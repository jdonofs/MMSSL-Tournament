import { chromium } from 'playwright'

const BASE = 'http://localhost:5174'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
page.on('crash', () => errors.push('PAGE CRASHED'))
async function shot(name) { await page.screenshot({ path: `C:/Users/jdono/Sluggers/tmp/${name}.png`, fullPage: true }) }
const pitcherText = async () => page.locator('text=DUM Pitchers').locator('..').innerText().catch(() => 'n/a')

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
await page.waitForTimeout(2000)
console.log('BEFORE:', (await pitcherText()).split('\n').slice(-1)[0])

await page.getByRole('button', { name: 'At-Bat Editor' }).click()
await page.waitForTimeout(1500)
// go to the newest existing page, then one more to reach "new"
let next = page.getByRole('button', { name: 'Next at-bat' })
while (await next.isEnabled()) { await next.click(); await page.waitForTimeout(300) }
await shot('a1-new-page')

await page.getByRole('button', { name: '+ Add pitch' }).click(); await page.waitForTimeout(200)
await page.getByRole('button', { name: '+ Add pitch' }).click(); await page.waitForTimeout(200)
const selects = page.locator('section', { hasText: 'Pitch by pitch' }).locator('div[style*="grid-template-columns"] select')
await selects.nth(2).selectOption('in_play')
await page.locator('section', { hasText: 'Result' }).locator('select').first().selectOption('K')
await page.waitForTimeout(300)
await page.getByRole('button', { name: 'Save at-bat' }).click()
await page.waitForTimeout(2500)
console.log('Errors after save:', errors)

await page.getByRole('button', { name: 'Game View' }).click()
await page.waitForTimeout(1000)
console.log('AFTER SAVE:', (await pitcherText()).split('\n').slice(-1)[0])
await shot('a2-after-save')

await page.getByRole('button', { name: 'At-Bat Editor' }).click()
await page.waitForTimeout(1000)
page.once('dialog', (d) => d.accept())
await page.getByRole('button', { name: 'Delete this at-bat' }).click()
await page.waitForTimeout(2500)
console.log('Errors after delete:', errors)

await page.getByRole('button', { name: 'Game View' }).click()
await page.waitForTimeout(1000)
console.log('AFTER DELETE:', (await pitcherText()).split('\n').slice(-1)[0])
await shot('a3-after-delete')
console.log('Final errors:', errors)
await browser.close()
