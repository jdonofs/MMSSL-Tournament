// The traits that pair a character's published mechanics against what the
// tracker measured: the fielding top-speed constant, and catch reach by
// approach.
//
// What these tests are guarding is mostly NEGATIVE -- which comparisons the
// report is not allowed to make, which contaminated rows are not allowed into a
// baseline, and which absences are not allowed to look like each other. Those
// are the failures that look fine on screen.

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

import {
  FEET_PER_SECOND_TO_MPH,
  catchApproachIsOrdinaryMechanics,
  summarizeCatchReach,
  summarizeMovementMetrics,
} from '../src/utils/advancedDefense.js'
import { getFieldSpeed } from '../src/data/gameSpeedCurves.js'

// measuredAttributes reaches characterAnalysis, which imports JSON and uses
// extensionless specifiers, so it is loaded through Vite exactly as
// tests/stats-reconciliation.test.mjs loads statsCalculator.
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const {
  MIN_CATCH_REACH_SECURED,
  buildMeasuredIndex,
  buildMinedIndex,
  buildRawValueRows,
  describeSpeedClassification,
} = await vite.ssrLoadModule('/src/utils/measuredAttributes.js')
after(() => vite.close())

const METRES_TO_FEET = 3.280839895
const fpsFor = (runSpeed, boosted = false) => Number(
  (getFieldSpeed(runSpeed, { boosted }).speedPerSecond * METRES_TO_FEET).toFixed(3),
)

// Wario: run_speed 40.
const WARIO_RUN_SPEED = 40
const WARIO_ORDINARY_FPS = fpsFor(WARIO_RUN_SPEED)
const WARIO_BOOSTED_FPS = fpsFor(WARIO_RUN_SPEED, true)
const ratings = new Map([['7', WARIO_RUN_SPEED]])

const fielderRow = (overrides = {}) => ({
  actor_type: 'fielder',
  character_id: 7,
  max_speed_fps: WARIO_ORDINARY_FPS,
  quality: {},
  ...overrides,
})

const approachRow = (overrides = {}) => ({
  fielder_character_id: 7,
  approach: 'ordinary',
  outcome: 'secured',
  separation_3d_units: 2.5,
  relative_height_units: 0.3,
  mechanics: ['ordinary'],
  quality: {},
  ...overrides,
})

// ─── The max-speed constant ──────────────────────────────────────────────────

test('the ordinary constant is the one matching this character\'s curve row', () => {
  const rows = [
    ...Array.from({ length: 16 }, () => fielderRow()),
    ...Array.from({ length: 4 }, () => fielderRow({ max_speed_fps: WARIO_BOOSTED_FPS })),
  ]
  const summary = summarizeMovementMetrics(rows, 'character', { speedStatByCharacterId: ratings })['7']
  assert.equal(summary.maxSpeedFps, WARIO_ORDINARY_FPS)
  assert.equal(summary.maxSpeedSamples, 16)
  assert.equal(summary.maxSpeedBoostedSamples, 4)
  assert.equal(summary.maxSpeedBoostedFps, WARIO_BOOSTED_FPS)
  assert.equal(summary.maxSpeedClassified, true)
  assert.equal(summary.maxSpeedUnclassifiedSamples, 0)
})

// THE REGRESSION THIS EXISTS FOR. Taking the modal value as "ordinary" reports
// the boosted constant as the character's top speed whenever boosted rows
// outnumber ordinary ones -- and reports ZERO boosted samples with it, because
// nothing sits above the mode.
test('a character seen only in the boosted state reports no ordinary constant', () => {
  const rows = Array.from({ length: 14 }, () => fielderRow({ max_speed_fps: WARIO_BOOSTED_FPS }))
  const summary = summarizeMovementMetrics(rows, 'character', { speedStatByCharacterId: ratings })['7']
  assert.equal(summary.maxSpeedFps, null, 'must not publish a boosted constant as ordinary')
  assert.equal(summary.maxSpeedSamples, 0)
  assert.equal(summary.maxSpeedBoostedSamples, 14)
  assert.equal(summary.maxSpeedBoostedFps, WARIO_BOOSTED_FPS)

  const measured = buildMeasuredIndex({ movementRows: rows, speedStatByCharacterId: ratings })
  const row = buildRawValueRows(7, {}, measured).find((entry) => entry.key === 'fieldTopSpeed')
  assert.equal(row.measuredValue, null)
  assert.equal(row.directDelta, null, 'no difference may be published against a value we do not have')
})

test('boosted rows dominating a scope still do not become the ordinary constant', () => {
  const rows = [
    ...Array.from({ length: 14 }, () => fielderRow({ max_speed_fps: WARIO_BOOSTED_FPS })),
    ...Array.from({ length: 4 }, () => fielderRow()),
  ]
  const summary = summarizeMovementMetrics(rows, 'character', { speedStatByCharacterId: ratings })['7']
  assert.equal(summary.maxSpeedFps, WARIO_ORDINARY_FPS)
  assert.equal(summary.maxSpeedSamples, 4)
  assert.equal(summary.maxSpeedBoostedSamples, 14)
})

test('without a rating the constant is reported unclassified, not as ordinary', () => {
  const rows = Array.from({ length: 9 }, () => fielderRow({ max_speed_fps: WARIO_BOOSTED_FPS }))
  const summary = summarizeMovementMetrics(rows, 'character')['7']
  assert.equal(summary.maxSpeedClassified, false)
  assert.equal(summary.maxSpeedFps, WARIO_BOOSTED_FPS, 'the observation is still offered')
  assert.equal(summary.maxSpeedBoostedSamples, 0, 'but nothing is claimed about what it is')
})

test('a constant on neither curve row is left unclassified rather than rounded to one', () => {
  const rows = Array.from({ length: 6 }, () => fielderRow({ max_speed_fps: 99.9 }))
  const summary = summarizeMovementMetrics(rows, 'character', { speedStatByCharacterId: ratings })['7']
  assert.equal(summary.maxSpeedFps, null)
  assert.equal(summary.maxSpeedUnclassifiedSamples, 6)
  assert.deepEqual(summary.maxSpeedUnclassifiedValues, [99.9])
})

test('runner and batter rows carry no top-speed constant', () => {
  const rows = [
    fielderRow(),
    { actor_type: 'batter', character_id: 7, max_speed_fps: null, sprint_speed_fps: 30.5, quality: {} },
  ]
  const summary = summarizeMovementMetrics(rows, 'character', { speedStatByCharacterId: ratings })['7']
  assert.equal(summary.maxSpeedObservedSamples, 1)
})

test('a quarantined session contributes no top speed', () => {
  const rows = [fielderRow({ quality: { quarantined_session: true } })]
  const summary = summarizeMovementMetrics(rows, 'character', { speedStatByCharacterId: ratings })['7']
  assert.equal(summary?.maxSpeedFps ?? null, null)
})

// ─── The classification, all the way to the row the page renders ─────────────
//
// summarizeMovementMetrics classifies correctly and that was where the
// checking stopped. The row builder then read `maxSpeedSamples` alone, so a
// character with fourteen boosted observations and no ordinary one produced a
// row indistinguishable from a character nobody has ever tracked: no value, no
// samples, "no samples" on screen. These tests run the whole way to the row.

const speedRow = (rows, options = {}) => buildRawValueRows(
  7, {}, buildMeasuredIndex({ movementRows: rows, ...options }),
).find((entry) => entry.key === 'fieldTopSpeed')

test('boosted-only observations reach the row as boosted, not as nothing', () => {
  const row = speedRow(
    Array.from({ length: 14 }, () => fielderRow({ max_speed_fps: WARIO_BOOSTED_FPS })),
    { speedStatByCharacterId: ratings },
  )
  assert.equal(row.measuredValue, null, 'a boosted constant is not the ordinary one')
  assert.equal(row.samples, 0, 'n is the denominator of the value, and there is no value')
  assert.equal(row.excluded, 14)
  assert.equal(row.awaitingSamples, false, 'fourteen observations is not "no samples"')
  assert.equal(row.excludedOnly, true)
  assert.equal(row.classification.state, 'boosted-only')
  assert.equal(row.classification.boostedSamples, 14)
  assert.equal(row.classification.observedSamples, 14)
  assert.equal(row.classification.boostedValue, WARIO_BOOSTED_FPS)
  assert.match(describeSpeedClassification(row.classification).label, /^boosted only · 14$/)
})

test('boosted observations dominating a scope do not take over the row', () => {
  const row = speedRow([
    ...Array.from({ length: 14 }, () => fielderRow({ max_speed_fps: WARIO_BOOSTED_FPS })),
    ...Array.from({ length: 4 }, () => fielderRow()),
  ], { speedStatByCharacterId: ratings })
  assert.equal(row.measuredValue, WARIO_ORDINARY_FPS * FEET_PER_SECOND_TO_MPH)
  assert.equal(row.samples, 4, 'the denominator is the ordinary observations only')
  assert.equal(row.excluded, 14)
  assert.equal(row.classification.state, 'ordinary')
  assert.equal(row.excludedOnly, false)
  // The excluded ones still have to be findable from the row.
  assert.equal(describeSpeedClassification(row.classification).label, '14 excluded')
  assert.match(describeSpeedClassification(row.classification).detail, /4 ordinary observations of 18/)
})

test('constants matching neither curve row say so rather than disappearing', () => {
  const row = speedRow(
    Array.from({ length: 6 }, () => fielderRow({ max_speed_fps: 99.9 })),
    { speedStatByCharacterId: ratings },
  )
  assert.equal(row.measuredValue, null)
  assert.equal(row.samples, 0)
  assert.equal(row.excluded, 6)
  assert.equal(row.excludedOnly, true)
  assert.equal(row.classification.state, 'unmatched-only')
  assert.equal(row.classification.unmatchedSamples, 6)
  assert.equal(describeSpeedClassification(row.classification).label, 'matches neither row · 6')
})

test('boosted AND unmatched together is its own state', () => {
  const row = speedRow([
    ...Array.from({ length: 3 }, () => fielderRow({ max_speed_fps: WARIO_BOOSTED_FPS })),
    ...Array.from({ length: 2 }, () => fielderRow({ max_speed_fps: 99.9 })),
  ], { speedStatByCharacterId: ratings })
  assert.equal(row.classification.state, 'boosted-and-unmatched')
  assert.equal(row.excluded, 5)
  assert.equal(row.samples, 0)
  assert.equal(describeSpeedClassification(row.classification).label, 'no ordinary observation · 5')
})

// WITHOUT A RATING NOTHING WAS CHECKED. The aggregator still offers the modal
// observation, because a caller may hold a constant and no roster row; the
// index must not let that reach a percentile or a difference against the curve.
test('a character with no rating shows the state, not the unchecked value', () => {
  const rows = Array.from({ length: 9 }, () => fielderRow({ max_speed_fps: WARIO_BOOSTED_FPS }))
  const measured = buildMeasuredIndex({ movementRows: rows })
  assert.equal(measured['7'].maxSpeedFps, null, 'an unchecked value is not the game constant')
  assert.equal(measured['7'].maxSpeedUnverifiedFps, WARIO_BOOSTED_FPS, 'but it is still carried')
  assert.equal(measured['7'].maxSpeedSamples, 0)

  const row = buildRawValueRows(7, {}, measured).find((entry) => entry.key === 'fieldTopSpeed')
  assert.equal(row.measuredValue, null)
  assert.equal(row.measuredPercentile, null, 'nothing unchecked may be ranked against the cast')
  assert.equal(row.directDelta, null)
  assert.equal(row.classification.state, 'unrated')
  assert.equal(row.classification.classified, false)
  assert.equal(row.classification.observedSamples, 9)
  assert.equal(row.excludedOnly, true)
  const described = describeSpeedClassification(row.classification)
  assert.equal(described.label, 'no rating · 9')
  assert.match(described.detail, /No run_speed/)
})

test('a character with no fielder rows at all is still "no samples"', () => {
  // Nobody in the index at all: the row still renders, with nothing to say.
  const absent = speedRow([], { speedStatByCharacterId: ratings })
  assert.equal(absent.measuredValue, null)
  assert.equal(absent.samples, null, 'no measured record, so not even a zero')
  assert.equal(absent.classification, null)
  assert.equal(absent.awaitingSamples, true)
  assert.equal(absent.excludedOnly, false)
  assert.equal(describeSpeedClassification(absent.classification), null)

  // In the index for other reasons, with no fielder row carrying a constant.
  const present = buildRawValueRows(7, {}, buildMeasuredIndex({
    movementRows: [{
      actor_type: 'batter', character_id: 7, sprint_speed_fps: 30.5,
      path_distance_m: 30, max_speed_fps: null, quality: {},
    }],
    speedStatByCharacterId: ratings,
  })).find((entry) => entry.key === 'fieldTopSpeed')
  assert.equal(present.measuredValue, null)
  assert.equal(present.samples, 0)
  assert.equal(present.excluded, 0)
  assert.equal(present.awaitingSamples, true, 'nothing observed really is "no samples"')
  assert.equal(present.excludedOnly, false)
  assert.equal(present.classification.state, 'none')
  assert.equal(describeSpeedClassification(present.classification), null)
})

// ─── Catch reach ─────────────────────────────────────────────────────────────

test('receiving a throw is not a reach at a batted ball', () => {
  const rows = [
    ...Array.from({ length: 8 }, () => approachRow()),
    ...Array.from({ length: 40 }, () => approachRow({ approach: 'throw', separation_3d_units: 9 })),
  ]
  const summary = summarizeCatchReach(rows, 'character')['7']
  assert.equal(summary.approaches.ordinary.attempts, 8)
  assert.equal(summary.approaches.throw, undefined)
})

test('assisted, stadium-decided and special-action windows stay out of the baseline', () => {
  assert.equal(catchApproachIsOrdinaryMechanics(approachRow()), true)
  // A glide that ENDED before the catch did is not contamination: the reach
  // itself was the character's. Only a body still being moved on the
  // resolving frame is.
  assert.equal(catchApproachIsOrdinaryMechanics(approachRow({ assisted: true, assist_frames: 9 })), true)
  for (const contaminated of [
    { assisted_at_closest: true },
    { buddy_jump_frames: 12 },
    { mechanics: ['buddy_receive'] },
    { mechanics: ['egg'] },
    { mechanics: ['star_ball'] },
    { quality: { stadium_affected: true } },
    { quality: { star_swing: true } },
    { quality: { quarantined_session: true } },
  ]) {
    assert.equal(
      catchApproachIsOrdinaryMechanics(approachRow(contaminated)),
      false,
      JSON.stringify(contaminated),
    )
  }
})

test('failures are kept, because only they bound a reach from above', () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, index) => approachRow({ separation_3d_units: 2 + (index * 0.2) })),
    approachRow({ outcome: 'no_contact', separation_3d_units: 5.5 }),
    approachRow({ outcome: 'missed', separation_3d_units: 4.8 }),
  ]
  const ordinary = summarizeCatchReach(rows, 'character')['7'].approaches.ordinary
  assert.equal(ordinary.attempts, 8)
  assert.equal(ordinary.secured, 6)
  assert.equal(ordinary.failed, 2)
  // The largest completed catch is a floor on capability and the smallest
  // failure is the ceiling. Both are reported; neither is called the maximum.
  assert.equal(ordinary.reachSecuredMax, 3)
  assert.equal(ordinary.reachFailedMin, 4.8)
  assert.ok(ordinary.reachSecuredMax < ordinary.reachFailedMin)
})

// THE REGRESSION THIS EXISTS FOR. The displayed reach is a quantile over the
// catches that were HELD, so six attempts holding one catch published that one
// separation as a "90th percentile" with n=6 printed beside it.
test('the threshold counts secured catches, not attempts', () => {
  const oneHeld = [
    approachRow({ separation_3d_units: 4.2 }),
    ...Array.from({ length: 5 }, (_, i) => approachRow({ outcome: 'no_contact', separation_3d_units: 5 + (i * 0.1) })),
  ]
  const measured = buildMeasuredIndex({ catchRows: oneHeld })
  assert.equal(measured['7'].ordinaryReachAttempts, 6)
  assert.equal(measured['7'].ordinaryReachSamples, 1)
  const row = buildRawValueRows(7, {}, measured).find((entry) => entry.key === 'ordinaryReach')
  assert.equal(row.measuredValue, null, 'one catch is not a percentile over six')
  assert.equal(row.samples, 1, 'n is the denominator of the value, so it counts catches')
  assert.equal(row.attempts, 6)
  assert.equal(row.insufficientSamples, true)
})

test('six secured catches do publish a reach', () => {
  const sixHeld = Array.from({ length: MIN_CATCH_REACH_SECURED }, (_, i) => (
    approachRow({ separation_3d_units: 2 + (i * 0.1) })
  ))
  const measured = buildMeasuredIndex({ catchRows: sixHeld })
  const row = buildRawValueRows(7, {}, measured).find((entry) => entry.key === 'ordinaryReach')
  assert.ok(row.measuredValue != null, 'six held catches clear the threshold')
  assert.equal(row.samples, MIN_CATCH_REACH_SECURED)
  assert.equal(row.insufficientSamples, false)
})

test('attempts with nothing held is its own state, not "too few"', () => {
  const noneHeld = Array.from({ length: 6 }, (_, i) => (
    approachRow({ outcome: 'no_contact', separation_3d_units: 5 + (i * 0.1) })
  ))
  const measured = buildMeasuredIndex({ catchRows: noneHeld })
  const row = buildRawValueRows(7, {}, measured).find((entry) => entry.key === 'ordinaryReach')
  assert.equal(row.measuredValue, null)
  assert.equal(row.samples, 0)
  assert.equal(row.attempts, 6)
  assert.equal(row.attemptedNoneHeld, true)
  assert.equal(row.insufficientSamples, false, '"too few" would hide that none were completed')
  assert.equal(row.awaitingSamples, false, 'six attempts is not "no samples"')
})

test('a character never tried at this approach reports no samples', () => {
  const row = buildRawValueRows(7, {}, buildMeasuredIndex({ catchRows: [] }))
    .find((entry) => entry.key === 'diveReach')
  assert.equal(row.awaitingSamples, true)
  assert.equal(row.attemptedNoneHeld, false)
  assert.equal(row.insufficientSamples, false)
})

// ─── What may be compared with what ──────────────────────────────────────────

test('the top-speed row carries a real difference; reach rows carry none at all', () => {
  const mined = {
    7: { fieldTopSpeedFps: WARIO_ORDINARY_FPS, catchRadiusRegular: 1.888 },
    8: { fieldTopSpeedFps: 24.5, catchRadiusRegular: 2.4 },
  }
  const measured = {
    7: { maxSpeedFps: WARIO_ORDINARY_FPS, maxSpeedSamples: 40, ordinaryReachUnits: 3.6, ordinaryReachSamples: 20, ordinaryReachAttempts: 24 },
    8: { maxSpeedFps: 24.2, maxSpeedSamples: 12, ordinaryReachUnits: 4.1, ordinaryReachSamples: 18, ordinaryReachAttempts: 20 },
  }
  const rows = buildRawValueRows(7, mined, measured)

  const speed = rows.find((row) => row.key === 'fieldTopSpeed')
  assert.equal(speed.sameUnit, 'mph')
  assert.equal(speed.comparable, true)
  assert.equal(speed.directDelta, 0)
  assert.equal(speed.samples, 40)

  // The workbook radius is glove-relative and the measurement runs from the
  // actor origin. They are not the same quantity, the ranking evidence is a
  // one-off archive pass for standing and NEGATIVE for dive, so no delta of
  // any kind is published -- not a subtraction and not a difference of ranks.
  const reach = rows.find((row) => row.key === 'ordinaryReach')
  assert.equal(reach.comparable, false)
  assert.equal(reach.sameUnit, null)
  assert.equal(reach.directDelta, null)
  assert.equal(reach.delta, null, 'a percentile delta would read as agreement nobody has shown')
  assert.ok(reach.minedValue != null && reach.measuredValue != null, 'both sides still show')
  assert.ok(reach.note.length > 0)
})

test('the traits that have no measured counterpart show their published value', () => {
  const rows = buildRawValueRows(7, {
    7: { baserunTopSpeedFps: 27.2, catchRadiusFacingAway: 0.944, catchRadiusHeight: 3.009 },
  }, {})
  for (const key of ['baserunTopSpeed', 'facingAwayReach', 'catchHeight']) {
    const row = rows.find((entry) => entry.key === key)
    assert.ok(row.minedValue != null, `${key} should show its published value`)
    assert.equal(row.measuredValue, null)
    assert.equal(row.delta, null)
    assert.equal(row.samples, null)
    assert.ok(row.note.length > 0, `${key} must say what validation is missing`)
    // The note names a missing input, not an impossibility.
    assert.doesNotMatch(row.note, /never|impossible|cannot ever/i)
  }
})

test('first-step distance is not presented as a catch reach', () => {
  const row = buildRawValueRows(7, {}, { 7: { jumpDistanceFeet: 16.7, jumpSamples: 9 } })
    .find((entry) => entry.key === 'jumpDistance')
  assert.equal(row.label, 'First-Step Distance')
  assert.equal(row.measuredUnit, 'ft')
  assert.equal(row.minedValue, null)
  assert.match(row.note, /Not a catch radius/)
})

test('the expected top speed comes from the validated fielding curve, in feet', () => {
  // Yoshi: run_speed 90, workbook 0.141 u/frame, 59.94 frames a second.
  const characters = [{ id: 42, name: 'Yoshi', run_speed: 90 }]
  const mined = buildMinedIndex(characters, {})['42']
  const expected = 0.141 * 59.94 * METRES_TO_FEET
  assert.ok(Math.abs(mined.fieldTopSpeedFps - expected) < 0.01,
    `${mined.fieldTopSpeedFps} vs ${expected}`)
  // The baserunning curve is a different table and must not be the same
  // number, which is the mistake a single "speed" lookup would make.
  assert.notEqual(mined.baserunTopSpeedFps, mined.fieldTopSpeedFps)
  assert.equal(mined.baserunTopSpeedValidated, false)
})
