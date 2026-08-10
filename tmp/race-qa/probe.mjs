import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const outDir = new URL('./artifacts/', import.meta.url)
await fs.mkdir(outDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.on('console', (msg) => console.log(`[console.${msg.type()}]`, msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))

try {
  await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'networkidle' })
  console.log('URL', page.url())
  console.log('TITLE', await page.title())
  console.log('BODY', (await page.locator('body').innerText()).slice(0, 5000))
  console.log('CONTROLS', await page.locator('button, a, input, select').evaluateAll((els) =>
    els.filter((el) => el.offsetParent !== null).map((el) => ({
      tag: el.tagName,
      text: (el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim(),
      type: el.getAttribute('type'),
      href: el.getAttribute('href'),
      disabled: 'disabled' in el ? el.disabled : undefined,
    }))))
  await page.screenshot({ path: new URL('login.png', outDir).pathname.slice(1), fullPage: true })
} finally {
  await browser.close()
}
