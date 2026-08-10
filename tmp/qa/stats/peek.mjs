import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2221`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await shot(page, 'g1-peek')
  console.log((await page.locator('body').innerText()).slice(0, 1500))
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
