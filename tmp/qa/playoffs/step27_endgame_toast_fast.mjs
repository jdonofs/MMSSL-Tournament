import { shot } from './browser.mjs'
import { openGame, cancelOpenInPlay } from './score.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  await page.getByRole('button', { name: 'End Game', exact: true }).click()
  await page.waitForTimeout(500)
  const confirmBtn = page.getByRole('button', { name: /confirm|end game/i }).last()
  await confirmBtn.click()
  // poll for toasts immediately, don't wait a fixed long time first
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300)
    const toasts = await page.locator('.toast').allInnerTexts()
    if (toasts.length) console.log(`t+${(i + 1) * 300}ms TOASTS:`, JSON.stringify(toasts))
  }
}
