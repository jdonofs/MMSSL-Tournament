import {
  STADIUM_CONFIGS,
  estimateHitAngle,
  estimateHitDistance,
  getFielderFieldSpot,
  projectDistanceAngleToSpot,
} from '../components/FieldPlayBuilder'

function toFiniteNumber(value) {
  if (value == null) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function roundSpot(spot) {
  if (!spot) return null
  const x = toFiniteNumber(spot.x)
  const y = toFiniteNumber(spot.y)
  if (x == null || y == null) return null
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
  }
}

function storedSpotForPa(pa) {
  const x = toFiniteNumber(pa?.hit_x)
  const y = toFiniteNumber(pa?.hit_y)
  if (x == null || y == null) return null
  return { x, y }
}

function fieldedSpotForPa(pa) {
  const x = toFiniteNumber(pa?.fielded_x)
  const y = toFiniteNumber(pa?.fielded_y)
  if (x == null || y == null) return null
  return { x, y }
}

function projectStoredDistanceForPa(pa, stadiumConfig) {
  const distance = toFiniteNumber(pa?.hit_distance_ft)
  const angle = toFiniteNumber(pa?.hit_angle_deg)
  if (distance == null || angle == null || !stadiumConfig) return null
  return roundSpot(projectDistanceAngleToSpot(distance, angle, stadiumConfig))
}

export function deriveTrackedHitFields(pa = {}, fallbackStadiumKey = null) {
  const stadiumKey = pa.hit_stadium_key || fallbackStadiumKey || null
  const stadiumConfig = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
  if (!stadiumConfig) return null

  const existingSpot = storedSpotForPa(pa)
  const projectedSpot = existingSpot ? null : projectStoredDistanceForPa(pa, stadiumConfig)
  const fieldedSpot = (!existingSpot && !projectedSpot) ? fieldedSpotForPa(pa) : null
  const fielderSpot = (!existingSpot && !projectedSpot && !fieldedSpot && pa.hit_location != null)
    ? roundSpot(getFielderFieldSpot(pa.hit_location, stadiumConfig))
    : null
  const resolvedSpot = existingSpot || projectedSpot || fieldedSpot || fielderSpot

  const patch = {}
  if (pa.hit_stadium_key == null && stadiumKey) patch.hit_stadium_key = stadiumKey
  if (pa.hit_x == null && resolvedSpot?.x != null) patch.hit_x = resolvedSpot.x
  if (pa.hit_y == null && resolvedSpot?.y != null) patch.hit_y = resolvedSpot.y

  if (resolvedSpot && pa.hit_distance_ft == null) {
    const derivedDistance = estimateHitDistance(resolvedSpot, stadiumConfig)
    if (derivedDistance != null) patch.hit_distance_ft = derivedDistance
  }
  if (resolvedSpot && pa.hit_angle_deg == null) {
    const derivedAngle = estimateHitAngle(resolvedSpot, stadiumConfig)
    if (derivedAngle != null) patch.hit_angle_deg = derivedAngle
  }

  if (!Object.keys(patch).length) return null
  return {
    ...patch,
    hit_tracking_source: fielderSpot ? 'fielder_position_fallback' : (fieldedSpot ? 'fielded_position_capture' : 'derived_projection'),
  }
}

export function enrichPlateAppearancesWithDerivedHitTracking(plateAppearances = [], stadiumKeyByGameId = {}) {
  return plateAppearances.map((pa) => {
    const derived = deriveTrackedHitFields(pa, stadiumKeyByGameId[String(pa.game_id)] || null)
    return derived ? { ...pa, ...derived } : pa
  })
}
