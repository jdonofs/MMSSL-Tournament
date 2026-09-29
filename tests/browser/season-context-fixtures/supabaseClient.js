let nextId = 1
const calls = []
const pending = new Map()
const channels = new Set()

function defer(table, seasonId) {
  const id = nextId++
  const promise = new Promise((resolve) => pending.set(id, resolve))
  calls.push({ id, table, seasonId })
  return promise
}

window.__DB__ = {
  calls: () => calls.filter((call) => pending.has(call.id)),
  complete(id, data, error = null) {
    const resolve = pending.get(id)
    if (!resolve) throw new Error(`Unknown pending query ${id}`)
    pending.delete(id)
    resolve({ data, error })
  },
  emit(table, seasonId) {
    for (const channel of channels) {
      for (const handler of channel.handlers) {
        if (handler.table === table && (!handler.seasonId || handler.seasonId === seasonId)) handler.callback()
      }
    }
  },
  reconnect() {
    for (const channel of channels) channel.callback?.('SUBSCRIBED')
  },
}

export const supabase = {
  from(table) {
    let seasonId = null
    const builder = {
      select() { return this },
      eq(column, value) { if (column === 'season_id') seasonId = String(value); return this },
      order() { return this },
      range() { return defer(table, seasonId) },
      then(resolve, reject) { return defer(table, seasonId).then(resolve, reject) },
    }
    return builder
  },
  channel() {
    const channel = {
      handlers: [],
      on(_event, filter, callback) {
        this.handlers.push({ table: filter.table, seasonId: filter.filter?.split('eq.')[1], callback })
        return this
      },
      subscribe(callback) { this.callback = callback; channels.add(this); callback?.('SUBSCRIBED'); return this },
    }
    return channel
  },
  removeChannel(channel) { channels.delete(channel) },
}
