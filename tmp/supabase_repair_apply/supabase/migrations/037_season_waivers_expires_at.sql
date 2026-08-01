alter table public.season_waivers
  add column if not exists expires_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists awarded_to_team_id integer;
