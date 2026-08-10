import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2227`, { waitUntil: 'domcontentloaded' })
  const btn = page.getByRole('button', { name: 'Undo', exact: true })
  await btn.click({ timeout: 3000 })
  console.log('click 1 done')
  await page.waitForTimeout(1200)
  await btn.click({ timeout: 3000 })
  console.log('click 2 done')
  await page.waitForTimeout(2000)
  await shot(page, 'multi-undo-after')
  console.log((await page.locator('body').innerText()).slice(0, 400))
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
