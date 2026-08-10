import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2227`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  console.log((await page.locator('body').innerText()).slice(0, 800))
  await shot(page, 'direct-2227')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
