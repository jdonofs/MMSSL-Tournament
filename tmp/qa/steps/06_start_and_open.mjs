import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /set stadium/i }).first().click()
  await page.waitForTimeout(800)
  await page.locator('.modal-backdrop select, .modal-card select').last().selectOption({ label: 'Mario Stadium' })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Start Game' }).click()
  await page.waitForURL(/scorebook/i, { timeout: 20000 }).catch(() => {})
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2500)
  console.log('URL:', page.url())
  await shot(page, '06-scorebook-initial')
  const ui = await dumpUI(page)
  console.log(JSON.stringify(ui))
}
