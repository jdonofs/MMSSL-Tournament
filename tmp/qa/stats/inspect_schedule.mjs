import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/schedule`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  console.log((await page.locator('body').innerText()).slice(0, 3000))
  await shot(page, 'schedule-state')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
