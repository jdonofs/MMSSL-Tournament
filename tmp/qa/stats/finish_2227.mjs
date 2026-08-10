import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { playPlan, endGame } from './run_game.mjs'
const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])
const plan = [
  { batter: 'Dry Bones', pitches: seq('SSS'), final: 'K' },
  { batter: 'Bowser', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { batter: 'Birdo', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
]
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2227`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await playPlan(page, plan)
  await endGame(page)
  await shot(page, 'g2227-final')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
