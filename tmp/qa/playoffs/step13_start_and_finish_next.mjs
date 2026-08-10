import { shot, BASE } from './browser.mjs'
import { currentBatterName, cancelOpenInPlay, hitHR, endGame } from './score.mjs'

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
  await page.waitForTimeout(2500)
  const url = page.url()
  console.log('Started game URL:', url)

  await cancelOpenInPlay(page)
  const batter = await currentBatterName(page)
  console.log('Current (away) batter:', batter)
  await hitHR(page)
  console.log('HR hit.')
  await endGame(page)
  await shot(page, `step13-${url.split('game=')[1]}-ended`)
  console.log('Done.')
}
