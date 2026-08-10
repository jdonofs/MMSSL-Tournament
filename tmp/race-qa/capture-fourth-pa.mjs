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
  await page.getByRole('button', { name: 'At-Bat Data', exact: true }).click()
  await page.waitForTimeout(1000)
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('button', { name: 'Next →', exact: true }).click()
    await page.waitForTimeout(250)
  }
  const body = await page.locator('body').innerText()
  console.log(body.slice(-6000))
  await fs.writeFile(path.join(artifacts, 'confirmed-close-mid-save-fourth-pa.txt'), body)
  await page.screenshot({ path: path.join(artifacts, 'confirmed-close-mid-save-fourth-pa.png'), fullPage: true })
} finally {
  await browser.close()
}
