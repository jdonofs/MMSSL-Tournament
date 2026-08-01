-- Captures the user-entered hang time (seconds of flight) for a batted-ball
-- plate appearance, plus the exit velocity and launch angle derived from it
-- via projectile motion against the already-recorded hit_distance_ft. Entry
-- happens after the game (from film), one hit at a time, in the Scorebook's
-- Exit Velocity tab. All nullable: only balls in play with a hang time
-- entered get values. Computed once at save time and stored, matching the
-- hit_distance_ft/hit_angle_deg convention from migration 048.
alter table plate_appearances
  add column if not exists hang_time_sec numeric(4,2),
  add column if not exists exit_velocity_mph numeric(5,1),
  add column if not exists launch_angle_deg numeric(5,1);
