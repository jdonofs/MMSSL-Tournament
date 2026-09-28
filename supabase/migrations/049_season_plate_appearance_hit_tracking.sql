-- Mirrors migration 048 onto season_plate_appearances, the parallel table
-- used for season (non-tournament) games. See 048 for column rationale.
alter table season_plate_appearances
  add column if not exists hit_x numeric(5,2),
  add column if not exists hit_y numeric(5,2),
  add column if not exists hit_distance_ft numeric(6,1),
  add column if not exists hit_angle_deg numeric(5,1),
  add column if not exists hit_stadium_key text;
