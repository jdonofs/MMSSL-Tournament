import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/stats`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.locator('select.nav-season-select').selectOption({ label: 'QA STATS' })
  await page.waitForTimeout(2000)
  const text = await page.locator('body').innerText()
  const idx = text.indexOf('Green Dry Bones')
  console.log('idx', idx)
  console.log(text.slice(Math.max(0,idx-200), idx+400))
  await shot(page, 'stats-page2')
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
