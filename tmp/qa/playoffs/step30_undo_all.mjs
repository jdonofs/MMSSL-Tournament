import { shot } from './browser.mjs'
import { openGame, cancelOpenInPlay } from './score.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  for (let i = 0; i < 60; i++) {
    const undoBtn = page.getByRole('button', { name: 'Undo', exact: true })
    const disabled = await undoBtn.isDisabled().catch(() => true)
    if (disabled) { console.log('Undo disabled after', i, 'clicks'); break }
    await undoBtn.click()
    await page.waitForTimeout(400)
  }
  const bodyText = await page.locator('body').innerText()
  const m = bodyText.match(/(\d+)\s*\n?\s*-\s*\n?\s*(\d+)/)
  await shot(page, `step30-g${gameId}-after-undo`)
  console.log('BODY SNIPPET:', bodyText.slice(0, 300))
}
