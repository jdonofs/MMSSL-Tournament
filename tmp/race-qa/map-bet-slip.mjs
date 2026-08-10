import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'may-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/season/bets', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  await page.locator('button[data-column-label="Moneyline"]').nth(3).click()
  await page.waitForTimeout(500)
  console.log((await page.locator('body').innerText()).slice(-4000))
  console.log(await page.locator('button:visible, input:visible, select:visible').evaluateAll((els) => els.slice(-40).map((el) => ({ tag: el.tagName, text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(), type: el.type, disabled: el.disabled, min: el.min, max: el.max }))))
} finally {
  await browser.close()
}
