import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPECTED_OUTCOME_MODEL_VERSION,
  buildExpectedOutcomeModel,
  summarizeExpectedBatting,
  summarizeExpectedPitching,
} from '../src/utils/expectedStats.js'

function contact(id, gameId, result, extra = {}) {
  return {
    id,
    game_id: gameId,
    season_id: 71,
    result,
    is_error: false,
    star_hit_used: false,
    exit_velocity_mph: 100,
    launch_angle_deg: 20,
    ...extra,
  }
}

test('historical expected stats hold out the entire game being evaluated', () => {
  const hit = contact('hit', 'game-a', '1B')
  const out = contact('out', 'game-b', 'GO')
  const model = buildExpectedOutcomeModel([hit, out])

  // A free-standing estimate uses the whole training pool, while a historical
  // PA estimate is trained only on other games.
  assert.equal(model.estimate(100, 20).xHitProb, 0.5)
  assert.equal(model.estimatePa(hit).xHitProb, 0)
  assert.equal(model.estimatePa(out).xHitProb, 1)
  assert.equal(model.modelVersion, EXPECTED_OUTCOME_MODEL_VERSION)
})

test('hitter and pitcher expected summaries use the identical play estimates', () => {
  const rows = [
    contact('a1', 'game-a', '1B'),
    contact('a2', 'game-a', 'GO', { exit_velocity_mph: 90 }),
    contact('b1', 'game-b', '2B'),
    contact('b2', 'game-b', 'FO', { exit_velocity_mph: 90 }),
  ]
  const model = buildExpectedOutcomeModel(rows)
  const batting = summarizeExpectedBatting(rows.slice(0, 2), model)
  const pitching = summarizeExpectedPitching(rows.slice(0, 2), model)

  assert.equal(batting.sampleSize, 2)
  assert.equal(pitching.sampleSize, 2)
  assert.equal(pitching.xBAAllowed, batting.xBA)
  assert.equal(pitching.xSLGAllowed, batting.xSLG)
  assert.equal(pitching.xwOBAAllowed, batting.xwOBA)
  assert.equal(pitching.trainingSampleSize, 4)
})

test('star-hit and legacy rows stay out of the contact-quality training pool', () => {
  const model = buildExpectedOutcomeModel([
    contact('normal', 'game-a', '1B'),
    contact('star', 'game-b', 'HR', { star_hit_used: true }),
    contact('legacy', 'game-c', 'GO', { exit_velocity_mph: null, launch_angle_deg: null }),
  ])

  assert.equal(model.sampleSize, 1)
})

test('an ordinary contact after a missed star swing stays in the expected-contact pool', () => {
  const model = buildExpectedOutcomeModel([
    contact('ordinary-after-star', 'game-a', 'HR', {
      star_hit_used: true,
      star_hit_connected: false,
    }),
    contact('connected-star', 'game-b', 'HR', {
      star_hit_used: true,
      star_hit_connected: true,
    }),
  ])
  assert.equal(model.sampleSize, 1)
})
