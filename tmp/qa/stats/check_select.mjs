import { launch, ensureLoggedIn, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/draft`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const val = await page.locator('select.nav-season-select').inputValue()
  const selectedText = await page.locator('select.nav-season-select option:checked').innerText()
  console.log('selected value/text:', val, selectedText)
  const body = await page.locator('body').innerText()
  console.log(body.slice(0, 2500))
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
