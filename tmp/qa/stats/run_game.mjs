// Generic driver: starts a season game from the schedule (by matchup substring),
// plays through a plan (game1_plan.mjs-style), and ends the game.
import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { openGame, runPa, changePitcherTo, currentBatterName } from '../scorebook.mjs'

export async function startGameFromSchedule(page, stadiumButtonIndex = 0) {
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const setStadiumBtns = page.getByRole('button', { name: /set stadium/i })
  await setStadiumBtns.nth(stadiumButtonIndex).click()
  await page.waitForTimeout(800)
  await page.locator('.modal-backdrop select, .modal-card select').last().selectOption({ label: 'Mario Stadium' })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Start Game', exact: true }).click()
  await page.waitForURL(/scorebook/i, { timeout: 20000 }).catch(() => {})
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2500)
  console.log('Started game, URL:', page.url())
}

export async function playPlan(page, plan, log = console.log) {
  for (const pa of plan) {
    await runPa(page, pa, log)
    if (pa.afterPa?.changePitcher) {
      log(`  changing pitcher -> ${pa.afterPa.changePitcher}`)
      await changePitcherTo(page, pa.afterPa.changePitcher)
    }
  }
}

export async function endGame(page) {
  await page.waitForTimeout(1000)
  const bannerBtn = page.getByRole('button', { name: /mark.*complete|confirm.*final|game over/i }).first()
  const endBtn = page.getByRole('button', { name: 'End Game', exact: true })
  for (let i = 0; i < 5; i++) {
    if (await bannerBtn.isVisible().catch(() => false)) {
      await bannerBtn.click()
      await page.waitForTimeout(1500)
      break
    }
    if (await endBtn.isVisible().catch(() => false)) {
      await endBtn.click()
      await page.waitForTimeout(600)
      const confirmBtn = page.getByRole('button', { name: /confirm/i }).last()
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click()
      await page.waitForTimeout(1500)
      break
    }
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(1500)
  console.log('After end-game, body snippet:', (await page.locator('body').innerText()).slice(0, 400))
}
