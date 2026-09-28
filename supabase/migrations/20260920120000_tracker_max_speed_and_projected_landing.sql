-- The game's own two answers: how fast a character can run, and where a batted
-- ball was going to land.
--
-- Both are read straight out of match memory rather than measured off the
-- flight, and both say something the measured columns beside them cannot.
--
-- MAX SPEED (movement_metrics.max_speed_mps/fps) is the character's top speed
-- from the fielder struct's acceleration constant, which the game stores as
-- max_speed/15 per frame. It correlates with the characters table's own
-- run_speed at 0.97 (rank 0.99) across 65 characters.
--
-- It is NOT a second sprint_speed. sprint_speed_mps on a fielder row measures
-- how far that fielder happened to have to run on that play -- a two-unit
-- shuffle reads 0.5 u/s and a full outfield run reads 7.8 for the same
-- character -- which is why summarizeMovementMetrics reads speed only off
-- runner and batter rows. max_speed has no such problem: it is the attribute,
-- identical on every play, and it is therefore the first speed column on a
-- fielder row that can be averaged.
--
-- PROJECTED LANDING (tracking_plays.projected_landing_*) is where the game
-- worked out the ball would first touch down, written on the contact frame.
-- Against the measured landing it agrees to a median 0.14 units, so it is not a
-- second opinion -- it is the answer in the cases where landing_x/y/z cannot
-- exist or are short by construction: a ball caught in flight never lands, and
-- a ball that clears the fence or hits a wall stops where it was interrupted.
-- In one 110-play session the measured landing covers 61 plays and this covers
-- all 110, including all 8 home runs and all 39 caught balls.
--
-- There is no y: the game stores only the ground plane for this, which is all
-- a landing point needs.

alter table public.movement_metrics
  add column if not exists max_speed_mps double precision,
  add column if not exists max_speed_fps double precision;

comment on column public.movement_metrics.max_speed_mps is
  'The character''s top speed as the game stores it (fielder actor +0x0F0 * 15, '
  'converted from per-frame). An attribute, not a measurement: unlike '
  'sprint_speed_mps it does not depend on how far the actor had to run on this '
  'play, so it is safe to average. Null on runner and batter rows -- the '
  'offense actor class does not carry the field.';

alter table public.tracking_plays
  add column if not exists projected_landing_frame integer,
  add column if not exists projected_landing_x double precision,
  add column if not exists projected_landing_z double precision,
  add column if not exists projected_landing_distance_m double precision;

comment on column public.tracking_plays.projected_landing_x is
  'Where the game itself expected the ball to first touch down, read on the '
  'contact frame. Present for balls that were caught, cleared the fence or '
  'struck a wall, where landing_x/y/z is null or short by construction.';
