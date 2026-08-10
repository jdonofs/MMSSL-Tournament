import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })

async function slow3g(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024, connectionType: 'cellular3g' })
}

function bettingState(body) {
  const balance = body.match(/Balance\s*\n\$([\d.]+)/)?.[1] || null
  const selected = body.includes('Mossers @ Big Ds · Big Ds ML')
  const pending = /placing|recalculating|settling|loading/i.test(body)
  const gameSliceStart = body.indexOf('Mossers @ Big Ds')
  return { balance, selected, pending, game: gameSliceStart >= 0 ? body.slice(gameSliceStart, gameSliceStart + 420) : null, tail: body.slice(-500) }
}

const browser = await chromium.launch({ headless: true })
const bettorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'may-qatest-state.json') })
const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const bettor = await bettorContext.newPage()
const admin = await adminContext.newPage()
bettor.setDefaultTimeout(60000)
admin.setDefaultTimeout(60000)

try {
  await Promise.all([
    bettor.goto('http://127.0.0.1:5173/season/bets', { waitUntil: 'networkidle' }),
    admin.goto('http://127.0.0.1:5173/season/scorebook?game=2145', { waitUntil: 'networkidle' }),
  ])
  await Promise.all([bettor.waitForTimeout(1600), admin.waitForTimeout(1600)])
  await bettor.locator('button[data-column-label="Moneyline"]').nth(3).click()
  await admin.getByRole('button', { name: 'End Game', exact: true }).click()
  console.log('BEFORE', bettingState(await bettor.locator('body').innerText()))
  await slow3g(bettor)

  const events = []
  for (const [label, page] of [['bettor', bettor], ['admin', admin]]) {
    page.on('request', (r) => r.method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ label, type: 'request', at: Date.now(), method: r.method(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
    page.on('response', (r) => r.request().method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ label, type: 'response', at: Date.now(), method: r.request().method(), status: r.status(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
  }

  const started = Date.now()
  await bettor.getByRole('button', { name: 'Place Bets', exact: true }).click()
  await bettor.waitForTimeout(50)
  await admin.getByRole('button', { name: 'Confirm End', exact: true }).click()

  const timeline = []
  let last = ''
  for (let i = 0; i < 220; i += 1) {
    const [betBody, adminBody] = await Promise.all([bettor.locator('body').innerText(), admin.locator('body').innerText()])
    const state = { ms: Date.now() - started, betting: bettingState(betBody), adminUrl: admin.url(), adminTail: adminBody.slice(-600) }
    timeline.push(state)
    const key = JSON.stringify({ b: state.betting, u: state.adminUrl, a: state.adminTail })
    if (key !== last) {
      console.log('CHANGE', state)
      last = key
      await bettor.screenshot({ path: path.join(artifacts, `bet-resolve-${state.ms}.png`), fullPage: true })
    }
    await bettor.waitForTimeout(100)
  }

  await bettor.getByRole('button', { name: 'My Bets', exact: true }).click()
  await bettor.waitForTimeout(1500)
  const myBets = await bettor.locator('body').innerText()
  console.log('MY BETS\n', myBets.slice(-5000))
  console.log('EVENTS', events.map((event) => ({ ...event, ms: event.at - started })))
  await fs.writeFile(path.join(artifacts, 'bet-resolve-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'bet-resolve-events.json'), JSON.stringify(events.map((event) => ({ ...event, ms: event.at - started })), null, 2))
  await fs.writeFile(path.join(artifacts, 'bet-resolve-my-bets.txt'), myBets)
  await bettor.screenshot({ path: path.join(artifacts, 'bet-resolve-my-bets.png'), fullPage: true })
} finally {
  await bettorContext.close()
  await adminContext.close()
  await browser.close()
}
