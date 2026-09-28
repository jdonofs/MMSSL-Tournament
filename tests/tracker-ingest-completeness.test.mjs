// What "already complete" is allowed to mean.
//
// The postgame ingest decides, from what is already stored, whether a capture
// needs importing at all. Two faults lived in that one decision:
//
//   * it counted plays, fielding, movement and throws and never looked at
//     tracking_catch_approaches, so a session ingested while that table was
//     missing read as complete forever and its reach measurements were never
//     saved by an ordinary retry;
//   * it counted the rows PostgREST chose to return from an un-ranged read,
//     which src/utils/fetchAllRows.js documents as 1,000, so any session with
//     more fielding or movement rows than that looked incomplete and was
//     reconciled row by row every single time.
//
// Both are about the same decision, so they are tested together here.
//
// WHAT A FAKE CLIENT IS EVIDENCE OF. Everything above the last test runs
// against tests/helpers/trackerFakeSupabase.mjs, which is a JavaScript object:
// it is evidence about what the ingester does with an answer, and none at all
// about what Postgres would answer. The last test is the other half -- the
// real migration files, applied to a real PostgreSQL in process, against the
// column types production actually holds.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ingestPlayerTrackingSession } from '../scripts/ingest_player_tracking.mjs'
import { createTrackerFakeSupabase } from './helpers/trackerFakeSupabase.mjs'
import {
  TRACKER_MIGRATIONS,
  createTrackerTestDatabase,
  databaseAvailable,
  migrationSql,
} from './helpers/trackerTestDatabase.mjs'

const ALL_POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']

// The same capture builder the other ingestion suites use, with the two knobs
// this one needs: how many plays, and how many fielders each play tracks.
// Nine fielders and one batter is ten movement rows a play, which is what puts
// a hundred-play game on the response cap exactly.
function writeFixture(dir, {
  competitionType = 'tournament',
  playCount = 1,
  positions = ['P', 'C'],
  fair = true,
  catchApproaches = null,
  playOverrides = null,
} = {}) {
  const stem = path.join(dir, `${competitionType}-capture`)
  fs.writeFileSync(`${stem}.json`, JSON.stringify({
    game_id: 12,
    competition_type: competitionType,
    source_id: competitionType === 'season' ? 7 : 3,
    park: 'mario-stadium',
    format: 'MSSTRK02',
    recorded_utc: '20260905T120000Z',
    frames: 600,
    missed_frames: 0,
    duration_seconds: 10,
    checksum_sha256: 'fixture-checksum',
    fielder_pointers_left_region: false,
  }))
  const fielder = {
    character_id: 2, pitch_release_start: [0, 0, -1], start: [0, 0, -1],
    end: [0, 0, -9], path_units: 8, fielded: true,
  }
  const play = {
    inning: 1, inning_half: 0, batter_id: 2,
    contact_timer: 100, pitch_release_timer: 80, dead_ball_timer: 140,
    batted_ball_class: fair ? 'fair_in_play' : 'foul', fair_or_foul: fair ? 'fair' : 'foul',
    contact_at: [0, 0, -10], first_touch: { by: 'P', character_id: 2, frame: 120, at: [0, 1, -10] },
    primary_fielder: 'P', caught_in_flight: false,
    fielders: Object.fromEntries(positions.map((position) => [position, { ...fielder }])),
    runners: {
      BAT: { character_id: 2, start: [0, 0, 0], end: [10, 0, 0], path_units: 10, five_foot_splits_s: {} },
    },
    throws: [{
      sequence: 1, thrower_position: 'P', thrower_character_id: 2,
      receiver_position: 'C', receiver_character_id: 2,
    }],
    ...(catchApproaches ? { catch_approaches: catchApproaches } : {}),
    ...(playOverrides || {}),
  }
  fs.writeFileSync(`${stem}.plays.jsonl`, Array.from({ length: playCount }, (_, index) => (
    JSON.stringify({ ...play, contact_timer: 100 + index, dead_ball_timer: 140 + index })
  )).join('\n'))
  return stem
}

function initialTables(type = 'tournament', paOverrides = null) {
  const paTable = type === 'season' ? 'season_plate_appearances' : 'plate_appearances'
  const fielderTable = type === 'season' ? 'season_game_fielders' : 'game_fielders'
  return {
    [paTable]: [{
      id: 50, game_id: 12, pa_number: 1, inning: 1, result: '1B', trajectory: 'G',
      character_id: 31, player_id: 'batter-owner', runner_assignments: [], tracker_contact_seq: 1,
      ...(paOverrides || {}),
    }],
    [fielderTable]: ALL_POSITIONS.map((position, index) => ({
      id: index + 1,
      game_id: 12,
      team_id: type === 'season' ? 101 : 'def-owner',
      character: 'Donkey Kong',
      position: index + 1,
      inning_from: 1,
    })),
    characters: [{ id: 31, name: 'Donkey Kong' }],
    season_teams: type === 'season' ? [{ id: 101, player_id: 'def-owner' }] : [],
    tracking_sessions: [], tracking_plays: [], fielding_opportunities: [], movement_metrics: [],
    tracking_throws: [], tracking_catch_approaches: [],
    runner_opportunities: [], double_play_opportunities: [],
  }
}

/**
 * A client whose reads stop at the server's row cap.
 *
 * Supabase caps every PostgREST response at 1,000 rows, ranged or not -- so
 * the cap is applied to the page as well, which is the case an un-paginated
 * read cannot survive and a paginated one has to. Deliberately local to this
 * file rather than a switch on the shared fake: the cap is the thing under
 * test, and a helper everything else inherits would make it a property of
 * every suite instead.
 */
function withResponseCap(client, limit = 1000) {
  return {
    ...client,
    from(table) {
      const query = client.from(table)
      const execute = query.execute.bind(query)
      query.execute = async () => {
        const result = await execute()
        if (query.action === 'select' && Array.isArray(result.data) && result.data.length > limit) {
          result.data = result.data.slice(0, limit)
        }
        return result
      }
      return query
    },
    restart(options) { return withResponseCap(client.restart(options), limit) },
  }
}

function factKeys(rows, keyColumns) {
  return rows.map((row) => keyColumns.map((column) => String(row[column] ?? '')).join('/')).sort()
}

function playOrdinalById(client) {
  return new Map(client.db.tracking_plays.map((row) => [String(row.id), row.play_ordinal]))
}

function childKeys(client, table, keyColumns) {
  const ordinals = playOrdinalById(client)
  return client.db[table].map((row) => [
    ordinals.get(String(row.tracking_play_id)),
    ...keyColumns.map((column) => row[column] ?? ''),
  ].join('/')).sort()
}

const APPROACHES = [
  {
    by: 'CF', character_id: 2, catch_type: 3, approach: 'dive', start_frame: 110, end_frame: 126,
    frames: 16, closest_frame: 121, closest_t: 2.02, separation_units: 1.4,
    separation_3d_units: 1.6, relative_height_units: 0.4, ball_height_units: 1.1,
    outcome: 'secured', secured: true, touched: true, outcome_source: 'possession',
  },
  {
    by: 'RF', character_id: 2, catch_type: 6, approach: 'leap', start_frame: 118, end_frame: 130,
    frames: 12, closest_frame: 124, closest_t: 2.07, separation_units: 3.2,
    separation_3d_units: 3.4, relative_height_units: 1.9, ball_height_units: 2.6,
    outcome: 'no_contact', secured: false, touched: false, outcome_source: null,
  },
]

const MISSING_TABLE = { code: '42P01', message: 'relation "tracking_catch_approaches" does not exist' }

test('a completed session is complete below, at and above the response cap', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-cap-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // 2 plays: 4 fielding, 6 movement. 100 plays: 900 fielding and exactly 1,000
  // movement, the boundary a "fewer rows than a page means the end" pager has
  // to get right. 120 plays: 1,080 and 1,200, both past the cap.
  const cases = [
    { label: 'below', playCount: 2, positions: ['P', 'C'], fielding: 4, movement: 6 },
    { label: 'at', playCount: 100, positions: ALL_POSITIONS, fielding: 900, movement: 1000 },
    { label: 'above', playCount: 120, positions: ALL_POSITIONS, fielding: 1080, movement: 1200 },
  ]
  for (const { label, playCount, positions, fielding, movement } of cases) {
    const caseDir = path.join(dir, label)
    fs.mkdirSync(caseDir, { recursive: true })
    const stem = writeFixture(caseDir, {
      competitionType: 'season', playCount, positions, fair: playCount === 2,
    })
    const backing = createTrackerFakeSupabase(initialTables('season'))
    const client = withResponseCap(backing)
    const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
    assert.equal(first.status, 'ingested', `${label}: first ingest`)
    assert.equal(backing.db.fielding_opportunities.length, fielding, `${label}: fielding rows`)
    assert.equal(backing.db.movement_metrics.length, movement, `${label}: movement rows`)

    const before = backing.operations.length
    const retry = await ingestPlayerTrackingSession(client.restart(), {
      session: stem, recompute: false, warn: () => {},
    })
    assert.equal(retry.alreadyComplete, true, `${label}: an unchanged capture is already complete`)
    assert.equal(retry.fieldingOpportunities, fielding, `${label}: and reports every row, not a capped page`)
    assert.equal(retry.movementMetrics, movement)
    assert.equal(retry.throws, playCount)
    assert.equal(retry.catchApproaches, 0)
    assert.equal(backing.db.fielding_opportunities.length, fielding, `${label}: nothing was rewritten`)
    assert.equal(backing.db.movement_metrics.length, movement)
    const written = backing.operations.slice(before).filter((operation) => operation.action !== 'select')
    assert.deepEqual(written, [], `${label}: a complete session is decided by reads alone`)
  }
})

test('an unchanged completed retry above the cap costs a bounded number of reads', async (t) => {
  // The measurement the review made: on this same 120-play capture the
  // un-paginated check took 2,539 database operations to decide an unchanged
  // session was unchanged, because every child read came back capped and sent
  // the run back through per-row reconciliation. These are request counts
  // against a fake client, not a timing benchmark against Supabase.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-ops-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, {
    competitionType: 'season', playCount: 120, positions: ALL_POSITIONS, fair: false,
  })
  const backing = createTrackerFakeSupabase(initialTables('season'))
  const client = withResponseCap(backing)
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  assert.equal(backing.db.fielding_opportunities.length, 1080)
  assert.equal(backing.db.movement_metrics.length, 1200)

  const before = backing.operations.length
  const retry = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: () => {},
  })
  const operations = backing.operations.length - before
  assert.equal(retry.alreadyComplete, true)
  // Four joins, the session, the plays, and one paged read per fact table:
  // roughly a dozen. The bound is loose enough not to be a change detector and
  // tight enough that a return to per-row reconciliation fails here.
  assert.ok(operations <= 30, `an unchanged retry took ${operations} operations`)
  assert.ok(operations >= 8, `${operations} operations is too few to have checked anything`)
})

test('a capture whose catch approaches never landed is repaired by an ordinary retry', async (t) => {
  // THE REPRODUCTION. tracking_catch_approaches is the one fact the writer is
  // allowed to lose -- a database without the September 20 migration keeps
  // working without it -- and the completeness check could not see it. So the
  // ingest that ran during the deployment window finished, the table arrived,
  // and every retry afterwards said "already complete" and saved none of them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-approach-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { catchApproaches: APPROACHES })

  const client = createTrackerFakeSupabase(initialTables(), {
    failures: [
      { table: 'tracking_catch_approaches', action: 'select', mode: 'before', times: 9, error: MISSING_TABLE },
      { table: 'tracking_catch_approaches', action: 'insert', mode: 'before', times: 9, error: MISSING_TABLE },
    ],
  })
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  assert.equal(first.status, 'ingested')
  assert.equal(first.catchApproaches, 0, 'the writer degraded rather than failing the game')
  assert.equal(client.db.tracking_catch_approaches.length, 0)

  const retry = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: () => {},
  })
  assert.notEqual(retry.alreadyComplete, true, 'the omitted facts are seen, not counted past')
  assert.equal(retry.catchApproaches, 2)
  assert.equal(client.db.tracking_catch_approaches.length, 2)

  // Identities and contents, not a count. These are measurements: a reach that
  // is stored with the wrong fielder or the wrong separation is worse than one
  // that is missing.
  const [dive, leap] = [...client.db.tracking_catch_approaches].sort((a, b) => a.start_frame - b.start_frame)
  assert.equal(dive.position, 'CF')
  assert.equal(dive.approach, 'dive')
  assert.equal(dive.catch_type, 3)
  assert.equal(dive.start_frame, 110)
  assert.equal(dive.separation_3d_units, 1.6)
  assert.equal(dive.outcome, 'secured')
  assert.equal(dive.secured, true)
  assert.equal(dive.fielder_character_id, 31)
  assert.equal(leap.position, 'RF')
  assert.equal(leap.approach, 'leap')
  assert.equal(leap.start_frame, 118)
  assert.equal(leap.relative_height_units, 1.9)
  assert.equal(leap.outcome, 'no_contact')
  assert.equal(leap.secured, false)
  assert.equal(String(dive.tracking_play_id), String(client.db.tracking_plays[0].id))
  assert.equal(String(leap.tracking_play_id), String(client.db.tracking_plays[0].id))

  // And the repair is idempotent: nothing else was rebuilt to get there.
  const third = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: () => {},
  })
  assert.equal(third.alreadyComplete, true)
  assert.equal(third.catchApproaches, 2)
  assert.equal(client.db.tracking_catch_approaches.length, 2)
  assert.equal(client.db.fielding_opportunities.length, 2)
})

test('approaches that only half landed are finished without duplicating the half that did', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-partial-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { catchApproaches: APPROACHES })

  // The first approach commits; the table goes out from under the second.
  const client = createTrackerFakeSupabase(initialTables(), {
    failures: [{
      table: 'tracking_catch_approaches', action: 'insert', mode: 'before', times: 9,
      when: (operation) => operation.tableActionOccurrence >= 2, error: MISSING_TABLE,
    }],
  })
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  assert.equal(client.db.tracking_catch_approaches.length, 1, 'one of the two landed')
  const survivor = client.db.tracking_catch_approaches[0]
  assert.equal(survivor.position, 'CF')

  const retry = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: () => {},
  })
  assert.notEqual(retry.alreadyComplete, true)
  assert.equal(client.db.tracking_catch_approaches.length, 2)
  assert.deepEqual(
    factKeys(client.db.tracking_catch_approaches, ['position', 'start_frame']),
    ['CF/110', 'RF/118'],
  )
  assert.equal(String(client.db.tracking_catch_approaches[0].id), String(survivor.id),
    'the row that was already there was reconciled, not replaced')
})

test('a lost approach write response is reconciled rather than written twice', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-lost-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { catchApproaches: APPROACHES })

  // The insert commits and the answer never arrives -- the ambiguous case
  // insertOneReconciled exists for.
  const client = createTrackerFakeSupabase(initialTables(), {
    failures: [{
      table: 'tracking_catch_approaches', action: 'insert', mode: 'after', times: 1,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    }],
  })
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  assert.equal(first.catchApproaches, 2)
  assert.equal(client.db.tracking_catch_approaches.length, 2)

  const retry = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: () => {},
  })
  assert.equal(retry.alreadyComplete, true)
  assert.equal(retry.catchApproaches, 2)
  assert.equal(client.db.tracking_catch_approaches.length, 2, 'the committed row was not written a second time')
})

test('a database with no catch-approach table says so instead of counting zero of them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-degraded-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { catchApproaches: APPROACHES })

  const client = createTrackerFakeSupabase(initialTables(), {
    failures: [
      { table: 'tracking_catch_approaches', action: 'select', mode: 'before', times: 9, error: MISSING_TABLE },
      { table: 'tracking_catch_approaches', action: 'insert', mode: 'before', times: 9, error: MISSING_TABLE },
    ],
  })
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const retry = await ingestPlayerTrackingSession(client.restart({
    failures: [{ table: 'tracking_catch_approaches', action: 'select', mode: 'before', times: 9, error: MISSING_TABLE }],
  }), { session: stem, recompute: false, warn: () => {} })
  assert.equal(retry.alreadyComplete, true, 'the rest of the session is genuinely finished')
  assert.equal(retry.catchApproaches, null,
    'and the fact this database cannot hold is reported as absent, not as zero')
  assert.equal(client.db.tracking_catch_approaches.length, 0)
})

test('a failed completeness check is a failure, not an empty count', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-errors-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { playCount: 2, catchApproaches: APPROACHES })
  const client = createTrackerFakeSupabase(initialTables())
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  const fieldingBefore = client.db.fielding_opportunities.length
  const approachesBefore = client.db.tracking_catch_approaches.length

  const faults = [
    { table: 'fielding_opportunities', code: '57014', message: 'canceling statement due to statement timeout' },
    { table: 'movement_metrics', code: '42501', message: 'permission denied for table movement_metrics' },
    { table: 'tracking_throws', code: '42703', message: 'column tracking_throws.throw_sequence does not exist' },
    { table: 'tracking_plays', code: '57014', message: 'canceling statement due to statement timeout' },
    // A missing table is a degradation for the catch approaches and ONLY for
    // them. Anywhere else it is a broken schema.
    { table: 'fielding_opportunities', code: '42P01', message: 'relation "fielding_opportunities" does not exist' },
    // A missing COLUMN on the one table that is allowed to be absent is still
    // a fault: the table is there, and something about it is wrong.
    {
      table: 'tracking_catch_approaches', code: '42703',
      message: 'column tracking_catch_approaches.start_frame does not exist',
    },
  ]
  for (const { table, code, message } of faults) {
    await assert.rejects(
      ingestPlayerTrackingSession(client.restart({
        failures: [{ table, action: 'select', mode: 'before', times: 1, error: { code, message } }],
      }), { session: stem, recompute: false, warn: () => {} }),
      (error) => error?.code === code,
      `${table} ${code} must reach the caller`,
    )
    assert.equal(client.db.tracking_sessions[0].status, 'ingested', `${code}: the stored session is untouched`)
    assert.equal(client.db.fielding_opportunities.length, fieldingBefore)
    assert.equal(client.db.tracking_catch_approaches.length, approachesBefore)
  }

  // And once nothing is failing, the same input is still complete.
  const retry = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: () => {},
  })
  assert.equal(retry.alreadyComplete, true)
})

test('a child set with the expected total under the wrong keys is not a finished ingest', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-skew-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { playCount: 2 })
  const client = createTrackerFakeSupabase(initialTables())
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  assert.equal(client.db.fielding_opportunities.length, 4)

  // The second play's catcher row now names a position the capture never
  // tracked. The TOTAL is still four, which is all the counted check ever
  // looked at, and the capture's own key -- play 2, position C -- is gone.
  const ordinals = playOrdinalById(client)
  const strayed = client.db.fielding_opportunities.find((row) => (
    ordinals.get(String(row.tracking_play_id)) === 2 && row.position === 'C'
  ))
  strayed.position = 'SS'
  assert.equal(client.db.fielding_opportunities.length, 4, 'the counts still agree exactly')

  const warnings = []
  const retry = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: (message) => warnings.push(message),
  })
  assert.notEqual(retry.alreadyComplete, true)
  assert.match(warnings.join('\n'), /fielding 1 missing, 1 unexpected/)
  assert.deepEqual(childKeys(client, 'fielding_opportunities', ['position']),
    ['1/C', '1/P', '2/C', '2/P', '2/SS'].sort(),
    'the key the capture asked for was written; the stray row is left for a person to look at')
})

test('two plays sharing an ordinal are not mistaken for one', async (t) => {
  // A duplicate ordinal collapses into a set, so the rows are counted as well
  // as keyed. 20260908120000 does create a unique index on
  // (tracking_session_id, play_ordinal) -- the last test checks that it does
  // -- but it skips any table that was not present when it ran, so a
  // deployment where tracking_plays arrived afterwards holds no such index and
  // the ingest cannot assume one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-complete-dup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { playCount: 2 })
  const client = createTrackerFakeSupabase(initialTables())
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const duplicated = client.db.tracking_plays.find((row) => row.play_ordinal === 2)
  client.db.tracking_plays.push({ ...duplicated, id: 'duplicate-play', pa_id: null })

  const warnings = []
  const retry = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: (message) => warnings.push(message),
  })
  assert.notEqual(retry.alreadyComplete, true)
  assert.match(warnings.join('\n'), /plays 0 missing, 1 unexpected/)
})

test('the catch-approach schema the completeness check reads is the one production holds', async (t) => {
  if (!await databaseAvailable()) {
    t.skip('@electric-sql/pglite is not installed; the SQL half was not exercised')
    return
  }
  // WHAT THIS COVERS AND WHAT IT DOES NOT. tests/helpers/trackerTestDatabase.mjs
  // applies its migration list to tests/fixtures/tracker-database-baseline.sql,
  // which models tracking_plays.id as bigserial. Production's is a uuid, and
  // 20260920130000 declares `tracking_play_id uuid references
  // tracking_plays(id)` -- so that migration cannot be added to the shared list
  // without retyping the whole baseline, which is not this task. The two that
  // CAN be added are checked against the shared baseline below; the
  // catch-approach pair is applied verbatim to a tracking subtree carrying
  // production's own types. Neither half is evidence about Supabase's
  // configuration, only about the SQL in these files.
  const { PGlite } = await import('@electric-sql/pglite')
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto')

  for (const name of [
    '20260918135000_tracking_play_pa_version_uniqueness.sql',
    '20260920120000_tracker_max_speed_and_projected_landing.sql',
  ]) {
    const db = await createTrackerTestDatabase({ migrations: [...TRACKER_MIGRATIONS, name] })
    t.after(() => db.close?.())
    assert.ok(db.appliedMigrations.includes(name), `${name} applies on top of the shared baseline`)
    // The index the play ordinal is keyed on. 20260908120000 creates it, and
    // skips silently when the table is absent -- which is why the completeness
    // check counts rows as well as ordinals rather than relying on it.
    const ordinalIndex = (await db.rows(`
      select indexdef from pg_indexes
      where tablename = 'tracking_plays' and indexname = 'tracking_plays_session_ordinal_uidx'`))
    assert.equal(ordinalIndex.length, 1, 'the session/ordinal unique index exists when that migration ran')
    assert.match(ordinalIndex[0].indexdef, /UNIQUE/i)
  }

  const db = await PGlite.create({ extensions: { pgcrypto } })
  t.after(() => db.close?.())
  await db.exec(`
    create extension if not exists pgcrypto;
    -- Supabase supplies these two roles and 20260918131000's policies call
    -- these two functions; both are prerequisites of the migration, not part
    -- of what is being tested.
    create role anon;
    create role authenticated;
    create function current_player_has_scorebook_access() returns boolean language sql as $$ select true $$;
    create function current_player_is_commissioner() returns boolean language sql as $$ select true $$;
    create table public.tracking_sessions (id uuid primary key default gen_random_uuid());
    create table public.tracking_plays (
      id uuid primary key default gen_random_uuid(),
      tracking_session_id uuid references public.tracking_sessions(id) on delete cascade,
      competition_type text, game_id bigint, pa_id bigint, play_ordinal int);
  `)
  for (const name of [
    '20260918135000_tracking_play_pa_version_uniqueness.sql',
    '20260920130000_tracking_catch_approaches.sql',
    '20260920140000_catch_approach_pa_id_is_bigint.sql',
  ]) {
    await db.exec(migrationSql(name))
  }

  const columns = Object.fromEntries((await db.query(`
    select column_name, data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'tracking_catch_approaches'`)).rows
    .map((row) => [row.column_name, row.data_type]))
  assert.equal(columns.tracking_play_id, 'uuid')
  assert.equal(columns.pa_id, 'bigint', '20260920140000 corrected this from uuid')
  assert.equal(columns.position, 'text')
  assert.equal(columns.start_frame, 'integer')

  // The completeness check treats (tracking_play_id, position, start_frame) as
  // an identity. The database has to agree, or key equality would prove less
  // than it claims.
  const { rows: [session] } = await db.query('insert into tracking_sessions default values returning id')
  const { rows: plays } = await db.query(`
    insert into tracking_plays (tracking_session_id, play_ordinal)
    values ($1, 1), ($1, 2) returning id, play_ordinal`, [session.id])
  const insert = `insert into tracking_catch_approaches
    (tracking_play_id, position, start_frame, approach, outcome) values ($1, $2, $3, 'dive', 'secured')`
  await db.query(insert, [plays[0].id, 'CF', 110])
  await assert.rejects(db.query(insert, [plays[0].id, 'CF', 110]), /duplicate key|unique/i,
    'the natural key is unique in the database, not only in the writer')
  await db.query(insert, [plays[0].id, 'CF', 111])

  // The exact read shape the paginated check issues, over more rows than one
  // PostgREST response can carry.
  await db.query(`
    insert into tracking_catch_approaches (tracking_play_id, position, start_frame, approach, outcome)
    select $1, 'RF', generate_series(1, 1050), 'leap', 'no_contact'`, [plays[1].id])
  const keys = new Set()
  for (let offset = 0; ; offset += 1000) {
    const { rows } = await db.query(`
      select id, tracking_play_id, position, start_frame from tracking_catch_approaches
      where tracking_play_id = any($1) order by id asc limit 1000 offset $2`,
    [[plays[0].id, plays[1].id], offset])
    for (const row of rows) keys.add(`${row.tracking_play_id}/${row.position}/${row.start_frame}`)
    if (rows.length < 1000) break
  }
  assert.equal(keys.size, 1052, 'every page, each key exactly once')
})

// A ground ball the second baseman dove for and secured, throwing the batter
// out at first: the Nice Play the live bridge structurally cannot see, because
// it writes the plate appearance before the capture closes the play.
const DIVING_GROUNDOUT = {
  primary_fielder: '2B',
  first_touch: { by: '2B', character_id: 2, frame: 120, at: [4, 0, -36] },
  fielding_events: [{
    event_type: 'possession', ball_contact: 'confirmed', secured: true, t: 1.3,
    by: '2B', character_id: 2, catch_type: 3, approach: 'dive', dive: true, leap: false,
  }],
}

test('the ingest sets is_nice_play from the joined capture, and never over an operator', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-nice-play-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { competitionType: 'season', playOverrides: DIVING_GROUNDOUT })
  const groundout = { result: 'GO', hit_notation: 'G4-3', outs_on_play: 1, is_nice_play: false }

  // The bridge stored false because it had no play to read.
  const client = createTrackerFakeSupabase(initialTables('season', groundout))
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  assert.equal(first.status, 'ingested')
  assert.equal(first.nicePlaysSet, 1)
  assert.equal(client.db.season_plate_appearances[0].is_nice_play, true)

  // A row that already says what the capture says is not rewritten.
  const settled = createTrackerFakeSupabase(initialTables('season', { ...groundout, is_nice_play: true }))
  const again = await ingestPlayerTrackingSession(settled, { session: stem, recompute: false, warn: () => {} })
  assert.equal(again.nicePlaysSet, 0)
  assert.equal(settled.db.season_plate_appearances[0].is_nice_play, true)

  // The diver has to be the first fielder in the notation, or the credit lands
  // on whoever the stats page shows first.
  const wrongChain = createTrackerFakeSupabase(initialTables('season', { ...groundout, hit_notation: 'G6-3' }))
  const other = await ingestPlayerTrackingSession(wrongChain, { session: stem, recompute: false, warn: () => {} })
  assert.equal(other.nicePlaysSet, 0)
  assert.equal(wrongChain.db.season_plate_appearances[0].is_nice_play, false)

  // A hand-set value outranks the capture's.
  const corrected = createTrackerFakeSupabase(initialTables('season', {
    ...groundout, correction_source: 'at-bat-editor',
  }))
  const kept = await ingestPlayerTrackingSession(corrected, { session: stem, recompute: false, warn: () => {} })
  assert.equal(kept.nicePlaysSet, 0)
  assert.equal(corrected.db.season_plate_appearances[0].is_nice_play, false)
})
