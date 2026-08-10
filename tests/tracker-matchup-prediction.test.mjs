import assert from 'node:assert/strict'
import test from 'node:test'

import {
  predictTrackerMatchup,
  resolveTrackerMatchupForHalf,
} from '../src/utils/trackerMatchupPrediction.js'

const alignments = {
  away: {
    batting: ['Away One', 'Away Two', 'Away Three'],
    fielding: { P: 'Away Pitcher' },
  },
  home: {
    batting: ['Home One', 'Home Two', 'Home Three'],
    fielding: { P: 'Home Pitcher' },
  },
}

test('predicts the next batter and opposing pitcher when the inning changes sides', () => {
  const result = predictTrackerMatchup({
    inning: 2,
    isTop: false,
    teamAPlayerId: 'away',
    teamBPlayerId: 'home',
    alignments,
    lastConfirmedBatterByPlayer: { home: 'Home Two' },
  })

  assert.deepEqual(result.matchup, {
    left: 'Away Pitcher',
    right: 'Home Three',
    inning: 2,
    isTop: false,
    predicted: true,
  })
  assert.equal(result.onDeckName, 'Home One')
})

test('falls back to completed team plate appearances when no confirmed cursor exists', () => {
  const result = predictTrackerMatchup({
    inning: 2,
    isTop: true,
    teamAPlayerId: 'away',
    teamBPlayerId: 'home',
    alignments,
    plateAppearances: [
      { player_id: 'away' },
      { player_id: 'home' },
      { player_id: 'away' },
      { player_id: 'away' },
      { player_id: 'away' },
    ],
  })

  assert.equal(result.matchup.left, 'Home Pitcher')
  assert.equal(result.matchup.right, 'Away Two')
  assert.equal(result.onDeckName, 'Away Three')
})

test('replaces the previous half inning matchup but yields to a current tracker matchup', () => {
  const common = {
    inning: 2,
    isTop: false,
    teamAPlayerId: 'away',
    teamBPlayerId: 'home',
    alignments,
    lastConfirmedBatterByPlayer: { home: 'Home One' },
  }
  const stale = resolveTrackerMatchupForHalf({
    ...common,
    existingMatchup: {
      left: 'Home Pitcher',
      right: 'Away Three',
      inning: 2,
      isTop: true,
      predicted: false,
    },
  })
  assert.equal(stale.matchup.left, 'Away Pitcher')
  assert.equal(stale.matchup.right, 'Home Two')
  assert.equal(stale.matchup.predicted, true)

  const authoritative = resolveTrackerMatchupForHalf({
    ...common,
    existingMatchup: {
      left: 'Away One',
      right: 'Home Three',
      inning: 2,
      isTop: false,
      predicted: false,
    },
  })
  assert.equal(authoritative.matchup.left, 'Away One')
  assert.equal(authoritative.matchup.right, 'Home Three')
  assert.equal(authoritative.matchup.predicted, false)
  assert.equal(authoritative.onDeckName, 'Home One')
})

test('recognizes a legacy current-half matchup by participant sides', () => {
  const current = resolveTrackerMatchupForHalf({
    existingMatchup: { left: 'Away Pitcher', right: 'Home One' },
    inning: 1,
    isTop: false,
    teamAPlayerId: 'away',
    teamBPlayerId: 'home',
    alignments,
  })

  assert.equal(current.matchup.left, 'Away Pitcher')
  assert.equal(current.matchup.right, 'Home One')
  assert.equal(current.matchup.predicted, false)
})
