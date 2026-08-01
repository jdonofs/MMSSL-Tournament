-- Captures the raw tap coordinates and computed distance/angle for each
-- batted-ball plate appearance from the "Build The Play" field UI.
-- All nullable: historical PAs, walks/Ks, and outs recorded without a tap
-- stay null. Distance/angle are computed once at save time and stored
-- (not recomputed downstream) so future calibration tweaks to the
-- angular-interpolation math don't retroactively rewrite historical stats.
alter table plate_appearances
  add column if not exists hit_x numeric(5,2),
  add column if not exists hit_y numeric(5,2),
  add column if not exists hit_distance_ft numeric(6,1),
  add column if not exists hit_angle_deg numeric(5,1),
  add column if not exists hit_stadium_key text;
