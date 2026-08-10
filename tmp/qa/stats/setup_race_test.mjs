import { launch, ensureLoggedIn, shot } from '../browser.mjs'
import { startGameFromSchedule, playPlan } from './run_game.mjs'

const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])

// Big Ds (home) vs Bompkins (away). Get a runner legitimately on base via a
// completed single, then leave the game there for the race test.
const plan = [
  { batter: 'Green Dry Bones', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
]

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await startGameFromSchedule(page, 0)
  await playPlan(page, plan)
  await shot(page, 'race-setup-done')
  console.log('setup done')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
