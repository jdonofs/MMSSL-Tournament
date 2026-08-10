// Diffs game 2144's DB rows against the independent simulator (expected.mjs).
import { all, supabase } from './db.mjs'
import { simulate } from './expected.mjs'

const GAME = 2144
const exp = simulate()
const problems = []
const note = (msg) => { problems.push(msg); console.log('MISMATCH:', msg) }
const ok = (msg) => console.log('ok:', msg)

const chars = await all('characters')
const nameById = Object.fromEntries(chars.map((c) => [c.id, c.name]))

// ── plate appearances ──────────────────────────────────────────
const pas = (await all('season_plate_appearances', (q) => q.eq('game_id', GAME))).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
console.log('PA rows:', pas.length, '(expected 43)')
if (pas.length !== 43) note(`PA count ${pas.length} != 43`)

// Aggregate batting from PA rows (like the app would)
const agg = {}
for (const pa of pas) {
  const name = nameById[pa.character_id]
  const a = (agg[name] ||= { pa: 0, ab: 0, h: 0, s1: 0, s2: 0, s3: 0, hr: 0, rbi: 0, bb: 0, hbp: 0, so: 0, sf: 0, sh: 0, tb: 0, rispPa: 0, rispAb: 0, rispH: 0, runScored: 0 })
  a.pa += 1
  const officialAb = typeof pa.is_official_ab === 'boolean' ? pa.is_official_ab : !['BB', 'HBP', 'SF', 'SH'].includes(pa.result)
  if (officialAb) a.ab += 1
  const hit = ['1B', '2B', '3B', 'HR', 'IPHR'].includes(pa.result)
  if (hit) a.h += 1
  a.s1 += pa.result === '1B' ? 1 : 0
  a.s2 += pa.result === '2B' ? 1 : 0
  a.s3 += pa.result === '3B' ? 1 : 0
  a.hr += (pa.result === 'HR' || pa.result === 'IPHR') ? 1 : 0
  a.tb += pa.result === '1B' ? 1 : pa.result === '2B' ? 2 : pa.result === '3B' ? 3 : (pa.result === 'HR' || pa.result === 'IPHR') ? 4 : 0
  const creditedRbi = (pa.is_error || ['ROE', 'DP', 'TP', 'FC'].includes(pa.result)) ? 0 : Number(pa.rbi || 0)
  a.rbi += creditedRbi
  a.bb += pa.result === 'BB' ? 1 : 0
  a.hbp += pa.result === 'HBP' ? 1 : 0
  a.so += pa.result === 'K' ? 1 : 0
  a.sf += pa.result === 'SF' ? 1 : 0
  a.sh += pa.result === 'SH' ? 1 : 0
  const risp = pa.runner_on_second_before === true || pa.runner_on_third_before === true
  if (risp) { a.rispPa += 1; if (officialAb) a.rispAb += 1; if (hit) a.rispH += 1 }
  if (pa.run_scored) a.runScored += 1
}

console.log('\n── Batting diff (DB-PA-derived vs expected) ──')
for (const [name, e] of Object.entries(exp.batting)) {
  const a = agg[name]
  if (!a) { note(`no PA rows for ${name}`); continue }
  for (const key of ['pa', 'ab', 'h', 's1', 's2', 's3', 'hr', 'rbi', 'bb', 'hbp', 'so', 'sf', 'sh', 'tb', 'rispPa', 'rispAb', 'rispH']) {
    if (a[key] !== e[key]) note(`${name}.${key}: db=${a[key]} expected=${e[key]}`)
  }
}
ok('batting compared')

// ── runs ───────────────────────────────────────────────────────
const runs = await all('season_runs_scored', (q) => q.eq('game_id', GAME))
console.log('\nRun rows:', runs.length, '(expected 17)')
if (runs.length !== exp.runsLog.length) note(`runs count ${runs.length} != ${exp.runsLog.length}`)
const runCounts = {}
const expRunCounts = {}
for (const r of runs) {
  const k = nameById[r.scoring_character_id]
  runCounts[k] = (runCounts[k] || 0) + 1
}
for (const r of exp.runsLog) expRunCounts[r.scorer] = (expRunCounts[r.scorer] || 0) + 1
for (const k of new Set([...Object.keys(runCounts), ...Object.keys(expRunCounts)])) {
  if ((runCounts[k] || 0) !== (expRunCounts[k] || 0)) note(`runs by ${k}: db=${runCounts[k] || 0} expected=${expRunCounts[k] || 0}`)
}
// charged pitcher + earned flags
const expCharge = {}
for (const r of exp.runsLog) {
  const key = `${r.chargedTo}`
  expCharge[key] = expCharge[key] || { r: 0, unearned: 0 }
  expCharge[key].r += 1
  if (!r.earned) expCharge[key].unearned += 1
}
const dbCharge = {}
for (const r of runs) {
  const key = nameById[r.charged_to_pitcher_id] || 'NULL'
  dbCharge[key] = dbCharge[key] || { r: 0, unearned: 0 }
  dbCharge[key].r += 1
  if (r.is_earned === false) dbCharge[key].unearned += 1
}
console.log('DB charge map:', JSON.stringify(dbCharge), '\nexpected:', JSON.stringify(expCharge))
for (const k of new Set([...Object.keys(dbCharge), ...Object.keys(expCharge)])) {
  const d = dbCharge[k] || { r: 0, unearned: 0 }
  const e = expCharge[k] || { r: 0, unearned: 0 }
  if (d.r !== e.r || d.unearned !== e.unearned) note(`charged runs ${k}: db=${JSON.stringify(d)} expected=${JSON.stringify(e)}`)
}
console.log('sample run row:', JSON.stringify(runs[0]))

// ── pitching stints ────────────────────────────────────────────
const stints = await all('season_pitching_stints', (q) => q.eq('game_id', GAME))
console.log('\nStints:', stints.length)
for (const s of stints) {
  console.log(' ', nameById[s.character_id], JSON.stringify({ ip: s.innings_pitched, h: s.hits_allowed, r: s.runs_allowed, er: s.earned_runs, bb: s.walks, k: s.strikeouts, hr: s.hr_allowed, w: s.win, l: s.loss, sv: s.save, p: s.pitches_thrown, str: s.strikes_thrown }))
}
const outsFromIp = (ip) => { const w = Math.trunc(ip); const f = Math.round((ip - w) * 10); return w * 3 + f }
for (const [name, e] of Object.entries(exp.pitching)) {
  const rows = stints.filter((s) => nameById[s.character_id] === name)
  if (!rows.length) { note(`no stint for ${name}`); continue }
  const sum = (k) => rows.reduce((t, s) => t + Number(s[k] || 0), 0)
  const outs = rows.reduce((t, s) => t + outsFromIp(Number(s.innings_pitched || 0)), 0)
  if (outs !== e.outs) note(`${name}.outs: db=${outs} expected=${e.outs}`)
  for (const [dbKey, expKey] of [['hits_allowed', 'h'], ['runs_allowed', 'r'], ['earned_runs', 'er'], ['walks', 'bb'], ['strikeouts', 'k'], ['hr_allowed', 'hr'], ['pitches_thrown', 'pitches'], ['strikes_thrown', 'strikes']]) {
    if (sum(dbKey) !== e[expKey]) note(`${name}.${expKey}: db=${sum(dbKey)} expected=${e[expKey]}`)
  }
}
const winner = stints.find((s) => s.win)
const loser = stints.find((s) => s.loss)
const saver = stints.find((s) => s.save)
console.log('W:', winner ? nameById[winner.character_id] : 'none', ' L:', loser ? nameById[loser.character_id] : 'none', ' SV:', saver ? nameById[saver.character_id] : 'none')
if (!winner || nameById[winner.character_id] !== 'Bowser') note(`win: db=${winner ? nameById[winner.character_id] : 'none'} expected=Bowser`)
if (!loser || nameById[loser.character_id] !== 'Dark Bones') note(`loss: db=${loser ? nameById[loser.character_id] : 'none'} expected=Dark Bones`)
if (saver) note(`save: db=${nameById[saver.character_id]} expected=none`)

// ── pitches ────────────────────────────────────────────────────
const pitches = await all('season_pitches', (q) => q.eq('game_id', GAME))
console.log('\nPitch rows:', pitches.length)
const byPitcher = {}
for (const p of pitches) byPitcher[p.pitcher_id] = (byPitcher[p.pitcher_id] || 0) + 1
console.log('by pitcher:', JSON.stringify(byPitcher))
for (const [name, e] of Object.entries(exp.pitching)) {
  if ((byPitcher[name] || 0) !== e.pitches) note(`pitch rows ${name}: db=${byPitcher[name] || 0} expected=${e.pitches}`)
}

// ── inning scores + schedule row ───────────────────────────────
const innScores = await all('season_inning_scores', (q) => q.eq('game_id', GAME))
console.log('\nInning scores:', JSON.stringify(innScores.map((r) => ({ team: r.team_id, inning: r.inning, runs: r.runs })).sort((a, b) => a.inning - b.inning || a.team - b.team)))
const expInn = { 303: { 1: 3, 2: 5, 3: 0, 4: 0 }, 308: { 1: 0, 2: 1, 3: 7, 4: 1 } }
for (const [team, byInn] of Object.entries(expInn)) {
  for (const [inn, r] of Object.entries(byInn)) {
    const row = innScores.find((x) => String(x.team_id) === team && Number(x.inning) === Number(inn))
    const got = row ? Number(row.runs) : null
    if (got !== r) note(`inning_scores team ${team} inning ${inn}: db=${got} expected=${r}`)
  }
}
const { data: game } = await supabase.from('season_schedule').select('*').eq('id', GAME).single()
console.log('\ngame row:', JSON.stringify({ status: game.status, home: game.home_score, away: game.away_score, winner: game.winner_team_id, extra: game.is_extra_innings, final_inning: game.final_inning }))
if (game.status !== 'completed') note('game status not completed')
if (game.home_score !== 9 || game.away_score !== 8) note(`score db=${game.away_score}-${game.home_score} expected=8-9`)
if (String(game.winner_team_id) !== '308') note(`winner db=${game.winner_team_id} expected=308`)
if (game.is_extra_innings !== true) note('is_extra_innings not true')
if (Number(game.final_inning) !== 4) note(`final_inning db=${game.final_inning} expected=4`)

// PA-level detail dump for reference
console.log('\nPA details:')
for (const pa of pas) {
  console.log(` ${String(pa.inning)}${pa.half || '?'} ${nameById[pa.character_id]?.padEnd(17)} ${String(pa.result).padEnd(4)} rbi=${pa.rbi} err=${pa.is_error ? pa.error_position : '-'} outs=${pa.outs_on_play} loc=${pa.hit_location ?? '-'} traj=${pa.trajectory ?? '-'} r2=${pa.runner_on_second_before ? 1 : 0} r3=${pa.runner_on_third_before ? 1 : 0} run=${pa.run_scored ? 1 : 0} ab=${pa.is_official_ab}`)
}

console.log(`\n=== ${problems.length} mismatches ===`)
problems.forEach((p) => console.log(' -', p))
