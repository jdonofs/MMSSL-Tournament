import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-draft-fixture-state.json') })
const page = await context.newPage()
try {
  await page.goto('http://127.0.0.1:5173/admin', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.waitForTimeout(300)
  console.log((await page.locator('body').innerText()).slice(-4000))
  console.log(await page.locator('button:visible, input:visible, select:visible').evaluateAll((els) => els.slice(-35).map((el) => ({ tag: el.tagName, text: (el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim(), type: el.type, value: el.value, disabled: el.disabled }))))
} finally {
  await browser.close()
}
