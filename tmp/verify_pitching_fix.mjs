import { chromium } from 'playwright'

const BASE = 'http://localhost:5174'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
async function shot(name) {
  await page.screenshot({ path: `C:/Users/jdono/Sluggers/tmp/${name}.png`, fullPage: true })
}

await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
await page.getByRole('button', { name: /Jason/i }).first().click()
await page.waitForTimeout(500)
await page.locator('input[type="password"]').fill('Mossss')
await page.keyboard.press('Enter')
await page.waitForTimeout(2000)

await page.goto(BASE + '/season/scorebook?game=2286&view=game', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
const pitcherPanelText = async () => (await page.locator('text=CURRENT PITCHER').locator('..').innerText().catch(() => 'n/a'))
console.log('BEFORE:', await pitcherPanelText())
await shot('80-before')

await page.getByRole('button', { name: 'At-Bat Editor' }).click()
await page.waitForTimeout(1500)
const next = page.getByRole('button', { name: 'Next at-bat' })
await next.click(); await page.waitForTimeout(400)
await next.click(); await page.waitForTimeout(400)
console.log('now on new-page (should be #3)')
await page.getByRole('button', { name: '+ Add pitch' }).click(); await page.waitForTimeout(200)
await page.getByRole('button', { name: '+ Add pitch' }).click(); await page.waitForTimeout(200)
const selects = page.locator('section', { hasText: 'Pitch by pitch' }).locator('div[style*="grid-template-columns"] select')
await selects.nth(2).selectOption('in_play')
await page.locator('section', { hasText: 'Result' }).locator('select').first().selectOption('K')
await page.waitForTimeout(400)
await page.getByRole('button', { name: 'Save at-bat' }).click()
await page.waitForTimeout(2500)
console.log('Errors after save:', errors)

await page.getByRole('button', { name: 'Game View' }).click()
await page.waitForTimeout(1000)
console.log('AFTER SAVE:', await pitcherPanelText())
await shot('81-after-save')

// Now delete that at-bat
await page.getByRole('button', { name: 'At-Bat Editor' }).click()
await page.waitForTimeout(1000)
page.once('dialog', (d) => d.accept())
await page.getByRole('button', { name: 'Delete this at-bat' }).click()
await page.waitForTimeout(2500)
console.log('Errors after delete:', errors)

await page.getByRole('button', { name: 'Game View' }).click()
await page.waitForTimeout(1000)
console.log('AFTER DELETE:', await pitcherPanelText())
await shot('82-after-delete')
console.log('Final errors:', errors)
await browser.close()
