// Local, read-only one-at-bat preview. This process never creates a Supabase
// client and never writes a game row; it only launches the patched tracker,
// parses stdout in memory, and exposes the latest snapshot on localhost.
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import {
  applyTrackerPreviewMessage,
  clearTrackerPreviewAtBats,
  createTrackerPreviewState,
  setTrackerPreviewCaptureHealth,
} from './tracker_preview_state.mjs'
import { createTrackerPreviewServer } from './tracker_preview_server.mjs'
import { createTrackerSessionLog } from './tracker_session_log.mjs'
import { annotationPathFor } from './tracker_annotations.mjs'
import { applyCollectorLine, collectorEvidenceArgs } from './tracker_collector_feed.mjs'

const env = { ...process.env }
// v26 widened the ball-object scan to the whole object. v25 and earlier search
// only +0x300..+0x700, and the coordinate field moved to 0x720 on 2026-08-17 --
// on those builds nothing tracks at all, silently.
// v27 keeps that scan and changes every real-world conversion to 1 metre/unit.
// v28 stops reading the dead-ball coordinate reset as the place a fly ball was
// caught, which put 11 of one Daisy Cruiser session's outfield catches 3 feet
// from home plate.
const DEFAULT_EXE = path.resolve('sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v28.exe')
const EXE_PATH = path.resolve(env.TRACKER_EXE_PATH || DEFAULT_EXE)
const PORT = Number(env.TRACKER_PREVIEW_PORT || 4317)
const state = createTrackerPreviewState()
// Until a park is resolved there is nothing to launch a collector against, and
// the console must not report that as "any moment now". launchCollector()
// replaces this the moment one is known.
setTrackerPreviewCaptureHealth(state, {
  status: 'waiting',
  note: 'waiting for the first live matchup; the stadium will be read from game memory automatically',
})

if (!fs.existsSync(EXE_PATH)) throw new Error(`Tracker executable not found at ${EXE_PATH}`)

// Everything this server answers lives in tracker_preview_server.mjs, shared
// with the live Supabase bridge so both expose the identical at-bat view.
const server = createTrackerPreviewServer({
  state,
  port: PORT,
  onStadiumChange: () => noteStadium(),
  onCalibrationRecord: (line) => {
    console.log(line)
    sessionLog.writeRecord(line)
  },
  // Flags land beside this session's log, which is the only artefact a
  // read-only preview leaves behind. Named for the session so two previews on
  // the same day do not share a file.
  annotationPath: () => annotationPathFor(
    state.playerTracking?.capture?.stem
      || String(SESSION_LOG_PATH).replace(/\.log$/, ''),
  ),
  onAnnotation: (record, filePath) => {
    console.log(`[tracker-preview] flagged PA ${record.pa_number} `
      + `(${record.categories.join(', ')}) -> ${filePath}`)
  },
  onShutdown: () => shutdown(),
})

// --- the 60 Hz collector, with no database anywhere near it -------------------
//
// WHY THIS PROCESS RUNS ONE. A test game exists to gather fielding and
// baserunning data and to check that the tracker understood it. Both halves of
// that need the collector: it produces the routes, contacts, throws and splits,
// and without it the console can only validate pitching and batting.
//
// The bridge also runs a collector, but it is a Supabase writer -- it needs a
// games row, and it records plate appearances as it goes. This process still
// creates no Supabase client and writes no database row. What it leaves behind
// is exactly what an advanced-metrics dataset is made of:
//
//   <stem>.bin / .json     the raw capture. AUTHORITATIVE.
//   <stem>.live.jsonl      plays as they were derived live
//   <stem>.plays.jsonl     the authoritative postgame derivation, run on exit
//   <stem>.annotations.jsonl   anything flagged in the console
//
// Loading those into Supabase later is a separate, deliberate act:
//   node scripts/ingest_player_tracking.mjs --session <stem> --game-id N ...
//
// WHICH PARK. The collector needs one at start-up for fence geometry, and the
// tracker often never prints a stadium line. So: TRACKER_PARK if set, otherwise
// whatever the tracker or the operator's stadium picker has resolved by the
// time the first pitch arrives. The collector re-checks the game's own stadium
// byte and overrides a wrong guess where it recognises the park, so this is a
// seed rather than an assertion.
const PLAYER_TRACKING_ENABLED = env.TRACKER_PLAYER_TRACKING !== '0'
const PLAYER_TRACKING_PYTHON = env.TRACKER_PLAYER_PYTHON || 'python'
const PLAYER_TRACKING_DIR = path.resolve(env.TRACKER_PLAYER_TRACKING_DIR || 'data/player_tracking')
const PARK_OVERRIDE = env.TRACKER_PARK || null

let collector = null
let derivation = null
let collectorStem = null
let collectorStopPath = null
let collectorManifestPath = null

function collectorPark() {
  return PARK_OVERRIDE || state.stadiumKey || 'auto'
}

function runPostCapture(command, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: process.cwd(), windowsHide: true })
    readline.createInterface({ input: proc.stdout })
      .on('line', (line) => console.log(`[${label}] ${line}`))
    readline.createInterface({ input: proc.stderr })
      .on('line', (line) => console.log(`[${label}] ${line}`))
    proc.on('error', reject)
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`))))
  })
}

// Calibrate and derive, and STOP. Ingest is deliberately not run here: it is
// the step that writes to Supabase, and this process's whole promise is that it
// does not. The .plays.jsonl it leaves is what ingest would have read.
function readCollectorManifest() {
  if (!collectorManifestPath || !fs.existsSync(collectorManifestPath)) return null
  try {
    return JSON.parse(fs.readFileSync(collectorManifestPath, 'utf8'))
  } catch {
    return null
  }
}

async function derivePlayerTrackingCapture() {
  const manifest = readCollectorManifest()
  if (!manifest) {
    console.log('[tracker-preview] the collector exited without a readable manifest; nothing to derive')
    return
  }
  if (manifest.status !== 'captured' || !manifest.stem) {
    console.log(`[tracker-preview] capture did not finish cleanly (status=${manifest.status || 'unknown'});`
      + ' the .bin is on disk and can be derived by hand')
    return
  }
  console.log('[tracker-preview] deriving the authoritative pass over the raw capture...')
  await runPostCapture(PLAYER_TRACKING_PYTHON,
    [path.resolve('scripts/calibrate_player_tracking.py'), manifest.stem], 'player-calibration')
  await runPostCapture(PLAYER_TRACKING_PYTHON,
    [path.resolve('scripts/derive_player_metrics.py'), manifest.stem], 'player-derivation')
  console.log(`[tracker-preview] derived: ${manifest.stem}.plays.jsonl`)
  console.log('[tracker-preview] nothing was written to Supabase. To load this session later:')
  console.log(`[tracker-preview]   node scripts/ingest_player_tracking.mjs --session ${manifest.stem} `
    + '--game-id <id> --competition-type <season|tournament> --source-id <id>')
}

// WHY A MATCHUP LINE IS NO LONGER THE ONLY THING THAT CAN START A CAPTURE.
//
// It used to hold until `state.current` -- a matchup line in the tracker's log
// -- on the reasoning that the actor objects do not exist before the first
// one. That reasoning is sound and it is still the trigger; what was wrong was
// having no other one, because it made the 60 Hz capture a hostage of the
// tracker executable. On 2026-08-28 the
// tracker was started against a game that was already running: it printed "It
// seems a game has already started", never printed the "Away vs. Home @
// Stadium" banner, and died one second later inside its own score-screen
// handler. No matchup line ever arrived, so no collector was launched, and a
// whole session produced nothing at all -- no .bin, no plays, no console --
// with Dolphin sitting right there and the game in play.
//
// The collector already answers the same question better and first-hand:
// resolve_actors() reads the game's own fielder pointer table and refuses with
// "Start a game first -- the actor objects do not exist outside of play" when
// they are null, and lock_ball_offset() then waits for a real ball before
// recording a frame. So a launch that is too early costs a refusal and a
// retry, while a launch that never happens costs the session.
//
// The matchup line is still the PREFERRED trigger and nothing about the normal
// path changes: when the tracker is working it fires first, at the moment play
// is live and a pitch is imminent, which is when the ball offset calibrates
// cleanly. These two are only for when it does not fire at all --
//
//   the tracker exited          it is not going to say anything now
//   nothing after this long     it attached to a game already in progress,
//                               which is the state it prints "It seems a game
//                               has already started" for and then dies in
const COLLECTOR_RETRY_MS = Number(env.TRACKER_COLLECTOR_RETRY_MS || 5000)
const COLLECTOR_MATCHUP_GRACE_MS = Number(env.TRACKER_COLLECTOR_GRACE_MS || 60000)
let collectorRetry = null
let collectorAttempts = 0

// A retry that is a TIMER, not a log line. The previous code re-entered
// launchCollector() from every tracker and collector line, so a collector that
// exited immediately -- an unknown stadium byte, a game not yet in play -- was
// respawned once per line for as long as the log kept moving.
function scheduleCollectorRetry(why) {
  if (collectorRetry || collector || !PLAYER_TRACKING_ENABLED || shuttingDown) return
  collectorRetry = setTimeout(() => {
    collectorRetry = null
    // Forced: whatever made the first attempt necessary has not gone away, and
    // the collector's own refusal is the check that matters from here.
    launchCollector({ force: true })
  }, COLLECTOR_RETRY_MS)
  if (why) console.log(`[tracker-preview] ${why}; retrying in ${Math.round(COLLECTOR_RETRY_MS / 1000)}s`)
}

function launchCollector({ force = false } = {}) {
  if (collector || !PLAYER_TRACKING_ENABLED || shuttingDown) return
  if (collectorRetry) return
  // The tracker's own word that play is live, which is the good case.
  if (!state.current && !force) return
  collectorAttempts += 1
  const park = collectorPark()
  fs.mkdirSync(PLAYER_TRACKING_DIR, { recursive: true })
  const prefix = `preview-${startedAt.toISOString().replace(/[:.]/g, '-')}`
  collectorStopPath = path.join(PLAYER_TRACKING_DIR, `${prefix}.stop`)
  collectorManifestPath = path.join(PLAYER_TRACKING_DIR, `${prefix}.manifest.json`)
  for (const filePath of [collectorStopPath, collectorManifestPath]) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch { /* nothing to clear */ }
  }
  const args = [
    path.resolve('scripts/collect_player_tracking.py'),
    '--park', park,
    '--out', PLAYER_TRACKING_DIR,
    '--stop-file', collectorStopPath,
    '--manifest', collectorManifestPath,
    '--note', 'standalone preview (no database writes)',
    // Set TRACKER_CALIBRATION_EXCLUDED=1 for a stadium-research game, where
    // balls are deliberately let go so they reach a hazard. The capture and the
    // derivation are unaffected; only the calibration counts skip it. See
    // --calibration-excluded in collect_player_tracking.py.
    ...(env.TRACKER_CALIBRATION_EXCLUDED === '1' ? ['--calibration-excluded'] : []),
    // And WHY, when the operator said. The collector's default reason names
    // stadium research, which is only sometimes true: a scripted swing-mode
    // game is excluded for a different reason and used to be filed under that
    // sentence anyway. --calibration-excluded-reason on the launcher sets this.
    ...(env.TRACKER_CALIBRATION_EXCLUDED === '1'
      && String(env.TRACKER_CALIBRATION_EXCLUDED_REASON || '').trim()
      ? ['--calibration-excluded-reason', String(env.TRACKER_CALIBRATION_EXCLUDED_REASON).trim()]
      : []),
    // The comprehensive evidence profile and who held which remote. Validated
    // by tracker_preview.mjs before anything was launched.
    ...collectorEvidenceArgs(env),
  ]
  console.log(`[tracker-preview] launching the 60 Hz collector for ${park}`
    + (collectorAttempts > 1 ? ` (attempt ${collectorAttempts})` : ''))
  const proc = spawn(PLAYER_TRACKING_PYTHON, args, { cwd: process.cwd(), windowsHide: true })
  collector = proc
  setTrackerPreviewCaptureHealth(state, {
    status: 'waiting', collector_pid: proc.pid || null, park, note: null,
  })
  // What the collector said it could not do, kept so the retry can report the
  // reason instead of a bare exit code the operator has to go and find.
  let lastRefusal = null
  const onLine = (line) => {
    const handled = applyCollectorLine(state, line,
      { log: (message) => console.log(`[player-tracker] ${message}`) })
    if (!handled) console.log(`[player-tracker] ${line}`)
    if (/Start a game first|outside the known 0\.\.8 menu|Could not hook Dolphin/i.test(String(line))) {
      lastRefusal = String(line).trim()
    }
    // A [live-status] line can resolve the park from game memory.
    noteStadium()
    const stem = String(line).match(/-> (.*\.bin)/)
    if (stem) collectorStem = stem[1].replace(/\.bin$/, '')
  }
  readline.createInterface({ input: proc.stdout }).on('line', onLine)
  readline.createInterface({ input: proc.stderr }).on('line', onLine)
  proc.on('error', (error) => {
    console.error('[tracker-preview] the collector failed to launch:', error.message)
    console.error('[tracker-preview] fielding and baserunning will be missing. '
      + 'Check that dolphin-memory-engine is installed for this Python.')
    setTrackerPreviewCaptureHealth(state, {
      status: 'failed', collector_pid: null, note: error.message,
    })
    collector = null
  })
  proc.on('exit', (code) => {
    const recorded = Boolean(collectorStem)
    collector = null
    if (code !== 0 && !recorded) {
      // A collector that refused BEFORE it recorded anything is a "not yet",
      // not a failure: the game is on a menu, or between innings, or the park
      // is not one the stadium byte names. Those all become true later, so the
      // console says it is waiting and this keeps asking.
      setTrackerPreviewCaptureHealth(state, {
        status: 'waiting',
        collector_pid: null,
        note: lastRefusal || `the collector exited with code ${code}`,
      })
      scheduleCollectorRetry(lastRefusal || `the collector exited with code ${code} before recording anything`)
      return
    }
    // THE MANIFEST DECIDES, NOT THE EXIT CODE. Ctrl-C in a shared Windows
    // console reaches the collector as well as this process, and the collector
    // catches it, flushes, writes a complete manifest with a checksum -- and
    // can still exit non-zero. This used to return here, which threw away a
    // finished capture: the 2026-08-31 Daisy Cruiser session left 83,395 clean
    // frames, 107 plays and a "captured" manifest on disk with no calibration
    // and no .plays.jsonl, and said nothing about it. derivePlayerTrackingCapture
    // reads that manifest and refuses on its own if the capture really did not
    // finish, so an unclean exit costs a message rather than the session.
    if (code !== 0) {
      console.log(`[tracker-preview] the collector exited with code ${code}; `
        + 'deriving anyway if it left a finished capture')
    }
    const manifest = readCollectorManifest()
    setTrackerPreviewCaptureHealth(state, {
      status: manifest?.status === 'captured' || code === 0 ? 'stopped' : 'failed',
      collector_pid: null,
      ...(manifest ? { stem: manifest.stem || collectorStem } : {}),
    })
    derivation = derivePlayerTrackingCapture()
      .catch((error) => console.error('[tracker-preview] derivation failed:', error.message))
  })
}

function stopCollector() {
  if (!collector || !collectorStopPath) return
  try {
    fs.writeFileSync(collectorStopPath, new Date().toISOString())
    console.log('[tracker-preview] asked the collector to stop and flush')
  } catch (error) {
    console.log('[tracker-preview] could not signal the collector:', error.message)
  }
}

const startedAt = new Date()
const sessionLog = createTrackerSessionLog({
  prefix: 'preview',
  startedAt,
  header: `[tracker-preview] session started ${startedAt.toISOString()} · exe=${EXE_PATH}`,
})
const SESSION_LOG_PATH = sessionLog.path
let sessionLogClosePromise = null
let flightsArchived = false

function closeSessionLog() {
  if (!sessionLogClosePromise) sessionLogClosePromise = sessionLog.close()
  return sessionLogClosePromise
}

async function archiveSessionFlights() {
  if (flightsArchived || !sessionLog.counts.ballSamples) return
  await closeSessionLog()
  console.log('[tracker-preview] merging this session\'s hitting/flight evidence into the local archive...')
  await runPostCapture(process.execPath,
    [path.resolve('scripts/distill_flights.mjs')], 'flight-archive')
  flightsArchived = true
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tracker-preview] local read-only feed: http://127.0.0.1:${PORT}/state`)
  console.log('[tracker-preview] database writes: DISABLED (this process creates no Supabase client)')
  console.log(`[tracker-preview] launching tracker: ${EXE_PATH}`)
  console.log(`[tracker-preview] session log (kept, not overwritten): ${SESSION_LOG_PATH}`)
})

const child = spawn(EXE_PATH, [], { cwd: path.dirname(EXE_PATH) })
state.trackerPid = child.pid || null
state.trackerStatus = 'tracker launched; waiting for Dolphin'

function noteStadium() {
  sessionLog.noteStadium(state, (record) => console.log(record))
  // The collector needs a park, and this is the moment one first exists --
  // either the tracker printed a stadium line or the operator picked one.
  launchCollector()
}

const LOG_LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.*)$/
function handleLine(line) {
  const clean = String(line || '').trim()
  if (!clean) return
  console.log(clean)
  sessionLog.write(clean)
  const match = clean.match(LOG_LINE_RE)
  applyTrackerPreviewMessage(state, match ? match[3] : clean)
  noteStadium()
}
readline.createInterface({ input: child.stdout }).on('line', handleLine)
readline.createInterface({ input: child.stderr }).on('line', handleLine)

child.on('error', (error) => {
  state.trackerStatus = `tracker launch failed: ${error.message}`
  console.error('[tracker-preview]', state.trackerStatus)
})
child.on('exit', (code) => {
  state.trackerStatus = `tracker exited with code ${code}`
  state.trackerPid = null
  // A tracker that finished ends the session, and the capture with it: there
  // is no game left to record. A tracker that CRASHED is a different event --
  // the game is still being played, the collector is still watching it, and
  // stopping the 60 Hz half because the log half died throws away the only
  // half that still works. So the capture survives a crash and Ctrl-C ends it.
  if (code === 0) stopCollector()
  // A crash before the tracker ever named a matchup is the case that used to
  // lose the whole session: nothing would ever have triggered the capture. The
  // game is still being played, so start recording it now.
  else if (!collector) launchCollector({ force: true })
  // The session's at-bats are held only for as long as the tracker that
  // produced them is running. The session log on disk is the record that
  // survives; nothing here is meant to outlive the process it came from.
  const capture = { ...state.playerTracking.capture }
  clearTrackerPreviewAtBats(state)
  // clearTrackerPreviewAtBats resets the 60 Hz half wholesale. The at-bats are
  // gone by design; the capture's identity is not, and a health bar that
  // reverted to "waiting" would say no capture had happened at all.
  setTrackerPreviewCaptureHealth(state, {
    status: capture.status, stem: capture.stem, park: capture.park,
    frames: capture.frames, missed_frames: capture.missed_frames,
    calibration_status: capture.calibration_status,
    note: code === 0
      ? 'the tracker stopped; this session’s at-bats were cleared with it'
      : 'the tracker crashed; its at-bats were cleared, and the 60 Hz capture is still recording',
  })
  console.log(`[tracker-preview] ${state.trackerStatus}; cleared this session's at-bats`)
  // The tracker refuses to attach to a game that is already running: it prints
  // "It seems a game has already started" and then dies in its own score-screen
  // handler with no team objects. That is a five-word fix at the console and an
  // hour lost if nobody says it, so it is said here rather than left in the log.
  if (code !== 0) {
    console.log('[tracker-preview] the tracker exited on its own. If its last lines say '
      + '"It seems a game has already started", it attached mid-game: go back to the '
      + 'menu, start the tracker, then start the game.')
    console.log('[tracker-preview] the 60 Hz capture does not stop with it — '
      + (collector ? 'it is still recording.' : 'it will keep trying to start until the game is in play.'))
  }
  sessionLog.summary().forEach((line) => console.log(`[tracker-preview] ${line}`))
  closeSessionLog()
})

// Ctrl-C has to be patient here, and that is a deliberate change from the
// read-only preview's old behaviour. A capture killed mid-write loses its last
// seconds, its checksum and its manifest, and the postgame derivation -- the
// thing that actually produces the fielding and baserunning dataset -- takes
// minutes. Exiting in one second would throw away the point of the session.
//
// Press Ctrl-C again to abandon it anyway.
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) {
    console.log('[tracker-preview] second interrupt — exiting now, the raw capture is on disk')
    process.exit(1)
  }
  shuttingDown = true
  clearTimeout(collectorRetry)
  collectorRetry = null
  stopCollector()
  try { child.kill() } catch { /* already stopped */ }

  if (collector) {
    console.log('[tracker-preview] waiting for the collector to flush... (Ctrl-C again to abandon)')
    await new Promise((resolve) => {
      collector?.on('exit', resolve)
      setTimeout(resolve, 30000).unref()
    })
  }
  if (derivation) {
    console.log('[tracker-preview] waiting for the postgame derivation... (Ctrl-C again to abandon)')
    await derivation
  }
  await closeSessionLog()
  try {
    await archiveSessionFlights()
  } catch (error) {
    // The raw log is already safely closed. Archiving is additive and can be
    // retried later, so a failure here must not strand the preview process.
    console.error('[tracker-preview] local flight archive update failed:', error.message)
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
// A tracker that attached to a game already in progress never prints a matchup
// line, so nothing would ever trigger the capture. Give it the grace period and
// then go anyway: the collector refuses harmlessly if the game is not in play,
// and retries.
setTimeout(() => {
  // Nothing to say if the capture is up, if the tracker did its job, or if
  // something already started trying.
  if (collector || collectorRetry || collectorAttempts || state.current || shuttingDown) return
  console.log('[tracker-preview] no matchup from the tracker yet — starting the 60 Hz '
    + 'collector anyway; it refuses harmlessly if the game is not in play')
  launchCollector({ force: true })
}, COLLECTOR_MATCHUP_GRACE_MS).unref()

process.on('SIGINT', () => { shutdown() })
process.on('SIGTERM', () => { shutdown() })
process.on('message', (message) => {
  if (message?.type === 'tracker-preview-shutdown' && !shuttingDown) shutdown()
})
