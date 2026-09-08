// The durable record of one ticket.
//
// Everything here is built from what was actually stored: the ticket's own
// accepted terms, the scoring facts of its game, and the ledger rows keyed to
// its `bet_id`. A later market move must never rewrite a receipt, so the
// current board is reported alongside the accepted terms and never in place of
// them, and anything that was not retained is reported as unavailable rather
// than filled in from the present.
//
// The other rule this module enforces: a calculated outcome is not a payment.
// "Your side won" comes from the scoring facts; "you were paid" comes from a
// `bet_settled:` ledger row and from nothing else.

import { buildBettingEntityLabel } from './oddsEngine.js'
import {
  buildGameResolutionTotals,
  formatOdds,
  getMarketLabel,
  getTargetPlayerName,
  getTargetPortraitName,
  getTeamLabels,
} from './bettingMarkets.js'

export const OPEN_STATUSES = new Set(['open', 'pending'])
export const SETTLED_STATUSES = new Set(['won', 'lost', 'void'])

const PLACED_REASON_PREFIX = 'bet_placed'
const SETTLED_REASON_PREFIX = 'bet_settled'

export function isOpenTicket(bet = {}) {
  return OPEN_STATUSES.has(bet.status)
}

export function isSettledTicket(bet = {}) {
  return SETTLED_STATUSES.has(bet.status)
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatLine(value) {
  const parsed = numberOrNull(value)
  return parsed == null ? null : parsed.toFixed(1)
}

// ── Accepted terms ────────────────────────────────────────────────────────────

export function getChosenSideLabel(bet = {}, labels = {}) {
  const line = formatLine(bet.line)
  switch (bet.bet_type) {
    case 'moneyline':
      return bet.chosen_side === 'home' ? labels.home || 'Home' : labels.away || 'Away'
    case 'run_line':
      return `${bet.chosen_side === 'home' ? labels.home || 'Home' : labels.away || 'Away'} ${Number(bet.line) >= 0 ? '+' : ''}${line ?? '--'}`
    case 'over_under':
    case 'hit_prop':
    case 'hr_prop':
    case 'k_prop':
      return `${bet.chosen_side === 'over' ? 'Over' : 'Under'} ${line ?? '--'}`
    case 'first_inning_run':
      return bet.chosen_side === 'yes' ? 'Yes' : 'No'
    default:
      return bet.chosen_side || '--'
  }
}

const PROP_UNITS = {
  hit_prop: { singular: 'hit', plural: 'hits' },
  hr_prop: { singular: 'home run', plural: 'home runs' },
  k_prop: { singular: 'strikeout', plural: 'strikeouts' },
}

function pluralize(count, unit) {
  if (!unit) return String(count)
  return `${count} ${Math.abs(count) === 1 ? unit.singular : unit.plural}`
}

// Plain language, in the second person, describing exactly what has to happen.
export function describeWinningConditions(bet = {}, labels = {}) {
  const line = formatLine(bet.line)
  const target = bet.target_entity || 'the selected player'
  switch (bet.bet_type) {
    case 'moneyline': {
      const side = bet.chosen_side === 'home' ? labels.home || 'the home team' : labels.away || 'the away team'
      return `${side} must win the game. A tie voids the ticket and refunds the wager.`
    }
    case 'run_line': {
      // The stored line is the spread the HOME team must beat; the away side
      // is the other half of that same proposition.
      const home = labels.home || 'the home team'
      const away = labels.away || 'the away team'
      return bet.chosen_side === 'home'
        ? `${home} must beat ${away} by more than ${line ?? '--'} runs. A winning margin of exactly ${line ?? '--'} is a push and refunds the wager.`
        : `${away} must win outright, or lose by fewer than ${line ?? '--'} runs. A ${home} margin of exactly ${line ?? '--'} is a push and refunds the wager.`
    }
    case 'over_under':
      return bet.chosen_side === 'over'
        ? `The two teams must combine for more than ${line ?? '--'} runs. Exactly ${line ?? '--'} is a push.`
        : `The two teams must combine for fewer than ${line ?? '--'} runs. Exactly ${line ?? '--'} is a push.`
    case 'first_inning_run':
      return bet.chosen_side === 'yes'
        ? 'At least one run must score in the 1st inning.'
        : 'The 1st inning must end with no runs scored.'
    case 'hit_prop':
    case 'hr_prop':
    case 'k_prop': {
      const unit = PROP_UNITS[bet.bet_type]
      const noun = unit ? unit.plural : 'events'
      const verb = bet.bet_type === 'k_prop' ? 'must record' : 'must finish with'
      return bet.chosen_side === 'over'
        ? `${target} ${verb} more than ${line ?? '--'} ${noun} in this game.`
        : `${target} ${verb} fewer than ${line ?? '--'} ${noun} in this game.`
    }
    default:
      return 'Winning conditions for this market are not described.'
  }
}

// ── Outcome ───────────────────────────────────────────────────────────────────

function finalScores(game = {}) {
  const away = numberOrNull(game.team_a_runs)
  const home = numberOrNull(game.team_b_runs)
  if (away == null || home == null) return null
  return { away, home, total: away + home, margin: Math.abs(away - home) }
}

function scoreLine(game, labels) {
  const scores = finalScores(game)
  if (!scores) return null
  return `${labels.away || 'Away'} ${scores.away}, ${labels.home || 'Home'} ${scores.home}`
}

function propFinalCount(bet, gameTotals) {
  if (!gameTotals) return null
  const table = bet.bet_type === 'k_prop' ? gameTotals.pitcherKTotals
    : bet.bet_type === 'hr_prop' ? gameTotals.hrTotals
      : bet.bet_type === 'hit_prop' ? gameTotals.hitTotals
        : null
  if (!table) return null
  // A target with no rows finished with zero, which is a real result for a
  // player who appeared. The receipt says so explicitly rather than implying a
  // measurement gap.
  return Number(table[bet.target_entity] || 0)
}

// A factual sentence about what happened, built from the game's scoring facts —
// never from the ticket's status alone. `basis` says which facts were used so
// the UI can label a derived explanation as derived.
export function buildOutcomeExplanation(bet = {}, { game = null, labels = {}, gameTotals = null, participation = null } = {}) {
  if (!isSettledTicket(bet)) return null

  const gameComplete = game?.status === 'complete'
  const scores = finalScores(game)
  const line = numberOrNull(bet.line)
  const lineText = formatLine(bet.line) ?? '--'

  const unavailable = (reason) => ({
    headline: bet.status === 'won' ? 'Won' : bet.status === 'lost' ? 'Lost' : 'Void',
    detail: reason,
    basis: 'ticket-status',
  })

  switch (bet.bet_type) {
    case 'moneyline': {
      if (!scores) return unavailable('The final score for this game is not available, so the graded result cannot be explained from the scoring facts.')
      const winner = scores.home === scores.away ? null : scores.home > scores.away ? 'home' : 'away'
      if (winner == null) {
        return {
          headline: 'Push — tied game',
          detail: `${scoreLine(game, labels)} — the game finished level, so the moneyline was voided and the wager refunded.`,
          basis: 'final-score',
        }
      }
      const winnerLabel = winner === 'home' ? labels.home || 'Home' : labels.away || 'Away'
      return {
        headline: bet.status === 'won' ? 'Won' : 'Lost',
        detail: `${scoreLine(game, labels)} — ${winnerLabel} won.`,
        basis: 'final-score',
      }
    }

    case 'run_line': {
      if (!scores || line == null) return unavailable('The final score or the accepted spread is not available, so the graded result cannot be explained.')
      if (scores.home === scores.away || scores.margin === line) {
        return {
          headline: 'Push',
          detail: scores.home === scores.away
            ? `${scoreLine(game, labels)} — the game finished level, so the run line was voided and the wager refunded.`
            : `${scoreLine(game, labels)} — the margin landed exactly on ${lineText}, so the run line was voided and the wager refunded.`,
          basis: 'final-score',
        }
      }
      // The spread is stored against the home team, so the selected side is
      // shown with the sign it actually laid or took.
      const isHome = bet.chosen_side === 'home'
      const homeCovered = scores.home > scores.away && scores.margin > line
      const sideCovered = isHome ? homeCovered : !homeCovered
      const homeLabel = labels.home || 'Home'
      const awayLabel = labels.away || 'Away'
      const perspective = isHome
        ? `${homeLabel} -${lineText}: ${scores.home} - ${lineText} = ${money(scores.home - line).toFixed(1)} against ${scores.away} for ${awayLabel}.`
        : `${awayLabel} +${lineText}: ${scores.away} + ${lineText} = ${money(scores.away + line).toFixed(1)} against ${scores.home} for ${homeLabel}.`
      return {
        headline: sideCovered ? 'Covered' : 'Did not cover',
        detail: `${scoreLine(game, labels)}. ${perspective}`,
        basis: 'final-score',
      }
    }

    case 'over_under': {
      if (!scores || line == null) return unavailable('The final score or the accepted total is not available, so the graded result cannot be explained.')
      if (scores.total === line) {
        return {
          headline: 'Push',
          detail: `The teams combined for exactly ${scores.total} runs, landing on the ${lineText} total — the ticket was voided and the wager refunded.`,
          basis: 'final-score',
        }
      }
      return {
        headline: bet.status === 'won' ? 'Won' : 'Lost',
        detail: `${bet.chosen_side === 'over' ? 'Over' : 'Under'} ${lineText} — the teams combined for ${scores.total} runs (${scoreLine(game, labels)}).`,
        basis: 'final-score',
      }
    }

    case 'first_inning_run': {
      const scored = bet.result_correct == null
        ? null
        : (bet.chosen_side === 'yes') === Boolean(bet.result_correct)
      if (scored == null) {
        return unavailable('This ticket was voided without a recorded first-inning result.')
      }
      return {
        headline: bet.status === 'won' ? 'Won' : 'Lost',
        detail: scored
          ? 'A run scored in the 1st inning.'
          : 'The 1st inning ended with no runs scored.',
        // Derived from the graded ticket rather than re-read from the run rows,
        // because the inning-1 evidence a settlement used is not retained.
        basis: 'graded-result',
      }
    }

    case 'hit_prop':
    case 'hr_prop':
    case 'k_prop': {
      const unit = PROP_UNITS[bet.bet_type]
      const actual = propFinalCount(bet, gameTotals)
      if (actual == null || !gameComplete) {
        return unavailable(`The completed-game totals for ${bet.target_entity || 'this player'} are not loaded, so the graded result cannot be explained from the scoring facts.`)
      }
      const headline = bet.status === 'won' ? 'Won' : bet.status === 'lost' ? 'Lost' : 'Void'
      const appeared = bet.bet_type === 'k_prop'
        ? participation?.pitchers?.has(bet.target_entity)
        : participation?.batters?.has(bet.target_entity)
      // A target with no rows in this game grades against a total of 0, which
      // is not the same fact as appearing and recording none. Say which it was.
      if (participation && !appeared) {
        return {
          headline,
          detail: `${bet.chosen_side === 'over' ? 'Over' : 'Under'} ${lineText} ${unit.plural} — no ${bet.bet_type === 'k_prop' ? 'pitching appearance' : 'plate appearance'} is recorded for ${bet.target_entity} in this game, so the ticket was graded against a total of 0.`,
          basis: 'scoring-facts',
        }
      }
      return {
        headline,
        detail: `${bet.chosen_side === 'over' ? 'Over' : 'Under'} ${lineText} ${unit.plural} — finished with ${pluralize(actual, unit)}.`,
        basis: 'scoring-facts',
      }
    }

    default:
      return unavailable('This market has no settlement rule, so the ticket was voided and the wager refunded.')
  }
}

// Which entities actually appear in a game's recorded rows. Absence of a row is
// the only evidence there is, so it is reported as absence rather than as zero.
export function buildGameParticipation(gameId, plateAppearances = [], pitchingStints = [], charactersById = {}, playersById = {}) {
  const scopedGameId = String(gameId)
  const batters = new Set()
  const pitchers = new Set()
  plateAppearances.forEach((row) => {
    if (String(row.game_id) !== scopedGameId) return
    batters.add(buildBettingEntityLabel(charactersById[row.character_id], playersById[row.player_id]))
  })
  pitchingStints.forEach((row) => {
    if (String(row.game_id) !== scopedGameId) return
    pitchers.add(buildBettingEntityLabel(charactersById[row.character_id], playersById[row.player_id]))
  })
  return { batters, pitchers }
}

// ── Money ─────────────────────────────────────────────────────────────────────

// Mirrors `buildSettledLedgerRows` in betResolution.js exactly. Kept as its own
// function so a receipt can say what SHOULD have been credited and compare it
// with what was.
export function expectedSettlementDelta(bet = {}, hasPlacementDebit = true) {
  const wager = money(bet.wager_dollars)
  const profit = money(bet.potential_payout_dollars)
  if (bet.status === 'won') return hasPlacementDebit ? money(wager + profit) : profit
  if (bet.status === 'void') return hasPlacementDebit ? wager : 0
  if (bet.status === 'lost') return hasPlacementDebit ? 0 : money(-wager)
  return 0
}

export function selectTicketLedgerRows(bet = {}, ledgerEntries = []) {
  return (ledgerEntries || []).filter((row) => row.bet_id != null && String(row.bet_id) === String(bet.id))
}

// `wager`, `potentialProfit` and `potentialReturn` come from the ticket's own
// accepted terms. `creditedReturn` comes only from the ledger, and `creditState`
// says whether a credit was actually recorded, is still owed, or was never
// expected in the first place.
export function buildTicketFinancials(bet = {}, {
  ledgerRows = [],
  ledgerChangeField = 'points_change',
  ledgerAvailable = true,
} = {}) {
  const wager = money(bet.wager_dollars)
  const potentialProfit = money(bet.potential_payout_dollars)
  const potentialReturn = money(wager + potentialProfit)

  const placementRow = ledgerRows.find((row) => String(row.reason || '').startsWith(`${PLACED_REASON_PREFIX}:`)) || null
  const settlementRow = ledgerRows.find((row) => String(row.reason || '').startsWith(`${SETTLED_REASON_PREFIX}:`)) || null
  const hasPlacementDebit = Boolean(placementRow)
  const settledDelta = settlementRow ? money(settlementRow[ledgerChangeField]) : null
  const expectedDelta = isSettledTicket(bet) ? expectedSettlementDelta(bet, hasPlacementDebit) : null

  let creditState = 'open'
  let creditNote = ''
  let creditedReturn = null

  if (!ledgerAvailable) {
    creditState = 'unknown'
    creditNote = 'Ledger rows for this competition are not loaded, so a credit cannot be confirmed here.'
  } else if (!isSettledTicket(bet)) {
    creditState = 'open'
    creditNote = 'This ticket has not been settled, so nothing has been credited yet.'
  } else if (bet.status === 'lost' && hasPlacementDebit) {
    creditState = 'no-credit-expected'
    creditedReturn = 0
    creditNote = 'A losing ticket has no credit: the wager was debited when the ticket was accepted.'
  } else if (settlementRow == null) {
    creditState = 'pending'
    creditNote = `Graded ${bet.status}, but no settlement entry has been recorded in the ledger yet. Nothing has been paid.`
  } else if (expectedDelta != null && Math.abs(settledDelta - expectedDelta) > 0.005) {
    creditState = 'mismatch'
    creditedReturn = settledDelta
    creditNote = `The recorded settlement entry (${settledDelta.toFixed(2)}) does not match this ticket's terms (${expectedDelta.toFixed(2)}). It is awaiting resettlement.`
  } else {
    creditState = 'credited'
    creditedReturn = settledDelta
    creditNote = hasPlacementDebit
      ? 'Credited to your balance, stake included.'
      : 'Credited to your balance as a net adjustment — no wager debit was recorded for this ticket, so the stake was never taken.'
  }

  // Realized profit from the ticket's own terms, used by the dashboard. Voids
  // and pushes are zero: the stake came back.
  const realizedProfit = bet.status === 'won' ? potentialProfit
    : bet.status === 'lost' ? money(-wager)
      : bet.status === 'void' ? 0
        : null

  return {
    wager,
    potentialProfit,
    potentialReturn,
    creditedReturn,
    creditState,
    creditNote,
    expectedSettlementDelta: expectedDelta,
    settledDelta,
    hasPlacementDebit,
    placementRow,
    settlementRow,
    realizedProfit,
    // Net movement the ledger actually recorded for this ticket, placement
    // debit included. Independent of the ticket-terms figure above.
    ledgerNet: ledgerAvailable && ledgerRows.length
      ? money(ledgerRows.reduce((sum, row) => sum + Number(row[ledgerChangeField] || 0), 0))
      : null,
  }
}

// ── Settlement timeline ───────────────────────────────────────────────────────

// The database keeps the CURRENT settlement state, not a log of past ones:
// `syncLedger` rebuilds the settled row rather than appending, and a reversal
// deletes it. So this is an evidence list, not an audit trail, and it says so.
export function buildSettlementTimeline(bet = {}, financials = {}, { game = null } = {}) {
  const entries = []

  if (bet.placed_at) {
    entries.push({ kind: 'placed', at: bet.placed_at, label: 'Ticket accepted' })
  }
  if (financials.placementRow?.created_at) {
    entries.push({ kind: 'debit', at: financials.placementRow.created_at, label: 'Wager debited' })
  }
  if (bet.resolved_at) {
    entries.push({
      kind: 'graded',
      at: bet.resolved_at,
      label: `Graded ${bet.status}`,
      note: 'This is the most recent grading time. A ticket that was resettled carries the latest time, not the original one.',
    })
  }
  if (financials.settlementRow?.created_at) {
    entries.push({ kind: 'credit', at: financials.settlementRow.created_at, label: 'Settlement entry recorded' })
  }

  const notes = []
  if (isOpenTicket(bet) && game?.status === 'complete') {
    notes.push('This ticket is open again on a finished game, which means its settlement was reversed. It will be graded again when the game is resettled.')
  }
  if (financials.creditState === 'pending') {
    notes.push(financials.creditNote)
  }
  if (financials.creditState === 'mismatch') {
    notes.push(financials.creditNote)
  }

  return {
    entries: entries.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0)),
    notes,
    // Stated plainly so nobody reads the list above as a complete history.
    coverage: 'The ledger keeps only the current placement and settlement entries for a ticket. Earlier settlements that were reversed are not retained, so this is the current state rather than a full reversal log.',
  }
}

// ── Current market comparison ─────────────────────────────────────────────────

function currentOddsForSide(marketRow, bet) {
  if (!marketRow) return null
  switch (bet.chosen_side) {
    case 'home': return numberOrNull(marketRow.odds_home)
    case 'away': return numberOrNull(marketRow.odds_away)
    case 'over': return numberOrNull(marketRow.odds_over)
    case 'under': return numberOrNull(marketRow.odds_under)
    case 'yes': return numberOrNull(marketRow.odds_yes)
    case 'no': return numberOrNull(marketRow.odds_no)
    default: return null
  }
}

// The board's current price for the same side, reported as a separate fact.
// When the board is no longer on the ticket's line the two are not comparable,
// and this says so instead of showing a misleading movement.
export function buildCurrentMarketComparison(bet = {}, marketRow = null) {
  if (!marketRow) {
    return {
      available: false,
      note: 'This market is no longer on the board, so there is no current price to compare against.',
    }
  }
  const acceptedLine = numberOrNull(bet.line)
  const currentLine = numberOrNull(marketRow.line)
  const sameLine = acceptedLine === currentLine
  const currentOdds = currentOddsForSide(marketRow, bet)
  const acceptedOdds = numberOrNull(bet.odds)

  return {
    available: true,
    currentOdds,
    currentLine,
    isLocked: Boolean(marketRow.is_locked),
    sameLine,
    oddsDelta: sameLine && currentOdds != null && acceptedOdds != null ? currentOdds - acceptedOdds : null,
    note: sameLine
      ? 'The board price moves after a ticket is accepted. Your ticket pays at the accepted odds above.'
      : `The board is now offering ${formatLine(currentLine) ?? '--'} on this market. Your ticket is on ${formatLine(acceptedLine) ?? '--'}, a different proposition, so the two prices are not comparable.`,
  }
}

// ── Receipt ───────────────────────────────────────────────────────────────────

export function buildBetReceipt({
  bet,
  game = null,
  marketRow = null,
  playersById = {},
  identitiesByPlayerId = {},
  charactersById = {},
  plateAppearances = [],
  pitchingStints = [],
  ledgerEntries = [],
  ledgerChangeField = 'points_change',
  ledgerAvailable = true,
  competitionLabel = '',
  competitionType = 'tournament',
} = {}) {
  if (!bet) return null

  const labels = getTeamLabels(game, playersById, identitiesByPlayerId)
  const gameTotals = game?.status === 'complete'
    ? buildGameResolutionTotals(bet.game_id, plateAppearances, pitchingStints, charactersById, playersById)
    : null
  const participation = game?.status === 'complete'
    ? buildGameParticipation(bet.game_id, plateAppearances, pitchingStints, charactersById, playersById)
    : null

  const ledgerRows = selectTicketLedgerRows(bet, ledgerEntries)
  const financials = buildTicketFinancials(bet, { ledgerRows, ledgerChangeField, ledgerAvailable })

  return {
    bet,
    game,
    competitionLabel,
    competitionType,
    labels,
    marketLabel: getMarketLabel(bet.bet_type),
    targetEntity: bet.target_entity || null,
    targetCharacterName: bet.target_entity ? getTargetPortraitName(bet.target_entity) : null,
    targetPlayerName: bet.target_entity ? getTargetPlayerName(bet.target_entity) : null,
    matchup: game ? `${labels.away} @ ${labels.home}` : null,
    acceptedTerms: {
      sideLabel: getChosenSideLabel(bet, labels),
      odds: numberOrNull(bet.odds),
      oddsLabel: formatOdds(bet.odds),
      line: numberOrNull(bet.line),
      lineLabel: formatLine(bet.line),
      predictedProbability: numberOrNull(bet.predicted_probability),
      placedAt: bet.placed_at || null,
    },
    placementContext: {
      placedAt: bet.placed_at || null,
      // No column ever stored these, so they are reported missing rather than
      // filled in from the game's current or final state.
      scoreRecorded: false,
      inningRecorded: false,
      note: 'Score and inning at the moment this ticket was accepted were not recorded.',
    },
    currentMarket: buildCurrentMarketComparison(bet, marketRow),
    winningConditions: describeWinningConditions(bet, labels),
    outcome: buildOutcomeExplanation(bet, { game, labels, gameTotals, participation }),
    financials,
    settlement: buildSettlementTimeline(bet, financials, { game }),
    isOpen: isOpenTicket(bet),
    isSettled: isSettledTicket(bet),
  }
}
