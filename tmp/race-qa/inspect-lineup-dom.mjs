import { chromium } from 'playwright'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
try {
  await page.goto('http://127.0.0.1:5173/season/scorebook?game=2146', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Lineups', exact: true }).click()
  await page.waitForTimeout(500)
  const characterButton = page.locator('button').filter({ hasText: /^Bowser Jr\.$/ })
  console.log(await characterButton.evaluate((el) => el.parentElement?.parentElement?.outerHTML))
  console.log('BLANKS', await page.locator('button:visible').evaluateAll((els) => els.filter((el) => !el.innerText.trim()).map((el, index) => ({ index, html: el.outerHTML.slice(0, 800) })).slice(0, 15)))
  console.log('P NODES', await page.locator('body *').evaluateAll((els) => els.filter((el) => el.offsetParent !== null && el.children.length === 0 && el.textContent.trim() === 'P').map((el) => ({ tag: el.tagName, html: el.parentElement?.outerHTML.slice(0, 1600) }))))
} finally {
  await browser.close()
}
