import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BASERUN_SPEED_CURVE,
  FIELD_SPEED_CURVE,
  GAME_FRAME_RATE,
  ORDINARY_STAT_MAX,
  SPEED_CURVE_VALIDATION,
  getBaserunSpeed,
  getFieldSpeed,
  getMovementMechanics,
  isBoostedFieldSpeed,
} from '../src/data/gameSpeedCurves.js'

test('speed curves preserve every workbook row', () => {
  assert.equal(BASERUN_SPEED_CURVE.length, 43)
  assert.equal(FIELD_SPEED_CURVE.length, 43)
  assert.equal(BASERUN_SPEED_CURVE[7].stat, 70)
  assert.equal(BASERUN_SPEED_CURVE[7].speedPerFrame, 0.138)
  assert.equal(FIELD_SPEED_CURVE[7].stat, 70)
  assert.equal(FIELD_SPEED_CURVE[7].speedPerFrame, 0.135)
})

test('a game second is 59.94 ticks, the rate the deriver uses', () => {
  // scripts/derive_player_metrics.py GAME_FRAME_RATE. At 60 every value comes
  // out 0.1% high and stops matching the captured constants below.
  assert.equal(GAME_FRAME_RATE, 59.94)
  assert.equal(FIELD_SPEED_CURVE[7].speedPerSecond, Number((0.135 * 59.94).toFixed(6)))
})

// The whole point of the module: these are the values the fielder actor's
// +0x0F0 constant actually holds, read off 58 archived sessions. Exact table
// rows and interpolated ratings both, because interpolation is the assumption
// under test.
test('the fielding curve reproduces the captured max-speed constants', () => {
  const captured = [
    [10, 7.253], [20, 7.313], [30, 7.672], [40, 7.732], [50, 7.792],
    [60, 8.032], [70, 8.092], [80, 8.152], [90, 8.452],
    // Ratings between published rows -- the interpolation check.
    [14, 7.277], [25, 7.493], [29, 7.636], [35, 7.702], [44, 7.756],
    [45, 7.762], [52, 7.84], [55, 7.912], [57, 7.96], [65, 8.062],
    [72, 8.104], [75, 8.122], [85, 8.302],
  ]
  for (const [runSpeed, measured] of captured) {
    assert.ok(
      Math.abs(getFieldSpeed(runSpeed).speedPerSecond - measured) <= 0.001,
      `run_speed ${runSpeed}: curve ${getFieldSpeed(runSpeed).speedPerSecond} vs captured ${measured}`,
    )
  }
})

// The boost multiplies the STAT and re-reads the curve. Multiplying the SPEED
// by 1.5 would predict 12.1 u/s where the game holds 8.63.
test('the boost is floor(stat * 1.5) on the same curve, not a speed multiplier', () => {
  const boosted = [[10, 7.283], [20, 7.672], [25, 7.714], [35, 7.84], [40, 8.032], [50, 8.122], [70, 8.631], [75, 8.727]]
  for (const [runSpeed, measured] of boosted) {
    assert.ok(
      Math.abs(getFieldSpeed(runSpeed, { boosted: true }).speedPerSecond - measured) <= 0.001,
      `run_speed ${runSpeed} boosted: ${getFieldSpeed(runSpeed, { boosted: true }).speedPerSecond} vs ${measured}`,
    )
    assert.equal(isBoostedFieldSpeed(runSpeed, measured), true)
  }
  assert.equal(isBoostedFieldSpeed(70, 8.092), false)
  assert.equal(isBoostedFieldSpeed(70, null), false)
})

test('ratings above 100 are marked as outside the ordinary domain', () => {
  assert.equal(ORDINARY_STAT_MAX, 100)
  assert.equal(getFieldSpeed(90).beyondOrdinaryRatings, false)
  assert.equal(getFieldSpeed(90, { boosted: true }).beyondOrdinaryRatings, true)
})

test('non-decimal character ratings interpolate between workbook entries', () => {
  const field = getFieldSpeed(25)
  assert.equal(field.exactTableEntry, false)
  assert.equal(field.lowerStat, 20)
  assert.equal(field.upperStat, 30)
  assert.ok(Math.abs(field.speedPerFrame - 0.125) < 1e-12)

  const baserun = getBaserunSpeed(65)
  assert.ok(Math.abs(baserun.speedPerFrame - 0.1365) < 1e-12)
})

// Fielding and baserunning are different tables for different activities and
// carry different evidence. The UI leans on this to decide what it may call an
// expectation, so it is asserted rather than left to a comment.
test('the baserunning curve is published but explicitly unvalidated', () => {
  assert.equal(SPEED_CURVE_VALIDATION.fielding.validated, true)
  assert.equal(SPEED_CURVE_VALIDATION.baserunning.validated, false)
  assert.ok(SPEED_CURVE_VALIDATION.baserunning.reason.length > 0)
  assert.notEqual(getBaserunSpeed(70).speedPerFrame, getFieldSpeed(70).speedPerFrame)
})

test('movement mechanics expose both gameplay contexts and clamp safely', () => {
  const mechanics = getMovementMechanics(70)
  assert.equal(mechanics.speedStat, 70)
  assert.equal(mechanics.baserunning.speedPerFrame, 0.138)
  assert.equal(mechanics.fielding.speedPerFrame, 0.135)
  assert.equal(mechanics.validation.baserunning.validated, false)
  assert.equal(getFieldSpeed(-5).stat, 0)
  assert.equal(getBaserunSpeed(999).stat, 420)
  assert.equal(getMovementMechanics(undefined), null)
})
