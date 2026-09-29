import { supabase } from '../supabaseClient.js'
import { adjustWeights, computeBrierScore } from './oddsEngine.js'

const PROP_TYPES = new Set(['hr_prop', 'hit_prop', 'k_prop'])
const BET_PLACED_REASON_PREFIX = 'bet_placed'
const BET_SETTLED_REASON_PREFIX = 'bet_settled'

function mean(values = [], fallback = 0) {
  if (!values.length) return fallback
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
}

const RESOLVED_STATUSES = ['won', 'lost', 'void']
const SETTLEABLE_STATUSES = ['open', 'pending', ...RESOLVED_STATUSES]

function describeBet(bet = {}) {
  return `bet ${bet.id} (${bet.bet_type}${bet.target_entity ? ` / ${bet.target_entity}` : ''})`
}

// A malformed number must stop the settlement, not quietly become NaN.
// `Number('abc') > NaN` and `Number('abc') < NaN` are both false, which used to
// grade BOTH sides of a two-sided prop as losers; a non-numeric wager reached
// the ledger as NaN. Refusing to settle is recoverable — the row can be fixed
// and the game re-settled — while a wrong grade is not.
function readNumericField(bet, value, field, fallback = 0) {
  if (value == null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new Error(`${describeBet(bet)} has a non-numeric ${field}: ${JSON.stringify(value)}`)
  }
  return numeric
}

function getBetLine(bet, fallback = 0) {
  return readNumericField(bet, bet.line, 'line', fallback)
}

function getResolvedStatus(isCorrect) {
  return isCorrect ? 'won' : 'lost'
}

export function getBettingWinningSide(winnerPlayerId, homePlayerId) {
  if (winnerPlayerId == null) return null
  return String(winnerPlayerId) === String(homePlayerId) ? 'home' : 'away'
}

function buildUpsertPayload(bet, isCorrect) {
  return {
    id: bet.id,
    status: getResolvedStatus(isCorrect),
    result_correct: isCorrect,
    resolved_at: new Date().toISOString(),
  }
}

// A push: the market landed exactly on the line (or the game itself ended in
// a tie), so neither side won or lost — void the bet so syncLedger refunds
// the wager instead of leaving strict >/< comparisons resolve it as a loss
// for both sides (over_under) or an unintended win for the other side
// (run_line).
function buildPushPayload(bet) {
  return {
    id: bet.id,
    status: 'void',
    result_correct: null,
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
    supabaseClient: supabase,
    ...config,
  }
}

async function updateBets(bets, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  if (!bets.length) return
  const updates = bets.map((bet) => {
    const { id, ...changes } = bet
    return resolvedConfig.supabaseClient.from(resolvedConfig.betsTable).update(changes).eq('id', id)
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
      const wager = readNumericField(bet, bet[resolvedConfig.wagerField], resolvedConfig.wagerField)
      return buildLedgerEntryBase(bet, -wager, BET_PLACED_REASON_PREFIX, resolvedConfig)
    })
}

function buildSettledLedgerRows(resolvedBets, placedBetIds, config) {
  return resolvedBets.map((bet) => {
    const payout = readNumericField(bet, bet[config.payoutField], config.payoutField)
    const wager = readNumericField(bet, bet[config.wagerField], config.wagerField)
    const hadPlacementDebit = placedBetIds.has(String(bet.id))
    const delta = bet.status === 'won'
      ? (hadPlacementDebit ? wager + payout : payout)
      : bet.status === 'void'
        ? (hadPlacementDebit ? wager : 0)
        : (hadPlacementDebit ? 0 : -wager)
    return buildLedgerEntryBase(bet, delta, BET_SETTLED_REASON_PREFIX, config)
  }).filter((entry) => Number(entry[config.ledgerChangeField] || 0) !== 0)
}

function settledLedgerFingerprint(rows, changeField) {
  return rows
    .map((row) => `${row.bet_id}|${row.reason}|${Number(row[changeField] || 0).toFixed(2)}`)
    .sort()
    .join(',')
}

// Brings the settled portion of the ledger in line with the bets' current
// statuses. It is idempotent by construction: when what the ledger already
// holds matches what these bets imply, it writes nothing at all, so repeating a
// settlement cannot move a balance. When they differ — a stranded settlement, a
// stale row left by a reopen, a correction — the settled rows are rebuilt from
// the durable bet statuses rather than appended to.
async function syncLedger(bets, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const resolvedBets = bets.filter((bet) => RESOLVED_STATUSES.includes(bet.status))
  if (!resolvedBets.length) return

  const betIds = resolvedBets.map((bet) => bet.id)
  // One read covers both halves: which bets were debited at placement, and what
  // settled rows already exist for them.
  const { data: ledgerRows, error: ledgerRowsError } = await resolvedConfig.supabaseClient
    .from(resolvedConfig.ledgerTable)
    .select('*')
    .in('bet_id', betIds)
  if (ledgerRowsError) throw ledgerRowsError

  const placedBetIds = new Set((ledgerRows || [])
    .filter((entry) => String(entry.reason || '').startsWith(`${BET_PLACED_REASON_PREFIX}:`))
    .map((entry) => String(entry.bet_id)))
  const existingSettled = (ledgerRows || [])
    .filter((entry) => String(entry.reason || '').startsWith(`${BET_SETTLED_REASON_PREFIX}:`))

  const expectedRows = buildSettledLedgerRows(resolvedBets, placedBetIds, resolvedConfig)
  const changeField = resolvedConfig.ledgerChangeField
  if (settledLedgerFingerprint(existingSettled, changeField) === settledLedgerFingerprint(expectedRows, changeField)) {
    return
  }

  if (existingSettled.length) {
    const { error: deleteError } = await resolvedConfig.supabaseClient
      .from(resolvedConfig.ledgerTable)
      .delete()
      .in('bet_id', betIds)
      .like('reason', `${BET_SETTLED_REASON_PREFIX}:%`)
    if (deleteError) throw deleteError
  }

  if (!expectedRows.length) return
  const { error } = await resolvedConfig.supabaseClient
    .from(resolvedConfig.ledgerTable)
    .upsert(expectedRows, { onConflict: 'bet_id,reason', ignoreDuplicates: true })
  if (error) throw error
}

// A settlement is two writes: the bet statuses, then the ledger. A timeout that
// lands after the status write commits used to strand the game forever — every
// retry read only `open`/`pending` bets, found none, and reported success while
// nobody was paid. Loading the already-resolved bets alongside the open ones
// lets each pass reconcile that gap before grading anything new.
async function loadSettleableBets(gameId, config) {
  const { data, error } = await config.supabaseClient
    .from(config.betsTable)
    .select('*')
    .eq('game_id', gameId)
    .in('status', SETTLEABLE_STATUSES)
  if (error) throw error
  const rows = data || []
  return {
    openBets: rows.filter((bet) => bet.status === 'open' || bet.status === 'pending'),
    resolvedBets: rows.filter((bet) => RESOLVED_STATUSES.includes(bet.status)),
  }
}

// Reverts a half-applied settlement: drop any settled ledger rows the failed
// pass may have committed, then put the bet statuses back so the game can be
// settled again cleanly. Both steps are best effort — the original failure is
// what the caller needs to see.
async function rollbackSettlement(updates, config) {
  const betIds = updates.map((update) => update.id)
  if (!betIds.length) return
  try {
    await config.supabaseClient
      .from(config.ledgerTable)
      .delete()
      .in('bet_id', betIds)
      .like('reason', `${BET_SETTLED_REASON_PREFIX}:%`)
  } catch { /* the rethrown settlement error is the actionable one */ }
  try {
    await config.supabaseClient
      .from(config.betsTable)
      .upsert(updates.map((update) => ({ id: update.id, status: 'open', result_correct: null, resolved_at: null })))
  } catch { /* as above */ }
}

// PART F — checks whether any run has been recorded in inning 1 of this game,
// excluding `excludePaId` (the PA currently being processed). Used to decide
// whether a first_inning_run bet can be settled yet via the "confirm via next
// play" rule: a run in inning 1 settles "yes" once a LATER play is recorded,
// and "no runs" settles once the first play of inning 2+ is recorded.
// Returns true (a run scored), false (none did), or null — inning 1 has no
// recorded plays or runs at all, so there is nothing to conclude from. Null
// matters for the live path: a game that has reached inning 2 with no inning-1
// plays on record has not published them yet, and settling "no runs" off that
// absence is settling on missing data. The game-completion fallback resolves
// those bets later against the finished game.
async function hasInning1Run(gameId, excludePaId, config) {
  const resolvedConfig = buildResolutionConfig(config)
  const { data: runRows, error: runsError } = await resolvedConfig.supabaseClient
    .from(resolvedConfig.runsScoredTable)
    .select('pa_id, inning')
    .eq('game_id', gameId)
    .eq('inning', 1)
  if (runsError) throw runsError

  const inning1Runs = (runRows || []).filter((entry) => String(entry.pa_id) !== String(excludePaId))
  if (inning1Runs.length) return true
  if ((runRows || []).length) return false

  const { data, error } = await resolvedConfig.supabaseClient
    .from(resolvedConfig.plateAppearancesTable)
    .select('id, inning, rbi, run_scored')
    .eq('game_id', gameId)
    .eq('inning', 1)
  if (error) throw error
  const otherInning1PAs = (data || []).filter((entry) => String(entry.id) !== String(excludePaId))
  if (!otherInning1PAs.length) return null
  return otherInning1PAs.some((entry) => Number(entry.rbi || 0) > 0 || entry.run_scored)
}

async function lockOdds(gameId, betType, targetEntity = null, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  let query = resolvedConfig.supabaseClient
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
  const { openBets, resolvedBets } = await loadSettleableBets(gameId, resolvedConfig)
  const updates = []

  // PART F — "confirm via next play": a first-inning-run bet settles once a
  // play AFTER the potentially-deciding moment has been recorded. If a run
  // already scored in inning 1 on an earlier play, this play confirms it
  // (settle "yes"). Otherwise, once the first play of inning 2+ is recorded,
  // that confirms inning 1 ended without a run (settle "no").
  const firstInningBets = openBets.filter((bet) => bet.bet_type === 'first_inning_run')
  if (firstInningBets.length) {
    // Settlement still waits for the following play so an immediately undone
    // scoring play does not pay out prematurely. Lock the market as soon as
    // the current first-inning play records a run, though: at that point the
    // "yes" outcome is already known and no new ticket may be accepted.
    const outcomeKnownOnCurrentPlay = Number(pa.inning) === 1
      && await hasInning1Run(gameId, null, resolvedConfig) === true
    const priorRun = await hasInning1Run(gameId, pa.id, resolvedConfig)
    let inning1Scored = null
    if (priorRun === true) {
      inning1Scored = true
    } else if (priorRun === false && Number(pa.inning) >= 2) {
      // priorRun === null means inning 1 has not been published yet — defer.
      inning1Scored = false
    }
    if (inning1Scored != null) {
      firstInningBets.forEach((bet) => updates.push(buildUpsertPayload(bet, (bet.chosen_side === 'yes') === inning1Scored)))
    }
    if (outcomeKnownOnCurrentPlay || inning1Scored != null) {
      await lockOdds(gameId, 'first_inning_run', null, resolvedConfig)
    }
  }

  if (updates.length) await updateBets(updates, resolvedConfig)

  const betsToSync = [
    ...openBets
      .filter((bet) => updates.some((update) => update.id === bet.id))
      .map((bet) => ({ ...bet, ...updates.find((update) => update.id === bet.id) })),
    // Already-resolved bets ride along so a settlement stranded by an earlier
    // timeout is repaired here. When the ledger already agrees this is free.
    ...resolvedBets,
  ]
  if (betsToSync.length) {
    try {
      await syncLedger(betsToSync, resolvedConfig)
    } catch (ledgerErr) {
      await rollbackSettlement(updates, resolvedConfig)
      throw ledgerErr
    }
  }

  return updates
}

export async function resolveFirstInningNoRun(gameId, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const { openBets, resolvedBets } = await loadSettleableBets(gameId, resolvedConfig)
  const firstInningBets = openBets.filter((bet) => bet.bet_type === 'first_inning_run')

  const updates = firstInningBets.map((bet) => buildUpsertPayload(bet, bet.chosen_side === 'no'))
  await updateBets(updates, resolvedConfig)
  const betsToSync = [
    ...firstInningBets.map((bet) => ({ ...bet, ...updates.find((update) => update.id === bet.id) })),
    ...resolvedBets,
  ]
  try {
    await syncLedger(betsToSync, resolvedConfig)
  } catch (ledgerErr) {
    await rollbackSettlement(updates, resolvedConfig)
    throw ledgerErr
  }
  await lockOdds(gameId, 'first_inning_run', null, resolvedConfig)
  return updates
}

export async function resolveGameBets(gameId, winningSide, totalRuns, pitcherKTotals = {}, margin = 0, config = {}, hrTotals = {}, hitTotals = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const { openBets, resolvedBets } = await loadSettleableBets(gameId, resolvedConfig)

  const updates = []
  let inning1RunFallback = null

  for (const bet of openBets) {
    if (bet.bet_type === 'moneyline') {
      // A tied final score (winningSide === null) is a push, not a loss for
      // both sides — chosen_side ('home'/'away') can never equal null.
      if (winningSide == null) {
        updates.push(buildPushPayload(bet))
        continue
      }
      updates.push(buildUpsertPayload(bet, bet.chosen_side === winningSide))
      continue
    }

    if (bet.bet_type === 'run_line') {
      const spread = getBetLine(bet, 1.5)
      if (winningSide == null || margin === spread) {
        updates.push(buildPushPayload(bet))
        continue
      }
      const homeCovers = winningSide === 'home' && margin > spread
      updates.push(buildUpsertPayload(bet, bet.chosen_side === 'home' ? homeCovers : !homeCovers))
      continue
    }

    if (bet.bet_type === 'over_under') {
      const line = getBetLine(bet)
      if (totalRuns === line) {
        updates.push(buildPushPayload(bet))
        continue
      }
      const isCorrect = bet.chosen_side === 'over' ? totalRuns > line : totalRuns < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      continue
    }

    if (bet.bet_type === 'k_prop') {
      const actualKs = Number(pitcherKTotals[bet.target_entity] || 0)
      const line = getBetLine(bet)
      const isCorrect = bet.chosen_side === 'over' ? actualKs > line : actualKs < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      continue
    }

    if (bet.bet_type === 'hr_prop') {
      const actualHRs = Number(hrTotals[bet.target_entity] || 0)
      const line = getBetLine(bet)
      const isCorrect = bet.chosen_side === 'over' ? actualHRs > line : actualHRs < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      continue
    }

    if (bet.bet_type === 'hit_prop') {
      const actualHits = Number(hitTotals[bet.target_entity] || 0)
      const line = getBetLine(bet)
      const isCorrect = bet.chosen_side === 'over' ? actualHits > line : actualHits < line
      updates.push(buildUpsertPayload(bet, isCorrect))
      continue
    }

    if (bet.bet_type === 'first_inning_run') {
      // PART F fallback — normally resolved via resolveOnPA's "confirm via
      // next play" check; this only fires for games that ended before any
      // inning-2 play was recorded (e.g. shortened games).
      if (inning1RunFallback == null) {
        // The game is over, so an inning 1 with nothing on record scored nothing.
        inning1RunFallback = await hasInning1Run(gameId, null, resolvedConfig) === true
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
  try {
    await syncLedger([
      ...openBets.map((bet) => ({ ...bet, ...updates.find((update) => update.id === bet.id) })),
      // Bets a previous pass already graded but never paid — see
      // loadSettleableBets. Reconciling them here is what makes a settlement
      // stranded by a timeout recoverable by simply running it again.
      ...resolvedBets,
    ], resolvedConfig)
  } catch (ledgerErr) {
    // Roll the newly graded bets back so the game can be re-resolved cleanly.
    await rollbackSettlement(updates, resolvedConfig)
    throw ledgerErr
  }
  // Calibration appends rows and moves the engine weights, so it belongs to the
  // pass that graded the bets. A retry that only reconciled the ledger (or found
  // nothing to do) must not count the same game a second time.
  if (updates.length) await runPostGameCalibration(gameId, resolvedConfig)
  return updates
}

const REVERSIBLE_BET_TYPES = ['moneyline', 'run_line', 'over_under', 'first_inning_run', 'k_prop', 'hr_prop', 'hit_prop']
// first_inning_run is the one market graded while a game is still being played.
const COMPLETION_ONLY_BET_TYPES = REVERSIBLE_BET_TYPES.filter((type) => type !== 'first_inning_run')

// What a finished reopen would still have to reverse on a game that is no
// longer complete: a market only completion grades that still reads settled,
// or a settled ledger row held by a bet that is open again. Either one means a
// reopen stopped partway. A settled first-inning bet is ordinary live play and
// is not reported.
export async function findUnreversedCompletionBets(gameId, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const { data, error } = await resolvedConfig.supabaseClient
    .from(resolvedConfig.betsTable)
    .select('*')
    .eq('game_id', gameId)
    .in('bet_type', REVERSIBLE_BET_TYPES)
    .in('status', SETTLEABLE_STATUSES)
  if (error) throw error
  const bets = data || []
  const settled = bets.filter((bet) => COMPLETION_ONLY_BET_TYPES.includes(bet.bet_type)
    && RESOLVED_STATUSES.includes(bet.status))
  const openIds = bets.filter((bet) => bet.status === 'open' || bet.status === 'pending').map((bet) => bet.id)
  const orphanedRows = await loadSettledLedgerRows(openIds, resolvedConfig)
  return { settled, orphanedRows }
}

async function loadSettledLedgerRows(betIds, config) {
  if (!betIds.length) return []
  const { data, error } = await config.supabaseClient
    .from(config.ledgerTable)
    .select('*')
    .in('bet_id', betIds)
    .like('reason', `${BET_SETTLED_REASON_PREFIX}:%`)
  if (error) throw error
  return data || []
}

// Success has to mean the reopened bets and the ledger agree, and nothing here
// holds a lock. A settlement can grade these bets again between the status
// write and the delete, and the delete then takes the credit that settlement
// just paid. Reading the ledger and then the statuses after the delete catches
// it: the newer settlement's rows are rebuilt from its own statuses and the
// reopen fails, rather than returning with a won ticket nobody was paid for.
// The same read catches a delete that reported success and removed nothing.
async function confirmReopenedLedger(gameId, betIds, config) {
  if (!betIds.length) return
  const settledRows = await loadSettledLedgerRows(betIds, config)
  const { data, error } = await config.supabaseClient
    .from(config.betsTable)
    .select('*')
    .in('id', betIds)
  if (error) throw error

  const bets = data || []
  const stillResolved = bets.filter((bet) => RESOLVED_STATUSES.includes(bet.status))
  if (stillResolved.length) {
    await syncLedger(stillResolved, config)
    throw new Error(
      `reopening game ${gameId} did not take: ${stillResolved.map(describeBet).join(', ')} still read as settled `
      + '(a settlement ran during the reopen, or the status change did not apply). Its ledger rows were left '
      + 'matching that settlement; reopen again to reverse it.',
    )
  }
  const openIds = new Set(bets.filter((bet) => bet.status === 'open' || bet.status === 'pending').map((bet) => String(bet.id)))
  const leftover = settledRows.filter((row) => openIds.has(String(row.bet_id)))
  if (leftover.length) {
    throw new Error(
      `reopening game ${gameId} left ${leftover.length} settled ledger row(s) on open bet(s) `
      + `${[...new Set(leftover.map((row) => row.bet_id))].join(', ')}; the delete did not remove them`,
    )
  }
}

// Reopening is two writes, statuses back to open and then the settled ledger
// rows removed, and the first used to erase the only evidence that the second
// was still owed: a retry after a failed or timed-out delete looked for
// won/lost/void bets, found none, and returned success with the payout still
// credited. Each pass now reads both sides. Resolved bets are reopened, and a
// settled row still held by any reversible bet on this game is removed whether
// or not this pass reopened it — an open bet can only hold one because an
// earlier reopen or rollback stopped halfway. Whichever write committed, running
// this again finishes the job.
export async function reopenGameBets(gameId, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  const { data: reversibleBets, error } = await resolvedConfig.supabaseClient
    .from(resolvedConfig.betsTable)
    .select('*')
    .eq('game_id', gameId)
    .in('bet_type', REVERSIBLE_BET_TYPES)
    .in('status', SETTLEABLE_STATUSES)

  if (error) throw error

  const bets = reversibleBets || []
  const updates = bets
    .filter((bet) => RESOLVED_STATUSES.includes(bet.status))
    .map((bet) => ({
      id: bet.id,
      status: 'open',
      result_correct: null,
      resolved_at: null,
    }))
  await updateBets(updates, resolvedConfig)

  const betIds = bets.map((bet) => bet.id)
  const staleRows = await loadSettledLedgerRows(betIds, resolvedConfig)
  if (staleRows.length) {
    const { error: ledgerError } = await resolvedConfig.supabaseClient
      .from(resolvedConfig.ledgerTable)
      .delete()
      .in('bet_id', [...new Set(staleRows.map((row) => row.bet_id))])
      .like('reason', `${BET_SETTLED_REASON_PREFIX}:%`)
    if (ledgerError) throw ledgerError
  }
  await confirmReopenedLedger(gameId, betIds, resolvedConfig)

  // Calibration rows go last. By here the balance change is done and confirmed,
  // so a retry after this step fails finds a ledger that already agrees and
  // writes nothing to it.
  if (resolvedConfig.enableCalibrationLogging && resolvedConfig.oddsCalibrationTable) {
    const { error: calibrationError } = await resolvedConfig.supabaseClient.from(resolvedConfig.oddsCalibrationTable).delete().eq('game_id', gameId)
    if (calibrationError) throw calibrationError
  }
  return updates
}

export async function runPostGameCalibration(gameId, config = {}) {
  const resolvedConfig = buildResolutionConfig(config)
  if (!resolvedConfig.enableCalibrationLogging && !resolvedConfig.enableWeightAdjustment) return null

  const queries = [
    resolvedConfig.supabaseClient
      .from(resolvedConfig.betsTable)
      .select('*')
      .eq('game_id', gameId)
      .in('status', ['won', 'lost']),
  ]

  if (resolvedConfig.enableWeightAdjustment && resolvedConfig.weightsTable) {
    queries.push(
      resolvedConfig.supabaseClient
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

  // A game with no graded probability predictions contains no calibration
  // signal. Treat it as a no-op instead of recording a synthetic 0 Brier
  // score and incrementing the global games_evaluated counter on every
  // complete/recomplete cycle.
  if (!predictions.length) {
    return { brierScore: null, weights: null }
  }

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
    const { error } = await resolvedConfig.supabaseClient.from(resolvedConfig.oddsCalibrationTable).insert(calibrationRows)
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

    const { error: upsertError } = await resolvedConfig.supabaseClient.from(resolvedConfig.weightsTable).upsert({
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
