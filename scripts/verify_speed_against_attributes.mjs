// Does a measured metric agree with the attribute the game stores for it?
//
//   node scripts/verify_speed_against_attributes.mjs
//
// WHY THIS IS THE RIGHT CHECK. Split-half reliability only asks whether a
// metric agrees with ITSELF, and a metric can be perfectly self-consistent and
// still be measuring the wrong thing. Fielder sprint speed was: it reproduced
// across independent halves at 0.95 while correlating with the game's own
// run_speed attribute at MINUS 0.66, because what reproduced was how hard the
// game glides each character, not how fast the character runs.
//
// The characters table holds run_speed and throwing_speed for all 72, so the
// external check is available and it is strictly stronger. Throw velocity has
// always passed it comfortably; fielder speed did not, until the glide
// threshold was split by actor type in derive_player_metrics.py.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'

const TRACKING_DIR = path.resolve('data/player_tracking')

// A run has to be long enough to reach top speed before it says anything about
// how fast a character is; below this the number is a measure of the run.
const MIN_RUN_UNITS = 10
const MIN_SAMPLES = 6

// What each check has to clear. Throw velocity is the reference -- it was
// correct before any of this work and sets the bar the others are held to.
// Runner speed is lower on purpose: a baserunner is only at full stretch when
// the play demands it, so its ceiling is genuinely below the other two.
const THRESHOLDS = { fielder: 0.8, runner: 0.6, throw: 0.8 }

function loadEnv(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

function pearson(xs, ys) {
  const n = xs.length
  if (n < 5) return null
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  const sx = Math.sqrt(xs.reduce((s, v) => s + (v - mx) ** 2, 0) / n)
  const sy = Math.sqrt(ys.reduce((s, v) => s + (v - my) ** 2, 0) / n)
  if (!sx || !sy) return null
  return xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / n / (sx * sy)
}

// EACH METRIC IS SUMMARISED THE WAY THE APP SUMMARISES IT, or this checks a
// statistic nothing computes. The three are genuinely different shapes:
//
//   fielder speed  the TOP TWO THIRDS after rejecting an entire actor-play when
//                  any glide occurred. A long route can still be a jog (the
//                  archive has a distinct 5.994 u/s mode), so its median is not
//                  a sprint ceiling on characters with only 6-9 samples. The
//                  upper tail is safe only because glide-contaminated plays
//                  were removed before this estimator sees them.
//   runner speed   the TOP TWO THIRDS, matching summarizeMovementMetrics. A
//                  runner who pulls up at first is not running slowly, they
//                  stopped running.
//   throw velocity the TOP TENTH, matching aggregateArmStrength's
//                  hardestThrowShare. An arm is what it can do, not what a lob
//                  to the cutoff man needed.
function topFraction(values, fraction) {
  const sorted = [...values].sort((a, b) => b - a)
  const take = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * fraction)))
  return take.reduce((sum, value) => sum + value, 0) / take.length
}

function collect() {
  const fielder = new Map()
  const runner = new Map()
  const throwing = new Map()
  const push = (map, key, value) => {
    if (!key) return
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(value)
  }
  for (const file of fs.readdirSync(TRACKING_DIR).filter((n) => n.endsWith('.plays.jsonl'))) {
    const stem = file.slice(0, -'.plays.jsonl'.length)
    const headerPath = path.join(TRACKING_DIR, `${stem}.json`)
    if (fs.existsSync(headerPath)) {
      const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'))
      if (header.calibration_excluded === true) continue
    }
    for (const line of fs.readFileSync(path.join(TRACKING_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const play = JSON.parse(line)
      for (const actor of Object.values(play.fielders || {})) {
        if (!actor || !actor.sprint_speed_ups) continue
        if (actor.assist_frames || actor.teleports) continue
        if ((actor.run_path_units || 0) < MIN_RUN_UNITS) continue
        push(fielder, actor.character, actor.sprint_speed_ups)
      }
      for (const actor of Object.values(play.runners || {})) {
        if (!actor || !actor.sprint_speed_ups) continue
        if (actor.assist_frames || actor.teleports) continue
        if ((actor.run_path_units || 0) < MIN_RUN_UNITS) continue
        push(runner, actor.character, actor.sprint_speed_ups)
      }
      // A Buddy Throw is a chemistry pair's output, not one player's arm.
      for (const record of play.throws || []) {
        if (record.is_throw === false || !record.peak_speed_mph || record.buddy_throw) continue
        push(throwing, record.thrower_character, record.peak_speed_mph)
      }
    }
  }
  return { fielder, runner, throwing }
}

function report(label, samples, attribute, characters, threshold, estimator) {
  const xs = []
  const ys = []
  for (const [name, values] of samples) {
    if (values.length < MIN_SAMPLES) continue
    const character = characters.get(name)
    if (!character || character[attribute] == null) continue
    xs.push(estimator(values))
    ys.push(character[attribute])
  }
  const r = pearson(xs, ys)
  const ok = r != null && r >= threshold
  const shown = r == null ? '  n/a' : r.toFixed(2).padStart(5)
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(28)} r=${shown} vs ${attribute}`
    + ` (${xs.length} characters, >=${MIN_SAMPLES} samples, threshold ${threshold})`)
  return ok
}

async function main() {
  const env = { ...loadEnv(path.resolve('.env')), ...process.env }
  const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  const { data, error } = await supabase
    .from('characters').select('name,run_speed,throwing_speed')
  if (error) throw new Error(`characters: ${error.message}`)
  const characters = new Map(data.map((c) => [c.name, c]))

  const { fielder, runner, throwing } = collect()
  console.log('measured metrics against the attributes the game stores for them:')
  const results = [
    report('fielder sprint speed', fielder, 'run_speed', characters,
      THRESHOLDS.fielder, (values) => topFraction(values, 2 / 3)),
    report('runner sprint speed', runner, 'run_speed', characters,
      THRESHOLDS.runner, (values) => topFraction(values, 2 / 3)),
    report('throw velocity (non-Buddy)', throwing, 'throwing_speed', characters,
      THRESHOLDS.throw, (values) => topFraction(values, 0.1)),
  ]
  if (results.every(Boolean)) {
    console.log('\nAll checks passed.')
    return
  }
  console.log('\nA metric disagrees with the game\'s own attribute for it.')
  process.exitCode = 1
}

main().catch((error) => {
  console.error(`verify_speed_against_attributes: ${error.message}`)
  process.exit(1)
})
