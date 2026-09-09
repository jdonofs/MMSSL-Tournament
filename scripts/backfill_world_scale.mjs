// Recompute real-world hit measurements after adopting 1 game unit = 1 metre.
//
// Stored hit_x/hit_y coordinates are percentages on stadium images, so they do
// not change. hit_distance_ft does: its wall references now use the canonical
// metre scale. Exit velocity and launch angle in the historical video-reviewed
// rows were derived from hit_distance_ft + hang_time_sec, so those values must
// be rerun through the same solver rather than multiplied as tracker readings.
//
//   node scripts/backfill_world_scale.mjs           # dry run
//   node scripts/backfill_world_scale.mjs --apply   # authenticate and write
//   node scripts/backfill_world_scale.mjs --undo    # dry-run the restore
//   node scripts/backfill_world_scale.mjs --undo --apply
//
// SAFETY. --apply writes a complete before/after snapshot before its first
// update and refuses to run while that snapshot exists. Updates include the
// original values in their predicates, so a concurrent edit cannot be
// overwritten silently. --undo uses the corresponding after values as guards.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { solveExitVelocityWithDrag } from '../src/utils/exitVelocityPhysics.js'
import {
  TRACKER_STADIUM_FIELD_GEOMETRY,
  estimateTrackerHitDistanceFeet,
  estimateTrackerWallDistance,
} from './tracker_field_projection.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const SNAPSHOT_PATH = path.join(__dirname, '.world_scale_backfill.json')
const TABLES = ['plate_appearances', 'season_plate_appearances']
const ROBBED_HR_CARRY_FT = 15
const VALUE_TOLERANCE = 0.11

const apply = process.argv.includes('--apply')
const undo = process.argv.includes('--undo')

const round1 = (value) => Math.round(Number(value) * 10) / 10
const finite = (value) => value != null && Number.isFinite(Number(value))
const close = (left, right) => finite(left) && finite(right)
  && Math.abs(Number(left) - Number(right)) <= VALUE_TOLERANCE

function loadEnvFile(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

const env = {
  ...loadEnvFile(path.join(repoRoot, '.env')),
  ...loadEnvFile(path.join(repoRoot, '.env.tracker-bridge')),
  ...process.env,
}

if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.')
}

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

async function authenticateForWrites() {
  if (!apply) return
  if (!env.TRACKER_BRIDGE_EMAIL || !env.TRACKER_BRIDGE_PASSWORD) {
    throw new Error('Apply/undo requires TRACKER_BRIDGE_EMAIL and TRACKER_BRIDGE_PASSWORD.')
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: env.TRACKER_BRIDGE_EMAIL,
    password: env.TRACKER_BRIDGE_PASSWORD,
  })
  if (error) throw new Error(`Sign-in failed: ${error.message}`)
}

async function fetchAll(table) {
  const rows = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select([
        'id', 'created_at', 'hit_x', 'hit_y', 'hit_distance_ft',
        'hit_angle_deg', 'hit_stadium_key', 'hang_time_sec',
        'exit_velocity_mph', 'launch_angle_deg', 'is_robbed_hr',
      ].join(','))
      .not('hit_distance_ft', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...data)
    if (data.length < pageSize) return rows
  }
}

// These are the field-image references that produced the existing distances.
// They remain here only so robbed-HR EVs can be recognized against their old
// wall+carry input after the live geometry has moved to metres.
const LEGACY_WALL_REFS = {
  mario_stadium: [259, 317, 259],
  yoshi_park: [253, 324, 254],
  wario_city: [292, 297, 289],
  dk_jungle: [274, 323, 275],
  bowser_castle: [278, 334, 277],
  bowser_jr_playroom: [262, 328, 264],
  daisy_cruiser: [232, 328, 231],
  peach_ice_garden: [314, 402, 313],
  luigis_mansion: [282, 351, 287],
  generic_field: [272, 334, 272],
}

// Kept separate to make the old calibration explicit without duplicating the
// interpolation implementation in the row planner.
function legacyWallDistance(angleDeg, stadiumKey) {
  const distances = LEGACY_WALL_REFS[stadiumKey]
  if (!distances || !finite(angleDeg)) return null
  const config = TRACKER_STADIUM_FIELD_GEOMETRY[stadiumKey]
  if (!config) return null
  const refs = config.wallRefs.map((ref, index) => {
    const dx = ref.x - config.homePlate.x
    const dy = ref.y - config.homePlate.y
    return { angle: (Math.atan2(dx, -dy) * 180) / Math.PI, distance: distances[index] }
  }).sort((left, right) => left.angle - right.angle)
  const angle = Number(angleDeg)
  if (angle <= refs[0].angle) return refs[0].distance
  if (angle >= refs[refs.length - 1].angle) return refs[refs.length - 1].distance
  for (let index = 0; index < refs.length - 1; index += 1) {
    if (angle < refs[index].angle || angle > refs[index + 1].angle) continue
    const fraction = (angle - refs[index].angle) / (refs[index + 1].angle - refs[index].angle)
    return refs[index].distance * (1 - fraction) + refs[index + 1].distance * fraction
  }
  return null
}

function physicsDistance(row, hitDistanceFt, useLegacyWall) {
  if (!row.is_robbed_hr || !finite(row.hit_angle_deg)) return hitDistanceFt
  const wall = useLegacyWall
    ? legacyWallDistance(row.hit_angle_deg, row.hit_stadium_key)
    : estimateTrackerWallDistance(row.hit_angle_deg, row.hit_stadium_key)
  return finite(wall) ? Number(wall) + ROBBED_HR_CARRY_FT : hitDistanceFt
}

async function planRow(table, row) {
  const beforeDistance = Number(row.hit_distance_ft)
  const coordinateDistance = estimateTrackerHitDistanceFeet(
    { x: row.hit_x, y: row.hit_y },
    row.hit_stadium_key,
  )
  if (!finite(coordinateDistance)) {
    return { skipped: 'missing coordinates or stadium calibration' }
  }

  const after = {}
  if (Number(coordinateDistance) !== beforeDistance) {
    after.hit_distance_ft = Number(coordinateDistance)
  }

  let derivation = 'distance only'
  if (finite(row.hang_time_sec) && finite(row.exit_velocity_mph)) {
    const beforePhysicsDistance = physicsDistance(row, beforeDistance, true)
    const afterPhysicsDistance = physicsDistance(row, coordinateDistance, false)
    const oldEstimate = solveExitVelocityWithDrag(beforePhysicsDistance, row.hang_time_sec)
    const newEstimate = solveExitVelocityWithDrag(afterPhysicsDistance, row.hang_time_sec)

    if (oldEstimate && newEstimate && close(row.exit_velocity_mph, oldEstimate.exitVelocityMph)) {
      derivation = 'physics-derived EV'
      if (!close(row.exit_velocity_mph, newEstimate.exitVelocityMph)) {
        after.exit_velocity_mph = newEstimate.exitVelocityMph
      }
      // Some reviewed rows deliberately override launch angle to encode their
      // trajectory class. Only values that still match the old solver output
      // are solver-owned and safe to replace.
      if (close(row.launch_angle_deg, oldEstimate.launchAngleDeg)
          && !close(row.launch_angle_deg, newEstimate.launchAngleDeg)) {
        after.launch_angle_deg = newEstimate.launchAngleDeg
      }
    } else if (newEstimate && close(row.exit_velocity_mph, newEstimate.exitVelocityMph)) {
      derivation = 'already migrated physics EV'
    } else {
      derivation = 'manual/unrecognized EV preserved'
    }
  }

  if (Object.keys(after).length === 0) return { unchanged: true, derivation }
  const before = Object.fromEntries(Object.keys(after).map((key) => [key, row[key] ?? null]))
  return { change: { table, id: row.id, before, after, derivation } }
}

async function buildPlan() {
  const changes = []
  const summary = new Map()
  for (const table of TABLES) {
    const rows = await fetchAll(table)
    let skipped = 0
    let unchanged = 0
    for (const row of rows) {
      const planned = await planRow(table, row)
      if (planned.change) {
        changes.push(planned.change)
        summary.set(planned.change.derivation, (summary.get(planned.change.derivation) || 0) + 1)
      } else if (planned.skipped) skipped += 1
      else unchanged += 1
    }
    console.log(`${table}: ${rows.length} measured hit(s), ${rows.length - skipped - unchanged} change, ${unchanged} unchanged, ${skipped} skipped`)
  }
  return { changes, summary }
}

function guard(query, values) {
  let guarded = query
  for (const [column, value] of Object.entries(values)) {
    guarded = value == null ? guarded.is(column, null) : guarded.eq(column, value)
  }
  return guarded
}

async function writeChange(change, direction) {
  const expected = direction === 'forward' ? change.before : change.after
  const values = direction === 'forward' ? change.after : change.before
  const query = supabase.from(change.table).update(values).eq('id', change.id)
  const { data, error } = await guard(query, expected).select('id')
  if (error) throw new Error(`${change.table}#${change.id}: ${error.message}`)
  if (!data || data.length !== 1) {
    throw new Error(`${change.table}#${change.id}: guarded update matched no row; data changed concurrently or RLS blocked the write`)
  }
}

async function runUndo() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.log('No world-scale snapshot exists; nothing to undo.')
    return 1
  }
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
  console.log(`${snapshot.changes.length} row(s) would be restored from ${snapshot.takenAt}.`)
  if (!apply) {
    console.log('Dry run; pass --undo --apply to restore them.')
    return 0
  }
  await authenticateForWrites()
  let done = 0
  for (const change of snapshot.changes) {
    await writeChange(change, 'reverse')
    done += 1
  }
  fs.renameSync(SNAPSHOT_PATH, `${SNAPSHOT_PATH}.undone`)
  console.log(`Restored ${done} row(s); snapshot moved to ${SNAPSHOT_PATH}.undone.`)
  return 0
}

async function main() {
  if (undo) return runUndo()
  if (apply && fs.existsSync(SNAPSHOT_PATH)) {
    console.log(`REFUSING: ${SNAPSHOT_PATH} already exists.`)
    console.log('Undo it or inspect/remove a stale snapshot before applying again.')
    return 1
  }

  const { changes, summary } = await buildPlan()
  console.log(`\n${changes.length} row(s) to update:`)
  for (const [label, count] of summary) console.log(`  ${label}: ${count}`)
  for (const change of changes.slice(0, 5)) {
    console.log(`  ${change.table}#${change.id}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`)
  }
  if (!apply) {
    console.log('\nDry run; nothing written. Pass --apply after reviewing this plan.')
    return 0
  }

  await authenticateForWrites()
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
    takenAt: new Date().toISOString(),
    purpose: '1 game unit = 1 metre world-scale migration',
    changes,
  }, null, 2))
  console.log(`\nSnapshot written to ${SNAPSHOT_PATH}`)

  let done = 0
  for (const change of changes) {
    await writeChange(change, 'forward')
    done += 1
    if (done % 50 === 0) console.log(`  ${done}/${changes.length}`)
  }
  console.log(`Updated ${done} row(s).`)
  console.log('Undo with: node scripts/backfill_world_scale.mjs --undo --apply')
  return 0
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
