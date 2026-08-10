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

async function waitEnabledAndClick(page, name, timeout = 30000) {
  const started = Date.now()
  const button = page.getByRole('button', { name, exact: true })
  while (Date.now() - started < timeout) {
    if (await button.isEnabled().catch(() => false)) {
      await button.click()
      return Date.now()
    }
    await page.waitForTimeout(50)
  }
  throw new Error(`${name} never became enabled`)
}

const browser = await chromium.launch({ headless: true })
const editorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const spectatorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'may-qatest-state.json') })
const editor = await editorContext.newPage()
const spectator = await spectatorContext.newPage()
editor.setDefaultTimeout(60000)

try {
  await Promise.all([editor.goto(url, { waitUntil: 'networkidle' }), spectator.goto(url, { waitUntil: 'networkidle' })])
  await Promise.all([editor.waitForTimeout(1800), spectator.waitForTimeout(1800)])
  await spectator.getByRole('button', { name: 'Game View', exact: true }).click()
  await spectator.waitForTimeout(400)
  console.log('BEFORE', { editor: card(await editor.locator('body').innerText()), spectator: card(await spectator.locator('body').innerText()) })
  await slow3g(editor)

  const events = []
  editor.on('request', (r) => r.method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ type: 'request', at: Date.now(), method: r.method(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))
  editor.on('response', (r) => r.request().method() !== 'GET' && r.url().includes('/rest/v1/') && events.push({ type: 'response', at: Date.now(), method: r.request().method(), status: r.status(), table: r.url().match(/\/rest\/v1\/([^?]+)/)?.[1] }))

  await editor.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await editor.getByRole('button', { name: 'GO', exact: true }).click()
  await editor.locator('button').filter({ hasText: /^P$/ }).click()
  await editor.locator('button').filter({ hasText: /^Out$/ }).click()
  const started = Date.now()
  await editor.getByRole('button', { name: 'CONFIRM', exact: true }).click()

  const timeline = []
  let action = 'saving'
  let undoAt = null
  let redoAt = null
  let last = ''
  for (let i = 0; i < 320; i += 1) {
    const [eb, sb] = await Promise.all([editor.locator('body').innerText(), spectator.locator('body').innerText()])
    const buttons = {
      undo: await editor.getByRole('button', { name: 'Undo', exact: true }).isEnabled().catch(() => false),
      redo: await editor.getByRole('button', { name: 'Redo', exact: true }).isEnabled().catch(() => false),
    }
    const row = { ms: Date.now() - started, action, editor: card(eb), spectator: card(sb), buttons }
    timeline.push(row)
    const key = JSON.stringify({ action, e: row.editor, s: row.spectator, buttons })
    if (key !== last) {
      console.log('CHANGE', row)
      last = key
    }
    if (action === 'saving' && buttons.undo) {
      undoAt = await waitEnabledAndClick(editor, 'Undo')
      action = 'undoing'
      await editor.screenshot({ path: path.join(artifacts, 'undo-redo-clicked-undo.png'), fullPage: true })
    } else if (action === 'undoing' && buttons.redo) {
      redoAt = await waitEnabledAndClick(editor, 'Redo')
      action = 'redoing'
      await editor.screenshot({ path: path.join(artifacts, 'undo-redo-clicked-redo.png'), fullPage: true })
    } else if (action === 'redoing' && buttons.undo && Date.now() - redoAt > 5000) {
      action = 'settled'
    }
    if (action === 'settled' && Date.now() - redoAt > 12000) break
    await editor.waitForTimeout(100)
  }

  console.log('ACTION TIMES', { undoMs: undoAt - started, redoMs: redoAt - started })
  console.log('FINAL', timeline.at(-1))
  console.log('EVENTS', events.map((event) => ({ ...event, ms: event.at - started })))
  await fs.writeFile(path.join(artifacts, 'undo-redo-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'undo-redo-events.json'), JSON.stringify(events.map((event) => ({ ...event, ms: event.at - started })), null, 2))
  await Promise.all([
    editor.screenshot({ path: path.join(artifacts, 'undo-redo-final-editor.png'), fullPage: true }),
    spectator.screenshot({ path: path.join(artifacts, 'undo-redo-final-spectator.png'), fullPage: true }),
  ])
} finally {
  await editorContext.close()
  await spectatorContext.close()
  await browser.close()
}
