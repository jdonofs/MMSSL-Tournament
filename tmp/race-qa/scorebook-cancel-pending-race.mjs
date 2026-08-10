import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const url = 'http://127.0.0.1:5173/season/scorebook?game=2146'

function scoreState(body) {
  const pitcher = body.match(/PITCHER\s*\n([^\n]+)\n([^\n]+)\nIP ([^\n]+)\nH ([^\n]+)\nR ([^\n]+)\nER ([^\n]+)\nBB ([^\n]+)\nK ([^\n]+)\nP ([^\n]+)/)
  const batter = body.match(/BATTER\s*\n([^\n]+)/)
  return pitcher ? { batter: batter?.[1], pitcher: pitcher[1], team: pitcher[2], ip: pitcher[3], pitches: Number(pitcher[9]) } : { tail: body.slice(-1000) }
}

async function newPage(context, label) {
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
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
  return cdp
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })

try {
  let page = await newPage(context, 'cancel')
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const initialBody = await page.locator('body').innerText()
  console.log('INITIAL', scoreState(initialBody))
  await slow3g(page)
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  const modalBody = await page.locator('body').innerText()
  console.log('AFTER IN PLAY', scoreState(modalBody))
  await page.getByRole('button', { name: 'BACK', exact: true }).click()
  await page.waitForTimeout(100)
  const afterBackBody = await page.locator('body').innerText()
  console.log('AFTER BACK 100MS', scoreState(afterBackBody))
  await page.screenshot({ path: path.join(artifacts, 'cancel-pending-after-back.png'), fullPage: true })
  await page.close()

  page = await newPage(context, 'reopen')
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const reopenedBody = await page.locator('body').innerText()
  console.log('REOPENED', scoreState(reopenedBody))
  await page.screenshot({ path: path.join(artifacts, 'cancel-pending-reopened-before-commit.png'), fullPage: true })

  await slow3g(page)
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.getByRole('button', { name: 'GO', exact: true }).click()
  await page.locator('button').filter({ hasText: /^P$/ }).click()
  await page.locator('button').filter({ hasText: /^Out$/ }).click()
  const confirmStarted = Date.now()
  await page.getByRole('button', { name: 'CONFIRM', exact: true }).click()

  const timeline = []
  for (let i = 0; i < 160; i += 1) {
    const body = await page.locator('body').innerText().catch(() => '')
    const buttons = await page.locator('button:visible').evaluateAll((els) => els.slice(-15).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled }))).catch(() => [])
    timeline.push({ ms: Date.now() - confirmStarted, state: scoreState(body), buttons })
    await page.waitForTimeout(100)
  }
  const finalBody = await page.locator('body').innerText()
  console.log('FINAL', scoreState(finalBody))
  console.log('STATE CHANGES', timeline.filter((item, index) => index === 0 || JSON.stringify(item.state) !== JSON.stringify(timeline[index - 1].state)))
  await fs.writeFile(path.join(artifacts, 'cancel-pending-race-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'cancel-pending-final.txt'), finalBody)
  await page.screenshot({ path: path.join(artifacts, 'cancel-pending-final.png'), fullPage: true })
} finally {
  await context.close()
  await browser.close()
}
