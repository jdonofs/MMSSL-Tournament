import { readFileSync, writeFileSync, existsSync } from 'fs'
import { shot } from '../browser.mjs'
import { openGame, runPa, waitForBatter, changePitcherTo, currentBatterName, cancelOpenInPlay } from '../scorebook.mjs'
import { plan } from '../game1_plan.mjs'

const PROGRESS = new URL('../game1_progress.json', import.meta.url)

export default async function (page) {
  let done = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')).done : 0
  console.log('Resuming after PA id', done)
  await openGame(page)
  await cancelOpenInPlay(page)

  for (const spec of plan) {
    if (spec.id <= done) continue
    // Wait for the expected batter to come up (handles half-inning auto-transitions)
    await waitForBatter(page, spec.batter, 20000)
    await runPa(page, spec)
    if (spec.afterPa?.changePitcher) {
      await changePitcherTo(page, spec.afterPa.changePitcher)
      console.log('  pitching change ->', spec.afterPa.changePitcher)
    }
    writeFileSync(PROGRESS, JSON.stringify({ done: spec.id }))
    if (spec.walkOff) {
      // Expect game end banner
      await page.getByRole('button', { name: /mark complete/i }).click({ timeout: 15000 })
      await page.waitForTimeout(3000)
      console.log('Game marked complete (walk-off).')
      await shot(page, '20-final')
    }
  }
  console.log('PLAN COMPLETE')
}
