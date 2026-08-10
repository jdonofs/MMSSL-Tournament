import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { playPlan } from './run_game.mjs'

const plan = [
  { batter: 'Green Dry Bones', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
]

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2225`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await playPlan(page, plan)
  await shot(page, 'race-setup2-done')
  console.log('setup done')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
