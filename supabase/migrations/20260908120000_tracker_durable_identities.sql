-- Durable database identities for everything the automatic tracker writes.
--
-- WHAT THIS FIXES. The bridge already reconciles every stage by a natural key,
-- but the keys were enforced only by the client: two processes racing the same
-- game, or one whose local journal was lost, could write the same plate
-- appearance, pitch, run or tracking fact twice and nothing in the database
-- would object. docs/tracker-persistence-reliability.md called these out as
-- the missing half of exactly-once.
--
-- NON-CONTACT PLATE APPEARANCES. `tracker_contact_seq` only exists when the
-- bat met the ball, so a strikeout, a walk or a hit batter had no durable
-- identity at all -- it was reconciled through the local journal's ordinal and
-- nothing else. `tracker_event_key` is the bridge's own durable event key
-- (`contact:<seq>`, `tracker-pa:<batter>:<n>`, `preview-pa:...`) written into
-- the row, so every plate appearance the tracker writes is identifiable from
-- the database alone.
--
-- DUPLICATES ARE NOT DELETED. Every index below is created, not backfilled
-- around: if the table already holds two rows that share a key, this migration
-- FAILS and changes nothing. That is deliberate. A duplicate here is a scoring
-- record, and which of the two is right is a question for a person with the
-- game in front of them, not for a migration. Run
--   node scripts/audit_tracker_duplicates.mjs
-- first; it reports every collision, read-only, and names the rows.

alter table if exists plate_appearances
  add column if not exists tracker_event_key text;
alter table if exists season_plate_appearances
  add column if not exists tracker_event_key text;

comment on column plate_appearances.tracker_event_key is
  'Durable identity of the tracker event that produced this row. NULL for rows '
  'written by hand in the scorebook or the At-Bat editor.';

do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      -- (table, index name, columns, partial predicate)
      ('plate_appearances',        'plate_appearances_tracker_event_key_uidx',
       'game_id, tracker_event_key',                    'tracker_event_key is not null'),
      ('season_plate_appearances', 'season_plate_appearances_tracker_event_key_uidx',
       'game_id, tracker_event_key',                    'tracker_event_key is not null'),
      ('plate_appearances',        'plate_appearances_tracker_contact_seq_uidx',
       'game_id, tracker_contact_seq',                  'tracker_contact_seq is not null'),
      ('season_plate_appearances', 'season_plate_appearances_tracker_contact_seq_uidx',
       'game_id, tracker_contact_seq',                  'tracker_contact_seq is not null'),
      ('plate_appearances',        'plate_appearances_game_pa_number_uidx',
       'game_id, pa_number',                            'pa_number is not null'),
      ('season_plate_appearances', 'season_plate_appearances_game_pa_number_uidx',
       'game_id, pa_number',                            'pa_number is not null'),
      ('pitches',                  'pitches_pa_pitch_number_uidx',
       'pa_id, pitch_number_pa',                        'pa_id is not null and pitch_number_pa is not null'),
      ('season_pitches',           'season_pitches_pa_pitch_number_uidx',
       'pa_id, pitch_number_pa',                        'pa_id is not null and pitch_number_pa is not null'),
      ('runs_scored',              'runs_scored_pa_scorer_uidx',
       'pa_id, scoring_player_id, scoring_character_id','pa_id is not null'),
      ('season_runs_scored',       'season_runs_scored_pa_scorer_uidx',
       'pa_id, scoring_player_id, scoring_character_id','pa_id is not null'),
      ('tracking_plays',           'tracking_plays_session_ordinal_uidx',
       'tracking_session_id, play_ordinal',             'tracking_session_id is not null'),
      ('fielding_opportunities',   'fielding_opportunities_play_position_uidx',
       'tracking_play_id, position',                    'tracking_play_id is not null'),
      ('movement_metrics',         'movement_metrics_play_actor_uidx',
       'tracking_play_id, actor_type, actor_slot',      'tracking_play_id is not null'),
      ('tracking_throws',          'tracking_throws_play_sequence_uidx',
       'tracking_play_id, throw_sequence',              'tracking_play_id is not null')
    ) as t(table_name, index_name, columns, predicate)
  loop
    -- A table this deployment does not have is skipped rather than failing the
    -- migration: the tracking tables were created ahead of this file and a
    -- fresh database built from supabase-schema.sql alone has only some of them.
    if to_regclass('public.' || spec.table_name) is null then
      raise notice 'skipping %: table not present', spec.table_name;
      continue;
    end if;
    if to_regclass('public.' || spec.index_name) is not null then
      continue;
    end if;
    execute format('create unique index %I on public.%I (%s) where %s',
                   spec.index_name, spec.table_name, spec.columns, spec.predicate);
  end loop;
end
$$;
