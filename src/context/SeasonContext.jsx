import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { buildSeasonStandings } from '../utils/competitionStandings'

const SeasonContext = createContext(null)
const STORAGE_KEY = 'sluggers-selected-season'

export function SeasonProvider({ children }) {
  const [allSeasons, setAllSeasons] = useState([])
  const [seasonTeams, setSeasonTeams] = useState([])
  const [schedule, setSchedule] = useState([])
  const [players, setPlayers] = useState([])
  const [selectedSeasonId, setSelectedSeasonId] = useState(() => localStorage.getItem(STORAGE_KEY) || '')
  const [loading, setLoading] = useState(true)
  const selectedSeasonIdRef = useRef(selectedSeasonId)

  const refreshSeasons = async (preferredSeasonId) => {
    setLoading(true)

    const { data: seasonsData, error: seasonsError } = await supabase
      .from('seasons')
      .select('*')
      .order('created_at', { ascending: false })

    if (seasonsError) {
      setLoading(false)
      throw seasonsError
    }

    const seasons = seasonsData || []
    setAllSeasons(seasons)

    const preferredId = preferredSeasonId ? String(preferredSeasonId) : ''
    const current = preferredId || selectedSeasonIdRef.current
    const hasSelection = seasons.some((season) => String(season.id) === current)
    const nextSelection = hasSelection ? current : String(seasons[0]?.id || '')
    setSelectedSeasonId(nextSelection)

    if (!nextSelection) {
      setSeasonTeams([])
      setSchedule([])
      setLoading(false)
      return seasons
    }

    const [{ data: teamsData }, { data: scheduleData }, { data: playersData }] = await Promise.all([
      supabase.from('season_teams').select('*').eq('season_id', nextSelection).order('created_at'),
      supabase.from('season_schedule').select('*').eq('season_id', nextSelection).order('round_number').order('id'),
      supabase.from('players').select('id, name, color').order('name'),
    ])

    setSeasonTeams(teamsData || [])
    setSchedule(scheduleData || [])
    setPlayers(playersData || [])
    setLoading(false)
    return seasons
  }

  useEffect(() => {
    refreshSeasons().catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    selectedSeasonIdRef.current = selectedSeasonId
  }, [selectedSeasonId])

  useEffect(() => {
    if (selectedSeasonId) {
      localStorage.setItem(STORAGE_KEY, selectedSeasonId)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  }, [selectedSeasonId])

  useEffect(() => {
    const channel = supabase
      .channel(`season-context-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seasons' }, () => {
        refreshSeasons().catch(() => setLoading(false))
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    if (!selectedSeasonId) return undefined

    const channel = supabase
      .channel(`season-live-${selectedSeasonId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_schedule', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        refreshSeasons(selectedSeasonId).catch(() => setLoading(false))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_teams', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        refreshSeasons(selectedSeasonId).catch(() => setLoading(false))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_roster', filter: `season_id=eq.${selectedSeasonId}` }, () => {
        refreshSeasons(selectedSeasonId).catch(() => setLoading(false))
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [selectedSeasonId])

  const viewedSeason = allSeasons.find((season) => String(season.id) === String(selectedSeasonId)) || null
  const activeSeason = allSeasons.find((season) => ['active', 'playoffs'].includes(season.status)) || null
  const currentSeason = viewedSeason || activeSeason || null

  const standings = useMemo(() => buildSeasonStandings(seasonTeams, schedule), [seasonTeams, schedule])
  const currentRound = useMemo(() => {
    const relevantRounds = schedule
      .filter((game) => ['in_progress', 'completed'].includes(game.status))
      .map((game) => Number(game.round_number || 0))
      .filter(Boolean)
    return relevantRounds.length ? Math.max(...relevantRounds) : 1
  }, [schedule])
  const totalRounds = currentSeason?.games_per_matchup || 0
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
