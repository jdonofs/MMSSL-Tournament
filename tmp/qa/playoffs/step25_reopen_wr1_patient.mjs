import { shot } from './browser.mjs'
import { switchSeason } from './switch_season.mjs'
import { openGame, cancelOpenInPlay } from './score.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  await switchSeason(page, 'QA PLAYOFFS DE')
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  await page.getByRole('button', { name: 'Reopen Game', exact: true }).click()
  await page.waitForTimeout(500)
  const confirmBtn = page.getByRole('button', { name: /confirm|reopen/i }).last()
  await confirmBtn.click()
  await page.waitForTimeout(6000)
  const toasts = await page.locator('.toast').allInnerTexts()
  console.log('TOASTS:', JSON.stringify(toasts))
}
