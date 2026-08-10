import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/draft`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await shot(page, 'step4-draft-initial')
  console.log('DRAFT UI:', JSON.stringify(await dumpUI(page), null, 1))
}
