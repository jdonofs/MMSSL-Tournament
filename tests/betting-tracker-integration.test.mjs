// Tracker -> market -> settlement integration suite.
//
// Every test drives the real betting functions (`syncTrackerLiveOdds`,
// `settleCompletedTrackerGame`, `resolveOnPA`, `resolveGameBets`,
// `reopenGameBets`) against an in-memory database. Nothing here touches
// Supabase, places a real bet, or moves a real balance.
//
// Both competition types run the same scenarios against the same numeric source
// id and game id, because tournament/season isolation is by table alone.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTrackerBetResolutionConfig,
  settleCompletedTrackerGame,
  syncTrackerLiveOdds,
} from '../scripts/tracker_betting_sync.mjs'
import { reopenGameBets, resolveGameBets, resolveOnPA } from '../src/utils/betResolution.js'
import { buildOddsRowKey } from '../src/utils/oddsEngine.js'
import {
  GAME_ID,
  LABELS,
  LEDGER_CHANGE_FIELD,
  PRIOR_GAME_ID,
  SOURCE_ID,
  SOURCE_ID_FIELD,
  applyLiveState,
  betsById,
  buildBettingWorld,
  entityLabel,
  ledgerNet,
  ledgerRowsFor,
  makeBet,
  makePA,
  makePitchingStint,
  makePlacementLedger,
  makeRunScored,
  oddsRows,
  tablesFor,
} from './helpers/bettingFixtures.mjs'

const COMPETITIONS = ['tournament', 'season']
const EXPECTED_PITCHERS = { p1: 12, p2: 22 }

function syncOptions(world, live = {}) {
  return {
    ...world.syncArgs,
    ...live,
    expectedPitcherByPlayer: EXPECTED_PITCHERS,
    regulationInnings: 3,
  }
}

function resolutionConfig(world, supabase = world.supabase) {
  return buildTrackerBetResolutionConfig({
    supabase,
    sourceType: world.sourceType,
    sourceId: world.sourceId,
  })
}

function impliedProbability(americanOdds) {
  const odds = Number(americanOdds)
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100)
}

function marketSides(row) {
  if (row.odds_home != null) return [row.odds_home, row.odds_away]
  if (row.odds_over != null) return [row.odds_over, row.odds_under]
  return [row.odds_yes, row.odds_no]
}

function settledLedgerByBet(world) {
  return Object.fromEntries(ledgerRowsFor(world).map((row) => [row.bet_id, Number(row[world.ledgerChangeField])]))
}

async function expectRejection(fn, matcher) {
  let caught = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'expected the call to fail')
  const message = String(caught.message || caught)
  assert.match(message, matcher, `unexpected failure message: ${message}`)
  return caught
}

// ── Pregame markets go live with the right identities ───────────────────────

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] pregame markets open with the correct home/away teams and character identities`, async () => {
    const world = buildBettingWorld(sourceType)
    const live = applyLiveState(world, { inning: 1, isTop: true, status: sourceType === 'season' ? 'scheduled' : 'pending' })
    const persisted = await syncTrackerLiveOdds(syncOptions(world, live))

    assert.equal(persisted.length, 14, 'the full board should be written once')
    const rows = oddsRows(world)
    assert.deepEqual(
      [...new Set(rows.map((row) => row.bet_type))].sort(),
      ['first_inning_run', 'hit_prop', 'hr_prop', 'k_prop', 'moneyline', 'over_under', 'run_line'],
    )

    // Home is team B / the home_team_id side; away is team A / away_team_id.
    // Every prop is keyed `Character (Player)` for the player who owns them.
    assert.deepEqual(
      oddsRows(world, 'hit_prop').map((row) => row.target_entity).sort(),
      [LABELS.daisy, LABELS.luigi, LABELS.mario, LABELS.peach].sort(),
    )
    // The lineup-designated pitcher wins over the roster-order fallback.
    assert.deepEqual(
      oddsRows(world, 'k_prop').map((row) => row.target_entity).sort(),
      [LABELS.daisy, LABELS.luigi].sort(),
    )
    assert.equal(oddsRows(world, 'k_prop').every((row) => row.line > 0), true)

    // Every market opens unlocked and priced on both sides.
    rows.forEach((row) => {
      assert.equal(row.is_locked, false, `${buildOddsRowKey(row)} should open unlocked`)
      marketSides(row).forEach((odds) => assert.ok(Number.isFinite(Number(odds)), `${buildOddsRowKey(row)} missing a price`))
    })
  })

  test(`[${sourceType}] every two-sided market keeps probabilities in bounds and prices complementary sides with a house edge`, async () => {
    const world = buildBettingWorld(sourceType)
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))

    oddsRows(world).forEach((row) => {
      const probability = Number(row.predicted_probability)
      assert.ok(probability > 0 && probability < 1, `${buildOddsRowKey(row)} probability out of bounds: ${probability}`)
      const [sideA, sideB] = marketSides(row)
      const total = impliedProbability(sideA) + impliedProbability(sideB)
      assert.ok(total > 1, `${buildOddsRowKey(row)} is arbitrageable: implied total ${total}`)
      assert.ok(total < 1.35, `${buildOddsRowKey(row)} overround is implausible: ${total}`)
    })
  })
}

// ── Live updates move markets without duplicating rows ──────────────────────

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] a new PA reprices the board without adding a second odds row for any market`, async () => {
    const world = buildBettingWorld(sourceType)
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))
    const openingKeys = oddsRows(world).map(buildOddsRowKey).sort()
    const openingIds = Object.fromEntries(oddsRows(world).map((row) => [buildOddsRowKey(row), row.id]))
    const openingMarioHit = { ...oddsRows(world, 'hit_prop').find((row) => row.target_entity === LABELS.mario) }

    world.db[world.tables.pas].push(makePA({ result: '1B', inning: 1, characterId: 11, playerId: 'p1' }))
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1, outs: 0 })))

    const afterKeys = oddsRows(world).map(buildOddsRowKey).sort()
    assert.deepEqual(afterKeys, openingKeys, 'the market set must not grow')
    assert.equal(new Set(afterKeys).size, afterKeys.length, 'no duplicate market rows')
    oddsRows(world).forEach((row) => {
      assert.equal(row.id, openingIds[buildOddsRowKey(row)], `${buildOddsRowKey(row)} was re-inserted instead of updated`)
    })

    // The saved hit changes the current count and the balanced live line.
    const marioHit = oddsRows(world, 'hit_prop').find((row) => row.target_entity === LABELS.mario)
    assert.equal(marioHit.prop_current_count, 1)
    assert.ok(marioHit.line > openingMarioHit.line)
    assert.notEqual(marioHit.odds_over, openingMarioHit.odds_over)
  })

  test(`[${sourceType}] repeating a sync with unchanged tracker state writes nothing`, async () => {
    const world = buildBettingWorld(sourceType)
    const live = applyLiveState(world, { inning: 1 })
    await syncTrackerLiveOdds(syncOptions(world, live))
    const writesAfterFirst = world.supabase.operations.filter((op) => op.table === world.tables.odds && op.action !== 'select').length

    const second = await syncTrackerLiveOdds(syncOptions(world, live))
    const writesAfterSecond = world.supabase.operations.filter((op) => op.table === world.tables.odds && op.action !== 'select').length

    assert.deepEqual(second, [], 'an unchanged board must persist nothing')
    assert.equal(writesAfterSecond, writesAfterFirst)
    assert.equal(oddsRows(world).length, 14)
  })

  test(`[${sourceType}] an accepted bet keeps its original line, odds and payout after the market moves`, async () => {
    const accepted = makeBet(sourceType, {
      id: 1,
      bet_type: 'hr_prop',
      target_entity: LABELS.mario,
      chosen_side: 'over',
      line: 0.5,
      odds: 900,
      predicted_probability: 0.1,
      wager_dollars: 10,
      potential_payout_dollars: 90,
    })
    const world = buildBettingWorld(sourceType, { bets: [accepted], ledger: makePlacementLedger(sourceType, [accepted]) })
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))

    world.db[world.tables.pas].push(makePA({ result: 'HR', inning: 1, rbi: 1, characterId: 11, playerId: 'p1' }))
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1, awayRuns: 1 })))

    // The board moved to over 1.5 ...
    assert.equal(oddsRows(world, 'hr_prop').find((row) => row.target_entity === LABELS.mario).line, 1.5)
    // ... and the ticket did not.
    const stored = betsById(world)[1]
    assert.equal(stored.line, 0.5)
    assert.equal(stored.odds, 900)
    assert.equal(stored.potential_payout_dollars, 90)
    assert.equal(stored.wager_dollars, 10)
    assert.equal(stored.status, 'open')

    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 1, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1',
    })
    // Graded against the accepted line of 0.5, not the board's 1.5.
    assert.equal(betsById(world)[1].status, 'won')
    assert.equal(settledLedgerByBet(world)[1], 100)
  })
}

// ── Props against already-recorded totals ───────────────────────────────────

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] hit, HR and strikeout props settle against the totals already recorded when the ticket was taken`, async () => {
    const bets = [
      // Taken after Mario's first hit, so the line already sits above it.
      makeBet(sourceType, { id: 1, bet_type: 'hit_prop', target_entity: LABELS.mario, chosen_side: 'over', line: 1.5, wager_dollars: 10, potential_payout_dollars: 20 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'hit_prop', target_entity: LABELS.mario, chosen_side: 'under', line: 1.5, wager_dollars: 10, potential_payout_dollars: 8 }),
      makeBet(sourceType, { id: 3, bet_type: 'hr_prop', target_entity: LABELS.peach, chosen_side: 'over', line: 0.5, wager_dollars: 10, potential_payout_dollars: 30 }),
      makeBet(sourceType, { id: 4, bet_type: 'k_prop', target_entity: LABELS.daisy, chosen_side: 'over', line: 3.5, wager_dollars: 10, potential_payout_dollars: 15 }),
      makeBet(sourceType, { id: 5, player_id: 'p2', bet_type: 'k_prop', target_entity: LABELS.daisy, chosen_side: 'under', line: 3.5, wager_dollars: 10, potential_payout_dollars: 12 }),
    ]
    const world = buildBettingWorld(sourceType, {
      bets,
      ledger: makePlacementLedger(sourceType, bets),
      pas: [
        makePA({ result: '1B', inning: 1, characterId: 11, playerId: 'p1' }),
        makePA({ result: '2B', inning: 2, characterId: 11, playerId: 'p1' }),
        // A hit-shaped play scored as an error is not a credited hit.
        makePA({ result: '1B', inning: 3, characterId: 11, playerId: 'p1', isError: true }),
        makePA({ result: 'OUT', inning: 1, characterId: 21, playerId: 'p2' }),
      ],
      pitching: [makePitchingStint({ playerId: 'p2', characterId: 22, strikeouts: 4, inningsPitched: 3 })],
    })

    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 2, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1',
    })

    const graded = betsById(world)
    // Mario finished with 2 credited hits: over 1.5 wins, under loses.
    assert.equal(graded[1].status, 'won')
    assert.equal(graded[2].status, 'lost')
    // Peach never homered: over 0.5 loses.
    assert.equal(graded[3].status, 'lost')
    // Daisy struck out 4: over 3.5 wins, under loses.
    assert.equal(graded[4].status, 'won')
    assert.equal(graded[5].status, 'lost')

    const settled = settledLedgerByBet(world)
    assert.deepEqual(settled, { 1: 30, 4: 25 }, 'only winners get a settled credit; losers keep the placement debit')
    assert.equal(ledgerNet(world, 'p1'), 25, 'p1: -30 wagered, +55 returned')
    assert.equal(ledgerNet(world, 'p2'), -20, 'p2: two losing $10 tickets')
  })
}

// ── The first-inning window ─────────────────────────────────────────────────

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] a scoreless first inning closes the market and settles "no" on the first inning-2 play`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'first_inning_run', chosen_side: 'yes', wager_dollars: 10, potential_payout_dollars: 12 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'first_inning_run', chosen_side: 'no', wager_dollars: 10, potential_payout_dollars: 8 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))
    assert.equal(oddsRows(world, 'first_inning_run')[0].is_locked, false, 'the market is open during inning 1')

    // Three scoreless outs in inning 1, then the first play of inning 2.
    const inningOne = [
      makePA({ result: 'OUT', inning: 1, characterId: 11, playerId: 'p1' }),
      makePA({ result: 'K', inning: 1, characterId: 12, playerId: 'p1' }),
      makePA({ result: 'OUT', inning: 1, characterId: 21, playerId: 'p2', isTop: false }),
    ]
    world.db[world.tables.pas].push(...inningOne)
    const inningTwoPA = makePA({ result: 'OUT', inning: 2, characterId: 11, playerId: 'p1' })
    world.db[world.tables.pas].push(inningTwoPA)

    await resolveOnPA(world.gameId, inningTwoPA, resolutionConfig(world))

    const graded = betsById(world)
    assert.equal(graded[1].status, 'lost')
    assert.equal(graded[2].status, 'won')
    assert.equal(oddsRows(world, 'first_inning_run')[0].is_locked, true)
    assert.deepEqual(settledLedgerByBet(world), { 2: 18 }, 'the "no" ticket gets wager + payout back')
    assert.equal(ledgerNet(world), -2)

    // Repricing after the window closed must leave the market closed.
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 2 })))
    assert.equal(oddsRows(world, 'first_inning_run')[0].is_locked, true)
  })

  test(`[${sourceType}] a first-inning run closes the market immediately and repricing cannot reopen it`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'first_inning_run', chosen_side: 'yes', wager_dollars: 10, potential_payout_dollars: 12 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'first_inning_run', chosen_side: 'no', wager_dollars: 10, potential_payout_dollars: 8 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))

    const scoringPA = makePA({ result: 'HR', inning: 1, rbi: 1, characterId: 11, playerId: 'p1' })
    world.db[world.tables.pas].push(scoringPA)
    world.db[world.tables.runs].push(makeRunScored({ paId: scoringPA.id, inning: 1 }))
    await resolveOnPA(world.gameId, scoringPA, resolutionConfig(world))

    // The outcome is known, so no new ticket may be taken — but settlement
    // still waits for the confirming next play.
    assert.equal(oddsRows(world, 'first_inning_run')[0].is_locked, true)
    assert.equal(betsById(world)[1].status, 'open')
    assert.equal(ledgerRowsFor(world).length, 0)

    // The bridge reprices on the same completed play. Regeneration must not
    // hand back a market whose result is already decided.
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1, awayRuns: 1 })))
    assert.equal(
      oddsRows(world, 'first_inning_run')[0].is_locked,
      true,
      'repricing reopened a first-inning market whose run had already scored',
    )

    const nextPA = makePA({ result: 'OUT', inning: 1, characterId: 12, playerId: 'p1' })
    world.db[world.tables.pas].push(nextPA)
    await resolveOnPA(world.gameId, nextPA, resolutionConfig(world))
    assert.equal(betsById(world)[1].status, 'won')
    assert.equal(betsById(world)[2].status, 'lost')
    assert.deepEqual(settledLedgerByBet(world), { 1: 22 })
    assert.equal(ledgerNet(world), 2)
  })

  test(`[${sourceType}] a lock set by hand survives the next tracker reprice`, async () => {
    const world = buildBettingWorld(sourceType)
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))
    const moneyline = oddsRows(world, 'moneyline')[0]
    moneyline.is_locked = true

    world.db[world.tables.pas].push(makePA({ result: '1B', inning: 1, characterId: 11, playerId: 'p1' }))
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))

    assert.equal(oddsRows(world, 'moneyline')[0].is_locked, true)
  })

  test(`[${sourceType}] an inning-2 play cannot settle "no runs" while inning 1 has not been published`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'first_inning_run', chosen_side: 'yes', wager_dollars: 10, potential_payout_dollars: 12 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'first_inning_run', chosen_side: 'no', wager_dollars: 10, potential_payout_dollars: 8 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })

    // The inning-2 play is durable; inning 1's plays and their run children are
    // not on record yet.
    const inningTwoPA = makePA({ result: 'OUT', inning: 2, characterId: 11, playerId: 'p1' })
    world.db[world.tables.pas].push(inningTwoPA)
    const updates = await resolveOnPA(world.gameId, inningTwoPA, resolutionConfig(world))

    assert.deepEqual(updates, [], 'nothing may settle off an unpublished first inning')
    assert.equal(betsById(world)[1].status, 'open')
    assert.equal(betsById(world)[2].status, 'open')
    assert.equal(ledgerRowsFor(world).length, 0)

    // Once inning 1 lands, the same confirming play settles it correctly.
    const scoringPA = makePA({ result: 'HR', inning: 1, rbi: 1, characterId: 11, playerId: 'p1' })
    world.db[world.tables.pas].push(scoringPA)
    world.db[world.tables.runs].push(makeRunScored({ paId: scoringPA.id, inning: 1 }))
    await resolveOnPA(world.gameId, inningTwoPA, resolutionConfig(world))
    assert.equal(betsById(world)[1].status, 'won')
    assert.equal(betsById(world)[2].status, 'lost')
    assert.equal(ledgerNet(world), 2)
  })
}

// ── Settlement durability ───────────────────────────────────────────────────

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] a timeout after the bet-status write commits is reconciled on the next attempt`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 15 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 10, potential_payout_dollars: 15 }),
    ]
    const world = buildBettingWorld(sourceType, {
      bets,
      ledger: makePlacementLedger(sourceType, bets),
      failures: [{ table: world_bets_table(sourceType), action: 'update', mode: 'after', times: 1 }],
    })
    const args = { ...world.syncArgs, teamARuns: 1, teamBRuns: 4, teamBPlayerId: 'p2', winnerPlayerId: 'p2' }

    await expectRejection(() => settleCompletedTrackerGame(args), /timeout after commit/)
    // The status write landed; the payout did not.
    assert.equal(betsById(world)[1].status, 'won')
    assert.equal(ledgerRowsFor(world).length, 0)

    await settleCompletedTrackerGame(args)
    assert.deepEqual(settledLedgerByBet(world), { 1: 25 })
    assert.equal(ledgerNet(world), 5)
  })

  test(`[${sourceType}] a timeout after the ledger write commits leaves no credit on a reopened bet and reconciles on retry`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 15 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 10, potential_payout_dollars: 15 }),
    ]
    const world = buildBettingWorld(sourceType, {
      bets,
      ledger: makePlacementLedger(sourceType, bets),
      failures: [{ table: world_ledger_table(sourceType), action: 'upsert', mode: 'after', times: 1 }],
    })
    const args = { ...world.syncArgs, teamARuns: 1, teamBRuns: 4, teamBPlayerId: 'p2', winnerPlayerId: 'p2' }

    await expectRejection(() => settleCompletedTrackerGame(args), /timeout after commit/)
    // Rolled back to open — and the credit that did commit was withdrawn with
    // it, so no balance is inflated while the bet is unsettled.
    assert.equal(betsById(world)[1].status, 'open')
    assert.equal(ledgerRowsFor(world).length, 0)
    assert.equal(ledgerNet(world), -20)

    await settleCompletedTrackerGame(args)
    assert.deepEqual(settledLedgerByBet(world), { 1: 25 })
    assert.equal(ledgerNet(world), 5)
  })

  test(`[${sourceType}] repeated settlement calls leave balances and ledger entries untouched after the first success`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'home', odds: -150, wager_dollars: 10, potential_payout_dollars: 6.67 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'over_under', chosen_side: 'over', line: 4.5, wager_dollars: 7.25, potential_payout_dollars: 9.06 }),
      makeBet(sourceType, { id: 3, player_id: 'p2', bet_type: 'run_line', chosen_side: 'away', line: 1.5, wager_dollars: 5, potential_payout_dollars: 4 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })
    const args = { ...world.syncArgs, teamARuns: 1, teamBRuns: 4, teamBPlayerId: 'p2', winnerPlayerId: 'p2' }

    await settleCompletedTrackerGame(args)
    const afterFirst = JSON.stringify(world.db[world.tables.ledger])
    const writesAfterFirst = world.supabase.operations
      .filter((op) => op.table === world.tables.ledger && op.action !== 'select').length

    await settleCompletedTrackerGame(args)
    await settleCompletedTrackerGame(args)

    assert.equal(JSON.stringify(world.db[world.tables.ledger]), afterFirst, 'the ledger must not change')
    assert.equal(
      world.supabase.operations.filter((op) => op.table === world.tables.ledger && op.action !== 'select').length,
      writesAfterFirst,
      'repeat settlements must not write to the ledger at all',
    )
    // 5 runs total beats the 4.5 line; the home win by 3 covers away +1.5.
    assert.deepEqual(settledLedgerByBet(world), { 1: 16.67, 2: 16.31 })
    assert.equal(ledgerNet(world, 'p1'), 6.67)
    assert.equal(ledgerNet(world, 'p2'), 4.06, 'p2: -12.25 placed, +16.31 on the winning total')
  })

  test(`[${sourceType}] a derived betting failure can be retried once the scoring data it needs is durable`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'hr_prop', target_entity: LABELS.mario, chosen_side: 'over', line: 0.5, wager_dollars: 10, potential_payout_dollars: 40 }),
    ]
    const world = buildBettingWorld(sourceType, {
      bets,
      ledger: makePlacementLedger(sourceType, bets),
      // The PA read fails on the first settlement attempt.
      failures: [{ table: world_pa_table(sourceType), action: 'select', mode: 'before', times: 1, error: { message: 'statement timeout reading plate appearances' } }],
    })
    const args = { ...world.syncArgs, teamARuns: 1, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1' }

    await expectRejection(() => settleCompletedTrackerGame(args), /statement timeout reading plate appearances/)
    assert.equal(betsById(world)[1].status, 'open', 'a failed derived update must not grade anything')
    assert.equal(ledgerRowsFor(world).length, 0)

    // The scoring fact lands, and the retry settles against it.
    world.db[world.tables.pas].push(makePA({ result: 'HR', inning: 1, rbi: 1, characterId: 11, playerId: 'p1' }))
    await settleCompletedTrackerGame(args)
    assert.equal(betsById(world)[1].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 1: 50 })
  })

  test(`[${sourceType}] final settlement grades against the complete final game, not the state the market last saw`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'hit_prop', target_entity: LABELS.mario, chosen_side: 'over', line: 1.5, wager_dollars: 10, potential_payout_dollars: 25 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'over_under', chosen_side: 'over', line: 5.5, wager_dollars: 10, potential_payout_dollars: 10 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })

    // The board last priced a 1-0 game in inning 1 with one Mario hit.
    world.db[world.tables.pas].push(makePA({ result: '1B', inning: 1, characterId: 11, playerId: 'p1' }))
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1, awayRuns: 1 })))
    assert.equal(oddsRows(world, 'hit_prop').find((row) => row.target_entity === LABELS.mario).prop_current_count, 1)

    // The rest of the game lands before completion.
    world.db[world.tables.pas].push(
      makePA({ result: '2B', inning: 2, characterId: 11, playerId: 'p1' }),
      makePA({ result: 'HR', inning: 3, rbi: 2, characterId: 11, playerId: 'p1' }),
    )
    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 4, teamBRuns: 3, teamBPlayerId: 'p2', winnerPlayerId: 'p1',
    })

    // Three credited hits, seven total runs — both graded on the final data.
    assert.equal(betsById(world)[1].status, 'won')
    assert.equal(betsById(world)[2].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 1: 35, 2: 20 })
  })

  test(`[${sourceType}] reopening a corrected game reverses settlement, and re-settling credits once`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 15 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 10, potential_payout_dollars: 15 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })

    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 1, teamBRuns: 4, teamBPlayerId: 'p2', winnerPlayerId: 'p2',
    })
    assert.deepEqual(settledLedgerByBet(world), { 1: 25 })

    // The score was wrong: the game is reopened and corrected to an away win.
    await reopenGameBets(world.gameId, resolutionConfig(world))
    assert.equal(ledgerRowsFor(world).length, 0, 'reopening must reverse the credit')
    assert.equal(ledgerNet(world), -20)
    assert.deepEqual(Object.values(betsById(world)).map((bet) => bet.status), ['open', 'open'])

    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 4, teamBRuns: 1, teamBPlayerId: 'p2', winnerPlayerId: 'p1',
    })
    assert.equal(betsById(world)[1].status, 'lost')
    assert.equal(betsById(world)[2].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 2: 25 })
    assert.equal(ledgerRowsFor(world).length, 1, 'no duplicate credit survives the correction')
    assert.equal(ledgerNet(world, 'p1'), -10)
    assert.equal(ledgerNet(world, 'p2'), 15)

    // Re-running the corrected settlement changes nothing further.
    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 4, teamBRuns: 1, teamBPlayerId: 'p2', winnerPlayerId: 'p1',
    })
    assert.deepEqual(settledLedgerByBet(world), { 2: 25 })
  })
}

// ── Reopen recovery ─────────────────────────────────────────────────────────
//
// A home moneyline ticket, wager 10 and profit 15, debited at placement and
// settled on a home win: +25 credit, ledger net +15. Reopened, it must hold only
// its placement debit (net -10), and a retry after any partial failure must end
// in the same place.

const HOME_TICKET = { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 15 }
// Wins on the same home win: 5 total runs clear 4.5.
const OVER_TICKET = { id: 2, player_id: 'p2', bet_type: 'over_under', chosen_side: 'over', line: 4.5, wager_dollars: 10, potential_payout_dollars: 10 }

function settleHomeWin(world, supabase = world.supabase, gameId = world.gameId) {
  return resolveGameBets(gameId, 'home', 5, {}, 3, resolutionConfig(world, supabase))
}

async function settledWorld(sourceType, tickets = [HOME_TICKET], options = {}) {
  const bets = tickets.map((ticket) => makeBet(sourceType, ticket))
  const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets), ...options })
  await settleHomeWin(world)
  return world
}

function bettingWrites(world) {
  return world.supabase.operations
    .filter((op) => (op.table === world.tables.bets || op.table === world.tables.ledger) && op.action !== 'select')
    .length
}

function ledgerDeletes(world) {
  return world.supabase.operations.filter((op) => op.table === world.tables.ledger && op.action === 'delete').length
}

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] a reopen whose ledger delete fails is finished by the retry instead of reported done`, async () => {
    const world = await settledWorld(sourceType)
    assert.deepEqual(settledLedgerByBet(world), { 1: 25 })
    assert.equal(ledgerNet(world), 15)

    const failing = world.supabase.restart({ failures: [{ table: world.tables.ledger, action: 'delete', mode: 'before' }] })
    await expectRejection(() => reopenGameBets(world.gameId, resolutionConfig(world, failing)), /injected delete:/)
    // The status write landed; the credit did not come off.
    assert.equal(betsById(world)[1].status, 'open')
    assert.deepEqual(settledLedgerByBet(world), { 1: 25 })

    // Nothing is left to reopen, and an empty result now means the ledger agrees.
    assert.deepEqual(await reopenGameBets(world.gameId, resolutionConfig(world)), [])
    assert.equal(ledgerRowsFor(world).length, 0)
    assert.equal(ledgerNet(world), -10, 'only the placement debit is left on the reopened ticket')
    assert.equal(ledgerRowsFor(world, { reasonPrefix: 'bet_placed' }).length, 1)
  })

  test(`[${sourceType}] a ticket an earlier reopen left open but still credited is reversed`, async () => {
    const world = await settledWorld(sourceType)
    // The state the old reopen left behind after its ledger delete failed.
    Object.assign(betsById(world)[1], { status: 'open', result_correct: null, resolved_at: null })

    assert.deepEqual(await reopenGameBets(world.gameId, resolutionConfig(world)), [])
    assert.equal(ledgerRowsFor(world).length, 0)
    assert.equal(ledgerNet(world), -10)
  })

  test(`[${sourceType}] a partial status update is finished on retry and the corrected result credits once`, async () => {
    const world = await settledWorld(sourceType, [HOME_TICKET, OVER_TICKET])
    assert.deepEqual(settledLedgerByBet(world), { 1: 25, 2: 20 })

    const failing = world.supabase.restart({ failures: [{
      table: world.tables.bets,
      action: 'update',
      mode: 'before',
      when: (op) => op.filters.some((filter) => filter.field === 'id' && String(filter.value) === '2'),
    }] })
    await expectRejection(() => reopenGameBets(world.gameId, resolutionConfig(world, failing)), /injected update:/)
    assert.equal(betsById(world)[1].status, 'open')
    assert.equal(betsById(world)[2].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 1: 25, 2: 20 }, 'nothing came off the ledger yet')

    await reopenGameBets(world.gameId, resolutionConfig(world))
    assert.deepEqual(Object.values(betsById(world)).map((bet) => bet.status), ['open', 'open'])
    assert.equal(ledgerRowsFor(world).length, 0)
    assert.equal(ledgerNet(world), -20)

    // Corrected to an away win: the home ticket loses, 5 runs still clear 4.5.
    await resolveGameBets(world.gameId, 'away', 5, {}, 3, resolutionConfig(world))
    assert.equal(betsById(world)[1].status, 'lost')
    assert.equal(betsById(world)[2].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 2: 20 })
    assert.equal(ledgerNet(world, 'p1'), -10)
    assert.equal(ledgerNet(world, 'p2'), 10)
  })

  test(`[${sourceType}] a lost response after either reopen write commits is safe to retry`, async () => {
    for (const [table, action] of [['bets', 'update'], ['ledger', 'delete']]) {
      const world = await settledWorld(sourceType)
      const failing = world.supabase.restart({ failures: [{ table: world.tables[table], action, mode: 'after' }] })
      await expectRejection(() => reopenGameBets(world.gameId, resolutionConfig(world, failing)), /timeout after commit/)
      assert.equal(betsById(world)[1].status, 'open', `${table}: the status write is durable`)

      await reopenGameBets(world.gameId, resolutionConfig(world))
      assert.equal(ledgerRowsFor(world).length, 0, `${table}: no credit survives the retry`)
      assert.equal(ledgerNet(world), -10, `${table}: the placement debit is untouched`)
    }
  })

  test(`[${sourceType}] repeating a finished reopen writes nothing`, async () => {
    const world = await settledWorld(sourceType, [HOME_TICKET, OVER_TICKET])
    await reopenGameBets(world.gameId, resolutionConfig(world))
    const ledgerAfter = JSON.stringify(world.db[world.tables.ledger])
    const writesAfter = bettingWrites(world)

    assert.deepEqual(await reopenGameBets(world.gameId, resolutionConfig(world)), [])
    await reopenGameBets(world.gameId, resolutionConfig(world))

    assert.equal(JSON.stringify(world.db[world.tables.ledger]), ledgerAfter)
    assert.equal(bettingWrites(world), writesAfter, 'a repeat must not write to bets or the ledger')
    assert.equal(ledgerNet(world), -20)
  })

  test(`[${sourceType}] a settlement that lands mid-reopen keeps its credit and the reopen fails`, async () => {
    const world = await settledWorld(sourceType)
    // Park the reopen's ledger delete, after its status write and ledger read.
    const parked = world.supabase.restart({ failures: [{ table: world.tables.ledger, action: 'delete', delayMs: 20 }] })
    const outcome = reopenGameBets(world.gameId, resolutionConfig(world, parked)).then(() => null, (error) => error)
    for (let tick = 0; tick < 100 && ledgerDeletes(world) === 0; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(ledgerDeletes(world), 1, 'the reopen reached its ledger delete')
    assert.equal(betsById(world)[1].status, 'open')

    // Settled again before that delete runs. On the fake this completes without
    // yielding to a timer, so the ordering is fixed.
    await settleHomeWin(world)
    assert.equal(betsById(world)[1].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 1: 25 }, 'the parked delete has not run')

    const error = await outcome
    assert.match(String(error?.message), /did not take/)
    assert.equal(betsById(world)[1].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 1: 25 }, 'the newer settlement stays paid')
    assert.equal(ledgerNet(world), 15)

    await reopenGameBets(world.gameId, resolutionConfig(world))
    assert.equal(betsById(world)[1].status, 'open')
    assert.equal(ledgerNet(world), -10)
  })
}

test('a recovered reopen leaves the other competition, other games and other ledger reasons alone', async () => {
  for (const reopened of COMPETITIONS) {
    // One client holds both competitions with the same source, game and bet ids.
    const ticketsFor = (sourceType) => [
      makeBet(sourceType, HOME_TICKET),
      makeBet(sourceType, { ...HOME_TICKET, id: 2, game_id: PRIOR_GAME_ID }),
    ]
    const unrelatedRow = (sourceType) => ({
      id: 7000,
      player_id: 'p1',
      game_id: GAME_ID,
      bet_id: null,
      [SOURCE_ID_FIELD[sourceType]]: SOURCE_ID,
      reason: 'settle_up:manual',
      [LEDGER_CHANGE_FIELD[sourceType]]: 3,
    })
    const world = buildBettingWorld('season', {
      bets: ticketsFor('season'),
      ledger: [...makePlacementLedger('season', ticketsFor('season')), unrelatedRow('season')],
      extraTables: {
        bets: ticketsFor('tournament'),
        points_ledger: [...makePlacementLedger('tournament', ticketsFor('tournament')), unrelatedRow('tournament')],
      },
    })
    const views = {
      season: world,
      tournament: {
        ...world,
        sourceType: 'tournament',
        tables: tablesFor('tournament'),
        ledgerChangeField: LEDGER_CHANGE_FIELD.tournament,
        sourceIdField: SOURCE_ID_FIELD.tournament,
      },
    }
    for (const view of Object.values(views)) {
      await settleHomeWin(view)
      await settleHomeWin(view, view.supabase, PRIOR_GAME_ID)
    }
    const view = views[reopened]
    const other = views[reopened === 'season' ? 'tournament' : 'season']
    const otherLedger = JSON.stringify(other.db[other.tables.ledger])
    const otherBets = JSON.stringify(other.db[other.tables.bets])

    const failing = world.supabase.restart({ failures: [{ table: view.tables.ledger, action: 'delete', mode: 'before' }] })
    await expectRejection(() => reopenGameBets(GAME_ID, resolutionConfig(view, failing)), /injected delete:/)
    await reopenGameBets(GAME_ID, resolutionConfig(view))

    assert.equal(betsById(view)[1].status, 'open', `${reopened}: the reopened game's ticket`)
    assert.equal(betsById(view)[2].status, 'won', `${reopened}: the earlier game keeps its result`)
    assert.deepEqual(settledLedgerByBet(view), { 2: 25 })
    assert.equal(view.db[view.tables.ledger].filter((row) => row.reason === 'settle_up:manual').length, 1)
    assert.equal(ledgerNet(view), 8, `${reopened}: -20 placed, +25 on the earlier game, +3 unrelated`)
    assert.equal(JSON.stringify(other.db[other.tables.ledger]), otherLedger, `${reopened}: the other ledger is untouched`)
    assert.equal(JSON.stringify(other.db[other.tables.bets]), otherBets, `${reopened}: the other bets are untouched`)
  }
})

test('[tournament] a calibration cleanup failure after the reversal is retried without repeating the balance change', async () => {
  const world = await settledWorld('tournament', [HOME_TICKET], {
    extraTables: {
      odds_calibration_log: [
        { id: 1, game_id: GAME_ID, bet_type: 'moneyline' },
        { id: 2, game_id: PRIOR_GAME_ID, bet_type: 'moneyline' },
      ],
    },
  })
  const withCalibration = (supabase) => ({
    ...resolutionConfig(world, supabase),
    enableCalibrationLogging: true,
    oddsCalibrationTable: 'odds_calibration_log',
  })
  const failing = world.supabase.restart({ failures: [{ table: 'odds_calibration_log', action: 'delete', mode: 'before' }] })
  await expectRejection(() => reopenGameBets(world.gameId, withCalibration(failing)), /injected delete:odds_calibration_log/)
  assert.equal(ledgerNet(world), -10, 'the reversal itself completed')
  const writesAfter = bettingWrites(world)

  await reopenGameBets(world.gameId, withCalibration(world.supabase))
  assert.equal(bettingWrites(world), writesAfter, 'the retry repeats no bet or ledger write')
  assert.deepEqual(world.db.odds_calibration_log.map((row) => row.game_id), [PRIOR_GAME_ID])
  assert.equal(ledgerNet(world), -10)
})

// ── Ledger conservation across every outcome ────────────────────────────────

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] wins, losses, pushes, refunds and voids each move the ledger by exactly the product's rule`, async () => {
    const bets = [
      // Win: refunded wager + payout.
      makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 15 }),
      // Loss: the placement debit stands, nothing else moves.
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 10, potential_payout_dollars: 15 }),
      // Push on an exact-total line: the wager is refunded.
      makeBet(sourceType, { id: 3, bet_type: 'over_under', chosen_side: 'over', line: 7, wager_dollars: 12.5, potential_payout_dollars: 11 }),
      makeBet(sourceType, { id: 4, player_id: 'p2', bet_type: 'over_under', chosen_side: 'under', line: 7, wager_dollars: 12.5, potential_payout_dollars: 11 }),
      // Push on an exact run-line margin.
      makeBet(sourceType, { id: 5, bet_type: 'run_line', chosen_side: 'home', line: 3, wager_dollars: 4, potential_payout_dollars: 6 }),
      // An unsupported market voids and refunds.
      makeBet(sourceType, { id: 6, player_id: 'p2', bet_type: 'custom', chosen_side: 'yes', wager_dollars: 3.33, potential_payout_dollars: 5 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })

    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 2, teamBRuns: 5, teamBPlayerId: 'p2', winnerPlayerId: 'p2',
    })

    const graded = betsById(world)
    assert.equal(graded[1].status, 'won')
    assert.equal(graded[2].status, 'lost')
    assert.equal(graded[3].status, 'void')
    assert.equal(graded[4].status, 'void')
    assert.equal(graded[5].status, 'void')
    assert.equal(graded[6].status, 'void')

    assert.deepEqual(settledLedgerByBet(world), {
      1: 25,    // 10 wager back + 15 payout
      3: 12.5,  // push refund
      4: 12.5,  // push refund
      5: 4,     // push refund
      6: 3.33,  // void refund
    })
    assert.equal(settledLedgerByBet(world)[2], undefined, 'a loss writes no settlement row')

    // Placement debits: p1 -26.5, p2 -25.83. Returns: p1 +41.5, p2 +15.83.
    assert.equal(ledgerNet(world, 'p1'), 15)
    assert.equal(ledgerNet(world, 'p2'), -10)
    assert.equal(ledgerNet(world), 5, 'the book keeps exactly the losing $10')
  })

  test(`[${sourceType}] a tied final game pushes every side market instead of grading both sides as losers`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 15 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 10, potential_payout_dollars: 15 }),
      makeBet(sourceType, { id: 3, bet_type: 'run_line', chosen_side: 'home', line: 1.5, wager_dollars: 10, potential_payout_dollars: 12 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })

    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 3, teamBRuns: 3, teamBPlayerId: 'p2', winnerPlayerId: null,
    })

    Object.values(betsById(world)).forEach((bet) => {
      assert.equal(bet.status, 'void')
      assert.equal(bet.result_correct, null)
    })
    assert.deepEqual(settledLedgerByBet(world), { 1: 10, 2: 10, 3: 10 })
    assert.equal(ledgerNet(world), 0, 'a full push is balance-neutral')
  })
}

// ── Isolation, identities and malformed data ────────────────────────────────

test('tournament and season data with identical numeric ids stay isolated', async () => {
  const tournament = buildBettingWorld('tournament', {
    bets: [makeBet('tournament', { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 15 })],
  })
  const season = buildBettingWorld('season', {
    bets: [makeBet('season', { id: 1, bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 99, potential_payout_dollars: 99 })],
  })
  // Same source id, same game id, different tables.
  assert.equal(tournament.sourceId, season.sourceId)
  assert.equal(tournament.gameId, season.gameId)

  // Point both at one client so a table mix-up would be observable.
  Object.assign(season.supabase.db, {
    games: tournament.db.games,
    bets: tournament.db.bets,
    game_odds: tournament.db.game_odds,
    points_ledger: tournament.db.points_ledger,
    plate_appearances: tournament.db.plate_appearances,
  })
  const shared = { supabase: season.supabase, sourceId: SOURCE_ID, gameId: GAME_ID }

  await syncTrackerLiveOdds({ ...shared, sourceType: 'season', regulationInnings: 3, expectedPitcherByPlayer: EXPECTED_PITCHERS })
  assert.equal(season.db.season_game_odds.length, 14)
  assert.equal(tournament.db.game_odds.length, 0, 'a season sync must not write to tournament odds')

  await settleCompletedTrackerGame({
    ...shared, sourceType: 'season', teamARuns: 1, teamBRuns: 4, teamBPlayerId: 'p2', winnerPlayerId: 'p2',
  })
  assert.equal(season.db.season_bets[0].status, 'lost', 'the away ticket loses the season game')
  assert.equal(tournament.db.bets[0].status, 'open', 'the identically-numbered tournament bet is untouched')
  assert.equal((tournament.db.points_ledger || []).length, 0)
})

test('a game id that belongs to another competition is rejected rather than silently priced', async () => {
  const world = buildBettingWorld('tournament')
  await expectRejection(
    () => syncTrackerLiveOdds({ ...world.syncArgs, gameId: 999, regulationInnings: 3 }),
    /could not load game 999/,
  )
})

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] an incomplete query fails loudly instead of pricing a partial board`, async () => {
    const world = buildBettingWorld(sourceType, {
      failures: [{ table: 'characters', action: 'select', mode: 'before', times: 1, error: { message: 'canceling statement due to statement timeout' } }],
    })
    await expectRejection(
      () => syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 }))),
      /statement timeout/,
    )
    assert.equal(oddsRows(world).length, 0)

    // The retry, with the query healthy again, writes the full board.
    const persisted = await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))
    assert.equal(persisted.length, 14)
  })

  test(`[${sourceType}] a malformed line refuses to settle instead of grading both sides of the market as losers`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'hr_prop', target_entity: LABELS.mario, chosen_side: 'over', line: 'abc', wager_dollars: 10, potential_payout_dollars: 20 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'hr_prop', target_entity: LABELS.mario, chosen_side: 'under', line: 'abc', wager_dollars: 10, potential_payout_dollars: 8 }),
    ]
    const world = buildBettingWorld(sourceType, {
      bets,
      ledger: makePlacementLedger(sourceType, bets),
      pas: [makePA({ result: 'HR', inning: 1, rbi: 1, characterId: 11, playerId: 'p1' })],
    })

    await expectRejection(
      () => settleCompletedTrackerGame({ ...world.syncArgs, teamARuns: 1, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1' }),
      /non-numeric line/,
    )
    assert.deepEqual(Object.values(betsById(world)).map((bet) => bet.status), ['open', 'open'])
    assert.equal(ledgerNet(world), -20, 'nothing was graded, so nothing was returned')

    // Correcting the row makes the settlement succeed.
    world.db[world.tables.bets].forEach((bet) => { bet.line = 0.5 })
    await settleCompletedTrackerGame({ ...world.syncArgs, teamARuns: 1, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1' })
    assert.equal(betsById(world)[1].status, 'won')
    assert.equal(betsById(world)[2].status, 'lost')
    assert.deepEqual(settledLedgerByBet(world), { 1: 30 })
  })

  test(`[${sourceType}] a malformed wager never reaches the ledger`, async () => {
    const bets = [makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 'ten', potential_payout_dollars: 15 })]
    const world = buildBettingWorld(sourceType, { bets })

    await expectRejection(
      () => settleCompletedTrackerGame({ ...world.syncArgs, teamARuns: 1, teamBRuns: 4, teamBPlayerId: 'p2', winnerPlayerId: 'p2' }),
      /non-numeric wager_dollars/,
    )
    assert.equal(ledgerRowsFor(world).length, 0)
    assert.equal((world.db[world.tables.ledger] || []).length, 0)
  })

  test(`[${sourceType}] an unresolved batter identity blocks settlement of the props exposed to it`, async () => {
    const bets = [makeBet(sourceType, { id: 1, bet_type: 'hr_prop', target_entity: LABELS.mario, chosen_side: 'over', line: 0.5, wager_dollars: 10, potential_payout_dollars: 40 })]
    const world = buildBettingWorld(sourceType, {
      bets,
      ledger: makePlacementLedger(sourceType, bets),
      pas: [makePA({ result: 'HR', inning: 1, rbi: 1, characterId: 11, playerId: 'p1' })],
    })
    // The PA now points at a character row that is not loadable.
    world.db[world.tables.pas].find((pa) => pa.game_id === GAME_ID).character_id = 999

    await expectRejection(
      () => settleCompletedTrackerGame({ ...world.syncArgs, teamARuns: 1, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1' }),
      /unresolved batter identities/,
    )
    assert.equal(betsById(world)[1].status, 'open', 'the prop must not grade against a phantom total of 0')

    world.db[world.tables.pas].find((pa) => pa.game_id === GAME_ID).character_id = 11
    await settleCompletedTrackerGame({ ...world.syncArgs, teamARuns: 1, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1' })
    assert.equal(betsById(world)[1].status, 'won')
  })

  test(`[${sourceType}] an unresolved identity with no prop exposure still settles the rest of the board`, async () => {
    const bets = [makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 15 })]
    const world = buildBettingWorld(sourceType, {
      bets,
      ledger: makePlacementLedger(sourceType, bets),
      pas: [makePA({ result: 'HR', inning: 1, rbi: 1, characterId: 11, playerId: 'p1' })],
    })
    world.db[world.tables.pas].find((pa) => pa.game_id === GAME_ID).character_id = 999

    await settleCompletedTrackerGame({ ...world.syncArgs, teamARuns: 1, teamBRuns: 4, teamBPlayerId: 'p2', winnerPlayerId: 'p2' })
    assert.equal(betsById(world)[1].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 1: 25 })
  })
}

test('a season roster character name that does not resolve stops odds generation instead of pricing the wrong pitcher', async () => {
  const world = buildBettingWorld('season')
  world.db.season_roster.forEach((row) => { if (row.character_name === 'Luigi') row.character_name = 'luigi' })

  await expectRejection(
    () => syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 }))),
    /cannot resolve roster character name\(s\).*luigi/,
  )
  assert.equal(oddsRows(world).length, 0)

  world.db.season_roster.forEach((row) => { if (row.character_name === 'luigi') row.character_name = 'Luigi' })
  await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))
  assert.deepEqual(oddsRows(world, 'k_prop').map((row) => row.target_entity).sort(), [LABELS.daisy, LABELS.luigi].sort())
})

test('a season team with no player keeps its markets off the board rather than keying them to a bare character name', async () => {
  const world = buildBettingWorld('season')
  world.db.season_teams.find((team) => team.id === 101).player_id = null

  await expectRejection(
    () => syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 }))),
    /cannot resolve a player for season team\(s\) 101/,
  )
  assert.equal(oddsRows(world).length, 0)
})

test('a tournament roster pick pointing at a missing character stops odds generation', async () => {
  const world = buildBettingWorld('tournament')
  world.db.draft_picks.find((pick) => pick.character_id === 12).character_id = 999

  await expectRejection(
    () => syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 }))),
    /cannot resolve roster character id\(s\).*999/,
  )
})

// ── Stale markets ───────────────────────────────────────────────────────────

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] a pulled pitcher's strikeout market is closed rather than left live alongside the new one`, async () => {
    const world = buildBettingWorld(sourceType)
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1 })))
    const originalAwayK = oddsRows(world, 'k_prop').find((row) => row.target_entity === LABELS.luigi)
    assert.ok(originalAwayK && originalAwayK.is_locked === false)

    // Aidan swaps Luigi out for Mario on the mound.
    world.db[world.tables.pitching].push(makePitchingStint({ gameId: GAME_ID, playerId: 'p1', characterId: 11, strikeouts: 0, inningsPitched: 1 }))
    await syncTrackerLiveOdds({
      ...world.syncArgs,
      ...applyLiveState(world, { inning: 2 }),
      expectedPitcherByPlayer: { p1: 11, p2: 22 },
      regulationInnings: 3,
    })

    const kRows = oddsRows(world, 'k_prop')
    const luigiRow = kRows.find((row) => row.target_entity === LABELS.luigi)
    const marioRow = kRows.find((row) => row.target_entity === entityLabel(11, 'p1'))
    assert.equal(luigiRow.is_locked, true, 'the pulled pitcher accepts no new tickets')
    assert.equal(marioRow.is_locked, false, 'the new pitcher is on the board')
    assert.equal(kRows.length, 3, 'the stale market is kept for settlement, not duplicated')
  })
}

// ── Full lifecycle ──────────────────────────────────────────────────────────

for (const sourceType of COMPETITIONS) {
  test(`[${sourceType}] full lifecycle: pregame board -> live repricing -> first-inning close -> final settlement -> correction`, async () => {
    const bets = [
      makeBet(sourceType, { id: 1, bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 20, potential_payout_dollars: 30 }),
      makeBet(sourceType, { id: 2, player_id: 'p2', bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 20, potential_payout_dollars: 18 }),
      makeBet(sourceType, { id: 3, bet_type: 'first_inning_run', chosen_side: 'yes', wager_dollars: 5, potential_payout_dollars: 6 }),
      makeBet(sourceType, { id: 4, player_id: 'p2', bet_type: 'hr_prop', target_entity: LABELS.mario, chosen_side: 'over', line: 0.5, wager_dollars: 5, potential_payout_dollars: 45 }),
      makeBet(sourceType, { id: 5, bet_type: 'k_prop', target_entity: LABELS.daisy, chosen_side: 'under', line: 2.5, wager_dollars: 10, potential_payout_dollars: 9 }),
    ]
    const world = buildBettingWorld(sourceType, { bets, ledger: makePlacementLedger(sourceType, bets) })
    const config = resolutionConfig(world)

    // 1. Pregame board.
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1, status: sourceType === 'season' ? 'scheduled' : 'pending' })))
    assert.equal(oddsRows(world).length, 14)

    // 2. Top 1: Mario homers. The market closes on the known outcome; the
    //    ticket settles only after the confirming play.
    const homer = makePA({ result: 'HR', inning: 1, rbi: 1, characterId: 11, playerId: 'p1' })
    world.db[world.tables.pas].push(homer)
    world.db[world.tables.runs].push(makeRunScored({ paId: homer.id, inning: 1 }))
    await resolveOnPA(world.gameId, homer, config)
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 1, awayRuns: 1 })))
    assert.equal(oddsRows(world, 'first_inning_run')[0].is_locked, true)
    assert.equal(betsById(world)[3].status, 'open')
    assert.equal(oddsRows(world, 'hr_prop').find((row) => row.target_entity === LABELS.mario).line, 1.5)

    const confirming = makePA({ result: 'K', inning: 1, characterId: 12, playerId: 'p1' })
    world.db[world.tables.pas].push(confirming)
    await resolveOnPA(world.gameId, confirming, config)
    assert.equal(betsById(world)[3].status, 'won')
    assert.deepEqual(settledLedgerByBet(world), { 3: 11 })

    // 3. The rest of the game.
    world.db[world.tables.pas].push(
      makePA({ result: 'OUT', inning: 2, characterId: 21, playerId: 'p2', isTop: false }),
      makePA({ result: '1B', inning: 3, characterId: 11, playerId: 'p1' }),
    )
    world.db[world.tables.pitching].push(makePitchingStint({ gameId: GAME_ID, playerId: 'p2', characterId: 22, strikeouts: 2, inningsPitched: 3 }))
    await syncTrackerLiveOdds(syncOptions(world, applyLiveState(world, { inning: 3, awayRuns: 1 })))
    assert.equal(oddsRows(world, 'first_inning_run')[0].is_locked, true, 'the closed market stays closed all game')

    // 4. Final settlement on the complete game: away wins 1-0, Mario has one
    //    HR, Daisy has 2 strikeouts.
    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 1, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1',
    })
    const graded = betsById(world)
    assert.equal(graded[1].status, 'won')   // away moneyline
    assert.equal(graded[2].status, 'lost')
    assert.equal(graded[4].status, 'won')   // Mario over 0.5 HR
    assert.equal(graded[5].status, 'won')   // Daisy under 2.5 K
    assert.deepEqual(settledLedgerByBet(world), { 1: 50, 3: 11, 4: 50, 5: 19 })
    assert.equal(ledgerNet(world, 'p1'), 45)  // -35 placed, +80 returned
    assert.equal(ledgerNet(world, 'p2'), 25)  // -25 placed, +50 returned
    assert.equal(ledgerNet(world), 70)

    // 5. Settling again is inert.
    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 1, teamBRuns: 0, teamBPlayerId: 'p2', winnerPlayerId: 'p1',
    })
    assert.equal(ledgerNet(world), 70)

    // 6. The game is corrected to a home win and re-settled exactly once.
    await reopenGameBets(world.gameId, config)
    assert.equal(ledgerRowsFor(world).length, 0)
    assert.equal(ledgerNet(world), -60, 'only the placement debits remain')

    await settleCompletedTrackerGame({
      ...world.syncArgs, teamARuns: 0, teamBRuns: 1, teamBPlayerId: 'p2', winnerPlayerId: 'p2',
    })
    const recorrected = betsById(world)
    assert.equal(recorrected[1].status, 'lost')
    assert.equal(recorrected[2].status, 'won')
    assert.equal(recorrected[3].status, 'won', 'the first-inning run still happened')
    assert.deepEqual(settledLedgerByBet(world), { 2: 38, 3: 11, 4: 50, 5: 19 })
    assert.equal(ledgerRowsFor(world).length, 4, 'no duplicate credit from the correction')
    assert.equal(ledgerNet(world), 58)
  })
}

// Table names the failure-injection rules need. Kept as functions so the
// scenario reads as one statement rather than a lookup dance.
function world_bets_table(sourceType) { return sourceType === 'season' ? 'season_bets' : 'bets' }
function world_ledger_table(sourceType) { return sourceType === 'season' ? 'season_betting_ledger' : 'points_ledger' }
function world_pa_table(sourceType) { return sourceType === 'season' ? 'season_plate_appearances' : 'plate_appearances' }
