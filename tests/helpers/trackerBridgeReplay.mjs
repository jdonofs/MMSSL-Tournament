// Drives the REAL bridge (scripts/live_tracker_bridge.mjs) over a saved
// tracker session log.
//
// Nothing here re-implements the bridge. The saved log lines are written into
// the stdout of the child the bridge itself spawned, so they arrive through
// the same readline the tracker .exe feeds: handleTrackerLogLine ->
// applyTrackerPreviewMessage -> applyLogMessage -> enqueuePlayEvent ->
// processPlayEvent -> finalizeCurrentPaIfAny -> the scoring persistence, the
// live-state publisher, the odds sync and finalizeTrackerGame. The only things
// injected are the database client and `spawn`.
//
// Each run gets its OWN module instance (`?run=n` on the import specifier).
// The bridge keeps a whole game in module-level state -- the parser's inning,
// the current PA buffer, the play-event chain -- so a second game in the same
// process has to be a second module, exactly as it is a second process in
// real life.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

let runCounter = 0

// A child that behaves like the tracker .exe in the two ways the bridge uses:
// line-oriented stdout, and an exit that means the game is over. `stdout` is
// always a pipe here because the bridge always reads one.
class ReplayChild extends EventEmitter {
  constructor(command) {
    super()
    this.command = command
    this.pid = 60000 + (runCounter += 1)
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.exitCode = null
    this.killed = false
  }

  kill() {
    this.killed = true
    return true
  }

  exit(code = 0) {
    if (this.exitCode !== null) return this
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, null)
    return this
  }
}

/**
 * `onSpawn` is how a test scripts a child the bridge starts and then WAITS on.
 *
 * The 60 Hz collector is the case that needs it: the bridge now holds the
 * tracker .exe until that child prints its recording evidence, so a replay
 * that only creates the child would sit out the whole capture-ready timeout
 * inside main(). It is called with the same {command, args, options, child}
 * entry that lands in `children`.
 */
export function createReplaySpawner(onSpawn = null) {
  const children = []
  const spawn = (command, args = [], options = {}) => {
    const child = new ReplayChild(command)
    const entry = { command, args: [...args], options, child }
    children.push(entry)
    onSpawn?.(entry)
    return child
  }
  spawn.children = children
  spawn.trackerChild = () => {
    const tracker = children.filter((entry) => /sluggers-stat-tracker/i.test(entry.command))
    if (tracker.length !== 1) throw new Error(`expected one tracker child, got ${tracker.length}`)
    return tracker[0].child
  }
  spawn.collectorChild = () => children.find(
    (entry) => entry.args.some((arg) => String(arg).includes('collect_player_tracking')))?.child || null
  return spawn
}

/** True for the child that is the 60 Hz collector rather than the tracker. */
export function isCollectorSpawn(entry) {
  return entry.args.some((arg) => String(arg).includes('collect_player_tracking'))
}

// Every line of a saved session log except the harness header the preview
// writer prepends ("[tracker-preview] session started ..."). The tracker .exe
// never emits that line, so replaying it would be feeding the parser something
// no real run produces.
export function readTrackerLogLines(logPath) {
  return fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter((line, index) => line.length && !(index === 0 && line.startsWith('[tracker-preview]')))
}

export function acceptanceEnv(directory, overrides = {}) {
  return {
    // No sign-in, no real endpoint: an injected client is used instead. These
    // still have to be syntactically present for module-level config.
    VITE_SUPABASE_URL: 'http://127.0.0.1:1/acceptance-never-called',
    VITE_SUPABASE_ANON_KEY: 'acceptance-anon-key',
    TRACKER_BRIDGE_EMAIL: 'acceptance@example.invalid',
    TRACKER_BRIDGE_PASSWORD: 'acceptance',
    // Nothing is spawned for real, but the module still resolves a path.
    TRACKER_EXE_PATH: path.join(directory, 'sluggers-stat-tracker-acceptance.exe'),
    // An empty directory the watcher will never see a workbook in. The real
    // workbook for these recordings is the acceptance test's oracle and is
    // deliberately kept out of the bridge's input.
    TRACKER_OUTPUT_DIR: path.join(directory, 'output'),
    TRACKER_BRIDGE_STATE_DIR: path.join(directory, 'journal'),
    TRACKER_PLAYER_TRACKING_DIR: path.join(directory, 'player_tracking'),
    // The 60 Hz sidecar reads Dolphin's memory; there is none. Postgame
    // ingestion of the recorded capture is run explicitly by the test through
    // the same ingestPlayerTrackingSession() the bridge would call.
    TRACKER_PLAYER_TRACKING: '0',
    // Writing a session log here would add a file to the recordings directory.
    TRACKER_BRIDGE_SESSION_LOG: '0',
    TRACKER_BRIDGE_PREVIEW_PORT: '0',
    TRACKER_GAME_ID: String(overrides.gameId ?? ''),
    TRACKER_GAME_TABLE: overrides.gamesTable || '',
    ...overrides.env,
  }
}

const runDirectories = []

// Every directory a replay was given, so a finished suite leaves none behind.
// They are not removed as each run ends: the restart variant deliberately
// reuses one, and the journal inside it is read after the second run.
export function cleanupRunDirectories() {
  while (runDirectories.length) {
    fs.rmSync(runDirectories.pop(), { recursive: true, force: true })
  }
}

export function makeRunDirectory(prefix = 'tracker-acceptance-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  runDirectories.push(directory)
  fs.mkdirSync(path.join(directory, 'output'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'journal'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'player_tracking'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'sluggers-stat-tracker-acceptance.exe'), 'not an executable')
  return directory
}

// The bridge reads its configuration at module-evaluation time, which happens
// while the dynamic import is still pending -- so the restore has to wait for
// the import to resolve, not merely for the call to return.
async function withEnv(values, fn) {
  const previous = {}
  Object.entries(values).forEach(([key, value]) => {
    previous[key] = process.env[key]
    if (value === '') delete process.env[key]
    else process.env[key] = value
  })
  try {
    return await fn()
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  }
}

/**
 * Start one bridge instance against an injected database.
 *
 * Returns the module (so a caller can drain its work), the tracker child whose
 * stdout is the log feed, and helpers for feeding and finishing.
 */
export async function startBridge({
  supabase, directory, gameId, gamesTable, env = {}, quiet = true, onSpawn = null,
  // Called with the freshly imported bridge module BEFORE main() runs, so a
  // test can reach an exported function of the run it is about to start --
  // stopping the bridge mid-startup, for one, which cannot be done from a
  // handle main() has not returned yet.
  onModule = null,
}) {
  // A real run is one bridge in one process; a suite is a dozen bridges in
  // one, each registering its own SIGINT/SIGTERM shutdown. The warning that
  // produces is about this harness, not about the bridge, so it is turned off
  // here rather than by weakening the bridge's own cleanup.
  process.setMaxListeners(Math.max(process.getMaxListeners(), 64))
  const spawn = createReplaySpawner(onSpawn)
  const bridge = await withEnv(acceptanceEnv(directory, { gameId, gamesTable, env }), () => (
    import(`../../scripts/live_tracker_bridge.mjs?run=${runCounter + 1}`)
  ))
  onModule?.(bridge)
  const logs = []
  const originalLog = console.log
  if (quiet) console.log = (...args) => { logs.push(args.join(' ')) }
  try {
    await bridge.main({ supabase, spawn, lockDirectory: path.join(directory, 'locks') })
  } finally {
    if (quiet) console.log = originalLog
  }
  return { bridge, spawn, logs, child: spawn.trackerChild() }
}

/**
 * Write saved log lines into the tracker child's stdout, one at a time, and
 * let the bridge's own readline split them. `chunk` lines are written before
 * yielding to the event loop so the serialized play-event chain gets to run;
 * the bridge is asynchronous behind a synchronous parser and a replay that
 * never yields would only ever measure the parser.
 */
export async function feedLines(child, lines, { chunk = 250, onProgress = null } = {}) {
  for (let index = 0; index < lines.length; index += chunk) {
    const slice = lines.slice(index, index + chunk)
    child.stdout.write(`${slice.join('\n')}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    onProgress?.(Math.min(index + chunk, lines.length), lines.length)
  }
  // readline delivers on newline; give it a turn to emit the tail.
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Wait until a condition the bridge drives becomes true, draining its queues
 * between checks so pending writes actually make progress.
 */
export async function waitForBridge(bridge, label, predicate, { timeoutMs = 120_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await Promise.allSettled(bridge.pendingTrackerWork().filter(Boolean))
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** The tracker exiting is what tells the bridge the game is over. */
export async function endTrackerProcess(bridge, child) {
  child.exit(0)
  await new Promise((resolve) => setImmediate(resolve))
  await Promise.allSettled(bridge.pendingTrackerWork().filter(Boolean))
}

export async function shutdownBridge(bridge) {
  await Promise.allSettled(bridge.pendingTrackerWork().filter(Boolean))
  await bridge.stopTrackerBridge()
}

// Kept so a caller can prove the harness parsed the same lines the bridge did
// rather than a filtered subset.
export function countLogLines(lines) {
  const counts = { total: lines.length, ballSamples: 0, parsed: 0 }
  for (const line of lines) {
    if (line.includes('[TRACKER_BALL_SAMPLE]')) counts.ballSamples += 1
    else counts.parsed += 1
  }
  return counts
}

export { readline }
