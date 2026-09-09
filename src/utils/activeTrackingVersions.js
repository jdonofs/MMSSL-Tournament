// Which tracking facts are the authoritative ones.
//
// A tracking session is `(competition_type, game_id, raw_stem, version)` and
// exactly one version per stem is active -- see
// supabase/migrations/20260908123000_tracking_session_versions.sql. A
// replacement is BUILT beside the completed version and only becomes active
// when it is finished, so at any moment the tracking tables can hold, for the
// same plays:
//
//   * the version that is active and correct,
//   * a superseded version kept as history (nothing deletes one),
//   * a replacement that is still being built, or was abandoned half-built.
//
// Every reader of `fielding_opportunities`, `movement_metrics` and
// `tracking_throws` was reading all three at once. The same play then entered a
// character's line twice, and both a retained old version and an unfinished
// replacement fed the catch-probability and arm models as though they were
// independent observations of different plays.
//
// AN UNKNOWN ANSWER IS NOT AN EMPTY ONE. The first version of this file caught
// every failure and returned an empty exclusion set, on the reasoning that
// dropping data because a query failed is the worse error. That reasoning holds
// for a database with no versioning migration -- there, "nothing is superseded"
// is the TRUE answer -- and it is wrong for everything else. A statement
// timeout on `tracking_sessions` produced the same empty set, so a superseded
// version and the active one were counted together, the duplicate landed in a
// character's line, and `recompute_advanced_metrics` PERSISTED models built out
// of it. Neither outcome is acceptable, so there are now three answers rather
// than two:
//
//   { data: Set }              membership is known
//   { data: Set, legacy: why } the schema cannot express versions; nothing is
//                              superseded, which is the real answer here
//   { error }                  membership is UNKNOWN -- the caller must not
//                              publish or persist an aggregate built from it
//
// The shape is `{ data, error }` on purpose: it is what fetchAllRows returns,
// so the existing "did any of these reads fail" check in every consumer covers
// this read too instead of each one needing its own branch.
//
// PAGINATION IS NOT OPTIONAL EITHER. Both reads were single un-paginated
// selects, and PostgREST caps a response at 1000 rows without saying so. Past
// a thousand plays in superseded versions, the 1001st stayed in the exclusion
// set's blind spot and was counted as an official fact -- the exact failure
// fetchAllRows exists for.

import { fetchAllRows } from './fetchAllRows.js'

// How many session ids go into one `in (...)` filter. PostgREST puts the list
// in the URL, so an unbounded list becomes a request too long to send.
const SESSION_ID_BATCH = 100

/**
 * A schema that cannot express versions at all, as distinct from a read that
 * failed.
 *
 * `is_active` arrives in 20260908123000_tracking_session_versions.sql and
 * `tracking_sessions` itself in the tracking migration before it. A database
 * without either has no superseded versions to exclude, and that is a real
 * answer. NARROW ON PURPOSE, exactly like isMissingFunction() in
 * scripts/tracker_game_lease.mjs: a code that names some other fault settles
 * it, and only the shape of "this column/table is not here" is eligible.
 */
export function isLegacyTrackingSchema(error) {
  const code = String(error?.code || '')
  // 42703 undefined_column, 42P01 undefined_table; PostgREST reports the same
  // two as PGRST204 (column not found) and PGRST205 (table not in schema).
  if (code === '42703' || code === '42P01' || code === 'PGRST204' || code === 'PGRST205') return true
  if (code) return false
  return /column .*(is_active|does not exist)|relation .* does not exist|could not find the .* column/i
    .test(String(error?.message || ''))
}

/** The ids of tracking plays that belong to a version which is not active. */
export function supersededTrackingPlayIds(sessions, plays) {
  const superseded = new Set(
    (sessions || []).filter((row) => row?.is_active === false).map((row) => String(row.id)),
  )
  if (!superseded.size) return new Set()
  return new Set(
    (plays || [])
      .filter((row) => superseded.has(String(row?.tracking_session_id)))
      .map((row) => String(row.id)),
  )
}

/**
 * Drop the fact rows that hang off a superseded or unfinished version.
 *
 * Refuses anything but a Set (or nothing at all). The exclusion set used to be
 * the bare return value of the fetch below, and that fetch now answers with a
 * `{ data, error }` result -- an object which is always truthy, has no `.size`,
 * and would therefore have silently filtered nothing while looking filtered.
 */
export function onlyActiveTrackingFacts(rows, supersededPlayIds) {
  if (supersededPlayIds != null && !(supersededPlayIds instanceof Set)) {
    throw new TypeError(
      'onlyActiveTrackingFacts needs the Set of superseded play ids, not the fetch result: '
      + 'pass result.data, and refuse to publish the aggregate when result.error is set.',
    )
  }
  if (!supersededPlayIds?.size) return rows || []
  return (rows || []).filter((row) => !supersededPlayIds.has(String(row?.tracking_play_id)))
}

/**
 * Ask the database which tracking plays are no longer authoritative.
 *
 * Resolves to `{ data, error, legacy }`, never rejects. `data` is the exclusion
 * set and is only meaningful when `error` is null; see the header for why an
 * unknown answer is reported rather than flattened into an empty one.
 */
export async function fetchSupersededTrackingPlayIds(supabase) {
  try {
    const sessions = await fetchAllRows(
      () => supabase.from('tracking_sessions').select('id,is_active'))
    if (sessions.error) {
      if (isLegacyTrackingSchema(sessions.error)) {
        return {
          data: new Set(),
          error: null,
          legacy: `this database does not version tracking sessions (${sessions.error.message
            || sessions.error.code || 'no is_active column'})`,
        }
      }
      return { data: null, error: sessions.error, legacy: null }
    }
    const superseded = (sessions.data || [])
      .filter((row) => row?.is_active === false).map((row) => row.id)
    if (!superseded.length) return { data: new Set(), error: null, legacy: null }

    const excluded = new Set()
    for (let index = 0; index < superseded.length; index += SESSION_ID_BATCH) {
      const batch = superseded.slice(index, index + SESSION_ID_BATCH)
      const plays = await fetchAllRows(() => supabase
        .from('tracking_plays').select('id,tracking_session_id').in('tracking_session_id', batch))
      if (plays.error) {
        if (isLegacyTrackingSchema(plays.error)) {
          return {
            data: new Set(),
            error: null,
            legacy: `this database has no tracking_plays to exclude (${plays.error.message
              || plays.error.code})`,
          }
        }
        return { data: null, error: plays.error, legacy: null }
      }
      for (const row of plays.data || []) excluded.add(String(row.id))
    }
    return { data: excluded, error: null, legacy: null }
  } catch (error) {
    // A client that throws rather than returning an error -- a network fault, a
    // builder that is not a builder -- is an operational failure like any
    // other, and is reported as one rather than as "nothing is superseded".
    return {
      data: null,
      error: error instanceof Error ? error : new Error(String(error)),
      legacy: null,
    }
  }
}
