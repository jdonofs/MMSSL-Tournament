import { supabase } from '../supabaseClient'
import { adjustWeights, computeBrierScore } from './OddsEngine'

const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR'])
const PROP_TYPES = new Set(['hr_prop', 'hit_prop', 'k_prop'])

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

async function loadGameEntities(gameId) {
  const [{ data: openBets }, { data: players }, { data: characters }] = await Promise.all([
    supabase.from('bets').select('*').eq('game_id', gameId).eq('status', 'open'),
    supabase.from('players').select('id, name'),
    supabase.from('characters').select('id, name'),
  ])

  return {
    openBets: openBets || [],
    playersById: Object.fromEntries((players || []).map((entry) => [entry.id, entry])),
    charactersById: Object.fromEntries((characters || []).map((entry) => [entry.id, entry])),
  }
}

function buildEntityCandidates(pa, playersById, charactersById) {
  const playerName = playersById[pa.player_id]?.name
  const characterName = charactersById[pa.character_id]?.name
  const candidates = new Set([
    playerName,
    characterName,
    playerName && characterName ? `${characterName} (${playerName})` : null,
    pa.target_entity,
  ].filter(Boolean))

  return candidates
}

async function updateBets(bets) {
  if (!bets.length) return
  const { error } = await supabase.from('bets').upsert(bets)
  if (error) throw error
}

async function lockOdds(gameId, betType, targetEntity = null) {
  let query = supabase
    .from('game_odds')
    .update({ is_locked: true, updated_at: new Date().toISOString() })
    .eq('game_id', gameId)
    .eq('bet_type', betType)

  query = targetEntity == null ? query.is('target_entity', null) : query.eq('target_entity', targetEntity)
  const { error } = await query
  if (error) throw error
}

export async function resolveOnPA(gameId, pa) {
  const { openBets, playersById, charactersById } = await loadGameEntities(gameId)
  const entityCandidates = buildEntityCandidates(pa, playersById, charactersById)
  const updates = []

  if (pa.result === 'HR') {
    openBets
      .filter((bet) => bet.bet_type === 'hr_prop' && entityCandidates.has(bet.target_entity))
      .forEach((bet) => updates.push(buildUpsertPayload(bet, bet.chosen_side === 'yes')))
    if (updates.length) await lockOdds(gameId, 'hr_prop', [...entityCandidates][0])
  }

  if (HIT_RESULTS.has(pa.result)) {
    openBets
      .filter((bet) => bet.bet_type === 'hit_prop' && entityCandidates.has(bet.target_entity))
      .forEach((bet) => updates.push(buildUpsertPayload(bet, bet.chosen_side === 'yes')))
    if (updates.some((bet) => openBets.find((entry) => entry.id === bet.id)?.bet_type === 'hit_prop')) {
      await lockOdds(gameId, 'hit_prop', [...entityCandidates][0])
    }
  }

  if (Number(pa.inning) === 1 && Number(pa.rbi || 0) > 0) {
    openBets
      .filter((bet) => bet.bet_type === 'first_inning_run')
      .forEach((bet) => updates.push(buildUpsertPayload(bet, bet.chosen_side === 'yes')))
    await lockOdds(gameId, 'first_inning_run', null)
  }

  if (updates.length) {
    await updateBets(updates)
  }

  return updates
}

export async function resolveFirstInningNoRun(gameId) {
  const { data: openBets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('game_id', gameId)
    .eq('bet_type', 'first_inning_run')
    .eq('status', 'open')

  if (error) throw error

  const updates = (openBets || []).map((bet) => buildUpsertPayload(bet, bet.chosen_side === 'no'))
  await updateBets(updates)
  await lockOdds(gameId, 'first_inning_run', null)
  return updates
}

export async function resolveGameBets(gameId, winningSide, totalRuns, pitcherKTotals = {}, margin = 0) {
  const { data: openBets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('game_id', gameId)
    .eq('status', 'open')

  if (error) throw error

  const updates = []

  ;(openBets || []).forEach((bet) => {
    if (bet.bet_type === 'moneyline') {
      updates.push(buildUpsertPayload(bet, bet.chosen_side === winningSide))
      return
    }

    if (bet.bet_type === 'run_line') {
      const spread = Number(bet.line || 1.5)
      const homeCovers = winningSide === 'home' && margin > spread
      updates.push(buildUpsertPayload(bet, bet.chosen_side === 'home' ? homeCovers : !homeCovers))
      return
    }

    if (bet.bet_type === 'over_under') {
      const line = Number(bet.line || 0)
      const isCorrect = bet.chosen_side === 'over' ? totalRuns > line : totalRuns < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      return
    }

    if (bet.bet_type === 'k_prop') {
      const actualKs = Number(pitcherKTotals[bet.target_entity] || 0)
      const line = Number(bet.line || 0)
      const isCorrect = bet.chosen_side === 'over' ? actualKs > line : actualKs < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      return
    }

    updates.push({
      id: bet.id,
      status: 'void',
      result_correct: null,
      resolved_at: new Date().toISOString(),
    })
  })

  await updateBets(updates)
  await runPostGameCalibration(gameId)
  return updates
}

export async function runPostGameCalibration(gameId) {
  const [{ data: resolvedBets, error: betsError }, { data: weightsRows, error: weightsError }] = await Promise.all([
    supabase
      .from('bets')
      .select('*')
      .eq('game_id', gameId)
      .in('status', ['won', 'lost']),
    supabase
      .from('odds_engine_weights')
      .select('*')
      .eq('id', 1)
      .maybeSingle(),
  ])

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
      game_odds_id: bet.game_odds_id,
      bet_type: bet.bet_type,
      target_entity: bet.target_entity,
      predicted_probability: Number(bet.predicted_probability),
      american_odds: bet.odds,
      actual_outcome: Boolean(bet.result_correct),
      brier_contribution: Math.pow(Number(bet.predicted_probability) - (bet.result_correct ? 1 : 0), 2),
      logged_at: new Date().toISOString(),
    }))

  if (calibrationRows.length) {
    const { error } = await supabase.from('odds_calibration_log').insert(calibrationRows)
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

  const adjusted = adjustWeights(weightsRows || {}, {
    char: mean(charScores, gameBrier),
    historical: mean(historicalScores, gameBrier),
    live: mean(liveScores, gameBrier),
  })

  const { error: upsertError } = await supabase.from('odds_engine_weights').upsert({
    id: 1,
    ...adjusted,
    games_evaluated: Number(weightsRows?.games_evaluated || 0) + 1,
    last_brier_score: gameBrier,
    updated_at: new Date().toISOString(),
  })

  if (upsertError) throw upsertError

  return {
    brierScore: gameBrier,
    weights: adjusted,
  }
}
