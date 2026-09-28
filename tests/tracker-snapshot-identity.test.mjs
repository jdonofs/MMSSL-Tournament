import assert from 'node:assert/strict'
import test from 'node:test'
import { embeddedTrackerSnapshotError } from '../src/utils/trackerSnapshotIdentity.js'

test('a reset game does not show at-bats from the previous tracker session', () => {
  const snapshot = { game: { game_id: 42 }, at_bat_count: 9 }
  assert.match(embeddedTrackerSnapshotError(snapshot, {
    gameId: 42, gameStatus: 'scheduled',
  }), /previous tracker session/)
  assert.equal(embeddedTrackerSnapshotError(snapshot, {
    gameId: 42, gameStatus: 'in_progress',
  }), null)
})

test('the embedded tracker rejects another game but accepts a fresh empty session', () => {
  assert.match(embeddedTrackerSnapshotError({ game: { game_id: 99 }, at_bat_count: 1 }, {
    gameId: 42, gameStatus: 'in_progress',
  }), /recording game #99/)
  assert.equal(embeddedTrackerSnapshotError({ game: { game_id: 42 }, at_bat_count: 0 }, {
    gameId: 42, gameStatus: 'scheduled',
  }), null)
})
