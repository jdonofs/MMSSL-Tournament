// The scorebook's End Game / Reopen hook itself -- the real
// src/features/scorebook/hooks/useGameCompletion.js, loaded through Vite with
// only `supabaseClient` redirected to a fake database -- rendered by React and
// driven through the callbacks the page wires to its buttons.
//
// What these establish that the lifecycle-module suite does not: the hook
// reports a failed follow-up as a failure (the old one toasted "Game complete"
// regardless), a second click while one is running does nothing, and a page
// opened fresh on an already-complete game -- where End Game no longer exists
// -- still has a working recovery control.

import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

import {
  EXPECTED_FLAGS,
  GAME_ID,
  SEASON_BET_CONFIG,
  SEASON_TABLES,
  buildRecoveryWorld,
  flagsById,
} from './game-completion-recovery-fixture.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stub = path.join(repoRoot, 'tests', 'game-completion-hook-supabase.js')

let vite = null
let useGameCompletion = null

before(async () => {
  vite = await createServer({
    configFile: false,
    root: repoRoot,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    plugins: [{
      name: 'game-completion-supabase-stub',
      enforce: 'pre',
      resolveId(source) {
        return /(^|[\\/])supabaseClient(\.js)?$/.test(source.replace(/\?.*$/, '')) ? stub : null
      },
    }],
  })
  useGameCompletion = (await vite.ssrLoadModule('/src/features/scorebook/hooks/useGameCompletion.js')).default
})

after(async () => { await vite?.close() })

const CHARACTERS_BY_ID = { 101: { id: 101, name: 'Mario' }, 102: { id: 102, name: 'Luigi' }, 103: { id: 103, name: 'Peach' }, 104: { id: 104, name: 'Bowser' } }
const PLAYERS_BY_ID = Object.fromEntries(['p-away', 'p-home', 'p-c', 'p-d'].map((id) => [id, { id, name: id.toUpperCase() }]))

// The season game as the scorebook holds it: normalized to player ids and
// the tournament status vocabulary (SeasonGameSessionProvider).
function scorebookGame(status) {
  return { id: GAME_ID, season_id: 7, status, team_a_player_id: 'p-away', team_b_player_id: 'p-home', away_team_id: 1, home_team_id: 2, stadium: 'Peach Ice Garden' }
}

function mountHook(client, { status = 'active' } = {}) {
  globalThis.__GAME_COMPLETION_SUPABASE__ = client
  const page = { toasts: [], games: [scorebookGame(status)], refreshes: 0, settled: 0 }
  let api = null
  const props = {
    betResolutionConfig: SEASON_BET_CONFIG,
    canManageLifecycle: true,
    charactersById: CHARACTERS_BY_ID,
    currentInning: 3,
    gameSession: {
      teamIdByPlayerId: { 'p-away': 1, 'p-home': 2 },
      onLifecycleSettled: async () => { page.settled += 1 },
    },
    isCommissioner: true,
    isGameComplete: status === 'complete',
    isSeasonGame: true,
    playersById: PLAYERS_BY_ID,
    pushToast: (toast) => page.toasts.push(toast),
    refreshGameData: async () => { page.refreshes += 1 },
    regulationInnings: 3,
    scorebookTables: SEASON_TABLES,
    scores: { a: 1, b: 2 },
    selectedGame: scorebookGame(status),
    setGameEndBanner: () => {},
    setGames: (update) => { page.games = typeof update === 'function' ? update(page.games) : update },
    setShowOutsBanner: () => {},
  }
  function Harness() {
    api = useGameCompletion(props)
    return null
  }
  renderToString(React.createElement(Harness))
  return { api, page }
}

const titles = (page, type) => page.toasts.filter((toast) => toast.type === type).map((toast) => toast.title)

test('End Game with a failed pitching write says so, and a fresh page finishes it', async () => {
  const client = buildRecoveryWorld({ failures: [{ table: 'season_pitching_stints', action: 'update', mode: 'before', times: 1 }] })
  const { api, page } = mountHook(client)
  await api.markGameComplete()

  assert.equal(client.db.season_schedule.find((row) => row.id === GAME_ID).status, 'completed')
  assert.equal(page.games[0].status, 'complete')
  assert.deepEqual(titles(page, 'success'), [], 'no unconditional "Game complete"')
  const error = page.toasts.find((toast) => toast.type === 'error')
  assert.match(error.title, /1 completion step\(s\) did not finish/)
  assert.match(error.message, /Pitching decisions \(W\/L\/S\): stint 501/)
  assert.match(error.message, /Finish completion steps/)
  assert.deepEqual(flagsById(client.db.season_pitching_stints)[501], { win: false, loss: false, save: false })
  assert.equal(page.refreshes, 1, 'local stints are reloaded from the database, not patched optimistically')

  // Reload: a new client, a page that opens on a game already complete.
  const reloaded = mountHook(client.restart(), { status: 'complete' })
  const audit = await reloaded.api.lifecycleRecovery.recheck()
  assert.equal(audit.kind, 'completion')
  assert.deepEqual(audit.owed.map((step) => step.key), ['pitching'])
  await reloaded.api.lifecycleRecovery.finish()
  assert.deepEqual(titles(reloaded.page, 'success'), ['Completion steps finished'])
  assert.deepEqual(flagsById(client.db.season_pitching_stints), EXPECTED_FLAGS)
  assert.deepEqual((await reloaded.api.lifecycleRecovery.recheck()).owed, [])
})

test('a thrown settlement error is reported and the standings wait for it', async () => {
  const client = buildRecoveryWorld({ failures: [{ table: 'season_bets', action: 'select', mode: 'throwBefore', times: 1 }] })
  const { api, page } = mountHook(client)
  await api.markGameComplete()
  const error = page.toasts.find((toast) => toast.type === 'error')
  assert.match(error.message, /Bet settlement/)
  assert.match(error.message, /Standings and bracket: waits for bet settlement/)
  assert.deepEqual(titles(page, 'success'), [])
})

test('a second End Game click while the first is running does nothing', async () => {
  const client = buildRecoveryWorld({ failures: [{ table: 'season_schedule', action: 'update', delayMs: 40, times: 1 }] })
  const { api, page } = mountHook(client)
  const first = api.markGameComplete()
  const second = await api.markGameComplete()
  await first
  assert.equal(second, null)
  assert.equal(client.operations.filter((entry) => entry.table === 'season_schedule' && entry.action === 'update'
    && entry.payload?.status === 'completed').length, 1)
  assert.deepEqual(titles(page, 'success'), ['Game complete'])
})

test('Reopen clears a save-only stint and reverses the settlement once', async () => {
  const client = buildRecoveryWorld()
  await mountHook(client).api.markGameComplete()
  assert.deepEqual(flagsById(client.db.season_pitching_stints)[503], { win: false, loss: false, save: true })

  const { api, page } = mountHook(client.restart(), { status: 'complete' })
  await api.reopenCompletedGame()
  assert.deepEqual(titles(page, 'success'), ['Game reopened'])
  assert.equal(client.db.season_schedule.find((row) => row.id === GAME_ID).status, 'in_progress')
  assert.deepEqual(Object.values(flagsById(client.db.season_pitching_stints)), Array(3).fill({ win: false, loss: false, save: false }))
  assert.equal(client.db.season_betting_ledger.filter((row) => row.reason.startsWith('bet_settled:')).length, 0)
  assert.equal(client.db.season_stadium_game_log.length, 0)
  assert.deepEqual((await api.lifecycleRecovery.recheck()).owed, [])
})
