-- Persist the compact, model-ready measurements emitted by
-- TRACKER_PITCH_PROVISIONAL. The raw XYZ trail remains in the tracker/session
-- artifacts; relational pitch rows keep only the reproducible features needed
-- by velocity, movement, pitch-type, and outcome models.

alter table if exists public.pitches
  add column if not exists is_star_swing boolean not null default false,
  add column if not exists pitch_speed_mph double precision,
  add column if not exists pitch_elapsed_seconds double precision,
  add column if not exists pitch_path_distance_ft double precision,
  add column if not exists pitch_direct_distance_units double precision,
  add column if not exists pitch_horizontal_delta_units double precision,
  add column if not exists pitch_vertical_delta_units double precision,
  add column if not exists pitch_forward_delta_units double precision,
  add column if not exists pitch_horizontal_range_units double precision,
  add column if not exists pitch_vertical_range_units double precision,
  add column if not exists pitch_horizontal_chord_deviation_units double precision,
  add column if not exists pitch_vertical_chord_deviation_units double precision,
  add column if not exists pitch_tracking_sample_count integer,
  add column if not exists pitch_tracking_start_seq bigint,
  add column if not exists pitch_tracking_end_seq bigint,
  add column if not exists pitch_tracking_status text,
  add column if not exists pitch_tracking_terminal text,
  add column if not exists pitch_tracking_classifier text,
  add column if not exists pitch_tracking_classifier_status text;

alter table if exists public.season_pitches
  add column if not exists is_star_swing boolean not null default false,
  add column if not exists pitch_speed_mph double precision,
  add column if not exists pitch_elapsed_seconds double precision,
  add column if not exists pitch_path_distance_ft double precision,
  add column if not exists pitch_direct_distance_units double precision,
  add column if not exists pitch_horizontal_delta_units double precision,
  add column if not exists pitch_vertical_delta_units double precision,
  add column if not exists pitch_forward_delta_units double precision,
  add column if not exists pitch_horizontal_range_units double precision,
  add column if not exists pitch_vertical_range_units double precision,
  add column if not exists pitch_horizontal_chord_deviation_units double precision,
  add column if not exists pitch_vertical_chord_deviation_units double precision,
  add column if not exists pitch_tracking_sample_count integer,
  add column if not exists pitch_tracking_start_seq bigint,
  add column if not exists pitch_tracking_end_seq bigint,
  add column if not exists pitch_tracking_status text,
  add column if not exists pitch_tracking_terminal text,
  add column if not exists pitch_tracking_classifier text,
  add column if not exists pitch_tracking_classifier_status text;
