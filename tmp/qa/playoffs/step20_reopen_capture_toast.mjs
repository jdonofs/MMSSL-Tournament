import { shot } from './browser.mjs'
import { openGame, cancelOpenInPlay } from './score.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  await page.getByRole('button', { name: 'Reopen Game', exact: true }).click()
  await page.waitForTimeout(500)
  const confirmBtn = page.getByRole('button', { name: /confirm|reopen/i }).last()
  await confirmBtn.click()
  await page.waitForTimeout(3000)
  const toasts = await page.locator('.toast').allInnerTexts()
  console.log('TOASTS:', JSON.stringify(toasts))
  await shot(page, `step20-g${gameId}-toasts`)
}
