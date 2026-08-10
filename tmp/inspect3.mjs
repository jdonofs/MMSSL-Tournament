import { chromium } from 'playwright'

const BASE = 'http://localhost:5174'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
page.on('crash', () => errors.push('PAGE CRASHED'))
async function shot(name) { await page.screenshot({ path: `C:/Users/jdono/Sluggers/tmp/${name}.png`, fullPage: true }) }

await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
await page.getByRole('button', { name: /Jason/i }).first().click()
await page.waitForTimeout(500)
await page.locator('input[type="password"]').fill('Mossss')
await page.keyboard.press('Enter')
await page.waitForTimeout(2000)

await page.goto(BASE + '/season/schedule', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /Resume Game/i }).first().click()
await page.waitForTimeout(2500)
console.log('URL:', page.url())
await shot('92-resumed')
console.log('Errors:', errors)

const tab = page.getByRole('button', { name: 'At-Bat Editor' })
console.log('tab count:', await tab.count())
if (await tab.count()) {
  await tab.click()
  await page.waitForTimeout(2000)
  await shot('93-editor-tab')
}
console.log('Errors after tab:', errors)
await browser.close()
