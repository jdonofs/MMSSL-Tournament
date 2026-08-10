import { shot } from './browser.mjs'
import { openGame, cancelOpenInPlay, endGame } from './score.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  await endGame(page)
  await page.waitForTimeout(3000)
  const toasts = await page.locator('.toast').allInnerTexts()
  console.log('TOASTS:', JSON.stringify(toasts))
}
