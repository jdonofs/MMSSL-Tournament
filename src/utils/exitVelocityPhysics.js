// Numerically back-solves initial exit velocity + launch angle from an
// observed carry distance and hang time, using a drag-inclusive projectile
// model. The naive closed-form vacuum formula (v0 derived from distance/time
// alone, assuming a symmetric no-drag parabola) underestimates exit
// velocity: a real ball decelerates throughout its flight from air
// resistance, so to cover the observed distance in the observed time
// despite that deceleration, it must have left the bat faster than a
// constant-velocity vacuum model would suggest. This solver instead
// simulates the actual trajectory (gravity + quadratic drag) and searches
// for the (v0, launch angle) pair whose simulated flight reproduces the two
// observed numbers.
//
// This models drag but not Magnus lift from backspin, since we don't
// capture spin rate — backspin-heavy fly balls will read a bit low on
// velocity / skewed on angle relative to a true Statcast measurement.

const G_MPS2 = 9.81
const FT_TO_M = 0.3048
const MPS_TO_MPH = 2.23694
const GRAVITY_FT_S2 = 32.174

// Standard MLB baseball: ~0.145kg mass, ~7.4cm diameter. Cd ~0.3 is a
// commonly used constant approximation for batted-ball speeds (real drag
// coefficient varies with speed/seam orientation, but a fixed value keeps
// this solver tractable without spin data).
const BALL_MASS_KG = 0.145
const BALL_RADIUS_M = 0.0369
const AIR_DENSITY_KGM3 = 1.2
const DRAG_COEFFICIENT = 0.3
const DRAG_K = (0.5 * DRAG_COEFFICIENT * AIR_DENSITY_KGM3 * Math.PI * BALL_RADIUS_M * BALL_RADIUS_M) / BALL_MASS_KG

function trajectoryDerivative({ vx, vy }) {
  const speed = Math.sqrt(vx * vx + vy * vy)
  return {
    dx: vx,
    dy: vy,
    dvx: -DRAG_K * speed * vx,
    dvy: -G_MPS2 - DRAG_K * speed * vy,
  }
}

function rk4Step(state, dt) {
  const k1 = trajectoryDerivative(state)
  const s2 = { vx: state.vx + (k1.dvx * dt) / 2, vy: state.vy + (k1.dvy * dt) / 2 }
  const k2 = trajectoryDerivative(s2)
  const s3 = { vx: state.vx + (k2.dvx * dt) / 2, vy: state.vy + (k2.dvy * dt) / 2 }
  const k3 = trajectoryDerivative(s3)
  const s4 = { vx: state.vx + k3.dvx * dt, vy: state.vy + k3.dvy * dt }
  const k4 = trajectoryDerivative(s4)
  return {
    x: state.x + (dt / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx),
    y: state.y + (dt / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy),
    vx: state.vx + (dt / 6) * (k1.dvx + 2 * k2.dvx + 2 * k3.dvx + k4.dvx),
    vy: state.vy + (dt / 6) * (k1.dvy + 2 * k2.dvy + 2 * k3.dvy + k4.dvy),
  }
}

// Simulates a batted-ball flight (SI units) and returns where/when it
// crosses back to launch height (y=0), interpolating between the last two
// steps for sub-step precision.
function simulateTrajectory(v0Mps, angleRad, dt = 0.006, maxTimeSec = 15) {
  let state = { x: 0, y: 0, vx: v0Mps * Math.cos(angleRad), vy: v0Mps * Math.sin(angleRad) }
  let t = 0
  while (t < maxTimeSec) {
    const prev = state
    state = rk4Step(state, dt)
    t += dt
    if (state.y <= 0 && prev.y > 0) {
      const f = prev.y / (prev.y - state.y)
      return { range: prev.x + f * (state.x - prev.x), time: t - dt + f * dt }
    }
  }
  return { range: state.x, time: t }
}

function toResult(v0Mps, angleRad, converged) {
  return {
    exitVelocityMph: Math.round(v0Mps * MPS_TO_MPH * 10) / 10,
    launchAngleDeg: Math.round(((angleRad * 180) / Math.PI) * 10) / 10,
    converged,
  }
}

// Newton-Raphson in two unknowns (launch speed, launch angle) against two
// observed targets (range, hang time). Seeded from the drag-free
// closed-form solution, which is normally within Newton's convergence
// basin since drag is a moderate perturbation at batted-ball speeds.
export function solveExitVelocityWithDrag(distanceFt, hangTimeSec, {
  maxIterations = 10,
  rangeToleranceM = 0.05,
  timeToleranceSec = 0.005,
} = {}) {
  const distance = Number(distanceFt)
  const hangTime = Number(hangTimeSec)
  if (!distance || !hangTime || distance <= 0 || hangTime <= 0) return null

  const targetRangeM = distance * FT_TO_M
  const targetTimeSec = hangTime

  const vxFtS = distance / hangTime
  const vyFtS = (GRAVITY_FT_S2 * hangTime) / 2
  let v0Mps = Math.sqrt(vxFtS * vxFtS + vyFtS * vyFtS) * FT_TO_M
  let angleRad = Math.atan2(vyFtS, vxFtS)

  for (let i = 0; i < maxIterations; i++) {
    const sim = simulateTrajectory(v0Mps, angleRad)
    const errRange = sim.range - targetRangeM
    const errTime = sim.time - targetTimeSec
    if (Math.abs(errRange) < rangeToleranceM && Math.abs(errTime) < timeToleranceSec) {
      return toResult(v0Mps, angleRad, true)
    }

    const dv = 0.5
    const dth = 0.005
    const simV = simulateTrajectory(v0Mps + dv, angleRad)
    const simTh = simulateTrajectory(v0Mps, angleRad + dth)
    const dRangeDv = (simV.range - sim.range) / dv
    const dTimeDv = (simV.time - sim.time) / dv
    const dRangeDth = (simTh.range - sim.range) / dth
    const dTimeDth = (simTh.time - sim.time) / dth

    const det = dRangeDv * dTimeDth - dRangeDth * dTimeDv
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) break

    const deltaV = (-errRange * dTimeDth + errTime * dRangeDth) / det
    const deltaTh = (-dRangeDv * errTime + dTimeDv * errRange) / det
    v0Mps = Math.max(1, v0Mps + deltaV)
    angleRad = Math.min(Math.max(angleRad + deltaTh, -0.2), (89 * Math.PI) / 180)
  }

  // Didn't tighten within tolerance — return the closest estimate found,
  // flagged so callers can show it with lower confidence if desired.
  return toResult(v0Mps, angleRad, false)
}

// Grounders used to get a separate 1D-roll deceleration model here instead
// of the drag-based projectile solver above, on the theory that they're
// airborne for only the first foot or two and treating the whole recorded
// distance/time as a flight path would invent a vertical arc that didn't
// happen. That's true of the *whole* contact-to-fielded interval — but once
// the ground-touch moment itself can be marked precisely (the game renders
// its own on-screen marker for it), contact-to-landed is a real, short,
// genuinely airborne phase, and the drag-based solver above is the correct
// (and more accurate) model for that phase too. See
// AtBatDataEntryPanel.jsx's computeShotShapeEstimate.
