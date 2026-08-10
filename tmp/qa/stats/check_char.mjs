import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/character/Green%20Dry%20Bones`, { waitUntil: 'networkidle' }).catch(()=>{})
  await page.waitForTimeout(2000)
  console.log('URL:', page.url())
  console.log((await page.locator('body').innerText()).slice(0, 1200))
  await shot(page, 'char-gdb')
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
