import assert from 'node:assert/strict'
import test from 'node:test'

import { getForcedRunnerIds, shouldNullifyRunsOnInningEndingForce } from '../src/utils/forcePlay.js'
import { assignAuthoritativePitchNumbers } from '../src/utils/pitchSequence.js'

const runner = (id) => ({ characterId: id, playerId: `p${id}` })

test('forced chain extends through third only with the bases loaded', () => {
  assert.deepEqual(getForcedRunnerIds({ first: runner(1), second: runner(2), third: runner(3) }), [
    'batter', 'first', 'second', 'third',
  ])
  assert.deepEqual(getForcedRunnerIds({ second: runner(2), third: runner(3) }), ['batter'])
})

test('bases-loaded third-out force nullifies a lead runner crossing home', () => {
  assert.equal(shouldNullifyRunsOnInningEndingForce({
    inningEnds: true,
    runnersAtStart: { first: runner(1), second: runner(2), third: runner(3) },
    assignments: [
      { id: 'batter', destination: 'first', isBatter: true },
      { id: 'first', destination: 'out' },
      { id: 'third', destination: 'home' },
    ],
  }), true)
})

test('a non-force tag out does not automatically nullify a run', () => {
  assert.equal(shouldNullifyRunsOnInningEndingForce({
    inningEnds: true,
    runnersAtStart: { second: runner(2), third: runner(3) },
    assignments: [
      { id: 'batter', destination: 'first', isBatter: true },
      { id: 'second', destination: 'out' },
      { id: 'third', destination: 'home' },
    ],
  }), false)
})

test('a play that does not end the inning never nullifies runs', () => {
  assert.equal(shouldNullifyRunsOnInningEndingForce({
    inningEnds: false,
    runnersAtStart: { first: runner(1) },
    assignments: [{ id: 'first', destination: 'out' }],
  }), false)
})

test('persisted pitch numbering advances from committed rows instead of a stale client counter', () => {
  const { rows, latestByPitcher } = assignAuthoritativePitchNumbers([
    { pitcher_id: 'Luigi', pitch_number_game: 1, result: 'ball' },
    { pitcher_id: 'Luigi', pitch_number_game: 2, result: 'in_play' },
  ], [
    { pitcher_id: 'Luigi', pitch_number_game: 1 },
    { pitcher_id: 'Luigi', pitch_number_game: 4 },
  ])

  assert.deepEqual(rows.map((row) => row.pitch_number_game), [5, 6])
  assert.equal(latestByPitcher.Luigi, 6)
})

test('authoritative pitch numbering tracks a mid-PA pitcher change independently', () => {
  const { rows } = assignAuthoritativePitchNumbers([
    { pitcher_id: 'Luigi' },
    { pitcher_id: 'Bowser' },
    { pitcher_id: 'Bowser' },
  ], [
    { pitcher_id: 'Luigi', pitch_number_game: 8 },
    { pitcher_id: 'Bowser', pitch_number_game: 3 },
  ])

  assert.deepEqual(rows.map((row) => row.pitch_number_game), [9, 4, 5])
})
