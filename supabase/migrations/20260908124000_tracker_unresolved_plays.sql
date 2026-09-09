-- Plate appearances the tracker watched and could not score.
--
-- WHAT WAS LOST. When the bridge cannot determine a result it logs a line,
-- marks the preview write "skipped", and writes nothing. The moment that
-- process ends, the only record that a plate appearance happened at all is a
-- line of console text. docs/tracker-acceptance-2026-09-06.md has the case:
-- one plate appearance in the tournament recording has no stated outcome, its
-- run went with it, and `runs_scored` holds 17 rows for an 18-run game.
--
-- WHAT THIS IS AND IS NOT. It is a durable, visible statement that something
-- happened and is NOT known -- the batter, the pitcher, the inning, the
-- pitches that were seen, and the reason the result could not be determined.
-- It is not a plate appearance: nothing here is counted in anyone's
-- statistics, and the tracker never fills in the result to make a total match.
-- An operator with the video supplies the outcome, the At-Bat editor writes a
-- real plate appearance from it, and THAT row carries the same
-- tracker_event_key -- so the bridge, on any later replay, finds the operator's
-- answer already present and leaves it exactly as it is.
--
-- game_id is not a foreign key: it addresses `games` OR `season_schedule`,
-- which number their rows independently, so (competition_type, game_id) is the
-- identity and neither table can carry the reference.

create extension if not exists pgcrypto;

create table if not exists tracker_unresolved_plays (
  id uuid primary key default gen_random_uuid(),
  competition_type text not null check (competition_type in ('tournament', 'season')),
  game_id bigint not null,
  season_id bigint,

  -- The same durable identity the plate appearance would have carried. It is
  -- what ties the operator's correction back to this record, and what stops a
  -- second sighting of the same play opening a second row.
  tracker_event_key text not null,
  tracker_contact_seq bigint,
  preview_pa_number integer,

  inning integer,
  half text check (half in ('top', 'bottom') or half is null),
  batter_name text,
  batter_character_id integer,
  batter_player_id uuid,
  pitcher_name text,
  pitcher_character_id integer,
  pitcher_player_id uuid,
  batting_team_id text,
  defensive_team_id text,

  -- Why it could not be scored, in the bridge's own words.
  reason text not null,
  -- Everything the bridge did see: the pitches, the runners on base before the
  -- play, any runs it observed but could not attribute, the tracker lines. An
  -- operator resolving this a week later has only what is in here.
  evidence jsonb not null default '{}'::jsonb,

  status text not null default 'open'
    check (status in ('open', 'resolved', 'dismissed')),
  resolved_pa_id bigint,
  resolved_at timestamptz,
  resolved_by uuid references players(id),
  resolution_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tracker_unresolved_plays_identity
    unique (competition_type, game_id, tracker_event_key)
);

create index if not exists tracker_unresolved_plays_open_idx
  on tracker_unresolved_plays (competition_type, game_id)
  where status = 'open';

alter table tracker_unresolved_plays disable row level security;

comment on table tracker_unresolved_plays is
  'Plate appearances the automatic tracker observed and could not score. Never '
  'counted in statistics; resolved only by an operator supplying the verified '
  'result. An open row is a known gap, deliberately visible.';

-- The other half of a correction: the plate appearance that answers one.
--
-- `correction_source = 'operator'` is read by the BRIDGE, not only by people.
-- scripts/tracker_scoring_persistence.mjs finds a row under the tracker event
-- key it was about to write and, seeing this flag, leaves it exactly as it is.
-- Without that, every restart and every replay would restate the operator's
-- verified result as whatever the tracker had guessed -- which for an
-- unresolved play is nothing at all.
alter table if exists plate_appearances
  add column if not exists correction_source text,
  add column if not exists corrected_at timestamptz,
  add column if not exists corrected_by uuid references players(id);

alter table if exists season_plate_appearances
  add column if not exists correction_source text,
  add column if not exists corrected_at timestamptz,
  add column if not exists corrected_by uuid references players(id);

comment on column plate_appearances.correction_source is
  'Set to ''operator'' when a person supplied this result for a play the '
  'automatic tracker could not score. Automatic ingestion never overwrites a '
  'row carrying it.';

-- The operator's answer, written where it belongs, in one transaction.
--
-- WHY THIS IS NOT THREE CLIENT WRITES. The At-Bat editor used to insert the
-- plate appearance, then its pitches, then its runs, and only then mark the
-- unresolved play resolved -- deliberately in that order, so a failure left the
-- gap visible. It did leave the gap visible; it also left the plate appearance
-- behind, holding the unresolved play's tracker_event_key. The unique index on
-- (game_id, tracker_event_key) then refused every retry, so the one path that
-- could close the gap was blocked by its own first attempt.
--
-- CHRONOLOGY IS PART OF THE ANSWER. An unresolved play happened in the fifth
-- inning; appending it after the ninth is not a cosmetic problem. Half-innings
-- are derived from the running out count (src/utils/trackerGameState.js), so a
-- plate appearance recorded out of order moves every later at-bat's inning,
-- half, runners and outs. p_pa_number is the chronological slot the editor
-- derived from the play's own evidence, and every plate appearance at or after
-- it is renumbered up by one, here, in the same transaction.
--
-- The renumbering is two passes on purpose. `pa_number = pa_number + 1` over a
-- range with a unique index on (game_id, pa_number) can collide with the row it
-- is about to move; moving the range far out of the way and back cannot.
--
-- NO LEASE IS ASSERTED, AND THAT IS THE POINT. This is a person answering a
-- question the tracker could not, from the video, possibly days later and on
-- another machine. The row it writes carries correction_source = 'operator',
-- which is what stops the bridge restating it -- see
-- scripts/tracker_scoring_persistence.mjs and the persist function's own
-- header.
create or replace function tracker_record_corrected_plate_appearance(
  p_competition_type text,
  p_unresolved_id uuid,
  p_pa jsonb,
  p_pitches jsonb default '[]'::jsonb,
  p_runs jsonb default '[]'::jsonb,
  p_pa_number integer default null,
  p_resolved_by uuid default null,
  p_note text default null
) returns jsonb
language plpgsql
as $fn$
declare
  unresolved tracker_unresolved_plays;
  pa_table text;
  pitch_table text;
  run_table text;
  pa_payload jsonb;
  existing_id bigint;
  existing_number integer;
  existing_source text;
  highest integer;
  slot integer;
  shifted integer := 0;
  retried boolean := false;
  new_pa_id bigint;
  columns text;
  selects text;
  assignments text;
  child jsonb;
  pa_row jsonb;
begin
  if p_competition_type = 'season' then
    pa_table := 'season_plate_appearances';
    pitch_table := 'season_pitches';
    run_table := 'season_runs_scored';
  elsif p_competition_type = 'tournament' then
    pa_table := 'plate_appearances';
    pitch_table := 'pitches';
    run_table := 'runs_scored';
  else
    raise exception 'competition type must be tournament or season, not %', p_competition_type;
  end if;

  select * into unresolved from tracker_unresolved_plays
   where id = p_unresolved_id for update;
  if unresolved.id is null then
    raise exception 'unresolved play % does not exist', p_unresolved_id;
  end if;
  if unresolved.competition_type is distinct from p_competition_type then
    raise exception 'unresolved play % belongs to %, not %',
      p_unresolved_id, unresolved.competition_type, p_competition_type
      using errcode = 'check_violation';
  end if;
  if p_pa ? 'game_id' and (p_pa ->> 'game_id')::bigint is distinct from unresolved.game_id then
    raise exception 'the correction names game % but the unresolved play is in game %',
      p_pa ->> 'game_id', unresolved.game_id
      using errcode = 'check_violation';
  end if;

  -- The durable identity is the unresolved play's own, not the caller's: it is
  -- what makes the bridge recognise this row on a later replay.
  pa_payload := p_pa
    || jsonb_build_object(
         'game_id', unresolved.game_id,
         'tracker_event_key', unresolved.tracker_event_key,
         'correction_source', 'operator',
         'corrected_at', to_jsonb(now()))
    || case when unresolved.tracker_contact_seq is null then '{}'::jsonb
            else jsonb_build_object('tracker_contact_seq', unresolved.tracker_contact_seq) end
    || case when p_resolved_by is null then '{}'::jsonb
            else jsonb_build_object('corrected_by', p_resolved_by) end;

  execute format(
    'select id, pa_number, correction_source from %I where game_id = $1 and tracker_event_key = $2 limit 1',
    pa_table) into existing_id, existing_number, existing_source
    using unresolved.game_id, unresolved.tracker_event_key;

  if existing_id is not null then
    -- A RETRY OF A SAVE THAT DIED AFTER THE INSERT. The row is this correction's
    -- own; it is completed rather than refused, which is what stops the unique
    -- event key from blocking the only path that can close the gap.
    if existing_source is distinct from 'operator' then
      raise exception 'the tracker already recorded a plate appearance under event key % in '
                      'game %; an unresolved play cannot be answered over it',
        unresolved.tracker_event_key, unresolved.game_id
        using errcode = 'check_violation';
    end if;
    retried := true;
    new_pa_id := existing_id;
    slot := existing_number;
    select string_agg(format('%I = r.%I', c.column_name, c.column_name), ', ')
      into assignments
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = pa_table
       and c.column_name not in ('id', 'created_at', 'pa_number')
       and pa_payload ? c.column_name;
    if assignments is not null then
      execute format('update %I t set %s from jsonb_populate_record(null::%I, $1) r where t.id = $2',
                     pa_table, assignments, pa_table)
        using pa_payload, new_pa_id;
    end if;
  else
    execute format('select coalesce(max(pa_number), 0) from %I where game_id = $1', pa_table)
      into highest using unresolved.game_id;
    slot := least(greatest(coalesce(p_pa_number, highest + 1), 1), highest + 1);

    -- Out of the way, then back, so the renumbering never collides with the row
    -- it is in the middle of moving.
    execute format('update %I set pa_number = pa_number + 1000000 where game_id = $1 and pa_number >= $2',
                   pa_table) using unresolved.game_id, slot;
    get diagnostics shifted = row_count;
    execute format('update %I set pa_number = pa_number - 999999 where game_id = $1 and pa_number >= 1000000',
                   pa_table) using unresolved.game_id;

    select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
           string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name)
      into columns, selects
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = pa_table
       and c.column_name not in ('id', 'created_at', 'pa_number')
       and pa_payload ? c.column_name;
    if columns is null then
      raise exception 'the correction payload has no column in common with %', pa_table;
    end if;
    execute format(
      'insert into %I (%s, pa_number) select %s, $2 from jsonb_populate_record(null::%I, $1) r '
      'returning id', pa_table, columns, selects, pa_table)
      into new_pa_id using pa_payload, slot;
  end if;

  -- The operator's own children replace whatever a previous attempt left, so a
  -- retry converges instead of accumulating.
  execute format('delete from %I where pa_id = $1', pitch_table) using new_pa_id;
  execute format('delete from %I where pa_id = $1', run_table) using new_pa_id;

  for child in select * from jsonb_array_elements(coalesce(p_pitches, '[]'::jsonb)) loop
    select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
           string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name)
      into columns, selects
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = pitch_table
       and c.column_name not in ('id', 'created_at', 'pa_id')
       and child ? c.column_name;
    execute format('insert into %I (%s, pa_id) select %s, $2 from jsonb_populate_record(null::%I, $1) r',
                   pitch_table, columns, selects, pitch_table)
      using child, new_pa_id;
  end loop;

  for child in select * from jsonb_array_elements(coalesce(p_runs, '[]'::jsonb)) loop
    select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
           string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name)
      into columns, selects
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = run_table
       and c.column_name not in ('id', 'created_at', 'pa_id')
       and child ? c.column_name;
    execute format('insert into %I (%s, pa_id) select %s, $2 from jsonb_populate_record(null::%I, $1) r',
                   run_table, columns, selects, run_table)
      using child, new_pa_id;
  end loop;

  update tracker_unresolved_plays
     set status = 'resolved',
         resolved_pa_id = new_pa_id,
         resolved_at = now(),
         resolved_by = coalesce(p_resolved_by, resolved_by),
         resolution_note = coalesce(p_note, resolution_note),
         updated_at = now()
   where id = unresolved.id;

  execute format('select to_jsonb(t) from %I t where id = $1', pa_table) into pa_row using new_pa_id;
  return jsonb_build_object(
    'pa_id', new_pa_id,
    'pa_number', slot,
    'retried', retried,
    'renumbered', shifted,
    'unresolved_id', unresolved.id,
    'pa', pa_row);
end
$fn$;
