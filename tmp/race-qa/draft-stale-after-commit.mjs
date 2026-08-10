import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const url = 'http://127.0.0.1:5173/season/draft'

function state(body) {
  const h = body.match(/PICK\s*\n(\d+)\nROUND\s*\n(\d+)\nREMAINING\s*\n(\d+)\nON THE CLOCK\s*\n([^\n]+)/)
  const pending = body.match(/([A-Z][A-Z ]+)\s*\n PICKED\s*\n([^\n]+)\nMake Pick/)
  return { pick: h ? Number(h[1]) : null, round: h ? Number(h[2]) : null, remaining: h ? Number(h[3]) : null, clock: h?.[4] || null, pendingTeam: pending?.[1]?.trim() || null, pendingPlayer: pending?.[2] || null, tail: body.slice(-400) }
}

async function slow3g(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024, connectionType: 'cellular3g' })
}

const browser = await chromium.launch({ headless: true })
const aidanContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'aidan-draft-fixture-state.json') })
const jasonContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-draft-fixture-state.json') })
const aidan = await aidanContext.newPage()
const jason = await jasonContext.newPage()
aidan.setDefaultTimeout(60000)
jason.setDefaultTimeout(60000)

try {
  await Promise.all([aidan.goto(url, { waitUntil: 'networkidle' }), jason.goto(url, { waitUntil: 'networkidle' })])
  await Promise.all([aidan.waitForTimeout(1400), jason.waitForTimeout(1400)])
  console.log('BEFORE', { aidan: state(await aidan.locator('body').innerText()), jason: state(await jason.locator('body').innerText()) })
  await slow3g(aidan)
  const events = []
  for (const [label, page] of [['aidan', aidan], ['jason', jason]]) {
    page.on('request', (r) => r.method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ label, type: 'request', at: Date.now(), method: r.method(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
    page.on('response', (r) => r.request().method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ label, type: 'response', at: Date.now(), method: r.request().method(), status: r.status(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
  }

  const started = Date.now()
  await aidan.getByRole('button', { name: 'Draft', exact: true }).first().click()
  await jason.getByRole('button', { name: 'Force', exact: true }).nth(1).click()
  await jason.getByRole('button', { name: 'Make Pick', exact: true }).click()
  console.log('COMMIT CLICKED', state(await jason.locator('body').innerText()))

  const timeline = []
  let last = ''
  for (let i = 0; i < 180; i += 1) {
    const [ab, jb] = await Promise.all([aidan.locator('body').innerText(), jason.locator('body').innerText()])
    const row = { ms: Date.now() - started, aidan: state(ab), jason: state(jb) }
    timeline.push(row)
    const key = JSON.stringify({ a: row.aidan, j: row.jason })
    if (key !== last) {
      console.log('CHANGE', row)
      last = key
      await Promise.all([
        aidan.screenshot({ path: path.join(artifacts, `draft-stale-aidan-${row.ms}.png`), fullPage: true }),
        jason.screenshot({ path: path.join(artifacts, `draft-stale-jason-${row.ms}.png`), fullPage: true }),
      ])
    }
    await aidan.waitForTimeout(100)
  }

  await jason.locator('select:visible').last().selectOption('drafted')
  await jason.waitForTimeout(1000)
  const drafted = await jason.locator('body').innerText()
  console.log('DRAFTED\n', drafted.slice(0, 4000))
  console.log('EVENTS', events.map((event) => ({ ...event, ms: event.at - started })))
  await fs.writeFile(path.join(artifacts, 'draft-stale-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'draft-stale-events.json'), JSON.stringify(events.map((event) => ({ ...event, ms: event.at - started })), null, 2))
  await fs.writeFile(path.join(artifacts, 'draft-stale-drafted.txt'), drafted)
  await jason.screenshot({ path: path.join(artifacts, 'draft-stale-drafted.png'), fullPage: true })
} finally {
  await aidanContext.close()
  await jasonContext.close()
  await browser.close()
}
