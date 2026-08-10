import { all } from './db.mjs'
const teamLineups = await all('season_team_lineups', (q) => q.eq('season_id', 54))
const teams = await all('season_teams', (q) => q.eq('season_id', 54))
const teamByPlayer = Object.fromEntries(teams.map((t) => [t.player_id, t.team_name]))
const chars = await all('characters')
const nameById = Object.fromEntries(chars.map((c) => [c.id, c.name]))
for (const r of teamLineups) {
  console.log(teamByPlayer[r.player_id], 'pitcher=', nameById[r.fielding_positions.pitcher])
}
