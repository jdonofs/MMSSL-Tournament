import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2222`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await page.waitForTimeout(1200)
  }
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 300))
  await shot(page, 'g2-after-undo2')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
