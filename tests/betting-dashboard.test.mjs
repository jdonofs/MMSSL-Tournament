// Personal betting dashboard: totals, ROI denominators, the cumulative curve,
// and the market breakdown.
//
// Every expected figure is a hand-worked literal. The suite deliberately mixes
// a reversed-then-resettled ticket, a still-open ticket and a void into the same
// dataset, because those are the three ways a naive total goes wrong.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBettingDashboard,
  buildCumulativeProfitSeries,
  buildMarketBreakdown,
  filterTickets,
  getRealizedProfit,
  listCompetitionOptions,
  listMarketOptions,
  summarizeTickets,
} from '../src/utils/bettingPerformance.js'

function ticket(overrides = {}) {
  return {
    id: 1,
    competitionId: 5,
    competitionLabel: 'Tournament 5',
    bet_type: 'moneyline',
    status: 'won',
    wager_dollars: 10,
    potential_payout_dollars: 15,
    placed_at: '2026-07-20T12:00:00.000Z',
    resolved_at: '2026-07-20T14:00:00.000Z',
    ...overrides,
  }
}

// $10 at +150 wins $15; $20 at -200 wins $10; a $30 loss is -$30; a void is 0.
const MIXED = [
  ticket({ id: 1, status: 'won', wager_dollars: 10, potential_payout_dollars: 15, resolved_at: '2026-07-20T14:00:00.000Z' }),
  ticket({ id: 2, status: 'lost', wager_dollars: 30, potential_payout_dollars: 45, bet_type: 'over_under', resolved_at: '2026-07-21T14:00:00.000Z' }),
  ticket({ id: 3, status: 'void', wager_dollars: 12, potential_payout_dollars: 11, bet_type: 'run_line', resolved_at: '2026-07-22T14:00:00.000Z' }),
  ticket({ id: 4, status: 'won', wager_dollars: 20, potential_payout_dollars: 10, bet_type: 'hit_prop', resolved_at: '2026-07-23T14:00:00.000Z' }),
  ticket({ id: 5, status: 'open', wager_dollars: 8, potential_payout_dollars: 16, bet_type: 'hr_prop', resolved_at: null, placed_at: '2026-07-24T12:00:00.000Z' }),
]

test('open exposure and potential return are the open tickets only', () => {
  const totals = summarizeTickets(MIXED)

  assert.equal(totals.openCount, 1)
  assert.equal(totals.openExposure, 8)
  assert.equal(totals.openPotentialProfit, 16)
  assert.equal(totals.openPotentialReturn, 24, 'stake plus profit')
})

test('settled net profit sums each ticket exactly once from its own terms', () => {
  const totals = summarizeTickets(MIXED)

  // +15 - 30 + 0 + 10 = -5
  assert.equal(totals.settledNetProfit, -5)
  assert.equal(totals.settledCount, 4)
  assert.equal(totals.wins, 2)
  assert.equal(totals.losses, 1)
  assert.equal(totals.voidsAndPushes, 1)
})

test('ROI divides by wagers actually at risk, with the void excluded', () => {
  const totals = summarizeTickets(MIXED)

  assert.equal(totals.settledWagered, 72, '10 + 30 + 12 + 20')
  assert.equal(totals.atRiskWagered, 60, '10 + 30 + 20 — the voided 12 came back')
  assert.equal(totals.roi, -5 / 60)
  assert.equal(totals.winRate, 2 / 3)
  assert.equal(totals.winRateDenominator, 3, 'won + lost, not including the void')
})

test('an empty dataset produces zeroes and no rates rather than divide-by-zero values', () => {
  const totals = summarizeTickets([])

  assert.equal(totals.settledNetProfit, 0)
  assert.equal(totals.settledWagered, 0)
  assert.equal(totals.roi, null)
  assert.equal(totals.winRate, null)
  assert.equal(totals.winRateDenominator, 0)
})

test('a player with only open tickets has no ROI to report', () => {
  const totals = summarizeTickets([ticket({ status: 'open', resolved_at: null })])

  assert.equal(totals.roi, null)
  assert.equal(totals.settledCount, 0)
  assert.equal(totals.openExposure, 10)
})

test('a reversed and resettled ticket counts once, at its final status', () => {
  // Same ticket id, graded twice: only its current row exists, so only its
  // current status can contribute.
  const beforeReversal = [ticket({ id: 9, status: 'won', wager_dollars: 10, potential_payout_dollars: 15 })]
  const afterResettlement = [ticket({ id: 9, status: 'lost', wager_dollars: 10, potential_payout_dollars: 15, resolved_at: '2026-07-25T14:00:00.000Z' })]

  assert.equal(summarizeTickets(beforeReversal).settledNetProfit, 15)
  assert.equal(summarizeTickets(afterResettlement).settledNetProfit, -10)
  assert.equal(summarizeTickets(afterResettlement).settledCount, 1, 'one ticket, one contribution')
})

test('a ticket reopened by a reversal leaves the settled totals and joins the open ones', () => {
  const reopened = [ticket({ id: 9, status: 'open', resolved_at: null })]
  const totals = summarizeTickets(reopened)

  assert.equal(totals.settledCount, 0)
  assert.equal(totals.settledNetProfit, 0)
  assert.equal(totals.openExposure, 10)
})

test('realized profit is null while a ticket is undecided', () => {
  assert.equal(getRealizedProfit(ticket({ status: 'open' })), null)
  assert.equal(getRealizedProfit(ticket({ status: 'pending' })), null)
  assert.equal(getRealizedProfit(ticket({ status: 'void' })), 0)
})

// ── curve ────────────────────────────────────────────────────────────────────

test('the cumulative curve runs in settlement order and ends at the settled total', () => {
  const curve = buildCumulativeProfitSeries(MIXED)

  assert.deepEqual(curve.points.map((point) => point.cumulative), [15, -15, -15, -5])
  assert.equal(curve.endingCumulative, -5)
  assert.equal(curve.excludedCount, 0)
  assert.equal(curve.coversAllSettled, true)
  assert.match(curve.basis, /settlement time/i)
})

test('a settled ticket with no settlement time is excluded from the curve and counted', () => {
  const withUndated = [
    ...MIXED,
    ticket({ id: 6, status: 'won', wager_dollars: 5, potential_payout_dollars: 9, resolved_at: null }),
  ]
  const curve = buildCumulativeProfitSeries(withUndated)

  assert.equal(curve.points.length, 4, 'the undated ticket has no place on a time axis')
  assert.equal(curve.excludedCount, 1)
  assert.equal(curve.excludedProfit, 9)
  assert.equal(curve.coversAllSettled, false)
  // The headline total still includes it; the curve endpoint does not, and the
  // component says so.
  assert.equal(summarizeTickets(withUndated).settledNetProfit, 4)
  assert.equal(curve.endingCumulative, -5)
})

test('an unparseable settlement time is treated as missing, not as epoch zero', () => {
  const curve = buildCumulativeProfitSeries([ticket({ id: 7, resolved_at: 'not a date' })])
  assert.equal(curve.points.length, 0)
  assert.equal(curve.excludedCount, 1)
})

test('an empty curve reports no points rather than a flat line at zero', () => {
  const curve = buildCumulativeProfitSeries([])
  assert.deepEqual(curve.points, [])
  assert.equal(curve.endingCumulative, 0)
})

// ── market breakdown ─────────────────────────────────────────────────────────

test('the market breakdown carries its own sample counts and per-market denominators', () => {
  const rows = buildMarketBreakdown(MIXED)
  const byType = Object.fromEntries(rows.map((row) => [row.betType, row]))

  assert.equal(byType.moneyline.tickets, 1)
  assert.equal(byType.moneyline.netProfit, 15)
  assert.equal(byType.moneyline.roi, 1.5, '15 profit on 10 at risk')

  assert.equal(byType.run_line.settled, 1)
  assert.equal(byType.run_line.voidsAndPushes, 1)
  assert.equal(byType.run_line.atRiskWagered, 0)
  assert.equal(byType.run_line.roi, null, 'a void-only market has no rate')
  assert.equal(byType.run_line.winRate, null)

  assert.equal(byType.hr_prop.open, 1)
  assert.equal(byType.hr_prop.settled, 0)
  assert.equal(byType.hr_prop.wagered, 0, 'an open wager is exposure, not settled volume')
})

// ── filters ──────────────────────────────────────────────────────────────────

test('status, market, competition and date filters each narrow the set', () => {
  assert.equal(filterTickets(MIXED, { status: 'open' }).length, 1)
  assert.equal(filterTickets(MIXED, { status: 'settled' }).length, 4)
  assert.equal(filterTickets(MIXED, { status: 'void' }).length, 1)
  assert.equal(filterTickets(MIXED, { market: 'hit_prop' }).length, 1)
  assert.equal(filterTickets(MIXED, { competitionId: 5 }).length, 5)
  assert.equal(filterTickets(MIXED, { competitionId: 6 }).length, 0)
})

test('the date range applies to placement and includes the whole closing day', () => {
  // A bare date bound means the reader's own calendar day, so the fixture is
  // built in local time and the assertion holds in any timezone.
  const localIso = (year, month, day, hour, minute) =>
    new Date(year, month - 1, day, hour, minute).toISOString()
  const spread = [
    ticket({ id: 1, placed_at: localIso(2026, 7, 19, 23, 59) }),
    ticket({ id: 2, placed_at: localIso(2026, 7, 20, 0, 30) }),
    ticket({ id: 3, placed_at: localIso(2026, 7, 20, 23, 30) }),
    ticket({ id: 4, placed_at: localIso(2026, 7, 21, 8, 0) }),
  ]
  const inRange = filterTickets(spread, { from: '2026-07-20', to: '2026-07-20' })
  assert.deepEqual(inRange.map((entry) => entry.id), [2, 3])
})

test('filtering by a competition keeps that competition to itself', () => {
  const mixedCompetitions = [
    ticket({ id: 1, competitionId: 5, competitionLabel: 'Tournament 5', status: 'won', wager_dollars: 10, potential_payout_dollars: 15 }),
    ticket({ id: 2, competitionId: 6, competitionLabel: 'Tournament 6', status: 'lost', wager_dollars: 40, potential_payout_dollars: 40 }),
  ]

  assert.equal(summarizeTickets(filterTickets(mixedCompetitions, { competitionId: 5 })).settledNetProfit, 15)
  assert.equal(summarizeTickets(filterTickets(mixedCompetitions, { competitionId: 6 })).settledNetProfit, -40)
  assert.equal(summarizeTickets(mixedCompetitions).settledNetProfit, -25, 'both, only when both are asked for')
})

test('the option lists carry counts so a filter never hides its own sample size', () => {
  assert.deepEqual(
    listMarketOptions(MIXED).map((option) => [option.id, option.count]).sort(),
    [['hit_prop', 1], ['hr_prop', 1], ['moneyline', 1], ['over_under', 1], ['run_line', 1]].sort(),
  )
  assert.deepEqual(
    listCompetitionOptions(MIXED, { 5: 'Tournament 5' }),
    [{ id: '5', label: 'Tournament 5', count: 5 }],
  )
})

test('a competition with no label falls back to its id rather than an empty option', () => {
  assert.deepEqual(
    listCompetitionOptions([ticket({ competitionId: 12 })], {}),
    [{ id: '12', label: 'Competition 12', count: 1 }],
  )
})

// ── whole dashboard ──────────────────────────────────────────────────────────

test('the dashboard applies one filter set consistently to totals, markets and curve', () => {
  const dashboard = buildBettingDashboard(MIXED, { status: 'settled' })

  assert.equal(dashboard.tickets.length, 4)
  assert.equal(dashboard.totals.openCount, 0)
  assert.equal(dashboard.totals.settledNetProfit, -5)
  assert.equal(dashboard.curve.points.length, 4)
  assert.equal(dashboard.markets.reduce((sum, row) => sum + row.tickets, 0), 4)
  assert.equal(dashboard.isEmpty, false)
})

test('a filter that matches nothing produces an empty dashboard, not a broken one', () => {
  const dashboard = buildBettingDashboard(MIXED, { market: 'k_prop' })

  assert.equal(dashboard.isEmpty, true)
  assert.equal(dashboard.totals.settledNetProfit, 0)
  assert.equal(dashboard.totals.roi, null)
  assert.deepEqual(dashboard.markets, [])
  assert.deepEqual(dashboard.curve.points, [])
})

test('a long ticket history stays exact and orders the curve by settlement time', () => {
  // 250 alternating tickets: 125 wins at +8 profit, 125 losses at -5.
  const many = Array.from({ length: 250 }, (_, index) => ticket({
    id: index + 1,
    status: index % 2 === 0 ? 'won' : 'lost',
    wager_dollars: 5,
    potential_payout_dollars: 8,
    resolved_at: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
  }))

  const totals = summarizeTickets(many)
  assert.equal(totals.settledCount, 250)
  assert.equal(totals.settledNetProfit, 125 * 8 - 125 * 5)
  assert.equal(totals.atRiskWagered, 250 * 5)

  const curve = buildCumulativeProfitSeries(many)
  assert.equal(curve.points.length, 250)
  assert.equal(curve.points[0].cumulative, 8)
  assert.equal(curve.points[1].cumulative, 3)
  assert.equal(curve.endingCumulative, totals.settledNetProfit)
})
