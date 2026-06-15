-- Ensure realtime postgres_changes events for team_lineups/season_team_lineups
-- always carry the full row (matches the approach used for draft_picks /
-- season_roster in migration 033), so filters on tournament_id/season_id and
-- DELETE payloads are reliable for every subscriber.

alter table public.team_lineups replica identity full;
alter table public.season_team_lineups replica identity full;
