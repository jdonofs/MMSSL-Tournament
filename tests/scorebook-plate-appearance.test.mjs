import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPitchRowsForSave,
  buildRunRowsForSave,
  comparePitchOrder,
  normalizePa,
  normalizeSavedPaRunScored,
  stripDbManagedFields,
} from '../src/features/scorebook/domain/plateAppearance.js'

test('legacy B trajectories normalize to fly balls without mutating the source row', () => {
  const source = { id: 1, trajectory: 'B' }
  assert.deepEqual(normalizePa(source), { id: 1, trajectory: 'F' })
  assert.equal(source.trajectory, 'B')
})

test('database-managed and derived fields are removed before rollback inserts', () => {
  assert.deepEqual(stripDbManagedFields({
    id: 7,
    created_at: 'now',
    hit_tracking_source: 'derived',
    game_id: 3,
    result: '1B',
  }), { game_id: 3, result: '1B' })
})

test('run-scored normalization recognizes homers and the batter in explicit run events', () => {
  const batter = { player_id: 'away', character_id: 4 }
  assert.equal(normalizeSavedPaRunScored('HR', false, [], batter), true)
  assert.equal(normalizeSavedPaRunScored('1B', false, [{ playerId: 'away', characterId: 4 }], batter), true)
  assert.equal(normalizeSavedPaRunScored('1B', false, [{ playerId: 'away', characterId: 5 }], batter), false)
})

test('pitch ordering uses game pitch numbers before tied timestamps', () => {
  const rows = [
    { id: 'late', pitch_number_game: 8, created_at: '2026-01-01T00:00:00Z' },
    { id: 'early', pitch_number_game: 7, created_at: '2026-01-01T00:00:10Z' },
  ]
  assert.deepEqual(rows.sort(comparePitchOrder).map((row) => row.id), ['early', 'late'])
})

test('pitch save rows preserve per-pitch identity, counts, stars, and side', () => {
  const rows = buildPitchRowsForSave({
    pitchRows: [{
      pitcherId: 'Luigi',
      pitcherPlayerId: 'home',
      pitchNumberPa: 2,
      pitchNumberGame: 14,
      pitch: {
        is_star_pitch: true,
        is_star_swing: false,
        result: 'called_strike',
        count_balls_before: 2,
        count_strikes_before: 1,
        count_balls_after: 2,
        count_strikes_after: 2,
      },
    }],
    gameId: 9,
    paId: 22,
    currentPitcherName: 'Mario',
    currentPitcherStint: { player_id: 'home' },
    playersById: { home: { name: 'Home Player' } },
    batterName: 'Peach',
    inning: 3,
    isTop: false,
    pitchNumber: 99,
  })

  assert.deepEqual(rows, [{
    game_id: 9,
    pa_id: 22,
    pitcher_id: 'Luigi',
    pitcher_player: 'Home Player',
    batter_id: 'Peach',
    inning: 3,
    half: 'bottom',
    pitch_number_pa: 2,
    pitch_number_game: 14,
    is_star_pitch: true,
    is_star_swing: false,
    result: 'called_strike',
    count_balls_before: 2,
    count_strikes_before: 1,
    count_balls_after: 2,
    count_strikes_after: 2,
  }])
})

test('run save rows retain original pitcher responsibility and earned-run state', () => {
  assert.deepEqual(buildRunRowsForSave({
    runEvents: [
      { playerId: 'away', characterId: 3, chargedToPitcherId: 8, chargedToPitcherPlayerId: 'old-home', isEarnedRun: false },
      { playerId: 'away', characterId: 4 },
    ],
    gameId: 9,
    paId: 22,
    inning: 3,
    isTop: true,
    currentPitcherStint: { character_id: 10, player_id: 'home' },
  }), [
    {
      game_id: 9,
      pa_id: 22,
      inning: 3,
      half: 'top',
      scoring_player_id: 'away',
      scoring_character_id: 3,
      charged_to_pitcher_id: 8,
      charged_to_pitcher_player_id: 'old-home',
      is_earned_run: false,
    },
    {
      game_id: 9,
      pa_id: 22,
      inning: 3,
      half: 'top',
      scoring_player_id: 'away',
      scoring_character_id: 4,
      charged_to_pitcher_id: 10,
      charged_to_pitcher_player_id: 'home',
      is_earned_run: true,
    },
  ])
})
