import { shot, dumpUI } from '../browser.mjs'
import { openGame, currentCount, currentBatterName } from '../scorebook.mjs'

export default async function (page) {
  await openGame(page)
  console.log('batter:', await currentBatterName(page))
  console.log('count:', JSON.stringify(await currentCount(page)))
  const body = await page.locator('body').innerText()
  const ballsStrikes = body.match(/\nB\n([\s\S]{0,40})O\n/)
  await shot(page, '11-state')
  // Undo any stray pitches from abandoned probes
  for (let i = 0; i < 5; i++) {
    const c = await currentCount(page)
    if (!c || c.p === 0) break
    console.log('undoing stray pitch, P =', c.p)
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForTimeout(1200)
  }
  console.log('count after cleanup:', JSON.stringify(await currentCount(page)))
  // Probe 1B stage-2: check for SHAPE picker
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: '1B', exact: true }).click()
  await page.waitForTimeout(700)
  await shot(page, '11-probe-1b')
  console.log(JSON.stringify(await dumpUI(page)))
  // Back out fully: BACK to result stage, then BACK again to cancel
  await page.getByRole('button', { name: 'BACK', exact: true }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'BACK', exact: true }).click()
  await page.waitForTimeout(800)
  console.log('count after backout:', JSON.stringify(await currentCount(page)))
}
