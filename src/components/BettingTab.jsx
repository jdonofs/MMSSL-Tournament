import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Moon, Shield, Sun, TrendingUp, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
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
  computeRunLineCoverProb,
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

const GAME_STATUSES = new Set(['pending', 'active', 'scheduled', 'in_progress', 'complete'])
const ACTIVE_STATUSES = new Set(['pending', 'active', 'scheduled', 'in_progress'])
const BOARD_COLUMN_HEADERS = ['Run Line', 'Total', 'Moneyline']
const DETAIL_TABS = [
  { id: 'game-odds', label: 'Game Odds' },
  { id: 'batter-props', label: 'Batter Props' },
  { id: 'pitcher-props', label: 'Pitcher Props' },
  { id: 'game-props', label: 'Game Props' },
  { id: 'inning-props', label: 'Inning Props' },
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
  return odds != null && Math.abs(Number(odds)) > 1000
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

function getTeamLabels(game, playersById) {
  return {
    home: playersById[game?.team_b_player_id]?.name || 'Home',
    away: playersById[game?.team_a_player_id]?.name || 'Away',
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

function buildLeaderboard(players, games, bets, tournamentId) {
  const tournamentGameIds = new Set(games.filter((game) => game.tournament_id === tournamentId).map((game) => game.id))
  return players
    .map((player) => {
      const net = bets
        .filter((bet) => bet.player_id === player.id && tournamentGameIds.has(bet.game_id))
        .reduce((sum, bet) => {
          if (bet.wager_type === 'finish_drink') return sum
          if (bet.status === 'won') return sum + Number(bet.potential_payout_sips || 0)
          if (bet.status === 'lost') return sum - Number(bet.wager_sips || 0)
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

function getSideOptions(row, game, playersById) {
  const labels = getTeamLabels(game, playersById)
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

function formatBetDescription(row, game, playersById) {
  const labels = getTeamLabels(game, playersById)
  if (row.bet_type === 'moneyline') return `${labels.home} vs ${labels.away}`
  if (row.bet_type === 'over_under') return `Game total ${Number(row.line || 0).toFixed(1)}`
  if (row.bet_type === 'first_inning_run') return 'Run scored in 1st inning'
  if (row.bet_type === 'k_prop') return `${row.target_entity} strikeouts ${Number(row.line || 0).toFixed(1)}`
  if (row.bet_type === 'custom') return row.target_entity
  return row.target_entity
}

function roundToHalf(value) {
  return Math.round(value * 2) / 2
}

function getAltSpreads(defaultSpread) {
  const base = roundToHalf(defaultSpread)
  return [
    Math.max(1.5, base - 1),
    base,
    base + 1,
    Math.min(7.5, base + 2),
  ].map(roundToHalf)
}

function getAltTotals(defaultTotal) {
  if (!defaultTotal) return []
  return [-1, -0.5, 0, 0.5, 1].map((delta) => roundToHalf(defaultTotal + delta))
}

function getBoardRow(row, side, game, playersById) {
  const teamLabels = getTeamLabels(game, playersById)
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
          label: moneylineLabel,
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
  if (row.bet_type === 'custom') return { tab: 'game-props', section: 'Custom Markets' }
  return { tab: 'inning-props', section: 'Inning Specials' }
}

function buildSlipKey(entry) {
  return entry.customLine != null
    ? `${entry.gameId}::${entry.rowId}::${entry.side}::${entry.customLine}`
    : `${entry.gameId}::${entry.rowId}::${entry.side}`
}

export default function BettingTab() {
  const { player } = useAuth()
  const { currentTournament } = useTournament()
  const { pushToast } = useToast()
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
  const [generatingGameId, setGeneratingGameId] = useState(null)
  const [voidingBetId, setVoidingBetId] = useState(null)
  const [customForm, setCustomForm] = useState({ description: '', targetEntity: '', manualOdds: -110 })
  const [expandedSections, setExpandedSections] = useState({})
  const [betSlip, setBetSlip] = useState([])
  const [stadiumModalGameId, setStadiumModalGameId] = useState(null)
  const autoSyncRef = useRef({})
  const { identitiesByPlayerId } = useTournamentTeamIdentity(currentTournament?.id)

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
        supabase.from('games').select('*').order('id'),
        supabase.from('players').select('*'),
        supabase.from('characters').select('*'),
        supabase.from('draft_picks').select('*'),
        supabase.from('plate_appearances').select('*').order('created_at'),
        supabase.from('pitching_stints').select('*').order('created_at'),
        supabase.from('game_odds').select('*').order('updated_at', { ascending: false }),
        supabase.from('bets').select('*').order('placed_at', { ascending: false }),
        supabase.from('game_settlements').select('*').order('settled_at', { ascending: false }),
        supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle(),
        supabase.from('stadiums').select('*'),
        supabase.from('stadium_game_log').select('*').order('created_at'),
      ])

      setGames((gamesData || []).filter((entry) => GAME_STATUSES.has(entry.status)))
      setPlayers(playersData || [])
      setCharacters(charactersData || [])
      setDraftPicks(picksData || [])
      setPlateAppearances(paData || [])
      setPitchingStints(pitchingData || [])
      setStadiums(stadiumsData || [])
      setStadiumGameLog(stadiumLogData || [])
      setGameOdds(oddsData || [])
      setBets(betsData || [])
      setSettlements(settlementsData || [])
      if (weightsData) setWeights(weightsData)

      setDetailGameId((current) => current || String((gamesData || []).find((entry) => ACTIVE_STATUSES.has(entry.status) && entry.tournament_id === currentTournament?.id)?.id || ''))
      setLoading(false)
    }

    load()
  }, [currentTournament?.id])

  useEffect(() => {
    const channel = supabase
      .channel(`betting-board-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_odds' }, async () => {
        const { data } = await supabase.from('game_odds').select('*').order('updated_at', { ascending: false })
        setGameOdds(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bets' }, async () => {
        const { data } = await supabase.from('bets').select('*').order('placed_at', { ascending: false })
        setBets(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, async () => {
        const { data } = await supabase.from('games').select('*').order('id')
        setGames((data || []).filter((entry) => GAME_STATUSES.has(entry.status)))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, async () => {
        const { data } = await supabase.from('plate_appearances').select('*').order('created_at')
        setPlateAppearances(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, async () => {
        const { data } = await supabase.from('pitching_stints').select('*').order('created_at')
        setPitchingStints(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks' }, async () => {
        const { data } = await supabase.from('draft_picks').select('*')
        setDraftPicks(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'odds_engine_weights' }, async () => {
        const { data } = await supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle()
        if (data) setWeights(data)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_settlements' }, async () => {
        const { data } = await supabase.from('game_settlements').select('*').order('settled_at', { ascending: false })
        setSettlements(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadiums' }, async () => {
        const { data } = await supabase.from('stadiums').select('*')
        setStadiums(data || [])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadium_game_log' }, async () => {
        const { data } = await supabase.from('stadium_game_log').select('*').order('created_at')
        setStadiumGameLog(data || [])
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  const playersById = useMemo(() => Object.fromEntries(players.map((entry) => [entry.id, entry])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map((entry) => [entry.id, entry])), [characters])
  const stadiumsById = useMemo(() => Object.fromEntries(stadiums.map((entry) => [entry.id, entry])), [stadiums])
  const tournamentGames = useMemo(
    () => games.filter((entry) => entry.tournament_id === currentTournament?.id),
    [games, currentTournament?.id],
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
    () => buildLeaderboard(players, boardGames, bets, currentTournament?.id),
    [players, boardGames, bets, currentTournament?.id],
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
    setGeneratingGameId(game.id)
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
        const { error: updateError } = await supabase.from('game_odds').upsert(toUpdate)
        if (updateError) throw updateError
      }
      if (toInsert.length) {
        const { data: inserted, error: insertError } = await supabase.from('game_odds').insert(toInsert).select()
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
      setGeneratingGameId(null)
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

    const option = getSideOptions(row, game, playersById).find((entry) => entry.side === side)
    if (!option?.odds && !customLineOpts?.customOdds) return

    const nextEntry = {
      key: buildSlipKey({ gameId: game.id, rowId: row.id, side, customLine: customLineOpts?.customLine }),
      gameId: game.id,
      rowId: row.id,
      row,
      side,
      wagerType: 'sips',
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
      const homeWinProb = Number(mlRow.predicted_probability || 0.5)
      const homeIsFav = homeWinProb >= 0.5
      const favWinProb = homeIsFav ? homeWinProb : 1 - homeWinProb
      const favCover = Math.min(0.97, Math.max(0.03, computeRunLineCoverProb(spread, completedGameMargins) + (favWinProb - 0.5) * 0.15))
      const homeOdds = homeIsFav ? americanOddsFromProbability(favCover) : americanOddsFromProbability(1 - favCover)
      const awayOdds = homeIsFav ? americanOddsFromProbability(1 - favCover) : americanOddsFromProbability(favCover)
      const homeProb = homeIsFav ? favCover : 1 - favCover
      const isAlt = spread !== Number(rlRow.line)
      return current.map((entry) => {
        if (entry.gameId !== gameId || entry.row?.bet_type !== 'run_line') return entry
        const isHome = entry.side === 'home'
        return {
          ...entry,
          customLine: isAlt ? spread : undefined,
          customOdds: isAlt ? (isHome ? homeOdds : awayOdds) : undefined,
          customProb: isAlt ? (isHome ? homeProb : 1 - homeProb) : undefined,
        }
      })
    })
  }, [completedGameMargins, oddsByGameId])

  const handleSelectAltTotal = useCallback((gameId, line) => {
    setAltTotal((prev) => ({ ...prev, [gameId]: { line } }))
    setBetSlip((current) => {
      if (!current.some((e) => e.gameId === gameId && e.row?.bet_type === 'over_under')) return current
      const rows = oddsByGameId[String(gameId)] || []
      const totalRow = rows.find((r) => r.bet_type === 'over_under')
      if (!totalRow) return current
      const defaultLine = Number(totalRow.line || 0)
      const stepsFromDefault = (line - defaultLine) / 0.5
      const defaultOverOdds = Number(totalRow.odds_over || -110)
      const defaultUnderOdds = Number(totalRow.odds_under || -110)
      const isAlt = line !== defaultLine
      return current.map((entry) => {
        if (entry.gameId !== gameId || entry.row?.bet_type !== 'over_under') return entry
        const isOver = entry.side === 'over'
        return {
          ...entry,
          customLine: isAlt ? line : undefined,
          customOdds: isAlt
            ? (isOver ? defaultOverOdds + Math.round(stepsFromDefault * 18) : defaultUnderOdds - Math.round(stepsFromDefault * 18))
            : undefined,
        }
      })
    })
  }, [oddsByGameId])

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

      const option = getSideOptions(row, game, playersById).find((item) => item.side === entry.side)
      if (!option?.odds) {
        setPlacingBetId(null)
        pushToast({ title: 'Bet slip invalid', message: 'One or more selections are missing live odds.', type: 'error' })
        return
      }

      const wagerSips = entry.wagerType === 'finish_drink' ? null : Number(entry.wagerSips || 0)
      const oddsToUse = entry.customOdds ?? Number(option.odds)
      const probToUse = entry.customProb ?? Number(option.probability)
      const lineToUse = entry.customLine ?? row.line
      payload.push({
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

    const { data, error } = await supabase.from('bets').insert(payload).select()
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
      .from('game_odds')
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

  const handleCreateCustomBet = async () => {
    if (!detailGame || !customForm.description.trim() || !isGameReadyForBetting(detailGame, playersById)) return
    const impliedProbability = 100 / (Math.abs(Number(customForm.manualOdds)) + 100)
    const row = {
      game_id: detailGame.id,
      bet_type: 'custom',
      target_entity: customForm.targetEntity.trim()
        ? `${customForm.description.trim()} · ${customForm.targetEntity.trim()}`
        : customForm.description.trim(),
      line: null,
      odds_yes: Number(customForm.manualOdds),
      odds_no: americanOddsFromProbability(1 - impliedProbability),
      predicted_probability: Number(impliedProbability.toFixed(4)),
      is_locked: false,
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await supabase.from('game_odds').insert(row).select().single()
    if (error) {
      pushToast({ title: 'Custom bet failed', message: error.message, type: 'error' })
      return
    }

    if (data) setGameOdds((current) => mergeRowsById(current, [data]))
    setCustomForm({ description: '', targetEntity: '', manualOdds: -110 })
    pushToast({ title: 'Custom bet added', type: 'success' })
  }

  const handleVoidBet = async (betId) => {
    setVoidingBetId(betId)
    const resolvedAt = new Date().toISOString()
    const { error } = await supabase
      .from('bets')
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
          stadiumData,
          homeRow: getBoardRow({ moneyline, total, runLine }, 'home', game, playersById),
          awayRow: getBoardRow({ moneyline, total, runLine }, 'away', game, playersById),
        }
      }),
    [boardGames, oddsByGameId, playersById, stadiumsById, stadiumGameLog],
  )

  const detailTabSections = detailSections[detailTab] || {}
  const ledgerRows = activeLedgerTab === 'leaderboard' ? leaderboard : activeLedgerTab === 'all-bets' ? selectedBets : myBets
  const teamLabels = getTeamLabels(detailGame, playersById)
  const slipPayout = betSlip.reduce((sum, entry) => {
    if (entry.wagerType === 'finish_drink') return sum
    const game = boardGames.find((item) => String(item.id) === String(entry.gameId))
    const row = (oddsByGameId[String(entry.gameId)] || []).find((item) => item.id === entry.rowId)
    const option = row && game ? getSideOptions(row, game, playersById).find((item) => item.side === entry.side) : null
    return sum + calculatePayout(Number(entry.wagerSips || 0), option?.odds)
  }, 0)

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
      <div className="page-head">
        <div>
          <span className="brand-kicker">Betting Tab</span>
          <h1>Live lines and sip settlements</h1>
        </div>
        {player?.is_commissioner ? (
          <button
            className="solid-button"
            disabled={!detailGame || !isGameReadyForBetting(detailGame, playersById) || generatingGameId === detailGame?.id}
            onClick={() => handleGenerateOdds(detailGame)}
            type="button"
          >
            <TrendingUp size={16} />
            <span>{generatingGameId === detailGame?.id ? 'Refreshing...' : 'Refresh Live Odds'}</span>
          </button>
        ) : null}
      </div>

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
                <span className="brand-kicker">Main Board</span>
                <h2>Game Lines</h2>
              </div>
              <span className="muted">{boardCards.length} game{boardCards.length === 1 ? '' : 's'}</span>
            </div>

            <div className="sportsbook-columns">
              <div className="sportsbook-columns-spacer">Game</div>
              {BOARD_COLUMN_HEADERS.map((column) => (
                <div className="sportsbook-column-label" key={column}>{column}</div>
              ))}
            </div>

            <div className="sportsbook-game-list">
              {boardCards.map(({ game, ready, homeRow, awayRow, moneyline, total, runLine, stadiumData }) => {
                const labels = getTeamLabels(game, playersById)
                const noOddsYet = !moneyline && !total
                const activeSpread = altRunLine[game.id]?.spread ?? Number(runLine?.line || 1.5)
                const activeLine = altTotal[game.id]?.line ?? Number(total?.line || 0)
                const homeWinProb = Number(moneyline?.predicted_probability || 0.5)
                const homeIsFav = homeWinProb >= 0.5
                const stadium = stadiumData.stadium
                const timeLabel = stadium ? getStadiumTimeLabel(stadium, game.is_night) : null
                const chaosColors = getChaosTagColors(stadium?.chaos_level)

                const getRunLineSide = (isHome) => {
                  if (!runLine) return { label: 'Not live', odds: null, selectable: false }
                  const showMinus = isHome ? homeIsFav : !homeIsFav
                  const label = `${showMinus ? '-' : '+'}${activeSpread.toFixed(1)}`
                  let odds
                  if (activeSpread === Number(runLine.line)) {
                    odds = isHome ? runLine.odds_home : runLine.odds_away
                  } else {
                    const favWinProb = homeIsFav ? homeWinProb : 1 - homeWinProb
                    const favCover = Math.min(0.97, Math.max(0.03, computeRunLineCoverProb(activeSpread, completedGameMargins) + (favWinProb - 0.5) * 0.15))
                    odds = isHome
                      ? (homeIsFav ? americanOddsFromProbability(favCover) : americanOddsFromProbability(1 - favCover))
                      : (homeIsFav ? americanOddsFromProbability(1 - favCover) : americanOddsFromProbability(favCover))
                  }
                  return { label, odds, selectable: true, side: isHome ? 'home' : 'away' }
                }

                const getTotalSide = (isOver) => {
                  if (!total) return { label: '--', odds: null, selectable: false }
                  const label = isOver ? `O ${activeLine.toFixed(1)}` : `U ${activeLine.toFixed(1)}`
                  let odds
                  if (activeLine === Number(total.line)) {
                    odds = isOver ? total.odds_over : total.odds_under
                  } else {
                    const steps = (activeLine - Number(total.line)) / 0.5
                    odds = isOver
                      ? Number(total.odds_over || -110) + Math.round(steps * 18)
                      : Number(total.odds_under || -110) - Math.round(steps * 18)
                  }
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
                      <div className="sportsbook-game-time">{game.game_code}</div>
                      <div className="muted">{getGameStatusLabel(game)}</div>
                    </div>

                    {stadium ? (
                      <div style={{ marginTop: -4, marginBottom: 10 }}>
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
                        >
                          <span>{stadium.name}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#E2E8F0' }}>
                            {timeLabel === 'Night' ? <Moon size={12} /> : <Sun size={12} />}
                            {timeLabel}
                          </span>
                        </button>
                      </div>
                    ) : null}

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

                          <button
                            className={`sportsbook-odds-button ${rlSelected ? 'sportsbook-odds-button-selected' : ''}`}
                            disabled={!ready || !rl.selectable || runLine?.is_locked || isOddsOffBoard(rl.odds)}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              if (!runLine) return
                              const isAlt = activeSpread !== Number(runLine.line)
                              toggleSlipSelection(game, runLine, rl.side, isAlt ? { customLine: activeSpread, customOdds: rl.odds } : null)
                            }}
                          >
                            <span className="sportsbook-odds-line">{rl.label}</span>
                            <strong>{formatOdds(rl.odds)}</strong>
                          </button>

                          <button
                            className={`sportsbook-odds-button ${totSelected ? 'sportsbook-odds-button-selected' : ''}`}
                            disabled={!ready || !tot.selectable || total?.is_locked || isOddsOffBoard(tot.odds)}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              if (!total) return
                              const isAlt = activeLine !== Number(total.line)
                              toggleSlipSelection(game, total, tot.side, isAlt ? { customLine: activeLine, customOdds: tot.odds } : null)
                            }}
                          >
                            <span className="sportsbook-odds-line">{tot.label}</span>
                            <strong>{formatOdds(tot.odds)}</strong>
                          </button>

                          <button
                            className={`sportsbook-odds-button ${mlSelected ? 'sportsbook-odds-button-selected' : ''}`}
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
                      )
                    })}

                    {ready && (runLine || total) && (
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
                    ) : noOddsYet ? (
                      <div className="sportsbook-card-note">Live lines are syncing.</div>
                    ) : null}
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
                    <Shield size={16} color="#EAB308" />
                  </div>
                  <div className="inline-actions">
                    <button className="ghost-button" onClick={() => handleToggleLocks(false)} type="button">Lock All</button>
                    <button className="ghost-button" onClick={() => handleToggleLocks(true)} type="button">Unlock All</button>
                  </div>
                  <div className="sportsbook-custom-form">
                    <input
                      onChange={(event) => setCustomForm((current) => ({ ...current, description: event.target.value }))}
                      placeholder="Custom bet description"
                      value={customForm.description}
                    />
                    <input
                      onChange={(event) => setCustomForm((current) => ({ ...current, targetEntity: event.target.value }))}
                      placeholder="Target entity"
                      value={customForm.targetEntity}
                    />
                    <input
                      onChange={(event) => setCustomForm((current) => ({ ...current, manualOdds: Number(event.target.value) }))}
                      type="number"
                      value={customForm.manualOdds}
                    />
                    <button className="solid-button" onClick={handleCreateCustomBet} type="button">Add Custom Bet</button>
                  </div>
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
                          <strong>{sectionName}</strong>
                          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>

                        {expanded ? (
                          <div className="sportsbook-market-list">
                            {rows.map((row) => (
                              <div className="sportsbook-market-row" key={row.id || buildOddsRowKey(row)}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                                  {['hr_prop', 'hit_prop', 'k_prop'].includes(row.bet_type) ? (
                                    <CharacterPortrait name={getTargetPortraitName(row.target_entity)} size={36} />
                                  ) : null}
                                  <div style={{ minWidth: 0 }}>
                                    <strong>{formatBetDescription(row, detailGame, playersById)}</strong>
                                    <div className="muted">
                                      {row.target_entity || row.bet_type.replaceAll('_', ' ')}
                                    </div>
                                  </div>
                                </div>
                                <div className="sportsbook-market-actions">
                                  {getSideOptions(row, detailGame, playersById).map((option) => {
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
                            {entry.net >= 0 ? '+' : ''}{entry.net.toFixed(1)}
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
                            <span>{bet.wager_type === 'finish_drink' ? 'Finish drink' : `${Number(bet.wager_sips || 0).toFixed(1)} sips`}</span>
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
                  const option = row && game ? getSideOptions(row, game, playersById).find((item) => item.side === entry.side) : null
                  return (
                    <div className="sportsbook-slip-row" key={entry.key}>
                      <div className="sportsbook-slip-copy" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {['hr_prop', 'hit_prop', 'k_prop'].includes(row?.bet_type) ? (
                          <CharacterPortrait name={getTargetPortraitName(row?.target_entity)} size={36} />
                        ) : null}
                        <div>
                          <strong>{game?.game_code} · {formatBetDescription(row, game, playersById)}</strong>
                          <span className="muted">{option?.label} · {formatOdds(option?.odds)}</span>
                        </div>
                      </div>

                      <div className="sportsbook-slip-controls">
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

                        {entry.wagerType === 'finish_drink' ? (
                          <span className="status-pill availability-open">Finish Drink</span>
                        ) : (
                          <input
                            className="sportsbook-slip-input"
                            min="0.5"
                            onChange={(event) => updateSlipEntry(entry.key, { wagerSips: event.target.value })}
                            step="0.1"
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
                  <strong>{slipPayout.toFixed(1)} sips</strong>
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
