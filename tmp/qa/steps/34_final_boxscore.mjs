import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/scorebook?game=2144`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await page.getByRole('button', { name: 'Game View', exact: true }).click()
  await page.waitForTimeout(2500)
  await shot(page, '34-gameview')
  const text = await page.locator('body').innerText()
  console.log(text.slice(0, 4000))
}
