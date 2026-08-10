import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { startGameFromSchedule, playPlan, endGame } from './run_game.mjs'

const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])

// Minimal repro: Mossers (home) vs Big Ds (away). Get one PA recorded under a
// reliever (Waluigi, subbed in for Boomerang Bro), then Undo exactly that PA,
// and confirm the reliever's now-empty stint is pruned instead of sticking
// around as a ghost "current pitcher".
const plan = [
  { id: 1, half: 'T1', batter: 'Blue Dry Bones', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 2, half: 'T1', batter: 'Red Kritter', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 3, half: 'T1', batter: 'Petey Piranha', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
  {
    id: 4, half: 'B1', batter: 'Wario', inplay: { result: '1B', chain: ['CF'] }, final: '1B',
    afterPa: { changePitcher: 'Boomerang Bro', side: 'A' }, // no-op change on the wrong side, placeholder removed below
  },
]

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await startGameFromSchedule(page, 0)
  await shot(page, 'fix-started')

  // Play the first 4 batters manually (T1 x3 clean outs, then Wario 1B in B1).
  const { runPa, changePitcherTo } = await import('../scorebook.mjs')
  for (const pa of plan) {
    await runPa(page, { ...pa, afterPa: undefined })
  }
  console.log('-- now changing pitcher to Hammer Bro (Big Ds relief, defending in B1) --')
  await changePitcherTo(page, 'Hammer Bro')

  console.log('-- recording ONE PA under the new pitcher (Dry Bones K) --')
  await runPa(page, { batter: 'Dry Bones', pitches: seq('SSS'), final: 'K' })

  await shot(page, 'fix-before-undo')
  console.log('BODY BEFORE UNDO:', (await page.locator('body').innerText()).slice(0, 400))

  console.log('-- clicking Undo once (should remove Dry Bones K and prune Waluigi stint) --')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.waitForTimeout(2000)

  await shot(page, 'fix-after-undo')
  console.log('BODY AFTER UNDO:', (await page.locator('body').innerText()).slice(0, 400))

  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
