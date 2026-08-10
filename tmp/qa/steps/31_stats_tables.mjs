import { shot, BASE } from '../browser.mjs'

async function grabTable(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')]
    return tables.map((t) => [...t.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join('|')).join('\n')).join('\n====\n')
  })
}

export default async function (page) {
  await page.goto(`${BASE}/season/stats`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  await page.getByRole('button', { name: 'Characters', exact: true }).click()
  await page.waitForTimeout(2500)
  console.log('=== CHARACTERS BATTING ===')
  console.log(await grabTable(page))
  await page.getByRole('button', { name: 'PITCHING', exact: true }).click()
  await page.waitForTimeout(2500)
  console.log('=== CHARACTERS PITCHING ===')
  console.log(await grabTable(page))
  await shot(page, '31-pitching')
  await page.getByRole('button', { name: 'FIELDING', exact: true }).click()
  await page.waitForTimeout(2500)
  console.log('=== FIELDING ===')
  console.log(await grabTable(page))
  await shot(page, '31-fielding')
}
