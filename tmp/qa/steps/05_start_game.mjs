import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // First card: Bompkins @ Dumbos (game 2144). Click its "Set Stadium" button.
  await page.getByRole('button', { name: /set stadium/i }).first().click()
  await page.waitForTimeout(800)
  await shot(page, '05-stadium-modal')
  const ui = await dumpUI(page)
  console.log(JSON.stringify(ui))
}
