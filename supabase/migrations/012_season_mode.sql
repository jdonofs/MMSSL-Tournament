create table if not exists seasons (
  id serial primary key,
  name text not null,
  status text not null default 'draft',
  league_type text not null,
  games_per_matchup int not null default 3,
  keeper_count int,
  auction_budget int,
  playoff_format text not null default 'double_elimination',
  innings int not null default 9,
  mercy_rule boolean not null default true,
  champion_player_id uuid references players(id),
  created_at timestamptz default now()
);

create table if not exists season_teams (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  player_id uuid references players(id),
  team_name text,
  team_logo_key text,
  wins int default 0,
  losses int default 0,
  run_differential int default 0,
  home_wins int default 0,
  home_losses int default 0,
  away_wins int default 0,
  away_losses int default 0,
  created_at timestamptz default now()
);

create table if not exists season_roster (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  team_id int references season_teams(id) on delete cascade,
  character_name text not null,
  acquired_via text not null,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists season_auction_bids (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  character_name text not null,
  nominating_team_id int references season_teams(id),
  winning_team_id int references season_teams(id),
  winning_bid int,
  status text default 'open',
  created_at timestamptz default now()
);

create table if not exists season_auction_bid_entries (
  id serial primary key,
  auction_bid_id int references season_auction_bids(id) on delete cascade,
  team_id int references season_teams(id),
  amount int not null,
  placed_at timestamptz default now()
);

create table if not exists season_schedule (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  home_team_id int references season_teams(id),
  away_team_id int references season_teams(id),
  round_number int not null,
  stage text,
  status text default 'scheduled',
  home_score int,
  away_score int,
  stadium_picker_team_id int references season_teams(id),
  stadium text,
  is_night boolean default false,
  is_extra_innings boolean default false,
  final_inning int,
  winner_team_id int references season_teams(id),
  created_at timestamptz default now()
);

create table if not exists season_lineups (
  id serial primary key,
  game_id int references season_schedule(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  player_id uuid references players(id),
  character_id int references characters(id),
  batting_order int,
  created_at timestamptz default now()
);

create table if not exists season_plate_appearances (
  id serial primary key,
  game_id int references season_schedule(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  player_id uuid references players(id),
  character_id int references characters(id),
  inning int,
  pa_number int,
  result text,
  rbi int default 0,
  run_scored boolean default false,
  trajectory text,
  hit_location text,
  hit_notation text,
  direction text,
  star_hit_used boolean default false,
  star_hit_connected boolean default false,
  star_hit_result text,
  star_hit_rbi int,
  star_pitch_used boolean default false,
  star_pitch_successful boolean default false,
  is_error boolean default false,
  error_position text,
  error_character text,
  error_player text,
  error_notation text,
  is_earned_run boolean default true,
  strikeout_type text,
  is_official_ab boolean default true,
  batting_team_id int references season_teams(id),
  defensive_team_id int references season_teams(id),
  pitcher_id int references characters(id),
  pitcher_player_id uuid references players(id),
  fielder_choice_out boolean default false,
  created_at timestamptz default now()
);

create table if not exists season_pitching_stints (
  id serial primary key,
  game_id int references season_schedule(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  player_id uuid references players(id),
  character_id int references characters(id),
  innings_pitched numeric,
  hits_allowed int default 0,
  runs_allowed int default 0,
  earned_runs int default 0,
  walks int default 0,
  strikeouts int default 0,
  hr_allowed int default 0,
  win boolean default false,
  loss boolean default false,
  save boolean default false,
  shutout boolean default false,
  complete_game boolean default false,
  created_at timestamptz default now()
);

create table if not exists season_inning_scores (
  id serial primary key,
  game_id int references season_schedule(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  team_id int references season_teams(id),
  inning int not null,
  runs int default 0
);

create table if not exists season_pitches (
  id uuid primary key default gen_random_uuid(),
  game_id int references season_schedule(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  pa_id int references season_plate_appearances(id) on delete cascade,
  pitcher_id text,
  pitcher_player text,
  batter_id text,
  inning integer,
  half text,
  pitch_number_pa integer,
  pitch_number_game integer,
  is_star_pitch boolean default false,
  result text,
  count_balls_before integer,
  count_strikes_before integer,
  count_balls_after integer,
  count_strikes_after integer,
  created_at timestamptz default now()
);

create table if not exists season_game_fielders (
  id uuid primary key default gen_random_uuid(),
  game_id int references season_schedule(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  team_id int references season_teams(id),
  player_name text,
  character text,
  position integer,
  inning_from integer default 1,
  inning_to integer,
  created_at timestamptz default now()
);

create table if not exists season_runs_scored (
  id uuid primary key default gen_random_uuid(),
  game_id int references season_schedule(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  pa_id int references season_plate_appearances(id) on delete cascade,
  inning integer,
  half text,
  scoring_player_id uuid references players(id),
  scoring_character_id integer references characters(id),
  charged_to_pitcher_id integer references characters(id),
  charged_to_pitcher_player_id uuid references players(id),
  is_earned_run boolean default true,
  created_at timestamptz default now()
);

create table if not exists season_trades (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  proposing_team_id int references season_teams(id),
  receiving_team_id int references season_teams(id),
  status text default 'pending',
  proposed_at timestamptz default now(),
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists season_trade_players (
  id serial primary key,
  trade_id int references season_trades(id) on delete cascade,
  character_name text not null,
  from_team_id int references season_teams(id),
  to_team_id int references season_teams(id)
);

create table if not exists season_waivers (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  claiming_team_id int references season_teams(id),
  dropping_character text,
  claiming_character text not null,
  status text default 'pending',
  priority_order int not null,
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists season_bets (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  game_id int references season_schedule(id) on delete cascade,
  player_id uuid references players(id),
  bet_type text not null,
  target_entity text,
  chosen_side text,
  odds int,
  predicted_probability numeric(6,4),
  line numeric,
  wager_dollars int not null,
  potential_payout_dollars int,
  status text default 'pending',
  result_correct boolean,
  placed_at timestamptz default now(),
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists season_betting_ledger (
  id serial primary key,
  season_id int references seasons(id) on delete cascade,
  player_id uuid references players(id),
  game_id int references season_schedule(id) on delete cascade,
  bet_id int references season_bets(id),
  dollars_change int not null,
  reason text,
  created_at timestamptz default now()
);

create table if not exists season_game_odds (
  id serial primary key,
  game_id int references season_schedule(id) on delete cascade,
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

create table if not exists season_game_settlements (
  id serial primary key,
  game_id int references season_schedule(id) on delete cascade,
  from_player_id uuid references players(id),
  to_player_id uuid references players(id),
  dollars numeric(10,2) default 0,
  settled_at timestamptz default now()
);

create table if not exists season_stadium_game_log (
  id uuid primary key default gen_random_uuid(),
  game_id int unique references season_schedule(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  stadium text,
  is_night boolean default false,
  total_runs int,
  confidence numeric default 1.0,
  created_at timestamptz default now()
);

alter table seasons disable row level security;
alter table season_teams disable row level security;
alter table season_roster disable row level security;
alter table season_auction_bids disable row level security;
alter table season_auction_bid_entries disable row level security;
alter table season_schedule disable row level security;
alter table season_lineups disable row level security;
alter table season_plate_appearances disable row level security;
alter table season_pitching_stints disable row level security;
alter table season_inning_scores disable row level security;
alter table season_pitches disable row level security;
alter table season_game_fielders disable row level security;
alter table season_runs_scored disable row level security;
alter table season_trades disable row level security;
alter table season_trade_players disable row level security;
alter table season_waivers disable row level security;
alter table season_bets disable row level security;
alter table season_betting_ledger disable row level security;
alter table season_game_odds disable row level security;
alter table season_game_settlements disable row level security;
alter table season_stadium_game_log disable row level security;
