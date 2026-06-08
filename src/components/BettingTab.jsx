import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Moon, Sun, X } from 'lucide-react'
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
  buildOddsRowKey,
  calculatePayout,
  generateGameOdds,
  mergeOddsWithExistingRows,
} from '../utils/oddsEngine'
import { buildOddsGenerationContext } from '../utils/oddsContext'
import { buildAppliedStadiumModel } from '../utils/stadiumOdds'
import {
  getChaosStars,
  getChaosTagColors,
  getStadiumSpriteStyle,
  getStadiumTimeLabel,
} from '../utils/stadiums'
import { getTeamShortName } from '../utils/teamIdentity'

const GAME_STATUSES = new Set(['pending', 'active', 'scheduled', 'in_progress', 'complete'])
const ACTIVE_STATUSES = new Set(['pending', 'active', 'scheduled', 'in_progress'])
const BOARD_COLUMN_HEADERS = ['Run Line', 'Total', 'Moneyline']
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
  return odds != null && Math.abs(Number(odds)) > 900
}

function formatLineValue(value, prefix = '') {
  if (value == null || Number.isNaN(Number(value))) return '--'
  const num = Number(value)
  const normalized = Number.isInteger(num) ? `${num}` : num.toFixed(1)
  if (!prefix) return normalized
  return `${prefix} ${normalized}`
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

function getGameStatusLabel(game) {
  if (!game) return 'Unavailable'
  if (game.status === 'in_progress' || game.status === 'active') {
    return `Live${game.current_inning ? ` · ${game.current_inning}${Number(game.current_inning) === 1 ? 'st' : Number(game.current_inning) === 2 ? 'nd' : Number(game.current_inning) === 3 ? 'rd' : 'th'} inning` : ''}`
  }
  if (game.status === 'scheduled') return 'Scheduled'
  if (game.status === 'pending') return 'Waiting on matchup'
  if (game.status === 'complete') return 'Final'
  return game.status
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
    payoutField = 'potential_payout_sips',
    wagerField = 'wager_sips',
    isSeasonMode = false,
  } = options
  const tournamentGameIds = new Set(games.filter((game) => game[sourceIdField] === sourceId || game.tournament_id === sourceId).map((game) => game.id))
  return players
    .map((player) => {
      const net = bets
        .filter((bet) => bet.player_id === player.id && tournamentGameIds.has(bet.game_id))
        .reduce((sum, bet) => {
          if (!isSeasonMode && bet.wager_type === 'finish_drink') return sum
          if (bet.status === 'won') return sum + Number(bet[payoutField] || 0)
          if (bet.status === 'lost') return sum - Number(bet[wagerField] || 0)
          return sum
        }, 0)
      return { ...player, net: Math.round(net * 10) / 10 }
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
    return [
      { side: 'home', label: labels.home, odds: row.odds_home, probability: row.predicted_probability },
      { side: 'away', label: labels.away, odds: row.odds_away, probability: 1 - Number(row.predicted_probability || 0.5) },
    ]
  }

  if (row.bet_type === 'over_under' || row.bet_type === 'k_prop') {
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
  return row.target_entity
}

function MarketTitle({ row, game, playersById, identitiesByPlayerId }) {
  if (row.bet_type === 'moneyline' || row.bet_type === 'run_line') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_b_player_id} playersById={playersById} />
        <span className="muted">vs</span>
        <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_a_player_id} playersById={playersById} />
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

function normalizeSeasonGame(game, teamsById, stadiumsByName) {
  const homeTeam = teamsById[game.home_team_id]
  const awayTeam = teamsById[game.away_team_id]
  return {
    ...game,
    tournament_id: game.season_id,
    team_a_player_id: awayTeam?.player_id || null,
    team_b_player_id: homeTeam?.player_id || null,
    winner_player_id: teamsById[game.winner_team_id]?.player_id || null,
    team_a_runs: Number(game.away_score || 0),
    team_b_runs: Number(game.home_score || 0),
    stadium_id: stadiumsByName[game.stadium]?.id || null,
    game_code: game.game_code || `R${game.round_number || '-'} · ${awayTeam?.team_name || 'Away'} @ ${homeTeam?.team_name || 'Home'}`,
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

export default function BettingTab({ mode = 'tournament' }) {
  const { player } = useAuth()
  const { currentTournament } = useTournament()
  const { currentSeason, seasonTeams } = useSeason()
  const { pushToast } = useToast()
  const isSeasonMode = mode === 'season'
  const sourceContext = isSeasonMode ? currentSeason : currentTournament
  const wagerUnitLabel = isSeasonMode ? 'dollars' : 'sips'
  const wagerUnitShort = isSeasonMode ? '$' : 'sips'
  const payoutFormatter = (value) => isSeasonMode ? `$${Number(value || 0).toFixed(0)}` : `${Number(value || 0).toFixed(1)} sips`
  const sourceTables = isSeasonMode ? {
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
    wagerField: 'wager_sips',
    payoutField: 'potential_payout_sips',
  }
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
  const [weights, setWeights] = useState({ char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 })
  const [detailGameId, setDetailGameId] = useState('')
  const [viewMode, setViewMode] = useState('board')
  const [detailTab, setDetailTab] = useState('game-odds')
  const [activeLedgerTab, setActiveLedgerTab] = useState('my-bets')
  const [loading, setLoading] = useState(true)
  const [altRunLine, setAltRunLine] = useState({})
  const [altTotal, setAltTotal] = useState({})
  const [placingBetId, setPlacingBetId] = useState(null)
  const [voidingBetId, setVoidingBetId] = useState(null)
  const [expandedSections, setExpandedSections] = useState({})
  const [betSlip, setBetSlip] = useState([])
  const [stadiumModalGameId, setStadiumModalGameId] = useState(null)
  const autoSyncRef = useRef({})
  const runLineRailRef = useRef(null)
  const totalRailRef = useRef(null)
  const { identitiesByPlayerId: tournamentIdentitiesByPlayerId } = useTournamentTeamIdentity(currentTournament?.id)

  useEffect(() => {
    async function load() {
      setLoading(true)
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
      ] = await Promise.all([
        supabase.from(sourceTables.games).select('*').order('id'),
        supabase.from('players').select('*'),
        supabase.from('characters').select('*'),
        isSeasonMode
          ? supabase.from(sourceTables.picks).select('*').eq('season_id', sourceContext?.id || -1).order('created_at')
          : supabase.from(sourceTables.picks).select('*'),
        supabase.from(sourceTables.pas).select('*').order('created_at'),
        supabase.from(sourceTables.pitching).select('*').order('created_at'),
        supabase.from(sourceTables.odds).select('*').order('updated_at', { ascending: false }),
        isSeasonMode
          ? supabase.from(sourceTables.bets).select('*').eq('season_id', sourceContext?.id || -1).order('placed_at', { ascending: false })
          : supabase.from(sourceTables.bets).select('*').order('placed_at', { ascending: false }),
        supabase.from(sourceTables.settlements).select('*').order('settled_at', { ascending: false }),
        supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle(),
        supabase.from('stadiums').select('*'),
        isSeasonMode
          ? supabase.from(sourceTables.stadiumLog).select('*').eq('season_id', sourceContext?.id || -1).order('created_at')
          : supabase.from(sourceTables.stadiumLog).select('*').order('created_at'),
      ])

      const teamsById = Object.fromEntries((seasonTeams || []).map((entry) => [entry.id, entry]))
      const stadiumsByName = Object.fromEntries((stadiumsData || []).map((entry) => [entry.name, entry]))
      const charactersByName = Object.fromEntries((charactersData || []).map((entry) => [entry.name, entry]))
      const normalizedGames = isSeasonMode
        ? (gamesData || []).map((entry) => normalizeSeasonGame(entry, teamsById, stadiumsByName))
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
      if (weightsData) setWeights(weightsData)

      setDetailGameId((current) => current || String((normalizedGames || []).find((entry) => ACTIVE_STATUSES.has(entry.status) && entry.tournament_id === sourceContext?.id)?.id || ''))
      setLoading(false)
    }

    load()
  }, [currentTournament?.id, currentSeason?.id, isSeasonMode, seasonTeams, sourceContext?.id])

  useEffect(() => {
    const channel = supabase
      .channel(`betting-board-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.odds }, async () => {
        const { data } = await supabase.from(sourceTables.odds).select('*').order('updated_at', { ascending: false })
        setGameOdds(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.bets }, async () => {
        const query = supabase.from(sourceTables.bets).select('*').order('placed_at', { ascending: false })
        const { data } = isSeasonMode ? await query.eq('season_id', sourceContext?.id || -1) : await query
        setBets(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.games }, async () => {
        const { data } = isSeasonMode
          ? await supabase.from(sourceTables.games).select('*').eq('season_id', sourceContext?.id || -1).order('id')
          : await supabase.from(sourceTables.games).select('*').order('id')
        if (isSeasonMode) {
          const teamsById = Object.fromEntries((seasonTeams || []).map((entry) => [entry.id, entry]))
          const stadiumsByName = Object.fromEntries(stadiums.map((entry) => [entry.name, entry]))
          setGames((data || []).map((entry) => normalizeSeasonGame(entry, teamsById, stadiumsByName)))
        } else {
          setGames((data || []).filter((entry) => GAME_STATUSES.has(entry.status)))
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.pas }, async () => {
        const { data } = await supabase.from(sourceTables.pas).select('*').order('created_at')
        setPlateAppearances(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.pitching }, async () => {
        const { data } = await supabase.from(sourceTables.pitching).select('*').order('created_at')
        setPitchingStints(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.picks }, async () => {
        if (isSeasonMode) {
          const [{ data }, { data: charsData }] = await Promise.all([
            supabase.from(sourceTables.picks).select('*').eq('season_id', sourceContext?.id || -1).order('created_at'),
            supabase.from('characters').select('*'),
          ])
          const charactersByName = Object.fromEntries((charsData || []).map((entry) => [entry.name, entry]))
          setDraftPicks(normalizeSeasonDraftPicks(data || [], sourceContext?.id, seasonTeams, charactersByName))
          return
        }
        const { data } = await supabase.from(sourceTables.picks).select('*')
        setDraftPicks(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'odds_engine_weights' }, async () => {
        const { data } = await supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle()
        if (data) setWeights(data)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: sourceTables.settlements }, async () => {
        const { data } = await supabase.from(sourceTables.settlements).select('*').order('settled_at', { ascending: false })
        setSettlements(data || [])
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
          const stadiumsByName = Object.fromEntries(stadiums.map((entry) => [entry.name, entry]))
          setStadiumGameLog((data || []).map((entry) => ({ ...entry, stadium_id: stadiumsByName[entry.stadium]?.id || null })))
        } else {
          setStadiumGameLog(data || [])
        }
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [isSeasonMode, seasonTeams, sourceContext?.id, stadiums, sourceTables])

  const playersById = useMemo(() => Object.fromEntries(players.map((entry) => [entry.id, entry])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map((entry) => [entry.id, entry])), [characters])
  const stadiumsById = useMemo(() => Object.fromEntries(stadiums.map((entry) => [entry.id, entry])), [stadiums])
  const seasonIdentitiesByPlayerId = useMemo(
    () => Object.fromEntries((seasonTeams || []).map((team) => [team.player_id, {
      playerId: team.player_id,
      teamName: team.team_name || playersById[team.player_id]?.name || 'Season Team',
      teamMascot: team.team_mascot || null,
      teamLogoKey: team.team_logo_key || null,
      teamLogoUrl: team.logo_url || null,
    }])),
    [seasonTeams, playersById],
  )
  const identitiesByPlayerId = isSeasonMode ? seasonIdentitiesByPlayerId : tournamentIdentitiesByPlayerId
  const tournamentGames = useMemo(
    () => games.filter((entry) => entry.tournament_id === sourceContext?.id),
    [games, sourceContext?.id],
  )
  const boardGames = useMemo(
    () =>
      tournamentGames
        .filter((entry) => ACTIVE_STATUSES.has(entry.status))
        .filter((entry) => isGameReadyForBetting(entry, playersById))
        .slice()
        .sort((a, b) => Number(a.id) - Number(b.id)),
    [tournamentGames, playersById],
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

  const selectedBets = useMemo(
    () => bets.filter((entry) => detailGame && String(entry.game_id) === String(detailGame.id)),
    [bets, detailGame],
  )
  const selectedSettlements = useMemo(
    () => settlements.filter((entry) => detailGame && String(entry.game_id) === String(detailGame.id)),
    [settlements, detailGame],
  )
  const myBets = useMemo(() => selectedBets.filter((entry) => entry.player_id === player?.id), [selectedBets, player?.id])
  const leaderboard = useMemo(
    () => buildLeaderboard(players, boardGames, bets, sourceContext?.id, {
      sourceIdField: sourceTables.sourceIdField,
      payoutField: sourceTables.payoutField,
      wagerField: sourceTables.wagerField,
      isSeasonMode,
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

  const detailOdds = useMemo(
    () => oddsByGameId[String(detailGame?.id)] || [],
    [oddsByGameId, detailGame?.id],
  )

  const detailSections = useMemo(() => {
    const tabs = Object.fromEntries(DETAIL_TABS.map((tab) => [tab.id, {}]))
    detailOdds.forEach((row) => {
      if (row.bet_type === 'custom') return
      const bucket = getDetailBucket(row)
      tabs[bucket.tab][bucket.section] = tabs[bucket.tab][bucket.section] || []
      tabs[bucket.tab][bucket.section].push(row)
    })
    return tabs
  }, [detailOdds])

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

      const payload = mergeOddsWithExistingRows(
        generatedRows,
        gameOdds.filter((entry) => entry.game_id === game.id),
      )

      const toUpdate = payload.filter((r) => r.id != null)
      const toInsert = payload.filter((r) => r.id == null)

      let finalPayload = [...toUpdate]

      if (toUpdate.length) {
        const { error: updateError } = await supabase.from(sourceTables.odds).upsert(toUpdate)
        if (updateError) throw updateError
      }
      if (toInsert.length) {
        const { data: inserted, error: insertError } = await supabase.from(sourceTables.odds).insert(toInsert).select()
        if (insertError) throw insertError
        if (inserted) finalPayload = [...finalPayload, ...inserted]
      }

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
    boardSourceSignatures.forEach(({ game, signature }) => {
      if (!readyGameIds.has(String(game.id))) return
      const syncState = autoSyncRef.current[game.id]
      if (syncState?.inFlight || syncState?.signature === signature) return
      handleGenerateOdds(game, { silent: true, sourceSignature: signature })
    })
  }, [boardSourceSignatures, readyGameIds])

  const toggleSlipSelection = (game, row, side, customLineOpts = null) => {
    if (!game || !row?.id || row.is_locked || !isGameReadyForBetting(game, playersById)) return

    const option = getSideOptions(row, game, playersById, identitiesByPlayerId).find((entry) => entry.side === side)
    if (!option?.odds && !customLineOpts?.customOdds) return

    const nextEntry = {
      key: buildSlipKey({ gameId: game.id, rowId: row.id, side, customLine: customLineOpts?.customLine }),
      gameId: game.id,
      rowId: row.id,
      row,
      side,
      wagerType: isSeasonMode ? 'dollars' : 'sips',
      wagerSips: 1,
      ...customLineOpts,
    }

    const isRunLineOrTotal = row.bet_type === 'run_line' || row.bet_type === 'over_under'
    setBetSlip((current) => {
      if (isRunLineOrTotal && customLineOpts != null) {
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
          customOdds: isAlt ? (isHome ? pricing.homeOdds : pricing.awayOdds) : undefined,
          customProb: isAlt ? (isHome ? pricing.homeProb : pricing.awayProb) : undefined,
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
          customOdds: isAlt ? (isOver ? pricing.overOdds : pricing.underOdds) : undefined,
          customProb: isAlt ? (isOver ? pricing.overProb : pricing.underProb) : undefined,
        }
      })
    })
  }, [games, oddsByGameId, stadiumGameLog, stadiumsById])

  const handlePlaceBets = async () => {
    if (!betSlip.length || !player?.id) return
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

      const wagerSips = entry.wagerType === 'finish_drink' ? null : Number(entry.wagerSips || 0)
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
        wager_type: entry.wagerType,
        wager_sips: wagerSips,
        potential_payout_sips: entry.wagerType === 'finish_drink' ? null : calculatePayout(wagerSips, oddsToUse),
        status: 'open',
        line: lineToUse,
        placed_at: new Date().toISOString(),
      })
    }

    const { data, error } = await supabase.from(sourceTables.bets).insert(payload).select()
    setPlacingBetId(null)
    if (error) {
      pushToast({ title: 'Bet failed', message: error.message, type: 'error' })
      return
    }

    if (data?.length) {
      setBets((current) => [...data, ...current.filter((entry) => !data.some((created) => created.id === entry.id))])
    }
    setBetSlip([])
    pushToast({ title: 'Bets placed', message: `${payload.length} ticket${payload.length === 1 ? '' : 's'} submitted.`, type: 'success' })
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

  const handleVoidBet = async (betId) => {
    setVoidingBetId(betId)
    const resolvedAt = new Date().toISOString()
    const { error } = await supabase
      .from(sourceTables.bets)
      .update({ status: 'void', result_correct: null, resolved_at: resolvedAt })
      .eq('id', betId)
    setVoidingBetId(null)

    if (error) {
      pushToast({ title: 'Void failed', message: error.message, type: 'error' })
      return
    }

    setBets((current) => current.map((bet) => (bet.id === betId ? { ...bet, status: 'void', result_correct: null, resolved_at: resolvedAt } : bet)))
    pushToast({ title: 'Bet voided', type: 'success' })
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
        return {
          game,
          ready,
          moneyline,
          total,
          runLine,
          marketCount: rows.length,
          stadiumData,
          homeRow: getBoardRow({ moneyline, total, runLine }, 'home', game, playersById, identitiesByPlayerId),
          awayRow: getBoardRow({ moneyline, total, runLine }, 'away', game, playersById, identitiesByPlayerId),
        }
      }),
    [boardGames, oddsByGameId, playersById, stadiumsById, stadiumGameLog],
  )

  const detailTabSections = detailSections[detailTab] || {}
  const ledgerRows = activeLedgerTab === 'leaderboard' ? leaderboard : activeLedgerTab === 'all-bets' ? selectedBets : myBets
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
    if (!isSeasonMode && entry.wagerType === 'finish_drink') return sum
    const game = boardGames.find((item) => String(item.id) === String(entry.gameId))
    const row = (oddsByGameId[String(entry.gameId)] || []).find((item) => item.id === entry.rowId)
    const option = row && game ? getSideOptions(row, game, playersById, identitiesByPlayerId).find((item) => item.side === entry.side) : null
    return sum + calculatePayout(Number(entry.wagerSips || 0), option?.odds)
  }, 0)

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
      {!boardGames.length ? (
        <div className="panel empty-state">
          <strong>No active games</strong>
          <span className="muted">Create or activate a matchup to publish lines.</span>
        </div>
      ) : null}

      {!boardGames.length ? null : (
        <>
          {viewMode === 'board' ? (
          <section className="panel sportsbook-board">
              <div className="sportsbook-board-head">
                <div>
                  <h2>Game Lines</h2>
                </div>
                <span className="muted">{boardCards.length} game{boardCards.length === 1 ? '' : 's'}</span>
            </div>

            <div className="sportsbook-game-list">
              {boardCards.map(({ game, ready, homeRow, awayRow, moneyline, total, runLine, marketCount, stadiumData }) => {
                const homeWinProb = Number(moneyline?.predicted_probability || 0.5)
                const homeIsFav = homeWinProb >= 0.5
                const stadium = stadiumData.stadium
                const timeLabel = stadium ? getStadiumTimeLabel(stadium, game.is_night) : null
                const chaosColors = getChaosTagColors(stadium?.chaos_level)
                const extraMarketCount = Math.max(0, marketCount - 3)

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
                    key={game.id}
                    onClick={() => {
                      if (!ready) return
                      setDetailGameId(String(game.id))
                      setDetailTab('game-odds')
                      setViewMode('detail')
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if ((event.key === 'Enter' || event.key === ' ') && ready) {
                        setDetailGameId(String(game.id))
                        setDetailTab('game-odds')
                        setViewMode('detail')
                      }
                    }}
                  >
                    <div className="sportsbook-game-meta">
                      <div className="sportsbook-game-meta-main">
                        <span className="brand-kicker">Today</span>
                        <div className="sportsbook-game-time">{game.game_code}</div>
                      </div>
                    </div>

                    {stadium ? (
                      <div className="sportsbook-stadium-chip-wrap">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            setStadiumModalGameId(String(game.id))
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

                    {[{ key: 'home', isHome: true }, { key: 'away', isHome: false }].map(({ key, isHome }) => {
                      const rl = getRunLineSide(isHome)
                      const tot = getTotalSide(isHome)
                      const ml = isHome ? homeRow.moneyline : awayRow.moneyline
                      const rlSelected = runLine && betSlip.some((e) => e.gameId === game.id && e.rowId === runLine.id && e.side === rl.side)
                      const totSelected = total && betSlip.some((e) => e.gameId === game.id && e.rowId === total.id && e.side === tot.side)
                      const mlSelected = betSlip.some((e) => e.gameId === game.id && e.rowId === ml.market?.id && e.side === ml.side)

                      return (
                        <div className="sportsbook-team-row" key={key}>
                          <div className="sportsbook-team-name">
                            <PlayerTag
                              height={24}
                              identitiesByPlayerId={identitiesByPlayerId}
                              playerId={isHome ? game.team_b_player_id : game.team_a_player_id}
                              playersById={playersById}
                            />
                          </div>
                          <div className="sportsbook-team-buttons">
                            <button
                              className={`sportsbook-odds-button ${rlSelected ? 'sportsbook-odds-button-selected' : ''}`}
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
                              className={`sportsbook-odds-button ${totSelected ? 'sportsbook-odds-button-selected' : ''}`}
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
                              className={`sportsbook-odds-button ${mlSelected ? 'sportsbook-odds-button-selected' : ''}`}
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

                    {false && ready && (runLine || total) && (
                      <div className="alt-line-selector">
                        {runLine && (
                          <>
                            <span className="alt-line-label">Spread</span>
                            {getAltSpreads(Number(runLine.line)).map((spread) => (
                              <button
                                className={`alt-line-pill${activeSpread === spread ? ' alt-line-pill-active' : ''}`}
                                key={spread}
                                onClick={(e) => { e.stopPropagation(); handleSelectAltSpread(game.id, spread) }}
                                type="button"
                              >
                                ±{spread.toFixed(1)}
                              </button>
                            ))}
                          </>
                        )}
                        {total && (
                          <>
                            <span className="alt-line-label" style={{ marginLeft: runLine ? '0.75rem' : 0 }}>Total</span>
                            {getAltTotals(Number(total.line)).map((line) => (
                              <button
                                className={`alt-line-pill${activeLine === line ? ' alt-line-pill-active' : ''}`}
                                key={line}
                                onClick={(e) => { e.stopPropagation(); handleSelectAltTotal(game.id, line) }}
                                type="button"
                              >
                                {line.toFixed(1)}
                              </button>
                            ))}
                          </>
                        )}
                      </div>
                    )}

                    {!ready ? (
                      <div className="sportsbook-card-note">Matchup not set. Betting is disabled until both teams are assigned.</div>
                    ) : null}

                    <div className="sportsbook-card-footer">
                      <div className="sportsbook-card-footer-meta">
                        {extraMarketCount > 0 ? <span className="sportsbook-card-footer-pill">{extraMarketCount} props</span> : null}
                        <span className="muted">{stadium ? `${stadium.name} ${timeLabel ? `· ${timeLabel}` : ''}` : 'Open markets available'}</span>
                      </div>
                      <span className="sportsbook-more-bets">
                        <span>More Bets</span>
                        <ChevronRight size={16} />
                      </span>
                    </div>
                  </div>
                )
              })}
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
                    <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={detailGame.team_b_player_id} playersById={playersById} />
                    <span className="muted">vs</span>
                    <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={detailGame.team_a_player_id} playersById={playersById} />
                  </div>
                  <span className="muted">{getGameStatusLabel(detailGame)}</span>
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
                          onClick={() => toggleSlipSelection(detailGame, detailRunLineRow, 'home', { customLine: detailActiveSpread, customOdds: detailRunLinePricing?.homeOdds })}
                          type="button"
                        >
                          <span className="sportsbook-alt-side-label">{teamLabels.home}</span>
                          <strong>{detailHomeIsFav ? '-' : '+'}{Number(detailActiveSpread || 0).toFixed(1)}</strong>
                          <span className="sportsbook-alt-side-odds">{formatOdds(detailRunLinePricing?.homeOdds)}</span>
                        </button>
                        <button
                          className="sportsbook-alt-side-card"
                          disabled={!detailRunLinePricing || !detailGame}
                          onClick={() => toggleSlipSelection(detailGame, detailRunLineRow, 'away', { customLine: detailActiveSpread, customOdds: detailRunLinePricing?.awayOdds })}
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
                          onClick={() => toggleSlipSelection(detailGame, detailTotalRow, 'over', { customLine: detailActiveTotal, customOdds: detailTotalPricing?.overOdds })}
                          type="button"
                        >
                          <span className="sportsbook-alt-side-label">Over</span>
                          <strong>{Number(detailActiveTotal || 0).toFixed(1)}</strong>
                          <span className="sportsbook-alt-side-odds">{formatOdds(detailTotalPricing?.overOdds)}</span>
                        </button>
                        <button
                          className="sportsbook-alt-side-card"
                          disabled={!detailTotalPricing || !detailGame}
                          onClick={() => toggleSlipSelection(detailGame, detailTotalRow, 'under', { customLine: detailActiveTotal, customOdds: detailTotalPricing?.underOdds })}
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
                            {rows.map((row) => (
                              <div className="sportsbook-market-row" key={row.id || buildOddsRowKey(row)}>
                                <div className="sportsbook-market-copy">
                                  {['hr_prop', 'hit_prop', 'k_prop'].includes(row.bet_type) ? (
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
                                <div className="sportsbook-market-actions">
                                  {getSideOptions(row, detailGame, playersById, identitiesByPlayerId).map((option) => {
                                    const selected = betSlip.some(
                                      (entry) =>
                                        entry.gameId === detailGame.id &&
                                        entry.rowId === row.id &&
                                        entry.side === option.side,
                                    )
                                    return (
                                      <button
                                        className={`sportsbook-odds-button ${selected ? 'sportsbook-odds-button-selected' : ''}`}
                                        disabled={!row.id || row.is_locked || !isGameReadyForBetting(detailGame, playersById)}
                                        key={option.side}
                                        onClick={() => toggleSlipSelection(detailGame, row, option.side)}
                                        type="button"
                                      >
                                        <span className="sportsbook-odds-line">{option.label}</span>
                                        <strong>{formatOdds(option.odds)}</strong>
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            ))}
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

          <section className="betting-summary-grid">
            <div className="panel">
              <div className="tab-row">
                <button className={`tab-button ${activeLedgerTab === 'my-bets' ? 'tab-button-active' : ''}`} onClick={() => setActiveLedgerTab('my-bets')} type="button">My Bets</button>
                <button className={`tab-button ${activeLedgerTab === 'all-bets' ? 'tab-button-active' : ''}`} onClick={() => setActiveLedgerTab('all-bets')} type="button">All Bets</button>
                <button className={`tab-button ${activeLedgerTab === 'leaderboard' ? 'tab-button-active' : ''}`} onClick={() => setActiveLedgerTab('leaderboard')} type="button">Leaderboard</button>
              </div>

              {ledgerRows.length ? (
                <div className="feed-list">
                  {activeLedgerTab === 'leaderboard'
                    ? leaderboard.map((entry, index) => (
                        <div className="feed-row" key={entry.id}>
                          <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span>{index + 1}.</span>
                            <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} player={entry} />
                          </strong>
                          <span style={{ color: entry.net >= 0 ? '#22C55E' : '#EF4444', fontWeight: 700 }}>
                            {isSeasonMode
                              ? `${entry.net >= 0 ? '+' : '-'}$${Math.abs(entry.net).toFixed(0)}`
                              : `${entry.net >= 0 ? '+' : ''}${entry.net.toFixed(1)}`}
                          </span>
                        </div>
                      ))
                    : ledgerRows.map((bet) => (
                        <div className="betting-ticket" key={bet.id}>
                          <div className="bet-card-head">
                            <strong>{bet.target_entity || bet.bet_type}</strong>
                            <span
                              className="status-pill"
                              style={{ background: `${STATUS_COLORS[bet.status] || '#94A3B8'}22`, color: STATUS_COLORS[bet.status] || '#94A3B8' }}
                            >
                              {bet.status}
                            </span>
                          </div>
                          <div className="betting-ticket-meta">
                            <span>{bet.chosen_side}</span>
                            <strong>{formatOdds(bet.odds)}</strong>
                          </div>
                          <div className="betting-ticket-meta muted">
                            <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={bet.player_id} playersById={playersById} />
                            <span>
                              {isSeasonMode
                                ? `$${Number(bet.wager_dollars || 0).toFixed(0)}`
                                : bet.wager_type === 'finish_drink'
                                  ? 'Finish drink'
                                  : `${Number(bet.wager_sips || 0).toFixed(1)} sips`}
                            </span>
                          </div>
                          {player?.is_commissioner && activeLedgerTab === 'all-bets' && bet.status === 'open' ? (
                            <button className="ghost-button" disabled={voidingBetId === bet.id} onClick={() => handleVoidBet(bet.id)} type="button">
                              {voidingBetId === bet.id ? 'Voiding...' : 'Void Bet'}
                            </button>
                          ) : null}
                        </div>
                      ))}
                </div>
              ) : (
                <div className="empty-state">
                  <strong>No entries</strong>
                  <span className="muted">{activeLedgerTab === 'leaderboard' ? 'Leaderboard will populate after bets settle.' : 'No bets match the current view.'}</span>
                </div>
              )}
            </div>
          </section>

          {betSlip.length ? (
            <div className="sportsbook-slip">
              <div className="sportsbook-slip-head">
                <div>
                  <span className="brand-kicker">Bet Slip</span>
                  <h3>{betSlip.length} selection{betSlip.length === 1 ? '' : 's'}</h3>
                </div>
                <button className="icon-button" onClick={() => setBetSlip([])} type="button">
                  <X size={16} />
                </button>
              </div>

              <div className="sportsbook-slip-list">
                {betSlip.map((entry) => {
                  const game = boardGames.find((item) => String(item.id) === String(entry.gameId))
                  const row = (oddsByGameId[String(entry.gameId)] || []).find((item) => item.id === entry.rowId) || entry.row
                  const option = row && game ? getSideOptions(row, game, playersById, identitiesByPlayerId).find((item) => item.side === entry.side) : null
                  return (
                    <div className="sportsbook-slip-row" key={entry.key}>
                      <div className="sportsbook-slip-copy sportsbook-slip-copy-with-portrait">
                        {['hr_prop', 'hit_prop', 'k_prop'].includes(row?.bet_type) ? (
                          <CharacterPortrait name={getTargetPortraitName(row?.target_entity)} size={36} />
                        ) : null}
                        <div>
                          <strong>{game?.game_code} · {formatBetDescription(row, game, playersById, identitiesByPlayerId)}</strong>
                          <span className="muted">{option?.label} · {formatOdds(option?.odds)}</span>
                        </div>
                      </div>

                      <div className="sportsbook-slip-controls">
                        {!isSeasonMode ? (
                          <div className="sportsbook-slip-toggle">
                            <button
                              className={`tab-button ${entry.wagerType === 'sips' ? 'tab-button-active' : ''}`}
                              onClick={() => updateSlipEntry(entry.key, { wagerType: 'sips', wagerSips: Number(entry.wagerSips || 1) || 1 })}
                              type="button"
                            >
                              Sips
                            </button>
                            <button
                              className={`tab-button ${entry.wagerType === 'finish_drink' ? 'tab-button-active' : ''}`}
                              onClick={() => updateSlipEntry(entry.key, { wagerType: 'finish_drink' })}
                              type="button"
                            >
                              Finish Drink
                            </button>
                          </div>
                        ) : null}

                        {!isSeasonMode && entry.wagerType === 'finish_drink' ? (
                          <span className="status-pill availability-open">Finish Drink</span>
                        ) : (
                          <input
                            className="sportsbook-slip-input"
                            min={isSeasonMode ? '1' : '0.5'}
                            onChange={(event) => updateSlipEntry(entry.key, { wagerSips: event.target.value })}
                            step={isSeasonMode ? '1' : '0.1'}
                            type="number"
                            value={entry.wagerSips}
                          />
                        )}

                        <button className="icon-button" onClick={() => setBetSlip((current) => current.filter((item) => item.key !== entry.key))} type="button">
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="sportsbook-slip-footer">
                <div>
                  <span className="muted">Potential payout</span>
                  <strong>{isSeasonMode ? `$${slipPayout.toFixed(0)}` : `${slipPayout.toFixed(1)} sips`}</strong>
                </div>
                <button className="solid-button" disabled={placingBetId === 'slip'} onClick={handlePlaceBets} type="button">
                  {placingBetId === 'slip' ? 'Placing...' : 'Place Bets'}
                </button>
              </div>
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
        </>
      )}
    </div>
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
