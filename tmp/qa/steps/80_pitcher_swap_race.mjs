import { shot } from '../browser.mjs'
import { openGame, currentBatterName, pitchCount } from '../scorebook.mjs'

async function readBSO(page) {
  return page.evaluate(() => {
    const text = document.body.innerText
    const m = text.match(/B\nS\nO\n([\s\S]{0,40})/)
    return m ? m[1].replace(/\n/g, '|') : null
  })
}

export default async function (page) {
  await openGame(page, 2238)
  const batter = await currentBatterName(page)
  console.log('batter:', batter)
  console.log('P before:', await pitchCount(page))

  let requestSeen = false
  await page.route('**/rest/v1/season_pitching_stints*', async (route) => {
    if (route.request().method() === 'POST') {
      requestSeen = true
      console.log('  [intercept] pitching_stints POST seen, delaying 4000ms')
      await new Promise((r) => setTimeout(r, 4000))
    }
    await route.continue()
  })

  // Fire pitcher swap (double-click Dark Bones avatar) without waiting for it
  // to settle, then throw a pitch as soon as the network request is in flight.
  const target = page.locator('img[alt="Bowser Jr."]').last()
  await target.click()
  await page.waitForTimeout(150)
  const clickPromise = target.click()

  // Poll for the request to start, then immediately throw a pitch mid-flight
  const start = Date.now()
  while (!requestSeen && Date.now() - start < 3000) await page.waitForTimeout(50)
  console.log('requestSeen after', Date.now() - start, 'ms')
  await page.waitForTimeout(200)
  console.log('P + B/S/O just before mid-flight pitch:', await pitchCount(page), await readBSO(page))
  await page.getByRole('button', { name: 'BALL', exact: true }).click()
  await page.waitForTimeout(300)
  console.log('P + B/S/O immediately after mid-flight pitch click:', await pitchCount(page), await readBSO(page))
  await shot(page, '80-mid-flight')

  await clickPromise
  // Wait past the artificial delay for the insert to resolve and restorePitchState to fire
  await page.waitForTimeout(5000)
  console.log('P + B/S/O after insert resolved:', await pitchCount(page), await readBSO(page))
  await shot(page, '80-after-resolve')

  const domDump = await page.evaluate(() => document.body.innerText.slice(0, 700))
  console.log('FINAL DOM:\n', domDump)
}
