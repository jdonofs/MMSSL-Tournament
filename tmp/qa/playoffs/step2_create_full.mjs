import { shot, dumpUI, BASE } from './browser.mjs'

export default async function (page) {
  await page.goto(`${BASE}/season/create`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)

  // Step 1: Setup
  const nameInput = page.locator('input').first()
  await nameInput.fill('')
  await nameInput.fill('QA PLAYOFFS DE')
  // games_per_matchup ("Weeks") input - second input on step1
  const inputs = page.locator('.modal-card input')
  await inputs.nth(1).fill('1') // Weeks = games per matchup
  // playoff format select - double_elimination is default already but set explicitly
  const selects = page.locator('.modal-card select')
  await selects.nth(1).selectOption('double_elimination')
  await shot(page, 'step2-setup-filled')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.waitForTimeout(500)

  // Step 2: Players - select exactly 4 players
  await shot(page, 'step2-players-before')
  const ui = await dumpUI(page)
  console.log('PLAYERS STEP UI:', JSON.stringify(ui, null, 1))
}
