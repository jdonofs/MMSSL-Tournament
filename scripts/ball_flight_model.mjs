// The game's batted-ball flight model, measured rather than assumed.
//
// Shared deliberately: scripts/backtest_hr_projection.mjs scores this model and
// scripts/tracker_play_events.mjs uses it to place balls that outran tracking.
// If those two ever held separate copies, the score would stop describing the
// thing actually shipping.
//
// WHAT WAS MEASURED. Off 37k free-flight frames at 60.5 Hz, acceleration is
// gravity plus drag STRICTLY LINEAR in velocity. Adding a quadratic term
// reduces the residual by 0.0%, so there is no air-resistance v^2 here at all --
// linear drag is what a per-frame velocity damping (v *= r) looks like in
// continuous time, which is how game engines usually do it. That the recovered
// damping is a clean 0.9972 per frame is the tell.
//
// Because the drag is linear, each axis decouples and the motion has a closed
// form, so nothing here integrates numerically:
//
//   A(t) = (1 - e^-ct) / c
//   x(t) = x0 + vx0*A                    (no horizontal forcing)
//   y(t) = y0 + vy0*A + (g/c)*(A - t)
//
// Two consequences worth knowing. Position is LINEAR in the initial state for
// fixed (g, c), which makes recovering (p0, v0) from a window of samples plain
// least squares instead of an optimisation -- and that is what averages the
// per-sample position noise DOWN, where a finite-difference estimate multiplies
// it by ~3700 and buries the signal. And the model has no park in it: every
// input and output is a position in the game's own coordinate frame, so nothing
// here depends on a fence, a homography, HOME_PLATE or FEET_PER_UNIT. A badly
// calibrated park cannot corrupt a prediction made with this.

// Fitted by minimising observed-first-touch error over 65 landed fly balls
// spanning unlabelled sessions, Peach Ice Garden, and Bowser Castle,
// with the same optimum recovered from five spread-out starting points (gravity
// spread 0.073 u/s^2), so this is an identified fit rather than wherever a
// search happened to stop. Reproduce with scripts/backtest_hr_projection.mjs.
export const GRAVITY_UNITS_PER_SEC2 = 9.9316
export const LINEAR_DRAG_PER_SEC = 0.16874

// A ball at rest sits exactly one radius above the surface -- a hard engine
// constant, confirmed across 74 records (minimum 0.250000, stdev 0.013).
export const BALL_RADIUS_UNITS = 0.25

// Frame spacing is ~16.5 ms. Anything outside this band is a dropped sample or
// a tracker re-acquisition, and differencing across it produces nonsense.
export const FRAME_MIN_SEC = 0.008
export const FRAME_MAX_SEC = 0.030

/** A(t) = (1 - e^-ct)/c, with the c -> 0 limit handled. */
export function rampFactor(c, t) {
  if (Math.abs(c) < 1e-9) return t
  return (1 - Math.exp(-c * t)) / c
}

/** Closed-form position t seconds after `state`. */
export function positionAt(state, t, g = GRAVITY_UNITS_PER_SEC2, c = LINEAR_DRAG_PER_SEC) {
  const A = rampFactor(c, t)
  return {
    x: state.x + (state.vx * A),
    y: state.y + (state.vy * A) + ((g / c) * (A - t)),
    z: state.z + (state.vz * A),
  }
}

/**
 * The longest run of contiguously-sampled frames in a flight.
 *
 * Necessary rather than defensive. The sample at contact_seq is typically
 * isolated -- the raw stream is sparse until the exe notices a contact, so that
 * frame can sit hundreds of milliseconds before dense tracking begins (0.42 s
 * in the first flight examined). Walking from the start and stopping at the
 * first gap therefore yields ONE sample and silently discards the flight.
 */
export function contiguousRun(flight) {
  let best = []
  let run = []
  for (let i = 0; i < flight.length; i += 1) {
    if (i > 0) {
      const dt = (flight[i].timeNs - flight[i - 1].timeNs) / 1e9
      if (dt < FRAME_MIN_SEC || dt > FRAME_MAX_SEC) {
        if (run.length > best.length) best = run
        run = []
      }
    }
    run.push(flight[i])
  }
  return run.length > best.length ? run : best
}

/**
 * Recover position and velocity at the first frame of a sample window.
 *
 * Linear least squares per axis, because for fixed (g, c) each axis is
 * p0 + v0*A(t) plus a known gravity term. Two unknowns, dozens of frames.
 */
export function fitInitialState(
  window, g = GRAVITY_UNITS_PER_SEC2, c = LINEAR_DRAG_PER_SEC,
) {
  if (!window || window.length < 4) return null
  const t0 = window[0].timeNs
  const axis = (get, forced) => {
    let sAA = 0, sA = 0, sN = 0, sPA = 0, sP = 0
    for (const s of window) {
      const t = (s.timeNs - t0) / 1e9
      const A = rampFactor(c, t)
      const p = get(s) - (forced ? (g / c) * (A - t) : 0)
      sAA += A * A; sA += A; sN += 1; sPA += p * A; sP += p
    }
    const det = (sN * sAA) - (sA * sA)
    if (Math.abs(det) < 1e-12) return null
    return {
      p0: ((sAA * sP) - (sA * sPA)) / det,
      v0: ((sN * sPA) - (sA * sP)) / det,
    }
  }
  const x = axis((s) => s.x, false)
  const y = axis((s) => s.y, true)
  const z = axis((s) => s.z, false)
  if (!x || !y || !z) return null
  return { x: x.p0, y: y.p0, z: z.p0, vx: x.v0, vy: y.v0, vz: z.v0, timeNs: t0 }
}

/**
 * Where this state first descends to ball-radius height.
 *
 * First touch, deliberately, not final rest. A ballistic model describes flight;
 * bounce and roll are a different process, and the tracker's `landing` is where
 * the ball STOPPED, well beyond where it first hit. Predicting rest would
 * require modelling a bounce nobody has measured.
 */
export function predictFirstTouch(
  state, g = GRAVITY_UNITS_PER_SEC2, c = LINEAR_DRAG_PER_SEC, maxSec = 15,
) {
  if (!state || !Number.isFinite(state.vy) || !Number.isFinite(state.y)) return null
  const yAt = (t) => positionAt(state, t, g, c).y
  let lo = 0
  let hi = 0.05
  while (hi < maxSec) {
    if (yAt(hi) <= BALL_RADIUS_UNITS && yAt(hi) < yAt(Math.max(0, hi - 0.02))) break
    lo = hi
    hi += 0.05
  }
  if (hi >= maxSec) return null
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2
    if (yAt(mid) > BALL_RADIUS_UNITS) lo = mid
    else hi = mid
  }
  const t = (lo + hi) / 2
  return { ...positionAt(state, t, g, c), tSec: t }
}

// How much contiguous flight is required before a projection is offered at all.
//
// Not a guess: the backtest measures error against how much flight was visible,
// and below roughly a third of a second the recovered velocity is too noisy to
// beat the alternatives. Offering nothing is better than offering a worse
// estimate than the tracker's own extrapolation.
export const MIN_PROJECTION_FRAMES = 20
export const MIN_PROJECTION_SEC = 0.33

/**
 * Where a tracked flight would have come down, from its samples alone.
 *
 * Returns null rather than guessing when the trajectory is too short, still
 * rising at the end of what we saw with no downward solution, or already at
 * rest. Callers are expected to fall back to whatever they used before.
 */
export function projectLandingFromSamples(samples) {
  if (!Array.isArray(samples) || samples.length < MIN_PROJECTION_FRAMES) return null
  const run = contiguousRun(samples)
  if (run.length < MIN_PROJECTION_FRAMES) return null
  const seconds = (run[run.length - 1].timeNs - run[0].timeNs) / 1e9
  if (!(seconds >= MIN_PROJECTION_SEC)) return null
  const state = fitInitialState(run)
  if (!state) return null
  const hit = predictFirstTouch(state)
  if (!hit) return null
  if (!Number.isFinite(hit.x) || !Number.isFinite(hit.z)) return null
  return {
    x: hit.x,
    z: hit.z,
    // Time from the START of the fitted run, not from contact.
    flightSecFromRun: hit.tSec,
    frames: run.length,
    observedSec: seconds,
  }
}
