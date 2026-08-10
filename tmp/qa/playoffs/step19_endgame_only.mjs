import { shot } from './browser.mjs'
import { openGame, cancelOpenInPlay, endGame } from './score.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  await endGame(page)
  await shot(page, `step19-g${gameId}-ended`)
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 600))
}
