import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { playPlan, endGame } from './run_game.mjs'
import { plan } from './game1_plan.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2221`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const remaining = plan.slice(3) // PA ids 4..22
  await playPlan(page, remaining)
  await shot(page, 'g1-before-end')
  await endGame(page)
  await shot(page, 'g1-ended')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
