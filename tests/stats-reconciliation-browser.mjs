import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.env.SLUGGERS_QA_URL || 'http://127.0.0.1:4173'
const fixture = JSON.parse(await readFile('tests/fixtures/stats-reconciliation-snapshot.json', 'utf8'))
const envText = await readFile('.env', 'utf8')
const configuredSupabaseUrl = envText.match(/^VITE_SUPABASE_URL=(.+)$/m)?.[1]?.trim()
const projectRef = configuredSupabaseUrl ? new URL(configuredSupabaseUrl).hostname.split('.')[0] : 'intercepted'
const authStorageKey = `sb-${projectRef}-auth-token`

const characters = fixture.characters.map((character) => ({
  ...character,
  batting: 5,
  pitching: 5,
  fielding: 5,
  speed: 5,
  slap_contact: 5,
  charge_contact: 5,
  slap_power: 5,
  charge_power: 5,
  bunting: 5,
  run_speed: 5,
  throwing_speed: 5,
  fielding_stat: 5,
  curveball_speed: 5,
  fastball_speed: 5,
  curve: 5,
  stamina: 5,
  character_class: 'Balanced',
}))
const tables = {
  players: fixture.players.map((player, index) => ({ ...player, auth_user_id: index === 0 ? 'qa-user' : null, team_name: `${player.name} Club` })),
  characters,
  games: fixture.games,
  tournaments: [
    { id: 101, tournament_number: 101, status: 'complete', archived: false, created_at: '2026-09-05T12:00:00Z' },
    { id: 102, tournament_number: 102, status: 'complete', archived: true, created_at: '2026-09-05T15:00:00Z' },
  ],
  seasons: [{ id: 201, name: 'Reconciliation Season', status: 'completed', created_at: '2026-09-05T16:00:00Z' }],
  season_teams: fixture.season_teams.map((team) => ({ ...team, team_name: `${team.player_id} Season Club` })),
  season_schedule: fixture.season_schedule,
  plate_appearances: fixture.plate_appearances,
  season_plate_appearances: fixture.season_plate_appearances,
  pitching_stints: fixture.pitching_stints,
  season_pitching_stints: fixture.season_pitching_stints,
  pitches: fixture.pitches,
  season_pitches: fixture.season_pitches,
  runs_scored: fixture.runs_scored,
  season_runs_scored: fixture.season_runs_scored,
  game_fielders: fixture.game_fielders,
  season_game_fielders: fixture.season_game_fielders,
  draft_picks: [
    { id: 1, tournament_id: 101, player_id: 'player-a', character_id: 1, pick_number: 1 },
    { id: 2, tournament_id: 101, player_id: 'player-a', character_id: 2, pick_number: 2 },
    { id: 3, tournament_id: 101, player_id: 'player-a', character_id: 3, pick_number: 3 },
    { id: 4, tournament_id: 101, player_id: 'player-b', character_id: 9, pick_number: 4 },
    { id: 5, tournament_id: 102, player_id: 'player-c', character_id: 10, pick_number: 1 },
    { id: 6, tournament_id: 102, player_id: 'player-c', character_id: 11, pick_number: 2 },
    { id: 7, tournament_id: 102, player_id: 'player-d', character_id: 4, pick_number: 3 },
  ],
  season_roster: [
    { id: 1, season_id: 201, team_id: 301, character_name: 'Red Pianta', is_active: true },
    { id: 2, season_id: 201, team_id: 301, character_name: 'Bowser', is_active: true },
    { id: 3, season_id: 201, team_id: 302, character_name: 'Peach', is_active: true },
  ],
  stadiums: [],
  stadium_game_log: [],
  season_stadium_game_log: [],
  tracking_throws: [],
  runner_opportunities: [],
  double_play_opportunities: [],
  fielding_opportunities: [],
  movement_metrics: [],
  season_betting_ledger: [],
  tournament_trade_proposals: [],
  tournament_trade_proposal_moves: [],
  season_trade_proposals: [],
  season_trade_proposal_moves: [],
  season_waivers: [],
  awards: [],
}

let delayedFramePath = null
let delayedRequestStarted = null

function delayNextResponseForPath(pathname) {
  delayedFramePath = pathname
  return new Promise((resolve) => { delayedRequestStarted = resolve })
}

function tableName(url) {
  return new URL(url).pathname.match(/\/rest\/v1\/([^/]+)/)?.[1] || null
}

function applyFilters(rows, url) {
  let filtered = [...rows]
  for (const [key, value] of url.searchParams) {
    if (['select', 'order', 'offset', 'limit'].includes(key)) continue
    if (value.startsWith('eq.')) {
      const expected = decodeURIComponent(value.slice(3))
      filtered = filtered.filter((row) => String(row[key]) === expected)
    }
  }
  const rangeHeader = url.searchParams.get('offset')
  const limit = Number(url.searchParams.get('limit'))
  if (rangeHeader != null && Number.isFinite(limit)) filtered = filtered.slice(Number(rangeHeader), Number(rangeHeader) + limit)
  return filtered
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
if (typeof context.routeWebSocket === 'function') {
  await context.routeWebSocket('wss://*.supabase.co/**', (socket) => socket.close())
}
await context.addInitScript(({ storageKey }) => {
  const session = {
    access_token: 'intercepted-token', refresh_token: 'intercepted-refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer',
    user: { id: 'qa-user', email: 'qa@example.test', aud: 'authenticated', role: 'authenticated' },
  }
  localStorage.setItem(storageKey, JSON.stringify(session))
  localStorage.setItem('sluggers-selected-tournament', '101')
  localStorage.setItem('sluggers-selected-season', '201')
}, { storageKey: authStorageKey })

await context.route('**/auth/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'qa-user' } }) }))
await context.route('**/rest/v1/**', async (route) => {
  const request = route.request()
  assert.equal(request.method(), 'GET', `browser reconciliation must remain read-only: ${request.method()} ${request.url()}`)
  const requestFramePath = new URL(request.frame().url()).pathname
  if (requestFramePath === delayedFramePath) {
    delayedFramePath = null
    delayedRequestStarted?.()
    delayedRequestStarted = null
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  const url = new URL(request.url())
  const name = tableName(request.url())
  let rows = applyFilters(tables[name] || [], url)
  const wantsObject = request.headers().accept?.includes('application/vnd.pgrst.object+json')
  const body = wantsObject ? (rows[0] || null) : rows
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` },
    body: JSON.stringify(body),
  })
})

const page = await context.newPage()
page.on('pageerror', (error) => console.error(`PAGE ERROR: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') console.error(`BROWSER error: ${message.text()}`)
})
page.on('requestfailed', (request) => console.error(`REQUEST FAILED: ${request.url()} ${request.failure()?.errorText}`))
const spaNavigate = (pathname) => page.evaluate((nextPath) => {
  window.history.pushState({}, '', nextPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}, pathname)
try {
  await page.goto(`${baseUrl}/stats`, { waitUntil: 'networkidle' })
  if (!await page.locator('.stats-rail-scope-select').count()) {
    throw new Error(`Stats controls did not render at ${page.url()}: ${(await page.locator('body').innerText()).slice(0, 2000)}`)
  }
  await page.locator('.stats-rail-scope-select').first().selectOption('tournament-101')
  const alphaRow = page.locator('tbody tr:visible').first()
  try {
    await alphaRow.waitFor({ timeout: 10_000 })
  } catch (error) {
    throw new Error(`Tournament Stats row did not render: ${(await page.locator('body').innerText()).slice(0, 5000)}`, { cause: error })
  }
  const alphaText = await alphaRow.innerText()
  assert.match(alphaText, /11/)
  assert.doesNotMatch(alphaText, /active/i)

  await page.locator('.stats-rail-scope-select').first().selectOption('season-201')
  const charlieRow = page.locator('tbody tr:visible').first()
  await charlieRow.waitFor()
  assert.match(await charlieRow.innerText(), /4/)

  await page.locator('.stats-rail-scope-select').first().selectOption('all')
  await page.getByRole('button', { name: 'Characters', exact: true }).click()
  const redRow = page.locator('tr:visible').filter({ hasText: /R(?:ed)? Pianta/ }).first()
  try {
    await redRow.waitFor({ timeout: 10_000 })
  } catch (error) {
    throw new Error(`Career character Stats row did not render: ${(await page.locator('body').innerText()).slice(0, 5000)}`, { cause: error })
  }
  assert.match(await redRow.innerText(), /6/)

  // Direct profile routes exercise their own hooks rather than Stats' navigation preset.
  await page.goto(`${baseUrl}/character/1/career`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: /R(?:ed)? Pianta/i }).first().waitFor()
  assert.match(await page.locator('body').innerText(), /Standard Stats/)

  // Switch identity and scope while an old request is deliberately held in flight. Its late
  // response must not repaint the current character or competition.
  const delayedCharacterRequest = delayNextResponseForPath('/character/4/season/201')
  await spaNavigate('/character/4/season/201')
  await delayedCharacterRequest
  await spaNavigate('/character/1/season/201')
  await page.waitForTimeout(500)
  await page.getByRole('heading', { name: /R(?:ed)? Pianta/i }).first().waitFor()
  assert.equal(await page.getByRole('heading', { name: /^Bowser$/i }).count(), 0)
  assert.match(await page.locator('body').innerText(), /Reconciliation Season/)

  await page.goto(`${baseUrl}/teams/player-a/tournament/101`, { waitUntil: 'networkidle' })
  const alphaHeading = page.getByRole('heading', { name: /^Club$/i }).first()
  try {
    await alphaHeading.waitFor({ timeout: 10_000 })
  } catch (error) {
    throw new Error(`Tournament team profile did not render: ${(await page.locator('body').innerText()).slice(0, 5000)}`, { cause: error })
  }
  assert.match(await page.locator('body').innerText(), /Standard Stats/)

  const delayedTeamRequest = delayNextResponseForPath('/teams/player-a/tournament/102')
  await spaNavigate('/teams/player-a/tournament/102')
  await delayedTeamRequest
  await spaNavigate('/teams/player-c/season/201')
  await page.waitForTimeout(500)
  await page.getByRole('heading', { name: /^Club$/i }).first().waitFor()
  const seasonTeamBody = await page.locator('body').innerText()
  assert.match(seasonTeamBody, /R(?:ed)? Pianta/)
  assert.match(seasonTeamBody, /Owner: Charlie/)
  assert.doesNotMatch(seasonTeamBody, /Owner: Alpha/)
  console.log('OK intercepted Stats, CharacterPage and TeamPage reconciliation routes')
} finally {
  await context.close()
  await browser.close()
}
