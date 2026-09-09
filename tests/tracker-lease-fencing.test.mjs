// Losing a lease has to STOP writes, not switch fencing off.
//
// The defect this suite exists for: renew() set `held = false`,
// writeCredentials() then produced `{ ownerId: null, epoch: null }`, and a null
// owner was exactly what tracker_lease_assert waved through as "an unleased
// caller (a backfill, a repair script)". A bridge that had been told in so many
// words that another process owned the game went on writing plate appearances
// into it -- fencing disabled by the very event fencing exists for.
//
// So the states are distinguished here one at a time, and the two halves are
// tested together: the client's refusal (which is what stops a write that never
// reaches a fenced function -- live state, game completion, an unresolved play)
// and the database's (which is what stops one that does).

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createTrackerTestDatabase,
  databaseAvailable,
  seedCollidingGames,
} from './helpers/trackerTestDatabase.mjs'
import { createPgliteSupabase } from './helpers/pgliteSupabase.mjs'
import {
  LEASE_STATUS,
  createTrackerGameLease,
  isLeaseNotHeldError,
  unleasedTrackerCredentials,
} from '../scripts/tracker_game_lease.mjs'

const HAVE_DATABASE = await databaseAvailable()
const skip = HAVE_DATABASE
  ? false
  : 'no local Postgres: @electric-sql/pglite is not installed (npm install)'

async function world(t) {
  const db = await createTrackerTestDatabase()
  t.after(() => db.close())
  const seeded = await seedCollidingGames(db)
  return { db, supabase: createPgliteSupabase(db), ...seeded }
}

function lease(w, ownerId, options = {}) {
  return createTrackerGameLease({
    supabase: w.supabase, competitionType: 'tournament', gameId: w.gameId, ownerId, ...options,
  })
}

test('a lease taken by another owner reads as lost, and refuses every write', { skip }, async (t) => {
  const w = await world(t)
  const mine = lease(w, 'bridge-a')
  const theirs = lease(w, 'bridge-b')
  await mine.acquire()
  await theirs.acquire({ takeover: true })
  await mine.renew()

  assert.equal(mine.status, LEASE_STATUS.LOST)
  assert.equal(mine.held, false)
  // The whole defect in one assertion: this used to hand back a null owner.
  assert.throws(() => mine.writeCredentials('a scoring write'), isLeaseNotHeldError)
  // Every bridge mutation goes through the same gate, named so the log says
  // which one was refused.
  for (const what of ['the live-state publish', 'game completion',
    'recording an unresolved play', 'postgame tracking ingestion']) {
    assert.throws(() => mine.assertWritable(what), (error) => (
      isLeaseNotHeldError(error) && error.message.includes(what)
    ))
  }
  assert.equal(theirs.writeCredentials().ownerId, 'bridge-b')
})

test('released and lost are different states, and neither is unleased', { skip }, async (t) => {
  const w = await world(t)

  const released = lease(w, 'bridge-released')
  await released.acquire()
  await released.release()
  assert.equal(released.status, LEASE_STATUS.RELEASED)
  assert.throws(() => released.writeCredentials(), isLeaseNotHeldError)
  assert.match(released.state.lostReason, /released/)

  const taken = lease(w, 'bridge-taken')
  await taken.acquire()
  await lease(w, 'bridge-thief').acquire({ takeover: true })
  await taken.renew()
  assert.equal(taken.status, LEASE_STATUS.LOST)
  assert.match(taken.state.lostReason, /bridge-thief now owns this game/)
})

test('an expiry nobody claimed is renewable, because the epoch never moved', { skip }, async (t) => {
  const w = await world(t)
  const slow = lease(w, 'bridge-slow')
  const first = await slow.acquire()
  await w.db.query("update tracker_game_leases set expires_at = now() - interval '1 minute'")

  // Renewal past expiry succeeds while nobody else has taken the game, and it
  // is meant to: the epoch is the fence, not the clock, and a bridge whose
  // round trip was slow has not lost anything if no other owner appeared. What
  // an expiry does mean is that the game is now RECLAIMABLE, and the moment
  // somebody reclaims it the epoch moves and the renewal below fails instead.
  const renewed = await slow.renew()
  assert.equal(renewed.granted, true)
  assert.equal(slow.status, LEASE_STATUS.HELD)
  assert.equal(Number(renewed.lease.epoch), Number(first.lease.epoch))

  await w.db.query("update tracker_game_leases set expires_at = now() - interval '1 minute'")
  await lease(w, 'bridge-fast').acquire()
  const refused = await slow.renew()
  assert.equal(refused.granted, false)
  assert.equal(slow.status, LEASE_STATUS.LOST)
  assert.throws(() => slow.writeCredentials(), isLeaseNotHeldError)
})

test('a lease nobody renewed is expired locally, before the round trip', { skip }, async (t) => {
  const w = await world(t)
  let clock = 1_000_000
  const held = lease(w, 'bridge-asleep', { ttlSeconds: 90, now: () => clock })
  await held.acquire()
  assert.equal(held.held, true)

  // The laptop slept through the renewal timer. The database would refuse the
  // write on expiry, but nothing that does not reach a fenced function would be
  // refused at all -- so the check happens here as well.
  clock += 91_000
  assert.equal(held.status, LEASE_STATUS.EXPIRED)
  assert.throws(() => held.assertWritable('the live-state publish'), isLeaseNotHeldError)
})

test('only a database with no lease functions yields unleased credentials', { skip }, async (t) => {
  const w = await world(t)
  await w.db.query('drop function tracker_lease_acquire(text, bigint, text, integer, text, integer, text, boolean)')
  const degraded = lease(w, 'bridge-degraded')
  const claim = await degraded.acquire()

  assert.equal(claim.granted, true)
  assert.equal(claim.available, false)
  assert.equal(degraded.status, LEASE_STATUS.UNAVAILABLE)
  const credentials = degraded.writeCredentials()
  assert.equal(credentials.ownerId, null)
  // And it is not silently null: the database now refuses a null owner that
  // does not say why it has no lease, so the reason travels with the write.
  assert.match(credentials.unleasedIntent, /no tracker lease functions/)
})

test('the explicit repair route is the only other way to write unleased', { skip }, async (t) => {
  const w = await world(t)
  const repair = unleasedTrackerCredentials('backfilling a 2026-08 session by hand')
  assert.equal(repair.ownerId, null)
  assert.equal(repair.unleasedIntent, 'backfilling a 2026-08 session by hand')
  assert.throws(() => unleasedTrackerCredentials(''), /has to name its reason/)

  const { error: anonymous } = await w.supabase.rpc('tracker_lease_assert', {
    p_competition_type: 'tournament',
    p_game_id: w.gameId,
    p_owner_id: null,
    p_epoch: null,
    p_unleased_intent: null,
  })
  assert.match(String(anonymous?.message), /unleased tracker write refused/)

  const { error: stated } = await w.supabase.rpc('tracker_lease_assert', {
    p_competition_type: 'tournament',
    p_game_id: w.gameId,
    p_owner_id: null,
    p_epoch: null,
    p_unleased_intent: repair.unleasedIntent,
  })
  assert.equal(stated, null)
})

test('the assert takes a row lock, so an ownership change waits for the write', { skip }, async (t) => {
  const w = await world(t)
  const held = lease(w, 'bridge-a')
  await held.acquire()

  // WHAT THIS SHOWS AND WHAT IT DOES NOT. It shows that tracker_lease_assert
  // locks the lease row for the rest of the calling transaction -- the lock is
  // read back out of pg_locks while that transaction is still open, which a
  // plain SELECT would not produce. It does NOT show two connections being
  // serialized by it: PGlite is a single backend, so nothing in this process
  // can hold two concurrent transactions. The footer of this file says so, and
  // docs/tracker-persistence-reliability.md carries it as an open item.
  await w.db.query('begin')
  try {
    await w.db.query('select tracker_lease_assert($1, $2, $3, $4)',
      ['tournament', w.gameId, 'bridge-a', held.epoch])
    const locks = await w.db.rows(
      "select mode from pg_locks where relation = 'tracker_game_leases'::regclass")
    assert.ok(locks.some((row) => row.mode === 'RowShareLock'),
      `the lease row is locked for the writing transaction; saw ${JSON.stringify(locks)}`)
  } finally {
    await w.db.query('commit')
  }

  // And the fence itself: once the epoch has moved, the old one is refused by
  // the database even though the client would also have refused it.
  await lease(w, 'bridge-b').acquire({ takeover: true })
  const { error } = await w.supabase.rpc('tracker_lease_assert', {
    p_competition_type: 'tournament',
    p_game_id: w.gameId,
    p_owner_id: 'bridge-a',
    p_epoch: held.epoch,
    p_unleased_intent: null,
  })
  assert.match(String(error?.message), /stale tracker lease/)
})

// ── the mutations that were only ever checked on the client ─────────────────
//
// Everything above is about the lease CLIENT refusing. These are about the
// database refusing, for the four writes that never reached a fenced function:
// the live-state publish, the running score, the game completion and the
// unresolved-play record. Each was an ordinary update in front of which the
// bridge checked its own cached state, and cached state is exactly what a
// takeover invalidates without telling anyone.

const LIVE_STATS = { game_id: 4242, batting: [{ order: 1 }] }

async function fencedCalls(w, ownerId, epoch) {
  return [
    ['the live-state publish', `select tracker_publish_live_state('tournament', $1, $2::jsonb, $3::jsonb, $4, $5)`,
      [w.gameId, JSON.stringify(LIVE_STATS), JSON.stringify({ inning: 4 }), ownerId, epoch]],
    ['the running score', `select tracker_apply_game_completion('tournament', $1, $2::jsonb, $3, $4)`,
      [w.gameId, JSON.stringify({ team_a_runs: 99, team_b_runs: 99 }), ownerId, epoch]],
    ['game completion', `select tracker_apply_game_completion('tournament', $1, $2::jsonb, $3, $4)`,
      [w.gameId, JSON.stringify({ status: 'complete', team_a_runs: 99 }), ownerId, epoch]],
    ['an unresolved play', `select tracker_record_unresolved_play('tournament', $1, $2::jsonb, $3, $4)`,
      [w.gameId, JSON.stringify({
        competition_type: 'tournament', game_id: 4242, tracker_event_key: 'fenced-key',
        reason: 'no result', status: 'open',
      }), ownerId, epoch]],
  ]
}

test('a takeover BEFORE the loser renews still refuses every protected mutation', { skip }, async (t) => {
  const w = await world(t)
  const mine = lease(w, 'bridge-a')
  const theirs = lease(w, 'bridge-b')
  await mine.acquire()
  await theirs.acquire({ takeover: true })

  // THE RACE, EXACTLY. No renewal has happened, so this client's own view is
  // still `held` and its guard hands back credentials -- which is what made the
  // ordinary-update path land a score of 99 in a game bridge-b owned.
  assert.equal(mine.status, LEASE_STATUS.HELD)
  const credentials = mine.assertWritable('game completion')
  assert.equal(credentials.status, LEASE_STATUS.HELD)

  for (const [label, sql, params] of await fencedCalls(w, 'bridge-a', credentials.epoch)) {
    const error = await w.db.fails(sql, params)
    assert.match(String(error?.message), /stale tracker lease/, `${label} is refused`)
  }
  // Nothing landed. The score is what the reproduction watched change.
  assert.equal(await w.db.value('select team_a_runs from games where id = $1', [w.gameId]), 0)
  assert.equal(await w.db.value('select live_state from games where id = $1', [w.gameId]), null)
  assert.equal(Number(await w.db.value('select count(*) from tracker_live_stats')), 0)
  assert.equal(Number(await w.db.value('select count(*) from tracker_unresolved_plays')), 0)
})

test('the same four writes go through for the owner that actually holds the game', { skip }, async (t) => {
  const w = await world(t)
  const held = lease(w, 'bridge-a')
  await held.acquire()
  for (const [label, sql, params] of await fencedCalls(w, 'bridge-a', held.epoch)) {
    assert.equal(await w.db.fails(sql, params), null, `${label} is allowed`)
  }
  const game = await w.db.one('select * from games where id = $1', [w.gameId])
  assert.equal(game.team_a_runs, 99)
  assert.equal(game.status, 'complete')
  assert.deepEqual(game.live_state, { inning: 4 })
  assert.equal(Number(await w.db.value('select count(*) from tracker_live_stats')), 1)
  assert.equal(Number(await w.db.value('select count(*) from tracker_unresolved_plays')), 1)
})

test('a takeover during in-flight work invalidates the epoch the work is carrying', { skip }, async (t) => {
  const w = await world(t)
  const mine = lease(w, 'bridge-a')
  await mine.acquire()

  // The live-state publish that a bridge is part way through: the payload is
  // built, the guard has passed, and the request has not been made yet.
  const inFlight = mine.assertWritable('the live-state publish')
  assert.equal(inFlight.status, LEASE_STATUS.HELD)

  // Ownership changes while that work is in flight.
  const theirs = lease(w, 'bridge-b')
  await theirs.acquire({ takeover: true })

  // It arrives carrying the epoch it was built under and is refused, whether or
  // not this process has noticed anything.
  const error = await w.db.fails(
    `select tracker_publish_live_state('tournament', $1, $2::jsonb, $3::jsonb, 'bridge-a', $4)`,
    [w.gameId, JSON.stringify(LIVE_STATS), JSON.stringify({ inning: 9 }), inFlight.epoch])
  assert.match(String(error?.message), /stale tracker lease/)
  assert.equal(Number(await w.db.value('select count(*) from tracker_live_stats')), 0)

  // And the new owner's identical write lands.
  assert.equal(await w.db.fails(
    `select tracker_publish_live_state('tournament', $1, $2::jsonb, $3::jsonb, 'bridge-b', $4)`,
    [w.gameId, JSON.stringify(LIVE_STATS), JSON.stringify({ inning: 9 }), theirs.epoch]), null)
  assert.deepEqual(await w.db.value('select live_state from games where id = $1', [w.gameId]),
    { inning: 9 })
})

test('a protected mutation with no lease has to name why, exactly as a scoring write does', { skip }, async (t) => {
  const w = await world(t)
  await lease(w, 'bridge-a').acquire()

  const unnamed = await w.db.fails(
    `select tracker_apply_game_completion('tournament', $1, $2::jsonb, null, null, null)`,
    [w.gameId, JSON.stringify({ team_a_runs: 5 })])
  assert.match(String(unnamed?.message), /unleased tracker write refused/)

  const repair = unleasedTrackerCredentials('test: correcting a final score by hand')
  assert.equal(await w.db.fails(
    `select tracker_apply_game_completion('tournament', $1, $2::jsonb, null, null, $3)`,
    [w.gameId, JSON.stringify({ team_a_runs: 5 }), repair.unleasedIntent]), null)
  assert.equal(await w.db.value('select team_a_runs from games where id = $1', [w.gameId]), 5)
})

test('a protected mutation refuses a payload naming another game', { skip }, async (t) => {
  const w = await world(t)
  const held = lease(w, 'bridge-a')
  await held.acquire()
  const error = await w.db.fails(
    `select tracker_publish_live_state('tournament', $1, $2::jsonb, $3::jsonb, 'bridge-a', $4)`,
    [w.gameId, JSON.stringify({ game_id: 777, batting: [] }), JSON.stringify({}), held.epoch])
  assert.match(String(error?.message), /live stats name game 777/)
  assert.equal(Number(await w.db.value('select count(*) from tracker_live_stats')), 0)
})

test('the season competition resolves the season tables, not the tournament ones', { skip }, async (t) => {
  const w = await world(t)
  const seasonLease = createTrackerGameLease({
    supabase: w.supabase, competitionType: 'season', gameId: w.gameId, ownerId: 'bridge-season',
  })
  await seasonLease.acquire()
  assert.equal(await w.db.fails(
    `select tracker_publish_live_state('season', $1, $2::jsonb, $3::jsonb, 'bridge-season', $4)`,
    [w.gameId, JSON.stringify({ game_id: 4242, batting: [] }), JSON.stringify({ inning: 1 }),
      seasonLease.epoch]), null)
  // The colliding tournament game 4242 is untouched, which is the whole reason
  // the competition type travels with every call.
  assert.equal(Number(await w.db.value('select count(*) from season_tracker_live_stats')), 1)
  assert.equal(Number(await w.db.value('select count(*) from tracker_live_stats')), 0)
  assert.equal(await w.db.value('select live_state from games where id = $1', [w.gameId]), null)
})

// VERIFICATION LIMIT, stated rather than implied: every test here runs against
// one PGlite backend, so "two machines racing" is modelled as two clients
// taking turns, and "in flight" means a payload built before a takeover and
// sent after it. The fencing epoch is what makes the outcome the same either
// way -- a write carrying a superseded epoch is refused whenever it arrives --
// but two genuinely concurrent connections have still never been observed.
