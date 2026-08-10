import { launch, ensureLoggedIn, BASE } from '../browser.mjs'
async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  // No networkidle wait, no post-load timeout -- click as fast as the DOM allows.
  await page.goto(`${BASE}/season/scorebook?game=2225`, { waitUntil: 'domcontentloaded' })
  const btn = page.getByRole('button', { name: 'Undo', exact: true })
  try {
    await btn.click({ timeout: 3000 })
    console.log('clicked')
  } catch (e) {
    console.log('click failed/timeout:', e.message.slice(0,200))
  }
  await page.waitForTimeout(2500)
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 400))
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
