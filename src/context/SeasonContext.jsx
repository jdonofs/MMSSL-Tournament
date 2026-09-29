import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import { createRefreshCoordinator } from '../utils/refreshCoordinator'
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
  const [snapshot, setSnapshot] = useState(null)
  const [selectedSeasonId, setSelectedSeasonId] = useState(() => readLocalStorageItem(STORAGE_KEY))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const selectedSeasonIdRef = useRef(selectedSeasonId)
  const snapshotRef = useRef(null)
  const requestRef = useRef(0)
  const sliceRequestsRef = useRef({ teams: 0, schedule: 0, ledger: 0 })
  const sliceRevisionsRef = useRef({ teams: 0, schedule: 0, ledger: 0 })
  const mountedRef = useRef(false)
  // Skip the selection effect when refreshSeasons has already started its load,
  // but run it when the user switches via the navbar.
  // Seeded with the same initial value as selectedSeasonId (not '') — on a fresh
  // page load with a previously-stored season in localStorage, the effect below
  // runs on mount before refreshSeasons' own fetch resolves and sets this ref,
  // so without seeding it here both fire the same 4 queries in parallel on every load.
  const lastRefreshedSeasonIdRef = useRef(selectedSeasonId)

  const selectSeason = useCallback((value) => {
    const next = String(typeof value === 'function' ? value(selectedSeasonIdRef.current) : value || '')
    if (next === selectedSeasonIdRef.current) return
    selectedSeasonIdRef.current = next
    requestRef.current += 1
    setError(null)
    setLoading(snapshotRef.current?.id !== next)
    setSelectedSeasonId(next)
  }, [])

  const loadSeason = useCallback(async (seasonId, request, sliceRevisions) => {
    const results = await Promise.all([
      fetchAllRows(() => supabase.from('season_teams').select('*').eq('season_id', seasonId).order('created_at')),
      fetchAllRows(() => supabase.from('season_schedule').select('*').eq('season_id', seasonId).order('round_number')),
      fetchAllRows(() => supabase.from('season_betting_ledger').select('*').eq('season_id', seasonId).order('created_at')),
      fetchAllRows(() => supabase.from('players').select('id, name, color').order('name')),
    ])
    for (const result of results) if (result.error) throw result.error
    if (!mountedRef.current || requestRef.current !== request || selectedSeasonIdRef.current !== seasonId) return
    const previous = snapshotRef.current?.id === seasonId ? snapshotRef.current : null
    const keepRows = (key, rows) => previous && JSON.stringify(previous[key]) === JSON.stringify(rows) ? previous[key] : rows
    const next = {
      id: seasonId,
      teams: keepRows('teams', previous && sliceRevisionsRef.current.teams !== sliceRevisions.teams ? previous.teams : results[0].data || []),
      schedule: keepRows('schedule', previous && sliceRevisionsRef.current.schedule !== sliceRevisions.schedule ? previous.schedule : results[1].data || []),
      ledger: keepRows('ledger', previous && sliceRevisionsRef.current.ledger !== sliceRevisions.ledger ? previous.ledger : results[2].data || []),
      players: keepRows('players', results[3].data || []),
    }
    const stableSnapshot = previous && next.teams === previous.teams && next.schedule === previous.schedule
      && next.ledger === previous.ledger && next.players === previous.players ? previous : next
    snapshotRef.current = stableSnapshot
    for (const slice of ['teams', 'schedule', 'ledger']) sliceRevisionsRef.current[slice] += 1
    setSnapshot(stableSnapshot)
    setError(null)
    setLoading(false)
  }, [])

  // The scorebook depends on this callback's stable identity. Recreating it on
  // every realtime render would reload the scorebook after each pitch.
  const refreshSeasons = useCallback(async (preferredSeasonId, options = {}) => {
    const { silent = false } = options
    const request = ++requestRef.current
    const selectionAtStart = selectedSeasonIdRef.current
    const preferredId = preferredSeasonId ? String(preferredSeasonId) : ''
    if (!silent && !snapshotRef.current) setLoading(true)
    if (!silent) setError(null)

    try {

    const { data: seasonsData, error: seasonsError } = await supabase
      .from('seasons')
      .select('*')
      .order('created_at', { ascending: false })

    if (seasonsError) throw seasonsError
    if (!mountedRef.current || requestRef.current !== request || selectedSeasonIdRef.current !== selectionAtStart) return seasonsData || []

    const seasons = (seasonsData || []).map((season) => ({
      ...season,
      innings: normalizeRegulationInnings(season?.innings, DEFAULT_REGULATION_INNINGS),
      mercy_rule: season?.mercy_rule === true,
      mercy_rule_differential: normalizeMercyRuleDifferential(
        season?.mercy_rule_differential,
        DEFAULT_MERCY_RULE_DIFFERENTIAL,
      ),
    }))
    const current = preferredId || selectedSeasonIdRef.current
    const hasSelection = seasons.some((season) => String(season.id) === current)
    const nextSelection = hasSelection ? current : String(seasons[0]?.id || '')
    if (nextSelection !== selectedSeasonIdRef.current) {
      selectedSeasonIdRef.current = nextSelection
      setSelectedSeasonId(nextSelection)
    }
    lastRefreshedSeasonIdRef.current = nextSelection
    if (snapshotRef.current?.id !== nextSelection) setLoading(true)

    if (!nextSelection) {
      snapshotRef.current = { id: '', teams: [], schedule: [], ledger: [], players: [] }
      setSnapshot(snapshotRef.current)
      setAllSeasons((current) => JSON.stringify(current) === JSON.stringify(seasons) ? current : seasons)
      setError(null)
      setLoading(false)
      return seasons
    }
    const sliceRevisions = { ...sliceRevisionsRef.current }
    for (const slice of ['teams', 'schedule', 'ledger']) sliceRequestsRef.current[slice] += 1
    await loadSeason(nextSelection, request, sliceRevisions)
    if (mountedRef.current && requestRef.current === request) {
      setAllSeasons((current) => JSON.stringify(current) === JSON.stringify(seasons) ? current : seasons)
    }
    return seasons
    } catch (failure) {
      if (mountedRef.current && requestRef.current === request) {
        setError(failure?.message || 'Season data is unavailable.')
        setLoading(false)
      }
      throw failure
    }
  }, [loadSeason])

  useEffect(() => {
    mountedRef.current = true
    refreshSeasons().catch(() => {})
    return () => { mountedRef.current = false; requestRef.current += 1 }
  }, [])

  // When the user switches seasons via the navbar (setViewedSeason), refreshSeasons
  // is NOT called, so schedule/teams data stays stale. This effect detects that case
  // (lastRefreshedSeasonIdRef doesn't match the new selectedSeasonId) and reloads
  // the season-specific data for the newly selected season.
  useEffect(() => {
    if (!selectedSeasonId || lastRefreshedSeasonIdRef.current === selectedSeasonId) return
    lastRefreshedSeasonIdRef.current = selectedSeasonId

    const request = ++requestRef.current
    const sliceRevisions = { ...sliceRevisionsRef.current }
    for (const slice of ['teams', 'schedule', 'ledger']) sliceRequestsRef.current[slice] += 1
    loadSeason(selectedSeasonId, request, sliceRevisions).catch((failure) => {
      if (mountedRef.current && requestRef.current === request && selectedSeasonIdRef.current === selectedSeasonId) {
        setError(failure?.message || 'Season data is unavailable.')
        setLoading(false)
      }
    })
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

    const dirtySlices = new Set()
    let disposed = false
    const refreshDirtySlices = async () => {
      const slices = [...dirtySlices]
      dirtySlices.clear()
      const request = requestRef.current
      const sliceRequests = Object.fromEntries(slices.map((slice) => [slice, ++sliceRequestsRef.current[slice]]))
      const results = await Promise.all(slices.map(async (slice) => {
        if (slice === 'schedule') return [slice, await fetchAllRows(() => supabase.from('season_schedule').select('*').eq('season_id', selectedSeasonId).order('round_number'))]
        if (slice === 'teams') return [slice, await fetchAllRows(() => supabase.from('season_teams').select('*').eq('season_id', selectedSeasonId).order('created_at'))]
        return [slice, await fetchAllRows(() => supabase.from('season_betting_ledger').select('*').eq('season_id', selectedSeasonId).order('created_at'))]
      }))
      if (disposed || !mountedRef.current || requestRef.current !== request || selectedSeasonIdRef.current !== selectedSeasonId) return
      for (const [slice, result] of results) {
        if (result.error) throw result.error
      }
      for (const [slice, result] of results) {
        if (sliceRequestsRef.current[slice] !== sliceRequests[slice] || snapshotRef.current?.id !== selectedSeasonId) continue
        const key = slice === 'teams' ? 'teams' : slice === 'schedule' ? 'schedule' : 'ledger'
        if (JSON.stringify(snapshotRef.current[key]) === JSON.stringify(result.data || [])) continue
        snapshotRef.current = { ...snapshotRef.current, [key]: result.data || [] }
        sliceRevisionsRef.current[slice] += 1
        setSnapshot(snapshotRef.current)
      }
    }
    const refreshCoordinator = createRefreshCoordinator({
      run: refreshDirtySlices,
      delayMs: 150,
      maxWaitMs: 750,
      isPaused: () => document.visibilityState === 'hidden',
      onError: (failure) => {
        if (!disposed && mountedRef.current && selectedSeasonIdRef.current === selectedSeasonId) {
          setError(failure?.message || 'Season data is unavailable.')
        }
      },
    })
    const invalidate = (slice) => {
      dirtySlices.add(slice)
      refreshCoordinator.request()
    }
    const invalidateAll = ({ immediate = false } = {}) => {
      dirtySlices.add('schedule')
      dirtySlices.add('teams')
      dirtySlices.add('ledger')
      refreshCoordinator.request({ immediate })
    }
    let hasSubscribed = false
    const channel = supabase
      .channel(`season-live-${selectedSeasonId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_schedule', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        invalidate('schedule')
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_teams', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        invalidate('teams')
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_betting_ledger', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        invalidate('ledger')
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (hasSubscribed) invalidateAll({ immediate: true })
        hasSubscribed = true
      })

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      invalidateAll({ immediate: true })
      refreshCoordinator.resume()
    }
    const handleOnline = () => invalidateAll({ immediate: true })
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnline)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
      refreshCoordinator.dispose()
      supabase.removeChannel(channel)
    }
  }, [realtimeEnabled, selectedSeasonId])

  const visibleSnapshot = snapshot?.id === selectedSeasonId ? snapshot : null
  const seasonTeams = visibleSnapshot?.teams || []
  const schedule = visibleSnapshot?.schedule || []
  const seasonBettingLedger = visibleSnapshot?.ledger || []
  const players = visibleSnapshot?.players || []

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
    setViewedSeason: (season) => selectSeason(season ? String(season.id) : ''),
    currentSeason,
    selectedSeasonId,
    setSelectedSeasonId: selectSeason,
    refreshSeasons,
    loading,
    error,
    available: Boolean(visibleSnapshot),
    standings,
    schedule,
    seasonTeams,
    seasonBettingLedger,
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
    error,
    visibleSnapshot,
    standings,
    schedule,
    seasonTeams,
    seasonBettingLedger,
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
