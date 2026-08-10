import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { playPlan, endGame } from './run_game.mjs'
import { plan } from './game2_replay2.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2222`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await playPlan(page, plan)
  await shot(page, 'g2-replay2-before-end')
  await endGame(page)
  await shot(page, 'g2-replay2-ended')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
