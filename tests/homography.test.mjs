import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyHomography,
  applyHomographyWithHeight,
  fitHomography,
  fitVerticalVanishing,
  invertHomography,
} from '../src/utils/homography.js'

// A synthetic camera: look at the ground plane from behind home plate, tilted
// down. Any real stadium screenshot is this same kind of projection, so
// recovering a KNOWN transform exactly is the real proof the fit works --
// clicking points on artwork can only ever be checked against itself.
function syntheticCamera(x, z) {
  const camHeight = 120
  const camZ = 60
  const focal = 900
  const dx = x
  const dy = camHeight
  const dz = camZ - z
  const u = 50 + ((focal * dx) / dz) / 20
  const v = 50 + ((focal * dy) / dz) / 20 - 60
  return { x: u, y: v }
}

const WORLD_POINTS = [
  { x: 0, z: 0 },
  { x: 19, z: -19 },
  { x: 0, z: -38 },
  { x: -19, z: -19 },
  { x: 0, z: -18 },
]

test('a known perspective projection is recovered exactly', () => {
  const correspondences = WORLD_POINTS.map((world) => ({
    world,
    image: syntheticCamera(world.x, world.z),
  }))
  const fit = fitHomography(correspondences)
  assert.ok(fit, 'fit should succeed')
  assert.ok(fit.rmsPercent < 1e-9, `rms was ${fit.rmsPercent}`)

  // Points that took no part in the fit must land correctly too, which is what
  // separates a real transform from one that merely memorised its inputs.
  for (const [x, z] of [[40, -80], [-55, -40], [10, -95], [0, -60]]) {
    const expected = syntheticCamera(x, z)
    const got = applyHomography(fit.matrix, x, z)
    assert.ok(Math.abs(got.x - expected.x) < 1e-6, `x off at ${x},${z}`)
    assert.ok(Math.abs(got.y - expected.y) < 1e-6, `y off at ${x},${z}`)
  }
})

test('four points are enough; more only reduce the error', () => {
  const four = WORLD_POINTS.slice(0, 4).map((world) => ({
    world, image: syntheticCamera(world.x, world.z),
  }))
  assert.ok(fitHomography(four).rmsPercent < 1e-9)
  assert.equal(fitHomography(four.slice(0, 3)), null, 'three points cannot determine it')
})

test('clicking error averages out rather than propagating', () => {
  // Same wobble applied to a bare-minimum fit and to a generous one.
  const wobble = [[0.4, -0.3], [-0.35, 0.45], [0.3, 0.4], [-0.4, -0.35], [0.2, 0.3],
    [-0.25, 0.2], [0.35, -0.4], [-0.3, -0.25]]
  const build = (points) => points.map((world, i) => {
    const clean = syntheticCamera(world.x, world.z)
    return { world, image: { x: clean.x + wobble[i][0], y: clean.y + wobble[i][1] } }
  })
  const extra = [...WORLD_POINTS, { x: 60, z: -60 }, { x: -60, z: -60 }, { x: 0, z: -95 }]
  const sparse = fitHomography(build(WORLD_POINTS.slice(0, 4)))
  const dense = fitHomography(build(extra))

  const truthError = (fit) => {
    let worst = 0
    for (const [x, z] of [[40, -80], [-55, -40], [10, -95]]) {
      const expected = syntheticCamera(x, z)
      const got = applyHomography(fit.matrix, x, z)
      worst = Math.max(worst, Math.hypot(got.x - expected.x, got.y - expected.y))
    }
    return worst
  }
  assert.ok(truthError(dense) < truthError(sparse), 'more points should track truth better')
})

test('the inverse recovers the world position a manual tap came from', () => {
  const fit = fitHomography(WORLD_POINTS.map((world) => ({
    world, image: syntheticCamera(world.x, world.z),
  })))
  for (const [x, z] of [[30, -70], [-45, -50], [0, -88]]) {
    const image = applyHomography(fit.matrix, x, z)
    const back = invertHomography(fit.matrix, image.x, image.y)
    assert.ok(Math.abs(back.x - x) < 1e-6, `x round-trip failed at ${x},${z}`)
    assert.ok(Math.abs(back.z - z) < 1e-6, `z round-trip failed at ${x},${z}`)
  }
})

test('degenerate point sets are refused instead of fitted', () => {
  // Three collinear points leave the transform underdetermined; returning some
  // arbitrary solution would misplace every marker with no warning.
  const collinear = [
    { world: { x: 0, z: 0 }, image: { x: 10, y: 10 } },
    { world: { x: 10, z: 0 }, image: { x: 20, y: 10 } },
    { world: { x: 20, z: 0 }, image: { x: 30, y: 10 } },
    { world: { x: 30, z: 0 }, image: { x: 40, y: 10 } },
  ]
  assert.equal(fitHomography(collinear), null)
  assert.equal(fitHomography([]), null)
  assert.equal(fitHomography(null), null)
})

test('non-finite input is refused rather than projected somewhere wrong', () => {
  const fit = fitHomography(WORLD_POINTS.map((world) => ({
    world, image: syntheticCamera(world.x, world.z),
  })))
  assert.equal(applyHomography(fit.matrix, Number.NaN, 0), null)
  assert.equal(applyHomography(null, 0, 0), null)
  assert.equal(applyHomography([1, 2, 3], 0, 0), null)
  assert.equal(invertHomography(fit.matrix, Number.NaN, 0), null)
})

// A camera that also sees height, so an elevated point can be checked against
// a known truth rather than against itself.
function camera3d(x, y, z) {
  const camHeight = 120
  const camZ = 60
  const focal = 900
  const dz = camZ - z
  return {
    x: 50 + ((focal * x) / dz) / 20,
    y: 50 + ((focal * (camHeight - y)) / dz) / 20 - 60,
  }
}

test('elevated points are placed correctly once the vertical is fitted', () => {
  const ground = WORLD_POINTS.map((world) => ({
    world, image: camera3d(world.x, 0, world.z),
  }))
  const fit = fitHomography(ground)
  assert.ok(fit.rmsPercent < 1e-9)

  // Two known-height points, as a wall's base-and-top pair would give.
  const vertical = fitVerticalVanishing(fit.matrix, [
    { world: { x: 0, z: -95, height: 4.65 }, image: camera3d(0, 4.65, -95) },
    { world: { x: -55, z: -55, height: 4.65 }, image: camera3d(-55, 4.65, -55) },
  ])
  assert.ok(vertical, 'vertical fit should succeed')
  assert.ok(vertical.rmsPercent < 1e-9, `rms was ${vertical.rmsPercent}`)

  // Heights and places that took no part in either fit — including the two
  // real home runs that exposed this: 9.12 units up in the stands and 4.65 off
  // the top of the wall.
  for (const [x, y, z] of [[40.8, 9.12, -103.2], [54.8, 4.65, -60.4], [-30, 20, -80], [10, 2, -70]]) {
    const expected = camera3d(x, y, z)
    const got = applyHomographyWithHeight(fit.matrix, vertical.vertical, x, z, y)
    assert.ok(Math.abs(got.x - expected.x) < 1e-6, `x off at ${x},${y},${z}`)
    assert.ok(Math.abs(got.y - expected.y) < 1e-6, `y off at ${x},${y},${z}`)
  }
})

test('an elevated ball is drawn deeper than the ground point beneath it', () => {
  // The actual symptom: markers for balls in the stands read short. Guard the
  // direction of the correction, not just its existence.
  const fit = fitHomography(WORLD_POINTS.map((world) => ({
    world, image: camera3d(world.x, 0, world.z),
  })))
  const vertical = fitVerticalVanishing(fit.matrix, [
    { world: { x: 0, z: -95, height: 4.65 }, image: camera3d(0, 4.65, -95) },
    { world: { x: -55, z: -55, height: 4.65 }, image: camera3d(-55, 4.65, -55) },
  ])
  const groundPoint = applyHomography(fit.matrix, 40.8, -103.2)
  const elevated = applyHomographyWithHeight(fit.matrix, vertical.vertical, 40.8, -103.2, 9.12)
  assert.ok(elevated.y < groundPoint.y, 'elevated should sit higher up the image')
})

test('height calibration is optional — ground hits still map without it', () => {
  const fit = fitHomography(WORLD_POINTS.map((world) => ({
    world, image: camera3d(world.x, 0, world.z),
  })))
  const ground = applyHomography(fit.matrix, 30, -70)
  for (const noVertical of [null, undefined, []]) {
    const got = applyHomographyWithHeight(fit.matrix, noVertical, 30, -70, 5)
    assert.deepEqual(got, ground, 'must fall back to the ground mapping')
  }
  // Height 0 is the ground mapping regardless of what was fitted.
  const vertical = fitVerticalVanishing(fit.matrix, [
    { world: { x: 0, z: -95, height: 4.65 }, image: camera3d(0, 4.65, -95) },
    { world: { x: -55, z: -55, height: 4.65 }, image: camera3d(-55, 4.65, -55) },
  ])
  assert.deepEqual(applyHomographyWithHeight(fit.matrix, vertical.vertical, 30, -70, 0), ground)
})

test('one known-height point is not enough and is refused', () => {
  const fit = fitHomography(WORLD_POINTS.map((world) => ({
    world, image: camera3d(world.x, 0, world.z),
  })))
  assert.equal(fitVerticalVanishing(fit.matrix, [
    { world: { x: 0, z: -95, height: 4.65 }, image: camera3d(0, 4.65, -95) },
  ]), null)
  assert.equal(fitVerticalVanishing(null, []), null)
})

test('clustered calibration points do not corrupt the height model', () => {
  // The real failure: wall pairs all clicked along the back wall sit at nearly
  // one depth, which leaves the vanishing term unobserved. Unconstrained it
  // absorbs their click noise and stops behaving like perspective — walls
  // coming out taller far away than near, which is geometrically impossible.
  const fit = fitHomography(WORLD_POINTS.map((world) => ({
    world, image: camera3d(world.x, 0, world.z),
  })))
  const H = 4.645
  const noise = [[0.15, -0.12], [-0.13, 0.14], [0.11, 0.13], [-0.14, -0.11]]
  const clustered = [
    { x: -20, z: -96 }, { x: 0, z: -99 }, { x: 20, z: -97 }, { x: 35, z: -93 },
  ].map((spot, i) => {
    const clean = camera3d(spot.x, H, spot.z)
    return {
      world: { x: spot.x, z: spot.z, height: H },
      image: { x: clean.x + noise[i][0], y: clean.y + noise[i][1] },
    }
  })

  const constrained = fitVerticalVanishing(fit.matrix, clustered)
  const free = fitVerticalVanishing(fit.matrix, clustered, { allowVanishing: true })

  // Truth check at a depth the calibration never covered — near a foul pole,
  // which is exactly where the bad fit showed itself.
  const worstError = (v) => {
    let worst = 0
    for (const [x, y, z] of [[-55, H, -55], [55, H, -55], [40.8, 9.12, -103.2]]) {
      const expected = camera3d(x, y, z)
      const got = applyHomographyWithHeight(fit.matrix, v, x, z, y)
      worst = Math.max(worst, Math.hypot(got.x - expected.x, got.y - expected.y))
    }
    return worst
  }
  assert.ok(
    worstError(constrained.vertical) < worstError(free.vertical),
    'constrained fit should generalise better from clustered points',
  )
  assert.equal(constrained.vertical[2], 0, 'vanishing term is dropped by default')

  // A wall must never appear taller further away — the check that caught this.
  const height = (x, z) => {
    const base = applyHomographyWithHeight(fit.matrix, constrained.vertical, x, z, 0)
    const top = applyHomographyWithHeight(fit.matrix, constrained.vertical, x, z, H)
    return base.y - top.y
  }
  assert.ok(height(-55, -55) > height(0, -99), 'near wall must look taller than far wall')
})
