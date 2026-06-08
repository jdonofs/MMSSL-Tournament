import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useTournament } from '../context/TournamentContext'
import { GameSessionProvider } from '../context/GameSessionContext'

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
}

export default function TournamentGameSessionProvider({ children }) {
  const [searchParams] = useSearchParams()
  const { viewedTournament, currentTournament } = useTournament()
  const tournament = viewedTournament || currentTournament
  const gameId = Number(searchParams.get('game') || 0)

  const value = useMemo(() => ({
    gameId,
    innings: tournament?.innings ?? 3,
    mercyRule: tournament?.mercy_rule !== false,
    sourceType: 'tournament',
    sourceId: tournament?.id || null,
    tables: TOURNAMENT_TABLES,
    teamIdByPlayerId: {},
    playerIdByTeamId: {},
    async loadScorebookData() {
      const [
        { data: gamesData }, { data: playersData }, { data: lineupsData },
        { data: charsData }, { data: picksData }, { data: pasData }, { data: pitchData },
        { data: pitchRowsData }, { data: fieldersData }, { data: runsData }, { data: inningScoresData },
        { data: stadiumsData }, { data: stadiumLogData },
      ] = await Promise.all([
        supabase.from(TOURNAMENT_TABLES.games).select('*').order('id'),
        supabase.from('players').select('*'),
        supabase.from(TOURNAMENT_TABLES.lineups).select('*').order('batting_order'),
        supabase.from('characters').select('*'),
        supabase.from(TOURNAMENT_TABLES.draftPicks).select('*'),
        supabase.from(TOURNAMENT_TABLES.plateAppearances).select('*').order('created_at'),
        supabase.from(TOURNAMENT_TABLES.pitchingStints).select('*').order('created_at'),
        supabase.from(TOURNAMENT_TABLES.pitches).select('*').order('created_at'),
        supabase.from(TOURNAMENT_TABLES.gameFielders).select('*').order('created_at'),
        supabase.from(TOURNAMENT_TABLES.runsScored).select('*').order('created_at'),
        supabase.from(TOURNAMENT_TABLES.inningScores).select('*').order('inning'),
        supabase.from('stadiums').select('*'),
        supabase.from(TOURNAMENT_TABLES.stadiumGameLog).select('*').order('created_at'),
      ])

      return {
        games: gamesData || [],
        players: playersData || [],
        lineups: lineupsData || [],
        characters: charsData || [],
        draftPicks: picksData || [],
        plateAppearances: pasData || [],
        pitchingStints: pitchData || [],
        pitches: pitchRowsData || [],
        gameFielders: fieldersData || [],
        runsScored: runsData || [],
        inningScores: inningScoresData || [],
        stadiums: stadiumsData || [],
        stadiumGameLog: stadiumLogData || [],
      }
    },
    getRoster: async () => [],
    getLineupKey: (playerId) => `roster-lineup-${tournament?.id}-${playerId}`,
    onGameComplete: async () => {},
  }), [gameId, tournament?.id, tournament?.innings, tournament?.mercy_rule])

  return <GameSessionProvider value={value}>{children}</GameSessionProvider>
}
