import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const base = 'http://127.0.0.1:5173'
const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })

async function loginAndSelect(browser, name, password) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('console', (msg) => msg.type() === 'error' && console.log(`[${name} console.error]`, msg.text()))
  page.on('pageerror', (err) => console.log(`[${name} pageerror]`, err.message))

  await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
  await page.locator('button').filter({ hasText: name }).first().click()
  await page.locator('input[type=password]').fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.includes('/login'))
  await page.waitForTimeout(6000)
  await page.goto(`${base}/season/schedule`, { waitUntil: 'networkidle' })
  const seasonSelect = page.locator('select:visible').first()
  console.log(name, 'season options', await seasonSelect.locator('option').evaluateAll((opts) => opts.map((o) => ({ label: o.textContent.trim(), value: o.value }))))
  await seasonSelect.selectOption({ label: 'QA TEST' })
  await page.waitForTimeout(5000)

  for (const route of ['/season/schedule', '/season/draft', '/season/roster', '/season/bets']) {
    await page.goto(`${base}${route}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)
    const body = await page.locator('body').innerText()
    await fs.writeFile(path.join(artifacts, `${name.toLowerCase()}-${route.replaceAll('/', '_')}.txt`), body)
    await page.screenshot({ path: path.join(artifacts, `${name.toLowerCase()}-${route.replaceAll('/', '_')}.png`), fullPage: true })
    console.log(`\n${name} ${route}\n`, body.slice(0, 5000))
  }

  await context.storageState({ path: path.join(root, `${name.toLowerCase()}-qatest-state.json`) })
  await context.close()
}

const browser = await chromium.launch({ headless: true })
try {
  await loginAndSelect(browser, 'Jason', 'Mossss')
  await loginAndSelect(browser, 'May', 'May')
} finally {
  await browser.close()
}
