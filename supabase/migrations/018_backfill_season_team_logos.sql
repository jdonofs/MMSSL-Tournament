-- Backfill missing season_teams logos from each player's saved team profile
-- (SeasonCreate previously didn't copy players.team_logo_url onto new season_teams rows)
update season_teams st
set logo_url = p.team_logo_url
from players p
where st.player_id = p.id
  and st.logo_url is null
  and p.team_logo_url is not null;
