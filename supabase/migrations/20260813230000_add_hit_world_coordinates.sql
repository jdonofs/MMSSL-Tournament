-- Store batted-ball landing positions in the game's own world units.
--
-- hit_x/hit_y (added in 048) are PERCENTAGES ON A STADIUM SCREENSHOT. That was
-- the right shape when a human tapping an image was the only input, but the
-- tracker reads the ball's actual coordinates out of the game, and projecting
-- those onto an image calibrated from three hand-tapped points throws away the
-- precision at the last step.
--
-- These columns keep the measurement itself. Everything else -- spray position,
-- distance, whether it cleared the fence -- can be derived from them exactly,
-- against the measured park geometry in src/utils/parkGeometry.js.
--
-- Nullable and purely additive. hit_x/hit_y stay as they are: historical rows
-- and manual taps continue to work unchanged, and nothing is rewritten. The
-- two coexist by design -- see the note on hit_angle_deg below for why the
-- older columns cannot simply be regenerated from these.
alter table plate_appearances
  add column if not exists hit_world_x numeric(8,3),
  add column if not exists hit_world_y numeric(8,3),
  add column if not exists hit_world_z numeric(8,3);

comment on column plate_appearances.hit_world_x is
  'Landing/catch X in game world units, home plate near origin, +X toward first base. Null for manual taps and historical rows.';
comment on column plate_appearances.hit_world_y is
  'Endpoint HEIGHT above the ground in game units. Not decoration: a home run into the stands ends ~9 units up and one off the top of the wall ~4.6, and a marker drawn at the ground point below it reads short in a perspective view of the park.';
comment on column plate_appearances.hit_world_z is
  'Landing/catch Z in game world units, -Z toward centre field. Null for manual taps and historical rows.';

-- Worth stating plainly, because it is the trap: hit_angle_deg is the LAUNCH
-- direction, measured a few frames after contact, and a curving ball does not
-- keep it. On a real tracked landing the launch and landing directions differed
-- by 10 degrees, which is about 40 feet at the fence. So hit_angle_deg is the
-- correct value for "which way was it hit" as a stat, and the WRONG value for
-- "where did it come down". Positions come from these world columns.
