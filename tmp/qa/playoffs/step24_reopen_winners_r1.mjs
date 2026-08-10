import { shot } from './browser.mjs'
import { switchSeason } from './switch_season.mjs'
import { reopenGame } from './reopen.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  await switchSeason(page, 'QA PLAYOFFS DE')
  await reopenGame(page, gameId)
  const toasts = await page.locator('.toast').allInnerTexts()
  console.log('TOASTS:', JSON.stringify(toasts))
}
