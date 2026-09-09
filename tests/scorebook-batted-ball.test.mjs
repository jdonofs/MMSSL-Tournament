import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildScoringPlayDescription,
  directionForFielderPosition,
  directionForSprayAngle,
  formatPlayResultText,
  resolveBattedBallDirection,
} from '../src/features/scorebook/domain/battedBall.js'

test('fielder-side direction flips for left-handed batters while center stays center', () => {
  assert.equal(directionForFielderPosition(7, 'R'), 'Pull')
  assert.equal(directionForFielderPosition(7, 'L'), 'Oppo')
  assert.equal(directionForFielderPosition(9, 'R'), 'Oppo')
  assert.equal(directionForFielderPosition(9, 'L'), 'Pull')
  assert.equal(directionForFielderPosition(8, 'L'), 'Center')
})

test('spray direction uses the same handedness-relative thresholds', () => {
  assert.equal(directionForSprayAngle(-15, 'R'), 'Pull')
  assert.equal(directionForSprayAngle(-15, 'L'), 'Oppo')
  assert.equal(directionForSprayAngle(0, 'R'), 'Center')
  assert.equal(directionForSprayAngle(15, 'L'), 'Pull')
  assert.equal(directionForSprayAngle('unknown', 'R'), null)
})

test('a scored fielder position takes precedence over the spray-angle fallback', () => {
  assert.equal(resolveBattedBallDirection(5, 30, 'R'), 'Pull')
  assert.equal(resolveBattedBallDirection(null, 30, 'R'), 'Oppo')
})

test('play-result wording retains trajectory, location, and strikeout detail', () => {
  assert.equal(formatPlayResultText({ result: 'GO', trajectory: 'G', hit_location: 6 }), 'grounded out to short')
  assert.equal(formatPlayResultText({ result: '1B', trajectory: 'G', hit_location: 9 }), 'singled on the ground to right field')
  assert.equal(formatPlayResultText({ result: 'K', strikeout_type: 'KL' }), 'struck out looking')
})

test('home-run scoring descriptions do not list the batter as a separate scorer', () => {
  const characters = {
    1: { name: 'Mario' },
    2: { name: 'Luigi' },
  }
  const description = buildScoringPlayDescription(
    { result: 'HR', character_id: 1 },
    2,
    [
      { scoring_character_id: 1 },
      { scoring_character_id: 2 },
    ],
    characters,
  )

  assert.equal(description, 'Mario homered; Luigi scored.')
})

test('scoring descriptions fall back to the run count when scorer names are unavailable', () => {
  assert.equal(
    buildScoringPlayDescription({ result: '2B', character_id: 99 }, 2),
    'Unknown batter doubled; 2 runs scored.',
  )
})
