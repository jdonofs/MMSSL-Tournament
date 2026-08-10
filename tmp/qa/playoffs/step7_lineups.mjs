import { shot, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/roster`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  const select = page.locator('select').last()
  const options = await select.locator('option').allInnerTexts()
  console.log('Team options:', options)

  for (const label of options) {
    await select.selectOption({ label })
    await page.waitForTimeout(1200)
    const autoLineup = page.getByRole('button', { name: 'Auto Lineup', exact: true })
    if (await autoLineup.isVisible().catch(() => false)) {
      await autoLineup.click()
      await page.waitForTimeout(600)
    }
    const autoFielding = page.getByRole('button', { name: 'Auto Fielding', exact: true })
    if (await autoFielding.isVisible().catch(() => false)) {
      await autoFielding.click()
      await page.waitForTimeout(600)
    }
    const saveBtn = page.getByRole('button', { name: /save/i }).first()
    if (await saveBtn.isVisible().catch(() => false) && await saveBtn.isEnabled()) {
      await saveBtn.click()
      await page.waitForTimeout(1200)
    }
    console.log(label, '-> save button text:', await saveBtn.innerText().catch(() => '?'))
  }
  await shot(page, 'step7-lineups-done')
}
