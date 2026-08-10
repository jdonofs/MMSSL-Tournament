import { all } from './db.mjs'
const chars = await all('characters')
const nameById = Object.fromEntries(chars.map((c) => [c.id, c.name]))
const lineups = await all('season_lineups', (q) => q.eq('game_id', 2145))
const byPlayer = {}
for (const r of lineups) { (byPlayer[r.player_id] ||= []).push(nameById[r.character_id]) }
console.log(JSON.stringify(byPlayer, null, 1))
const fielders = await all('season_game_fielders', (q) => q.eq('game_id', 2145))
console.log(fielders.map((f) => `${f.team_id} pos${f.position} ${f.character}`).join('\n'))
