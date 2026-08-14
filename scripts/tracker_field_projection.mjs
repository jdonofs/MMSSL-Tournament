// Server-safe subset of FieldPlayBuilder's calibrated stadium geometry. The
// tracker bridge runs directly in Node and cannot import a JSX component, but
// it must use the same home-plate and LF/CF/RF reference points so tracked
// distance/angle values land on the exact same field-image coordinate system
// as a manual tap in the At-Bat Editor.
export const TRACKER_STADIUM_FIELD_GEOMETRY = {
  mario_stadium: {
    homePlate: { x: 50.0, y: 92.9 },
    wallRefs: [{ x: 18.0, y: 44.2, dist: 259 }, { x: 50.6, y: 21.7, dist: 317 }, { x: 82.8, y: 44.6, dist: 259 }],
  },
  yoshi_park: {
    homePlate: { x: 50.2, y: 94.2 },
    wallRefs: [{ x: 10.4, y: 49.0, dist: 253 }, { x: 50.3, y: 25.2, dist: 324 }, { x: 89.4, y: 48.7, dist: 254 }],
  },
  wario_city: {
    homePlate: { x: 50.1, y: 94.1 },
    wallRefs: [{ x: 15.8, y: 41.8, dist: 292 }, { x: 51.4, y: 28.3, dist: 297 }, { x: 86.9, y: 43.2, dist: 289 }],
  },
  dk_jungle: {
    homePlate: { x: 50.2, y: 92.6 },
    wallRefs: [{ x: 15.4, y: 40.8, dist: 274 }, { x: 50.1, y: 19.2, dist: 323 }, { x: 83.9, y: 39.4, dist: 275 }],
  },
  bowser_castle: {
    homePlate: { x: 49.6, y: 92.8 },
    wallRefs: [{ x: 13.8, y: 44.7, dist: 278 }, { x: 49.2, y: 24.2, dist: 334 }, { x: 84.4, y: 43.8, dist: 277 }],
  },
  bowser_jr_playroom: {
    homePlate: { x: 49.8, y: 92.6 },
    wallRefs: [{ x: 13.3, y: 44.2, dist: 262 }, { x: 50.3, y: 20.8, dist: 328 }, { x: 86.0, y: 44.3, dist: 264 }],
  },
  daisy_cruiser: {
    homePlate: { x: 50.3, y: 93.9 },
    wallRefs: [{ x: 24.7, y: 62.5, dist: 232 }, { x: 50.3, y: 37.9, dist: 328 }, { x: 75.3, y: 61.7, dist: 231 }],
  },
  peach_ice_garden: {
    homePlate: { x: 50.0, y: 93.0 },
    wallRefs: [{ x: 13.3, y: 41.6, dist: 314 }, { x: 50.9, y: 18.0, dist: 402 }, { x: 86.6, y: 42.9, dist: 313 }],
  },
  luigis_mansion: {
    homePlate: { x: 49.9, y: 90.4 },
    wallRefs: [{ x: 13.6, y: 47.8, dist: 282 }, { x: 49.7, y: 27.4, dist: 351 }, { x: 85.8, y: 48.9, dist: 287 }],
  },
  generic_field: {
    homePlate: { x: 49.9, y: 90.4 },
    wallRefs: [{ x: 9.4, y: 52.3, dist: 272 }, { x: 50.6, y: 22.1, dist: 334 }, { x: 90.4, y: 52.2, dist: 272 }],
  },
}

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
//   c0 + c1*v + c2*a + c3*a^2                     LOO 31.4 ft
//   c0 + c1*v + c2*sin(a) + c3*v*sin(2a)          LOO 29.9 ft
//   c0 + c1*v + c2*a + c3*a^2 + c4*v*a            LOO 29.8 ft
//   this one, adding v*a^2                        LOO 25.1 ft
//
// Sanity checked beyond the score: distance peaks at 35 degrees, rises
// monotonically with exit velocity, and residual bias is flat across the range
// (+20 ft under 150, 0 ft beyond 330 -- the deep end is where it gets used).
//
// LIMITS. Trained on 76-117 mph and 48-396 ft from one park, and applied to
// balls that outran tracking, which are by definition deeper than anything in
// the training set. Exit velocity is also skewed hard: 71 of the 98 sit between
// 105 and 115 mph. Treat the result as a good estimate, not a measurement.
//
// (An earlier fit here was discarded: it was trained on records a log parser
// had spliced together, turning 4 real contacts into "45". scripts/
// extract_batted_balls.mjs now bounds records properly and is tested against
// exactly that failure.)
const DISTANCE_COEFFICIENTS = [
  30.0025866, 0.811115553, -21.1718510, 0.380001446, 0.337470128, -0.00566511042,
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
