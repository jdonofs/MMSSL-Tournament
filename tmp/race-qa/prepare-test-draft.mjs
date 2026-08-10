import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })

try {
  for (const name of ['jason', 'may']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, `${name}-qatest-state.json`) })
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    await page.goto('http://127.0.0.1:5173/season/draft', { waitUntil: 'networkidle' })
    await page.locator('select:visible').first().selectOption({ label: 'TEST' })
    await page.waitForTimeout(3500)
    const body = await page.locator('body').innerText()
    console.log(`\n${name.toUpperCase()} TEST DRAFT\n`, body.slice(0, 6000))
    await fs.writeFile(path.join(artifacts, `${name}-test-draft.txt`), body)
    await page.screenshot({ path: path.join(artifacts, `${name}-test-draft.png`), fullPage: true })
    await context.storageState({ path: path.join(root, `${name}-test-state.json`) })
    await context.close()
  }
} finally {
  await browser.close()
}
