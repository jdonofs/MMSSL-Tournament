// Renders the acceptance pipeline's OWN rows in the real app.
//
//   npm run build && npm run preview          # in one terminal
//   npm run test:acceptance                   # writes tmp/tracker-acceptance/pipeline-rows.json
//   node tests/tracker-acceptance-browser.mjs # this file
//
// There is no separately authored browser fixture. Every row served here was
// written by the bridge, the scoring persistence and the postgame ingestion
// during `npm run test:acceptance`; this file only puts them behind the
// Supabase REST endpoints the app already calls, read-only.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.env.SLUGGERS_QA_URL || 'http://127.0.0.1:4173'
const pipeline = JSON.parse(await readFile('tmp/tracker-acceptance/pipeline-rows.json', 'utf8'))
const expected = JSON.parse(await readFile('tests/fixtures/tracker-acceptance-expected.json', 'utf8'))
const tables = pipeline.tables

// The rows must be the finished ones, or this proves nothing about the final
// views.
assert.equal(tables.games[0].status, expected.tournament.game.status)
assert.equal(tables.season_schedule[0].status, expected.season.game.status)

const envText = await readFile('.env', 'utf8')
const configuredSupabaseUrl = envText.match(/^VITE_SUPABASE_URL=(.+)$/m)?.[1]?.trim()
const projectRef = configuredSupabaseUrl ? new URL(configuredSupabaseUrl).hostname.split('.')[0] : 'intercepted'
const authStorageKey = `sb-${projectRef}-auth-token`

// Tables the app asks for that a tracker game never writes. Served empty
// rather than missing, so a 404-shaped response is never mistaken for data.
const EMPTY = [
  'awards', 'season_waivers', 'tournament_trade_proposals', 'tournament_trade_proposal_moves',
  'season_trade_proposals', 'season_trade_proposal_moves', 'odds_calibration_log',
  'tournament_teams', 'season_standings', 'season_playoff_series',
]
for (const name of EMPTY) tables[name] ||= []
tables.players = tables.players.map((player, index) => ({
  ...player,
  auth_user_id: index === 0 ? 'qa-user' : null,
  // The At-Bat editor's correction controls are scorekeeper-only, and the
  // point of rendering that page here is to see them.
  is_commissioner: index === 0 ? true : Boolean(player.is_commissioner),
  team_name: `${player.name} Club`,
}))

function tableName(url) {
  return new URL(url).pathname.match(/\/rest\/v1\/([^/]+)/)?.[1] || null
}

function applyFilters(rows, url) {
  let filtered = [...rows]
  for (const [key, value] of url.searchParams) {
    if (['select', 'order', 'offset', 'limit'].includes(key)) continue
    if (value.startsWith('eq.')) {
      const wanted = decodeURIComponent(value.slice(3))
      filtered = filtered.filter((row) => String(row[key]) === wanted)
    } else if (value.startsWith('in.')) {
      const allowed = decodeURIComponent(value.slice(3)).replace(/^\(|\)$/g, '').split(',')
        .map((entry) => entry.replace(/^"|"$/g, ''))
      filtered = filtered.filter((row) => allowed.includes(String(row[key])))
    }
  }
  const offset = url.searchParams.get('offset')
  const limit = Number(url.searchParams.get('limit'))
  if (offset != null && Number.isFinite(limit)) filtered = filtered.slice(Number(offset), Number(offset) + limit)
  return filtered
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
if (typeof context.routeWebSocket === 'function') {
  await context.routeWebSocket('wss://*.supabase.co/**', (socket) => socket.close())
}
await context.addInitScript(({ storageKey }) => {
  localStorage.setItem(storageKey, JSON.stringify({
    access_token: 'intercepted-token', refresh_token: 'intercepted-refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer',
    user: { id: 'qa-user', email: 'qa@example.test', aud: 'authenticated', role: 'authenticated' },
  }))
  localStorage.setItem('sluggers-selected-tournament', '909')
  localStorage.setItem('sluggers-selected-season', '909')
}, { storageKey: authStorageKey })

await context.route('**/auth/v1/**', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'qa-user' } }),
}))
await context.route('**/rest/v1/**', async (route) => {
  const request = route.request()
  assert.equal(request.method(), 'GET', `the acceptance browser check must stay read-only: ${request.method()} ${request.url()}`)
  const url = new URL(request.url())
  const name = tableName(request.url())
  const rows = applyFilters(tables[name] || [], url)
  const wantsObject = request.headers().accept?.includes('application/vnd.pgrst.object+json')
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` },
    body: JSON.stringify(wantsObject ? (rows[0] || null) : rows),
  })
})

const page = await context.newPage()
page.on('pageerror', (error) => console.error(`PAGE ERROR: ${error.message}`))
page.on('console', (message) => { if (message.type() === 'error') console.error(`BROWSER error: ${message.text()}`) })

// Stats groups by team by default; every check here is about one character's
// line, so the character view is selected first each time.
async function showCharacters() {
  await page.getByRole('button', { name: 'Characters', exact: true }).click()
  await page.waitForTimeout(500)
}

// The batting table's leading columns, in the order the header renders them.
// The site abbreviates a character's colour ("B Pianta"), so rows are found by
// a pattern rather than by the full name.
const BATTING_COLUMNS = ['G', 'PA', 'AB', 'H', '1B', '2B', '3B', 'HR', 'R', 'RBI', 'BB', 'HBP', 'SO', 'SF', 'SH', 'TB']

async function battingRow(match) {
  const row = page.locator('tbody tr:visible').filter({ hasText: match }).first()
  await row.waitFor({ timeout: 15_000 })
  const cells = (await row.innerText()).split(/\s*[\r\n\t]+\s*/).map((cell) => cell.trim()).filter(Boolean)
  const numbers = cells.slice(1, 1 + BATTING_COLUMNS.length)
  return Object.fromEntries(BATTING_COLUMNS.map((column, index) => [column, numbers[index]]))
}

function expectRow(actual, want, label) {
  assert.deepEqual({
    G: actual.G, PA: actual.PA, AB: actual.AB, H: actual.H,
    HR: actual.HR, R: actual.R, RBI: actual.RBI, BB: actual.BB,
    HBP: actual.HBP, SO: actual.SO, TB: actual.TB,
  }, {
    G: String(want.games ?? 1), PA: String(want.pa), AB: String(want.ab), H: String(want.hits),
    HR: String(want.homeRuns ?? 0), R: String(want.runs), RBI: String(want.rbi),
    BB: String(want.walks ?? 0), HBP: String(want.hbp ?? 0), SO: String(want.strikeouts ?? 0),
    TB: String(want.totalBases),
  }, label)
}

try {
  // ── Stats, tournament scope ──────────────────────────────────────────────
  await page.goto(`${baseUrl}/stats`, { waitUntil: 'networkidle' })
  const scopeSelect = page.locator('.stats-rail-scope-select').first()
  if (!await scopeSelect.count()) {
    throw new Error(`Stats controls did not render at ${page.url()}: ${(await page.locator('body').innerText()).slice(0, 2000)}`)
  }
  await scopeSelect.selectOption('tournament-909')
  await showCharacters()
  // Stats opens on Leaders; the batting line lives under Batting > Standard.
  await page.getByRole('button', { name: 'Batting', exact: true }).click()
  const wantTournament = expected.tournament.batting['Blue Pianta']
  expectRow(await battingRow(/B(?:lue)? Pianta/), wantTournament, 'Stats / tournament 909 / Blue Pianta')
  expectRow(await battingRow(/Bowser/), expected.tournament.batting.Bowser, 'Stats / tournament 909 / Bowser')

  // ── Stats, season scope ──────────────────────────────────────────────────
  await scopeSelect.selectOption('season-909')
  await showCharacters()
  const wantSeason = expected.season.batting['Dry Bones']
  expectRow(await battingRow(/^Dry Bones/m), wantSeason, 'Stats / season 909 / Dry Bones')
  expectRow(await battingRow(/G(?:reen)? Toad/), expected.season.batting['Green Toad'], 'Stats / season 909 / Green Toad')
  // The tournament game must not leak into the season scope: Purple Toad only
  // ever batted in the tournament recording.
  assert.equal(await page.locator('tbody tr:visible').filter({ hasText: /P(?:urple)? Toad/ }).count(), 0)

  // The persisted Peach capture contains 17 freeze onsets. The site must show
  // physical incidents separately from Gimmick Luck and let a count reveal a play.
  const capturedFreezes = tables.tracking_plays.reduce((sum, play) => sum
    + (play.quality?.stadium_incidents || []).filter((event) => event.type === 'player_freeze').length, 0)
  assert.equal(capturedFreezes, 17)
  await page.getByRole('button', { name: 'Game Events', exact: true }).click()
  await page.getByRole('button', { name: 'Stadium Interactions', exact: true }).click()
  await page.getByRole('heading', { name: 'Stadium Interactions' }).waitFor()
  const freezeButton = page.getByRole('button', { name: /Show \d+ Frozen records/ }).first()
  await freezeButton.waitFor()
  await freezeButton.click()
  assert.match(await page.locator('.stats-main').innerText(), /season game .*play .*peach_ice_garden/i)
  await page.getByRole('button', { name: 'Mechanics', exact: true }).click()
  await page.getByRole('heading', { name: 'Player Mechanics' }).waitFor()
  assert.ok(await page.locator('.stats-main tbody tr').count() > 0)
  await page.getByRole('button', { name: 'Players', exact: true }).click()
  await page.getByRole('heading', { name: 'Player Mechanics' }).waitFor()
  await showCharacters()
  await page.getByRole('button', { name: 'Batting', exact: true }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.stats-rail-mobile-controls select').first().selectOption('baserunning')
  await page.getByRole('columnheader', { name: 'XBT Opp' }).waitFor()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: 'Batting', exact: true }).click()

  // ── Career: one character, two competitions, two owners ──────────────────
  await scopeSelect.selectOption('all')
  await showCharacters()
  const wantCareer = expected.career['Blue Pianta']
  expectRow(await battingRow(/B(?:lue)? Pianta/), {
    ...wantCareer, homeRuns: 3, walks: 0, hbp: 0, strikeouts: 0,
  }, 'Stats / career / Blue Pianta')

  // ── A character profile, rendered from the same rows ─────────────────────
  const bluePiantaId = tables.characters.find((character) => character.name === 'Blue Pianta').id
  await page.goto(`${baseUrl}/character/${bluePiantaId}/career`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: /B(?:lue)? Pianta/i }).first().waitFor({ timeout: 15_000 })
  const profile = await page.locator('body').innerText()
  assert.match(profile, /Standard Stats/)
  assert.match(profile, /Baserunning/)

  // ── The play the tracker could not score, in the editor ─────────────────
  //
  // Read-only, like everything else here: the route above refuses any non-GET,
  // so this proves the gap is VISIBLE to an operator and carries the evidence
  // the bridge recorded. Making the correction is a write and is covered by
  // the offline suites.
  const unresolved = (tables.tracker_unresolved_plays || [])
    .filter((row) => row.competition_type === 'tournament' && row.status === 'open')
  assert.equal(unresolved.length, 1, 'the pipeline recorded exactly one unresolved play')
  // /tracker-editor/:source/:gameId, not /at-bat/:source/:id -- the latter's
  // parameter is a PLATE APPEARANCE id, and the editor sits on "Loading..."
  // forever when a game id is handed to it.
  await page.goto(`${baseUrl}/tracker-editor/tournament/${tables.games[0].id}`, { waitUntil: 'networkidle' })
  const panel = page.locator('.at-bat-unresolved-panel')
  await panel.waitFor({ timeout: 15_000 })
  const panelText = await panel.innerText()
  assert.match(panelText, /1 play the tracker\s+could not score/)
  assert.match(panelText, new RegExp(unresolved[0].batter_name))
  // The run it heard and could not attribute is the reason this game's run
  // rows are one short of its scoreboard, so it has to be on screen.
  assert.match(panelText, /1 run announced and NOT recorded/)
  assert.match(panelText, /Record the result/)
  // And nothing here fills in an outcome to make the totals agree.
  assert.doesNotMatch(panelText, /resolved/i)

  console.log([
    'OK acceptance pipeline rows rendered in the real app:',
    `  Stats tournament 909  Blue Pianta ${wantTournament.pa} PA / ${wantTournament.hits} H / ${wantTournament.rbi} RBI / ${wantTournament.totalBases} TB`,
    `  Stats season 909      Dry Bones   ${wantSeason.pa} PA / ${wantSeason.hits} H / ${wantSeason.rbi} RBI / ${wantSeason.totalBases} TB`,
    `  Stats career          Blue Pianta ${wantCareer.pa} PA across ${wantCareer.games} games, two competitions`,
    '  CharacterPage         Blue Pianta career profile',
    `  At-Bat editor         1 unresolved play visible (${unresolved[0].batter_name}, `
      + `${unresolved[0].half} ${unresolved[0].inning})`,
  ].join('\n'))
} finally {
  await context.close()
  await browser.close()
}
