import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.env.SLUGGERS_QA_URL || 'http://127.0.0.1:4173'
const outputDir = 'tmp/season-playoffs-browser'
const envText = await readFile('.env', 'utf8')
const configuredSupabaseUrl = envText.match(/^VITE_SUPABASE_URL=(.+)$/m)?.[1]?.trim()
const projectRef = configuredSupabaseUrl ? new URL(configuredSupabaseUrl).hostname.split('.')[0] : 'intercepted'
const authStorageKey = `sb-${projectRef}-auth-token`

const season = {
  id: 1,
  name: 'Intercepted Reliability Season',
  status: 'playoffs',
  playoff_format: 'single_elimination',
  games_per_matchup: 1,
  innings: 6,
  mercy_rule: false,
  mercy_rule_differential: 10,
  created_at: '2026-09-05T12:00:00Z',
}
const players = [1, 2, 3, 4].map((id) => ({
  id: `player-${id}`,
  auth_user_id: id === 1 ? 'qa-user' : null,
  name: `Player ${id}`,
  color: ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b'][id - 1],
  scorebook_access: id === 1,
}))
const teams = [1, 2, 3, 4].map((id) => ({
  id,
  season_id: 1,
  player_id: `player-${id}`,
  team_name: `Team ${id}`,
  wins: 4 - id,
  losses: id - 1,
  created_at: `2026-09-0${id}T12:00:00Z`,
}))
const regularGames = [
  [1, 2], [3, 4], [1, 3], [2, 4], [1, 4], [2, 3],
].map(([home, away], index) => ({
  id: index + 1,
  season_id: 1,
  round_number: Math.floor(index / 2) + 1,
  stage: null,
  home_team_id: home,
  away_team_id: away,
  stadium_picker_team_id: home,
  stadium: 'Mario Stadium',
  status: 'completed',
  home_score: 4,
  away_score: 1,
  winner_team_id: home,
  innings: 6,
}))
const playoffGames = [
  { id: 7, season_id: 1, round_number: 4, stage: 'Round 1-1', home_team_id: 1, away_team_id: 4, stadium_picker_team_id: 1, stadium: 'Mario Stadium', status: 'completed', home_score: 4, away_score: 1, winner_team_id: 1, innings: 6 },
  { id: 8, season_id: 1, round_number: 5, stage: 'Round 1-2', home_team_id: 2, away_team_id: 3, stadium_picker_team_id: 2, stadium: 'Peach Garden', status: 'scheduled', home_score: 0, away_score: 0, winner_team_id: null, innings: 6 },
  { id: 9, season_id: 1, round_number: 6, stage: 'Round 2-1', home_team_id: 1, away_team_id: null, stadium_picker_team_id: 1, stadium: 'Bowser Castle', status: 'scheduled', home_score: 0, away_score: 0, winner_team_id: null, innings: 6 },
]
const tables = {
  seasons: [season],
  season_teams: teams,
  season_schedule: [...regularGames, ...playoffGames],
  season_betting_ledger: [],
  players,
  tournaments: [],
  stadiums: [
    { id: 1, name: 'Mario Stadium' },
    { id: 2, name: 'Peach Garden' },
    { id: 3, name: 'Bowser Castle' },
  ],
  season_plate_appearances: [],
  season_tracker_live_stats: [],
}

function tableNameFromUrl(url) {
  const match = new URL(url).pathname.match(/\/rest\/v1\/([^/]+)/)
  return match?.[1] || null
}

async function runViewport(browser, viewport, label) {
  const context = await browser.newContext({ viewport })
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**', (socket) => socket.close())
  }
  await context.addInitScript(({ storageKey }) => {
    const session = {
      access_token: 'intercepted-token',
      refresh_token: 'intercepted-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'qa-user', email: 'qa@example.test', aud: 'authenticated', role: 'authenticated' },
    }
    localStorage.setItem('sluggers_mode', 'season')
    localStorage.setItem('sluggers-selected-season', '1')
    localStorage.setItem(storageKey, JSON.stringify(session))
  }, { storageKey: authStorageKey })

  const mutationRequests = []
  await context.route('**/auth/v1/**', async (route) => {
    const session = {
      access_token: 'intercepted-token',
      refresh_token: 'intercepted-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'qa-user', email: 'qa@example.test', aud: 'authenticated', role: 'authenticated' },
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) })
  })
  await context.route('**/rest/v1/**', async (route) => {
    const request = route.request()
    if (request.method() !== 'GET') mutationRequests.push(`${request.method()} ${request.url()}`)
    const url = new URL(request.url())
    const table = tableNameFromUrl(request.url())
    let rows = tables[table] || []
    if (table === 'players' && url.searchParams.has('auth_user_id')) {
      rows = players[0]
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': Array.isArray(rows) ? `0-${Math.max(0, rows.length - 1)}/${rows.length}` : '0-0/1' },
      body: JSON.stringify(rows),
    })
  })

  const page = await context.newPage()
  await page.goto(`${baseUrl}/season/schedule?view=playoffs`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Intercepted Reliability Season' }).waitFor()
  await page.getByText('Round 2-1', { exact: true }).click()
  await page.getByText('Stadium Setup', { exact: true }).waitFor()
  const startButton = page.getByRole('button', { name: 'Start Game', exact: true })
  await startButton.waitFor()
  assert.equal(await startButton.isDisabled(), true)
  assert.match(await page.locator('.modal-card').innerText(), /Complete Round 1-2 first/)
  assert.ok(await page.getByText('Bowser Castle', { exact: true }).count())
  assert.ok(await page.getByText('TBD', { exact: true }).count())
  const stadiumSelect = page.locator('.modal-card select')
  await stadiumSelect.scrollIntoViewIfNeeded()
  assert.equal(await stadiumSelect.isVisible(), true)
  const scheduleOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(scheduleOverflow <= 1, `${label} schedule has ${scheduleOverflow}px horizontal overflow`)
  await page.screenshot({ path: `${outputDir}/schedule-${label}.png`, fullPage: true })

  await page.goto(`${baseUrl}/season/bracket`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Single Elimination Bracket' }).waitFor()
  assert.ok(await page.getByText('Round 2-1', { exact: true }).count())
  const bracketOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(bracketOverflow <= 1, `${label} bracket has ${bracketOverflow}px horizontal overflow`)
  await page.screenshot({ path: `${outputDir}/bracket-${label}.png`, fullPage: true })

  assert.deepEqual(mutationRequests, [], 'browser QA must not issue production-style writes')
  await context.close()
}

await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  await runViewport(browser, { width: 1440, height: 900 }, 'desktop')
  await runViewport(browser, { width: 390, height: 844 }, 'mobile')
  console.log('OK intercepted desktop/mobile season schedule and bracket views')
} finally {
  await browser.close()
}
