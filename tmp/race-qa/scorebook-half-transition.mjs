import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const url = 'http://127.0.0.1:5173/season/scorebook?game=2146'

function compact(body) {
  const batter = body.match(/BATTER\s*\n([^\n]+)\n([^\n]+)/)
  const pitcher = body.match(/PITCHER\s*\n([^\n]+)\n([^\n]+)\nIP ([^\n]+)\nH ([^\n]+)\nR ([^\n]+)\nER ([^\n]+)\nBB ([^\n]+)\nK ([^\n]+)\nP ([^\n]+)/)
  return {
    batter: batter ? `${batter[1]} | ${batter[2]}` : null,
    pitcher: pitcher?.[1] || null,
    pitcherTeam: pitcher?.[2] || null,
    ip: pitcher?.[3] || null,
    pitches: pitcher ? Number(pitcher[9]) : null,
    tail: body.slice(-600),
  }
}

async function openPage(context, label) {
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  page.on('console', (msg) => msg.type() === 'error' && console.log(`[${label} console.error]`, msg.text()))
  page.on('pageerror', (err) => console.log(`[${label} pageerror]`, err.message))
  return page
}

async function slow3g(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: 50 * 1024,
    uploadThroughput: 20 * 1024,
    connectionType: 'cellular3g',
  })
}

const browser = await chromium.launch({ headless: true })
const editorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const spectatorContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'may-qatest-state.json') })

try {
  let editor = await openPage(editorContext, 'editor-abandon')
  await editor.goto(url, { waitUntil: 'networkidle' })
  await editor.waitForTimeout(2000)
  const beforeAbandon = await editor.locator('body').innerText()
  console.log('BEFORE ABANDON', compact(beforeAbandon))
  await editor.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await editor.getByRole('button', { name: 'GO', exact: true }).click()
  await editor.waitForTimeout(3500)
  const abandonedModal = await editor.locator('body').innerText()
  console.log('ABANDONED MODAL', compact(abandonedModal))
  await editor.screenshot({ path: path.join(artifacts, 'half-transition-abandoned-modal.png'), fullPage: true })
  await editor.close()

  editor = await openPage(editorContext, 'editor-final')
  await editor.goto(url, { waitUntil: 'networkidle' })
  await editor.waitForTimeout(2000)
  const reopened = await editor.locator('body').innerText()
  console.log('REOPENED AFTER ABANDON', compact(reopened))
  await editor.screenshot({ path: path.join(artifacts, 'half-transition-reopened.png'), fullPage: true })

  const spectator = await openPage(spectatorContext, 'spectator')
  await spectator.goto(url, { waitUntil: 'networkidle' })
  await spectator.waitForTimeout(2000)
  const gameView = spectator.getByRole('button', { name: 'Game View', exact: true })
  if (await gameView.count()) await gameView.click()
  await spectator.waitForTimeout(1000)
  console.log('SPECTATOR BEFORE', compact(await spectator.locator('body').innerText()))
  await spectator.screenshot({ path: path.join(artifacts, 'half-transition-spectator-before.png'), fullPage: true })

  await slow3g(editor)
  const mutationLog = []
  editor.on('request', (request) => {
    if (/season_(plate_appearances|pitches|schedule|pitching_stints|inning_scores)/.test(request.url()) && request.method() !== 'GET') {
      mutationLog.push({ type: 'request', ms: Date.now(), method: request.method(), url: request.url().split('?')[0] })
    }
  })
  editor.on('response', (response) => {
    if (/season_(plate_appearances|pitches|schedule|pitching_stints|inning_scores)/.test(response.url()) && response.request().method() !== 'GET') {
      mutationLog.push({ type: 'response', ms: Date.now(), status: response.status(), method: response.request().method(), url: response.url().split('?')[0] })
    }
  })

  await editor.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await editor.getByRole('button', { name: 'GO', exact: true }).click()
  await editor.locator('button').filter({ hasText: /^P$/ }).click()
  await editor.locator('button').filter({ hasText: /^Out$/ }).click()
  const started = Date.now()
  await editor.getByRole('button', { name: 'CONFIRM', exact: true }).click()

  const timeline = []
  for (let i = 0; i < 180; i += 1) {
    const [editorBody, spectatorBody] = await Promise.all([
      editor.locator('body').innerText().catch(() => ''),
      spectator.locator('body').innerText().catch(() => ''),
    ])
    timeline.push({ ms: Date.now() - started, editor: compact(editorBody), spectator: compact(spectatorBody) })
    if ([0, 15, 35, 65, 110, 175].includes(i)) {
      await Promise.all([
        editor.screenshot({ path: path.join(artifacts, `half-transition-editor-${i}.png`), fullPage: true }),
        spectator.screenshot({ path: path.join(artifacts, `half-transition-spectator-${i}.png`), fullPage: true }),
      ])
    }
    await editor.waitForTimeout(100)
  }

  const changes = timeline.filter((row, i) => i === 0 || JSON.stringify({ e: row.editor.batter, ep: row.editor.pitcher, epp: row.editor.pitches, eip: row.editor.ip, s: row.spectator.batter, sp: row.spectator.pitcher, spp: row.spectator.pitches, sip: row.spectator.ip }) !== JSON.stringify({ e: timeline[i - 1].editor.batter, ep: timeline[i - 1].editor.pitcher, epp: timeline[i - 1].editor.pitches, eip: timeline[i - 1].editor.ip, s: timeline[i - 1].spectator.batter, sp: timeline[i - 1].spectator.pitcher, spp: timeline[i - 1].spectator.pitches, sip: timeline[i - 1].spectator.ip }))
  console.log('TRANSITION CHANGES', changes)
  console.log('MUTATIONS', mutationLog.map((entry) => ({ ...entry, ms: entry.ms - started })))
  await fs.writeFile(path.join(artifacts, 'half-transition-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'half-transition-mutations.json'), JSON.stringify(mutationLog.map((entry) => ({ ...entry, ms: entry.ms - started })), null, 2))

  await editor.getByRole('button', { name: 'At-Bat Data', exact: true }).click()
  await editor.waitForTimeout(2000)
  const atBat = await editor.locator('body').innerText()
  console.log('AT-BAT FINAL TAIL', atBat.slice(-5500))
  await fs.writeFile(path.join(artifacts, 'half-transition-at-bat-data.txt'), atBat)
  await editor.screenshot({ path: path.join(artifacts, 'half-transition-at-bat-data.png'), fullPage: true })
} finally {
  await editorContext.close()
  await spectatorContext.close()
  await browser.close()
}
