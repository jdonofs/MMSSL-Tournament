import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveGameBets, resolveOnPA, resolveFirstInningNoRun, reopenGameBets, buildPlacedBetLedgerEntries } from '../src/utils/betResolution.js'
import {
  buildBettingEntityLabel,
  generateGameOdds,
  recalculateOdds,
  priceMarket,
  calculatePayout,
  DEFAULT_LIABILITY_CAP,
} from '../src/utils/oddsEngine.js'
import { supabase } from '../src/supabaseClient.js'
import { parseDollarWager, sanitizeDollarWagerInput, summarizeSlipWagers } from '../src/utils/bettingSlip.js'
import { buildSettleUpBalances, computeSettleUpAmount, hasSettleUpAssignments } from '../src/utils/settleUp.js'
import { createFakeSupabase } from './helpers/fakeSupabase.mjs'

const TOURNAMENT_ID = 5
const GAME_ID = 77

const BETTING_CONFIG = {
  enableCalibrationLogging: false,
  enableWeightAdjustment: false,
  sourceIdField: 'tournament_id',
  sourceIdValue: TOURNAMENT_ID,
}

async function withFakeSupabase(initialTables, run) {
  const fake = createFakeSupabase(initialTables)
  const original = {
    auth: supabase.auth,
    from: supabase.from,
    rpc: supabase.rpc,
    channel: supabase.channel,
    removeChannel: supabase.removeChannel,
    removeAllChannels: supabase.removeAllChannels,
  }

  Object.assign(supabase, fake)
  try {
    await run(fake.db)
  } finally {
    Object.assign(supabase, original)
  }
}

function makeBet(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    game_id: GAME_ID,
    player_id: overrides.player_id ?? 'p1',
    tournament_id: TOURNAMENT_ID,
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

function makePlacementLedger(bets) {
  return buildPlacedBetLedgerEntries(bets, BETTING_CONFIG)
}

test('buildPlacedBetLedgerEntries debits wagers with the expected source metadata', () => {
  const rows = buildPlacedBetLedgerEntries([
    makeBet({ id: 10, player_id: 'p1', wager_dollars: 12.5, bet_type: 'moneyline', chosen_side: 'away' }),
  ], BETTING_CONFIG)

  assert.deepEqual(rows, [
    {
      player_id: 'p1',
      game_id: GAME_ID,
      bet_id: 10,
      tournament_id: TOURNAMENT_ID,
      reason: 'bet_placed:moneyline:away',
      points_change: -12.5,
    },
  ])
})

test('resolveOnPA settles first-inning-run yes/no bets once a later play confirms a first-inning run', async () => {
  const yesBet = makeBet({ id: 1, bet_type: 'first_inning_run', chosen_side: 'yes', potential_payout_dollars: 9 })
  const noBet = makeBet({ id: 2, player_id: 'p2', bet_type: 'first_inning_run', chosen_side: 'no', potential_payout_dollars: 11 })

  await withFakeSupabase({
    bets: [yesBet, noBet],
    game_odds: [{ id: 9, game_id: GAME_ID, bet_type: 'first_inning_run', target_entity: null, is_locked: false }],
    points_ledger: makePlacementLedger([yesBet, noBet]),
    runs_scored: [{ id: 1, game_id: GAME_ID, pa_id: 10, inning: 1 }],
    plate_appearances: [],
  }, async (db) => {
    const updates = await resolveOnPA(GAME_ID, { id: 11, inning: 1 }, BETTING_CONFIG)

    assert.equal(updates.length, 2)
    assert.equal(db.bets.find((bet) => bet.id === 1).status, 'won')
    assert.equal(db.bets.find((bet) => bet.id === 2).status, 'lost')
    assert.equal(db.game_odds[0].is_locked, true)

    const settlementRows = db.points_ledger
      .filter((row) => row.reason.startsWith('bet_settled:'))
      .map(({ id, ...row }) => row)
    assert.deepEqual(settlementRows, [
      {
        player_id: 'p1',
        game_id: GAME_ID,
        bet_id: 1,
        tournament_id: TOURNAMENT_ID,
        reason: 'bet_settled:first_inning_run:yes',
        points_change: 19,
      },
    ])
  })
})

test('resolveFirstInningNoRun settles no-run bets and refunds the winning side after the placement debit', async () => {
  const yesBet = makeBet({ id: 1, bet_type: 'first_inning_run', chosen_side: 'yes' })
  const noBet = makeBet({ id: 2, player_id: 'p2', bet_type: 'first_inning_run', chosen_side: 'no', potential_payout_dollars: 8 })

  await withFakeSupabase({
    bets: [yesBet, noBet],
    game_odds: [{ id: 9, game_id: GAME_ID, bet_type: 'first_inning_run', target_entity: null, is_locked: false }],
    points_ledger: makePlacementLedger([yesBet, noBet]),
  }, async (db) => {
    const updates = await resolveFirstInningNoRun(GAME_ID, BETTING_CONFIG)

    assert.equal(updates.length, 2)
    assert.equal(db.bets.find((bet) => bet.id === 1).status, 'lost')
    assert.equal(db.bets.find((bet) => bet.id === 2).status, 'won')
    assert.equal(db.game_odds[0].is_locked, true)

    const settlementRows = db.points_ledger
      .filter((row) => row.reason.startsWith('bet_settled:'))
      .map(({ id, ...row }) => row)
    assert.deepEqual(settlementRows, [
      {
        player_id: 'p2',
        game_id: GAME_ID,
        bet_id: 2,
        tournament_id: TOURNAMENT_ID,
        reason: 'bet_settled:first_inning_run:no',
        points_change: 18,
      },
    ])
  })
})

test('resolveGameBets settles every supported market type and voids unknown markets', async () => {
  const bets = [
    makeBet({ id: 1, bet_type: 'moneyline', chosen_side: 'home' }),
    makeBet({ id: 2, player_id: 'p2', bet_type: 'moneyline', chosen_side: 'away' }),
    makeBet({ id: 3, bet_type: 'run_line', chosen_side: 'home', line: 1.5 }),
    makeBet({ id: 4, player_id: 'p2', bet_type: 'run_line', chosen_side: 'away', line: 1.5 }),
    makeBet({ id: 5, bet_type: 'over_under', chosen_side: 'over', line: 5.5 }),
    makeBet({ id: 6, player_id: 'p2', bet_type: 'over_under', chosen_side: 'under', line: 5.5 }),
    makeBet({ id: 7, bet_type: 'k_prop', target_entity: 'Pitcher One', chosen_side: 'over', line: 4.5 }),
    makeBet({ id: 8, player_id: 'p2', bet_type: 'k_prop', target_entity: 'Pitcher One', chosen_side: 'under', line: 4.5 }),
    makeBet({ id: 9, bet_type: 'hr_prop', target_entity: 'Slugger', chosen_side: 'over', line: 0.5 }),
    makeBet({ id: 10, player_id: 'p2', bet_type: 'hr_prop', target_entity: 'Slugger', chosen_side: 'under', line: 0.5 }),
    makeBet({ id: 11, bet_type: 'hit_prop', target_entity: 'Contact', chosen_side: 'over', line: 1.5 }),
    makeBet({ id: 12, player_id: 'p2', bet_type: 'hit_prop', target_entity: 'Contact', chosen_side: 'under', line: 1.5 }),
    makeBet({ id: 13, bet_type: 'custom', chosen_side: 'yes' }),
  ]

  await withFakeSupabase({
    bets,
    points_ledger: makePlacementLedger(bets),
  }, async (db) => {
    await resolveGameBets(
      GAME_ID,
      'home',
      7,
      { 'Pitcher One': 5 },
      2,
      BETTING_CONFIG,
      { Slugger: 1 },
      { Contact: 2 },
    )

    const byId = Object.fromEntries(db.bets.map((bet) => [bet.id, bet]))
    assert.equal(byId[1].status, 'won')
    assert.equal(byId[2].status, 'lost')
    assert.equal(byId[3].status, 'won')
    assert.equal(byId[4].status, 'lost')
    assert.equal(byId[5].status, 'won')
    assert.equal(byId[6].status, 'lost')
    assert.equal(byId[7].status, 'won')
    assert.equal(byId[8].status, 'lost')
    assert.equal(byId[9].status, 'won')
    assert.equal(byId[10].status, 'lost')
    assert.equal(byId[11].status, 'won')
    assert.equal(byId[12].status, 'lost')
    assert.equal(byId[13].status, 'void')

    const voidSettlement = db.points_ledger.find((row) => row.bet_id === 13 && row.reason.startsWith('bet_settled:'))
    assert.equal(voidSettlement.points_change, 10)

    const losingSettlement = db.points_ledger.find((row) => row.bet_id === 2 && row.reason.startsWith('bet_settled:'))
    assert.equal(losingSettlement, undefined)
  })
})

test('resolveGameBets pushes (voids + refunds) moneyline/run_line/over_under bets on an exact tie instead of settling both sides as losers', async () => {
  const bets = [
    // Tied final score: winningSide is null.
    makeBet({ id: 1, bet_type: 'moneyline', chosen_side: 'home', wager_dollars: 10 }),
    makeBet({ id: 2, player_id: 'p2', bet_type: 'moneyline', chosen_side: 'away', wager_dollars: 10 }),
    // Integer alt run_line spread where the actual margin lands exactly on it.
    makeBet({ id: 3, bet_type: 'run_line', chosen_side: 'home', line: 2, wager_dollars: 10 }),
    makeBet({ id: 4, player_id: 'p2', bet_type: 'run_line', chosen_side: 'away', line: 2, wager_dollars: 10 }),
    // Integer alt total where the actual total lands exactly on it.
    makeBet({ id: 5, bet_type: 'over_under', chosen_side: 'over', line: 7, wager_dollars: 10 }),
    makeBet({ id: 6, player_id: 'p2', bet_type: 'over_under', chosen_side: 'under', line: 7, wager_dollars: 10 }),
  ]

  await withFakeSupabase({
    bets,
    points_ledger: makePlacementLedger(bets),
  }, async (db) => {
    await resolveGameBets(GAME_ID, null, 7, {}, 2, BETTING_CONFIG)

    const byId = Object.fromEntries(db.bets.map((bet) => [bet.id, bet]))
    for (const id of [1, 2, 3, 4, 5, 6]) {
      assert.equal(byId[id].status, 'void', `bet ${id} should push, not win/lose`)
      assert.equal(byId[id].result_correct, null)
    }

    // A push refunds the wager (the placement debit is reversed), unlike a
    // loss (no settlement row) or a win (wager + payout).
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const settlement = db.points_ledger.find((row) => row.bet_id === id && row.reason.startsWith('bet_settled:'))
      assert.equal(settlement.points_change, 10, `bet ${id} should be refunded its $10 wager`)
    }
  })
})

test('reopenGameBets reopens resolved markets, including first-inning-run bets, and removes settled ledger rows', async () => {
  const moneyline = makeBet({ id: 1, bet_type: 'moneyline', status: 'won', result_correct: true, resolved_at: '2026-07-20T12:05:00.000Z' })
  const firstInning = makeBet({ id: 2, player_id: 'p2', bet_type: 'first_inning_run', chosen_side: 'yes', status: 'lost', result_correct: false, resolved_at: '2026-07-20T12:05:00.000Z' })

  await withFakeSupabase({
    bets: [moneyline, firstInning],
    points_ledger: [
      ...makePlacementLedger([moneyline, firstInning]),
      {
        player_id: 'p1',
        game_id: GAME_ID,
        bet_id: 1,
        tournament_id: TOURNAMENT_ID,
        reason: 'bet_settled:moneyline:home',
        points_change: 25,
      },
      {
        player_id: 'p2',
        game_id: GAME_ID,
        bet_id: 2,
        tournament_id: TOURNAMENT_ID,
        reason: 'bet_settled:first_inning_run:yes',
        points_change: 10,
      },
    ],
  }, async (db) => {
    await reopenGameBets(GAME_ID, BETTING_CONFIG)

    db.bets.forEach((bet) => {
      assert.equal(bet.status, 'open')
      assert.equal(bet.result_correct, null)
      assert.equal(bet.resolved_at, null)
    })
    assert.equal(db.points_ledger.some((row) => row.reason.startsWith('bet_settled:')), false)
  })
})

test('generateGameOdds carries current in-game counts into generated prop markets', () => {
  const playersById = {
    p1: { id: 'p1', name: 'Aidan', color: '#fff' },
    p2: { id: 'p2', name: 'Donovan', color: '#000' },
  }
  const game = {
    id: 1,
    tournament_id: 9,
    team_a_player_id: 'p1',
    team_b_player_id: 'p2',
    team_a_runs: 1,
    team_b_runs: 2,
    current_inning: 2,
    stadium_id: null,
    is_night: false,
    status: 'active',
  }
  const mario = { id: 11, name: 'Mario', batting: 8, pitching: 3, fielding: 5, speed: 6 }
  const luigi = { id: 12, name: 'Luigi', batting: 5, pitching: 8, fielding: 6, speed: 6 }
  const peach = { id: 21, name: 'Peach', batting: 7, pitching: 4, fielding: 5, speed: 7 }
  const daisy = { id: 22, name: 'Daisy', batting: 4, pitching: 9, fielding: 5, speed: 7 }
  const marioLabel = buildBettingEntityLabel(mario, playersById.p1)
  const luigiLabel = buildBettingEntityLabel(luigi, playersById.p1)
  const peachLabel = buildBettingEntityLabel(peach, playersById.p2)
  const daisyLabel = buildBettingEntityLabel(daisy, playersById.p2)

  const awayRoster = [
    { ...mario, playerId: 'p1', playerName: 'Aidan', entityLabel: marioLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 2, hitsSoFar: 1, hrSoFar: 1, kSoFar: 0 },
    { ...luigi, playerId: 'p1', playerName: 'Aidan', entityLabel: luigiLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 0, hitsSoFar: 0, hrSoFar: 0, kSoFar: 1, isPitcher: true, isActivePitcher: true },
  ]
  const homeRoster = [
    { ...peach, playerId: 'p2', playerName: 'Donovan', entityLabel: peachLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 2, hitsSoFar: 1, hrSoFar: 0, kSoFar: 0 },
    { ...daisy, playerId: 'p2', playerName: 'Donovan', entityLabel: daisyLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 0, hitsSoFar: 0, hrSoFar: 0, kSoFar: 1, isPitcher: true, isActivePitcher: true },
  ]
  const history = {
    gamesPlayed: 1,
    winRate: 0.5,
    avg: 0.25,
    hitRate: 0.25,
    hrRate: 0.05,
    kRate: 0.2,
    strikeoutsPerInning: 1,
    strikeoutsPerGame: 3,
    plateAppearances: 20,
    avgDistance: 220,
    hardHitRate: 0.2,
    skillProfile: { skillScore: 0.55 },
  }
  const playerProps = {
    historicalByEntity: {},
    gameState: {
      inning: 2,
      paCount: 4,
      scoreDiff: 1,
      homePitcherId: 22,
      awayPitcherId: 12,
    },
    historicalTotals: { sampleSize: 1, average: 5, stdDev: 1.2 },
    headToHead: { homeWinRate: 0.5, awayWinRate: 0.5, gamesPlayed: 0 },
    runLineData: { margins: [1], historicalAvgMargin: 1, oneRunGameRate: 1, stdDev: 1 },
    totalInnings: 3,
    marketVolume: {},
  }

  const rows = generateGameOdds(game, homeRoster, awayRoster, history, history, playerProps)

  const marioHr = rows.find((row) => row.bet_type === 'hr_prop' && row.target_entity === marioLabel)
  const peachHit = rows.find((row) => row.bet_type === 'hit_prop' && row.target_entity === peachLabel)
  const luigiK = rows.find((row) => row.bet_type === 'k_prop' && row.target_entity === luigiLabel)

  assert.equal(marioHr.prop_current_count, 1)
  assert.equal(marioHr.line, 1.5)
  assert.equal(peachHit.prop_current_count, 1)
  assert.equal(peachHit.line, 1.5)
  assert.equal(luigiK.prop_current_count, 1)
  assert.ok(luigiK.line > luigiK.prop_current_count)
})

test('recalculateOdds locks first-inning-run markets after the window closes', () => {
  const changed = recalculateOdds([
    { id: 1, bet_type: 'first_inning_run', game_id: 1, is_locked: false, updated_at: '2026-07-20T12:00:00.000Z' },
  ], {
    liveState: { currentInning: 2 },
  })

  assert.deepEqual(changed, [
    { id: 1, bet_type: 'first_inning_run', game_id: 1, is_locked: true, updated_at: changed[0].updated_at },
  ])
})

test('recalculateOdds locks the previous pitcher strikeout market after a pitcher swap', () => {
  const playersById = {
    p1: { id: 'p1', name: 'Aidan', color: '#fff' },
    p2: { id: 'p2', name: 'Donovan', color: '#000' },
  }
  const mario = { id: 11, name: 'Mario', batting: 8, pitching: 6, fielding: 5, speed: 6 }
  const luigi = { id: 12, name: 'Luigi', batting: 5, pitching: 8, fielding: 6, speed: 6 }
  const peach = { id: 21, name: 'Peach', batting: 7, pitching: 4, fielding: 5, speed: 7 }
  const daisy = { id: 22, name: 'Daisy', batting: 4, pitching: 9, fielding: 5, speed: 7 }
  const marioLabel = buildBettingEntityLabel(mario, playersById.p1)
  const luigiLabel = buildBettingEntityLabel(luigi, playersById.p1)
  const peachLabel = buildBettingEntityLabel(peach, playersById.p2)
  const daisyLabel = buildBettingEntityLabel(daisy, playersById.p2)
  const game = {
    id: 1,
    tournament_id: 9,
    team_a_player_id: 'p1',
    team_b_player_id: 'p2',
    team_a_runs: 0,
    team_b_runs: 0,
    current_inning: 2,
    stadium_id: null,
    is_night: false,
    status: 'active',
  }
  const history = {
    gamesPlayed: 1,
    winRate: 0.5,
    avg: 0.25,
    hitRate: 0.25,
    hrRate: 0.05,
    kRate: 0.2,
    strikeoutsPerInning: 1,
    strikeoutsPerGame: 3,
    plateAppearances: 20,
    avgDistance: 220,
    hardHitRate: 0.2,
    skillProfile: { skillScore: 0.55 },
  }
  const playerProps = {
    historicalByEntity: {},
    gameState: {
      inning: 2,
      paCount: 0,
      scoreDiff: 0,
      homePitcherId: 22,
      awayPitcherId: 12,
    },
    historicalTotals: { sampleSize: 1, average: 5, stdDev: 1.2 },
    headToHead: { homeWinRate: 0.5, awayWinRate: 0.5, gamesPlayed: 0 },
    runLineData: { margins: [1], historicalAvgMargin: 1, oneRunGameRate: 1, stdDev: 1 },
    totalInnings: 3,
    marketVolume: {},
  }
  const currentContext = {
    game,
    homeRoster: [
      { ...peach, playerId: 'p2', playerName: 'Donovan', entityLabel: peachLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 0, hitsSoFar: 0, hrSoFar: 0, kSoFar: 0 },
      { ...daisy, playerId: 'p2', playerName: 'Donovan', entityLabel: daisyLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 0, hitsSoFar: 0, hrSoFar: 0, kSoFar: 0, isPitcher: true, isActivePitcher: true },
    ],
    awayRoster: [
      { ...mario, playerId: 'p1', playerName: 'Aidan', entityLabel: marioLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 0, hitsSoFar: 0, hrSoFar: 0, kSoFar: 0 },
      { ...luigi, playerId: 'p1', playerName: 'Aidan', entityLabel: luigiLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 0, hitsSoFar: 0, hrSoFar: 0, kSoFar: 0, isPitcher: true, isActivePitcher: true },
    ],
    homeHistorical: history,
    awayHistorical: history,
    playerProps,
  }
  const currentOdds = generateGameOdds(game, currentContext.homeRoster, currentContext.awayRoster, history, history, playerProps)
    .map((row, index) => ({ ...row, id: index + 1 }))

  const nextContext = {
    game,
    homeRoster: currentContext.homeRoster,
    awayRoster: [
      { ...mario, playerId: 'p1', playerName: 'Aidan', entityLabel: marioLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 0, hitsSoFar: 0, hrSoFar: 0, kSoFar: 0, isPitcher: true, isActivePitcher: true },
      { ...luigi, playerId: 'p1', playerName: 'Aidan', entityLabel: luigiLabel, skillProfile: { skillScore: 0.55 }, paSoFar: 0, hitsSoFar: 0, hrSoFar: 0, kSoFar: 0 },
    ],
    homeHistorical: history,
    awayHistorical: history,
    playerProps: {
      ...playerProps,
      gameState: { ...playerProps.gameState, awayPitcherId: 11 },
    },
  }
  const changes = recalculateOdds(currentOdds, {
    generationContext: nextContext,
    pitcherSwap: true,
  })

  const lockedOldPitcher = changes.find((row) => row.bet_type === 'k_prop' && row.target_entity === luigiLabel)
  assert.equal(lockedOldPitcher?.is_locked, true)
})

test('betting slip wager parsing and validation block zero-dollar or malformed tickets', () => {
  assert.equal(parseDollarWager('10'), 10)
  assert.equal(parseDollarWager('10.50'), 10.5)
  assert.equal(Number.isNaN(parseDollarWager('')), true)
  assert.equal(Number.isNaN(parseDollarWager('1.234')), true)
  assert.equal(Number.isNaN(parseDollarWager('-5')), true)

  assert.equal(sanitizeDollarWagerInput(''), '')
  assert.equal(sanitizeDollarWagerInput('10.5'), '10.5')
  assert.equal(sanitizeDollarWagerInput('10.555'), null)
  assert.equal(sanitizeDollarWagerInput('-1'), null)

  assert.deepEqual(
    summarizeSlipWagers([
      { wagerSips: '10' },
      { wagerSips: '5.25' },
    ]),
    { totalWager: 15.25, hasInvalidWager: false },
  )
  assert.deepEqual(
    summarizeSlipWagers([
      { wagerSips: '10' },
      { wagerSips: '0' },
    ]),
    { totalWager: 10, hasInvalidWager: true },
  )
})

test('settle-up only stays active while both winners and losers still have assignable balances', () => {
  const players = [
    { id: 'p1', name: 'Aidan' },
    { id: 'p2', name: 'Donovan' },
  ]
  const bets = [
    makeBet({ id: 1, player_id: 'p1', status: 'won', potential_payout_dollars: 15 }),
    makeBet({ id: 2, player_id: 'p2', status: 'lost', wager_dollars: 10 }),
  ]

  const initialBalances = buildSettleUpBalances(bets, [], players)
  assert.equal(hasSettleUpAssignments(initialBalances), true)
  assert.equal(computeSettleUpAmount(initialBalances[0].netAmount, initialBalances[1].netAmount), 10)

  const postSettlementBalances = buildSettleUpBalances(
    bets,
    [{ id: 1, game_id: GAME_ID, from_player_id: 'p2', to_player_id: 'p1', dollars: 10 }],
    players,
  )

  assert.deepEqual(postSettlementBalances, [
    { playerId: 'p1', name: 'Aidan', netAmount: 5 },
    { playerId: 'p2', name: 'Donovan', netAmount: 0 },
  ])
  assert.equal(hasSettleUpAssignments(postSettlementBalances), false)
})

function impliedProbabilityFromAmericanOdds(odds) {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100)
}

test('priceMarket never produces an arbitrageable two-sided board (implied probabilities always sum above 1)', () => {
  const fairProbabilities = [0.02, 0.1, 0.3, 0.5, 0.7, 0.9, 0.98]
  for (const fairProbabilityA of fairProbabilities) {
    const pricing = priceMarket(fairProbabilityA, { moneyA: 0, moneyB: 0 })
    const impliedA = impliedProbabilityFromAmericanOdds(pricing.oddsA)
    const impliedB = impliedProbabilityFromAmericanOdds(pricing.oddsB)
    assert.ok(
      impliedA + impliedB > 1,
      `fairProbabilityA=${fairProbabilityA}: implied ${impliedA}+${impliedB}=${impliedA + impliedB} should exceed 1 (house edge)`,
    )
  }
})

test('priceMarket suspends a side once liability exceeds the cap, and heavier money on one side shifts its own odds worse (never better)', () => {
  const balanced = priceMarket(0.5, { moneyA: 0, moneyB: 0, liabilityCap: DEFAULT_LIABILITY_CAP })
  assert.equal(balanced.isSuspended, false)

  const overCap = priceMarket(0.5, { moneyA: 0, moneyB: 0, liabilityA: DEFAULT_LIABILITY_CAP + 1, liabilityCap: DEFAULT_LIABILITY_CAP })
  assert.equal(overCap.isSuspended, true)

  const heavyOnA = priceMarket(0.5, { moneyA: 1000, moneyB: 0, liabilityCap: DEFAULT_LIABILITY_CAP })
  assert.ok(
    impliedProbabilityFromAmericanOdds(heavyOnA.oddsA) > impliedProbabilityFromAmericanOdds(balanced.oddsA),
    'heavy money on side A should make side A pay out relatively less (worse odds for new A bettors), not better',
  )
})

test('calculatePayout matches the American-odds formula both sides of even money', () => {
  assert.equal(calculatePayout(10, 150), 15)
  assert.equal(calculatePayout(10, -150), 6.67)
  assert.equal(calculatePayout(0, 150), 0)
  assert.equal(calculatePayout(10, 0), 0)
})
