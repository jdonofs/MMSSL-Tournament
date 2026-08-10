import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { playPlan, endGame } from './run_game.mjs'
import { plan } from './game3_plan.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2223`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const remaining = plan.filter(p => p.id >= 3.5)
  await playPlan(page, remaining)
  await shot(page, 'g3-before-end')
  await endGame(page)
  await shot(page, 'g3-ended')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
