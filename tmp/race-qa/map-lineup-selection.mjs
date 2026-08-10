import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)

try {
  await page.goto('http://127.0.0.1:5173/season/scorebook?game=2146', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Lineups', exact: true }).click()
  await page.waitForTimeout(500)
  await page.locator('button').filter({ hasText: /^Bowser Jr\.$/ }).click()
  await page.waitForTimeout(500)
  console.log((await page.locator('body').innerText()).slice(-5000))
  console.log(await page.locator('button:visible, select:visible').evaluateAll((els) => els.map((el) => ({ tag: el.tagName, text: (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim(), title: el.title, disabled: el.disabled, cls: el.className }))).then((xs) => xs.slice(-80)))
} finally {
  await browser.close()
}
