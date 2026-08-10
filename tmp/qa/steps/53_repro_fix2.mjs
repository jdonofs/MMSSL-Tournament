import { shot, BASE } from '../browser.mjs'
import { openGame, clickResult, clickChain, confirmInPlay, currentBatterName, changePitcherTo, cancelOpenInPlay } from '../scorebook.mjs'

const MOSSERS = ['Funky Kong', 'Blue Kritter', 'King K. Rool', 'Yellow Pianta', 'Red Toad', 'Green Shy Guy', 'Red Yoshi', 'Light-Blue Yoshi', 'Waluigi']
const BIGDS = ['Hammer Bro', 'Brown Kritter', 'Blue Dry Bones', 'Wario', 'Yellow Toad', 'Peach', 'Monty Mole', 'Blue Shy Guy', 'Paratroopa']

async function pitcherName(page) {
  const m = (await page.locator('body').innerText()).match(/PITCHER\n([^\n]+)\n/)
  return m ? m[1].trim() : null
}
async function quickOut(page, chain) {
  await clickResult(page, 'GO')
  await clickChain(page, chain)
  await confirmInPlay(page)
}
async function playUntilBatterIn(page, roster, label) {
  for (let i = 0; i < 10; i++) {
    const b = await currentBatterName(page)
    if (roster.includes(b)) { console.log(`  reached ${label}, batter=${b}`); return }
    await quickOut(page, ['SS', '1B'])
  }
  throw new Error(`never reached ${label}`)
}

export default async function (page) {
  await openGame(page, 2145)
  await cancelOpenInPlay(page)
  console.log('T1 batter:', await currentBatterName(page), 'pitcher (Big Ds, currently mis-assigned):', await pitcherName(page))

  // Change Big Ds' pitcher (currently Hammer Bro via the initial-assign bug)
  // to the SAVED correct pitcher, Wario, while Big Ds is still on defense (T1).
  await changePitcherTo(page, 'Wario')
  console.log('Big Ds pitcher right after change to Wario:', await pitcherName(page))

  // Finish T1 (Mossers batting, Big Ds/Wario pitching).
  await playUntilBatterIn(page, BIGDS, 'B1 (Big Ds batting)')
  console.log('B1 pitcher (should be Mossers, irrelevant here)')

  // Play through B1 until Mossers bat again in T2 -- this is the moment Big Ds
  // retakes the mound, which is exactly when the bug used to revert the pitcher.
  await playUntilBatterIn(page, MOSSERS, 'T2 (Mossers batting, Big Ds pitching again)')

  const finalPitcher = await pitcherName(page)
  console.log('T2 Big Ds pitcher (should be Wario, NOT reverted to Hammer Bro):', finalPitcher)
  await shot(page, '53-t2-pitcher')
  console.log(finalPitcher === 'Wario' ? 'FIX VERIFIED: pitcher held' : `FIX FAILED: pitcher reverted to ${finalPitcher}`)
}
