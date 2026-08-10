import { all } from './db.mjs'
const chars = await all('characters')
const nameById = Object.fromEntries(chars.map((c) => [c.id, c.name]))
const stints = (await all('season_pitching_stints', (q) => q.eq('game_id', 2145))).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
for (const s of stints) console.log(s.id, s.created_at, nameById[s.character_id], 'player=', s.player_id)
