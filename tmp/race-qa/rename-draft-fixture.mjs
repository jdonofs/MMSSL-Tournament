import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
const seasonName = 'QA RACE DRAFT 2026-08-02'
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-draft-fixture-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)
try {
  await page.goto('http://127.0.0.1:5173/admin', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('textbox').last().fill(seasonName)
  await page.getByRole('button', { name: 'Save Season', exact: true }).click()
  await page.waitForTimeout(5000)
  console.log((await page.locator('body').innerText()).slice(-2500))
  await fs.writeFile(path.join(artifacts, 'draft-fixture-name.txt'), seasonName)
  await context.storageState({ path: path.join(root, 'jason-draft-fixture-state.json') })
} finally {
  await browser.close()
}
