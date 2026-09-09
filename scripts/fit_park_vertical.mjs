// Fit a park's PARK_IMAGE_VERTICAL from marker corrections already in the logs.
//
//   node scripts/fit_park_vertical.mjs --park dk_jungle
//   node scripts/fit_park_vertical.mjs --park all      # what is available
//   node scripts/fit_park_vertical.mjs --park wario_city --max-height 25
//
// WHY THIS EXISTS. A homography maps the GROUND. A ball that ended up in a
// tree, on a deck or in the stands is not on it, and with no vertical vector
// the marker is drawn at the ground point directly beneath the ball -- which in
// a perspective view sits nearer and lower than where the ball actually
// appears. On DK Jungle that put markers a median 10.5 image percent from where
// they belonged, and 16.8 percent on a ball 25 units up. Fitting the vector
// took that to 1.1 percent. This is the step that makes markers land on the
// spot rather than merely in the right region.
//
// WHERE THE DATA COMES FROM, and this is the part worth knowing: it already
// exists. Every time a marker is corrected in the at-bat preview, the session
// log gets a TRACKER_IMAGE_CALIBRATION record carrying the ball's world x/y/z,
// the image position that was clicked, and the position the code drew. That is
// exactly the correspondence ballVerticalFit asks for in the calibrator, so
// ordinary use of the preview IS the calibration pass. Nobody needs to click
// anything twice, and nothing here assumes WALL_HEIGHT_UNITS -- each ball
// brings its own measured height, which is what makes this usable on a park
// whose wall height varies (DK Jungle, Daisy) where the calibrator's wall
// base/top path is wrong by construction.
//
// A MEASURED LANDING IS NEVER MOVED TO FIT THE MAP. When landed balls plot
// wrong while projected ones (which arrive at height 0) plot correctly, the
// fault is always here, in the park's height model -- never in the ball's
// coordinates. Fix the projection, not the data.
//
// THE ORDER MATTERS. PARK_FENCES and PARK_IMAGE_HOMOGRAPHY must be in place
// first: the homography is an input to this fit, and refitting it later
// invalidates the vector.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyHomographyWithHeight, fitVerticalVanishing } from '../src/utils/homography.js'
import { PARK_IMAGE_HOMOGRAPHY, PARK_IMAGE_VERTICAL } from '../src/utils/parkGeometry.js'

const MARKER = 'TRACKER_IMAGE_CALIBRATION] '
// A ball at rest reads y = 0.25 (one ball radius). At or under this it is on
// the ground, where the vertical has nothing to say and the ground mapping is
// already exact.
const MIN_HEIGHT_UNITS = 0.5
// Optional ceiling, off by default. A ball high up against a vertical structure
// has no well-defined spot on a ground-plane map, and the clicks show it: six
// Wario City balls that struck the WARIO tower all report depth 97.6-98.6u, and
// two of them sitting 5 ft apart in world space were clicked 19.3 image percent
// apart -- about 65 ft. One world point cannot map to two image points, so those
// corrections contradict each other rather than the model, and no vertical can
// satisfy them. Including all 15 gave 7.81 median; capping at 25u gave 1.74 on
// the 9 that remain. Use it only for structure hits like these, never to drop a
// correction that is merely inconvenient.
const maxHeightArg = process.argv.indexOf('--max-height')
const MAX_HEIGHT_UNITS = maxHeightArg > 0
  ? Number(process.argv[maxHeightArg + 1])
  : Infinity
// Two is the algebraic minimum, but two clicks cannot show whether they agree.
const MIN_POINTS = 4
// Letting vw float is only honest when the balls disagree about DEPTH: the
// vanishing term is observable solely as a difference in apparent height
// between near and far. DK Jungle spanned 22 units and the free solve moved the
// residual by 0.06 image percent, i.e. nothing.
const DEPTH_SPREAD_FOR_VANISHING_UNITS = 60

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOG_ROOT = join(repoRoot, 'sluggers-stat-tracker-advanced-stats-dev')

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

/** Every logged marker correction, one entry per ball, latest click kept. */
export function loadCorrections(roots = [LOG_ROOT]) {
  const byPark = new Map()
  for (const root of roots) {
    for (const path of findLogs(root)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const at = line.indexOf(MARKER)
        if (at < 0) continue
        const fields = {}
        for (const pair of line.slice(at + MARKER.length).trim().split('|')) {
          const eq = pair.indexOf('=')
          if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1)
        }
        const park = fields.stadium_key
        if (!park) continue
        const point = {
          world: { x: Number(fields.x), z: Number(fields.z), height: Number(fields.y) },
          image: { x: Number(fields.image_x), y: Number(fields.image_y) },
          automatic: {
            x: Number(fields.automatic_image_x),
            y: Number(fields.automatic_image_y),
          },
        }
        if (!Number.isFinite(point.world.height)) continue
        if (point.world.height <= MIN_HEIGHT_UNITS) continue
        if (point.world.height > MAX_HEIGHT_UNITS) continue
        if (!Number.isFinite(point.image.x) || !Number.isFinite(point.image.y)) continue
        if (!byPark.has(park)) byPark.set(park, new Map())
        // A ball corrected twice keeps the later click: that is the one settled on.
        byPark.get(park).set(`${fields.contact_seq}|${fields.endpoint_seq}`, point)
      }
    }
  }
  return new Map([...byPark].map(([park, points]) => [park, [...points.values()]]))
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[sorted.length >> 1]
}

function residuals(matrix, vertical, points) {
  return points.map(({ world, image }) => {
    const spot = applyHomographyWithHeight(matrix, vertical, world.x, world.z, world.height)
    return spot ? Math.hypot(spot.x - image.x, spot.y - image.y) : NaN
  }).filter(Number.isFinite)
}

/**
 * Leave-one-out: fit without each point, then predict it.
 *
 * The check that matters when a park has only a handful of corrections. An
 * in-sample residual on seven points against two free parameters proves very
 * little by itself; if the held-out number tracks it, the fit generalises.
 */
export function leaveOneOut(matrix, points, options) {
  const errors = []
  for (let index = 0; index < points.length; index += 1) {
    const training = points.filter((_, other) => other !== index)
    const fit = fitVerticalVanishing(matrix, training, options)
    if (!fit) continue
    errors.push(...residuals(matrix, fit.vertical, [points[index]]))
  }
  return errors
}

export function fitPark(park, points) {
  const matrix = PARK_IMAGE_HOMOGRAPHY[park]
  if (!matrix) {
    return { park, points, error: 'no PARK_IMAGE_HOMOGRAPHY -- fit the ground first' }
  }
  if (points.length < MIN_POINTS) {
    return { park, points, error: `only ${points.length} corrections, want ${MIN_POINTS}+` }
  }
  const heights = points.map((point) => point.world.height)
  const depths = points.map((point) => Math.hypot(point.world.x, point.world.z))
  const depthSpread = Math.max(...depths) - Math.min(...depths)
  const allowVanishing = depthSpread >= DEPTH_SPREAD_FOR_VANISHING_UNITS
  const fit = fitVerticalVanishing(matrix, points, { allowVanishing })
  if (!fit) return { park, points, error: 'fit failed' }
  return {
    park,
    points,
    allowVanishing,
    depthSpread,
    heightRange: [Math.min(...heights), Math.max(...heights)],
    vertical: fit.vertical,
    uncorrected: points.map((point) => Math.hypot(
      point.automatic.x - point.image.x,
      point.automatic.y - point.image.y,
    )).filter(Number.isFinite),
    fitted: residuals(matrix, fit.vertical, points),
    heldOut: leaveOneOut(matrix, points, { allowVanishing }),
    storedResiduals: PARK_IMAGE_VERTICAL[park]
      ? residuals(matrix, PARK_IMAGE_VERTICAL[park], points)
      : null,
  }
}

function report(result) {
  console.log(`\n=== ${result.park}`)
  if (result.error) {
    console.log(`    ${result.error} (${result.points.length} corrections)`)
    return
  }
  const span = (values) => `${median(values).toFixed(2)} median / ${Math.max(...values).toFixed(2)} max`
  console.log(`    ${result.points.length} corrections   `
    + `heights ${result.heightRange[0].toFixed(2)}-${result.heightRange[1].toFixed(2)}u   `
    + `depth spread ${result.depthSpread.toFixed(1)}u`)
  console.log(`    vw ${result.allowVanishing
    ? 'solved (depth spread supports it)'
    : 'held at 0 (depth too narrow to observe it)'}`)
  console.log('\n    marker error, image percent')
  console.log(`      no vertical      ${span(result.uncorrected)}`)
  if (result.storedResiduals) console.log(`      stored vector    ${span(result.storedResiduals)}`)
  console.log(`      this fit         ${span(result.fitted)}`)
  if (result.heldOut.length) console.log(`      held out (LOO)   ${span(result.heldOut)}`)
  if (result.heldOut.length && median(result.heldOut) > median(result.fitted) * 2) {
    console.log('\n    WARNING: held-out error is more than double in-sample, so this is')
    console.log('    overfitted. Collect more corrections before storing it.')
  }
  console.log('\n    src/utils/parkGeometry.js -> PARK_IMAGE_VERTICAL')
  console.log(`      ${result.park}: [${result.vertical.map((v) => v.toFixed(10)).join(', ')}],`)
}

const args = process.argv.slice(2)
const parkArg = args.includes('--park') ? args[args.indexOf('--park') + 1] : 'all'
const corrections = loadCorrections()
if (!corrections.size) {
  console.log('No TRACKER_IMAGE_CALIBRATION records found. Correct a few markers in the')
  console.log('at-bat preview first -- each correction is one calibration point.')
} else if (parkArg === 'all') {
  console.log('Parks with logged marker corrections:')
  for (const [park, points] of corrections) console.log(`  ${park.padEnd(22)} ${points.length}`)
  console.log('\nRe-run with --park <key> to fit one.')
} else {
  report(fitPark(parkArg, corrections.get(parkArg) ?? []))
}
