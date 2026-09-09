// The handshake that releases a held game has to say what actually came up.
//
// THE DEFECT. launchTracker() spawned the executable and main() wrote the
// readers file on the next line:
//
//     launchTracker()
//     announceReadersReady(attached)   // trackerStarted: true, unconditionally
//
// Nothing waited for the process to start, let alone to attach to Dolphin. An
// ENOENT on the tracker .exe produced a file saying both readers were up, and
// scripts/mss_autoteam.py -- which checked only that the file EXISTED --
// resumed a live match that nothing was scoring. The whole hold, which exists
// to protect the opening play, released into a game with no scoring reader at
// all.
//
// So there are two halves here and both are tested: the bridge waits for the
// tracker's own statement that it is attached and publishes a named outcome,
// and the gameplay controller reads that outcome. The controller half is
// tests/gameplay_hold_test.py; this is the bridge half.
//
// WHAT IS STILL NOT ESTABLISHED HERE, stated rather than implied: the tracker
// child in these tests is tests/helpers/trackerBridgeReplay.mjs's ReplayChild,
// so "the real sluggers-stat-tracker prints `Dolphin hooked.` on startup" is
// evidence from the recorded sessions in the acceptance fixtures, not from this
// suite. The footer of this file says what a real game still has to confirm.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  cleanupRunDirectories,
  isCollectorSpawn,
  makeRunDirectory,
  shutdownBridge,
  startBridge,
} from './helpers/trackerBridgeReplay.mjs'
import { buildAcceptanceWorld, GAME_ID } from './helpers/trackerAcceptanceWorld.mjs'

test.after(() => cleanupRunDirectories())

// The tracker's first line of output, in the format the real executable prints
// it -- see the recorded sessions the acceptance suite replays.
const HOOKED = '13:10:49 [INFO] Dolphin hooked.'

/**
 * Start a bridge whose gameplay is held, and give the test the readers file.
 *
 * `script` is called with the tracker child's spawn entry and decides what that
 * child does: print its hook line, die, fail to start, or nothing at all.
 */
async function handshake(t, { script = null, env = {}, onModule = null } = {}) {
  const directory = makeRunDirectory('tracker-handshake-')
  const readersPath = path.join(directory, 'run.live.readers')
  const handle = await startBridge({
    supabase: buildAcceptanceWorld(),
    directory,
    gameId: GAME_ID,
    gamesTable: 'games',
    onModule,
    env: {
      TRACKER_PLAYER_TRACKING: '0',
      TRACKER_LAUNCH_READERS: readersPath,
      TRACKER_SCORING_READY_TIMEOUT_MS: '250',
      ...env,
    },
    onSpawn(entry) {
      if (isCollectorSpawn(entry)) return
      script?.(entry)
    },
  })
  t.after(() => shutdownBridge(handle.bridge))
  return {
    ...handle,
    readers: JSON.parse(fs.readFileSync(readersPath, 'utf8')),
    said: (pattern) => handle.logs.some((line) => pattern.test(line)),
  }
}

test('the tracker saying it is attached is what "ready" means', async (t) => {
  const run = await handshake(t, {
    script: (entry) => entry.child.stdout.write(`${HOOKED}\n`),
  })
  assert.equal(run.readers.status, 'ready')
  assert.equal(run.readers.trackerStarted, true)
  assert.equal(run.readers.scoringReader, 'ready')
  assert.equal(run.readers.scoringReason, null)
  assert.ok(run.said(/both readers up/))
})

test('a reader that takes its time is waited for, not raced', async (t) => {
  const run = await handshake(t, {
    env: { TRACKER_SCORING_READY_TIMEOUT_MS: '5000' },
    // Later than the tick main() would otherwise have published on: the whole
    // point of the hold is that this wait is real.
    script: (entry) => setTimeout(() => entry.child.stdout.write(`${HOOKED}\n`), 120),
  })
  assert.equal(run.readers.status, 'ready')
  assert.ok(run.readers.scoringWaitedMs >= 100,
    `the hold lasted ${run.readers.scoringWaitedMs}ms, so it was not released early`)
})

test('an executable that fails to start is published as failed, not as ready', async (t) => {
  const run = await handshake(t, {
    script: (entry) => setImmediate(() => entry.child.emit(
      'error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))),
  })
  // The exact reproduction: this file used to say trackerStarted: true.
  assert.equal(run.readers.status, 'failed')
  assert.equal(run.readers.trackerStarted, false)
  assert.equal(run.readers.scoringReader, 'spawn_failed')
  assert.match(run.readers.scoringReason, /ENOENT/)
  assert.ok(run.said(/NOTHING WILL SCORE THIS GAME/))
  assert.ok(!run.said(/both readers up/), 'and never claims both readers are up')
})

test('a tracker that starts and dies before attaching is failed too', async (t) => {
  const run = await handshake(t, {
    script: (entry) => setImmediate(() => entry.child.exit(3)),
  })
  assert.equal(run.readers.status, 'failed')
  assert.equal(run.readers.trackerStarted, false)
  assert.equal(run.readers.scoringReader, 'exited')
  assert.match(run.readers.scoringReason, /exited with code 3/)
})

test('a reader that never says anything is unconfirmed, and the game is still released', async (t) => {
  const run = await handshake(t, { env: { TRACKER_SCORING_READY_TIMEOUT_MS: '80' } })
  // Running, unproven. Not 'failed' -- the process is alive and may attach yet
  // -- and not 'ready', because nothing has said so.
  assert.equal(run.readers.status, 'unconfirmed')
  assert.equal(run.readers.trackerStarted, true)
  assert.equal(run.readers.scoringReader, 'timeout')
  assert.match(run.readers.scoringReason, /did not report attaching/)
  assert.ok(run.said(/has NOT said it attached/))
})

test('a bridge stopped mid-handshake publishes cancelled rather than nothing', async (t) => {
  let bridge = null
  const run = await handshake(t, {
    onModule: (module) => { bridge = module },
    env: { TRACKER_SCORING_READY_TIMEOUT_MS: '10000' },
    // Stopped while the wait is running -- a Ctrl+C during startup. The file
    // still has to appear: whatever is holding the pause menu is waiting on it,
    // and leaving a live match paused is the one outcome worse than a bad one.
    script: () => setTimeout(() => bridge.stopTrackerBridge(), 30),
  })
  assert.equal(run.readers.status, 'cancelled')
  assert.equal(run.readers.trackerStarted, false)
  assert.equal(run.readers.scoringReader, 'cancelled')
  assert.ok(run.readers.scoringWaitedMs < 10000, 'and does not sit out the timeout')
})

test('a bridge with nothing holding gameplay does not wait for a handshake nobody reads', async (t) => {
  const directory = makeRunDirectory('tracker-handshake-none-')
  const started = Date.now()
  const handle = await startBridge({
    supabase: buildAcceptanceWorld(),
    directory,
    gameId: GAME_ID,
    gamesTable: 'games',
    // No TRACKER_LAUNCH_READERS: a standalone `npm run tracker:bridge`.
    env: { TRACKER_PLAYER_TRACKING: '0', TRACKER_SCORING_READY_TIMEOUT_MS: '10000' },
  })
  t.after(() => shutdownBridge(handle.bridge))
  assert.ok(Date.now() - started < 5000,
    'startup is not delayed by a wait whose answer would go to nobody')
  assert.ok(!handle.logs.some((line) => /waiting for the scoring reader/.test(line)))
})

// WHAT A REAL GAME STILL HAS TO CONFIRM. Everything above drives the bridge's
// side of the handshake with a scripted child. The remaining claim -- that the
// real sluggers-stat-tracker build in use prints a line matching
// SCORING_READER_ATTACHED_RE promptly after launch, so that the hold costs a
// fraction of a second rather than the full timeout -- can only be established
// by launching one game through scripts/mss_autogame.mjs and reading the
// readers file and autoteam's own resume marker. docs/tracker-launcher-
// orchestration.md carries it as an open item.
