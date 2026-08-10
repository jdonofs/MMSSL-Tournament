import { launch, ensureLoggedIn, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2227`, { waitUntil: 'domcontentloaded' })
  const btn = page.getByRole('button', { name: 'Undo', exact: true })
  try {
    await btn.click({ timeout: 3000 })
    console.log('clicked')
  } catch (e) {
    console.log('click failed/timeout:', e.message.slice(0,200))
  }
  await page.waitForTimeout(2500)
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
