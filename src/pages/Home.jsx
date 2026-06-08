import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import CompetitionOverviewTables from '../components/CompetitionOverviewTables'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import { buildTournamentStandings } from '../utils/competitionStandings'
import { buildSeasonPowerRankings } from '../utils/seasonPowerRankings'
import { getTeamShortName } from '../utils/teamIdentity'
import { importTournamentOneWorkbook } from '../utils/dataImport.jsx'

function emptyRankingData() {
  return {
    roster: [],
    characters: [],
    plateAppearances: [],
    pitchingStints: [],
    gameFielders: [],
    historicalPlateAppearances: [],
    historicalPitchingStints: [],
    historicalGameFielders: [],
  }
}

export default function Home() {
  const { player } = useAuth()
  const { pushToast } = useToast()
  const { currentTournament, refreshTournaments } = useTournament()
  const { identitiesByPlayerId } = useTournamentTeamIdentity(currentTournament?.id)
  const [players, setPlayers] = useState([])
  const [allGames, setAllGames] = useState([])
  const [rankingData, setRankingData] = useState(emptyRankingData)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [rankingsLoading, setRankingsLoading] = useState(false)
  const [rankingsError, setRankingsError] = useState('')

  useEffect(() => {
    const loadHome = async () => {
      setLoading(true)
      const [{ data: playersData, error: playersError }, { data: gamesData, error: gamesError }] =
        await Promise.all([
          supabase.from('players').select('*').order('name'),
          supabase.from('games').select('*').order('id')
        ])

      const firstError = playersError || gamesError
      if (firstError) {
        pushToast({
          title: 'Unable to load home page',
          message: firstError.message,
          type: 'error'
        })
      } else {
        setPlayers(playersData || [])
        setAllGames(gamesData || [])
      }
      setLoading(false)
    }

    loadHome()
  }, [pushToast])

  useEffect(() => {
    if (!currentTournament?.id) return undefined

    const channel = supabase
      .channel(`home-tournament-${currentTournament.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `tournament_id=eq.${currentTournament.id}` }, async (payload) => {
        setAllGames((current) => {
          const next = [...current]
          const index = next.findIndex((game) => game.id === payload.new?.id || game.id === payload.old?.id)
          if (payload.eventType === 'INSERT' && payload.new) return [...next, payload.new]
          if (payload.eventType === 'UPDATE' && payload.new && index >= 0) {
            next[index] = payload.new
            return next
          }
          if (payload.eventType === 'DELETE' && payload.old && index >= 0) {
            next.splice(index, 1)
            return next
          }
          return next
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, async () => {
        const { data } = await supabase.from('players').select('*').order('name')
        setPlayers(data || [])
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [currentTournament?.id])

  useEffect(() => {
    if (!currentTournament?.id) {
      setRankingData(emptyRankingData())
      setRankingsLoading(false)
      setRankingsError('')
      return undefined
    }

    let isActive = true

    const loadRankingData = async () => {
      if (isActive) {
        setRankingsLoading(true)
        setRankingsError('')
      }

      const [
        { data: draftPicksData, error: draftPicksError },
        { data: charactersData, error: charactersError },
        { data: gamesData, error: gamesError },
        { data: paData, error: paError },
        { data: pitchingData, error: pitchingError },
        { data: fieldersData, error: fieldersError },
      ] = await Promise.all([
        supabase.from('draft_picks').select('*').eq('tournament_id', currentTournament.id).order('pick_number'),
        supabase.from('characters').select('*').order('name'),
        supabase.from('games').select('id,tournament_id').order('id'),
        supabase.from('plate_appearances').select('*').order('created_at'),
        supabase.from('pitching_stints').select('*').order('created_at'),
        supabase.from('game_fielders').select('*').order('created_at'),
      ])

      const error = draftPicksError || charactersError || gamesError || paError || pitchingError || fieldersError
      if (!isActive) return

      if (error) {
        setRankingsError(error.message || 'Unable to load power rankings.')
        setRankingsLoading(false)
        return
      }

      const currentGameIds = new Set((gamesData || []).filter((game) => String(game.tournament_id) === String(currentTournament.id)).map((game) => String(game.id)))
      const currentPlateAppearances = (paData || []).filter((pa) => currentGameIds.has(String(pa.game_id)))
      const currentPitchingStints = (pitchingData || []).filter((stint) => currentGameIds.has(String(stint.game_id)))
      const currentFielders = (fieldersData || []).filter((fielder) => currentGameIds.has(String(fielder.game_id)))
      const charactersById = Object.fromEntries((charactersData || []).map((character) => [character.id, character]))

      setRankingData({
        roster: (draftPicksData || [])
          .filter((entry) => entry.character_id)
          .map((entry) => ({
            ...entry,
            team_id: entry.player_id,
            character_name: charactersById[entry.character_id]?.name || '',
            is_active: true,
          })),
        characters: charactersData || [],
        plateAppearances: currentPlateAppearances,
        pitchingStints: currentPitchingStints,
        gameFielders: currentFielders,
        historicalPlateAppearances: (paData || []).filter((pa) => !currentGameIds.has(String(pa.game_id))),
        historicalPitchingStints: (pitchingData || []).filter((stint) => !currentGameIds.has(String(stint.game_id))),
        historicalGameFielders: (fieldersData || []).filter((fielder) => !currentGameIds.has(String(fielder.game_id))),
      })
      setRankingsLoading(false)
    }

    loadRankingData()

    const channel = supabase
      .channel(`home-rankings-${currentTournament.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks', filter: `tournament_id=eq.${currentTournament.id}` }, loadRankingData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `tournament_id=eq.${currentTournament.id}` }, loadRankingData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, loadRankingData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, loadRankingData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_fielders' }, loadRankingData)
      .subscribe()

    return () => {
      isActive = false
      supabase.removeChannel(channel)
    }
  }, [currentTournament?.id])

  const games = useMemo(
    () => allGames.filter((game) => !currentTournament || String(game.tournament_id) === String(currentTournament.id)),
    [allGames, currentTournament],
  )

  const tournamentPlayerIds = useMemo(() => {
    const ids = new Set((currentTournament?.player_ids || []).map((id) => String(id)))
    games.forEach((game) => {
      if (game.team_a_player_id) ids.add(String(game.team_a_player_id))
      if (game.team_b_player_id) ids.add(String(game.team_b_player_id))
    })
    rankingData.roster.forEach((entry) => {
      if (entry.player_id) ids.add(String(entry.player_id))
    })
    return ids
  }, [currentTournament?.player_ids, games, rankingData.roster])

  const tournamentPlayers = useMemo(
    () => players.filter((player) => tournamentPlayerIds.has(String(player.id))),
    [players, tournamentPlayerIds],
  )

  const playersById = useMemo(
    () => Object.fromEntries(tournamentPlayers.map((player) => [player.id, player])),
    [tournamentPlayers],
  )

  const tournamentTeams = useMemo(
    () => tournamentPlayers.map((player) => ({
      id: player.id,
      player_id: player.id,
      team_name: getTeamShortName(identitiesByPlayerId[player.id]) || identitiesByPlayerId[player.id]?.teamName || player.name,
      team_logo_key: identitiesByPlayerId[player.id]?.teamLogoKey || null,
    })),
    [identitiesByPlayerId, tournamentPlayers],
  )

  const standings = useMemo(
    () => buildTournamentStandings(games, tournamentPlayers, identitiesByPlayerId),
    [games, tournamentPlayers, identitiesByPlayerId],
  )

  const powerRankings = useMemo(() => buildSeasonPowerRankings({
    seasonTeams: tournamentTeams,
    standings,
    roster: rankingData.roster,
    characters: rankingData.characters,
    plateAppearances: rankingData.plateAppearances,
    pitchingStints: rankingData.pitchingStints,
    gameFielders: rankingData.gameFielders,
    historicalPlateAppearances: rankingData.historicalPlateAppearances,
    historicalPitchingStints: rankingData.historicalPitchingStints,
    historicalGameFielders: rankingData.historicalGameFielders,
  }), [tournamentTeams, standings, rankingData])

  const handleImportTournamentOne = async () => {
    if (!player?.is_commissioner) {
      pushToast({
        title: 'Not authorized',
        message: 'Only commissioners can import historical tournament data.',
        type: 'error',
      })
      return
    }
    setImporting(true)
    try {
      const tournament = await importTournamentOneWorkbook()
      await refreshTournaments(tournament.id)
      const { data: refreshedGames } = await supabase.from('games').select('*').order('id')
      setAllGames(refreshedGames || [])
      pushToast({
        title: 'Tournament 1 imported',
        message: 'Historical draft, bracket, lineups, batting, and pitching data are now available.',
        type: 'success'
      })
    } catch (importError) {
      pushToast({
        title: 'Import failed',
        message: importError.message,
        type: 'error'
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="page-stack">
      <div className="page-head">
        <div className="inline-actions">
          <button className="ghost-button" disabled={importing || !player?.is_commissioner} onClick={handleImportTournamentOne} type="button">
            <Download size={16} />
            {importing ? 'Importing...' : 'Import Tournament 1'}
          </button>
          <div className="player-pill">
            <span>Status</span>
            <strong>{currentTournament?.status || 'pending'}</strong>
          </div>
        </div>
      </div>

      {!currentTournament ? (
        <section className="panel">
          <h2>No tournament history yet</h2>
          <p className="muted">Use the import button above to load Tournament 1 from the workbook data and unlock historical browsing across the app.</p>
        </section>
      ) : (
        <CompetitionOverviewTables
          standings={standings}
          powerRankings={powerRankings}
          rankingsLoading={rankingsLoading}
          rankingsError={rankingsError}
          identitiesByPlayerId={identitiesByPlayerId}
          playersById={playersById}
        />
      )}
    </div>
  )
}
