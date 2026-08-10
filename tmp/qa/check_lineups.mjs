import { all } from './db.mjs'
const lineups = await all('season_lineups', (q) => q.eq('game_id', 2144))
console.log('LINEUPS:')
for (const r of lineups.sort((a, b) => String(a.player_id).localeCompare(String(b.player_id)) || a.batting_order - b.batting_order)) {
  console.log(JSON.stringify(r))
}
const fielders = await all('season_game_fielders', (q) => q.eq('game_id', 2144))
console.log('FIELDERS:')
for (const r of fielders.sort((a, b) => String(a.team_id).localeCompare(String(b.team_id)) || a.position - b.position)) {
  console.log(JSON.stringify(r))
}
