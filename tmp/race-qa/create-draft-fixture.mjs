import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const seasonName = `QA RACE DRAFT ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(30000)

try {
  await page.goto('http://127.0.0.1:5173/admin', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Create', exact: true }).first().click()
  await page.getByRole('textbox').last().fill(seasonName)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(300)
  console.log('DRAFT ORDER STEP\n', (await page.locator('body').innerText()).slice(-3500))
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(300)
  console.log('REVIEW STEP\n', (await page.locator('body').innerText()).slice(-3500))
  const createSeason = page.getByRole('button', { name: /create season/i }).last()
  if (await createSeason.count()) await createSeason.click()
  else await page.getByRole('button', { name: 'Create', exact: true }).last().click()
  await page.waitForTimeout(8000)
  const body = await page.locator('body').innerText()
  console.log('CREATED URL', page.url())
  console.log('CREATED BODY\n', body.slice(0, 5000))
  await fs.writeFile(path.join(artifacts, 'draft-fixture-name.txt'), seasonName)
  await fs.writeFile(path.join(artifacts, 'draft-fixture-created.txt'), body)
  await page.screenshot({ path: path.join(artifacts, 'draft-fixture-created.png'), fullPage: true })
  await context.storageState({ path: path.join(root, 'jason-draft-fixture-state.json') })
} finally {
  await browser.close()
}
