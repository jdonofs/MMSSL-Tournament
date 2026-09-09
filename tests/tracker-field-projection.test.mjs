import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TRACKER_STADIUM_FIELD_GEOMETRY,
  estimateTrackerHitDistanceFeet,
  estimateTrackerWallDistance,
  projectTrackerFieldSpot,
} from '../scripts/tracker_field_projection.mjs'
import { fenceDistanceFeet } from '../src/utils/parkGeometry.js'

test('every stadium reference round-trips between image and distance', () => {
  for (const [stadiumKey, config] of Object.entries(TRACKER_STADIUM_FIELD_GEOMETRY)) {
    for (const ref of config.wallRefs) {
      assert.equal(
        estimateTrackerHitDistanceFeet({ x: ref.x, y: ref.y }, stadiumKey),
        Math.round(ref.dist),
        `${stadiumKey} ${ref.dist}`,
      )
      const dx = ref.x - config.homePlate.x
      const dy = ref.y - config.homePlate.y
      const angle = (Math.atan2(dx, -dy) * 180) / Math.PI
      const projected = projectTrackerFieldSpot(ref.dist, angle, stadiumKey)
      assert.ok(Math.abs(projected.x - ref.x) <= 0.1, `${stadiumKey} x`)
      assert.ok(Math.abs(projected.y - ref.y) <= 0.1, `${stadiumKey} y`)
      assert.ok(Math.abs(estimateTrackerWallDistance(angle, stadiumKey) - ref.dist) < 1e-9)
    }
  }
})

test('measured park wall references use the same metre-scale fence distances', () => {
  for (const stadiumKey of [
    'mario_stadium', 'luigis_mansion', 'daisy_cruiser',
    'peach_ice_garden', 'bowser_castle',
  ]) {
    const refs = TRACKER_STADIUM_FIELD_GEOMETRY[stadiumKey].wallRefs
    for (const [index, angle] of [-45, 0, 45].entries()) {
      const measured = fenceDistanceFeet(stadiumKey, angle)
      assert.ok(
        Math.abs(refs[index].dist - measured) < 0.15,
        `${stadiumKey} ${angle}: ${refs[index].dist} vs ${measured}`,
      )
    }
  }
})

test('unknown or partial geometry is refused', () => {
  assert.equal(projectTrackerFieldSpot(300, 0, 'missing'), null)
  assert.equal(estimateTrackerHitDistanceFeet({ x: 50 }, 'mario_stadium'), null)
  assert.equal(estimateTrackerWallDistance(Number.NaN, 'mario_stadium'), null)
})
