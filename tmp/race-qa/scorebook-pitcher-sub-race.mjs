import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const url = 'http://127.0.0.1:5173/season/scorebook?game=2146'

function card(body) {
  const batter = body.match(/BATTER\s*\n([^\n]+)\n([^\n]+)/)
  const scorebookPitcher = body.match(/PITCHER\s*\n([^\n]+)\n([^\n]+)\nIP ([^\n]+)\nH ([^\n]+)\nR ([^\n]+)\nER ([^\n]+)\nBB ([^\n]+)\nK ([^\n]+)\nP ([^\n]+)/)
  const gamePitcher = body.match(/CURRENT PITCHER\s*\n([^\n]+)\nIP ([^\n]+)\nPitch Count ([^\n]+)/)
  return {
    batter: batter ? `${batter[1]} | ${batter[2]}` : null,
    pitcher: scorebookPitcher?.[1] || gamePitcher?.[1] || null,
    ip: scorebookPitcher?.[3] || gamePitcher?.[2] || null,
    pitches: scorebookPitcher ? Number(scorebookPitcher[9]) : gamePitcher ? Number(gamePitcher[3]) : null,
  }
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
spectator.setDefaultTimeout(60000)

try {
  await Promise.all([
    editor.goto(url, { waitUntil: 'networkidle' }),
    spectator.goto(url, { waitUntil: 'networkidle' }),
  ])
  await Promise.all([editor.waitForTimeout(2000), spectator.waitForTimeout(2000)])
  await spectator.getByRole('button', { name: 'Game View', exact: true }).click()
  await spectator.waitForTimeout(500)
  console.log('BEFORE', { editor: card(await editor.locator('body').innerText()), spectator: card(await spectator.locator('body').innerText()) })
  await slow3g(editor)

  const mutations = []
  editor.on('request', (request) => {
    if (/season_(schedule|lineups|game_fielders|pitching_stints)/.test(request.url()) && request.method() !== 'GET') mutations.push({ type: 'request', time: Date.now(), method: request.method(), table: request.url().match(/\/rest\/v1\/([^?]+)/)?.[1] })
  })
  editor.on('response', (response) => {
    if (/season_(schedule|lineups|game_fielders|pitching_stints)/.test(response.url()) && response.request().method() !== 'GET') mutations.push({ type: 'response', time: Date.now(), method: response.request().method(), status: response.status(), table: response.url().match(/\/rest\/v1\/([^?]+)/)?.[1] })
  })

  await editor.getByRole('button', { name: 'BALL', exact: true }).click()
  const started = Date.now()
  console.log('AFTER BALL', card(await editor.locator('body').innerText()))
  await editor.getByRole('button', { name: 'Lineups', exact: true }).click()
  await editor.locator('img[alt="Bowser Jr."][style*="width: 46px"]').click({ force: true })
  await editor.locator('img[alt="Boomerang Bro"][style*="width: 46px"]').click({ force: true })
  console.log('LINEUP AFTER SWAP\n', (await editor.locator('body').innerText()).slice(-4200))
  await editor.getByRole('button', { name: 'Scorebook', exact: true }).click()

  const timeline = []
  let priorKey = ''
  for (let i = 0; i < 180; i += 1) {
    const [editorBody, spectatorBody] = await Promise.all([editor.locator('body').innerText(), spectator.locator('body').innerText()])
    const row = { ms: Date.now() - started, editor: card(editorBody), spectator: card(spectatorBody) }
    timeline.push(row)
    const key = JSON.stringify(row.editor) + JSON.stringify(row.spectator)
    if (key !== priorKey) {
      console.log('CHANGE', row)
      priorKey = key
      await Promise.all([
        editor.screenshot({ path: path.join(artifacts, `pitcher-sub-editor-${row.ms}.png`), fullPage: true }),
        spectator.screenshot({ path: path.join(artifacts, `pitcher-sub-spectator-${row.ms}.png`), fullPage: true }),
      ])
    }
    await editor.waitForTimeout(100)
  }

  console.log('MUTATIONS', mutations.map((entry) => ({ ...entry, ms: entry.time - started })))
  await fs.writeFile(path.join(artifacts, 'pitcher-sub-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'pitcher-sub-mutations.json'), JSON.stringify(mutations.map((entry) => ({ ...entry, ms: entry.time - started })), null, 2))
  await fs.writeFile(path.join(artifacts, 'pitcher-sub-editor-final.txt'), await editor.locator('body').innerText())
  await fs.writeFile(path.join(artifacts, 'pitcher-sub-spectator-final.txt'), await spectator.locator('body').innerText())
} finally {
  await editorContext.close()
  await spectatorContext.close()
  await browser.close()
}
