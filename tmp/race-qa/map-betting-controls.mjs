import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'may-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/season/bets', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const buttons = await page.locator('button:visible').evaluateAll((els) => els.map((el, index) => ({
    index,
    text: el.innerText.replace(/\s+/g, ' ').trim(),
    aria: el.getAttribute('aria-label'),
    title: el.title,
    disabled: el.disabled,
    parent: el.parentElement?.innerText.replace(/\s+/g, ' ').trim().slice(0, 500),
    html: el.outerHTML.slice(0, 900),
  })))
  console.log(JSON.stringify(buttons.slice(0, 90), null, 2))
} finally {
  await browser.close()
}
