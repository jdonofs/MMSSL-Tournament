import { all } from './db.mjs'
const stints = await all('season_pitching_stints', (q) => q.eq('game_id', 2144))
console.log(JSON.stringify(stints, null, 1))
const chars = await all('characters', (q) => q.in('id', [2, 63, 19]))
console.log(chars.map((c) => `${c.id}=${c.name}`).join(', '))
