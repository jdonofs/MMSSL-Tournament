import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/season/roster', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Tournament', exact: true }).click()
  await page.waitForTimeout(4000)
  console.log('URL', page.url())
  console.log((await page.locator('body').innerText()).slice(0, 7000))
  console.log(await page.locator('a:visible, button:visible, select:visible').evaluateAll((els) => els.slice(0, 100).map((el) => ({ tag: el.tagName, text: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(), href: el.getAttribute('href'), disabled: el.disabled }))))
} finally {
  await browser.close()
}
