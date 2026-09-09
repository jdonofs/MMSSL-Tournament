import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import { useTournament } from '../context/TournamentContext'
import { GameSessionProvider } from '../context/GameSessionContext'
import { DEFAULT_REGULATION_INNINGS, normalizeRegulationInnings } from '../utils/gameRules'

const TOURNAMENT_TEAM_IDENTITY_MAP = new Proxy(Object.create(null), {
  get: (_target, key) => {
    if (typeof key !== 'string') return undefined
    const numeric = Number(key)
    return Number.isFinite(numeric) ? numeric : undefined
  },
})

const TOURNAMENT_TABLES = {
  games: 'games',
  lineups: 'lineups',
  draftPicks: 'draft_picks',
  plateAppearances: 'plate_appearances',
  pitchingStints: 'pitching_stints',
  pitches: 'pitches',
  gameFielders: 'game_fielders',
  runsScored: 'runs_scored',
  inningScores: 'inning_scores',
  bets: 'bets',
  bettingLedger: 'points_ledger',
  gameOdds: 'game_odds',
  settlements: 'game_settlements',
  stadiumGameLog: 'stadium_game_log',
  trackerLiveStats: 'tracker_live_stats',
}

export default function TournamentGameSessionProvider({ children }) {
  const [searchParams] = useSearchParams()
  const { viewedTournament, currentTournament } = useTournament()
  const tournament = viewedTournament || currentTournament
  const gameId = Number(searchParams.get('game') || 0)

  const value = useMemo(() => ({
    gameId,
    innings: normalizeRegulationInnings(tournament?.innings, DEFAULT_REGULATION_INNINGS),
    mercyRule: tournament?.mercy_rule !== false,
    sourceType: 'tournament',
    sourceId: tournament?.id || null,
    tables: TOURNAMENT_TABLES,
    // Tournament "teams" are just the owning players, so the scorebook still needs an
    // identity mapping here. Without it, live tournament PAs save batting/defensive team
    // ids as null, which breaks downstream fielding + pitching-context recovery.
    teamIdByPlayerId: TOURNAMENT_TEAM_IDENTITY_MAP,
    playerIdByTeamId: TOURNAMENT_TEAM_IDENTITY_MAP,
    async loadScorebookData() {
      const [
        { data: gamesData, error: gamesError }, { data: playersData, error: playersError }, { data: lineupsData, error: lineupsError },
        { data: charsData, error: charsError }, { data: picksData, error: picksError }, { data: pasData, error: pasError }, { data: pitchData, error: pitchingError },
        pitchRowsResult, { data: fieldersData, error: fieldersError }, { data: runsData, error: runsError }, { data: inningScoresData, error: inningScoresError },
        { data: stadiumsData }, { data: stadiumLogData }, { data: savedTeamLineupsData },
      ] = await Promise.all([
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.games).select('*')),
        fetchAllRows(() => supabase.from('players').select('*')),
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.lineups).select('*').order('batting_order')),
        fetchAllRows(() => supabase.from('characters').select('*')),
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.draftPicks).select('*')),
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.plateAppearances).select('*').order('created_at')),
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.pitchingStints).select('*').order('created_at')),
        // Only the selected game's pitch log is used by Scorebook, so this stays
        // game-scoped; fetchAllRows still guards a marathon game's pitch count.
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.pitches).select('*').eq('game_id', gameId).order('created_at')),
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.gameFielders).select('*').order('created_at')),
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.runsScored).select('*').order('created_at')),
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.inningScores).select('*').order('inning')),
        fetchAllRows(() => supabase.from('stadiums').select('*')),
        fetchAllRows(() => supabase.from(TOURNAMENT_TABLES.stadiumGameLog).select('*').order('created_at')),
        tournament?.id
          ? supabase.from('team_lineups').select('player_id, lineup_order, fielding_positions').eq('tournament_id', tournament.id)
          : Promise.resolve({ data: [], error: null }),
      ])

      return {
        games: gamesData || [],
        players: playersData || [],
        lineups: lineupsData || [],
        characters: charsData || [],
        draftPicks: picksData || [],
        plateAppearances: pasData || [],
        pitchingStints: pitchData || [],
        pitches: pitchRowsResult.error ? null : (pitchRowsResult.data || []),
        pitchLoadError: pitchRowsResult.error || null,
        loadError: gamesError
          || playersError
          || lineupsError
          || charsError
          || picksError
          || pasError
          || pitchingError
          || pitchRowsResult.error
          || fieldersError
          || runsError
          || inningScoresError
          || null,
        gameFielders: fieldersData || [],
        runsScored: runsData || [],
        inningScores: inningScoresData || [],
        stadiums: stadiumsData || [],
        stadiumGameLog: stadiumLogData || [],
        savedTeamLineups: savedTeamLineupsData || [],
      }
    },
    getRoster: async () => [],
    getLineupKey: (playerId) => `roster-lineup-${tournament?.id}-${playerId}`,
    onGameComplete: async () => {},
  }), [gameId, tournament?.id, tournament?.innings, tournament?.mercy_rule])

  return <GameSessionProvider value={value}>{children}</GameSessionProvider>
}
