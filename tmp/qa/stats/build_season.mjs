import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)

  // ---- Create season ----
  await page.goto(`${BASE}/season/create`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const nameInput = page.locator('input').first()
  await nameInput.fill('')
  await nameInput.fill('QA STATS')
  const inputs = page.locator('.modal-card input')
  await inputs.nth(1).fill('3') // games per matchup = 3
  const selects = page.locator('.modal-card select')
  await selects.nth(1).selectOption('single_elimination')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(500)

  // Deselect down to 4 players: keep Aidan, Donovan, Jason, May
  await page.getByRole('button', { name: /^Justin/ }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: /^Nick/ }).click()
  await page.waitForTimeout(200)
  await shot(page, 'stats-players-4')

  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(500)
  console.log('REVIEW:', (await page.locator('.modal-card').innerText()).slice(0, 1200))

  await page.getByRole('button', { name: 'Create Season' }).click()
  await page.waitForTimeout(2500)
  await shot(page, 'stats-created')
  console.log('URL after create:', page.url())

  // ---- Autodraft ----
  await page.goto(`${BASE}/season/draft`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  for (let i = 0; i < 6; i++) {
    const captainsBtn = page.getByRole('button', { name: /Auto Draft Captains/i })
    const allBtn = page.getByRole('button', { name: /^Auto Draft$/i })
    if (await captainsBtn.isVisible().catch(() => false)) {
      await captainsBtn.click()
      await page.waitForTimeout(1500)
    } else if (await allBtn.isVisible().catch(() => false)) {
      await allBtn.click()
      await page.waitForTimeout(1500)
    } else {
      break
    }
  }
  await page.waitForTimeout(1000)
  await shot(page, 'stats-drafted')

  // ---- Lineups + fielding for each team ----
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
