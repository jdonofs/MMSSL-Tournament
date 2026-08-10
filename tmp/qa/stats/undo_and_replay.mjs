import { launch, ensureLoggedIn, shot, BASE } from '../browser.mjs'
import { currentBatterName } from '../scorebook.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/scorebook?game=2222`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)

  // Undo 6 times: removes PA25,24,23,22,21,20 (back to right after PA19 Luigi 1B)
  for (let i = 0; i < 6; i++) {
    const before = await currentBatterName(page)
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await page.waitForTimeout(900)
    const after = await currentBatterName(page)
    console.log(`undo ${i + 1}: batter ${before} -> ${after}`)
  }
  await shot(page, 'g2-after-undo')
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 500))
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
