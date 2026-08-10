import { shot, BASE } from '../browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/bets`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  // Add first selection: Bompkins run line (-117)
  await page.getByText('-117', { exact: true }).first().click()
  await page.waitForTimeout(600)
  await shot(page, '92-slip-1-added')

  let requestSeen = false
  await page.route('**/rest/v1/rpc/place_season_bets*', async (route) => {
    requestSeen = true
    console.log('  [intercept] place_season_bets RPC seen, delaying 4000ms')
    await new Promise((r) => setTimeout(r, 4000))
    await route.continue()
  })

  const placeBtn = page.getByRole('button', { name: 'Place Bets', exact: true })
  const placeClick = placeBtn.click()

  const start = Date.now()
  while (!requestSeen && Date.now() - start < 3000) await page.waitForTimeout(50)
  console.log('requestSeen after', Date.now() - start, 'ms')
  await page.waitForTimeout(200)

  // Mid-flight: add a second selection from the other live game (Mossers @ Kings moneyline -116)
  const added = await page.evaluate(() => {
    // Find the "Mossers @ Kings" card and click its moneyline (-116) cell
    const cards = [...document.querySelectorAll('div')].filter(d => d.textContent?.includes('Mossers @ Kings'))
    return cards.length
  })
  console.log('mossers cards found:', added)
  // Scroll the board so the Mossers/Kings odds are clickable (slip panel covers bottom)
  await page.evaluate(() => window.scrollTo(0, 0))
  const clicked = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && el.textContent.trim() === 'Mossers @ Kings')
    if (!heading) return 'no heading'
    let card = heading
    for (let i = 0; i < 6 && card; i++) card = card.parentElement
    if (!card) return 'no card ancestor'
    const cell = [...card.querySelectorAll('*')].find(el => el.children.length === 0 && el.textContent.trim() === '-116')
    if (!cell) return 'no -116 cell'
    cell.click()
    return 'clicked'
  })
  console.log('mid-flight add result:', clicked)
  await page.waitForTimeout(400)
  await shot(page, '92-mid-flight-add')
  const midDump = await page.evaluate(() => document.body.innerText.slice(-1200))
  console.log('MID-FLIGHT SLIP STATE:\n', midDump)

  await placeClick
  await page.waitForTimeout(5000)
  await shot(page, '92-after-resolve')
  const finalDump = await page.evaluate(() => document.body.innerText.slice(-1200))
  console.log('FINAL SLIP STATE:\n', finalDump)
}
