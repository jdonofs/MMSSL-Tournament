import { shot, BASE } from './browser.mjs'
import { cancelOpenInPlay, playQuickWin } from './score.mjs'

const side = process.argv[3] || 'away'

export default async function (page) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /set stadium/i }).first().click()
  await page.waitForTimeout(800)
  await page.locator('.modal-backdrop select, .modal-card select').last().selectOption({ label: 'Mario Stadium' })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Start Game', exact: true }).click()
  await page.waitForURL(/scorebook/i, { timeout: 20000 }).catch(() => {})
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)
  const url = page.url()
  const gameId = Number(url.split('game=')[1])
  console.log('Started game', gameId, 'winner side:', side)
  await cancelOpenInPlay(page)
  await playQuickWin(page, gameId, side)
  console.log('Finished game', gameId)
}
