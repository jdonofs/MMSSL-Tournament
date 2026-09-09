function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalized(value) {
  return value == null ? value : String(value)
}

// Insertion order as a real timestamp. It has to be a VALID date and it has to
// keep increasing: several consumers order rows by created_at, and the earlier
// `00:00:${id}` form silently became "00:00:78Z" -- not a time -- once a table
// held sixty rows, so `new Date(...)` produced NaN and every comparison against
// it was false. A game's later plate appearances then matched no pitching
// stint at all, which looks exactly like a bridge that stopped attributing.
function stampFor(id) {
  return new Date(Date.UTC(2026, 0, 1) + (Number(id) || 0) * 1000).toISOString()
}

function nextId(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function ruleMatches(rule, operation) {
  return (!rule.table || rule.table === operation.table)
    && (!rule.action || rule.action === operation.action)
    && (rule.occurrence == null || rule.occurrence === operation.tableActionOccurrence)
    && (typeof rule.when !== 'function' || rule.when(operation))
}

function likeMatches(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
  return new RegExp(`^${escaped}$`).test(String(value ?? ''))
}

class Query {
  constructor(owner, table) {
    this.owner = owner
    this.table = table
    this.action = 'select'
    this.payload = null
    this.filters = []
    this.mode = 'many'
    this.returnRows = false
    this.ordering = null
    this.rangeBounds = null
    this.limitCount = null
  }

  select(_columns = '*', options = {}) {
    if (this.action !== 'select') this.returnRows = true
    // PostgREST reports the matching row count in Content-Range; supabase-js
    // surfaces it as `count`, and `head: true` means the caller wants only
    // that. The bridge decides whether a game is pristine this way.
    if (options.count) this.countMode = options.count
    if (options.head) this.headOnly = true
    return this
  }
  insert(payload) { this.action = 'insert'; this.payload = Array.isArray(payload) ? payload : [payload]; return this }
  update(payload) { this.action = 'update'; this.payload = payload; return this }
  delete() { this.action = 'delete'; return this }
  upsert(payload, options = {}) { this.action = 'upsert'; this.payload = Array.isArray(payload) ? payload : [payload]; this.upsertOptions = options; return this }
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

  uniqueViolation(rows, candidate, ignoreRow = null) {
    const constraints = this.owner.unique[this.table] || []
    const conflict = constraints.find((fields) => fields.every((field) => candidate[field] != null)
      && rows.some((row) => row !== ignoreRow
        && fields.every((field) => normalized(row[field]) === normalized(candidate[field]))))
    return conflict
      ? { code: '23505', message: `duplicate key on ${conflict.join(',')}` }
      : null
  }

  format(rows) {
    let result = rows.filter((row) => this.matches(row))
    if (this.ordering) {
      const { field, ascending } = this.ordering
      result = [...result].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (ascending ? 1 : -1))
    }
    if (this.limitCount != null) result = result.slice(0, this.limitCount)
    if (this.rangeBounds) result = result.slice(this.rangeBounds.start, this.rangeBounds.end + 1)
    if (this.mode === 'single' || this.mode === 'maybeSingle') return result[0] || null
    return result
  }

  async execute() {
    const state = this.owner.state
    const rows = state.tables[this.table] ||= []
    state.counts ||= new Map()
    const counterKey = `${this.action}:${this.table}`
    const occurrence = (state.counts.get(counterKey) || 0) + 1
    state.counts.set(counterKey, occurrence)
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
      if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs))
      if (rule.mode === 'stale') return { data: clone(rule.data || []), error: null }
      if (rule.mode === 'before') return { data: null, error: clone(rule.error || { message: 'failure before write' }) }
      if (rule.mode === 'throwBefore') throw new Error(rule.error?.message || 'process stopped before write')
    }

    let data
    let count = null
    let error = null
    if (this.action === 'select') {
      if (this.countMode) count = rows.filter((row) => this.matches(row)).length
      data = this.headOnly ? null : clone(this.format(rows))
    } else if (this.action === 'insert') {
      const created = []
      for (const item of this.payload) {
        const conflict = this.uniqueViolation(rows, item)
        if (conflict) {
          error = conflict
          break
        }
        const row = clone(item)
        if (row.id == null) row.id = nextId(rows)
        if (row.created_at == null) row.created_at = stampFor(row.id)
        rows.push(row)
        created.push(row)
      }
      data = this.mode === 'single' ? clone(created[0] || null) : clone(created)
    } else if (this.action === 'update') {
      const changed = rows.filter((row) => this.matches(row))
      changed.forEach((row) => Object.assign(row, clone(this.payload)))
      data = this.returnRows ? clone(this.format(changed)) : null
    } else if (this.action === 'delete') {
      const removed = rows.filter((row) => this.matches(row))
      state.tables[this.table] = rows.filter((row) => !this.matches(row))
      data = this.returnRows ? clone(removed) : null
    } else if (this.action === 'upsert') {
      const conflictFields = String(this.upsertOptions?.onConflict || '')
        .split(',').map((entry) => entry.trim()).filter(Boolean)
      const touched = []
      for (const item of this.payload) {
        const candidate = clone(item)
        let found = null
        if (conflictFields.length) {
          // PostgREST only resolves the conflict target when every column in
          // it is present and non-null; a NULL member leaves the row distinct.
          if (conflictFields.every((field) => candidate[field] != null)) {
            found = rows.find((row) => conflictFields.every(
              (field) => normalized(row[field]) === normalized(candidate[field]),
            ))
          }
        } else if (candidate.id != null) {
          found = rows.find((row) => normalized(row.id) === normalized(candidate.id))
        }
        if (found) {
          if (!this.upsertOptions?.ignoreDuplicates) Object.assign(found, candidate)
          touched.push(found)
          continue
        }
        const conflict = this.uniqueViolation(rows, candidate)
        if (conflict) {
          error = conflict
          break
        }
        if (candidate.id == null) candidate.id = nextId(rows)
        if (candidate.created_at == null) candidate.created_at = stampFor(candidate.id)
        rows.push(candidate)
        touched.push(candidate)
      }
      data = error ? null : clone(touched)
    }

    if (rule?.mode === 'throwAfter') throw new Error(rule.error?.message || 'process stopped after commit')
    if (rule?.mode === 'after') return { data: null, error: clone(rule.error || { message: 'timeout after commit' }) }
    return { data, error, count }
  }
}

export function createTrackerFakeSupabase(initialTables = {}, options = {}) {
  const state = options.state || {
    tables: Object.fromEntries(Object.entries(initialTables).map(([table, rows]) => [table, clone(rows)])),
    operations: [],
    counts: new Map(),
  }
  const unique = options.unique || {
    plate_appearances: [['game_id', 'pa_number'], ['game_id', 'tracker_contact_seq'],
      ['game_id', 'tracker_event_key']],
    season_plate_appearances: [['game_id', 'pa_number'], ['game_id', 'tracker_contact_seq'],
      ['game_id', 'tracker_event_key']],
    pitches: [['pa_id', 'pitch_number_pa']],
    season_pitches: [['pa_id', 'pitch_number_pa']],
    runs_scored: [['pa_id', 'scoring_player_id', 'scoring_character_id']],
    season_runs_scored: [['pa_id', 'scoring_player_id', 'scoring_character_id']],
    tracking_sessions: [['competition_type', 'game_id', 'raw_stem']],
    tracking_plays: [['tracking_session_id', 'play_ordinal']],
    fielding_opportunities: [['tracking_play_id', 'position']],
    movement_metrics: [['tracking_play_id', 'actor_type', 'actor_slot']],
    tracking_throws: [['tracking_play_id', 'throw_sequence']],
    tracker_unresolved_plays: [['competition_type', 'game_id', 'tracker_event_key']],
  }
  // Database functions. A fake cannot execute plpgsql, so by default every
  // call answers the way a deployment that has not run the migrations does --
  // PGRST202, "could not find the function" -- which is the branch the bridge
  // and the persistence both have to keep working through. A test that wants
  // to model a lease being held, or an atomic write, supplies a handler.
  //
  // The real behaviour of those functions is tested against a real Postgres in
  // tests/tracker-database-guarantees.test.mjs. Nothing here is evidence about
  // the SQL; it is evidence about what the client does with the answer.
  const rpcHandlers = new Map(Object.entries(options.rpc || {}))
  const client = {
    state,
    db: state.tables,
    operations: state.operations,
    unique,
    rpcCalls: state.rpcCalls ||= [],
    failures: (options.failures || []).map((rule) => ({ remaining: rule.times ?? 1, ...rule })),
    from(table) { return new Query(client, table) },
    setRpcHandler(name, handler) { rpcHandlers.set(name, handler); return client },
    async rpc(name, args) {
      client.rpcCalls.push({ name, args: clone(args) })
      const handler = rpcHandlers.get(name)
      if (!handler) {
        return {
          data: null,
          error: {
            code: 'PGRST202',
            message: `Could not find the function public.${name} in the schema cache`,
          },
        }
      }
      const answer = await handler(args, client)
      return answer && ('data' in answer || 'error' in answer)
        ? answer
        : { data: answer ?? null, error: null }
    },
    restart(restartOptions = {}) {
      return createTrackerFakeSupabase({}, { state, unique, ...restartOptions })
    },
  }
  return client
}
