alter table plate_appearances
  add column if not exists trajectory text,
  add column if not exists hit_location text,
  add column if not exists hit_notation text,
  add column if not exists direction text,
  add column if not exists star_hit_used boolean default false,
  add column if not exists star_hit_connected boolean default false,
  add column if not exists star_hit_result text,
  add column if not exists star_hit_rbi integer default 0,
  add column if not exists star_pitch_used boolean default false,
  add column if not exists star_pitch_successful boolean default false,
  add column if not exists is_error boolean default false,
  add column if not exists error_position text,
  add column if not exists error_character text,
  add column if not exists error_player text,
  add column if not exists error_notation text,
  add column if not exists is_earned_run boolean default true,
  add column if not exists strikeout_type text,
  add column if not exists is_official_ab boolean default true,
  add column if not exists batting_team_id uuid references players(id),
  add column if not exists defensive_team_id uuid references players(id),
  add column if not exists pitcher_id integer references characters(id),
  add column if not exists pitcher_player_id uuid references players(id),
  add column if not exists fielder_choice_out boolean default false;

create table if not exists pitches (
  id uuid primary key default gen_random_uuid(),
  game_id integer references games(id) on delete cascade,
  pa_id integer references plate_appearances(id) on delete cascade,
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

create table if not exists game_fielders (
  id uuid primary key default gen_random_uuid(),
  game_id integer references games(id) on delete cascade,
  team_id uuid references players(id),
  player_name text,
  character text,
  position integer,
  inning_from integer default 1,
  inning_to integer,
  created_at timestamptz default now()
);

create table if not exists runs_scored (
  id uuid primary key default gen_random_uuid(),
  game_id integer references games(id) on delete cascade,
  pa_id integer references plate_appearances(id) on delete cascade,
  inning integer,
  half text,
  scoring_player_id uuid references players(id),
  scoring_character_id integer references characters(id),
  charged_to_pitcher_id integer references characters(id),
  charged_to_pitcher_player_id uuid references players(id),
  is_earned_run boolean default true,
  created_at timestamptz default now()
);

create index if not exists idx_pitches_game_pa on pitches(game_id, pa_id, created_at);
create index if not exists idx_game_fielders_lookup on game_fielders(game_id, team_id, inning_from, inning_to, position);
create index if not exists idx_runs_scored_game_pa on runs_scored(game_id, pa_id, created_at);

alter table pitches disable row level security;
alter table game_fielders disable row level security;
alter table runs_scored disable row level security;
