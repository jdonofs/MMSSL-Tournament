// Personal betting performance, aggregated from tickets.
//
// Basis, applied everywhere in this module without exception:
//
//   FINAL TICKET RESULTS. Each ticket contributes once, from its current status
//   and its own accepted terms — never from ledger activity. That is what makes
//   a reversal followed by a resettlement count once rather than twice: the
//   ticket has one status, so it has one contribution.
//
// Realized profit per settled ticket:
//   won   -> + potential_payout_dollars   (the accepted net profit)
//   lost  -> - wager_dollars
//   void  ->   0                          (push or void: the stake came back)
//
// Deposits, admin awards, sip purchases and transfers are not tickets and never
// enter any figure here. Every input is a row from `bets` / `season_bets`.
//
// Units are per competition. `BettingTab` mounts for one competition type at a
// time and this module never totals across the two.

import { getMarketLabel } from './bettingMarkets.js'
import { OPEN_STATUSES, SETTLED_STATUSES } from './betReceipt.js'

export const TICKET_STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'settled', label: 'Settled' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
  { id: 'void', label: 'Void / Push' },
]

export const PROFIT_BASIS_LABEL = 'Final ticket results'
export const PROFIT_BASIS_NOTE = 'Every figure below is computed from each ticket’s current status and its own accepted terms. A ticket counts once, so a settlement that was reversed and graded again is not counted twice.'
export const ROI_DENOMINATOR_NOTE = 'ROI = settled net profit ÷ the wagers actually at risk (won + lost tickets). Voided and pushed tickets return the stake, so they are excluded from the denominator and shown separately.'

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

export function isOpenStatus(status) {
  return OPEN_STATUSES.has(status)
}

export function isSettledStatus(status) {
  return SETTLED_STATUSES.has(status)
}

export function getRealizedProfit(bet = {}) {
  if (bet.status === 'won') return money(bet.potential_payout_dollars)
  if (bet.status === 'lost') return money(-Number(bet.wager_dollars || 0))
  if (bet.status === 'void') return 0
  return null
}

// ── Filtering ─────────────────────────────────────────────────────────────────

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/

// `<input type="date">` yields a bare calendar day, and the reader means their
// own day — so a bare bound is resolved in local time, start of day for `from`
// and end of day for `to`. Parsing it as UTC (which `new Date('2026-07-20')`
// does) silently drops evening tickets west of Greenwich.
function parseBound(value, endOfDay) {
  const raw = String(value)
  if (BARE_DATE.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number)
    return endOfDay
      ? new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
      : new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
  }
  return new Date(raw).getTime()
}

function withinRange(value, from, to) {
  if (!from && !to) return true
  if (!value) return false
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return false
  if (from) {
    const lower = parseBound(from, false)
    if (!Number.isNaN(lower) && time < lower) return false
  }
  if (to) {
    const upper = parseBound(to, true)
    if (!Number.isNaN(upper) && time > upper) return false
  }
  return true
}

// The date range is applied to `placed_at` — when the ticket was accepted —
// because that is the only placement fact the schema retains.
export function filterTickets(tickets = [], {
  competitionId = 'all',
  status = 'all',
  market = 'all',
  from = '',
  to = '',
} = {}) {
  return tickets.filter((ticket) => {
    if (competitionId !== 'all' && String(ticket.competitionId ?? '') !== String(competitionId)) return false
    if (market !== 'all' && ticket.bet_type !== market) return false
    if (!withinRange(ticket.placed_at, from, to)) return false
    if (status === 'all') return true
    if (status === 'open') return isOpenStatus(ticket.status)
    if (status === 'settled') return isSettledStatus(ticket.status)
    return ticket.status === status
  })
}

// ── Totals ────────────────────────────────────────────────────────────────────

export function summarizeTickets(tickets = []) {
  const open = tickets.filter((ticket) => isOpenStatus(ticket.status))
  const settled = tickets.filter((ticket) => isSettledStatus(ticket.status))
  const won = settled.filter((ticket) => ticket.status === 'won')
  const lost = settled.filter((ticket) => ticket.status === 'lost')
  const voided = settled.filter((ticket) => ticket.status === 'void')

  const sumWager = (rows) => money(rows.reduce((total, row) => total + Number(row.wager_dollars || 0), 0))
  const sumProfit = (rows) => money(rows.reduce((total, row) => total + Number(row.potential_payout_dollars || 0), 0))

  const openExposure = sumWager(open)
  const openPotentialProfit = sumProfit(open)
  const settledWagered = sumWager(settled)
  const atRiskWagered = money(sumWager(won) + sumWager(lost))
  const settledNetProfit = money(settled.reduce((total, ticket) => total + (getRealizedProfit(ticket) || 0), 0))

  return {
    ticketCount: tickets.length,
    openCount: open.length,
    settledCount: settled.length,
    wins: won.length,
    losses: lost.length,
    // The schema stores a push and a genuine void under the same `void`
    // status, so they are one category here and the label says so.
    voidsAndPushes: voided.length,

    openExposure,
    openPotentialProfit,
    openPotentialReturn: money(openExposure + openPotentialProfit),

    settledWagered,
    atRiskWagered,
    settledNetProfit,
    roi: atRiskWagered > 0 ? settledNetProfit / atRiskWagered : null,

    // Denominators, stated rather than implied.
    winRate: (won.length + lost.length) > 0 ? won.length / (won.length + lost.length) : null,
    winRateDenominator: won.length + lost.length,
    settledDenominator: settled.length,
  }
}

// ── Results by market ─────────────────────────────────────────────────────────

export function buildMarketBreakdown(tickets = []) {
  const byType = new Map()

  tickets.forEach((ticket) => {
    const key = ticket.bet_type || 'unknown'
    if (!byType.has(key)) {
      byType.set(key, {
        betType: key,
        label: getMarketLabel(key),
        tickets: 0,
        open: 0,
        settled: 0,
        wins: 0,
        losses: 0,
        voidsAndPushes: 0,
        wagered: 0,
        atRiskWagered: 0,
        netProfit: 0,
      })
    }
    const entry = byType.get(key)
    entry.tickets += 1
    const wager = Number(ticket.wager_dollars || 0)
    if (isOpenStatus(ticket.status)) {
      entry.open += 1
      return
    }
    if (!isSettledStatus(ticket.status)) return
    entry.settled += 1
    entry.wagered += wager
    entry.netProfit += getRealizedProfit(ticket) || 0
    if (ticket.status === 'won') { entry.wins += 1; entry.atRiskWagered += wager }
    else if (ticket.status === 'lost') { entry.losses += 1; entry.atRiskWagered += wager }
    else entry.voidsAndPushes += 1
  })

  return [...byType.values()]
    .map((entry) => ({
      ...entry,
      wagered: money(entry.wagered),
      atRiskWagered: money(entry.atRiskWagered),
      netProfit: money(entry.netProfit),
      roi: entry.atRiskWagered > 0 ? money(entry.netProfit) / money(entry.atRiskWagered) : null,
      winRate: (entry.wins + entry.losses) > 0 ? entry.wins / (entry.wins + entry.losses) : null,
      winRateDenominator: entry.wins + entry.losses,
    }))
    .sort((a, b) => b.tickets - a.tickets || a.label.localeCompare(b.label))
}

// ── Cumulative profit curve ───────────────────────────────────────────────────

export const PROFIT_CURVE_BASIS_NOTE = 'Cumulative profit is plotted by settlement time (`resolved_at`) using each ticket’s final result. A ticket that was reversed and settled again sits at its latest settlement time, and still counts once.'

// One point per settled ticket, ordered by settlement time. Tickets whose
// settlement time was never recorded cannot be placed on a time axis; they are
// excluded and counted so the gap is visible rather than silently absorbed.
export function buildCumulativeProfitSeries(tickets = []) {
  const settled = tickets.filter((ticket) => isSettledStatus(ticket.status))
  const hasSettlementTime = (ticket) => Boolean(ticket.resolved_at)
    && !Number.isNaN(new Date(ticket.resolved_at).getTime())
  const dated = settled.filter(hasSettlementTime)
  const undated = settled.filter((ticket) => !hasSettlementTime(ticket))

  const ordered = [...dated].sort((a, b) => {
    const delta = new Date(a.resolved_at) - new Date(b.resolved_at)
    return delta !== 0 ? delta : Number(a.id || 0) - Number(b.id || 0)
  })

  let running = 0
  const points = ordered.map((ticket) => {
    const profit = getRealizedProfit(ticket) || 0
    running = money(running + profit)
    return {
      betId: ticket.id,
      at: ticket.resolved_at,
      profit: money(profit),
      cumulative: running,
      status: ticket.status,
      betType: ticket.bet_type,
    }
  })

  const excludedProfit = money(undated.reduce((total, ticket) => total + (getRealizedProfit(ticket) || 0), 0))

  return {
    points,
    basis: PROFIT_CURVE_BASIS_NOTE,
    excludedCount: undated.length,
    excludedProfit,
    // The curve's endpoint only equals the headline settled net profit when
    // every settled ticket carries a settlement time.
    coversAllSettled: undated.length === 0,
    endingCumulative: points.length ? points[points.length - 1].cumulative : 0,
  }
}

// ── Whole dashboard ───────────────────────────────────────────────────────────

export function buildBettingDashboard(tickets = [], filters = {}) {
  const filtered = filterTickets(tickets, filters)
  return {
    filters,
    tickets: filtered,
    totals: summarizeTickets(filtered),
    markets: buildMarketBreakdown(filtered),
    curve: buildCumulativeProfitSeries(filtered),
    isEmpty: filtered.length === 0,
  }
}

export function listMarketOptions(tickets = []) {
  const seen = new Map()
  tickets.forEach((ticket) => {
    const key = ticket.bet_type || 'unknown'
    if (!seen.has(key)) seen.set(key, { id: key, label: getMarketLabel(key), count: 0 })
    seen.get(key).count += 1
  })
  return [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function listCompetitionOptions(tickets = [], labelsById = {}) {
  const seen = new Map()
  tickets.forEach((ticket) => {
    const id = ticket.competitionId
    if (id == null) return
    const key = String(id)
    if (!seen.has(key)) {
      seen.set(key, { id: key, label: labelsById[key] || `Competition ${key}`, count: 0 })
    }
    seen.get(key).count += 1
  })
  return [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
