// A Supabase client shaped like PostgREST, backed by the real PostgreSQL.
//
// WHY THIS EXISTS BESIDE trackerFakeSupabase.mjs. That one models the CLIENT
// honestly and is the right tool for testing client logic. It cannot answer the
// questions this file exists for, because it is a JavaScript object: it does
// not have a column list, so it can never say "column tracker_event_key does
// not exist"; it does not run plpgsql, so it can never exercise the functions
// the migrations install; and it has no transactions, so it can never show one
// rolling back.
//
// Those three are exactly what the persistence path now depends on, so the
// writer is tested against a real server here -- the same migration files that
// would run against Supabase, applied to PGlite in this process.
//
// WHAT IT IS NOT. It is not a PostgREST implementation. It supports the query
// shapes scripts/tracker_persistence.mjs and scripts/tracker_scoring_persistence.mjs
// actually use, and it raises on anything else rather than silently returning
// the wrong rows -- a shim that quietly ignored a filter would turn a passing
// test into no test at all.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

// The server's own error, kept as an Error so a rejection reads like one, with
// the SQLSTATE still on it -- 42703 for a column this schema does not have,
// 42883 for a missing function, 23505 for a duplicate key. Every classifier in
// scripts/ reads .code first and the message only as a fallback.
class PgError extends Error {
  constructor(error) {
    super(error?.message || String(error))
    this.name = 'PostgrestError'
    this.code = error?.code
    this.detail = error?.detail
    // PostgREST returns HINT too, and functions use it for a machine-readable reason.
    this.hint = error?.hint
    this.cause = error
  }
}

function assertIdentifier(name, what) {
  if (!IDENTIFIER.test(String(name))) {
    throw new Error(`pgliteSupabase: ${what} ${JSON.stringify(name)} is not a plain identifier`)
  }
  return name
}

function columnList(columns) {
  const raw = String(columns || '*').trim()
  if (raw === '*') return '*'
  // PostgREST's own comma-separated projection. Each name is checked, because
  // an unchecked one would be interpolated into SQL.
  return raw.split(',').map((name) => assertIdentifier(name.trim(), 'column')).join(', ')
}

class Query {
  constructor(db, table) {
    this.db = db
    this.table = assertIdentifier(table, 'table')
    this.action = 'select'
    this.columns = '*'
    this.filters = []
    this.payload = null
    this.returning = false
    this.mode = 'many'
    this.ordering = null
    this.limitCount = null
    this.countMode = null
    this.headOnly = false
  }

  select(columns = '*', options = {}) {
    if (this.action === 'select') this.columns = columnList(columns)
    else this.returning = true
    if (options.count) this.countMode = options.count
    if (options.head) this.headOnly = true
    return this
  }

  insert(payload) {
    this.action = 'insert'
    this.payload = Array.isArray(payload) ? payload : [payload]
    return this
  }

  update(payload) { this.action = 'update'; this.payload = payload; return this }
  delete() { this.action = 'delete'; return this }

  eq(field, value) { this.filters.push(['=', field, value]); return this }
  neq(field, value) { this.filters.push(['<>', field, value]); return this }
  gt(field, value) { this.filters.push(['>', field, value]); return this }
  gte(field, value) { this.filters.push(['>=', field, value]); return this }
  lt(field, value) { this.filters.push(['<', field, value]); return this }
  lte(field, value) { this.filters.push(['<=', field, value]); return this }
  is(field, value) { this.filters.push(['is', field, value]); return this }
  in(field, values) { this.filters.push(['in', field, values]); return this }
  order(field, options = {}) {
    this.ordering = { field: assertIdentifier(field, 'order column'), ascending: options.ascending !== false }
    return this
  }
  limit(count) { this.limitCount = Number(count); return this }
  single() { this.mode = 'single'; return this }
  maybeSingle() { this.mode = 'maybeSingle'; return this }

  where(params) {
    if (!this.filters.length) return ''
    const clauses = this.filters.map(([operator, field, value]) => {
      assertIdentifier(field, 'filter column')
      if (operator === 'is') {
        if (value !== null) throw new Error('pgliteSupabase: .is() is only used for null here')
        return `${field} is null`
      }
      if (operator === 'in') {
        if (!value.length) return 'false'
        const placeholders = value.map((entry) => `$${params.push(entry)}`)
        return `${field} in (${placeholders.join(', ')})`
      }
      if (value === null) return `${field} ${operator === '=' ? 'is' : 'is not'} null`
      return `${field} ${operator} $${params.push(value)}`
    })
    return ` where ${clauses.join(' and ')}`
  }

  buildSelect() {
    const params = []
    const projection = this.countMode
      ? 'count(*)::int as count'
      : (this.headOnly ? '1' : this.columns)
    let sql = `select ${projection} from ${this.table}${this.where(params)}`
    if (this.ordering && !this.countMode) {
      sql += ` order by ${this.ordering.field} ${this.ordering.ascending ? 'asc' : 'desc'}`
    }
    if (this.limitCount != null && !this.countMode) sql += ` limit ${Number(this.limitCount)}`
    return { sql, params }
  }

  buildInsert() {
    const columns = [...new Set(this.payload.flatMap((row) => Object.keys(row)))]
      .map((name) => assertIdentifier(name, 'insert column'))
    const params = []
    const values = this.payload.map((row) => (
      `(${columns.map((name) => (row[name] === undefined ? 'default' : `$${params.push(normalize(row[name]))}`)).join(', ')})`
    ))
    return {
      sql: `insert into ${this.table} (${columns.join(', ')}) values ${values.join(', ')} returning *`,
      params,
    }
  }

  buildUpdate() {
    const params = []
    const assignments = Object.keys(this.payload)
      .map((name) => `${assertIdentifier(name, 'update column')} = $${params.push(normalize(this.payload[name]))}`)
    return {
      sql: `update ${this.table} set ${assignments.join(', ')}${this.where(params)} returning *`,
      params,
    }
  }

  buildDelete() {
    const params = []
    return { sql: `delete from ${this.table}${this.where(params)} returning *`, params }
  }

  async execute() {
    try {
      const built = this.action === 'select' ? this.buildSelect()
        : this.action === 'insert' ? this.buildInsert()
          : this.action === 'update' ? this.buildUpdate() : this.buildDelete()
      const result = await this.db.query(built.sql, built.params)
      const rows = result.rows || []
      if (this.countMode) return { data: null, error: null, count: rows[0]?.count ?? 0 }
      if (this.mode === 'single') {
        if (rows.length !== 1) {
          return { data: null, error: { code: 'PGRST116', message: `expected one row, got ${rows.length}` } }
        }
        return { data: rows[0], error: null }
      }
      if (this.mode === 'maybeSingle') return { data: rows[0] ?? null, error: null }
      return { data: rows, error: null, count: rows.length }
    } catch (error) {
      // The server's own code travels back, which is the entire point: 42703
      // for a column this schema does not have, 42883 for a function it does
      // not have, 23505 for a duplicate key.
      return { data: null, error: new PgError(error) }
    }
  }

  then(resolve, reject) { return this.execute().then(resolve, reject) }
}

function normalize(value) {
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value)
  return value
}

export function createPgliteSupabase(db) {
  return {
    from(table) { return new Query(db, table) },
    async rpc(name, args = {}) {
      const entries = Object.entries(args)
      const sql = `select ${assertIdentifier(name, 'function')}(`
        + `${entries.map(([key], index) => `${assertIdentifier(key, 'argument')} => $${index + 1}`).join(', ')}`
        + ') as result'
      try {
        const result = await db.query(sql, entries.map(([, value]) => normalize(value)))
        return { data: result.rows[0]?.result ?? null, error: null }
      } catch (error) {
        return { data: null, error: new PgError(error) }
      }
    },
  }
}
