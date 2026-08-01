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

const [{ supabase }, { buildPlacedBetLedgerEntries }, { calculatePayout }] = await Promise.all([
  import('../src/supabaseClient.js'),
  import('../src/utils/betResolution.js'),
  import('../src/utils/oddsEngine.js'),
])

const auditEmail = process.env.BETTING_AUDIT_EMAIL
const auditPassword = process.env.BETTING_AUDIT_PASSWORD
const auditSeasonName = process.env.BETTING_AUDIT_SEASON || 'TEST'

if (!auditEmail || !auditPassword) {
  throw new Error('BETTING_AUDIT_EMAIL and BETTING_AUDIT_PASSWORD are required')
}

async function must(queryPromise, label) {
  const { data, error } = await queryPromise
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

async function resolvePlayer(user) {
  let player = await must(
    supabase.from('players').select('id,name,email').eq('id', user.id).maybeSingle(),
    'load player by id',
  )
  if (!player && user.email) {
    player = await must(
      supabase.from('players').select('id,name,email').eq('email', user.email).maybeSingle(),
      'load player by email',
    )
  }
  if (!player && user.email) {
    const fallbackName = user.email.split('@')[0]
    const normalizedName = fallbackName ? fallbackName.slice(0, 1).toUpperCase() + fallbackName.slice(1).toLowerCase() : null
    if (normalizedName) {
      player = await must(
        supabase.from('players').select('id,name,email').eq('name', normalizedName).maybeSingle(),
        'load player by name',
      )
    }
  }
  if (!player) throw new Error(`Missing player row for auth user ${user.id}`)
  return player
}

async function loadBalance(seasonId, playerId) {
  const [ledgerEntries, balanceAwards, sipTransactions] = await Promise.all([
    must(
      supabase.from('season_betting_ledger').select('dollars_change').eq('season_id', seasonId).eq('player_id', playerId),
      'load ledger balance',
    ),
    must(
      supabase.from('balance_awards').select('amount').eq('season_id', seasonId).eq('player_id', playerId),
      'load balance awards',
    ),
    must(
      supabase.from('sip_transactions').select('type,amount_dollars').eq('season_id', seasonId).eq('player_id', playerId),
      'load sip transactions',
    ),
  ])
  const ledgerNet = (ledgerEntries || []).reduce((sum, row) => sum + Number(row.dollars_change || 0), 0)
  const awardsNet = (balanceAwards || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const sipNet = (sipTransactions || []).reduce((sum, row) => sum + (row.type === 'sell' ? Number(row.amount_dollars || 0) : -Number(row.amount_dollars || 0)), 0)
  return roundMoney(100 + ledgerNet + awardsNet + sipNet)
}

const createdBetIds = []

try {
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: auditEmail,
    password: auditPassword,
  })
  if (authError) throw new Error(`sign in: ${authError.message}`)

  const player = await resolvePlayer(authData.user)
  const seasons = await must(
    supabase.from('seasons').select('id,name').eq('name', auditSeasonName).order('id', { ascending: false }).limit(1),
    'load season',
  )
  const season = seasons?.[0]
  if (!season) throw new Error(`Missing season named ${auditSeasonName}`)

  const scheduledGames = await must(
    supabase.from('season_schedule').select('id,status').eq('season_id', season.id).in('status', ['scheduled', 'pending', 'active', 'in_progress']).order('id'),
    'load scheduled games',
  )
  const gameIds = (scheduledGames || []).map((row) => row.id)
  if (!gameIds.length) throw new Error('No scheduled season games available')

  const oddsRows = await must(
    supabase.from('season_game_odds').select('id,game_id,bet_type,odds_home,odds_away,predicted_probability,is_locked').in('game_id', gameIds).eq('bet_type', 'moneyline').eq('is_locked', false).order('id'),
    'load moneyline odds',
  )
  const row = oddsRows?.[0]
  if (!row) throw new Error('No unlocked season moneyline row available')

  const balanceBefore = await loadBalance(season.id, player.id)
  const placedAt = new Date().toISOString()

  async function directPlace(chosenSide, odds) {
    const payload = {
      season_id: season.id,
      game_id: row.game_id,
      player_id: player.id,
      bet_type: 'moneyline',
      target_entity: null,
      chosen_side: chosenSide,
      odds,
      predicted_probability: chosenSide === 'home'
        ? Math.round(Number(row.predicted_probability || 0.5) * 10000) / 10000
        : Math.round((1 - Number(row.predicted_probability || 0.5)) * 10000) / 10000,
      line: null,
      wager_dollars: 80,
      potential_payout_dollars: calculatePayout(80, odds),
      status: 'open',
      placed_at: placedAt,
    }
    const bet = await must(
      supabase.from('season_bets').insert(payload).select().single(),
      `insert direct ${chosenSide} bet`,
    )
    const [ledgerRow] = buildPlacedBetLedgerEntries([bet], {
      sourceIdField: 'season_id',
      sourceIdValue: season.id,
      ledgerChangeField: 'dollars_change',
      wagerField: 'wager_dollars',
    })
    await must(
      supabase.from('season_betting_ledger').insert(ledgerRow),
      `insert direct ${chosenSide} ledger`,
    )
    return bet
  }

  try {
    const [homeBet, awayBet] = await Promise.all([
      directPlace('home', Number(row.odds_home)),
      directPlace('away', Number(row.odds_away)),
    ])
    createdBetIds.push(homeBet.id, awayBet.id)

    const balanceAfter = await loadBalance(season.id, player.id)

    console.log(JSON.stringify({
      seasonId: season.id,
      gameId: row.game_id,
      betIds: createdBetIds,
      balanceBefore,
      balanceAfter,
      directInsertBlocked: false,
      overdrawStillPossibleViaDirectInsert: balanceAfter < 0,
    }, null, 2))
  } catch (error) {
    const balanceAfter = await loadBalance(season.id, player.id)
    console.log(JSON.stringify({
      seasonId: season.id,
      gameId: row.game_id,
      betIds: createdBetIds,
      balanceBefore,
      balanceAfter,
      directInsertBlocked: true,
      errorMessage: error.message,
    }, null, 2))
  }
} finally {
  if (createdBetIds.length) {
    await must(
      supabase.from('season_betting_ledger').delete().in('bet_id', createdBetIds),
      'cleanup direct ledger',
    )
    await must(
      supabase.from('season_bets').delete().in('id', createdBetIds),
      'cleanup direct bets',
    )
  }
  await supabase.auth.signOut()
  await supabase.removeAllChannels()
}
