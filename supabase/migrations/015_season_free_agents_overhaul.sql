alter table season_waivers
  alter column priority_order drop not null;

alter table season_waivers
  add column if not exists source_team_id int references season_teams(id),
  add column if not exists expires_at timestamptz,
  add column if not exists denied_team_ids int[] not null default '{}'::int[],
  add column if not exists awarded_to_team_id int references season_teams(id);

update season_waivers
set expires_at = coalesce(expires_at, created_at + interval '7 days');

delete from season_waivers;

create table if not exists season_waiver_claims (
  id serial primary key,
  waiver_id int not null references season_waivers(id) on delete cascade,
  season_id int not null references seasons(id) on delete cascade,
  claiming_team_id int not null references season_teams(id),
  dropping_character text not null,
  priority_order int not null,
  status text not null default 'pending',
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create unique index if not exists season_waiver_claims_waiver_team_unique
  on season_waiver_claims (waiver_id, claiming_team_id);

alter table season_waiver_claims disable row level security;
