import { shot, dumpUI, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // Find the card whose text contains "Mossers" and "Big Ds"
  const cardIndex = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.season-game-card')]
    return cards.findIndex((c) => c.textContent.includes('Mossers') && c.textContent.includes('Big Ds'))
  })
  console.log('card index:', cardIndex)
  if (cardIndex === -1) throw new Error('card not found')
  await page.locator('.season-game-card').nth(cardIndex).click()
  await page.waitForTimeout(800)
  await page.locator('.modal-backdrop select, .modal-card select').last().selectOption({ label: 'Yoshi Park' })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Start Game' }).click()
  await page.waitForURL(/scorebook/i, { timeout: 20000 }).catch(() => {})
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2500)
  console.log('URL:', page.url())
  await shot(page, '51-game2145-start')
}
