// Market language shared by the board, the ticket list and the receipt.
//
// These used to live inside BettingTab.jsx. They are pure and are now imported
// by both BettingTab and the receipt/dashboard components so a market can never
// be described one way on the board and another way on the ticket.

import { buildBettingEntityLabel } from './oddsEngine.js'
import { isCreditedHit } from './creditedHit.js'
import { getTeamShortName } from './teamIdentity.js'

export const COUNT_PROP_TYPES = new Set(['hr_prop', 'hit_prop', 'k_prop'])
export const HR_RESULTS = new Set(['HR', 'IPHR'])

export function isCountPropType(betType = '') {
  return COUNT_PROP_TYPES.has(betType)
}

export function formatOdds(value) {
  if (value == null) return '--'
  const num = Number(value)
  if (!Number.isFinite(num)) return '--'
  return num > 0 ? `+${num}` : `${num}`
}

export function getTeamLabels(game, playersById = {}, identitiesByPlayerId = {}) {
  return {
    home: getTeamShortName(identitiesByPlayerId[game?.team_b_player_id]) || playersById[game?.team_b_player_id]?.name || 'Home',
    away: getTeamShortName(identitiesByPlayerId[game?.team_a_player_id]) || playersById[game?.team_a_player_id]?.name || 'Away',
  }
}

export function getTargetPortraitName(targetEntity = '') {
  const match = String(targetEntity || '').match(/^(.*?)\s+\(/)
  return match ? match[1] : null
}

export function getTargetPlayerName(targetEntity = '') {
  const match = String(targetEntity || '').match(/\(([^)]*)\)\s*$/)
  return match ? match[1] : null
}

export function formatBetDescription(row, game, playersById, identitiesByPlayerId = {}) {
  const labels = getTeamLabels(game, playersById, identitiesByPlayerId)
  if (row.bet_type === 'moneyline') return `${labels.home} vs ${labels.away}`
  if (row.bet_type === 'over_under') return `Game total ${Number(row.line || 0).toFixed(1)}`
  if (row.bet_type === 'first_inning_run') return 'Run scored in 1st inning'
  if (row.bet_type === 'k_prop') return `${row.target_entity} strikeouts ${Number(row.line || 0).toFixed(1)}`
  if (row.bet_type === 'hr_prop') return `${row.target_entity} home runs ${Number(row.line || 0).toFixed(1)}`
  if (row.bet_type === 'hit_prop') return `${row.target_entity} hits ${Number(row.line || 0).toFixed(1)}`
  return row.target_entity
}

export function formatBetTitle(bet, game, playersById, identitiesByPlayerId = {}) {
  const labels = getTeamLabels(game, playersById, identitiesByPlayerId)
  const line = bet.line != null ? Number(bet.line) : null
  switch (bet.bet_type) {
    case 'moneyline':
      return `${bet.chosen_side === 'home' ? labels.home : labels.away} ML`
    case 'run_line':
      return `${bet.chosen_side === 'home' ? labels.home : labels.away} ${line >= 0 ? '+' : ''}${line?.toFixed(1)}`
    case 'over_under':
      return `${bet.chosen_side === 'over' ? 'Over' : 'Under'} ${line?.toFixed(1)}`
    case 'k_prop':
      return `${bet.chosen_side === 'over' ? 'Over' : 'Under'} ${line?.toFixed(1)} K`
    case 'hr_prop':
      return `${bet.chosen_side === 'over' ? 'Over' : 'Under'} ${line?.toFixed(1)} HR`
    case 'hit_prop':
      return `${bet.chosen_side === 'over' ? 'Over' : 'Under'} ${line?.toFixed(1)} Hits`
    case 'first_inning_run':
      return `${bet.chosen_side === 'yes' ? 'Yes' : 'No'} - Run in 1st`
    default:
      return bet.target_entity || bet.bet_type
  }
}

export function formatBetSubtitle(bet, game, playersById, identitiesByPlayerId = {}) {
  const labels = getTeamLabels(game, playersById, identitiesByPlayerId)
  if (bet.bet_type === 'moneyline' || bet.bet_type === 'run_line' || bet.bet_type === 'over_under' || bet.bet_type === 'first_inning_run') {
    return `${labels.away} @ ${labels.home}`
  }
  return bet.target_entity || ''
}

export function formatBettingGameMatchup(game, playersById, identitiesByPlayerId = {}) {
  const labels = getTeamLabels(game, playersById, identitiesByPlayerId)
  return `${labels.away} @ ${labels.home}`
}

export function formatMyBetContext(bet, game, playersById, identitiesByPlayerId = {}) {
  if (!game) return ''

  const matchup = String(formatBettingGameMatchup(game, playersById, identitiesByPlayerId) || '').trim()
  const gameCode = matchup
  const subtitle = String(formatBetSubtitle(bet, game, playersById, identitiesByPlayerId) || '').trim()

  if (!matchup) return subtitle
  if (!subtitle || subtitle === matchup) return matchup

  return `${gameCode} · ${subtitle}`
}

// Human-readable name for a market family, used by the dashboard's
// results-by-market breakdown and by the receipt header.
export const MARKET_LABELS = {
  moneyline: 'Moneyline',
  run_line: 'Run Line',
  over_under: 'Game Total',
  first_inning_run: '1st Inning Run',
  hit_prop: 'Hits Prop',
  hr_prop: 'Home Run Prop',
  k_prop: 'Strikeout Prop',
}

export function getMarketLabel(betType = '') {
  return MARKET_LABELS[betType] || String(betType || 'Unknown').replaceAll('_', ' ')
}

export function getBetProgress(bet, game, plateAppearances, pitchingStints, charactersById, playersById) {
  const line = bet.line != null ? Number(bet.line) : null
  if (line == null || Number.isNaN(line)) return null

  const gamePAs = plateAppearances.filter((pa) => String(pa.game_id) === String(bet.game_id))
  const gamePitching = pitchingStints.filter((entry) => String(entry.game_id) === String(bet.game_id))

  if (bet.bet_type === 'over_under') {
    const current = Number(game?.team_a_runs || 0) + Number(game?.team_b_runs || 0)
    return { current, line, unit: 'runs', wantsOver: bet.chosen_side === 'over' }
  }

  if (bet.bet_type === 'k_prop') {
    const current = gamePitching
      .filter((entry) => buildBettingEntityLabel(charactersById[entry.character_id], playersById[entry.player_id]) === bet.target_entity)
      .reduce((sum, entry) => sum + Number(entry.strikeouts || 0), 0)
    return { current, line, unit: 'K', wantsOver: bet.chosen_side === 'over' }
  }

  if (bet.bet_type === 'hr_prop' || bet.bet_type === 'hit_prop') {
    const current = gamePAs.filter((pa) =>
      buildBettingEntityLabel(charactersById[pa.character_id], playersById[pa.player_id]) === bet.target_entity &&
      isCreditedHit(pa) && (bet.bet_type !== 'hr_prop' || HR_RESULTS.has(pa.result)),
    ).length
    return { current, line, unit: bet.bet_type === 'hr_prop' ? 'HR' : 'hits', wantsOver: bet.chosen_side === 'over' }
  }

  return null
}

export function buildGameResolutionTotals(gameId, plateAppearances, pitchingStints, charactersById, playersById) {
  const scopedGameId = String(gameId)
  const pitcherKTotals = {}
  const hrTotals = {}
  const hitTotals = {}

  pitchingStints.forEach((entry) => {
    if (String(entry.game_id) !== scopedGameId) return
    const key = buildBettingEntityLabel(charactersById[entry.character_id], playersById[entry.player_id])
    pitcherKTotals[key] = Number(pitcherKTotals[key] || 0) + Number(entry.strikeouts || 0)
  })

  plateAppearances.forEach((entry) => {
    if (String(entry.game_id) !== scopedGameId) return
    const key = buildBettingEntityLabel(charactersById[entry.character_id], playersById[entry.player_id])
    if (isCreditedHit(entry) && HR_RESULTS.has(entry.result)) hrTotals[key] = Number(hrTotals[key] || 0) + 1
    if (isCreditedHit(entry)) hitTotals[key] = Number(hitTotals[key] || 0) + 1
  })

  return { pitcherKTotals, hrTotals, hitTotals }
}
