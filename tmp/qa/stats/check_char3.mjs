import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/character/40/season/59`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  console.log((await page.locator('body').innerText()).slice(0, 2500))
  await shot(page, 'char-gdb3')
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
