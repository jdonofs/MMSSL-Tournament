// A replacement tracking version must be invisible until it is finished.
//
// The versioning migration already built the replacement beside the completed
// one and moved the active pointer last. What it did not do was hold back the
// links: the ingest wrote `plate_appearances.tracking_session_id` and the
// runner/double-play `tracking_play_id` the moment each play was staged, so a
// replacement that failed halfway left OFFICIAL rows pointing into an
// unfinished version while the previous version was still the active one. Both
// halves of "the previous valid session survives" have to be true, and only one
// of them was.
//
// The links now travel with the activation and land in the same transaction as
// the pointer move. This suite is the database half of that, against a real
// PostgreSQL; the client half -- that the ingest stages instead of writing --
// is in tests/tracker-ingestion-reliability.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createTrackerTestDatabase,
  databaseAvailable,
  seedCollidingGames,
} from './helpers/trackerTestDatabase.mjs'
import { createPgliteSupabase } from './helpers/pgliteSupabase.mjs'
import {
  onlyActiveTrackingFacts,
  supersededTrackingPlayIds,
} from '../src/utils/activeTrackingVersions.js'

const HAVE_DATABASE = await databaseAvailable()
const skip = HAVE_DATABASE
  ? false
  : 'no local Postgres: @electric-sql/pglite is not installed (npm install)'

const REPAIR = 'test: replacing a session by hand'
const STEM = 'data/player_tracking/wario_stadium-A'

/**
 * A game with one recorded plate appearance, one completed tracking version
 * measuring it, and the official rows that point at that version.
 */
async function replacedWorld(t) {
  const db = await createTrackerTestDatabase()
  t.after(() => db.close())
  const seeded = await seedCollidingGames(db)
  const supabase = createPgliteSupabase(db)

  const pa = await db.one(
    `insert into plate_appearances (game_id, pa_number, result, player_id, character_id)
     values ($1, 1, '1B', $2, $3) returning *`, [seeded.gameId, seeded.away.id, seeded.batter.id])
  const original = await db.one(
    `insert into tracking_sessions (competition_type, game_id, raw_stem, status, quality)
     values ('tournament', $1, $2, 'ingested', '{"plays": 1}'::jsonb) returning *`,
    [seeded.gameId, STEM])
  const originalPlay = await db.one(
    `insert into tracking_plays (tracking_session_id, competition_type, game_id, pa_id,
                                 play_ordinal, contact_frame)
     values ($1, 'tournament', $2, $3, 1, 100) returning *`,
    [original.id, seeded.gameId, pa.id])
  await db.query(
    `insert into fielding_opportunities (tracking_play_id, competition_type, game_id, pa_id, position)
     values ($1, 'tournament', $2, $3, 'CF')`, [originalPlay.id, seeded.gameId, pa.id])
  await db.query('update plate_appearances set tracking_session_id = $1, tracking_contact_frame = 100 where id = $2',
    [original.id, pa.id])
  const runner = await db.one(
    `insert into runner_opportunities (competition_type, game_id, pa_id, origin_base, target_base,
                                       tracking_play_id, runner_speed_mps)
     values ('tournament', $1, $2, 'first', 'second', $3, 5.5) returning *`,
    [seeded.gameId, pa.id, originalPlay.id])
  const dp = await db.one(
    `insert into double_play_opportunities (competition_type, game_id, pa_id, tracking_play_id)
     values ('tournament', $1, $2, $3) returning *`, [seeded.gameId, pa.id, originalPlay.id])

  const opened = await db.one(
    'select tracker_begin_session_replacement($1, $2::jsonb, null, null, $3) as result',
    [original.id, JSON.stringify({
      competition_type: 'tournament', game_id: seeded.gameId, raw_stem: STEM, status: 'ingesting',
    }), REPAIR])
  const replacementId = Number(opened.result.session_id)
  // The replacement's own facts, staged exactly as the ingest stages them:
  // its own plays and its own fielding rows, and NOTHING pointing at it from
  // an official row.
  const replacementPlay = await db.one(
    `insert into tracking_plays (tracking_session_id, competition_type, game_id, pa_id,
                                 play_ordinal, contact_frame)
     values ($1, 'tournament', $2, $3, 1, 137) returning *`,
    [replacementId, seeded.gameId, pa.id])
  await db.query(
    `insert into fielding_opportunities (tracking_play_id, competition_type, game_id, pa_id, position)
     values ($1, 'tournament', $2, $3, 'CF')`, [replacementPlay.id, seeded.gameId, pa.id])

  return { db, supabase, ...seeded, pa, original, originalPlay, replacementId, replacementPlay, runner, dp }
}

async function officialLinks(w) {
  return {
    pa: await w.db.one('select tracking_session_id, tracking_contact_frame from plate_appearances where id = $1',
      [w.pa.id]),
    runner: await w.db.one('select tracking_play_id, runner_speed_mps from runner_opportunities where id = $1',
      [w.runner.id]),
    dp: await w.db.one('select tracking_play_id from double_play_opportunities where id = $1', [w.dp.id]),
  }
}

test('a replacement that never finishes leaves every official link on the good version', { skip }, async (t) => {
  const w = await replacedWorld(t)
  // The ingest died before it could mark the version finished.
  const failure = await w.db.fails('select tracker_activate_session_version($1, null, null, $2)',
    [w.replacementId, REPAIR])
  assert.match(String(failure?.message), /only a finished ingest replaces a finished ingest/)

  const links = await officialLinks(w)
  assert.equal(Number(links.pa.tracking_session_id), Number(w.original.id))
  assert.equal(Number(links.pa.tracking_contact_frame), 100)
  assert.equal(Number(links.runner.tracking_play_id), Number(w.originalPlay.id))
  assert.equal(Number(links.dp.tracking_play_id), Number(w.originalPlay.id))
  assert.equal(await w.db.value('select is_active from tracking_sessions where id = $1', [w.original.id]), true)
  assert.equal(await w.db.value('select count(*) from tracking_plays where tracking_session_id = $1',
    [w.original.id]), 1, 'and the good version still has its facts')
})

test('activation moves the pointer and every official link in one transaction', { skip }, async (t) => {
  const w = await replacedWorld(t)
  await w.db.query("update tracking_sessions set status = 'ingested' where id = $1", [w.replacementId])
  const activated = await w.db.one(
    'select tracker_activate_session_version($1, null, null, $2, $3::jsonb) as result',
    [w.replacementId, REPAIR, JSON.stringify({
      runner_opportunities: [{ id: Number(w.runner.id), runner_x: 1.5, runner_z: -2.5, runner_speed_mps: 6.25, tracking_throw_id: null }],
    })])

  assert.equal(activated.result.activated, true)
  assert.equal(Number(activated.result.plate_appearances_relinked), 1)
  assert.equal(Number(activated.result.runner_opportunities_relinked), 1)
  assert.equal(Number(activated.result.double_play_opportunities_relinked), 1)

  const links = await officialLinks(w)
  assert.equal(Number(links.pa.tracking_session_id), Number(w.replacementId))
  assert.equal(Number(links.pa.tracking_contact_frame), 137, "the replacement's own measurement")
  assert.equal(Number(links.runner.tracking_play_id), Number(w.replacementPlay.id))
  assert.equal(Number(links.runner.runner_speed_mps), 6.25, 'and the measured half it carried')
  assert.equal(Number(links.dp.tracking_play_id), Number(w.replacementPlay.id))
  // Nothing was deleted to make room.
  assert.equal(await w.db.value('select count(*) from tracking_plays'), 2)
})

test('a successful replacement counts each play exactly once', { skip }, async (t) => {
  const w = await replacedWorld(t)
  await w.db.query("update tracking_sessions set status = 'ingested' where id = $1", [w.replacementId])
  await w.db.query('select tracker_activate_session_version($1, null, null, $2)', [w.replacementId, REPAIR])

  // Both versions' facts are on disk -- superseded ones are kept as history --
  // so the reader is what decides. Every page and the recomputation now filter
  // through this pair.
  const sessions = await w.db.rows('select id, is_active from tracking_sessions')
  const plays = await w.db.rows('select id, tracking_session_id from tracking_plays')
  const opportunities = await w.db.rows('select id, tracking_play_id from fielding_opportunities')
  assert.equal(opportunities.length, 2, 'the raw table really does hold both versions')

  const superseded = supersededTrackingPlayIds(sessions, plays)
  const active = onlyActiveTrackingFacts(opportunities, superseded)
  assert.equal(active.length, 1, 'but only the active version is counted')
  assert.equal(String(active[0].tracking_play_id), String(w.replacementPlay.id))
})

test('a lost activation response is safe to repeat', { skip }, async (t) => {
  const w = await replacedWorld(t)
  await w.db.query("update tracking_sessions set status = 'ingested' where id = $1", [w.replacementId])
  const links = { runner_opportunities: [{ id: Number(w.runner.id), runner_speed_mps: 6.25 }] }
  await w.db.query('select tracker_activate_session_version($1, null, null, $2, $3::jsonb)',
    [w.replacementId, REPAIR, JSON.stringify(links)])

  // The response never arrived, so the ingest runs the same call again.
  const again = await w.db.one(
    'select tracker_activate_session_version($1, null, null, $2, $3::jsonb) as result',
    [w.replacementId, REPAIR, JSON.stringify(links)])
  assert.equal(again.result.activated, false)
  assert.equal(again.result.reason, 'already_active')
  assert.equal(await w.db.value(
    'select count(*) from tracking_sessions where is_active and raw_stem = $1', [STEM]), 1)
  const after = await officialLinks(w)
  assert.equal(Number(after.pa.tracking_session_id), Number(w.replacementId))
  assert.equal(Number(after.runner.runner_speed_mps), 6.25,
    'and the measured half is reapplied rather than assumed to have landed')
})

test('an unleased activation still has to name its reason', { skip }, async (t) => {
  const w = await replacedWorld(t)
  await w.db.query("update tracking_sessions set status = 'ingested' where id = $1", [w.replacementId])
  const anonymous = await w.db.fails('select tracker_activate_session_version($1)', [w.replacementId])
  assert.match(String(anonymous?.message), /unleased tracker write refused/)
  assert.equal(await w.db.value('select is_active from tracking_sessions where id = $1',
    [w.original.id]), true)
})
