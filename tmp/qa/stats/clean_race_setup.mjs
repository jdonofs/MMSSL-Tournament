import { launch, ensureLoggedIn, shot } from '../browser.mjs'
import { startGameFromSchedule, playPlan } from './run_game.mjs'

const plan = [
  { batter: 'Green Dry Bones', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
]

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await startGameFromSchedule(page, 0)
  await playPlan(page, plan)
  console.log('setup done, url:', page.url())
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
