import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import { buildOddsGenerationContext } from '../src/utils/oddsContext.js'
import {
  buildBettingEntityLabel,
  buildOddsRowKey,
  generateGameOdds,
  mergeOddsWithExistingRows,
  recalculateOdds,
} from '../src/utils/oddsEngine.js'
import { persistOddsRowsWithFallback } from '../src/utils/oddsPersistence.js'
import { buildLiveMarketState } from '../src/utils/trackerLiveFeed.js'
import { resolveGameBets } from '../src/utils/betResolution.js'

const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const LIVE_ODDS_FIELDS = [
  'line',
  'odds_home', 'odds_away',
  'odds_over', 'odds_under',
  'odds_yes', 'odds_no',
  'predicted_probability',
  'prop_current_count', 'prop_lambda', 'prop_variance_multiplier',
  'is_locked',
]

function oddsValuesMatch(left = {}, right = {}) {
  return LIVE_ODDS_FIELDS.every((field) => (left[field] ?? null) === (right[field] ?? null))
}

function sourceConfig(sourceType) {
  return sourceType === 'season'
    ? {
        games: 'season_schedule', picks: 'season_roster', pas: 'season_plate_appearances',
        pitching: 'season_pitching_stints', odds: 'season_game_odds', bets: 'season_bets',
        stadiumLog: 'season_stadium_game_log', ledger: 'season_betting_ledger', runs: 'season_runs_scored',
        sourceField: 'season_id', wagerField: 'wager_dollars', payoutField: 'potential_payout_dollars',
        ledgerChangeField: 'dollars_change', gameOddsIdField: null,
      }
    : {
        games: 'games', picks: 'draft_picks', pas: 'plate_appearances', pitching: 'pitching_stints',
        odds: 'game_odds', bets: 'bets', stadiumLog: 'stadium_game_log', ledger: 'points_ledger',
        runs: 'runs_scored', sourceField: 'tournament_id', wagerField: 'wager_dollars',
        payoutField: 'potential_payout_dollars', ledgerChangeField: 'points_change', gameOddsIdField: 'game_odds_id',
      }
}

export function buildTrackerBetResolutionConfig({ supabase, sourceType, sourceId }) {
  const tables = sourceConfig(sourceType)
  return {
    supabaseClient: supabase,
    betsTable: tables.bets,
    gameOddsTable: tables.odds,
    ledgerTable: tables.ledger,
    plateAppearancesTable: tables.pas,
    runsScoredTable: tables.runs,
    wagerField: tables.wagerField,
    payoutField: tables.payoutField,
    ledgerChangeField: tables.ledgerChangeField,
    sourceIdField: tables.sourceField,
    sourceIdValue: sourceId,
    gameOddsIdField: tables.gameOddsIdField,
    enableCalibrationLogging: false,
    enableWeightAdjustment: false,
  }
}

function normalizeSeasonGame(game, teamsById, stadiumsByName) {
  return {
    ...game,
    tournament_id: game.season_id,
    team_a_player_id: teamsById[game.away_team_id]?.player_id || null,
    team_b_player_id: teamsById[game.home_team_id]?.player_id || null,
    winner_player_id: teamsById[game.winner_team_id]?.player_id || null,
    team_a_runs: Number(game.away_score || 0),
    team_b_runs: Number(game.home_score || 0),
    stadium_id: stadiumsByName[game.stadium]?.id || null,
    status: game.status === 'completed' ? 'complete' : game.status === 'in_progress' ? 'active' : game.status,
  }
}

function mergeLiveChanges(rows, changes) {
  const changesByKey = Object.fromEntries((changes || []).map((row) => [buildOddsRowKey(row), row]))
  return rows.map((row) => changesByKey[buildOddsRowKey(row)] || row)
}

async function loadTrackerBettingData({ supabase, sourceType, sourceId, gameId }) {
  const tables = sourceConfig(sourceType)
  const isSeason = sourceType === 'season'
  const [gamesResult, playersResult, charactersResult, stadiumsResult, teamsResult, picksResult] = await Promise.all([
    fetchAllRows(() => supabase.from(tables.games).select('*').eq(tables.sourceField, sourceId)),
    fetchAllRows(() => supabase.from('players').select('*')),
    fetchAllRows(() => supabase.from('characters').select('*')),
    fetchAllRows(() => supabase.from('stadiums').select('*')),
    isSeason ? fetchAllRows(() => supabase.from('season_teams').select('*').eq('season_id', sourceId)) : Promise.resolve({ data: [] }),
    fetchAllRows(() => supabase.from(tables.picks).select('*').eq(tables.sourceField, sourceId)),
  ])
  const firstError = gamesResult.error || playersResult.error || charactersResult.error || stadiumsResult.error || teamsResult.error || picksResult.error
  if (firstError) throw firstError

  const rawGames = gamesResult.data || []
  const gameIds = rawGames.map((game) => game.id)
  const [pasResult, pitchingResult, oddsResult, betsResult, stadiumLogResult, weightsResult] = await Promise.all([
    gameIds.length ? fetchAllRows(() => supabase.from(tables.pas).select('*').in('game_id', gameIds).order('created_at')) : Promise.resolve({ data: [] }),
    gameIds.length ? fetchAllRows(() => supabase.from(tables.pitching).select('*').in('game_id', gameIds).order('created_at')) : Promise.resolve({ data: [] }),
    fetchAllRows(() => supabase.from(tables.odds).select('*').eq('game_id', gameId)),
    fetchAllRows(() => supabase.from(tables.bets).select('*').eq(tables.sourceField, sourceId)),
    fetchAllRows(() => supabase.from(tables.stadiumLog).select('*')),
    supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle(),
  ])
  const secondError = pasResult.error || pitchingResult.error || oddsResult.error || betsResult.error || stadiumLogResult.error || weightsResult.error
  if (secondError) throw secondError

  const playersById = Object.fromEntries((playersResult.data || []).map((player) => [player.id, player]))
  const charactersById = Object.fromEntries((charactersResult.data || []).map((character) => [character.id, character]))
  const charactersByName = Object.fromEntries((charactersResult.data || []).map((character) => [character.name, character]))
  const stadiumsByName = Object.fromEntries((stadiumsResult.data || []).map((stadium) => [stadium.name, stadium]))
  const stadiumsById = Object.fromEntries((stadiumsResult.data || []).map((stadium) => [stadium.id, stadium]))
  const teamsById = Object.fromEntries((teamsResult.data || []).map((team) => [team.id, team]))
  const games = isSeason
    ? rawGames.map((game) => normalizeSeasonGame(game, teamsById, stadiumsByName))
    : rawGames
  const game = games.find((entry) => String(entry.id) === String(gameId))
  if (!game) throw new Error(`betting sync could not load game ${gameId}`)
  const draftPicks = isSeason
    ? (picksResult.data || []).map((pick) => ({
        ...pick,
        tournament_id: sourceId,
        player_id: teamsById[pick.team_id]?.player_id || null,
        character_id: charactersByName[pick.character_name]?.id || null,
      }))
    : (picksResult.data || [])
  const stadiumGameLog = isSeason
    ? (stadiumLogResult.data || []).filter((row) => String(row.season_id) === String(sourceId)).map((row) => ({
        ...row,
        stadium_id: stadiumsByName[row.stadium]?.id || null,
      }))
    : (stadiumLogResult.data || []).filter((row) => gameIds.some((id) => String(id) === String(row.game_id)))

  return {
    tables, game, games, playersById, charactersById, draftPicks,
    allPAs: pasResult.data || [], allPitching: pitchingResult.data || [],
    existingOdds: oddsResult.data || [], bets: betsResult.data || [],
    stadiumsById, stadiumGameLog, weights: weightsResult.data || {},
  }
}

export async function syncTrackerLiveOdds({
  supabase,
  sourceType,
  sourceId,
  gameId,
  liveState = null,
  teamARuns = null,
  teamBRuns = null,
  expectedPitcherByPlayer = {},
  regulationInnings = null,
  shouldPersist = null,
}) {
  const data = await loadTrackerBettingData({ supabase, sourceType, sourceId, gameId })
  const gamePAs = data.allPAs.filter((row) => String(row.game_id) === String(gameId))
  const gamePitching = data.allPitching.filter((row) => String(row.game_id) === String(gameId))
  const game = {
    ...data.game,
    ...(liveState ? { live_state: liveState } : {}),
    ...(teamARuns != null ? { team_a_runs: Number(teamARuns) } : {}),
    ...(teamBRuns != null ? { team_b_runs: Number(teamBRuns) } : {}),
  }
  const context = buildOddsGenerationContext({
    game,
    draftPicks: data.draftPicks,
    charactersById: data.charactersById,
    gamePAs,
    gamePitching,
    allGames: data.games,
    allPAs: data.allPAs,
    allPitching: data.allPitching,
    stadiumsById: data.stadiumsById,
    stadiumGameLog: data.stadiumGameLog,
    playersById: data.playersById,
    currentInning: liveState?.inning,
    scores: { a: game.team_a_runs, b: game.team_b_runs },
    totalInnings: regulationInnings ?? game.innings,
    bets: data.bets,
    expectedPitcherByPlayer,
    oddsWeights: data.weights,
  })
  if (!context?.homeRoster?.length || !context?.awayRoster?.length) return []

  const generated = generateGameOdds(
    context.game,
    context.homeRoster,
    context.awayRoster,
    context.homeHistorical,
    context.awayHistorical,
    context.playerProps,
    data.weights,
  )
  const baseRows = mergeOddsWithExistingRows(generated, data.existingOdds)
  const liveChanges = recalculateOdds(baseRows, {
    oddsContext: context,
    liveState: buildLiveMarketState(game, gamePAs, regulationInnings ?? game.innings),
  })
  const liveRows = mergeLiveChanges(baseRows, liveChanges)
  const currentKTargets = new Set(liveRows.filter((row) => row.bet_type === 'k_prop').map((row) => row.target_entity))
  const staleKLocks = data.existingOdds
    .filter((row) => row.bet_type === 'k_prop' && !row.is_locked && !currentKTargets.has(row.target_entity))
    .map((row) => ({ ...row, is_locked: true, updated_at: new Date().toISOString() }))
  const payload = [...liveRows, ...staleKLocks]
  const existingById = Object.fromEntries(data.existingOdds.filter((row) => row.id != null).map((row) => [String(row.id), row]))
  const updates = payload.filter((row) => (
    row.id != null && !oddsValuesMatch(existingById[String(row.id)] || {}, row)
  ))
  const inserts = payload.filter((row) => row.id == null)
  if (!updates.length && !inserts.length) return []
  if (shouldPersist && !shouldPersist()) return []
  return persistOddsRowsWithFallback({ supabase, table: data.tables.odds, updates, inserts })
}

export async function settleCompletedTrackerGame({
  supabase,
  sourceType,
  sourceId,
  gameId,
  teamARuns,
  teamBRuns,
  teamBPlayerId,
  winnerPlayerId,
}) {
  const data = await loadTrackerBettingData({ supabase, sourceType, sourceId, gameId })
  const gamePAs = data.allPAs.filter((row) => String(row.game_id) === String(gameId))
  const gamePitching = data.allPitching.filter((row) => String(row.game_id) === String(gameId))
  const pitcherKTotals = {}
  const hrTotals = {}
  const hitTotals = {}
  gamePitching.forEach((stint) => {
    const key = buildBettingEntityLabel(data.charactersById[stint.character_id], data.playersById[stint.player_id])
    pitcherKTotals[key] = Number(pitcherKTotals[key] || 0) + Number(stint.strikeouts || 0)
  })
  gamePAs.forEach((pa) => {
    const key = buildBettingEntityLabel(data.charactersById[pa.character_id], data.playersById[pa.player_id])
    if (pa.result === 'HR' || pa.result === 'IPHR') hrTotals[key] = Number(hrTotals[key] || 0) + 1
    if (HIT_RESULTS.has(pa.result)) hitTotals[key] = Number(hitTotals[key] || 0) + 1
  })
  const winningSide = winnerPlayerId == null ? null : String(winnerPlayerId) === String(teamBPlayerId) ? 'home' : 'away'
  return resolveGameBets(
    gameId,
    winningSide,
    Number(teamARuns || 0) + Number(teamBRuns || 0),
    pitcherKTotals,
    Math.abs(Number(teamARuns || 0) - Number(teamBRuns || 0)),
    buildTrackerBetResolutionConfig({ supabase, sourceType, sourceId }),
    hrTotals,
    hitTotals,
  )
}
