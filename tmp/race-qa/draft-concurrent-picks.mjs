import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const url = 'http://127.0.0.1:5173/season/draft'

function draftState(body) {
  const match = body.match(/PICK\s*\n(\d+)\nROUND\s*\n(\d+)\nREMAINING\s*\n(\d+)\nON THE CLOCK\s*\n([^\n]+)/)
  return { pick: match ? Number(match[1]) : null, round: match ? Number(match[2]) : null, remaining: match ? Number(match[3]) : null, clock: match?.[4] || null, head: body.slice(0, 1400), tail: body.slice(-400) }
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
  await Promise.all([aidan.waitForTimeout(1600), jason.waitForTimeout(1600)])
  console.log('BEFORE', { aidan: draftState(await aidan.locator('body').innerText()), jason: draftState(await jason.locator('body').innerText()) })
  console.log('BUTTONS', {
    aidanDrafts: await aidan.getByRole('button', { name: 'Draft', exact: true }).count(),
    jasonForces: await jason.getByRole('button', { name: 'Force', exact: true }).count(),
  })
  await slow3g(aidan)

  const events = []
  for (const [label, page] of [['aidan', aidan], ['jason', jason]]) {
    page.on('request', (r) => r.method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ label, type: 'request', at: Date.now(), method: r.method(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
    page.on('response', (r) => r.request().method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ label, type: 'response', at: Date.now(), method: r.request().method(), status: r.status(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
  }

  const aidanMario = aidan.getByRole('button', { name: 'Draft', exact: true }).first()
  const jasonBirdo = jason.getByRole('button', { name: 'Force', exact: true }).nth(1)
  const started = Date.now()
  await Promise.all([aidanMario.click(), jasonBirdo.click()])

  const timeline = []
  let last = ''
  for (let i = 0; i < 180; i += 1) {
    const [ab, jb] = await Promise.all([aidan.locator('body').innerText(), jason.locator('body').innerText()])
    const row = { ms: Date.now() - started, aidan: draftState(ab), jason: draftState(jb) }
    timeline.push(row)
    const key = JSON.stringify({ a: { pick: row.aidan.pick, clock: row.aidan.clock, remaining: row.aidan.remaining, tail: row.aidan.tail }, j: { pick: row.jason.pick, clock: row.jason.clock, remaining: row.jason.remaining, tail: row.jason.tail } })
    if (key !== last) {
      console.log('CHANGE', row)
      last = key
      await Promise.all([
        aidan.screenshot({ path: path.join(artifacts, `draft-race-aidan-${row.ms}.png`), fullPage: true }),
        jason.screenshot({ path: path.join(artifacts, `draft-race-jason-${row.ms}.png`), fullPage: true }),
      ])
    }
    await aidan.waitForTimeout(100)
  }

  for (const [label, page] of [['aidan', aidan], ['jason', jason]]) {
    await page.getByText('Drafted Players', { exact: true }).click()
    await page.waitForTimeout(1000)
    const body = await page.locator('body').innerText()
    console.log(`${label.toUpperCase()} DRAFTED\n`, body.slice(0, 5000))
    await fs.writeFile(path.join(artifacts, `draft-race-${label}-drafted.txt`), body)
    await page.screenshot({ path: path.join(artifacts, `draft-race-${label}-drafted.png`), fullPage: true })
  }

  console.log('EVENTS', events.map((event) => ({ ...event, ms: event.at - started })))
  await fs.writeFile(path.join(artifacts, 'draft-race-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'draft-race-events.json'), JSON.stringify(events.map((event) => ({ ...event, ms: event.at - started })), null, 2))
} finally {
  await aidanContext.close()
  await jasonContext.close()
  await browser.close()
}
