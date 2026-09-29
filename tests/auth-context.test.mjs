// AuthProvider races exercised in a browser with a local, deferred Supabase fixture.
// Every state assertion is read from the real context provider; no request guard is
// reproduced in this test harness and no network request leaves the process.

import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createServer } from 'vite'

import { authFixturePlugin } from './browser/auth-fixtures/vitePlugin.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repoRoot, 'tests', 'browser', 'auth-fixtures')

let server
let browser
let baseUrl

test.before(async () => {
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const selectedPort = socket.address().port
      socket.close(() => resolve(selectedPort))
    })
  })
  server = await createServer({
    configFile: false,
    root: fixtureRoot,
    logLevel: 'error',
    plugins: [authFixturePlugin(), react()],
    server: { port, strictPort: true, host: '127.0.0.1', fs: { allow: [repoRoot] } },
    optimizeDeps: { include: [] },
  })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await chromium.launch()
})

test.after(async () => {
  await browser?.close()
  await server?.close()
})

async function openProvider({ strict = false } = {}) {
  const page = await browser.newPage()
  const failures = []
  page.on('pageerror', (error) => failures.push(error.message))
  await page.addInitScript((seed) => { window.__AUTH_SEED__ = seed }, { strict })
  await page.goto(baseUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__AUTH_CONTROL__ && window.__AUTH_SNAPSHOT__)
  return { page, failures }
}

async function calls(page) {
  return page.evaluate(() => window.__AUTH_CONTROL__.calls())
}

async function waitForCall(page, kind, { userId, count = 1 } = {}) {
  await page.waitForFunction(
    ({ expectedKind, expectedUserId, expectedCount }) => window.__AUTH_CONTROL__.calls()
      .filter((call) => call.kind === expectedKind && (expectedUserId === undefined || call.userId === expectedUserId)).length >= expectedCount,
    { expectedKind: kind, expectedUserId: userId, expectedCount: count },
  )
  const matching = (await calls(page)).filter(
    (call) => call.kind === kind && (userId === undefined || call.userId === userId),
  )
  return matching[count - 1]
}

async function complete(page, call, value) {
  await page.evaluate(({ id, result }) => window.__AUTH_CONTROL__.complete(id, result), { id: call.id, result: value })
}

async function resolveSession(page, call, userId, token) {
  await complete(page, call, {
    data: { session: userId ? { access_token: token || `token-${userId}`, user: { id: userId, email: `${userId}@example.test` } } : null },
    error: null,
  })
}

async function resolvePlayer(page, call, userId, overrides = {}) {
  await complete(page, call, {
    data: {
      id: `player-${userId}`,
      name: `Player ${userId}`,
      auth_user_id: userId,
      is_commissioner: false,
      scorebook_access: false,
      ...overrides,
    },
    error: null,
  })
}

async function rejectLookup(page, call, message = 'lookup failed') {
  await complete(page, call, { data: null, error: { message } })
}

async function snapshot(page) {
  return page.evaluate(() => window.__AUTH_SNAPSHOT__)
}

async function waitForPlayer(page, userId) {
  await page.waitForFunction((expected) => (
    window.__AUTH_SNAPSHOT__.userId === expected
    && window.__AUTH_SNAPSHOT__.playerId === `player-${expected}`
    && window.__AUTH_SNAPSHOT__.loading === false
  ), userId)
}

test('an older session lookup cannot replace the current session player', async () => {
  const { page, failures } = await openProvider()

  await page.evaluate(() => {
    window.__AUTH_CONTROL__.emit('SIGNED_IN', 'A')
    window.__AUTH_CONTROL__.emit('SIGNED_IN', 'B')
  })
  const lookupA = await waitForCall(page, 'lookup', { userId: 'A' })
  const lookupB = await waitForCall(page, 'lookup', { userId: 'B' })

  await resolvePlayer(page, lookupB, 'B', { is_commissioner: true })
  await waitForPlayer(page, 'B')
  await resolvePlayer(page, lookupA, 'A', { scorebook_access: true })

  await page.waitForTimeout(25)
  assert.deepEqual(await snapshot(page), {
    userId: 'B',
    token: 'token-B',
    playerId: 'player-B',
    playerName: 'Player B',
    isLoggedIn: true,
    isCommissioner: true,
    isScorekeeper: true,
    loading: false,
  })
  assert.deepEqual(failures, [])
  await page.close()
})

test('a pending explicit refresh and realtime refresh cannot repopulate after logout', async () => {
  const { page, failures } = await openProvider()
  const initialSession = await waitForCall(page, 'session')
  await resolveSession(page, initialSession, 'A')
  const initialLookup = await waitForCall(page, 'lookup', { userId: 'A' })
  await resolvePlayer(page, initialLookup, 'A')
  await waitForPlayer(page, 'A')

  await page.evaluate(() => {
    void window.__AUTH_ACTIONS__.refreshPlayer()
    window.__AUTH_CONTROL__.realtime()
  })
  const refreshLookup = await waitForCall(page, 'lookup', { userId: 'A', count: 2 })
  const realtimeLookup = await waitForCall(page, 'lookup', { userId: 'A', count: 3 })
  await page.evaluate(() => window.__AUTH_ACTIONS__.logout())
  await page.waitForFunction(() => window.__AUTH_SNAPSHOT__.userId === null && window.__AUTH_SNAPSHOT__.loading === false)

  await resolvePlayer(page, realtimeLookup, 'A', { is_commissioner: true })
  await resolvePlayer(page, refreshLookup, 'A', { is_commissioner: true })
  await page.waitForTimeout(25)
  assert.deepEqual(await snapshot(page), {
    userId: null,
    token: null,
    playerId: null,
    playerName: null,
    isLoggedIn: false,
    isCommissioner: false,
    isScorekeeper: false,
    loading: false,
  })
  assert.deepEqual(failures, [])
  await page.close()
})

test('an old failure cannot clear a newer player or settle its loading state', async () => {
  const { page, failures } = await openProvider()
  await page.evaluate(() => window.__AUTH_CONTROL__.emit('SIGNED_IN', 'A'))
  const lookupA = await waitForCall(page, 'lookup', { userId: 'A' })

  await page.evaluate(() => window.__AUTH_CONTROL__.emit('SIGNED_IN', 'B'))
  const lookupB = await waitForCall(page, 'lookup', { userId: 'B' })
  await rejectLookup(page, lookupA, 'late A failure')
  await page.waitForTimeout(25)
  assert.equal((await snapshot(page)).loading, true, 'A must not finish B loading')

  await resolvePlayer(page, lookupB, 'B')
  await waitForPlayer(page, 'B')
  assert.equal((await snapshot(page)).playerId, 'player-B')
  assert.deepEqual(failures, [])
  await page.close()
})

test('StrictMode cleanup and unmount invalidate obsolete provider requests', async () => {
  const { page, failures } = await openProvider({ strict: true })
  const firstSession = await waitForCall(page, 'session', { count: 1 })
  const secondSession = await waitForCall(page, 'session', { count: 2 })

  await resolveSession(page, secondSession, 'B')
  const lookupB = await waitForCall(page, 'lookup', { userId: 'B' })
  await resolvePlayer(page, lookupB, 'B')
  await waitForPlayer(page, 'B')

  await resolveSession(page, firstSession, 'A')
  await page.waitForTimeout(25)
  assert.equal((await calls(page)).some((call) => call.kind === 'lookup' && call.userId === 'A'), false)
  assert.equal((await snapshot(page)).playerId, 'player-B')

  await page.evaluate(() => { void window.__AUTH_ACTIONS__.refreshPlayer() })
  const pendingRefresh = await waitForCall(page, 'lookup', { userId: 'B', count: 2 })
  await page.evaluate(() => window.__AUTH_UNMOUNT__())
  const rendersAtUnmount = await page.evaluate(() => window.__AUTH_RENDER_COUNT__)
  await resolvePlayer(page, pendingRefresh, 'B', { name: 'Obsolete B' })
  await page.waitForTimeout(25)
  assert.equal(await page.evaluate(() => window.__AUTH_RENDER_COUNT__), rendersAtUnmount)
  assert.deepEqual(failures, [])
  await page.close()
})

test('same-user token maintenance preserves the player and mounted content', async () => {
  const { page, failures } = await openProvider()
  const initialSession = await waitForCall(page, 'session')
  await resolveSession(page, initialSession, 'A', 'token-original')
  const lookupA = await waitForCall(page, 'lookup', { userId: 'A' })
  await resolvePlayer(page, lookupA, 'A')
  await waitForPlayer(page, 'A')
  const before = await page.evaluate(() => ({
    id: window.__AUTH_CONTENT_ID__,
    mounts: window.__AUTH_CONTENT_MOUNTS__,
    lookups: window.__AUTH_CONTROL__.calls().filter((call) => call.kind === 'lookup').length,
  }))

  await page.evaluate(() => {
    window.__AUTH_CONTROL__.emit('TOKEN_REFRESHED', 'A', 'token-refreshed')
    window.__AUTH_CONTROL__.emit('SIGNED_IN', 'A', 'token-reestablished')
  })
  await page.waitForFunction(() => window.__AUTH_SNAPSHOT__.token === 'token-reestablished')

  const after = await page.evaluate(() => ({
    snapshot: window.__AUTH_SNAPSHOT__,
    id: window.__AUTH_CONTENT_ID__,
    mounts: window.__AUTH_CONTENT_MOUNTS__,
    lookups: window.__AUTH_CONTROL__.calls().filter((call) => call.kind === 'lookup').length,
  }))
  assert.equal(after.snapshot.playerId, 'player-A')
  assert.equal(after.snapshot.loading, false)
  assert.equal(after.id, before.id)
  assert.equal(after.mounts, before.mounts)
  assert.equal(after.lookups, before.lookups)
  assert.deepEqual(failures, [])
  await page.close()
})

test('initial link and explicit refresh failures are handled without stale state or unhandled rejection', async () => {
  const { page, failures } = await openProvider()
  const initialSession = await waitForCall(page, 'session')
  await resolveSession(page, initialSession, 'A')
  const lookupA = await waitForCall(page, 'lookup', { userId: 'A' })
  await complete(page, lookupA, { data: null, error: null })
  const link = await waitForCall(page, 'link')
  await complete(page, link, { data: null, error: { message: 'link failed' } })
  await page.waitForFunction(() => window.__AUTH_SNAPSHOT__.loading === false)
  assert.equal((await snapshot(page)).playerId, null)

  await page.evaluate(() => window.__AUTH_CONTROL__.emit('SIGNED_IN', 'B'))
  const lookupB = await waitForCall(page, 'lookup', { userId: 'B' })
  await resolvePlayer(page, lookupB, 'B')
  await waitForPlayer(page, 'B')
  await page.evaluate(() => { void window.__AUTH_ACTIONS__.refreshPlayer() })
  const failedRefresh = await waitForCall(page, 'lookup', { userId: 'B', count: 2 })
  await rejectLookup(page, failedRefresh, 'refresh failed')
  await page.waitForTimeout(25)

  assert.equal((await snapshot(page)).playerId, 'player-B')
  assert.deepEqual(failures, [])
  await page.close()
})

test('an initialization lookup failure settles loading without an unhandled rejection', async () => {
  const { page, failures } = await openProvider()
  const initialSession = await waitForCall(page, 'session')
  await resolveSession(page, initialSession, 'A')
  const lookupA = await waitForCall(page, 'lookup', { userId: 'A' })
  await rejectLookup(page, lookupA, 'initial lookup failed')
  await page.waitForFunction(() => window.__AUTH_SNAPSHOT__.loading === false)

  const state = await snapshot(page)
  assert.equal(state.userId, 'A')
  assert.equal(state.playerId, null)
  assert.equal(state.isLoggedIn, false)
  assert.deepEqual(failures, [])
  await page.close()
})

test('a current session still auto-links when its first player lookup is empty', async () => {
  const { page, failures } = await openProvider()
  const initialSession = await waitForCall(page, 'session')
  await resolveSession(page, initialSession, 'A')
  const lookupA = await waitForCall(page, 'lookup', { userId: 'A' })
  await complete(page, lookupA, { data: null, error: null })
  const link = await waitForCall(page, 'link')
  await complete(page, link, {
    data: {
      id: 'player-A',
      name: 'Linked Player A',
      auth_user_id: 'A',
      is_commissioner: false,
      scorebook_access: true,
    },
    error: null,
  })
  await waitForPlayer(page, 'A')

  const state = await snapshot(page)
  assert.equal(state.playerName, 'Linked Player A')
  assert.equal(state.isScorekeeper, true)
  assert.deepEqual(failures, [])
  await page.close()
})
