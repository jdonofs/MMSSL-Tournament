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
import { buildObservationGameContext } from '../src/utils/oddsHistory.js'
import { ODDS_HISTORY_STATUS, recordOddsObservations } from '../src/utils/oddsHistoryPersistence.js'
import { buildLiveMarketState } from '../src/utils/trackerLiveFeed.js'
import { resolveGameBets } from '../src/utils/betResolution.js'
import { isCreditedHit } from '../src/utils/creditedHit.js'

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

// Every betting market is keyed by `Character (Player)`. An identity that fails
// to resolve does not raise an error on its own — it silently becomes a
// different key, or no roster entry at all, and the damage only shows up later:
// a prop priced for the wrong pitcher, or a settlement that grades a real
// player's home-run prop against a total of 0. These checks turn each of those
// into a named, recoverable failure. Betting is derived work, so the bridge
// logs the failure and the durable scoring facts are untouched.
function assertGameIdentitiesResolved({ isSeason, rawGame, game, rawPicks, charactersById, charactersByName, teamsById }) {
  const picks = rawPicks || []
  if (isSeason) {
    const missingTeams = [rawGame.away_team_id, rawGame.home_team_id]
      .filter((teamId) => teamsById[teamId]?.player_id == null)
    if (missingTeams.length) {
      throw new Error(`betting sync cannot resolve a player for season team(s) ${missingTeams.join(', ')} on game ${game.id}`)
    }
  }
  if (game.team_a_player_id == null || game.team_b_player_id == null) {
    throw new Error(`betting sync cannot resolve both teams for game ${game.id} (away=${game.team_a_player_id}, home=${game.team_b_player_id})`)
  }

  if (isSeason) {
    const gameTeamIds = new Set([rawGame.away_team_id, rawGame.home_team_id].map(String))
    const unresolved = picks
      .filter((pick) => gameTeamIds.has(String(pick.team_id)) && !charactersByName[pick.character_name])
      .map((pick) => pick.character_name)
    if (unresolved.length) {
      throw new Error(`betting sync cannot resolve roster character name(s) for game ${game.id}: ${[...new Set(unresolved)].join(', ')}`)
    }
    return
  }

  const gamePlayerIds = new Set([game.team_a_player_id, game.team_b_player_id].map(String))
  const unresolved = picks
    .filter((pick) => gamePlayerIds.has(String(pick.player_id)) && pick.character_id != null && !charactersById[pick.character_id])
    .map((pick) => pick.character_id)
  if (unresolved.length) {
    throw new Error(`betting sync cannot resolve roster character id(s) for game ${game.id}: ${[...new Set(unresolved)].join(', ')}`)
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
    isSeason,
    rawGame: rawGames.find((entry) => String(entry.id) === String(gameId)),
    rawPicks: picksResult.data || [],
    charactersByName, teamsById,
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
  logOddsHistory = null,
}) {
  const data = await loadTrackerBettingData({ supabase, sourceType, sourceId, gameId })
  // Odds generation is driven entirely by the roster, so an unresolvable roster
  // identity must stop here rather than quietly price a short lineup.
  assertGameIdentitiesResolved(data)
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
  if (shouldPersist && !shouldPersist()) return []

  const persisted = (updates.length || inserts.length)
    ? await persistOddsRowsWithFallback({ supabase, table: data.tables.odds, updates, inserts })
    : []

  // Odds history is recorded here rather than in the browser: this is the
  // writer the tracker bridge drives, it already knows which markets moved, and
  // it runs once per game instead of once per open tab. A market that has not
  // moved writes nothing, so a repeated sync or a retry after a timeout cannot
  // append a second identical observation. History is derived work — a missing
  // table or a failed append is reported, never allowed to break pricing.
  const persistedByKey = Object.fromEntries(
    persisted.filter((row) => row?.bet_type).map((row) => [buildOddsRowKey(row), row]),
  )
  const observationRows = payload.map((row) => persistedByKey[buildOddsRowKey(row)] || row)
  const historyResult = await recordOddsObservations({
    supabase,
    sourceType,
    gameId,
    rows: observationRows,
    gameContext: buildObservationGameContext(game, { isSeason: data.isSeason }),
  })
  if (historyResult.status !== ODDS_HISTORY_STATUS.ok && logOddsHistory) {
    logOddsHistory(historyResult.status === ODDS_HISTORY_STATUS.unavailable
      ? `odds history table is not present; skipping snapshots for game ${gameId}`
      : `odds history append returned ${historyResult.status} for game ${gameId}${historyResult.error ? `: ${historyResult.error.message}` : ''}`)
  }

  return persisted
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
  const unresolvedPitchingRows = []
  const unresolvedPARows = []
  gamePitching.forEach((stint) => {
    const character = data.charactersById[stint.character_id]
    const player = data.playersById[stint.player_id]
    if (!character || !player) unresolvedPitchingRows.push(`stint ${stint.id} (character ${stint.character_id}, player ${stint.player_id})`)
    const key = buildBettingEntityLabel(character, player)
    pitcherKTotals[key] = Number(pitcherKTotals[key] || 0) + Number(stint.strikeouts || 0)
  })
  gamePAs.forEach((pa) => {
    const character = data.charactersById[pa.character_id]
    const player = data.playersById[pa.player_id]
    if (!character || !player) unresolvedPARows.push(`PA ${pa.id} (character ${pa.character_id}, player ${pa.player_id})`)
    const key = buildBettingEntityLabel(character, player)
    if (isCreditedHit(pa) && (pa.result === 'HR' || pa.result === 'IPHR')) hrTotals[key] = Number(hrTotals[key] || 0) + 1
    if (isCreditedHit(pa)) hitTotals[key] = Number(hitTotals[key] || 0) + 1
  })

  // A row whose identity does not resolve is counted under a label no market
  // uses, so the real entity's total silently reads as 0 and every "over"
  // ticket on them grades as a loss. Refuse to settle the affected prop family
  // instead: the identity can be repaired and settlement re-run, which the
  // ledger reconciliation makes safe. Markets with no exposure are unaffected.
  const openPropBets = data.bets.filter((bet) => (
    String(bet.game_id) === String(gameId) && (bet.status === 'open' || bet.status === 'pending')
  ))
  const exposedTypes = new Set(openPropBets.map((bet) => bet.bet_type))
  if (unresolvedPARows.length && (exposedTypes.has('hr_prop') || exposedTypes.has('hit_prop'))) {
    throw new Error(`betting settlement blocked: unresolved batter identities on game ${gameId} with open hit/HR props — ${unresolvedPARows.join('; ')}`)
  }
  if (unresolvedPitchingRows.length && exposedTypes.has('k_prop')) {
    throw new Error(`betting settlement blocked: unresolved pitcher identities on game ${gameId} with open strikeout props — ${unresolvedPitchingRows.join('; ')}`)
  }
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
