import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/scorebook?game=2144`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'GO', exact: true }).click()
  await page.waitForTimeout(800)
  await shot(page, '10-inplay-go')
  console.log(JSON.stringify(await dumpUI(page)))
  const text = await page.locator('body').innerText()
  console.log('---BODY---')
  console.log(text.slice(text.indexOf('BATTER'), text.indexOf('BATTER') + 2500))
}
