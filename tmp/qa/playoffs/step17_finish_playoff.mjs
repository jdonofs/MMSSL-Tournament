import { shot } from './browser.mjs'
import { cancelOpenInPlay, playQuickWin } from './score.mjs'

const gameId = Number(process.argv[3])
const side = process.argv[4] // 'home' | 'away'

export default async function (page) {
  console.log('Playing game', gameId, 'winner side:', side)
  await playQuickWin(page, gameId, side)
  await shot(page, `step17-g${gameId}-ended`)
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 400))
}
