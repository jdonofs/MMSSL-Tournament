import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/bets`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // Click the Bompkins moneyline (-117) cell
  await page.getByText('-117', { exact: true }).first().click()
  await page.waitForTimeout(800)
  await shot(page, '91-after-click-moneyline')
  const dump = await page.evaluate(() => document.body.innerText.slice(-1500))
  console.log(dump)
}
