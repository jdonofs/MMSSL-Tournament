import { launch, ensureLoggedIn, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/standings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  console.log((await page.locator('body').innerText()).slice(0, 1500))
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
