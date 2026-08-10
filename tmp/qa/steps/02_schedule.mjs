import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season`, { waitUntil: 'networkidle' })
  await page.locator('select.nav-season-select').selectOption({ label: 'QA TEST' })
  await page.waitForTimeout(1500)
  await page.getByRole('link', { name: 'Schedule' }).click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)
  await shot(page, '02-schedule')
  // Dump the first week card texts
  const text = await page.locator('main, body').first().innerText()
  console.log(text.slice(0, 3000))
}
