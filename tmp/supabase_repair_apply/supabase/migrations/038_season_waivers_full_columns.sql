alter table public.season_waivers
  add column if not exists denied_team_ids integer[] not null default '{}'::integer[],
  add column if not exists source_team_id integer,
  add column if not exists claiming_character text,
  add column if not exists status text not null default 'active',
  add column if not exists expires_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists awarded_to_team_id integer,
  add column if not exists created_at timestamptz not null default now();

alter table public.season_waivers
  alter column priority_order drop not null;
