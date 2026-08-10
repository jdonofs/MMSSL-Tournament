import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/stats`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const link = page.getByRole('link', { name: /Green Dry Bones/i }).first()
  if (await link.isVisible().catch(()=>false)) {
    await link.click()
  } else {
    await page.getByText('Green Dry Bones', { exact: false }).first().click()
  }
  await page.waitForTimeout(2000)
  console.log('URL:', page.url())
  console.log((await page.locator('body').innerText()).slice(0, 2000))
  await shot(page, 'char-gdb2')
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
