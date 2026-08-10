import { all } from './db.mjs'
const rows = await all('season_team_lineups', (q) => q.eq('season_id', 54))
for (const r of rows) console.log(JSON.stringify(r))
