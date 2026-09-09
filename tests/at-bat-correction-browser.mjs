// The correction workflow, in the real page, actually selected and saved.
//
//   npm run build && npm run preview     # in one terminal
//   node tests/at-bat-correction-browser.mjs
//
// WHY A SECOND BROWSER CHECK. tests/tracker-acceptance-browser.mjs is
// deliberately read-only -- its route handler refuses any non-GET -- so the
// most it can establish about an unresolved play is that the banner is on
// screen. That is exactly the assertion that stayed green while clicking
// "Record the result" opened Bottom 9, the wrong batter, the wrong pitcher, no
// pitches and empty bases.
//
// So this file drives the page: it opens the correction, reads back the context
// the editor put on screen, picks a result, saves, and inspects the write. The
// Supabase endpoints are intercepted and answered from an in-memory world; the
// one write the correction makes is a single RPC, and its payload is the last
// assertion here.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.env.SLUGGERS_QA_URL || 'http://127.0.0.1:4173'

const GAME_ID = 4242
const TOURNAMENT_ID = 909
const AWAY = { id: 'away-gm-0000-0000-0000-000000000001', name: 'Acceptance Knights GM' }
const HOME = { id: 'home-gm-0000-0000-0000-000000000002', name: 'Acceptance Spitballs GM' }
const UNRESOLVED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// Nine on each side. Red Noki bats for the away team; Shy Guy pitches for the
// home team -- the pairing the unresolved play names.
const AWAY_CHARACTERS = ['Red Noki', 'Green Paratroopa', 'Blue Yoshi', 'Luigi', 'Monty Mole',
  'Pink Yoshi', 'Paratroopa', 'Wario', 'Purple Toad']
const HOME_CHARACTERS = ['Blooper', 'Blue Pianta', 'Yellow Magikoopa', 'Red Pianta', 'Brown Kritter',
  'Shy Guy', 'Paragoomba', 'Waluigi', 'Bowser']

const characters = [...AWAY_CHARACTERS, ...HOME_CHARACTERS]
  .map((name, index) => ({ id: 7000 + index, name }))
const characterId = (name) => characters.find((row) => row.name === name).id

// A game played out to the bottom of the ninth with the top of the fifth one
// out short: that missing out is the play the tracker could not score, and it
// is why the slot the editor picks is in the middle of the list rather than
// at the end.
function playedGame() {
  const rows = []
  let paNumber = 1
  for (let half = 0; half < 18; half++) {
    const outs = half === 8 ? 2 : 3
    const batting = half % 2 === 0 ? AWAY : HOME
    const batters = half % 2 === 0 ? AWAY_CHARACTERS : HOME_CHARACTERS
    for (let out = 0; out < outs; out++) {
      rows.push({
        id: paNumber,
        game_id: GAME_ID,
        pa_number: paNumber,
        result: 'GO',
        outs_on_play: 1,
        inning: Math.floor(half / 2) + 1,
        player_id: batting.id,
        character_id: characterId(batters[out % batters.length]),
        pitcher_id: characterId(half % 2 === 0 ? 'Shy Guy' : 'Red Noki'),
        pitcher_player_id: half % 2 === 0 ? HOME.id : AWAY.id,
        runner_assignments: [],
        is_official_ab: true,
        tracker_event_key: `contact:${paNumber}`,
      })
      paNumber += 1
    }
  }
  return rows
}

const plateAppearances = playedGame()

const tables = {
  players: [
    { ...AWAY, auth_user_id: 'qa-user', is_commissioner: true, team_name: 'Knights' },
    { ...HOME, auth_user_id: null, is_commissioner: false, team_name: 'Spitballs' },
  ],
  characters,
  games: [{
    id: GAME_ID, tournament_id: TOURNAMENT_ID, status: 'complete', stats_source: 'tracker',
    team_a_player_id: AWAY.id, team_b_player_id: HOME.id, innings: 9,
    team_a_runs: 0, team_b_runs: 0,
  }],
  tournaments: [{ id: TOURNAMENT_ID, tournament_number: 1, name: 'Acceptance', status: 'active' }],
  lineups: [
    ...AWAY_CHARACTERS.map((name, index) => ({
      id: `a${index}`, game_id: GAME_ID, player_id: AWAY.id, batting_order: index + 1,
      character_id: characterId(name),
    })),
    ...HOME_CHARACTERS.map((name, index) => ({
      id: `h${index}`, game_id: GAME_ID, player_id: HOME.id, batting_order: index + 1,
      character_id: characterId(name),
    })),
  ],
  plate_appearances: plateAppearances,
  pitches: [],
  runs_scored: [],
  pitching_stints: [
    { id: 1, game_id: GAME_ID, player_id: HOME.id, character_id: characterId('Shy Guy'), created_at: '2026-09-08T00:00:00Z' },
    { id: 2, game_id: GAME_ID, player_id: AWAY.id, character_id: characterId('Red Noki'), created_at: '2026-09-08T00:00:00Z' },
  ],
  game_fielders: [],
  stadiums: [],
  seasons: [],
  season_schedule: [],
  season_teams: [],
  tracker_unresolved_plays: [{
    id: UNRESOLVED_ID,
    competition_type: 'tournament',
    game_id: GAME_ID,
    tracker_event_key: 'tracker-pa:red-noki:3',
    tracker_contact_seq: null,
    preview_pa_number: 27,
    inning: 5,
    half: 'top',
    batter_name: 'Red Noki',
    batter_character_id: characterId('Red Noki'),
    batter_player_id: AWAY.id,
    pitcher_name: 'Shy Guy',
    pitcher_character_id: characterId('Shy Guy'),
    pitcher_player_id: HOME.id,
    reason: 'No result could be determined from the tracker log',
    evidence: {
      outs_before_pa: 2,
      pitches: [
        { type: 'fastball', balls_before: 0, strikes_before: 0 },
        { type: 'curveball', balls_before: 1, strikes_before: 0 },
      ],
      runners_before: {
        first: null,
        second: { characterId: characterId('Green Paratroopa'), playerId: AWAY.id },
        third: null,
      },
      observed_runs: [{ scorer: 'Green Paratroopa' }],
    },
    status: 'open',
  }],
}

const EMPTY = [
  'awards', 'season_waivers', 'tournament_trade_proposals', 'tournament_trade_proposal_moves',
  'season_trade_proposals', 'season_trade_proposal_moves', 'odds_calibration_log',
  'tournament_teams', 'season_standings', 'season_playoff_series', 'season_roster',
  'season_plate_appearances', 'season_pitches', 'season_runs_scored', 'season_pitching_stints',
  'season_game_fielders', 'season_lineups', 'draft_picks', 'game_odds', 'bets',
  'runner_opportunities', 'double_play_opportunities', 'tracking_sessions', 'tracking_plays',
  'fielding_opportunities', 'movement_metrics', 'tracking_throws', 'stadium_game_log',
]
for (const name of EMPTY) tables[name] ||= []

const envText = await readFile('.env', 'utf8').catch(() => '')
const configuredSupabaseUrl = envText.match(/^VITE_SUPABASE_URL=(.+)$/m)?.[1]?.trim()
const projectRef = configuredSupabaseUrl ? new URL(configuredSupabaseUrl).hostname.split('.')[0] : 'intercepted'
const authStorageKey = `sb-${projectRef}-auth-token`

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
  return filtered
}

// Every write the page makes, in order. The correction is meant to be exactly
// one of them.
const writes = []

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
if (typeof context.routeWebSocket === 'function') {
  await context.routeWebSocket('wss://*.supabase.co/**', (socket) => socket.close())
}
await context.addInitScript(({ storageKey }) => {
  localStorage.setItem(storageKey, JSON.stringify({
    access_token: 'intercepted-token', refresh_token: 'intercepted-refresh', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer',
    user: { id: 'qa-user', email: 'qa@example.test', aud: 'authenticated', role: 'authenticated' },
  }))
  localStorage.setItem('sluggers-selected-tournament', String(909))
}, { storageKey: authStorageKey })

await context.route('**/auth/v1/**', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'qa-user' } }),
}))

await context.route('**/rest/v1/**', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  const name = tableName(request.url())

  if (name === 'rpc') {
    const fn = url.pathname.split('/').pop()
    const body = JSON.parse(request.postData() || '{}')
    writes.push({ kind: 'rpc', fn, body })
    if (fn === 'tracker_record_corrected_plate_appearance') {
      // The real function inserts at the slot, renumbers what follows, writes
      // the children, and marks the play resolved -- all in one transaction.
      // That behaviour is tested against a real PostgreSQL in
      // tests/tracker-correction-workflow.test.mjs; here it only has to answer
      // in the shape the page reads.
      const slot = Number(body.p_pa_number)
      for (const row of tables.plate_appearances) {
        if (Number(row.pa_number) >= slot) row.pa_number = Number(row.pa_number) + 1
      }
      const saved = {
        ...body.p_pa,
        id: 9001,
        pa_number: slot,
        tracker_event_key: 'tracker-pa:red-noki:3',
        correction_source: 'operator',
      }
      tables.plate_appearances.push(saved)
      tables.tracker_unresolved_plays[0].status = 'resolved'
      tables.tracker_unresolved_plays[0].resolved_pa_id = saved.id
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pa_id: saved.id, pa_number: slot, retried: false, renumbered: 2, pa: saved }),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
  }

  if (request.method() !== 'GET') {
    // The score and pitching-stint recomputations that follow every save. They
    // are derived work and are answered rather than asserted on; what matters
    // is that the SCORING record went through the one call above.
    writes.push({ kind: request.method(), table: name })
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  }

  const rows = applyFilters(tables[name] || [], url)
  const wantsObject = request.headers().accept?.includes('application/vnd.pgrst.object+json')
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` },
    body: JSON.stringify(wantsObject ? (rows[0] || null) : rows),
  })
})

const page = await context.newPage()
page.on('pageerror', (error) => console.error(`PAGE ERROR: ${error.message}`))
page.on('console', (message) => { if (message.type() === 'error') console.error(`BROWSER error: ${message.text()}`) })

try {
  await page.goto(`${baseUrl}/tracker-editor/tournament/${GAME_ID}`, { waitUntil: 'networkidle' })
  const panel = page.locator('.at-bat-unresolved-panel')
  await panel.waitFor({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Record the result', exact: true }).click()
  await page.locator('[data-testid="at-bat-correction-active"]').waitFor({ timeout: 10_000 })

  // ── the context the page opened in ────────────────────────────────────────
  const contextRow = await page.locator('.at-bat-context-row').innerText()
  assert.match(contextRow, /Top 5/, `the correction opened in ${contextRow.replace(/\s+/g, ' ')}`)
  assert.match(contextRow, /2 outs/, 'at the out count the tracker recorded')

  const selected = await page.locator('.at-bat-hero-matchup select').evaluateAll(
    (nodes) => nodes.map((node) => node.options[node.selectedIndex]?.text || ''))
  assert.match(selected[0], /Red Noki/, `the batter reads ${selected[0]}`)
  assert.match(selected[1], /Shy Guy/, `the pitcher reads ${selected[1]}`)

  const bases = await page.locator('.at-bat-base-copy').innerText()
  assert.match(bases, /2nd/, `the runner the tracker saw is on second, not "${bases.replace(/\s+/g, ' ')}"`)

  const pitchRows = await page.locator('.at-bat-pitch-row, [data-testid="at-bat-pitch-row"]').count()
  const pitchArea = await page.locator('body').innerText()
  assert.doesNotMatch(pitchArea, /No pitches yet/, 'the two pitches the tracker saw are carried in')

  const slot = await page.locator('[data-testid="at-bat-correction-slot"]').innerText()
  assert.equal(slot, '#27', `the answer is slotted chronologically, not appended (read ${slot})`)
  assert.equal(await page.locator('[data-testid="at-bat-correction-mismatch"]').count(), 0,
    'and the game\'s own out count agrees with the play, so nothing is flagged')

  // ── select a result and save ──────────────────────────────────────────────
  await page.getByRole('button', { name: '1B: Single' }).first().click()
  await page.getByRole('button', { name: /Save at-bat/i }).first().click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="at-bat-correction-active"]'),
    null, { timeout: 20_000 })

  const rpc = writes.find((write) => write.fn === 'tracker_record_corrected_plate_appearance')
  assert.ok(rpc, `the save did not go through the correction function; writes were ${JSON.stringify(writes)}`)
  assert.equal(rpc.body.p_competition_type, 'tournament')
  assert.equal(rpc.body.p_unresolved_id, UNRESOLVED_ID)
  assert.equal(rpc.body.p_pa.result, '1B')
  assert.equal(Number(rpc.body.p_pa.inning), 5)
  assert.equal(Number(rpc.body.p_pa.character_id), characterId('Red Noki'))
  assert.equal(Number(rpc.body.p_pa.pitcher_id), characterId('Shy Guy'))
  assert.equal(rpc.body.p_pa.runner_on_second_before, true)
  assert.equal(Number(rpc.body.p_pa_number), 27)
  assert.equal(rpc.body.p_pitches.length, 2, 'the pitches the tracker saw are saved with the answer')

  // One scoring write, not four: the plate appearance, its children and the
  // closing of the gap are one transaction now.
  const scoringWrites = writes.filter((write) => (
    write.kind === 'rpc' || ['plate_appearances', 'pitches', 'runs_scored', 'tracker_unresolved_plays']
      .includes(write.table)
  ))
  assert.deepEqual(scoringWrites.map((write) => write.fn || write.table),
    ['tracker_record_corrected_plate_appearance'])

  console.log([
    'OK the At-Bat editor answered an unresolved play in the real page:',
    `  opened  ${contextRow.replace(/\s+/g, ' ')} — ${selected[0]} vs ${selected[1]}`,
    `  bases   ${bases.replace(/\s+/g, ' ')} (${pitchRows} pitch rows carried in)`,
    `  saved   1B at at-bat ${slot}, in one transactional call`,
  ].join('\n'))
} finally {
  await context.close()
  await browser.close()
}
