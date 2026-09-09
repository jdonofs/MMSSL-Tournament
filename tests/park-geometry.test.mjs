import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASE_PATH_UNITS,
  BODY_RADIUS_UNITS,
  FEET_PER_UNIT,
  METERS_PER_UNIT,
  HOME_PLATE,
  PARK_FENCES,
  RUBBER_DISTANCE_UNITS,
  WALL_HEIGHT_UNITS,
  FOUL_LINE_ANGLE_DEG,
  clampToFairTerritory,
  fenceDistanceFeet,
  fenceRadiusAt,
  hasHeightCalibration,
  hasImageCalibration,
  hasMeasuredGeometry,
  infieldCorners,
  parkMaxRadius,
  polarToWorld,
  standsHeightUnits,
  worldToImagePercent,
  worldToImagePercentAtHeight,
  worldLandingToImagePercentAtHeight,
  worldToPolar,
} from '../src/utils/parkGeometry.js'

test('world coordinates use exactly one metre per unit', () => {
  assert.equal(BASE_PATH_UNITS, 26.84)
  assert.equal(METERS_PER_UNIT, 1)
  assert.ok(Math.abs(FEET_PER_UNIT - 3.280839895013123) < 1e-12)
  // The held-out rubber clusters around an intended 18m, independently of the
  // fitted 27m base path. It must remain the measured coordinate, not a 60'6"
  // regulation distance converted back into units.
  assert.ok(Math.abs(RUBBER_DISTANCE_UNITS - 17.979) < 1e-6)
  assert.ok(Math.abs((RUBBER_DISTANCE_UNITS * FEET_PER_UNIT) - 58.986) < 0.01)
})

test('measured fence distances match what the presses recorded', () => {
  // Straightaway centre and both foul poles from raw world coordinates.
  const centre = fenceDistanceFeet('mario_stadium', 0)
  const leftPole = fenceDistanceFeet('mario_stadium', -45)
  const rightPole = fenceDistanceFeet('mario_stadium', 45)
  assert.ok(centre > 316 && centre < 319, `centre was ${centre}`)
  assert.ok(leftPole > 256 && leftPole < 260, `LF pole was ${leftPole}`)
  assert.ok(rightPole > 257 && rightPole < 261, `RF pole was ${rightPole}`)
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

test('the infield is the measured metric diamond', () => {
  const { home, first, second, third, rubber } = infieldCorners()
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  for (const [p, q] of [[home, first], [first, second], [second, third], [third, home]]) {
    assert.ok(Math.abs(dist(p, q) - BASE_PATH_UNITS) < 1e-6)
  }
  // Diagonals of a square: side * sqrt(2).
  assert.ok(Math.abs(dist(home, second) - (BASE_PATH_UNITS * Math.SQRT2)) < 1e-6)
  assert.ok(Math.abs(dist(first, third) - (BASE_PATH_UNITS * Math.SQRT2)) < 1e-6)
  assert.ok(Math.abs(dist(home, rubber) - 17.979) < 1e-6)
})

test('a park with no measurements yet is reported as unmeasured, not guessed at', () => {
  assert.equal(hasMeasuredGeometry('mario_stadium'), true)
  // No real park stands in for "not yet pressed" any more: yoshi_park was the
  // last one, measured on 2026-08-20, and wario_city on 2026-08-19 before it.
  // An unknown key carries the same contract -- report nothing rather than
  // interpolate a fence out of thin air -- so it is what the test asserts on.
  assert.equal(hasMeasuredGeometry('not_a_park'), false)
  assert.equal(fenceRadiusAt('not_a_park', 0), null)
  assert.equal(fenceDistanceFeet('not_a_park', 0), null)
  assert.equal(parkMaxRadius('not_a_park'), null)
})

test('every park the tracker can be played in now has a measured fence', () => {
  // Nine parks, all pressed. If a tenth is ever added this should fail until it
  // is measured, rather than the app quietly guessing at its wall.
  for (const park of [
    'mario_stadium', 'luigis_mansion', 'daisy_cruiser', 'peach_ice_garden',
    'bowser_castle', 'bowser_jr_playroom', 'dk_jungle', 'wario_city',
    'yoshi_park',
  ]) {
    assert.equal(hasMeasuredGeometry(park), true, park)
    assert.ok(fenceDistanceFeet(park, 0) > 200, park)
  }
})

test('Peach Ice Garden measures as the deep park it is', () => {
  // The source samples are origin-relative, but the exported curve is correctly
  // converted to distance and angle from home plate.
  const centre = fenceDistanceFeet('peach_ice_garden', 0)
  const leftPole = fenceDistanceFeet('peach_ice_garden', -45)
  const rightPole = fenceDistanceFeet('peach_ice_garden', 45)
  assert.ok(centre > 388 && centre < 391, `centre was ${centre}`)
  assert.ok(leftPole > 305 && leftPole < 308, `LF pole was ${leftPole}`)
  assert.ok(rightPole > 306 && rightPole < 309, `RF pole was ${rightPole}`)
  assert.ok(Math.abs(leftPole - rightPole) < 3)
  // Deepest park in the game, by a margin no measurement error could close.
  assert.ok(parkMaxRadius('peach_ice_garden') > parkMaxRadius('luigis_mansion'))
})

test('Peach Ice Garden keeps its polygon corners sharp', () => {
  // The stored points are generated from a fitted regular 24-gon, and every
  // vertex is an entry precisely so linear interpolation cannot round one off.
  // A vertex shows up as a change in slope; between vertices the slope holds.
  // Guard the property that matters: sampling the array back at 0.25-degree
  // steps must stay close to the stored points it interpolates between, which
  // fails loudly if someone thins the array to "tidy" it.
  const fence = PARK_FENCES.peach_ice_garden
  for (const [angle, radius] of fence) {
    const sampled = fenceRadiusAt('peach_ice_garden', angle)
    assert.ok(Math.abs(sampled - radius) < 1e-9)
  }
  // Angles must be sorted and reach both foul lines.
  for (let i = 1; i < fence.length; i += 1) {
    assert.ok(fence[i][0] > fence[i - 1][0], `angle ${i} out of order`)
  }
  assert.ok(fence[0][0] < -44 && fence[fence.length - 1][0] > 44)
})

test('Bowser Castle uses its measured symmetric polygon', () => {
  const left = fenceDistanceFeet('bowser_castle', -45)
  const centre = fenceDistanceFeet('bowser_castle', 0)
  const right = fenceDistanceFeet('bowser_castle', 45)
  assert.ok(left > 268 && left < 272, `LF was ${left}`)
  assert.ok(centre > 321 && centre < 324, `CF was ${centre}`)
  assert.ok(right > 269 && right < 272, `RF was ${right}`)
  assert.ok(Math.abs(left - right) < 1)
  assert.equal(hasImageCalibration('bowser_castle'), true)
  assert.equal(hasHeightCalibration('bowser_castle'), true)
  assert.equal(hasHeightCalibration('daisy_cruiser'), false)
})

test('Bowser Castle vertical calibration uses its measured ordinary-wall height', () => {
  // Three tracked top contacts put the ordinary surface at 8.737477u on
  // average. The vertical was fitted from that game-space measurement, not
  // Mario Stadium's much shorter wall assumption.
  const height = 8.7374773
  const refs = [
    [-45, { x: 13.8, y: 44.7 }],
    [0, { x: 49.2, y: 24.2 }],
    [45, { x: 84.4, y: 43.8 }],
  ]
  for (const [angle, expected] of refs) {
    const radius = fenceRadiusAt('bowser_castle', angle)
    const world = polarToWorld(angle, radius)
    const point = worldToImagePercentAtHeight(
      'bowser_castle', world.x, world.z, height,
    )
    assert.ok(
      Math.hypot(point.x - expected.x, point.y - expected.y) < 1.2,
      `${angle}deg wall top was ${JSON.stringify(point)}`,
    )
  }
})

test('a shallow Bowser Castle lava landing clears the wall only on the artwork', () => {
  // Boomerang Bro.'s measured 2026-08-18 landing: 10.29u behind the fence at
  // +19.43deg. Its flat-plane projection is physically behind the wall but is
  // painted on top of the wall silhouette in this overhead image.
  const landing = { x: 35.9727173, z: -102.855698 }
  const polar = worldToPolar(landing.x, landing.z)
  const fence = fenceRadiusAt('bowser_castle', polar.angleDeg)
  assert.ok(polar.distanceUnits > fence)
  assert.ok(polar.distanceUnits < fence + 20)

  const raw = worldToImagePercentAtHeight('bowser_castle', landing.x, landing.z, 0.25)
  const visible = worldLandingToImagePercentAtHeight(
    'bowser_castle', landing.x, landing.z, 0.25,
  )
  assert.ok(raw.y > 25 && raw.y < 26, `raw y was ${raw.y}`)
  assert.ok(visible.y > 21 && visible.y < 23, `visible y was ${visible.y}`)
  assert.ok(visible.y < raw.y, 'the display marker must clear the wall toward the lava')

  // Deep landings are already visible, and other parks have no invented rule.
  const deep = polarToWorld(polar.angleDeg, fence + 25)
  assert.deepEqual(
    worldLandingToImagePercentAtHeight('bowser_castle', deep.x, deep.z, 0.25),
    worldToImagePercentAtHeight('bowser_castle', deep.x, deep.z, 0.25),
  )
  assert.deepEqual(
    worldLandingToImagePercentAtHeight('mario_stadium', landing.x, landing.z, 0.25),
    worldToImagePercentAtHeight('mario_stadium', landing.x, landing.z, 0.25),
  )
})

test('a shallow Playroom ground landing can clear the wall artwork', () => {
  // The low-level visibility projection remains available for a true ground
  // landing. Callers deliberately do not use it for measured raised impacts,
  // because a Thwomp and the rear deck can share the same world height.
  const landing = { x: 69.7323532, y: 0.25, z: -76.3782883 }
  const polar = worldToPolar(landing.x, landing.z)
  const fence = fenceRadiusAt('bowser_jr_playroom', polar.angleDeg)
  assert.ok(polar.distanceUnits > fence)
  assert.ok(polar.distanceUnits < fence + 28)

  const raw = worldToImagePercentAtHeight(
    'bowser_jr_playroom', landing.x, landing.z, landing.y,
  )
  const visible = worldLandingToImagePercentAtHeight(
    'bowser_jr_playroom', landing.x, landing.z, landing.y,
  )
  assert.deepEqual(
    { x: Number(visible.x.toFixed(1)), y: Number(visible.y.toFixed(1)) },
    { x: 88.2, y: 29.6 },
  )
  assert.ok(visible.y < raw.y, 'the display marker must clear the wall toward the visible deck')
})

test('Playroom local calibration reproduces replay-marked object impacts', () => {
  // Petey's and Bowser Jr.'s raised objects are direct measured impacts.
  // K. Rool's ground landing uses the display-only clearance.
  const direct = worldToImagePercentAtHeight(
    'bowser_jr_playroom', -9.70315742, -103.197731, 12.9713068,
  )
  assert.deepEqual(
    { x: Number(direct.x.toFixed(1)), y: Number(direct.y.toFixed(1)) },
    { x: 44.4, y: 9.9 },
  )

  const wallTop = worldToImagePercentAtHeight(
    'bowser_jr_playroom', -16.2222824, -97.5733032, 12.5062609,
  )
  assert.deepEqual(
    { x: Number(wallTop.x.toFixed(1)), y: Number(wallTop.y.toFixed(1)) },
    { x: 40.4, y: 20.8 },
  )

  // A point only 0.1u away can belong to a different overlapping surface.
  // Do not smear the marked wall-top correction onto an unmarked contact.
  const adjacentSurface = worldToImagePercentAtHeight(
    'bowser_jr_playroom', -16.1222824, -97.5733032, 12.5062609,
  )
  assert.deepEqual(
    { x: Number(adjacentSurface.x.toFixed(1)), y: Number(adjacentSurface.y.toFixed(1)) },
    { x: 41.7, y: 20.5 },
  )

  const raised = worldToImagePercentAtHeight(
    'bowser_jr_playroom', 53.4743958, -83.1447296, 6.34289837,
  )
  assert.deepEqual(
    { x: Number(raised.x.toFixed(1)), y: Number(raised.y.toFixed(1)) },
    { x: 80.3, y: 28.6 },
  )

  const ground = worldLandingToImagePercentAtHeight(
    'bowser_jr_playroom', 69.7323532, -76.3782883, 0.25,
  )
  assert.deepEqual(
    { x: Number(ground.x.toFixed(1)), y: Number(ground.y.toFixed(1)) },
    { x: 88.2, y: 29.6 },
  )

  for (const [x, y, z, expected] of [
    [-56.0879364, 6.38419437, -72.3675079, { x: 18, y: 36 }],
    [-52.680088, 6.42286682, -83.7811661, { x: 21.4, y: 28.8 }],
  ]) {
    const thwomp = worldToImagePercentAtHeight('bowser_jr_playroom', x, z, y)
    assert.deepEqual(
      { x: Number(thwomp.x.toFixed(1)), y: Number(thwomp.y.toFixed(1)) },
      expected,
    )
  }

  for (const [x, y, z, expected] of [
    [-41.6679306, 23.9301376, -88.3078384, { x: 23.4, y: 15.3 }],
    [-39.6038399, 25.8843918, -91.9564209, { x: 25.4, y: 13.1 }],
    [-42.3134537, 25.9399357, -89.7069168, { x: 24.3, y: 15.7 }],
  ]) {
    const chest = worldToImagePercentAtHeight('bowser_jr_playroom', x, z, y)
    assert.deepEqual(
      { x: Number(chest.x.toFixed(1)), y: Number(chest.y.toFixed(1)) },
      expected,
    )
  }

  for (const [x, y, z, expected] of [
    [-42.7874718, 0.25, -111.736595, { x: 29.1, y: 13.5 }],
    [31.3421078, 0.25, -122.650551, { x: 69.3, y: 9.5 }],
  ]) {
    const behindChest = worldLandingToImagePercentAtHeight(
      'bowser_jr_playroom', x, z, y,
    )
    assert.deepEqual(
      { x: Number(behindChest.x.toFixed(1)), y: Number(behindChest.y.toFixed(1)) },
      expected,
    )
  }
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
  // No real park is uncalibrated any more -- yoshi_park was the last stand-in
  // and got its homography on 2026-08-20, wario_city on 2026-08-19 before it.
  // An unknown key holds the same contract: report nothing, never a guess.
  assert.equal(hasImageCalibration('not_a_park'), false)
  assert.equal(worldToImagePercent('not_a_park', 0, -80), null)
  assert.equal(worldToImagePercent('mario_stadium', Number.NaN, 0), null)
})

test('a park with a ground mapping but no vertical still draws ground-level hits', () => {
  // Peach Ice Garden has a homography and deliberately no PARK_IMAGE_VERTICAL.
  // That combination must degrade to the ground mapping rather than to null,
  // because it is the normal state of a freshly calibrated park -- and at this
  // park nearly every ball comes down at field level anyway.
  assert.equal(hasImageCalibration('peach_ice_garden'), true)
  assert.equal(hasHeightCalibration('peach_ice_garden'), false)
  const ground = worldToImagePercent('peach_ice_garden', 0, -119.5)
  assert.ok(ground && ground.x > 45 && ground.x < 55)
  const elevated = worldToImagePercentAtHeight('peach_ice_garden', 0, -119.5, 6)
  assert.deepEqual(elevated, ground)
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
  assert.ok(Math.abs((deepCentre * FEET_PER_UNIT) - 11.252) < 0.1, 'raw deck height survives the scale change')
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

// Every stadium image is served with a hardcoded aspectRatio, and every other
// number for that park -- homePlate, wallRefs, the nine fielder markers -- is a
// PERCENTAGE OF THAT IMAGE. Replace the artwork without redoing them and each
// one silently points at the wrong spot. Yoshi Park shipped that way: its
// aspectRatio read 1280/823 while the committed image was 952x789, matching
// neither it nor the 1486x899 replacement.
test('each park aspectRatio matches the real dimensions of its stadium image', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/components/FieldPlayBuilder.jsx', import.meta.url), 'utf8')
  const entries = [...source.matchAll(/image: ['"]([^'"]+\.png)['"],\s*\n\s*aspectRatio: '(\d+)\/(\d+)'/g)]
  assert.ok(entries.length >= 9, `expected every park to declare an aspectRatio, found ${entries.length}`)

  for (const [, imagePath, width, height] of entries) {
    const png = await readFile(new URL(`../public${imagePath}`, import.meta.url))
    // PNG IHDR: 8-byte signature, 4 length, 4 type, then width and height as
    // big-endian uint32. Cheaper and more certain than pulling in a decoder.
    assert.equal(png.toString('ascii', 12, 16), 'IHDR', `${imagePath} is not a PNG`)
    assert.equal(png.readUInt32BE(16), Number(width), `${imagePath} width`)
    assert.equal(png.readUInt32BE(20), Number(height), `${imagePath} height`)
  }
})
