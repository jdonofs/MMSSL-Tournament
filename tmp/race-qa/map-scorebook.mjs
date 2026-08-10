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
page.on('console', (msg) => console.log(`[console.${msg.type()}]`, msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))

try {
  await page.goto('http://127.0.0.1:5173/season/schedule', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const target = page.locator('button').filter({ hasText: 'Kings' }).filter({ hasText: 'Schlongs' }).filter({ hasText: 'Resume Game' }).first()
  console.log('TARGET', await target.innerText())
  await target.click()
  await page.waitForTimeout(5000)
  console.log('URL', page.url())
  const body = await page.locator('body').innerText()
  console.log('BODY\n' + body.slice(0, 15000))
  const controls = await page.locator('button, a, input, select, textarea').evaluateAll((els) => els.filter((el) => el.offsetParent !== null).map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    title: el.getAttribute('title'),
    aria: el.getAttribute('aria-label'),
    disabled: 'disabled' in el ? el.disabled : undefined,
  })))
  console.log('CONTROLS', controls)
  await fs.writeFile(path.join(artifacts, 'scorebook-kings-schlongs-body.txt'), body)
  await fs.writeFile(path.join(artifacts, 'scorebook-kings-schlongs-controls.json'), JSON.stringify(controls, null, 2))
  await page.screenshot({ path: path.join(artifacts, 'scorebook-kings-schlongs.png'), fullPage: true })
} finally {
  await browser.close()
}
