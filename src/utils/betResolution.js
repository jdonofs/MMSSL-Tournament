import { supabase } from '../supabaseClient'
import { adjustWeights, computeBrierScore } from './oddsEngine'

const PROP_TYPES = new Set(['hr_prop', 'hit_prop', 'k_prop'])
const BET_PLACED_REASON_PREFIX = 'bet_placed'
const BET_SETTLED_REASON_PREFIX = 'bet_settled'

function mean(values = [], fallback = 0) {
  if (!values.length) return fallback
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
}

function getResolvedStatus(isCorrect) {
  return isCorrect ? 'won' : 'lost'
}

function buildUpsertPayload(bet, isCorrect) {
  return {
    id: bet.id,
    status: getResolvedStatus(isCorrect),
    result_correct: isCorrect,
    resolved_at: new Date().toISOString(),
  }
}

function buildResolutionConfig(config = {}) {
  return {
    betsTable: 'bets',
    gameOddsTable: 'game_odds',
    oddsCalibrationTable: 'odds_calibration_log',
    weightsTable: 'odds_engine_weights',
    enableCalibrationLogging: true,
    enableWeightAdjustment: true,
    ledgerTable: 'points_ledger',
    plateAppearancesTable: 'plate_appearances',
    runsScoredTable: 'runs_scored',
    wagerField: 'wager_dollars',
    payoutField: 'potential_payout_dollars',
    ledgerChangeField: 'points_change',
    sourceIdField: 'tournament_id',
    sourceIdValue: null,
    gameOddsIdField: 'game_odds_id',
    ...config,
  }
}

async function loadGameEntities(gameId, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const { data: openBets, error } = await supabase
    .from(resolvedConfig.betsTable)
    .select('*')
    .eq('game_id', gameId)
    .in('status', ['open', 'pending'])
  if (error) throw error

  return { openBets: openBets || [] }
}

async function updateBets(bets, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  if (!bets.length) return
  const updates = bets.map((bet) => {
    const { id, ...changes } = bet
    return supabase.from(resolvedConfig.betsTable).update(changes).eq('id', id)
  })
  const results = await Promise.all(updates)
  const failed = results.find(({ error }) => error)
  if (failed?.error) throw failed.error
}

function buildLedgerEntryBase(bet, delta, reasonPrefix, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const payload = {
    player_id: bet.player_id,
    game_id: bet.game_id,
    bet_id: bet.id,
    reason: `${reasonPrefix}:${bet.bet_type}:${bet.chosen_side}`,
    [resolvedConfig.ledgerChangeField]: Math.round(Number(delta || 0) * 100) / 100,
  }
  if (resolvedConfig.sourceIdField && resolvedConfig.sourceIdValue != null) {
    payload[resolvedConfig.sourceIdField] = resolvedConfig.sourceIdValue
  } else if (resolvedConfig.sourceIdField && bet[resolvedConfig.sourceIdField] != null) {
    payload[resolvedConfig.sourceIdField] = bet[resolvedConfig.sourceIdField]
  }
  return payload
}

export function buildPlacedBetLedgerEntries(bets = [], config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  return bets
    .filter((bet) => bet?.id != null)
    .map((bet) => {
      const wager = Number(bet[resolvedConfig.wagerField] || 0)
      return buildLedgerEntryBase(bet, -wager, BET_PLACED_REASON_PREFIX, resolvedConfig)
    })
}

async function syncLedger(bets, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const resolvedBets = bets.filter((bet) => ['won', 'lost', 'void'].includes(bet.status))
  if (!resolvedBets.length) return

  const betIds = resolvedBets.map((bet) => bet.id)
  const { data: placedRows, error: placedRowsError } = await supabase
    .from(resolvedConfig.ledgerTable)
    .select('bet_id')
    .in('bet_id', betIds)
    .like('reason', `${BET_PLACED_REASON_PREFIX}:%`)
  if (placedRowsError) throw placedRowsError
  const placedBetIds = new Set((placedRows || []).map((entry) => String(entry.bet_id)))

  const { error: deleteError } = await supabase
    .from(resolvedConfig.ledgerTable)
    .delete()
    .in('bet_id', betIds)
    .like('reason', `${BET_SETTLED_REASON_PREFIX}:%`)
  if (deleteError) throw deleteError

  const ledgerRows = resolvedBets.map((bet) => {
    const payout = Number(bet[resolvedConfig.payoutField] || 0)
    const wager = Number(bet[resolvedConfig.wagerField] || 0)
    const hadPlacementDebit = placedBetIds.has(String(bet.id))
    const delta = bet.status === 'won'
      ? (hadPlacementDebit ? wager + payout : payout)
      : bet.status === 'void'
        ? (hadPlacementDebit ? wager : 0)
        : (hadPlacementDebit ? 0 : -wager)
    return buildLedgerEntryBase(bet, delta, BET_SETTLED_REASON_PREFIX, resolvedConfig)
  }).filter((entry) => Number(entry[resolvedConfig.ledgerChangeField] || 0) !== 0)

  if (!ledgerRows.length) return
  const { error } = await supabase.from(resolvedConfig.ledgerTable).insert(ledgerRows)
  if (error) throw error
}

// PART F — checks whether any run has been recorded in inning 1 of this game,
// excluding `excludePaId` (the PA currently being processed). Used to decide
// whether a first_inning_run bet can be settled yet via the "confirm via next
// play" rule: a run in inning 1 settles "yes" once a LATER play is recorded,
// and "no runs" settles once the first play of inning 2+ is recorded.
async function hasInning1Run(gameId, excludePaId, config) {
  const resolvedConfig = buildResolutionConfig(config)
  const { data: runRows, error: runsError } = await supabase
    .from(resolvedConfig.runsScoredTable)
    .select('pa_id, inning')
    .eq('game_id', gameId)
    .eq('inning', 1)
  if (runsError) throw runsError

  const inning1Runs = (runRows || []).filter((entry) => String(entry.pa_id) !== String(excludePaId))
  if (inning1Runs.length) return true
  if ((runRows || []).length) return false

  const { data, error } = await supabase
    .from(resolvedConfig.plateAppearancesTable)
    .select('id, inning, rbi, run_scored')
    .eq('game_id', gameId)
    .eq('inning', 1)
  if (error) throw error
  return (data || []).some((entry) => String(entry.id) !== String(excludePaId) && (Number(entry.rbi || 0) > 0 || entry.run_scored))
}

async function lockOdds(gameId, betType, targetEntity = null, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  let query = supabase
    .from(resolvedConfig.gameOddsTable)
    .update({ is_locked: true, updated_at: new Date().toISOString() })
    .eq('game_id', gameId)
    .eq('bet_type', betType)

  query = targetEntity == null ? query.is('target_entity', null) : query.eq('target_entity', targetEntity)
  const { error } = await query
  if (error) throw error
}

export async function resolveOnPA(gameId, pa, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const { openBets } = await loadGameEntities(gameId, resolvedConfig)
  const updates = []

  // PART F — "confirm via next play": a first-inning-run bet settles once a
  // play AFTER the potentially-deciding moment has been recorded. If a run
  // already scored in inning 1 on an earlier play, this play confirms it
  // (settle "yes"). Otherwise, once the first play of inning 2+ is recorded,
  // that confirms inning 1 ended without a run (settle "no").
  const firstInningBets = openBets.filter((bet) => bet.bet_type === 'first_inning_run')
  if (firstInningBets.length) {
    const priorRun = await hasInning1Run(gameId, pa.id, resolvedConfig)
    let inning1Scored = null
    if (priorRun) {
      inning1Scored = true
    } else if (Number(pa.inning) >= 2) {
      inning1Scored = false
    }
    if (inning1Scored != null) {
      firstInningBets.forEach((bet) => updates.push(buildUpsertPayload(bet, (bet.chosen_side === 'yes') === inning1Scored)))
      await lockOdds(gameId, 'first_inning_run', null, resolvedConfig)
    }
  }

  if (updates.length) {
    await updateBets(updates, resolvedConfig)
    await syncLedger(
      openBets
        .filter((bet) => updates.some((update) => update.id === bet.id))
        .map((bet) => ({ ...bet, ...updates.find((update) => update.id === bet.id) })),
      resolvedConfig,
    )
  }

  return updates
}

export async function resolveFirstInningNoRun(gameId, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const { data: openBets, error } = await supabase
    .from(resolvedConfig.betsTable)
    .select('*')
    .eq('game_id', gameId)
    .eq('bet_type', 'first_inning_run')
    .in('status', ['open', 'pending'])

  if (error) throw error

  const updates = (openBets || []).map((bet) => buildUpsertPayload(bet, bet.chosen_side === 'no'))
  await updateBets(updates, resolvedConfig)
  await syncLedger((openBets || []).map((bet) => ({ ...bet, ...updates.find((update) => update.id === bet.id) })), resolvedConfig)
  await lockOdds(gameId, 'first_inning_run', null, resolvedConfig)
  return updates
}

export async function resolveGameBets(gameId, winningSide, totalRuns, pitcherKTotals = {}, margin = 0, config = {}, hrTotals = {}, hitTotals = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const { data: openBets, error } = await supabase
    .from(resolvedConfig.betsTable)
    .select('*')
    .eq('game_id', gameId)
    .in('status', ['open', 'pending'])

  if (error) throw error

  const updates = []
  let inning1RunFallback = null

  for (const bet of openBets || []) {
    if (bet.bet_type === 'moneyline') {
      updates.push(buildUpsertPayload(bet, bet.chosen_side === winningSide))
      continue
    }

    if (bet.bet_type === 'run_line') {
      const spread = Number(bet.line || 1.5)
      const homeCovers = winningSide === 'home' && margin > spread
      updates.push(buildUpsertPayload(bet, bet.chosen_side === 'home' ? homeCovers : !homeCovers))
      continue
    }

    if (bet.bet_type === 'over_under') {
      const line = Number(bet.line || 0)
      const isCorrect = bet.chosen_side === 'over' ? totalRuns > line : totalRuns < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      continue
    }

    if (bet.bet_type === 'k_prop') {
      const actualKs = Number(pitcherKTotals[bet.target_entity] || 0)
      const line = Number(bet.line || 0)
      const isCorrect = bet.chosen_side === 'over' ? actualKs > line : actualKs < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      continue
    }

    if (bet.bet_type === 'hr_prop') {
      const actualHRs = Number(hrTotals[bet.target_entity] || 0)
      const line = Number(bet.line || 0)
      const isCorrect = bet.chosen_side === 'over' ? actualHRs > line : actualHRs < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      continue
    }

    if (bet.bet_type === 'hit_prop') {
      const actualHits = Number(hitTotals[bet.target_entity] || 0)
      const line = Number(bet.line || 0)
      const isCorrect = bet.chosen_side === 'over' ? actualHits > line : actualHits < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      continue
    }

    if (bet.bet_type === 'first_inning_run') {
      // PART F fallback — normally resolved via resolveOnPA's "confirm via
      // next play" check; this only fires for games that ended before any
      // inning-2 play was recorded (e.g. shortened games).
      if (inning1RunFallback == null) {
        inning1RunFallback = await hasInning1Run(gameId, null, resolvedConfig)
      }
      updates.push(buildUpsertPayload(bet, (bet.chosen_side === 'yes') === inning1RunFallback))
      continue
    }

    updates.push({
      id: bet.id,
      status: 'void',
      result_correct: null,
      resolved_at: new Date().toISOString(),
    })
  }

  await updateBets(updates, resolvedConfig)
  await syncLedger((openBets || []).map((bet) => ({ ...bet, ...updates.find((update) => update.id === bet.id) })), resolvedConfig)
  await runPostGameCalibration(gameId, resolvedConfig)
  return updates
}

export async function reopenGameBets(gameId, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const reversibleTypes = ['moneyline', 'run_line', 'over_under', 'k_prop', 'hr_prop', 'hit_prop']
  const { data: resolvedBets, error } = await supabase
    .from(resolvedConfig.betsTable)
    .select('*')
    .eq('game_id', gameId)
    .in('bet_type', reversibleTypes)
    .in('status', ['won', 'lost', 'void'])

  if (error) throw error

  const updates = (resolvedBets || []).map((bet) => ({
    id: bet.id,
    status: 'open',
    result_correct: null,
    resolved_at: null,
  }))

  if (updates.length) {
    await updateBets(updates, resolvedConfig)
    const betIds = updates.map((bet) => bet.id)
    const { error: ledgerError } = await supabase
      .from(resolvedConfig.ledgerTable)
      .delete()
      .in('bet_id', betIds)
      .like('reason', `${BET_SETTLED_REASON_PREFIX}:%`)
    if (ledgerError) throw ledgerError
  }

  if (resolvedConfig.enableCalibrationLogging && resolvedConfig.oddsCalibrationTable) {
    const { error: calibrationError } = await supabase.from(resolvedConfig.oddsCalibrationTable).delete().eq('game_id', gameId)
    if (calibrationError) throw calibrationError
  }
  return updates
}

export async function runPostGameCalibration(gameId, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  if (!resolvedConfig.enableCalibrationLogging && !resolvedConfig.enableWeightAdjustment) return null

  const queries = [
    supabase
      .from(resolvedConfig.betsTable)
      .select('*')
      .eq('game_id', gameId)
      .in('status', ['won', 'lost']),
  ]

  if (resolvedConfig.enableWeightAdjustment && resolvedConfig.weightsTable) {
    queries.push(
      supabase
        .from(resolvedConfig.weightsTable)
        .select('*')
        .eq('id', 1)
        .maybeSingle(),
    )
  }

  const [{ data: resolvedBets, error: betsError }, weightsResult] = await Promise.all(queries)
  const weightsRows = weightsResult?.data || null
  const weightsError = weightsResult?.error || null

  if (betsError) throw betsError
  if (weightsError) throw weightsError

  const predictions = (resolvedBets || [])
    .filter((bet) => bet.predicted_probability != null)
    .map((bet) => ({
      predicted_probability: Number(bet.predicted_probability),
      actual_outcome: bet.result_correct ? 1 : 0,
    }))

  const calibrationRows = (resolvedBets || [])
    .filter((bet) => bet.predicted_probability != null)
    .map((bet) => ({
      game_id: gameId,
      game_odds_id: bet[resolvedConfig.gameOddsIdField],
      bet_type: bet.bet_type,
      target_entity: bet.target_entity,
      predicted_probability: Number(bet.predicted_probability),
      american_odds: bet.odds,
      actual_outcome: Boolean(bet.result_correct),
      brier_contribution: Math.pow(Number(bet.predicted_probability) - (bet.result_correct ? 1 : 0), 2),
      logged_at: new Date().toISOString(),
    }))

  if (resolvedConfig.enableCalibrationLogging && resolvedConfig.oddsCalibrationTable && calibrationRows.length) {
    const { error } = await supabase.from(resolvedConfig.oddsCalibrationTable).insert(calibrationRows)
    if (error) throw error
  }

  const gameBrier = computeBrierScore(predictions)
  const charScores = calibrationRows.filter((row) => PROP_TYPES.has(row.bet_type)).map((row) => row.brier_contribution)
  const historicalScores = calibrationRows
    .filter((row) => row.bet_type === 'moneyline' || row.bet_type === 'over_under')
    .map((row) => row.brier_contribution)
  const liveScores = calibrationRows
    .filter((row) => row.bet_type === 'first_inning_run' || row.bet_type === 'k_prop')
    .map((row) => row.brier_contribution)

  let adjusted = null
  if (resolvedConfig.enableWeightAdjustment && resolvedConfig.weightsTable) {
    adjusted = adjustWeights(weightsRows || {}, {
      char: mean(charScores, gameBrier),
      historical: mean(historicalScores, gameBrier),
      live: mean(liveScores, gameBrier),
    })

    const { error: upsertError } = await supabase.from(resolvedConfig.weightsTable).upsert({
      id: 1,
      ...adjusted,
      games_evaluated: Number(weightsRows?.games_evaluated || 0) + 1,
      last_brier_score: gameBrier,
      updated_at: new Date().toISOString(),
    })

    if (upsertError) throw upsertError
  }

  return {
    brierScore: gameBrier,
    weights: adjusted,
  }
}
