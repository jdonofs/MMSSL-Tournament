import { STADIUM_CONFIGS, estimateWallDistanceAtAngle } from '../components/FieldPlayBuilder'
import { MIN_PA_THRESHOLD } from './statsCalculator'
import { solveExitVelocityWithDrag } from './exitVelocityPhysics'

export const HARD_HIT_THRESHOLD_FT = 275

// A caught fly/liner counts as a robbed home run when the catch spot is
// within this many feet of (or beyond) the wall at that angle. For exit
// velocity/launch angle specifically, the tapped/marked catch spot
// understates true distance — the ball was still carrying past the fence
// when caught, not landing where the glove met it — so the assumed "true"
// distance is the wall distance plus this much further carry, instead of
// the truncated catch-point distance. Shared by every place that computes
// exit velocity for a robbed HR (Scorebook's live Buddy Jump flow,
// AtBatDataEntryPanel/AtBatPage's video-reviewed ones) so the assumption
// can't drift between them.
export const ROBBED_HR_WALL_MARGIN_FT = 15
export const ROBBED_HR_CARRY_FT = 15

// Statcast-standard exit-velocity threshold, distinct from HARD_HIT_THRESHOLD_FT
// (the distance-based version above, kept for backward compatibility with rows
// that predate exit velocity tracking).
export const HARD_HIT_VELOCITY_THRESHOLD_MPH = 95

// Statcast's launch-angle window for "sweet spot" contact.
export const SWEET_SPOT_MIN_DEG = 8
export const SWEET_SPOT_MAX_DEG = 32

// Barrel classification: exit velocity >= 98mph, with the qualifying launch-angle
// window widening from 20-35 deg at 98mph out to 5-65 deg at 116mph+. The
// underlying MLB Statcast reference points (26-30 widening to 8-50) were tuned
// to real batted-ball flight; this game's distance/hang-time-derived launch
// angles cluster bimodally instead -- sharp liners at 5-20 deg and towering
// majestic fly balls at 50-65 deg -- with almost nothing in Statcast's 26-50
// window in between. Widened here to actually cover both clusters instead of
// classifying next to nothing as a barrel.
const BARREL_MIN_VELOCITY_MPH = 98
const BARREL_MAX_VELOCITY_MPH = 116
const BARREL_NARROW_ANGLE_RANGE = [20, 35]
const BARREL_WIDE_ANGLE_RANGE = [5, 65]

export function isBarrel(exitVelocityMph, launchAngleDeg) {
  if (exitVelocityMph == null || launchAngleDeg == null) return false
  const ev = Number(exitVelocityMph)
  const la = Number(launchAngleDeg)
  if (!Number.isFinite(ev) || !Number.isFinite(la) || ev < BARREL_MIN_VELOCITY_MPH) return false
  const t = Math.max(0, Math.min(1, (ev - BARREL_MIN_VELOCITY_MPH) / (BARREL_MAX_VELOCITY_MPH - BARREL_MIN_VELOCITY_MPH)))
  const lowerBound = BARREL_NARROW_ANGLE_RANGE[0] - t * (BARREL_NARROW_ANGLE_RANGE[0] - BARREL_WIDE_ANGLE_RANGE[0])
  const upperBound = BARREL_NARROW_ANGLE_RANGE[1] + t * (BARREL_WIDE_ANGLE_RANGE[1] - BARREL_NARROW_ANGLE_RANGE[1])
  return la >= lowerBound && la <= upperBound
}

// Contact-quality rates that require both exit velocity AND launch angle (unlike
// summarizeHitDistance/summarizeExitVelocity above, which each only need one).
export function summarizeContactQuality(plateAppearances = []) {
  const pas = plateAppearances.filter((pa) => (
    pa && pa.exit_velocity_mph != null && pa.launch_angle_deg != null &&
    Number.isFinite(Number(pa.exit_velocity_mph)) && Number.isFinite(Number(pa.launch_angle_deg))
  ))
  const sampleSize = pas.length
  if (sampleSize === 0) {
    return { sampleSize: 0, barrels: null, barrelRate: null, hardHitCount: null, hardHitRate: null, sweetSpotCount: null, sweetSpotRate: null }
  }
  const barrels = pas.filter((pa) => isBarrel(pa.exit_velocity_mph, pa.launch_angle_deg)).length
  const hardHitCount = pas.filter((pa) => Number(pa.exit_velocity_mph) >= HARD_HIT_VELOCITY_THRESHOLD_MPH).length
  const sweetSpotCount = pas.filter((pa) => {
    const la = Number(pa.launch_angle_deg)
    return la >= SWEET_SPOT_MIN_DEG && la <= SWEET_SPOT_MAX_DEG
  }).length
  return {
    sampleSize,
    barrels,
    barrelRate: Math.round((barrels / sampleSize) * 1000) / 1000,
    hardHitCount,
    hardHitRate: Math.round((hardHitCount / sampleSize) * 1000) / 1000,
    sweetSpotCount,
    sweetSpotRate: Math.round((sweetSpotCount / sampleSize) * 1000) / 1000,
  }
}

const AVG_DISTANCE_FLOOR_FT = 150
const AVG_DISTANCE_CEIL_FT = 320
const MAX_DISTANCE_FLOOR_FT = 200
const MAX_DISTANCE_CEIL_FT = 420

function withDistance(pas = []) {
  return pas.filter((pa) => pa && pa.hit_distance_ft != null && Number.isFinite(Number(pa.hit_distance_ft)))
}

export function summarizeHitDistance(plateAppearances = []) {
  const pas = withDistance(plateAppearances)
  const sampleSize = pas.length
  if (sampleSize === 0) {
    return { sampleSize: 0, avgDistance: null, maxDistance: null, hardHitCount: null, hardHitRate: null }
  }
  const distances = pas.map((pa) => Number(pa.hit_distance_ft))
  const avgDistance = distances.reduce((sum, d) => sum + d, 0) / sampleSize
  const maxDistance = Math.max(...distances)
  const hardHitCount = distances.filter((d) => d >= HARD_HIT_THRESHOLD_FT).length
  return {
    sampleSize,
    avgDistance: Math.round(avgDistance * 10) / 10,
    maxDistance: Math.round(maxDistance),
    hardHitCount,
    hardHitRate: Math.round((hardHitCount / sampleSize) * 1000) / 1000,
  }
}

// Derives exit velocity + launch angle from a landed-spot distance and the
// contact-to-landed hang time. Two knowns (distance, time) fully determine
// the two unknowns (launch speed, launch angle) via projectile physics —
// same model for every trajectory, grounders included, since contact to
// when it first touches the ground is a real (if brief) airborne phase for
// a grounder too (see exitVelocityPhysics.js).
export function estimateExitVelocity(distanceFt, hangTimeSec) {
  const result = solveExitVelocityWithDrag(distanceFt, hangTimeSec)
  if (!result) return null
  return { exitVelocityMph: result.exitVelocityMph, launchAngleDeg: result.launchAngleDeg }
}

// The distance to feed estimateExitVelocity for a PA that might be a robbed
// home run — see ROBBED_HR_CARRY_FT above for why the raw hit_distance_ft
// (the actual catch spot) isn't the right input once is_robbed_hr is set.
// Callers keep hit_distance_ft itself unchanged (it's real, useful data —
// where the catch actually happened), and only substitute this corrected
// number into the exit-velocity/launch-angle calculation.
export function exitVelocityDistanceFt({ isRobbedHr, hitDistanceFt, hitAngleDeg }, config) {
  if (isRobbedHr && config && hitAngleDeg != null) {
    const wallDistanceFt = estimateWallDistanceAtAngle(hitAngleDeg, config)
    if (wallDistanceFt != null) return wallDistanceFt + ROBBED_HR_CARRY_FT
  }
  return hitDistanceFt
}

function withExitVelocity(pas = []) {
  return pas.filter((pa) => pa && pa.exit_velocity_mph != null && Number.isFinite(Number(pa.exit_velocity_mph)))
}

export function summarizeExitVelocity(plateAppearances = []) {
  const pas = withExitVelocity(plateAppearances)
  const sampleSize = pas.length
  if (sampleSize === 0) {
    return { sampleSize: 0, avgExitVelocity: null, maxExitVelocity: null, avgLaunchAngle: null }
  }
  const velocities = pas.map((pa) => Number(pa.exit_velocity_mph))
  const angles = pas
    .map((pa) => (pa.launch_angle_deg != null ? Number(pa.launch_angle_deg) : null))
    .filter((angle) => angle != null && Number.isFinite(angle))
  const avgExitVelocity = velocities.reduce((sum, v) => sum + v, 0) / sampleSize
  const maxExitVelocity = Math.max(...velocities)
  const avgLaunchAngle = angles.length ? angles.reduce((sum, a) => sum + a, 0) / angles.length : null
  return {
    sampleSize,
    avgExitVelocity: Math.round(avgExitVelocity * 10) / 10,
    maxExitVelocity: Math.round(maxExitVelocity * 10) / 10,
    avgLaunchAngle: avgLaunchAngle != null ? Math.round(avgLaunchAngle * 10) / 10 : null,
  }
}

function normalize(value, floor, ceil) {
  if (value == null) return null
  return Math.max(0, Math.min(1, (value - floor) / (ceil - floor)))
}

// Composite quality-of-contact index (0-100). Named to avoid colliding with
// buildCharacterIntrinsics().powerScore, which is an in-game ability grade.
export function calculateHitPowerIndex(distanceProfile) {
  if (!distanceProfile || distanceProfile.sampleSize === 0) return null
  const avgNorm = normalize(distanceProfile.avgDistance, AVG_DISTANCE_FLOOR_FT, AVG_DISTANCE_CEIL_FT)
  const maxNorm = normalize(distanceProfile.maxDistance, MAX_DISTANCE_FLOOR_FT, MAX_DISTANCE_CEIL_FT)
  const hardHitNorm = distanceProfile.hardHitRate ?? 0
  const blended = (avgNorm * 0.45) + (maxNorm * 0.25) + (hardHitNorm * 0.30)
  return Math.round(blended * 100)
}

// League-wide avg distance per stadium key, used to flat-normalize a
// player's distances against the parks they actually played in. v1 only —
// a future refinement could bucket by hit_angle_deg tercile per stadium to
// account for asymmetric park shapes (e.g. a short CF but long foul lines).
export function calculateParkAdjustedDistance(playerPas = [], allPas = []) {
  const playerWithDist = withDistance(playerPas)
  if (playerWithDist.length === 0) return null

  const leagueByStadium = new Map()
  withDistance(allPas).forEach((pa) => {
    const key = pa.hit_stadium_key
    if (!key) return
    if (!leagueByStadium.has(key)) leagueByStadium.set(key, [])
    leagueByStadium.get(key).push(Number(pa.hit_distance_ft))
  })
  const leagueAvgAll = (() => {
    const all = [...leagueByStadium.values()].flat()
    return all.length ? all.reduce((sum, d) => sum + d, 0) / all.length : null
  })()
  if (!leagueAvgAll) return null

  const adjusted = playerWithDist.map((pa) => {
    const key = pa.hit_stadium_key
    const parkDistances = key ? leagueByStadium.get(key) : null
    const parkAvg = parkDistances?.length ? parkDistances.reduce((sum, d) => sum + d, 0) / parkDistances.length : leagueAvgAll
    const factor = parkAvg > 0 ? leagueAvgAll / parkAvg : 1
    return Number(pa.hit_distance_ft) * factor
  })
  return Math.round((adjusted.reduce((sum, d) => sum + d, 0) / adjusted.length) * 10) / 10
}

// For a single PA with hit_distance_ft/hit_angle_deg, counts how many of the
// known stadiums the ball would have cleared the wall in at that angle.
export function wouldBeHrElsewhere(pa) {
  if (!pa || pa.hit_distance_ft == null || pa.hit_angle_deg == null) return null
  const distance = Number(pa.hit_distance_ft)
  const angle = Number(pa.hit_angle_deg)
  const stadiumKeys = Object.keys(STADIUM_CONFIGS)
  let clearedCount = 0
  stadiumKeys.forEach((key) => {
    const wallDistance = estimateWallDistanceAtAngle(angle, STADIUM_CONFIGS[key])
    if (wallDistance != null && distance >= wallDistance) clearedCount += 1
  })
  return { clearedCount, totalStadiums: stadiumKeys.length }
}

// Descriptive correlation only - does not feed the odds engine.
export function correlateDistanceWithCharacterAbility(characterRows = []) {
  const eligible = characterRows.filter((row) => (row.distanceProfile?.sampleSize || 0) >= MIN_PA_THRESHOLD)
  if (eligible.length < 2) return null

  const xs = eligible.map((row) => row.intrinsics?.powerScore ?? 0)
  const ys = eligible.map((row) => row.distanceProfile?.avgDistance ?? 0)
  const n = xs.length
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n
  let numerator = 0
  let denomX = 0
  let denomY = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX
    const dy = ys[i] - meanY
    numerator += dx * dy
    denomX += dx * dx
    denomY += dy * dy
  }
  const denom = Math.sqrt(denomX * denomY)
  const correlation = denom > 0 ? numerator / denom : null

  return {
    correlation: correlation != null ? Math.round(correlation * 1000) / 1000 : null,
    sampleSize: n,
    points: eligible.map((row) => ({
      characterId: row.characterId ?? row.id ?? null,
      powerScore: row.intrinsics?.powerScore ?? null,
      avgDistance: row.distanceProfile?.avgDistance ?? null,
      hardHitRate: row.distanceProfile?.hardHitRate ?? null,
    })),
  }
}
