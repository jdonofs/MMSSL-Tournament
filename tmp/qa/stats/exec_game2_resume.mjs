import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { playPlan, endGame } from './run_game.mjs'
import { plan } from './game2_plan.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2222`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const remaining = plan.slice(4) // PA id 5 onward
  await playPlan(page, remaining)
  await shot(page, 'g2-before-end')
  await endGame(page)
  await shot(page, 'g2-ended')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
