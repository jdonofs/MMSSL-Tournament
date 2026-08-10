import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/scorebook?game=2144`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.waitForTimeout(800)
  await shot(page, '09-inplay-stage1')
  console.log(JSON.stringify(await dumpUI(page)))
}
