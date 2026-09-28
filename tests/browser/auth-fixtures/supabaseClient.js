let nextCallId = 1
const calls = []
const pending = new Map()
const authListeners = new Set()
const realtimeListeners = new Set()

function deferred(kind, details = {}) {
  const id = nextCallId++
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
  calls.push({ id, kind, ...details })
  return promise
}

function sessionFor(userId, token = `token-${userId}`) {
  return userId ? { access_token: token, user: { id: userId, email: `${userId}@example.test` } } : null
}

window.__AUTH_CONTROL__ = {
  calls: () => calls.map((call) => ({ ...call, pending: pending.has(call.id) })),
  complete(id, value) {
    const operation = pending.get(id)
    if (!operation) throw new Error(`No pending auth operation ${id}`)
    pending.delete(id)
    operation.resolve(value)
  },
  reject(id, message) {
    const operation = pending.get(id)
    if (!operation) throw new Error(`No pending auth operation ${id}`)
    pending.delete(id)
    operation.reject(new Error(message))
  },
  emit(event, userId, token) {
    const nextSession = sessionFor(userId, token)
    for (const listener of [...authListeners]) listener(event, nextSession)
  },
  realtime() {
    for (const listener of [...realtimeListeners]) listener()
  },
}

export const supabase = {
  auth: {
    getSession() {
      return deferred('session')
    },
    onAuthStateChange(listener) {
      authListeners.add(listener)
      return {
        data: {
          subscription: {
            unsubscribe() {
              authListeners.delete(listener)
            },
          },
        },
      }
    },
    async signInWithPassword() {
      return { error: null }
    },
    async updateUser() {
      return { error: null }
    },
    async signOut() {
      for (const listener of [...authListeners]) listener('SIGNED_OUT', null)
      return { error: null }
    },
  },
  from(table) {
    if (table !== 'players') throw new Error(`Unexpected table ${table}`)
    let userId = null
    return {
      select() { return this },
      eq(column, value) {
        if (column === 'auth_user_id') userId = value
        return this
      },
      maybeSingle() {
        return deferred('lookup', { userId })
      },
    }
  },
  rpc(name) {
    if (name !== 'link_player_to_current_user') throw new Error(`Unexpected RPC ${name}`)
    return deferred('link')
  },
  channel() {
    const channel = {
      listener: null,
      on(_event, _filter, listener) {
        this.listener = listener
        realtimeListeners.add(listener)
        return this
      },
      subscribe() { return this },
    }
    return channel
  },
  removeChannel(channel) {
    if (channel.listener) realtimeListeners.delete(channel.listener)
  },
}
