import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canFinalizeInPlaySelection,
  effectiveErrorPositions,
} from '../src/features/scorebook/domain/inPlay.js'

test('explicit error fielders take precedence over the ROE fallback', () => {
  assert.deepEqual(effectiveErrorPositions({
    resultType: 'error',
    fielderChain: [6],
    errorFielderPositions: [4, 3],
  }), [4, 3])
  assert.deepEqual(effectiveErrorPositions({ resultType: 'error', fielderChain: [6] }), [6])
  assert.deepEqual(effectiveErrorPositions({ resultType: 'hit', fielderChain: [6] }), [])
})

test('home runs and results without fielding credit can finalize immediately', () => {
  assert.equal(canFinalizeInPlaySelection({ result: 'HR' }), true)
  assert.equal(canFinalizeInPlaySelection({ result: '1B' }), false)
  assert.equal(canFinalizeInPlaySelection({ result: '1B', fielderChain: [8] }), true)
})

test('buddy jumps require two fielders with good chemistry', () => {
  const fielders = {
    7: { character: 'Mario' },
    8: { character: 'Luigi' },
    9: { character: 'Bowser' },
  }
  const haveGoodChemistry = (left, right) => left === 'Mario' && right === 'Luigi'
  assert.equal(canFinalizeInPlaySelection({ result: 'FO', isBuddyJump: true, fielderChain: [7] }, fielders, haveGoodChemistry), false)
  assert.equal(canFinalizeInPlaySelection({ result: 'FO', isBuddyJump: true, fielderChain: [7, 8] }, fielders, haveGoodChemistry), true)
  assert.equal(canFinalizeInPlaySelection({ result: 'FO', isBuddyJump: true, fielderChain: [7, 9] }, fielders, haveGoodChemistry), false)
})
