// Server-safe geometry shared with FieldPlayBuilder. Re-export the historical
// tracker name for callers while keeping the values in one source of truth.
import { STADIUM_FIELD_GEOMETRY } from '../src/utils/stadiumFieldGeometry.js'

export const TRACKER_STADIUM_FIELD_GEOMETRY = STADIUM_FIELD_GEOMETRY

export function projectTrackerFieldSpot(distanceFeet, angleDegrees, stadiumKey) {
  const config = TRACKER_STADIUM_FIELD_GEOMETRY[stadiumKey]
  const distance = Number(distanceFeet)
  const angle = Number(angleDegrees)
  if (!config || !Number.isFinite(distance) || distance < 0 || !Number.isFinite(angle)) return null

  const refs = config.wallRefs.map((ref) => {
    const dx = ref.x - config.homePlate.x
    const dy = ref.y - config.homePlate.y
    return {
      angle: (Math.atan2(dx, -dy) * 180) / Math.PI,
      scale: Math.sqrt((dx * dx) + (dy * dy)) / ref.dist,
    }
  }).sort((left, right) => left.angle - right.angle)

  let scale = null
  if (angle <= refs[0].angle) scale = refs[0].scale
  else if (angle >= refs[refs.length - 1].angle) scale = refs[refs.length - 1].scale
  else {
    for (let index = 0; index < refs.length - 1; index += 1) {
      if (angle < refs[index].angle || angle > refs[index + 1].angle) continue
      const fraction = (angle - refs[index].angle) / (refs[index + 1].angle - refs[index].angle)
      scale = refs[index].scale * (1 - fraction) + refs[index + 1].scale * fraction
      break
    }
  }
  if (scale == null) return null

  const imageDistance = distance * scale
  const radians = (angle * Math.PI) / 180
  return {
    x: Math.round((config.homePlate.x + (imageDistance * Math.sin(radians))) * 10) / 10,
    y: Math.round((config.homePlate.y - (imageDistance * Math.cos(radians))) * 10) / 10,
  }
}

// Forward transform used by the editor when a scorer taps a location on the
// field image. Keeping a Node-safe copy here lets data migrations recompute a
// stored distance from the original hit_x/hit_y coordinates with exactly the
// same stadium calibration as new plate appearances.
export function estimateTrackerHitDistanceFeet(spot, stadiumKey) {
  const config = TRACKER_STADIUM_FIELD_GEOMETRY[stadiumKey]
  const x = Number(spot?.x)
  const y = Number(spot?.y)
  if (!config || !Number.isFinite(x) || !Number.isFinite(y)) return null

  const dx = x - config.homePlate.x
  const dy = y - config.homePlate.y
  const imageDistance = Math.sqrt((dx * dx) + (dy * dy))
  if (imageDistance < 1) return null
  const angle = Math.atan2(dx, -dy)

  const refs = config.wallRefs.map((ref) => {
    const refDx = ref.x - config.homePlate.x
    const refDy = ref.y - config.homePlate.y
    return {
      angle: Math.atan2(refDx, -refDy),
      scale: Math.sqrt((refDx * refDx) + (refDy * refDy)) / ref.dist,
    }
  }).sort((left, right) => left.angle - right.angle)

  let scale = null
  if (angle <= refs[0].angle) scale = refs[0].scale
  else if (angle >= refs[refs.length - 1].angle) scale = refs[refs.length - 1].scale
  else {
    for (let index = 0; index < refs.length - 1; index += 1) {
      if (angle < refs[index].angle || angle > refs[index + 1].angle) continue
      const fraction = (angle - refs[index].angle) / (refs[index + 1].angle - refs[index].angle)
      scale = refs[index].scale * (1 - fraction) + refs[index + 1].scale * fraction
      break
    }
  }
  return scale ? Math.round(imageDistance / scale) : null
}

const MPH_TO_FEET_PER_SECOND = 1.4666667
const STANDARD_GRAVITY_FT_PER_SEC2 = 32.174
// Contact happens roughly bat height above the ground; distance is not very
// sensitive to a few feet of error here at real home-run speeds/angles.
const ASSUMED_CONTACT_HEIGHT_FEET = 3

// How far a batted ball carries, fitted to 98 tracked landings.
//
// Real-world projectile physics does not describe this game. Measured against
// those same 98 records, a no-drag ballistic model overshoots by 160 feet on
// average (256 ft RMS) and gets worse the higher the ball is hit, which is what
// unmodelled drag looks like. The pure ballistic SHAPE, k*v^2*sin(2a), explains
// almost none of the variance here (R^2 0.09), so no amount of tuning gravity
// rescues it -- the functional form is wrong, not just its constant.
//
// Chosen by leave-one-out cross-validation rather than in-sample fit:
//
//   c0 + c1*v + c2*a + c3*a^2                     LOO 30.7 ft
//   c0 + c1*v + c2*sin(a) + c3*v*sin(2a)          LOO 29.3 ft
//   c0 + c1*v + c2*a + c3*a^2 + c4*v*a            LOO 29.2 ft
//   this one, adding v*a^2                        LOO 24.6 ft
//
// Sanity checked beyond the score: distance peaks at 35 degrees, rises
// monotonically with exit velocity, and residual bias is flat across the range
// (+20 ft under 150, 0 ft beyond 330 -- the deep end is where it gets used).
//
// LIMITS. Trained on 74-114 mph and 47-388 ft from one park, and applied to
// balls that outran tracking, which are by definition deeper than anything in
// the training set. Exit velocity is also skewed hard: 71 of the 98 sit between
// 105 and 115 mph. Treat the result as a good estimate, not a measurement.
//
// (An earlier fit here was discarded: it was trained on records a log parser
// had spliced together, turning 4 real contacts into "45". scripts/
// extract_batted_balls.mjs now bounds records properly and is tested against
// exactly that failure.)
// The original fit used 90/26.84 ft per unit for both its velocities and its
// target distances. Moving both axes to 1 metre/unit is an exact linear change
// of variables: c0/c2/c3 scale by the new-to-old ratio, while terms containing
// velocity do not because their input and output scale cancel. This preserves
// every prediction in raw game units without introducing a second fit.
const DISTANCE_COEFFICIENTS = [
  29.3551117, 0.811115553, -20.7149490, 0.371800773, 0.337470128, -0.00566511042,
]

export function estimateTrackerBattedBallDistanceFeet(exitVelocityMph, launchAngleDeg) {
  const v = Number(exitVelocityMph)
  const a = Number(launchAngleDeg)
  if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(a)) return null
  const [c0, c1, c2, c3, c4, c5] = DISTANCE_COEFFICIENTS
  const distance = c0 + (c1 * v) + (c2 * a) + (c3 * a * a) + (c4 * v * a) + (c5 * v * a * a)
  // A polynomial fit has no idea it is describing a ball. Weak contact at a
  // steep angle drives it negative, and a negative distance would plot behind
  // home plate; refusing is better than inventing a position.
  return distance > 0 ? distance : null
}

export function projectTrackerBattedBallDistanceFeet(exitVelocityMph, launchAngleDeg) {
  const speedFtPerSec = Number(exitVelocityMph) * MPH_TO_FEET_PER_SECOND
  const launchRadians = (Number(launchAngleDeg) * Math.PI) / 180
  if (!Number.isFinite(speedFtPerSec) || speedFtPerSec <= 0 || !Number.isFinite(launchRadians)) return null
  const vx = speedFtPerSec * Math.cos(launchRadians)
  const vy = speedFtPerSec * Math.sin(launchRadians)
  const discriminant = (vy * vy) + (2 * STANDARD_GRAVITY_FT_PER_SEC2 * ASSUMED_CONTACT_HEIGHT_FEET)
  if (discriminant < 0) return null
  const timeToLandingSec = (vy + Math.sqrt(discriminant)) / STANDARD_GRAVITY_FT_PER_SEC2
  if (!Number.isFinite(timeToLandingSec) || timeToLandingSec <= 0) return null
  // Distance is the calibrated fit. Hang time is NOT calibrated -- it is still
  // the no-drag projectile value, and the same drag that makes that model
  // overshoot distance means it understates time in the air. Flagged so a
  // caller can tell either apart from a tracked measurement.
  const distanceFeet = estimateTrackerBattedBallDistanceFeet(exitVelocityMph, launchAngleDeg)
  if (distanceFeet == null) return null
  return {
    distanceFeet,
    hangTimeSec: timeToLandingSec,
    hangTimeIsModelled: true,
    distanceIsModelled: true,
  }
}

// Real fence distance at the tracked spray angle. This is the Node-safe
// equivalent of FieldPlayBuilder's estimateWallDistanceAtAngle helper so the
// bridge and the At-Bat Editor use the same calibrated stadium geometry.
export function estimateTrackerWallDistance(angleDegrees, stadiumKey) {
  const config = TRACKER_STADIUM_FIELD_GEOMETRY[stadiumKey]
  const angle = Number(angleDegrees)
  if (!config || !Number.isFinite(angle)) return null

  const refs = config.wallRefs.map((ref) => {
    const dx = ref.x - config.homePlate.x
    const dy = ref.y - config.homePlate.y
    return {
      angle: (Math.atan2(dx, -dy) * 180) / Math.PI,
      distance: ref.dist,
    }
  }).sort((left, right) => left.angle - right.angle)

  if (angle <= refs[0].angle) return refs[0].distance
  if (angle >= refs[refs.length - 1].angle) return refs[refs.length - 1].distance
  for (let index = 0; index < refs.length - 1; index += 1) {
    if (angle < refs[index].angle || angle > refs[index + 1].angle) continue
    const fraction = (angle - refs[index].angle) / (refs[index + 1].angle - refs[index].angle)
    return refs[index].distance * (1 - fraction) + refs[index + 1].distance * fraction
  }
  return null
}
