// The bridge's half of "every protected mutation carries the lease".
//
// THE DEFECT. Exactly one bridge write went through a fenced database function.
// The live-state publish, the running score, the game completion and the
// unresolved-play record were ordinary PostgREST updates in front of which the
// bridge checked its OWN cached lease state:
//
//     assertLeaseWritable('game completion')          // reads cached state
//     await supabase.from('games').update({ ... })    // separate request
//
// After a takeover the losing bridge reads `held` until its next renewal, so
// that guard passed and the update landed in a game another machine owned. The
// reproduction acquired A, transferred to B, and wrote a final score of 99
// through A's guard with no error at all.
//
// The database half -- that the assert and the write are ONE transaction, and
// that the lease row is locked for its duration -- is in
// tests/tracker-lease-fencing.test.mjs against a real PostgreSQL. This is the
// client half: that the bridge takes that route, that a refusal from it stops
// the write rather than falling through to the unfenced one, and that a
// database without the migration degrades loudly instead of silently.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cleanupRunDirectories,
  makeRunDirectory,
  shutdownBridge,
  startBridge,
  waitForBridge,
} from './helpers/trackerBridgeReplay.mjs'
import { buildAcceptanceWorld, GAME_ID } from './helpers/trackerAcceptanceWorld.mjs'

test.after(() => cleanupRunDirectories())

async function bridgeOver(t, supabase, { env = {} } = {}) {
  const directory = makeRunDirectory('tracker-fenced-')
  const handle = await startBridge({
    supabase,
    directory,
    gameId: GAME_ID,
    gamesTable: 'games',
    env: { TRACKER_PLAYER_TRACKING: '0', ...env },
  })
  t.after(() => shutdownBridge(handle.bridge))
  return handle
}

const called = (client, fn) => client.rpcCalls.filter((call) => call.name === fn)

test('the live-state publish goes through the fenced function, carrying the epoch', async (t) => {
  const world = buildAcceptanceWorld()
  await bridgeOver(t, world)

  const publishes = called(world, 'tracker_publish_live_state')
  assert.ok(publishes.length >= 1, 'startup republishes live state; it is a protected mutation')
  const lease = world.db.tracker_game_leases[0]
  for (const call of publishes) {
    assert.equal(call.args.p_competition_type, 'tournament')
    assert.equal(Number(call.args.p_game_id), GAME_ID)
    assert.equal(call.args.p_owner_id, lease.owner_id)
    assert.equal(Number(call.args.p_epoch), Number(lease.epoch))
    assert.equal(call.args.p_unleased_intent, null)
  }
  // And it really wrote through it: the row exists and the game row's own
  // live_state moved with it, which is the pair the function commits together.
  assert.equal(world.db.tracker_live_stats.length, 1)
  assert.ok(world.db.games.find((row) => String(row.id) === String(GAME_ID)).live_state)
})

test('a refusal from the fenced function stops the write; it never falls back', async (t) => {
  const world = buildAcceptanceWorld()
  // Ownership moves the way a takeover moves it: the epoch changes, and this
  // bridge is still holding the old one.
  world.setRpcHandler('tracker_publish_live_state', () => ({
    data: null,
    error: {
      code: '23514',
      message: 'stale tracker lease: bridge-a epoch 1 is not the owner of tournament game 4242',
    },
  }))
  const handle = await bridgeOver(t, world)

  assert.equal(world.db.tracker_live_stats.length, 0,
    'nothing was published through the unfenced path afterwards')
  assert.ok(handle.logs.some((line) => /stale tracker lease/.test(line)),
    'and the refusal is reported rather than swallowed')
  assert.ok(!handle.logs.some((line) => /has no tracker_publish_live_state/.test(line)),
    'a refusal is not a missing function and must never be read as one')
})

test('a database without the migration degrades loudly, once', async (t) => {
  // No fenced functions at all: the deployment has not run
  // 20260909120000_tracker_fenced_game_mutations.sql. The bridge must still
  // track the game -- a migration nobody has applied is not a reason to stop
  // recording -- and must say what guarantee is missing.
  const world = buildAcceptanceWorld({ fencedMutations: false })
  const handle = await bridgeOver(t, world)

  assert.ok(called(world, 'tracker_publish_live_state').length >= 1, 'it asked')
  assert.equal(world.db.tracker_live_stats.length, 1, 'and then wrote the ordinary way')
  const warnings = handle.logs.filter(
    (line) => /Cross-machine exclusion on THOSE writes is NOT in force/.test(line))
  assert.equal(warnings.length, 1, 'said once, not once per publish')
  assert.match(warnings[0], /20260909120000_tracker_fenced_game_mutations\.sql/)
})

test('the running score is a protected mutation too, and used to have no guard at all', async (t) => {
  const world = buildAcceptanceWorld()
  // The side each scoreboard name belongs to, as a previous run of this game
  // left it. Without it a running-score line names a team the bridge cannot
  // place and no sync is triggered at all.
  world.db.tracker_live_stats.push({
    id: 1,
    game_id: GAME_ID,
    team_mapping: { 'Luigi Knights': 'A', 'Waluigi Spitballs': 'B' },
  })
  const handle = await bridgeOver(t, world)
  const tracker = handle.spawn.trackerChild()

  // The tracker's own running-score line, in the format it prints on every
  // side change: "<scoreboard name> - <runs>". Both sides, because the sync
  // only runs once both are known.
  tracker.stdout.write('12:00:00 [INFO] Luigi Knights - 3\n')
  tracker.stdout.write('12:00:00 [INFO] Waluigi Spitballs - 0\n')
  await new Promise((resolve) => setTimeout(resolve, 400))
  await Promise.allSettled(handle.bridge.pendingTrackerWork().filter(Boolean))

  const scores = called(world, 'tracker_apply_game_completion')
  assert.ok(scores.length >= 1,
    'the running score goes through the same fenced function the final score does')
  const lease = world.db.tracker_game_leases[0]
  assert.equal(scores[0].args.p_owner_id, lease.owner_id)
  assert.equal(Number(scores[0].args.p_epoch), Number(lease.epoch))
})

test('an unresolved play is recorded through the fenced function, and an operator answer stands', async (t) => {
  const world = buildAcceptanceWorld()
  world.db.tracker_unresolved_plays = [{
    id: 'already-answered',
    competition_type: 'tournament',
    game_id: GAME_ID,
    tracker_event_key: 'answered-key',
    status: 'resolved',
    reason: 'an operator supplied the result',
  }]
  await bridgeOver(t, world)

  const answer = await world.rpc('tracker_record_unresolved_play', {
    p_competition_type: 'tournament',
    p_game_id: GAME_ID,
    p_payload: {
      competition_type: 'tournament', game_id: GAME_ID,
      tracker_event_key: 'answered-key', reason: 'the tracker could not score it', status: 'open',
    },
    p_owner_id: world.db.tracker_game_leases[0].owner_id,
    p_epoch: world.db.tracker_game_leases[0].epoch,
    p_unleased_intent: null,
  })
  assert.equal(answer.data.recorded, false)
  assert.equal(answer.data.reason, 'resolved_by_operator')
  assert.equal(world.db.tracker_unresolved_plays[0].status, 'resolved')
  assert.equal(world.db.tracker_unresolved_plays[0].reason, 'an operator supplied the result')
})

// ── the odds calculation lock ───────────────────────────────────────────────
//
// THE DEFECT. publishOddsCalculationState wrote live_feed with an ordinary
// update and no fence of any kind -- not even the client-side check the other
// mutations at least had. Both of its writes are separated from the moment they
// were decided: the opening `true` waits behind the reprice debounce and the
// sync queue, and the closing `false` waits for a whole pricing pass. Either
// can land after another machine has taken the game and published its own feed,
// and this update replaces that feed wholesale with the losing bridge's copy.
//
// An odds-status publish is the one that carries live_feed WITHOUT the box
// score, which is what tells it apart from an ordinary state push here.
const oddsPublishes = (client) => client.rpcCalls.filter((call) => (
  call.name === 'tracker_publish_live_state' && !('game_info' in (call.args.p_stats || {}))))

const statsWritesAfter = (client, offset) => client.operations.slice(offset).filter(
  (op) => op.table === 'tracker_live_stats')

// startBridge captures the bridge's log only for the duration of main(), and
// every odds publish happens after it returns -- so a test that reads what the
// bridge said about one has to keep capturing.
function captureBridgeLog(t) {
  const lines = []
  const original = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  const stop = () => { console.log = original }
  t.after(stop)
  return { lines, stop }
}

// Another machine takes the game: the epoch moves and the new owner publishes
// its own feed. The losing bridge still reads `held` until its next renewal.
function takeTheGame(world, owner = 'machine-B') {
  const lease = world.db.tracker_game_leases[0]
  lease.owner_id = owner
  lease.epoch = Number(lease.epoch) + 1
  world.db.tracker_live_stats[0].live_feed = { currentOwnerMarker: owner }
  return lease
}

test('an odds status queued before a takeover is refused, not written', async (t) => {
  const world = buildAcceptanceWorld()
  const handle = await bridgeOver(t, world)
  const bridgeLog = captureBridgeLog(t)

  takeTheGame(world)
  const offset = world.operations.length
  // Both halves of the pass are attempted -- the lock and the unlock -- because
  // the `finally` that publishes `false` runs whatever the opening write did.
  // Either route counts as "it happened", so a bridge that writes the old
  // unfenced way is caught by the assertions below rather than by a timeout.
  await waitForBridge(handle.bridge, 'the queued odds status publish',
    () => oddsPublishes(world).length >= 2 || statsWritesAfter(world, offset).length >= 2,
    { timeoutMs: 15_000 })
  bridgeLog.stop()

  assert.equal(world.db.tracker_live_stats[0].live_feed.currentOwnerMarker, 'machine-B',
    "the new owner's feed is intact; the stale bridge did not overwrite it")
  assert.deepEqual(statsWritesAfter(world, offset), [],
    'and a stale-owner refusal never falls through to an ordinary update')
  const lease = world.db.tracker_game_leases[0]
  for (const call of oddsPublishes(world)) {
    assert.ok(call.args.p_owner_id, 'it wrote as its own lease owner, never unleased')
    assert.equal(call.args.p_unleased_intent, null)
    assert.notEqual(Number(call.args.p_epoch), Number(lease.epoch),
      'carrying the epoch it still believed it held, which is what refused it')
  }
  assert.ok(bridgeLog.lines.some((line) => (
    /could not publish live-odds calculation state/.test(line) && /stale tracker lease/.test(line))),
  'and the refusal is reported rather than swallowed')
})

test('a takeover during the pricing pass refuses the unlock write too', async (t) => {
  const world = buildAcceptanceWorld()
  // The takeover lands mid-run: the lock was published legitimately, and the
  // game changed hands while the prices were being calculated. The `false` that
  // follows is the write that used to arrive last and win.
  let takenOverAt = null
  const passThrough = world.rpc.bind(world)
  world.rpc = async (name, args) => {
    const answer = await passThrough(name, args)
    if (name === 'tracker_publish_live_state' && args?.p_stats?.live_feed?.oddsCalculating === true
        && takenOverAt == null) {
      takeTheGame(world)
      takenOverAt = world.operations.length
    }
    return answer
  }
  const handle = await bridgeOver(t, world)
  const bridgeLog = captureBridgeLog(t)

  await waitForBridge(handle.bridge, 'the odds status unlock',
    () => takenOverAt != null && (statsWritesAfter(world, takenOverAt).length > 0
      || oddsPublishes(world).some(
        (call) => call.args.p_stats?.live_feed?.oddsCalculating === false)),
    { timeoutMs: 15_000 })
  bridgeLog.stop()

  assert.equal(world.db.tracker_live_stats[0].live_feed.currentOwnerMarker, 'machine-B',
    'the unlock did not overwrite the new owner\'s feed')
  assert.deepEqual(statsWritesAfter(world, takenOverAt), [],
    'and nothing fell back to an unfenced update after the refusal')
  assert.ok(bridgeLog.lines.some(
    (line) => /could not publish live-odds calculation state/.test(line)))
})

test('without the migration the odds status still publishes, the ordinary way', async (t) => {
  // A deployment that has not applied the fenced-mutation migration must go on
  // publishing the lock. The guarantee it loses is stated once by the fallback
  // itself; what it must not do is stop telling the board that prices are being
  // calculated.
  const world = buildAcceptanceWorld({ fencedMutations: false })
  const handle = await bridgeOver(t, world)
  const bridgeLog = captureBridgeLog(t)

  await waitForBridge(handle.bridge, 'the ordinary odds status update',
    () => world.db.tracker_live_stats[0]?.live_feed
      && 'oddsCalculating' in world.db.tracker_live_stats[0].live_feed,
    { timeoutMs: 15_000 })
  bridgeLog.stop()
  assert.equal(world.db.tracker_live_stats[0].live_feed.oddsCalculating, false,
    'the board is unlocked again once the pass finishes')
  assert.ok(!bridgeLog.lines.some((line) => /could not publish live-odds calculation state/.test(line)),
    'a missing function is not a refusal and is not reported as one')
})

test('a write with no lease at all has to name why, and the bridge never names one', async (t) => {
  const world = buildAcceptanceWorld()
  await bridgeOver(t, world)
  // Every call the BRIDGE made carried an owner. Read before the deliberate
  // unleased call below, which is this test's other half.
  const byTheBridge = world.rpcCalls.filter((entry) => entry.name === 'tracker_publish_live_state')
  assert.ok(byTheBridge.length >= 1)
  for (const call of byTheBridge) {
    assert.ok(call.args.p_owner_id, 'the bridge always writes as its lease owner')
    assert.equal(call.args.p_unleased_intent, null)
  }

  // The database's own refusal, modelled: a null owner with no stated intent is
  // exactly what a tracker that lost its lease would look like, and is refused
  // rather than waved through as a repair script.
  const refused = await world.rpc('tracker_publish_live_state', {
    p_competition_type: 'tournament', p_game_id: GAME_ID,
    p_stats: { game_id: GAME_ID }, p_live_state: {},
    p_owner_id: null, p_epoch: null, p_unleased_intent: null,
  })
  assert.match(String(refused.error?.message), /unleased tracker write refused/)
  // ...while a caller that states one is allowed, which is the repair route.
  const repair = await world.rpc('tracker_publish_live_state', {
    p_competition_type: 'tournament', p_game_id: GAME_ID,
    p_stats: { game_id: GAME_ID }, p_live_state: { repaired: true },
    p_owner_id: null, p_epoch: null,
    p_unleased_intent: 'test: repairing a live feed by hand',
  })
  assert.equal(repair.error, null)
})
