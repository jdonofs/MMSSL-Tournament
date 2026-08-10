import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/stats`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  await shot(page, '30-stats')
  const ui = await dumpUI(page)
  console.log(JSON.stringify(ui).slice(0, 4000))
  const text = await page.locator('body').innerText()
  console.log('---BODY (first 6000)---')
  console.log(text.slice(0, 6000))
}
