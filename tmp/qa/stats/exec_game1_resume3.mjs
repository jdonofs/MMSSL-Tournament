import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { playPlan, endGame } from './run_game.mjs'
import { plan } from './game1_plan.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2221`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  console.log('CURRENT BATTER CHECK:', (await page.locator('body').innerText()).slice(0,300))
  const remaining = plan.slice(13) // PA id 14 onward
  await playPlan(page, remaining)
  await shot(page, 'g1-before-end')
  await endGame(page)
  await shot(page, 'g1-ended')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
