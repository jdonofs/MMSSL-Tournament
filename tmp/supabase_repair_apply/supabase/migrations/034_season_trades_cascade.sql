-- season_trades.proposing_team_id and receiving_team_id referenced season_teams
-- without ON DELETE CASCADE, which can block season deletion with a foreign key
-- violation (same issue 028 fixed for season_trade_players). Add cascade so
-- trade history for a deleted season is removed along with its teams.

alter table public.season_trades
  drop constraint if exists season_trades_proposing_team_id_fkey,
  add constraint season_trades_proposing_team_id_fkey
    foreign key (proposing_team_id) references public.season_teams(id) on delete cascade;

alter table public.season_trades
  drop constraint if exists season_trades_receiving_team_id_fkey,
  add constraint season_trades_receiving_team_id_fkey
    foreign key (receiving_team_id) references public.season_teams(id) on delete cascade;
