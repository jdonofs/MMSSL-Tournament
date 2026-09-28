-- Pitch and run ids are UUIDs in production; the replay path read them into a
-- bigint.
--
-- tracker_persist_plate_appearance looks a child up by its natural key and
-- selects its id into `child_id` to learn whether it already exists. That
-- variable was declared bigint, but pitches, season_pitches, runs_scored and
-- season_runs_scored all key on uuid in production (the test baseline gave
-- them serial ids, which is why the database suite never saw it). A pitch's
-- first delivery never reaches the lookup's hit branch, so every live write
-- succeeded -- and then game completion, which re-delivers every plate
-- appearance through scoringPersistence.verifyAll() before it marks the game
-- final, failed on the first pitch it found:
--
--   invalid input syntax for type bigint: "6e7c4153-..."
--
-- Season game 2766 (2026-09-18) stopped exactly there, one play short of its
-- walk-off. The id is only ever tested for null, so it is held as text, which
-- takes a uuid and an integer alike. Nothing else in the function changes.

create or replace function tracker_persist_plate_appearance(
  p_competition_type text,
  p_game_id bigint,
  p_pa jsonb,
  p_pitches jsonb default '[]'::jsonb,
  p_runs jsonb default '[]'::jsonb,
  p_owner_id text default null,
  p_epoch bigint default null,
  p_unleased_intent text default null
) returns jsonb
language plpgsql
as $fn$
declare
  -- The fields that say WHICH plate appearance this is. Deliberately the same
  -- list scripts/tracker_scoring_persistence.mjs compares on, so the staged
  -- path and this one cannot disagree about what counts as the same event.
  pa_identity constant text[] := array[
    'game_id', 'player_id', 'character_id', 'pitcher_id', 'pitcher_player_id',
    'inning', 'result', 'tracker_contact_seq'];
  pa_table text;
  pitch_table text;
  run_table text;
  pa_columns text;
  pa_selects text;
  existing_id bigint;
  existing_number integer;
  existing_json jsonb;
  typed_pa jsonb;
  found_by text := null;
  conflicts text[];
  backfill_set text;
  new_pa_id bigint;
  new_pa_number integer;
  was_inserted boolean := false;
  event_key text;
  contact_seq bigint;
  pitch_rows integer := 0;
  run_rows integer := 0;
  child jsonb;
  child_id text;
  child_json jsonb;
  typed_child jsonb;
  child_columns text;
  child_selects text;
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

  perform tracker_lease_assert(p_competition_type, p_game_id, p_owner_id, p_epoch,
                               p_unleased_intent);

  event_key := nullif(p_pa ->> 'tracker_event_key', '');
  contact_seq := nullif(p_pa ->> 'tracker_contact_seq', '')::bigint;
  if event_key is null then
    raise exception 'tracker_event_key is required: a plate appearance with no durable '
                    'identity cannot be written idempotently';
  end if;

  -- Every row in this payload belongs to the game this call was made about.
  if p_pa ? 'game_id' and (p_pa ->> 'game_id')::bigint is distinct from p_game_id then
    raise exception 'plate appearance names game % but this call is for % game %',
      p_pa ->> 'game_id', p_competition_type, p_game_id
      using errcode = 'check_violation';
  end if;
  for child in select * from jsonb_array_elements(
      coalesce(p_pitches, '[]'::jsonb) || coalesce(p_runs, '[]'::jsonb)) loop
    if child ? 'game_id' and (child ->> 'game_id')::bigint is distinct from p_game_id then
      raise exception 'a child row names game % but this call is for % game %',
        child ->> 'game_id', p_competition_type, p_game_id
        using errcode = 'check_violation';
    end if;
  end loop;

  -- The payload as the table itself would store it, so the comparisons below
  -- are between two values of the same type rather than between a column and
  -- whatever shape JSON happened to carry.
  execute format('select to_jsonb(r) from jsonb_populate_record(null::%I, $1) r', pa_table)
    into typed_pa using p_pa;

  -- Already written? Both keys are checked, because a session recorded before
  -- tracker_event_key existed identifies its contact plate appearances by
  -- tracker_contact_seq alone and must not be duplicated by a replay.
  execute format(
    'select id, pa_number, to_jsonb(t) from %I t where game_id = $1 and tracker_event_key = $2 limit 1',
    pa_table) into existing_id, existing_number, existing_json using p_game_id, event_key;
  if existing_id is not null then
    found_by := 'tracker_event_key';
  elsif contact_seq is not null then
    execute format(
      'select id, pa_number, to_jsonb(t) from %I t where game_id = $1 and tracker_contact_seq = $2 limit 1',
      pa_table) into existing_id, existing_number, existing_json using p_game_id, contact_seq;
    if existing_id is not null then found_by := 'tracker_contact_seq'; end if;
  end if;

  if existing_id is not null then
    -- AN OPERATOR'S ANSWER IS NOT THE TRACKER'S TO RESTATE. The At-Bat editor
    -- writes a correction under the SAME tracker_event_key the unresolved play
    -- carried, precisely so a later replay finds it. Its children were written
    -- beside it by the editor; adding the tracker's guesses to them is how a
    -- corrected strikeout grew a home run's run.
    if existing_json ->> 'correction_source' = 'operator' then
      return jsonb_build_object(
        'pa_id', existing_id,
        'pa_number', existing_number,
        'inserted', false,
        'operator_correction', true,
        'pitches_inserted', 0,
        'runs_inserted', 0,
        'pa', existing_json);
    end if;

    -- A CONFLICT IS TWO DIFFERENT ANSWERS, NOT A BLANK ONE. A row recorded
    -- before event keys existed carries no key, and one imported without its
    -- batter carries no batter; those are missing facts, and filling them in is
    -- a backfill. Only a field that already SAYS something else is a
    -- contradiction, and that is refused.
    select coalesce(array_agg(k order by k), '{}'::text[]) into conflicts
      from jsonb_object_keys(p_pa) k
     where (k = any(pa_identity) or k = 'tracker_event_key')
       and typed_pa ? k
       and (existing_json ->> k) is not null
       and (existing_json ->> k) is distinct from (typed_pa ->> k);
    if array_length(conflicts, 1) > 0 then
      raise exception 'tracker event % already names a different plate appearance in % game % '
                      '(differs in %); refusing to overwrite a recorded scoring fact',
        event_key, p_competition_type, p_game_id, array_to_string(conflicts, ', ')
        using errcode = 'check_violation';
    end if;

    select string_agg(format('%I = r.%I', k, k), ', ') into backfill_set
      from jsonb_object_keys(p_pa) k
     where (k = any(pa_identity) or k = 'tracker_event_key')
       and typed_pa ? k
       and (typed_pa ->> k) is not null
       and (existing_json ->> k) is null;
    if backfill_set is not null then
      execute format('update %I t set %s from jsonb_populate_record(null::%I, $1) r where t.id = $2',
                     pa_table, backfill_set, pa_table)
        using p_pa, existing_id;
    end if;
    new_pa_id := existing_id;
    new_pa_number := existing_number;
  else
    -- Only the keys the payload actually carries, resolved against the real
    -- column list: jsonb_populate_record types every value, and a key this
    -- deployment has no column for is dropped rather than failing the write.
    -- `id`, `created_at` and `pa_number` are never taken from the payload.
    select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
           string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name)
      into pa_columns, pa_selects
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = pa_table
       and c.column_name not in ('id', 'created_at', 'pa_number')
       and p_pa ? c.column_name;
    if pa_columns is null then
      raise exception 'the plate appearance payload has no column in common with %', pa_table;
    end if;

    -- pa_number is allocated here rather than by the caller: two clients each
    -- reading "max + 1" is exactly the race the unique index now rejects, and
    -- inside one transaction this read and the insert cannot interleave.
    execute format('select coalesce(max(pa_number), 0) + 1 from %I where game_id = $1', pa_table)
      into new_pa_number using p_game_id;

    execute format(
      'insert into %I (%s, pa_number) select %s, $2 from jsonb_populate_record(null::%I, $1) r '
      'returning id, pa_number',
      pa_table, pa_columns, pa_selects, pa_table)
      into new_pa_id, new_pa_number
      using p_pa, new_pa_number;
    was_inserted := true;
  end if;

  -- Children. Looked up by their natural key first, so "already there" and
  -- "already there with different data" are told apart: `on conflict do
  -- nothing` alone reported a contradiction as a successful no-op.
  for child in select * from jsonb_array_elements(coalesce(p_pitches, '[]'::jsonb)) loop
    execute format('select id, to_jsonb(t) from %I t where pa_id = $1 and pitch_number_pa = $2 limit 1',
                   pitch_table)
      into child_id, child_json using new_pa_id, (child ->> 'pitch_number_pa')::int;
    if child_id is not null then
      execute format('select to_jsonb(r) from jsonb_populate_record(null::%I, $1) r', pitch_table)
        into typed_child using child;
      -- pitch_number_game is a display ordinal counted across the whole game,
      -- so a replay into a database that already holds these pitches computes a
      -- HIGHER one for the same pitch. It is not part of the pitch's identity
      -- and is deliberately not compared -- the same exception the staged
      -- client path makes, for the same reason.
      select coalesce(array_agg(k order by k), '{}'::text[]) into conflicts
        from jsonb_object_keys(child) k
       where k not in ('id', 'created_at', 'pa_id', 'pitch_number_game')
         and typed_child ? k
         and (child_json ->> k) is distinct from (typed_child ->> k);
      if array_length(conflicts, 1) > 0 then
        raise exception 'pitch % of plate appearance % is already recorded with different data '
                        '(differs in %)',
          child ->> 'pitch_number_pa', new_pa_id, array_to_string(conflicts, ', ')
          using errcode = 'check_violation';
      end if;
      continue;
    end if;
    select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
           string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name)
      into child_columns, child_selects
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = pitch_table
       and c.column_name not in ('id', 'created_at', 'pa_id')
       and child ? c.column_name;
    execute format(
      'insert into %I (%s, pa_id) select %s, $2 from jsonb_populate_record(null::%I, $1) r',
      pitch_table, child_columns, child_selects, pitch_table)
      using child, new_pa_id;
    pitch_rows := pitch_rows + 1;
  end loop;

  for child in select * from jsonb_array_elements(coalesce(p_runs, '[]'::jsonb)) loop
    execute format(
      'select id, to_jsonb(t) from %I t where pa_id = $1 '
      'and scoring_player_id is not distinct from $2 '
      'and scoring_character_id is not distinct from $3 limit 1', run_table)
      into child_id, child_json
      using new_pa_id, (child ->> 'scoring_player_id')::uuid, (child ->> 'scoring_character_id')::int;
    if child_id is not null then
      execute format('select to_jsonb(r) from jsonb_populate_record(null::%I, $1) r', run_table)
        into typed_child using child;
      select coalesce(array_agg(k order by k), '{}'::text[]) into conflicts
        from jsonb_object_keys(child) k
       where k not in ('id', 'created_at', 'pa_id')
         and typed_child ? k
         and (child_json ->> k) is distinct from (typed_child ->> k);
      if array_length(conflicts, 1) > 0 then
        raise exception 'the run scored by % on plate appearance % is already recorded with '
                        'different data (differs in %)',
          child ->> 'scoring_character_id', new_pa_id, array_to_string(conflicts, ', ')
          using errcode = 'check_violation';
      end if;
      continue;
    end if;
    select string_agg(quote_ident(c.column_name), ', ' order by c.column_name),
           string_agg('r.' || quote_ident(c.column_name), ', ' order by c.column_name)
      into child_columns, child_selects
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = run_table
       and c.column_name not in ('id', 'created_at', 'pa_id')
       and child ? c.column_name;
    execute format(
      'insert into %I (%s, pa_id) select %s, $2 from jsonb_populate_record(null::%I, $1) r',
      run_table, child_columns, child_selects, run_table)
      using child, new_pa_id;
    run_rows := run_rows + 1;
  end loop;

  -- The whole row back, so the caller never has to re-read what it just wrote
  -- (and so an ambiguous response can be settled by asking again).
  execute format('select to_jsonb(t) from %I t where id = $1', pa_table)
    into pa_row using new_pa_id;

  return jsonb_build_object(
    'pa_id', new_pa_id,
    'pa_number', new_pa_number,
    'inserted', was_inserted,
    'operator_correction', false,
    'pitches_inserted', pitch_rows,
    'runs_inserted', run_rows,
    'pa', pa_row);
end
$fn$;
