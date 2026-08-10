import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await shot(page, 'step9-schedule')
  console.log('SCHEDULE PAGE UI:', JSON.stringify(await dumpUI(page), null, 1))
  console.log('BODY TEXT:', (await page.locator('body').innerText()).slice(0, 2000))
}
