// The tracker bridge finishing a recorded game while the work after the final
// row fails -- the real bridge, fed the real session log, against the
// acceptance database -- and the game then finished from the database after
// that bridge has exited.
//
// Before: completeTrackerGameLifecycle logged each failure and returned, so
// finalizeTrackerGame kept a resolved promise and logged "game finalized";
// nothing afterwards knew the W/L/S, stadium log or standings were missing.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after } from 'node:test'

import { buildSeasonStandings } from '../src/utils/competitionStandings.js'
import { auditGameLifecycle, finishGameCompletion } from '../src/utils/gameCompletionLifecycle.js'
import { GAME_ID, buildAcceptanceWorld, repoPath } from './helpers/trackerAcceptanceWorld.mjs'
import { SCORING_TABLES, replayRecording } from './helpers/trackerAcceptanceRun.mjs'
import { cleanupRunDirectories } from './helpers/trackerBridgeReplay.mjs'

after(() => cleanupRunDirectories())

const expected = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'tracker-acceptance-expected.json'), 'utf8'))
const FINALIZATION_SLOT = 4 // pendingTrackerWork(): [..., finalizationPromise]

function settledLedger(world, competitionType) {
  const tables = SCORING_TABLES[competitionType]
  return world.db[tables.ledger]
    .filter((row) => String(row.reason).startsWith('bet_settled:'))
    .map((row) => `${row.bet_id}:${row[tables.ledgerChange]}`)
    .sort()
}

test('tournament: failed W/L/S and stadium log are reported, not cached, and finished after the bridge exits', async () => {
  const world = buildAcceptanceWorld()
  const run = await replayRecording(world, 'tournament', {
    failures: [
      { table: 'pitching_stints', action: 'update', mode: 'before', times: 1_000 },
      { table: 'stadium_game_log', action: 'insert', mode: 'before', times: 1_000 },
    ],
  })
  assert.equal(run.finished, true)
  const game = world.db.games[0]
  assert.deepEqual([game.status, game.team_a_runs, game.team_b_runs], ['complete', expected.tournament.game.teamARuns, expected.tournament.game.teamBRuns])
  assert.equal(world.db.plate_appearances.length, expected.tournament.persisted.plateAppearances)

  const report = run.messages.find((line) => /follow-up step\(s\) did not finish/.test(line))
  assert.ok(report, run.messages.filter((line) => /completion/.test(line)).join('\n'))
  assert.match(report, /pitching decisions/)
  assert.match(report, /stadium game log/)
  assert.match(report, /Finish completion steps/)
  assert.ok(!run.messages.some((line) => /game finalized automatically/.test(line)), 'no success is logged')
  assert.equal(run.bridge.pendingTrackerWork()[FINALIZATION_SLOT], null, 'a failed finalization is not kept as a result')
  // Independent steps still ran: the bets were settled.
  const settledAfterBridge = settledLedger(world, 'tournament')
  assert.ok(settledAfterBridge.length > 0)
  assert.ok(world.db.pitching_stints.every((row) => !row.win && !row.loss && !row.save))

  // The bridge is gone. Recovery reads the database the way a reloaded page does.
  world.failures.length = 0
  const options = { supabase: world, sourceType: 'tournament', gameId: GAME_ID }
  const audit = await auditGameLifecycle(options)
  assert.deepEqual(audit.owed.map((step) => step.key), ['stadiumLog', 'pitching'])
  const finished = await finishGameCompletion(options)
  assert.equal(finished.outcome, 'done', JSON.stringify(finished.failed))

  assert.equal(world.db.stadium_game_log.length, 1)
  assert.equal(world.db.pitching_stints.filter((row) => row.win).length, 1)
  assert.equal(world.db.pitching_stints.filter((row) => row.loss).length, 1)
  assert.deepEqual(settledLedger(world, 'tournament'), settledAfterBridge, 'bets are not paid a second time')
  assert.deepEqual([world.db.games[0].team_a_runs, world.db.games[0].team_b_runs], [expected.tournament.game.teamARuns, expected.tournament.game.teamBRuns])
  assert.equal(world.db.plate_appearances.length, expected.tournament.persisted.plateAppearances)
  assert.deepEqual((await auditGameLifecycle(options)).owed, [])
}, { timeout: 300_000 })

test('season: a failed standings update is reported and finished after the bridge exits', async () => {
  const world = buildAcceptanceWorld()
  const run = await replayRecording(world, 'season', {
    failures: [{ table: 'season_teams', action: 'update', mode: 'before', times: 1_000 }],
  })
  assert.equal(run.finished, true)
  const game = world.db.season_schedule[0]
  assert.deepEqual([game.status, game.away_score, game.home_score], ['completed', expected.season.game.awayScore, expected.season.game.homeScore])
  const report = run.messages.find((line) => /follow-up step\(s\) did not finish/.test(line))
  assert.ok(report)
  assert.match(report, /season standings/)
  assert.equal(run.bridge.pendingTrackerWork()[FINALIZATION_SLOT], null)
  const settledAfterBridge = settledLedger(world, 'season')

  world.failures.length = 0
  const options = { supabase: world, sourceType: 'season', gameId: GAME_ID }
  assert.deepEqual((await auditGameLifecycle(options)).owed.map((step) => step.key), ['competition'])
  assert.equal((await finishGameCompletion(options)).outcome, 'done')

  const standings = buildSeasonStandings(world.db.season_teams, world.db.season_schedule, world.db.season_betting_ledger)
  for (const team of world.db.season_teams) {
    const row = standings.find((entry) => entry.id === team.id)
    assert.deepEqual([team.wins, team.losses], [row.wins, row.losses])
  }
  assert.equal(world.db.season_teams.reduce((sum, team) => sum + team.wins, 0), 1)
  assert.deepEqual(settledLedger(world, 'season'), settledAfterBridge)
  assert.deepEqual((await auditGameLifecycle(options)).owed, [])
}, { timeout: 300_000 })
