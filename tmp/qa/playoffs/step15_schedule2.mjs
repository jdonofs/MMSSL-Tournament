import { shot, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await shot(page, 'step15-schedule-playoffs')
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 2500))
}
