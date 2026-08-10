import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/scorebook?game=2238`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const text = await page.locator('body').innerText()
  console.log(text.slice(0, 700))
  await shot(page, '81-pip-check')
}
