import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/home`, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(1000)
  await page.getByRole('link', { name: 'Bets', exact: true }).click().catch(async () => {
    await page.locator('text=Bets').first().click()
  })
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  console.log('URL:', page.url())
  await shot(page, '90-bets-page')
  const dump = await page.evaluate(() => document.body.innerText.slice(0, 2000))
  console.log(dump)
}
