import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const seasonName = 'QA RACE DRAFT 2026-08-02'
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'networkidle' })
  await page.locator('button').filter({ hasText: 'Aidan' }).first().click()
  await page.locator('input[type=password]').fill('Aidan')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.includes('/login'))
  await page.waitForTimeout(6000)
  await page.goto('http://127.0.0.1:5173/season/draft', { waitUntil: 'networkidle' })
  await page.locator('select:visible').first().selectOption({ label: seasonName })
  await page.waitForTimeout(3500)
  console.log((await page.locator('body').innerText()).slice(0, 4000))
  await context.storageState({ path: path.join(root, 'aidan-draft-fixture-state.json') })
} finally {
  await browser.close()
}
