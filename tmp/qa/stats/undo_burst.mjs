import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2222`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const btn = page.getByRole('button', { name: 'Undo', exact: true })
  for (let i = 0; i < 5; i++) {
    await btn.click()
    await page.waitForTimeout(1500)
    console.log(`click ${i+1} done`)
  }
  await shot(page, 'g2-undo-burst')
  console.log((await page.locator('body').innerText()).slice(0,300))
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
