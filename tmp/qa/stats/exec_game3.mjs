import { launch, ensureLoggedIn, shot } from '../browser.mjs'
import { startGameFromSchedule, playPlan, endGame } from './run_game.mjs'
import { plan } from './game3_plan.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await startGameFromSchedule(page, 0)
  await shot(page, 'g3-started')
  await playPlan(page, plan)
  await shot(page, 'g3-before-end')
  await endGame(page)
  await shot(page, 'g3-ended')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
