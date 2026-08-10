import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tmp/race-qa')
const artifacts = path.join(root, 'artifacts')
await fs.mkdir(artifacts, { recursive: true })

function lineup(body) {
  const match = body.match(/LINEUP\s*\nAuto Lineup\n([\s\S]*?)\nAuto Fielding/)
  if (!match) return []
  const lines = match[1].split('\n').map((x) => x.trim()).filter(Boolean)
  const names = []
  for (let i = 0; i < lines.length; i += 1) if (/^[1-9]$/.test(lines[i]) && lines[i + 1]) names.push(lines[i + 1])
  return names.slice(0, 9)
}

function scoreCard(body) {
  const p = body.match(/PITCHER\s*\n([^\n]+)\n([^\n]+)\nIP ([^\n]+)\nH ([^\n]+)\nR ([^\n]+)\nER ([^\n]+)\nBB ([^\n]+)\nK ([^\n]+)\nP ([^\n]+)/)
  return p ? { pitcher: p[1], ip: p[3], h: p[4], r: p[5], er: p[6], bb: p[7], k: p[8], pitches: Number(p[9]) } : null
}

async function slow3g(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024, connectionType: 'cellular3g' })
}

async function swapFirstTwo(page) {
  await page.getByRole('button', { name: 'Lineup spot 1', exact: true }).click()
  await page.getByRole('button', { name: 'Lineup spot 2', exact: true }).click()
}

async function saveChangedRoster(page) {
  const save = page.locator('button:visible').filter({ hasText: /^Save/ }).filter({ hasNotText: /^Saved$/ }).last()
  if (await save.count()) await save.click()
}

const browser = await chromium.launch({ headless: true })
const tournamentContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const seasonContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const scoreContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: path.join(root, 'jason-qatest-state.json') })
const tournament = await tournamentContext.newPage()
const season = await seasonContext.newPage()
const scorebook = await scoreContext.newPage()
const admin = await adminContext.newPage()
for (const page of [tournament, season, scorebook, admin]) page.setDefaultTimeout(60000)

try {
  await Promise.all([
    tournament.goto('http://127.0.0.1:5173/roster', { waitUntil: 'networkidle' }),
    season.goto('http://127.0.0.1:5173/season/roster', { waitUntil: 'networkidle' }),
    scorebook.goto('http://127.0.0.1:5173/season/scorebook?game=2146', { waitUntil: 'networkidle' }),
    admin.goto('http://127.0.0.1:5173/admin', { waitUntil: 'networkidle' }),
  ])
  await Promise.all([tournament.waitForTimeout(1800), season.waitForTimeout(1800), scorebook.waitForTimeout(1800), admin.waitForTimeout(1800)])
  const before = {
    tournament: lineup(await tournament.locator('body').innerText()),
    season: lineup(await season.locator('body').innerText()),
    scorebook: scoreCard(await scorebook.locator('body').innerText()),
  }
  console.log('BEFORE', before)
  await Promise.all([slow3g(tournament), slow3g(season), slow3g(scorebook)])
  await Promise.all([swapFirstTwo(tournament), swapFirstTwo(season)])
  console.log('AFTER LOCAL SWAPS', {
    tournament: lineup(await tournament.locator('body').innerText()),
    season: lineup(await season.locator('body').innerText()),
    tournamentSaveButtons: await tournament.locator('button:visible').filter({ hasText: /Save/ }).allInnerTexts(),
    seasonSaveButtons: await season.locator('button:visible').filter({ hasText: /Save/ }).allInnerTexts(),
  })

  const started = Date.now()
  await Promise.all([
    saveChangedRoster(tournament),
    saveChangedRoster(season),
    scorebook.getByRole('button', { name: 'BALL', exact: true }).click(),
    admin.getByRole('button', { name: 'Recompute', exact: true }).click(),
  ])
  const confirm = admin.getByRole('button', { name: /confirm|recompute/i }).last()
  if (await confirm.count() && await confirm.isVisible() && await confirm.isEnabled()) await confirm.click()

  const timeline = []
  let last = ''
  for (let i = 0; i < 300; i += 1) {
    const [tb, sb, gb, ab] = await Promise.all([
      tournament.locator('body').innerText(),
      season.locator('body').innerText(),
      scorebook.locator('body').innerText(),
      admin.locator('body').innerText(),
    ])
    const row = {
      ms: Date.now() - started,
      tournament: lineup(tb),
      season: lineup(sb),
      scorebook: scoreCard(gb),
      tournamentStatus: tb.split('\n').filter((x) => /saved|unsaved|saving/i.test(x)).slice(-3),
      seasonStatus: sb.split('\n').filter((x) => /saved|unsaved|saving/i.test(x)).slice(-3),
      adminStatus: ab.split('\n').filter((x) => /recomput|complete|failed/i.test(x)).slice(-6),
    }
    timeline.push(row)
    const key = JSON.stringify(row)
    if (key !== last && (i === 0 || JSON.stringify({ t: row.tournament, s: row.season, g: row.scorebook, ts: row.tournamentStatus, ss: row.seasonStatus, as: row.adminStatus }) !== JSON.stringify({ t: timeline[i - 1]?.tournament, s: timeline[i - 1]?.season, g: timeline[i - 1]?.scorebook, ts: timeline[i - 1]?.tournamentStatus, ss: timeline[i - 1]?.seasonStatus, as: timeline[i - 1]?.adminStatus }))) {
      console.log('CHANGE', row)
      last = key
    }
    if (i === 0 || i === 20 || i === 60 || i === 150 || i === 299) {
      await Promise.all([
        tournament.screenshot({ path: path.join(artifacts, `roster-race-tournament-${i}.png`), fullPage: true }),
        season.screenshot({ path: path.join(artifacts, `roster-race-season-${i}.png`), fullPage: true }),
        scorebook.screenshot({ path: path.join(artifacts, `roster-race-scorebook-${i}.png`), fullPage: true }),
        admin.screenshot({ path: path.join(artifacts, `roster-race-admin-${i}.png`), fullPage: true }),
      ])
    }
    await tournament.waitForTimeout(100)
  }

  await Promise.all([tournament.reload({ waitUntil: 'networkidle' }), season.reload({ waitUntil: 'networkidle' }), scorebook.reload({ waitUntil: 'networkidle' })])
  await Promise.all([tournament.waitForTimeout(1500), season.waitForTimeout(1500), scorebook.waitForTimeout(1500)])
  const persisted = {
    tournament: lineup(await tournament.locator('body').innerText()),
    season: lineup(await season.locator('body').innerText()),
    scorebook: scoreCard(await scorebook.locator('body').innerText()),
  }
  console.log('PERSISTED', persisted)
  await fs.writeFile(path.join(artifacts, 'roster-recompute-timeline.json'), JSON.stringify(timeline, null, 2))
  await fs.writeFile(path.join(artifacts, 'roster-recompute-persisted.json'), JSON.stringify({ before, persisted }, null, 2))

  // Restore both lineup orders after preserving the race evidence.
  await Promise.all([swapFirstTwo(tournament), swapFirstTwo(season)])
  await Promise.all([saveChangedRoster(tournament), saveChangedRoster(season)])
  await Promise.all([tournament.waitForTimeout(4000), season.waitForTimeout(4000)])
  console.log('RESTORED', {
    tournament: lineup(await tournament.locator('body').innerText()),
    season: lineup(await season.locator('body').innerText()),
  })
} finally {
  await tournamentContext.close()
  await seasonContext.close()
  await scoreContext.close()
  await adminContext.close()
  await browser.close()
}
