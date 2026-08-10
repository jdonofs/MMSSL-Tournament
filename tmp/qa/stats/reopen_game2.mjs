import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2222`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  console.log('PRE-REOPEN:', (await page.locator('body').innerText()).slice(0, 200))

  const reopenBtn = page.getByRole('button', { name: 'Reopen Game', exact: true })
  await reopenBtn.click()
  await page.waitForTimeout(800)
  const confirmBtn = page.getByRole('button', { name: /confirm|yes|reopen/i }).last()
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click()
  }
  await page.waitForTimeout(2000)
  await shot(page, 'g2-reopened')
  console.log('POST-REOPEN:', (await page.locator('body').innerText()).slice(0, 400))
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
