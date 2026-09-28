const fixture = globalThis.__EDITOR_SEED__ || { tables: {} }
const tables = Object.fromEntries(Object.entries(fixture.tables || {}).map(([name, rows]) => [name, structuredClone(rows)]))
const calls = []
const pending = new Map()
const deferRules = [...(fixture.deferRules || [])]
const failureRules = [...(fixture.failureRules || [])]
const channels = []
let nextCallId = 1

function matches(rule, call) {
  return rule.table === call.table
    && (rule.gameId == null || String(rule.gameId) === String(call.filters.game_id ?? call.filters.id))
    && (rule.operation == null || rule.operation === call.operation)
    && (rule.maybeSingle == null || rule.maybeSingle === call.maybeSingle)
}

function consume(rules, call) {
  const index = rules.findIndex((rule) => matches(rule, call))
  if (index === -1) return null
  return rules.splice(index, 1)[0]
}

function filteredRows(table, filters) {
  let rows = [...(tables[table] || [])]
  for (const [column, wanted] of Object.entries(filters)) {
    if (Array.isArray(wanted)) rows = rows.filter((row) => wanted.map(String).includes(String(row[column])))
    else rows = rows.filter((row) => String(row[column]) === String(wanted))
  }
  return rows
}

function execute(call, override) {
  if (override) return override
  const failure = consume(failureRules, call)
  if (failure) return { data: null, error: failure.error || { message: 'fixture query failed' } }
  const rows = filteredRows(call.table, call.filters)
  if (call.operation === 'read') {
    const data = call.single || call.maybeSingle ? (rows[0] || null) : rows
    return { data: structuredClone(data), error: call.single && !data ? { message: 'row not found' } : null }
  }
  if (call.operation === 'update') {
    for (const row of rows) Object.assign(row, structuredClone(call.values))
    const data = call.single ? (rows[0] || null) : rows
    return { data: structuredClone(data), error: null }
  }
  if (call.operation === 'delete') {
    const ids = new Set(rows.map((row) => row.id))
    tables[call.table] = (tables[call.table] || []).filter((row) => !ids.has(row.id))
    return { data: [], error: null }
  }
  const inserted = (Array.isArray(call.values) ? call.values : [call.values]).map((row, index) => ({
    id: row.id ?? `${call.table}-${Date.now()}-${index}`,
    ...structuredClone(row),
  }))
  tables[call.table] = [...(tables[call.table] || []), ...inserted]
  return { data: structuredClone(call.single ? inserted[0] : inserted), error: null }
}

class Query {
  constructor(table) {
    this.table = table
    this.operation = 'read'
    this.filters = {}
    this.values = null
    this.wantsSingle = false
    this.wantsMaybeSingle = false
  }
  select() { return this }
  eq(column, value) { this.filters[column] = value; return this }
  in(column, values) { this.filters[column] = values; return this }
  order() { return this }
  range() { return this }
  update(values) { this.operation = 'update'; this.values = values; return this }
  insert(values) { this.operation = 'insert'; this.values = values; return this }
  delete() { this.operation = 'delete'; return this }
  single() { this.wantsSingle = true; return this }
  maybeSingle() { this.wantsMaybeSingle = true; return this }
  then(resolve, reject) {
    const call = {
      id: nextCallId++,
      table: this.table,
      operation: this.operation,
      filters: structuredClone(this.filters),
      values: structuredClone(this.values),
      single: this.wantsSingle,
      maybeSingle: this.wantsMaybeSingle,
    }
    calls.push(call)
    const deferred = consume(deferRules, call)
    const promise = deferred
      ? new Promise((finish) => pending.set(call.id, { call, finish }))
      : Promise.resolve(execute(call))
    return promise.then(resolve, reject)
  }
}

function channel() {
  const record = { callbacks: [], active: true }
  const api = {
    on(_event, _filter, callback) { record.callbacks.push(callback); return api },
    subscribe() { channels.push(record); return api },
  }
  record.api = api
  return api
}

export const supabase = {
  from(table) { return new Query(table) },
  channel,
  removeChannel(api) {
    const record = channels.find((item) => item.api === api)
    if (record) record.active = false
  },
  async rpc(name, args) {
    const call = { id: nextCallId++, operation: 'rpc', table: `rpc:${name}`, filters: {}, values: structuredClone(args) }
    calls.push(call)
    if (name === 'tracker_record_corrected_plate_appearance') {
      const paTable = args.p_competition_type === 'season' ? 'season_plate_appearances' : 'plate_appearances'
      const saved = { id: 9900, ...structuredClone(args.p_pa), pa_number: args.p_pa_number }
      tables[paTable] = [...(tables[paTable] || []), saved]
      const unresolved = (tables.tracker_unresolved_plays || []).find((row) => row.id === args.p_unresolved_id)
      if (unresolved) unresolved.status = 'resolved'
    }
    return { data: { pa_id: 9900, pa_number: args?.p_pa_number || 1, pa: args?.p_pa, retried: false }, error: null }
  },
}

globalThis.__EDITOR_DB__ = {
  calls() { return structuredClone(calls) },
  pending() { return [...pending.values()].map(({ call }) => structuredClone(call)) },
  complete(id, result) {
    const item = pending.get(id)
    if (!item) throw new Error(`No pending query ${id}`)
    pending.delete(id)
    item.finish(execute(item.call, result))
  },
  defer(rule) { deferRules.push(structuredClone(rule)) },
  fail(rule) { failureRules.push(structuredClone(rule)) },
  replace(table, rows) { tables[table] = structuredClone(rows) },
  realtime() {
    for (const callback of new Set(channels.filter((record) => record.active).flatMap((record) => record.callbacks))) callback()
  },
}
