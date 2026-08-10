import { openGame, cancelOpenInPlay } from './score.mjs'
import { shot } from './browser.mjs'

export async function reopenGame(page, gameId) {
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  await page.getByRole('button', { name: 'Reopen Game', exact: true }).click()
  await page.waitForTimeout(500)
  const confirmBtn = page.getByRole('button', { name: /confirm|reopen/i }).last()
  await confirmBtn.click()
  await page.waitForTimeout(2500)
}
