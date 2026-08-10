import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/roster`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await shot(page, 'step6-roster-initial')
  console.log('ROSTER UI:', JSON.stringify(await dumpUI(page), null, 1))
}
