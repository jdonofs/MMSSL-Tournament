// Dedicated fixtures for the tracker -> market -> settlement integration suite.
//
// Both competitions deliberately use the SAME numeric source id (5) and the
// SAME numeric game id (77). Tournament and season data must stay isolated by
// table, and reusing the numbers is what proves it.

import { buildBettingEntityLabel } from '../../src/utils/oddsEngine.js'
import { createBettingFakeSupabase } from './bettingFakeSupabase.mjs'

export const SOURCE_ID = 5
export const GAME_ID = 77
export const PRIOR_GAME_ID = 76

export const AWAY_PLAYER = { id: 'p1', name: 'Aidan', color: '#ff0000' }
export const HOME_PLAYER = { id: 'p2', name: 'Donovan', color: '#0000ff' }

export const AWAY_TEAM_ID = 101
export const HOME_TEAM_ID = 102

export const CHARACTERS = [
  { id: 11, name: 'Mario', batting: 8, pitching: 3, fielding: 5, speed: 6 },
  { id: 12, name: 'Luigi', batting: 5, pitching: 8, fielding: 6, speed: 6 },
  { id: 21, name: 'Peach', batting: 7, pitching: 4, fielding: 5, speed: 7 },
  { id: 22, name: 'Daisy', batting: 4, pitching: 9, fielding: 5, speed: 7 },
]

export const STADIUM = { id: 1, name: 'Mario Stadium', hr_factor: 1, scoring_factor: 1 }

const AWAY_CHARACTER_IDS = [11, 12]
const HOME_CHARACTER_IDS = [21, 22]

const characterById = Object.fromEntries(CHARACTERS.map((character) => [character.id, character]))

export function entityLabel(characterId, playerId) {
  const player = playerId === HOME_PLAYER.id ? HOME_PLAYER : AWAY_PLAYER
  return buildBettingEntityLabel(characterById[characterId], player)
}

export const LABELS = {
  mario: entityLabel(11, AWAY_PLAYER.id),
  luigi: entityLabel(12, AWAY_PLAYER.id),
  peach: entityLabel(21, HOME_PLAYER.id),
  daisy: entityLabel(22, HOME_PLAYER.id),
}

export const TOURNAMENT_TABLES = {
  games: 'games',
  picks: 'draft_picks',
  pas: 'plate_appearances',
  pitching: 'pitching_stints',
  odds: 'game_odds',
  bets: 'bets',
  ledger: 'points_ledger',
  runs: 'runs_scored',
  stadiumLog: 'stadium_game_log',
  ledgerChangeField: 'dollars_change',
}

export const SEASON_TABLES = {
  games: 'season_schedule',
  picks: 'season_roster',
  pas: 'season_plate_appearances',
  pitching: 'season_pitching_stints',
  odds: 'season_game_odds',
  bets: 'season_bets',
  ledger: 'season_betting_ledger',
  runs: 'season_runs_scored',
  stadiumLog: 'season_stadium_game_log',
  ledgerChangeField: 'dollars_change',
}

// `sourceConfig()` in tracker_betting_sync.mjs picks the ledger delta column:
// `points_change` for tournaments, `dollars_change` for seasons.
export const LEDGER_CHANGE_FIELD = {
  tournament: 'points_change',
  season: 'dollars_change',
}

export const SOURCE_ID_FIELD = {
  tournament: 'tournament_id',
  season: 'season_id',
}

export function tablesFor(sourceType) {
  return sourceType === 'season' ? SEASON_TABLES : TOURNAMENT_TABLES
}

function tournamentGame(overrides = {}) {
  return {
    id: GAME_ID,
    tournament_id: SOURCE_ID,
    team_a_player_id: AWAY_PLAYER.id,
    team_b_player_id: HOME_PLAYER.id,
    team_a_runs: 0,
    team_b_runs: 0,
    winner_player_id: null,
    status: 'pending',
    innings: 3,
    stadium_id: STADIUM.id,
    is_night: false,
    current_inning: 1,
    is_top_inning: true,
    live_state: null,
    ...overrides,
  }
}

function seasonGame(overrides = {}) {
  return {
    id: GAME_ID,
    season_id: SOURCE_ID,
    away_team_id: AWAY_TEAM_ID,
    home_team_id: HOME_TEAM_ID,
    away_score: 0,
    home_score: 0,
    winner_team_id: null,
    status: 'scheduled',
    innings: 3,
    stadium: STADIUM.name,
    is_night: false,
    current_inning: 1,
    is_top_inning: true,
    live_state: null,
    ...overrides,
  }
}

// A single completed prior game keeps the historical blend non-degenerate
// without making the fixture slow or the arithmetic opaque.
function priorTournamentGame() {
  return tournamentGame({
    id: PRIOR_GAME_ID,
    status: 'complete',
    team_a_runs: 3,
    team_b_runs: 4,
    winner_player_id: HOME_PLAYER.id,
    current_inning: 3,
  })
}

function priorSeasonGame() {
  return seasonGame({
    id: PRIOR_GAME_ID,
    status: 'completed',
    away_score: 3,
    home_score: 4,
    winner_team_id: HOME_TEAM_ID,
    current_inning: 3,
  })
}

let paSequence = 0
let pitchingSequence = 0

export function resetFixtureSequences() {
  paSequence = 0
  pitchingSequence = 0
}

export function makePA({
  gameId = GAME_ID,
  playerId = AWAY_PLAYER.id,
  characterId = 11,
  result = '1B',
  inning = 1,
  isTop = true,
  rbi = 0,
  runScored = false,
  isError = false,
  paNumber = null,
  id = null,
} = {}) {
  paSequence += 1
  const ordinal = paNumber ?? paSequence
  return {
    id: id ?? 1000 + paSequence,
    game_id: gameId,
    player_id: playerId,
    character_id: characterId,
    pa_number: ordinal,
    inning,
    is_top_inning: isTop,
    result,
    rbi,
    run_scored: runScored,
    is_error: isError,
    hit_distance_ft: result === 'HR' ? 340 : null,
    created_at: `2026-07-20T12:${String(ordinal).padStart(2, '0')}:00.000Z`,
  }
}

export function makePitchingStint({
  gameId = GAME_ID,
  playerId = HOME_PLAYER.id,
  characterId = 22,
  strikeouts = 0,
  inningsPitched = 1,
  id = null,
} = {}) {
  pitchingSequence += 1
  return {
    id: id ?? 2000 + pitchingSequence,
    game_id: gameId,
    player_id: playerId,
    character_id: characterId,
    innings_pitched: inningsPitched,
    strikeouts,
    hits_allowed: 0,
    runs_allowed: 0,
    walks: 0,
    created_at: `2026-07-20T12:${String(pitchingSequence).padStart(2, '0')}:00.000Z`,
  }
}

export function makeRunScored({
  gameId = GAME_ID,
  paId,
  inning = 1,
  playerId = AWAY_PLAYER.id,
  characterId = 11,
  id = null,
} = {}) {
  return {
    id: id ?? 3000 + paId,
    game_id: gameId,
    pa_id: paId,
    inning,
    scoring_player_id: playerId,
    scoring_character_id: characterId,
  }
}

export function makeBet(sourceType, overrides = {}) {
  const sourceField = SOURCE_ID_FIELD[sourceType]
  return {
    id: overrides.id ?? 1,
    game_id: overrides.game_id ?? GAME_ID,
    player_id: overrides.player_id ?? AWAY_PLAYER.id,
    [sourceField]: overrides[sourceField] ?? SOURCE_ID,
    game_odds_id: overrides.game_odds_id ?? null,
    bet_type: overrides.bet_type ?? 'moneyline',
    target_entity: overrides.target_entity ?? null,
    chosen_side: overrides.chosen_side ?? 'home',
    odds: overrides.odds ?? 150,
    predicted_probability: overrides.predicted_probability ?? 0.4,
    wager_dollars: overrides.wager_dollars ?? 10,
    potential_payout_dollars: overrides.potential_payout_dollars ?? 15,
    status: overrides.status ?? 'open',
    line: overrides.line ?? null,
    result_correct: overrides.result_correct ?? null,
    placed_at: overrides.placed_at ?? '2026-07-20T12:00:00.000Z',
    resolved_at: overrides.resolved_at ?? null,
  }
}

export function makePlacementLedger(sourceType, bets = []) {
  const changeField = LEDGER_CHANGE_FIELD[sourceType]
  const sourceField = SOURCE_ID_FIELD[sourceType]
  return bets.map((bet, index) => ({
    id: 5000 + index,
    player_id: bet.player_id,
    game_id: bet.game_id,
    bet_id: bet.id,
    [sourceField]: SOURCE_ID,
    reason: `bet_placed:${bet.bet_type}:${bet.chosen_side}`,
    [changeField]: -Number(bet.wager_dollars || 0),
  }))
}

// Unique keys the database is expected to hold. The fake enforces them so a
// test can prove the client never relies on writing a duplicate, and so a
// missing constraint shows up as a duplicate row rather than an error.
export const BETTING_UNIQUE_KEYS = {
  game_odds: [['game_id', 'bet_type', 'target_entity']],
  season_game_odds: [['game_id', 'bet_type', 'target_entity']],
  points_ledger: [['bet_id', 'reason']],
  season_betting_ledger: [['bet_id', 'reason']],
}

export function buildBettingWorld(sourceType, {
  gameOverrides = {},
  pas = [],
  pitching = [],
  runs = [],
  odds = [],
  bets = [],
  ledger = [],
  priorPAs = null,
  includePriorGame = true,
  failures = [],
  unique = BETTING_UNIQUE_KEYS,
  extraTables = {},
} = {}) {
  resetFixtureSequences()
  const isSeason = sourceType === 'season'
  const tables = tablesFor(sourceType)

  const priorGamePAs = priorPAs ?? [
    makePA({ gameId: PRIOR_GAME_ID, playerId: AWAY_PLAYER.id, characterId: 11, result: '1B', inning: 1 }),
    makePA({ gameId: PRIOR_GAME_ID, playerId: AWAY_PLAYER.id, characterId: 11, result: 'K', inning: 2 }),
    makePA({ gameId: PRIOR_GAME_ID, playerId: HOME_PLAYER.id, characterId: 21, result: 'HR', inning: 1, rbi: 1 }),
    makePA({ gameId: PRIOR_GAME_ID, playerId: HOME_PLAYER.id, characterId: 21, result: 'OUT', inning: 2 }),
  ]
  const priorGamePitching = [
    makePitchingStint({ gameId: PRIOR_GAME_ID, playerId: HOME_PLAYER.id, characterId: 22, strikeouts: 2, inningsPitched: 3 }),
    makePitchingStint({ gameId: PRIOR_GAME_ID, playerId: AWAY_PLAYER.id, characterId: 12, strikeouts: 1, inningsPitched: 3 }),
  ]
  resetFixtureSequences()

  const gameRow = isSeason ? seasonGame(gameOverrides) : tournamentGame(gameOverrides)
  const gameRows = includePriorGame
    ? [isSeason ? priorSeasonGame() : priorTournamentGame(), gameRow]
    : [gameRow]

  const pickRows = isSeason
    ? [
      ...AWAY_CHARACTER_IDS.map((characterId, index) => ({
        id: 300 + index,
        season_id: SOURCE_ID,
        team_id: AWAY_TEAM_ID,
        character_name: characterById[characterId].name,
      })),
      ...HOME_CHARACTER_IDS.map((characterId, index) => ({
        id: 310 + index,
        season_id: SOURCE_ID,
        team_id: HOME_TEAM_ID,
        character_name: characterById[characterId].name,
      })),
    ]
    : [
      ...AWAY_CHARACTER_IDS.map((characterId, index) => ({
        id: 300 + index,
        tournament_id: SOURCE_ID,
        player_id: AWAY_PLAYER.id,
        character_id: characterId,
      })),
      ...HOME_CHARACTER_IDS.map((characterId, index) => ({
        id: 310 + index,
        tournament_id: SOURCE_ID,
        player_id: HOME_PLAYER.id,
        character_id: characterId,
      })),
    ]

  const initialTables = {
    players: [AWAY_PLAYER, HOME_PLAYER],
    characters: CHARACTERS,
    stadiums: [STADIUM],
    odds_engine_weights: [{
      id: 1,
      char_stats_weight: 0.333,
      historical_weight: 0.333,
      live_weight: 0.334,
      games_evaluated: 12,
      last_brier_score: 0.2,
    }],
    [tables.games]: gameRows,
    [tables.picks]: pickRows,
    [tables.pas]: [...(includePriorGame ? priorGamePAs : []), ...pas],
    [tables.pitching]: [...(includePriorGame ? priorGamePitching : []), ...pitching],
    [tables.runs]: runs,
    [tables.odds]: odds,
    [tables.bets]: bets,
    [tables.ledger]: ledger,
    [tables.stadiumLog]: isSeason
      ? [{ id: 1, season_id: SOURCE_ID, game_id: PRIOR_GAME_ID, stadium: STADIUM.name, is_night: false, total_runs: 7 }]
      : [{ id: 1, game_id: PRIOR_GAME_ID, stadium_id: STADIUM.id, is_night: false, total_runs: 7 }],
    ...(isSeason
      ? {
        season_teams: [
          { id: AWAY_TEAM_ID, season_id: SOURCE_ID, player_id: AWAY_PLAYER.id, team_name: 'Aidan FC' },
          { id: HOME_TEAM_ID, season_id: SOURCE_ID, player_id: HOME_PLAYER.id, team_name: 'Donovan FC' },
        ],
      }
      : {}),
    ...extraTables,
  }

  const supabase = createBettingFakeSupabase(initialTables, { failures, unique })

  return {
    supabase,
    db: supabase.db,
    tables,
    sourceType,
    sourceId: SOURCE_ID,
    gameId: GAME_ID,
    ledgerChangeField: LEDGER_CHANGE_FIELD[sourceType],
    sourceIdField: SOURCE_ID_FIELD[sourceType],
    syncArgs: {
      supabase,
      sourceType,
      sourceId: SOURCE_ID,
      gameId: GAME_ID,
    },
  }
}

// Applies a live tracker publication to the game row the way the bridge does:
// scores on the game row, the rest in `live_state`.
export function applyLiveState(world, { inning = 1, isTop = true, outs = 0, awayRuns = 0, homeRuns = 0, status = null } = {}) {
  const isSeason = world.sourceType === 'season'
  const row = world.db[world.tables.games].find((entry) => String(entry.id) === String(world.gameId))
  row.live_state = { inning, isTop, outsInHalf: outs, runners: {} }
  row.current_inning = inning
  row.is_top_inning = isTop
  if (isSeason) {
    row.away_score = awayRuns
    row.home_score = homeRuns
    row.status = status ?? 'in_progress'
  } else {
    row.team_a_runs = awayRuns
    row.team_b_runs = homeRuns
    row.status = status ?? 'active'
  }
  return {
    liveState: row.live_state,
    teamARuns: awayRuns,
    teamBRuns: homeRuns,
  }
}

export function ledgerRowsFor(world, { reasonPrefix = 'bet_settled' } = {}) {
  return (world.db[world.tables.ledger] || []).filter((row) => String(row.reason || '').startsWith(`${reasonPrefix}:`))
}

export function ledgerNet(world, playerId = null) {
  return Math.round((world.db[world.tables.ledger] || [])
    .filter((row) => playerId == null || row.player_id === playerId)
    .reduce((sum, row) => sum + Number(row[world.ledgerChangeField] || 0), 0) * 100) / 100
}

export function oddsRows(world, betType = null) {
  return (world.db[world.tables.odds] || []).filter((row) => !betType || row.bet_type === betType)
}

export function betsById(world) {
  return Object.fromEntries((world.db[world.tables.bets] || []).map((bet) => [bet.id, bet]))
}
