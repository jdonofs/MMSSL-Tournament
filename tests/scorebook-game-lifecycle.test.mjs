import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGameCompletionPatch,
  buildGameReopenPatch,
  buildGameResetPatch,
  resolveGameCompletionDetails,
} from '../src/features/scorebook/domain/gameLifecycle.js'

test('completion resolves the winner and infers extra innings after reload', () => {
  assert.deepEqual(resolveGameCompletionDetails({
    scores: { a: 3, b: 4 },
    selectedGame: { team_a_player_id: 'away', team_b_player_id: 'home' },
    currentInning: 4,
    regulationInnings: 3,
  }), {
    resolvedWinnerId: 'home',
    resolvedFinalInning: 4,
    resolvedIsExtra: true,
  })
})

test('a tied completion preserves a null winner and an explicit extra-innings override', () => {
  assert.deepEqual(resolveGameCompletionDetails({
    scores: { a: 2, b: 2 },
    selectedGame: { team_a_player_id: 'away', team_b_player_id: 'home' },
    currentInning: 5,
    regulationInnings: 3,
    isExtra: false,
  }), {
    resolvedWinnerId: null,
    resolvedFinalInning: 5,
    resolvedIsExtra: false,
  })
})

test('tournament completion writes tournament score and winner fields', () => {
  assert.deepEqual(buildGameCompletionPatch({
    isSeasonGame: false,
    winnerId: 'captain-a',
    scores: { a: 7, b: 4 },
    finalInning: 3,
    isExtra: false,
    clearedLiveState: {},
  }), {
    status: 'complete',
    live_state: {},
    winner_player_id: 'captain-a',
    team_a_runs: 7,
    team_b_runs: 4,
    final_inning: 3,
    is_extra_innings: false,
  })
})

test('season completion maps the winning player to its season team', () => {
  assert.deepEqual(buildGameCompletionPatch({
    isSeasonGame: true,
    winnerId: 'captain-b',
    scores: { a: 1, b: 2 },
    finalInning: 4,
    isExtra: true,
    teamIdByPlayerId: { 'captain-b': 'team-22' },
    clearedLiveState: {},
  }), {
    status: 'completed',
    live_state: {},
    winner_team_id: 'team-22',
    away_score: 1,
    home_score: 2,
    final_inning: 4,
    is_extra_innings: true,
  })
})

test('reopen patches retain scores but clear winner and final metadata', () => {
  assert.equal(buildGameReopenPatch({ isSeasonGame: false, scores: { a: 5, b: 3 }, clearedLiveState: {} }).status, 'active')
  assert.deepEqual(buildGameReopenPatch({ isSeasonGame: true, scores: { a: 5, b: 3 }, clearedLiveState: {} }), {
    status: 'in_progress',
    live_state: {},
    winner_team_id: null,
    away_score: 5,
    home_score: 3,
    final_inning: null,
    is_extra_innings: false,
  })
})

test('reset patches preserve source-specific pristine status and score semantics', () => {
  assert.deepEqual(buildGameResetPatch({ isSeasonGame: false }), {
    status: 'pending',
    team_a_runs: 0,
    team_b_runs: 0,
    winner_player_id: null,
    stadium_id: null,
    is_night: false,
    video_url: null,
    live_state: {},
    final_inning: null,
    is_extra_innings: false,
  })
  assert.deepEqual(buildGameResetPatch({ isSeasonGame: true }), {
    status: 'scheduled',
    home_score: null,
    away_score: null,
    winner_team_id: null,
    stadium: null,
    is_night: false,
    video_url: null,
    live_state: {},
    final_inning: null,
    is_extra_innings: false,
  })
})
