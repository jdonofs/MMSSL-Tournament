import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import { GameSessionProvider } from '../context/GameSessionContext'
import { useSeason } from '../context/SeasonContext'
import {
  DEFAULT_MERCY_RULE_DIFFERENTIAL,
  DEFAULT_REGULATION_INNINGS,
  normalizeMercyRuleDifferential,
  normalizeRegulationInnings,
} from '../utils/gameRules'
import { resolveSeasonScorebookGameId } from '../utils/seasonPlayoffs'

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
  trackerLiveStats: 'season_tracker_live_stats',
}

export default function SeasonGameSessionProvider({ children }) {
  const [searchParams] = useSearchParams()
  const { currentSeason, refreshSeasons, schedule, seasonTeams } = useSeason()
  const requestedGameId = Number(searchParams.get('game') || 0)
  const requestedScheduleGame = useMemo(
    () => (schedule || []).find((entry) => Number(entry.id) === requestedGameId) || null,
    [requestedGameId, schedule],
  )
  const gameId = resolveSeasonScorebookGameId({
    requestedGameId,
    schedule,
    playoffFormat: currentSeason?.playoff_format,
    teamCount: seasonTeams.length,
    seasonStatus: currentSeason?.status,
  })
  const selectedScheduleGame = gameId ? requestedScheduleGame : null
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
    innings: normalizeRegulationInnings(
      selectedScheduleGame?.innings ?? currentSeason?.innings,
      DEFAULT_REGULATION_INNINGS,
    ),
    mercyRule: (selectedScheduleGame?.mercy_rule ?? currentSeason?.mercy_rule) === true,
    mercyRuleDifferential: normalizeMercyRuleDifferential(
      selectedScheduleGame?.mercy_rule_differential ?? currentSeason?.mercy_rule_differential,
      DEFAULT_MERCY_RULE_DIFFERENTIAL,
    ),
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
          savedTeamLineups: [],
        }
      }

      const [
        { data: seasonGamesData, error: seasonGamesError },
        { data: playersData, error: playersError },
        { data: lineupsData, error: lineupsError },
        { data: charsData, error: charsError },
        { data: rosterData, error: rosterError },
        { data: pasData, error: pasError },
        { data: pitchingData, error: pitchingError },
        pitchRowsResult,
        { data: fieldersData, error: fieldersError },
        { data: runsData, error: runsError },
        { data: inningScoresData, error: inningScoresError },
        { data: teamsData, error: teamsError },
        { data: stadiumsData },
        { data: stadiumLogData },
        { data: savedTeamLineupsData },
      ] = await Promise.all([
        fetchAllRows(() => supabase.from(SEASON_TABLES.games).select('*').eq('season_id', currentSeason.id).order('round_number')),
        fetchAllRows(() => supabase.from('players').select('*')),
        fetchAllRows(() => supabase.from(SEASON_TABLES.lineups).select('*').eq('season_id', currentSeason.id).order('batting_order')),
        fetchAllRows(() => supabase.from('characters').select('*')),
        fetchAllRows(() => supabase.from(SEASON_TABLES.draftPicks).select('*').eq('season_id', currentSeason.id).order('created_at')),
        fetchAllRows(() => supabase.from(SEASON_TABLES.plateAppearances).select('*').eq('season_id', currentSeason.id).order('created_at')),
        fetchAllRows(() => supabase.from(SEASON_TABLES.pitchingStints).select('*').eq('season_id', currentSeason.id).order('created_at')),
        // Scorebook only consumes pitch rows for the selected game, so this one
        // stays game-scoped — but it still goes through fetchAllRows in case a
        // marathon game somehow produces more than a page of pitches.
        fetchAllRows(() => supabase.from(SEASON_TABLES.pitches).select('*').eq('game_id', gameId).order('created_at')),
        fetchAllRows(() => supabase.from(SEASON_TABLES.gameFielders).select('*').eq('season_id', currentSeason.id).order('created_at')),
        fetchAllRows(() => supabase.from(SEASON_TABLES.runsScored).select('*').eq('season_id', currentSeason.id).order('created_at')),
        fetchAllRows(() => supabase.from(SEASON_TABLES.inningScores).select('*').eq('season_id', currentSeason.id).order('inning')),
        fetchAllRows(() => supabase.from('season_teams').select('*').eq('season_id', currentSeason.id).order('created_at')),
        fetchAllRows(() => supabase.from('stadiums').select('*')),
        fetchAllRows(() => supabase.from(SEASON_TABLES.stadiumGameLog).select('*').eq('season_id', currentSeason.id).order('created_at')),
        supabase.from('season_team_lineups').select('player_id, lineup_order, fielding_positions').eq('season_id', currentSeason.id),
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
        pitches: pitchRowsResult.error ? null : (pitchRowsResult.data || []),
        pitchLoadError: pitchRowsResult.error || null,
        loadError: seasonGamesError
          || playersError
          || lineupsError
          || charsError
          || rosterError
          || pasError
          || pitchingError
          || pitchRowsResult.error
          || fieldersError
          || runsError
          || inningScoresError
          || teamsError
          || null,
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
        savedTeamLineups: savedTeamLineupsData || [],
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
    // Standings and playoff advancement are done by the scorebook's lifecycle
    // module from the game row's own season_id (not whichever season is
    // selected here). This only brings the season context up to date after.
    async onLifecycleSettled() {
      if (!currentSeason?.id) return
      await refreshSeasons(currentSeason.id).catch(() => {})
    },
  }), [
    gameId,
    currentSeason?.id,
    currentSeason?.status,
    currentSeason?.playoff_format,
    currentSeason?.innings,
    currentSeason?.mercy_rule,
    currentSeason?.mercy_rule_differential,
    refreshSeasons,
    selectedScheduleGame?.innings,
    selectedScheduleGame?.mercy_rule,
    selectedScheduleGame?.mercy_rule_differential,
    teamIdByPlayerId,
    playerIdByTeamId,
  ])

  return <GameSessionProvider value={value}>{children}</GameSessionProvider>
}
