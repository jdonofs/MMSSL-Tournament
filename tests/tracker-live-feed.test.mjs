import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTrackerLiveStateToGame,
  buildLiveMarketState,
  buildTrackerGameSignature,
  buildTrackerMarketInputSignature,
  resolveTrackerScore,
} from '../src/utils/trackerLiveFeed.js'
import { buildTrackerBetResolutionConfig } from '../scripts/tracker_betting_sync.mjs'
import {
  applyPaDerivedTrackerInningState,
  applyTrackerInningStateMessage,
  captureTrackerPutout,
  consumeTrackerPitch,
  isTrackerMissingPlayerName,
  isTrackerReplayMessage,
  markPendingTrackerStarPitch,
  parseTrackerPutoutMessage,
  parseTrackerStarPitchMessage,
  shouldCreditTrackerPutout,
  trackerOutsOnPlay,
  trackerPitchStatFields,
  trackerStarPitchPaFlags,
} from '../scripts/tracker_play_events.mjs'

test('keeps explicit tracker inning state when PA outs are one short', () => {
  const state = { inning: 1, isTop: false, outs: 2 }
  const messages = [
    'Stat tracking paused for replay.',
    'Replay ended. Resuming stat tracking.',
    'Changing sides!',
    'Next: Top of inning 2',
    '0 outs',
  ]
  messages.forEach((message) => applyTrackerInningStateMessage(state, message))

  assert.deepEqual({ inning: state.inning, isTop: state.isTop, outs: state.outs }, {
    inning: 2,
    isTop: true,
    outs: 0,
  })
  assert.deepEqual(applyPaDerivedTrackerInningState(state, 5, {
    hasExplicitTrackerState: true,
  }), { applied: false, halfChanged: false })
  assert.deepEqual({ inning: state.inning, isTop: state.isTop, outs: state.outs }, {
    inning: 2,
    isTop: true,
    outs: 0,
  })
})

test('uses PA outs as an inning-state fallback before tracker state arrives', () => {
  const state = { inning: 1, isTop: true, outs: 0 }
  assert.deepEqual(applyPaDerivedTrackerInningState(state, 5), {
    applied: true,
    halfChanged: true,
  })
  assert.deepEqual({ inning: state.inning, isTop: state.isTop, outs: state.outs }, {
    inning: 1,
    isTop: false,
    outs: 2,
  })
})

test('counts and credits a baserunner putout even when the batter records a hit', () => {
  const buffer = {
    batterName: 'Wario',
    result: null,
    putoutFielderName: null,
    observedPutouts: [],
  }
  const putout = captureTrackerPutout(buffer, 'Blue Dry Bones put Bowser out!')
  assert.deepEqual({ fielderName: putout.fielderName, runnerName: putout.runnerName }, {
    fielderName: 'Blue Dry Bones',
    runnerName: 'Bowser',
  })
  buffer.result = '3B'
  assert.equal(buffer.putoutFielderName, 'Blue Dry Bones')
  assert.equal(trackerOutsOnPlay(buffer, 0), 1)
})

test('keeps a named putout without inferring a Nice Play from replay messages', () => {
  const buffer = {
    batterName: 'Green Paratroopa',
    result: 'FO',
    putoutFielderName: null,
    isNicePlay: false,
  }

  const putout = parseTrackerPutoutMessage('Red Pianta put Green Paratroopa out!')
  assert.deepEqual(putout, {
    fielderName: 'Red Pianta',
    runnerName: 'Green Paratroopa',
  })
  assert.equal(shouldCreditTrackerPutout({
    runnerName: putout.runnerName,
    batterName: buffer.batterName,
    result: buffer.result,
  }), true)
  buffer.putoutFielderName = putout.fielderName

  assert.equal(isTrackerReplayMessage('Stat tracking paused for replay.'), true)
  assert.equal(isTrackerReplayMessage('Replay ended. Resuming stat tracking.'), true)
  assert.equal(buffer.putoutFielderName, 'Red Pianta')
  assert.equal(buffer.isNicePlay, false)
})

test('does not treat ordinary pause messages as replay metadata', () => {
  assert.equal(isTrackerReplayMessage('Game paused...'), false)
})

test('records Wario star pitching from the tracker announcement on the following pitch', () => {
  const buffer = {
    pitcherName: 'Wario',
    pendingStarPitch: false,
  }

  const firstPitch = consumeTrackerPitch(buffer, {
    type: 'swinging_miss',
    before: { balls: 0, strikes: 0 },
    after: { balls: 0, strikes: 1 },
  })
  assert.equal(firstPitch.isStarPitch, false)

  assert.equal(parseTrackerStarPitchMessage('Wario used a star pitch!'), 'Wario')
  assert.equal(markPendingTrackerStarPitch(buffer, 'Wario used a star pitch!'), true)
  const starPitch = consumeTrackerPitch(buffer, {
    type: 'swinging_miss',
    before: { balls: 0, strikes: 1 },
    after: { balls: 0, strikes: 2 },
  })

  assert.equal(starPitch.isStarPitch, true)
  assert.equal(buffer.pendingStarPitch, false)

  assert.deepEqual(trackerPitchStatFields(starPitch), {
    is_star_pitch: true,
    result: 'swinging_miss',
    count_balls_before: 0,
    count_strikes_before: 1,
    count_balls_after: 0,
    count_strikes_after: 2,
    pitch_type: null,
  })
})

test('only marks a plate appearance when the decisive pitch was a star pitch', () => {
  assert.deepEqual(trackerStarPitchPaFlags([
    { isStarPitch: false },
    { isStarPitch: true },
  ], 1), {
    starPitchUsed: true,
    starPitchSuccessful: true,
  })
  assert.deepEqual(trackerStarPitchPaFlags([
    { isStarPitch: true },
    { isStarPitch: false },
  ], 1), {
    starPitchUsed: false,
    starPitchSuccessful: false,
  })
})

test('retains the fielder when a caught star swing reports No Player as the out runner', () => {
  assert.deepEqual(parseTrackerPutoutMessage('Fire Bro. put No Player out!'), {
    fielderName: 'Fire Bro.',
    runnerName: 'No Player',
  })
  assert.equal(isTrackerMissingPlayerName('No Player'), true)
  assert.equal(isTrackerMissingPlayerName('Red Pianta'), false)
  assert.equal(shouldCreditTrackerPutout({
    runnerName: 'No Player',
    batterName: 'Red Pianta',
    result: 'FO',
  }), true)
  assert.equal(shouldCreditTrackerPutout({
    runnerName: 'No Player',
    batterName: 'Red Pianta',
    result: null,
  }), false)
  assert.equal(shouldCreditTrackerPutout({
    runnerName: 'Tiny Kong',
    batterName: 'Red Pianta',
    result: 'FO',
  }), false)
})

test('resolves patched tracker score names from lineup alignment suffixes', () => {
  const trackerStats = {
    live_feed: {
      inning: 2,
      isTop: true,
      outs: 0,
      score: { 'Mario Fireballs': 3, 'Wario Muscles': 0 },
      alignments: {
        p1: { teamName: 'Fireballs' },
        p2: { teamName: 'Muscles' },
      },
    },
  }

  assert.deepEqual(resolveTrackerScore({ trackerStats, teamAPlayerId: 'p1', teamBPlayerId: 'p2' }), {
    teamARuns: 3,
    teamBRuns: 0,
    teamAName: 'Mario Fireballs',
    teamBName: 'Wario Muscles',
    sideByScoreName: { 'Mario Fireballs': 'A', 'Wario Muscles': 'B' },
  })
})

test('overlays tracker score, inning, count, outs, and runners onto a season game', () => {
  const game = {
    id: 8,
    stats_source: 'tracker',
    away_score: 0,
    home_score: 0,
    team_a_runs: 0,
    team_b_runs: 0,
    team_a_player_id: 'p1',
    team_b_player_id: 'p2',
  }
  const trackerStats = {
    updated_at: '2026-08-10T12:00:00.000Z',
    team_mapping: { 'Mario Fireballs': 'A', 'Wario Muscles': 'B' },
    live_feed: {
      inning: 2,
      isTop: true,
      outs: 1,
      balls: 2,
      strikes: 1,
      score: { 'Mario Fireballs': 3, 'Wario Muscles': 0 },
      runners: { first: { characterId: 1 }, second: null, third: { characterId: 3 } },
    },
  }

  const overlaid = applyTrackerLiveStateToGame(game, trackerStats, { isSeason: true })
  assert.equal(overlaid.away_score, 3)
  assert.equal(overlaid.home_score, 0)
  assert.equal(overlaid.current_inning, 2)
  assert.equal(overlaid.is_top_inning, true)
  assert.equal(overlaid.live_state.outsInHalf, 1)
  assert.equal(overlaid.live_state.balls, 2)
  assert.equal(overlaid.live_state.strikes, 1)
  assert.equal(buildLiveMarketState(overlaid, []).runnersOccupied, 2)
})

test('a single explicit mapping safely identifies the other club in a two-team feed', () => {
  const result = resolveTrackerScore({
    trackerStats: {
      team_mapping: { 'Mario Fireballs': 'A' },
      live_feed: { score: { 'Mario Fireballs': 3, 'Wario Muscles': 0 } },
    },
  })
  assert.equal(result.teamARuns, 3)
  assert.equal(result.teamBRuns, 0)
})

test('side-keyed live totals override stale named scoreboard lines within a half inning', () => {
  const result = resolveTrackerScore({
    trackerStats: {
      team_mapping: { 'Mario Fireballs': 'A', 'Wario Muscles': 'B' },
      live_feed: {
        score: { 'Mario Fireballs': 3, 'Wario Muscles': 0 },
        scoreBySide: { a: 3, b: 2 },
      },
    },
  })
  assert.equal(result.teamARuns, 3)
  assert.equal(result.teamBRuns, 2)
})

test('legacy snapshots cannot regress a newer live game-row score', () => {
  const game = {
    stats_source: 'tracker',
    away_score: 3,
    home_score: 2,
    team_a_runs: 3,
    team_b_runs: 2,
  }
  const trackerStats = {
    team_mapping: { 'Mario Fireballs': 'A', 'Wario Muscles': 'B' },
    live_feed: { score: { 'Mario Fireballs': 3, 'Wario Muscles': 0 } },
  }
  const overlaid = applyTrackerLiveStateToGame(game, trackerStats, { isSeason: true })
  assert.equal(overlaid.away_score, 3)
  assert.equal(overlaid.home_score, 2)
})

test('tracker betting settlement uses the authenticated bridge client and source tables', () => {
  const bridgeClient = { from() {} }
  const config = buildTrackerBetResolutionConfig({
    supabase: bridgeClient,
    sourceType: 'season',
    sourceId: 12,
  })
  assert.equal(config.supabaseClient, bridgeClient)
  assert.equal(config.betsTable, 'season_bets')
  assert.equal(config.gameOddsTable, 'season_game_odds')
  assert.equal(config.sourceIdValue, 12)
})

test('odds input signature changes once per completed at-bat, not per pitch', () => {
  const base = {
    scoreState: { a: 4, b: 2 },
    liveState: {
      inning: 3,
      isTop: true,
      outsInHalf: 1,
      balls: 0,
      strikes: 0,
      pitchNumber: 10,
      batterCharacterId: 16,
      batterPlayerId: 'away',
      pitcherCharacterId: 3,
      pitcherPlayerId: 'home',
      runners: { first: null, second: null, third: null },
      lastEvent: 'Count: 0-0',
      lastEventAt: '2026-08-10T17:08:16.000Z',
      updatedAt: '2026-08-10T17:08:16.100Z',
    },
    expectedPitcherByPlayer: { home: 3 },
    completedPaRevision: 25,
  }
  const paused = {
    ...base,
    liveState: {
      ...base.liveState,
      lastEvent: 'Game paused...',
      lastEventAt: '2026-08-10T17:08:18.652Z',
      updatedAt: '2026-08-10T17:08:19.335Z',
    },
  }
  const nextPitchAndBatter = {
    ...paused,
    liveState: {
      ...paused.liveState,
      balls: 1,
      pitchNumber: 11,
      batterCharacterId: 17,
      batterPlayerId: 'away',
      paNumber: 26,
      lastEvent: 'Count: 1-0',
    },
  }
  const completedAtBat = {
    ...nextPitchAndBatter,
    completedPaRevision: 26,
  }
  const pitchingChange = {
    ...base,
    liveState: {
      ...base.liveState,
      pitcherCharacterId: 8,
    },
  }

  assert.equal(buildTrackerMarketInputSignature(paused), buildTrackerMarketInputSignature(base))
  assert.equal(buildTrackerMarketInputSignature(nextPitchAndBatter), buildTrackerMarketInputSignature(base))
  assert.notEqual(buildTrackerMarketInputSignature(completedAtBat), buildTrackerMarketInputSignature(base))
  assert.notEqual(buildTrackerMarketInputSignature(pitchingChange), buildTrackerMarketInputSignature(base))
})

test('browser odds fallback signature ignores pitch ticks and tracker heartbeats', () => {
  const game = {
    id: 2511,
    team_a_runs: 3,
    team_b_runs: 0,
    live_state: {
      inning: 1,
      isTop: true,
      outsInHalf: 1,
      balls: 0,
      strikes: 0,
      pitcherCharacterId: 58,
      pitcherPlayerId: 'home',
      updatedAt: '2026-08-10T17:37:50.000Z',
      runners: { first: null, second: null, third: null },
    },
  }
  const pitching = [{
    id: 621,
    character_id: 58,
    innings_pitched: 0.1,
    hits_allowed: 3,
    runs_allowed: 3,
    walks: 0,
    strikeouts: 1,
    pitches_thrown: 12,
  }]
  const afterTwoStrikes = {
    ...game,
    live_state: {
      ...game.live_state,
      strikes: 2,
      pitchNumber: 14,
      updatedAt: '2026-08-10T17:38:00.946Z',
    },
  }
  const pitchingAfterTwoStrikes = [{ ...pitching[0], pitches_thrown: 14 }]
  const completedPa = [{ id: 99, result: 'K', rbi: 0, run_scored: false, outs_on_play: 1 }]

  assert.equal(
    buildTrackerGameSignature(afterTwoStrikes, [], pitchingAfterTwoStrikes),
    buildTrackerGameSignature(game, [], pitching),
  )
  assert.notEqual(
    buildTrackerGameSignature(afterTwoStrikes, completedPa, pitchingAfterTwoStrikes),
    buildTrackerGameSignature(game, [], pitching),
  )
})
