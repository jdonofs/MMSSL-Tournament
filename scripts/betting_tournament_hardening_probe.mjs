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

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

loadDotEnv()

const [
  { supabase },
  { calculatePayout },
  { resolveGameBets, reopenGameBets },
] = await Promise.all([
  import('../src/supabaseClient.js'),
  import('../src/utils/oddsEngine.js'),
  import('../src/utils/betResolution.js'),
])

const auditEmail = process.env.BETTING_AUDIT_EMAIL
const auditPassword = process.env.BETTING_AUDIT_PASSWORD
const tournamentStatus = process.env.BETTING_AUDIT_TOURNAMENT_STATUS || 'qa_betting_hardening'

if (!auditEmail || !auditPassword) {
  throw new Error('BETTING_AUDIT_EMAIL and BETTING_AUDIT_PASSWORD are required')
}

async function must(queryPromise, label) {
  const { data, error } = await queryPromise
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

function buildResolutionConfig(tournamentId) {
  return {
    betsTable: 'bets',
    gameOddsTable: 'game_odds',
    ledgerTable: 'points_ledger',
    plateAppearancesTable: 'plate_appearances',
    runsScoredTable: 'runs_scored',
    wagerField: 'wager_dollars',
    payoutField: 'potential_payout_dollars',
    ledgerChangeField: 'points_change',
    sourceIdField: 'tournament_id',
    sourceIdValue: tournamentId,
    enableCalibrationLogging: false,
    enableWeightAdjustment: false,
  }
}

function buildBetPayload({ playerId, row, side = 'home', wagerDollars = 1 }) {
  const probability = Number(row.predicted_probability ?? 0.5)
  const odds = side === 'home' ? Number(row.odds_home) : Number(row.odds_away)
  const predictedProbability = side === 'home' ? probability : 1 - probability
  return {
    player_id: playerId,
    game_id: row.game_id,
    game_odds_id: row.id,
    bet_type: row.bet_type,
    target_entity: row.target_entity,
    chosen_side: side,
    odds,
    predicted_probability: Math.round(predictedProbability * 10000) / 10000,
    wager_type: 'dollars',
    wager_dollars: wagerDollars,
    potential_payout_dollars: calculatePayout(wagerDollars, odds),
    status: 'open',
    placed_at: new Date().toISOString(),
  }
}

async function resolvePlayer(user) {
  let player = await must(
    supabase.from('players').select('id,name,email,is_commissioner,scorebook_access').eq('id', user.id).maybeSingle(),
    'load player by id',
  )
  if (!player && user.email) {
    player = await must(
      supabase.from('players').select('id,name,email,is_commissioner,scorebook_access').eq('email', user.email).maybeSingle(),
      'load player by email',
    )
  }
  if (!player && user.email) {
    const fallbackName = user.email.split('@')[0]
    const normalizedName = fallbackName ? fallbackName.slice(0, 1).toUpperCase() + fallbackName.slice(1).toLowerCase() : null
    if (normalizedName) {
      player = await must(
        supabase.from('players').select('id,name,email,is_commissioner,scorebook_access').eq('name', normalizedName).maybeSingle(),
        'load player by name',
      )
    }
  }
  if (!player) throw new Error(`Missing player row for auth user ${user.id}`)
  return player
}

const report = {}

try {
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: auditEmail,
    password: auditPassword,
  })
  if (authError) throw new Error(`sign in: ${authError.message}`)

  const player = await resolvePlayer(authData.user)
  const tournaments = await must(
    supabase.from('tournaments').select('id,tournament_number,status').eq('status', tournamentStatus).order('id', { ascending: false }).limit(1),
    'load tournament fixture',
  )
  const tournament = tournaments?.[0]
  if (!tournament) throw new Error(`Missing tournament fixture with status ${tournamentStatus}`)

  const games = await must(
    supabase.from('games').select('id,tournament_id,status').eq('tournament_id', tournament.id).order('id'),
    'load tournament games',
  )
  const game = games?.[0]
  if (!game) throw new Error(`Missing game for tournament ${tournament.id}`)

  const oddsRows = await must(
    supabase.from('game_odds').select('*').eq('game_id', game.id).eq('bet_type', 'moneyline').eq('is_locked', false).order('id'),
    'load tournament moneyline odds',
  )
  const row = oddsRows?.[0]
  if (!row) throw new Error(`Missing unlocked moneyline row for tournament game ${game.id}`)

  const payload = buildBetPayload({
    playerId: player.id,
    row,
    side: 'home',
    wagerDollars: 1,
  })

  const directInsertAttempt = await supabase
    .from('bets')
    .insert(payload)
    .select('id')
  report.directBetInsertBlocked = {
    blocked: Boolean(directInsertAttempt.error),
    errorMessage: directInsertAttempt.error?.message || null,
  }

  const { data: placedBets, error: placeError } = await supabase.rpc('place_tournament_bets', {
    p_tournament_id: tournament.id,
    p_bets: [payload],
  })
  if (placeError) throw new Error(`place_tournament_bets: ${placeError.message}`)
  const bet = placedBets?.[0]
  if (!bet) throw new Error('No bet returned from place_tournament_bets')

  const placedLedgerRows = await must(
    supabase.from('points_ledger').select('id,bet_id,reason,points_change').eq('bet_id', bet.id).order('id'),
    'load placed tournament ledger rows',
  )
  const placedLedgerRow = placedLedgerRows?.find((entry) => String(entry.reason || '').startsWith('bet_placed:'))
  if (!placedLedgerRow) throw new Error(`Missing placed ledger row for bet ${bet.id}`)

  report.betId = bet.id
  report.placedLedgerId = placedLedgerRow.id
  report.player = {
    id: player.id,
    name: player.name,
    isCommissioner: Boolean(player.is_commissioner),
    scorebookAccess: Boolean(player.scorebook_access),
  }
  report.tournament = tournament
  report.gameId = row.game_id

  const wagerUpdateAttempt = await supabase
    .from('bets')
    .update({ wager_dollars: 2 })
    .eq('id', bet.id)
    .select('id,wager_dollars')
    .maybeSingle()
  const betAfterWagerUpdateAttempt = await must(
    supabase.from('bets').select('id,wager_dollars').eq('id', bet.id).single(),
    'load tournament bet after wager update attempt',
  )
  report.directWagerUpdateBlocked = {
    blocked: Boolean(wagerUpdateAttempt.error) || roundMoney(betAfterWagerUpdateAttempt.wager_dollars) === 1,
    errorMessage: wagerUpdateAttempt.error?.message || null,
    storedWagerDollars: roundMoney(betAfterWagerUpdateAttempt.wager_dollars),
  }

  const betDeleteAttempt = await supabase
    .from('bets')
    .delete()
    .eq('id', bet.id)
    .select('id')
  const betAfterDeleteAttempt = await must(
    supabase.from('bets').select('id').eq('id', bet.id).maybeSingle(),
    'load tournament bet after delete attempt',
  )
  report.directBetDeleteBlocked = {
    blocked: Boolean(betDeleteAttempt.error) || Boolean(betAfterDeleteAttempt),
    errorMessage: betDeleteAttempt.error?.message || null,
    betStillPresent: Boolean(betAfterDeleteAttempt),
  }

  const placedLedgerInsertAttempt = await supabase
    .from('points_ledger')
    .insert({
      tournament_id: tournament.id,
      player_id: player.id,
      game_id: row.game_id,
      bet_id: bet.id,
      points_change: -1,
      reason: 'bet_placed:moneyline:test_probe',
    })
    .select('id')
  const probePlacedLedgerRows = await must(
    supabase.from('points_ledger').select('id').eq('bet_id', bet.id).eq('reason', 'bet_placed:moneyline:test_probe'),
    'load probe placed tournament ledger rows',
  )
  report.directPlacedLedgerInsertBlocked = {
    blocked: Boolean(placedLedgerInsertAttempt.error) || (probePlacedLedgerRows || []).length === 0,
    errorMessage: placedLedgerInsertAttempt.error?.message || null,
    insertedProbeRowCount: (probePlacedLedgerRows || []).length,
  }

  const placedLedgerDeleteAttempt = await supabase
    .from('points_ledger')
    .delete()
    .eq('id', placedLedgerRow.id)
    .select('id')
  const placedLedgerRowAfterDeleteAttempt = await must(
    supabase.from('points_ledger').select('id').eq('id', placedLedgerRow.id).maybeSingle(),
    'load tournament placed ledger row after delete attempt',
  )
  report.directPlacedLedgerDeleteBlocked = {
    blocked: Boolean(placedLedgerDeleteAttempt.error) || Boolean(placedLedgerRowAfterDeleteAttempt),
    errorMessage: placedLedgerDeleteAttempt.error?.message || null,
    rowStillPresent: Boolean(placedLedgerRowAfterDeleteAttempt),
  }

  await resolveGameBets(row.game_id, 'home', 5, {}, 2, buildResolutionConfig(tournament.id))
  const settledBet = await must(
    supabase.from('bets').select('id,status,result_correct,resolved_at').eq('id', bet.id).single(),
    'load settled tournament bet',
  )
  const settledLedgerRows = await must(
    supabase.from('points_ledger').select('id,bet_id,reason,points_change').eq('bet_id', bet.id).like('reason', 'bet_settled:%').order('id'),
    'load settled tournament ledger rows',
  )
  report.scorebookResolutionStillWorks = {
    status: settledBet.status,
    resultCorrect: settledBet.result_correct,
    settledLedgerRowCount: (settledLedgerRows || []).length,
    settledLedgerTotal: roundMoney((settledLedgerRows || []).reduce((sum, entry) => sum + Number(entry.points_change || 0), 0)),
    worked: settledBet.status === 'won' && settledBet.result_correct === true && (settledLedgerRows || []).length === 1,
  }

  await reopenGameBets(row.game_id, buildResolutionConfig(tournament.id))
  const reopenedBet = await must(
    supabase.from('bets').select('id,status,result_correct,resolved_at').eq('id', bet.id).single(),
    'load reopened tournament bet',
  )
  const remainingSettledLedgerRows = await must(
    supabase.from('points_ledger').select('id').eq('bet_id', bet.id).like('reason', 'bet_settled:%'),
    'load remaining tournament settled ledger rows',
  )
  report.scorebookReopenStillWorks = {
    status: reopenedBet.status,
    resultCorrect: reopenedBet.result_correct,
    remainingSettledLedgerRowCount: (remainingSettledLedgerRows || []).length,
    worked: reopenedBet.status === 'open' && reopenedBet.result_correct == null && (remainingSettledLedgerRows || []).length === 0,
  }

  console.log(JSON.stringify(report, null, 2))
} finally {
  await supabase.auth.signOut()
  await supabase.removeAllChannels()
}
