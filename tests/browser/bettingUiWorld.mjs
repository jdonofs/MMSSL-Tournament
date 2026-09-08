// Seed data for the betting UI fixture page, shaped the way BettingTab loads it.
// Serialized into the browser by `addInitScript`, so everything here must be
// plain JSON.

// Distinct mascots: `getTeamShortName` prefers the mascot, and two teams both
// short-named "FC" would make every board and ticket label ambiguous.
export const PLAYER_A = { id: 'p1', name: 'Aidan', color: '#c62828', team_name: 'Aidan Aces', team_mascot: 'Aces' }
export const PLAYER_B = { id: 'p2', name: 'Donovan', color: '#1565c0', team_name: 'Donovan Dukes', team_mascot: 'Dukes' }

const CHARACTERS = [
  { id: 11, name: 'Mario', batting: 8, pitching: 3, fielding: 5, speed: 6 },
  { id: 12, name: 'Luigi', batting: 5, pitching: 8, fielding: 6, speed: 6 },
  { id: 21, name: 'Peach', batting: 7, pitching: 4, fielding: 5, speed: 7 },
  { id: 22, name: 'Daisy', batting: 4, pitching: 9, fielding: 5, speed: 7 },
]

const GAME_ID = 77
const TOURNAMENT_ID = 5

function oddsRow(overrides) {
  return {
    game_id: GAME_ID,
    target_entity: null,
    line: null,
    is_locked: false,
    updated_at: '2026-07-20T12:00:00.000Z',
    ...overrides,
  }
}

export const BOARD_ODDS = [
  oddsRow({ id: 1, bet_type: 'moneyline', odds_home: -140, odds_away: 120, predicted_probability: 0.58 }),
  oddsRow({ id: 2, bet_type: 'run_line', line: 1.5, odds_home: 105, odds_away: -125, predicted_probability: 0.48 }),
  oddsRow({ id: 3, bet_type: 'over_under', line: 6.5, odds_over: -110, odds_under: -110, predicted_probability: 0.5 }),
  oddsRow({ id: 4, bet_type: 'first_inning_run', line: 0.5, odds_yes: 130, odds_no: -155, predicted_probability: 0.44 }),
]

export function buildUiFixture({
  balance = 500,
  odds = BOARD_ODDS,
  isScorekeeper = false,
  trackerManaged = true,
  oddsCalculating = false,
} = {}) {
  // `balance` is the effective spendable balance the UI should show. economy.js
  // starts every player at STARTING_BALANCE, so the seed row carries the delta.
  const STARTING_BALANCE = 100
  const delta = Math.round((balance - STARTING_BALANCE) * 100) / 100
  const ledger = delta === 0 ? [] : [{
    id: 1,
    player_id: PLAYER_A.id,
    game_id: null,
    bet_id: null,
    tournament_id: TOURNAMENT_ID,
    reason: 'seed:balance',
    points_change: delta,
  }]

  return {
    player: PLAYER_A,
    isScorekeeper,
    tournament: { id: TOURNAMENT_ID, name: 'Fixture Cup', innings: 3 },
    season: null,
    seasonTeams: [],
    // The placement RPC stand-in is installed by the test (see openBoard);
    // functions do not survive addInitScript's JSON boundary.
    rpc: {},
    tables: {
      players: [PLAYER_A, PLAYER_B],
      characters: CHARACTERS,
      stadiums: [{ id: 1, name: 'Mario Stadium' }],
      games: [{
        id: GAME_ID,
        tournament_id: TOURNAMENT_ID,
        team_a_player_id: PLAYER_A.id,
        team_b_player_id: PLAYER_B.id,
        team_a_runs: 1,
        team_b_runs: 0,
        winner_player_id: null,
        status: 'active',
        innings: 3,
        stadium_id: 1,
        is_night: false,
        current_inning: 2,
        is_top_inning: true,
        game_code: 'AID @ DON',
      }],
      draft_picks: [
        { id: 1, tournament_id: TOURNAMENT_ID, player_id: PLAYER_A.id, character_id: 11, pick_number: 1 },
        { id: 2, tournament_id: TOURNAMENT_ID, player_id: PLAYER_A.id, character_id: 12, pick_number: 2 },
        { id: 3, tournament_id: TOURNAMENT_ID, player_id: PLAYER_B.id, character_id: 21, pick_number: 3 },
        { id: 4, tournament_id: TOURNAMENT_ID, player_id: PLAYER_B.id, character_id: 22, pick_number: 4 },
      ],
      plate_appearances: [
        { id: 101, game_id: GAME_ID, player_id: PLAYER_A.id, character_id: 11, pa_number: 1, inning: 1, result: 'HR', rbi: 1, created_at: '2026-07-20T12:01:00.000Z' },
      ],
      pitching_stints: [
        { id: 201, game_id: GAME_ID, player_id: PLAYER_B.id, character_id: 22, innings_pitched: 1, strikeouts: 1, created_at: '2026-07-20T12:01:00.000Z' },
      ],
      pitches: [],
      runs_scored: [{ id: 301, game_id: GAME_ID, pa_id: 101, inning: 1, scoring_player_id: PLAYER_A.id, scoring_character_id: 11 }],
      game_odds: odds,
      bets: [],
      game_settlements: [],
      stadium_game_log: [],
      points_ledger: ledger,
      player_sips: [],
      sip_transactions: [],
      sip_redemptions: [],
      balance_awards: [],
      odds_engine_weights: [{ id: 1, char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 }],
      tracker_live_stats: trackerManaged
        ? [{ id: 1, game_id: GAME_ID, live_feed: { inning: 2, isTop: true, oddsCalculating } }]
        : [],
      game_fielders: [],
      team_lineups: [],
    },
  }
}

// ── My Bets / receipts / odds history / prop research fixture ────────────────
//
// Adds a finished game (76) with four settled tickets and keeps the live game
// (77) for the open ones, so one page exercises won, lost, void, a graded win
// whose credit has not been recorded, and two open tickets.
//
// Hand-worked money, used by the assertions in betting-experience-ui.test.mjs:
//   501 won   $25 @ +150 -> +37.50 profit, $62.50 returned and credited
//   502 lost  $30 @ -110 -> -30.00
//   503 void  $12 @ +120 ->   0.00, $12 refunded
//   504 won   $20 @ +140 -> +28.00 profit, NOT yet credited
//   settled net +35.50 on $87 settled ($75 at risk) -> ROI 47.3%
//   open exposure $18, open potential return $46
const FINISHED_GAME_ID = 76

const MY_TICKETS = [
  {
    id: 501, game_id: FINISHED_GAME_ID, player_id: PLAYER_A.id, tournament_id: TOURNAMENT_ID,
    bet_type: 'moneyline', target_entity: null, chosen_side: 'home', odds: 150, line: null,
    predicted_probability: 0.4, wager_dollars: 25, potential_payout_dollars: 37.5,
    status: 'won', result_correct: true,
    placed_at: '2026-07-19T12:00:00.000Z', resolved_at: '2026-07-19T13:00:00.000Z',
  },
  {
    id: 502, game_id: FINISHED_GAME_ID, player_id: PLAYER_A.id, tournament_id: TOURNAMENT_ID,
    bet_type: 'over_under', target_entity: null, chosen_side: 'over', odds: -110, line: 12.5,
    predicted_probability: 0.5, wager_dollars: 30, potential_payout_dollars: 27.27,
    status: 'lost', result_correct: false,
    placed_at: '2026-07-19T12:10:00.000Z', resolved_at: '2026-07-19T13:05:00.000Z',
  },
  {
    id: 503, game_id: FINISHED_GAME_ID, player_id: PLAYER_A.id, tournament_id: TOURNAMENT_ID,
    bet_type: 'run_line', target_entity: null, chosen_side: 'home', odds: 120, line: 3,
    predicted_probability: 0.45, wager_dollars: 12, potential_payout_dollars: 14.4,
    status: 'void', result_correct: null,
    placed_at: '2026-07-19T12:20:00.000Z', resolved_at: '2026-07-19T13:10:00.000Z',
  },
  {
    id: 504, game_id: FINISHED_GAME_ID, player_id: PLAYER_A.id, tournament_id: TOURNAMENT_ID,
    bet_type: 'hit_prop', target_entity: 'Mario (Aidan)', chosen_side: 'over', odds: 140, line: 1.5,
    predicted_probability: 0.42, wager_dollars: 20, potential_payout_dollars: 28,
    status: 'won', result_correct: true,
    placed_at: '2026-07-19T12:30:00.000Z', resolved_at: '2026-07-19T13:15:00.000Z',
  },
  {
    id: 505, game_id: GAME_ID, player_id: PLAYER_A.id, tournament_id: TOURNAMENT_ID,
    bet_type: 'hr_prop', target_entity: 'Mario (Aidan)', chosen_side: 'over', odds: 200, line: 0.5,
    predicted_probability: 0.33, wager_dollars: 8, potential_payout_dollars: 16,
    status: 'open', result_correct: null,
    placed_at: '2026-07-21T11:00:00.000Z', resolved_at: null,
  },
  {
    id: 506, game_id: GAME_ID, player_id: PLAYER_A.id, tournament_id: TOURNAMENT_ID,
    bet_type: 'moneyline', target_entity: null, chosen_side: 'away', odds: 120, line: null,
    predicted_probability: 0.45, wager_dollars: 10, potential_payout_dollars: 12,
    status: 'open', result_correct: null,
    placed_at: '2026-07-21T12:00:00.000Z', resolved_at: null,
  },
]

// One placement debit per ticket; settlement entries only where the ledger
// really holds one. Ticket 504 deliberately has no settlement entry.
const MY_LEDGER = [
  { id: 601, player_id: PLAYER_A.id, game_id: FINISHED_GAME_ID, bet_id: 501, tournament_id: TOURNAMENT_ID, reason: 'bet_placed:moneyline:home', points_change: -25, created_at: '2026-07-19T12:00:01.000Z' },
  { id: 602, player_id: PLAYER_A.id, game_id: FINISHED_GAME_ID, bet_id: 501, tournament_id: TOURNAMENT_ID, reason: 'bet_settled:moneyline:home', points_change: 62.5, created_at: '2026-07-19T13:00:05.000Z' },
  { id: 603, player_id: PLAYER_A.id, game_id: FINISHED_GAME_ID, bet_id: 502, tournament_id: TOURNAMENT_ID, reason: 'bet_placed:over_under:over', points_change: -30, created_at: '2026-07-19T12:10:01.000Z' },
  { id: 604, player_id: PLAYER_A.id, game_id: FINISHED_GAME_ID, bet_id: 503, tournament_id: TOURNAMENT_ID, reason: 'bet_placed:run_line:home', points_change: -12, created_at: '2026-07-19T12:20:01.000Z' },
  { id: 605, player_id: PLAYER_A.id, game_id: FINISHED_GAME_ID, bet_id: 503, tournament_id: TOURNAMENT_ID, reason: 'bet_settled:run_line:home', points_change: 12, created_at: '2026-07-19T13:10:05.000Z' },
  { id: 606, player_id: PLAYER_A.id, game_id: FINISHED_GAME_ID, bet_id: 504, tournament_id: TOURNAMENT_ID, reason: 'bet_placed:hit_prop:over', points_change: -20, created_at: '2026-07-19T12:30:01.000Z' },
  { id: 607, player_id: PLAYER_A.id, game_id: GAME_ID, bet_id: 505, tournament_id: TOURNAMENT_ID, reason: 'bet_placed:hr_prop:over', points_change: -8, created_at: '2026-07-21T11:00:01.000Z' },
  { id: 608, player_id: PLAYER_A.id, game_id: GAME_ID, bet_id: 506, tournament_id: TOURNAMENT_ID, reason: 'bet_placed:moneyline:away', points_change: -10, created_at: '2026-07-21T12:00:01.000Z' },
]

// Mario went 2-for-3 in the finished game (one of them a home run), which is
// what settles ticket 504 and what the hit-prop research card reports.
const FINISHED_GAME_PAS = [
  { id: 701, game_id: FINISHED_GAME_ID, player_id: PLAYER_A.id, character_id: 11, pa_number: 1, inning: 1, result: '1B', rbi: 0, created_at: '2026-07-19T12:31:00.000Z' },
  { id: 702, game_id: FINISHED_GAME_ID, player_id: PLAYER_A.id, character_id: 11, pa_number: 2, inning: 2, result: 'HR', rbi: 2, created_at: '2026-07-19T12:32:00.000Z' },
  { id: 703, game_id: FINISHED_GAME_ID, player_id: PLAYER_A.id, character_id: 11, pa_number: 3, inning: 3, result: 'K', rbi: 0, created_at: '2026-07-19T12:33:00.000Z' },
  { id: 704, game_id: FINISHED_GAME_ID, player_id: PLAYER_B.id, character_id: 21, pa_number: 4, inning: 1, result: 'HR', rbi: 3, created_at: '2026-07-19T12:34:00.000Z' },
]

const FINISHED_GAME_STINTS = [
  { id: 801, game_id: FINISHED_GAME_ID, player_id: PLAYER_B.id, character_id: 22, innings_pitched: 3, strikeouts: 4, created_at: '2026-07-19T12:31:00.000Z' },
]

const PROP_ODDS = [
  oddsRow({ id: 5, bet_type: 'hit_prop', target_entity: 'Mario (Aidan)', line: 1.5, odds_over: 130, odds_under: -160, predicted_probability: 0.41 }),
  oddsRow({ id: 6, bet_type: 'hr_prop', target_entity: 'Mario (Aidan)', line: 0.5, odds_over: 240, odds_under: -320, predicted_probability: 0.28 }),
  oddsRow({ id: 7, bet_type: 'k_prop', target_entity: 'Daisy (Donovan)', line: 3.5, odds_over: -105, odds_under: -115, predicted_probability: 0.5 }),
]

// Three recorded observations on the live game's moneyline, one of which also
// moves the total's line — the two must not be read as one series.
const ODDS_HISTORY = [
  {
    id: 1, game_id: GAME_ID, game_odds_id: 1, bet_type: 'moneyline', target_entity: null,
    previous_observation_id: null, line: null, odds_home: -120, odds_away: 100,
    predicted_probability: 0.545, is_locked: false, inning: 1, is_top_inning: true,
    away_score: 0, home_score: 0, game_status: 'active', source: 'tracker_sync',
    observed_at: '2026-07-21T10:00:00.000Z',
  },
  {
    id: 2, game_id: GAME_ID, game_odds_id: 1, bet_type: 'moneyline', target_entity: null,
    previous_observation_id: 1, line: null, odds_home: -135, odds_away: 112,
    predicted_probability: 0.565, is_locked: false, inning: 1, is_top_inning: false,
    away_score: 0, home_score: 1, game_status: 'active', source: 'tracker_sync',
    observed_at: '2026-07-21T10:20:00.000Z',
  },
  {
    id: 3, game_id: GAME_ID, game_odds_id: 1, bet_type: 'moneyline', target_entity: null,
    previous_observation_id: 2, line: null, odds_home: -140, odds_away: 120,
    predicted_probability: 0.58, is_locked: false, inning: 2, is_top_inning: true,
    away_score: 1, home_score: 0, game_status: 'active', source: 'tracker_sync',
    observed_at: '2026-07-21T10:40:00.000Z',
  },
  {
    id: 4, game_id: GAME_ID, game_odds_id: 3, bet_type: 'over_under', target_entity: null,
    previous_observation_id: null, line: 5.5, odds_over: -115, odds_under: -105,
    predicted_probability: 0.52, is_locked: false, inning: 1, is_top_inning: true,
    away_score: 0, home_score: 0, game_status: 'active', source: 'tracker_sync',
    observed_at: '2026-07-21T10:00:00.000Z',
  },
  {
    id: 5, game_id: GAME_ID, game_odds_id: 3, bet_type: 'over_under', target_entity: null,
    previous_observation_id: 4, line: 6.5, odds_over: -110, odds_under: -110,
    predicted_probability: 0.5, is_locked: false, inning: 2, is_top_inning: true,
    away_score: 1, home_score: 0, game_status: 'active', source: 'tracker_sync',
    observed_at: '2026-07-21T10:40:00.000Z',
  },
]

function finishedGame() {
  return {
    id: FINISHED_GAME_ID,
    tournament_id: TOURNAMENT_ID,
    team_a_player_id: PLAYER_A.id,
    team_b_player_id: PLAYER_B.id,
    team_a_runs: 3,
    team_b_runs: 6,
    winner_player_id: PLAYER_B.id,
    status: 'complete',
    innings: 3,
    stadium_id: 1,
    is_night: false,
    current_inning: 3,
    is_top_inning: false,
    game_code: 'AID @ DON',
    created_at: '2026-07-19T12:00:00.000Z',
  }
}

// `extraTickets` pads the history so the ticket list has to paginate.
function padTickets(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 900 + index,
    game_id: FINISHED_GAME_ID,
    player_id: PLAYER_A.id,
    tournament_id: TOURNAMENT_ID,
    bet_type: 'moneyline',
    target_entity: null,
    chosen_side: index % 2 === 0 ? 'home' : 'away',
    odds: index % 2 === 0 ? 150 : -150,
    line: null,
    predicted_probability: 0.5,
    wager_dollars: 1,
    potential_payout_dollars: index % 2 === 0 ? 1.5 : 0.67,
    status: index % 2 === 0 ? 'won' : 'lost',
    result_correct: index % 2 === 0,
    placed_at: `2026-07-18T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    resolved_at: `2026-07-18T${String(index % 24).padStart(2, '0')}:30:00.000Z`,
  }))
}

export const MY_BETS_TOTALS = {
  openExposure: '$18.00',
  openPotentialReturn: '$46.00',
  settledNetProfit: '+$35.50',
  settledWagered: '$87.00',
  atRiskWagered: '$75.00',
  roi: '47.3%',
  record: '2 / 1 / 1',
}

export function buildMyBetsFixture({ oddsHistoryAvailable = true, extraTickets = 0 } = {}) {
  const base = buildUiFixture({ odds: [...BOARD_ODDS, ...PROP_ODDS] })
  const tickets = [...MY_TICKETS, ...padTickets(extraTickets)]

  return {
    ...base,
    tournaments: [base.tournament],
    failures: oddsHistoryAvailable ? [] : [{
      table: 'game_odds_history',
      mode: 'before',
      times: 200,
      error: { code: 'PGRST205', message: "Could not find the table 'public.game_odds_history' in the schema cache" },
    }],
    tables: {
      ...base.tables,
      games: [...base.tables.games, finishedGame()],
      bets: tickets,
      points_ledger: [...base.tables.points_ledger, ...MY_LEDGER],
      plate_appearances: [...base.tables.plate_appearances, ...FINISHED_GAME_PAS],
      pitching_stints: [...base.tables.pitching_stints, ...FINISHED_GAME_STINTS],
      game_odds_history: oddsHistoryAvailable ? ODDS_HISTORY : [],
    },
  }
}

// ── The same world, in season tables ─────────────────────────────────────────
//
// Season and tournament are parallel table sets and BettingTab renders the same
// component against either. Both competitions deliberately reuse game ids 76/77
// and source id 5, because that is what proves the two never cross-select.
const AWAY_TEAM_ID = 101
const HOME_TEAM_ID = 102
const SEASON_ID = TOURNAMENT_ID

function toSeasonGame(game) {
  return {
    id: game.id,
    season_id: SEASON_ID,
    away_team_id: AWAY_TEAM_ID,
    home_team_id: HOME_TEAM_ID,
    away_score: game.team_a_runs,
    home_score: game.team_b_runs,
    winner_team_id: game.winner_player_id === PLAYER_B.id ? HOME_TEAM_ID
      : game.winner_player_id === PLAYER_A.id ? AWAY_TEAM_ID : null,
    status: game.status === 'complete' ? 'completed' : 'in_progress',
    innings: game.innings,
    stadium: 'Mario Stadium',
    is_night: false,
    current_inning: game.current_inning,
    is_top_inning: game.is_top_inning,
    round_number: 1,
    game_code: game.game_code,
    created_at: game.created_at || '2026-07-19T12:00:00.000Z',
  }
}

export function buildSeasonMyBetsFixture(options = {}) {
  const base = buildMyBetsFixture(options)
  const seasonBets = base.tables.bets.map(({ tournament_id: _tournamentId, ...bet }) => ({ ...bet, season_id: SEASON_ID }))
  const seasonLedger = base.tables.points_ledger
    .filter((row) => row.bet_id != null)
    .map(({ tournament_id: _tournamentId, points_change: change, ...row }) => ({
      ...row, season_id: SEASON_ID, dollars_change: change,
    }))

  return {
    ...base,
    tournament: null,
    tournaments: [],
    season: { id: SEASON_ID, name: 'Fixture Season', innings: 3, games_per_matchup: 1 },
    allSeasons: [{ id: SEASON_ID, name: 'Fixture Season' }],
    seasonTeams: [
      { id: AWAY_TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_A.id, team_name: 'Aidan Aces', team_mascot: 'Aces' },
      { id: HOME_TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_B.id, team_name: 'Donovan Dukes', team_mascot: 'Dukes' },
    ],
    failures: (base.failures || []).map((rule) => (
      rule.table === 'game_odds_history' ? { ...rule, table: 'season_game_odds_history' } : rule
    )),
    tables: {
      players: base.tables.players,
      characters: base.tables.characters,
      stadiums: base.tables.stadiums,
      odds_engine_weights: base.tables.odds_engine_weights,
      player_sips: [],
      sip_transactions: [],
      sip_redemptions: [],
      balance_awards: [],
      season_teams: [
        { id: AWAY_TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_A.id, team_name: 'Aidan Aces', team_mascot: 'Aces' },
        { id: HOME_TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_B.id, team_name: 'Donovan Dukes', team_mascot: 'Dukes' },
      ],
      season_schedule: base.tables.games.map(toSeasonGame),
      season_roster: [
        { id: 1, season_id: SEASON_ID, team_id: AWAY_TEAM_ID, character_name: 'Mario', created_at: '2026-07-01T00:00:00.000Z' },
        { id: 2, season_id: SEASON_ID, team_id: AWAY_TEAM_ID, character_name: 'Luigi', created_at: '2026-07-01T00:01:00.000Z' },
        { id: 3, season_id: SEASON_ID, team_id: HOME_TEAM_ID, character_name: 'Peach', created_at: '2026-07-01T00:02:00.000Z' },
        { id: 4, season_id: SEASON_ID, team_id: HOME_TEAM_ID, character_name: 'Daisy', created_at: '2026-07-01T00:03:00.000Z' },
      ],
      season_plate_appearances: base.tables.plate_appearances,
      season_pitching_stints: base.tables.pitching_stints,
      season_pitches: [],
      season_runs_scored: base.tables.runs_scored,
      season_tracker_live_stats: base.tables.tracker_live_stats,
      season_game_odds: base.tables.game_odds,
      season_bets: seasonBets,
      season_game_settlements: [],
      season_stadium_game_log: [],
      season_betting_ledger: seasonLedger,
      season_game_odds_history: base.tables.game_odds_history,
      // Deliberately populated with the tournament rows: if the season view
      // ever read these, the numbers would double.
      games: base.tables.games,
      bets: base.tables.bets,
      points_ledger: base.tables.points_ledger,
      game_odds: base.tables.game_odds,
      game_odds_history: base.tables.game_odds_history,
      plate_appearances: base.tables.plate_appearances,
      pitching_stints: base.tables.pitching_stints,
      season_lineups: [],
      season_game_fielders: [],
    },
  }
}
