import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/create`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)

  const nameInput = page.locator('input').first()
  await nameInput.fill('')
  await nameInput.fill('QA PLAYOFFS DE')
  const inputs = page.locator('.modal-card input')
  await inputs.nth(1).fill('1')
  const selects = page.locator('.modal-card select')
  await selects.nth(1).selectOption('double_elimination')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(500)

  // Deselect Justin and Nick -> keep Aidan, Donovan, Jason, May (4 teams)
  await page.getByRole('button', { name: /^Justin/ }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: /^Nick/ }).click()
  await page.waitForTimeout(200)
  await shot(page, 'step3-players-4')

  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(500)
  await shot(page, 'step3-draftorder')
  console.log('DRAFT ORDER STEP:', JSON.stringify(await dumpUI(page), null, 1))

  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(500)
  await shot(page, 'step3-review')
  console.log('REVIEW STEP:', JSON.stringify(await dumpUI(page), null, 1))
  console.log('REVIEW TEXT:', (await page.locator('.modal-card').innerText()).slice(0, 1500))

  await page.getByRole('button', { name: 'Create Season' }).click()
  await page.waitForTimeout(2500)
  await shot(page, 'step3-created')
  console.log('URL after create:', page.url())
}
