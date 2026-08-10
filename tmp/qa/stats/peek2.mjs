import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2221`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: 'IN PLAY', exact: true }).click()
  await page.waitForTimeout(1000)
  await shot(page, 'g1-inplay-options')
  const buttons = await page.$$eval('button', els => els.filter(e=>e.offsetParent!==null).map(e=>e.textContent.trim()))
  console.log(JSON.stringify(buttons))
  await context.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
