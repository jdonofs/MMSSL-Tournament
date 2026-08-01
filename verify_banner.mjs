import { chromium } from 'playwright'
const BASE = 'http://localhost:5175'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } })
page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message))
await page.goto(`${BASE}/login`)
await page.getByText('Jason', { exact: true }).click()
await page.locator('input[type="password"]').fill('Mossss')
await page.getByRole('button', { name: /sign in/i }).click()
await page.waitForURL(/\/season/, { timeout: 15000 })
await page.goto(`${BASE}/teams/3b12101d-2d43-4fa0-9e07-f4132d86dfe3/career`)
await page.waitForTimeout(1500)
await page.screenshot({ path: 'banner_check.png', clip: { x: 0, y: 0, width: 1400, height: 620 } })
await browser.close()
