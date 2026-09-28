import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { createServer } from 'vite'

import { atBatEditorFixturePlugin } from './browser/at-bat-editor-fixtures/vitePlugin.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repoRoot, 'tests', 'browser', 'at-bat-editor-fixtures')

const players = [
  { id: 'away', name: 'Away Manager' },
  { id: 'home', name: 'Home Manager' },
  { id: 'season-away', name: 'Season Away' },
  { id: 'season-home', name: 'Season Home' },
]
const characters = [
  { id: 11, name: 'Game A Batter' }, { id: 12, name: 'Game A Pitcher' },
  { id: 21, name: 'Game B Batter' }, { id: 22, name: 'Game B Pitcher' },
  { id: 71, name: 'Tournament Seven Batter' }, { id: 72, name: 'Tournament Seven Pitcher' },
  { id: 81, name: 'Season Seven Batter' }, { id: 82, name: 'Season Seven Pitcher' },
]

function tournamentGame(id) {
  return { id, team_a_player_id: 'away', team_b_player_id: 'home', innings: 3, team_a_runs: 0, team_b_runs: 0 }
}

function pa(id, gameId, characterId, result = 'K') {
  return {
    id, game_id: gameId, pa_number: 1, player_id: gameId === 7 ? 'away' : 'away',
    character_id: characterId, pitcher_id: characterId + 1, pitcher_player_id: 'home',
    result, outs_on_play: result === 'HR' ? 0 : 1, rbi: result === 'HR' ? 1 : 0,
    run_scored: result === 'HR', runner_assignments: [], is_official_ab: true,
  }
}

function pitch(id, paId, number = 1) {
  return { id, pa_id: paId, game_id: paId === 201 ? 2 : paId === 701 ? 7 : 1, pitch_number_pa: number, pitch_number_game: number, result: 'looking' }
}

function baseTables() {
  return {
    games: [tournamentGame(1), tournamentGame(2), tournamentGame(7)],
    plate_appearances: [pa(101, 1, 11), pa(201, 2, 21), pa(701, 7, 71)],
    pitches: [pitch(1001, 101), pitch(2001, 201), { ...pitch(2002, 201, 2), game_id: 2 }, pitch(7001, 701)],
    lineups: [
      { id: 'a1', game_id: 1, player_id: 'away', character_id: 11, batting_order: 1 },
      { id: 'a2', game_id: 1, player_id: 'home', character_id: 12, batting_order: 1 },
      { id: 'b1', game_id: 2, player_id: 'away', character_id: 21, batting_order: 1 },
      { id: 'b2', game_id: 2, player_id: 'home', character_id: 22, batting_order: 1 },
      { id: 't1', game_id: 7, player_id: 'away', character_id: 71, batting_order: 1 },
      { id: 't2', game_id: 7, player_id: 'home', character_id: 72, batting_order: 1 },
    ],
    pitching_stints: [], runs_scored: [], game_fielders: [],
    season_schedule: [{ id: 7, season_id: 5, away_team_id: 501, home_team_id: 502, innings: 3, away_score: 0, home_score: 0 }],
    season_teams: [
      { id: 501, season_id: 5, player_id: 'season-away' },
      { id: 502, season_id: 5, player_id: 'season-home' },
    ],
    season_plate_appearances: [{ ...pa(801, 7, 81), player_id: 'season-away', pitcher_player_id: 'season-home' }],
    season_pitches: [{ id: 8001, pa_id: 801, game_id: 7, pitch_number_pa: 1, pitch_number_game: 1, result: 'looking' }],
    season_lineups: [
      { id: 's1', game_id: 7, player_id: 'season-away', character_id: 81, batting_order: 1 },
      { id: 's2', game_id: 7, player_id: 'season-home', character_id: 82, batting_order: 1 },
    ],
    season_pitching_stints: [], season_runs_scored: [], season_game_fielders: [],
    characters, players, stadiums: [], tracker_unresolved_plays: [],
  }
}

let server
let browser
let baseUrl

test.before(async () => {
  server = await createServer({
    configFile: false,
    root: fixtureRoot,
    logLevel: 'error',
    plugins: [atBatEditorFixturePlugin(), react()],
    server: { port: 0, host: '127.0.0.1', fs: { allow: [repoRoot] } },
    optimizeDeps: { include: [] },
  })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await chromium.launch({ headless: true })
})

test.after(async () => {
  await browser?.close()
  await server?.close()
})

async function openEditor({ target, deferRules = [], failureRules = [], tables = baseTables() } = {}) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((seed) => { window.__EDITOR_SEED__ = seed }, {
    target: target || { source: 'tournament', gameId: 1, paId: null },
    tables, deferRules, failureRules,
  })
  await page.goto(baseUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__EDITOR_DB__ && window.__EDITOR_ACTIONS__)
  return { page, errors }
}

async function pending(page, table) {
  await page.waitForFunction((name) => window.__EDITOR_DB__.pending().some((call) => call.table === name), table)
  return page.evaluate((name) => window.__EDITOR_DB__.pending().filter((call) => call.table === name), table)
}

async function complete(page, call, result) {
  await page.evaluate(({ id, response }) => window.__EDITOR_DB__.complete(id, response), { id: call.id, response: result })
}

async function waitForGame(page, source, gameId) {
  await page.waitForFunction(({ expectedSource, expectedId }) => {
    const editor = document.querySelector('.at-bat-editor-shell')
    return editor?.dataset.competitionSource === expectedSource && editor?.dataset.gameId === String(expectedId)
  }, { expectedSource: source, expectedId: gameId })
}

test('switching A to B keeps B after A finishes and blocks imperative save while B is incomplete', async () => {
  const { page, errors } = await openEditor({ deferRules: [{ table: 'games', gameId: 1 }] })
  const [loadA] = await pending(page, 'games')
  await page.evaluate(() => {
    window.__EDITOR_DB__.defer({ table: 'games', gameId: 2 })
    window.__EDITOR_ACTIONS__.setTarget({ source: 'tournament', gameId: 2, paId: null })
  })
  const loadB = (await pending(page, 'games')).find((call) => call.id !== loadA.id)
  await page.evaluate(() => window.__EDITOR_ACTIONS__.save())
  assert.equal((await page.evaluate(() => window.__EDITOR_DB__.calls())).filter((call) => call.operation !== 'read').length, 0)

  await complete(page, loadB)
  await waitForGame(page, 'tournament', 2)
  assert.equal(await page.locator('.at-bat-pitch-row').count(), 2)
  assert.match(await page.locator('.at-bat-hero-matchup select').first().inputValue(), /21/)
  await complete(page, loadA)
  await page.waitForTimeout(25)

  assert.equal(await page.locator('.at-bat-editor-shell').getAttribute('data-game-id'), '2')
  assert.equal(await page.locator('.at-bat-pitch-row').count(), 2)
  assert.deepEqual(errors, [])
  await page.close()
})

test('colliding numeric IDs cannot cross competition sources', async () => {
  const { page, errors } = await openEditor({
    target: { source: 'tournament', gameId: 7, paId: null },
    deferRules: [{ table: 'games', gameId: 7 }],
  })
  const [tournamentLoad] = await pending(page, 'games')
  await page.evaluate(() => window.__EDITOR_ACTIONS__.setTarget({ source: 'season', gameId: 7, paId: null }))
  await waitForGame(page, 'season', 7)
  assert.equal(await page.locator('.at-bat-hero-matchup select').first().inputValue(), '81')

  await complete(page, tournamentLoad)
  await page.waitForTimeout(25)
  assert.equal(await page.locator('.at-bat-editor-shell').getAttribute('data-competition-source'), 'season')
  assert.equal(await page.locator('.at-bat-hero-matchup select').first().inputValue(), '81')
  assert.deepEqual(errors, [])
  await page.close()
})

test('an older same-game realtime reload cannot replace a newer snapshot', async () => {
  const { page, errors } = await openEditor()
  await waitForGame(page, 'tournament', 1)
  await page.evaluate(() => {
    window.__EDITOR_DB__.defer({ table: 'plate_appearances', gameId: 1 })
    window.__EDITOR_DB__.realtime()
  })
  const [olderReload] = await pending(page, 'plate_appearances')
  await page.evaluate(() => {
    window.__EDITOR_DB__.defer({ table: 'plate_appearances', gameId: 1 })
    window.__EDITOR_DB__.realtime()
  })
  const reloads = await pending(page, 'plate_appearances')
  assert.equal(reloads.length, 2)
  const oldPa = pa(101, 1, 11, 'K')
  const newPa = pa(101, 1, 11, 'HR')
  await page.evaluate((rows) => window.__EDITOR_DB__.replace('pitches', rows), [pitch(1001, 101), pitch(1002, 101, 2)])
  await complete(page, reloads[1], { data: [newPa], error: null })
  await page.waitForFunction(() => document.querySelector('.at-bat-result-summary')?.textContent.includes('Home'))
  assert.equal(await page.locator('.at-bat-pitch-row').count(), 2)

  await page.evaluate((rows) => window.__EDITOR_DB__.replace('pitches', rows), [pitch(1001, 101)])
  await complete(page, olderReload, { data: [oldPa], error: null })
  await page.waitForTimeout(25)
  assert.match(await page.locator('.at-bat-result-summary').innerText(), /Home/)
  assert.equal(await page.locator('.at-bat-pitch-row').count(), 2)
  assert.deepEqual(errors, [])
  await page.close()
})

test('deep-link and required-query failures settle without exposing an editable snapshot', async () => {
  const missing = await openEditor({ target: { source: 'tournament', gameId: null, paId: 9999 } })
  await missing.page.getByTestId('at-bat-load-error').waitFor()
  assert.match(await missing.page.getByTestId('at-bat-load-error').innerText(), /not found/i)
  assert.equal(await missing.page.locator('.at-bat-editor-shell').count(), 0)
  assert.deepEqual(missing.errors, [])
  await missing.page.close()

  const lookupFailure = await openEditor({
    target: { source: 'tournament', gameId: null, paId: 101 },
    failureRules: [{ table: 'plate_appearances', gameId: 101, maybeSingle: true, error: { message: 'lookup unavailable' } }],
  })
  await lookupFailure.page.getByTestId('at-bat-load-error').waitFor()
  assert.match(await lookupFailure.page.getByTestId('at-bat-load-error').innerText(), /lookup unavailable/)
  assert.deepEqual(lookupFailure.errors, [])
  await lookupFailure.page.close()

  const failed = await openEditor({ failureRules: [{ table: 'lineups', gameId: 1, error: { message: 'lineups unavailable' } }] })
  await failed.page.getByTestId('at-bat-load-error').waitFor()
  assert.match(await failed.page.getByTestId('at-bat-load-error').innerText(), /lineups unavailable/)
  await failed.page.evaluate(() => window.__EDITOR_ACTIONS__.save())
  assert.equal((await failed.page.evaluate(() => window.__EDITOR_DB__.calls())).filter((call) => call.operation !== 'read').length, 0)
  assert.deepEqual(failed.errors, [])
  await failed.page.close()
})

test('a deep link selects once, survives reload navigation, and tolerates an unavailable optional table', async () => {
  const tables = baseTables()
  tables.plate_appearances.push({ ...pa(102, 1, 11, 'K'), pa_number: 2 })
  tables.pitches.push({ ...pitch(1002, 102), game_id: 1 })
  const { page, errors } = await openEditor({
    target: { source: 'tournament', gameId: null, paId: 102 },
    tables,
    failureRules: [{ table: 'tracker_unresolved_plays', error: { code: 'PGRST205', message: 'table unavailable' } }],
  })
  await waitForGame(page, 'tournament', 1)
  assert.equal(await page.locator('.at-bat-nav-position strong').innerText(), '2')
  await page.getByRole('button', { name: 'Previous at-bat' }).click()
  assert.equal(await page.locator('.at-bat-nav-position strong').innerText(), '1')
  const priorRequest = Number(await page.locator('.at-bat-editor-shell').getAttribute('data-load-request'))
  await page.evaluate(() => window.__EDITOR_DB__.realtime())
  await page.waitForFunction((request) => Number(document.querySelector('.at-bat-editor-shell')?.dataset.loadRequest) > request, priorRequest)
  assert.equal(await page.locator('.at-bat-nav-position strong').innerText(), '1')
  assert.deepEqual(errors, [])
  await page.close()
})

test('valid tournament and season snapshots still save with matching identities', async () => {
  for (const target of [
    { source: 'tournament', gameId: 1, paId: null, table: 'plate_appearances', paIdExpected: 101 },
    { source: 'season', gameId: 7, paId: null, table: 'season_plate_appearances', paIdExpected: 801 },
  ]) {
    const { page, errors } = await openEditor({ target })
    await waitForGame(page, target.source, target.gameId)
    await page.evaluate(() => window.__EDITOR_ACTIONS__.save())
    await page.waitForFunction(({ table, id }) => window.__EDITOR_DB__.calls().some((call) => (
      call.operation === 'update' && call.table === table && String(call.filters.id) === String(id)
    )), { table: target.table, id: target.paIdExpected })
    const update = (await page.evaluate(() => window.__EDITOR_DB__.calls())).find((call) => (
      call.operation === 'update' && call.table === target.table && String(call.filters.id) === String(target.paIdExpected)
    ))
    assert.equal(Number(update.values.game_id), target.gameId)
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test('unresolved-play correction still writes through the transactional path for both sources', async () => {
  for (const target of [
    { source: 'tournament', gameId: 1, batter: 11, pitcher: 12, batterPlayer: 'away', pitcherPlayer: 'home' },
    { source: 'season', gameId: 7, batter: 81, pitcher: 82, batterPlayer: 'season-away', pitcherPlayer: 'season-home' },
  ]) {
    const tables = baseTables()
    tables.tracker_unresolved_plays = [{
      id: `unresolved-${target.source}`,
      competition_type: target.source,
      game_id: target.gameId,
      status: 'open',
      inning: 1,
      half: 'top',
      preview_pa_number: 1,
      batter_name: 'Fixture Batter',
      batter_character_id: target.batter,
      batter_player_id: target.batterPlayer,
      pitcher_name: 'Fixture Pitcher',
      pitcher_character_id: target.pitcher,
      pitcher_player_id: target.pitcherPlayer,
      tracker_event_key: `fixture:${target.source}`,
      evidence: { outs_before_pa: 0, pitches: [], runners_before: { first: null, second: null, third: null } },
    }]
    const { page, errors } = await openEditor({ target: { ...target, paId: null }, tables })
    await waitForGame(page, target.source, target.gameId)
    await page.getByRole('button', { name: 'Record the result', exact: true }).click()
    await page.getByRole('button', { name: 'K: Strikeout' }).click()
    await page.getByRole('button', { name: /Save at-bat/i }).click()
    await page.waitForFunction(() => window.__EDITOR_DB__.calls().some((call) => call.table === 'rpc:tracker_record_corrected_plate_appearance'))
    const rpc = (await page.evaluate(() => window.__EDITOR_DB__.calls())).find((call) => call.table === 'rpc:tracker_record_corrected_plate_appearance')
    assert.equal(rpc.values.p_competition_type, target.source)
    assert.equal(Number(rpc.values.p_pa.game_id), target.gameId)
    assert.equal(Number(rpc.values.p_pa.character_id), target.batter)
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test('same-page navigation still protects an unsaved draft', async () => {
  const tables = baseTables()
  tables.plate_appearances.push({ ...pa(102, 1, 11, 'K'), pa_number: 2 })
  const { page, errors } = await openEditor({ tables })
  await waitForGame(page, 'tournament', 1)
  await page.getByRole('button', { name: 'HR: Home run' }).click()
  await page.locator('.at-bat-save-bar').getByText('Unsaved changes', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Next at-bat' }).click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.locator('.at-bat-nav-position strong').innerText(), '1')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await page.locator('.at-bat-nav-position strong').innerText(), '1')
  assert.equal(await page.getByRole('button', { name: 'HR: Home run' }).getAttribute('aria-pressed'), 'true')
  assert.deepEqual(errors, [])
  await page.close()
})

test('a stale failure and an unmounted load cannot commit error or loading state', async () => {
  const stale = await openEditor({ deferRules: [{ table: 'games', gameId: 1 }] })
  const [oldLoad] = await pending(stale.page, 'games')
  await stale.page.evaluate(() => window.__EDITOR_ACTIONS__.setTarget({ source: 'tournament', gameId: 2, paId: null }))
  await waitForGame(stale.page, 'tournament', 2)
  await complete(stale.page, oldLoad, { data: null, error: { message: 'late A failure' } })
  await stale.page.waitForTimeout(25)
  assert.equal(await stale.page.getByTestId('at-bat-load-error').count(), 0)
  assert.equal(await stale.page.locator('.at-bat-editor-shell').getAttribute('data-game-id'), '2')
  await stale.page.close()

  const unmounted = await openEditor({ deferRules: [{ table: 'games', gameId: 1 }] })
  const [pendingLoad] = await pending(unmounted.page, 'games')
  await unmounted.page.evaluate(() => window.__EDITOR_ACTIONS__.unmount())
  await unmounted.page.getByTestId('editor-unmounted').waitFor()
  await complete(unmounted.page, pendingLoad)
  await unmounted.page.waitForTimeout(25)
  assert.equal(await unmounted.page.getByTestId('editor-unmounted').innerText(), 'Unmounted')
  assert.deepEqual(unmounted.errors, [])
  await unmounted.page.close()
})
