import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
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
    console.log(label, '-> done')
  }
  await shot(page, 'stats-lineups-done')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
