import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLiveGameStateSnapshot,
  getPersistedLiveStateValue,
  hasMeaningfulLiveStatePayload,
  normalizeLiveState,
  serializeLiveStateForComparison,
} from '../src/features/scorebook/domain/liveState.js'

const liveSnapshotDefaults = {
  offense: { inning: 3, isTop: true, battingPlayerId: 'away' },
  currentBatter: { character_id: 7, player_id: 'away' },
  onDeckBatter: null,
  runners: { first: null, second: null, third: null },
  runnersHistory: [],
  outsInHalf: 0,
  balls: 0,
  strikes: 0,
  pitchNumber: 0,
  currentPitcherStint: null,
  activePaNumber: 4,
  paPitchRows: [],
  pendingPA: null,
  pitchActionSheet: null,
  pendingPitchEvent: null,
  inPlayState: null,
  rbiOverlay: null,
  starPitchActive: false,
  starHitUsed: false,
  starHitPending: false,
  starHitConnected: false,
  updatedAt: '2026-08-31T12:00:00.000Z',
}

test('empty live-state payloads do not restore a phantom in-progress game', () => {
  assert.equal(hasMeaningfulLiveStatePayload(null), false)
  assert.equal(hasMeaningfulLiveStatePayload({}), false)
  assert.equal(hasMeaningfulLiveStatePayload([]), false)
  assert.equal(hasMeaningfulLiveStatePayload({ runners: { first: null, second: null, third: null } }), false)
  assert.equal(normalizeLiveState({}), null)
})

test('a runner-only snapshot remains meaningful after normalization', () => {
  const state = normalizeLiveState({
    runners: {
      first: {
        characterId: '12',
        playerId: 'player-a',
        reachedOnError: true,
        chargedToPitcherId: 44,
        chargedToPitcherPlayerId: 'player-b',
      },
    },
  })

  assert.deepEqual(state.runners.first, {
    characterId: 12,
    playerId: 'player-a',
    reachedOnError: true,
    chargedToPitcherId: 44,
    chargedToPitcherPlayerId: 'player-b',
  })
  assert.equal(state.inning, 1)
  assert.equal(state.isTop, false)
})

test('reload restoration accepts database snake-case fields and retains active PA state', () => {
  const liveState = normalizeLiveState({
    inning: '4',
    is_top: true,
    outs_in_half: '2',
    balls: '3',
    strikes: '1',
    pitch_number: '47',
    pitcher_stint_id: 'stint-8',
    pa_number: '19',
    batter_character_id: 7,
    batter_player_id: 'away',
    on_deck_character_id: 8,
    on_deck_player_id: 'away',
    pitcher_character_id: 20,
    pitcher_player_id: 'home',
    runners: { second: { characterId: 9, playerId: 'away' } },
    runnersHistory: [
      { first: { characterId: 9, playerId: 'away' } },
      { second: { characterId: 9, playerId: 'away' } },
    ],
    paPitchRows: [{ result: 'ball' }, { result: 'called_strike' }],
    starHitUsed: true,
    starHitPending: true,
    starHitConnected: false,
    starPitchActive: true,
    updated_at: '2026-08-31T12:00:00.000Z',
  })

  assert.deepEqual(liveState, {
    inning: 4,
    isTop: true,
    outsInHalf: 2,
    balls: 3,
    strikes: 1,
    pitchNumber: 47,
    pitcherStintId: 'stint-8',
    paNumber: 19,
    batterCharacterId: 7,
    batterPlayerId: 'away',
    onDeckCharacterId: 8,
    onDeckPlayerId: 'away',
    pitcherCharacterId: 20,
    pitcherPlayerId: 'home',
    runners: {
      first: null,
      second: { characterId: 9, playerId: 'away' },
      third: null,
    },
    runnersHistory: [
      { first: { characterId: 9, playerId: 'away' }, second: null, third: null },
      { first: null, second: { characterId: 9, playerId: 'away' }, third: null },
    ],
    paPitchRows: [{ result: 'ball' }, { result: 'called_strike' }],
    starHitUsed: true,
    starHitPending: true,
    starHitConnected: false,
    starPitchActive: true,
    updatedAt: '2026-08-31T12:00:00.000Z',
  })
})

test('comparison serialization ignores update timestamps but detects scoring-state changes', () => {
  const base = {
    inning: 2,
    isTop: false,
    balls: 1,
    strikes: 2,
    updatedAt: '2026-08-31T12:00:00.000Z',
  }

  assert.equal(
    serializeLiveStateForComparison(base),
    serializeLiveStateForComparison({ ...base, updatedAt: '2026-08-31T12:00:05.000Z' }),
  )
  assert.notEqual(
    serializeLiveStateForComparison(base),
    serializeLiveStateForComparison({ ...base, balls: 2 }),
  )
})

test('persistence supplies an object only for tables that require a non-null live_state', () => {
  const snapshot = { inning: 2 }
  assert.equal(getPersistedLiveStateValue(null), null)
  assert.deepEqual(getPersistedLiveStateValue(null, true), {})
  assert.equal(getPersistedLiveStateValue(snapshot), snapshot)
})

test('a clean plate appearance produces no live-state snapshot', () => {
  assert.deepEqual(buildLiveGameStateSnapshot(liveSnapshotDefaults), {
    hasLiveContext: false,
    liveState: null,
  })
})

test('outs and runner history keep reload context even when the bases are empty', () => {
  const previousRunner = { characterId: 12, playerId: 'away' }
  const result = buildLiveGameStateSnapshot({
    ...liveSnapshotDefaults,
    outsInHalf: 1,
    runnersHistory: [{ first: previousRunner, second: null, third: null }],
  })

  assert.equal(result.hasLiveContext, true)
  assert.equal(result.liveState.outsInHalf, 1)
  assert.deepEqual(result.liveState.runnersHistory[0].first, previousRunner)
  assert.equal(result.liveState.updatedAt, '2026-08-31T12:00:00.000Z')
})

test('live snapshots discard runners belonging to the defensive team', () => {
  const result = buildLiveGameStateSnapshot({
    ...liveSnapshotDefaults,
    runners: {
      first: { characterId: 12, playerId: 'home' },
      second: { characterId: 13, playerId: 'away' },
      third: null,
    },
  })

  assert.equal(result.liveState.runners.first, null)
  assert.deepEqual(result.liveState.runners.second, { characterId: 13, playerId: 'away' })
})
