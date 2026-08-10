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
  await page.waitForTimeout(2500)
  console.log('=== CHARACTERS BATTING (with names) ===')
  console.log(await grabTable(page))
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'PITCHING')
    if (!btn) return 'no PITCHING button; buttons: ' + [...document.querySelectorAll('.stats-rail-label-btn')].map((b) => b.textContent.trim()).join(',')
    btn.click()
    return true
  })
  console.log('pitching click:', clicked)
  await page.waitForTimeout(2500)
  console.log('=== PITCHING ===')
  console.log(await grabTable(page))
  await shot(page, '32-pitching')
  const clicked2 = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'FIELDING')
    if (!btn) return 'no FIELDING button'
    btn.click()
    return true
  })
  console.log('fielding click:', clicked2)
  await page.waitForTimeout(2500)
  console.log('=== FIELDING ===')
  console.log(await grabTable(page))
  await shot(page, '32-fielding')
}
