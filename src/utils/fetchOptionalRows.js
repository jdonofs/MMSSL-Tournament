// A paginated read of a table that may not exist yet.
//
// Every other read on the character page is required: if it fails, the page
// keeps the numbers it already had rather than showing a line built from half
// the data. That is the right default and it is the wrong one for a table
// added in the same change as the feature that reads it, because a database
// one migration behind would lose the whole page instead of three rows of it.
//
// ONLY A MISSING TABLE IS TOLERATED. A timeout, a permission refusal or any
// other fault still comes back as an error and still stops the page -- the
// same distinction scripts/ingest_player_tracking.mjs draws when it writes
// this table, and the same one activeTrackingVersions.js draws between "no
// versions exist" and "the answer is unknown".

import { fetchAllRows } from './fetchAllRows.js'

// PGRST205: PostgREST cannot find the table in its schema cache.
// 42P01: Postgres itself says the relation does not exist.
const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01'])

export function isMissingTableError(error) {
  if (!error) return false
  if (MISSING_TABLE_CODES.has(String(error.code))) return true
  // PostgREST does not always set `code` on a 404 from an older deployment.
  return /could not find the table|does not exist/i.test(String(error.message || ''))
}

/**
 * Resolves to `{ data, error, missing }`, never rejects.
 *
 * `missing: true` means the table is not there, `data` is empty and `error` is
 * null -- so the caller's "did any read fail" check passes and the feature
 * that needs the table can say it is unavailable instead of showing a zero.
 */
export async function fetchOptionalRows(supabase, table, select = '*') {
  const result = await fetchAllRows(() => supabase.from(table).select(select))
  if (result?.error && isMissingTableError(result.error)) {
    return { data: [], error: null, missing: true }
  }
  return { ...result, missing: false }
}
