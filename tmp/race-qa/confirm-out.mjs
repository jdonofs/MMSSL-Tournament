import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)

async function tail(label) {
  console.log(`\n${label}\n`, (await page.locator('body').innerText()).slice(-2200))
  console.log('BUTTONS', await page.locator('button:visible').evaluateAll((els) => els.slice(-30).map((b) => ({ text: b.innerText.replace(/\s+/g, ' ').trim(), disabled: b.disabled, cls: b.className }))))
}

try {
  await page.goto('http://127.0.0.1:5173/season/scorebook?game=2146', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await tail('BEFORE')
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.getByRole('button', { name: 'GO', exact: true }).click()
  await page.locator('button').filter({ hasText: /^P$/ }).click()
  await page.locator('button').filter({ hasText: /^Out$/ }).click()
  await tail('READY TO CONFIRM')
  await page.getByRole('button', { name: 'CONFIRM', exact: true }).click()
  await page.waitForTimeout(100)
  await tail('100MS')
  await page.waitForTimeout(1000)
  await tail('1100MS')
  await page.waitForTimeout(5000)
  await tail('6100MS')
} finally {
  await browser.close()
}
