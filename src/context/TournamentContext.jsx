import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import useRealtimeEnabled from '../hooks/useRealtimeEnabled'
import { DEFAULT_REGULATION_INNINGS, normalizeRegulationInnings } from '../utils/gameRules'
import { readLocalStorageItem, removeLocalStorageItem, writeLocalStorageItem } from '../utils/localStorage'

const TournamentContext = createContext(null)
const STORAGE_KEY = 'sluggers-selected-tournament'

export function TournamentProvider({ children }) {
  const realtimeEnabled = useRealtimeEnabled()
  const [tournaments, setTournaments] = useState([])
  const [selectedTournamentId, setSelectedTournamentId] = useState(
    () => readLocalStorageItem(STORAGE_KEY),
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hasLoaded, setHasLoaded] = useState(false)
  const hasLoadedRef = useRef(false)
  const selectedTournamentIdRef = useRef(selectedTournamentId)
  const requestRef = useRef(0)
  const mountedRef = useRef(false)

  const selectTournament = useCallback((value) => {
    const next = String(typeof value === 'function' ? value(selectedTournamentIdRef.current) : value || '')
    if (next === selectedTournamentIdRef.current) return
    selectedTournamentIdRef.current = next
    requestRef.current += 1
    setSelectedTournamentId(next)
    if (!hasLoadedRef.current) refreshTournaments(next).catch(() => {})
  }, [])

  const refreshTournaments = useCallback(async (preferredTournamentId) => {
    const request = ++requestRef.current
    const selectionAtStart = selectedTournamentIdRef.current
    try {
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .order('tournament_number', { ascending: false })

    if (error) throw error
    if (!mountedRef.current || requestRef.current !== request || selectedTournamentIdRef.current !== selectionAtStart) return data || []

    const next = (data || []).map((tournament) => ({
      ...tournament,
      innings: normalizeRegulationInnings(tournament?.innings, DEFAULT_REGULATION_INNINGS),
    }))
    setTournaments(next)

    const preferredId = preferredTournamentId ? String(preferredTournamentId) : ''
    const current = preferredId || selectedTournamentIdRef.current
    const hasSelection = next.some(t => String(t.id) === current)
    const nextSelection = hasSelection ? current : String(next[0]?.id || '')
    selectedTournamentIdRef.current = nextSelection
    setSelectedTournamentId(nextSelection)
    setError(null)
    hasLoadedRef.current = true
    setHasLoaded(true)
    setLoading(false)
    return next
    } catch (failure) {
      if (mountedRef.current && requestRef.current === request && selectedTournamentIdRef.current === selectionAtStart) {
        setError(failure?.message || 'Tournament data is unavailable.')
        setLoading(false)
      }
      throw failure
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    refreshTournaments().catch(() => {})
    return () => { mountedRef.current = false; requestRef.current += 1 }
  }, [])

  useEffect(() => {
    // Skipped on pages that don't need live updates (see useRealtimeEnabled) — an open realtime
    // WebSocket connection disqualifies a page from the browser's back/forward cache, so a page
    // with no use for this channel shouldn't pay that cost.
    if (!realtimeEnabled) return undefined

    const channelName = `tournaments-context-${Math.random().toString(36).slice(2)}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, () => {
        refreshTournaments(undefined, { silent: true }).catch(() => {})
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [realtimeEnabled])

  useEffect(() => {
    if (selectedTournamentId) {
      writeLocalStorageItem(STORAGE_KEY, selectedTournamentId)
    } else {
      removeLocalStorageItem(STORAGE_KEY)
    }
  }, [selectedTournamentId])

  // The tournament the user is currently viewing (may be archived)
  const viewedTournament =
    tournaments.find(t => String(t.id) === String(selectedTournamentId)) || null

  // The real active (non-archived) tournament
  const activeTournament =
    tournaments.find(t => !t.archived) || tournaments[0] || null

  // Backward-compat alias
  const currentTournament = viewedTournament

  const setViewedTournament = (tournament) => {
    selectTournament(tournament ? String(tournament.id) : '')
  }

  const value = useMemo(
    () => ({
      // New API
      allTournaments: tournaments,
      activeTournament,
      viewedTournament,
      setViewedTournament,
      // Backward-compat
      tournaments,
      currentTournament,
      selectedTournamentId,
      setSelectedTournamentId: selectTournament,
      refreshTournaments,
      loading,
      error,
      available: hasLoaded,
    }),
    [tournaments, activeTournament, viewedTournament, currentTournament, loading, error, hasLoaded, selectedTournamentId],
  )

  return <TournamentContext.Provider value={value}>{children}</TournamentContext.Provider>
}

export function useTournament() {
  const context = useContext(TournamentContext)
  if (!context) throw new Error('useTournament must be used inside TournamentProvider')
  return context
}
