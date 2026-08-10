import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/admin', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: 'Create', exact: true }).first().click()
  await page.waitForTimeout(300)
  await page.getByRole('textbox').last().fill('QA RACE DRAFT')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(300)
  console.log((await page.locator('body').innerText()).slice(-5000))
  console.log(await page.locator('button:visible, input:visible, select:visible').evaluateAll((els) => els.slice(-50).map((el) => ({ tag: el.tagName, text: (el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim(), type: el.type, value: el.value, disabled: el.disabled }))))
} finally {
  await browser.close()
}
