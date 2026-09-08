// Writes and reads the append-only odds-history tables.
//
// Kept next to `oddsPersistence.js` and shaped the same way: the caller stays
// usable when the schema addition has not been applied. A missing table is a
// reported status, never a thrown error — betting must keep working on a
// database that has no history tables at all.

import { fetchAllRows } from './fetchAllRows.js'
import {
  buildLatestObservationsByKey,
  buildOddsHistoryRows,
  getOddsHistoryTable,
  isDuplicateObservationError,
  isMissingOddsHistoryTableError,
} from './oddsHistory.js'

export const ODDS_HISTORY_STATUS = {
  ok: 'ok',
  unavailable: 'unavailable',
  duplicate: 'duplicate',
  error: 'error',
}

export async function loadGameOddsHistory({ supabase, sourceType, gameId, table = null }) {
  const historyTable = table || getOddsHistoryTable(sourceType)
  const { data, error } = await fetchAllRows(
    () => supabase.from(historyTable).select('*').eq('game_id', gameId),
  )
  if (error) {
    if (isMissingOddsHistoryTableError(error)) {
      return { rows: [], status: ODDS_HISTORY_STATUS.unavailable, error: null }
    }
    return { rows: [], status: ODDS_HISTORY_STATUS.error, error }
  }
  return { rows: data || [], status: ODDS_HISTORY_STATUS.ok, error: null }
}

// Appends one observation per market whose priced values differ from the newest
// observation already recorded for it. Markets that have not moved write
// nothing, which is what keeps a repeated sync — or a retry after a timeout —
// from adding a second identical row.
export async function recordOddsObservations({
  supabase,
  sourceType,
  table = null,
  gameId,
  rows = [],
  gameContext = {},
  source = 'tracker_sync',
  observedAt = null,
}) {
  const historyTable = table || getOddsHistoryTable(sourceType)
  if (!rows.length) return { recorded: [], status: ODDS_HISTORY_STATUS.ok, error: null }

  const existing = await loadGameOddsHistory({ supabase, sourceType, gameId, table: historyTable })
  if (existing.status !== ODDS_HISTORY_STATUS.ok) {
    return { recorded: [], status: existing.status, error: existing.error }
  }

  const payload = buildOddsHistoryRows({
    rows,
    latestByKey: buildLatestObservationsByKey(existing.rows),
    gameId,
    gameContext,
    source,
    observedAt,
  })
  if (!payload.length) return { recorded: [], status: ODDS_HISTORY_STATUS.ok, error: null }

  const { data, error } = await supabase.from(historyTable).insert(payload).select()
  if (error) {
    if (isMissingOddsHistoryTableError(error)) {
      return { recorded: [], status: ODDS_HISTORY_STATUS.unavailable, error: null }
    }
    // The successor unique index rejected the batch: another writer recorded
    // the same step first. That is the index doing its job, not a failure.
    if (isDuplicateObservationError(error)) {
      return { recorded: [], status: ODDS_HISTORY_STATUS.duplicate, error: null }
    }
    return { recorded: [], status: ODDS_HISTORY_STATUS.error, error }
  }

  return { recorded: data || [], status: ODDS_HISTORY_STATUS.ok, error: null }
}
