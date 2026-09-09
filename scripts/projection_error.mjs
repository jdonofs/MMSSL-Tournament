// Read back the marks made on PROJECTED balls and say, in feet, how wrong the
// projection was.
//
//   node scripts/projection_error.mjs --park wario_city
//
// A projected landing can sit in the wrong place on the artwork for two quite
// different reasons, and they look identical on screen: the CARRY projection
// put the ball at the wrong world point, or the ground mapping drew the right
// world point in the wrong place. Inverting the clicked image position back
// through the park's homography separates them -- it gives the world point the
// click actually meant, so the disagreement can be stated as a distance and a
// bearing rather than as a pixel offset.
//
// These records come from marking a projected ball in the preview, and are
// deliberately NOT the ones fit_park_vertical.mjs reads: a projected world
// point is computed, not measured, so it must never be fed to the vertical fit.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PARK_IMAGE_HOMOGRAPHY, HOME_PLATE, FEET_PER_UNIT, fenceRadiusAt } from '../src/utils/parkGeometry.js'

const MARKER = 'TRACKER_PROJECTION_CALIBRATION] '
const LOG_ROOT = 'sluggers-stat-tracker-advanced-stats-dev'

function findLogs(dir, found = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return found }
  for (const entry of entries) {
    const path = join(dir, entry)
    let stats
    try { stats = statSync(path) } catch { continue }
    if (stats.isDirectory()) findLogs(path, found)
    else if (path.endsWith('.log')) found.push(path)
  }
  return found
}

/** Undo the ground homography: image percent -> world x/z on the field plane. */
function imageToWorld(matrix, px, py) {
  const [a, b, c, d, e, f, g, h, i] = matrix
  const A = [[a - (px * g), b - (px * h)], [d - (py * g), e - (py * h)]]
  const B = [(px * i) - c, (py * i) - f]
  const det = (A[0][0] * A[1][1]) - (A[0][1] * A[1][0])
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return {
    x: ((B[0] * A[1][1]) - (B[1] * A[0][1])) / det,
    z: ((A[0][0] * B[1]) - (A[1][0] * B[0])) / det,
  }
}

const args = process.argv.slice(2)
const parkArg = args.includes('--park') ? args[args.indexOf('--park') + 1] : null

const rows = []
for (const path of findLogs(LOG_ROOT)) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf(MARKER)
    if (at < 0) continue
    const fields = {}
    for (const pair of line.slice(at + MARKER.length).trim().split('|')) {
      const eq = pair.indexOf('=')
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    if (parkArg && fields.stadium_key !== parkArg) continue
    rows.push(fields)
  }
}
// One row per ball, latest mark kept -- the same rule fit_park_vertical uses.
const byBall = new Map(rows.map((row) => [`${row.stadium_key}|${row.contact_seq}|${row.endpoint_seq}`, row]))
const marks = [...byBall.values()]

if (!marks.length) {
  console.log(`No ${MARKER.trim()} records${parkArg ? ` for ${parkArg}` : ''}.`)
  console.log('Mark a projected ball in the preview ("Mark actual landing") to create one.')
  process.exit(0)
}

const plateRadius = (x, z) => Math.hypot(x - HOME_PLATE.x, z - HOME_PLATE.z)
const plateAngle = (x, z) => (Math.atan2(x - HOME_PLATE.x, -(z - HOME_PLATE.z)) * 180) / Math.PI

const byPark = new Map()
for (const mark of marks) {
  if (!byPark.has(mark.stadium_key)) byPark.set(mark.stadium_key, [])
  byPark.get(mark.stadium_key).push(mark)
}

for (const [park, entries] of byPark) {
  const matrix = PARK_IMAGE_HOMOGRAPHY[park]
  console.log(`\n=== ${park}   ${entries.length} marked projection(s)`)
  if (!matrix) {
    console.log('    no PARK_IMAGE_HOMOGRAPHY -- cannot invert clicks for this park')
    continue
  }
  const errors = []
  console.log('    PA   result    projected            marked               carry err   lateral')
  for (const entry of entries.sort((l, r) => Number(l.pa_number) - Number(r.pa_number))) {
    const truth = imageToWorld(matrix, Number(entry.image_x), Number(entry.image_y))
    if (!truth) continue
    const px = Number(entry.x)
    const pz = Number(entry.z)
    const projR = plateRadius(px, pz)
    const trueR = plateRadius(truth.x, truth.z)
    const projA = plateAngle(px, pz)
    const trueA = plateAngle(truth.x, truth.z)
    const carry = (trueR - projR) * FEET_PER_UNIT
    // Lateral gap along the arc, which is what a bearing error costs on the map.
    const lateral = (((trueA - projA) * Math.PI) / 180) * trueR * FEET_PER_UNIT
    errors.push({ carry, lateral, trueR, projR, entry })
    console.log(`    ${String(entry.pa_number).padStart(3)}  ${String(entry.result || '-').padEnd(7)}`
      + `  ${(projR * FEET_PER_UNIT).toFixed(0).padStart(4)} ft @ ${projA.toFixed(1).padStart(6)}`
      + `   ${(trueR * FEET_PER_UNIT).toFixed(0).padStart(4)} ft @ ${trueA.toFixed(1).padStart(6)}`
      + `   ${carry >= 0 ? '+' : ''}${carry.toFixed(0).padStart(4)} ft`
      + `   ${lateral >= 0 ? '+' : ''}${lateral.toFixed(0).padStart(4)} ft`)
  }
  if (!errors.length) continue
  const median = (values) => [...values].sort((l, r) => l - r)[values.length >> 1]
  const carries = errors.map((e) => e.carry)
  const laterals = errors.map((e) => e.lateral)
  console.log('')
  console.log(`    carry    median ${median(carries) >= 0 ? '+' : ''}${median(carries).toFixed(0)} ft`
    + `   worst ${Math.max(...carries.map(Math.abs)).toFixed(0)} ft`)
  console.log(`    lateral  median ${median(laterals) >= 0 ? '+' : ''}${median(laterals).toFixed(0)} ft`
    + `   worst ${Math.max(...laterals.map(Math.abs)).toFixed(0)} ft`)
  console.log('')
  // The diagnosis. A carry error that is consistently one-signed is the flight
  // projection falling short or long; a lateral error that big is the ground
  // mapping or the bearing, and would show on measured balls too.
  const sameSign = carries.every((c) => c > 0) || carries.every((c) => c < 0)
  if (sameSign && Math.abs(median(carries)) > 10) {
    console.log(`    Carry error is one-signed and ${median(carries) > 0 ? 'SHORT' : 'LONG'} -- that is the`)
    console.log('    flight projection, not the artwork. Truncated flights read short.')
  }
  if (Math.abs(median(laterals)) > Math.abs(median(carries))) {
    console.log('    Lateral error dominates, which the carry projection cannot cause.')
    console.log('    Suspect the homography or the plotted bearing instead.')
  }
}
