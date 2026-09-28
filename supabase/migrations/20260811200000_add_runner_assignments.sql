alter table public.plate_appearances
  add column if not exists runner_assignments jsonb;
alter table public.season_plate_appearances
  add column if not exists runner_assignments jsonb;
comment on column public.plate_appearances.runner_assignments is
  'Resolved per-runner destinations for exact base-state replay.';
comment on column public.season_plate_appearances.runner_assignments is
  'Resolved per-runner destinations for exact base-state replay.';
