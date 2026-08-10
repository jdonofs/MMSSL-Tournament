import { shot } from './browser.mjs'
import { reopenGame } from './reopen.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  console.log('Reopening game', gameId)
  await reopenGame(page, gameId)
  await shot(page, `step18-g${gameId}-reopened`)
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 500))
}
