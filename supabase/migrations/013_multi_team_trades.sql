create table if not exists season_trade_proposals (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  created_by_player_id uuid references players(id),
  created_by_team_id int references season_teams(id),
  status text not null default 'pending',
  notes text,
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists season_trade_proposal_teams (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  proposal_id int references season_trade_proposals(id) on delete cascade,
  team_id int references season_teams(id) on delete cascade,
  decision_status text not null default 'pending',
  decided_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists season_trade_proposal_moves (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  proposal_id int references season_trade_proposals(id) on delete cascade,
  roster_id int references season_roster(id) on delete cascade,
  character_name text not null,
  from_team_id int references season_teams(id),
  to_team_id int references season_teams(id),
  created_at timestamptz default now()
);

create unique index if not exists season_trade_proposal_teams_unique_idx
  on season_trade_proposal_teams (proposal_id, team_id);

create unique index if not exists season_trade_proposal_moves_unique_idx
  on season_trade_proposal_moves (proposal_id, roster_id);

create index if not exists season_trade_proposals_season_idx
  on season_trade_proposals (season_id, status);

create index if not exists season_trade_proposal_teams_season_idx
  on season_trade_proposal_teams (season_id, team_id, decision_status);

create index if not exists season_trade_proposal_moves_season_idx
  on season_trade_proposal_moves (season_id, from_team_id, to_team_id);

alter table season_trade_proposals disable row level security;
alter table season_trade_proposal_teams disable row level security;
alter table season_trade_proposal_moves disable row level security;
