import { all } from './db.mjs'
const teams = await all('season_teams', (q) => q.eq('season_id', 54))
console.log(teams.map((t) => `${t.id} ${t.name ?? t.team_name ?? JSON.stringify(t)}`).join('\n'))
console.log(JSON.stringify(teams[0], null, 1))
const roster = await all('season_roster', (q) => q.eq('season_id', 54))
console.log('roster rows:', roster.length)
console.log(JSON.stringify(roster[0]))
