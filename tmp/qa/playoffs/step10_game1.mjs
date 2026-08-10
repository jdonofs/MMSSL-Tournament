import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /set stadium/i }).first().click()
  await page.waitForTimeout(800)
  await shot(page, 'step10-stadium-modal')
  console.log('MODAL UI:', JSON.stringify(await dumpUI(page), null, 1))
}
