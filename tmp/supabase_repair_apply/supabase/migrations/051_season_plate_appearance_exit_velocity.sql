-- Mirrors migration 050 onto season_plate_appearances, the parallel table
-- used for season (non-tournament) games. See 050 for column rationale.
alter table season_plate_appearances
  add column if not exists hang_time_sec numeric(4,2),
  add column if not exists exit_velocity_mph numeric(5,1),
  add column if not exists launch_angle_deg numeric(5,1);
