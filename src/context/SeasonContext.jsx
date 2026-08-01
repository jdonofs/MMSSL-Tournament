import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import useRealtimeEnabled from '../hooks/useRealtimeEnabled'
import { buildSeasonStandings } from '../utils/competitionStandings'
import { readLocalStorageItem, removeLocalStorageItem, writeLocalStorageItem } from '../utils/localStorage'
import {
  DEFAULT_MERCY_RULE_DIFFERENTIAL,
  DEFAULT_REGULATION_INNINGS,
  normalizeMercyRuleDifferential,
  normalizeRegulationInnings,
} from '../utils/gameRules'

const SeasonContext = createContext(null)
const STORAGE_KEY = 'sluggers-selected-season'

export function SeasonProvider({ children }) {
  const realtimeEnabled = useRealtimeEnabled()
  const [allSeasons, setAllSeasons] = useState([])
  const [seasonTeams, setSeasonTeams] = useState([])
  const [schedule, setSchedule] = useState([])
  const [seasonBettingLedger, setSeasonBettingLedger] = useState([])
  const [players, setPlayers] = useState([])
  const [selectedSeasonId, setSelectedSeasonId] = useState(() => readLocalStorageItem(STORAGE_KEY))
  const [loading, setLoading] = useState(true)
  const selectedSeasonIdRef = useRef(selectedSeasonId)
  // Tracks which season ID was last fully loaded by refreshSeasons so the
  // selectedSeasonId effect below can skip re-fetching when refreshSeasons
  // already did the load, but fire when the user switches via the navbar.
  // Seeded with the same initial value as selectedSeasonId (not '') — on a fresh
  // page load with a previously-stored season in localStorage, the effect below
  // runs on mount before refreshSeasons' own fetch resolves and sets this ref,
  // so without seeding it here both fire the same 4 queries in parallel on every load.
  const lastRefreshedSeasonIdRef = useRef(selectedSeasonId)

  // Memoized so its identity stays stable across renders — it's a dependency of
  // SeasonGameSessionProvider's `gameSession` memo, and an unstable reference
  // there caused Scorebook's full-season reload effect to re-fire on every
  // realtime tick (i.e. on every single pitch, since scoring writes to
  // season_schedule), not just on genuine season changes.
  const refreshSeasons = useCallback(async (preferredSeasonId, options = {}) => {
    const { silent = false } = options
    if (!silent) setLoading(true)

    const { data: seasonsData, error: seasonsError } = await supabase
      .from('seasons')
      .select('*')
      .order('created_at', { ascending: false })

    if (seasonsError) {
      if (!silent) setLoading(false)
      throw seasonsError
    }

    const seasons = (seasonsData || []).map((season) => ({
      ...season,
      innings: normalizeRegulationInnings(season?.innings, DEFAULT_REGULATION_INNINGS),
      mercy_rule: season?.mercy_rule === true,
      mercy_rule_differential: normalizeMercyRuleDifferential(
        season?.mercy_rule_differential,
        DEFAULT_MERCY_RULE_DIFFERENTIAL,
      ),
    }))
    setAllSeasons(seasons)

    const preferredId = preferredSeasonId ? String(preferredSeasonId) : ''
    const current = preferredId || selectedSeasonIdRef.current
    const hasSelection = seasons.some((season) => String(season.id) === current)
    const nextSelection = hasSelection ? current : String(seasons[0]?.id || '')
    lastRefreshedSeasonIdRef.current = nextSelection
    setSelectedSeasonId(nextSelection)

    if (!nextSelection) {
      setSeasonTeams([])
      setSchedule([])
      setSeasonBettingLedger([])
      if (!silent) setLoading(false)
      return seasons
    }

    const [{ data: teamsData }, { data: scheduleData }, { data: bettingLedgerData }, { data: playersData }] = await Promise.all([
      supabase.from('season_teams').select('*').eq('season_id', nextSelection).order('created_at'),
      supabase.from('season_schedule').select('*').eq('season_id', nextSelection).order('round_number').order('id'),
      supabase.from('season_betting_ledger').select('*').eq('season_id', nextSelection).order('created_at'),
      supabase.from('players').select('id, name, color').order('name'),
    ])

    setSeasonTeams(teamsData || [])
    setSchedule(scheduleData || [])
    setSeasonBettingLedger(bettingLedgerData || [])
    setPlayers(playersData || [])
    if (!silent) setLoading(false)
    return seasons
  }, [])

  useEffect(() => {
    refreshSeasons().catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    selectedSeasonIdRef.current = selectedSeasonId
  }, [selectedSeasonId])

  // When the user switches seasons via the navbar (setViewedSeason), refreshSeasons
  // is NOT called, so schedule/teams data stays stale. This effect detects that case
  // (lastRefreshedSeasonIdRef doesn't match the new selectedSeasonId) and reloads
  // the season-specific data for the newly selected season.
  useEffect(() => {
    if (!selectedSeasonId || lastRefreshedSeasonIdRef.current === selectedSeasonId) return
    lastRefreshedSeasonIdRef.current = selectedSeasonId

    const reload = async () => {
      const [{ data: teamsData }, { data: scheduleData }, { data: bettingLedgerData }, { data: playersData }] = await Promise.all([
        supabase.from('season_teams').select('*').eq('season_id', selectedSeasonId).order('created_at'),
        supabase.from('season_schedule').select('*').eq('season_id', selectedSeasonId).order('round_number').order('id'),
        supabase.from('season_betting_ledger').select('*').eq('season_id', selectedSeasonId).order('created_at'),
        supabase.from('players').select('id, name, color').order('name'),
      ])
      setSeasonTeams(teamsData || [])
      setSchedule(scheduleData || [])
      setSeasonBettingLedger(bettingLedgerData || [])
      setPlayers(playersData || [])
    }
    reload().catch(() => {})
  }, [selectedSeasonId])

  useEffect(() => {
    if (selectedSeasonId) {
      writeLocalStorageItem(STORAGE_KEY, selectedSeasonId)
    } else {
      removeLocalStorageItem(STORAGE_KEY)
    }
  }, [selectedSeasonId])

  useEffect(() => {
    // Skipped on pages that don't need live updates (see useRealtimeEnabled) — an open realtime
    // WebSocket connection disqualifies a page from the browser's back/forward cache, so a page
    // with no use for this channel shouldn't pay that cost.
    if (!realtimeEnabled) return undefined

    const channel = supabase
      .channel(`season-context-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seasons' }, () => {
        // Pass the current selection explicitly so a newly-inserted season never
        // auto-switches away from the season the user is already viewing.
        refreshSeasons(selectedSeasonIdRef.current || undefined, { silent: true }).catch(() => {})
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [realtimeEnabled])

  useEffect(() => {
    if (!realtimeEnabled || !selectedSeasonId) return undefined

    const channel = supabase
      .channel(`season-live-${selectedSeasonId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_schedule', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        refreshSeasons(selectedSeasonId, { silent: true }).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_teams', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        refreshSeasons(selectedSeasonId, { silent: true }).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_betting_ledger', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        refreshSeasons(selectedSeasonId, { silent: true }).catch(() => {})
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_roster', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        refreshSeasons(selectedSeasonId, { silent: true }).catch(() => {})
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [realtimeEnabled, selectedSeasonId])

  const viewedSeason = allSeasons.find((season) => String(season.id) === String(selectedSeasonId)) || null
  const activeSeason = allSeasons.find((season) => ['active', 'playoffs'].includes(season.status)) || null
  const currentSeason = viewedSeason || activeSeason || null

  const standings = useMemo(
    () => buildSeasonStandings(seasonTeams, schedule, seasonBettingLedger),
    [seasonTeams, schedule, seasonBettingLedger],
  )
  const currentRound = useMemo(() => {
    const relevantRounds = schedule
      .filter((game) => ['in_progress', 'completed'].includes(game.status))
      .map((game) => Number(game.round_number || 0))
      .filter(Boolean)
    return relevantRounds.length ? Math.max(...relevantRounds) : 1
  }, [schedule])
  const totalRounds = useMemo(() => {
    const teamCount = seasonTeams.length
    const gamesPerMatchup = currentSeason?.games_per_matchup || 0
    return teamCount > 1 ? (teamCount - 1) * gamesPerMatchup : 0
  }, [seasonTeams, currentSeason?.games_per_matchup])
  const tradeDeadlinePassed = useMemo(() => {
    if (!totalRounds || totalRounds < 2) return false
    const deadlineRound = totalRounds - 1
    const roundGames = schedule.filter((game) => Number(game.round_number) === deadlineRound)
    return roundGames.length > 0 && roundGames.every((game) => game.status === 'completed')
  }, [schedule, totalRounds])

  const seasonPlayersById = useMemo(
    () => Object.fromEntries(players.map((p) => [p.id, p])),
    [players],
  )

  const value = useMemo(() => ({
    allSeasons,
    activeSeason,
    viewedSeason,
    setViewedSeason: (season) => setSelectedSeasonId(season ? String(season.id) : ''),
    currentSeason,
    selectedSeasonId,
    setSelectedSeasonId,
    refreshSeasons,
    loading,
    standings,
    schedule,
    seasonTeams,
    players,
    seasonPlayersById,
    tradeDeadlinePassed,
    currentRound,
    totalRounds,
  }), [
    allSeasons,
    activeSeason,
    viewedSeason,
    currentSeason,
    selectedSeasonId,
    loading,
    standings,
    schedule,
    seasonTeams,
    players,
    seasonPlayersById,
    tradeDeadlinePassed,
    currentRound,
    totalRounds,
  ])

  return <SeasonContext.Provider value={value}>{children}</SeasonContext.Provider>
}

export function useSeason() {
  const context = useContext(SeasonContext)
  if (!context) {
    throw new Error('useSeason must be used inside SeasonProvider')
  }
  return context
}
