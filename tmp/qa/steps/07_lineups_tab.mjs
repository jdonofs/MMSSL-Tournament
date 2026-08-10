import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/scorebook?game=2144`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  await shot(page, '07-scorebook-wait')
  const bodyText = await page.locator('body').innerText()
  console.log('has "No lineup set":', bodyText.includes('No lineup set'))
  await page.getByRole('button', { name: 'Lineups' }).click()
  await page.waitForTimeout(1500)
  await shot(page, '07-lineups-tab')
  const ui = await dumpUI(page)
  console.log(JSON.stringify(ui))
}
