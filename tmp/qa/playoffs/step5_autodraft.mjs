import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/draft`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  for (let i = 0; i < 6; i++) {
    const captainsBtn = page.getByRole('button', { name: /Auto Draft Captains/i })
    const allBtn = page.getByRole('button', { name: /^Auto Draft$/i })
    if (await captainsBtn.isVisible().catch(() => false)) {
      console.log('click Auto Draft Captains, iter', i)
      await captainsBtn.click()
      await page.waitForTimeout(1500)
    } else if (await allBtn.isVisible().catch(() => false)) {
      console.log('click Auto Draft, iter', i)
      await allBtn.click()
      await page.waitForTimeout(1500)
    } else {
      console.log('no auto draft button visible, iter', i)
      break
    }
    const bodyText = await page.locator('body').innerText()
    if (/picks remain|Draft complete|No picks/.test(bodyText)) {
      console.log('  status hint found')
    }
  }
  await page.waitForTimeout(1000)
  await shot(page, 'step5-after-autodraft')
  console.log('BODY SNIPPET:', (await page.locator('body').innerText()).slice(0, 800))
}
