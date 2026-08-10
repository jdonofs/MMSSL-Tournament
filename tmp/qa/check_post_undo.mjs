import { all, supabase } from './db.mjs'
const chars = await all('characters')
const nameById = Object.fromEntries(chars.map((c) => [c.id, c.name]))
const pas = await all('season_plate_appearances', (q) => q.eq('game_id', 2144))
console.log('PA rows now:', pas.length)
const stints = (await all('season_pitching_stints', (q) => q.eq('game_id', 2144))).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
for (const s of stints) console.log(s.id, nameById[s.character_id], JSON.stringify({ ip: s.innings_pitched, h: s.hits_allowed, r: s.runs_allowed, bb: s.walks, k: s.strikeouts, p: s.pitches_thrown, w: s.win, l: s.loss }))
const { data: game } = await supabase.from('season_schedule').select('status, home_score, away_score, winner_team_id').eq('id', 2144).single()
console.log('game:', JSON.stringify(game))
