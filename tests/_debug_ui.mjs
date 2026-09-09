import path from 'node:path'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { bettingFixturePlugin } from './browser/fixtures/vitePlugin.mjs'
import { buildMyBetsFixture } from './browser/bettingUiWorld.mjs'

const repoRoot = 'C:/Users/jdono/Sluggers'
const fixtureRoot = path.join(repoRoot, 'tests', 'browser', 'fixtures')

const server = await createServer({
  configFile: false,
  root: fixtureRoot,
  logLevel: 'error',
  plugins: [bettingFixturePlugin(), react()],
  server: { port: 0, host: '127.0.0.1', fs: { allow: [repoRoot] } },
  optimizeDeps: { include: [] },
})
await server.listen()
const { port } = server.httpServer.address()
const baseUrl = `http://127.0.0.1:${port}/`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await page.addInitScript((seed) => { window.__BETTING_FIXTURE__ = seed }, buildMyBetsFixture())
await page.goto(baseUrl, { waitUntil: 'load' })
await page.waitForSelector('.sportsbook-top-tabbar', { timeout: 20000 })

console.log('--- board cards:', await page.locator('.sportsbook-game-card').count())
console.log('--- card html head:')
console.log((await page.locator('.sportsbook-game-card').first().innerHTML()).slice(0, 900))

await page.getByRole('button', { name: /^My Bets/ }).click()
await page.waitForSelector('.sportsbook-my-bets', { timeout: 20000 })
const titles = await page.locator('.my-bet-ticket-button .bet-card-head strong').allInnerTexts()
console.log('--- ticket titles:', JSON.stringify(titles))
console.log('--- net profit tile:', await page.locator('.betting-stat-tile').filter({ hasText: 'Settled net profit' }).first().innerText())

const svgTexts = await page.evaluate(() => Array.from(document.querySelectorAll('.betting-chart-svg text')).map((n) => n.textContent))
console.log('--- svg texts:', JSON.stringify(svgTexts))

await browser.close()
await server.close()
