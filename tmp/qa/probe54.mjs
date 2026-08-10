import { supabase, all } from './db.mjs'

const { data: season } = await supabase.from('seasons').select('*').eq('id', 54).single()
console.log('SEASON 54:', JSON.stringify(season))

const sched = await all('season_schedule', (q) => q.eq('season_id', 54))
console.log('SCHEDULE rows:', sched.length, 'statuses:', JSON.stringify(sched.reduce((a, g) => { a[g.status] = (a[g.status] || 0) + 1; return a }, {})))
console.log('FIRST GAME:', JSON.stringify(sched.sort((a, b) => (a.game_number ?? a.id) - (b.game_number ?? b.id))[0]))

for (const t of ['season_plate_appearances', 'season_pitching_stints', 'season_runs_scored', 'season_pitches', 'season_game_fielders', 'season_lineups']) {
  const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true }).eq('season_id', 54)
  console.log(t, error ? 'ERR: ' + error.message : count)
}
