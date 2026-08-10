import { all } from './db.mjs'
const chars = await all('characters')
const nameById = Object.fromEntries(chars.map((c) => [c.id, c.name]))
const stints = await all('season_pitching_stints', (q) => q.eq('game_id', 2146))
for (const s of stints) console.log(s.id, nameById[s.character_id], 'ip=', s.innings_pitched)
