import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(20000)
page.on('console', (msg) => console.log(`[console.${msg.type()}]`, msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))
page.on('response', (response) => response.url().includes('supabase.co/rest') && console.log('[response]', response.status(), response.request().method(), response.url().replace(/apikey=[^&]+/, 'apikey=REDACTED')))

try {
  await page.goto('http://127.0.0.1:5173/season/scorebook?game=2146', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  console.log('BEFORE\n', (await page.locator('body').innerText()).slice(-1200))
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.getByRole('button', { name: 'GO', exact: true }).click()
  await page.waitForTimeout(500)
  console.log('AFTER GO 500MS\n', (await page.locator('body').innerText()).slice(-2500))
  await page.waitForTimeout(5000)
  const body = await page.locator('body').innerText()
  console.log('AFTER GO 5.5S\n', body.slice(-3000))
  await fs.writeFile(path.join(artifacts, 'score-one-out-after.txt'), body)
  await page.screenshot({ path: path.join(artifacts, 'score-one-out-after.png'), fullPage: true })
} finally {
  await browser.close()
}
