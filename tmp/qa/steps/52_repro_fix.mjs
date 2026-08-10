import { shot, dumpUI, BASE } from '../browser.mjs'
import { openGame, clickPitch, clickResult, clickChain, confirmInPlay, currentBatterName, changePitcherTo } from '../scorebook.mjs'

export default async function (page) {
  await openGame(page, 2145)
  console.log('batter:', await currentBatterName(page))

  // Record one clean PA (leadoff batter grounds out) to get outs on the board.
  await clickResult(page, 'GO')
  await clickChain(page, ['SS', '1B'])
  await confirmInPlay(page)
  console.log('after PA1, batter:', await currentBatterName(page))

  // Grab whichever defensive-team roster avatar is rendered second in the
  // strip (not currently pitching) and change to them.
  const candidates = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.textContent.trim() === 'Pitching')
    if (!headers.length) return []
    const header = headers[0]
    // Defensive roster strip: siblings after the "Pitching" label within the same row container
    const row = header.closest('div')?.parentElement
    if (!row) return []
    return [...row.querySelectorAll('img')].map((i) => i.alt).filter(Boolean)
  })
  console.log('avatar candidates:', JSON.stringify(candidates.slice(0, 20)))

  const pitcherNameMatch = (await page.locator('body').innerText()).match(/PITCHER\n([^\n]+)\n/)
  const currentPitcherName = pitcherNameMatch ? pitcherNameMatch[1].trim() : null
  console.log('current pitcher before change:', currentPitcherName)

  // Pick a defensive-team roster avatar that isn't the current pitcher
  const target = candidates.find((n) => n && n !== currentPitcherName)
  console.log('changing pitcher to:', target)
  await changePitcherTo(page, target)
  await page.waitForTimeout(500)
  let pm = (await page.locator('body').innerText()).match(/PITCHER\n([^\n]+)\n/)
  console.log('pitcher right after change:', pm ? pm[1].trim() : null)

  console.log('waiting 8s for the 5s poll to fire...')
  await page.waitForTimeout(8000)
  pm = (await page.locator('body').innerText()).match(/PITCHER\n([^\n]+)\n/)
  console.log('pitcher after 8s wait (should NOT revert):', pm ? pm[1].trim() : null)
  await shot(page, '52-after-wait')

  console.log('waiting another 8s...')
  await page.waitForTimeout(8000)
  pm = (await page.locator('body').innerText()).match(/PITCHER\n([^\n]+)\n/)
  console.log('pitcher after 16s total:', pm ? pm[1].trim() : null)
}
