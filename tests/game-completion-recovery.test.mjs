// Completion and reopen follow-ups, run by the real lifecycle module against a
// fake database that can fail a write before it commits, after it commits, or
// by throwing -- and against a second client over the same rows, which is
// what a page reload or another device is.
//
// Each recovery below is made from a FRESH client (`restart()`), never from
// state the failed pass left in memory.

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSeasonStandings } from '../src/utils/competitionStandings.js'
import {
  auditGameLifecycle,
  finishGameCompletion,
  finishGameReopen,
  writeGameCompletion,
  writeGameReopen,
} from '../src/utils/gameCompletionLifecycle.js'
import { completeSeasonGameLifecycle } from '../src/utils/seasonPlayoffs.js'
import {
  EXPECTED_FLAGS,
  GAME_ID,
  SEASON_BET_CONFIG,
  SEASON_TABLES,
  TOURNAMENT_TABLES,
  balanceByPlayer,
  buildRecoveryWorld,
  flagsById,
  seasonCompletionPatch,
  seasonReopenPatch,
  snapshot,
  tournamentCompletionPatch,
} from './game-completion-recovery-fixture.mjs'

const season = (client, extra = {}) => ({ supabase: client, sourceType: 'season', tables: SEASON_TABLES, gameId: GAME_ID, betConfig: SEASON_BET_CONFIG, ...extra })
const tournament = (client, extra = {}) => ({ supabase: client, sourceType: 'tournament', tables: TOURNAMENT_TABLES, gameId: GAME_ID, ...extra })

const TOURNAMENT_ROWS = ['games', 'tournaments', 'pitching_stints', 'plate_appearances', 'runs_scored', 'stadium_game_log', 'bets', 'points_ledger', 'odds_calibration_log', 'odds_engine_weights']
const SEASON_ROWS = ['seasons', 'season_teams', 'season_schedule', 'season_pitching_stints', 'season_stadium_game_log', 'season_bets', 'season_betting_ledger']

// A season game completed and every follow-up finished: the state each
// recovery below has to converge on.
const SETTLED_SEASON_BALANCES = { 'p-c': 12 + 4, 'p-d': -5 }

function assertSeasonFinished(client) {
  assert.equal(client.db.season_schedule.find((row) => row.id === GAME_ID).status, 'completed')
  assert.deepEqual(flagsById(client.db.season_pitching_stints), EXPECTED_FLAGS)
  assert.equal(client.db.season_stadium_game_log.filter((row) => row.game_id === GAME_ID).length, 1)
  assert.deepEqual(client.db.season_bets.map((row) => [row.id, row.status]), [[1, 'won'], [2, 'lost'], [3, 'won']])
  const settled = client.db.season_betting_ledger.filter((row) => row.reason.startsWith('bet_settled:'))
  assert.deepEqual(settled.map((row) => row.bet_id).sort(), [1, 3], 'one settled row per paid bet, never two')
  assert.deepEqual(balanceByPlayer(client.db.season_betting_ledger, 'dollars_change'), SETTLED_SEASON_BALANCES)
  const standings = buildSeasonStandings(client.db.season_teams, client.db.season_schedule, client.db.season_betting_ledger)
  for (const team of client.db.season_teams) {
    const expected = standings.find((row) => row.id === team.id)
    assert.deepEqual([team.wins, team.losses, team.run_differential], [expected.wins, expected.losses, expected.run_differential], `standings for team ${team.id}`)
  }
  assert.deepEqual([client.db.season_teams[1].wins, client.db.season_teams[0].losses], [1, 1], 'the home team has its win')
}

async function completeSeason(client, scores) {
  const write = await writeGameCompletion({ supabase: client, sourceType: 'season', gameId: GAME_ID, patch: seasonCompletionPatch(scores) })
  assert.equal(write.error, null)
  return write
}

for (const [label, mode] of [['returns { error }', 'before'], ['throws', 'throwBefore']]) {
  test(`a pitching write that ${label} is reported, not credited, and finished after a reload`, async () => {
    const client = buildRecoveryWorld({ failures: [{ table: 'season_pitching_stints', action: 'update', mode, times: 1 }] })
    const tournamentBefore = snapshot(client, TOURNAMENT_ROWS)
    await completeSeason(client)
    const first = await finishGameCompletion(season(client))

    assert.equal(first.outcome, 'incomplete')
    assert.deepEqual(first.failed.map((step) => step.key), ['pitching'])
    assert.match(first.failed[0].message, /stint 501/)
    // Partial: the failed stint is still unflagged in the database, the other
    // two were written. Nothing claims a flag that did not persist.
    const partial = flagsById(client.db.season_pitching_stints)
    assert.deepEqual(partial[501], { win: false, loss: false, save: false })
    assert.deepEqual(partial[502], EXPECTED_FLAGS[502])
    assert.deepEqual(partial[503], EXPECTED_FLAGS[503])

    const reloaded = client.restart()
    const audit = await auditGameLifecycle(season(reloaded))
    assert.equal(audit.kind, 'completion')
    assert.deepEqual(audit.owed.map((step) => step.key), ['pitching'])

    const retry = await finishGameCompletion(season(reloaded))
    assert.equal(retry.outcome, 'done')
    assertSeasonFinished(reloaded)
    assert.deepEqual((await auditGameLifecycle(season(reloaded))).owed, [])
    assert.deepEqual(snapshot(reloaded, TOURNAMENT_ROWS), tournamentBefore, 'tournament game 42 is untouched')
  })
}

test('a failed settlement holds standings back, and a later client settles it exactly once', async () => {
  const client = buildRecoveryWorld({ failures: [{ table: 'season_betting_ledger', action: 'upsert', mode: 'before', times: 1 }] })
  const teamsBefore = snapshot(client, ['season_teams']).season_teams
  await completeSeason(client)
  const first = await finishGameCompletion(season(client))
  assert.equal(first.outcome, 'incomplete')
  assert.deepEqual(first.failed.map((step) => [step.key, Boolean(step.skipped)]), [['bets', false], ['competition', true]])
  // The settlement rolled itself back, so no one was paid and the standings
  // (tie-broken on winnings) waited.
  assert.ok(client.db.season_bets.filter((row) => row.id !== 3).every((row) => row.status === 'open'))
  assert.deepEqual(client.db.season_teams, teamsBefore)

  const reloaded = client.restart()
  assert.deepEqual((await auditGameLifecycle(season(reloaded))).owed.map((step) => step.key), ['bets', 'competition'])
  assert.equal((await finishGameCompletion(season(reloaded))).outcome, 'done')
  assertSeasonFinished(reloaded)
})

test('a ledger write that commits and then reports failure is paid once after retry', async () => {
  const client = buildRecoveryWorld({ failures: [{ table: 'season_betting_ledger', action: 'upsert', mode: 'after', times: 1 }] })
  await completeSeason(client)
  assert.equal((await finishGameCompletion(season(client))).outcome, 'incomplete')
  const reloaded = client.restart()
  assert.equal((await finishGameCompletion(season(reloaded))).outcome, 'done')
  assert.equal((await finishGameCompletion(season(reloaded))).outcome, 'done')
  assertSeasonFinished(reloaded)
})

test('a completion whose response was lost after commit is recognised and finished', async () => {
  const client = buildRecoveryWorld({ failures: [{ table: 'season_schedule', action: 'update', mode: 'after', times: 1 }] })
  const write = await writeGameCompletion({ supabase: client, sourceType: 'season', gameId: GAME_ID, patch: seasonCompletionPatch() })
  assert.equal(write.error, null)
  assert.equal(write.applied, false)
  assert.equal(write.uncertain, true)
  assert.equal(write.game.status, 'completed')
  assert.equal((await finishGameCompletion(season(client.restart()))).outcome, 'done')
  assertSeasonFinished(client)
})

test('a failed standings update is owed after a reload and finished without touching bets again', async () => {
  const client = buildRecoveryWorld({ failures: [{ table: 'season_teams', action: 'update', mode: 'before', times: 1 }] })
  await completeSeason(client)
  const first = await finishGameCompletion(season(client))
  assert.deepEqual(first.failed.map((step) => step.key), ['competition'])
  const reloaded = client.restart()
  const audit = await auditGameLifecycle(season(reloaded))
  assert.deepEqual(audit.owed.map((step) => step.key), ['competition'])
  const ledgerWrites = () => reloaded.operations.filter((entry) => entry.table === 'season_betting_ledger' && entry.action !== 'select').length
  const before = ledgerWrites()
  assert.equal((await finishGameCompletion(season(reloaded))).outcome, 'done')
  assert.equal(ledgerWrites(), before, 'the already-settled ledger is not rewritten')
  assertSeasonFinished(reloaded)
})

test('repeated and concurrent completion converge with no duplicate credit or log', async () => {
  const client = buildRecoveryWorld()
  const other = client.restart()
  const [a, b] = await Promise.all([
    writeGameCompletion({ supabase: client, sourceType: 'season', gameId: GAME_ID, patch: seasonCompletionPatch() }),
    writeGameCompletion({ supabase: other, sourceType: 'season', gameId: GAME_ID, patch: seasonCompletionPatch() }),
  ])
  assert.deepEqual([a.applied, b.applied].sort(), [false, true], 'the status compare-and-set lets exactly one through')
  assert.equal([a, b].find((write) => !write.applied).alreadyComplete, true)

  await Promise.all([finishGameCompletion(season(client)), finishGameCompletion(season(other))])
  await finishGameCompletion(season(client))
  assertSeasonFinished(client)

  // Once converged a further pass changes nothing. (Standings are rewritten
  // with the values they already hold; nothing is inserted or removed.)
  const before = snapshot(client, [...SEASON_ROWS, ...TOURNAMENT_ROWS])
  const operationsBefore = client.operations.length
  const again = await finishGameCompletion(season(client.restart()))
  assert.equal(again.outcome, 'done')
  assert.deepEqual(snapshot(client, [...SEASON_ROWS, ...TOURNAMENT_ROWS]), before)
  const writes = client.operations.slice(operationsBefore).filter((entry) => entry.action !== 'select')
  assert.deepEqual([...new Set(writes.map((entry) => `${entry.action} ${entry.table}`))], ['update season_teams'])
  assert.deepEqual((await auditGameLifecycle(season(client))).owed, [])
})

test('a stale End Game cannot overwrite a newer final score', async () => {
  const client = buildRecoveryWorld()
  await completeSeason(client, { a: 1, b: 2 })
  const stale = await writeGameCompletion({ supabase: client.restart(), sourceType: 'season', gameId: GAME_ID, patch: seasonCompletionPatch({ a: 3, b: 2 }) })
  assert.equal(stale.applied, false)
  assert.equal(stale.alreadyComplete, true)
  const row = client.db.season_schedule.find((entry) => entry.id === GAME_ID)
  assert.deepEqual([row.away_score, row.home_score, row.winner_team_id], [1, 2, 2])
})

test('reopen clears W, L and S -- including a save-only stint -- and reverses the settlement', async () => {
  const client = buildRecoveryWorld()
  const tournamentBefore = snapshot(client, TOURNAMENT_ROWS)
  await completeSeason(client)
  await finishGameCompletion(season(client))
  assert.deepEqual(flagsById(client.db.season_pitching_stints)[503], { win: false, loss: false, save: true })

  const reopen = await writeGameReopen({ supabase: client, sourceType: 'season', gameId: GAME_ID, patch: seasonReopenPatch() })
  assert.equal(reopen.applied, true)
  const result = await finishGameReopen(season(client))
  assert.equal(result.outcome, 'done')
  assert.deepEqual(Object.values(flagsById(client.db.season_pitching_stints)), Array(3).fill({ win: false, loss: false, save: false }))
  assert.equal(client.db.season_stadium_game_log.length, 0)
  assert.ok(client.db.season_bets.every((row) => row.status === 'open'))
  assert.equal(client.db.season_betting_ledger.filter((row) => row.reason.startsWith('bet_settled:')).length, 0)
  assert.deepEqual(balanceByPlayer(client.db.season_betting_ledger, 'dollars_change'), { 'p-c': -14, 'p-d': -5 })
  assert.deepEqual([client.db.season_teams[1].wins, client.db.season_teams[0].losses], [0, 0])
  // Same numeric id, other competition: its W on stint 501 and its rows stay.
  assert.deepEqual(snapshot(client, TOURNAMENT_ROWS), tournamentBefore)
  assert.deepEqual((await auditGameLifecycle(season(client))).owed, [])

  // And completing again credits it all again, once.
  await completeSeason(client)
  assert.equal((await finishGameCompletion(season(client))).outcome, 'done')
  assertSeasonFinished(client)
})

test('a reopen that stops partway is owed after a reload and finished there', async () => {
  const client = buildRecoveryWorld()
  await completeSeason(client)
  await finishGameCompletion(season(client))
  client.failures.push({ table: 'season_bets', action: 'update', mode: 'before', remaining: 1 })
  await writeGameReopen({ supabase: client, sourceType: 'season', gameId: GAME_ID, patch: seasonReopenPatch() })
  const first = await finishGameReopen(season(client))
  assert.equal(first.outcome, 'incomplete')

  const reloaded = client.restart()
  const audit = await auditGameLifecycle(season(reloaded))
  assert.equal(audit.kind, 'reopen')
  assert.deepEqual(audit.owed.map((step) => step.key), ['bets', 'competition'])
  assert.equal((await finishGameReopen(season(reloaded))).outcome, 'done')
  assert.deepEqual((await auditGameLifecycle(season(reloaded))).owed, [])
  assert.equal(reloaded.db.season_betting_ledger.filter((row) => row.reason.startsWith('bet_settled:')).length, 0)
})

test('an in-progress game with a live first-inning settlement is not reported as a leftover', async () => {
  const client = buildRecoveryWorld()
  const audit = await auditGameLifecycle(season(client))
  assert.equal(audit.kind, 'reopen')
  assert.deepEqual(audit.owed, [])
})

test('games of a finished competition are not offered for repair', async () => {
  const client = buildRecoveryWorld()
  // A regular-season game completed long ago with no W/L/S or stadium log,
  // as imported games are.
  client.db.season_schedule[0].status = 'completed'
  client.db.season_schedule[0].winner_team_id = 2
  client.db.seasons[0].status = 'completed'
  assert.deepEqual(await auditGameLifecycle(season(client)), { kind: null, game: client.db.season_schedule[0], owed: [] })
  // The same game while its season is still being played is reported.
  client.db.seasons[0].status = 'active'
  assert.deepEqual((await auditGameLifecycle(season(client))).owed.map((step) => step.key), ['stadiumLog', 'bets', 'pitching', 'competition'])
})

test('standings drift alone on a game in play is not reported as a half-finished reopen', async () => {
  const client = buildRecoveryWorld()
  client.db.season_teams[0].wins = 5
  const audit = await auditGameLifecycle(season(client))
  assert.equal(audit.kind, 'reopen')
  assert.deepEqual(audit.owed, [])
})

test('a completion overtaken by a reopen stops, and the reopen audit finishes the job', async () => {
  // Client A's pass stalls on its first read; client B reopens and rolls the
  // game back in the meantime.
  const client = buildRecoveryWorld({ failures: [{ table: 'season_stadium_game_log', action: 'select', delayMs: 80, times: 1 }] })
  await completeSeason(client)
  const pending = finishGameCompletion(season(client))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const other = client.restart()
  await writeGameReopen({ supabase: other, sourceType: 'season', gameId: GAME_ID, patch: seasonReopenPatch() })
  await finishGameReopen(season(other))
  const stale = await pending
  assert.equal(stale.outcome, 'superseded')
  assert.ok(stale.steps.filter((step) => step.key !== 'stadiumLog').every((step) => step.skipped))
  assert.ok(client.db.season_bets.every((row) => row.status !== 'lost'), 'no bet was graded against a reopened game')

  const audit = await auditGameLifecycle(season(other))
  assert.equal(audit.kind, 'reopen')
  assert.deepEqual(audit.owed.map((step) => step.key), ['stadiumLog'])
  assert.equal((await finishGameReopen(season(other))).outcome, 'done')
  assert.equal(other.db.season_stadium_game_log.length, 0)
  assert.equal(other.db.season_schedule.find((row) => row.id === GAME_ID).status, 'in_progress')
})

test('the season lifecycle refuses to put `completed` back on a reopened game', async () => {
  const client = buildRecoveryWorld()
  const before = snapshot(client, SEASON_ROWS)
  await assert.rejects(
    completeSeasonGameLifecycle({ supabase: client, season: client.db.seasons[0], selectedGame: client.db.season_schedule[0], requirePersistedCompletion: true }),
    (error) => error.code === 'game_not_complete',
  )
  assert.deepEqual(snapshot(client, SEASON_ROWS), before)
})

test('tournament completion: same flow, bracket advanced once, calibration counted once', async () => {
  const client = buildRecoveryWorld({ failures: [{ table: 'games', action: 'insert', mode: 'before', times: 1 }] })
  const seasonBefore = snapshot(client, SEASON_ROWS)
  const write = await writeGameCompletion({ supabase: client, sourceType: 'tournament', gameId: GAME_ID, patch: tournamentCompletionPatch() })
  assert.equal(write.applied, true)
  const first = await finishGameCompletion(tournament(client))
  assert.deepEqual(first.failed.map((step) => step.key), ['competition'])

  const reloaded = client.restart()
  assert.deepEqual((await auditGameLifecycle(tournament(reloaded))).owed.map((step) => step.key), ['competition'])
  assert.equal((await finishGameCompletion(tournament(reloaded))).outcome, 'done')
  assert.equal((await finishGameCompletion(tournament(reloaded))).outcome, 'done')

  const finals = reloaded.db.games.filter((row) => row.stage === 'Round 2-1')
  assert.equal(finals.length, 1, 'one final, however many passes ran')
  assert.deepEqual([finals[0].team_a_player_id, finals[0].team_b_player_id].sort(), ['t2', 't4'])
  assert.deepEqual(flagsById(reloaded.db.pitching_stints), EXPECTED_FLAGS)
  assert.equal(reloaded.db.stadium_game_log.length, 1)
  assert.deepEqual(balanceByPlayer(reloaded.db.points_ledger, 'points_change'), { t2: 18 })
  assert.equal(reloaded.db.odds_engine_weights[0].games_evaluated, 13, 'calibration ran for the one pass that graded bets')
  assert.equal(reloaded.db.odds_calibration_log.length, 1)
  assert.deepEqual(snapshot(reloaded, SEASON_ROWS), seasonBefore, 'season game 42 is untouched')
})
