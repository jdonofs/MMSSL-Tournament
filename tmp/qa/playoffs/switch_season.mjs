import { BASE } from './browser.mjs'

export async function switchSeason(page, label) {
  await page.goto(`${BASE}/season`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const select = page.locator('select.nav-season-select')
  await select.selectOption({ label })
  await page.waitForTimeout(1500)
}
