import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/create`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  await shot(page, 'step1-create-initial')
  const ui = await dumpUI(page)
  console.log(JSON.stringify(ui, null, 1))
}
