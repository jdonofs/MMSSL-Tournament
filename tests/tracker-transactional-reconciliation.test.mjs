// The real scoring writer against the real database functions.
//
// Every other persistence suite runs the writer against
// tests/helpers/trackerFakeSupabase.mjs, which is the right tool for the
// client's own logic and cannot answer any of the questions below: it has no
// column list, so it can never say a column is missing; it does not run
// plpgsql, so it never executes the function the migration installs; and it has
// no transactions, so it cannot show one rolling back. Four defects lived in
// exactly that gap -- between a passing client suite and a passing database
// suite, with nothing exercising the two together.
//
// So this suite is scripts/tracker_scoring_persistence.mjs, unmodified, talking
// to PGlite through a PostgREST-shaped shim, against three schemas: unmigrated,
// partially migrated (the durable identities without the transactional
// function), and fully migrated.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createTrackerTestDatabase,
  databaseAvailable,
  seedCollidingGames,
  TRACKER_MIGRATIONS,
} from './helpers/trackerTestDatabase.mjs'
import { createPgliteSupabase } from './helpers/pgliteSupabase.mjs'
import {
  createTrackerScoringPersistence,
  describeSchemaCapabilities,
} from '../scripts/tracker_scoring_persistence.mjs'
import { createTrackerGameLease, unleasedTrackerCredentials } from '../scripts/tracker_game_lease.mjs'

const HAVE_DATABASE = await databaseAvailable()
const skip = HAVE_DATABASE
  ? false
  : 'no local Postgres: @electric-sql/pglite is not installed (npm install)'

// The identity columns arrive here; the transactional function arrives in the
// migration after it. A deployment that has run one and not the other is a real
// state and is one of the three tested below.
const IDENTITIES_ONLY = TRACKER_MIGRATIONS.slice(0, 2)

const TABLES = { plateAppearances: 'plate_appearances', pitches: 'pitches', runsScored: 'runs_scored' }
const REPAIR = unleasedTrackerCredentials('test: an operator repair with no lease')

async function world(t, migrations = TRACKER_MIGRATIONS) {
  const db = await createTrackerTestDatabase({ migrations })
  t.after(() => db.close())
  const seeded = await seedCollidingGames(db)
  return { db, supabase: createPgliteSupabase(db), ...seeded }
}

function writer(supabase, gameId, options = {}) {
  return createTrackerScoringPersistence({
    supabase,
    tables: TABLES,
    competitionType: 'tournament',
    gameId,
    leaseCredentials: () => REPAIR,
    ...options,
  })
}

function paFor(w, overrides = {}) {
  return {
    player_id: w.away.id,
    character_id: w.batter.id,
    pitcher_id: w.pitcher.id,
    pitcher_player_id: w.home.id,
    inning: 1,
    result: 'K',
    ...overrides,
  }
}

// ── the operator's correction ───────────────────────────────────────────────

test('a replayed payload cannot add a run to an operator-corrected strikeout', { skip }, async (t) => {
  const w = await world(t)
  const [correction] = await w.db.rows(
    `insert into plate_appearances (game_id, pa_number, result, tracker_event_key,
                                    correction_source, player_id, character_id)
     values ($1, 1, 'K', 'tracker-pa:5:1', 'operator', $2, $3) returning *`,
    [w.gameId, w.away.id, w.batter.id])
  // The operator's own children, written beside it by the editor.
  await w.db.query(
    "insert into pitches (game_id, pa_id, pitch_number_pa, pitch_result) values ($1, $2, 1, 'looking')",
    [w.gameId, correction.id])

  const saved = await writer(w.supabase, w.gameId).persistEvent({
    eventKey: 'tracker-pa:5:1',
    pa: paFor(w, { result: 'HR' }),
    pitches: [{ pitch_number_pa: 1, pitch_result: 'in_play' }],
    runs: [{ scoring_player_id: w.away.id, scoring_character_id: w.batter.id }],
  })

  assert.equal(saved.operatorCorrection, true)
  assert.equal(saved.runs, 0)
  const row = await w.db.one('select result, correction_source from plate_appearances where id = $1',
    [correction.id])
  assert.equal(row.result, 'K', "the operator's result stands")
  assert.equal(row.correction_source, 'operator')
  assert.equal(await w.db.value('select count(*) from runs_scored where pa_id = $1', [correction.id]), 0,
    'and it did not grow a run from the replayed payload')
  assert.equal(await w.db.value('select pitch_result from pitches where pa_id = $1', [correction.id]),
    'looking', "the operator's own pitch is complete and unrestated")
})

// ── contradiction versus retry ──────────────────────────────────────────────

test('conflicting facts under one event key are refused, and nothing is written', { skip }, async (t) => {
  const w = await world(t)
  const first = await writer(w.supabase, w.gameId).persistEvent({
    eventKey: 'contact:11', pa: paFor(w, { tracker_contact_seq: 11 }), pitches: [], runs: [],
  })
  assert.equal(first.transactional, true)

  await assert.rejects(
    () => writer(w.supabase, w.gameId).persistEvent({
      eventKey: 'contact:11',
      pa: paFor(w, { tracker_contact_seq: 11, result: 'HR' }),
      pitches: [],
      runs: [{ scoring_player_id: w.away.id, scoring_character_id: w.batter.id }],
    }),
    /already names a different plate appearance.*differs in result/s,
  )
  assert.equal(await w.db.value('select result from plate_appearances where tracker_event_key = $1',
    ['contact:11']), 'K')
  assert.equal(await w.db.value('select count(*) from runs_scored'), 0,
    'the refused payload left no run behind either')
})

test('an identical retry is a no-op, children included', { skip }, async (t) => {
  const w = await world(t)
  const event = {
    eventKey: 'contact:12',
    pa: paFor(w, { tracker_contact_seq: 12, result: '1B' }),
    pitches: [{ pitch_number_pa: 1, pitch_result: 'in_play' }],
    runs: [{ scoring_player_id: w.away.id, scoring_character_id: w.batter.id }],
  }
  const first = await writer(w.supabase, w.gameId).persistEvent(event)
  // A different writer, so the local journal cannot be what makes this pass.
  const second = await writer(w.supabase, w.gameId).persistEvent(event)
  assert.equal(String(second.pa.id), String(first.pa.id))
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 1)
  assert.equal(await w.db.value('select count(*) from pitches'), 1)
  assert.equal(await w.db.value('select count(*) from runs_scored'), 1)
})

test('a pitch already recorded with different data is a conflict, not a no-op', { skip }, async (t) => {
  const w = await world(t)
  await writer(w.supabase, w.gameId).persistEvent({
    eventKey: 'contact:13',
    pa: paFor(w, { tracker_contact_seq: 13, result: '1B' }),
    pitches: [{ pitch_number_pa: 1, pitch_result: 'in_play' }],
    runs: [],
  })
  await assert.rejects(
    () => writer(w.supabase, w.gameId).persistEvent({
      eventKey: 'contact:13',
      pa: paFor(w, { tracker_contact_seq: 13, result: '1B' }),
      pitches: [{ pitch_number_pa: 1, pitch_result: 'foul' }],
      runs: [],
    }),
    /pitch 1 .* already recorded with different data/s,
  )
  assert.equal(await w.db.value('select pitch_result from pitches where pitch_number_pa = 1'), 'in_play')
})

test('pitch_number_game is still not part of a pitch identity', { skip }, async (t) => {
  const w = await world(t)
  const event = (numberInGame) => ({
    eventKey: 'contact:14',
    pa: paFor(w, { tracker_contact_seq: 14, result: '1B' }),
    pitches: [{ pitch_number_pa: 1, pitch_result: 'in_play', pitch_number_game: numberInGame }],
    runs: [],
  })
  await writer(w.supabase, w.gameId).persistEvent(event(7))
  // The same pitch, replayed into a database that already holds it, computes a
  // higher game ordinal. That is a display number, not a contradiction.
  await writer(w.supabase, w.gameId).persistEvent(event(31))
  assert.equal(await w.db.value('select count(*) from pitches'), 1)
  assert.equal(await w.db.value('select pitch_number_game from pitches'), 7)
})

// ── game identity ───────────────────────────────────────────────────────────

test('a child naming another game is refused before anything is written', { skip }, async (t) => {
  const w = await world(t)
  await w.db.query('insert into games (id, tournament_id, stats_source) values (5555, 909, $1)', ['tracker'])
  await assert.rejects(
    () => w.supabase.rpc('tracker_persist_plate_appearance', {
      p_competition_type: 'tournament',
      p_game_id: w.gameId,
      p_pa: { ...paFor(w), game_id: w.gameId, tracker_event_key: 'contact:15' },
      p_pitches: [{ game_id: 5555, pitch_number_pa: 1 }],
      p_runs: [],
      p_owner_id: null,
      p_epoch: null,
      p_unleased_intent: 'test',
    }).then(({ error }) => { if (error) throw new Error(error.message) }),
    /a child row names game 5555/,
  )
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 0)
  assert.equal(await w.db.value('select count(*) from pitches'), 0)
})

test('a plate appearance naming another game is refused', { skip }, async (t) => {
  const w = await world(t)
  await w.db.query('insert into games (id, tournament_id, stats_source) values (5556, 909, $1)', ['tracker'])
  const { error } = await w.supabase.rpc('tracker_persist_plate_appearance', {
    p_competition_type: 'tournament',
    p_game_id: w.gameId,
    p_pa: { ...paFor(w), game_id: 5556, tracker_event_key: 'contact:16' },
    p_pitches: [],
    p_runs: [],
    p_owner_id: null,
    p_epoch: null,
    p_unleased_intent: 'test',
  })
  assert.match(String(error?.message), /names game 5556/)
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 0)
})

// ── the lease, through the real writer ──────────────────────────────────────

test('a writer whose lease was taken writes nothing at all', { skip }, async (t) => {
  const w = await world(t)
  const mine = createTrackerGameLease({
    supabase: w.supabase, competitionType: 'tournament', gameId: w.gameId, ownerId: 'bridge-a',
  })
  const theirs = createTrackerGameLease({
    supabase: w.supabase, competitionType: 'tournament', gameId: w.gameId, ownerId: 'bridge-b',
  })
  await mine.acquire()
  await theirs.acquire({ takeover: true })
  await mine.renew()
  assert.equal(mine.status, 'lost')

  const stale = writer(w.supabase, w.gameId, { leaseCredentials: (what) => mine.writeCredentials(what) })
  await assert.rejects(
    () => stale.persistEvent({ eventKey: 'contact:17', pa: paFor(w), pitches: [], runs: [] }),
    (error) => error.code === 'TRACKER_LEASE_NOT_HELD',
  )
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 0)
  // And it did not even journal the intention, so a restart replays nothing.
  assert.equal(stale.journal.events.length, 0)

  // The new owner writes normally, which is what makes the refusal a fence
  // rather than an outage.
  const live = writer(w.supabase, w.gameId, { leaseCredentials: (what) => theirs.writeCredentials(what) })
  const saved = await live.persistEvent({ eventKey: 'contact:17', pa: paFor(w), pitches: [], runs: [] })
  assert.ok(saved.pa.id)
})

// ── the three schemas ───────────────────────────────────────────────────────

test('an unmigrated schema is tracked into rather than failing on the first at-bat', { skip }, async (t) => {
  const w = await world(t, [])
  const messages = []
  const writing = writer(w.supabase, w.gameId, { log: (message) => messages.push(String(message)) })

  const first = await writing.persistEvent({
    eventKey: 'tracker-pa:5:1', pa: paFor(w), pitches: [{ pitch_result: 'looking' }], runs: [],
  })
  assert.ok(first.pa.id, 'the advertised fallback actually writes')
  assert.equal(first.transactional, undefined)
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 1)
  assert.equal(await w.db.value('select count(*) from pitches'), 1)

  assert.ok(messages.some((message) => /no tracker_persist_plate_appearance/.test(message)),
    'the missing function is reported once')
  assert.ok(messages.some((message) => /no plate_appearances\.tracker_event_key/.test(message)),
    'and so is the missing column, in the same words the capability report uses')
})

test('on an unmigrated schema a contact at-bat still has a durable identity', { skip }, async (t) => {
  const w = await world(t, [])
  const event = {
    eventKey: 'contact:31',
    pa: paFor(w, { tracker_contact_seq: 31, result: '1B' }),
    pitches: [{ pitch_result: 'in_play' }],
    runs: [],
  }
  const first = await writer(w.supabase, w.gameId).persistEvent(event)
  // A different writer with no journal at all: the only thing that can
  // reconcile this is the row's own tracker_contact_seq, which predates the
  // durable-identity migration and is why that column is the supported floor.
  const replay = await writer(w.supabase, w.gameId).persistEvent(event)
  assert.equal(String(replay.pa.id), String(first.pa.id))
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 1)
  assert.equal(await w.db.value('select count(*) from pitches'), 1)
})

test('on an unmigrated schema a non-contact at-bat is reconciled by the journal, and only by it', { skip }, async (t) => {
  const w = await world(t, [])
  const journalPath = path.join(os.tmpdir(), `tracker-fallback-${process.pid}-${Date.now()}.json`)
  t.after(() => { try { fs.unlinkSync(journalPath) } catch { /* never written */ } })
  // A strikeout has no contact sequence, and this schema has no event key
  // column, so the local journal is the whole of its identity. That is exactly
  // what describeSchemaCapabilities() calls degraded, and this is the test of
  // what "degraded" actually means.
  const event = { eventKey: 'tracker-pa:5:1', pa: paFor(w), pitches: [], runs: [] }
  const before = await writer(w.supabase, w.gameId, { journalPath }).persistEvent(event)

  const restarted = writer(w.supabase, w.gameId, { journalPath })
  const recovered = await restarted.verifyAll()
  assert.equal(recovered.length, 1)
  assert.equal(String(recovered[0].pa.id), String(before.pa.id),
    'a restart that still has its journal reconciles rather than duplicating')
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 1)

  // And the limit, stated rather than implied: a writer that has LOST its
  // journal cannot tell this strikeout from a second one by the same batter in
  // the same inning, because on this schema nothing in the row says.
  await writer(w.supabase, w.gameId).persistEvent(event)
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 2)
  const capabilities = await writer(w.supabase, w.gameId).schemaCapabilities()
  assert.equal(capabilities.tracker_event_key, false)
  assert.equal(describeSchemaCapabilities(capabilities).degraded.length, 2)
})

test('a schema with no contact sequence is refused before the game starts', { skip }, async (t) => {
  const w = await world(t, [])
  await w.db.query('alter table plate_appearances drop column tracker_contact_seq')
  await assert.rejects(
    () => writer(w.supabase, w.gameId).assertSchemaSupported(),
    /no plate_appearances\.tracker_contact_seq/,
  )
  // The prerequisite fails at startup rather than on the first at-bat, which is
  // the difference between an operator seeing this before a game and seeing it
  // in the middle of one.
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 0)
})

test('a partially migrated schema uses the durable key without the function', { skip }, async (t) => {
  const w = await world(t, IDENTITIES_ONLY)
  const capabilities = await writer(w.supabase, w.gameId).schemaCapabilities()
  assert.deepEqual(capabilities, {
    tracker_event_key: true, tracker_contact_seq: true, correction_source: false,
  })

  const event = { eventKey: 'tracker-pa:5:2', pa: paFor(w, { result: 'BB' }), pitches: [], runs: [] }
  const first = await writer(w.supabase, w.gameId).persistEvent(event)
  const replay = await writer(w.supabase, w.gameId).persistEvent(event)
  assert.equal(String(replay.pa.id), String(first.pa.id))
  assert.equal(await w.db.value(
    'select tracker_event_key from plate_appearances where id = $1', [first.pa.id]), 'tracker-pa:5:2',
  'the key is written into the row even though the transactional function is absent')
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 1)
})

test('a fully migrated schema commits transactionally', { skip }, async (t) => {
  const w = await world(t)
  const saved = await writer(w.supabase, w.gameId).persistEvent({
    eventKey: 'contact:18',
    pa: paFor(w, { tracker_contact_seq: 18, result: 'HR' }),
    pitches: [{ pitch_number_pa: 1, pitch_result: 'in_play' }],
    runs: [{ scoring_player_id: w.away.id, scoring_character_id: w.batter.id }],
  })
  assert.equal(saved.transactional, true)
  assert.equal(await w.db.value('select count(*) from runs_scored where pa_id = $1', [saved.pa.id]), 1)
})

test('a real failure is never mistaken for a missing capability', { skip }, async (t) => {
  const w = await world(t)
  // A run whose scorer is not a real player: a foreign-key violation, which is
  // a failed write and not a schema that lacks something. Read as the latter it
  // would fall through to a weaker path and write half the event.
  await assert.rejects(
    () => writer(w.supabase, w.gameId).persistEvent({
      eventKey: 'contact:19',
      pa: paFor(w, { tracker_contact_seq: 19, result: 'HR' }),
      pitches: [],
      runs: [{ scoring_player_id: '00000000-0000-0000-0000-000000000000', scoring_character_id: w.batter.id }],
    }),
    /foreign key|violates/i,
  )
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 0,
    'and the transaction took the plate appearance back with it')
})
