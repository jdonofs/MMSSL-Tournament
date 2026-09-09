// Fixture identities and the in-memory database for the end-to-end tracker
// acceptance pass.
//
// TWO RECORDINGS, NEITHER OF THEM A LEAGUE GAME. Both saved sessions are
// unowned calibration exhibitions: their capture headers say
// `"note": "standalone preview (no database writes)"` with a null game_id, and
// no site game, player or team was ever attached to them. So every identity
// below is invented for this test and named so it cannot be mistaken for a
// real one -- the players are `acceptance-*`, the teams are `Acceptance ...`,
// and nothing here claims that a real league player batted in these innings.
// What the recordings supply is the tracker's own output; who owns it is
// fixture data.
//
// THE COMPETITIONS DELIBERATELY COLLIDE. The tournament game and the season
// game are both id 4242 inside competition 909, in one shared database, which
// is what makes "season and tournament identities stay isolated" a real
// assertion rather than an arrangement.

import fs from 'node:fs'
import path from 'node:path'

import { createTrackerFakeSupabase } from './trackerFakeSupabase.mjs'

export const GAME_ID = 4242
export const SOURCE_ID = 909

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', '..')

export const repoPath = (...parts) => path.join(REPO, ...parts)

// ── the two recordings ──────────────────────────────────────────────────────
//
// Each row is one played game with three saved artefacts that belong together:
// the tracker's own console log (the pipeline's input), the 60 Hz capture
// derived alongside it (postgame ingestion's input), and the workbook the
// tracker itself wrote when the game ended (the independent oracle -- it is
// never fed to the bridge).
//
// The pairing is by wall clock and is checked, not assumed: the capture stem
// carries the UTC instant the collector started, the session log's first line
// carries the UTC instant the log opened ~35 s earlier, and the log's last
// lines name the workbook the tracker saved.

export const RECORDINGS = {
  tournament: {
    competitionType: 'tournament',
    park: 'luigis_mansion',
    stadiumName: "Luigi's Mansion",
    trackerLog: repoPath('sluggers-stat-tracker-advanced-stats-dev', 'preview-sessions', 'preview-2026-09-04_13-10-49.log'),
    capture: repoPath('data', 'player_tracking', 'luigis_mansion-20260904T171123Z'),
    workbook: repoPath('sluggers-stat-tracker-advanced-stats-dev', 'output', 'Knights vs Spitballs - 2026-09-04 13-33-40.xlsx'),
    // "The Knights will bat first!" -- so the Knights are the away side, which
    // is side A on a site game row. The tracker's own header line prints the
    // two teams in the other order.
    away: {
      trackerTeam: 'Knights',
      scoreboardName: 'Luigi Knights',
      roster: ['Red Noki', 'Green Paratroopa', 'Blue Yoshi', 'Luigi', 'Monty Mole', 'Pink Yoshi', 'Paratroopa', 'Wario', 'Purple Toad'],
      // The starting alignment the game itself was set up from, as the
      // workbook's Game Info sheet records it. The site holds this before the
      // first pitch, which is what seedGameFieldersFromSiteLineup reads.
      fielding: {
        catcher: 'Red Noki', shortStop: 'Green Paratroopa', secondBase: 'Blue Yoshi',
        pitcher: 'Luigi', firstBase: 'Monty Mole', centerField: 'Pink Yoshi',
        rightField: 'Paratroopa', leftField: 'Wario', thirdBase: 'Purple Toad',
      },
    },
    home: {
      trackerTeam: 'Spitballs',
      scoreboardName: 'Waluigi Spitballs',
      roster: ['Blooper', 'Blue Pianta', 'Yellow Magikoopa', 'Red Pianta', 'Brown Kritter', 'Shy Guy', 'Paragoomba', 'Waluigi', 'Bowser'],
      fielding: {
        pitcher: 'Blooper', firstBase: 'Blue Pianta', shortStop: 'Yellow Magikoopa',
        thirdBase: 'Red Pianta', secondBase: 'Brown Kritter', catcher: 'Shy Guy',
        leftField: 'Paragoomba', centerField: 'Waluigi', rightField: 'Bowser',
      },
    },
  },
  season: {
    competitionType: 'season',
    park: 'peach_ice_garden',
    stadiumName: 'Peach Ice Garden',
    trackerLog: repoPath('sluggers-stat-tracker-advanced-stats-dev', 'preview-sessions', 'preview-2026-09-04_11-21-37.log'),
    capture: repoPath('data', 'player_tracking', 'peach_ice_garden-20260904T152214Z'),
    workbook: repoPath('sluggers-stat-tracker-advanced-stats-dev', 'output', 'Fireballs vs DK Wilds - 2026-09-04 11-47-26.xlsx'),
    away: {
      trackerTeam: 'Fireballs',
      scoreboardName: 'Mario Fireballs',
      // The tracker spells this "Light Blue Yoshi"; the site's characters table
      // spells it "Light-Blue Yoshi". Resolving that is characterNames.js's job
      // and the fixture deliberately does not pre-resolve it.
      roster: ['Light-Blue Yoshi', 'Blue Noki', 'Paratroopa', 'Dixie Kong', 'Green Toad', 'Red Kritter', 'Green Noki', 'Pink Yoshi', 'Petey Piranha'],
      fielding: {
        pitcher: 'Light-Blue Yoshi', firstBase: 'Blue Noki', secondBase: 'Paratroopa',
        shortStop: 'Dixie Kong', rightField: 'Green Toad', leftField: 'Red Kritter',
        thirdBase: 'Green Noki', centerField: 'Pink Yoshi', catcher: 'Petey Piranha',
      },
    },
    home: {
      trackerTeam: 'DK Wilds',
      scoreboardName: 'DK Wilds',
      roster: ['Baby Luigi', 'Blue Pianta', 'Blue Toad', 'Donkey Kong', 'Dry Bones', 'Blue Dry Bones', 'Gray Shy Guy', 'Green Magikoopa', 'Tiny Kong'],
      fielding: {
        firstBase: 'Baby Luigi', shortStop: 'Blue Pianta', leftField: 'Blue Toad',
        pitcher: 'Donkey Kong', rightField: 'Dry Bones', secondBase: 'Blue Dry Bones',
        centerField: 'Gray Shy Guy', thirdBase: 'Green Magikoopa', catcher: 'Tiny Kong',
      },
    },
  },
}

// ── fixture identities ──────────────────────────────────────────────────────

export const PLAYERS = {
  tournamentAway: { id: 'acceptance-t-away', name: 'Acceptance Knights GM' },
  tournamentHome: { id: 'acceptance-t-home', name: 'Acceptance Spitballs GM' },
  seasonAway: { id: 'acceptance-s-away', name: 'Acceptance Fireballs GM' },
  seasonHome: { id: 'acceptance-s-home', name: 'Acceptance Wilds GM' },
}

export const SEASON_TEAMS = {
  away: { id: 'acceptance-s-away-team', team_name: 'Acceptance Fireballs' },
  home: { id: 'acceptance-s-home-team', team_name: 'Acceptance Wilds' },
}

export const STADIUMS = [
  { id: 8101, name: "Luigi's Mansion", hr_factor: 1, scoring_factor: 1 },
  { id: 8102, name: 'Peach Ice Garden', hr_factor: 1, scoring_factor: 1 },
]

// public.characters.name, the same canonical list tests/character-names.test.mjs
// pins. All 72 are here rather than only the 33 these two recordings field,
// because postgame ingestion translates the GAME's character ids through this
// table and a short table would quietly change what it can resolve.
//
// The ids are fixture ids and mean nothing outside this suite. Paratroopa,
// Pink Yoshi and Blue Pianta appear in BOTH games on different teams, which is
// what the character-career isolation check needs.
export const CHARACTER_NAMES = [
  'Baby Daisy', 'Baby DK', 'Baby Luigi', 'Baby Mario', 'Baby Peach', 'Birdo',
  'Blooper', 'Blue Dry Bones', 'Blue Kritter', 'Blue Noki', 'Blue Pianta',
  'Blue Shy Guy', 'Blue Toad', 'Blue Yoshi', 'Boo', 'Boomerang Bro', 'Bowser',
  'Bowser Jr.', 'Brown Kritter', 'Daisy', 'Dark Bones', 'Diddy Kong',
  'Dixie Kong', 'Donkey Kong', 'Dry Bones', 'Fire Bro', 'Funky Kong',
  'Goomba', 'Gray Shy Guy', 'Green Dry Bones', 'Green Magikoopa',
  'Green Noki', 'Green Paratroopa', 'Green Shy Guy', 'Green Toad',
  'Hammer Bro', 'King Boo', 'King K. Rool', 'Koopa', 'Kritter',
  'Light-Blue Yoshi', 'Luigi', 'Magikoopa', 'Mario', 'Mii', 'Monty Mole',
  'Paragoomba', 'Paratroopa', 'Peach', 'Petey Piranha', 'Pink Yoshi',
  'Purple Toad', 'Red Koopa', 'Red Kritter', 'Red Magikoopa', 'Red Noki',
  'Red Pianta', 'Red Toad', 'Red Yoshi', 'Shy Guy', 'Tiny Kong', 'Toadette',
  'Toadsworth', 'Waluigi', 'Wario', 'Wiggler', 'Yellow Magikoopa',
  'Yellow Pianta', 'Yellow Shy Guy', 'Yellow Toad', 'Yellow Yoshi', 'Yoshi',
]

export const CHARACTER_ID_BY_NAME = Object.fromEntries(
  CHARACTER_NAMES.map((name, index) => [name, 7000 + index]),
)

const CHARACTERS = CHARACTER_NAMES.map((name) => ({
  id: CHARACTER_ID_BY_NAME[name],
  name,
  batting: 5, pitching: 5, fielding: 5, speed: 5,
  slap_contact: 5, charge_contact: 5, slap_power: 5, charge_power: 5,
  bunting: 5, run_speed: 5, throwing_speed: 5, fielding_stat: 5,
  curveball_speed: 5, fastball_speed: 5, curve: 5, stamina: 5,
  character_class: 'Balanced',
}))

// Unique keys the real schema is expected to hold. The fake enforces them, so
// a client that only avoids duplicates by luck shows up as a duplicate-key
// error rather than as a second row.
export const ACCEPTANCE_UNIQUE_KEYS = {
  // tracker_event_key is the identity a plate appearance with no contact has,
  // and the only one: 20260908120000_tracker_durable_identities.sql adds the
  // column and the index, and this mirrors it so the offline replay is held to
  // the same rule the database now holds.
  plate_appearances: [['game_id', 'pa_number'], ['game_id', 'tracker_contact_seq'],
    ['game_id', 'tracker_event_key']],
  season_plate_appearances: [['game_id', 'pa_number'], ['game_id', 'tracker_contact_seq'],
    ['game_id', 'tracker_event_key']],
  pitches: [['pa_id', 'pitch_number_pa']],
  season_pitches: [['pa_id', 'pitch_number_pa']],
  runs_scored: [['pa_id', 'scoring_player_id', 'scoring_character_id']],
  season_runs_scored: [['pa_id', 'scoring_player_id', 'scoring_character_id']],
  tracking_sessions: [['competition_type', 'game_id', 'raw_stem']],
  tracking_plays: [['tracking_session_id', 'play_ordinal']],
  fielding_opportunities: [['tracking_play_id', 'position']],
  movement_metrics: [['tracking_play_id', 'actor_type', 'actor_slot']],
  tracking_throws: [['tracking_play_id', 'throw_sequence']],
  game_odds: [['game_id', 'bet_type', 'target_entity']],
  season_game_odds: [['game_id', 'bet_type', 'target_entity']],
  points_ledger: [['bet_id', 'reason']],
  season_betting_ledger: [['bet_id', 'reason']],
  tracker_game_leases: [['competition_type', 'game_id']],
  tracker_unresolved_plays: [['competition_type', 'game_id', 'tracker_event_key']],
}

function draftPicks() {
  const rows = []
  let id = 9000
  RECORDINGS.tournament.away.roster.forEach((name) => {
    rows.push({ id: id += 1, tournament_id: SOURCE_ID, player_id: PLAYERS.tournamentAway.id, character_id: CHARACTER_ID_BY_NAME[name], pick_number: rows.length + 1 })
  })
  RECORDINGS.tournament.home.roster.forEach((name) => {
    rows.push({ id: id += 1, tournament_id: SOURCE_ID, player_id: PLAYERS.tournamentHome.id, character_id: CHARACTER_ID_BY_NAME[name], pick_number: rows.length + 1 })
  })
  return rows
}

function seasonRoster() {
  const rows = []
  let id = 9500
  RECORDINGS.season.away.roster.forEach((character_name) => {
    rows.push({ id: id += 1, season_id: SOURCE_ID, team_id: SEASON_TEAMS.away.id, character_name, is_active: true })
  })
  RECORDINGS.season.home.roster.forEach((character_name) => {
    rows.push({ id: id += 1, season_id: SOURCE_ID, team_id: SEASON_TEAMS.home.id, character_name, is_active: true })
  })
  return rows
}

function lineupRows(recording, sourceField, playerIdFor) {
  return ['away', 'home'].map((side, index) => ({
    id: (sourceField === 'season_id' ? 9800 : 9700) + index,
    [sourceField]: SOURCE_ID,
    player_id: playerIdFor(side),
    lineup_order: recording[side].roster.map((name) => CHARACTER_ID_BY_NAME[name]),
    fielding_positions: Object.fromEntries(
      Object.entries(recording[side].fielding).map(([field, name]) => [field, CHARACTER_ID_BY_NAME[name]]),
    ),
  }))
}

// ── bets ────────────────────────────────────────────────────────────────────
//
// Placed before the game, priced by hand, and paired with the placement debit
// the real placement RPC writes. Every expected settlement in the acceptance
// test is arithmetic on these literal numbers -- see EXPECTED_SETTLEMENTS in
// tests/fixtures/tracker-acceptance-expected.json.

export function acceptanceBets(competitionType) {
  const sourceField = competitionType === 'season' ? 'season_id' : 'tournament_id'
  const bettor = competitionType === 'season' ? PLAYERS.seasonAway.id : PLAYERS.tournamentAway.id
  const base = {
    game_id: GAME_ID,
    player_id: bettor,
    [sourceField]: SOURCE_ID,
    status: 'open',
    placed_at: '2026-09-04T12:00:00.000Z',
    resolved_at: null,
    result_correct: null,
    predicted_probability: 0.5,
    game_odds_id: null,
    target_entity: null,
    line: null,
  }
  if (competitionType === 'season') {
    return [
      // DK Wilds (home) won 8-6: a home moneyline wins.
      { ...base, id: 6101, bet_type: 'moneyline', chosen_side: 'home', odds: -120, wager_dollars: 60, potential_payout_dollars: 50 },
      // 14 total runs, over 9.5 wins.
      { ...base, id: 6102, bet_type: 'over_under', chosen_side: 'over', line: 9.5, odds: 100, wager_dollars: 25, potential_payout_dollars: 25 },
      // Margin is 2, exactly the 2.0 line: a push, refunded.
      { ...base, id: 6103, bet_type: 'run_line', chosen_side: 'home', line: 2, odds: 110, wager_dollars: 40, potential_payout_dollars: 44 },
      // The away side lost.
      { ...base, id: 6104, bet_type: 'moneyline', chosen_side: 'away', odds: 150, wager_dollars: 20, potential_payout_dollars: 30 },
    ]
  }
  return [
    // Spitballs (home) won 12-6.
    { ...base, id: 6001, bet_type: 'moneyline', chosen_side: 'home', odds: -150, wager_dollars: 30, potential_payout_dollars: 20 },
    // 18 total runs, under 12.5 loses.
    { ...base, id: 6002, bet_type: 'over_under', chosen_side: 'under', line: 12.5, odds: 105, wager_dollars: 10, potential_payout_dollars: 10.5 },
    // Margin is 6, over the 4.5 line: the home run line covers.
    { ...base, id: 6003, bet_type: 'run_line', chosen_side: 'home', line: 4.5, odds: 120, wager_dollars: 15, potential_payout_dollars: 18 },
    // Exactly the total: a push on a whole-number line.
    { ...base, id: 6004, bet_type: 'over_under', chosen_side: 'over', line: 18, odds: -110, wager_dollars: 22, potential_payout_dollars: 20 },
  ]
}

export function placementLedger(competitionType, bets) {
  const sourceField = competitionType === 'season' ? 'season_id' : 'tournament_id'
  const changeField = competitionType === 'season' ? 'dollars_change' : 'points_change'
  return bets.map((bet, index) => ({
    id: (competitionType === 'season' ? 6600 : 6500) + index,
    player_id: bet.player_id,
    game_id: bet.game_id,
    bet_id: bet.id,
    [sourceField]: SOURCE_ID,
    reason: `bet_placed:${bet.bet_type}:${bet.chosen_side}`,
    [changeField]: -Number(bet.wager_dollars),
  }))
}

// ── the shared database ─────────────────────────────────────────────────────

export function buildAcceptanceTables() {
  const tournamentBets = acceptanceBets('tournament')
  const seasonBets = acceptanceBets('season')
  return {
    players: Object.values(PLAYERS).map((player) => ({ ...player, color: '#336699' })),
    characters: CHARACTERS,
    stadiums: STADIUMS,
    tournaments: [{ id: SOURCE_ID, tournament_number: 909, status: 'active', archived: false, created_at: '2026-09-04T00:00:00Z' }],
    seasons: [{ id: SOURCE_ID, name: 'Acceptance Season', status: 'active', created_at: '2026-09-04T00:00:00Z' }],
    season_teams: [
      { ...SEASON_TEAMS.away, season_id: SOURCE_ID, player_id: PLAYERS.seasonAway.id },
      { ...SEASON_TEAMS.home, season_id: SOURCE_ID, player_id: PLAYERS.seasonHome.id },
    ],
    games: [{
      id: GAME_ID,
      tournament_id: SOURCE_ID,
      status: 'pending',
      stats_source: 'tracker',
      team_a_player_id: PLAYERS.tournamentAway.id,
      team_b_player_id: PLAYERS.tournamentHome.id,
      team_a_runs: 0,
      team_b_runs: 0,
      winner_player_id: null,
      innings: 9,
      stadium_id: STADIUMS[0].id,
      is_night: true,
      current_inning: 1,
      is_top_inning: true,
      live_state: null,
      created_at: '2026-09-04T17:00:00Z',
    }],
    season_schedule: [{
      id: GAME_ID,
      season_id: SOURCE_ID,
      status: 'scheduled',
      stats_source: 'tracker',
      away_team_id: SEASON_TEAMS.away.id,
      home_team_id: SEASON_TEAMS.home.id,
      away_score: 0,
      home_score: 0,
      winner_team_id: null,
      innings: 9,
      stadium: 'Peach Ice Garden',
      is_night: false,
      current_inning: 1,
      is_top_inning: true,
      live_state: null,
      created_at: '2026-09-04T15:00:00Z',
    }],
    draft_picks: draftPicks(),
    season_roster: seasonRoster(),
    odds_engine_weights: [{
      id: 1, char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334,
      games_evaluated: 12, last_brier_score: 0.2,
    }],
    bets: tournamentBets,
    season_bets: seasonBets,
    points_ledger: placementLedger('tournament', tournamentBets),
    season_betting_ledger: placementLedger('season', seasonBets),
    game_odds: [],
    season_game_odds: [],
    stadium_game_log: [],
    season_stadium_game_log: [],
    lineups: [],
    season_lineups: [],
    game_fielders: [],
    season_game_fielders: [],
    plate_appearances: [],
    season_plate_appearances: [],
    pitches: [],
    season_pitches: [],
    runs_scored: [],
    season_runs_scored: [],
    pitching_stints: [],
    season_pitching_stints: [],
    team_lineups: lineupRows(RECORDINGS.tournament, 'tournament_id', (side) => (
      side === 'away' ? PLAYERS.tournamentAway.id : PLAYERS.tournamentHome.id
    )),
    season_team_lineups: lineupRows(RECORDINGS.season, 'season_id', (side) => (
      side === 'away' ? PLAYERS.seasonAway.id : PLAYERS.seasonHome.id
    )),
    tracker_live_stats: [],
    season_tracker_live_stats: [],
    tracking_sessions: [],
    tracking_plays: [],
    fielding_opportunities: [],
    movement_metrics: [],
    tracking_throws: [],
    runner_opportunities: [],
    double_play_opportunities: [],
  }
}

// A model of the three lease functions, over a table in the fake.
//
// WHAT IT IS FOR AND WHAT IT IS NOT EVIDENCE OF. The bridge now takes a
// database game lease at startup, renews it while the game runs, and releases
// it on the way out; without something to answer those calls a replay
// exercises only the "this deployment has no lease functions" branch. This
// answers them, so the acceptance replay covers the wiring.
//
// It is NOT evidence about the SQL. Row-level locking, the fencing epoch
// actually refusing a write, and expiry are properties of Postgres and are
// tested against a real one in tests/tracker-database-guarantees.test.mjs.
// This is a JavaScript object and could not establish any of them.
export function installAcceptanceLeaseFunctions(client, { now = () => Date.now() } = {}) {
  const leases = client.db.tracker_game_leases ||= []
  const find = (type, gameId) => leases.find(
    (row) => row.competition_type === type && String(row.game_id) === String(gameId))

  client.setRpcHandler('tracker_lease_acquire', (args) => {
    const existing = find(args.p_competition_type, args.p_game_id)
    const expiresAt = new Date(now() + args.p_ttl_seconds * 1000).toISOString()
    if (!existing) {
      const created = {
        competition_type: args.p_competition_type,
        game_id: args.p_game_id,
        owner_id: args.p_owner_id,
        owner_host: args.p_owner_host,
        owner_pid: args.p_owner_pid,
        owner_label: args.p_owner_label,
        epoch: 1,
        acquired_at: new Date(now()).toISOString(),
        renewed_at: new Date(now()).toISOString(),
        expires_at: expiresAt,
        released_at: null,
      }
      leases.push(created)
      return { granted: true, reason: 'acquired', lease: created }
    }
    if (existing.owner_id === args.p_owner_id && existing.released_at == null) {
      Object.assign(existing, { renewed_at: new Date(now()).toISOString(), expires_at: expiresAt })
      return { granted: true, reason: 'renewed', lease: existing }
    }
    const live = existing.released_at == null && new Date(existing.expires_at).getTime() > now()
    if (live && !args.p_takeover) {
      return { granted: false, reason: 'held', lease: existing }
    }
    const previousOwner = existing.owner_id
    Object.assign(existing, {
      owner_id: args.p_owner_id,
      owner_host: args.p_owner_host,
      owner_pid: args.p_owner_pid,
      owner_label: args.p_owner_label,
      epoch: Number(existing.epoch) + 1,
      acquired_at: new Date(now()).toISOString(),
      renewed_at: new Date(now()).toISOString(),
      expires_at: expiresAt,
      released_at: null,
    })
    return {
      granted: true,
      reason: live ? 'taken_over' : 'reclaimed_expired',
      previous_owner: previousOwner,
      lease: existing,
    }
  })

  client.setRpcHandler('tracker_lease_renew', (args) => {
    const existing = find(args.p_competition_type, args.p_game_id)
    if (!existing || existing.owner_id !== args.p_owner_id
        || Number(existing.epoch) !== Number(args.p_epoch) || existing.released_at != null) {
      return { granted: false, reason: 'not_the_owner', lease: existing || null }
    }
    Object.assign(existing, {
      renewed_at: new Date(now()).toISOString(),
      expires_at: new Date(now() + args.p_ttl_seconds * 1000).toISOString(),
    })
    return { granted: true, reason: 'renewed', lease: existing }
  })

  client.setRpcHandler('tracker_lease_release', (args) => {
    const existing = find(args.p_competition_type, args.p_game_id)
    if (!existing || existing.owner_id !== args.p_owner_id
        || Number(existing.epoch) !== Number(args.p_epoch) || existing.released_at != null) {
      return { released: false, lease: existing || null }
    }
    existing.released_at = new Date(now()).toISOString()
    existing.expires_at = existing.released_at
    return { released: true, lease: existing }
  })

  return client
}

// A model of the fenced game mutations, over the same tables.
//
// SAME CAVEAT AS THE LEASE FUNCTIONS ABOVE, and it matters more here: this is a
// JavaScript object and cannot establish that the assert and the write are one
// TRANSACTION, which is the whole guarantee
// 20260909120000_tracker_fenced_game_mutations.sql exists to add. That is
// tested against a real Postgres in tests/tracker-lease-fencing.test.mjs. What
// this establishes is the client half: that the bridge routes the live-state
// publish, the score, the completion and the unresolved-play record through
// these functions at all, and that a refusal from them stops the write instead
// of falling through to an ordinary update.
export function installAcceptanceGameMutationFunctions(client) {
  const leases = client.db.tracker_game_leases ||= []
  const tablesFor = (type) => (type === 'season'
    ? { games: 'season_schedule', stats: 'season_tracker_live_stats' }
    : { games: 'games', stats: 'tracker_live_stats' })

  // tracker_lease_assert, in the same order and with the same refusals.
  // Returns a PostgREST-shaped refusal rather than throwing, because that is
  // how the real client delivers a raised check_violation to the bridge.
  const refuse = (message) => ({ data: null, error: { code: '23514', message } })
  const leaseRefusal = (args) => {
    const lease = leases.find((row) => row.competition_type === args.p_competition_type
      && String(row.game_id) === String(args.p_game_id))
    if (args.p_owner_id == null) {
      if (!String(args.p_unleased_intent || '').trim()) {
        return refuse(`unleased tracker write refused for ${args.p_competition_type} game `
          + `${args.p_game_id}: a caller with no lease has to name why`)
      }
      return null
    }
    if (!lease) {
      return refuse(`no tracker lease exists for ${args.p_competition_type} game ${args.p_game_id}`)
    }
    if (lease.owner_id !== args.p_owner_id || Number(lease.epoch) !== Number(args.p_epoch)
        || lease.released_at != null) {
      return refuse(`stale tracker lease: ${args.p_owner_id} epoch ${args.p_epoch} is not the `
        + `owner of ${args.p_competition_type} game ${args.p_game_id} `
        + `(owner ${lease.owner_id} epoch ${lease.epoch})`)
    }
    return null
  }

  const gameRow = (type, gameId) => (client.db[tablesFor(type).games] || []).find(
    (row) => String(row.id) === String(gameId))

  client.setRpcHandler('tracker_publish_live_state', (args) => {
    const refusal = leaseRefusal(args)
    if (refusal) return refusal
    const stats = client.db[tablesFor(args.p_competition_type).stats] ||= []
    const existing = stats.find((row) => String(row.game_id) === String(args.p_game_id))
    if (existing) Object.assign(existing, args.p_stats)
    else stats.push({ id: stats.length + 1, ...args.p_stats })
    const game = gameRow(args.p_competition_type, args.p_game_id)
    if (!game) return refuse(`${args.p_competition_type} game ${args.p_game_id} does not exist`)
    game.live_state = args.p_live_state
    return { published: true, games_updated: 1 }
  })

  client.setRpcHandler('tracker_apply_game_completion', (args) => {
    const refusal = leaseRefusal(args)
    if (refusal) return refusal
    const game = gameRow(args.p_competition_type, args.p_game_id)
    if (!game) return refuse(`${args.p_competition_type} game ${args.p_game_id} does not exist`)
    Object.assign(game, args.p_completion)
    return { updated: 1, game: { ...game } }
  })

  client.setRpcHandler('tracker_record_unresolved_play', (args) => {
    const refusal = leaseRefusal(args)
    if (refusal) return refusal
    const rows = client.db.tracker_unresolved_plays ||= []
    const key = args.p_payload?.tracker_event_key
    if (!key) return refuse('an unresolved play needs a tracker_event_key')
    const existing = rows.find((row) => row.competition_type === args.p_competition_type
      && String(row.game_id) === String(args.p_game_id) && row.tracker_event_key === key)
    if (existing) {
      if (existing.status !== 'open') {
        return { recorded: false, reason: 'resolved_by_operator', status: existing.status,
          play: { ...existing } }
      }
      Object.assign(existing, {
        reason: args.p_payload.reason,
        evidence: args.p_payload.evidence ?? existing.evidence,
        updated_at: args.p_payload.updated_at,
      })
      return { recorded: true, inserted: false, play: { ...existing } }
    }
    const created = { id: `unresolved-${rows.length + 1}`, ...args.p_payload }
    rows.push(created)
    return { recorded: true, inserted: true, play: { ...created } }
  })
  return client
}

export function buildAcceptanceWorld(options = {}) {
  const { lease = true, fencedMutations = true, ...rest } = options
  const client = createTrackerFakeSupabase(buildAcceptanceTables(), {
    unique: ACCEPTANCE_UNIQUE_KEYS,
    ...rest,
  })
  if (lease) installAcceptanceLeaseFunctions(client)
  // Defaults ON for the same reason the lease functions do: a world that
  // answers neither models a database nobody is running, and the degraded
  // branch is worth testing deliberately rather than by default.
  if (fencedMutations) installAcceptanceGameMutationFunctions(client)
  return client
}

// ── recording integrity ─────────────────────────────────────────────────────
//
// A pairing that has drifted is not a test failure worth debugging in the
// middle of a game replay, so it is checked before anything is replayed.

export function readRecordingPairing(recording) {
  const log = fs.readFileSync(recording.trackerLog, 'utf8')
  const header = log.slice(0, log.indexOf('\n'))
  const logStartedUtc = header.match(/session started (\S+)/)?.[1] || null
  const stem = path.basename(recording.capture)
  const captureUtc = stem.match(/-(\d{8}T\d{6}Z)$/)?.[1] || null
  const savedWorkbook = log.match(/Output saved to '([^']+)'/)?.[1] || null
  const captureHeader = JSON.parse(fs.readFileSync(`${recording.capture}.json`, 'utf8'))
  return { logStartedUtc, captureUtc, savedWorkbook, captureHeader, stem }
}

export function isoFromCaptureStamp(stamp) {
  const m = String(stamp).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null
}
