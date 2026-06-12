alter table public.season_waivers
  add column if not exists denied_team_ids integer[] not null default '{}'::integer[];
