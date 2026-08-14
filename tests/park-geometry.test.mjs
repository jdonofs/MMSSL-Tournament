import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASE_PATH_UNITS,
  BODY_RADIUS_UNITS,
  FEET_PER_UNIT,
  HOME_PLATE,
  PARK_FENCES,
  RUBBER_DISTANCE_UNITS,
  WALL_HEIGHT_UNITS,
  FOUL_LINE_ANGLE_DEG,
  clampToFairTerritory,
  fenceDistanceFeet,
  fenceRadiusAt,
  hasImageCalibration,
  hasMeasuredGeometry,
  infieldCorners,
  parkMaxRadius,
  polarToWorld,
  standsHeightUnits,
  worldToImagePercent,
  worldToImagePercentAtHeight,
  worldToPolar,
} from '../src/utils/parkGeometry.js'

test('the scale is the measured base path against a regulation one', () => {
  assert.equal(BASE_PATH_UNITS, 26.84)
  assert.ok(Math.abs(FEET_PER_UNIT - 3.3532) < 0.001)
  // The rubber was held out of the infield fit and still landed within 0.4% of
  // 60'6", which is the evidence the scale rests on rather than an assumption
  // it makes. Guard that it stays true if the scale is ever retuned.
  assert.ok(Math.abs((RUBBER_DISTANCE_UNITS * FEET_PER_UNIT) - 60.5) < 0.01)
})

test('measured fence distances match what the presses recorded', () => {
  // Straightaway centre and both foul poles, cross-checked against the Reddit
  // run-timing numbers (259 / 317 / 259) which agree to within ~3%.
  const centre = fenceDistanceFeet('mario_stadium', 0)
  const leftPole = fenceDistanceFeet('mario_stadium', -45)
  const rightPole = fenceDistanceFeet('mario_stadium', 45)
  assert.ok(centre > 320 && centre < 332, `centre was ${centre}`)
  assert.ok(leftPole > 260 && leftPole < 270, `LF pole was ${leftPole}`)
  assert.ok(rightPole > 260 && rightPole < 270, `RF pole was ${rightPole}`)
  // A symmetric park should measure symmetric.
  assert.ok(Math.abs(leftPole - rightPole) < 8)
})

test('centre field is deeper than the lines, as a ballpark must be', () => {
  const centre = fenceRadiusAt('mario_stadium', 0)
  for (const angle of [-45, -35, 35, 45]) {
    assert.ok(fenceRadiusAt('mario_stadium', angle) < centre)
  }
})

test('the fence holds its end value past the foul poles instead of extrapolating', () => {
  const fence = PARK_FENCES.mario_stadium
  const [firstAngle, firstRadius] = fence[0]
  const [lastAngle, lastRadius] = fence[fence.length - 1]
  // Past the poles there is no fence to describe; running the last segment out
  // linearly would invent one, and at 90 degrees it would invent a big one.
  assert.equal(fenceRadiusAt('mario_stadium', firstAngle - 20), firstRadius)
  assert.equal(fenceRadiusAt('mario_stadium', lastAngle + 20), lastRadius)
  assert.equal(fenceRadiusAt('mario_stadium', -90), firstRadius)
})

test('interpolation lands between its neighbouring measurements', () => {
  const fence = PARK_FENCES.mario_stadium
  for (let i = 0; i < fence.length - 1; i += 1) {
    const [a0, r0] = fence[i]
    const [a1, r1] = fence[i + 1]
    if (a1 - a0 < 0.01) continue
    const mid = fenceRadiusAt('mario_stadium', (a0 + a1) / 2)
    assert.ok(mid >= Math.min(r0, r1) - 1e-9 && mid <= Math.max(r0, r1) + 1e-9)
  }
})

test('world and polar coordinates round-trip through home plate', () => {
  for (const [angle, radius] of [[0, 90], [-30, 80], [42, 79], [15, 50]]) {
    const world = polarToWorld(angle, radius)
    const polar = worldToPolar(world.x, world.z)
    assert.ok(Math.abs(polar.angleDeg - angle) < 1e-6)
    assert.ok(Math.abs(polar.distanceUnits - radius) < 1e-6)
  }
})

test('distances are measured from home plate, not the world origin', () => {
  // The origin sits about 0.7 units beyond the plate. A ball sitting exactly on
  // home plate must therefore read zero distance, not 0.7.
  const atPlate = worldToPolar(HOME_PLATE.x, HOME_PLATE.z)
  assert.ok(atPlate.distanceUnits < 1e-9)
  const atOrigin = worldToPolar(0, 0)
  assert.ok(atOrigin.distanceUnits > 0.5 && atOrigin.distanceUnits < 1.0)
})

test('the infield is a regulation diamond at the measured scale', () => {
  const { home, first, second, third, rubber } = infieldCorners()
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  for (const [p, q] of [[home, first], [first, second], [second, third], [third, home]]) {
    assert.ok(Math.abs(dist(p, q) - BASE_PATH_UNITS) < 1e-6)
  }
  // Diagonals of a square: side * sqrt(2).
  assert.ok(Math.abs(dist(home, second) - (BASE_PATH_UNITS * Math.SQRT2)) < 1e-6)
  assert.ok(Math.abs(dist(first, third) - (BASE_PATH_UNITS * Math.SQRT2)) < 1e-6)
  assert.ok(Math.abs((dist(home, rubber) * FEET_PER_UNIT) - 60.5) < 0.01)
})

test('a park with no measurements yet is reported as unmeasured, not guessed at', () => {
  assert.equal(hasMeasuredGeometry('mario_stadium'), true)
  assert.equal(hasMeasuredGeometry('peach_ice_garden'), false)
  assert.equal(fenceRadiusAt('peach_ice_garden', 0), null)
  assert.equal(fenceDistanceFeet('peach_ice_garden', 0), null)
  assert.equal(parkMaxRadius('peach_ice_garden'), null)
})

test('the body-radius correction is already folded into the stored fence', () => {
  // The presses stop one body radius short of the padding; the arrays here are
  // corrected, so re-adding it downstream would double-count.
  assert.ok(BODY_RADIUS_UNITS > 0 && BODY_RADIUS_UNITS < 1)
  assert.ok(parkMaxRadius('mario_stadium') > 99)
})

test('bad input is refused rather than plotted somewhere wrong', () => {
  assert.equal(fenceRadiusAt('mario_stadium', Number.NaN), null)
  assert.equal(fenceRadiusAt(null, 0), null)
  assert.equal(worldToPolar(Number.NaN, 0), null)
  assert.equal(polarToWorld(0, Number.NaN), null)
})

test('the image calibration reproduces independently tapped wall positions', () => {
  // The wallRefs in FieldPlayBuilder were hand-tapped years earlier, by eye,
  // for the old three-point geometry. They land on the wall's TOP edge, not its
  // base — which is what someone tapping "the centre field wall" on a
  // screenshot naturally clicks. Our fence measurement is the base, since it is
  // where a character standing on the ground stops against the padding.
  //
  // So the meaningful comparison is against the projected wall TOP, and it is a
  // strong one: reaching the top uses the homography AND the vertical, so
  // landing on points nobody involved in either fit ever saw validates the
  // whole height model rather than just the ground mapping.
  const at = (angle, height) => {
    const radius = fenceRadiusAt('mario_stadium', angle)
    const rad = (angle * Math.PI) / 180
    return worldToImagePercentAtHeight(
      'mario_stadium',
      HOME_PLATE.x + (radius * Math.sin(rad)),
      HOME_PLATE.z - (radius * Math.cos(rad)),
      height,
    )
  }
  const off = (p, x, y) => Math.hypot(p.x - x, p.y - y)
  assert.ok(off(at(0.5, WALL_HEIGHT_UNITS), 50.6, 21.7) < 1.0, 'centre field wall top')
  assert.ok(off(at(-45, WALL_HEIGHT_UNITS), 18.0, 44.2) < 2.0, 'left field pole wall top')
  assert.ok(off(at(45, WALL_HEIGHT_UNITS), 82.8, 44.6) < 2.0, 'right field pole wall top')

  // The base must sit BELOW the top by roughly the wall's height, which is the
  // direction that was wrong when the height fit was ill-conditioned.
  for (const angle of [-45, 0, 45]) {
    const base = at(angle, 0)
    const top = at(angle, WALL_HEIGHT_UNITS)
    assert.ok(base.y > top.y, `wall base must sit below its top at ${angle}deg`)
  }

  const home = worldToImagePercent('mario_stadium', HOME_PLATE.x, HOME_PLATE.z)
  assert.ok(off(home, 50.0, 92.9) < 0.5, 'home plate')
})

test('the wall looks taller near the camera than far from it', () => {
  // Perspective, and the check that caught an ill-conditioned height fit: an
  // ill-conditioned one produced a wall that was uniformly tall, and slightly
  // TALLER at centre field despite centre being furthest away.
  const apparentHeight = (angle) => {
    const radius = fenceRadiusAt('mario_stadium', angle)
    const rad = (angle * Math.PI) / 180
    const x = HOME_PLATE.x + (radius * Math.sin(rad))
    const z = HOME_PLATE.z - (radius * Math.cos(rad))
    return worldToImagePercentAtHeight('mario_stadium', x, z, 0).y
      - worldToImagePercentAtHeight('mario_stadium', x, z, WALL_HEIGHT_UNITS).y
  }
  assert.ok(apparentHeight(-45) > apparentHeight(0), 'LF pole wall must look taller than centre')
  assert.ok(apparentHeight(45) > apparentHeight(0), 'RF pole wall must look taller than centre')
  // A symmetric park should foreshorten symmetrically.
  assert.ok(Math.abs(apparentHeight(-45) - apparentHeight(45)) < 0.2)
})

test('an uncalibrated park reports no image mapping rather than a wrong one', () => {
  assert.equal(hasImageCalibration('mario_stadium'), true)
  assert.equal(hasImageCalibration('peach_ice_garden'), false)
  assert.equal(worldToImagePercent('peach_ice_garden', 0, -80), null)
  assert.equal(worldToImagePercent('mario_stadium', Number.NaN, 0), null)
})

test('an estimated home run is never plotted in foul territory', () => {
  // A ball hit hard down the line often LEAVES the bat past 45 degrees and
  // hooks fair, and a ball that outruns tracking is positioned by extrapolation
  // or from that launch angle — neither of which knows the foul lines exist.
  // The result already told us it was fair, so keep that.
  for (const angle of [52, -52, 61, -48, 89, -89]) {
    const radius = 110
    const world = polarToWorld(angle, radius)
    const fair = clampToFairTerritory(world.x, world.z)
    const polar = worldToPolar(fair.x, fair.z)
    assert.ok(
      Math.abs(polar.angleDeg) <= FOUL_LINE_ANGLE_DEG + 1e-9,
      `${angle}deg should clamp inside the lines, got ${polar.angleDeg}`,
    )
    assert.equal(Math.sign(polar.angleDeg), Math.sign(angle), 'must stay on its own side')
    // Distance is not the thing in doubt, so it must survive untouched.
    assert.ok(Math.abs(polar.distanceUnits - radius) < 1e-9, 'distance must not change')
  }
})

test('a ball already in fair territory is left exactly alone', () => {
  // Clamping must be a no-op where it does not apply, or it would quietly
  // rewrite good measurements — including a foul pop-up caught for an out,
  // which genuinely belongs outside the lines and is never an estimate.
  for (const angle of [0, 44.9, -44.9, 20, -30]) {
    const world = polarToWorld(angle, 95)
    const fair = clampToFairTerritory(world.x, world.z)
    assert.equal(fair.x, world.x)
    assert.equal(fair.z, world.z)
  }
})

test('a ball clearing the wall is placed on the deck, not on the ground', () => {
  // Height beyond the wall depends on ANGLE, not on how far past it the ball
  // lands — against distance past the wall the relationship is nothing.
  const deepCentre = standsHeightUnits('mario_stadium', 5, 110)
  const deepCorner = standsHeightUnits('mario_stadium', 35, 100)
  assert.ok(deepCentre > 0, 'a ball into the centre stands must not sit at ground level')
  assert.ok(deepCorner > deepCentre, 'the corner deck measured higher than the centre one')
  assert.ok(Math.abs((deepCentre * FEET_PER_UNIT) - 11.5) < 0.1, 'centre deck is the measured 11.5 ft')
})

test('a ball that stays in the park gets no deck height', () => {
  // Inside the wall the ball lands on the field, and inventing a height there
  // would lift ordinary flies off the grass.
  const insideCentre = fenceRadiusAt('mario_stadium', 0) - 10
  assert.equal(standsHeightUnits('mario_stadium', 0, insideCentre), null)
  assert.equal(standsHeightUnits('mario_stadium', 0, 0), null)
})

test('a park with no measured deck profile reports none rather than guessing', () => {
  assert.equal(standsHeightUnits('peach_ice_garden', 0, 200), null)
  assert.equal(standsHeightUnits('mario_stadium', Number.NaN, 110), null)
})

test('the measured fence agrees with the right field foul pole', () => {
  // A ball off the RF foul pole, tracked at x=56.0140839 z=-57.0149269. A foul
  // pole is a fixed object at a KNOWN place — on the foul line, at the wall —
  // and nothing about it informed any measurement here. So it is an outside
  // check on the whole chain at once: the press measurements, the body-radius
  // correction derived from a different bounced ball, and home plate's position.
  const contact = { x: 56.0140839, z: -57.0149269 }
  const polar = worldToPolar(contact.x, contact.z)

  // A foul pole stands on the foul line.
  assert.ok(
    Math.abs(polar.angleDeg - FOUL_LINE_ANGLE_DEG) < 0.5,
    `pole should sit on the 45 degree line, measured ${polar.angleDeg.toFixed(2)}`,
  )

  // And at the wall. Our fence there was measured entirely independently; the
  // agreement was 0.22 ft, well inside the 0.8 ft press repeatability.
  const fence = fenceRadiusAt('mario_stadium', polar.angleDeg)
  const gapFeet = Math.abs(polar.distanceUnits - fence) * FEET_PER_UNIT
  assert.ok(gapFeet < 3, `fence and foul pole disagree by ${gapFeet.toFixed(2)} ft`)
})
