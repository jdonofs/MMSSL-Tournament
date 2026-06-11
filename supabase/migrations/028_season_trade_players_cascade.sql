-- Deleting a season cascades to season_teams, but season_trade_players.from_team_id
-- and to_team_id referenced season_teams without ON DELETE CASCADE, blocking
-- season deletion with a foreign key violation. Add cascade so trade history
-- for a deleted season is removed along with its teams.

alter table public.season_trade_players
  drop constraint if exists season_trade_players_from_team_id_fkey,
  add constraint season_trade_players_from_team_id_fkey
    foreign key (from_team_id) references public.season_teams(id) on delete cascade;

alter table public.season_trade_players
  drop constraint if exists season_trade_players_to_team_id_fkey,
  add constraint season_trade_players_to_team_id_fkey
    foreign key (to_team_id) references public.season_teams(id) on delete cascade;
