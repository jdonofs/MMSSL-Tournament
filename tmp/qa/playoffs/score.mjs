import { BASE } from './browser.mjs'

export async function openGame(page, gameId) {
  await page.goto(`${BASE}/season/scorebook?game=${gameId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
}

export async function currentBatterName(page) {
  const text = await page.locator('body').innerText()
  const m = text.match(/BATTER\n([^\n]+)\n/)
  return m ? m[1].trim() : null
}

export async function pitchCount(page) {
  const text = await page.locator('body').innerText()
  const m = text.match(/\bP (\d+)\b/)
  return m ? +m[1] : null
}

export async function cancelOpenInPlay(page) {
  for (let i = 0; i < 3; i++) {
    const backVisible = await page.getByRole('button', { name: 'BACK', exact: true }).isVisible().catch(() => false)
    if (!backVisible) return
    await page.getByRole('button', { name: 'BACK', exact: true }).click()
    await page.waitForTimeout(800)
  }
}

export async function clickPitch(page, kind) {
  const before = await pitchCount(page)
  const batterBefore = await currentBatterName(page)
  const btn = page.getByRole('button', { name: kind, exact: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    await btn.click()
    const start = Date.now()
    while (Date.now() - start < 6000) {
      await page.waitForTimeout(250)
      const p = await pitchCount(page)
      const batter = await currentBatterName(page)
      if ((p != null && before != null && p !== before) || batter !== batterBefore) return
    }
  }
  throw new Error(`pitch ${kind} not registered`)
}

// Strikes the current batter out with 3 swinging strikes (1 out, no runs).
export async function strikeoutBatter(page) {
  const batterBefore = await currentBatterName(page)
  await clickPitch(page, 'SWING')
  await clickPitch(page, 'SWING')
  await clickPitch(page, 'SWING')
  const start = Date.now()
  while (Date.now() - start < 8000) {
    const b = await currentBatterName(page)
    if (b !== batterBefore) return
    await page.waitForTimeout(300)
  }
}

// Hits an immediate HR for whoever the current batter is (auto-finalizes, no dests needed).
export async function hitHR(page) {
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.getByRole('button', { name: 'E', exact: true }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: 'HR', exact: true }).click()
  await page.getByRole('button', { name: 'E', exact: true }).waitFor({ state: 'hidden', timeout: 12000 })
  await page.waitForTimeout(700)
}

export async function endGame(page) {
  await page.getByRole('button', { name: 'End Game', exact: true }).click()
  await page.waitForTimeout(500)
  const confirmBtn = page.getByRole('button', { name: /confirm|end game/i }).last()
  await confirmBtn.click()
  await page.waitForTimeout(2500)
}

// Plays a game so that either the away team (top of 1st) or the home team
// (bottom of 1st, after retiring the away side scoreless) wins 1-0.
export async function playQuickWin(page, gameId, winnerSide /* 'away' | 'home' */) {
  await openGame(page, gameId)
  await cancelOpenInPlay(page)
  if (winnerSide === 'away') {
    await hitHR(page)
    await endGame(page)
    return
  }
  // home wins: retire away side 1-2-3, then HR for home leadoff, then end
  await strikeoutBatter(page)
  await strikeoutBatter(page)
  await strikeoutBatter(page)
  await hitHR(page)
  await endGame(page)
}
