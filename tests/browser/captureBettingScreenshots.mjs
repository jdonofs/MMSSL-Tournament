// Captures the betting experience screenshots referenced by the handoff report.
//
//   node tests/browser/captureBettingScreenshots.mjs
//
// Uses the same local fixture harness as tests/betting-experience-ui.test.mjs —
// no network, no real bets, no real balances. Output goes to
// docs/betting-experience/.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createServer } from 'vite'

import { bettingFixturePlugin } from './fixtures/vitePlugin.mjs'
import { buildMyBetsFixture } from './bettingUiWorld.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const fixtureRoot = path.join(here, 'fixtures')
const outDir = path.join(repoRoot, 'docs', 'betting-experience')

const DESKTOP = { width: 1280, height: 1000 }
const MOBILE = { width: 390, height: 844 }

const server = await createServer({
  configFile: false,
  root: fixtureRoot,
  logLevel: 'error',
  plugins: [bettingFixturePlugin(), react()],
  server: { port: 0, host: '127.0.0.1', fs: { allow: [repoRoot] } },
  optimizeDeps: { include: [] },
})
await server.listen()
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`
const browser = await chromium.launch()
await fs.mkdir(outDir, { recursive: true })

async function open(viewport) {
  const page = await browser.newPage({ viewport })
  await page.addInitScript((seed) => { window.__BETTING_FIXTURE__ = seed }, buildMyBetsFixture())
  await page.goto(baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('.sportsbook-top-tabbar', { timeout: 20000 })
  return page
}

async function toMyBets(page) {
  await page.getByRole('button', { name: /^My Bets/ }).click()
  await page.waitForSelector('.sportsbook-my-bets', { timeout: 20000 })
}

async function shot(page, name, locator = null) {
  const file = path.join(outDir, `${name}.png`)
  if (locator) await locator.screenshot({ path: file })
  else await page.screenshot({ path: file, fullPage: true })
  console.log(`wrote ${path.relative(repoRoot, file)}`)
}

// 1. Dashboard, desktop.
let page = await open(DESKTOP)
await toMyBets(page)
await page.waitForSelector('.betting-chart-svg')
await shot(page, 'dashboard-desktop')

// 2. Receipt, desktop — a settled winner whose credit is recorded.
await page.locator('.my-bet-ticket-button').filter({ hasText: 'Dukes ML' }).first().click()
await page.waitForSelector('.bet-receipt-dialog')
await shot(page, 'receipt-desktop', page.locator('.bet-receipt-dialog'))
await page.keyboard.press('Escape')

// 3. Receipt, desktop — a graded winner still waiting on its ledger credit.
await page.locator('.my-bet-ticket-button').filter({ hasText: 'Over 1.5 Hits' }).first().click()
await page.waitForSelector('.bet-receipt-dialog')
await shot(page, 'receipt-awaiting-credit', page.locator('.bet-receipt-dialog'))
await page.close()

// 4. Dashboard and receipt on a narrow screen.
page = await open(MOBILE)
await toMyBets(page)
await page.waitForSelector('.betting-chart-svg')
await shot(page, 'dashboard-mobile')
await page.locator('.my-bet-ticket-button').filter({ hasText: 'Dukes ML' }).first().click()
await page.waitForSelector('.bet-receipt-dialog')
await shot(page, 'receipt-mobile')
await page.close()

// 5. Odds history and prop research on the board detail view.
page = await open(DESKTOP)
await page.locator('.sportsbook-more-bets').first().click()
await page.waitForSelector('.sportsbook-detail')
await page.locator('.sportsbook-market-history-toggle').first().click()
await page.waitForSelector('.odds-history-panel')
await shot(page, 'odds-history')
await page.getByRole('button', { name: 'Batter Props' }).click()
await page.locator('.prop-research-toggle').first().click()
await page.waitForSelector('.prop-research-body')
await shot(page, 'prop-research')
await page.close()

await browser.close()
await server.close()
