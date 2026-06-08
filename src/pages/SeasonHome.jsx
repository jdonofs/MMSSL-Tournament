import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import CompetitionOverviewTables from '../components/CompetitionOverviewTables'
import { buildSeasonPowerRankings } from '../utils/seasonPowerRankings'
import { buildSeasonTeamIdentity } from '../utils/teamIdentity'

export default function SeasonHome() {
  const { player } = useAuth()
  const { currentSeason, standings, seasonPlayersById, seasonTeams } = useSeason()
  const [rankingData, setRankingData] = useState({
    roster: [],
    characters: [],
    plateAppearances: [],
    pitchingStints: [],
    gameFielders: [],
    historicalPlateAppearances: [],
    historicalPitchingStints: [],
    historicalGameFielders: [],
  })
  const [rankingsLoading, setRankingsLoading] = useState(false)
  const [rankingsError, setRankingsError] = useState('')

  const identitiesByPlayerId = useMemo(
    () => Object.fromEntries(
      standings.map((team) => [team.player_id, buildSeasonTeamIdentity(team)]),
    ),
    [standings],
  )
  const playersById = useMemo(
    () => Object.fromEntries(
      standings.map((team) => {
        const seasonPlayer = seasonPlayersById[team.player_id]
        return [team.player_id, { id: team.player_id, name: seasonPlayer?.name || team.team_name || 'TBD', color: seasonPlayer?.color || '#E2E8F0' }]
      }),
    ),
    [standings, seasonPlayersById],
  )

  useEffect(() => {
    if (!currentSeason?.id) {
      setRankingData({
        roster: [],
        characters: [],
        plateAppearances: [],
        pitchingStints: [],
        gameFielders: [],
        historicalPlateAppearances: [],
        historicalPitchingStints: [],
        historicalGameFielders: [],
      })
      setRankingsLoading(false)
      setRankingsError('')
      return undefined
    }

    let isActive = true

    const loadRankingsData = async () => {
      if (isActive) {
        setRankingsLoading(true)
        setRankingsError('')
      }

      const [
        { data: rosterData, error: rosterError },
        { data: charactersData, error: charactersError },
        { data: paData, error: paError },
        { data: pitchingData, error: pitchingError },
        { data: fieldersData, error: fieldersError },
        { data: historicalPaData, error: historicalPaError },
        { data: historicalPitchingData, error: historicalPitchingError },
        { data: historicalFieldersData, error: historicalFieldersError },
      ] = await Promise.all([
        supabase.from('season_roster').select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from('characters').select('*').order('name'),
        supabase.from('season_plate_appearances').select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from('season_pitching_stints').select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from('season_game_fielders').select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from('plate_appearances').select('*').order('created_at'),
        supabase.from('pitching_stints').select('*').order('created_at'),
        supabase.from('game_fielders').select('*').order('created_at'),
      ])

      const error = rosterError || charactersError || paError || pitchingError || fieldersError || historicalPaError || historicalPitchingError || historicalFieldersError
      if (!isActive) return

      if (error) {
        setRankingsError(error.message || 'Unable to load power rankings.')
        setRankingsLoading(false)
        return
      }

      setRankingData({
        roster: rosterData || [],
        characters: charactersData || [],
        plateAppearances: paData || [],
        pitchingStints: pitchingData || [],
        gameFielders: fieldersData || [],
        historicalPlateAppearances: historicalPaData || [],
        historicalPitchingStints: historicalPitchingData || [],
        historicalGameFielders: historicalFieldersData || [],
      })
      setRankingsLoading(false)
    }

    loadRankingsData()

    const channel = supabase
      .channel(`season-home-rankings-${currentSeason.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_roster', filter: `season_id=eq.${currentSeason.id}` }, loadRankingsData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_plate_appearances', filter: `season_id=eq.${currentSeason.id}` }, loadRankingsData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitching_stints', filter: `season_id=eq.${currentSeason.id}` }, loadRankingsData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_game_fielders', filter: `season_id=eq.${currentSeason.id}` }, loadRankingsData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_teams', filter: `season_id=eq.${currentSeason.id}` }, loadRankingsData)
      .subscribe()

    return () => {
      isActive = false
      supabase.removeChannel(channel)
    }
  }, [currentSeason?.id])

  const powerRankings = useMemo(() => buildSeasonPowerRankings({
    seasonTeams,
    standings,
    roster: rankingData.roster,
    characters: rankingData.characters,
    plateAppearances: rankingData.plateAppearances,
    pitchingStints: rankingData.pitchingStints,
    gameFielders: rankingData.gameFielders,
    historicalPlateAppearances: rankingData.historicalPlateAppearances,
    historicalPitchingStints: rankingData.historicalPitchingStints,
    historicalGameFielders: rankingData.historicalGameFielders,
  }), [rankingData, seasonTeams, standings])

  if (!currentSeason) {
    return (
      <div className="page-stack">
        <section className="panel">
          <p className="muted">No season created yet.</p>
        </section>
      </div>
    )
  }

  return (
    <CompetitionOverviewTables
      standings={standings}
      powerRankings={powerRankings}
      rankingsLoading={rankingsLoading}
      rankingsError={rankingsError}
      identitiesByPlayerId={identitiesByPlayerId}
      playersById={playersById}
      viewerPlayerId={player?.id || null}
    />
  )
}
