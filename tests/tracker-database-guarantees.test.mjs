// The guarantees only a database can make, against a real database.
//
// Every other tracker suite runs on tests/helpers/trackerFakeSupabase.mjs,
// which models the client's behaviour honestly and establishes nothing about
// the server's: it is one JavaScript object, so it cannot show a unique index
// rejecting a race, a transaction rolling back, or two clients being
// serialized. docs/tracker-acceptance-2026-09-06.md lists exactly that as its
// verification limit.
//
// This suite applies the real migration files from supabase/migrations/ to a
// real PostgreSQL (PGlite, the server compiled to WebAssembly, in process) and
// tests them by their effects. Nothing here touches Supabase, and every
// database is created fresh and thrown away.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createTrackerTestDatabase,
  databaseAvailable,
  seedCollidingGames,
  TRACKER_MIGRATIONS,
} from './helpers/trackerTestDatabase.mjs'

const HAVE_DATABASE = await databaseAvailable()
const skip = HAVE_DATABASE
  ? false
  : 'no local Postgres: @electric-sql/pglite is not installed (npm install)'

async function freshWorld(t, options = {}) {
  const db = await createTrackerTestDatabase(options)
  t.after(() => db.close())
  const world = await seedCollidingGames(db)
  return { db, ...world }
}

function paPayload(world, overrides = {}) {
  return JSON.stringify({
    game_id: world.gameId,
    player_id: world.away.id,
    character_id: world.batter.id,
    pitcher_id: world.pitcher.id,
    pitcher_player_id: world.home.id,
    inning: 1,
    result: 'K',
    tracker_event_key: 'tracker-pa:1:1',
    ...overrides,
  })
}

// REPAIR IS A ROUTE YOU ASK FOR BY NAME. A null owner used to be waved through
// as "an unleased caller (a backfill, a repair script)", which is the exact
// shape a bridge that had just LOST its lease produced -- so losing a lease
// disabled fencing instead of stopping writes. A caller with no lease now has
// to say why, and these tests say it the way a repair script would.
const REPAIR = 'test: an operator repair with no lease'

async function persist(db, competition, world, {
  pa = {}, pitches = [], runs = [], owner = null, epoch = null, unleased = REPAIR,
} = {}) {
  const row = await db.one(
    'select tracker_persist_plate_appearance($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8) as result',
    [competition, world.gameId, paPayload(world, pa), JSON.stringify(pitches), JSON.stringify(runs),
      owner, epoch, owner ? null : unleased],
  )
  return row.result
}

// ── the migrations themselves ───────────────────────────────────────────────

test('every tracker migration applies to a database that has the tables', { skip }, async (t) => {
  const { db } = await freshWorld(t)
  assert.deepEqual(db.appliedMigrations, TRACKER_MIGRATIONS)
  const indexes = await db.rows(
    "select indexname from pg_indexes where schemaname = 'public' and indexname like '%uidx' order by 1")
  assert.deepEqual(indexes.map((row) => row.indexname), [
    'fielding_opportunities_play_position_uidx',
    'movement_metrics_play_actor_uidx',
    'pitches_pa_pitch_number_uidx',
    'plate_appearances_game_pa_number_uidx',
    'plate_appearances_tracker_contact_seq_uidx',
    'plate_appearances_tracker_event_key_uidx',
    'runs_scored_pa_scorer_uidx',
    'season_pitches_pa_pitch_number_uidx',
    'season_plate_appearances_game_pa_number_uidx',
    'season_plate_appearances_tracker_contact_seq_uidx',
    'season_plate_appearances_tracker_event_key_uidx',
    'season_runs_scored_pa_scorer_uidx',
    'tracking_plays_session_ordinal_uidx',
    'tracking_sessions_active_stem_uidx',
    'tracking_sessions_stem_version_uidx',
    'tracking_throws_play_sequence_uidx',
  ])
})

test('a table this deployment does not have is skipped, not failed', { skip }, async (t) => {
  // The tracking tables were created directly against Supabase and no DDL for
  // them is in this repository, so a database can legitimately be missing them.
  const db = await createTrackerTestDatabase({
    beforeMigrations: (handle) => handle.exec('drop table tracking_throws, movement_metrics, fielding_opportunities'),
    migrations: ['20260908120000_tracker_durable_identities.sql'],
  })
  t.after(() => db.close())
  assert.equal(await db.value(
    "select count(*) from pg_indexes where indexname = 'plate_appearances_tracker_event_key_uidx'"), 1)
})

test('existing duplicates fail the migration and nothing is deleted or merged', { skip }, async (t) => {
  // The rule the migration header states: a duplicate scoring row is a
  // question for a person with the game in front of them. The migration's job
  // is to refuse, loudly, having changed nothing.
  let failure = null
  const db = await createTrackerTestDatabase({
    beforeMigrations: async (handle) => {
      await handle.exec("insert into players (name) values ('dupe-player')")
      await handle.exec("insert into characters (name) values ('dupe-character')")
      await handle.exec('insert into games (id) values (77)')
      await handle.exec(`insert into plate_appearances (game_id, pa_number, result)
                         values (77, 1, 'K'), (77, 1, 'BB')`)
    },
    migrations: [],
  })
  t.after(() => db.close())
  const { migrationSql } = await import('./helpers/trackerTestDatabase.mjs')
  try {
    await db.exec(migrationSql('20260908120000_tracker_durable_identities.sql'))
  } catch (error) {
    failure = error
  }
  assert.ok(failure, 'a duplicate pa_number has to stop the migration')
  assert.match(String(failure.message), /could not create unique index|duplicate key/i)
  assert.equal(await db.value('select count(*) from plate_appearances'), 2,
    'both rows survive: the migration reports, it does not repair')
  assert.equal(await db.value(
    "select count(*) from information_schema.columns where table_name = 'plate_appearances' "
    + "and column_name = 'tracker_event_key'"), 0,
    'the whole migration file rolls back, column included')
})

// ── durable identity ────────────────────────────────────────────────────────

test('two plate appearances cannot share a tracker event key in one game', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  await persist(db, 'tournament', world)
  const failure = await db.fails(
    `insert into plate_appearances (game_id, pa_number, result, tracker_event_key)
     values ($1, 99, 'BB', 'tracker-pa:1:1')`, [world.gameId])
  assert.ok(failure)
  assert.match(String(failure.message), /duplicate key/i)
})

test('a non-contact plate appearance has a durable identity of its own', { skip }, async (t) => {
  // The case docs/tracker-persistence-reliability.md could not cover:
  // tracker_contact_seq is null for a strikeout, a walk and a hit batter, so
  // before tracker_event_key existed they had no database identity at all and
  // were reconciled through a local journal that a lost machine takes with it.
  const { db, ...world } = await freshWorld(t)
  const first = await persist(db, 'tournament', world, {
    pa: { tracker_event_key: 'tracker-pa:1:1', result: 'K' },
  })
  const second = await persist(db, 'tournament', world, {
    pa: { tracker_event_key: 'tracker-pa:2:1', result: 'BB', character_id: world.pitcher.id },
  })
  assert.notEqual(first.pa_id, second.pa_id)
  assert.equal(first.pa_number, 1)
  assert.equal(second.pa_number, 2)

  // The same strikeout delivered twice is the same row, not a third one.
  const replay = await persist(db, 'tournament', world, {
    pa: { tracker_event_key: 'tracker-pa:1:1', result: 'K' },
  })
  assert.equal(replay.pa_id, first.pa_id)
  assert.equal(replay.inserted, false)
  assert.equal(await db.value('select count(*) from plate_appearances'), 2)
})

test('pitches, runs and every tracking fact are unique by their natural key', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const pa = await persist(db, 'tournament', world, {
    pitches: [{ game_id: world.gameId, pitch_number_pa: 1, pitch_result: 'ball' }],
    runs: [{
      game_id: world.gameId,
      scoring_player_id: world.away.id,
      scoring_character_id: world.batter.id,
    }],
  })
  const duplicatePitch = await db.fails(
    'insert into pitches (pa_id, pitch_number_pa, pitch_result) values ($1, 1, $2)',
    [pa.pa_id, 'foul'])
  assert.match(String(duplicatePitch?.message), /duplicate key/i)
  const duplicateRun = await db.fails(
    'insert into runs_scored (pa_id, scoring_player_id, scoring_character_id) values ($1, $2, $3)',
    [pa.pa_id, world.away.id, world.batter.id])
  assert.match(String(duplicateRun?.message), /duplicate key/i)

  const session = await db.one(
    `insert into tracking_sessions (competition_type, game_id, raw_stem, status)
     values ('tournament', $1, 'stem-a', 'ingesting') returning id`, [world.gameId])
  const play = await db.one(
    'insert into tracking_plays (tracking_session_id, play_ordinal) values ($1, 1) returning id',
    [session.id])
  assert.match(String((await db.fails(
    'insert into tracking_plays (tracking_session_id, play_ordinal) values ($1, 1)',
    [session.id]))?.message), /duplicate key/i)
  await db.query("insert into fielding_opportunities (tracking_play_id, position) values ($1, 'CF')", [play.id])
  assert.match(String((await db.fails(
    "insert into fielding_opportunities (tracking_play_id, position) values ($1, 'CF')",
    [play.id]))?.message), /duplicate key/i)
  await db.query(
    "insert into movement_metrics (tracking_play_id, actor_type, actor_slot) values ($1, 'fielder', 'CF')",
    [play.id])
  assert.match(String((await db.fails(
    "insert into movement_metrics (tracking_play_id, actor_type, actor_slot) values ($1, 'fielder', 'CF')",
    [play.id]))?.message), /duplicate key/i)
  await db.query('insert into tracking_throws (tracking_play_id, throw_sequence) values ($1, 1)', [play.id])
  assert.match(String((await db.fails(
    'insert into tracking_throws (tracking_play_id, throw_sequence) values ($1, 1)',
    [play.id]))?.message), /duplicate key/i)
})

test('a season game and a tournament game may share a number and stay separate', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const tournament = await persist(db, 'tournament', world, {
    pa: { tracker_event_key: 'contact:11', tracker_contact_seq: 11 },
  })
  const season = await persist(db, 'season', world, {
    pa: { tracker_event_key: 'contact:11', tracker_contact_seq: 11, season_id: 909 },
  })
  assert.equal(tournament.pa_number, 1)
  assert.equal(season.pa_number, 1, 'each table numbers its own game')
  assert.equal(await db.value('select count(*) from plate_appearances where game_id = $1', [world.gameId]), 1)
  assert.equal(await db.value('select count(*) from season_plate_appearances where game_id = $1', [world.gameId]), 1)
  assert.equal(await db.value('select season_id from season_plate_appearances where id = $1', [season.pa_id]), 909)
})

// ── the transaction ─────────────────────────────────────────────────────────

test('a plate appearance and its children commit together', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const result = await persist(db, 'tournament', world, {
    pa: { tracker_event_key: 'contact:5', tracker_contact_seq: 5, result: '1B', rbi: 1 },
    pitches: [
      { game_id: world.gameId, pitch_number_pa: 1, pitch_result: 'ball' },
      { game_id: world.gameId, pitch_number_pa: 2, pitch_result: 'in_play' },
    ],
    runs: [{
      game_id: world.gameId,
      scoring_player_id: world.away.id,
      scoring_character_id: world.batter.id,
    }],
  })
  assert.equal(result.pitches_inserted, 2)
  assert.equal(result.runs_inserted, 1)
  assert.equal(await db.value('select count(*) from pitches where pa_id = $1', [result.pa_id]), 2)
  assert.equal(await db.value('select count(*) from runs_scored where pa_id = $1', [result.pa_id]), 1)
  assert.equal(result.pa.result, '1B')
})

test('a child that cannot be written rolls the plate appearance back with it', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  // A run whose scorer is not a real player. Under the staged client writes
  // this left a committed plate appearance with a missing run -- a scoring
  // record short of a run, visible to the live feed and the stat pages.
  const failure = await db.fails(
    'select tracker_persist_plate_appearance($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8)',
    ['tournament', world.gameId, paPayload(world, { tracker_event_key: 'contact:9', result: 'HR' }),
      '[]', JSON.stringify([{
        game_id: world.gameId,
        scoring_player_id: '00000000-0000-0000-0000-000000000000',
        scoring_character_id: world.batter.id,
      }]), null, null, REPAIR],
  )
  assert.ok(failure, 'the write has to fail')
  assert.match(String(failure.message), /foreign key|violates/i)
  assert.equal(await db.value('select count(*) from plate_appearances'), 0,
    'nothing is left behind: no orphan plate appearance, no partial scoring record')
})

test('a write that commits but loses its response is not written twice', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const payload = {
    pa: { tracker_event_key: 'contact:7', tracker_contact_seq: 7, result: '2B', rbi: 2 },
    pitches: [{ game_id: world.gameId, pitch_number_pa: 1, pitch_result: 'in_play' }],
    runs: [{
      game_id: world.gameId,
      scoring_player_id: world.away.id,
      scoring_character_id: world.batter.id,
    }],
  }
  const first = await persist(db, 'tournament', world, payload)
  // The client never saw that answer -- a timeout, a dropped socket -- so it
  // asks again with the same event. The row it gets back is the row it already
  // has, and nothing new was written.
  const retry = await persist(db, 'tournament', world, payload)
  assert.equal(retry.pa_id, first.pa_id)
  assert.equal(retry.inserted, false)
  assert.equal(retry.pitches_inserted, 0)
  assert.equal(retry.runs_inserted, 0)
  assert.equal(await db.value('select count(*) from plate_appearances'), 1)
  assert.equal(await db.value('select count(*) from pitches'), 1)
  assert.equal(await db.value('select count(*) from runs_scored'), 1)
})

test('a session recorded before event keys existed is matched by its contact sequence', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  await db.query(
    `insert into plate_appearances (game_id, pa_number, result, tracker_contact_seq)
     values ($1, 1, '1B', 42)`, [world.gameId])
  const again = await persist(db, 'tournament', world, {
    pa: { tracker_event_key: 'contact:42', tracker_contact_seq: 42, result: '1B' },
  })
  assert.equal(again.inserted, false)
  assert.equal(await db.value('select count(*) from plate_appearances'), 1,
    'the older row is the same plate appearance, not a second one')
})

// ── the lease ───────────────────────────────────────────────────────────────

async function acquire(db, owner, options = {}) {
  const row = await db.one(
    'select tracker_lease_acquire($1, $2, $3, $4, $5, $6, $7, $8) as result',
    [options.competition || 'tournament', options.gameId ?? 4242, owner, options.ttl ?? 90,
      options.host || 'test-host', options.pid ?? 1234, options.label || null,
      options.takeover ?? false],
  )
  return row.result
}

test('one client holds a game and an independent client is refused', { skip }, async (t) => {
  const { db } = await freshWorld(t)
  const first = await acquire(db, 'bridge-a')
  assert.equal(first.granted, true)
  assert.equal(first.reason, 'acquired')
  assert.equal(first.lease.epoch, 1)

  const second = await acquire(db, 'bridge-b')
  assert.equal(second.granted, false)
  assert.equal(second.reason, 'held')
  assert.equal(second.lease.owner_id, 'bridge-a')
  assert.equal(await db.value('select count(*) from tracker_game_leases'), 1)
})

test('the same client renewing keeps its epoch; a takeover raises it', { skip }, async (t) => {
  const { db } = await freshWorld(t)
  const first = await acquire(db, 'bridge-a')
  const renewed = await acquire(db, 'bridge-a')
  assert.equal(renewed.reason, 'renewed')
  assert.equal(renewed.lease.epoch, first.lease.epoch)

  const taken = await acquire(db, 'bridge-b', { takeover: true })
  assert.equal(taken.granted, true)
  assert.equal(taken.reason, 'taken_over')
  assert.equal(taken.previous_owner, 'bridge-a')
  assert.equal(Number(taken.lease.epoch), Number(first.lease.epoch) + 1)
})

test('an expired lease is reclaimed by whoever asks next, under a new epoch', { skip }, async (t) => {
  const { db } = await freshWorld(t)
  const first = await acquire(db, 'bridge-a')
  // The bridge is gone -- crashed, or its machine slept -- and stopped
  // renewing. Time passing is the only thing being simulated here.
  await db.query("update tracker_game_leases set expires_at = now() - interval '1 minute'")
  const second = await acquire(db, 'bridge-b')
  assert.equal(second.granted, true)
  assert.equal(second.reason, 'reclaimed_expired')
  assert.equal(Number(second.lease.epoch), Number(first.lease.epoch) + 1)
})

test('a lease that has been taken away cannot be renewed back into existence', { skip }, async (t) => {
  const { db } = await freshWorld(t)
  const first = await acquire(db, 'bridge-a')
  await db.query("update tracker_game_leases set expires_at = now() - interval '1 minute'")
  await acquire(db, 'bridge-b')
  const renew = await db.one(
    'select tracker_lease_renew($1, $2, $3, $4, $5) as result',
    ['tournament', 4242, 'bridge-a', first.lease.epoch, 90],
  )
  assert.equal(renew.result.granted, false)
  assert.equal(renew.result.reason, 'not_the_owner')
  assert.equal(renew.result.lease.owner_id, 'bridge-b')
})

test('a stale owner cannot write, even holding a lease it once had', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const first = await acquire(db, 'bridge-a')
  await db.query("update tracker_game_leases set expires_at = now() - interval '1 minute'")
  const second = await acquire(db, 'bridge-b')

  // bridge-a wakes up believing it still owns the game. This is the failure
  // expiry alone cannot prevent, and the reason the epoch travels with the write.
  const failure = await db.fails(
    'select tracker_persist_plate_appearance($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)',
    ['tournament', world.gameId, paPayload(world), '[]', '[]', 'bridge-a', first.lease.epoch],
  )
  assert.ok(failure)
  assert.match(String(failure.message), /stale tracker lease/)
  assert.equal(await db.value('select count(*) from plate_appearances'), 0)

  // The current owner writes normally.
  const ok = await persist(db, 'tournament', world, { owner: 'bridge-b', epoch: second.lease.epoch })
  assert.equal(ok.inserted, true)
})

test('an expired lease refuses writes even when nobody else has taken it', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const lease = await acquire(db, 'bridge-a')
  await db.query("update tracker_game_leases set expires_at = now() - interval '1 second'")
  const failure = await db.fails(
    'select tracker_persist_plate_appearance($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)',
    ['tournament', world.gameId, paPayload(world), '[]', '[]', 'bridge-a', lease.lease.epoch],
  )
  assert.match(String(failure?.message), /expired tracker lease/)
})

test('a released lease is free immediately and the releaser cannot write again', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const lease = await acquire(db, 'bridge-a')
  const released = await db.one('select tracker_lease_release($1, $2, $3, $4) as result',
    ['tournament', 4242, 'bridge-a', lease.lease.epoch])
  assert.equal(released.result.released, true)
  const next = await acquire(db, 'bridge-b')
  assert.equal(next.granted, true)
  assert.match(String((await db.fails(
    'select tracker_persist_plate_appearance($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)',
    ['tournament', world.gameId, paPayload(world), '[]', '[]', 'bridge-a', lease.lease.epoch],
  ))?.message), /stale tracker lease/)
})

test('a lease is per competition, so the two 4242s are held separately', { skip }, async (t) => {
  const { db } = await freshWorld(t)
  const tournament = await acquire(db, 'bridge-a', { competition: 'tournament' })
  const season = await acquire(db, 'bridge-b', { competition: 'season' })
  assert.equal(tournament.granted, true)
  assert.equal(season.granted, true, 'the same number in the other table is a different game')
  assert.equal(await db.value('select count(*) from tracker_game_leases'), 2)
})

test('an unleased caller has to name its reason, and then repairs still work', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  await acquire(db, 'bridge-a')

  // This is the shape a bridge that has lost its lease used to produce, and it
  // is the whole defect: a null owner was read as "a backfill, a repair
  // script" and waved through, so losing the lease DISABLED fencing.
  const anonymous = await db.fails(
    'select tracker_persist_plate_appearance($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8)',
    ['tournament', world.gameId, paPayload(world), '[]', '[]', null, null, null],
  )
  assert.match(String(anonymous?.message), /unleased tracker write refused/)
  assert.equal(await db.value('select count(*) from plate_appearances'), 0)

  // A repair that says so is still allowed, which is what the route is for.
  const repair = await persist(db, 'tournament', world)
  assert.equal(repair.inserted, true)
})

// ── replacing a completed tracking session ──────────────────────────────────

async function completedSession(db, gameId, stem = 'data/player_tracking/wario_stadium-A') {
  const row = await db.one(
    `insert into tracking_sessions (competition_type, game_id, raw_stem, status, quality)
     values ('tournament', $1, $2, 'ingested', '{"plays": 57}'::jsonb) returning *`, [gameId, stem])
  await db.query('insert into tracking_plays (tracking_session_id, play_ordinal) values ($1, 1), ($1, 2)', [row.id])
  return row
}

test('a replacement is built beside the completed session, which stays active', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const original = await completedSession(db, world.gameId)
  const opened = await db.one(
    'select tracker_begin_session_replacement($1, $2::jsonb, null, null, $3) as result',
    [original.id, JSON.stringify({
      competition_type: 'tournament', game_id: world.gameId,
      raw_stem: original.raw_stem, status: 'ingesting',
    }), REPAIR],
  )
  assert.equal(opened.result.version, 2)
  assert.equal(Number(opened.result.replaces), Number(original.id))
  assert.equal(await db.value('select is_active from tracking_sessions where id = $1', [original.id]), true)
  assert.equal(await db.value('select is_active from tracking_sessions where id = $1',
    [opened.result.session_id]), false)
  assert.equal(await db.value('select count(*) from tracking_plays where tracking_session_id = $1',
    [original.id]), 2, 'the good tree is untouched while the replacement is built')
})

test('a replacement that never finishes cannot take over from a good ingest', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const original = await completedSession(db, world.gameId)
  const opened = await db.one(
    'select tracker_begin_session_replacement($1, $2::jsonb, null, null, $3) as result',
    [original.id, JSON.stringify({
      competition_type: 'tournament', game_id: world.gameId,
      raw_stem: original.raw_stem, status: 'ingesting',
    }), REPAIR],
  )
  // The ingest died halfway: status never reached 'ingested'.
  const failure = await db.fails('select tracker_activate_session_version($1, null, null, $2)',
    [opened.result.session_id, REPAIR])
  assert.match(String(failure?.message), /only a finished ingest replaces a finished ingest/)
  assert.equal(await db.value('select is_active from tracking_sessions where id = $1', [original.id]), true)
  assert.equal(await db.value('select status from tracking_sessions where id = $1', [original.id]), 'ingested')
  assert.equal(await db.value('select count(*) from tracking_plays where tracking_session_id = $1',
    [original.id]), 2)
})

test('a finished replacement takes over in one statement and the old version is kept', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const original = await completedSession(db, world.gameId)
  const opened = await db.one(
    'select tracker_begin_session_replacement($1, $2::jsonb, null, null, $3) as result',
    [original.id, JSON.stringify({
      competition_type: 'tournament', game_id: world.gameId,
      raw_stem: original.raw_stem, status: 'ingesting',
    }), REPAIR],
  )
  const replacementId = opened.result.session_id
  await db.query('insert into tracking_plays (tracking_session_id, play_ordinal) values ($1, 1)', [replacementId])
  await db.query("update tracking_sessions set status = 'ingested' where id = $1", [replacementId])
  const activated = await db.one(
    'select tracker_activate_session_version($1, null, null, $2) as result', [replacementId, REPAIR])
  assert.equal(activated.result.activated, true)
  assert.equal(Number(activated.result.superseded), Number(original.id))

  const active = await db.rows(
    'select id, version from tracking_sessions where is_active and raw_stem = $1', [original.raw_stem])
  assert.equal(active.length, 1, 'exactly one version of a stem is ever active')
  assert.equal(Number(active[0].id), Number(replacementId))
  assert.equal(Number(await db.value('select superseded_by from tracking_sessions where id = $1',
    [original.id])), Number(replacementId))
  assert.equal(await db.value('select count(*) from tracking_plays where tracking_session_id = $1',
    [original.id]), 2, 'the superseded version keeps its facts; nothing was deleted to make room')
})

test('the active version of a stem is unique, enforced by the database', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const original = await completedSession(db, world.gameId)
  const failure = await db.fails(
    `insert into tracking_sessions (competition_type, game_id, raw_stem, status, version, is_active)
     values ('tournament', $1, $2, 'ingested', 2, true)`, [world.gameId, original.raw_stem])
  assert.match(String(failure?.message), /duplicate key/i)
})

test('pruning refuses to touch the active version', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const original = await completedSession(db, world.gameId)
  const failure = await db.fails('select tracker_prune_superseded_session($1)', [original.id])
  assert.match(String(failure?.message), /it is the active version/)
  assert.equal(await db.value('select count(*) from tracking_sessions'), 1)
})

// ── unresolved plays ────────────────────────────────────────────────────────

test('an unresolved play is one row per event, and stays open until answered', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  await db.query(
    `insert into tracker_unresolved_plays
       (competition_type, game_id, tracker_event_key, reason, inning, batter_name)
     values ('tournament', $1, 'preview-pa:12:4:top:Boo', $2, 4, 'Boo')`,
    [world.gameId, 'a putout was recorded on a runner, not the batter'])
  // The same play seen again by a restarted bridge is the same row.
  const failure = await db.fails(
    `insert into tracker_unresolved_plays (competition_type, game_id, tracker_event_key, reason)
     values ('tournament', $1, 'preview-pa:12:4:top:Boo', 'seen again')`, [world.gameId])
  assert.match(String(failure?.message), /duplicate key/i)
  assert.equal(await db.value('select status from tracker_unresolved_plays'), 'open')

  // The same number in the other competition is a different game.
  await db.query(
    `insert into tracker_unresolved_plays (competition_type, game_id, tracker_event_key, reason)
     values ('season', $1, 'preview-pa:12:4:top:Boo', 'a different game entirely')`, [world.gameId])
  assert.equal(await db.value('select count(*) from tracker_unresolved_plays'), 2)
})

test('an unresolved play can only be one of the three states', { skip }, async (t) => {
  const { db, ...world } = await freshWorld(t)
  const failure = await db.fails(
    `insert into tracker_unresolved_plays (competition_type, game_id, tracker_event_key, reason, status)
     values ('tournament', $1, 'k', 'r', 'probably-a-single')`, [world.gameId])
  assert.match(String(failure?.message), /check constraint/i)
})
