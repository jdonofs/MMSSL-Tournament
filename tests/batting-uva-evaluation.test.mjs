import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MODEL_FEATURES,
  assertLeakageSafeFeatures,
  evaluateGroupedBinary,
  featureVector,
} from '../scripts/evaluate_batting_uva.mjs'
import { buildRestatementAudit } from '../scripts/audit_pitch_evidence_restatement.mjs'

test('Batting UVA feature contracts reject realized scoring outcomes', () => {
  assert.equal(assertLeakageSafeFeatures(MODEL_FEATURES.decision), true)
  assert.throws(() => assertLeakageSafeFeatures(['count', 'result']), /Target leakage/)
  assert.throws(() => assertLeakageSafeFeatures(['contact']), /Target leakage/)
})

test('missing charge evidence is omitted rather than encoded as zero', () => {
  const missing = featureVector({
    ballsBefore: 0, strikesBefore: 0, chargeFrames: null, releaseTimingFrames: null,
  }, ['count', 'charge_frames', 'release_timing'])
  assert.deepEqual(missing, { 'count=0-0': 1 })

  const observedZero = featureVector({
    ballsBefore: 0, strikesBefore: 0, chargeFrames: 0, releaseTimingFrames: 0,
  }, ['count', 'charge_frames', 'release_timing'])
  assert.deepEqual(observedZero, { 'count=0-0': 1, charge_frames: 0, release_timing: 0 })
})

test('binary evaluation holds out complete games', () => {
  const rows = [
    { gameId: 'a', offered: true, ballsBefore: 0, strikesBefore: 0, pitchZone: 'in' },
    { gameId: 'a', offered: false, ballsBefore: 1, strikesBefore: 0, pitchZone: 'out' },
    { gameId: 'b', offered: true, ballsBefore: 0, strikesBefore: 1, pitchZone: 'in' },
    { gameId: 'b', offered: false, ballsBefore: 2, strikesBefore: 0, pitchZone: 'out' },
    { gameId: 'c', offered: true, ballsBefore: 0, strikesBefore: 2, pitchZone: 'shadow' },
    { gameId: 'c', offered: false, ballsBefore: 3, strikesBefore: 1, pitchZone: 'out' },
  ]
  const result = evaluateGroupedBinary(rows, {
    labelKey: 'offered', featureNames: ['count', 'pitch_zone'],
  })
  assert.equal(result.split, 'leave_one_whole_game_out')
  assert.equal(result.folds.length, 3)
  assert.equal(result.metrics.n, rows.length)
  for (const fold of result.folds) {
    assert.equal(fold.trainN, 4)
    assert.equal(fold.test.n, 2)
  }
})

test('restatement audit is dry-run-only and preserves pitch-level mixed modes', () => {
  const report = buildRestatementAudit()
  assert.equal(report.dryRun, true)
  assert.equal(report.databaseWrites, 0)
  assert.equal(report.safety.scoringFieldAttempts, 0)
  assert.equal(report.safety.negativeStarPitchUpdates, 0)
  assert.equal(report.safety.duplicateCanonicalTargets, 0)
  assert.equal(report.safety.mixedModePlateAppearancesRemainPitchLevel, true)
  assert.ok(report.coverage.mixedModePlateAppearances > 0)
  assert.equal(report.coverage.plannedUpdates, 474)
})

