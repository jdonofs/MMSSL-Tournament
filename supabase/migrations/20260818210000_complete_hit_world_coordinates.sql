-- Complete the tracker world-coordinate schema on both competition modes.
--
-- The first migration added hit_world_* only to tournament plate appearances,
-- while the live bridge writes season_plate_appearances too. It also began
-- writing hit_position_estimated without creating that column. A season game
-- would therefore reject the whole PA payload even though tracking succeeded.

alter table public.plate_appearances
  add column if not exists hit_world_x numeric(8,3),
  add column if not exists hit_world_y numeric(8,3),
  add column if not exists hit_world_z numeric(8,3),
  add column if not exists hit_position_estimated boolean not null default false;
alter table public.season_plate_appearances
  add column if not exists hit_world_x numeric(8,3),
  add column if not exists hit_world_y numeric(8,3),
  add column if not exists hit_world_z numeric(8,3),
  add column if not exists hit_position_estimated boolean not null default false;
comment on column public.plate_appearances.hit_position_estimated is
  'True when hit_world_x/z is a trajectory or launch-model projection rather than a tracked endpoint.';
comment on column public.season_plate_appearances.hit_position_estimated is
  'True when hit_world_x/z is a trajectory or launch-model projection rather than a tracked endpoint.';
comment on column public.season_plate_appearances.hit_world_x is
  'Landing/catch X in game world units (metres), +X toward first base.';
comment on column public.season_plate_appearances.hit_world_y is
  'Tracked endpoint height in game world units (metres); null for projected positions.';
comment on column public.season_plate_appearances.hit_world_z is
  'Landing/catch Z in game world units (metres), -Z toward centre field.';
