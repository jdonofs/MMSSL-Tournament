-- Mirrors 057_game_video_url.sql onto season_schedule, the season equivalent
-- of games.
alter table season_schedule
  add column if not exists video_url text;
