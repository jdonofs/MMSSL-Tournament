import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { seasonFixturePlugin } from './browser/season-context-fixtures/vitePlugin.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repoRoot, 'tests/browser/season-context-fixtures')
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
    configFile: false, root: fixtureRoot, logLevel: 'error',
    plugins: [seasonFixturePlugin(), react()],
    server: { port, strictPort: true, host: '127.0.0.1', fs: { allow: [repoRoot] } },
    optimizeDeps: { include: [] },
  })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await chromium.launch()
})
test.after(async () => { await browser?.close(); await server?.close() })

async function open() {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('sluggers-selected-season', 'A'))
  await page.goto(baseUrl)
  await page.waitForFunction(() => window.__SEASON__ && window.__DB__)
  return { page, errors }
}
const calls = (page) => page.evaluate(() => window.__DB__.calls())
const state = (page) => page.evaluate(() => window.__SEASON__)
const seasonRows = [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]
async function waitCall(page, table, seasonId, count = 1) {
  await page.waitForFunction(({ table, seasonId, count }) => window.__DB__.calls().filter((c) => c.table === table && c.seasonId === seasonId).length >= count, { table, seasonId, count })
  return (await calls(page)).filter((c) => c.table === table && c.seasonId === seasonId)[count - 1]
}
async function complete(page, call, rows, error = null) {
  await page.evaluate(({ id, rows, error }) => window.__DB__.complete(id, rows, error), { id: call.id, rows, error })
}
async function finishSlices(page, id, suffix = id, { fail } = {}) {
  const tables = ['season_teams', 'season_schedule', 'season_betting_ledger', 'players']
  const pending = await calls(page)
  for (const table of tables) {
    const matching = pending.filter((item) => item.table === table && item.seasonId === (table === 'players' ? null : id))
    const call = table === 'players' && id === 'B' ? matching.at(-1) : matching[0]
    assert.ok(call, `pending ${table} for ${id}`)
    await complete(page, call, table === fail ? null : [{ id: `${table}-${suffix}` }], table === fail ? { message: `${table} failed` } : null)
  }
}
async function initial(page) {
  await complete(page, await waitCall(page, 'seasons', null), seasonRows)
  await waitCall(page, 'season_teams', 'A')
  await finishSlices(page, 'A')
  await page.waitForFunction(() => window.__SEASON__.available && !window.__SEASON__.loading)
}
async function expectScoped(page, id, suffix = id) {
  await page.waitForFunction(({ id, suffix }) => {
    const s = window.__SEASON__
    return s.selected === id && !s.loading && s.schedule[0] === `season_schedule-${suffix}`
  }, { id, suffix })
  const s = await state(page)
  assert.deepEqual(s.teams, [`season_teams-${suffix}`])
  assert.deepEqual(s.schedule, [`season_schedule-${suffix}`])
  assert.deepEqual(s.ledger, [`season_betting_ledger-${suffix}`])
}

test('switching A to B keeps all slices scoped when A finishes last', async () => {
  const { page, errors } = await open()
  await complete(page, await waitCall(page, 'seasons', null), seasonRows)
  await waitCall(page, 'season_teams', 'A')
  await page.evaluate(() => window.__SEASON_ACTIONS__.select('B'))
  await waitCall(page, 'season_teams', 'B')
  assert.equal((await state(page)).available, false)
  await finishSlices(page, 'B')
  await expectScoped(page, 'B')
  await finishSlices(page, 'A', 'old', { fail: 'season_schedule' })
  await expectScoped(page, 'B')
  assert.equal((await state(page)).error, null)
  assert.deepEqual(errors, [])
  await page.close()
})

test('newer same-season refresh wins and leaves mounted content in place', async () => {
  const { page } = await open()
  await initial(page)
  const nodeBefore = await page.locator('[data-testid="mounted-content"]').evaluate((node) => { window.__NODE__ = node; return node.textContent })
  assert.equal(nodeBefore, 'season_schedule-A')
  await page.evaluate(() => { window.__SEASON_ACTIONS__.refresh('A') })
  const first = await waitCall(page, 'seasons', null)
  await complete(page, first, seasonRows)
  await waitCall(page, 'season_teams', 'A')
  await page.evaluate(() => { window.__SEASON_ACTIONS__.refresh('A') })
  const second = await waitCall(page, 'seasons', null)
  await complete(page, second, seasonRows)
  await page.waitForFunction(() => window.__DB__.calls().filter((c) => c.table === 'season_teams' && c.seasonId === 'A').length === 2)
  const groups = await calls(page)
  for (const table of ['season_teams', 'season_schedule', 'season_betting_ledger', 'players']) {
    const matching = groups.filter((c) => c.table === table && (table === 'players' || c.seasonId === 'A'))
    await complete(page, matching[1], [{ id: `${table}-new` }])
  }
  await expectScoped(page, 'A', 'new')
  for (const table of ['season_teams', 'season_schedule', 'season_betting_ledger', 'players']) {
    const old = groups.find((c) => c.table === table && (table === 'players' || c.seasonId === 'A'))
    await complete(page, old, [{ id: `${table}-old` }])
  }
  await expectScoped(page, 'A', 'new')
  assert.equal(await page.evaluate(() => window.__NODE__ === document.querySelector('[data-testid="mounted-content"]')), true)
  await page.close()
})

test('failed required slice retains valid data, retry recovers, real empty rows clear it', async () => {
  const { page } = await open()
  await initial(page)
  await page.evaluate(() => { window.__SEASON_ACTIONS__.refresh('A') })
  await complete(page, await waitCall(page, 'seasons', null), seasonRows)
  await waitCall(page, 'season_teams', 'A')
  await finishSlices(page, 'A', 'bad', { fail: 'season_schedule' })
  await page.waitForFunction(() => window.__SEASON__.error?.includes('season_schedule failed'))
  await expectScoped(page, 'A')
  await page.evaluate(() => { window.__SEASON_ACTIONS__.refresh('A') })
  await complete(page, await waitCall(page, 'seasons', null), seasonRows)
  await waitCall(page, 'season_teams', 'A')
  await finishSlices(page, 'A', 'recovered')
  await expectScoped(page, 'A', 'recovered')
  assert.equal((await state(page)).error, null)
  await page.evaluate(() => { window.__SEASON_ACTIONS__.refresh('A') })
  await complete(page, await waitCall(page, 'seasons', null), seasonRows)
  await page.waitForFunction(() => window.__DB__.calls().some((c) => c.table === 'season_teams'))
  for (const call of await calls(page)) await complete(page, call, [])
  await page.waitForFunction(() => window.__SEASON__.schedule.length === 0)
  assert.deepEqual((await state(page)).teams, [])
  assert.deepEqual((await state(page)).ledger, [])
  await page.close()
})

test('failed switch exposes unavailable state and retry restores B', async () => {
  const { page } = await open()
  await initial(page)
  await page.evaluate(() => window.__SEASON_ACTIONS__.select('B'))
  await waitCall(page, 'season_teams', 'B')
  await finishSlices(page, 'B', 'bad', { fail: 'season_betting_ledger' })
  await page.waitForFunction(() => window.__SEASON__.error?.includes('season_betting_ledger failed'))
  assert.equal((await state(page)).available, false)
  assert.deepEqual((await state(page)).schedule, [])
  await page.evaluate(() => { window.__SEASON_ACTIONS__.refresh('B') })
  await complete(page, await waitCall(page, 'seasons', null), seasonRows)
  await waitCall(page, 'season_teams', 'B')
  await finishSlices(page, 'B')
  await expectScoped(page, 'B')
  await page.close()
})

test('old query success and failure after unmount cannot commit', async () => {
  const { page, errors } = await open()
  await complete(page, await waitCall(page, 'seasons', null), seasonRows)
  await waitCall(page, 'season_teams', 'A')
  await page.evaluate(() => window.__UNMOUNT__())
  const pending = await calls(page)
  for (const [index, call] of pending.entries()) {
    await complete(page, call, index === 0 ? [{ id: 'late success' }] : null, index === 0 ? null : { message: 'late failure' })
  }
  assert.deepEqual(errors, [])
  await page.close()
})

test('first load failure is unavailable and recovers with an in-page retry', async () => {
  const { page } = await open()
  await complete(page, await waitCall(page, 'seasons', null), null, { message: 'seasons unavailable' })
  await page.waitForFunction(() => window.__SEASON__.error === 'seasons unavailable')
  assert.equal((await state(page)).available, false)
  assert.equal((await state(page)).loading, false)
  await page.evaluate(() => { window.__SEASON_ACTIONS__.refresh() })
  await complete(page, await waitCall(page, 'seasons', null), seasonRows)
  await waitCall(page, 'season_teams', 'A')
  await finishSlices(page, 'A')
  await expectScoped(page, 'A')
  await page.close()
})

test('realtime and reconnect refresh current slices; disposed A refresh cannot write into B', async () => {
  const { page } = await open()
  await initial(page)
  await page.evaluate(() => window.__DB__.emit('season_schedule', 'A'))
  const oldSchedule = await waitCall(page, 'season_schedule', 'A')
  await page.evaluate(() => window.__SEASON_ACTIONS__.select('B'))
  await waitCall(page, 'season_teams', 'B')
  await finishSlices(page, 'B')
  await expectScoped(page, 'B')
  await complete(page, oldSchedule, [{ id: 'season_schedule-stale' }])
  await expectScoped(page, 'B')

  await page.evaluate(() => window.__DB__.reconnect())
  await page.waitForFunction(() => window.__DB__.calls().filter((c) => c.seasonId === 'B').length === 3)
  const pending = await calls(page)
  for (const call of pending) await complete(page, call, [{ id: `${call.table}-live` }])
  await page.waitForFunction(() => window.__SEASON__.schedule[0] === 'season_schedule-live')
  assert.deepEqual((await state(page)).teams, ['season_teams-live'])
  assert.deepEqual((await state(page)).ledger, ['season_betting_ledger-live'])
  await page.close()
})

test('visibility resume reconciles paused slices', async () => {
  const { page } = await open()
  await initial(page)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    window.__DB__.emit('season_schedule', 'A')
  })
  await page.waitForTimeout(250)
  assert.equal((await calls(page)).length, 0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForFunction(() => window.__DB__.calls().length === 3)
  for (const call of await calls(page)) await complete(page, call, [{ id: `${call.table}-visible` }])
  await page.waitForFunction(() => window.__SEASON__.schedule[0] === 'season_schedule-visible')
  assert.deepEqual((await state(page)).ledger, ['season_betting_ledger-visible'])
  await page.close()
})

test('tournament selection invalidates an older list and initial error remains retryable', async () => {
  const page = await browser.newPage()
  await page.addInitScript(() => localStorage.setItem('sluggers-selected-tournament', 'A'))
  await page.goto(`${baseUrl}tournament.html`)
  await page.waitForFunction(() => window.__TOURNAMENT__ && window.__DB__)
  const first = await waitCall(page, 'tournaments', null)
  await page.evaluate(() => window.__TOURNAMENT_ACTIONS__.select('B'))
  await page.waitForFunction(() => window.__DB__.calls().filter((c) => c.table === 'tournaments').length === 2)
  const second = (await calls(page)).find((call) => call.table === 'tournaments' && call.id !== first.id)
  await complete(page, second, [{ id: 'A' }, { id: 'B' }])
  await page.waitForFunction(() => window.__TOURNAMENT__.selected === 'B' && !window.__TOURNAMENT__.loading)
  await complete(page, first, [{ id: 'A' }])
  assert.deepEqual(await page.evaluate(() => window.__TOURNAMENT__.tournaments), ['A', 'B'])
  await page.evaluate(() => { window.__TOURNAMENT_ACTIONS__.refresh('B') })
  await complete(page, await waitCall(page, 'tournaments', null), null, { message: 'tournament unavailable' })
  await page.waitForFunction(() => window.__TOURNAMENT__.error === 'tournament unavailable')
  assert.deepEqual(await page.evaluate(() => window.__TOURNAMENT__.tournaments), ['A', 'B'])
  await page.evaluate(() => { window.__TOURNAMENT_ACTIONS__.refresh('B') })
  await complete(page, await waitCall(page, 'tournaments', null), [{ id: 'B' }])
  await page.waitForFunction(() => window.__TOURNAMENT__.error === null && window.__TOURNAMENT__.tournaments.length === 1)
  await page.close()
})
