import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })

async function snapshot(page, label) {
  const body = await page.locator('body').innerText()
  const controls = await page.locator('button, a, input, select, textarea, [role=button]').evaluateAll((els) => els.filter((el) => el.offsetParent !== null).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    type: el.getAttribute('type'),
    role: el.getAttribute('role'),
    title: el.getAttribute('title'),
    disabled: 'disabled' in el ? el.disabled : undefined,
  })))
  console.log(`\n===== ${label} =====\n${body.slice(0, 12000)}\nCONTROLS`, controls)
  await fs.writeFile(path.join(artifacts, `${label}.txt`), `${body}\n\n${JSON.stringify(controls, null, 2)}`)
  await page.screenshot({ path: path.join(artifacts, `${label}.png`), fullPage: true })
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const page = await context.newPage()
page.setDefaultTimeout(20000)

try {
  await page.goto('http://127.0.0.1:5173/season/scorebook?game=2146', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.waitForTimeout(500)
  await snapshot(page, 'scorebook-in-play-modal')
  const cancel = page.getByRole('button', { name: /cancel|close/i }).last()
  if (await cancel.count()) await cancel.click(); else await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Lineups', exact: true }).click()
  await page.waitForTimeout(1000)
  await snapshot(page, 'scorebook-lineups-tab')

  await page.getByRole('button', { name: 'Admin', exact: true }).last().click()
  await page.waitForTimeout(1000)
  await snapshot(page, 'scorebook-admin-tab')
} finally {
  await browser.close()
}
