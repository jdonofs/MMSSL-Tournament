import { all } from './db.mjs'

const pas = (await all('season_plate_appearances', (q) => q.eq('game_id', 2144))).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
const pitches = await all('season_pitches', (q) => q.eq('game_id', 2144))
const runs = await all('season_runs_scored', (q) => q.eq('game_id', 2144))
const chars = await all('characters')
const nameById = Object.fromEntries(chars.map((c) => [c.id, c.name]))

console.log('Pitches per PA:')
for (const pa of pas) {
  const rows = pitches.filter((p) => String(p.pa_id) === String(pa.id))
  console.log(` pa=${pa.id} in${pa.inning} ${nameById[pa.character_id]?.padEnd(17)} ${String(pa.result).padEnd(4)} pitchRows=${rows.length} [${rows.map((r) => r.result).join(',')}]`)
}
console.log('\nEarned flags on runs:')
for (const r of runs) {
  console.log(` inning=${r.inning} ${r.half} scorer=${nameById[r.scoring_character_id]} charged=${nameById[r.charged_to_pitcher_id]} earned=${r.is_earned_run}`)
}
