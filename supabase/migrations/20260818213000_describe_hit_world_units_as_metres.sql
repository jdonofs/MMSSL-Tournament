-- Make the canonical unit explicit in database metadata for both game modes.
-- The columns themselves are unchanged; 1 game world unit is exactly 1 metre.

comment on column public.plate_appearances.hit_world_x is
  'Landing/catch X in game world units (metres), +X toward first base. Null for manual taps and historical rows.';
comment on column public.plate_appearances.hit_world_y is
  'Tracked endpoint height in game world units (metres); null for projected positions.';
comment on column public.plate_appearances.hit_world_z is
  'Landing/catch Z in game world units (metres), -Z toward centre field. Null for manual taps and historical rows.';
comment on column public.season_plate_appearances.hit_world_x is
  'Landing/catch X in game world units (metres), +X toward first base. Null for manual taps and historical rows.';
comment on column public.season_plate_appearances.hit_world_y is
  'Tracked endpoint height in game world units (metres); null for projected positions.';
comment on column public.season_plate_appearances.hit_world_z is
  'Landing/catch Z in game world units (metres), -Z toward centre field. Null for manual taps and historical rows.';
