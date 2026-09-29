// The completion recovery control, in the real page, on a game whose status
// has already changed -- the case where End Game is gone and the old code left
// nothing to press.
//
//   npm run build && npx vite preview --host 127.0.0.1 --port 4173   # one terminal
//   node tests/game-completion-recovery-browser.mjs
//
// The starting rows are produced by the real lifecycle module: a season game
// completed while its W/L/S writes failed. Supabase is intercepted and answered
// from those rows in memory (reads AND writes, with PostgREST filter
// semantics), so nothing leaves the machine. The first press of the control is
// made to fail as well, then it is pressed again, then the page is reloaded.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

import { finishGameCompletion, writeGameCompletion } from '../src/utils/gameCompletionLifecycle.js'
import {
  EXPECTED_FLAGS,
  GAME_ID,
  SEASON_BET_CONFIG,
  SEASON_TABLES,
  buildRecoveryWorld,
  flagsById,
  seasonCompletionPatch,
} from './game-completion-recovery-fixture.mjs'

const baseUrl = process.env.SLUGGERS_QA_URL || 'http://127.0.0.1:4173'

// ── the starting state: completed, W/L/S never written ───────────────────────
const seed = buildRecoveryWorld({ failures: [{ table: 'season_pitching_stints', action: 'update', mode: 'before', times: 1_000 }] })
await writeGameCompletion({ supabase: seed, sourceType: 'season', gameId: GAME_ID, patch: seasonCompletionPatch() })
const partial = await finishGameCompletion({ supabase: seed, sourceType: 'season', tables: SEASON_TABLES, gameId: GAME_ID, betConfig: SEASON_BET_CONFIG })
assert.deepEqual(partial.failed.map((step) => step.key), ['pitching'], 'seed: only W/L/S is left undone')

const tables = JSON.parse(JSON.stringify(seed.db))
tables.players = tables.players.map((row) => (row.id === 'p-away'
  ? { ...row, auth_user_id: 'qa-user', is_commissioner: true, scorebook_access: true }
  : row))
tables.seasons = tables.seasons.map((row) => ({ ...row, name: 'Recovery Season', created_at: '2026-09-01T00:00:00Z' }))
tables.season_schedule = tables.season_schedule.map((row) => ({ ...row, stats_source: 'tracker', innings: 3 }))

const envText = await readFile('.env', 'utf8').catch(() => '')
const configuredSupabaseUrl = envText.match(/^VITE_SUPABASE_URL=(.+)$/m)?.[1]?.trim()
const projectRef = configuredSupabaseUrl ? new URL(configuredSupabaseUrl).hostname.split('.')[0] : 'intercepted'
const authStorageKey = `sb-${projectRef}-auth-token`

// ── PostgREST, in memory ─────────────────────────────────────────────────────
function parseList(value) {
  return value.replace(/^\(|\)$/g, '').split(',').map((entry) => entry.replace(/^"|"$/g, ''))
}

function rowFilter(url) {
  const tests = []
  for (const [key, raw] of url.searchParams) {
    if (['select', 'order', 'offset', 'limit', 'on_conflict', 'columns'].includes(key)) continue
    const value = decodeURIComponent(raw)
    if (value.startsWith('eq.')) tests.push((row) => String(row[key]) === value.slice(3))
    else if (value.startsWith('neq.')) tests.push((row) => String(row[key]) !== value.slice(4))
    else if (value.startsWith('in.')) { const allowed = parseList(value.slice(3)); tests.push((row) => allowed.includes(String(row[key]))) }
    else if (value === 'is.null') tests.push((row) => row[key] == null)
    else if (value.startsWith('like.')) {
      const pattern = new RegExp(`^${value.slice(5).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*')}$`)
      tests.push((row) => pattern.test(String(row[key] ?? '')))
    }
  }
  return (row) => tests.every((check) => check(row))
}

const writes = []
let failNextStintPatch = true

function respond(route, status, body, headers = {}) {
  return route.fulfill({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

const browser = await chromium.launch({ headless: true })
// SLUGGERS_QA_WIDTH=390 runs the same checks at phone width.
const context = await browser.newContext({ viewport: { width: Number(process.env.SLUGGERS_QA_WIDTH) || 1280, height: 1000 } })
if (typeof context.routeWebSocket === 'function') {
  await context.routeWebSocket('wss://*.supabase.co/**', (socket) => socket.close())
}
await context.addInitScript(({ storageKey }) => {
  localStorage.setItem(storageKey, JSON.stringify({
    access_token: 'intercepted-token', refresh_token: 'intercepted-refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer',
    user: { id: 'qa-user', email: 'qa@example.test', aud: 'authenticated', role: 'authenticated' },
  }))
  localStorage.setItem('sluggers-selected-season', '7')
}, { storageKey: authStorageKey })
await context.route('**/auth/v1/**', (route) => respond(route, 200, { user: { id: 'qa-user' } }))

await context.route('**/rest/v1/**', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  const name = url.pathname.match(/\/rest\/v1\/([^/]+)/)?.[1]
  if (name === 'rpc') return respond(route, 200, null)
  const rows = tables[name] ||= []
  const matches = rowFilter(url)
  const method = request.method()
  const wantsObject = request.headers().accept?.includes('application/vnd.pgrst.object+json')
  const representation = (request.headers().prefer || '').includes('return=representation')

  if (method === 'GET' || method === 'HEAD') {
    const found = rows.filter(matches)
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(0, found.length - 1)}/${found.length}` },
      body: JSON.stringify(wantsObject ? (found[0] || null) : found),
    })
  }

  writes.push({ method, table: name, query: url.search })
  if (method === 'PATCH') {
    if (name === 'season_pitching_stints' && failNextStintPatch) {
      failNextStintPatch = false
      writes.at(-1).failed = true
      return respond(route, 503, { message: 'injected: the database did not answer' })
    }
    const patch = JSON.parse(request.postData() || '{}')
    const changed = rows.filter(matches)
    changed.forEach((row) => Object.assign(row, patch))
    return respond(route, 200, representation ? (wantsObject ? changed[0] || null : changed) : [])
  }
  if (method === 'POST') {
    const payload = JSON.parse(request.postData() || '[]')
    const created = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ id: rows.length + 1000, ...row }))
    rows.push(...created)
    return respond(route, 201, representation ? (wantsObject ? created[0] : created) : [])
  }
  if (method === 'DELETE') {
    const removed = rows.filter(matches)
    tables[name] = rows.filter((row) => !matches(row))
    return respond(route, 200, representation ? removed : [])
  }
  return respond(route, 405, { message: `unsupported ${method}` })
})

const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

const banner = page.locator('[data-testid="game-lifecycle-recovery"]')
const finishButton = banner.getByRole('button', { name: 'Finish completion steps' })

try {
  await page.goto(`${baseUrl}/season/scorebook?game=${GAME_ID}`, { waitUntil: 'networkidle' })
  await banner.waitFor({ timeout: 30_000 })
  const listed = await banner.locator('[data-testid="game-lifecycle-owed-step"]').allInnerTexts()
  assert.deepEqual(listed.map((text) => text.split(' — ')[0]), ['Pitching decisions (W/L/S)'])
  assert.equal(await banner.getAttribute('data-lifecycle-kind'), 'completion')
  assert.equal(await page.getByRole('button', { name: /^End Game$/ }).count(), 0, 'End Game is gone once the game is final')

  // First press: the W/L/S write fails again. The control has to still be
  // there afterwards, listing the same step.
  await finishButton.click()
  await page.getByText(/completion step\(s\) did not finish/).first().waitFor({ timeout: 20_000 })
  await finishButton.waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="game-lifecycle-recovery"] button[disabled]'), null, { timeout: 20_000 })
  assert.ok(writes.some((write) => write.failed), 'the first attempt really failed')
  assert.equal(await banner.locator('[data-testid="game-lifecycle-owed-step"]').count(), 1)

  // Second press: it goes through and the banner clears.
  await finishButton.click()
  await banner.waitFor({ state: 'detached', timeout: 20_000 })
  assert.deepEqual(flagsById(tables.season_pitching_stints), EXPECTED_FLAGS)
  assert.equal(tables.season_schedule.find((row) => row.id === GAME_ID).status, 'completed', 'the final row was never rewritten')
  assert.equal(tables.season_stadium_game_log.length, 1)
  assert.equal(tables.season_betting_ledger.filter((row) => row.reason.startsWith('bet_settled:')).length, 2, 'no bet was paid again')

  // Reload: nothing is owed, so nothing is shown.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  assert.equal(await banner.count(), 0)
  assert.deepEqual(pageErrors, [])

  const stintWrites = writes.filter((write) => write.table === 'season_pitching_stints')
  console.log([
    'OK the completion recovery control works after the status has changed:',
    `  opened   season game ${GAME_ID}, already completed, W/L/S missing -> banner listed ${listed.length} step`,
    `  press 1  failed (${stintWrites.filter((write) => write.failed).length} rejected write); control still offered`,
    `  press 2  ${stintWrites.filter((write) => !write.failed).length} stint write(s); banner cleared; W/L/S = ${JSON.stringify(flagsById(tables.season_pitching_stints))}`,
    '  reload   no banner',
  ].join('\n'))
} finally {
  await context.close()
  await browser.close()
}
