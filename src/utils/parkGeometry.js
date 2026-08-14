// Measured park geometry, in the game's own world units.
//
// This is the authoritative source for where things actually are. Every number
// here was measured out of the running game rather than tapped on a screenshot
// (see scripts/collect_fence_samples.py and scripts/derive_fence_geometry.py):
// a character carrying the ball was driven head-on into the wall at ~40 angles
// per park, which stops at a repeatable spot, and the ball's own coordinates
// were read directly from memory.
//
// Coordinates share the game's frame: home plate near the origin, -Z toward
// centre field, +X toward first base. Spray angle is measured from
// straightaway centre, negative toward third base.
//
// UNITS, NOT FEET. Feet are a label applied at the very end via FEET_PER_UNIT,
// which carries the single assumption in the whole chain (that the base path
// is regulation size). Keeping geometry in units means that assumption can
// change without any of this needing to be re-measured.

// Measured infield: fitting a regulation diamond to 103 held positions on
// home/1B/2B/3B/rubber gives this base path with a 0.19u RMS residual, and
// independently places the rubber within 0.4% of 60'6".
export const BASE_PATH_UNITS = 26.84
export const BASE_PATH_FEET = 90.0
export const FEET_PER_UNIT = BASE_PATH_FEET / BASE_PATH_UNITS

// The world origin is not exactly home plate. Two independent measurements
// agree it sits about 0.7 units beyond it: pitches cross the plate near
// (+0.2, -0.9), and the infield fit puts the plate at (-0.067, -0.714).
// Distances measured from the origin instead of from here run long by that
// much, which is small but free to correct.
export const HOME_PLATE = { x: -0.067, z: -0.714 }

export const RUBBER_DISTANCE_UNITS = 60.5 / FEET_PER_UNIT

// Presses read one body radius short of the padding, since a character cannot
// stand inside the wall. Measured from a batted ball that bounced off the wall
// at +37.5deg: the ball reached 0.17u beyond the press line, keeping 92% of
// its pace off the padding. It is a property of the character rather than the
// park, so the same correction applies everywhere -- already folded into the
// fence arrays below.
export const BODY_RADIUS_UNITS = 0.17

// [sprayAngleDeg, radiusUnits], ordered by angle. Radii are distances from
// HOME_PLATE, with BODY_RADIUS_UNITS already added.
export const PARK_FENCES = {
  mario_stadium: [
    [-44.69, 79.08], [-44.43, 79.53], [-42.54, 80.01], [-36.79, 82.17],
    [-33.51, 83.84], [-28.68, 86.96], [-24.03, 90.82], [-19.94, 95.05],
    [-18.43, 96.42], [-13.32, 95.68], [-9.78, 95.61], [-5.72, 95.98],
    [-2.14, 96.72], [1.69, 97.95], [4.75, 99.27], [6.33, 100.08],
    [6.58, 99.94], [6.76, 99.86], [9.77, 98.60], [12.63, 97.68],
    [16.40, 96.86], [18.71, 96.57], [18.76, 96.57], [18.79, 96.53],
    [19.08, 96.30], [21.16, 94.80], [23.98, 93.02], [27.63, 91.13],
    [30.56, 89.94], [31.28, 89.68], [31.57, 89.49], [32.33, 88.70],
    [34.60, 86.54], [36.93, 84.56], [39.84, 82.40], [42.42, 80.74],
    [44.62, 79.40],
  ],
}

export const MEASURED_PARK_KEYS = Object.keys(PARK_FENCES)

export function hasMeasuredGeometry(parkKey) {
  return Object.hasOwn(PARK_FENCES, parkKey)
}

// Exact world -> stadium-artwork mapping, one 3x3 projective transform per
// park, produced by public/calibrate-homography.html.
//
// A ballfield is a plane and the artwork is a perspective view of it, so this
// relationship is not an approximation that happens to fit -- it is the exact
// one, and it is what the old three-point radial scale could never express.
//
// Each matrix is fitted from EIGHT landmarks: the five infield positions, plus
// both foul poles and dead centre taken from the measured fence. The outfield
// three are not optional. The infield alone spans about 38 units while the
// fence sits at 80-100, so an infield-only fit extrapolates a projective
// transform far past its calibration region -- sub-pixel clicking error near
// home fans out into tens of feet at the wall, and the projected wall visibly
// drifts off the painted one while the diamond still looks perfect.
//
// The check that the fit is honest: the wallRefs hand-tapped years earlier for
// the old geometry sit on the wall's TOP edge, not its base, since that is what
// the eye picks when clicking "the wall" on a screenshot. Projecting our fence
// to WALL_HEIGHT_UNITS reproduces them to 0.4% at centre field and 0.6-1.2% at
// the poles -- and reaching the top uses this matrix AND the vertical below, so
// the agreement covers the height model too.
export const PARK_IMAGE_HOMOGRAPHY = {
  mario_stadium: [
    0.7297496135, -0.2645464743, 50.19907679,
    0.003532676323, 0.5808994849, 93.64572873,
    -0.00008449240113, -0.005254595705, 1.000000000,
  ],
}

// Outfield wall height, in units. Measured from a batted ball that clipped the
// very top of the wall and left the park: its tracked endpoint sat at 4.645
// units, and our independently measured fence put the wall 1.5 ft inside that
// point. Used to calibrate the vertical below, since it gives a feature whose
// height AND ground position are both known.
export const WALL_HEIGHT_UNITS = 4.645

// The vertical vanishing point per park, as a homogeneous 3-vector.
//
// PARK_IMAGE_HOMOGRAPHY maps the GROUND. A ball in the stands or off the top of
// the wall is not on the ground, and drawing it at the ground point beneath
// itself puts the marker nearer and lower than where the ball actually appears
// — which is exactly how this was noticed. An elevated point is the ground
// projection plus height times this one vector, so three numbers cover every
// height exactly.
//
// A park without an entry here still draws every ground-level hit correctly;
// only elevated endpoints fall back to their ground position.
export const PARK_IMAGE_VERTICAL = {
  // Third component is 0 by construction: the vanishing term is only
  // observable as a difference in apparent height between near and far, so
  // calibration points along one wall cannot see it, and left free it absorbs
  // their noise instead. Dropping it keeps height foreshortening correct via
  // the ground term's own depth denominator.
  mario_stadium: [0.1157609077, -0.7927953185, 0.000000000],
}

// Where a ball that clears the wall comes down, by spray angle.
//
// A ball landing beyond the fence does not land on the ground -- it lands on
// the seating deck, and a marker drawn at the ground point beneath it reads
// short in a perspective view. For a TRACKED ball this does not matter, since
// its height is measured. It matters for a projected one, which has no height
// at all and would otherwise be drawn as though the stands were the field.
//
// Measured from 34 tracked landings that cleared the wall. Height turns out to
// depend on ANGLE, not on how far past the wall the ball came down -- against
// distance past the wall the relationship is nothing (R^2 0.06), but split by
// angle two decks appear:
//
//   |angle| 0-19    n=19   mean 11.5 ft   sd 1.1 ft
//   |angle| 19-50   n=15   mean 22.1 ft   sd 6.5 ft
//
// The lower deck is tight enough to rely on. The upper is not -- 6.5 ft of
// scatter says there is more than one surface out there -- so treat a corner
// estimate as rougher than a centre one.
//
// Two dead-centre landings at 56 and 61 ft are excluded: at ~0 degrees and far
// above everything else, they are a different structure entirely (scoreboard or
// batter's eye), not the seating.
export const PARK_STANDS_DECKS = {
  mario_stadium: [
    { withinAngle: 19, heightUnits: 11.5 / 3.3532 },
    { withinAngle: 90, heightUnits: 22.1 / 3.3532 },
  ],
}

/**
 * Expected landing height for a ball that cleared the wall, in units.
 *
 * Null when the park has no measured deck profile, or when the ball did not
 * clear -- inside the wall it lands on the field, and the answer is zero.
 */
export function standsHeightUnits(parkKey, angleDeg, distanceUnits) {
  const decks = PARK_STANDS_DECKS[parkKey]
  const angle = Number(angleDeg)
  const fence = fenceRadiusAt(parkKey, angle)
  if (!decks || !Number.isFinite(angle) || fence == null) return null
  if (!(Number(distanceUnits) > fence)) return null
  for (const deck of decks) {
    if (Math.abs(angle) < deck.withinAngle) return deck.heightUnits
  }
  return decks[decks.length - 1].heightUnits
}

export function hasImageCalibration(parkKey) {
  return Object.hasOwn(PARK_IMAGE_HOMOGRAPHY, parkKey)
}

export function hasHeightCalibration(parkKey) {
  return Object.hasOwn(PARK_IMAGE_VERTICAL, parkKey)
}

// World position AND height -> percentage across the park's artwork. Height 0,
// or a park with no vertical fitted, falls through to the ground mapping.
export function worldToImagePercentAtHeight(parkKey, x, z, height) {
  const matrix = PARK_IMAGE_HOMOGRAPHY[parkKey]
  const vertical = PARK_IMAGE_VERTICAL[parkKey]
  const h = Number(height)
  if (!matrix || !vertical || !Number.isFinite(h) || h === 0) {
    return worldToImagePercent(parkKey, x, z)
  }
  const [a, b, c, d, e, f, g, hh, i] = matrix
  const [vx, vy, vw] = vertical
  const X = Number(x)
  const Z = Number(z)
  if (!Number.isFinite(X) || !Number.isFinite(Z)) return null
  const w = (g * X) + (hh * Z) + i + (h * vw)
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null
  return {
    x: ((a * X) + (b * Z) + c + (h * vx)) / w,
    y: ((d * X) + (e * Z) + f + (h * vy)) / w,
  }
}

// World position -> percentage across the park's artwork. Null when the park
// has not been calibrated, or when the point maps behind the camera -- callers
// must treat that as "cannot be drawn" rather than substituting a guess.
export function worldToImagePercent(parkKey, x, z) {
  const matrix = PARK_IMAGE_HOMOGRAPHY[parkKey]
  if (!matrix) return null
  const [a, b, c, d, e, f, g, h, i] = matrix
  const X = Number(x)
  const Z = Number(z)
  if (!Number.isFinite(X) || !Number.isFinite(Z)) return null
  const w = (g * X) + (h * Z) + i
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null
  return {
    x: ((a * X) + (b * Z) + c) / w,
    y: ((d * X) + (e * Z) + f) / w,
  }
}

// Fence distance at one spray angle, interpolated between measured points.
// Beyond the measured span the nearest measurement is held rather than
// extrapolated: past the foul poles there is no fence to describe, and a
// linear run-out would invent one.
export function fenceRadiusAt(parkKey, angleDeg) {
  const fence = PARK_FENCES[parkKey]
  const angle = Number(angleDeg)
  if (!fence || !fence.length || !Number.isFinite(angle)) return null
  if (angle <= fence[0][0]) return fence[0][1]
  if (angle >= fence[fence.length - 1][0]) return fence[fence.length - 1][1]
  for (let i = 0; i < fence.length - 1; i += 1) {
    const [a0, r0] = fence[i]
    const [a1, r1] = fence[i + 1]
    if (angle < a0 || angle > a1) continue
    if (a1 === a0) return r0
    return r0 + ((angle - a0) / (a1 - a0)) * (r1 - r0)
  }
  return null
}

export function fenceDistanceFeet(parkKey, angleDeg) {
  const radius = fenceRadiusAt(parkKey, angleDeg)
  return radius == null ? null : radius * FEET_PER_UNIT
}

// World position -> spray angle and distance from home plate.
export function worldToPolar(x, z) {
  const dx = Number(x) - HOME_PLATE.x
  const dz = Number(z) - HOME_PLATE.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
  return {
    angleDeg: (Math.atan2(dx, -dz) * 180) / Math.PI,
    distanceUnits: Math.sqrt((dx * dx) + (dz * dz)),
  }
}

// The foul lines run at 45 degrees either side of straightaway centre.
export const FOUL_LINE_ANGLE_DEG = 45

// Pull an ESTIMATED position back inside the foul lines.
//
// Only ever apply this to an estimate. A tracked coordinate is where the ball
// actually was, and balls genuinely do end up foul -- a foul pop-up caught for
// an out belongs in foul ground and must stay there.
//
// An estimate is different. A ball that leaves tracked play is positioned by
// extrapolation, or failing that from its LAUNCH spray angle, and a ball hit
// hard down the line commonly leaves the bat at more than 45 degrees and hooks
// fair. Nothing in either estimate knows about the foul lines, so a home run
// -- fair by definition -- gets drawn in foul territory. Clamping the angle
// keeps the one thing the result already told us.
export function clampToFairTerritory(x, z) {
  const polar = worldToPolar(x, z)
  if (!polar) return null
  if (Math.abs(polar.angleDeg) <= FOUL_LINE_ANGLE_DEG) return { x: Number(x), z: Number(z) }
  const clamped = Math.sign(polar.angleDeg) * FOUL_LINE_ANGLE_DEG
  return polarToWorld(clamped, polar.distanceUnits)
}

export function polarToWorld(angleDeg, distanceUnits) {
  const radians = (Number(angleDeg) * Math.PI) / 180
  const distance = Number(distanceUnits)
  if (!Number.isFinite(radians) || !Number.isFinite(distance)) return null
  return {
    x: HOME_PLATE.x + (distance * Math.sin(radians)),
    z: HOME_PLATE.z - (distance * Math.cos(radians)),
  }
}

// The regulation diamond, drawn from the fitted infield rather than from the
// individual base holds: the fit already averaged out the centring error in
// those, so it is the better estimate of where the bases actually are.
export function infieldCorners() {
  const half = BASE_PATH_UNITS / Math.sqrt(2)
  return {
    home: { x: HOME_PLATE.x, z: HOME_PLATE.z },
    first: { x: HOME_PLATE.x + half, z: HOME_PLATE.z - half },
    second: { x: HOME_PLATE.x, z: HOME_PLATE.z - (BASE_PATH_UNITS * Math.sqrt(2)) },
    third: { x: HOME_PLATE.x - half, z: HOME_PLATE.z - half },
    rubber: { x: HOME_PLATE.x, z: HOME_PLATE.z - RUBBER_DISTANCE_UNITS },
  }
}

// How far out the drawing needs to reach for a park, so every park can be
// rendered at TRUE SCALE against a shared extent -- which is what makes
// comparing two parks on one chart mean anything.
export function parkMaxRadius(parkKey) {
  const fence = PARK_FENCES[parkKey]
  if (!fence || !fence.length) return null
  return fence.reduce((max, [, radius]) => Math.max(max, radius), 0)
}

export function allParksMaxRadius() {
  return MEASURED_PARK_KEYS.reduce(
    (max, key) => Math.max(max, parkMaxRadius(key) || 0),
    0,
  )
}
