import { shot, BASE } from './browser.mjs'
import { openGame, currentBatterName, cancelOpenInPlay, hitHR, endGame } from './score.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  const batter = await currentBatterName(page)
  console.log('Current batter (should be AWAY team leadoff):', batter)
  await shot(page, `step12-g${gameId}-before`)
  await hitHR(page)
  console.log('HR hit for', batter)
  await shot(page, `step12-g${gameId}-after-hr`)
  await endGame(page)
  await shot(page, `step12-g${gameId}-ended`)
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 500))
}
