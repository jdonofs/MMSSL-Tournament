import { all } from './db.mjs'
const stints = (await all('season_pitching_stints', (q) => q.eq('game_id', 2144))).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
const chars = await all('characters')
const nameById = Object.fromEntries(chars.map((c) => [c.id, c.name]))
for (const s of stints) {
  console.log(s.id, s.created_at, nameById[s.character_id], JSON.stringify({ ip: s.innings_pitched, h: s.hits_allowed, r: s.runs_allowed, er: s.earned_runs, bb: s.walks, k: s.strikeouts, hr: s.hr_allowed, w: s.win, l: s.loss, sv: s.save, p: s.pitches_thrown, str: s.strikes_thrown, player: s.player_id }))
}
