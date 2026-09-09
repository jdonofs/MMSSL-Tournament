-- Versioned tracking sessions, so a completed ingest can be REPLACED without
-- ever being destroyed first.
--
-- WHAT HAPPENS TODAY. `ingest_player_tracking.mjs` refuses outright:
--
--   "Refusing to replace completed tracking session N without a database
--    transaction; the existing completed ingest was preserved."
--
-- That is the right call with the tools it had -- deleting a good tree of
-- tracking_plays, fielding_opportunities, movement_metrics and tracking_throws
-- and then failing halfway through rebuilding it would lose a game's fielding
-- outright -- but it also means a re-derived session (a fixed derivation, a
-- recovered capture) can never be loaded.
--
-- WHAT THIS ADDS. A session is now (competition_type, game_id, raw_stem,
-- version), and exactly one version per stem is `is_active`. A replacement is
-- built as a NEW version alongside the old one, its facts are ingested into
-- it, and only then does one transactional statement move the active pointer.
-- If anything fails at any point before that, the previous version is still
-- active, still complete, and untouched.
--
-- Nothing here deletes a session or its facts. Superseded versions stay on
-- disk as history; `tracker_prune_superseded_session` exists for when an
-- operator deliberately wants one gone, and it refuses to touch an active one.
--
-- THE POINTER IS NOT THE ONLY THING THAT HAS TO MOVE. A tracking version owns
-- its own facts, but it is also POINTED AT by rows the site treats as official:
-- plate_appearances.tracking_session_id / tracking_contact_frame, and
-- runner_opportunities / double_play_opportunities.tracking_play_id (plus the
-- measured runner kinematics and the throw a runner was thrown out by). The
-- ingest used to write all of those the moment each play was staged -- before
-- activation, while the replacement was still unfinished -- so a replacement
-- that failed halfway left official rows pointing INTO the failed version while
-- the previous version was still the active one. Those links now travel with
-- the activation and are applied in the same statement pair, inside the same
-- transaction: either the new version is active and everything official points
-- at it, or nothing moved at all.

do $$
begin
  if to_regclass('public.tracking_sessions') is null then
    raise notice 'skipping: tracking_sessions is not present in this database';
    return;
  end if;

  alter table tracking_sessions add column if not exists version integer not null default 1;
  alter table tracking_sessions add column if not exists is_active boolean not null default true;
  alter table tracking_sessions add column if not exists superseded_by bigint;
  alter table tracking_sessions add column if not exists superseded_at timestamptz;
  alter table tracking_sessions add column if not exists replaces_session_id bigint;

  -- The old identity was (competition_type, game_id, raw_stem) and is now the
  -- identity of the ACTIVE version only; every version of a stem is unique on
  -- its version number.
  if to_regclass('public.tracking_sessions_stem_version_uidx') is null then
    execute 'create unique index tracking_sessions_stem_version_uidx on tracking_sessions '
         || '(competition_type, game_id, raw_stem, version)';
  end if;
  if to_regclass('public.tracking_sessions_active_stem_uidx') is null then
    execute 'create unique index tracking_sessions_active_stem_uidx on tracking_sessions '
         || '(competition_type, game_id, raw_stem) where is_active';
  end if;
end
$$;

-- Open a replacement. Returns the new session row; the caller ingests into it
-- exactly as it would a first ingest, and the previous version stays active
-- and complete the whole time.
drop function if exists tracker_begin_session_replacement(bigint, jsonb, text, bigint);
create or replace function tracker_begin_session_replacement(
  p_session_id bigint,
  p_payload jsonb,
  p_owner_id text default null,
  p_epoch bigint default null,
  p_unleased_intent text default null
) returns jsonb
language plpgsql
as $fn$
declare
  previous tracking_sessions;
  next_version integer;
  columns text;
  selects text;
  created_id bigint;
  created jsonb;
begin
  select * into previous from tracking_sessions where id = p_session_id;
  if previous.id is null then
    raise exception 'tracking session % does not exist', p_session_id;
  end if;
  perform tracker_lease_assert(previous.competition_type, previous.game_id, p_owner_id, p_epoch,
                               p_unleased_intent);

  select coalesce(max(version), 0) + 1 into next_version
    from tracking_sessions
   where competition_type = previous.competition_type
     and game_id = previous.game_id
     and raw_stem = previous.raw_stem;

  select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
         string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name)
    into columns, selects
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'tracking_sessions'
     and c.column_name not in ('id', 'created_at', 'version', 'is_active',
                               'superseded_by', 'superseded_at', 'replaces_session_id')
     and p_payload ? c.column_name;

  execute format(
    'insert into tracking_sessions (%s, version, is_active, replaces_session_id) '
    'select %s, $2, false, $3 from jsonb_populate_record(null::tracking_sessions, $1) r '
    'returning id', columns, selects)
    into created_id using p_payload, next_version, previous.id;

  select to_jsonb(t) into created from tracking_sessions t where id = created_id;
  return jsonb_build_object('session_id', created_id, 'version', next_version,
                            'replaces', previous.id, 'session', created);
end
$fn$;

-- Move the pointer, and everything official that points at a version, together.
--
-- One transaction: there is no instant at which a stem has two active versions
-- or none, and no instant at which a plate appearance names a version that is
-- not the active one.
--
-- It refuses to activate a version that is not finished, which is what makes
-- "the previous valid session survives a failed replacement" true rather than
-- hopeful: a replacement that died halfway simply never gets here.
--
-- p_official_links carries only what cannot be derived from the rows
-- themselves -- the measured runner position, speed, and the throw a runner was
-- retired by. The session id, the contact frame and the tracking_play_id are
-- read out of the candidate's own tracking_plays, so a re-run after a lost
-- response reapplies exactly the same links rather than a remembered copy of
-- them.
drop function if exists tracker_activate_session_version(bigint, text, bigint);
create or replace function tracker_activate_session_version(
  p_session_id bigint,
  p_owner_id text default null,
  p_epoch bigint default null,
  p_unleased_intent text default null,
  p_official_links jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
as $fn$
declare
  candidate tracking_sessions;
  previous_id bigint;
  pa_table text;
  already boolean := false;
  pa_relinked integer := 0;
  runner_relinked integer := 0;
  dp_relinked integer := 0;
  runner_measured integer := 0;
begin
  select * into candidate from tracking_sessions where id = p_session_id for update;
  if candidate.id is null then
    raise exception 'tracking session % does not exist', p_session_id;
  end if;
  perform tracker_lease_assert(candidate.competition_type, candidate.game_id, p_owner_id, p_epoch,
                               p_unleased_intent);
  if candidate.status is distinct from 'ingested' then
    raise exception 'refusing to activate tracking session % with status %: only a finished '
                    'ingest replaces a finished ingest', candidate.id, candidate.status
      using errcode = 'check_violation';
  end if;

  if candidate.is_active then
    -- A re-run after a lost response. The pointer is already where it belongs;
    -- the links below are re-applied because the response that was lost may
    -- have been lost BEFORE they were.
    already := true;
  else
    select id into previous_id from tracking_sessions
     where competition_type = candidate.competition_type
       and game_id = candidate.game_id
       and raw_stem = candidate.raw_stem
       and is_active
     for update;

    update tracking_sessions
       set is_active = false, superseded_by = candidate.id, superseded_at = now()
     where id = previous_id;
    update tracking_sessions set is_active = true where id = candidate.id;
  end if;

  pa_table := case when candidate.competition_type = 'season'
                   then 'season_plate_appearances' else 'plate_appearances' end;

  if to_regclass('public.' || pa_table) is not null then
    execute format(
      'update %I p set tracking_session_id = $1, tracking_contact_frame = tp.contact_frame '
      '  from tracking_plays tp '
      ' where tp.tracking_session_id = $1 and tp.pa_id = p.id '
      '   and (p.tracking_session_id is distinct from $1 '
      '        or p.tracking_contact_frame is distinct from tp.contact_frame)', pa_table)
      using candidate.id;
    get diagnostics pa_relinked = row_count;
  end if;

  if to_regclass('public.runner_opportunities') is not null then
    update runner_opportunities ro
       set tracking_play_id = tp.id
      from tracking_plays tp
     where tp.tracking_session_id = candidate.id
       and ro.pa_id = tp.pa_id
       and ro.competition_type = candidate.competition_type
       and ro.game_id = candidate.game_id
       and ro.tracking_play_id is distinct from tp.id;
    get diagnostics runner_relinked = row_count;

    -- The measured half, which no query could re-derive.
    update runner_opportunities ro
       set runner_x = (measured ->> 'runner_x')::double precision,
           runner_z = (measured ->> 'runner_z')::double precision,
           runner_speed_mps = (measured ->> 'runner_speed_mps')::double precision,
           tracking_throw_id = (measured ->> 'tracking_throw_id')::bigint
      from jsonb_array_elements(coalesce(p_official_links -> 'runner_opportunities', '[]'::jsonb)) measured
     where ro.id = (measured ->> 'id')::bigint
       and ro.competition_type = candidate.competition_type
       and ro.game_id = candidate.game_id;
    get diagnostics runner_measured = row_count;
  end if;

  if to_regclass('public.double_play_opportunities') is not null then
    update double_play_opportunities dp
       set tracking_play_id = tp.id
      from tracking_plays tp
     where tp.tracking_session_id = candidate.id
       and dp.pa_id = tp.pa_id
       and dp.competition_type = candidate.competition_type
       and dp.game_id = candidate.game_id
       and dp.tracking_play_id is distinct from tp.id;
    get diagnostics dp_relinked = row_count;
  end if;

  return jsonb_build_object(
    'activated', not already,
    'reason', case when already then 'already_active' else 'activated' end,
    'session_id', candidate.id,
    'superseded', previous_id,
    'version', candidate.version,
    'plate_appearances_relinked', pa_relinked,
    'runner_opportunities_relinked', runner_relinked,
    'runner_opportunities_measured', runner_measured,
    'double_play_opportunities_relinked', dp_relinked);
end
$fn$;

-- Deliberate cleanup of a superseded version and its facts. Never called by
-- the ingest path; it exists so history can be pruned on purpose rather than
-- by a replacement that half-succeeded.
create or replace function tracker_prune_superseded_session(
  p_session_id bigint
) returns jsonb
language plpgsql
as $fn$
declare
  target tracking_sessions;
  removed integer;
begin
  select * into target from tracking_sessions where id = p_session_id;
  if target.id is null then
    raise exception 'tracking session % does not exist', p_session_id;
  end if;
  if target.is_active then
    raise exception 'refusing to prune tracking session %: it is the active version',
      target.id using errcode = 'check_violation';
  end if;
  delete from tracking_plays where tracking_session_id = target.id;
  get diagnostics removed = row_count;
  delete from tracking_sessions where id = target.id;
  return jsonb_build_object('pruned', target.id, 'plays_removed', removed);
end
$fn$;
