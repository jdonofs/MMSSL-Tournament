import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const url = page.url()
  console.log('schedule URL:', url)
  await shot(page, '71-schedule')
}
