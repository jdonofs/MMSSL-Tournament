import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/roster`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await shot(page, '03-roster')
  const ui = await dumpUI(page)
  console.log(JSON.stringify(ui))
}
