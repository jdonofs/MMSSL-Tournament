// Measure how well we can predict where a batted ball comes down.
//
// THE PROBLEM THIS SOLVES. The shipped estimator is a polynomial in exit
// velocity and launch angle, and it cannot be validated: the exe emits
// projected_x/z only when tracking STALLS, which is exactly when x/z is 'none',
// so no ball has ever carried both a tracked endpoint and an extrapolated one.
// There is no ball on which the projection's error is observable, which makes
// the whole system unfalsifiable -- and an unfalsifiable model cannot be
// improved, only changed.
//
// THE WAY OUT. Take a ball that DID come down, throw away the part of its
// trajectory that a stalled tracker would never have seen, predict from what is
// left, and compare against the landing we actually observed. That manufactures
// the missing label. It is honest because the discarded frames take no part in
// the prediction, and it is calibration-free: both the prediction and the truth
// are positions in the game's own coordinate frame, so no fence, homography,
// HOME_PLATE or FEET_PER_UNIT enters. A park being imperfectly calibrated
// cannot corrupt this measurement, which is the property the distance model's
// own training labels do not have.
//
// THE FLIGHT MODEL. Measured off 37k free-flight frames rather than assumed:
// acceleration is gravity plus drag STRICTLY LINEAR in velocity -- adding a
// quadratic term reduces the residual by 0.0%. Linear drag is what a per-frame
// velocity damping (v *= r) looks like in continuous time, which is how game
// engines usually do it, and it has a closed-form solution, so nothing here
// needs numerical integration:
//
//   A(t) = (1 - e^-ct) / c
//   x(t) = x0 + vx0*A                      (no horizontal forcing)
//   y(t) = y0 + vy0*A + (g/c)*(A - t)
//
// Both are exact, and for fixed (g, c) the position is LINEAR in the initial
// state -- so recovering (p0, v0) from a window of samples is least squares
// rather than an optimisation, which is what makes this robust to the position
// noise that swamped a finite-difference fit.
//
//   node scripts/backtest_hr_projection.mjs
//   node scripts/backtest_hr_projection.mjs --truncate 1.5
//   node scripts/backtest_hr_projection.mjs --park peach_ice_garden
//
// --park needs TRACKER_STADIUM in the log, which only exists for sessions run
// through scripts/tracker_at_bat_preview.mjs after that was added. Older logs
// are park-anonymous and drop out of any filtered run.
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSessions, buildFlights } from './ball_trajectories.mjs'
import { ARCHIVE_PATH, loadArchivedFlights } from './flight_archive.mjs'
import {
  BALL_RADIUS_UNITS, FRAME_MIN_SEC, FRAME_MAX_SEC,
  rampFactor, positionAt as modelPositionAt, contiguousRun as modelContiguousRun,
  fitInitialState as modelFitInitialState, predictFirstTouch as modelPredictFirstTouch,
  GRAVITY_UNITS_PER_SEC2, LINEAR_DRAG_PER_SEC, projectLandingFromSamples,
} from './ball_flight_model.mjs'
import { estimateTrackerBattedBallDistanceFeet } from './tracker_field_projection.mjs'
import { FEET_PER_UNIT, HOME_PLATE } from '../src/utils/parkGeometry.js'

// Starting point for the search. The shipped constants are the natural seed;
// the multi-start check below is what proves the optimum is not seed-dependent.
const G_SEED = GRAVITY_UNITS_PER_SEC2
const C_SEED = LINEAR_DRAG_PER_SEC

// What the legacy executable believes a unit is worth, as recorded in its logs
// (`feet_per_unit=3`). Not the canonical 1 metre/unit -- anything that exe
// already converted to feet or mph carries this scale and has to be undone.
const EXE_FEET_PER_UNIT = 3.0

// Thin wrappers over the shared model. The fitter needs to vary (g, c), which
// the runtime never does, so these keep the explicit-parameter form while the
// single implementation lives in ball_flight_model.mjs.
export const fitInitialState = (window, g, c) => modelFitInitialState(window, g, c)
export const positionAt = (state, g, c, t) => modelPositionAt(state, t, g, c)
export const predictFirstTouch = (state, g, c, maxSec = 12) =>
  modelPredictFirstTouch(state, g, c, maxSec)
export const contiguousRun = modelContiguousRun

/**
 * The first time the OBSERVED flight descends to ball-radius height.
 *
 * Requires an apex first, so a low line drive still rising is not mistaken for
 * a descent, and requires the frames around it to be contiguous.
 */
export function observedFirstTouch(flight) {
  let apexIndex = -1
  let apex = -Infinity
  for (let i = 0; i < flight.length; i += 1) {
    if (flight[i].y > apex) { apex = flight[i].y; apexIndex = i }
  }
  if (apexIndex < 0 || apex < 2) return null
  for (let i = apexIndex + 1; i < flight.length; i += 1) {
    if (flight[i].y > BALL_RADIUS_UNITS + 0.35) continue
    const dt = (flight[i].timeNs - flight[i - 1].timeNs) / 1e9
    if (dt < FRAME_MIN_SEC || dt > FRAME_MAX_SEC) return null
    return { x: flight[i].x, y: flight[i].y, z: flight[i].z, index: i, timeNs: flight[i].timeNs }
  }
  return null
}

/** Frames from the start of a contiguous run, up to `seconds` into it. */
function windowOf(run, seconds) {
  if (!run.length) return []
  const t0 = run[0].timeNs
  return run.filter((s) => (s.timeNs - t0) / 1e9 <= seconds)
}

// A projection model is only interesting for balls with real air under them.
// Grounders and low liners are dominated by bounce and roll, which no ballistic
// model describes, and including them would flatter or damn the model for
// reasons unrelated to flight.
export const MIN_APEX_UNITS = 4.0
export const MIN_FLIGHT_SEC = 1.2

/**
 * Flights usable as ground truth: came to rest, and both the observed first
 * touch and a clean early window are available.
 *
 * `struck` flights are excluded HERE because their first touch is a wall rather
 * than the ground, so they carry no landing to score against -- but note that
 * they remain perfectly good input for the projection itself, which is the
 * whole advantage of a trajectory model over a carry regression.
 */
export function scorableFlights(flights) {
  const out = []
  for (const f of flights) {
    if (f.kind !== 'landed') continue
    const run = contiguousRun(f.flight)
    if (run.length < 20) continue
    const touch = observedFirstTouch(run)
    if (!touch) continue
    const airborne = run.slice(0, touch.index + 1)
    const apex = Math.max(...airborne.map((s) => s.y))
    const flightSec = (touch.timeNs - run[0].timeNs) / 1e9
    if (apex < MIN_APEX_UNITS || flightSec < MIN_FLIGHT_SEC) continue
    // `airborne` is what any fit may see: everything after first touch is
    // bounce and roll, and fitting a ballistic model across a bounce is what
    // made an earlier version of this fit gravity at 67 u/s^2.
    out.push({ ...f, run, airborne, touch, apex, flightSec })
  }
  return out
}

const stat = (values, pick) => {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? pick(s) : NaN
}

/**
 * Report BOTH error measures, because they answer different questions and the
 * comparison is unfair if only one is shown.
 *
 * `2D` is the distance between predicted and actual landing POINTS, which is
 * what a spray chart marker needs and what includes any direction error.
 * `dist` is the error in carry distance alone, ignoring direction — the metric
 * the shipped polynomial was actually built to serve, since it only ever
 * predicted a distance and took its direction from the launch spray angle.
 */
function summarise(rows, label, pad = 30) {
  if (!rows.length) {
    console.log(`  ${label.padEnd(pad)}   no scorable flights`)
    return null
  }
  const two = rows.map((r) => r.error2d)
  const rad = rows.map((r) => r.errorRadial)
  const f = (v) => (v * FEET_PER_UNIT).toFixed(1).padStart(5)
  const rms = (arr) => Math.sqrt(arr.reduce((s, e) => s + (e * e), 0) / arr.length)
  console.log(`  ${label.padEnd(pad)} n=${String(rows.length).padStart(3)}`
    + `  2D med ${f(stat(two, (s) => s[Math.floor(s.length / 2)]))}`
    + ` rms ${f(rms(two))}`
    + ` p90 ${f(stat(two, (s) => s[Math.floor(s.length * 0.9)]))}`
    + `   |  dist med ${f(stat(rad, (s) => s[Math.floor(s.length / 2)]))}`
    + ` rms ${f(rms(rad))}`)
  return rms(two)
}

/** Radial distance from home plate, for the distance-only comparison. */
const radiusOf = (x, z) => Math.hypot(x - HOME_PLATE.x, z - HOME_PLATE.z)

/** Mean squared first-touch error over all flights, for one (g, c). */
function modelCost(scorable, g, c, truncateSec) {
  let sum = 0
  let count = 0
  for (const f of scorable) {
    const window = windowOf(f.airborne, truncateSec)
    if (window.length < 8) continue
    const state = fitInitialState(window, g, c)
    if (!state) continue
    const hit = predictFirstTouch(state, g, c)
    if (!hit) continue
    sum += ((hit.x - f.touch.x) ** 2) + ((hit.z - f.touch.z) ** 2)
    count += 1
  }
  return count ? sum / count : Infinity
}

/** Coordinate descent on (g, c) against first-touch error. */
function fitFlightModel(scorable, truncateSec, seedG = G_SEED, seedC = C_SEED) {
  let g = seedG
  let c = seedC
  let stepG = 1.0
  let stepC = 0.1
  let best = modelCost(scorable, g, c, truncateSec)
  for (let iter = 0; iter < 60; iter += 1) {
    let improved = false
    for (const [dg, dc] of [[stepG, 0], [-stepG, 0], [0, stepC], [0, -stepC]]) {
      const ng = g + dg
      const nc = c + dc
      if (ng <= 0.1 || nc <= 0.001) continue
      const cost = modelCost(scorable, ng, nc, truncateSec)
      if (cost < best) { best = cost; g = ng; c = nc; improved = true }
    }
    if (!improved) {
      stepG /= 2
      stepC /= 2
      if (stepG < 1e-4 && stepC < 1e-5) break
    }
  }
  return { g, c, rms: Math.sqrt(best) }
}

function main() {
  const args = process.argv.slice(2)
  const at = args.indexOf('--truncate')
  const requested = at >= 0 ? Number(args[at + 1]) : null
  const parkAt = args.indexOf('--park')
  const parkFilter = parkAt >= 0 ? args[parkAt + 1] : null

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  // The archive is the durable source once logs have been distilled and
  // deleted; the logs are the source while they still exist. Reading both and
  // preferring whichever holds more of a given flight would be tidier, but it
  // would also hide the moment the archive stopped being complete -- so this is
  // an explicit choice, and --verify in distill_flights.mjs is what proves the
  // two agree before anything is thrown away.
  const useArchive = args.includes('--archive')
  const allFlights = useArchive
    ? loadArchivedFlights()
    : buildFlights(loadSessions([join(repoRoot, 'sluggers-stat-tracker-advanced-stats-dev')]))
  if (useArchive) console.log(`reading ${ARCHIVE_PATH}\n`)
  const flights = parkFilter
    ? allFlights.filter((f) => f.stadiumKey === parkFilter)
    : allFlights
  const scorable = scorableFlights(flights)

  if (parkFilter) {
    console.log(`--park ${parkFilter}: ${flights.length} of ${allFlights.length} flights\n`)
  }
  console.log(`${flights.length} flights, ${scorable.length} scorable `
    + `(came to rest, with a clean observed first touch)\n`)
  if (!scorable.length) {
    console.log(parkFilter
      ? `Nothing to score at ${parkFilter}. Logs written before the preview began`
        + ' recording the stadium carry no park, so they cannot be filtered.'
      : 'Nothing to score. Play a game with the tracker running first.')
    return
  }

  // Which parks the fit is actually made of. Worth printing rather than
  // assuming: this fit is quoted as a measurement of the GAME's physics, and
  // that claim gets weaker the more one park dominates the sample.
  const parkMix = new Map()
  for (const f of scorable) {
    const key = f.stadiumKey ?? '(unlabelled)'
    parkMix.set(key, (parkMix.get(key) ?? 0) + 1)
  }
  if (parkMix.size > 1 || !parkMix.has('(unlabelled)')) {
    const parts = [...parkMix.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
    console.log(`scorable by park: ${parts.join(', ')}\n`)
  }

  // Fit the flight model on a long window: this is a measurement of the game's
  // physics, and it should use everything available rather than be handicapped.
  const fitted = fitFlightModel(scorable, 99)

  // g and c trade off against each other over a limited window (more gravity
  // with less drag mimics less gravity with more drag), so coordinate descent
  // could settle anywhere along that valley. Restart from spread-out seeds and
  // check they agree before quoting either number as measured.
  const seeds = [[5, 0.1], [7.24, 0.32], [12, 0.05], [20, 0.6], [33, 0.15]]
  const restarts = seeds.map(([sg, sc]) => fitFlightModel(scorable, 99, sg, sc))
  const spreadG = Math.max(...restarts.map((r) => r.g)) - Math.min(...restarts.map((r) => r.g))
  const spreadRms = Math.max(...restarts.map((r) => r.rms)) - Math.min(...restarts.map((r) => r.rms))
  console.log(`fit stability across ${seeds.length} starting points: `
    + `gravity spread ${spreadG.toFixed(3)} u/s^2, `
    + `rms spread ${(spreadRms * FEET_PER_UNIT).toFixed(2)} ft`)
  console.log(`  ${spreadG < 0.5
    ? 'converges to one optimum — the fit is identified'
    : 'DOES NOT converge — g and c are trading off; treat both as indicative'}\n`)

  console.log('flight model fitted to observed first touches (full trajectories):')
  console.log(`  gravity      ${fitted.g.toFixed(4)} u/s^2  `
    + `(${(fitted.g * FEET_PER_UNIT).toFixed(2)} ft/s^2)`)
  console.log(`  linear drag  ${fitted.c.toFixed(5)} /s  `
    + `-> v *= ${(1 - (fitted.c / 60.5)).toFixed(6)} per frame at 60.5 Hz`)
  console.log(`  first-touch rms ${(fitted.rms * FEET_PER_UNIT).toFixed(2)} ft `
    + `with the whole trajectory available\n`)

  // THE BACKTEST. Hide the tail of each flight and predict from the rest.
  const cuts = requested != null ? [requested] : [0.5, 0.75, 1.0, 1.5, 2.0, 2.5]
  console.log('BACKTEST — predict the landing from only the first N seconds of flight')
  console.log('(the hidden frames take no part in the prediction)\n')

  const baseline = []
  for (const f of scorable) {
    // The shipped model, scored the same way: its distance, at the launch spray
    // angle, against the observed first touch.
    //
    // Exit velocity MUST be rescaled first. The exe converts units/sec to mph
    // with its own built-in 3.0 ft per unit (the logs carry feet_per_unit=3),
    // while the canonical scale is 3.28084 -- so a raw reading is 9.4% low, and
    // the polynomial was fitted on rescaled values (see calibrationRows in
    // extract_batted_balls.mjs). Feeding it the raw number would handicap the
    // baseline and flatter the trajectory model by comparison.
    const exitMph = f.exitSpeedMph * (FEET_PER_UNIT / EXE_FEET_PER_UNIT)
    const feet = estimateTrackerBattedBallDistanceFeet(exitMph, f.launchDeg)
    if (feet == null || f.sprayDeg == null) continue
    const radius = feet / FEET_PER_UNIT
    const rad = (f.sprayDeg * Math.PI) / 180
    const px = HOME_PLATE.x + (radius * Math.sin(rad))
    const pz = HOME_PLATE.z - (radius * Math.cos(rad))
    baseline.push({
      error2d: Math.hypot(px - f.touch.x, pz - f.touch.z),
      errorRadial: Math.abs(radius - radiusOf(f.touch.x, f.touch.z)),
    })
  }

  for (const cut of cuts) {
    const rows = []
    const hidden = []
    for (const f of scorable) {
      // Only score balls whose flight genuinely extends past the cut. Otherwise
      // the "prediction" saw the landing and is a measurement, not a forecast.
      if (f.flightSec <= cut + 0.15) continue
      const window = windowOf(f.airborne, cut)
      if (window.length < 8) continue
      const state = fitInitialState(window, fitted.g, fitted.c)
      if (!state) continue
      const hit = predictFirstTouch(state, fitted.g, fitted.c)
      if (!hit) continue
      rows.push({
        error2d: Math.hypot(hit.x - f.touch.x, hit.z - f.touch.z),
        errorRadial: Math.abs(radiusOf(hit.x, hit.z) - radiusOf(f.touch.x, f.touch.z)),
      })
      hidden.push(f.flightSec - cut)
    }
    const label = `first ${cut.toFixed(2)}s`
      + (hidden.length
        ? ` (${(hidden.reduce((s, v) => s + v, 0) / hidden.length).toFixed(2)}s hidden)`
        : '')
    summarise(rows, label, 26)
  }

  console.log('')
  summarise(baseline, 'SHIPPED polynomial (v, a)', 26)

  // What the change actually does to the balls it is FOR. These have no
  // landing, so this is not an accuracy measurement -- it is the size of the
  // disagreement with the estimate being replaced, which is the thing to eyeball
  // on the artwork before trusting it.
  const unresolved = flights.filter((f) => f.kind === 'unresolved')
  const moved = []
  let projectable = 0
  for (const f of unresolved) {
    const landing = projectLandingFromSamples(f.flight)
    if (!landing) continue
    projectable += 1
    if (f.projectedX == null || f.projectedZ == null) continue
    moved.push(Math.hypot(landing.x - f.projectedX, landing.z - f.projectedZ))
  }
  console.log(`\nUNRESOLVED balls — the ones this change is for (no landing exists,`)
  console.log(`so this is disagreement with the exe, not error):`)
  console.log(`  ${unresolved.length} unresolved, ${projectable} with enough flight to project`)
  if (moved.length) {
    const sorted = [...moved].sort((a, b) => a - b)
    console.log(`  moves the marker by ${(sorted[Math.floor(sorted.length / 2)] * FEET_PER_UNIT).toFixed(1)} ft `
      + `median, ${(sorted[sorted.length - 1] * FEET_PER_UNIT).toFixed(1)} ft worst`)
    console.log('  The exe extends the last tracked frame in a STRAIGHT LINE, with no')
    console.log('  gravity and no drag, so it should read long — check the sign on the chart.')
  }
  console.log('\nThe polynomial gets exit velocity and launch angle only, which is all it')
  console.log('has ever had; the rows above get a slice of the real flight. Note its 2D')
  console.log('error is much worse than its distance error — it takes direction from the')
  console.log('LAUNCH spray angle, and balls curve.')
}

const invoked = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invoked) main()
