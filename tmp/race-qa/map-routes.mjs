import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })

const routes = [
  '/season/schedule',
  '/season/draft',
  '/season/roster',
  '/season/bets',
  '/admin',
  '/tournaments',
  '/schedule',
]

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  storageState: path.join(root, 'jason-state.json'),
})
const page = await context.newPage()
page.setDefaultTimeout(10000)
page.on('console', (msg) => msg.type() === 'error' && console.log('[console.error]', msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))

try {
  for (const route of routes) {
    console.log(`\n===== ${route} =====`)
    await page.goto(`http://127.0.0.1:5173${route}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    console.log('URL', page.url())
    console.log('BODY\n' + (await page.locator('body').innerText()).slice(0, 12000))
    console.log('CONTROLS', await page.locator('button, a, input, select').evaluateAll((els) =>
      els.filter((el) => el.offsetParent !== null).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        type: el.getAttribute('type'),
        href: el.getAttribute('href'),
        value: 'value' in el ? el.value : undefined,
        disabled: 'disabled' in el ? el.disabled : undefined,
      }))))
    await page.screenshot({ path: path.join(artifacts, `map-${route.replaceAll('/', '_') || 'root'}.png`), fullPage: true })
  }
} finally {
  await browser.close()
}
