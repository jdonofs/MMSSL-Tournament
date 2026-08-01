import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function loadDotEnv() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const envPath = path.resolve(scriptDir, '..', '.env')
  const raw = fs.readFileSync(envPath, 'utf8')
  raw
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^([^=]+)=(.*)$/)
      if (!match) return
      const [, key, value] = match
      if (!process.env[key]) process.env[key] = value
    })
}

loadDotEnv()

const [{ createClient }, { buildPlacedBetLedgerEntries, resolveGameBets }] = await Promise.all([
  import('@supabase/supabase-js'),
  import('../src/utils/betResolution.js'),
])

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY)

function uniqueTournamentNumber() {
  return 900000 + Number(String(Date.now()).slice(-6))
}

async function must(queryPromise, label) {
  const { data, error } = await queryPromise
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

async function getPlayersByName(names) {
  const rows = await must(
    supabase.from('players').select('id,name').in('name', names),
    'load players',
  )
  const byName = Object.fromEntries((rows || []).map((row) => [row.name, row]))
  names.forEach((name) => {
    if (!byName[name]) throw new Error(`Missing required player: ${name}`)
  })
  return byName
}

async function createTournamentFixture(playersByName) {
  const tournament = await must(
    supabase
      .from('tournaments')
      .insert({
        tournament_number: uniqueTournamentNumber(),
        date: '2026-07-20',
        player_count: 3,
        status: 'qa_betting_audit',
      })
      .select()
      .single(),
    'create tournament',
  )

  const overdrawGame = await must(
    supabase
      .from('games')
      .insert({
        tournament_id: tournament.id,
        game_code: `QA-OD-${tournament.id}`,
        team_a_player_id: playersByName.Aidan.id,
        team_b_player_id: playersByName.Donovan.id,
        status: 'scheduled',
      })
      .select()
      .single(),
    'create overdraw game',
  )

  const settlementGame = await must(
    supabase
      .from('games')
      .insert({
        tournament_id: tournament.id,
        game_code: `QA-ST-${tournament.id}`,
        team_a_player_id: playersByName.Aidan.id,
        team_b_player_id: playersByName.Jason.id,
        status: 'scheduled',
      })
      .select()
      .single(),
    'create settlement game',
  )

  const oddsRows = await must(
    supabase
      .from('game_odds')
      .insert([
        {
          game_id: overdrawGame.id,
          bet_type: 'moneyline',
          target_entity: null,
          odds_home: 150,
          odds_away: -130,
          predicted_probability: 0.4,
          is_locked: false,
        },
        {
          game_id: settlementGame.id,
          bet_type: 'moneyline',
          target_entity: null,
          odds_home: 140,
          odds_away: -120,
          predicted_probability: 0.42,
          is_locked: false,
        },
      ])
      .select(),
    'create odds',
  )

  return {
    tournament,
    overdrawGame,
    settlementGame,
    oddsByGameId: Object.fromEntries(oddsRows.map((row) => [row.game_id, row])),
  }
}

async function cleanupTournamentFixture(tournamentId) {
  const games = await must(
    supabase.from('games').select('id').eq('tournament_id', tournamentId),
    'load cleanup games',
  )
  const gameIds = (games || []).map((row) => row.id)

  await must(
    supabase.from('points_ledger').delete().eq('tournament_id', tournamentId),
    'delete ledger rows',
  )

  if (gameIds.length) {
    await must(
      supabase.from('game_settlements').delete().in('game_id', gameIds),
      'delete settlements',
    )
  }

  await must(
    supabase.from('games').delete().eq('tournament_id', tournamentId),
    'delete games',
  )
  await must(
    supabase.from('tournaments').delete().eq('id', tournamentId),
    'delete tournament',
  )
}

async function placeBetAndLedger(betPayload) {
  const bet = await must(
    supabase.from('bets').insert(betPayload).select().single(),
    'insert bet',
  )
  const [ledgerRow] = buildPlacedBetLedgerEntries([bet], {
    sourceIdField: 'tournament_id',
    sourceIdValue: betPayload.tournament_id,
  })
  await must(
    supabase.from('points_ledger').insert(ledgerRow),
    'insert ledger row',
  )
  return bet
}

async function runOverdrawAudit({ tournament, overdrawGame, oddsByGameId, playersByName }) {
  const playerId = playersByName.Aidan.id
  const oddsRow = oddsByGameId[overdrawGame.id]
  const basePayload = {
    player_id: playerId,
    tournament_id: tournament.id,
    game_id: overdrawGame.id,
    game_odds_id: oddsRow.id,
    bet_type: 'moneyline',
    target_entity: null,
    chosen_side: 'home',
    odds: oddsRow.odds_home,
    predicted_probability: Number(oddsRow.predicted_probability),
    wager_type: 'dollars',
    wager_dollars: 80,
    potential_payout_dollars: 120,
    status: 'open',
    placed_at: new Date().toISOString(),
  }

  const [firstBet, secondBet] = await Promise.all([
    placeBetAndLedger(basePayload),
    placeBetAndLedger({ ...basePayload, chosen_side: 'away', odds: oddsRow.odds_away, potential_payout_dollars: 61.54 }),
  ])

  const ledger = await must(
    supabase
      .from('points_ledger')
      .select('points_change')
      .eq('tournament_id', tournament.id)
      .eq('player_id', playerId),
    'load overdraw ledger',
  )
  const balance = 100 + (ledger || []).reduce((sum, row) => sum + Number(row.points_change || 0), 0)

  return {
    firstBetId: firstBet.id,
    secondBetId: secondBet.id,
    balanceAfterConcurrentPlacement: Math.round(balance * 100) / 100,
    overdrawPrevented: balance >= 0,
  }
}

async function runConcurrentSettlementAudit({ tournament, settlementGame, oddsByGameId, playersByName }) {
  const oddsRow = oddsByGameId[settlementGame.id]
  const bet = await placeBetAndLedger({
    player_id: playersByName.Aidan.id,
    tournament_id: tournament.id,
    game_id: settlementGame.id,
    game_odds_id: oddsRow.id,
    bet_type: 'moneyline',
    target_entity: null,
    chosen_side: 'home',
    odds: oddsRow.odds_home,
    predicted_probability: Number(oddsRow.predicted_probability),
    wager_type: 'dollars',
    wager_dollars: 10,
    potential_payout_dollars: 14,
    status: 'open',
    placed_at: new Date().toISOString(),
  })

  await Promise.all([
    resolveGameBets(settlementGame.id, 'home', 3, {}, 1, {
      enableCalibrationLogging: false,
      enableWeightAdjustment: false,
      sourceIdField: 'tournament_id',
      sourceIdValue: tournament.id,
    }),
    resolveGameBets(settlementGame.id, 'home', 3, {}, 1, {
      enableCalibrationLogging: false,
      enableWeightAdjustment: false,
      sourceIdField: 'tournament_id',
      sourceIdValue: tournament.id,
    }),
  ])

  const settledRows = await must(
    supabase
      .from('points_ledger')
      .select('id,bet_id,reason,points_change')
      .eq('bet_id', bet.id)
      .like('reason', 'bet_settled:%'),
    'load settlement ledger rows',
  )

  return {
    betId: bet.id,
    settledLedgerRowCount: settledRows.length,
    settledRows,
    duplicateSettlementPrevented: settledRows.length === 1,
  }
}

const playersByName = await getPlayersByName(['Aidan', 'Donovan', 'Jason'])
const fixture = await createTournamentFixture(playersByName)

try {
  const overdraw = await runOverdrawAudit({ ...fixture, playersByName })
  const concurrentSettlement = await runConcurrentSettlementAudit({ ...fixture, playersByName })

  console.log(JSON.stringify({
    tournamentId: fixture.tournament.id,
    overdraw,
    concurrentSettlement,
  }, null, 2))
} finally {
  await cleanupTournamentFixture(fixture.tournament.id)
  await supabase.removeAllChannels()
}
