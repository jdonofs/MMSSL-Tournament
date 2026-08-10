import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/roster`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  for (const label of ['Kings', 'Mossers']) {
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
    console.log(label, 'lineup done')
  }

  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const cardIndex = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.season-game-card')]
    return cards.findIndex((c) => c.textContent.includes('Kings') && c.textContent.includes('Mossers'))
  })
  console.log('card index:', cardIndex)
  if (cardIndex === -1) throw new Error('card not found')
  await page.locator('.season-game-card').nth(cardIndex).click()
  await page.waitForTimeout(800)
  const stadiumSelect = page.locator('.modal-backdrop select, .modal-card select').last()
  const opts = await stadiumSelect.locator('option').allInnerTexts()
  const stadiumTarget = opts.find((o) => o.trim().length > 0 && !/select/i.test(o))
  if (stadiumTarget) await stadiumSelect.selectOption({ label: stadiumTarget })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Start Game' }).click()
  await page.waitForURL(/scorebook/i, { timeout: 20000 }).catch(() => {})
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2500)
  console.log('URL:', page.url())
  await shot(page, 'setup-start-2238')
}
