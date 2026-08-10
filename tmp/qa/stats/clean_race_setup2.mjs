import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { playPlan } from './run_game.mjs'
const plan = [
  { batter: 'Wario', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
]
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2227`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await playPlan(page, plan)
  console.log('setup done')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
