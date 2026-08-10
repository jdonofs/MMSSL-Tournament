import { shot, BASE } from '../browser.mjs'

async function grabTable(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')]
    return tables.map((t) => [...t.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((c) => {
      const img = c.querySelector('img')
      const alt = img?.alt && !c.innerText.trim() ? img.alt : ''
      return (alt + ' ' + c.innerText).replace(/\s+/g, ' ').trim()
    }).join('|')).join('\n')).join('\n====\n')
  })
}

export default async function (page) {
  await page.goto(`${BASE}/season/stats`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  await page.getByRole('button', { name: 'Characters', exact: true }).click()
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: 'Pitching', exact: true }).click()
  await page.waitForTimeout(2500)
  console.log('=== CHARACTERS PITCHING ===')
  console.log(await grabTable(page))
  await shot(page, '33-pitching')
  await page.getByRole('button', { name: 'Fielding', exact: true }).click()
  await page.waitForTimeout(2500)
  console.log('=== CHARACTERS FIELDING ===')
  console.log(await grabTable(page))
  await shot(page, '33-fielding')
  // Players pitching too
  await page.getByRole('button', { name: 'Players', exact: true }).click()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Pitching', exact: true }).click().catch(async () => {
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'PITCHING')?.click())
  })
  await page.waitForTimeout(2500)
  console.log('=== PLAYERS PITCHING ===')
  console.log(await grabTable(page))
}
