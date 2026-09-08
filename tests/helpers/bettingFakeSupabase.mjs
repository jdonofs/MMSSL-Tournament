// Deterministic in-memory Supabase stand-in for the betting integration suite.
//
// It is deliberately separate from `trackerFakeSupabase.mjs` (which the tracker
// suite owns) because the betting path needs three things that helper does not
// model:
//   * `.like()` filters — `syncLedger`/`reopenGameBets` scope ledger rows by
//     `reason LIKE 'bet_settled:%'`.
//   * `upsert()` with no `onConflict` must reconcile on the primary key, the
//     way PostgREST does. `persistOddsRowsWithFallback` and the bet-status
//     rollback both rely on that.
//   * `ignoreDuplicates` against a conflict target, used by the settled-ledger
//     upsert.
//
// Failure injection mirrors the tracker helper's vocabulary so the two suites
// read the same way:
//   mode 'before'      -> query returns an error, nothing is written
//   mode 'after'       -> the write commits, then the response reports an error
//                         (a database timeout after a successful write)
//   mode 'stale'       -> a select returns caller-supplied rows instead of the
//                         real ones (delayed publication / stale read)
//   mode 'throwBefore' -> the process dies before the write
//   mode 'throwAfter'  -> the process dies after the write commits

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalized(value) {
  if (value == null) return value
  return String(value)
}

function likeMatches(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
  return new RegExp(`^${escaped}$`).test(String(value ?? ''))
}

function nextId(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function ruleMatches(rule, operation) {
  if (rule.table && rule.table !== operation.table) return false
  if (rule.action && rule.action !== operation.action) return false
  if (rule.occurrence != null && rule.occurrence !== operation.tableActionOccurrence) return false
  if (typeof rule.when === 'function' && !rule.when(operation)) return false
  return true
}

class BettingQuery {
  constructor(owner, table) {
    this.owner = owner
    this.table = table
    this.action = 'select'
    this.payload = null
    this.upsertOptions = {}
    this.filters = []
    this.mode = 'many'
    this.returnRows = false
    this.ordering = null
    this.rangeBounds = null
    this.limitCount = null
  }

  select() { if (this.action !== 'select') this.returnRows = true; return this }
  insert(payload) { this.action = 'insert'; this.payload = Array.isArray(payload) ? payload : [payload]; return this }
  update(payload) { this.action = 'update'; this.payload = payload; return this }
  delete() { this.action = 'delete'; return this }
  upsert(payload, options = {}) {
    this.action = 'upsert'
    this.payload = Array.isArray(payload) ? payload : [payload]
    this.upsertOptions = options
    return this
  }

  eq(field, value) { this.filters.push({ type: 'eq', field, value }); return this }
  neq(field, value) { this.filters.push({ type: 'neq', field, value }); return this }
  in(field, values) { this.filters.push({ type: 'in', field, value: values }); return this }
  is(field, value) { this.filters.push({ type: 'is', field, value }); return this }
  like(field, pattern) { this.filters.push({ type: 'like', field, value: pattern }); return this }
  order(field, options = {}) { this.ordering = { field, ascending: options.ascending !== false }; return this }
  range(start, end) { this.rangeBounds = { start, end }; return this }
  limit(count) { this.limitCount = count; return this }
  single() { this.mode = 'single'; return this }
  maybeSingle() { this.mode = 'maybeSingle'; return this }
  then(resolve, reject) { return this.execute().then(resolve, reject) }

  matches(row) {
    return this.filters.every((filter) => {
      if (filter.type === 'eq') return normalized(row[filter.field]) === normalized(filter.value)
      if (filter.type === 'neq') return normalized(row[filter.field]) !== normalized(filter.value)
      if (filter.type === 'in') return filter.value.map(normalized).includes(normalized(row[filter.field]))
      if (filter.type === 'like') return likeMatches(row[filter.field], filter.value)
      return filter.value == null ? row[filter.field] == null : row[filter.field] === filter.value
    })
  }

  format(rows) {
    let result = rows.filter((row) => this.matches(row))
    if (this.ordering) {
      const { field, ascending } = this.ordering
      result = [...result].sort((a, b) => {
        const left = a?.[field]
        const right = b?.[field]
        if (left == null && right == null) return 0
        if (left == null) return ascending ? 1 : -1
        if (right == null) return ascending ? -1 : 1
        if (left > right) return ascending ? 1 : -1
        if (left < right) return ascending ? -1 : 1
        return 0
      })
    }
    if (this.limitCount != null) result = result.slice(0, this.limitCount)
    if (this.rangeBounds) result = result.slice(this.rangeBounds.start, this.rangeBounds.end + 1)
    if (this.mode === 'single' || this.mode === 'maybeSingle') return result[0] || null
    return result
  }

  _uniqueViolation(rows, candidate, ignoreRow = null) {
    const constraints = this.owner.unique[this.table] || []
    const conflict = constraints.find((fields) => fields.every((field) => candidate[field] != null)
      && rows.some((row) => row !== ignoreRow && fields.every((field) => normalized(row[field]) === normalized(candidate[field]))))
    return conflict
      ? { code: '23505', message: `duplicate key value violates unique constraint on (${conflict.join(',')}) in ${this.table}` }
      : null
  }

  async execute() {
    const state = this.owner.state
    const rows = state.tables[this.table] ||= []
    const key = `${this.action}:${this.table}`
    const occurrence = (state.counts.get(key) || 0) + 1
    state.counts.set(key, occurrence)
    const operation = {
      sequence: state.operations.length + 1,
      table: this.table,
      action: this.action,
      tableActionOccurrence: occurrence,
      payload: clone(this.payload),
      filters: clone(this.filters),
    }
    state.operations.push(operation)

    const rule = this.owner.failures.find((candidate) => candidate.remaining > 0 && ruleMatches(candidate, operation))
    if (rule) {
      rule.remaining -= 1
      operation.injected = rule.mode
      if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs))
      if (rule.mode === 'stale') {
        return { data: clone(typeof rule.data === 'function' ? rule.data(rows) : (rule.data ?? [])), error: null }
      }
      if (rule.mode === 'before') return { data: null, error: clone(rule.error || { message: `injected ${key} failure` }) }
      if (rule.mode === 'throwBefore') throw new Error(rule.error?.message || `injected ${key} crash before write`)
    }

    let data = null
    let error = null

    if (this.action === 'select') {
      data = clone(this.format(rows))
    } else if (this.action === 'insert') {
      const created = []
      for (const item of this.payload) {
        const violation = this._uniqueViolation(rows, item)
        if (violation) { error = violation; break }
        const row = clone(item)
        if (row.id == null) row.id = nextId(rows)
        rows.push(row)
        created.push(row)
      }
      data = error ? null : (this.mode === 'single' ? clone(created[0] || null) : clone(created))
    } else if (this.action === 'update') {
      const changed = rows.filter((row) => this.matches(row))
      changed.forEach((row) => Object.assign(row, clone(this.payload)))
      data = this.returnRows ? clone(changed) : null
    } else if (this.action === 'delete') {
      const removed = rows.filter((row) => this.matches(row))
      state.tables[this.table] = rows.filter((row) => !this.matches(row))
      data = this.returnRows ? clone(removed) : null
    } else if (this.action === 'upsert') {
      const conflictFields = String(this.upsertOptions?.onConflict || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
      const touched = []
      for (const item of this.payload) {
        const candidate = clone(item)
        let existing = null
        if (conflictFields.length) {
          // PostgREST resolves the conflict target only when every column in it
          // is present and non-null; a NULL member leaves the row distinct.
          const targetUsable = conflictFields.every((field) => candidate[field] != null)
          if (targetUsable) {
            existing = rows.find((row) => conflictFields.every((field) => normalized(row[field]) === normalized(candidate[field])))
          }
        } else if (candidate.id != null) {
          existing = rows.find((row) => normalized(row.id) === normalized(candidate.id))
        }

        if (existing) {
          if (!this.upsertOptions?.ignoreDuplicates) Object.assign(existing, candidate)
          touched.push(existing)
          continue
        }
        const violation = this._uniqueViolation(rows, candidate)
        if (violation) { error = violation; break }
        if (candidate.id == null) candidate.id = nextId(rows)
        rows.push(candidate)
        touched.push(candidate)
      }
      data = error ? null : (this.mode === 'single' ? clone(touched[0] || null) : clone(touched))
    } else {
      throw new Error(`Unsupported fake Supabase action: ${this.action}`)
    }

    if (rule?.mode === 'throwAfter') throw new Error(rule.error?.message || `injected ${key} crash after commit`)
    if (rule?.mode === 'after') return { data: null, error: clone(rule.error || { message: `injected ${key} timeout after commit` }) }
    return { data, error }
  }
}

export function createBettingFakeSupabase(initialTables = {}, options = {}) {
  const state = options.state || {
    tables: {},
    operations: [],
    counts: new Map(),
  }
  Object.entries(initialTables).forEach(([table, rows]) => {
    if (!state.tables[table]) state.tables[table] = clone(rows)
  })

  const client = {
    state,
    db: state.tables,
    operations: state.operations,
    unique: options.unique || {},
    failures: (options.failures || []).map((rule) => ({ remaining: rule.times ?? 1, ...rule })),
    from(table) { return new BettingQuery(client, table) },
    // Placement is a server-side RPC (place_tournament_bets/place_season_bets).
    // It is deliberately not modelled: nothing local may claim to reproduce the
    // server's balance enforcement.
    rpc: async () => ({ data: null, error: { message: 'rpc is server-enforced and not modelled locally' } }),
    // Continue against the same data with a different failure script — models a
    // retry by a fresh process after a crash or timeout.
    restart(restartOptions = {}) {
      return createBettingFakeSupabase({}, { unique: client.unique, ...restartOptions, state })
    },
  }
  return client
}

export function countOperations(client, { table, action } = {}) {
  return client.operations.filter((entry) => (
    (!table || entry.table === table) && (!action || entry.action === action)
  )).length
}
