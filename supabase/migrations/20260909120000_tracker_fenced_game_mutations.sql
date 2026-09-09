-- Ownership enforced INSIDE the transaction that writes, for the mutations
-- that were only ever checked outside it.
--
-- WHAT WAS ACTUALLY GUARANTEED BEFORE. Exactly one bridge write went through a
-- fenced function: tracker_persist_plate_appearance, which asserts the lease in
-- its own transaction and is refused when the epoch has moved. Everything else
-- -- the live-state publish, the games-row completion, the unresolved-play
-- record -- was an ordinary PostgREST update guarded by a CLIENT-SIDE check:
--
--     assertLeaseWritable('game completion')          // reads cached state
--     await supabase.from('games').update({ ... })    // separate request
--
-- and assertWritable() only knows what the last renewal told it. After a
-- takeover a losing bridge reads `held` until its next renewal, so a takeover
-- that has already committed leaves the old bridge's guard passing and its
-- update landing. Even with a perfectly current local view the two are separate
-- requests: ownership can change between the check and the write, and a check
-- before a separate request is not a fence, it is a hope.
--
-- WHAT THIS ADDS. One function per protected mutation, each asserting the lease
-- with tracker_lease_assert as its first statement -- which takes `for update`
-- on the lease row and holds it for the rest of the transaction, so a
-- concurrent takeover blocks until this write commits or rolls back and every
-- write after it carries an epoch the database refuses. The check and the write
-- are one commit; there is no window between them because there is no between.
--
-- The client keeps its local check, and that is deliberate: it refuses a write
-- this process already knows it must not make, without a round trip, and it
-- names which write was refused. What it no longer does is decide.
--
-- DEGRADING IS THE SAME DELIBERATE, LOUD, ONE-DIRECTION AFFAIR IT IS EVERYWHERE
-- ELSE HERE. These functions arrive in a migration a person has to apply. Until
-- it is, the bridge falls back to the ordinary updates, says so once, and
-- reports the guarantee as absent rather than pretending it holds.
--
-- Ids are not foreign keys, for the reason tracker_game_leases states: game_id
-- addresses a row in `games` OR in `season_schedule`, which number their rows
-- independently.
--
-- EVERY REFERENCE TO A TRACKER TABLE IS DYNAMIC, INCLUDING THE ONES THAT DID
-- NOT HAVE TO BE. A plpgsql function resolves its declared types when it is
-- first called, so a `tracker_unresolved_plays%rowtype` variable fails on a
-- database that has not created that table -- before the to_regclass check that
-- exists to let exactly that database carry on. Dynamic statements are analysed
-- only when they are reached, which is what makes "a missing table is not an
-- error" true rather than stated.

-- Which table pair a competition type names. One place, so the two functions
-- below and the bridge cannot disagree about it.
create or replace function tracker_game_tables(p_competition_type text)
returns table (games_table text, stats_table text)
language plpgsql
immutable
as $fn$
begin
  if p_competition_type = 'season' then
    return query select 'season_schedule'::text, 'season_tracker_live_stats'::text;
  elsif p_competition_type = 'tournament' then
    return query select 'games'::text, 'tracker_live_stats'::text;
  else
    raise exception 'competition type must be tournament or season, not %', p_competition_type;
  end if;
end
$fn$;

-- The live feed and the game row's own live_state, together.
--
-- They were two requests and are one commit: the site reads `live_state` off
-- the game row and the box score off the stats table, and a bridge that wrote
-- the first and lost its lease before the second left the two disagreeing about
-- the same instant of the same game.
drop function if exists tracker_publish_live_state(text, bigint, jsonb, jsonb, text, bigint);
create or replace function tracker_publish_live_state(
  p_competition_type text,
  p_game_id bigint,
  p_stats jsonb,
  p_live_state jsonb,
  p_owner_id text default null,
  p_epoch bigint default null,
  p_unleased_intent text default null
) returns jsonb
language plpgsql
as $fn$
declare
  games_rel text;
  stats_rel text;
  columns text;
  selects text;
  updates text;
  games_updated integer := 0;
begin
  select t.games_table, t.stats_table into games_rel, stats_rel
    from tracker_game_tables(p_competition_type) t;

  perform tracker_lease_assert(p_competition_type, p_game_id, p_owner_id, p_epoch,
                               p_unleased_intent);

  -- The payload belongs to the game this call was made about. Without this a
  -- stats row carrying another game_id would be written into a game this call
  -- neither read nor leased -- the same rule tracker_persist_plate_appearance
  -- applies to a plate appearance and its children.
  if p_stats ? 'game_id' and (p_stats ->> 'game_id')::bigint is distinct from p_game_id then
    raise exception 'live stats name game % but this call is for % game %',
      p_stats ->> 'game_id', p_competition_type, p_game_id
      using errcode = 'check_violation';
  end if;

  if to_regclass('public.' || stats_rel) is null then
    raise exception 'this database has no %, so a live feed cannot be published', stats_rel;
  end if;

  select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
         string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name),
         string_agg(format('%I = excluded.%I', c.column_name, c.column_name), ', '
                    order by c.column_name)
    into columns, selects, updates
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = stats_rel
     and c.column_name <> 'id'
     and p_stats ? c.column_name;

  if columns is null then
    raise exception 'the live-stats payload names no column of %', stats_rel
      using errcode = 'check_violation';
  end if;

  execute format(
    'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1) r '
    'on conflict (game_id) do update set %s',
    stats_rel, columns, selects, stats_rel, updates) using p_stats;

  -- The site's own live_state column, so Game View and the manual scorebook
  -- read the same in-progress state this bridge just published.
  execute format('update %I set live_state = $1 where id = $2', games_rel)
    using p_live_state, p_game_id;
  get diagnostics games_updated = row_count;
  if games_updated = 0 then
    raise exception '% game % does not exist', p_competition_type, p_game_id
      using errcode = 'check_violation';
  end if;

  return jsonb_build_object('published', true, 'games_updated', games_updated);
end
$fn$;

-- The final score, the winner and the status, written under the lease.
--
-- This is the row the whole site treats as the answer to "what happened in this
-- game", and it was the least protected write the bridge made.
drop function if exists tracker_apply_game_completion(text, bigint, jsonb, text, bigint);
create or replace function tracker_apply_game_completion(
  p_competition_type text,
  p_game_id bigint,
  p_completion jsonb,
  p_owner_id text default null,
  p_epoch bigint default null,
  p_unleased_intent text default null
) returns jsonb
language plpgsql
as $fn$
declare
  games_rel text;
  stats_rel text;
  assignments text;
  updated integer := 0;
  saved jsonb;
begin
  select t.games_table, t.stats_table into games_rel, stats_rel
    from tracker_game_tables(p_competition_type) t;

  perform tracker_lease_assert(p_competition_type, p_game_id, p_owner_id, p_epoch,
                               p_unleased_intent);

  if p_completion ? 'id' and (p_completion ->> 'id')::bigint is distinct from p_game_id then
    raise exception 'the completion payload names game % but this call is for % game %',
      p_completion ->> 'id', p_competition_type, p_game_id
      using errcode = 'check_violation';
  end if;

  select string_agg(format('%I = r.%I', c.column_name, c.column_name), ', '
                    order by c.column_name)
    into assignments
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = games_rel
     and c.column_name <> 'id'
     and p_completion ? c.column_name;

  if assignments is null then
    raise exception 'the completion payload names no column of %', games_rel
      using errcode = 'check_violation';
  end if;

  execute format(
    'update %I t set %s from jsonb_populate_record(null::%I, $1) r where t.id = $2',
    games_rel, assignments, games_rel) using p_completion, p_game_id;
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception '% game % does not exist', p_competition_type, p_game_id
      using errcode = 'check_violation';
  end if;

  execute format('select to_jsonb(t) from %I t where t.id = $1', games_rel)
    into saved using p_game_id;
  return jsonb_build_object('updated', updated, 'game', saved);
end
$fn$;

-- A play the bridge could not score, recorded under the lease.
--
-- IDEMPOTENT, AND AN OPERATOR'S ANSWER STILL STANDS. The rules are the ones the
-- client applied and are kept here so the transactional path and the fallback
-- cannot disagree: a row already resolved by a person is returned untouched, an
-- open one has its reason and evidence restated, and a play seen for the first
-- time is inserted under its durable event key.
--
-- A MISSING TABLE IS NOT AN ERROR, because the migration that adds it is
-- applied by a person and a game must not fail over an unresolved-play record.
-- It is reported, and the caller says so in its own log exactly as it did.
drop function if exists tracker_record_unresolved_play(text, bigint, jsonb, text, bigint);
create or replace function tracker_record_unresolved_play(
  p_competition_type text,
  p_game_id bigint,
  p_payload jsonb,
  p_owner_id text default null,
  p_epoch bigint default null,
  p_unleased_intent text default null
) returns jsonb
language plpgsql
as $fn$
declare
  event_key text;
  existing_status text;
  existing_json jsonb;
  columns text;
  selects text;
  saved jsonb;
begin
  perform tracker_lease_assert(p_competition_type, p_game_id, p_owner_id, p_epoch,
                               p_unleased_intent);

  if to_regclass('public.tracker_unresolved_plays') is null then
    return jsonb_build_object('recorded', false, 'reason', 'no_tracker_unresolved_plays_table');
  end if;

  event_key := nullif(p_payload ->> 'tracker_event_key', '');
  if event_key is null then
    raise exception 'an unresolved play needs a tracker_event_key: without one it cannot be '
                    'reconciled with the play it describes'
      using errcode = 'check_violation';
  end if;
  if p_payload ? 'game_id' and (p_payload ->> 'game_id')::bigint is distinct from p_game_id then
    raise exception 'the unresolved play names game % but this call is for % game %',
      p_payload ->> 'game_id', p_competition_type, p_game_id
      using errcode = 'check_violation';
  end if;

  -- Addressed by the natural key throughout, never by `id`. The primary key of
  -- this table is a uuid here and need not be one everywhere; the unique
  -- (competition_type, game_id, tracker_event_key) is the identity the client,
  -- the editor and this function all already agree on.
  execute 'select status, to_jsonb(t) from tracker_unresolved_plays t '
       || ' where t.competition_type = $1 and t.game_id = $2 and t.tracker_event_key = $3 limit 1'
    into existing_status, existing_json
    using p_competition_type, p_game_id, event_key;

  if existing_json is not null then
    if existing_status is distinct from 'open' then
      return jsonb_build_object('recorded', false, 'reason', 'resolved_by_operator',
                                'status', existing_status, 'play', existing_json);
    end if;
    execute 'update tracker_unresolved_plays as t '
         || '   set reason = $4, '
         || '       evidence = coalesce($5, t.evidence), '
         || '       updated_at = coalesce($6, now()) '
         || ' where t.competition_type = $1 and t.game_id = $2 and t.tracker_event_key = $3 '
         || ' returning to_jsonb(t)'
      into saved
      using p_competition_type, p_game_id, event_key,
            p_payload ->> 'reason', p_payload -> 'evidence',
            (p_payload ->> 'updated_at')::timestamptz;
    return jsonb_build_object('recorded', true, 'inserted', false, 'play', saved);
  end if;

  select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
         string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name)
    into columns, selects
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'tracker_unresolved_plays'
     and c.column_name <> 'id'
     and p_payload ? c.column_name;

  execute format(
    'insert into tracker_unresolved_plays (%s) '
    'select %s from jsonb_populate_record(null::tracker_unresolved_plays, $1) r '
    'returning to_jsonb(tracker_unresolved_plays.*)', columns, selects)
    into saved using p_payload;
  return jsonb_build_object('recorded', true, 'inserted', true, 'play', saved);
end
$fn$;
