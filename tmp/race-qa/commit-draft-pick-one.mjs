import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-draft-fixture-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/season/draft', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  console.log('BEFORE COMMIT\n', (await page.locator('body').innerText()).slice(0, 1800))
  await page.getByRole('button', { name: 'Make Pick', exact: true }).click()
  await page.waitForTimeout(6000)
  console.log('AFTER COMMIT\n', (await page.locator('body').innerText()).slice(0, 2200))
  await context.storageState({ path: path.join(root, 'jason-draft-fixture-state.json') })
} finally {
  await browser.close()
}
