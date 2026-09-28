-- The subset of the production schema the tracker's persistence path touches,
-- reconstructed from the code that reads and writes it.
--
-- WHY THIS FILE EXISTS AND WHAT IT IS NOT. The tracking and season tables were
-- created directly against Supabase and no DDL for them is in this repository
-- -- `supabase-schema.sql` predates all of them. The migrations in
-- `supabase/migrations/` are therefore written defensively (add column if not
-- exists, skip a table that is not present), and to run them against a real
-- Postgres a table has to exist for them to alter.
--
-- This is a TEST HARNESS, not the production schema. It carries the columns
-- the tracker actually writes plus the keys the migrations index, and nothing
-- else: no betting, no standings, no odds, and none of the columns the site
-- reads but the bridge never touches. A column being absent here says nothing
-- about production. What the tests establish is the behaviour of the
-- migrations' own constraints and functions, which depend only on the columns
-- named below.

create extension if not exists pgcrypto;

create table players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz default now()
);

create table characters (
  id serial primary key,
  name text not null unique
);

create table games (
  id serial primary key,
  tournament_id int,
  status text default 'pending',
  stats_source text default 'manual',
  team_a_runs int default 0,
  team_b_runs int default 0,
  team_a_player_id uuid references players(id),
  team_b_player_id uuid references players(id),
  winner_player_id uuid references players(id),
  innings int default 3,
  final_inning int,
  is_extra_innings boolean default false,
  -- The in-progress batter/pitcher/count the site reads. Written by the bridge
  -- and by the manual scorebook, which is why the bridge writing it is a
  -- protected mutation rather than bookkeeping of its own.
  live_state jsonb,
  created_at timestamptz default now()
);

create table season_schedule (
  id serial primary key,
  season_id int,
  status text default 'scheduled',
  stats_source text default 'manual',
  away_score int default 0,
  home_score int default 0,
  away_team_id int,
  home_team_id int,
  winner_team_id int,
  innings int default 3,
  final_inning int,
  is_extra_innings boolean default false,
  live_state jsonb,
  created_at timestamptz default now()
);

-- The bridge's own live feed, one row per game. `game_id` is unique because
-- every publish is an upsert on it -- the bridge, tracker_publish_live_state
-- and the site's live view all address the row that way.
create table tracker_live_stats (
  id serial primary key,
  game_id int not null unique references games(id) on delete cascade,
  game_info jsonb,
  batting jsonb,
  pitching jsonb,
  live_feed jsonb,
  team_mapping jsonb,
  updated_at timestamptz default now()
);

create table season_tracker_live_stats (
  id serial primary key,
  game_id int not null unique references season_schedule(id) on delete cascade,
  game_info jsonb,
  batting jsonb,
  pitching jsonb,
  live_feed jsonb,
  team_mapping jsonb,
  updated_at timestamptz default now()
);

create table plate_appearances (
  id serial primary key,
  game_id int references games(id) on delete cascade,
  player_id uuid references players(id),
  character_id int references characters(id),
  pitcher_id int references characters(id),
  pitcher_player_id uuid references players(id),
  batting_team_id text,
  defensive_team_id text,
  inning int,
  pa_number int,
  result text,
  rbi int default 0,
  run_scored boolean default false,
  outs_on_play int,
  is_official_ab boolean,
  runner_assignments jsonb,
  trajectory text,
  hit_notation text,
  tracker_contact_seq bigint,
  tracking_contact_frame bigint,
  tracking_session_id bigint,
  created_at timestamptz default now()
);

create table season_plate_appearances (
  id serial primary key,
  season_id int,
  game_id int references season_schedule(id) on delete cascade,
  player_id uuid references players(id),
  character_id int references characters(id),
  pitcher_id int references characters(id),
  pitcher_player_id uuid references players(id),
  batting_team_id text,
  defensive_team_id text,
  inning int,
  pa_number int,
  result text,
  rbi int default 0,
  run_scored boolean default false,
  outs_on_play int,
  is_official_ab boolean,
  runner_assignments jsonb,
  trajectory text,
  hit_notation text,
  tracker_contact_seq bigint,
  tracking_contact_frame bigint,
  tracking_session_id bigint,
  created_at timestamptz default now()
);

create table pitches (
  -- uuid, as in production; a serial id here hid a bigint cast on this key.
  id uuid primary key default gen_random_uuid(),
  game_id int,
  pa_id int references plate_appearances(id) on delete cascade,
  pitch_number_pa int,
  pitch_number_game int,
  inning int,
  half text,
  pitch_type text,
  pitch_result text,
  created_at timestamptz default now()
);

create table season_pitches (
  -- uuid, as in production; a serial id here hid a bigint cast on this key.
  id uuid primary key default gen_random_uuid(),
  season_id int,
  game_id int,
  pa_id int references season_plate_appearances(id) on delete cascade,
  pitch_number_pa int,
  pitch_number_game int,
  inning int,
  half text,
  pitch_type text,
  pitch_result text,
  created_at timestamptz default now()
);

create table runs_scored (
  -- uuid, as in production; a serial id here hid a bigint cast on this key.
  id uuid primary key default gen_random_uuid(),
  game_id int,
  pa_id int references plate_appearances(id) on delete cascade,
  inning int,
  half text,
  scoring_player_id uuid references players(id),
  scoring_character_id int references characters(id),
  charged_to_pitcher_id int,
  charged_to_pitcher_player_id uuid,
  is_earned_run boolean default true,
  created_at timestamptz default now()
);

create table season_runs_scored (
  -- uuid, as in production; a serial id here hid a bigint cast on this key.
  id uuid primary key default gen_random_uuid(),
  season_id int,
  game_id int,
  pa_id int references season_plate_appearances(id) on delete cascade,
  inning int,
  half text,
  scoring_player_id uuid references players(id),
  scoring_character_id int references characters(id),
  charged_to_pitcher_id int,
  charged_to_pitcher_player_id uuid,
  is_earned_run boolean default true,
  created_at timestamptz default now()
);

create table tracking_sessions (
  id bigserial primary key,
  competition_type text not null,
  game_id bigint not null,
  source_id bigint,
  stadium_key text,
  format_version text,
  -- Production's check, as it stood before 20260918133000 widened it. Without
  -- it here the suite passed statuses production refused.
  status text constraint tracking_sessions_status_check check (status in (
    'recording', 'captured', 'derived', 'ingested', 'quarantined', 'failed')),
  recorded_utc timestamptz,
  completed_utc timestamptz,
  raw_stem text not null,
  raw_manifest_path text,
  frame_rate numeric,
  frames bigint,
  missed_frames bigint,
  duration_seconds numeric,
  checksum_sha256 text,
  calibration jsonb default '{}'::jsonb,
  quality jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table tracking_plays (
  id bigserial primary key,
  tracking_session_id bigint references tracking_sessions(id) on delete cascade,
  competition_type text,
  game_id bigint,
  pa_id bigint,
  play_ordinal int,
  inning int,
  inning_half text,
  contact_frame bigint,
  batted_ball_class text,
  quality jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table fielding_opportunities (
  id bigserial primary key,
  tracking_play_id bigint references tracking_plays(id) on delete cascade,
  competition_type text,
  game_id bigint,
  pa_id bigint,
  position text,
  player_id uuid,
  character_id int,
  created_at timestamptz default now()
);

create table movement_metrics (
  id bigserial primary key,
  tracking_play_id bigint references tracking_plays(id) on delete cascade,
  competition_type text,
  game_id bigint,
  pa_id bigint,
  actor_type text,
  actor_slot text,
  player_id uuid,
  character_id int,
  created_at timestamptz default now()
);

create table tracking_throws (
  id bigserial primary key,
  tracking_play_id bigint references tracking_plays(id) on delete cascade,
  competition_type text,
  game_id bigint,
  pa_id bigint,
  throw_sequence int,
  thrower_position text,
  receiver_position text,
  created_at timestamptz default now()
);

-- The two OFFICIAL opportunity tables. They are not tracking facts: one row per
-- baserunning or double-play chance is created by the scorebook, and postgame
-- ingestion only fills in the measured half and the link to the tracking play
-- that measured it. That is exactly why they belong here -- a replacement
-- tracking version has to move those links atomically with the active pointer,
-- and before it does they must still name the version that is active.
create table runner_opportunities (
  id bigserial primary key,
  competition_type text,
  game_id bigint,
  pa_id bigint,
  runner_id text,
  -- Production as it stands before 20260922120000: the table was built for
  -- runners already on a base, so the batter-runner has no origin to start
  -- from. This is the live catalog's definition, verbatim in effect.
  origin_base text constraint runner_opportunities_origin_base_check
    check (origin_base in ('first', 'second', 'third')),
  target_base text,
  responsible_fielder_position text,
  tracking_play_id bigint,
  tracking_throw_id bigint,
  runner_x double precision,
  runner_z double precision,
  runner_speed_mps double precision,
  expected_attempt_probability double precision,
  expected_success_probability double precision,
  runner_run_value double precision,
  arm_run_value double precision,
  model_version text,
  created_at timestamptz default now()
);

create table double_play_opportunities (
  id bigserial primary key,
  competition_type text,
  game_id bigint,
  pa_id bigint,
  tracking_play_id bigint,
  expected_double_play_probability double precision,
  double_plays_added double precision,
  run_value double precision,
  model_version text,
  created_at timestamptz default now()
);
