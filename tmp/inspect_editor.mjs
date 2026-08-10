import { chromium } from 'playwright'

const BASE = 'http://localhost:5174'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (msg) => { errors.push(`[${msg.type()}] ${msg.text()}`) })
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))

await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
await page.getByRole('button', { name: /Jason/i }).first().click()
await page.waitForTimeout(500)
await page.locator('input[type="password"]').fill('Mossss')
await page.keyboard.press('Enter')
await page.waitForTimeout(2000)

await page.goto(BASE + '/season/scorebook?game=2286&view=game', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'At-Bat Editor' }).click()
await page.waitForTimeout(3000)
await page.screenshot({ path: 'C:/Users/jdono/Sluggers/tmp/90-editor-inspect.png', fullPage: true })
console.log('console log (last 30):')
console.log(errors.slice(-30).join('\n'))
await browser.close()
