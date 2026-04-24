create extension if not exists pgcrypto;

drop table if exists points_ledger;
drop table if exists odds_calibration_log;
drop table if exists game_settlements;
drop table if exists game_odds;
drop table if exists odds_engine_weights;
drop table if exists bets;
drop table if exists pitching_stints;
drop table if exists plate_appearances;
drop table if exists lineups;
drop table if exists inning_scores;
drop table if exists stadium_game_log;
drop table if exists games;
drop table if exists stadiums;
drop table if exists draft_picks;
drop table if exists tournaments;
drop table if exists characters;
drop table if exists players;

create table players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text,
  created_at timestamptz default now()
);

create table characters (
  id serial primary key,
  name text not null unique,
  pitching int,
  batting int,
  fielding int,
  speed int
);

create table tournaments (
  id serial primary key,
  tournament_number int not null,
  date date,
  player_count int,
  status text default 'pending',
  champion_player_id uuid references players(id),
  created_at timestamptz default now()
);

create table draft_picks (
  id serial primary key,
  tournament_id int references tournaments(id) on delete cascade,
  pick_number int,
  round int,
  pick_in_round int,
  player_id uuid references players(id),
  character_id int references characters(id),
  mii_color text,
  picked_at timestamptz default now()
);

create table games (
  id serial primary key,
  tournament_id int references tournaments(id) on delete cascade,
  game_code text,
  stage text,
  team_a_player_id uuid references players(id),
  team_b_player_id uuid references players(id),
  winner_player_id uuid references players(id),
  team_a_runs int default 0,
  team_b_runs int default 0,
  status text default 'pending',
  created_at timestamptz default now()
);

create table stadiums (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  lf_distance int,
  cf_distance int,
  rf_distance int,
  chaos_level int default 0,
  fielding_disruption_level int default 0,
  description text,
  night_only boolean default false,
  day_only boolean default false
);

alter table games
  add column if not exists stadium_id uuid references stadiums(id),
  add column if not exists is_night boolean default false;

create table stadium_game_log (
  id uuid primary key default gen_random_uuid(),
  game_id int unique references games(id) on delete cascade,
  stadium_id uuid references stadiums(id),
  is_night boolean default false,
  total_runs int,
  confidence numeric default 1.0,
  created_at timestamptz default now()
);

create table inning_scores (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  player_id uuid references players(id),
  inning int,
  runs int default 0
);

create table lineups (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  player_id uuid references players(id),
  character_id int references characters(id),
  batting_order int
);

create table plate_appearances (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  player_id uuid references players(id),
  character_id int references characters(id),
  inning int,
  pa_number int,
  result text,
  rbi int default 0,
  run_scored boolean default false,
  created_at timestamptz default now()
);

create table pitching_stints (
  id serial primary key,
  game_id int references games(id) on delete cascade,
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

create table bets (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  player_id uuid references players(id),
  game_odds_id int,
  bet_type text,
  target_entity text,
  chosen_side text,
  odds int,
  predicted_probability numeric(6,4),
  wager_type text default 'sips',
  wager_sips numeric(6,1),
  potential_payout_sips numeric(6,1),
  line numeric,
  status text default 'open',
  result_correct boolean,
  placed_at timestamptz default now(),
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create table game_odds (
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

alter table bets
  add constraint bets_game_odds_id_fkey
  foreign key (game_odds_id) references game_odds(id) on delete set null;

create table game_settlements (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  from_player_id uuid references players(id),
  to_player_id uuid references players(id),
  sips numeric(6,1) default 0,
  is_finish_drink boolean default false,
  settled_at timestamptz default now()
);

create table odds_calibration_log (
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

create table odds_engine_weights (
  id int primary key default 1 check (id = 1),
  char_stats_weight numeric(6,4) default 0.333,
  historical_weight numeric(6,4) default 0.333,
  live_weight numeric(6,4) default 0.334,
  games_evaluated int default 0,
  last_brier_score float,
  updated_at timestamptz default now()
);

create table points_ledger (
  id serial primary key,
  player_id uuid references players(id),
  tournament_id int references tournaments(id),
  game_id int references games(id),
  bet_id int references bets(id),
  points_change int,
  reason text,
  created_at timestamptz default now()
);

alter table players disable row level security;
alter table characters disable row level security;
alter table tournaments disable row level security;
alter table draft_picks disable row level security;
alter table games disable row level security;
alter table stadiums disable row level security;
alter table stadium_game_log disable row level security;
alter table inning_scores disable row level security;
alter table lineups disable row level security;
alter table plate_appearances disable row level security;
alter table pitching_stints disable row level security;
alter table bets disable row level security;
alter table game_odds disable row level security;
alter table game_settlements disable row level security;
alter table odds_calibration_log disable row level security;
alter table odds_engine_weights disable row level security;
alter table points_ledger disable row level security;

insert into stadiums (name, lf_distance, cf_distance, rf_distance, chaos_level, fielding_disruption_level, description, night_only, day_only) values
('Mario Stadium', 259, 317, 259, 0, 0, 'No gimmicks. Pure baseball. True neutral park.', false, false),
('Peach Ice Garden', 314, 402, 313, 1, 2, 'Massive walls suppress HRs. Freezies stun fielders. Night: stadium blackout event.', false, false),
('DK Jungle', 274, 323, 275, 2, 2, 'Barrels crush fielders. Poison flowers slow them. Tree roots suppress center field hits.', false, false),
('Wario City', 292, 297, 289, 2, 2, 'Short fence everywhere, especially shallow center. Manholes and directional arrows disrupt plays.', false, false),
('Yoshi Park', 253, 324, 254, 3, 3, 'Short lines. Day: warp pipes teleport the ball randomly. Night: Piranha Plants eat and spit ball.', false, false),
('Bowser Jr. Playroom', 262, 328, 264, 2, 2, 'High walls suppress HRs hard. Chain Chomps and Bullet Bills chase fielders.', false, true),
('Daisy Cruiser', 232, 328, 231, 3, 3, 'Shortest lines in the game. Day: tables stun fielders. Night: Cheep Cheeps + Gooper Blooper tilts entire field.', false, false),
('Luigi''s Mansion', 282, 351, 287, 3, 3, 'Ghosts attack fielders. Tall grass hides the ball. Night only.', true, false),
('Bowser Castle', 278, 334, 277, 4, 4, 'Tall walls + Thwomps suppress HRs. Lava Bubbles, fireballs, and Bob-ombs create constant chaos.', true, false);

insert into characters (name, pitching, batting, fielding, speed) values
('Daisy', 7, 6, 8, 5),
('Luigi', 6, 6, 7, 7),
('Mario', 6, 7, 6, 7),
('Peach', 9, 4, 8, 5),
('Waluigi', 8, 4, 8, 5),
('Birdo', 4, 8, 7, 5),
('Mii', 6, 6, 6, 6),
('Bowser Jr.', 5, 7, 4, 7),
('Diddy Kong', 5, 4, 8, 6),
('Yoshi', 4, 4, 6, 9),
('Tiny Kong', 5, 5, 7, 5),
('Baby DK', 3, 6, 8, 4),
('Baby Daisy', 6, 4, 5, 6),
('Baby Peach', 8, 2, 5, 6),
('Blooper', 6, 4, 5, 6),
('Blue Kritter', 5, 6, 7, 3),
('Bowser', 5, 10, 3, 3),
('Brown Kritter', 3, 7, 7, 4),
('Dark Bones', 5, 7, 4, 5),
('Funky Kong', 4, 8, 6, 3),
('King Boo', 7, 7, 3, 4),
('Kritter', 4, 7, 7, 3),
('Paragoomba', 6, 3, 7, 5),
('Petey Piranha', 4, 10, 5, 2),
('Red Kritter', 3, 8, 7, 3),
('Wiggler', 3, 7, 4, 7),
('Baby Luigi', 5, 2, 5, 8),
('Baby Mario', 5, 3, 4, 8),
('Blue Dry Bones', 3, 7, 5, 5),
('Blue Noki', 5, 4, 4, 7),
('Blue Shy Guy', 5, 4, 7, 4),
('Blue Toad', 4, 6, 3, 7),
('Blue Yoshi', 4, 2, 6, 8),
('Boo', 9, 3, 3, 5),
('Boomerang Bro', 5, 7, 5, 3),
('Donkey Kong', 6, 9, 3, 2),
('Dry Bones', 4, 7, 4, 5),
('Fire Bro', 3, 8, 6, 3),
('Gray Shy Guy', 4, 4, 8, 4),
('Green Dry Bones', 3, 7, 4, 6),
('Green Noki', 4, 5, 4, 7),
('Green Paratroopa', 3, 5, 7, 5),
('Green Shy Guy', 3, 5, 7, 5),
('Green Toad', 4, 5, 4, 7),
('Hammer Bro', 4, 7, 6, 3),
('Light-Blue Yoshi', 3, 3, 6, 8),
('Magikoopa', 8, 2, 8, 2),
('Monty Mole', 4, 4, 5, 7),
('Paratroopa', 4, 4, 7, 5),
('Pink Yoshi', 2, 3, 6, 9),
('Purple Toad', 5, 6, 2, 7),
('Red Magikoopa', 8, 3, 8, 1),
('Red Noki', 4, 4, 5, 7),
('Red Toad', 5, 5, 3, 7),
('Shy Guy', 4, 5, 7, 4),
('Toadette', 5, 3, 4, 8),
('Toadsworth', 7, 3, 7, 3),
('Wario', 5, 8, 3, 4),
('Yellow Magikoopa', 7, 3, 8, 2),
('Yellow Shy Guy', 4, 4, 7, 5),
('Yellow Toad', 3, 6, 4, 7),
('Yellow Yoshi', 3, 4, 6, 7),
('Blue Pianta', 5, 8, 4, 2),
('Dixie Kong', 2, 2, 8, 7),
('Goomba', 6, 3, 6, 4),
('Green Magikoopa', 7, 2, 8, 2),
('King K. Rool', 6, 10, 2, 1),
('Koopa', 3, 6, 4, 6),
('Red Koopa', 4, 6, 3, 6),
('Red Yoshi', 3, 4, 4, 8),
('Red Pianta', 4, 8, 4, 2),
('Yellow Pianta', 4, 8, 4, 2);

insert into players (name, color) values
('Aidan', '#3B82F6'),
('Donovan', '#F97316'),
('Jason', '#22C55E'),
('Justin', '#EF4444'),
('May', '#A855F7'),
('Nick', '#EC4899');

insert into odds_engine_weights (id) values (1);
