import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireTrackerGameLock, drainTrackerWork, insertRowsReconciled, rowsMatchPayload } from '../scripts/tracker_persistence.mjs'
import { createTrackerScoringPersistence } from '../scripts/tracker_scoring_persistence.mjs'
import { recomputeTrackerPitchingStats } from '../scripts/tracker_pitching_persistence.mjs'
import { resolveTrackerGameTarget } from '../scripts/tracker_game_target.mjs'
import { createTrackerFakeSupabase } from './helpers/trackerFakeSupabase.mjs'

const TABLES = {
  plateAppearances: 'plate_appearances', pitches: 'pitches', runsScored: 'runs_scored',
}

test('read-back accepts Postgres timestamp and JSONB normalization', () => {
  assert.equal(rowsMatchPayload({
    recorded_utc: '2026-09-18T15:14:12+00:00',
    updated_at: '2026-09-18T18:14:03.960+00:00',
    quality: { b: 2, a: { y: true, x: 1 } },
  }, {
    recorded_utc: '2026-09-18T15:14:12.000Z',
    updated_at: '2026-09-18T18:14:03.960Z',
    quality: { a: { x: 1, y: true }, b: 2 },
  }), true)
  assert.equal(rowsMatchPayload({ quality: { b: 3 } }, { quality: { b: 2 } }), false)
  assert.equal(rowsMatchPayload({ position_depth_ft: 14.1235 },
    { position_depth_ft: 14.123456 }, ['position_depth_ft'], 'fielding_opportunities'), true)
  assert.equal(rowsMatchPayload({ end_x: -1.2345 },
    { end_x: -1.23445 }, ['end_x'], 'fielding_opportunities'), true)
  assert.equal(rowsMatchPayload({ expected_out_probability: 0.123456 },
    { expected_out_probability: 0.123476 }, ['expected_out_probability'], 'fielding_opportunities'), false)
})

test('a resumed ingest accepts a play the recompute priced after it was written', () => {
  const facts = { park: 'peach_ice_garden', observed: 'not_caught', primary_fielder: 'RF' }
  const priced = { quality: { stadium_runs: { ...facts, price: { runs: 2.2 } } } }
  assert.equal(rowsMatchPayload(priced, { quality: { stadium_runs: facts } },
    ['quality'], 'tracking_plays'), true)
  // The facts themselves still have to agree.
  assert.equal(rowsMatchPayload(priced, { quality: { stadium_runs: { ...facts, observed: 'caught' } } },
    ['quality'], 'tracking_plays'), false)
})

test('target selection validates explicit games and refuses ambiguous automatic targets', async () => {
  const client = createTrackerFakeSupabase({
    games: [{ id: 1, stats_source: 'tracker', status: 'active' }],
    season_schedule: [{ id: 2, stats_source: 'tracker', status: 'scheduled', season_id: 7 }],
  })
  const explicit = await resolveTrackerGameTarget(client, { gameId: 2 })
  assert.equal(explicit.source.gamesTable, 'season_schedule')
  await assert.rejects(resolveTrackerGameTarget(client), /Multiple games are in Tracker mode/)

  client.db.games[0].stats_source = 'manual'
  await assert.rejects(resolveTrackerGameTarget(client, { gameId: 1 }), /not set to stats_source='tracker'/)
  client.db.games[0].stats_source = 'tracker'
  client.db.games[0].status = 'complete'
  await assert.rejects(resolveTrackerGameTarget(client, { gameId: 1 }), /not open for tracker writes/)
})

test('an id both tables hold needs a table, and the table is honoured', async () => {
  // `games` and `season_schedule` number their rows independently. Resolving a
  // shared id by search order made this bridge, the lineup exporter and the
  // launcher able to disagree about which game was being played, each of them
  // looking like it worked.
  const client = createTrackerFakeSupabase({
    games: [{ id: 12, stats_source: 'tracker', status: 'active', tournament_id: 3 }],
    season_schedule: [{ id: 12, stats_source: 'tracker', status: 'scheduled', season_id: 71 }],
  })
  await assert.rejects(
    resolveTrackerGameTarget(client, { gameId: 12 }),
    /exists in both games and season_schedule.*TRACKER_GAME_TABLE/s,
  )
  const season = await resolveTrackerGameTarget(client, { gameId: 12, gamesTable: 'season_schedule' })
  assert.equal(season.source.gamesTable, 'season_schedule')
  assert.equal(season.row.season_id, 71)
  const tournament = await resolveTrackerGameTarget(client, { gameId: 12, gamesTable: 'games' })
  assert.equal(tournament.row.tournament_id, 3)

  // A pinned table also narrows the automatic search, so two games in tracker
  // mode in different tables is no longer ambiguous once one is named.
  const auto = await resolveTrackerGameTarget(client, { gamesTable: 'games' })
  assert.equal(auto.source.gamesTable, 'games')
  await assert.rejects(
    resolveTrackerGameTarget(client, { gamesTable: 'nowhere' }),
    /Unknown games table "nowhere"/,
  )
})

function event(overrides = {}) {
  return {
    eventKey: 'contact:401',
    pa: {
      player_id: 'batter-owner', character_id: 31,
      pitcher_id: 2, pitcher_player_id: 'pitcher-owner',
      inning: 1, result: '1B', tracker_contact_seq: 401,
    },
    pitches: [
      { pitch_number_pa: 1, pitch_number_game: 1, result: 'strike' },
      { pitch_number_pa: 2, pitch_number_game: 2, result: 'in_play' },
    ],
    runs: [{ scoring_player_id: 'runner-owner', scoring_character_id: 9, is_earned_run: true }],
    ...overrides,
  }
}

function store(client, journalPath, competitionType = 'tournament') {
  const tables = competitionType === 'season'
    ? { plateAppearances: 'season_plate_appearances', pitches: 'season_pitches', runsScored: 'season_runs_scored' }
    : TABLES
  return createTrackerScoringPersistence({
    supabase: client, tables, competitionType, seasonId: competitionType === 'season' ? 7 : null,
    gameId: 12, journalPath,
  })
}

test('PA commit survives pitch failure and process restart without duplication', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-score-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const journal = path.join(dir, 'game.json')
  const first = createTrackerFakeSupabase({}, {
    failures: [{ table: 'pitches', action: 'insert', mode: 'before', times: 3 }],
  })
  await assert.rejects(store(first, journal).persistEvent(event()), (error) => error.message === 'failure before write')
  assert.equal(first.db.plate_appearances.length, 1)
  assert.equal(first.db.pitches.length, 0)

  const restarted = first.restart()
  await store(restarted, journal).recoverPending()
  assert.equal(restarted.db.plate_appearances.length, 1)
  assert.equal(restarted.db.pitches.length, 2)
  assert.equal(restarted.db.runs_scored.length, 1)
})

test('PA and pitches survive a run failure and resume at the missing stage', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-runs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const journal = path.join(dir, 'game.json')
  const first = createTrackerFakeSupabase({}, {
    failures: [{ table: 'runs_scored', action: 'insert', mode: 'before', times: 3 }],
  })
  await assert.rejects(store(first, journal).persistEvent(event()), (error) => error.message === 'failure before write')
  assert.equal(first.db.pitches.length, 2)
  await store(first.restart(), journal).recoverPending()
  assert.equal(first.db.plate_appearances.length, 1)
  assert.equal(first.db.pitches.length, 2)
  assert.equal(first.db.runs_scored.length, 1)
})

test('a game reset between runs does not bring its plays back at completion', async (t) => {
  // Season game 2766: an aborted attempt's two plays stayed in the per-game
  // journal, the operator reset the game, and the next run's completion
  // verifyAll() re-delivered them as PAs 37 and 38 after the walk-off.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-reset-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const journal = path.join(dir, 'game.json')
  const client = createTrackerFakeSupabase({})
  await store(client, journal).persistEvent(event())
  client.db.plate_appearances.length = 0
  client.db.pitches.length = 0
  client.db.runs_scored.length = 0

  const rerun = store(client.restart(), journal)
  await rerun.recoverPending()
  await rerun.persistEvent(event({ eventKey: 'contact:77', pa: { ...event().pa, tracker_contact_seq: 77 } }))
  await rerun.verifyAll()
  assert.deepEqual(client.db.plate_appearances.map((row) => row.tracker_contact_seq), [77])
  assert.deepEqual(rerun.journal.events.map((entry) => entry.eventKey), ['contact:77'])
})

test('timeouts after commit are reconciled by authoritative reads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-timeout-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const client = createTrackerFakeSupabase({}, { failures: [
    { table: 'plate_appearances', action: 'insert', mode: 'after' },
    { table: 'pitches', action: 'insert', mode: 'after' },
    { table: 'runs_scored', action: 'insert', mode: 'after' },
  ] })
  const result = await store(client, path.join(dir, 'game.json')).persistEvent(event())
  assert.equal(result.pa.id, 1)
  assert.equal(client.db.plate_appearances.length, 1)
  assert.equal(client.db.pitches.length, 2)
  assert.equal(client.db.runs_scored.length, 1)
})

test('delayed responses preserve PA, pitch, then run operation order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-delay-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const client = createTrackerFakeSupabase({}, {
    failures: [{ table: 'pitches', action: 'insert', mode: 'delay', delayMs: 15, times: 2 }],
  })
  await store(client, path.join(dir, 'game.json')).persistEvent(event())
  const writes = client.operations.filter((operation) => operation.action === 'insert').map((operation) => operation.table)
  assert.deepEqual(writes, ['plate_appearances', 'pitches', 'pitches', 'runs_scored'])
})

test('duplicate tracker delivery is a no-op, including after restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-duplicate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const journal = path.join(dir, 'game.json')
  const client = createTrackerFakeSupabase()
  await store(client, journal).persistEvent(event())
  const duplicate = await store(client.restart(), journal).persistEvent(event())
  assert.equal(duplicate.duplicate, true)
  assert.equal(client.db.plate_appearances.length, 1)
  assert.equal(client.db.pitches.length, 2)
  assert.equal(client.db.runs_scored.length, 1)

  client.db.pitches.pop()
  await store(client.restart(), journal).persistEvent(event())
  assert.equal(client.db.pitches.length, 2)
})

test('a stale PA-number read racing another writer refetches max instead of duplicating', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-stale-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const client = createTrackerFakeSupabase({ plate_appearances: [
    { id: 1, game_id: 12, pa_number: 1, player_id: 'other', character_id: 2, inning: 1, result: 'K' },
  ] }, { failures: [{ table: 'plate_appearances', action: 'select', mode: 'stale', data: [] }] })
  const noContact = event({ eventKey: 'tracker-pa:2', pa: { ...event().pa, tracker_contact_seq: null } })
  const result = await store(client, path.join(dir, 'game.json')).persistEvent(noContact)
  assert.equal(result.pa.pa_number, 2)
  assert.deepEqual(client.db.plate_appearances.map((row) => row.pa_number), [1, 2])
})

test('season writes use season tables and season_id on every scoring row', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-season-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const client = createTrackerFakeSupabase()
  await store(client, path.join(dir, 'game.json'), 'season').persistEvent(event())
  for (const table of ['season_plate_appearances', 'season_pitches', 'season_runs_scored']) {
    assert.ok(client.db[table].length)
    assert.ok(client.db[table].every((row) => row.season_id === 7 && row.game_id === 12))
  }
  assert.equal(client.db.plate_appearances, undefined)
})

test('the local game lock refuses a second bridge and releases cleanly', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-lock-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const first = acquireTrackerGameLock({ competitionType: 'season', gameId: 99, directory: dir })
  assert.throws(() => acquireTrackerGameLock({ competitionType: 'season', gameId: 99, directory: dir }), /already owns/)
  first.release()
  const second = acquireTrackerGameLock({ competitionType: 'season', gameId: 99, directory: dir })
  second.release()
})

test('pitching-stat recomputation is repeatable and checks every persisted source row', async () => {
  const client = createTrackerFakeSupabase({
    pitching_stints: [{
      id: 1, game_id: 12, player_id: 'pitcher-owner', character_id: 2,
      created_at: '2026-01-01T00:00:00Z', hits_allowed: 99, pitches_thrown: 99,
    }],
    plate_appearances: [{
      id: 10, game_id: 12, pa_number: 1, pitcher_id: 2, created_at: '2026-01-01T00:00:01Z',
      result: 'HR', outs_on_play: 0, is_error: false,
    }],
    pitches: [
      { id: 20, game_id: 12, pa_id: 10, result: 'strike' },
      { id: 21, game_id: 12, pa_id: 10, result: 'in_play' },
    ],
    runs_scored: [
      { id: 30, game_id: 12, pa_id: 10, charged_to_pitcher_id: 2, is_earned_run: true },
    ],
  })
  const tables = {
    pitchingStints: 'pitching_stints', plateAppearances: 'plate_appearances',
    pitches: 'pitches', runsScored: 'runs_scored',
  }
  await recomputeTrackerPitchingStats(client, { tables, gameId: 12 })
  const first = structuredClone(client.db.pitching_stints[0])
  await recomputeTrackerPitchingStats(client, { tables, gameId: 12 })
  assert.deepEqual(client.db.pitching_stints[0], first)
  assert.equal(first.hits_allowed, 1)
  assert.equal(first.hr_allowed, 1)
  assert.equal(first.pitches_thrown, 2)
  assert.equal(first.runs_allowed, 1)
})

test('shutdown draining waits for an in-flight required write and reports failures', async () => {
  let release
  let finished = false
  const inFlight = new Promise((resolve) => { release = resolve }).then(() => { finished = true })
  const draining = drainTrackerWork([inFlight])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false)
  release()
  await draining
  assert.equal(finished, true)
  await assert.rejects(
    drainTrackerWork([Promise.resolve()], { requiredFailure: () => new Error('required PA missing') }),
    /required PA missing/,
  )
})

test('lineup insertion resumes after a committed response loss and preserves conflicts', async () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({
    game_id: 12, player_id: 'owner', character_id: index + 1, batting_order: index + 1,
  }))
  const first = createTrackerFakeSupabase({}, {
    unique: { lineups: [['game_id', 'player_id', 'character_id']] },
    failures: [{ table: 'lineups', action: 'insert', mode: 'throwAfter' }],
  })
  await assert.rejects(insertRowsReconciled(first, 'lineups', rows, {
    keyFields: ['game_id', 'player_id', 'character_id'],
  }), /process stopped after commit/)
  assert.equal(first.db.lineups.length, 1)
  const restarted = first.restart()
  await insertRowsReconciled(restarted, 'lineups', rows, {
    keyFields: ['game_id', 'player_id', 'character_id'],
  })
  assert.equal(restarted.db.lineups.length, 9)

  restarted.db.lineups[0].batting_order = 9
  await assert.rejects(insertRowsReconciled(restarted, 'lineups', rows, {
    keyFields: ['game_id', 'player_id', 'character_id'],
  }), /already belongs to different data/)
  assert.equal(restarted.db.lineups.length, 9)
})
