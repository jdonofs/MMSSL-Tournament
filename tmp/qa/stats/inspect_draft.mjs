import { launch, ensureLoggedIn, shot, dumpUI, BASE } from '../browser.mjs'

async function main() {
  const { context, page } = await launch()
  await ensureLoggedIn(page)
  await page.goto(`${BASE}/season/draft`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  console.log('UI:', JSON.stringify(await dumpUI(page), null, 1))
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 1500))
  await shot(page, 'stats-draft-state')
  await context.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
