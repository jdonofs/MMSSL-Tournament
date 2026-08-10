import { chromium } from 'playwright'

const SCRATCH = 'C:/Users/jdono/AppData/Local/Temp/claude/c--Users-jdono-Sluggers/203493b3-1d9a-4f2b-8c6c-48a2b4daa8af/scratchpad'
export const BASE = 'http://localhost:5173'
export const SHOTS = `${SCRATCH}/shots`

export async function launch() {
  const context = await chromium.launchPersistentContext(`${SCRATCH}/profile`, {
    headless: true,
    viewport: { width: 1500, height: 1000 },
  })
  const page = context.pages()[0] || (await context.newPage())
  page.setDefaultTimeout(15000)
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 300))
  })
  page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 500)))
  return { context, page }
}

export async function ensureLoggedIn(page, name = 'Jason', password = 'Mossss') {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  if (!page.url().includes('/login')) return
  await page.locator('button').filter({ has: page.getByText(name, { exact: true }) }).first().click()
  await page.locator('input[type="password"]').fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15000 })
  await page.waitForLoadState('networkidle')
}

export async function shot(page, label) {
  const path = `${SHOTS}/${label}.png`
  await page.screenshot({ path, fullPage: false })
  console.log('SHOT:', path)
  return path
}

export async function dumpUI(page, rootSelector = 'body') {
  const items = await page.$$eval(`${rootSelector} button, ${rootSelector} a, ${rootSelector} select, ${rootSelector} input`, (els) =>
    els.filter((el) => el.offsetParent !== null).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      cls: (el.className || '').toString().slice(0, 50),
      disabled: el.disabled || undefined,
    })))
  return items
}
