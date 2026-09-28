import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import { readCachedResult, invalidateCachedResult } from '../utils/asyncResultCache'
import { createRefreshCoordinator } from '../utils/refreshCoordinator'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import CompetitionOverviewTables from '../components/CompetitionOverviewTables'
import { buildSeasonPowerRankings } from '../utils/seasonPowerRankings'
import { buildSeasonTeamIdentity } from '../utils/teamIdentity'

export default function SeasonHome() {
  const { player } = useAuth()
  const { currentSeason, standings, seasonPlayersById, seasonTeams, allSeasons } = useSeason()
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
    const historyCachePrefix = `season-power-history:${allSeasons.map((season) => season.id).sort().join(',')}:${currentSeason.id}`

    const loadRankingsData = async () => {
      if (isActive) {
        setRankingsLoading(true)
        setRankingsError('')
      }

      const otherSeasonIds = allSeasons
        .map((season) => season.id)
        .filter((id) => String(id) !== String(currentSeason.id))

      const [
        { data: rosterData, error: rosterError },
        { data: charactersData, error: charactersError },
        { data: paData, error: paError },
        { data: pitchingData, error: pitchingError },
        { data: fieldersData, error: fieldersError },
        { data: historicalPaData, error: historicalPaError },
        { data: historicalPitchingData, error: historicalPitchingError },
        { data: historicalFieldersData, error: historicalFieldersError },
        { data: pastSeasonsPaData, error: pastSeasonsPaError },
        { data: pastSeasonsPitchingData, error: pastSeasonsPitchingError },
        { data: pastSeasonsFieldersData, error: pastSeasonsFieldersError },
        { data: seasonPitchesData, error: seasonPitchesError },
        { data: tournamentPitchesData, error: tournamentPitchesError },
      ] = await Promise.all([
        fetchAllRows(() => supabase.from('season_roster').select('*').eq('season_id', currentSeason.id).order('created_at')),
        fetchAllRows(() => supabase.from('characters').select('*').order('name')),
        fetchAllRows(() => supabase.from('season_plate_appearances').select('*').eq('season_id', currentSeason.id).order('created_at')),
        fetchAllRows(() => supabase.from('season_pitching_stints').select('*').eq('season_id', currentSeason.id).order('created_at')),
        fetchAllRows(() => supabase.from('season_game_fielders').select('*').eq('season_id', currentSeason.id).order('created_at')),
        readCachedResult(`${historyCachePrefix}:tournament-pa`, () => fetchAllRows(() => supabase.from('plate_appearances').select('*').order('created_at'))),
        readCachedResult(`${historyCachePrefix}:tournament-pitching`, () => fetchAllRows(() => supabase.from('pitching_stints').select('*').order('created_at'))),
        readCachedResult(`${historyCachePrefix}:tournament-fielders`, () => fetchAllRows(() => supabase.from('game_fielders').select('*').order('created_at'))),
        // A GM's performance in seasons other than the one being viewed is part of their real
        // history too — not just their pre-season-era tournament stats. Without this, "history"
        // for a fresh season only reflects old tournament data and ignores how the GM actually
        // performed last season. Scoped to `otherSeasonIds` (seasons that still exist) rather than
        // just excluding the current season, so a deleted season's stats never resurface as history.
        otherSeasonIds.length
          ? readCachedResult(`${historyCachePrefix}:past-season-pa`, () => fetchAllRows(() => supabase.from('season_plate_appearances').select('*').in('season_id', otherSeasonIds).order('created_at')))
          : Promise.resolve({ data: [] }),
        otherSeasonIds.length
          ? readCachedResult(`${historyCachePrefix}:past-season-pitching`, () => fetchAllRows(() => supabase.from('season_pitching_stints').select('*').in('season_id', otherSeasonIds).order('created_at')))
          : Promise.resolve({ data: [] }),
        otherSeasonIds.length
          ? readCachedResult(`${historyCachePrefix}:past-season-fielders`, () => fetchAllRows(() => supabase.from('season_game_fielders').select('*').in('season_id', otherSeasonIds).order('created_at')))
          : Promise.resolve({ data: [] }),
        Promise.all([
          fetchAllRows(() => supabase.from('season_pitches').select('game_id,pitcher_id').eq('season_id', currentSeason.id)),
          otherSeasonIds.length
            ? readCachedResult(`${historyCachePrefix}:past-season-pitches`, () => fetchAllRows(() => supabase.from('season_pitches').select('game_id,pitcher_id').in('season_id', otherSeasonIds)))
            : Promise.resolve({ data: [], error: null }),
        ]).then(([current, past]) => (current.error || past.error
          ? { data: null, error: current.error || past.error }
          : { data: [...(current.data || []), ...(past.data || [])], error: null })),
        readCachedResult(`${historyCachePrefix}:tournament-pitches`, () => fetchAllRows(() => supabase.from('pitches').select('game_id,pitcher_id'))),
      ])

      const error = rosterError || charactersError || paError || pitchingError || fieldersError || historicalPaError || historicalPitchingError || historicalFieldersError || pastSeasonsPaError || pastSeasonsPitchingError || pastSeasonsFieldersError || seasonPitchesError || tournamentPitchesError
      if (!isActive) return

      if (error) {
        setRankingsError(error.message || 'Unable to load power rankings.')
        setRankingsLoading(false)
        return
      }

      // A pitching_stints row is created the moment a pitcher takes the mound (Scorebook's
      // mound-assignment bookkeeping), before they've necessarily thrown a pitch — drop stints
      // with no matching row in `pitches`/`season_pitches` (by game_id + pitcher name) before
      // ranking teams on them.
      const nameById = Object.fromEntries((charactersData || []).map((c) => [c.id, c.name]))
      const seasonThrownKeys = new Set((seasonPitchesData || []).map((p) => `${p.game_id}:${p.pitcher_id}`))
      const tournamentThrownKeys = new Set((tournamentPitchesData || []).map((p) => `${p.game_id}:${p.pitcher_id}`))

      setRankingData({
        roster: rosterData || [],
        characters: charactersData || [],
        plateAppearances: paData || [],
        pitchingStints: (pitchingData || []).filter((stint) => seasonThrownKeys.has(`${stint.game_id}:${nameById[stint.character_id]}`)),
        gameFielders: fieldersData || [],
        historicalPlateAppearances: [...(historicalPaData || []), ...(pastSeasonsPaData || [])],
        historicalPitchingStints: [
          ...(historicalPitchingData || []).filter((stint) => tournamentThrownKeys.has(`${stint.game_id}:${nameById[stint.character_id]}`)),
          ...(pastSeasonsPitchingData || []).filter((stint) => seasonThrownKeys.has(`${stint.game_id}:${nameById[stint.character_id]}`)),
        ],
        historicalGameFielders: [...(historicalFieldersData || []), ...(pastSeasonsFieldersData || [])],
      })
      setRankingsLoading(false)
    }

    const refreshCoordinator = createRefreshCoordinator({
      run: loadRankingsData,
      delayMs: 500,
      maxWaitMs: 1500,
      isPaused: () => document.visibilityState === 'hidden',
    })
    const refresh = () => refreshCoordinator.request()
    const invalidateTournamentHistory = () => {
      ;['tournament-pa', 'tournament-pitching', 'tournament-fielders', 'tournament-pitches']
        .forEach((suffix) => invalidateCachedResult(`${historyCachePrefix}:${suffix}`))
      refresh()
    }
    const invalidateAllHistory = () => {
      ;['tournament-pa', 'tournament-pitching', 'tournament-fielders', 'tournament-pitches',
        'past-season-pa', 'past-season-pitching', 'past-season-fielders', 'past-season-pitches']
        .forEach((suffix) => invalidateCachedResult(`${historyCachePrefix}:${suffix}`))
      refreshCoordinator.request({ immediate: true })
    }
    refreshCoordinator.request({ immediate: true })
    let hasSubscribed = false

    const channel = supabase
      .channel(`season-home-rankings-${currentSeason.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_roster', filter: `season_id=eq.${currentSeason.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_plate_appearances', filter: `season_id=eq.${currentSeason.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_pitching_stints', filter: `season_id=eq.${currentSeason.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_game_fielders', filter: `season_id=eq.${currentSeason.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_teams', filter: `season_id=eq.${currentSeason.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, invalidateTournamentHistory)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, invalidateTournamentHistory)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_fielders' }, invalidateTournamentHistory)
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (hasSubscribed) invalidateAllHistory()
        hasSubscribed = true
      })
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') invalidateAllHistory()
    }
    const handleOnline = invalidateAllHistory
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnline)

    return () => {
      isActive = false
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
      refreshCoordinator.dispose()
      supabase.removeChannel(channel)
    }
  }, [currentSeason?.id, allSeasons.length])

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
      teamLinkBuilder={(playerId) => `/teams/${playerId}/season/${currentSeason.id}`}
    />
  )
}
