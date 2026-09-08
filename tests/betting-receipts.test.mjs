// Ticket receipts: accepted terms, plain-language conditions, factual outcome
// explanations, and the line between a calculated result and a recorded credit.
//
// Every expected amount here is a literal worked out by hand from the ticket's
// accepted odds; none is produced by calling the production payout helper.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBetReceipt,
  buildCurrentMarketComparison,
  buildOutcomeExplanation,
  buildTicketFinancials,
  describeWinningConditions,
  expectedSettlementDelta,
} from '../src/utils/betReceipt.js'

const AWAY = { id: 'p1', name: 'Aidan' }
const HOME = { id: 'p2', name: 'Donovan' }
const PLAYERS = { p1: AWAY, p2: HOME }
const CHARACTERS = { 11: { id: 11, name: 'Mario' }, 22: { id: 22, name: 'Daisy' } }
const LABELS = { home: 'Donovan', away: 'Aidan' }

function makeGame(overrides = {}) {
  return {
    id: 77,
    tournament_id: 5,
    team_a_player_id: AWAY.id,
    team_b_player_id: HOME.id,
    team_a_runs: 3,
    team_b_runs: 6,
    status: 'complete',
    ...overrides,
  }
}

function makeBet(overrides = {}) {
  return {
    id: 1,
    game_id: 77,
    player_id: AWAY.id,
    bet_type: 'moneyline',
    target_entity: null,
    chosen_side: 'home',
    odds: 150,
    line: null,
    wager_dollars: 25,
    potential_payout_dollars: 37.5,
    status: 'won',
    result_correct: true,
    placed_at: '2026-07-20T12:00:00.000Z',
    resolved_at: '2026-07-20T13:30:00.000Z',
    ...overrides,
  }
}

function ledger(betId, { placed = null, settled = null, changeField = 'points_change' } = {}) {
  const rows = []
  if (placed != null) {
    rows.push({ id: 1, bet_id: betId, reason: 'bet_placed:moneyline:home', [changeField]: placed, created_at: '2026-07-20T12:00:01.000Z' })
  }
  if (settled != null) {
    rows.push({ id: 2, bet_id: betId, reason: 'bet_settled:moneyline:home', [changeField]: settled, created_at: '2026-07-20T13:30:05.000Z' })
  }
  return rows
}

// ── money ────────────────────────────────────────────────────────────────────

test('wager, potential net profit and potential total return are three different numbers', () => {
  // $25 at +150 pays $37.50 profit on top of the $25 stake.
  const financials = buildTicketFinancials(makeBet(), {
    ledgerRows: ledger(1, { placed: -25, settled: 62.5 }),
  })

  assert.equal(financials.wager, 25)
  assert.equal(financials.potentialProfit, 37.5)
  assert.equal(financials.potentialReturn, 62.5)
  assert.equal(financials.creditedReturn, 62.5)
  assert.equal(financials.creditState, 'credited')
  assert.equal(financials.realizedProfit, 37.5)
  assert.equal(financials.ledgerNet, 37.5, 'the ledger moved the balance by the profit, not the return')
})

test('a graded win with no settlement entry is reported as awaiting credit, never as paid', () => {
  const financials = buildTicketFinancials(makeBet(), { ledgerRows: ledger(1, { placed: -25 }) })

  assert.equal(financials.creditState, 'pending')
  assert.equal(financials.creditedReturn, null)
  assert.match(financials.creditNote, /no settlement entry/i)
  assert.match(financials.creditNote, /Nothing has been paid/i)
  // The calculated result is still available and unaffected.
  assert.equal(financials.realizedProfit, 37.5)
})

test('a losing ticket expects no credit at all rather than a missing one', () => {
  const financials = buildTicketFinancials(
    makeBet({ status: 'lost', result_correct: false }),
    { ledgerRows: ledger(1, { placed: -25 }) },
  )

  assert.equal(financials.creditState, 'no-credit-expected')
  assert.equal(financials.creditedReturn, 0)
  assert.equal(financials.realizedProfit, -25)
})

test('a void refunds exactly the stake', () => {
  const financials = buildTicketFinancials(
    makeBet({ status: 'void', result_correct: null }),
    { ledgerRows: ledger(1, { placed: -25, settled: 25 }) },
  )

  assert.equal(financials.creditedReturn, 25)
  assert.equal(financials.creditState, 'credited')
  assert.equal(financials.realizedProfit, 0)
  assert.equal(financials.ledgerNet, 0, 'a refunded push leaves the balance where it started')
})

test('a settlement entry that disagrees with the ticket terms is flagged, not accepted', () => {
  // Ticket says $62.50 back; the ledger holds a stale $40 from an earlier grade.
  const financials = buildTicketFinancials(makeBet(), {
    ledgerRows: ledger(1, { placed: -25, settled: 40 }),
  })

  assert.equal(financials.creditState, 'mismatch')
  assert.equal(financials.creditedReturn, 40)
  assert.equal(financials.expectedSettlementDelta, 62.5)
  assert.match(financials.creditNote, /awaiting resettlement/i)
})

test('a ticket with no placement debit credits the profit alone, and says so', () => {
  const financials = buildTicketFinancials(makeBet(), { ledgerRows: ledger(1, { settled: 37.5 }) })

  assert.equal(financials.hasPlacementDebit, false)
  assert.equal(financials.creditState, 'credited')
  assert.equal(financials.creditedReturn, 37.5)
  assert.match(financials.creditNote, /net adjustment/i)
})

test('expectedSettlementDelta mirrors the settlement rule on both debit paths', () => {
  const won = makeBet()
  assert.equal(expectedSettlementDelta(won, true), 62.5)
  assert.equal(expectedSettlementDelta(won, false), 37.5)
  assert.equal(expectedSettlementDelta({ ...won, status: 'lost' }, true), 0)
  assert.equal(expectedSettlementDelta({ ...won, status: 'lost' }, false), -25)
  assert.equal(expectedSettlementDelta({ ...won, status: 'void' }, true), 25)
  assert.equal(expectedSettlementDelta({ ...won, status: 'void' }, false), 0)
})

test('an open ticket claims nothing about payment', () => {
  const financials = buildTicketFinancials(makeBet({ status: 'open', result_correct: null, resolved_at: null }), {
    ledgerRows: ledger(1, { placed: -25 }),
  })

  assert.equal(financials.creditState, 'open')
  assert.equal(financials.creditedReturn, null)
  assert.equal(financials.realizedProfit, null)
})

test('a ticket outside the loaded ledger scope reports the credit as unconfirmed', () => {
  const financials = buildTicketFinancials(makeBet(), { ledgerRows: [], ledgerAvailable: false })

  assert.equal(financials.creditState, 'unknown')
  assert.match(financials.creditNote, /not loaded/i)
})

// ── outcome explanations ─────────────────────────────────────────────────────

test('a prop receipt names the final total, matching the example wording', () => {
  const bet = makeBet({
    bet_type: 'hit_prop', target_entity: 'Mario (Aidan)', chosen_side: 'over', line: 1.5,
  })
  const outcome = buildOutcomeExplanation(bet, {
    game: makeGame(),
    labels: LABELS,
    gameTotals: { hitTotals: { 'Mario (Aidan)': 2 }, hrTotals: {}, pitcherKTotals: {} },
    participation: { batters: new Set(['Mario (Aidan)']), pitchers: new Set() },
  })

  assert.equal(outcome.detail, 'Over 1.5 hits — finished with 2 hits.')
  assert.equal(outcome.basis, 'scoring-facts')
})

test('a single home run reads in the singular', () => {
  const bet = makeBet({ bet_type: 'hr_prop', target_entity: 'Mario (Aidan)', chosen_side: 'over', line: 0.5 })
  const outcome = buildOutcomeExplanation(bet, {
    game: makeGame(),
    labels: LABELS,
    gameTotals: { hitTotals: {}, hrTotals: { 'Mario (Aidan)': 1 }, pitcherKTotals: {} },
    participation: { batters: new Set(['Mario (Aidan)']), pitchers: new Set() },
  })

  assert.equal(outcome.detail, 'Over 0.5 home runs — finished with 1 home run.')
})

test('a target with no recorded appearance is not reported as a zero performance', () => {
  const bet = makeBet({
    bet_type: 'hit_prop', target_entity: 'Mario (Aidan)', chosen_side: 'over', line: 0.5,
    status: 'lost', result_correct: false,
  })
  const outcome = buildOutcomeExplanation(bet, {
    game: makeGame(),
    labels: LABELS,
    gameTotals: { hitTotals: {}, hrTotals: {}, pitcherKTotals: {} },
    participation: { batters: new Set(['Daisy (Donovan)']), pitchers: new Set() },
  })

  assert.match(outcome.detail, /no plate appearance is recorded for Mario \(Aidan\)/)
  assert.match(outcome.detail, /graded against a total of 0/)
})

test('a spread receipt shows the final score and the adjusted result from the chosen side', () => {
  // Donovan 6, Aidan 3 — a 3-run margin against a 1.5 spread.
  const homeTicket = buildOutcomeExplanation(
    makeBet({ bet_type: 'run_line', chosen_side: 'home', line: 1.5 }),
    { game: makeGame(), labels: LABELS },
  )
  assert.equal(homeTicket.headline, 'Covered')
  assert.equal(homeTicket.detail, 'Aidan 3, Donovan 6. Donovan -1.5: 6 - 1.5 = 4.5 against 3 for Aidan.')

  const awayTicket = buildOutcomeExplanation(
    makeBet({ bet_type: 'run_line', chosen_side: 'away', line: 1.5, status: 'lost', result_correct: false }),
    { game: makeGame(), labels: LABELS },
  )
  assert.equal(awayTicket.headline, 'Did not cover')
  assert.equal(awayTicket.detail, 'Aidan 3, Donovan 6. Aidan +1.5: 3 + 1.5 = 4.5 against 6 for Donovan.')
})

test('a spread landing exactly on the line is explained as a push', () => {
  const outcome = buildOutcomeExplanation(
    makeBet({ bet_type: 'run_line', chosen_side: 'home', line: 3, status: 'void', result_correct: null }),
    { game: makeGame(), labels: LABELS },
  )
  assert.equal(outcome.headline, 'Push')
  assert.match(outcome.detail, /landed exactly on 3\.0/)
})

test('a tied game explains the moneyline push from the final score', () => {
  const outcome = buildOutcomeExplanation(
    makeBet({ status: 'void', result_correct: null }),
    { game: makeGame({ team_a_runs: 4, team_b_runs: 4 }), labels: LABELS },
  )
  assert.match(outcome.headline, /Push/)
  assert.match(outcome.detail, /finished level/)
})

test('a total that lands on the line is a push, and one that clears it is explained by the run count', () => {
  const push = buildOutcomeExplanation(
    makeBet({ bet_type: 'over_under', chosen_side: 'over', line: 9, status: 'void', result_correct: null }),
    { game: makeGame(), labels: LABELS },
  )
  assert.equal(push.headline, 'Push')
  assert.match(push.detail, /exactly 9 runs/)

  const won = buildOutcomeExplanation(
    makeBet({ bet_type: 'over_under', chosen_side: 'over', line: 6.5 }),
    { game: makeGame(), labels: LABELS },
  )
  assert.equal(won.detail, 'Over 6.5 — the teams combined for 9 runs (Aidan 3, Donovan 6).')
})

test('an explanation that cannot be rebuilt from the facts says so instead of guessing', () => {
  const outcome = buildOutcomeExplanation(makeBet(), {
    game: makeGame({ team_a_runs: null, team_b_runs: null }),
    labels: LABELS,
  })
  assert.equal(outcome.basis, 'ticket-status')
  assert.match(outcome.detail, /not available/i)
})

// ── winning conditions ───────────────────────────────────────────────────────

test('both sides of a run line describe the same proposition from their own side', () => {
  assert.match(
    describeWinningConditions(makeBet({ bet_type: 'run_line', chosen_side: 'home', line: 1.5 }), LABELS),
    /Donovan must beat Aidan by more than 1\.5 runs/,
  )
  assert.match(
    describeWinningConditions(makeBet({ bet_type: 'run_line', chosen_side: 'away', line: 1.5 }), LABELS),
    /Aidan must win outright, or lose by fewer than 1\.5 runs/,
  )
})

test('a prop states the target, the direction and the game scope', () => {
  const text = describeWinningConditions(
    makeBet({ bet_type: 'k_prop', target_entity: 'Daisy (Donovan)', chosen_side: 'under', line: 4.5 }),
    LABELS,
  )
  assert.equal(text, 'Daisy (Donovan) must record fewer than 4.5 strikeouts in this game.')
})

// ── accepted terms vs the current board ──────────────────────────────────────

test('a market that moved after acceptance reports both prices without rewriting the ticket', () => {
  const bet = makeBet({ odds: 150, line: 1.5, bet_type: 'run_line', chosen_side: 'home' })
  const comparison = buildCurrentMarketComparison(bet, {
    bet_type: 'run_line', line: 1.5, odds_home: 120, odds_away: -140, is_locked: false,
  })

  assert.equal(comparison.currentOdds, 120)
  assert.equal(comparison.oddsDelta, -30)
  assert.equal(comparison.sameLine, true)
  assert.match(comparison.note, /pays at the accepted odds/i)
})

test('a board that moved to a different line is reported as a different proposition, with no delta', () => {
  const bet = makeBet({ odds: 150, line: 1.5, bet_type: 'run_line', chosen_side: 'home' })
  const comparison = buildCurrentMarketComparison(bet, {
    bet_type: 'run_line', line: 2.5, odds_home: 120, odds_away: -140,
  })

  assert.equal(comparison.sameLine, false)
  assert.equal(comparison.oddsDelta, null, 'prices across a line move are not comparable')
  assert.match(comparison.note, /not comparable/)
})

test('a market no longer on the board reports no current price', () => {
  const comparison = buildCurrentMarketComparison(makeBet(), null)
  assert.equal(comparison.available, false)
  assert.match(comparison.note, /no longer on the board/)
})

// ── whole receipt ────────────────────────────────────────────────────────────

test('a receipt never substitutes present values for placement context it does not have', () => {
  const receipt = buildBetReceipt({
    bet: makeBet(),
    game: makeGame(),
    marketRow: { bet_type: 'moneyline', odds_home: -110, odds_away: -110 },
    playersById: PLAYERS,
    charactersById: CHARACTERS,
    ledgerEntries: ledger(1, { placed: -25, settled: 62.5 }),
  })

  assert.equal(receipt.placementContext.scoreRecorded, false)
  assert.equal(receipt.placementContext.inningRecorded, false)
  assert.match(receipt.placementContext.note, /not recorded/i)
  assert.equal(receipt.placementContext.placedAt, '2026-07-20T12:00:00.000Z')
  // Accepted odds survive a board that has since moved to -110.
  assert.equal(receipt.acceptedTerms.odds, 150)
  assert.equal(receipt.acceptedTerms.oddsLabel, '+150')
  assert.equal(receipt.currentMarket.currentOdds, -110)
})

test('a ticket with no accepted line reports it as absent rather than as zero', () => {
  const receipt = buildBetReceipt({
    bet: makeBet({ line: null }),
    game: makeGame(),
    playersById: PLAYERS,
  })
  assert.equal(receipt.acceptedTerms.line, null)
  assert.equal(receipt.acceptedTerms.lineLabel, null)
})

test('a reopened ticket on a finished game is reported as a reversal awaiting resettlement', () => {
  const receipt = buildBetReceipt({
    bet: makeBet({ status: 'open', result_correct: null, resolved_at: null }),
    game: makeGame(),
    playersById: PLAYERS,
    ledgerEntries: ledger(1, { placed: -25 }),
  })

  assert.equal(receipt.isOpen, true)
  assert.equal(receipt.outcome, null, 'an unsettled ticket has no result to explain')
  assert.ok(receipt.settlement.notes.some((note) => /settlement was reversed/i.test(note)))
})

test('the settlement record states that reversed settlements are not retained', () => {
  const receipt = buildBetReceipt({
    bet: makeBet(),
    game: makeGame(),
    playersById: PLAYERS,
    ledgerEntries: ledger(1, { placed: -25, settled: 62.5 }),
  })

  assert.match(receipt.settlement.coverage, /not retained/i)
  assert.deepEqual(
    receipt.settlement.entries.map((entry) => entry.kind),
    ['placed', 'debit', 'graded', 'credit'],
  )
})

test('season and tournament tickets with the same numeric game id keep their own facts', () => {
  const bet = makeBet({ bet_type: 'hit_prop', target_entity: 'Mario (Aidan)', chosen_side: 'over', line: 0.5 })

  // Same game_id 77 in both competitions; only the caller's rows differ.
  const tournamentReceipt = buildBetReceipt({
    bet,
    game: makeGame(),
    playersById: PLAYERS,
    charactersById: CHARACTERS,
    plateAppearances: [{ game_id: 77, character_id: 11, player_id: 'p1', result: '1B' }],
    pitchingStints: [],
    competitionLabel: 'Tournament 5',
  })
  const seasonReceipt = buildBetReceipt({
    bet,
    game: makeGame(),
    playersById: PLAYERS,
    charactersById: CHARACTERS,
    plateAppearances: [{ game_id: 77, character_id: 11, player_id: 'p1', result: 'K' }],
    pitchingStints: [],
    competitionLabel: 'Season 3',
    competitionType: 'season',
  })

  assert.match(tournamentReceipt.outcome.detail, /finished with 1 hit\./)
  assert.match(seasonReceipt.outcome.detail, /finished with 0 hits\./)
  assert.equal(tournamentReceipt.competitionLabel, 'Tournament 5')
  assert.equal(seasonReceipt.competitionLabel, 'Season 3')
})

test('an empty receipt request returns nothing rather than an empty shell', () => {
  assert.equal(buildBetReceipt({ bet: null }), null)
})
