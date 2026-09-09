// Odds history: the recorder attached to the authoritative automatic betting
// update path, and the reader that turns what it wrote into a series.
//
// The recorder is exercised through the real `syncTrackerLiveOdds`, against the
// same in-memory database the rest of the betting integration suite uses. No
// Supabase call leaves the machine.
//
// What these tests do NOT prove: the database-level uniqueness that stops two
// concurrent writers appending the same step. That is the unique index in
// migration 20260906180000, and a mocked client cannot demonstrate it. What is
// proved here is that the client never depends on writing a duplicate, and that
// it survives one being rejected.

import assert from 'node:assert/strict'
import test from 'node:test'

import { syncTrackerLiveOdds } from '../scripts/tracker_betting_sync.mjs'
import {
  buildLatestObservationsByKey,
  buildObservationGameContext,
  buildOddsHistoryRows,
  getOddsHistoryTable,
  groupObservationsByMarket,
  isDuplicateObservationError,
  isMissingOddsHistoryTableError,
  summarizeMarketHistory,
} from '../src/utils/oddsHistory.js'
import { loadGameOddsHistory, recordOddsObservations } from '../src/utils/oddsHistoryPersistence.js'
import { GAME_ID, SOURCE_ID, applyLiveState, buildBettingWorld, makePA } from './helpers/bettingFixtures.mjs'

const COMPETITIONS = ['tournament', 'season']

function historyTable(sourceType) {
  return getOddsHistoryTable(sourceType)
}

function historyRows(world) {
  return world.db[historyTable(world.sourceType)] || []
}

function syncOptions(world, live = {}) {
  return {
    ...world.syncArgs,
    ...live,
    expectedPitcherByPlayer: { p1: 12, p2: 22 },
    regulationInnings: 3,
  }
}

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] the first sync records one opening observation per market and no more`, async () => {
    const world = buildBettingWorld(sourceType)

    await syncTrackerLiveOdds(syncOptions(world))
    const first = historyRows(world)
    assert.ok(first.length > 0, 'the first sync records the markets it priced')
    assert.equal(
      new Set(first.map((row) => `${row.bet_type}::${row.target_entity || 'game'}`)).size,
      first.length,
      'one row per market, not one per side',
    )
    assert.ok(first.every((row) => row.previous_observation_id == null), 'nothing preceded the first observation')
    assert.ok(first.every((row) => row.game_id === GAME_ID))

    // An immediate re-run reprices exactly the same board.
    await syncTrackerLiveOdds(syncOptions(world))
    assert.equal(historyRows(world).length, first.length, 'an unchanged market records nothing')
  })

  test(`[${sourceType}] a market that moves appends one observation chained to the last`, async () => {
    const world = buildBettingWorld(sourceType)
    await syncTrackerLiveOdds(syncOptions(world))
    const opening = historyRows(world).find((row) => row.bet_type === 'moneyline')

    // Four runs in the 2nd inning is a genuine change in the live model.
    const live = applyLiveState(world, { inning: 2, isTop: false, awayRuns: 0, homeRuns: 4 })
    world.db[world.tables.pas].push(makePA({ result: 'HR', inning: 1, rbi: 4, playerId: 'p2', characterId: 21 }))
    await syncTrackerLiveOdds(syncOptions(world, live))

    const moneylineRows = historyRows(world).filter((row) => row.bet_type === 'moneyline')
    assert.equal(moneylineRows.length, 2, 'one opening observation and one move')
    assert.equal(moneylineRows[1].previous_observation_id, opening.id, 'each observation names the one it followed')
    assert.notEqual(moneylineRows[1].odds_home, moneylineRows[0].odds_home)
    // Game context travels with the observation.
    assert.equal(moneylineRows[1].inning, 2)
    assert.equal(moneylineRows[1].home_score, 4)
    assert.equal(moneylineRows[1].away_score, 0)
  })

  test(`[${sourceType}] a retry after a write that timed out does not double-record`, async () => {
    // The odds upsert commits and then reports a timeout, so the caller retries
    // the whole sync against a board that is already up to date.
    const world = buildBettingWorld(sourceType, {
      failures: [{ table: sourceType === 'season' ? 'season_game_odds' : 'game_odds', action: 'upsert', mode: 'after', occurrence: 1 }],
    })

    await assert.rejects(() => syncTrackerLiveOdds(syncOptions(world)))
    const afterCrash = historyRows(world).length

    await syncTrackerLiveOdds(syncOptions(world))
    const afterRetry = historyRows(world)
    assert.ok(afterRetry.length > 0, 'the retry records the board it found')
    assert.equal(
      new Set(afterRetry.map((row) => `${row.bet_type}::${row.target_entity || 'game'}`)).size,
      afterRetry.length,
      `a retry must not duplicate a market (had ${afterCrash} before)`,
    )
  })

  test(`[${sourceType}] a database with no history tables still prices and settles normally`, async () => {
    const world = buildBettingWorld(sourceType, {
      failures: [
        {
          table: historyTable(sourceType),
          mode: 'before',
          times: 10,
          error: { code: 'PGRST205', message: `Could not find the table 'public.${historyTable(sourceType)}' in the schema cache` },
        },
      ],
    })

    const messages = []
    const persisted = await syncTrackerLiveOdds({
      ...syncOptions(world),
      logOddsHistory: (message) => messages.push(message),
    })

    assert.ok(persisted.length > 0, 'the board is priced even with no history schema')
    assert.equal(historyRows(world).length, 0)
    assert.equal(messages.length, 1)
    assert.match(messages[0], /odds history table is not present/)
  })

  test(`[${sourceType}] a rejected duplicate append is reported, not thrown`, async () => {
    const world = buildBettingWorld(sourceType, {
      failures: [
        {
          table: historyTable(sourceType),
          action: 'insert',
          mode: 'before',
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        },
      ],
    })

    const messages = []
    const persisted = await syncTrackerLiveOdds({
      ...syncOptions(world),
      logOddsHistory: (message) => messages.push(message),
    })

    assert.ok(persisted.length > 0)
    assert.equal(historyRows(world).length, 0, 'the rejected batch wrote nothing')
    assert.match(messages[0], /returned duplicate/)
  })
}

test('tournament and season history stay in their own tables under one game id', async () => {
  const tournament = buildBettingWorld('tournament')
  const season = buildBettingWorld('season')

  await syncTrackerLiveOdds(syncOptions(tournament))
  await syncTrackerLiveOdds(syncOptions(season))

  assert.ok((tournament.db.game_odds_history || []).length > 0)
  assert.equal((tournament.db.season_game_odds_history || []).length, 0)
  assert.ok((season.db.season_game_odds_history || []).length > 0)
  assert.equal((season.db.game_odds_history || []).length, 0)
  // Both used source id 5 and game id 77 deliberately.
  assert.ok(tournament.db.game_odds_history.every((row) => row.game_id === GAME_ID))
  assert.equal(SOURCE_ID, 5)
})

// ── pure helpers ─────────────────────────────────────────────────────────────

test('a market whose values are unchanged produces no snapshot row', () => {
  const stored = { id: 7, bet_type: 'moneyline', target_entity: null, line: null, odds_home: -140, odds_away: 120, predicted_probability: 0.58, is_locked: false }
  const rows = buildOddsHistoryRows({
    rows: [{ ...stored, updated_at: 'later' }],
    latestByKey: buildLatestObservationsByKey([stored]),
    gameId: 77,
  })
  assert.deepEqual(rows, [])
})

test('a line move and an odds move are both meaningful changes', () => {
  const stored = { id: 7, bet_type: 'over_under', target_entity: null, line: 6.5, odds_over: -110, odds_under: -110 }
  const latestByKey = buildLatestObservationsByKey([stored])

  assert.equal(buildOddsHistoryRows({ rows: [{ ...stored, line: 7.5 }], latestByKey, gameId: 77 }).length, 1)
  assert.equal(buildOddsHistoryRows({ rows: [{ ...stored, odds_over: -125 }], latestByKey, gameId: 77 }).length, 1)
  assert.equal(buildOddsHistoryRows({ rows: [{ ...stored, is_locked: true }], latestByKey, gameId: 77 }).length, 1)
})

test('two characters with the same market type never share a series', () => {
  const rows = [
    { id: 1, bet_type: 'hit_prop', target_entity: 'Mario (Aidan)', line: 1.5, odds_over: -110, observed_at: '2026-07-20T12:00:00.000Z' },
    { id: 2, bet_type: 'hit_prop', target_entity: 'Peach (Donovan)', line: 0.5, odds_over: 120, observed_at: '2026-07-20T12:00:00.000Z' },
    { id: 3, bet_type: 'hit_prop', target_entity: 'Mario (Aidan)', line: 1.5, odds_over: -130, observed_at: '2026-07-20T12:30:00.000Z' },
  ]
  const grouped = groupObservationsByMarket(rows)

  assert.equal(grouped.size, 2)
  assert.equal(grouped.get('hit_prop::Mario (Aidan)').length, 2)
  assert.equal(grouped.get('hit_prop::Peach (Donovan)').length, 1)
})

test('the earliest row is labelled the first recorded observation, not an open', () => {
  const summary = summarizeMarketHistory([
    { id: 1, bet_type: 'moneyline', odds_home: -140, odds_away: 120, observed_at: '2026-07-20T12:00:00.000Z' },
    { id: 2, bet_type: 'moneyline', odds_home: -160, odds_away: 135, observed_at: '2026-07-20T12:30:00.000Z' },
  ], { betType: 'moneyline', labels: { home: 'Donovan', away: 'Aidan' } })

  assert.equal(summary.observationCount, 2)
  assert.equal(summary.first.isFirstRecorded, true)
  assert.equal(summary.latest.isFirstRecorded, false)
  assert.equal(summary.first.sides[0].label, 'Donovan')
  assert.equal(summary.latest.sides[0].delta, -20, '-140 to -160')
  assert.equal(summary.lineChangeCount, 0)
})

test('no odds delta is reported across a line change', () => {
  const summary = summarizeMarketHistory([
    { id: 1, bet_type: 'over_under', line: 6.5, odds_over: -110, odds_under: -110, observed_at: '2026-07-20T12:00:00.000Z' },
    { id: 2, bet_type: 'over_under', line: 7.5, odds_over: -105, odds_under: -115, observed_at: '2026-07-20T12:30:00.000Z' },
  ], { betType: 'over_under' })

  assert.equal(summary.lineChangeCount, 1)
  assert.equal(summary.latest.lineChanged, true)
  assert.equal(summary.latest.previousLine, 6.5)
  assert.equal(summary.latest.sides[0].delta, null, 'a different line is a different proposition')
  assert.equal(summary.latest.sides[0].changed, true)
})

test('a market with no recorded observations summarizes as empty rather than as flat', () => {
  const summary = summarizeMarketHistory([], { betType: 'moneyline' })
  assert.equal(summary.observationCount, 0)
  assert.equal(summary.first, null)
  assert.deepEqual(summary.changes, [])
})

test('observation context is the game state, not a ticket placement context', () => {
  const tournamentContext = buildObservationGameContext({
    team_a_runs: 2, team_b_runs: 3, current_inning: 4, is_top_inning: false, status: 'active',
  })
  assert.deepEqual(tournamentContext, {
    inning: 4, is_top_inning: false, away_score: 2, home_score: 3, game_status: 'active',
  })

  const seasonContext = buildObservationGameContext(
    { away_score: 1, home_score: 0, live_state: { inning: 2, isTop: true }, status: 'in_progress' },
    { isSeason: true },
  )
  assert.deepEqual(seasonContext, {
    inning: 2, is_top_inning: true, away_score: 1, home_score: 0, game_status: 'in_progress',
  })
})

test('a missing table is recognised from either PostgREST shape', () => {
  assert.equal(isMissingOddsHistoryTableError({ code: '42P01', message: 'relation "game_odds_history" does not exist' }), true)
  assert.equal(isMissingOddsHistoryTableError({ code: 'PGRST205', message: "Could not find the table 'public.game_odds_history' in the schema cache" }), true)
  assert.equal(isMissingOddsHistoryTableError({ code: '23505', message: 'duplicate key value' }), false)
  assert.equal(isMissingOddsHistoryTableError(null), false)
  assert.equal(isDuplicateObservationError({ code: '23505' }), true)
})

test('the reader reports an absent table as unavailable rather than as empty history', async () => {
  const world = buildBettingWorld('tournament', {
    failures: [{
      table: 'game_odds_history',
      mode: 'before',
      error: { code: 'PGRST205', message: "Could not find the table 'public.game_odds_history' in the schema cache" },
    }],
  })

  const result = await loadGameOddsHistory({ supabase: world.supabase, sourceType: 'tournament', gameId: GAME_ID })
  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.rows, [])
})

test('an unexpected read failure is reported as an error, not silently as no history', async () => {
  const world = buildBettingWorld('tournament', {
    failures: [{ table: 'game_odds_history', mode: 'before', error: { code: '08006', message: 'connection failure' } }],
  })

  const result = await loadGameOddsHistory({ supabase: world.supabase, sourceType: 'tournament', gameId: GAME_ID })
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, '08006')
})

test('recording nothing is a no-op that does not read the table', async () => {
  const world = buildBettingWorld('tournament')
  const before = world.supabase.operations.length
  const result = await recordOddsObservations({
    supabase: world.supabase, sourceType: 'tournament', gameId: GAME_ID, rows: [],
  })
  assert.equal(result.status, 'ok')
  assert.equal(world.supabase.operations.length, before)
})
