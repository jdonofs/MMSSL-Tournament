-- Backfill: HR/IPHR plate appearances where the stored `rbi` is missing credit for
-- the batter's own run. Caused by a since-fixed bug (commit c14fcae removed the
-- `runnersToScore.length - 1` that dropped the batter from the RBI count) — these
-- 24 rows were recorded before that fix. Correct rbi = count of matching rows in
-- season_runs_scored for that pa_id (the authoritative runner-credit table).
--
-- Verified against season_runs_scored before running; every mismatch below is
-- exactly "stored rbi + 1" (the batter's own run). No tournament (non-season)
-- games needed this — the tournament runs_scored table has zero rows (all
-- tournament games predate that table and already carried correct rbi values).

update season_plate_appearances set rbi = 2 where id = 823;
update season_plate_appearances set rbi = 3 where id = 828;
update season_plate_appearances set rbi = 1 where id = 871;
update season_plate_appearances set rbi = 1 where id = 880;
update season_plate_appearances set rbi = 3 where id = 914;
update season_plate_appearances set rbi = 1 where id = 952;
update season_plate_appearances set rbi = 1 where id = 955;
update season_plate_appearances set rbi = 1 where id = 967;
update season_plate_appearances set rbi = 1 where id = 977;
update season_plate_appearances set rbi = 2 where id = 998;
update season_plate_appearances set rbi = 1 where id = 1000;
update season_plate_appearances set rbi = 2 where id = 1004;
update season_plate_appearances set rbi = 2 where id = 1024;
update season_plate_appearances set rbi = 1 where id = 1025;
update season_plate_appearances set rbi = 1 where id = 1044;
update season_plate_appearances set rbi = 1 where id = 1052;
update season_plate_appearances set rbi = 1 where id = 1069;
update season_plate_appearances set rbi = 1 where id = 1073;
update season_plate_appearances set rbi = 1 where id = 1085;
update season_plate_appearances set rbi = 2 where id = 1096;
update season_plate_appearances set rbi = 3 where id = 1109;
update season_plate_appearances set rbi = 1 where id = 1111;
update season_plate_appearances set rbi = 1 where id = 1112;
update season_plate_appearances set rbi = 1 where id = 1120;
