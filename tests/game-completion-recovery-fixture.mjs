// One season game and one tournament game that share the numeric id 42, with
// the plate appearances, stints, runs, bets and placement ledger each needs to
// be completed for real. Both live in the same fake database so every test can
// check that finishing one never touches the other.

import { buildSeasonStandings } from '../src/utils/competitionStandings.js'
import { createBettingFakeSupabase } from './helpers/bettingFakeSupabase.mjs'

export const GAME_ID = 42
export const SEASON_ID = 7
export const TOURNAMENT_ID = 9

export const SEASON_TABLES = {
  games: 'season_schedule',
  plateAppearances: 'season_plate_appearances',
  pitchingStints: 'season_pitching_stints',
  runsScored: 'season_runs_scored',
  stadiumGameLog: 'season_stadium_game_log',
  bets: 'season_bets',
  bettingLedger: 'season_betting_ledger',
}

export const TOURNAMENT_TABLES = {
  games: 'games',
  plateAppearances: 'plate_appearances',
  pitchingStints: 'pitching_stints',
  runsScored: 'runs_scored',
  stadiumGameLog: 'stadium_game_log',
  bets: 'bets',
  bettingLedger: 'points_ledger',
}

// The scorebook's own season bet configuration (Scorebook.jsx betResolutionConfig).
export const SEASON_BET_CONFIG = {
  betsTable: 'season_bets',
  gameOddsTable: 'season_game_odds',
  ledgerTable: 'season_betting_ledger',
  plateAppearancesTable: 'season_plate_appearances',
  runsScoredTable: 'season_runs_scored',
  enableCalibrationLogging: false,
  enableWeightAdjustment: false,
  wagerField: 'wager_dollars',
  payoutField: 'potential_payout_dollars',
  ledgerChangeField: 'dollars_change',
  sourceIdField: 'season_id',
  sourceIdValue: SEASON_ID,
}

const CHARACTERS = [
  { id: 101, name: 'Mario' },
  { id: 102, name: 'Luigi' },
  { id: 103, name: 'Peach' },
  { id: 104, name: 'Bowser' },
]

// Away scores one in the top of the first; home answers with two in the
// bottom, and a reliever who entered up one finishes an inning: W to the home
// starter, L to the away starter, S to the reliever -- a save-only stint.
function gameFacts({ away, home }) {
  const at = (minute) => `2026-09-28T10:0${minute}:00Z`
  return {
    stints: [
      { id: 501, game_id: GAME_ID, player_id: away, character_id: 101, created_at: at(0), innings_pitched: 2, strikeouts: 2, win: false, loss: false, save: false },
      { id: 502, game_id: GAME_ID, player_id: home, character_id: 102, created_at: at(0), innings_pitched: 2, strikeouts: 1, win: false, loss: false, save: false },
      { id: 503, game_id: GAME_ID, player_id: home, character_id: 103, created_at: at(3), innings_pitched: 1, strikeouts: 1, win: false, loss: false, save: false },
    ],
    pas: [
      { id: 601, game_id: GAME_ID, pa_number: 1, inning: 1, player_id: away, character_id: 104, pitcher_id: 102, pitcher_player_id: home, result: 'HR', rbi: 1, created_at: at(1) },
      { id: 602, game_id: GAME_ID, pa_number: 2, inning: 1, player_id: home, character_id: 103, pitcher_id: 101, pitcher_player_id: away, result: '2B', rbi: 2, created_at: at(2) },
    ],
    runs: [
      { id: 701, game_id: GAME_ID, pa_id: 601, inning: 1, charged_to_pitcher_id: 102, charged_to_pitcher_player_id: home },
      { id: 702, game_id: GAME_ID, pa_id: 602, inning: 1, charged_to_pitcher_id: 101, charged_to_pitcher_player_id: away },
      { id: 703, game_id: GAME_ID, pa_id: 602, inning: 1, charged_to_pitcher_id: 101, charged_to_pitcher_player_id: away },
    ],
  }
}

export const EXPECTED_FLAGS = {
  501: { win: false, loss: true, save: false },
  502: { win: true, loss: false, save: false },
  503: { win: false, loss: false, save: true },
}

function bet(id, fields) {
  return { id, game_id: GAME_ID, status: 'open', result_correct: null, resolved_at: null, line: null, target_entity: null, ...fields }
}

export function buildRecoveryWorld({ failures = [] } = {}) {
  const seasonTeams = [
    { id: 1, season_id: SEASON_ID, player_id: 'p-away', team_name: 'Away' },
    { id: 2, season_id: SEASON_ID, player_id: 'p-home', team_name: 'Home' },
    { id: 3, season_id: SEASON_ID, player_id: 'p-c', team_name: 'Cee' },
    { id: 4, season_id: SEASON_ID, player_id: 'p-d', team_name: 'Dee' },
  ]
  const schedule = [
    { id: GAME_ID, season_id: SEASON_ID, round_number: 1, stage: null, status: 'in_progress', away_team_id: 1, home_team_id: 2, away_score: 1, home_score: 2, winner_team_id: null, stadium: 'Peach Ice Garden', is_night: false, live_state: {}, final_inning: null },
    { id: 43, season_id: SEASON_ID, round_number: 1, stage: null, status: 'completed', away_team_id: 3, home_team_id: 4, away_score: 1, home_score: 3, winner_team_id: 4, stadium: 'Mario Stadium', is_night: false, live_state: {}, final_inning: 3 },
    { id: 44, season_id: SEASON_ID, round_number: 2, stage: null, status: 'scheduled', away_team_id: 1, home_team_id: 3, away_score: 0, home_score: 0, winner_team_id: null, stadium: null, is_night: false, live_state: {} },
  ]
  // Persisted standings that already agree with the one finished game, as a
  // live season's would.
  const standingFields = ['wins', 'losses', 'run_differential', 'home_wins', 'home_losses', 'away_wins', 'away_losses']
  const standings = buildSeasonStandings(seasonTeams, schedule, [])
  const persistedTeams = seasonTeams.map((team) => {
    const row = standings.find((entry) => entry.id === team.id)
    return { ...team, ...Object.fromEntries(standingFields.map((field) => [field, row[field]])) }
  })

  const seasonFacts = gameFacts({ away: 'p-away', home: 'p-home' })
  const tournamentFacts = gameFacts({ away: 't1', home: 't4' })
  const seasonBets = [
    bet(1, { player_id: 'p-c', bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10, potential_payout_dollars: 12, season_id: SEASON_ID }),
    bet(2, { player_id: 'p-d', bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 5, potential_payout_dollars: 7, season_id: SEASON_ID }),
    // Settled during play, as first-inning bets are.
    bet(3, { player_id: 'p-c', bet_type: 'first_inning_run', chosen_side: 'yes', wager_dollars: 4, potential_payout_dollars: 4, season_id: SEASON_ID, status: 'won', result_correct: true, resolved_at: '2026-09-28T10:02:00Z' }),
  ]
  const tournamentBets = [
    bet(1, { player_id: 't2', bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 20, potential_payout_dollars: 18, tournament_id: TOURNAMENT_ID, predicted_probability: 0.55 }),
  ]

  const tables = {
    characters: CHARACTERS,
    players: ['p-away', 'p-home', 'p-c', 'p-d', 't1', 't2', 't3', 't4'].map((id) => ({ id, name: id.toUpperCase() })),
    seasons: [{ id: SEASON_ID, status: 'active', playoff_format: 'double_elimination', innings: 3, champion_player_id: null }],
    season_teams: persistedTeams,
    season_schedule: schedule,
    season_pitching_stints: seasonFacts.stints.map((row) => ({ ...row, season_id: SEASON_ID })),
    season_plate_appearances: seasonFacts.pas.map((row) => ({ ...row, season_id: SEASON_ID })),
    season_runs_scored: seasonFacts.runs.map((row) => ({ ...row, season_id: SEASON_ID })),
    season_stadium_game_log: [],
    season_bets: seasonBets,
    season_betting_ledger: [
      ...seasonBets.map((row, index) => ({ id: index + 1, player_id: row.player_id, game_id: GAME_ID, bet_id: row.id, season_id: SEASON_ID, reason: `bet_placed:${row.bet_type}:${row.chosen_side}`, dollars_change: -row.wager_dollars })),
      { id: 10, player_id: 'p-c', game_id: GAME_ID, bet_id: 3, season_id: SEASON_ID, reason: 'bet_settled:first_inning_run:yes', dollars_change: 8 },
    ],
    season_game_odds: [],
    tournaments: [{ id: TOURNAMENT_ID, status: 'active', bracket_format: 'single', player_ids: ['t1', 't2', 't3', 't4'], seeding: ['t1', 't2', 't3', 't4'], champion_player_id: null }],
    games: [
      { id: GAME_ID, tournament_id: TOURNAMENT_ID, stage: 'Round 1-1', status: 'active', team_a_player_id: 't1', team_b_player_id: 't4', team_a_runs: 1, team_b_runs: 2, winner_player_id: null, stadium_id: 'stadium-uuid-1', is_night: true, game_code: 'G1' },
      { id: 43, tournament_id: TOURNAMENT_ID, stage: 'Round 1-2', status: 'complete', team_a_player_id: 't2', team_b_player_id: 't3', team_a_runs: 4, team_b_runs: 1, winner_player_id: 't2', stadium_id: null, is_night: false, game_code: 'G2' },
    ],
    pitching_stints: tournamentFacts.stints,
    plate_appearances: tournamentFacts.pas,
    runs_scored: tournamentFacts.runs,
    stadium_game_log: [],
    bets: tournamentBets,
    points_ledger: tournamentBets.map((row, index) => ({ id: index + 1, player_id: row.player_id, game_id: GAME_ID, bet_id: row.id, tournament_id: TOURNAMENT_ID, reason: `bet_placed:${row.bet_type}:${row.chosen_side}`, points_change: -row.wager_dollars })),
    game_odds: [],
    odds_calibration_log: [],
    odds_engine_weights: [{ id: 1, char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334, games_evaluated: 12, last_brier_score: 0.2 }],
  }

  return createBettingFakeSupabase(tables, {
    failures,
    // What the schema enforces: one park-factor row per game, and the settled
    // ledger upsert's conflict target.
    unique: {
      stadium_game_log: [['game_id']],
      season_stadium_game_log: [['game_id']],
      season_betting_ledger: [['bet_id', 'reason']],
      points_ledger: [['bet_id', 'reason']],
    },
  })
}

export function seasonCompletionPatch(scores = { a: 1, b: 2 }) {
  const winnerTeam = scores.a === scores.b ? null : (scores.a > scores.b ? 1 : 2)
  return { status: 'completed', live_state: {}, winner_team_id: winnerTeam, away_score: scores.a, home_score: scores.b, final_inning: 3, is_extra_innings: false }
}

export function seasonReopenPatch(scores = { a: 1, b: 2 }) {
  return { status: 'in_progress', live_state: {}, winner_team_id: null, away_score: scores.a, home_score: scores.b, final_inning: null, is_extra_innings: false }
}

export function tournamentCompletionPatch() {
  return { status: 'complete', live_state: {}, winner_player_id: 't4', team_a_runs: 1, team_b_runs: 2, final_inning: 3, is_extra_innings: false }
}

export function balanceByPlayer(rows, field) {
  const totals = {}
  rows.forEach((row) => { totals[row.player_id] = Math.round(((totals[row.player_id] || 0) + Number(row[field] || 0)) * 100) / 100 })
  return totals
}

export function flagsById(rows) {
  return Object.fromEntries(rows.map((row) => [row.id, { win: Boolean(row.win), loss: Boolean(row.loss), save: Boolean(row.save) }]))
}

export function snapshot(client, tables) {
  return JSON.parse(JSON.stringify(Object.fromEntries(tables.map((table) => [table, client.db[table]]))))
}
