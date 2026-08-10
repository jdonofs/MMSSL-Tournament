import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/roster`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  for (const label of ['Kings', 'Schlongs']) {
    const select = page.locator('select').last()
    const options = await select.locator('option').allInnerTexts()
    const target = options.find((o) => o.includes(label))
    if (!target) throw new Error(`No team option matching ${label}`)
    await select.selectOption({ label: target })
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: 'Auto Lineup' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Auto Fielding' }).click()
    await page.waitForTimeout(500)
    const saveBtn = page.getByRole('button', { name: /save/i }).first()
    if (await saveBtn.isEnabled()) { await saveBtn.click(); await page.waitForTimeout(1500) }
    console.log(label, 'done')
  }
}
