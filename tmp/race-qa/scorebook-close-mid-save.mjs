import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const url = 'http://127.0.0.1:5173/season/scorebook?game=2146'

function card(body) {
  const b = body.match(/BATTER\s*\n([^\n]+)\n([^\n]+)/)
  const p = body.match(/PITCHER\s*\n([^\n]+)\n([^\n]+)\nIP ([^\n]+)\nH ([^\n]+)\nR ([^\n]+)\nER ([^\n]+)\nBB ([^\n]+)\nK ([^\n]+)\nP ([^\n]+)/)
  const gb = body.match(/CURRENT BATTER\s*\n([^\n]+)\n([^\n]+)/)
  const gp = body.match(/CURRENT PITCHER\s*\n([^\n]+)\nIP ([^\n]+)\nPitch Count ([^\n]+)/)
  return { batter: b ? `${b[1]} | ${b[2]}` : gb ? `${gb[1]} | ${gb[2]}` : null, pitcher: p?.[1] || gp?.[1] || null, ip: p?.[3] || gp?.[2] || null, pitches: p ? Number(p[9]) : gp ? Number(gp[3]) : null }
}

async function slow3g(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024, connectionType: 'cellular3g' })
}

const browser = await chromium.launch({ headless: true })
const editorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const spectatorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'may-qatest-state.json') })
let editor = await editorContext.newPage()
const spectator = await spectatorContext.newPage()
editor.setDefaultTimeout(60000)

try {
  await Promise.all([editor.goto(url, { waitUntil: 'networkidle' }), spectator.goto(url, { waitUntil: 'networkidle' })])
  await Promise.all([editor.waitForTimeout(2000), spectator.waitForTimeout(2000)])
  await spectator.getByRole('button', { name: 'Game View', exact: true }).click()
  await spectator.waitForTimeout(400)
  console.log('BEFORE', { editor: card(await editor.locator('body').innerText()), spectator: card(await spectator.locator('body').innerText()) })
  await slow3g(editor)
  const requests = []
  editor.on('request', (r) => r.method() !== 'GET' && r.url().includes('/rest/v1/') && requests.push({ type: 'request', at: Date.now(), method: r.method(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
  editor.on('response', (r) => r.request().method() !== 'GET' && r.url().includes('/rest/v1/') && requests.push({ type: 'response', at: Date.now(), method: r.request().method(), status: r.status(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))

  await editor.getByRole('button', { name: 'SWING', exact: true }).click()
  const started = Date.now()
  await editor.getByRole('button', { name: 'SWING', exact: true }).click()
  await editor.waitForTimeout(75)
  console.log('AT CLOSE', card(await editor.locator('body').innerText()))
  await editor.screenshot({ path: path.join(artifacts, 'close-mid-save-editor-at-close.png'), fullPage: true })
  await editor.close()

  const spectatorTimeline = []
  let last = ''
  for (let i = 0; i < 100; i += 1) {
    const body = await spectator.locator('body').innerText()
    const state = card(body)
    spectatorTimeline.push({ ms: Date.now() - started, state, tail: body.slice(-500) })
    const key = JSON.stringify(state)
    if (key !== last) {
      console.log('SPECTATOR CHANGE', spectatorTimeline.at(-1))
      last = key
      await spectator.screenshot({ path: path.join(artifacts, `close-mid-save-spectator-${Date.now() - started}.png`), fullPage: true })
    }
    await spectator.waitForTimeout(100)
  }

  editor = await editorContext.newPage()
  editor.setDefaultTimeout(60000)
  await editor.goto(url, { waitUntil: 'networkidle' })
  await editor.waitForTimeout(2500)
  const reopenedBody = await editor.locator('body').innerText()
  console.log('REOPENED', card(reopenedBody))
  console.log('REQUESTS BEFORE CLOSE', requests.map((event) => ({ ...event, ms: event.at - started })))
  await fs.writeFile(path.join(artifacts, 'close-mid-save-spectator-timeline.json'), JSON.stringify(spectatorTimeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'close-mid-save-reopened.txt'), reopenedBody)
  await fs.writeFile(path.join(artifacts, 'close-mid-save-requests.json'), JSON.stringify(requests.map((event) => ({ ...event, ms: event.at - started })), null, 2))
  await editor.screenshot({ path: path.join(artifacts, 'close-mid-save-reopened.png'), fullPage: true })

  await editor.getByRole('button', { name: 'At-Bat Data', exact: true }).click()
  await editor.waitForTimeout(1000)
  const atBatBody = await editor.locator('body').innerText()
  await fs.writeFile(path.join(artifacts, 'close-mid-save-at-bat-data.txt'), atBatBody)
  await editor.screenshot({ path: path.join(artifacts, 'close-mid-save-at-bat-data.png'), fullPage: true })
  console.log('AT-BAT TAIL', atBatBody.slice(-4500))
} finally {
  await editorContext.close()
  await spectatorContext.close()
  await browser.close()
}
