-- Mirrors 059_plate_appearance_video_timestamps.sql onto
-- season_plate_appearances. See that file for rationale.
alter table season_plate_appearances
  add column if not exists video_timestamp_start_sec numeric(7,2),
  add column if not exists video_timestamp_end_sec numeric(7,2);
