import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })

async function login(page, name, password) {
  await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  console.log('LOGIN BODY', (await page.locator('body').innerText()).slice(0, 2000))
  await page.locator('button').filter({ hasText: name }).first().click()
  await page.locator('input[type=password]').fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.includes('/login'))
  await page.waitForTimeout(8000)
}

function controls(page) {
  return page.locator('button, a, input, select').evaluateAll((els) =>
    els.filter((el) => el.offsetParent !== null).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      type: el.getAttribute('type'),
      href: el.getAttribute('href'),
      disabled: 'disabled' in el ? el.disabled : undefined,
    })))
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.on('console', (msg) => msg.type() === 'error' && console.log('[console.error]', msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))
page.on('requestfailed', (request) => console.log('[requestfailed]', request.url(), request.failure()?.errorText))

try {
  await login(page, 'Jason', 'Mossss')
  console.log('URL', page.url())
  console.log('BODY\n' + (await page.locator('body').innerText()).slice(0, 15000))
  console.log('CONTROLS', await controls(page))
  await page.screenshot({ path: path.join(artifacts, 'dashboard-jason.png'), fullPage: true })
  await context.storageState({ path: path.join(root, 'jason-state.json') })
} finally {
  await browser.close()
}
