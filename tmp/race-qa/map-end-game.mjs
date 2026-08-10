import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/season/scorebook?game=2145', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  console.log('BEFORE\n', (await page.locator('body').innerText()).slice(-1800))
  await page.getByRole('button', { name: 'End Game', exact: true }).click()
  await page.waitForTimeout(300)
  console.log('MODAL\n', (await page.locator('body').innerText()).slice(-3500))
  console.log(await page.locator('button:visible, input:visible, select:visible').evaluateAll((els) => els.slice(-40).map((el) => ({ tag: el.tagName, text: (el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim(), type: el.type, disabled: el.disabled }))))
} finally {
  await browser.close()
}
