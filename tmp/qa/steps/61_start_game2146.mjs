import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const cardIndex = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.season-game-card')]
    return cards.findIndex((c) => c.textContent.includes('Kings') && c.textContent.includes('Schlongs'))
  })
  console.log('card index:', cardIndex)
  if (cardIndex === -1) throw new Error('card not found')
  await page.locator('.season-game-card').nth(cardIndex).click()
  await page.waitForTimeout(800)
  await page.locator('.modal-backdrop select, .modal-card select').last().selectOption({ label: "Luigi's Mansion" })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Start Game' }).click()
  await page.waitForURL(/scorebook/i, { timeout: 20000 }).catch(() => {})
  await page.waitForLoadState('networkidle')
  // Do NOT visit the Lineups tab -- straight to reading the pitcher, this is
  // the exact repro condition for the initial-pitcher-assignment bug.
  await page.waitForTimeout(3000)
  console.log('URL:', page.url())
  const text = await page.locator('body').innerText()
  const m = text.match(/PITCHER\n([^\n]+)\n/)
  console.log('Auto-assigned pitcher:', m ? m[1].trim() : null, '(Kings away/bat first -> Schlongs pitch first -> expected Donkey Kong)')
  await shot(page, '61-game2146-pitcher')
}
