import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/stats`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const text = await page.locator('body').innerText()
  const idx = text.indexOf('Green Dry Bones')
  console.log(text.slice(Math.max(0,idx-100), idx+300))
  await shot(page, 'stats-page')
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
