// Betting UI states, driven in a real browser against local fixtures only.
//
// A Vite dev server serves `tests/browser/fixtures/index.html`, which mounts the
// real BettingTab with `src/supabaseClient` and the four React contexts
// redirected to in-memory stand-ins. No Supabase call leaves the machine, no bet
// is placed and no balance moves.
//
// Bet placement itself is a server RPC (`place_tournament_bets`). It is scripted
// here, never reimplemented: the client-side balance check these tests exercise
// is a UX guard, and the server remains the only thing that actually enforces a
// balance against concurrent clients.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createServer } from 'vite'

import { bettingFixturePlugin } from './browser/fixtures/vitePlugin.mjs'
import { BOARD_ODDS, buildUiFixture } from './browser/bettingUiWorld.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repoRoot, 'tests', 'browser', 'fixtures')

let server = null
let browser = null
let baseUrl = ''

test.before(async () => {
  server = await createServer({
    configFile: false,
    root: fixtureRoot,
    logLevel: 'error',
    plugins: [bettingFixturePlugin(), react()],
    server: { port: 0, host: '127.0.0.1', fs: { allow: [repoRoot] } },
    optimizeDeps: { include: [] },
  })
  await server.listen()
  const { port } = server.httpServer.address()
  baseUrl = `http://127.0.0.1:${port}/`
  browser = await chromium.launch()
})

test.after(async () => {
  await browser?.close()
  await server?.close()
})

// `addInitScript` serializes its argument as JSON, so an RPC stand-in has to
// cross as source text and be rebuilt in the page.
async function openBoard(fixture, rpcScripts = {}) {
  const page = await browser.newPage()
  const failures = []
  page.on('pageerror', (error) => failures.push(error.message))
  await page.addInitScript((seed) => { window.__BETTING_FIXTURE__ = seed }, fixture)
  if (Object.keys(rpcScripts).length) {
    await page.addInitScript((sources) => {
      window.__BETTING_FIXTURE__.rpc = Object.fromEntries(
        Object.entries(sources).map(([name, source]) => [name, (0, eval)(`(${source})`)]),
      )
    }, rpcScripts)
  }
  await page.goto(baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('.sportsbook-game-card', { timeout: 20000 })
  return { page, failures }
}

function moneylineButtons(page) {
  return page.locator('button.sportsbook-odds-button[data-column-label="Moneyline"]')
}

async function addToSlip(page, columnLabel = 'Moneyline', index = 0) {
  await page.locator(`button.sportsbook-odds-button[data-column-label="${columnLabel}"]`).nth(index).click()
  await page.waitForSelector('.sportsbook-slip-footer', { timeout: 10000 })
}

async function setSlipWager(page, amount) {
  await page.locator('.sportsbook-slip-input').first().click()
  await page.locator('.sportsbook-numpad-grid button', { hasText: /^⌫$/ }).click({ clickCount: 6 })
  for (const digit of String(amount)) {
    await page.locator('.sportsbook-numpad-grid button', { hasText: new RegExp(`^${digit === '.' ? '\\.' : digit}$`) }).first().click()
  }
}

test('a locked market is off the board: its price button cannot be selected', async () => {
  const lockedOdds = BOARD_ODDS.map((row) => (row.bet_type === 'moneyline' ? { ...row, is_locked: true } : row))
  const { page, failures } = await openBoard(buildUiFixture({ odds: lockedOdds }))

  const moneyline = moneylineButtons(page)
  assert.equal(await moneyline.count(), 2, 'both moneyline sides render')
  assert.equal(await moneyline.nth(0).isDisabled(), true, 'a locked moneyline must not accept a selection')
  assert.equal(await moneyline.nth(1).isDisabled(), true)

  // An unlocked market on the same card is still bettable.
  const total = page.locator('button.sportsbook-odds-button[data-column-label="Total"]').first()
  assert.equal(await total.isDisabled(), false)

  await moneyline.nth(0).click({ force: true })
  assert.equal(await page.locator('.sportsbook-slip-footer').count(), 0, 'a locked market cannot reach the slip')
  assert.deepEqual(failures, [])
  await page.close()
})

test('while the tracker is repricing, the whole card is suspended and the slip will not submit', async () => {
  const { page, failures } = await openBoard(buildUiFixture({ oddsCalculating: true }))

  await page.waitForSelector('.sportsbook-game-card-odds-calculating', { timeout: 10000 })
  const moneyline = moneylineButtons(page)
  assert.equal(await moneyline.nth(0).isDisabled(), true, 'no ticket may be taken against a price being recomputed')
  assert.deepEqual(failures, [])
  await page.close()
})

test('a price change flashes the affected button rather than moving silently', async () => {
  // The board's own writer regenerates odds when no tracker owns the game, so a
  // deliberately stale stored price is repriced on load.
  const staleOdds = BOARD_ODDS.map((row) => (
    row.bet_type === 'moneyline' ? { ...row, odds_home: -999, odds_away: 900, predicted_probability: 0.9 } : row
  ))
  const { page, failures } = await openBoard(buildUiFixture({
    odds: staleOdds,
    isScorekeeper: true,
    trackerManaged: false,
  }))

  await page.waitForSelector('button.sportsbook-odds-flash[data-column-label="Moneyline"]', { timeout: 15000 })
  const shown = await moneylineButtons(page).nth(0).innerText()
  assert.equal(/-999|\+900/.test(shown), false, `the stale price is still displayed: ${shown}`)
  assert.deepEqual(failures, [])
  await page.close()
})

test('a wager over the balance is refused in the slip and never reaches the placement RPC', async () => {
  const { page, failures } = await openBoard(
    buildUiFixture({ balance: 3 }),
    // A placement that would succeed if it were ever reached.
    { place_tournament_bets: '(args) => ({ data: (args.p_bets || []).map((bet, i) => ({ ...bet, id: 800 + i })), error: null })' },
  )

  await addToSlip(page)
  await setSlipWager(page, '20')
  await page.locator('.sportsbook-slip-footer button.solid-button').click()

  await page.waitForSelector('.sportsbook-slip-error', { timeout: 10000 })
  assert.equal(await page.locator('.sportsbook-slip-error').innerText(), 'Insufficient balance')
  const rpcCalls = await page.evaluate(() => window.__BETTING_RPC_CALLS__ || [])
  assert.deepEqual(rpcCalls, [], 'the client must not even attempt a ticket it knows is unfunded')
  // The ticket stays on the slip so the wager can be corrected.
  assert.equal(await page.locator('.sportsbook-slip-footer').count(), 1)
  assert.deepEqual(failures, [])
  await page.close()
})

test('a failed placement keeps the slip intact, and the retry places exactly one ticket', async () => {
  const { page, failures } = await openBoard(
    buildUiFixture({ balance: 500 }),
    {
      place_tournament_bets: `(args, callNumber) => callNumber === 1
        ? { data: null, error: { message: 'could not serialize access due to concurrent update' } }
        : { data: (args.p_bets || []).map((bet, index) => ({ ...bet, id: 900 + index })), error: null }`,
    },
  )

  await addToSlip(page)
  await setSlipWager(page, '5')
  await page.locator('.sportsbook-slip-footer button.solid-button').click()

  await page.waitForFunction(() => (window.__BETTING_TOASTS__ || []).some((toast) => toast.title === 'Bet failed'), null, { timeout: 10000 })
  assert.equal(await page.locator('.sportsbook-slip-footer').count(), 1, 'a failed placement must not discard the ticket')

  await page.locator('.sportsbook-slip-footer button.solid-button').click()
  await page.waitForFunction(() => (window.__BETTING_TOASTS__ || []).some((toast) => toast.title === 'Bets placed'), null, { timeout: 10000 })

  const calls = await page.evaluate(() => window.__BETTING_RPC_CALLS__ || [])
  assert.equal(calls.length, 2, 'one failed attempt, one successful retry')
  assert.equal(calls[1].args.p_bets.length, 1, 'the retry submits the same single ticket, not a duplicate')
  assert.equal(calls[1].args.p_bets[0].wager_dollars, 5)
  await page.waitForFunction(() => document.querySelectorAll('.sportsbook-slip-footer').length === 0, null, { timeout: 10000 })
  assert.deepEqual(failures, [])
  await page.close()
})
