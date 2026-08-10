import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  console.log('URL after login:', page.url())
  await page.goto(`${BASE}/season`, { waitUntil: 'networkidle' })
  await shot(page, '01-season-home')
  const ui = await dumpUI(page)
  console.log(JSON.stringify(ui, null, 1))
}
