import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDisplayedPitchingStints,
  dedupePitchingStints,
  formatBaseballAverage,
  formatHitsAtBats,
  formatRate,
  isMeaningfulPitchingStint,
} from '../src/features/scorebook/domain/display.js'

test('baseball rate formatting omits leading zeroes and handles empty denominators', () => {
  assert.equal(formatBaseballAverage({ atBats: 0, avg: 1 }), '.000')
  assert.equal(formatBaseballAverage({ atBats: 4, avg: 0.5 }), '.500')
  assert.equal(formatBaseballAverage({ atBats: 4, avg: 1 }), '1.000')
  assert.equal(formatRate(0.625), '.625')
  assert.equal(formatHitsAtBats({ hits: 2, atBats: 5 }), '2-5')
})

test('pitching decisions make a zero-stat stint meaningful', () => {
  assert.equal(isMeaningfulPitchingStint({ innings_pitched: 0, win: true }), true)
  assert.equal(isMeaningfulPitchingStint({ innings_pitched: 0 }), false)
})

test('duplicate empty stints collapse to the latest row', () => {
  const rows = dedupePitchingStints([
    { id: 1, player_id: 'home', character_id: 8, created_at: '2026-01-01T00:00:00Z' },
    { id: 2, player_id: 'home', character_id: 8, created_at: '2026-01-01T00:01:00Z' },
  ])
  assert.deepEqual(rows.map((row) => row.id), [2])
})

test('duplicate stints with recorded stats remain visible and chronological', () => {
  const rows = dedupePitchingStints([
    { id: 2, player_id: 'home', character_id: 8, innings_pitched: 1, created_at: '2026-01-01T00:02:00Z' },
    { id: 1, player_id: 'home', character_id: 8, strikeouts: 2, created_at: '2026-01-01T00:01:00Z' },
    { id: 3, player_id: 'home', character_id: 9, created_at: '2026-01-01T00:03:00Z' },
  ])
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3])
})

test('the currently assigned pitcher remains displayed before recording a stat', () => {
  assert.deepEqual(buildDisplayedPitchingStints([], 'home', 12), [{
    player_id: 'home',
    character_id: 12,
    innings_pitched: 0,
    hits_allowed: 0,
    runs_allowed: 0,
    earned_runs: 0,
    walks: 0,
    strikeouts: 0,
    hr_allowed: 0,
    pitches_thrown: 0,
    strikes_thrown: 0,
  }])
})
