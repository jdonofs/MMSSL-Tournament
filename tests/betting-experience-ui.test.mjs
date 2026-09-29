// My Bets dashboard, ticket receipts, odds history and prop research, driven in
// a real browser against local fixtures only.
//
// Same harness as betting-ui.test.mjs: a Vite dev server mounts the real
// BettingTab with `src/supabaseClient` and the four React contexts redirected to
// in-memory stand-ins. Nothing leaves the machine, no bet is placed, no balance
// moves.

import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createServer } from 'vite'

import { bettingFixturePlugin } from './browser/fixtures/vitePlugin.mjs'
import { MY_BETS_TOTALS, buildMyBetsFixture, buildSeasonMyBetsFixture } from './browser/bettingUiWorld.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repoRoot, 'tests', 'browser', 'fixtures')

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 780 }

let server = null
let browser = null
let baseUrl = ''

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
    plugins: [bettingFixturePlugin(), react()],
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

async function openTab(fixture, { viewport = DESKTOP, view = 'my-bets', mode = 'tournament' } = {}) {
  const page = await browser.newPage({ viewport })
  const failures = []
  page.on('pageerror', (error) => failures.push(error.message))
  await page.addInitScript((seed) => { window.__BETTING_FIXTURE__ = seed }, fixture)
  await page.goto(mode === 'season' ? `${baseUrl}?mode=season` : baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('.sportsbook-top-tabbar', { timeout: 20000 })
  if (view === 'my-bets') {
    await page.getByRole('button', { name: /^My Bets/ }).click()
    await page.waitForSelector('.sportsbook-my-bets', { timeout: 20000 })
  }
  if (view === 'detail') {
    await page.waitForSelector('.sportsbook-game-card', { timeout: 20000 })
    await page.locator('.sportsbook-more-bets').first().click()
    await page.waitForSelector('.sportsbook-detail', { timeout: 20000 })
  }
  return { page, failures }
}

function tile(page, label) {
  return page.locator('.betting-stat-tile').filter({ hasText: label }).first()
}

async function openReceipt(page, ticketText) {
  await page.locator('.my-bet-ticket-button').filter({ hasText: ticketText }).first().click()
  await page.waitForSelector('.bet-receipt-dialog', { timeout: 10000 })
}

// ── dashboard ────────────────────────────────────────────────────────────────

test('the dashboard reports exposure, settled profit, ROI and the record with stated denominators', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  assert.match(await tile(page, 'Open exposure').innerText(), new RegExp(MY_BETS_TOTALS.openExposure.replace('$', '\\$')))
  assert.match(await tile(page, 'Open potential return').innerText(), new RegExp(MY_BETS_TOTALS.openPotentialReturn.replace('$', '\\$')))
  assert.match(await tile(page, 'Settled net profit').innerText(), /\+\$35\.50/)
  assert.match(await tile(page, 'Settled wagered').innerText(), /\$87\.00/)
  assert.match(await tile(page, 'Settled wagered').innerText(), /\$75\.00 at risk \(won \+ lost\)/)
  assert.match(await tile(page, 'ROI').innerText(), /47\.3%/)

  const record = await tile(page, 'Won / lost / void').innerText()
  assert.match(record, /2 \/ 1 \/ 1/)
  assert.match(record, /66\.7% of 3 decided \(won \+ lost\)/)

  assert.match(await page.locator('.betting-basis-note').first().innerText(), /counts once/)
  assert.deepEqual(failures, [])
  await page.close()
})

test('the cumulative curve is labelled by its basis and ends at the settled total', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  await page.waitForSelector('.betting-chart-svg', { timeout: 10000 })
  assert.match(await page.locator('.betting-chart-head').innerText(), /settlement time/i)
  const labels = await page.evaluate(
    () => Array.from(document.querySelectorAll('.betting-chart-svg text')).map((node) => node.textContent),
  )
  assert.equal(labels[labels.length - 1], '$35.50', 'the last point carries a direct label')
  assert.ok(labels.some((text) => text === '-$4.50'), `a negative axis bound reads with a leading minus: ${labels.join(', ')}`)

  // The keyboard path reads the same points the crosshair does.
  await page.locator('.betting-chart-svg').focus()
  await page.keyboard.press('ArrowRight')
  assert.match(await page.locator('.betting-chart-readout').innerText(), /\$37\.50/)

  await page.locator('.betting-chart-head button').click()
  await page.waitForSelector('.betting-chart-table-scroll', { timeout: 5000 })
  const rows = await page.locator('.betting-chart-table-scroll tbody tr').count()
  assert.equal(rows, 4, 'one row per settled ticket')
  assert.deepEqual(failures, [])
  await page.close()
})

test('the market breakdown shows a sample count and withholds a rate it cannot compute', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  const runLineRow = page.locator('.betting-market-breakdown tbody tr').filter({ hasText: 'Run Line' }).first()
  const cells = await runLineRow.locator('td').allInnerTexts()
  // Tickets, settled, W/L/V, wagered, net profit, ROI
  assert.deepEqual(cells, ['1', '1', '0 / 0 / 1', '$12.00', '$0.00', '--'])
  assert.deepEqual(failures, [])
  await page.close()
})

test('filters narrow the list, and rapid changes settle on the last one', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  const statusFilter = page.locator('.betting-filter-row select').nth(2)
  await statusFilter.selectOption('open')
  await statusFilter.selectOption('won')
  await statusFilter.selectOption('lost')
  await page.waitForFunction(() => document.querySelectorAll('.my-bet-ticket-button').length === 1, null, { timeout: 5000 })
  assert.match(await page.locator('.sportsbook-board-head').innerText(), /1 of 6 tickets/)
  assert.match(await tile(page, 'Settled net profit').innerText(), /-\$30\.00/)

  await page.locator('.betting-filter-row select').nth(1).selectOption('hit_prop')
  await page.waitForFunction(() => document.querySelectorAll('.my-bet-ticket-button').length === 0, null, { timeout: 5000 })
  assert.match(await page.locator('.betting-tickets-empty').innerText(), /No tickets match these filters/)

  await page.locator('.betting-filter-row .ghost-button').click()
  await page.waitForFunction(() => document.querySelectorAll('.my-bet-ticket-button').length === 6, null, { timeout: 5000 })
  assert.deepEqual(failures, [])
  await page.close()
})

test('a long ticket history paginates instead of rendering every ticket', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture({ extraTickets: 40 }))

  assert.equal(await page.locator('.my-bet-ticket-button').count(), 20)
  assert.match(await page.locator('.betting-pagination').innerText(), /Page 1 of 3/)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.waitForFunction(() => /Page 2 of 3/.test(document.querySelector('.betting-pagination').textContent), null, { timeout: 5000 })
  assert.equal(await page.locator('.my-bet-ticket-button').count(), 20)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.waitForFunction(() => /Page 3 of 3/.test(document.querySelector('.betting-pagination').textContent), null, { timeout: 5000 })
  assert.equal(await page.locator('.my-bet-ticket-button').count(), 6)
  assert.deepEqual(failures, [])
  await page.close()
})

// ── receipts ─────────────────────────────────────────────────────────────────

test('a settled prop receipt explains the result from the game facts and separates the three money figures', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  await openReceipt(page, 'Over 1.5 Hits')
  const body = await page.locator('.bet-receipt-body').innerText()

  assert.match(body, /Over 1\.5 hits — finished with 2 hits\./)
  assert.match(body, /Mario \(Aidan\) must finish with more than 1\.5 hits in this game\./)
  assert.match(body, /Wager\s*\n?\$20\.00/)
  assert.match(body, /Potential net profit\s*\n?\$28\.00/)
  assert.match(body, /Potential total return\s*\n?\$48\.00/)
  // Graded a winner, but the ledger has no settlement entry for it.
  assert.match(body, /AWAITING CREDIT/i)
  assert.match(body, /no settlement entry has been recorded in the ledger yet/i)
  assert.deepEqual(failures, [])
  await page.close()
})

test('a credited winner reports the ledger entry rather than only the calculation', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  await openReceipt(page, 'Dukes ML')
  const body = await page.locator('.bet-receipt-body').innerText()

  assert.match(body, /Aces 3, Dukes 6 — Dukes won\./)
  assert.match(body, /Actual credited return\s*\n?\$62\.50/)
  assert.match(body, /CREDITED/i)
  assert.match(body, /Explained from this game’s recorded final score\./)
  assert.deepEqual(failures, [])
  await page.close()
})

test('a spread receipt shows the final score and the adjusted result from the chosen side', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  await openReceipt(page, 'Dukes +3.0')
  const body = await page.locator('.bet-receipt-body').innerText()

  assert.match(body, /Push/)
  assert.match(body, /Aces 3, Dukes 6/)
  assert.match(body, /landed exactly on 3\.0/)
  assert.match(body, /Actual credited return\s*\n?\$12\.00/)
  assert.deepEqual(failures, [])
  await page.close()
})

test('a receipt keeps the accepted odds when the board has moved, and never invents placement context', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  // Ticket 506 took +120 on the away side; the live board still shows +120 for
  // away but -140 the other way, and the ticket's own terms lead.
  await openReceipt(page, 'Aces ML')
  const body = await page.locator('.bet-receipt-body').innerText()

  assert.match(body, /Accepted odds\s*\n?\+120/)
  assert.match(body, /Score \/ inning at placement\s*\n?Not recorded/)
  assert.match(body, /were not recorded/)
  assert.match(body, /Actual credited return\s*\n?—/, 'an open ticket has no credited return')
  assert.match(body, /has not been settled, so nothing has been credited yet/i)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.bet-receipt-dialog'), null, { timeout: 5000 })

  // An open ticket that does carry a line shows its live progress instead.
  await openReceipt(page, 'Over 0.5 HR')
  const propBody = await page.locator('.bet-receipt-body').innerText()
  assert.match(propBody, /Live progress from the game’s recorded rows\. Nothing is settled yet\./)
  assert.equal(await page.locator('.bet-receipt-body .bet-progress-meter').count(), 1)
  assert.deepEqual(failures, [])
  await page.close()
})

test('the receipt traps focus, closes on Escape and hands focus back to the ticket', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture())

  const trigger = page.locator('.my-bet-ticket-button').first()
  await trigger.click()
  await page.waitForSelector('.bet-receipt-dialog', { timeout: 10000 })

  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    'Close receipt',
    'the close button takes focus when the dialog opens',
  )
  assert.equal(await page.evaluate(() => document.querySelector('.bet-receipt-dialog')?.getAttribute('aria-modal')), 'true')

  // Tab stays inside the dialog.
  for (let index = 0; index < 25; index += 1) await page.keyboard.press('Tab')
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector('.bet-receipt-dialog')?.contains(document.activeElement))),
    true,
    'focus never escapes the open receipt',
  )

  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.bet-receipt-dialog'), null, { timeout: 5000 })
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('my-bet-ticket-button')),
    true,
    'focus returns to the ticket that opened the receipt',
  )
  assert.deepEqual(failures, [])
  await page.close()
})

test('the receipt fills a narrow screen without scrolling the page sideways', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture(), { viewport: MOBILE })

  await openReceipt(page, 'Dukes ML')
  const overflow = await page.evaluate(() => ({
    body: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    dialog: (() => {
      const node = document.querySelector('.bet-receipt-dialog')
      return node.scrollWidth - node.clientWidth
    })(),
  }))
  assert.equal(overflow.body <= 1, true, `page scrolls sideways by ${overflow.body}px`)
  assert.equal(overflow.dialog <= 1, true, `dialog scrolls sideways by ${overflow.dialog}px`)
  assert.deepEqual(failures, [])
  await page.close()
})

// ── odds history ─────────────────────────────────────────────────────────────

test('a market history lists the recorded observations and calls the earliest one first recorded', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture(), { view: 'detail' })

  await page.locator('.sportsbook-market-history-toggle').first().click()
  await page.waitForSelector('.odds-history-panel', { timeout: 10000 })
  const panel = await page.locator('.odds-history-panel').first().innerText()

  assert.match(panel, /First recorded/)
  assert.match(panel, /Dukes -120 \/ Aces \+100/)
  assert.match(panel, /Latest recorded/)
  assert.match(panel, /Dukes -140 \/ Aces \+120/)
  assert.match(panel, /3 recorded observations/)
  assert.match(panel, /not the market’s opening price/)
  assert.match(panel, /first recorded/i)
  assert.deepEqual(failures, [])
  await page.close()
})

test('a line move is shown as a line move, and no odds delta is drawn across it', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture(), { view: 'detail' })

  const totalsToggle = page.locator('.sportsbook-section').filter({ hasText: 'Totals' }).locator('.sportsbook-market-history-toggle').first()
  await totalsToggle.click()
  await page.waitForSelector('.odds-history-panel', { timeout: 10000 })
  const panel = await page.locator('.odds-history-panel').first().innerText()

  assert.match(panel, /moved from 5\.5/)
  assert.match(panel, /1 line change/)
  assert.match(panel, /a different line is a different proposition/)
  assert.equal(await page.locator('.odds-history-panel .odds-history-delta').count(), 0)
  assert.deepEqual(failures, [])
  await page.close()
})

test('with no history schema the board still works and says history is unavailable', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture({ oddsHistoryAvailable: false }), { view: 'detail' })

  await page.locator('.sportsbook-market-history-toggle').first().click()
  await page.waitForSelector('.odds-history-note', { timeout: 10000 })
  const note = await page.locator('.odds-history-note').first().innerText()

  assert.match(note, /Odds history is unavailable/)
  assert.match(note, /does not have the odds-history tables yet/)
  assert.match(note, /Betting is unaffected/)
  // The board itself is untouched: prices still render and are still bettable.
  assert.ok(await page.locator('.sportsbook-odds-button').count() > 0)
  assert.deepEqual(failures, [])
  await page.close()
})

// ── prop research ────────────────────────────────────────────────────────────

test('a prop research card states its denominator, links its games and keeps the live game out', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture(), { view: 'detail' })

  await page.getByRole('button', { name: 'Batter Props' }).click()
  await page.locator('.prop-research-toggle').first().click()
  await page.waitForSelector('.prop-research-body', { timeout: 10000 })
  const card = await page.locator('.prop-research-body').first().innerText()

  // Mario has one completed game on record (game 76) with 2 hits; the live
  // game's home run is reported separately.
  assert.match(card, /Hits per game\s*\n?2\.00/)
  assert.match(card, /n = 1/)
  assert.match(card, /Eligible sample\s*\n?1/)
  assert.match(card, /of 1 completed/)
  assert.match(card, /This game so far: 1 hit\b/)
  assert.match(card, /Not included in the average above/)
  assert.match(card, /Past results only\. This is not a probability/)

  const link = page.locator('.prop-research-strip-link').first()
  assert.match(await link.getAttribute('href'), /\/scorebook\?game=76/)
  assert.deepEqual(failures, [])
  await page.close()
})

test('the research card does not claim an edge or a probability anywhere', async () => {
  const { page, failures } = await openTab(buildMyBetsFixture(), { view: 'detail' })

  await page.getByRole('button', { name: 'Batter Props' }).click()
  await page.locator('.prop-research-toggle').first().click()
  await page.waitForSelector('.prop-research-body', { timeout: 10000 })
  const card = (await page.locator('.prop-research-body').first().innerText()).toLowerCase()

  for (const phrase of ['safe bet', 'value', 'edge', 'likely', 'chance', '% to hit']) {
    assert.equal(card.includes(phrase), false, `research card must not say "${phrase}"`)
  }
  assert.deepEqual(failures, [])
  await page.close()
})

// ── empty state ──────────────────────────────────────────────────────────────

test('a player with no tickets gets an empty dashboard rather than broken numbers', async () => {
  const fixture = buildMyBetsFixture()
  const { page, failures } = await openTab({ ...fixture, tables: { ...fixture.tables, bets: [] } })

  assert.match(await tile(page, 'Settled net profit').innerText(), /\$0\.00/)
  assert.match(await tile(page, 'ROI').innerText(), /--/)
  assert.match(await tile(page, 'ROI').innerText(), /no wagers at risk yet/)
  assert.match(await page.locator('.betting-chart-empty').innerText(), /No settled tickets to plot/)
  assert.match(await page.locator('.empty-state').last().innerText(), /No bets here/)
  assert.deepEqual(failures, [])
  await page.close()
})

// ── season mode ──────────────────────────────────────────────────────────────
//
// The same component against the season tables. The fixture also carries the
// tournament tables, populated with the same rows and the same game ids, so a
// leak across the two would double every figure below.

test('[season] the dashboard reads the season tables and matches the same hand-worked totals', async () => {
  const { page, failures } = await openTab(buildSeasonMyBetsFixture(), { mode: 'season' })

  assert.match(await tile(page, 'Open exposure').innerText(), /\$18\.00/)
  assert.match(await tile(page, 'Settled net profit').innerText(), /\+\$35\.50/)
  assert.match(await tile(page, 'ROI').innerText(), /47\.3%/)
  assert.equal(await page.locator('.my-bet-ticket-button').count(), 6, 'the tournament rows must not leak in')
  assert.match(await page.locator('.betting-filter-row select').first().innerText(), /Fixture Season/)
  assert.deepEqual(failures, [])
  await page.close()
})

test('[season] a receipt confirms the season ledger credit and links to the season game', async () => {
  const { page, failures } = await openTab(buildSeasonMyBetsFixture(), { mode: 'season' })

  await openReceipt(page, 'Dukes ML')
  const body = await page.locator('.bet-receipt-body').innerText()
  assert.match(body, /Actual credited return\s*\n?\$62\.50/)
  assert.match(body, /CREDITED/i)
  assert.match(await page.locator('.bet-receipt-kicker').innerText(), /Fixture Season/i)

  const gameLink = await page.locator('.bet-receipt-links a').first().getAttribute('href')
  assert.match(gameLink, /^\/season\/scorebook\?game=76$/)
  assert.deepEqual(failures, [])
  await page.close()
})

test('[season] odds history reads the season history table', async () => {
  const { page, failures } = await openTab(buildSeasonMyBetsFixture(), { mode: 'season', view: 'detail' })

  await page.locator('.sportsbook-market-history-toggle').first().click()
  await page.waitForSelector('.odds-history-panel', { timeout: 10000 })
  assert.match(await page.locator('.odds-history-panel').first().innerText(), /3 recorded observations/)
  assert.deepEqual(failures, [])
  await page.close()
})

test('[season] a missing season history table degrades to unavailable without breaking the board', async () => {
  const { page, failures } = await openTab(
    buildSeasonMyBetsFixture({ oddsHistoryAvailable: false }),
    { mode: 'season', view: 'detail' },
  )

  await page.locator('.sportsbook-market-history-toggle').first().click()
  await page.waitForSelector('.odds-history-note', { timeout: 10000 })
  assert.match(await page.locator('.odds-history-note').first().innerText(), /Odds history is unavailable/)
  assert.ok(await page.locator('.sportsbook-odds-button').count() > 0)
  assert.deepEqual(failures, [])
  await page.close()
})
