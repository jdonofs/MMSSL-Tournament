import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getActivePaStorageKey,
  getRunnerHistoryStorageKey,
  getRunnerStateStorageKey,
  sanitizeRunnersForOffense,
} from '../src/features/scorebook/domain/runnerState.js'

test('runner persistence keys remain scoped to game and half inning', () => {
  assert.equal(getActivePaStorageKey(42), 'scorebook-active-pa:42')
  assert.equal(getRunnerStateStorageKey(42, 3), 'scorebook-runners:42:3')
  assert.equal(getRunnerHistoryStorageKey(42, 3), 'scorebook-runners-history:42:3')
})

test('runner sanitation retains only the current offense', () => {
  const first = { characterId: 1, playerId: 8 }
  const second = { characterId: 2, playerId: 9 }
  const third = { characterId: 3, playerId: '8' }
  assert.deepEqual(
    sanitizeRunnersForOffense({ first, second, third }, { battingPlayerId: 8 }),
    { first, second: null, third },
  )
})

test('runner sanitation preserves the source when offense is not resolved', () => {
  const runners = { first: { characterId: 1, playerId: 8 }, second: null, third: null }
  assert.equal(sanitizeRunnersForOffense(runners, null), runners)
})
