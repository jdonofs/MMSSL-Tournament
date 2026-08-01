function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeValue(value) {
  if (value == null) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

function matchesLike(value, pattern) {
  const source = String(value ?? '')
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
  return new RegExp(`^${escaped}$`).test(source)
}

function nextNumericId(rows = []) {
  return rows.reduce((max, row) => {
    const value = Number(row?.id)
    return Number.isFinite(value) ? Math.max(max, value) : max
  }, 0) + 1
}

class FakeQueryBuilder {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.action = 'select'
    this.payload = null
    this.options = {}
    this.filters = []
    this.selectFields = '*'
    this.returnMode = 'many'
    this.ordering = null
    this.rangeBounds = null
    this.returnRowsAfterMutation = false
  }

  select(fields = '*') {
    this.selectFields = fields
    if (this.action !== 'select') this.returnRowsAfterMutation = true
    return this
  }

  update(payload) {
    this.action = 'update'
    this.payload = payload
    return this
  }

  insert(payload) {
    this.action = 'insert'
    this.payload = Array.isArray(payload) ? payload : [payload]
    return this
  }

  upsert(payload, options = {}) {
    this.action = 'upsert'
    this.payload = Array.isArray(payload) ? payload : [payload]
    this.options = options
    return this
  }

  delete() {
    this.action = 'delete'
    return this
  }

  eq(field, value) {
    this.filters.push((row) => normalizeValue(row[field]) === normalizeValue(value))
    return this
  }

  in(field, values = []) {
    const allowed = new Set(values.map((value) => normalizeValue(value)))
    this.filters.push((row) => allowed.has(normalizeValue(row[field])))
    return this
  }

  like(field, pattern) {
    this.filters.push((row) => matchesLike(row[field], pattern))
    return this
  }

  is(field, value) {
    this.filters.push((row) => (value == null ? row[field] == null : row[field] === value))
    return this
  }

  order(field, { ascending = true } = {}) {
    this.ordering = { field, ascending }
    return this
  }

  range(start, end) {
    this.rangeBounds = { start, end }
    return this
  }

  maybeSingle() {
    this.returnMode = 'maybeSingle'
    return this
  }

  single() {
    this.returnMode = 'single'
    return this
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }

  _rows() {
    if (!this.db[this.table]) this.db[this.table] = []
    return this.db[this.table]
  }

  _applyFilters(rows) {
    return rows.filter((row) => this.filters.every((filter) => filter(row)))
  }

  _applyOrdering(rows) {
    if (!this.ordering) return rows
    const { field, ascending } = this.ordering
    const sorted = [...rows].sort((a, b) => {
      const left = a?.[field]
      const right = b?.[field]
      if (left == null && right == null) return 0
      if (left == null) return 1
      if (right == null) return -1
      if (left > right) return 1
      if (left < right) return -1
      return 0
    })
    return ascending ? sorted : sorted.reverse()
  }

  _applyRange(rows) {
    if (!this.rangeBounds) return rows
    const { start, end } = this.rangeBounds
    return rows.slice(start, end + 1)
  }

  _formatSelectRows(rows) {
    const ordered = this._applyOrdering(this._applyFilters(rows))
    const ranged = this._applyRange(ordered)
    if (this.returnMode === 'single') return ranged[0] || null
    if (this.returnMode === 'maybeSingle') return ranged[0] || null
    return ranged
  }

  async execute() {
    const tableRows = this._rows()

    if (this.action === 'select') {
      return { data: clone(this._formatSelectRows(tableRows)), error: null }
    }

    if (this.action === 'update') {
      const matching = this._applyFilters(tableRows)
      const updated = matching.map((row) => Object.assign(row, clone(this.payload)))
      return { data: this.returnRowsAfterMutation ? clone(updated) : null, error: null }
    }

    if (this.action === 'delete') {
      const matchingSet = new Set(this._applyFilters(tableRows))
      const deleted = tableRows.filter((row) => matchingSet.has(row))
      this.db[this.table] = tableRows.filter((row) => !matchingSet.has(row))
      return { data: this.returnRowsAfterMutation ? clone(deleted) : null, error: null }
    }

    if (this.action === 'insert') {
      const created = this.payload.map((entry) => {
        const next = clone(entry)
        if (next.id == null) next.id = nextNumericId(tableRows)
        tableRows.push(next)
        return next
      })
      return {
        data: this.returnMode === 'single' ? clone(created[0] || null) : (this.returnRowsAfterMutation ? clone(created) : clone(created)),
        error: null,
      }
    }

    if (this.action === 'upsert') {
      const createdOrUpdated = []
      const conflictKeys = String(this.options.onConflict || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)

      this.payload.forEach((entry) => {
        const candidate = clone(entry)
        let existing = null

        if (conflictKeys.length) {
          existing = tableRows.find((row) => conflictKeys.every((key) => normalizeValue(row[key]) === normalizeValue(candidate[key])))
        } else if (candidate.id != null) {
          existing = tableRows.find((row) => normalizeValue(row.id) === normalizeValue(candidate.id))
        }

        if (existing) {
          if (!this.options.ignoreDuplicates) Object.assign(existing, candidate)
          createdOrUpdated.push(existing)
          return
        }

        if (candidate.id == null) candidate.id = nextNumericId(tableRows)
        tableRows.push(candidate)
        createdOrUpdated.push(candidate)
      })

      const formatted = this.returnMode === 'single'
        ? clone(createdOrUpdated[0] || null)
        : (this.returnRowsAfterMutation ? clone(createdOrUpdated) : clone(createdOrUpdated))
      return { data: formatted, error: null }
    }

    throw new Error(`Unsupported fake Supabase action: ${this.action}`)
  }
}

export function createFakeSupabase(initialTables = {}) {
  const db = Object.fromEntries(
    Object.entries(initialTables).map(([table, rows]) => [table, clone(rows)]),
  )

  return {
    db,
    from(table) {
      return new FakeQueryBuilder(db, table)
    },
    removeChannel() {},
    removeAllChannels: async () => {},
  }
}
