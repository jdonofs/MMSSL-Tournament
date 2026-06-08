import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { GameSessionProvider } from '../context/GameSessionContext'
import { useSeason } from '../context/SeasonContext'

const SEASON_TABLES = {
  games: 'season_schedule',
  lineups: 'season_lineups',
  draftPicks: 'season_roster',
  plateAppearances: 'season_plate_appearances',
  pitchingStints: 'season_pitching_stints',
  pitches: 'season_pitches',
  gameFielders: 'season_game_fielders',
  runsScored: 'season_runs_scored',
  inningScores: 'season_inning_scores',
  bets: 'season_bets',
  bettingLedger: 'season_betting_ledger',
  gameOdds: 'season_game_odds',
  settlements: 'season_game_settlements',
  stadiumGameLog: 'season_stadium_game_log',
}

export default function SeasonGameSessionProvider({ children }) {
  const [searchParams] = useSearchParams()
  const { currentSeason, refreshSeasons, seasonTeams } = useSeason()
  const gameId = Number(searchParams.get('game') || 0)
  const teamIdByPlayerId = useMemo(
    () => Object.fromEntries((seasonTeams || []).map((entry) => [entry.player_id, entry.id])),
    [seasonTeams],
  )
  const playerIdByTeamId = useMemo(
    () => Object.fromEntries((seasonTeams || []).map((entry) => [entry.id, entry.player_id])),
    [seasonTeams],
  )

  const value = useMemo(() => ({
    gameId,
    innings: currentSeason?.innings ?? 3,
    mercyRule: currentSeason?.mercy_rule !== false,
    sourceType: 'season',
    sourceId: currentSeason?.id || null,
    tables: SEASON_TABLES,
    async loadScorebookData() {
      if (!currentSeason?.id) {
        return {
          games: [],
          players: [],
          lineups: [],
          characters: [],
          draftPicks: [],
          plateAppearances: [],
          pitchingStints: [],
          pitches: [],
          gameFielders: [],
          runsScored: [],
          inningScores: [],
          stadiums: [],
          stadiumGameLog: [],
        }
      }

      const [
        { data: seasonGamesData },
        { data: playersData },
        { data: lineupsData },
        { data: charsData },
        { data: rosterData },
        { data: pasData },
        { data: pitchingData },
        { data: pitchRowsData },
        { data: fieldersData },
        { data: runsData },
        { data: inningScoresData },
        { data: teamsData },
        { data: stadiumsData },
        { data: stadiumLogData },
      ] = await Promise.all([
        supabase.from(SEASON_TABLES.games).select('*').eq('season_id', currentSeason.id).order('round_number').order('id'),
        supabase.from('players').select('*'),
        supabase.from(SEASON_TABLES.lineups).select('*').eq('season_id', currentSeason.id).order('batting_order'),
        supabase.from('characters').select('*'),
        supabase.from(SEASON_TABLES.draftPicks).select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from(SEASON_TABLES.plateAppearances).select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from(SEASON_TABLES.pitchingStints).select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from(SEASON_TABLES.pitches).select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from(SEASON_TABLES.gameFielders).select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from(SEASON_TABLES.runsScored).select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from(SEASON_TABLES.inningScores).select('*').eq('season_id', currentSeason.id).order('inning'),
        supabase.from('season_teams').select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from('stadiums').select('*'),
        supabase.from(SEASON_TABLES.stadiumGameLog).select('*').eq('season_id', currentSeason.id).order('created_at'),
      ])

      const charactersByName = Object.fromEntries((charsData || []).map((entry) => [entry.name, entry]))
      const teamsById = Object.fromEntries((teamsData || []).map((entry) => [entry.id, entry]))
      const playerIdByTeamId = Object.fromEntries((teamsData || []).map((entry) => [entry.id, entry.player_id]))
      const teamIdByPlayerId = Object.fromEntries((teamsData || []).map((entry) => [entry.player_id, entry.id]))
      const stadiumByName = Object.fromEntries((stadiumsData || []).map((entry) => [entry.name, entry]))

      const normalizedGames = (seasonGamesData || []).map((game) => ({
        ...game,
        source_id: game.season_id,
        tournament_id: game.season_id,
        stadium_id: stadiumByName[game.stadium]?.id || null,
        game_code: game.stage ? `S${game.season_id}-${game.stage}` : `R${game.round_number}-G${game.id}`,
        team_a_player_id: playerIdByTeamId[game.away_team_id] || null,
        team_b_player_id: playerIdByTeamId[game.home_team_id] || null,
        winner_player_id: playerIdByTeamId[game.winner_team_id] || null,
        team_a_runs: Number(game.away_score || 0),
        team_b_runs: Number(game.home_score || 0),
        status: game.status === 'completed' ? 'complete' : game.status === 'in_progress' ? 'active' : game.status === 'scheduled' ? 'pending' : game.status,
      }))

      const normalizedRoster = (rosterData || []).map((entry) => ({
        ...entry,
        tournament_id: entry.season_id,
        player_id: teamsById[entry.team_id]?.player_id || null,
        character_id: charactersByName[entry.character_name]?.id || null,
      }))

      const normalizedFielders = (fieldersData || []).map((entry) => ({
        ...entry,
        player_name: entry.player_name || teamsById[entry.team_id]?.team_name || '',
      }))

      return {
        games: normalizedGames,
        players: playersData || [],
        lineups: lineupsData || [],
        characters: charsData || [],
        draftPicks: normalizedRoster,
        plateAppearances: pasData || [],
        pitchingStints: pitchingData || [],
        pitches: pitchRowsData || [],
        gameFielders: normalizedFielders,
        runsScored: runsData || [],
        inningScores: (inningScoresData || []).map((entry) => ({
          ...entry,
          player_id: playerIdByTeamId[entry.team_id] || null,
        })),
        stadiums: stadiumsData || [],
        stadiumGameLog: (stadiumLogData || []).map((entry) => ({
          ...entry,
          stadium_id: stadiumByName[entry.stadium]?.id || null,
        })),
      }
    },
    teamIdByPlayerId,
    playerIdByTeamId,
    async getRoster(playerId) {
      if (!currentSeason?.id || !playerId) return []
      const { data: teamsData } = await supabase.from('season_teams').select('*').eq('season_id', currentSeason.id)
      const team = (teamsData || []).find((entry) => String(entry.player_id) === String(playerId))
      if (!team) return []
      const { data: rosterData } = await supabase
        .from(SEASON_TABLES.draftPicks)
        .select('*')
        .eq('season_id', currentSeason.id)
        .eq('team_id', team.id)
        .eq('is_active', true)
        .order('created_at')
      return rosterData || []
    },
    getLineupKey: (playerId) => `season-lineup-${currentSeason?.id}-${playerId}`,
    async onGameComplete({ selectedGame, scores }) {
      if (!selectedGame || !currentSeason?.id) return

      const winnerTeamId =
        scores.a === scores.b
          ? null
          : scores.a > scores.b
            ? selectedGame.away_team_id
            : selectedGame.home_team_id

      const { error } = await supabase
        .from(SEASON_TABLES.games)
        .update({
          status: 'completed',
          winner_team_id: winnerTeamId,
          away_score: scores.a,
          home_score: scores.b,
        })
        .eq('id', selectedGame.id)

      if (error) throw error

      const { data: allGames } = await supabase.from(SEASON_TABLES.games).select('*').eq('season_id', currentSeason.id)
      const { data: allTeams } = await supabase.from('season_teams').select('*').eq('season_id', currentSeason.id)

      const nextTeams = (allTeams || []).map((team) => {
        const teamGames = (allGames || []).filter((game) => game.home_team_id === team.id || game.away_team_id === team.id)
        let wins = 0
        let losses = 0
        let runDiff = 0
        let homeWins = 0
        let homeLosses = 0
        let awayWins = 0
        let awayLosses = 0

        teamGames.forEach((game) => {
          if (game.status !== 'completed') return
          const isHome = game.home_team_id === team.id
          const scored = Number(isHome ? game.home_score : game.away_score || 0)
          const allowed = Number(isHome ? game.away_score : game.home_score || 0)
          runDiff += scored - allowed
          if (game.winner_team_id === team.id) {
            wins += 1
            if (isHome) homeWins += 1
            else awayWins += 1
          } else if (game.winner_team_id) {
            losses += 1
            if (isHome) homeLosses += 1
            else awayLosses += 1
          }
        })

        return {
          ...team,
          wins,
          losses,
          run_differential: runDiff,
          home_wins: homeWins,
          home_losses: homeLosses,
          away_wins: awayWins,
          away_losses: awayLosses,
        }
      })

      await Promise.all(nextTeams.map((team) => (
        supabase
          .from('season_teams')
          .update({
            wins: team.wins,
            losses: team.losses,
            run_differential: team.run_differential,
            home_wins: team.home_wins,
            home_losses: team.home_losses,
            away_wins: team.away_wins,
            away_losses: team.away_losses,
          })
          .eq('id', team.id)
      )))

      const allRegularSeasonComplete = (allGames || [])
        .filter((game) => !game.stage)
        .every((game) => game.status === 'completed')

      if (allRegularSeasonComplete) {
        await supabase.from('seasons').update({ status: 'playoffs' }).eq('id', currentSeason.id)
      }

      await refreshSeasons(currentSeason.id)
    },
  }), [gameId, currentSeason?.id, currentSeason?.innings, currentSeason?.mercy_rule, refreshSeasons, teamIdByPlayerId, playerIdByTeamId])

  return <GameSessionProvider value={value}>{children}</GameSessionProvider>
}
