import { shot } from '../browser.mjs'
import { openGame, currentBatterName, pitchCount } from '../scorebook.mjs'

async function readState(page) {
  const text = await page.locator('body').innerText()
  const scoreMatch = text.match(/\bR\n(\d+)\n(\d+)\n(\d+)\n(\d+)\n(\d+)/)
  const inningsMatch = text.match(/IP ([\d.]+)\s+H (\d+)\s+R (\d+)\s+ER (\d+)\s+BB (\d+)\s+K (\d+)\s+P (\d+)/)
  return {
    batter: await currentBatterName(page),
    pitcher: inningsMatch ? { ip: inningsMatch[1], h: +inningsMatch[2], r: +inningsMatch[3], er: +inningsMatch[4], bb: +inningsMatch[5], k: +inningsMatch[6], p: +inningsMatch[7] } : null,
  }
}

export default async function (page) {
  // Reopen the completed game first (Admin -> Reopen), then undo repeatedly
  // on the last few PAs and check the pitcher line / batter pointer for drift.
  await openGame(page)
  const reopenBtn = page.getByRole('button', { name: 'Reopen Game', exact: true })
  if (await reopenBtn.isVisible().catch(() => false)) {
    await reopenBtn.click()
    await page.waitForTimeout(600)
    const confirmBtn = page.getByRole('button', { name: /reopen/i }).last()
    await confirmBtn.click().catch(() => {})
    await page.waitForTimeout(2000)
  }
  await shot(page, '40-reopened')

  const snapshots = []
  for (let i = 0; i < 6; i++) {
    snapshots.push(await readState(page))
    const undoBtn = page.getByRole('button', { name: 'Undo', exact: true })
    if (!(await undoBtn.isEnabled().catch(() => false))) break
    await undoBtn.click()
    await page.waitForTimeout(1500)
  }
  console.log('States walking backward via Undo:')
  snapshots.forEach((s, i) => console.log(i, JSON.stringify(s)))

  // Now redo forward the same number of times and compare we land back exactly
  const redoCount = snapshots.length - 1
  for (let i = 0; i < redoCount; i++) {
    const redoBtn = page.getByRole('button', { name: 'Redo', exact: true })
    if (!(await redoBtn.isEnabled().catch(() => false))) { console.log('Redo disabled early at step', i); break }
    await redoBtn.click()
    await page.waitForTimeout(1500)
  }
  const finalState = await readState(page)
  console.log('Final state after redo-back:', JSON.stringify(finalState))
  console.log('Matches original (index 0)?', JSON.stringify(finalState) === JSON.stringify(snapshots[0]))
  await shot(page, '40-after-redo')
}
