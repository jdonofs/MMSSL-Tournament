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
  const gp = body.match(/CURRENT PITCHER\s*\n([^\n]+)\nIP ([^\n]+)\nPitch Count ([^\n]+)/)
  return { batter: b ? `${b[1]} | ${b[2]}` : null, pitcher: p?.[1] || gp?.[1] || null, ip: p?.[3] || gp?.[2] || null, pitches: p ? Number(p[9]) : gp ? Number(gp[3]) : null }
}

async function slow3g(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024, connectionType: 'cellular3g' })
}

const browser = await chromium.launch({ headless: true })
const editorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const spectatorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'may-qatest-state.json') })
const editor = await editorContext.newPage()
const spectator = await spectatorContext.newPage()
editor.setDefaultTimeout(60000)

try {
  await Promise.all([editor.goto(url, { waitUntil: 'networkidle' }), spectator.goto(url, { waitUntil: 'networkidle' })])
  await Promise.all([editor.waitForTimeout(2000), spectator.waitForTimeout(2000)])
  await spectator.getByRole('button', { name: 'Game View', exact: true }).click()
  await spectator.waitForTimeout(400)
  console.log('BEFORE', { editor: card(await editor.locator('body').innerText()), spectator: card(await spectator.locator('body').innerText()) })
  await slow3g(editor)
  const events = []
  editor.on('request', (r) => r.method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ type: 'request', at: Date.now(), method: r.method(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
  editor.on('response', (r) => r.request().method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ type: 'response', at: Date.now(), method: r.request().method(), status: r.status(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))

  await editor.getByRole('button', { name: 'LOOK', exact: true }).click()
  const started = Date.now()
  console.log('AFTER SECOND PITCH', card(await editor.locator('body').innerText()))
  await editor.getByRole('button', { name: 'Lineups', exact: true }).click()
  await editor.locator('img[alt="Bowser Jr."][style*="width: 46px"]').click({ force: true })
  await editor.locator('img[alt="Boomerang Bro"][style*="width: 46px"]').click({ force: true })
  await editor.getByRole('button', { name: 'Save Team A Lineup', exact: true }).click()
  await editor.waitForTimeout(50)
  await editor.getByRole('button', { name: 'Scorebook', exact: true }).click()
  const saveLeave = editor.getByRole('button', { name: 'Save & Leave', exact: true })
  if (await saveLeave.count()) await saveLeave.click()

  const timeline = []
  let last = ''
  for (let i = 0; i < 200; i += 1) {
    const [eb, sb] = await Promise.all([editor.locator('body').innerText(), spectator.locator('body').innerText()])
    const row = { ms: Date.now() - started, editor: card(eb), spectator: card(sb), editorTail: eb.slice(-300) }
    timeline.push(row)
    const key = JSON.stringify({ e: row.editor, s: row.spectator })
    if (key !== last) {
      console.log('CHANGE', row)
      last = key
      await Promise.all([
        editor.screenshot({ path: path.join(artifacts, `pitcher-sub-save-editor-${row.ms}.png`), fullPage: true }),
        spectator.screenshot({ path: path.join(artifacts, `pitcher-sub-save-spectator-${row.ms}.png`), fullPage: true }),
      ])
    }
    await editor.waitForTimeout(100)
  }
  console.log('EVENTS', events.map((event) => ({ ...event, ms: event.at - started })))
  await fs.writeFile(path.join(artifacts, 'pitcher-sub-save-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'pitcher-sub-save-events.json'), JSON.stringify(events.map((event) => ({ ...event, ms: event.at - started })), null, 2))
} finally {
  await editorContext.close()
  await spectatorContext.close()
  await browser.close()
}
