import { all } from './db.mjs'

async function main() {
  const seasons = await all('seasons')
  const season = seasons.find((s) => s.name === 'QA PLAYOFFS DE')
  console.log('SEASON:', season)
  const teams = await all('season_teams', (q) => q.eq('season_id', season.id))
  console.log('TEAMS:', teams.map((t) => ({ id: t.id, name: t.team_name, player_id: t.player_id })))
  const schedule = await all('season_schedule', (q) => q.eq('season_id', season.id))
  console.log('SCHEDULE:', schedule.map((g) => ({ id: g.id, round: g.round_number, stage: g.stage, home: g.home_team_id, away: g.away_team_id, status: g.status })))
}
main()
