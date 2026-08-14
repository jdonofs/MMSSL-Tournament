import assert from 'node:assert/strict'
import test from 'node:test'
import {
  estimateTrackerBattedBallDistanceFeet,
  projectTrackerBattedBallDistanceFeet,
} from '../scripts/tracker_field_projection.mjs'

// Real tracked landings, sampled evenly across the distance range rather than
// from either end — a sample of only the deepest balls measures the tail of the
// scatter and reads as bias that is not there.
const TRACKED = [
  [111.7, -0.7, 79], [107.2, 17.9, 337], [108.6, 35.5, 370],
]

test('the fitted model tracks real measured distances', () => {
  const errors = TRACKED.map(([v, a, real]) => estimateTrackerBattedBallDistanceFeet(v, a) - real)
  const rms = Math.sqrt(errors.reduce((s, e) => s + (e * e), 0) / errors.length)
  // Cross-validated error over all 98 training records was 25.1 ft, against
  // 256 ft for the no-drag physics model this replaced. The ceiling guards the
  // gap rather than the exact figure.
  assert.ok(rms < 60, `RMS was ${rms.toFixed(1)} ft`)
})

test('distance peaks at a launch angle a real batted ball would', () => {
  // A polynomial can fit the data and still be shaped like nothing physical.
  // Peak carry belongs in the high twenties to low forties, not at a line drive
  // and not at a pop-up.
  let best = { angle: null, distance: -Infinity }
  for (let angle = -5; angle <= 65; angle += 1) {
    const distance = estimateTrackerBattedBallDistanceFeet(105, angle)
    if (distance != null && distance > best.distance) best = { angle, distance }
  }
  assert.ok(best.angle >= 25 && best.angle <= 45, `peak was at ${best.angle} degrees`)
})

test('distance rises with exit velocity', () => {
  let previous = 0
  for (const v of [80, 90, 100, 110, 120]) {
    const distance = estimateTrackerBattedBallDistanceFeet(v, 30)
    assert.ok(distance > previous, `harder contact must carry further, ${v} mph gave ${distance}`)
    previous = distance
  }
})

test('it no longer doubles the distance the way real-gravity physics did', () => {
  // The no-drag model put a 110 mph / 30 degree ball at 706 ft. The deepest
  // ball ever tracked here is 396, and the fence is ~330 to centre.
  const deep = estimateTrackerBattedBallDistanceFeet(110, 30)
  assert.ok(deep > 330, `a 110 mph bomb should clear the fence, got ${deep.toFixed(0)}`)
  assert.ok(deep < 500, `but not by 300 feet, got ${deep.toFixed(0)}`)
})

test('a nonsensical result is refused rather than plotted behind home plate', () => {
  // The fit is a polynomial, not a law; weak contact at a steep angle drives it
  // negative, and a negative distance would plot on the wrong side of the plate.
  for (let v = 70; v <= 125; v += 5) {
    for (let a = -10; a <= 60; a += 5) {
      const distance = estimateTrackerBattedBallDistanceFeet(v, a)
      assert.ok(distance == null || distance > 0, `${v} mph @ ${a}deg gave ${distance}`)
    }
  }
  assert.equal(estimateTrackerBattedBallDistanceFeet(0, 30), null)
  assert.equal(estimateTrackerBattedBallDistanceFeet(Number.NaN, 30), null)
  assert.equal(estimateTrackerBattedBallDistanceFeet(100, Number.NaN), null)
})

test('projected figures are flagged as modelled, and hang time separately so', () => {
  // Distance is calibrated; hang time is still the uncalibrated projectile
  // value. Both must be distinguishable from a tracked measurement, and from
  // each other — they are not equally trustworthy.
  const projected = projectTrackerBattedBallDistanceFeet(105, 30)
  assert.equal(projected.distanceIsModelled, true)
  assert.equal(projected.hangTimeIsModelled, true)
  assert.equal(
    projected.distanceFeet,
    estimateTrackerBattedBallDistanceFeet(105, 30),
    'projection must use the calibrated distance',
  )
})
