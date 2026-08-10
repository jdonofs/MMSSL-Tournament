import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/season/scorebook?game=2146', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  const scorebook = await page.locator('body').innerText()
  console.log('SCOREBOOK\n', scorebook.slice(-2200))
  await fs.writeFile(path.join(artifacts, 'post-undo-redo-scorebook.txt'), scorebook)
  await page.screenshot({ path: path.join(artifacts, 'post-undo-redo-scorebook.png'), fullPage: true })

  await page.getByRole('button', { name: 'Game View', exact: true }).click()
  await page.waitForTimeout(1000)
  const gameView = await page.locator('body').innerText()
  console.log('GAME VIEW TAIL\n', gameView.slice(-3500))
  await fs.writeFile(path.join(artifacts, 'post-undo-redo-game-view.txt'), gameView)
  await page.screenshot({ path: path.join(artifacts, 'post-undo-redo-game-view.png'), fullPage: true })

  await page.getByRole('button', { name: 'At-Bat Data', exact: true }).click()
  await page.waitForTimeout(700)
  for (let i = 0; i < 20; i += 1) {
    const body = await page.locator('body').innerText()
    const match = body.match(/At-bat (\d+) of (\d+)/)
    if (!match || match[1] === match[2]) break
    await page.getByRole('button', { name: 'Next →', exact: true }).click()
    await page.waitForTimeout(150)
  }
  const lastAtBat = await page.locator('body').innerText()
  console.log('LAST AT-BAT\n', lastAtBat.slice(-4500))
  await fs.writeFile(path.join(artifacts, 'post-undo-redo-last-at-bat.txt'), lastAtBat)
  await page.screenshot({ path: path.join(artifacts, 'post-undo-redo-last-at-bat.png'), fullPage: true })
} finally {
  await browser.close()
}
