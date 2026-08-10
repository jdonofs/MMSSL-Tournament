import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)

try {
  await page.goto('http://127.0.0.1:5173/season/scorebook?game=2146', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const cardBody = await page.locator('body').innerText()
  console.log('STABLE SCOREBOOK\n', cardBody.slice(-1800))
  await fs.writeFile(path.join(artifacts, 'confirmed-pitch-desync-scorebook.txt'), cardBody)
  await page.screenshot({ path: path.join(artifacts, 'confirmed-pitch-desync-scorebook.png'), fullPage: true })

  await page.getByRole('button', { name: 'At-Bat Data', exact: true }).click()
  await page.waitForTimeout(1500)
  const atBatBody = await page.locator('body').innerText()
  console.log('AT-BAT DATA\n', atBatBody.slice(-5000))
  await fs.writeFile(path.join(artifacts, 'confirmed-pitch-desync-at-bat-data.txt'), atBatBody)
  await page.screenshot({ path: path.join(artifacts, 'confirmed-pitch-desync-at-bat-data.png'), fullPage: true })
} finally {
  await browser.close()
}
