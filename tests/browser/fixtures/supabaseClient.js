// Stands in for `src/supabaseClient.js` inside the betting UI fixture.
//
// It is the same in-memory client the Node integration suite uses, plus the
// realtime and RPC surface BettingTab touches. The seed data and the RPC
// behaviour are supplied by the page (window.__BETTING_FIXTURE__) so a
// Playwright test can script placement success, failure and retry without any
// network access.
import { createBettingFakeSupabase } from '../../helpers/bettingFakeSupabase.mjs'

const fixture = globalThis.__BETTING_FIXTURE__ || { tables: {} }

// `failures` lets a test script a table that does not exist yet (the optional
// odds-history schema) or a query that fails, so the UI's degraded states are
// exercised rather than described.
const client = createBettingFakeSupabase(fixture.tables || {}, {
  unique: fixture.unique || {},
  failures: fixture.failures || [],
})

function noopChannel() {
  const channel = {
    on() { return channel },
    subscribe() { return channel },
    unsubscribe() { return Promise.resolve('ok') },
  }
  return channel
}

export const supabase = {
  ...client,
  from: (table) => client.from(table),
  channel: noopChannel,
  removeChannel() {},
  removeAllChannels: async () => {},
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'p1' } } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
  // Bet placement is a server RPC. The fixture scripts its outcome rather than
  // reimplementing it — the point of these tests is the UI's behaviour around
  // the call, and no client-side check may be presented as the real guard.
  async rpc(name, args) {
    const script = globalThis.__BETTING_FIXTURE__?.rpc?.[name]
    globalThis.__BETTING_RPC_CALLS__ = globalThis.__BETTING_RPC_CALLS__ || []
    globalThis.__BETTING_RPC_CALLS__.push({ name, args })
    if (typeof script === 'function') return script(args, globalThis.__BETTING_RPC_CALLS__.length)
    return { data: [], error: { message: `no fixture response scripted for ${name}` } }
  },
}

globalThis.__BETTING_DB__ = client.db
