import { openGame, cancelOpenInPlay } from './score.mjs'

const gameId = Number(process.argv[3])

export default async function (page) {
  page.on('response', async (res) => {
    if (res.status() >= 400) {
      let body = ''
      try { body = await res.text() } catch {}
      console.log('BAD RESPONSE', res.status(), res.url(), body.slice(0, 500))
    }
  })
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  await page.getByRole('button', { name: 'End Game', exact: true }).click()
  await page.waitForTimeout(500)
  const confirmBtn = page.getByRole('button', { name: /confirm|end game/i }).last()
  await confirmBtn.click()
  await page.waitForTimeout(4000)
}
