import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2222`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await shot(page, 'g2-before-click')
  const btn = page.getByRole('button', { name: 'Undo', exact: true })
  await btn.click()
  await page.waitForTimeout(2500)
  await shot(page, 'g2-after-click')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
