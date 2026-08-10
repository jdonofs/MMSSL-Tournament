import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/scorebook?game=2144`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  // Tap Luigi in the defensive (pitching) row twice: select then confirm
  const luigi = page.locator('img[alt="Luigi"]').first()
  await luigi.click()
  await page.waitForTimeout(400)
  await luigi.click()
  await page.waitForTimeout(1500)
  const header = await page.locator('body').innerText()
  console.log('Pitcher is Luigi:', /PITCHER[\s\S]{0,40}Luigi/.test(header))
  await shot(page, '08-pitcher-fixed')
}
