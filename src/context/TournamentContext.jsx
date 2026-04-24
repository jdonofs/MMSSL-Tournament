import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'

const TournamentContext = createContext(null)
const STORAGE_KEY = 'sluggers-selected-tournament'

export function TournamentProvider({ children }) {
  const [tournaments, setTournaments] = useState([])
  const [selectedTournamentId, setSelectedTournamentId] = useState(
    () => localStorage.getItem(STORAGE_KEY) || '',
  )
  const [loading, setLoading] = useState(true)
  const selectedTournamentIdRef = useRef(selectedTournamentId)

  const refreshTournaments = async (preferredTournamentId) => {
    setLoading(true)
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .order('tournament_number', { ascending: false })

    if (error) {
      setLoading(false)
      throw error
    }

    const next = data || []
    setTournaments(next)

    const preferredId = preferredTournamentId ? String(preferredTournamentId) : ''
    const current = preferredId || selectedTournamentIdRef.current
    const hasSelection = next.some(t => String(t.id) === current)
    const nextSelection = hasSelection ? current : String(next[0]?.id || '')
    setSelectedTournamentId(nextSelection)
    setLoading(false)
    return next
  }

  useEffect(() => {
    refreshTournaments().catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    selectedTournamentIdRef.current = selectedTournamentId
  }, [selectedTournamentId])

  useEffect(() => {
    const channelName = `tournaments-context-${Math.random().toString(36).slice(2)}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, () => {
        refreshTournaments().catch(() => setLoading(false))
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    if (selectedTournamentId) {
      localStorage.setItem(STORAGE_KEY, selectedTournamentId)
    } else {
      localStorage.removeItem(STORAGE_KEY)
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
    setSelectedTournamentId(tournament ? String(tournament.id) : '')
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
      setSelectedTournamentId,
      refreshTournaments,
      loading,
    }),
    [tournaments, activeTournament, viewedTournament, currentTournament, loading, selectedTournamentId],
  )

  return <TournamentContext.Provider value={value}>{children}</TournamentContext.Provider>
}

export function useTournament() {
  const context = useContext(TournamentContext)
  if (!context) throw new Error('useTournament must be used inside TournamentProvider')
  return context
}
