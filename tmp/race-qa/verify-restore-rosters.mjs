import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })

async function firstTwo(page) {
  const rows = []
  for (const n of [1, 2]) {
    const spot = page.getByRole('button', { name: `Lineup spot ${n}`, exact: true })
    rows.push((await spot.locator('..').innerText()).split('\n').map((x) => x.trim()).filter(Boolean))
  }
  return rows
}

async function swapAndSave(page) {
  await page.getByRole('button', { name: 'Lineup spot 1', exact: true }).click()
  await page.getByRole('button', { name: 'Lineup spot 2', exact: true }).click()
  await page.getByRole('button', { name: 'Save Lineup', exact: true }).click()
  await page.getByText('All changes saved', { exact: true }).waitFor({ timeout: 30000 })
}

const browser = await chromium.launch({ headless: true })
const tournamentContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const seasonContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const tournament = await tournamentContext.newPage()
const season = await seasonContext.newPage()

try {
  await Promise.all([
    tournament.goto('http://127.0.0.1:5173/roster', { waitUntil: 'networkidle' }),
    season.goto('http://127.0.0.1:5173/season/roster', { waitUntil: 'networkidle' }),
  ])
  await Promise.all([tournament.waitForTimeout(1500), season.waitForTimeout(1500)])
  const persisted = { tournament: await firstTwo(tournament), season: await firstTwo(season) }
  console.log('PERSISTED BEFORE RESTORE', persisted)
  await fs.writeFile(path.join(artifacts, 'roster-persisted-before-restore.json'), JSON.stringify(persisted, null, 2))
  await Promise.all([
    tournament.screenshot({ path: path.join(artifacts, 'roster-persisted-tournament.png'), fullPage: true }),
    season.screenshot({ path: path.join(artifacts, 'roster-persisted-season.png'), fullPage: true }),
  ])
  await Promise.all([swapAndSave(tournament), swapAndSave(season)])
  await Promise.all([
    tournament.reload({ waitUntil: 'domcontentloaded' }),
    season.reload({ waitUntil: 'domcontentloaded' }),
  ])
  await Promise.all([tournament.waitForTimeout(3500), season.waitForTimeout(3500)])
  const restored = { tournament: await firstTwo(tournament), season: await firstTwo(season) }
  console.log('RESTORED', restored)
  await fs.writeFile(path.join(artifacts, 'roster-restored.json'), JSON.stringify(restored, null, 2))
} finally {
  await tournamentContext.close()
  await seasonContext.close()
  await browser.close()
}
