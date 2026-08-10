import { chromium } from 'playwright'

const BASE = 'http://localhost:5174'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (msg) => { errors.push(`[${msg.type()}] ${msg.text()}`) })
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
page.on('crash', () => errors.push('PAGE CRASHED'))

await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
await page.getByRole('button', { name: /Jason/i }).first().click()
await page.waitForTimeout(500)
await page.locator('input[type="password"]').fill('Mossss')
await page.keyboard.press('Enter')
await page.waitForTimeout(2000)
console.log('post-login URL:', page.url())

await page.goto(BASE + '/season/scorebook?game=2286&view=game', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
console.log('scorebook URL:', page.url())
await page.screenshot({ path: 'C:/Users/jdono/Sluggers/tmp/91-scorebook-loaded.png', fullPage: true })
console.log('console so far:')
console.log(errors.join('\n'))
await browser.close()
