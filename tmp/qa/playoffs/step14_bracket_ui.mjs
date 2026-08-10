import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/bracket`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await shot(page, 'step14-bracket')
  console.log('BRACKET BODY:', (await page.locator('body').innerText()).slice(0, 2500))
}
