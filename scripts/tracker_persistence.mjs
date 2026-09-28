import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function normalize(value) {
  if (value == null) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

const TRACKING_NUMERIC_TABLES = new Set([
  'tracking_sessions', 'tracking_plays', 'tracking_throws', 'fielding_opportunities',
  'movement_metrics', 'runner_opportunities', 'double_play_opportunities',
])

function trackingNumericScale(table, field) {
  if (!TRACKING_NUMERIC_TABLES.has(table)) return null
  if (table === 'tracking_sessions' && ['duration_seconds', 'frame_rate'].includes(field)) return 3
  if (['route_efficiency', 'jump_route_efficiency', 'join_confidence'].includes(field)) return 5
  if (/^(expected_.*probability|outs_above_average|(?:arm|runner|run)_run_value|double_plays_added|run_value)$/.test(field)) return 6
  return 4
}

// recompute_advanced_metrics.mjs prices stadium_runs in place on EVERY stored
// play, a half-written replacement's included. So an ingest resuming that
// replacement rebuilds the unpriced facts and finds them priced: season game
// 2811's resume was refused over play 5 after 2813's ingest repriced it.
function withoutRecomputedPrice(quality) {
  if (!quality?.stadium_runs || typeof quality.stadium_runs !== 'object') return quality
  const { price, ...facts } = quality.stadium_runs
  return { ...quality, stadium_runs: facts }
}

function sameValue(left, right, field = '', table = '') {
  if (left == null && right == null) return true
  if (table === 'tracking_plays' && field === 'quality') {
    left = withoutRecomputedPrice(left)
    right = withoutRecomputedPrice(right)
  }
  const scale = trackingNumericScale(table, field)
  if (scale != null && typeof left === 'number' && typeof right === 'number'
      && Number.isFinite(left) && Number.isFinite(right)) {
    if (left === right) return true
    const factor = 10 ** scale
    const rounded = Math.sign(right) * Math.round((Math.abs(right) + Number.EPSILON) * factor) / factor
    return left === rounded
  }
  if (/(?:_at|_utc)$/.test(field) && left != null && right != null) {
    const leftTime = Date.parse(left)
    const rightTime = Date.parse(right)
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime === rightTime
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(canonicalJson(left ?? null)) === JSON.stringify(canonicalJson(right ?? null))
  }
  return normalize(left) === normalize(right)
}

export function isDuplicateKeyError(error) {
  return String(error?.code || '') === '23505'
    || /duplicate key|unique constraint/i.test(String(error?.message || ''))
}

export function rowsMatchPayload(row, payload, fields = Object.keys(payload || {}), table = '') {
  return Boolean(row) && fields.every((field) => sameValue(row[field], payload[field], field, table))
}

export async function selectByKey(supabase, table, key) {
  let query = supabase.from(table).select('*')
  for (const [field, value] of Object.entries(key)) {
    query = value == null ? query.is(field, null) : query.eq(field, value)
  }
  const { data, error } = await query
  if (error) throw error
  return data || []
}

export async function insertOneReconciled(supabase, table, payload, {
  key,
  compareFields = Object.keys(payload),
  attempts = 3,
} = {}) {
  if (!key || !Object.keys(key).length) throw new Error(`${table}: a reconciliation key is required`)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const existing = await selectByKey(supabase, table, key)
    const exact = existing.find((row) => rowsMatchPayload(row, payload, compareFields, table))
    if (exact) return { row: exact, inserted: false }
    if (existing.length) {
      const mismatched = compareFields.filter((field) =>
        existing.every((row) => !sameValue(row[field], payload[field], field, table)))
      throw new Error(`${table}: durable key ${JSON.stringify(key)} already belongs to different data (${mismatched.join(', ')})`)
    }

    const { data, error } = await supabase.from(table).insert(payload).select('*').single()
    if (!error && data) return { row: data, inserted: true }

    // A timeout or duplicate response is ambiguous: the server may have
    // committed the row. Read the authoritative table before retrying.
    const committed = await selectByKey(supabase, table, key)
    const committedExact = committed.find((row) => rowsMatchPayload(row, payload, compareFields, table))
    if (committedExact) return { row: committedExact, inserted: true, reconciled: true }
    if (error && !isDuplicateKeyError(error)) {
      if (attempt === attempts - 1) throw error
      continue
    }
  }
  throw new Error(`${table}: write could not be reconciled for ${JSON.stringify(key)}`)
}

export async function insertRowsReconciled(supabase, table, rows, {
  keyFields,
  compareFields = null,
} = {}) {
  if (!Array.isArray(keyFields) || !keyFields.length) {
    throw new Error(`${table}: keyFields are required`)
  }
  const result = []
  // Deliberately one row at a time. If a response fails halfway through a
  // former batch, every committed row has an independently readable key and
  // the next attempt resumes at the first missing row.
  for (const payload of rows || []) {
    const key = Object.fromEntries(keyFields.map((field) => [field, payload[field]]))
    const saved = await insertOneReconciled(supabase, table, payload, {
      key,
      compareFields: compareFields || Object.keys(payload),
    })
    result.push(saved.row)
  }
  return result
}

export async function updateRowsVerified(supabase, table, key, patch, {
  allowMissing = false,
} = {}) {
  let query = supabase.from(table).update(patch)
  for (const [field, value] of Object.entries(key)) {
    query = value == null ? query.is(field, null) : query.eq(field, value)
  }
  const { error } = await query
  const rows = await selectByKey(supabase, table, key)
  if (!rows.length && allowMissing) return []
  if (!rows.length) throw error || new Error(`${table}: update target ${JSON.stringify(key)} does not exist`)
  if (rows.every((row) => rowsMatchPayload(row, patch, Object.keys(patch), table))) return rows
  const mismatched = Object.keys(patch).filter((field) =>
    rows.some((row) => !sameValue(row[field], patch[field], field, table)))
  throw error || new Error(`${table}: update response succeeded but read-back did not match (${mismatched.join(', ')})`)
}

export function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// The lock's name is part of its contract: scripts/mss_autogame.mjs reads it
// (and only reads it) to refuse a second launch against a game a bridge
// already owns, so the two must agree on where the file lives.
export function trackerGameLockPath({ competitionType, gameId, directory = os.tmpdir() }) {
  return path.join(directory, `mss-tracker-${competitionType}-${gameId}.lock`)
}

// The live owner of a lock file, or null. A lock whose pid is gone is a
// crashed bridge rather than a running one, and is reported as no owner --
// the same reading acquireTrackerGameLock() takes before it reclaims the file.
export function trackerGameLockOwner(lockPath) {
  let owner = null
  try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch { return null }
  return processExists(Number(owner?.pid)) ? owner : null
}

export function acquireTrackerGameLock({ competitionType, gameId, directory = os.tmpdir() }) {
  const lockPath = trackerGameLockPath({ competitionType, gameId, directory })
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const claim = () => {
    const handle = fs.openSync(lockPath, 'wx')
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
    fs.closeSync(handle)
  }
  try {
    claim()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let owner = null
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch { /* stale/corrupt lock */ }
    if (processExists(Number(owner?.pid))) {
      throw new Error(`another tracker bridge (pid ${owner.pid}) already owns ${competitionType} game ${gameId}`)
    }
    fs.unlinkSync(lockPath)
    claim()
  }
  let released = false
  return {
    path: lockPath,
    release() {
      if (released) return
      released = true
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
        if (Number(owner?.pid) === process.pid) fs.unlinkSync(lockPath)
      } catch { /* already removed */ }
    },
  }
}

export async function drainTrackerWork(promises, { requiredFailure = null } = {}) {
  const settled = await Promise.allSettled((promises || []).filter(Boolean))
  const failed = settled.filter((result) => result.status === 'rejected')
  const persistenceFailure = typeof requiredFailure === 'function' ? requiredFailure() : requiredFailure
  if (failed.length || persistenceFailure) {
    throw failed[0]?.reason || persistenceFailure
  }
  return settled.map((result) => result.value)
}
