-- Betting tab schema
-- Run this in the Supabase SQL editor or via supabase migration up

create table if not exists game_odds (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  bet_type text not null,
  target_entity text,
  line numeric,
  odds_home int,
  odds_away int,
  odds_over int,
  odds_under int,
  odds_yes int,
  odds_no int,
  predicted_probability numeric(6,4),
  is_locked boolean default false,
  updated_at timestamptz default now()
);

alter table if exists bets
  add column if not exists player_id uuid references players(id);
alter table if exists bets
  add column if not exists game_odds_id int references game_odds(id) on delete set null;
alter table if exists bets
  add column if not exists target_entity text;
alter table if exists bets
  add column if not exists chosen_side text;
alter table if exists bets
  add column if not exists odds int;
alter table if exists bets
  add column if not exists predicted_probability numeric(6,4);
alter table if exists bets
  add column if not exists wager_type text default 'sips';
alter table if exists bets
  add column if not exists wager_sips numeric(6,1);
alter table if exists bets
  add column if not exists potential_payout_sips numeric(6,1);
alter table if exists bets
  add column if not exists status text default 'open';
alter table if exists bets
  add column if not exists result_correct boolean;
alter table if exists bets
  add column if not exists placed_at timestamptz default now();

update bets
set player_id = coalesce(player_id, bettor_player_id)
where player_id is null and bettor_player_id is not null;

create table if not exists game_settlements (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  from_player_id uuid references players(id),
  to_player_id uuid references players(id),
  sips numeric(6,1) default 0,
  is_finish_drink boolean default false,
  settled_at timestamptz default now()
);

create table if not exists odds_calibration_log (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  game_odds_id int references game_odds(id) on delete set null,
  bet_type text,
  target_entity text,
  predicted_probability numeric(6,4),
  american_odds int,
  actual_outcome boolean,
  brier_contribution float,
  logged_at timestamptz default now()
);

create table if not exists odds_engine_weights (
  id int primary key default 1 check (id = 1),
  char_stats_weight numeric(6,4) default 0.333,
  historical_weight numeric(6,4) default 0.333,
  live_weight numeric(6,4) default 0.334,
  games_evaluated int default 0,
  last_brier_score float,
  updated_at timestamptz default now()
);

insert into odds_engine_weights (id)
values (1)
on conflict (id) do nothing;

alter table if exists game_odds disable row level security;
alter table if exists game_settlements disable row level security;
alter table if exists odds_calibration_log disable row level security;
alter table if exists odds_engine_weights disable row level security;
