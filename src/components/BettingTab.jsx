import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Moon, Sun, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import CharacterPortrait from './CharacterPortrait'
import PlayerTag from './PlayerTag'
import SettleUp from './SettleUp'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import {
  americanOddsFromProbability,
  buildBettingEntityLabel,
  buildOddsRowKey,
  calculatePayout,
  generateGameOdds,
  mergeOddsWithExistingRows,
  priceCountPropLine,
} from '../utils/oddsEngine'
import { buildPlacedBetLedgerEntries } from '../utils/betResolution'
import { buildOddsGenerationContext } from '../utils/oddsContext'
import { persistOddsRowsWithFallback } from '../utils/oddsPersistence'
import { buildAppliedStadiumModel } from '../utils/stadiumOdds'
import { syncGamePitchersFromLineups } from '../utils/pitcherSync'
import { SEASON_TEAM_LINEUPS, TOURNAMENT_TEAM_LINEUPS } from '../utils/teamLineups'
import {
  getChaosStars,
  getChaosTagColors,
  getStadiumSpriteStyle,
  getStadiumTimeLabel,
} from '../utils/stadiums'
import { getTeamShortName } from '../utils/teamIdentity'
import { computeBalance, computeSipCount, computeTotalSipsHeld, getSipPrice } from '../utils/economy'
import { DEFAULT_REGULATION_INNINGS, getFinalStatusLabel, normalizeRegulationInnings } from '../utils/gameRules'

const GAME_STATUSES = new Set(['pending', 'active', 'scheduled', 'in_progress', 'complete'])
const ACTIVE_STATUSES = new Set(['pending', 'active', 'scheduled', 'in_progress'])
const BOARD_COLUMN_HEADERS = ['Run Line', 'Total', 'Moneyline']
const ODDS_FLASH_FIELDS = ['odds_home', 'odds_away', 'odds_over', 'odds_under', 'odds_yes', 'odds_no']
const ODDS_FLASH_DURATION_MS = 700
const DETAIL_TABS = [
  { id: 'game-odds', label: 'Game Odds' },
  { id: 'batter-props', label: 'Batter Props' },
  { id: 'pitcher-props', label: 'Pitcher Props' },
]
const STATUS_COLORS = {
  open: '#EAB308',
  won: '#22C55E',
  lost: '#EF4444',
  void: '#94A3B8',
}

function StadiumLogo({ name, width = 76, height = 30, borderRadius = 8 }) {
  return (
    <div
      aria-hidden="true"
      style={{
        ...getStadiumSpriteStyle(name, {
          width,
          height,
          borderRadius,
          backgroundColor: 'rgba(15,23,42,0.85)',
          border: '1px solid rgba(51,65,85,0.8)',
          flexShrink: 0,
        }),
      }}
    />
  )
}

function formatOdds(value) {
  if (value == null) return '--'
  const num = Number(value)
  return num > 0 ? `+${num}` : `${num}`
}

function isOddsOffBoard(odds) {
  return odds != null && Math.abs(Number(odds)) > 20000
}

function formatLineValue(value, prefix = '') {
  if (value == null || Number.isNaN(Number(value))) return '--'
  const num = Number(value)
  const normalized = Number.isInteger(num) ? `${num}` : num.toFixed(1)
  if (!prefix) return normalized
  return `${prefix} ${normalized}`
}

function parseDollarWager(value) {
  const raw = String(value ?? '').trim()
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) return NaN
  return Number(raw)
}

function sanitizeDollarWagerInput(value) {
  const raw = String(value ?? '')
  if (raw === '') return ''
  if (!/^\d*(\.\d{0,2})?$/.test(raw)) return null
  return raw
}

function isGameReadyForBetting(game, playersById) {
  return Boolean(
    game?.team_a_player_id &&
    game?.team_b_player_id &&
    playersById[game.team_a_player_id]?.name &&
    playersById[game.team_b_player_id]?.name &&
    game.team_a_player_id !== game.team_b_player_id,
  )
}

function getTeamLabels(game, playersById, identitiesByPlayerId = {}) {
  return {
    home: getTeamShortName(identitiesByPlayerId[game?.team_b_player_id]) || playersById[game?.team_b_player_id]?.name || 'Home',
    away: getTeamShortName(identitiesByPlayerId[game?.team_a_player_id]) || playersById[game?.team_a_player_id]?.name || 'Away',
  }
}

function getGameStatusLabel(game, regulationInnings = DEFAULT_REGULATION_INNINGS) {
  if (!game) return 'Unavailable'
  if (game.status === 'in_progress' || game.status === 'active') {
    if (!game.current_inning) return 'Live'
    const inningNum = Number(game.current_inning)
    const ordinal = inningNum === 1 ? 'st' : inningNum === 2 ? 'nd' : inningNum === 3 ? 'rd' : 'th'
    const half = game.is_top_inning == null ? '' : game.is_top_inning ? 'Top ' : 'Bot '
    return `Live · ${half}${inningNum}${ordinal} inning`
  }
  if (game.status === 'scheduled') return 'Scheduled'
  if (game.status === 'pending') return 'Waiting on matchup'
  if (game.status === 'complete') return getFinalStatusLabel(game, regulationInnings)
  return game.status
}

function getInningLabel(game) {
  if (!game.current_inning) return null
  const inningNum = Number(game.current_inning)
  const ordinal = inningNum === 1 ? 'st' : inningNum === 2 ? 'nd' : inningNum === 3 ? 'rd' : 'th'
  const half = game.is_top_inning == null ? '' : game.is_top_inning ? 'Top ' : 'Bot '
  return `${half}${inningNum}${ordinal}`
}

function buildStadiumDisplayModel(game, stadiumsById, stadiumGameLog) {
  const stadium = stadiumsById[game?.stadium_id] || null
  const scopedLog = stadium
    ? stadiumGameLog.filter((entry) =>
        String(entry.stadium_id) === String(stadium.id) &&
        Boolean(entry.is_night) === Boolean(game?.is_night) &&
        String(entry.game_id) !== String(game?.id),
      )
    : []

  return {
    stadium,
    log: scopedLog,
    model: buildAppliedStadiumModel(stadium, Boolean(game?.is_night), scopedLog),
  }
}

function getTargetPortraitName(targetEntity = '') {
  const match = String(targetEntity || '').match(/^(.*?)\s+\(/)
  return match ? match[1] : null
}

function buildLeaderboard(players, games, bets, sourceId, options = {}) {
  const {
    sourceIdField = 'tournament_id',
    payoutField = 'potential_payout_dollars',
    wagerField = 'wager_dollars',
  } = options
  const tournamentGameIds = new Set(games.filter((game) => game[sourceIdField] === sourceId || game.tournament_id === sourceId).map((game) => game.id))
  return players
    .map((player) => {
      const net = bets
        .filter((bet) => bet.player_id === player.id && tournamentGameIds.has(bet.game_id))
        .reduce((sum, bet) => {
          if (bet.status === 'won') return sum + Number(bet[payoutField] || 0)
          if (bet.status === 'lost') return sum - Number(bet[wagerField] || 0)
          return sum
        }, 0)
      return { ...player, net: Math.round(net * 100) / 100 }
    })
    .sort((a, b) => b.net - a.net)
}

function mergeRowsById(currentRows, nextRows, getId = (row) => row.id) {
  const nextById = new Map(nextRows.map((row) => [String(getId(row)), row]))
  const merged = currentRows.map((row) => nextById.get(String(getId(row))) || row)
  const knownIds = new Set(currentRows.map((row) => String(getId(row))))
  const additions = nextRows.filter((row) => !knownIds.has(String(getId(row))))
  return [...merged, ...additions]
}

function mergeOddsIntoState(currentRows, incomingRows, gameId) {
  const scopedCurrent = currentRows.filter((entry) => String(entry.game_id) !== String(gameId))
  const existingForGame = currentRows.filter((entry) => String(entry.game_id) === String(gameId))
  const mergedRows = mergeOddsWithExistingRows(incomingRows, existingForGame)
  const incomingByKey = Object.fromEntries(mergedRows.map((entry) => [buildOddsRowKey(entry), entry]))
  const untouchedRows = existingForGame.filter((entry) => !incomingByKey[buildOddsRowKey(entry)])
  return [...scopedCurrent, ...untouchedRows, ...mergedRows].sort(
    (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0),
  )
}

function getSideOptions(row, game, playersById, identitiesByPlayerId = {}) {
  const labels = getTeamLabels(game, playersById, identitiesByPlayerId)
  if (row.bet_type === 'moneyline' || row.bet_type === 'run_line') {
    // PART J — away listed first, home second (home always on the bottom)
    return [
      { side: 'away', label: labels.away, odds: row.odds_away, probability: 1 - Number(row.predicted_probability || 0.5) },
      { side: 'home', label: labels.home, odds: row.odds_home, probability: row.predicted_probability },
    ]
  }

  if (row.bet_type === 'over_under' || row.bet_type === 'k_prop' || row.bet_type === 'hr_prop' || row.bet_type === 'hit_prop') {
    return [
      { side: 'over', label: `Over ${Number(row.line || 0).toFixed(1)}`, odds: row.odds_over, probability: row.predicted_probability },
      { side: 'under', label: `Under ${Number(row.line || 0).toFixed(1)}`, odds: row.odds_under, probability: 1 - Number(row.predicted_probability || 0.5) },
    ]
  }

  return [
    { side: 'yes', label: 'Yes', odds: row.odds_yes, probability: row.predicted_probability },
    { side: 'no', label: 'No', odds: row.odds_no, probability: 1 - Number(row.predicted_probability || 0.5) },
  ]
}

function formatBetDescription(row, game, playersById, identitiesByPlayerId = {}) {
  const labels = getTeamLabels(game, playersById, identitiesByPlayerId)
  if (row.bet_type === 'moneyline') return `${labels.home} vs ${labels.away}`
  if (row.bet_type === 'over_under') return `Game total ${Number(row.line || 0).toFixed(1)}`
  if (row.bet_type === 'first_inning_run') return 'Run scored in 1st inning'
  if (row.bet_type === 'k_prop') return `${row.target_entity} strikeouts ${Number(row.line || 0).toFixed(1)}`
  if (row.bet_type === 'hr_prop') return `${row.target_entity} home runs ${Number(row.line || 0).toFixed(1)}`
  if (row.bet_type === 'hit_prop') return `${row.target_entity} hits ${Number(row.line || 0).toFixed(1)}`
  return row.target_entity
}

const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const HR_RESULTS = new Set(['HR', 'IPHR'])

function formatBetTitle(bet, game, playersById, identitiesByPlayerId = {}) {
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

function formatBetSubtitle(bet, game, playersById, identitiesByPlayerId = {}) {
  const labels = getTeamLabels(game, playersById, identitiesByPlayerId)
  if (bet.bet_type === 'moneyline' || bet.bet_type === 'run_line' || bet.bet_type === 'over_under' || bet.bet_type === 'first_inning_run') {
    return `${labels.away} @ ${labels.home}`
  }
  return bet.target_entity || ''
}

function getBetProgress(bet, game, plateAppearances, pitchingStints, charactersById, playersById) {
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
    const matchSet = bet.bet_type === 'hr_prop' ? HR_RESULTS : HIT_RESULTS
    const current = gamePAs.filter((pa) =>
      buildBettingEntityLabel(charactersById[pa.character_id], playersById[pa.player_id]) === bet.target_entity &&
      matchSet.has(pa.result),
    ).length
    return { current, line, unit: bet.bet_type === 'hr_prop' ? 'HR' : 'hits', wantsOver: bet.chosen_side === 'over' }
  }

  return null
}

function BetProgressMeter({ progress, status }) {
  const { current, line, unit, wantsOver } = progress
  const max = Math.max(line * 2, current, 1)
  const fillPct = Math.min(100, (current / max) * 100)
  const markerPct = Math.min(100, (line / max) * 100)
  const hit = wantsOver ? current > line : current < line
  let fillColor = '#94A3B8'
  if (status === 'won') fillColor = '#22C55E'
  else if (status === 'lost') fillColor = '#EF4444'
  else if (status === 'open') fillColor = hit ? '#22C55E' : '#EAB308'

  return (
    <div className="bet-progress-meter">
      <div className="bet-progress-meter-track">
        <div className="bet-progress-meter-fill" style={{ width: `${fillPct}%`, background: fillColor }} />
        <div className="bet-progress-meter-marker" style={{ left: `${markerPct}%` }} />
      </div>
      <div className="bet-progress-meter-labels">
        <span>{current} {unit}</span>
        <span className="muted">Line: {line}</span>
      </div>
    </div>
  )
}

function MarketTitle({ row, game, playersById, identitiesByPlayerId }) {
  if (row.bet_type === 'moneyline' || row.bet_type === 'run_line') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <PlayerTag height={32} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_a_player_id} playersById={playersById} />
        <span className="muted">vs</span>
        <PlayerTag height={32} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_b_player_id} playersById={playersById} />
      </div>
    )
  }

  return <strong>{formatBetDescription(row, game, playersById, identitiesByPlayerId)}</strong>
}

function roundToHalf(value) {
  return Math.round(value * 2) / 2
}

function getAltSpreads(defaultSpread) {
  const base = roundToHalf(defaultSpread)
  const min = 1
  const max = Math.max(5, base + 2)
  const values = []
  for (let current = min; current <= max; current += 0.5) {
    values.push(roundToHalf(current))
  }
  return values
}

function getAltTotals(defaultTotal) {
  if (!defaultTotal) return []
  const base = roundToHalf(defaultTotal)
  const values = []
  for (let current = base - 2; current <= base + 2; current += 0.5) {
    values.push(roundToHalf(Math.max(1, current)))
  }
  return [...new Set(values)]
}

// Player-prop count markets (hr/hit/k) always sit on an X.5 hook. Build a
// rail of nearby lines centered on the generated default line.
function getAltPropLines(defaultLine) {
  if (defaultLine == null) return []
  const center = Math.floor(Number(defaultLine)) + 0.5
  const min = Math.max(0.5, center - 3)
  const values = []
  for (let current = min; current <= center + 3; current += 1) {
    values.push(roundToHalf(current))
  }
  return values
}

// Re-prices a hr_prop/hit_prop/k_prop row at an alternate count line using the
// row's stored Poisson rate (prop_lambda) — the same live-updating rate the
// board uses for the default line, just evaluated at a different threshold.
function getPropSettledCount(row) {
  if (row?.prop_current_count != null) return Math.max(0, Number(row.prop_current_count || 0))
  if (row?.bet_type === 'hr_prop' || row?.bet_type === 'hit_prop') {
    return Math.max(0, Math.floor(Number(row.line || 0)))
  }
  return 0
}

function getAltPropPricing({ line, row }) {
  if (!row || row.prop_lambda == null) return null
  const pricing = priceCountPropLine(Number(row.prop_lambda), line, {
    varianceMultiplier: Number(row.prop_variance_multiplier || 1),
    settledCount: getPropSettledCount(row),
  })
  return {
    overProb: pricing.probabilityOver,
    underProb: 1 - pricing.probabilityOver,
    overOdds: pricing.oddsOver,
    underOdds: pricing.oddsUnder,
  }
}

function getDetailSliderValue(rawValue, options = []) {
  const fallback = options[0]
  const parsed = Number(rawValue)
  return options.includes(parsed) ? parsed : fallback
}

function getSteppedOption(currentValue, options = [], direction = 0) {
  if (!options.length || !direction) return currentValue
  const currentIndex = Math.max(0, options.indexOf(currentValue))
  const nextIndex = Math.min(options.length - 1, Math.max(0, currentIndex + direction))
  return options[nextIndex]
}

function centerActiveRailValue(track) {
  if (!track) return
  const active = track.querySelector('.sportsbook-number-rail-value-active')
  if (!active) return
  const targetLeft = active.offsetLeft - ((track.clientWidth - active.clientWidth) / 2)
  track.scrollTo({ left: Math.max(0, targetLeft), behavior: 'auto' })
}

function clampProbability(probability) {
  return Math.min(0.93, Math.max(0.07, Number(probability || 0.5)))
}

function standardDeviation(values = []) {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
  const variance = values.reduce((sum, value) => sum + Math.pow(Number(value || 0) - mean, 2), 0) / values.length
  return Math.sqrt(variance)
}

function getAltRunLinePricing({ spread, runLineRow, moneylineRow, completedGameMargins = [] }) {
  if (!runLineRow || !moneylineRow) return null
  const homeWinProb = Number(moneylineRow.predicted_probability || 0.5)
  const homeIsFav = homeWinProb >= 0.5
  const defaultSpread = Number(runLineRow.line || 0.5)
  const defaultHomeProb = Number(runLineRow.predicted_probability || 0.5)
  const stepsFromDefault = (spread - defaultSpread) / 0.5
  const marginStdDev = Math.max(1.25, standardDeviation(completedGameMargins) || 2.5)
  const stepSize = 0.2 / marginStdDev
  const homeAdjustment = stepsFromDefault * stepSize * (homeIsFav ? -1 : 1)
  const homeProb = clampProbability(defaultHomeProb + homeAdjustment)
  return {
    homeProb,
    awayProb: 1 - homeProb,
    homeOdds: americanOddsFromProbability(homeProb),
    awayOdds: americanOddsFromProbability(1 - homeProb),
  }
}

function getAltTotalPricing({ line, totalRow, stadiumModel }) {
  if (!totalRow) return null
  const defaultLine = Number(totalRow.line || 0)
  const defaultProb = Number(totalRow.predicted_probability || 0.5)
  const stepsFromDefault = (line - defaultLine) / 0.5
  const variance = Number(stadiumModel?.finalModifiers?.varianceMultiplier || 1)
  const scoring = Number(stadiumModel?.finalModifiers?.scoringFactor || 1)
  const stepSize = 0.045 / Math.max(0.9, variance) + Math.max(0, scoring - 1) * 0.01
  const overProb = clampProbability(defaultProb - (stepsFromDefault * stepSize))
  return {
    overProb,
    underProb: 1 - overProb,
    overOdds: americanOddsFromProbability(overProb),
    underOdds: americanOddsFromProbability(1 - overProb),
  }
}

function getBoardRow(row, side, game, playersById, identitiesByPlayerId = {}) {
  const teamLabels = getTeamLabels(game, playersById, identitiesByPlayerId)
  const isHome = side === 'home'
  const moneylineLabel = isHome ? teamLabels.home : teamLabels.away
  const totalLabel = isHome ? `O ${Number(row?.total?.line || 0).toFixed(1)}` : `U ${Number(row?.total?.line || 0).toFixed(1)}`
  const rlRow = row?.runLine
  const homeIsFav = (row?.moneyline?.predicted_probability ?? 0.5) >= 0.5
  const spread = Number(rlRow?.line || 1.5)
  const showMinus = isHome ? homeIsFav : !homeIsFav

  return {
    runLine: rlRow
      ? {
          label: `${showMinus ? '-' : '+'}${spread.toFixed(1)}`,
          odds: isHome ? rlRow.odds_home : rlRow.odds_away,
          selectable: true,
          market: rlRow,
          side: isHome ? 'home' : 'away',
        }
      : { label: 'Not live', odds: null, selectable: false, market: null },
    total: row?.total
      ? {
          label: totalLabel,
          odds: isHome ? row.total.odds_over : row.total.odds_under,
          selectable: true,
          market: row.total,
          side: isHome ? 'over' : 'under',
        }
      : { label: '--', odds: null, selectable: false, market: null },
    moneyline: row?.moneyline
      ? {
          label: '',
          odds: isHome ? row.moneyline.odds_home : row.moneyline.odds_away,
          selectable: true,
          market: row.moneyline,
          side: isHome ? 'home' : 'away',
        }
      : { label: '--', odds: null, selectable: false, market: null },
  }
}

function getDetailBucket(row) {
  if (row.bet_type === 'moneyline') return { tab: 'game-odds', section: 'Moneyline' }
  if (row.bet_type === 'over_under') return { tab: 'game-odds', section: 'Totals' }
  if (row.bet_type === 'hit_prop') return { tab: 'batter-props', section: 'Hits' }
  if (row.bet_type === 'hr_prop') return { tab: 'batter-props', section: 'Home Runs' }
  if (row.bet_type === 'k_prop') return { tab: 'pitcher-props', section: 'Strikeouts' }
  return { tab: 'game-odds', section: 'Other' }
}

function buildSlipKey(entry) {
  return entry.customLine != null
    ? `${entry.gameId}::${entry.rowId}::${entry.side}::${entry.customLine}`
    : `${entry.gameId}::${entry.rowId}::${entry.side}`
}

function normalizeCustomLineSelection(row, customLineOpts) {
  if (!customLineOpts || customLineOpts.customLine == null) return customLineOpts
  const defaultLine = row?.line != null ? Number(row.line) : null
  const customLine = Number(customLineOpts.customLine)
  if (defaultLine != null && customLine === defaultLine) {
    // Same line as the board's default, but keep customOdds/customProb so the slip
    // matches whatever the alt-market panel displayed when the user clicked.
    return { ...customLineOpts, customLine: undefined }
  }
  return { ...customLineOpts, customLine }
}

function normalizeSeasonGame(game, teamsById, stadiumsByName, playersById = {}) {
  const homeTeam = teamsById[game.home_team_id]
  const awayTeam = teamsById[game.away_team_id]
  const awayName = playersById[awayTeam?.player_id]?.team_name || awayTeam?.team_name || 'Away'
  const homeName = playersById[homeTeam?.player_id]?.team_name || homeTeam?.team_name || 'Home'
  return {
    ...game,
    tournament_id: game.season_id,
    team_a_player_id: awayTeam?.player_id || null,
    team_b_player_id: homeTeam?.player_id || null,
    winner_player_id: teamsById[game.winner_team_id]?.player_id || null,
    team_a_runs: Number(game.away_score || 0),
    team_b_runs: Number(game.home_score || 0),
    stadium_id: stadiumsByName[game.stadium]?.id || null,
    game_code: game.game_code || `R${game.round_number || '-'} · ${awayName} @ ${homeName}`,
    status: game.status === 'completed' ? 'complete' : game.status === 'in_progress' ? 'active' : game.status,
  }
}

function normalizeSeasonDraftPicks(rosterRows, seasonId, seasonTeams, charactersByName) {
  const teamCount = Math.max((seasonTeams || []).length, 1)
  return (rosterRows || []).map((entry, index) => ({
    ...entry,
    tournament_id: seasonId,
    pick_number: index + 1,
    round: Math.ceil((index + 1) / teamCount),
    pick_in_round: (index % teamCount) + 1,
    player_id: (seasonTeams || []).find((team) => team.id === entry.team_id)?.player_id || null,
    character_id: charactersByName[entry.character_name]?.id || null,
    mii_color: null,
  }))
}

function boardGameCardEqual(prev, next) {
  return (
    JSON.stringify(prev.game) === JSON.stringify(next.game) &&
    prev.ready === next.ready &&
    JSON.stringify(prev.homeRow) === JSON.stringify(next.homeRow) &&
    JSON.stringify(prev.awayRow) === JSON.stringify(next.awayRow) &&
    JSON.stringify(prev.moneyline) === JSON.stringify(next.moneyline) &&
    JSON.stringify(prev.total) === JSON.stringify(next.total) &&
    JSON.stringify(prev.runLine) === JSON.stringify(next.runLine) &&
    JSON.stringify(prev.stadiumData) === JSON.stringify(next.stadiumData) &&
    prev.flashSignature === next.flashSignature &&
    JSON.stringify(prev.gameBetSlip) === JSON.stringify(next.gameBetSlip) &&
    prev.identitiesByPlayerId === next.identitiesByPlayerId &&
    prev.playersById === next.playersById
  )
}

const BoardGameCard = memo(function BoardGameCard({
  game,
  ready,
  homeRow,
  awayRow,
  moneyline,
  total,
  runLine,
  stadiumData,
  flashSignature,
  gameBetSlip,
  identitiesByPlayerId,
  playersById,
  toggleSlipSelection,
  onOpenDetail,
  onOpenStadiumModal,
}) {
  const homeWinProb = Number(moneyline?.predicted_probability || 0.5)
  const homeIsFav = homeWinProb >= 0.5
  const stadium = stadiumData.stadium
  const timeLabel = stadium ? getStadiumTimeLabel(stadium, game.is_night) : null
  const chaosColors = getChaosTagColors(stadium?.chaos_level)
  const flashTokens = flashSignature ? flashSignature.split(',') : []

  const getRunLineSide = (isHome) => {
    if (!runLine) return { label: 'Not live', odds: null, selectable: false }
    const showMinus = isHome ? homeIsFav : !homeIsFav
    const label = `${showMinus ? '-' : '+'}${Number(runLine.line || 1.5).toFixed(1)}`
    const odds = isHome ? runLine.odds_home : runLine.odds_away
    return { label, odds, selectable: true, side: isHome ? 'home' : 'away' }
  }

  const getTotalSide = (isOver) => {
    if (!total) return { label: '--', odds: null, selectable: false }
    const label = isOver ? `O ${Number(total.line || 0).toFixed(1)}` : `U ${Number(total.line || 0).toFixed(1)}`
    const odds = isOver ? total.odds_over : total.odds_under
    return { label, odds, selectable: true, side: isOver ? 'over' : 'under' }
  }

  return (
    <div
      className={`sportsbook-game-card ${ready ? '' : 'sportsbook-game-card-disabled'}`}
    >
      <div className="sportsbook-game-meta">
        <div className="sportsbook-game-meta-main">
          <span className="brand-kicker">Today</span>
          <div className="sportsbook-game-time">{game.game_code}</div>
        </div>
        {(game.status === 'in_progress' || game.status === 'active') ? (
          <div className="sportsbook-live-score" style={{ fontSize: 12, fontWeight: 700, color: '#F87171' }}>
            Live
          </div>
        ) : null}
      </div>

      {stadium ? (
        <div className="sportsbook-stadium-chip-wrap">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onOpenStadiumModal(game.id)
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 999,
              border: `1px solid ${chaosColors.border}`,
              background: chaosColors.background,
              color: chaosColors.color,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 700,
            }}
            className="sportsbook-stadium-chip"
          >
            <span>{stadium.name}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#E2E8F0' }}>
              {timeLabel === 'Night' ? <Moon size={12} /> : <Sun size={12} />}
              {timeLabel}
            </span>
          </button>
        </div>
      ) : null}

      <div className="sportsbook-columns">
        <div className="sportsbook-columns-spacer" aria-hidden="true" />
        {BOARD_COLUMN_HEADERS.map((column) => (
          <div className="sportsbook-column-label" key={column}>{column}</div>
        ))}
      </div>

      <div className="sportsbook-mobile-columns" aria-hidden="true">
        <div className="sportsbook-mobile-columns-spacer" />
        {BOARD_COLUMN_HEADERS.map((column) => (
          <div className="sportsbook-mobile-column-label" key={column}>{column}</div>
        ))}
      </div>

      {/* PART J — home team is always rendered on the bottom of the card (away on top) */}
      {[{ key: 'away', isHome: false }, { key: 'home', isHome: true }].map(({ key, isHome }) => {
        const rl = getRunLineSide(isHome)
        const tot = getTotalSide(isHome)
        const ml = isHome ? homeRow.moneyline : awayRow.moneyline
        const rlSelected = runLine && gameBetSlip.some((e) => e.rowId === runLine.id && e.side === rl.side)
        const totSelected = total && gameBetSlip.some((e) => e.rowId === total.id && e.side === tot.side)
        const mlSelected = gameBetSlip.some((e) => e.rowId === ml.market?.id && e.side === ml.side)

        const teamRuns = isHome ? game.team_b_runs : game.team_a_runs
        const showRuns = game.status === 'in_progress' || game.status === 'active' || game.status === 'complete'

        return (
          <div className="sportsbook-team-row" key={key}>
            <div className="sportsbook-team-name" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <PlayerTag
                height={36}
                identitiesByPlayerId={identitiesByPlayerId}
                playerId={isHome ? game.team_b_player_id : game.team_a_player_id}
                playersById={playersById}
                style={{ flex: 1, minWidth: 0 }}
              />
              {showRuns ? <span className="sportsbook-team-runs">{Number(teamRuns || 0)}</span> : null}
            </div>
            <div className="sportsbook-team-buttons">
              <button
                className={`sportsbook-odds-button ${rlSelected ? 'sportsbook-odds-button-selected' : ''} ${flashTokens.includes(isHome ? 'rlh' : 'rla') ? 'sportsbook-odds-flash' : ''}`}
                data-column-label="Run Line"
                disabled={!ready || !rl.selectable || runLine?.is_locked || isOddsOffBoard(rl.odds)}
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  if (!runLine) return
                  toggleSlipSelection(game, runLine, rl.side)
                }}
              >
                <span className="sportsbook-odds-line">{rl.label}</span>
                <strong>{formatOdds(rl.odds)}</strong>
              </button>

              <button
                className={`sportsbook-odds-button ${totSelected ? 'sportsbook-odds-button-selected' : ''} ${flashTokens.includes(isHome ? 'to' : 'tu') ? 'sportsbook-odds-flash' : ''}`}
                data-column-label="Total"
                disabled={!ready || !tot.selectable || total?.is_locked || isOddsOffBoard(tot.odds)}
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  if (!total) return
                  toggleSlipSelection(game, total, tot.side)
                }}
              >
                <span className="sportsbook-odds-line">{tot.label}</span>
                <strong>{formatOdds(tot.odds)}</strong>
              </button>

              <button
                className={`sportsbook-odds-button ${mlSelected ? 'sportsbook-odds-button-selected' : ''} ${flashTokens.includes(isHome ? 'mlh' : 'mla') ? 'sportsbook-odds-flash' : ''}`}
                data-column-label="Moneyline"
                disabled={!ready || !ml.selectable || ml.market?.is_locked || isOddsOffBoard(ml.odds)}
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  if (!ml.market || !ml.side) return
                  toggleSlipSelection(game, ml.market, ml.side)
                }}
              >
                <span className="sportsbook-odds-line">{ml.label}</span>
                <strong>{formatOdds(ml.odds)}</strong>
              </button>
            </div>
          </div>
        )
      })}

      {!ready ? (
        <div className="sportsbook-card-note">Matchup not set. Betting is disabled until both teams are assigned.</div>
      ) : null}

      <div className="sportsbook-card-footer">
        <div className="sportsbook-card-footer-meta">
          <span className="muted">{stadium ? `${stadium.name} ${timeLabel ? `· ${timeLabel}` : ''}` : 'Open markets available'}</span>
        </div>
        <div className="sportsbook-card-footer-end">
          {(game.status === 'in_progress' || game.status === 'active') && game.current_inning ? (
            <span className="sportsbook-card-footer-pill">{getInningLabel(game)}</span>
          ) : null}
          <button
            type="button"
            className="sportsbook-more-bets"
            disabled={!ready}
            onClick={(event) => {
              event.stopPropagation()
              if (!ready) return
              onOpenDetail(game.id)
            }}
          >
            <span>More Bets</span>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}, boardGameCardEqual)

export default function BettingTab({ mode = 'tournament' }) {
  const { player, isScorekeeper, is_logged_in } = useAuth()
  const { currentTournament } = useTournament()
  const { currentSeason, seasonTeams } = useSeason()
  const { pushToast } = useToast()
  const isSeasonMode = mode === 'season'
  const sourceContext = isSeasonMode ? currentSeason : currentTournament
  const wagerUnitLabel = 'dollars'
  const wagerUnitShort = '$'
  const payoutFormatter = (value) => `$${Number(value || 0).toFixed(2)}`
  const sourceTables = useMemo(() => (isSeasonMode ? {
    games: 'season_schedule',
    picks: 'season_roster',
    pas: 'season_plate_appearances',
    pitching: 'season_pitching_stints',
    odds: 'season_game_odds',
    bets: 'season_bets',
    settlements: 'season_game_settlements',
    stadiumLog: 'season_stadium_game_log',
    sourceIdField: 'season_id',
    wagerField: 'wager_dollars',
    payoutField: 'potential_payout_dollars',
    ledgerTable: 'season_betting_ledger',
    ledgerChangeField: 'dollars_change',
  } : {
    games: 'games',
    picks: 'draft_picks',
    pas: 'plate_appearances',
    pitching: 'pitching_stints',
    odds: 'game_odds',
    bets: 'bets',
    settlements: 'game_settlements',
    stadiumLog: 'stadium_game_log',
    sourceIdField: 'tournament_id',
    wagerField: 'wager_dollars',
    payoutField: 'potential_payout_dollars',
    ledgerTable: 'points_ledger',
    ledgerChangeField: 'points_change',
  }), [isSeasonMode])
  const [games, setGames] = useState([])
  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [draftPicks, setDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [stadiums, setStadiums] = useState([])
  const [stadiumGameLog, setStadiumGameLog] = useState([])
  const [gameOdds, setGameOdds] = useState([])
  const [bets, setBets] = useState([])
  const [settlements, setSettlements] = useState([])
  const [ledgerEntries, setLedgerEntries] = useState([])
  const [playerSips, setPlayerSips] = useState([])
  const [sipTransactions, setSipTransactions] = useState([])
  const [sipRedemptions, setSipRedemptions] = useState([])
  const [balanceAwards, setBalanceAwards] = useState([])
  const [economyActionLoading, setEconomyActionLoading] = useState(false)
  const [redeemTargetId, setRedeemTargetId] = useState('')
  const [redeemNote, setRedeemNote] = useState('')
  const [redeemQty, setRedeemQty] = useState('1')
  const [weights, setWeights] = useState({ char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 })
  const [detailGameId, setDetailGameId] = useState('')
  const [viewMode, setViewMode] = useState('board')
  const [detailTab, setDetailTab] = useState('game-odds')
  const [loading, setLoading] = useState(true)
  const [altRunLine, setAltRunLine] = useState({})
  const [altPropLine, setAltPropLine] = useState({})
  const [altTotal, setAltTotal] = useState({})
  const [placingBetId, setPlacingBetId] = useState(null)
  const [expandedSections, setExpandedSections] = useState({})
  const [betSlip, setBetSlip] = useState([])
  const [slipError, setSlipError] = useState('')
  const [slipCollapsed, setSlipCollapsed] = useState(false)
  const [activeWagerKey, setActiveWagerKey] = useState(null)
  const [stadiumModalGameId, setStadiumModalGameId] = useState(null)
  const [myBetsFilter, setMyBetsFilter] = useState('all')
  const hasLoadedOnceRef = useRef(false)
  const autoSyncRef = useRef({})
  // Keep refs to frequently-changing values so the realtime subscription
  // effect below doesn't need them as dependencies (which would tear down
  // and recreate the channel on every update, dropping live events).
  const stadiumsRef = useRef(stadiums)
  useEffect(() => { stadiumsRef.current = stadiums }, [stadiums])
  const playersRef = useRef(players)
  useEffect(() => { playersRef.current = players }, [players])
  const seasonTeamsRef = useRef(seasonTeams)
  useEffect(() => { seasonTeamsRef.current = seasonTeams }, [seasonTeams])
  const runLineRailRef = useRef(null)
  const totalRailRef = useRef(null)
  const { identitiesByPlayerId: tournamentIdentitiesByPlayerId } = useTournamentTeamIdentity(currentTournament?.id)

  useEffect(() => {
    async function load() {
      if (!hasLoadedOnceRef.current) setLoading(true)
      const economyContextField = isSeasonMode ? 'season_id' : 'tournament_id'
      const economyContextId = sourceContext?.id || -1

      const [
        { data: gamesData },
        { data: playersData },
        { data: charactersData },
        { data: picksData },
        { data: paData },
        { data: pitchingData },
        { data: oddsData },
        { data: betsData },
        { data: settlementsData },
        { data: weightsData },
        { data: stadiumsData },
        { data: stadiumLogData },
        { data: ledgerData },
        { data: playerSipsData },
        { data: sipTransactionsData },
        { data: sipRedemptionsData },
        { data: balanceAwardsData },
      ] = await Promise.all([
        supabase.from(sourceTables.games).select('*').order('id'),
        supabase.from('players').select('*'),
        supabase.from('characters').select('*'),
        isSeasonMode
          ? supabase.from(sourceTables.picks).select('*').eq('season_id', sourceContext?.id || -1).order('created_at')
          : supabase.from(sourceTables.picks).select('*'),
        supabase.from(sourceTables.pas).select('*').order('created_at'),
        supabase.from(sourceTables.pitching).select('*').order('created_at'),
        supabase.from(sourceTables.odds).select('*').order('updated_at', { ascending: false }).range(0, 49999),
        isSeasonMode
          ? supabase.from(sourceTables.bets).select('*').eq('season_id', sourceContext?.id || -1).order('placed_at', { ascending: false })
          : supabase.from(sourceTables.bets).select('*').order('placed_at', { ascending: false }),
        supabase.from(sourceTables.settlements).select('*').order('settled_at', { ascending: false }),
        supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle(),
        supabase.from('stadiums').select('*'),
        isSeasonMode
          ? supabase.from(sourceTables.stadiumLog).select('*').eq('season_id', sourceContext?.id || -1).order('created_at')
          : supabase.from(sourceTables.stadiumLog).select('*').order('created_at'),
        supabase.from(sourceTables.ledgerTable).select('*').eq(economyContextField, economyContextId),
        supabase.from('player_sips').select('*').eq(economyContextField, economyContextId),
        supabase.from('sip_transactions').select('*').eq(economyContextField, economyContextId),
        supabase.from('sip_redemptions').select('*').eq(economyContextField, economyContextId).order('created_at', { ascending: false }),
        supabase.from('balance_awards').select('*').eq(economyContextField, economyContextId),
      ])

      const teamsById = Object.fromEntries((seasonTeams || []).map((entry) => [entry.id, entry]))
      const stadiumsByName = Object.fromEntries((stadiumsData || []).map((entry) => [entry.name, entry]))
      const charactersByName = Object.fromEntries((charactersData || []).map((entry) => [entry.name, entry]))
      const loadedPlayersById = Object.fromEntries((playersData || []).map((entry) => [entry.id, entry]))
      const normalizedGames = isSeasonMode
        ? (gamesData || []).map((entry) => normalizeSeasonGame(entry, teamsById, stadiumsByName, loadedPlayersById))
        : (gamesData || []).filter((entry) => GAME_STATUSES.has(entry.status))
      const normalizedPicks = isSeasonMode
        ? normalizeSeasonDraftPicks(picksData || [], sourceContext?.id, seasonTeams, charactersByName)
        : (picksData || [])
      const normalizedStadiumLog = isSeasonMode
        ? (stadiumLogData || []).map((entry) => ({ ...entry, stadium_id: stadiumsByName[entry.stadium]?.id || null }))
        : (stadiumLogData || [])

      setGames(normalizedGames)
      setPlayers(playersData || [])
      setCharacters(charactersData || [])
      setDraftPicks(normalizedPicks)
      setPlateAppearances(paData || [])
      setPitchingStints(pitchingData || [])
      setStadiums(stadiumsData || [])
      setStadiumGameLog(normalizedStadiumLog)
      setGameOdds(oddsData || [])
      setBets(betsData || [])
      setSettlements(settlementsData || [])
      setLedgerEntries(ledgerData || [])
      setPlayerSips(playerSipsData || [])
      setSipTransactions(sipTransactionsData || [])
      setSipRedemptions(sipRedemptionsData || [])
      setBalanceAwards(balanceAwardsData || [])
      if (weightsData) setWeights(weightsData)

      setDetailGameId((current) => current || String((normalizedGames || []).find((entry) => ACTIVE_STATUSES.has(entry.status) && entry.tournament_id === sourceContext?.id)?.id || ''))
      hasLoadedOnceRef.current = true
      setLoading(false)
    }

    load()
  }, [currentTournament?.id, currentSeason?.id, isSeasonMode, seasonTeams, sourceContext?.id])

  const refetchOdds = useCallback(async () => {
    const { data } = await supabase.from(sourceTables.odds).select('*').order('updated_at', { ascending: false }).range(0, 49999)
    setGameOdds(data || [])
  }, [sourceTables])

  const refetchBets = useCallback(async () => {
    const query = supabase.from(sourceTables.bets).select('*').order('placed_at', { ascending: false })
    const { data } = isSeasonMode ? await query.eq('season_id', sourceContext?.id || -1) : await query
    setBets(data || [])
  }, [sourceTables, isSeasonMode, sourceContext?.id])

  const refetchGames = useCallback(async () => {
    const { data } = isSeasonMode
      ? await supabase.from(sourceTables.games).select('*').eq('season_id', sourceContext?.id || -1).order('id')
      : await supabase.from(sourceTables.games).select('*').order('id')
    if (isSeasonMode) {
      const teamsById = Object.fromEntries((seasonTeamsRef.current || []).map((entry) => [entry.id, entry]))
      const stadiumsByName = Object.fromEntries(stadiumsRef.current.map((entry) => [entry.name, entry]))
      const playersById = Object.fromEntries(playersRef.current.map((entry) => [entry.id, entry]))
      setGames((data || []).map((entry) => normalizeSeasonGame(entry, teamsById, stadiumsByName, playersById)))
    } else {
      setGames((data || []).filter((entry) => GAME_STATUSES.has(entry.status)))
    }
  }, [sourceTables, isSeasonMode, sourceContext?.id])

  const refetchPitching = useCallback(async () => {
    const { data } = await supabase.from(sourceTables.pitching).select('*').order('created_at')
    setPitchingStints(data || [])
  }, [sourceTables])

  const refetchPicks = useCallback(async () => {
    if (isSeasonMode) {
      const [{ data }, { data: charsData }] = await Promise.all([
        supabase.from(sourceTables.picks).select('*').eq('season_id', sourceContext?.id || -1).order('created_at'),
        supabase.from('characters').select('*'),
      ])
      const charactersByName = Object.fromEntries((charsData || []).map((entry) => [entry.name, entry]))
      setDraftPicks(normalizeSeasonDraftPicks(data || [], sourceContext?.id, seasonTeamsRef.current, charactersByName))
      return
    }
    const { data } = await supabase.from(sourceTables.picks).select('*')
    setDraftPicks(data || [])
  }, [sourceTables, isSeasonMode, sourceContext?.id])

  // Browsers throttle/suspend websockets on backgrounded tabs, so realtime
  // events for lineup/pitcher/odds changes that happen while a tab is hidden
  // can be missed entirely. Re-sync the data that drives the betting board
  // as soon as the tab becomes visible again, without a full page reload.
  useEffect(() => {
    const refreshAll = () => {
      refetchOdds()
      refetchBets()
      refetchPitching()
      refetchGames()
      refetchPicks()
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshAll()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    // Realtime postgres_changes can silently fail to deliver in some
    // environments, so also poll periodically as a fallback to guarantee the
    // board (odds, pitcher props, bets) stays live without manual refresh.
    const pollInterval = setInterval(refreshAll, 5000)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      clearInterval(pollInterval)
    }
  }, [refetchOdds, refetchBets, refetchPitching, refetchGames, refetchPicks])

  useEffect(() => {
    const channel = supabase
      .channel(`betting-board-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.odds }, refetchOdds)
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.bets }, refetchBets)
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.games }, refetchGames)
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.pas }, async () => {
        const { data } = await supabase.from(sourceTables.pas).select('*').order('created_at')
        setPlateAppearances(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.pitching }, refetchPitching)
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.picks }, refetchPicks)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'odds_engine_weights' }, async () => {
        const { data } = await supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle()
        if (data) setWeights(data)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.settlements }, async () => {
        const { data } = await supabase.from(sourceTables.settlements).select('*').order('settled_at', { ascending: false })
        setSettlements(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.ledgerTable }, async () => {
        const economyContextField = isSeasonMode ? 'season_id' : 'tournament_id'
        const { data } = await supabase.from(sourceTables.ledgerTable).select('*').eq(economyContextField, sourceContext?.id || -1)
        setLedgerEntries(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_sips' }, async () => {
        const economyContextField = isSeasonMode ? 'season_id' : 'tournament_id'
        const { data } = await supabase.from('player_sips').select('*').eq(economyContextField, sourceContext?.id || -1)
        setPlayerSips(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sip_transactions' }, async () => {
        const economyContextField = isSeasonMode ? 'season_id' : 'tournament_id'
        const { data } = await supabase.from('sip_transactions').select('*').eq(economyContextField, sourceContext?.id || -1)
        setSipTransactions(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sip_redemptions' }, async () => {
        const economyContextField = isSeasonMode ? 'season_id' : 'tournament_id'
        const { data } = await supabase.from('sip_redemptions').select('*').eq(economyContextField, sourceContext?.id || -1).order('created_at', { ascending: false })
        setSipRedemptions(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'balance_awards' }, async () => {
        const economyContextField = isSeasonMode ? 'season_id' : 'tournament_id'
        const { data } = await supabase.from('balance_awards').select('*').eq(economyContextField, sourceContext?.id || -1)
        setBalanceAwards(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadiums' }, async () => {
        const { data } = await supabase.from('stadiums').select('*')
        setStadiums(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.stadiumLog }, async () => {
        const { data } = isSeasonMode
          ? await supabase.from(sourceTables.stadiumLog).select('*').eq('season_id', sourceContext?.id || -1).order('created_at')
          : await supabase.from(sourceTables.stadiumLog).select('*').order('created_at')
        if (isSeasonMode) {
          const stadiumsByName = Object.fromEntries(stadiumsRef.current.map((entry) => [entry.name, entry]))
          setStadiumGameLog((data || []).map((entry) => ({ ...entry, stadium_id: stadiumsByName[entry.stadium]?.id || null })))
        } else {
          setStadiumGameLog(data || [])
        }
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [isSeasonMode, sourceContext?.id, sourceTables, refetchOdds, refetchBets, refetchGames, refetchPitching, refetchPicks])

  const playersById = useMemo(() => Object.fromEntries(players.map((entry) => [entry.id, entry])), [players])

  const myBalance = useMemo(() => computeBalance({
    playerId: player?.id,
    ledgerEntries,
    ledgerField: sourceTables.ledgerChangeField,
    balanceAwards,
    sipTransactions,
  }), [player?.id, ledgerEntries, sourceTables.ledgerChangeField, balanceAwards, sipTransactions])

  const mySipCount = useMemo(() => computeSipCount({
    playerId: player?.id,
    sipTransactions,
    sipRedemptions,
  }), [player?.id, sipTransactions, sipRedemptions])

  const totalSipsHeld = useMemo(() => computeTotalSipsHeld({
    sipTransactions,
    sipRedemptions,
  }), [sipTransactions, sipRedemptions])

  const sipSellPrice = useMemo(() => getSipPrice(totalSipsHeld), [totalSipsHeld])
  const sipBuyPrice = useMemo(() => getSipPrice(totalSipsHeld + 1), [totalSipsHeld])

  const sipHistory = useMemo(() => {
    const txEntries = sipTransactions
      .filter((entry) => entry.created_at)
      .map((entry) => ({ kind: 'transaction', ...entry }))
    const redemptionEntries = sipRedemptions.map((entry) => ({ kind: 'redemption', ...entry }))
    return [...txEntries, ...redemptionEntries].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    )
  }, [sipTransactions, sipRedemptions])

  const mySipsOwed = useMemo(
    () => sipRedemptions.filter((entry) => entry.to_player_id === player?.id && !entry.taken).length,
    [sipRedemptions, player?.id],
  )

  const myPendingSipRedemptions = useMemo(
    () => sipRedemptions.filter((entry) => entry.to_player_id === player?.id && !entry.taken),
    [sipRedemptions, player?.id],
  )

  const pendingSipsByPlayer = useMemo(() => {
    const counts = new Map()
    sipRedemptions.forEach((entry) => {
      if (entry.taken) return
      counts.set(entry.to_player_id, (counts.get(entry.to_player_id) || 0) + 1)
    })
    return Array.from(counts.entries())
      .map(([playerId, count]) => ({ playerId, count }))
      .sort((a, b) => b.count - a.count)
  }, [sipRedemptions])

  const economyContextField = isSeasonMode ? 'season_id' : 'tournament_id'

  const handleBuySip = useCallback(async () => {
    if (!player?.id || !sourceContext?.id) return
    if (myBalance < sipBuyPrice) {
      pushToast({ title: 'Not enough balance to buy a sip.', type: 'error' })
      return
    }
    setEconomyActionLoading(true)
    const createdAt = new Date().toISOString()
    const { error } = await supabase.from('sip_transactions').insert({
      [economyContextField]: sourceContext.id,
      player_id: player.id,
      type: 'buy',
      amount_dollars: sipBuyPrice,
      created_at: createdAt,
    })
    setEconomyActionLoading(false)
    if (error) {
      pushToast({ title: 'Buy sip failed', message: error.message, type: 'error' })
      return
    }
    setSipTransactions((current) => [...current, { [economyContextField]: sourceContext.id, player_id: player.id, type: 'buy', amount_dollars: sipBuyPrice, created_at: createdAt }])
    pushToast({ title: `Bought 1 sip for $${sipBuyPrice.toFixed(2)}.`, type: 'success' })
  }, [player?.id, sourceContext?.id, myBalance, sipBuyPrice, economyContextField, pushToast])

  const handleSellSip = useCallback(async () => {
    if (!player?.id || !sourceContext?.id) return
    if (mySipCount < 1) {
      pushToast({ title: 'You have no sips to sell.', type: 'error' })
      return
    }
    setEconomyActionLoading(true)
    const createdAt = new Date().toISOString()
    const { error } = await supabase.from('sip_transactions').insert({
      [economyContextField]: sourceContext.id,
      player_id: player.id,
      type: 'sell',
      amount_dollars: sipSellPrice,
      created_at: createdAt,
    })
    setEconomyActionLoading(false)
    if (error) {
      pushToast({ title: 'Sell sip failed', message: error.message, type: 'error' })
      return
    }
    setSipTransactions((current) => [...current, { [economyContextField]: sourceContext.id, player_id: player.id, type: 'sell', amount_dollars: sipSellPrice, created_at: createdAt }])
    pushToast({ title: `Sold 1 sip for $${sipSellPrice.toFixed(2)}.`, type: 'success' })
  }, [player?.id, sourceContext?.id, mySipCount, sipSellPrice, economyContextField, pushToast])

  const handleRedeemSip = useCallback(async () => {
    if (!player?.id || !sourceContext?.id || !redeemTargetId) return
    const qty = Math.floor(Number(redeemQty))
    if (!Number.isFinite(qty) || qty < 1) {
      pushToast({ title: 'Enter a valid number of sips.', type: 'error' })
      return
    }
    if (mySipCount < qty) {
      pushToast({ title: "You don't have enough sips to redeem.", type: 'error' })
      return
    }
    setEconomyActionLoading(true)
    const { data, error } = await supabase.from('sip_redemptions').insert(
      Array.from({ length: qty }, () => ({
        [economyContextField]: sourceContext.id,
        from_player_id: player.id,
        to_player_id: redeemTargetId,
        note: redeemNote || null,
      })),
    ).select()
    setEconomyActionLoading(false)
    if (error) {
      pushToast({ title: 'Redeem failed', message: error.message, type: 'error' })
      return
    }
    setSipRedemptions((current) => [...data, ...current])
    setRedeemTargetId('')
    setRedeemNote('')
    setRedeemQty('1')
    pushToast({ title: `${playersById[redeemTargetId]?.name || 'Player'} has been forced to take ${qty} sip${qty === 1 ? '' : 's'}!`, type: 'success' })
  }, [player?.id, sourceContext?.id, redeemTargetId, redeemNote, redeemQty, mySipCount, economyContextField, pushToast, playersById])

  const handleConfirmSipTaken = useCallback(async (redemptionId) => {
    setEconomyActionLoading(true)
    const takenAt = new Date().toISOString()
    const { data, error } = await supabase.from('sip_redemptions').update({ taken: true, taken_at: takenAt }).eq('id', redemptionId).select().maybeSingle()
    setEconomyActionLoading(false)
    if (error) {
      pushToast({ title: 'Confirm failed', message: error.message, type: 'error' })
      return
    }
    if (!data) {
      pushToast({ title: 'Confirm failed', message: 'You do not have permission to confirm this sip.', type: 'error' })
      return
    }
    setSipRedemptions((current) => current.map((entry) => (entry.id === redemptionId ? { ...entry, taken: true, taken_at: takenAt } : entry)))
    pushToast({ title: 'Sip confirmed.', type: 'success' })
  }, [pushToast])

  const charactersById = useMemo(() => Object.fromEntries(characters.map((entry) => [entry.id, entry])), [characters])
  const stadiumsById = useMemo(() => Object.fromEntries(stadiums.map((entry) => [entry.id, entry])), [stadiums])
  const seasonIdentitiesByPlayerId = useMemo(
    () => Object.fromEntries((seasonTeams || []).map((team) => {
      const profile = playersById[team.player_id]
      return [team.player_id, {
        playerId: team.player_id,
        teamName: profile?.team_name || team.team_name || profile?.name || 'Season Team',
        teamMascot: profile?.team_mascot || team.team_mascot || null,
        teamLogoKey: team.team_logo_key || null,
        teamLogoUrl: profile?.team_logo_url || team.logo_url || null,
      }]
    })),
    [seasonTeams, playersById],
  )
  const identitiesByPlayerId = isSeasonMode ? seasonIdentitiesByPlayerId : tournamentIdentitiesByPlayerId
  const tournamentGames = useMemo(
    () => games.filter((entry) => entry.tournament_id === sourceContext?.id),
    [games, sourceContext?.id],
  )
  const currentWeekGameIds = useMemo(() => {
    if (!isSeasonMode) return null
    const regularSeasonGames = tournamentGames.filter((entry) => !entry.stage)
    const gamesPerWeek = (seasonTeams || []).length * ((seasonTeams || []).length - 1) / 2
    if (!gamesPerWeek) return null
    const totalWeeks = Number(sourceContext?.games_per_matchup || 0)
    const maxRound = Math.max(0, ...regularSeasonGames.map((entry) => Number(entry.round_number || 0)))

    let groups
    if (totalWeeks > 0 && maxRound <= totalWeeks) {
      groups = Array.from({ length: totalWeeks }, (_, index) =>
        regularSeasonGames.filter((entry) => Number(entry.round_number || 0) === index + 1))
    } else {
      const sorted = [...regularSeasonGames].sort((a, b) => Number(a.id) - Number(b.id))
      groups = []
      for (let i = 0; i < sorted.length; i += gamesPerWeek) {
        groups.push(sorted.slice(i, i + gamesPerWeek))
      }
    }

    const currentGroup = groups.find((group) => group.length && !group.every((entry) => entry.status === 'complete')) || groups[groups.length - 1]
    return new Set((currentGroup || []).map((entry) => String(entry.id)))
  }, [isSeasonMode, tournamentGames, seasonTeams, sourceContext?.games_per_matchup])
  const boardGames = useMemo(
    () =>
      tournamentGames
        .filter((entry) => ACTIVE_STATUSES.has(entry.status))
        .filter((entry) => isGameReadyForBetting(entry, playersById))
        .filter((entry) => !isSeasonMode || entry.stage || currentWeekGameIds?.has(String(entry.id)))
        .slice()
        .sort((a, b) => Number(a.id) - Number(b.id)),
    [tournamentGames, playersById, isSeasonMode, currentWeekGameIds],
  )
  const detailGame = useMemo(
    () => boardGames.find((entry) => String(entry.id) === String(detailGameId)) || boardGames[0] || null,
    [boardGames, detailGameId],
  )
  const stadiumModalGame = useMemo(
    () => boardGames.find((entry) => String(entry.id) === String(stadiumModalGameId)) || null,
    [boardGames, stadiumModalGameId],
  )
  const readyGameIds = useMemo(() => new Set(boardGames.map((game) => String(game.id))), [boardGames])

  const gamesById = useMemo(() => Object.fromEntries(tournamentGames.map((entry) => [String(entry.id), entry])), [tournamentGames])

  const myAllBets = useMemo(
    () => bets
      .filter((entry) => entry.player_id === player?.id && gamesById[String(entry.game_id)])
      .slice()
      .sort((a, b) => new Date(b.placed_at || 0) - new Date(a.placed_at || 0)),
    [bets, player?.id, gamesById],
  )

  const selectedBets = useMemo(
    () => bets.filter((entry) => detailGame && String(entry.game_id) === String(detailGame.id)),
    [bets, detailGame],
  )
  const selectedSettlements = useMemo(
    () => settlements.filter((entry) => detailGame && String(entry.game_id) === String(detailGame.id)),
    [settlements, detailGame],
  )
  const leaderboard = useMemo(
    () => buildLeaderboard(players, boardGames, bets, sourceContext?.id, {
      sourceIdField: sourceTables.sourceIdField,
      payoutField: sourceTables.payoutField,
      wagerField: sourceTables.wagerField,
    }),
    [players, boardGames, bets, sourceContext?.id, sourceTables, isSeasonMode],
  )

  const oddsByGameId = useMemo(() => {
    const groups = {}
    gameOdds.forEach((entry) => {
      const key = String(entry.game_id)
      groups[key] = groups[key] || []
      groups[key].push(entry)
    })
    return groups
  }, [gameOdds])

  const [flashKeys, setFlashKeys] = useState(() => new Set())
  const prevOddsValuesRef = useRef(null)
  const flashTimeoutsRef = useRef({})

  useEffect(() => {
    const prev = prevOddsValuesRef.current
    const next = {}
    const changed = []

    gameOdds.forEach((row) => {
      ODDS_FLASH_FIELDS.forEach((field) => {
        if (row[field] == null) return
        const key = `${row.id}:${field}`
        next[key] = row[field]
        if (prev && prev[key] != null && prev[key] !== row[field]) {
          changed.push(key)
        }
      })
    })

    prevOddsValuesRef.current = next

    if (changed.length) {
      setFlashKeys((current) => {
        const updated = new Set(current)
        changed.forEach((key) => updated.add(key))
        return updated
      })
      changed.forEach((key) => {
        clearTimeout(flashTimeoutsRef.current[key])
        flashTimeoutsRef.current[key] = setTimeout(() => {
          setFlashKeys((current) => {
            if (!current.has(key)) return current
            const updated = new Set(current)
            updated.delete(key)
            return updated
          })
          delete flashTimeoutsRef.current[key]
        }, ODDS_FLASH_DURATION_MS)
      })
    }
  }, [gameOdds])

  useEffect(() => () => {
    Object.values(flashTimeoutsRef.current).forEach(clearTimeout)
  }, [])

  const isOddsFlashing = useCallback((rowId, side) => {
    if (rowId == null) return false
    return flashKeys.has(`${rowId}:odds_${side}`)
  }, [flashKeys])

  const detailOdds = useMemo(
    () => oddsByGameId[String(detailGame?.id)] || [],
    [oddsByGameId, detailGame?.id],
  )

  const detailSections = useMemo(() => {
    const tabs = Object.fromEntries(DETAIL_TABS.map((tab) => [tab.id, {}]))
    detailOdds.forEach((row) => {
      if (row.bet_type === 'custom') return
      // Locked player props (e.g. a pitcher who's been pulled) are stale —
      // hide them from the active board. Anyone who already bet on them can
      // still see/settle the bet via My Bets, which reads from `bets`
      // directly rather than this prop list.
      if (row.is_locked && ['k_prop', 'hr_prop', 'hit_prop'].includes(row.bet_type)) return
      const bucket = getDetailBucket(row)
      tabs[bucket.tab][bucket.section] = tabs[bucket.tab][bucket.section] || []
      tabs[bucket.tab][bucket.section].push(row)
    })
    return tabs
  }, [detailOdds])

  const detailGeneratedOddsByKey = useMemo(() => {
    if (!detailGame || !isGameReadyForBetting(detailGame, playersById)) return {}
    const gamePAs = plateAppearances.filter((entry) => entry.game_id === detailGame.id)
    const gamePitching = pitchingStints.filter((entry) => entry.game_id === detailGame.id)
    const context = buildOddsGenerationContext({
      game: detailGame,
      draftPicks,
      charactersById,
      gamePAs,
      gamePitching,
      allGames: games,
      allPAs: plateAppearances,
      allPitching: pitchingStints,
      stadiumsById,
      stadiumGameLog,
      playersById,
      totalInnings: normalizeRegulationInnings(sourceContext?.innings, DEFAULT_REGULATION_INNINGS),
      bets,
    })

    if (!context?.homeRoster?.length || !context?.awayRoster?.length) return {}

    return Object.fromEntries(
      generateGameOdds(
        detailGame,
        context.homeRoster,
        context.awayRoster,
        context.homeHistorical,
        context.awayHistorical,
        context.playerProps,
        weights,
      ).map((row) => [buildOddsRowKey(row), row]),
    )
  }, [
    bets,
    charactersById,
    detailGame,
    draftPicks,
    games,
    pitchingStints,
    plateAppearances,
    playersById,
    sourceContext?.innings,
    stadiumGameLog,
    stadiumsById,
    weights,
  ])

  const boardSourceSignatures = useMemo(
    () =>
      boardGames.map((game) => {
        const gamePAs = plateAppearances.filter((entry) => entry.game_id === game.id).length
        const gamePitching = pitchingStints.filter((entry) => entry.game_id === game.id).length
        return {
          game,
          signature: [
            game.id,
            game.status,
            Number(game.team_a_runs || 0),
            Number(game.team_b_runs || 0),
            Number(game.current_inning || 1),
            String(game.stadium_id || ''),
            Boolean(game.is_night),
            gamePAs,
            gamePitching,
            draftPicks.filter((entry) => entry.tournament_id === game.tournament_id).length,
            stadiumGameLog.filter((entry) =>
              String(entry.stadium_id) === String(game.stadium_id) &&
              Boolean(entry.is_night) === Boolean(game.is_night),
            ).length,
          ].join('|'),
        }
      }),
    [boardGames, plateAppearances, pitchingStints, draftPicks, stadiumGameLog],
  )

  const handleGenerateOdds = async (game, options = {}) => {
    if (!game || !isGameReadyForBetting(game, playersById)) return
    const { silent = false, sourceSignature = null } = options
    autoSyncRef.current[game.id] = { ...(autoSyncRef.current[game.id] || {}), inFlight: true }

    try {
      const gamePAs = plateAppearances.filter((entry) => entry.game_id === game.id)
      const gamePitching = pitchingStints.filter((entry) => entry.game_id === game.id)
      const context = buildOddsGenerationContext({
        game,
        draftPicks,
        charactersById,
        gamePAs,
        gamePitching,
        allGames: games,
        allPAs: plateAppearances,
        allPitching: pitchingStints,
        stadiumsById,
        stadiumGameLog,
        playersById,
        totalInnings: normalizeRegulationInnings(sourceContext?.innings, DEFAULT_REGULATION_INNINGS),
        bets,
      })

      if (!context.homeRoster.length || !context.awayRoster.length) {
        autoSyncRef.current[game.id] = { inFlight: false, signature: null }
        return
      }

      const generatedRows = generateGameOdds(
        game,
        context.homeRoster,
        context.awayRoster,
        context.homeHistorical,
        context.awayHistorical,
        context.playerProps,
        weights,
      )

      const { data: existingRows } = await supabase
        .from(sourceTables.odds)
        .select('*')
        .eq('game_id', game.id)

      const payload = mergeOddsWithExistingRows(
        generatedRows,
        existingRows || [],
      )

      const toUpdate = payload.filter((r) => r.id != null)
      const toInsert = payload.filter((r) => r.id == null)

      const finalPayload = await persistOddsRowsWithFallback({
        supabase,
        table: sourceTables.odds,
        updates: toUpdate,
        inserts: toInsert,
      })

      setGameOdds((current) => mergeOddsIntoState(current, finalPayload, game.id))
      autoSyncRef.current[game.id] = { inFlight: false, signature: sourceSignature }
      if (!silent) pushToast({ title: 'Odds generated', message: `${game.game_code} lines are live.`, type: 'success' })
    } catch (error) {
      autoSyncRef.current[game.id] = { inFlight: false, signature: null }
      pushToast({ title: 'Odds failed', message: error.message, type: 'error' })
    } finally {
    }
  }

  useEffect(() => {
    if (!isScorekeeper) return
    boardSourceSignatures.forEach(({ game, signature }) => {
      if (!readyGameIds.has(String(game.id))) return
      const syncState = autoSyncRef.current[game.id]
      if (syncState?.inFlight || syncState?.signature === signature) return
      handleGenerateOdds(game, { silent: true, sourceSignature: signature })
    })
  }, [boardSourceSignatures, readyGameIds, isScorekeeper])

  // A lineup edit (e.g. from Roster/SeasonRoster or another Scorebook
  // session) only writes to team_lineups/season_team_lineups. Poll each
  // board game's teams' saved fielding.pitcher so odds generation can
  // target the lineup-designated pitcher immediately — even before that
  // team has thrown a pitch (no pitching_stints row yet) — instead of
  // waiting for a pitching_stints row that may not exist until the team
  // takes the mound. See expectedPitcherByPlayer usage below.
  const [expectedPitcherByKey, setExpectedPitcherByKey] = useState({})
  useEffect(() => {
    let cancelled = false

    const runPoll = async () => {
      const lookups = []
      boardGames.forEach((game) => {
        const sourceId = isSeasonMode ? sourceContext?.id : game.tournament_id
        if (!sourceId) return
        const table = isSeasonMode ? SEASON_TEAM_LINEUPS : TOURNAMENT_TEAM_LINEUPS
        ;[game.team_a_player_id, game.team_b_player_id].forEach((playerId) => {
          if (!playerId) return
          lookups.push({ key: `${sourceId}:${playerId}`, table, sourceId, playerId })
        })
      })

      const uniqueLookups = Object.values(
        lookups.reduce((acc, entry) => { acc[entry.key] = entry; return acc }, {}),
      )

      const results = await Promise.all(
        uniqueLookups.map(async (entry) => {
          const saved = await fetchTeamLineup(entry)
          const pitcherCharId = saved?.fieldingPositions?.pitcher ? Number(saved.fieldingPositions.pitcher) : null
          return [entry.key, pitcherCharId]
        }),
      )

      if (cancelled) return
      setExpectedPitcherByKey(Object.fromEntries(results))
    }

    runPoll()
    const interval = setInterval(runPoll, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [boardGames, isSeasonMode, sourceContext?.id])

  const getExpectedPitcherByPlayer = useCallback((game) => {
    const sourceId = isSeasonMode ? sourceContext?.id : game.tournament_id
    const map = {}
    ;[game.team_a_player_id, game.team_b_player_id].forEach((playerId) => {
      if (!playerId) return
      const charId = expectedPitcherByKey[`${sourceId}:${playerId}`]
      if (charId != null) map[playerId] = charId
    })
    return map
  }, [expectedPitcherByKey, isSeasonMode, sourceContext?.id])

  const toggleSlipSelection = (game, row, side, customLineOpts = null) => {
    if (!game || !row?.id || row.is_locked || !isGameReadyForBetting(game, playersById)) return

    const normalizedCustomLineOpts = normalizeCustomLineSelection(row, customLineOpts)
    const option = getSideOptions(row, game, playersById, identitiesByPlayerId).find((entry) => entry.side === side)
    if (!option?.odds && !normalizedCustomLineOpts?.customOdds) return

    const nextEntry = {
      key: buildSlipKey({ gameId: game.id, rowId: row.id, side, customLine: normalizedCustomLineOpts?.customLine }),
      gameId: game.id,
      rowId: row.id,
      row,
      side,
      wagerType: 'dollars',
      wagerSips: 1,
      ...normalizedCustomLineOpts,
    }

    const isRunLineOrTotal = ['run_line', 'over_under', 'hr_prop', 'hit_prop', 'k_prop'].includes(row.bet_type)
    setBetSlip((current) => {
      if (isRunLineOrTotal && normalizedCustomLineOpts != null) {
        // For alternate lines: replace any existing entry for same game/row/side
        const existingIdx = current.findIndex((e) => e.gameId === game.id && e.rowId === row.id && e.side === side)
        if (existingIdx >= 0) {
          const next = [...current]
          next[existingIdx] = nextEntry
          return next
        }
        return [...current, nextEntry]
      }
      return current.some((entry) => entry.key === nextEntry.key)
        ? current.filter((entry) => entry.key !== nextEntry.key)
        : [...current, nextEntry]
    })
  }

  const updateSlipEntry = (key, patch) => {
    setBetSlip((current) => current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)))
  }

  useEffect(() => {
    if (!betSlip.length) {
      if (activeWagerKey != null) setActiveWagerKey(null)
      return
    }
    if (!betSlip.some((entry) => entry.key === activeWagerKey)) {
      setActiveWagerKey(betSlip[0].key)
    }
  }, [betSlip, activeWagerKey])

  const handleSlipWagerChange = useCallback((key, rawValue) => {
    const sanitized = sanitizeDollarWagerInput(rawValue)
    if (sanitized == null) return
    updateSlipEntry(key, { wagerSips: sanitized })
  }, [])

  const handleNumpadKeyPress = useCallback((key) => {
    if (!activeWagerKey) return
    setBetSlip((current) => current.map((entry) => {
      if (entry.key !== activeWagerKey) return entry
      const value = String(entry.wagerSips ?? '')
      const next = key === 'back'
        ? value.slice(0, -1)
        : key === '.'
          ? (value.includes('.') ? value : `${value}.`)
          : `${value}${key}`
      const sanitized = sanitizeDollarWagerInput(next)
      return sanitized == null ? entry : { ...entry, wagerSips: sanitized }
    }))
  }, [activeWagerKey])

  const handleNumpadQuickAdd = useCallback((amount) => {
    if (!activeWagerKey) return
    setBetSlip((current) => current.map((entry) => {
      if (entry.key !== activeWagerKey) return entry
      const base = parseDollarWager(entry.wagerSips)
      const next = (Number.isFinite(base) ? base : 0) + amount
      return { ...entry, wagerSips: String(Number(next.toFixed(2))) }
    }))
  }, [activeWagerKey])

  const completedGameMargins = useMemo(
    () =>
      games
        .filter((g) => g.status === 'complete' && g.team_a_runs != null && g.team_b_runs != null)
        .map((g) => Math.abs(Number(g.team_a_runs || 0) - Number(g.team_b_runs || 0))),
    [games],
  )

  const handleSelectAltSpread = useCallback((gameId, spread) => {
    setAltRunLine((prev) => ({ ...prev, [gameId]: { spread } }))
    setBetSlip((current) => {
      if (!current.some((e) => e.gameId === gameId && e.row?.bet_type === 'run_line')) return current
      const rows = oddsByGameId[String(gameId)] || []
      const rlRow = rows.find((r) => r.bet_type === 'run_line')
      const mlRow = rows.find((r) => r.bet_type === 'moneyline')
      if (!rlRow || !mlRow) return current
      const pricing = getAltRunLinePricing({ spread, runLineRow: rlRow, moneylineRow: mlRow, completedGameMargins })
      if (!pricing) return current
      const isAlt = spread !== Number(rlRow.line)
      return current.map((entry) => {
        if (entry.gameId !== gameId || entry.row?.bet_type !== 'run_line') return entry
        const isHome = entry.side === 'home'
        return {
          ...entry,
          customLine: isAlt ? spread : undefined,
          customOdds: isHome ? pricing.homeOdds : pricing.awayOdds,
          customProb: isHome ? pricing.homeProb : pricing.awayProb,
        }
      })
    })
  }, [completedGameMargins, oddsByGameId])

  const handleSelectAltTotal = useCallback((gameId, line) => {
    setAltTotal((prev) => ({ ...prev, [gameId]: { line } }))
    setBetSlip((current) => {
      if (!current.some((e) => e.gameId === gameId && e.row?.bet_type === 'over_under')) return current
      const game = games.find((entry) => String(entry.id) === String(gameId))
      const rows = oddsByGameId[String(gameId)] || []
      const totalRow = rows.find((r) => r.bet_type === 'over_under')
      if (!totalRow || !game) return current
      const defaultLine = Number(totalRow.line || 0)
      const stadiumModel = buildStadiumDisplayModel(game, stadiumsById, stadiumGameLog).model
      const pricing = getAltTotalPricing({ line, totalRow, stadiumModel })
      if (!pricing) return current
      const isAlt = line !== defaultLine
      return current.map((entry) => {
        if (entry.gameId !== gameId || entry.row?.bet_type !== 'over_under') return entry
        const isOver = entry.side === 'over'
        return {
          ...entry,
          customLine: isAlt ? line : undefined,
          customOdds: isOver ? pricing.overOdds : pricing.underOdds,
          customProb: isOver ? pricing.overProb : pricing.underProb,
        }
      })
    })
  }, [games, oddsByGameId, stadiumGameLog, stadiumsById])

  const handleSelectAltProp = useCallback((gameId, row, line, pricingRow = row) => {
    setAltPropLine((prev) => ({ ...prev, [row.id]: line }))
    setBetSlip((current) => {
      if (!current.some((e) => e.gameId === gameId && e.rowId === row.id)) return current
      const isAlt = line !== Number(row.line)
      const pricing = isAlt ? getAltPropPricing({ line, row: pricingRow || row }) : null
      if (isAlt && !pricing) return current
      return current.map((entry) => {
        if (entry.gameId !== gameId || entry.rowId !== row.id) return entry
        const isOver = entry.side === 'over'
        return {
          ...entry,
          customLine: isAlt ? line : undefined,
          customOdds: isAlt ? (isOver ? pricing.overOdds : pricing.underOdds) : undefined,
          customProb: isAlt ? (isOver ? pricing.overProb : pricing.underProb) : undefined,
        }
      })
    })
  }, [])

  const handlePlaceBets = async () => {
    if (!betSlip.length || !player?.id || !sourceContext?.id) return
    if (slipHasInvalidWager) {
      pushToast({ title: 'Bet slip invalid', message: 'Every ticket must have a non-negative wager with at most two decimal places, and be at least $0.01.', type: 'error' })
      return
    }
    if (slipWager > myBalance) {
      setSlipError('Insufficient balance')
      setTimeout(() => setSlipError(''), 4000)
      return
    }
    setPlacingBetId('slip')

    const payload = []
    for (const entry of betSlip) {
      const game = boardGames.find((item) => String(item.id) === String(entry.gameId))
      const row = (oddsByGameId[String(entry.gameId)] || []).find((item) => item.id === entry.rowId)
      if (!game || !row || !row.id || row.is_locked || !isGameReadyForBetting(game, playersById)) {
        setPlacingBetId(null)
        pushToast({ title: 'Bet slip invalid', message: 'One or more selections are no longer available.', type: 'error' })
        return
      }

      const option = getSideOptions(row, game, playersById, identitiesByPlayerId).find((item) => item.side === entry.side)
      if (!option?.odds) {
        setPlacingBetId(null)
        pushToast({ title: 'Bet slip invalid', message: 'One or more selections are missing live odds.', type: 'error' })
        return
      }

      const wagerSips = parseDollarWager(entry.wagerSips)
      const oddsToUse = entry.customOdds ?? Number(option.odds)
      const probToUse = entry.customProb ?? Number(option.probability)
      const lineToUse = entry.customLine ?? row.line
      payload.push(isSeasonMode ? {
        season_id: sourceContext.id,
        player_id: player.id,
        game_id: game.id,
        bet_type: row.bet_type,
        target_entity: row.target_entity,
        chosen_side: entry.side,
        odds: oddsToUse,
        predicted_probability: Number(probToUse.toFixed(4)),
        wager_dollars: wagerSips,
        potential_payout_dollars: calculatePayout(wagerSips, oddsToUse),
        status: 'open',
        line: lineToUse,
        placed_at: new Date().toISOString(),
      } : {
        player_id: player.id,
        game_id: game.id,
        game_odds_id: row.id,
        bet_type: row.bet_type,
        target_entity: row.target_entity,
        chosen_side: entry.side,
        odds: oddsToUse,
        predicted_probability: Number(probToUse.toFixed(4)),
        wager_type: 'dollars',
        wager_dollars: wagerSips,
        potential_payout_dollars: calculatePayout(wagerSips, oddsToUse),
        status: 'open',
        line: lineToUse,
        placed_at: new Date().toISOString(),
      })
    }

    const { data, error } = await supabase.from(sourceTables.bets).insert(payload).select()
    if (error) {
      setPlacingBetId(null)
      pushToast({ title: 'Bet failed', message: error.message, type: 'error' })
      return
    }

    const placedBets = data || []
    const placedLedgerRows = buildPlacedBetLedgerEntries(placedBets, {
      wagerField: sourceTables.wagerField,
      ledgerTable: sourceTables.ledgerTable,
      ledgerChangeField: sourceTables.ledgerChangeField,
      sourceIdField: sourceTables.sourceIdField,
      sourceIdValue: sourceContext.id,
    })

    if (placedLedgerRows.length) {
      const { error: ledgerError } = await supabase.from(sourceTables.ledgerTable).insert(placedLedgerRows)
      if (ledgerError) {
        const createdBetIds = placedBets.map((bet) => bet.id).filter(Boolean)
        if (createdBetIds.length) {
          await supabase.from(sourceTables.bets).delete().in('id', createdBetIds)
        }
        setPlacingBetId(null)
        pushToast({ title: 'Bet failed', message: 'The wager could not be debited, so the bet was rolled back.', type: 'error' })
        return
      }
      setLedgerEntries((current) => [...placedLedgerRows, ...current])
    }

    setPlacingBetId(null)

    if (placedBets.length) {
      setBets((current) => [...placedBets, ...current.filter((entry) => !placedBets.some((created) => created.id === entry.id))])
    }
    setBetSlip([])
    pushToast({ title: 'Bets placed', message: `${payload.length} ticket${payload.length === 1 ? '' : 's'} submitted and debited.`, type: 'success' })
  }

  const handleToggleLocks = async (isLocked) => {
    if (!detailGame || !isGameReadyForBetting(detailGame, playersById)) return
    const updatedAt = new Date().toISOString()
    const { error } = await supabase
      .from(sourceTables.odds)
      .update({ is_locked: !isLocked, updated_at: updatedAt })
      .eq('game_id', detailGame.id)

    if (error) {
      pushToast({ title: 'Lock update failed', message: error.message, type: 'error' })
      return
    }

    setGameOdds((current) =>
      current.map((entry) =>
        entry.game_id === detailGame.id ? { ...entry, is_locked: !isLocked, updated_at: updatedAt } : entry,
      ),
    )
    pushToast({ title: !isLocked ? 'Board locked' : 'Board unlocked', type: 'success' })
  }

  const boardCards = useMemo(
    () =>
      boardGames.map((game) => {
        const ready = isGameReadyForBetting(game, playersById)
        const rows = oddsByGameId[String(game.id)] || []
        const moneyline = rows.find((entry) => entry.bet_type === 'moneyline')
        const total = rows.find((entry) => entry.bet_type === 'over_under')
        const runLine = rows.find((entry) => entry.bet_type === 'run_line')
        const stadiumData = buildStadiumDisplayModel(game, stadiumsById, stadiumGameLog)
        const gamePAs = plateAppearances.filter((entry) => entry.game_id === game.id)
        const gamePAInnings = gamePAs.map((entry) => Number(entry.inning || 1))
        const currentInning = Number(game.current_inning || (gamePAInnings.length ? Math.max(...gamePAInnings) : 1))
        const lastPA = gamePAs.reduce((latest, entry) => (!latest || Number(entry.id) > Number(latest.id) ? entry : latest), null)
        const awayPlayerId = game.team_a_player_id
        const isTopInning = lastPA
          ? (lastPA.batting_team_id != null
            ? lastPA.batting_team_id === game.away_team_id
            : lastPA.player_id === awayPlayerId)
          : null
        const gameWithInning = { ...game, current_inning: currentInning, is_top_inning: isTopInning }
        const flashSignature = [
          runLine && isOddsFlashing(runLine.id, 'home') ? 'rlh' : '',
          runLine && isOddsFlashing(runLine.id, 'away') ? 'rla' : '',
          total && isOddsFlashing(total.id, 'over') ? 'to' : '',
          total && isOddsFlashing(total.id, 'under') ? 'tu' : '',
          moneyline && isOddsFlashing(moneyline.id, 'home') ? 'mlh' : '',
          moneyline && isOddsFlashing(moneyline.id, 'away') ? 'mla' : '',
        ].filter(Boolean).join(',')
        const gameBetSlip = betSlip.filter((entry) => entry.gameId === game.id)
        return {
          game: gameWithInning,
          ready,
          moneyline,
          total,
          runLine,
          stadiumData,
          homeRow: getBoardRow({ moneyline, total, runLine }, 'home', game, playersById, identitiesByPlayerId),
          awayRow: getBoardRow({ moneyline, total, runLine }, 'away', game, playersById, identitiesByPlayerId),
          flashSignature,
          gameBetSlip,
        }
      }),
    [boardGames, oddsByGameId, playersById, stadiumsById, stadiumGameLog, plateAppearances, isOddsFlashing, betSlip, identitiesByPlayerId],
  )

  const detailTabSections = detailSections[detailTab] || {}
  const teamLabels = getTeamLabels(detailGame, playersById, identitiesByPlayerId)
  const detailMoneylineRow = detailOdds.find((row) => row.bet_type === 'moneyline') || null
  const detailRunLineRow = detailOdds.find((row) => row.bet_type === 'run_line') || null
  const detailTotalRow = detailOdds.find((row) => row.bet_type === 'over_under') || null
  const detailRunLineOptions = detailRunLineRow ? getAltSpreads(Number(detailRunLineRow.line)) : []
  const detailTotalOptions = detailTotalRow ? getAltTotals(Number(detailTotalRow.line)) : []
  const detailActiveSpread = detailGame ? getDetailSliderValue(altRunLine[detailGame.id]?.spread, detailRunLineOptions) : undefined
  const detailActiveTotal = detailGame ? getDetailSliderValue(altTotal[detailGame.id]?.line, detailTotalOptions) : undefined
  const detailRunLinePricing = detailRunLineRow && detailMoneylineRow && detailActiveSpread
    ? getAltRunLinePricing({ spread: detailActiveSpread, runLineRow: detailRunLineRow, moneylineRow: detailMoneylineRow, completedGameMargins })
    : null
  const detailTotalPricing = detailTotalRow && detailActiveTotal
    ? getAltTotalPricing({
      line: detailActiveTotal,
      totalRow: detailTotalRow,
      stadiumModel: detailGame ? buildStadiumDisplayModel(detailGame, stadiumsById, stadiumGameLog).model : null,
    })
    : null
  const detailHomeIsFav = Number(detailMoneylineRow?.predicted_probability || 0.5) >= 0.5
  const slipPayout = betSlip.reduce((sum, entry) => {
    const game = boardGames.find((item) => String(item.id) === String(entry.gameId))
    const row = (oddsByGameId[String(entry.gameId)] || []).find((item) => item.id === entry.rowId)
    const option = row && game ? getSideOptions(row, game, playersById, identitiesByPlayerId).find((item) => item.side === entry.side) : null
    const wager = parseDollarWager(entry.wagerSips)
    return sum + calculatePayout(Number.isFinite(wager) ? wager : 0, entry.customOdds ?? option?.odds)
  }, 0)
  const slipWager = betSlip.reduce((sum, entry) => {
    const wager = parseDollarWager(entry.wagerSips)
    return sum + (Number.isFinite(wager) && wager >= 0.01 ? wager : 0)
  }, 0)
  const slipHasInvalidWager = betSlip.some((entry) => {
    const wager = parseDollarWager(entry.wagerSips)
    return !Number.isFinite(wager) || wager < 0.01
  })

  useEffect(() => {
    centerActiveRailValue(runLineRailRef.current)
  }, [detailGame?.id, detailActiveSpread, detailTab, viewMode])

  useEffect(() => {
    centerActiveRailValue(totalRailRef.current)
  }, [detailGame?.id, detailActiveTotal, detailTab, viewMode])

  if (loading) {
    return (
      <div className="page-stack">
        <div className="page-head">
          <div>
            <span className="brand-kicker">Betting</span>
            <h1>Loading board...</h1>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-stack betting-redesign">
      <div className="panel balance-bar">
        <div className="balance-bar-stats">
          <div>
            <span className="muted">Balance</span>
            <strong className={myBalance < 0 ? 'balance-negative' : ''}>${myBalance.toFixed(2)}</strong>
          </div>
          <div>
            <span className="muted">Sips to take</span>
            <strong className={mySipsOwed > 0 ? 'balance-negative' : ''}>{mySipsOwed}</strong>
          </div>
        </div>
      </div>

      <div className="sportsbook-top-tabbar tab-row">
        <button
          className={`tab-button ${viewMode === 'board' || viewMode === 'detail' ? 'tab-button-active' : ''}`}
          onClick={() => setViewMode('board')}
          type="button"
        >
          Board
        </button>
        {is_logged_in ? (
          <button
            className={`tab-button ${viewMode === 'my-bets' ? 'tab-button-active' : ''}`}
            onClick={() => setViewMode('my-bets')}
            type="button"
          >
            My Bets{myAllBets.some((bet) => bet.status === 'open') ? ` (${myAllBets.filter((bet) => bet.status === 'open').length})` : ''}
          </button>
        ) : null}
        <button
          className={`tab-button ${viewMode === 'leaderboard' ? 'tab-button-active' : ''}`}
          onClick={() => setViewMode('leaderboard')}
          type="button"
        >
          Leaderboard
        </button>
        {is_logged_in ? (
          <button
            className={`tab-button ${viewMode === 'sips' ? 'tab-button-active' : ''}`}
            onClick={() => setViewMode('sips')}
            type="button"
          >
            Buy Sips
          </button>
        ) : null}
        <button
          className={`tab-button ${viewMode === 'sips-history' ? 'tab-button-active' : ''}`}
          onClick={() => setViewMode('sips-history')}
          type="button"
        >
          Sips History
        </button>
      </div>

      {viewMode === 'my-bets' ? (
        <MyBetsView
          key={viewMode}
          bets={myAllBets}
          charactersById={charactersById}
          filter={myBetsFilter}
          gamesById={gamesById}
          identitiesByPlayerId={identitiesByPlayerId}
          isSeasonMode={isSeasonMode}
          onFilterChange={setMyBetsFilter}
          payoutFormatter={payoutFormatter}
          plateAppearances={plateAppearances}
          pitchingStints={pitchingStints}
          playersById={playersById}
        />
      ) : viewMode === 'leaderboard' ? (
        <div className="panel" key={viewMode}>
          <div className="section-head">
            <h2>Leaderboard</h2>
          </div>
          {leaderboard.length ? (
            <div className="feed-list">
              {leaderboard.map((entry, index) => (
                <div className="feed-row" key={entry.id}>
                  <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{index + 1}.</span>
                    <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} player={entry} />
                  </strong>
                  <span style={{ color: entry.net >= 0 ? '#22C55E' : '#EF4444', fontWeight: 700 }}>
                    {`${entry.net >= 0 ? '+' : '-'}$${Math.abs(entry.net).toFixed(2)}`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>No entries</strong>
              <span className="muted">Leaderboard will populate after bets settle.</span>
            </div>
          )}
        </div>
      ) : viewMode === 'sips' ? (
        <div className="panel" key={viewMode}>
          <div className="section-head">
            <h2>Buy Sips</h2>
            <strong>{mySipCount} sip{mySipCount === 1 ? '' : 's'} owned</strong>
          </div>
          <div className="balance-bar-actions">
            <div>
              <span className="muted">Current price</span>
              <strong>${sipSellPrice.toFixed(2)}</strong>
            </div>
            <button className="ghost-button" disabled={economyActionLoading || myBalance < sipBuyPrice} onClick={handleBuySip} type="button">
              Buy Sip (${sipBuyPrice.toFixed(2)})
            </button>
            <button className="ghost-button" disabled={economyActionLoading || mySipCount < 1} onClick={handleSellSip} type="button">
              Sell Sip (${sipSellPrice.toFixed(2)})
            </button>
            <select
              className="balance-bar-select"
              disabled={economyActionLoading || mySipCount < 1}
              onChange={(event) => setRedeemTargetId(event.target.value)}
              value={redeemTargetId}
            >
              <option value="">Force a sip on...</option>
              {players.filter((entry) => entry.id !== player?.id).map((entry) => (
                <option key={entry.id} value={entry.id}>{identitiesByPlayerId?.[entry.id]?.teamName || entry.name}</option>
              ))}
            </select>
            <input
              className="balance-bar-note"
              disabled={economyActionLoading || mySipCount < 1}
              onChange={(event) => setRedeemNote(event.target.value)}
              placeholder="Note (optional)"
              type="text"
              value={redeemNote}
            />
            <input
              className="balance-bar-note"
              disabled={economyActionLoading || mySipCount < 1}
              max={mySipCount}
              min={1}
              onChange={(event) => setRedeemQty(event.target.value)}
              style={{ width: 64 }}
              type="number"
              value={redeemQty}
            />
            <button className="solid-button" disabled={economyActionLoading || mySipCount < 1 || !redeemTargetId} onClick={handleRedeemSip} type="button">
              Redeem
            </button>
          </div>
          {myPendingSipRedemptions.length ? (
            <div className="feed-list">
              <strong className="muted">Sips you owe</strong>
              {myPendingSipRedemptions.map((entry) => (
                <div className="feed-row" key={entry.id}>
                  <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.from_player_id} playersById={playersById} />
                    <span className="muted">forced you to drink</span>
                    {entry.note ? <span className="muted">"{entry.note}"</span> : null}
                  </strong>
                  <button className="ghost-button" disabled={economyActionLoading} onClick={() => handleConfirmSipTaken(entry.id)} type="button">
                    Confirm taken
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {pendingSipsByPlayer.length ? (
            <div className="feed-list">
              <strong className="muted">Sips still owed</strong>
              {pendingSipsByPlayer.map(({ playerId, count }) => (
                <div className="feed-row" key={playerId}>
                  <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={playerId} playersById={playersById} />
                  </strong>
                  <span className="muted">{count} sip{count === 1 ? '' : 's'} to take</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : viewMode === 'sips-history' ? (
        <div className="panel" key={viewMode}>
          <div className="section-head">
            <h2>Sips History</h2>
          </div>
          {sipHistory.length ? (
            <div className="feed-list">
              {sipHistory.map((entry) => (
                <div className="feed-row" key={`${entry.kind}-${entry.id}`}>
                  {entry.kind === 'transaction' ? (
                    <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.player_id} playersById={playersById} />
                      <span className="muted">{entry.type === 'buy' ? 'bought' : 'sold'} 1 sip for ${Number(entry.amount_dollars).toFixed(2)}</span>
                    </strong>
                  ) : (
                    <strong style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.from_player_id} playersById={playersById} />
                      <span className="muted">forced</span>
                      <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.to_player_id} playersById={playersById} />
                      <span className="muted">to drink</span>
                      <span className="muted">{entry.taken ? '(Taken)' : '(Pending)'}</span>
                      {entry.note ? <span className="muted">"{entry.note}"</span> : null}
                    </strong>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>No entries</strong>
              <span className="muted">No sip activity yet.</span>
            </div>
          )}
        </div>
      ) : !boardGames.length ? (
        <div className="panel empty-state" key={viewMode}>
          <strong>No active games</strong>
          <span className="muted">Create or activate a matchup to publish lines.</span>
        </div>
      ) : (
        <Fragment key={viewMode}>
          {viewMode === 'board' ? (
          <section className="panel sportsbook-board">
            <div className="sportsbook-game-list">
              {boardCards.map((card) => (
                <BoardGameCard
                  key={card.game.id}
                  game={card.game}
                  ready={card.ready}
                  homeRow={card.homeRow}
                  awayRow={card.awayRow}
                  moneyline={card.moneyline}
                  total={card.total}
                  runLine={card.runLine}
                  stadiumData={card.stadiumData}
                  flashSignature={card.flashSignature}
                  gameBetSlip={card.gameBetSlip}
                  identitiesByPlayerId={identitiesByPlayerId}
                  playersById={playersById}
                  toggleSlipSelection={toggleSlipSelection}
                  onOpenDetail={(gameId) => {
                    setDetailGameId(String(gameId))
                    setDetailTab('game-odds')
                    setViewMode('detail')
                  }}
                  onOpenStadiumModal={(gameId) => setStadiumModalGameId(String(gameId))}
                />
              ))}
            </div>
          </section>
          ) : null}

          {detailGame && viewMode === 'detail' ? (
            <section className="panel sportsbook-detail">
              <div className="sportsbook-detail-head">
                <button className="ghost-button" onClick={() => setViewMode('board')} type="button">
                  <ArrowLeft size={16} />
                  <span>Board</span>
                </button>
                <div className="sportsbook-detail-copy">
                  {(() => {
                    const stadiumData = buildStadiumDisplayModel(detailGame, stadiumsById, stadiumGameLog)
                    const stadium = stadiumData.stadium
                    return stadium ? (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <StadiumLogo name={stadium.name} />
                        <button
                          type="button"
                          onClick={() => setStadiumModalGameId(String(detailGame.id))}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999, border: `1px solid ${getChaosTagColors(stadium.chaos_level).border}`, background: getChaosTagColors(stadium.chaos_level).background, color: getChaosTagColors(stadium.chaos_level).color, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}
                        >
                          <span>{stadium.name}</span>
                          {getStadiumTimeLabel(stadium, detailGame.is_night) === 'Night' ? <Moon size={12} /> : <Sun size={12} />}
                        </button>
                      </div>
                    ) : null
                  })()}
                  <span className="brand-kicker">Game Detail</span>
                  <h2>{detailGame.game_code}</h2>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <PlayerTag height={32} identitiesByPlayerId={identitiesByPlayerId} playerId={detailGame.team_a_player_id} playersById={playersById} />
                    <span className="muted">vs</span>
                    <PlayerTag height={32} identitiesByPlayerId={identitiesByPlayerId} playerId={detailGame.team_b_player_id} playersById={playersById} />
                  </div>
                  <span className="muted">{getGameStatusLabel(detailGame, detailGame?.innings ?? sourceContext?.innings)}</span>
                </div>
              </div>

              <div className="sportsbook-tabbar">
                {DETAIL_TABS.map((tab) => (
                  <button
                    className={`sportsbook-tab ${detailTab === tab.id ? 'sportsbook-tab-active' : ''}`}
                    key={tab.id}
                    onClick={() => setDetailTab(tab.id)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {player?.is_commissioner && isGameReadyForBetting(detailGame, playersById) ? (
                <div className="sportsbook-commissioner">
                  <div className="section-head">
                    <h3>Commissioner Controls</h3>
                  </div>
                  <div className="inline-actions">
                    <button className="ghost-button" onClick={() => handleToggleLocks(false)} type="button">Lock All</button>
                    <button className="ghost-button" onClick={() => handleToggleLocks(true)} type="button">Unlock All</button>
                  </div>
                </div>
              ) : null}

              {detailTab === 'game-odds' ? (
                <div className="sportsbook-alt-market-panel">
                  {detailRunLineRow && detailRunLineOptions.length ? (
                    <div className="sportsbook-alt-market-block">
                      <div className="sportsbook-alt-market-head">
                        <div className="sportsbook-alt-market-title">
                          <strong>Alternate Run Line</strong>
                          <span className="muted">Run Line Alternate</span>
                        </div>
                        <span className="sportsbook-alt-market-value">+/-{Number(detailActiveSpread || detailRunLineRow.line).toFixed(1)}</span>
                      </div>
                      <div className="sportsbook-alt-market-actions">
                        <button
                          className="sportsbook-alt-side-card"
                          disabled={!detailRunLinePricing || !detailGame}
                          onClick={() => toggleSlipSelection(detailGame, detailRunLineRow, 'home', {
                            customLine: detailActiveSpread,
                            customOdds: detailRunLinePricing?.homeOdds,
                            customProb: detailRunLinePricing?.homeProb,
                          })}
                          type="button"
                        >
                          <span className="sportsbook-alt-side-label">{teamLabels.home}</span>
                          <strong>{detailHomeIsFav ? '-' : '+'}{Number(detailActiveSpread || 0).toFixed(1)}</strong>
                          <span className="sportsbook-alt-side-odds">{formatOdds(detailRunLinePricing?.homeOdds)}</span>
                        </button>
                        <button
                          className="sportsbook-alt-side-card"
                          disabled={!detailRunLinePricing || !detailGame}
                          onClick={() => toggleSlipSelection(detailGame, detailRunLineRow, 'away', {
                            customLine: detailActiveSpread,
                            customOdds: detailRunLinePricing?.awayOdds,
                            customProb: detailRunLinePricing?.awayProb,
                          })}
                          type="button"
                        >
                          <span className="sportsbook-alt-side-label">{teamLabels.away}</span>
                          <strong>{detailHomeIsFav ? '+' : '-'}{Number(detailActiveSpread || 0).toFixed(1)}</strong>
                          <span className="sportsbook-alt-side-odds">{formatOdds(detailRunLinePricing?.awayOdds)}</span>
                        </button>
                      </div>
                      <div className="sportsbook-number-rail">
                        <button
                          className="sportsbook-number-rail-arrow"
                          onClick={() => handleSelectAltSpread(detailGame.id, getSteppedOption(detailActiveSpread, detailRunLineOptions, -1))}
                          type="button"
                        >
                          <ChevronLeft size={18} />
                        </button>
                        <div className="sportsbook-number-rail-track" ref={runLineRailRef}>
                          {detailRunLineOptions.map((spread) => (
                            <button
                              className={`sportsbook-number-rail-value ${detailActiveSpread === spread ? 'sportsbook-number-rail-value-active' : ''}`}
                              key={spread}
                              onClick={() => handleSelectAltSpread(detailGame.id, spread)}
                              type="button"
                            >
                              {spread.toFixed(1)}
                            </button>
                          ))}
                        </div>
                        <button
                          className="sportsbook-number-rail-arrow"
                          onClick={() => handleSelectAltSpread(detailGame.id, getSteppedOption(detailActiveSpread, detailRunLineOptions, 1))}
                          type="button"
                        >
                          <ChevronRight size={18} />
                        </button>
                      </div>
                      <div className="alt-line-selector" style={{ display: 'none' }}>
                        {detailRunLineOptions.map((spread) => (
                          <button
                            className={`alt-line-pill${detailActiveSpread === spread ? ' alt-line-pill-active' : ''}`}
                            data-pill-label={`+/-${spread.toFixed(1)}`}
                            key={spread}
                            onClick={() => handleSelectAltSpread(detailGame.id, spread)}
                            type="button"
                          >
                            Â±{spread.toFixed(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {detailTotalRow && detailTotalOptions.length ? (
                    <div className="sportsbook-alt-market-block">
                      <div className="sportsbook-alt-market-head">
                        <div className="sportsbook-alt-market-title">
                          <strong>Alternate Total Runs</strong>
                          <span className="muted">Total Alternate</span>
                        </div>
                        <span className="sportsbook-alt-market-value">{Number(detailActiveTotal || detailTotalRow.line).toFixed(1)}</span>
                      </div>
                      <div className="sportsbook-alt-market-actions">
                        <button
                          className="sportsbook-alt-side-card"
                          disabled={!detailTotalPricing || !detailGame}
                          onClick={() => toggleSlipSelection(detailGame, detailTotalRow, 'over', {
                            customLine: detailActiveTotal,
                            customOdds: detailTotalPricing?.overOdds,
                            customProb: detailTotalPricing?.overProb,
                          })}
                          type="button"
                        >
                          <span className="sportsbook-alt-side-label">Over</span>
                          <strong>{Number(detailActiveTotal || 0).toFixed(1)}</strong>
                          <span className="sportsbook-alt-side-odds">{formatOdds(detailTotalPricing?.overOdds)}</span>
                        </button>
                        <button
                          className="sportsbook-alt-side-card"
                          disabled={!detailTotalPricing || !detailGame}
                          onClick={() => toggleSlipSelection(detailGame, detailTotalRow, 'under', {
                            customLine: detailActiveTotal,
                            customOdds: detailTotalPricing?.underOdds,
                            customProb: detailTotalPricing?.underProb,
                          })}
                          type="button"
                        >
                          <span className="sportsbook-alt-side-label">Under</span>
                          <strong>{Number(detailActiveTotal || 0).toFixed(1)}</strong>
                          <span className="sportsbook-alt-side-odds">{formatOdds(detailTotalPricing?.underOdds)}</span>
                        </button>
                      </div>
                      <div className="sportsbook-number-rail">
                        <button
                          className="sportsbook-number-rail-arrow"
                          onClick={() => handleSelectAltTotal(detailGame.id, getSteppedOption(detailActiveTotal, detailTotalOptions, -1))}
                          type="button"
                        >
                          <ChevronLeft size={18} />
                        </button>
                        <div className="sportsbook-number-rail-track" ref={totalRailRef}>
                          {detailTotalOptions.map((line) => (
                            <button
                              className={`sportsbook-number-rail-value ${detailActiveTotal === line ? 'sportsbook-number-rail-value-active' : ''}`}
                              key={line}
                              onClick={() => handleSelectAltTotal(detailGame.id, line)}
                              type="button"
                            >
                              {line.toFixed(1)}
                            </button>
                          ))}
                        </div>
                        <button
                          className="sportsbook-number-rail-arrow"
                          onClick={() => handleSelectAltTotal(detailGame.id, getSteppedOption(detailActiveTotal, detailTotalOptions, 1))}
                          type="button"
                        >
                          <ChevronRight size={18} />
                        </button>
                      </div>
                      <div className="alt-line-selector" style={{ display: 'none' }}>
                        {detailTotalOptions.map((line) => (
                          <button
                            className={`alt-line-pill${detailActiveTotal === line ? ' alt-line-pill-active' : ''}`}
                            data-pill-label={line.toFixed(1)}
                            key={line}
                            onClick={() => handleSelectAltTotal(detailGame.id, line)}
                            type="button"
                          >
                            {line.toFixed(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="sportsbook-sections">
                {Object.keys(detailTabSections).length ? (
                  Object.entries(detailTabSections).map(([sectionName, rows]) => {
                    const expanded = expandedSections[`${detailTab}:${sectionName}`] !== false
                    return (
                      <div className="sportsbook-section" key={sectionName}>
                        <button
                          className="sportsbook-section-head"
                          onClick={() =>
                            setExpandedSections((current) => ({
                              ...current,
                              [`${detailTab}:${sectionName}`]: current[`${detailTab}:${sectionName}`] === false,
                            }))
                          }
                          type="button"
                        >
                          <span className="sportsbook-section-head-copy">
                            <strong>{sectionName}</strong>
                          </span>
                          <span className="sportsbook-section-head-actions">
                            <span className="sportsbook-sgp-pill">Live</span>
                            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </span>
                        </button>

                        {expanded ? (
                          <div className="sportsbook-market-list">
                            {rows.map((row) => {
                              const isCountProp = ['hr_prop', 'hit_prop', 'k_prop'].includes(row.bet_type)
                              const propPricingRow = isCountProp
                                ? (row.prop_lambda != null ? row : detailGeneratedOddsByKey[buildOddsRowKey(row)] || row)
                                : row
                              const altPropOptions = isCountProp ? getAltPropLines(Number(row.line)) : []
                              const activeLine = isCountProp
                                ? (altPropLine[row.id] != null && altPropOptions.includes(altPropLine[row.id]) ? altPropLine[row.id] : Number(row.line))
                                : null
                              const isAltLine = isCountProp && activeLine !== Number(row.line)
                              const activePricing = isAltLine ? getAltPropPricing({ line: activeLine, row: propPricingRow }) : null
                              const unit = row.bet_type === 'hr_prop' ? 'HR' : row.bet_type === 'hit_prop' ? 'Hits' : 'K'

                              return (
                                <div className="sportsbook-market-row" key={row.id || buildOddsRowKey(row)}>
                                  <div className="sportsbook-market-copy">
                                    {isCountProp ? (
                                      <CharacterPortrait name={getTargetPortraitName(row.target_entity)} size={36} />
                                    ) : null}
                                    <div className="sportsbook-market-copy-text">
                                      <MarketTitle
                                        game={detailGame}
                                        identitiesByPlayerId={identitiesByPlayerId}
                                        playersById={playersById}
                                        row={row}
                                      />
                                      <div className="muted">
                                        {row.target_entity || row.bet_type.replaceAll('_', ' ')}
                                      </div>
                                    </div>
                                  </div>

                                  {isCountProp && altPropOptions.length ? (
                                    <div className="sportsbook-number-rail sportsbook-prop-rail">
                                      <button
                                        className="sportsbook-number-rail-arrow"
                                        onClick={() => handleSelectAltProp(detailGame.id, row, getSteppedOption(activeLine, altPropOptions, -1), propPricingRow)}
                                        type="button"
                                      >
                                        <ChevronLeft size={16} />
                                      </button>
                                      <div className="sportsbook-number-rail-track">
                                        {altPropOptions.map((line) => (
                                          <button
                                            className={`sportsbook-number-rail-value ${activeLine === line ? 'sportsbook-number-rail-value-active' : ''}`}
                                            key={line}
                                            onClick={() => handleSelectAltProp(detailGame.id, row, line, propPricingRow)}
                                            type="button"
                                          >
                                            {line.toFixed(1)}
                                          </button>
                                        ))}
                                      </div>
                                      <button
                                        className="sportsbook-number-rail-arrow"
                                        onClick={() => handleSelectAltProp(detailGame.id, row, getSteppedOption(activeLine, altPropOptions, 1), propPricingRow)}
                                        type="button"
                                      >
                                        <ChevronRight size={16} />
                                      </button>
                                    </div>
                                  ) : null}

                                  <div className="sportsbook-market-actions">
                                    {isCountProp ? (
                                      ['over', 'under'].map((side) => {
                                        const odds = isAltLine
                                          ? (side === 'over' ? activePricing?.overOdds : activePricing?.underOdds)
                                          : (side === 'over' ? row.odds_over : row.odds_under)
                                        const prob = isAltLine
                                          ? (side === 'over' ? activePricing?.overProb : activePricing?.underProb)
                                          : (side === 'over' ? row.predicted_probability : 1 - Number(row.predicted_probability || 0.5))
                                        const selected = betSlip.some(
                                          (entry) =>
                                            entry.gameId === detailGame.id &&
                                            entry.rowId === row.id &&
                                            entry.side === side &&
                                            (entry.customLine ?? Number(row.line)) === activeLine,
                                        )
                                        return (
                                          <button
                                            className={`sportsbook-odds-button ${selected ? 'sportsbook-odds-button-selected' : ''} ${!isAltLine && isOddsFlashing(row.id, side) ? 'sportsbook-odds-flash' : ''}`}
                                            disabled={!row.id || row.is_locked || !isGameReadyForBetting(detailGame, playersById) || odds == null}
                                            key={side}
                                            onClick={() => toggleSlipSelection(
                                              detailGame,
                                              row,
                                              side,
                                              isAltLine ? { customLine: activeLine, customOdds: odds, customProb: prob } : null,
                                            )}
                                            type="button"
                                          >
                                            <span className="sportsbook-odds-line">{side === 'over' ? 'Over' : 'Under'} {activeLine.toFixed(1)} {unit}</span>
                                            <strong>{formatOdds(odds)}</strong>
                                          </button>
                                        )
                                      })
                                    ) : (
                                      getSideOptions(row, detailGame, playersById, identitiesByPlayerId).map((option) => {
                                        const selected = betSlip.some(
                                          (entry) =>
                                            entry.gameId === detailGame.id &&
                                            entry.rowId === row.id &&
                                            entry.side === option.side,
                                        )
                                        return (
                                          <button
                                            className={`sportsbook-odds-button ${selected ? 'sportsbook-odds-button-selected' : ''} ${isOddsFlashing(row.id, option.side) ? 'sportsbook-odds-flash' : ''}`}
                                            disabled={!row.id || row.is_locked || !isGameReadyForBetting(detailGame, playersById)}
                                            key={option.side}
                                            onClick={() => toggleSlipSelection(detailGame, row, option.side)}
                                            type="button"
                                          >
                                            <span className="sportsbook-odds-line">{option.label}</span>
                                            <strong>{formatOdds(option.odds)}</strong>
                                          </button>
                                        )
                                      })
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                    )
                  })
                ) : (
                  <div className="empty-state">
                    <strong>No markets yet</strong>
                    <span className="muted">
                      {isGameReadyForBetting(detailGame, playersById)
                        ? 'Live odds will appear here as soon as lines are generated.'
                        : 'Assign both teams before publishing a betting board.'}
                    </span>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          {betSlip.length ? (
            <div className={`sportsbook-slip ${slipCollapsed ? 'sportsbook-slip-collapsed' : ''}`}>
              <button
                aria-label={slipCollapsed ? 'Expand bet slip' : 'Collapse bet slip'}
                className="sportsbook-slip-drag"
                onClick={() => setSlipCollapsed((current) => !current)}
                type="button"
              >
                <span className="sportsbook-slip-drag-bar" />
              </button>

              <div className="sportsbook-slip-head" onClick={() => setSlipCollapsed((current) => !current)}>
                <div className="sportsbook-slip-head-title">
                  <span className="sportsbook-slip-count">{betSlip.length}</span>
                  <h3>Bet Slip</h3>
                </div>
                <div className="sportsbook-slip-head-meta">
                  {slipCollapsed ? <span className="muted">{`$${slipWager.toFixed(2)} staked`}</span> : null}
                  <button
                    className="link-button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setBetSlip([])
                      setActiveWagerKey(null)
                    }}
                    type="button"
                  >
                    Clear All
                  </button>
                  {slipCollapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </div>
              </div>

              {!slipCollapsed ? (
                <>
                  <div className="sportsbook-slip-list">
                    {betSlip.map((entry) => {
                      const game = boardGames.find((item) => String(item.id) === String(entry.gameId))
                      const row = (oddsByGameId[String(entry.gameId)] || []).find((item) => item.id === entry.rowId) || entry.row
                      const option = row && game ? getSideOptions(row, game, playersById, identitiesByPlayerId).find((item) => item.side === entry.side) : null
                      const slipLine = entry.customLine ?? row?.line
                      const slipOdds = entry.customOdds ?? option?.odds
                      const slipTitle = row && game
                        ? formatBetTitle({ ...row, chosen_side: entry.side, line: slipLine }, game, playersById, identitiesByPlayerId)
                        : entry.side
                      const slipSubtitle = row && game
                        ? formatBetDescription({ ...row, line: slipLine }, game, playersById, identitiesByPlayerId)
                        : ''
                      return (
                        <div className="sportsbook-slip-row" key={entry.key}>
                          <div className="sportsbook-slip-copy sportsbook-slip-copy-with-portrait">
                            {['hr_prop', 'hit_prop', 'k_prop'].includes(row?.bet_type) ? (
                              <CharacterPortrait name={getTargetPortraitName(row?.target_entity)} size={36} />
                            ) : null}
                            <div>
                              {row && game ? (
                                <>
                                  <strong>{game?.game_code} · {slipTitle}</strong>
                                  <span className="muted">{slipSubtitle} · {formatOdds(slipOdds)}</span>
                                </>
                              ) : (
                                <>
                              <strong>{game?.game_code} · {formatBetDescription(row, game, playersById, identitiesByPlayerId)}</strong>
                              <span className="muted">{option?.label} · {formatOdds(option?.odds)}</span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="sportsbook-slip-controls">
                            <button
                              className={`sportsbook-slip-input ${activeWagerKey === entry.key ? 'sportsbook-slip-input-active' : ''}`}
                              onClick={() => setActiveWagerKey(entry.key)}
                              type="button"
                            >
                              <span className="sportsbook-slip-input-prefix">$</span>
                              {entry.wagerSips === '' ? '0' : entry.wagerSips}
                            </button>

                            <button
                              className="icon-button"
                              onClick={() => setBetSlip((current) => current.filter((item) => item.key !== entry.key))}
                              type="button"
                            >
                              <X size={16} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="sportsbook-numpad">
                    <div className="sportsbook-numpad-quick">
                      {[1, 5, 20].map((amount) => (
                        <button key={amount} onClick={() => handleNumpadQuickAdd(amount)} type="button">
                          {`+$${amount}`}
                        </button>
                      ))}
                    </div>
                    <div className="sportsbook-numpad-grid">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].map((key) => (
                        <button key={key} onClick={() => handleNumpadKeyPress(key)} type="button">
                          {key === 'back' ? '⌫' : key}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="sportsbook-slip-footer">
                    <div>
                      <span className="muted">Potential payout</span>
                      <strong>{`$${slipPayout.toFixed(2)}`}</strong>
                      {slipError ? <div className="sportsbook-slip-error">{slipError}</div> : null}
                    </div>
                    <button className="solid-button" disabled={placingBetId === 'slip' || slipHasInvalidWager} onClick={handlePlaceBets} type="button">
                      {placingBetId === 'slip' ? 'Placing...' : 'Place Bets'}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {stadiumModalGame ? (
            <StadiumInfoModal
              game={stadiumModalGame}
              onClose={() => setStadiumModalGameId(null)}
              stadiumGameLog={stadiumGameLog}
              stadiumsById={stadiumsById}
            />
          ) : null}

          <SettleUp
            bets={selectedBets.filter((entry) => ['won', 'lost'].includes(entry.status))}
            currentPlayer={player}
            game={detailGame}
            identitiesByPlayerId={identitiesByPlayerId}
            mode={mode}
            onSettlementCreated={(settlement) => setSettlements((current) => [settlement, ...current.filter((entry) => entry.id !== settlement.id)])}
            players={players}
            pushToast={pushToast}
            settlements={selectedSettlements}
          />
        </Fragment>
      )}
    </div>
  )
}

const MY_BETS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'settled', label: 'Settled' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
]

function MyBetsView({
  bets,
  gamesById,
  playersById,
  identitiesByPlayerId,
  charactersById,
  plateAppearances,
  pitchingStints,
  isSeasonMode,
  payoutFormatter,
  filter,
  onFilterChange,
}) {
  const filteredBets = bets.filter((bet) => {
    if (filter === 'all') return true
    if (filter === 'open') return bet.status === 'open'
    if (filter === 'settled') return ['won', 'lost', 'void'].includes(bet.status)
    return bet.status === filter
  })

  return (
    <section className="panel sportsbook-my-bets">
      <div className="sportsbook-board-head">
        <div>
          <h2>My Bets</h2>
        </div>
        <span className="muted">{bets.length} bet{bets.length === 1 ? '' : 's'}</span>
      </div>

      <div className="tab-row">
        {MY_BETS_FILTERS.map((entry) => (
          <button
            className={`tab-button ${filter === entry.id ? 'tab-button-active' : ''}`}
            key={entry.id}
            onClick={() => onFilterChange(entry.id)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      {filteredBets.length ? (
        <div className="feed-list">
          {filteredBets.map((bet) => {
            const game = gamesById[String(bet.game_id)]
            const progress = game ? getBetProgress(bet, game, plateAppearances, pitchingStints, charactersById, playersById) : null
            const wager = Number(bet.wager_dollars || 0)
            const payout = Number(bet.potential_payout_dollars || 0)
            return (
              <div className="betting-ticket my-bet-ticket" key={bet.id}>
                <div className="bet-card-head">
                  <strong>{game ? formatBetTitle(bet, game, playersById, identitiesByPlayerId) : bet.bet_type}</strong>
                  <span
                    className="status-pill"
                    style={{ background: `${STATUS_COLORS[bet.status] || '#94A3B8'}22`, color: STATUS_COLORS[bet.status] || '#94A3B8' }}
                  >
                    {bet.status}
                  </span>
                </div>
                <div className="muted">{game ? `${game.game_code} · ${formatBetSubtitle(bet, game, playersById, identitiesByPlayerId)}` : ''}</div>

                {progress ? <BetProgressMeter progress={progress} status={bet.status} /> : null}

                <div className="betting-ticket-meta">
                  <span className="muted">Odds: <strong>{formatOdds(bet.odds)}</strong></span>
                  <span className="muted">Wager: {payoutFormatter(wager)}</span>
                  <span className="muted">To Pay: {payoutFormatter(payout)}</span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="empty-state">
          <strong>No bets here</strong>
          <span className="muted">Place a bet from the board to see it here.</span>
        </div>
      )}
    </section>
  )
}

function StadiumInfoModal({ game, stadiumsById, stadiumGameLog, onClose }) {
  const { stadium, log, model } = buildStadiumDisplayModel(game, stadiumsById, stadiumGameLog)
  if (!stadium) return null

  const timeLabel = getStadiumTimeLabel(stadium, game.is_night)
  const chaosColors = getChaosTagColors(stadium.chaos_level)

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(2,6,23,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{ width: '100%', maxWidth: 520, background: '#0F172A', border: '1px solid rgba(51,65,85,0.95)', borderRadius: 18, padding: 20 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <StadiumLogo name={stadium.name} width={104} height={40} borderRadius={10} />
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{stadium.name}</div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#CBD5E1' }}>
                  {timeLabel === 'Night' ? <Moon size={13} /> : <Sun size={13} />}
                  {timeLabel}
                </div>
              </div>
            </div>
            <div style={{ color: '#94A3B8', fontSize: 13, marginTop: 10 }}>
              LF {stadium.lf_distance} / CF {stadium.cf_distance} / RF {stadium.rf_distance}
            </div>
          </div>
          <button className="icon-button" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>

        <div style={{ marginTop: 14, color: '#CBD5E1', fontSize: 14 }}>{stadium.description}</div>

        <div style={{ display: 'inline-flex', marginTop: 14, padding: '6px 10px', borderRadius: 999, border: `1px solid ${chaosColors.border}`, background: chaosColors.background, color: chaosColors.color, fontSize: 12, fontWeight: 700 }}>
          Chaos {getChaosStars(stadium.chaos_level)}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginTop: 16 }}>
          <div className="panel" style={{ padding: 12 }}>
            <span className="muted">Scoring factor</span>
            <strong style={{ display: 'block', marginTop: 4 }}>{model.finalModifiers.scoringFactor.toFixed(2)}x</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <span className="muted">HR factor</span>
            <strong style={{ display: 'block', marginTop: 4 }}>{model.finalModifiers.hrFactor.toFixed(2)}x</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <span className="muted">Variance</span>
            <strong style={{ display: 'block', marginTop: 4 }}>{model.finalModifiers.varianceMultiplier.toFixed(2)}x</strong>
          </div>
        </div>

        <div style={{ marginTop: 16, padding: 14, borderRadius: 14, border: '1px solid rgba(51,65,85,0.9)', background: 'rgba(15,23,42,0.65)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Historical sample</span>
            <span className="muted" style={{ fontSize: 13 }}>
              {log.length} game{log.length === 1 ? '' : 's'} · {Math.round(model.weights.avgConfidence * 100)}% confidence
            </span>
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
            Formula weight {(model.weights.formulaWeight * 100).toFixed(0)}% · historical weight {(model.weights.historicalWeight * 100).toFixed(0)}%
          </div>
        </div>
      </div>
    </div>
  )
}
