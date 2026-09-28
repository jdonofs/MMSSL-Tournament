// Bridges the community stat-tracker into Supabase for a game marked
// `stats_source = 'tracker'`, two ways:
//   1. Live feed — this script launches the tracker .exe itself, captures
//      its console log line-by-line, and mirrors a parsed play-by-play
//      state (count/outs/matchup + recent events) into `live_feed` in
//      near-real-time.
//   2. Final box score — the tracker only writes its xlsx workbook once
//      the game ends, so that file is watched separately and treated as
//      the authoritative batting/pitching totals once it appears.
// Run this on whatever PC is running the tracker, in place of launching
// the tracker .exe yourself — this script launches it for you.
//
// Usage:
//   node scripts/live_tracker_bridge.mjs
//
// Config (env vars, can go in a local .env.tracker-bridge — see below):
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY   - reused from the main .env
//   TRACKER_BRIDGE_EMAIL / TRACKER_BRIDGE_PASSWORD - a Supabase login for an
//     account with scorebook_access or is_commissioner (RLS requires it)
//   TRACKER_EXE_PATH  - path to the advanced-stat tracker executable
//     (defaults to the metre-native v28 build, with older lineup builds as
//     compatibility fallbacks)
//   TRACKER_OUTPUT_DIR - directory where the tracker writes completed xlsx files
//     (defaults to the output directory beside the tracker executable)
//   TRACKER_AUTO_EXIT_AFTER_GAME - defaults to 1; after the game finishes,
//     wait for the final workbook, capture derivation/ingest and game
//     completion, then exit so `npm run game` finishes without a manual Ctrl+C
//   TRACKER_XLSX_PATH  - optional fixed completed-workbook path; when omitted,
//     the bridge watches TRACKER_OUTPUT_DIR for the newly-created game workbook
//   TRACKER_LAUNCH_SIGNAL - optional path; when set, the bridge does all of
//     its own startup and then waits for this file to appear before it
//     launches the tracker .exe. scripts/mss_autogame.mjs writes it once the
//     match reaches its first pitch, so the tracker initialises against a
//     live game rather than a menu.
//   TRACKER_LAUNCH_SIGNAL_TIMEOUT_MS - how long to wait for it (default 300000);
//     on expiry the tracker launches anyway.
//   TRACKER_LAUNCH_OWNER_PID - optional; the launcher that promised to write
//     TRACKER_LAUNCH_SIGNAL. While waiting for that signal the bridge gives up
//     if this process disappears, rather than timing out and launching the
//     tracker against whatever screen the game is on.
//   TRACKER_LAUNCH_READY - optional path; written once this bridge has
//     finished its own startup and is about to hold the tracker. It is the
//     only thing that distinguishes a bridge that is running from one that is
//     ready, and scripts/mss_autogame.mjs refuses to touch the emulator until
//     it appears.
//   TRACKER_LAUNCH_RECORDING - optional path; written once the 60 Hz collector
//     has proved it is capturing -- frames sampled and flushed to the .bin,
//     not a pid and not a "started" line. Written on failure too, saying why,
//     so a launcher waiting on it never has to guess between "not yet" and
//     "never".
//   TRACKER_CAPTURE_READY_TIMEOUT_MS - how long this bridge waits for that
//     evidence before launching the tracker anyway (default 30000).
//   TRACKER_LEASE_TAKEOVER - '1' to take a database game lease that another
//     machine still holds. Deliberately not the default: the ordinary reason a
//     lease is held is that somebody is playing that game.
//   TRACKER_LEASE_TTL_SECONDS - lease lifetime (default 90). It is renewed
//     every 25 s while the bridge runs, so this is how long a crashed bridge's
//     game stays locked before another machine can take it.
//   TRACKER_GAME_TABLE - optional 'games' or 'season_schedule'; pins which
//     table TRACKER_GAME_ID is an id in. The two number their rows
//     independently, so a shared id is otherwise resolved by search order.
//   TRACKER_GAME_ID    - optional; the games.id row to write into. If omitted,
//     the bridge looks for exactly one game with stats_source='tracker' and
//     status in ('pending','active') and uses that.
//   TRACKER_BRIDGE_PREVIEW_PORT - optional (default 4317); serves the at-bat
//     preview this game's scorebook embeds in its Live Tracker tab. Same API
//     and same page as scripts/tracker_at_bat_preview.mjs, over a session that
//     is actually recording — each at-bat reports whether it reached the
//     database. 0 disables it. Only one process can hold the port, so the
//     standalone preview and this bridge cannot both run.
//   TRACKER_BRIDGE_SESSION_LOG - optional; set to 0 to stop writing the raw
//     tracker console log. On by default, and worth leaving on: that file is
//     the only input to the flight pipeline (scripts/ball_trajectories.mjs ->
//     scripts/distill_flights.mjs), so a session without one records the game's
//     statistics in full and loses every ball trajectory in it. Written to
//     sluggers-stat-tracker-advanced-stats-dev/preview-sessions/bridge-*.log.
//   TRACKER_PLAYER_TRACKING - set to 0 to disable the 60 Hz player sidecar.
//   TRACKER_PLAYER_PYTHON - Python executable for the sidecar (default python).
//   TRACKER_PLAYER_TRACKING_DIR - raw session directory (default
//     data/player_tracking). Completed captures are calibrated, derived,
//     ingested, and model-refit automatically after the tracker exits.
//   TRACKER_LIVE_TRACKING - set to 0 to stop writing movement and fielding
//     facts during the game; they then arrive only with the postgame ingest.
//     Needs the session-versioning migration, and writes nothing without it.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import util from 'node:util'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import ExcelJS from 'exceljs'
import chokidar from 'chokidar'
import { createClient } from '@supabase/supabase-js'
import {
  TRACKER_POSITION_NUMBERS,
  TRACKER_POSITIONS_BY_NUMBER,
  parseTrackerBattingMessage,
  parseTrackerLineupMessage,
  parseTrackerPositionChangeMessage,
  parseTrackerRunnerMessage,
  parseWorkbookStartingLineups,
  planTrackerPositionChange,
  validateTrackerAlignment,
  validateTrackerBattingOrder,
} from './tracker_alignment.mjs'
import { createTrackerGameLease, isLeaseNotHeldError } from './tracker_game_lease.mjs'
import { trackerShutdownTimeoutMs } from './tracker_shutdown_policy.mjs'
import { computePendingState, computePendingOutState, extractNextRunners } from '../src/utils/runnerAssignment.js'
import { isCreditedHit } from '../src/utils/creditedHit.js'
import { decideGamePitchingFlags } from '../src/utils/pitchingDecisions.js'
import { completeSeasonGameLifecycle } from '../src/utils/seasonPlayoffs.js'
import { advanceBracketOnGameComplete } from '../src/utils/bracketProgression.js'
import { planFielderStintChange } from '../src/utils/fielderStints.js'
import { getStadiumKeyByName } from '../src/utils/stadiums.js'
import { resolveOnPA } from '../src/utils/betResolution.js'
import {
  buildDoublePlayOpportunityFromPa,
  parseFieldingPositions,
} from '../src/utils/advancedDefense.js'
import {
  buildTrackerMarketInputSignature,
  shouldStartFreshTrackerSession,
} from '../src/utils/trackerLiveFeed.js'
import { resolveTrackerMatchupForHalf } from '../src/utils/trackerMatchupPrediction.js'
import { assembleErrorNotation, parseFielderChainFromNotation } from '../src/utils/notation.js'
import {
  buildTrackerBetResolutionConfig,
  settleCompletedTrackerGame,
  syncTrackerLiveOdds,
} from './tracker_betting_sync.mjs'
import { characterNameKey } from '../src/utils/characterNames.js'
import {
  applyTrackerPreviewMessage,
  applyTrackerPreviewPlay,
  trackerPreviewMeasuredPitches,
  trackerPreviewOutcomePlay,
  rejoinTrackerPreviewPlays,
  applyTrackerPreviewPostgamePlay,
  clearTrackerPreviewAtBats,
  createTrackerPreviewState,
  recordTrackerPreviewWrite,
  setTrackerPreviewCaptureHealth,
  setTrackerPreviewGameContext,
  setTrackerPreviewStadiumOverride,
} from './tracker_preview_state.mjs'
import { annotationPathFor } from './tracker_annotations.mjs'
import { createLiveTrackingPersistence } from './tracker_live_tracking_persistence.mjs'
import { runnerAdvancedOnPlay, runnerDestinationsFromPlay } from './tracker_runner_telemetry.mjs'
import { applyCollectorLine, assertEvidenceProfileReady, collectorEvidenceArgs } from './tracker_collector_feed.mjs'
import { syncRunnerOpportunities } from '../src/utils/runnerOpportunityPersistence.js'
import { createTrackerPreviewServer } from './tracker_preview_server.mjs'
import { createTrackerSessionLog } from './tracker_session_log.mjs'
import {
  acquireTrackerGameLock,
  processExists,
  drainTrackerWork,
  insertOneReconciled,
  insertRowsReconciled,
  selectByKey,
  updateRowsVerified,
} from './tracker_persistence.mjs'
import { createTrackerScoringPersistence } from './tracker_scoring_persistence.mjs'
import { recomputeTrackerPitchingStats } from './tracker_pitching_persistence.mjs'
import { resolveTrackerGameTarget, TRACKER_GAME_SOURCES } from './tracker_game_target.mjs'
import {
  applyTrackerBattedBallToBuffer,
  applyTrackerFieldedBallToBuffer,
  applyTrackerRunnerDelta,
  applyPaDerivedTrackerInningState,
  applyTrackerInningStateMessage,
  buildExactTrackerRunnerAssignments,
  copyTrackerRunnerState,
  captureTrackerPutout,
  consumeTrackerPitch,
  applyMeasuredPitchOffers,
  trackerContactWasBunt,
  isTrackerReplayMessage,
  isTrackerRobbedHomeRun,
  markPendingTrackerStarPitch,
  markTrackerStarSwing,
  numberTrackerPitches,
  parseTrackerBattedBallMessage,
  parseTrackerFieldedBallMessage,
  parseTrackerHitByPitchMessage,
  parseTrackerInningStateMessage,
  parseTrackerPitchProvisionalMessage,
  parseTrackerPutoutMessage,
  removeTrackerRunner,
  shouldChargeTrackerBobbleError,
  trackerPlayThrowingError,
  trackerPlayFieldingPosition,
  trackerPlayIsNicePlay,
  isTrackerMissingPlayerName,
  trackerPlayCatchPosition,
  trackerHitBeforeOutfieldBoot,
  trackerOutNotationLetter,
  trackerPlayOutChainPositions,
  shouldClassifyTrackerFielderChoice,
  shouldClassifyTrackerSacrificeBunt,
  shouldCreditTrackerPutout,
  shouldReclassifyTrackerFlyOutAsSacFly,
  TRACKER_BALL_SAMPLE_MARKER,
  TRACKER_BATTED_BALL_MARKER,
  TRACKER_FIELDED_BALL_MARKER,
  TRACKER_PITCH_PROVISIONAL_MARKER,
  TrackerBallSampleBuffer,
  attachTrackerTrajectory,
  normalizeRbiForPaResult,
  trackerRbiForPaResult,
  shouldDowngradeTrackerHitToRoe,
  trackerResultFromMeasuredBatterBases,
  parseTrackerBallSampleMessage,
  trackerBattedBallPaFields,
  trackerCaughtBallResult,
  trackerFieldedBallPaFields,
  trackerOutsOnPlay,
  trackerPitchStatFields,
  trackerStarPitchPaFlags,
} from './tracker_play_events.mjs'

function loadEnvFile(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) return
    env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim()
  })
  return env
}

const env = {
  ...loadEnvFile(path.resolve('.env')),
  ...loadEnvFile(path.resolve('.env.tracker-bridge')),
  ...process.env,
}

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY
const BRIDGE_EMAIL = env.TRACKER_BRIDGE_EMAIL
const BRIDGE_PASSWORD = env.TRACKER_BRIDGE_PASSWORD
const ADVANCED_TRACKER_PATH = path.resolve('sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v28.exe')
const PATCHED_TRACKER_PATH = path.resolve('sluggers-stat-tracker-windows/sluggers-stat-tracker-live-v2.exe')
const LEGACY_PATCHED_TRACKER_PATH = path.resolve('sluggers-stat-tracker-windows/sluggers-stat-tracker-live.exe')
const STOCK_TRACKER_PATH = path.resolve('sluggers-stat-tracker-windows/sluggers-stat-tracker.exe')
const EXE_PATH = path.resolve(env.TRACKER_EXE_PATH || (
  fs.existsSync(ADVANCED_TRACKER_PATH)
    ? ADVANCED_TRACKER_PATH
    : fs.existsSync(PATCHED_TRACKER_PATH)
    ? PATCHED_TRACKER_PATH
    : fs.existsSync(LEGACY_PATCHED_TRACKER_PATH) ? LEGACY_PATCHED_TRACKER_PATH : STOCK_TRACKER_PATH
))
const XLSX_PATH = env.TRACKER_XLSX_PATH ? path.resolve(env.TRACKER_XLSX_PATH) : null
const TRACKER_OUTPUT_DIR = path.resolve(env.TRACKER_OUTPUT_DIR || path.join(path.dirname(EXE_PATH), 'output'))
const AUTO_EXIT_AFTER_GAME = !['0', 'false', 'no', 'off'].includes(
  String(env.TRACKER_AUTO_EXIT_AFTER_GAME ?? '1').trim().toLowerCase(),
)
// Optional handoff gate, used by scripts/mss_autogame.mjs. Everything above
// launchTracker() -- signing in, loading the roster, repairing live state --
// takes seconds the tracker does not need to be present for, and the tracker
// itself wants the match already up when it initialises its game and team
// data. Splitting the two lets the slow half run while the stadium is still
// loading and holds only the .exe back until something says the match is
// live. Unset means launch immediately, which is the standalone behaviour
// this file has always had.
const LAUNCH_SIGNAL_PATH = env.TRACKER_LAUNCH_SIGNAL ? path.resolve(env.TRACKER_LAUNCH_SIGNAL) : null
const LAUNCH_SIGNAL_TIMEOUT_MS = Math.max(0, Number(env.TRACKER_LAUNCH_SIGNAL_TIMEOUT_MS || 300000))
// The other half of that handshake. A launcher can see that this process
// exists long before it can do anything useful, and "it is running" was being
// read as "it is ready" -- so a bridge that died on a bad login or a held game
// lock was discovered an hour later, with the game played and nothing
// recorded. This file is written once, immediately before the tracker is
// held, and means every startup step below main() has finished.
const LAUNCH_READY_PATH = env.TRACKER_LAUNCH_READY ? path.resolve(env.TRACKER_LAUNCH_READY) : null
// The process that promised to write the launch signal. Windows has no way to
// deliver a catchable signal to a TerminateProcess'd parent's children, and no
// job object holds this one, so a launcher killed hard -- or a console window
// closed -- leaves this bridge waiting on a handoff that is never coming. It
// would then sit out LAUNCH_SIGNAL_TIMEOUT_MS and launch the tracker anyway,
// against whatever screen the game happens to be on, which is the exact
// failure the wait exists to prevent. Watching the pid turns that into a
// clean exit.
const LAUNCH_OWNER_PID = Number(env.TRACKER_LAUNCH_OWNER_PID) || null
// The third file in the handshake, and the only one backed by measurement.
// <signal>.ready says this process finished starting up; nothing said the 60 Hz
// collector was writing anything, so the first pitch could be thrown into a
// capture that had not sampled a frame. The collector prints its evidence
// (frames counted AND bytes flushed to the .bin) and this path is where that
// evidence -- or the reason there is none -- is published for the launcher.
const LAUNCH_RECORDING_PATH = env.TRACKER_LAUNCH_RECORDING
  ? path.resolve(env.TRACKER_LAUNCH_RECORDING) : null
// Long enough for python to start, attach to Dolphin, resolve the actors and
// lock the ball offset; short enough that a collector which is never going to
// record does not hold the tracker for the whole of pregame. On expiry the
// tracker launches anyway -- a game tracked without the 60 Hz capture is worth
// more than no game at all -- and the file says the wait timed out.
const CAPTURE_READY_TIMEOUT_MS = Math.max(0, Number(env.TRACKER_CAPTURE_READY_TIMEOUT_MS || 30000))
// WHAT ACTUALLY PROTECTS THE OPENING PLAY, AND WHY IT IS A DIFFERENT FILE.
//
// The previous sequence started the collector, waited up to 30 s for RECORDING
// evidence, and only then started the tracker .exe. Nothing in it held
// gameplay: autoteam signals when the match is already live at a pitch reset,
// so every second of that wait was a second of a live game with no scoring
// reader attached. The ordering test proved collector-before-executable, which
// is not the same claim as capture-before-first-pitch.
//
// Gameplay is now held by the one process that can hold it -- autoteam, which
// owns the controller ports -- and this file is what it waits for: both readers
// up. "Both readers up" is deliberately weaker than recording evidence, because
// recording evidence CANNOT be produced while gameplay is held: the collector's
// frame counter only advances when the game clock does, and holding the game is
// exactly what stops the clock. So the collector states `attached` (attached,
// stadium read, ball offset resolved, stream file open -- all provable with the
// clock stopped), the tracker .exe is started, this file is written, gameplay
// resumes, and the recording evidence settles in the first half second of live
// play exactly as before.
const LAUNCH_READERS_PATH = env.TRACKER_LAUNCH_READERS
  ? path.resolve(env.TRACKER_LAUNCH_READERS) : null
// Attaching is python starting, importing, attaching to Dolphin and resolving
// the actors. It does not wait on the game, so it is much shorter than the
// recording wait -- and gameplay is held for it, so it must be.
const CAPTURE_ATTACH_TIMEOUT_MS = Math.max(0, Number(env.TRACKER_CAPTURE_ATTACH_TIMEOUT_MS || 20000))
// The SCORING reader has the same question asked of it, and until now it was
// not asked at all: spawnChild() returned an object and the handshake declared
// both readers up, so a tracker .exe that failed to start with ENOENT released
// a live game that nothing was scoring. The tracker announces its own
// attachment on its first line of output ("Dolphin hooked."), which is the
// evidence this waits for -- the scoring equivalent of the collector's
// `attached`, and provable with the game clock stopped for the same reason.
const SCORING_READY_TIMEOUT_MS = Math.max(0, Number(env.TRACKER_SCORING_READY_TIMEOUT_MS || 30000))
const ODDS_REPRICE_DEBOUNCE_MS = Math.max(50, Number(env.TRACKER_ODDS_REPRICE_MS || 120))
// The at-bat preview surface, served on the same port the standalone
// read-only preview uses so the browser page needs no reconfiguring to point
// at a live game. 0 disables it. Only one of the two processes can hold the
// port, which is the right constraint: they both drive the same tracker .exe
// and were never meant to run at once.
const PREVIEW_PORT = Number(env.TRACKER_BRIDGE_PREVIEW_PORT ?? 4317)
// The raw tracker console output, kept on disk. This is the only input to the
// flight pipeline (scripts/ball_trajectories.mjs -> distill_flights.mjs), so a
// bridge that does not write one records the game's statistics perfectly and
// loses every ball trajectory in it. Set to 0/false to opt out.
const SESSION_LOG_ENABLED = !['0', 'false', 'no', 'off']
  .includes(String(env.TRACKER_BRIDGE_SESSION_LOG ?? '').trim().toLowerCase())
const PLAYER_TRACKING_ENABLED = !['0', 'false', 'no', 'off']
  .includes(String(env.TRACKER_PLAYER_TRACKING ?? '').trim().toLowerCase())
const PLAYER_TRACKING_PYTHON = String(env.TRACKER_PLAYER_PYTHON || 'python')
const PLAYER_TRACKING_DIR = path.resolve(env.TRACKER_PLAYER_TRACKING_DIR || 'data/player_tracking')
const BRIDGE_STATE_DIR = path.resolve(env.TRACKER_BRIDGE_STATE_DIR || 'data/tracker_bridge_state')
let TARGET_GAME_ID = env.TRACKER_GAME_ID ? Number(env.TRACKER_GAME_ID) : null
let TARGET_STATS_TABLE = null // 'tracker_live_stats' (tournament) or 'season_tracker_live_stats' (season)
let TARGET_GAMES_TABLE = null // 'games' (tournament) or 'season_schedule' (season)
let TARGET_ROSTER_TABLE = null // 'draft_picks' (tournament) or 'season_roster' (season)
let TARGET_TEAM_A_PLAYER_ID = null
let TARGET_TEAM_B_PLAYER_ID = null
let TARGET_SEASON_ID = null // season games only: season_schedule.season_id, stamped onto every row a season table requires it on
let TARGET_SOURCE_ID = null // tournament_id or season_id used by shared team-lineup rows
let TARGET_GAME_ROW = null
let TARGET_STADIUM_KEY = null
let GAME_TABLES = null // set once TARGET_GAMES_TABLE is known — the row-per-play tables matching it
const TEAM_ID_BY_PLAYER_ID = {} // season only: player_id -> season_teams.id (tournament PA rows use player_id directly instead)

const SOURCES = TRACKER_GAME_SOURCES

// Checked when this process is going to talk to the real database and drive
// the real executable. An injected client and an injected spawn (the
// acceptance harness) supply both, so the checks would only be refusing a
// configuration nothing is about to use. They run inside main() rather than at
// import time so a missing value is reported through main()'s own catch --
// which sets process.exitCode instead of aborting node mid-socket-close.
function requireBridgeEnvironment() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (check .env).')
  }
  if (!BRIDGE_EMAIL || !BRIDGE_PASSWORD) {
    throw new Error(
      'Missing TRACKER_BRIDGE_EMAIL / TRACKER_BRIDGE_PASSWORD. Put them in a ' +
      '.env.tracker-bridge file (not committed) next to .env, e.g.\n' +
      '  TRACKER_BRIDGE_EMAIL=jason@sluggers.local\n  TRACKER_BRIDGE_PASSWORD=Mossss',
    )
  }
  if (!fs.existsSync(EXE_PATH)) {
    throw new Error(`Tracker executable not found at ${EXE_PATH}. Set TRACKER_EXE_PATH.`)
  }
}

let supabase = null
// The child launcher, so an in-process caller can hand the bridge scripted
// children instead of the tracker .exe and the 60 Hz sidecar. Defaults to the
// real one; nothing below this line knows the difference.
let spawnChild = spawn
let xlsxWatcher = null
let trackerGameLock = null
let scoringPersistence = null
let requiredPersistenceFailure = null
// The database half of "this game is mine". The local lock keeps a second
// bridge on THIS machine off the game; only this can keep one on another
// machine off it. Null until main() has resolved the game.
let trackerGameLease = null

// THE LOCAL HALF OF THE FENCE. It refuses a write this process already knows
// it must not make, without a round trip, and names which one was refused --
// and it THROWS, because a lost lease is never a reason to write a weaker
// version of the same row.
//
// WHAT IT IS NOT IS THE FENCE. It reads cached state: after a takeover this
// bridge goes on reading `held` until its next renewal, so a guard that passed
// here said nothing about who owned the game by the time the update that
// followed it arrived. Even with a perfectly current view, a check and a
// separate request are two moments. The mutations below now carry the lease
// INTO the transaction that writes -- see
// supabase/migrations/20260909120000_tracker_fenced_game_mutations.sql -- and
// this check stays in front of them as the cheap, early, well-named refusal it
// always was.
function assertLeaseWritable(what) {
  if (!trackerGameLease) return null
  return trackerGameLease.assertWritable(what)
}

// Set by stopTrackerBridge, and never unset: this module is one bridge.
let bridgeReleased = false

// What a fenced call has to carry. Unleased ONLY when the database has no lease
// functions at all, and then it says so; every other non-held state throws --
// see scripts/tracker_game_lease.mjs.
function leaseWriteCredentials(what) {
  if (!trackerGameLease) return { ownerId: null, epoch: null, unleasedIntent: null }
  return trackerGameLease.writeCredentials(what)
}

// PostgREST reports a function that is not there as PGRST202/PGRST203 and
// Postgres itself as 42883. Any of them means "this deployment has not run
// 20260909120000_tracker_fenced_game_mutations.sql". The message test is narrow
// on purpose: a bare /does not exist/ also matches a missing column or table,
// and reading one of those as a missing capability hides a schema fault behind
// a fallback.
function isMissingRpc(error) {
  const code = String(error?.code || '')
  if (code === 'PGRST202' || code === 'PGRST203' || code === '42883') return true
  if (code) return false
  return /could not find the function|function [^ ]* does not exist/i.test(String(error?.message || ''))
}

// The functions this deployment turned out not to have. Per function rather
// than one flag for all three: they arrive in one migration, so in practice it
// is all or none, but a partially applied one should degrade only the call it
// actually lacks rather than every call after it.
const missingFencedMutations = new Set()

/**
 * One protected mutation, with ownership asserted inside its own transaction.
 *
 * Returns `{ fenced: true, data }` when the database enforced it and
 * `{ fenced: false }` when this deployment has no such function -- the signal
 * for the caller to take the ordinary-update path it used before, once and
 * loudly. Anything else that goes wrong is thrown: a refused lease, a
 * constraint violation and a rolled-back transaction all mean the write did
 * NOT happen, and retrying them through the unfenced path would be the one
 * outcome worse than failing.
 */
async function callFencedGameMutation(fn, args, what) {
  const credentials = leaseWriteCredentials(what)
  if (missingFencedMutations.has(fn) || typeof supabase?.rpc !== 'function') {
    return { fenced: false }
  }
  const { data, error } = await supabase.rpc(fn, {
    p_competition_type: trackerSourceType(),
    p_game_id: Number(TARGET_GAME_ID),
    ...args,
    p_owner_id: credentials?.ownerId ?? null,
    p_epoch: credentials?.epoch ?? null,
    p_unleased_intent: credentials?.ownerId ? null : (credentials?.unleasedIntent ?? null),
  })
  if (error) {
    if (isMissingRpc(error)) {
      if (!missingFencedMutations.has(fn)) {
        log(`this database has no ${fn}(); ${what} falls back to an ordinary update guarded `
          + "only by this process's own lease check. Cross-machine exclusion on THOSE writes "
          + 'is NOT in force until '
          + 'supabase/migrations/20260909120000_tracker_fenced_game_mutations.sql is applied.')
      }
      missingFencedMutations.add(fn)
      return { fenced: false }
    }
    throw error
  }
  return { fenced: true, data }
}

const GAME_INFO_LABELS = [
  'Away Team', 'Home Team', 'Stadium - Time of Day', 'Innings - X',
  'Stars - On/Off', 'Items - On/Off', 'Mercy - On/Off',
]

// Everything the bridge says also goes to disk, one file per run. The launcher
// keeps only its last 80 lines in memory, so season game 2766's failed
// completion had no log left once the process exited.
const BRIDGE_LOG_PATH = path.join(BRIDGE_STATE_DIR, 'logs',
  `bridge-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
let bridgeLogDirReady = false

function log(...args) {
  const line = util.format(`[tracker-bridge ${new Date().toISOString()}]`, ...args)
  console.log(line)
  try {
    if (!bridgeLogDirReady) {
      fs.mkdirSync(path.dirname(BRIDGE_LOG_PATH), { recursive: true })
      bridgeLogDirReady = true
    }
    fs.appendFileSync(BRIDGE_LOG_PATH, `${line}\n`)
  } catch {
    // The console copy above is the one that must not fail.
  }
}

async function resolveTeamPlayerIds(source, gameRow) {
  if (source.gamesTable === 'games') {
    return { teamAPlayerId: gameRow.team_a_player_id, teamBPlayerId: gameRow.team_b_player_id }
  }
  // season_schedule stores away_team_id/home_team_id referencing season_teams,
  // not player ids directly — team_a = away, team_b = home, same convention
  // the site's own SeasonGameSessionProvider normalizes to.
  const { data: teams, error } = await supabase
    .from('season_teams').select('id, player_id').in('id', [gameRow.away_team_id, gameRow.home_team_id])
  if (error) throw error
  const playerIdByTeamId = Object.fromEntries((teams || []).map((t) => [t.id, t.player_id]))
  for (const t of teams || []) TEAM_ID_BY_PLAYER_ID[String(t.player_id)] = t.id
  return { teamAPlayerId: playerIdByTeamId[gameRow.away_team_id] || null, teamBPlayerId: playerIdByTeamId[gameRow.home_team_id] || null }
}

async function resolveTargetStadiumKey(gameRow) {
  let stadiumName = gameRow?.stadium || null
  if (!stadiumName && gameRow?.stadium_id) {
    const { data, error } = await supabase
      .from('stadiums').select('name').eq('id', gameRow.stadium_id).maybeSingle()
    if (error) throw error
    stadiumName = data?.name || null
  }
  return getStadiumKeyByName(stadiumName)
}

async function applyTargetSource(source, row) {
  TARGET_GAME_ROW = row
  TARGET_STATS_TABLE = source.statsTable
  TARGET_GAMES_TABLE = source.gamesTable
  TARGET_ROSTER_TABLE = source.rosterTable
  TARGET_SEASON_ID = source.gamesTable === 'season_schedule' ? row.season_id : null
  TARGET_SOURCE_ID = source.gamesTable === 'season_schedule' ? row.season_id : row.tournament_id
  TARGET_STADIUM_KEY = await resolveTargetStadiumKey(row)
  GAME_TABLES = source.gamesTable === 'season_schedule'
    ? {
        lineups: 'season_lineups', gameFielders: 'season_game_fielders',
        plateAppearances: 'season_plate_appearances', pitches: 'season_pitches',
        runsScored: 'season_runs_scored', pitchingStints: 'season_pitching_stints',
        teamLineups: 'season_team_lineups', teamLineupsSourceField: 'season_id',
      }
    : {
        lineups: 'lineups', gameFielders: 'game_fielders',
        plateAppearances: 'plate_appearances', pitches: 'pitches',
        runsScored: 'runs_scored', pitchingStints: 'pitching_stints',
        teamLineups: 'team_lineups', teamLineupsSourceField: 'tournament_id',
      }
  const { teamAPlayerId, teamBPlayerId } = await resolveTeamPlayerIds(source, row)
  TARGET_TEAM_A_PLAYER_ID = teamAPlayerId
  TARGET_TEAM_B_PLAYER_ID = teamBPlayerId
}

async function resolveTargetGame() {
  const { row, source } = await resolveTrackerGameTarget(supabase, {
    gameId: TARGET_GAME_ID,
    // Which table that id came from, when the launcher already knows. The two
    // tables number their rows independently, so a shared id resolved by
    // search order alone can put a season game's plate appearances into the
    // tournament game with the same number.
    gamesTable: env.TRACKER_GAME_TABLE || null,
    sources: SOURCES,
  })
  await applyTargetSource(source, row)
  return row.id
}

// ── roster/character resolution ─────────────────────────────────────────────
// Lets the bridge turn a tracker-reported character name (e.g. "Yoshi") into
// this game's actual character_id/player_id, so the live batter/pitcher can
// be written into the site's own live_state — the same field the manual
// scorebook uses — instead of a side channel only this bridge understands.

let charactersByName = {}
let characterNamesById = {}
let rosterPlayerIdByCharacterName = {}
let playerNamesById = {}

async function loadRosterAndCharacters() {
  const [{ data: characters, error: charError }, { data: players, error: playersError }] = await Promise.all([
    supabase.from('characters').select('id, name'),
    supabase.from('players').select('id, name').in('id', [TARGET_TEAM_A_PLAYER_ID, TARGET_TEAM_B_PLAYER_ID]),
  ])
  if (charError) throw charError
  if (playersError) throw playersError
  charactersByName = Object.fromEntries((characters || []).map((c) => [c.name, c.id]))
  characterNamesById = Object.fromEntries((characters || []).map((c) => [String(c.id), c.name]))
  playerNamesById = Object.fromEntries((players || []).map((player) => [String(player.id), player.name]))
  const idToName = Object.fromEntries((characters || []).map((c) => [c.id, c.name]))

  if (TARGET_ROSTER_TABLE === 'draft_picks') {
    const { data: picks, error } = await supabase
      .from('draft_picks').select('player_id, character_id')
      .in('player_id', [TARGET_TEAM_A_PLAYER_ID, TARGET_TEAM_B_PLAYER_ID])
    if (error) throw error
    for (const pick of picks || []) {
      const name = idToName[pick.character_id]
      if (name) rosterPlayerIdByCharacterName[name] = pick.player_id
    }
    return
  }

  // season_roster is keyed by team_id + character_name, not player_id/character_id.
  //
  // MUST be scoped to this season. A player has a team in every season they
  // have played, so matching on player_id alone pulled all of them: for one
  // TEST game this matched four teams instead of two, 36 roster rows instead
  // of 18, and built a name->player map spanning two competitions. The damage
  // is silent and looks like something else entirely — Peach is on Donovan's
  // TEST roster AND on May's MSL Season 1 roster, so Peach resolved to May,
  // Donovan's nine batters spanned two site players, and the whole batting
  // order was rejected with "tracker lineup contains characters from multiple
  // site teams". Nothing in that message points at the season.
  const { data: teams, error: teamsError } = await supabase
    .from('season_teams').select('id, player_id')
    .eq('season_id', TARGET_SEASON_ID)
    .in('player_id', [TARGET_TEAM_A_PLAYER_ID, TARGET_TEAM_B_PLAYER_ID])
  if (teamsError) throw teamsError
  const playerIdByTeamId = Object.fromEntries((teams || []).map((t) => [t.id, t.player_id]))
  const teamIds = (teams || []).map((t) => t.id)
  if (!teamIds.length) return
  const { data: roster, error } = await supabase
    .from('season_roster').select('team_id, character_name, is_active').in('team_id', teamIds)
  if (error) throw error
  for (const entry of roster || []) {
    // A dropped character stays on the table as a row, and could since have
    // been picked up by the other team -- so an unfiltered map can hand back
    // the previous owner. The exporter already filters this way.
    if (entry.is_active === false) continue
    const playerId = playerIdByTeamId[entry.team_id]
    if (playerId && entry.character_name) rosterPlayerIdByCharacterName[entry.character_name] = playerId
  }
}

// The tracker prints some names with a trailing period ("Hammer Bro.",
// "Fire Bro.") that the site's own characters table doesn't have ("Hammer
// Bro", "Fire Bro") — fall back to the period-stripped form so those
// characters still resolve instead of silently failing every lookup.
// The tracker names a Mii by its colour and gender — "Orange Mii (M)" — while
// the site models every Mii as the single character "Mii" (characters.id 7)
// plus an optional colour that is, in practice, null on every row in the
// database. So neither the exact name nor the period-stripped form can ever
// match, and every lookup for a Mii failed: the batting order sync was
// rejected outright with "could not resolve Orange Mii (M)".
//
// Matching on the word "Mii" is safe against MSS's roster — no other character
// name contains it — and unambiguous per team, because a character can only be
// drafted once per season, so a team fields at most one Mii.
//
// It is NOT unambiguous across a game where BOTH teams field a Mii: this
// lookup is keyed by character name, so the two would collide on "Mii" and
// whichever roster loaded last would win. That cannot happen in a season (one
// draft, one Mii) and has never happened in a tournament, where mii_color
// exists to tell them apart and is unset on every row. If it ever does, the
// colour in the tracker's name is the thing to key on.
const TRACKER_MII_NAME = /\bmii\b/i

// The two vocabularies differ in punctuation as well as periods: the site
// writes "Light-Blue Yoshi" and the tracker reads MSS's "Light Blue Yoshi".
//
// PUNCTUATION WAS NOT THE WHOLE DIFFERENCE. Two characters differ by a word:
// the tracker writes "Koopa Troopa" and "Red Koopa Troopa" where the site
// writes "Koopa" and "Red Koopa", and no amount of stripping hyphens reconciles
// those. They fell straight into the failure the comment below describes --
// every putout and assist dropped for both -- so this now goes through the
// repo's one alias table rather than keeping a private near-miss copy of it.
function normalizeCharacterName(name) {
  return characterNameKey(name)
}

// Do these two names mean the same character? Used wherever a tracker-supplied
// name meets one the site produced, which is not only the id lookups: the live
// alignment map stores the site's canonical name and is then searched with the
// tracker's, so an exact comparison there quietly dropped every putout and
// assist for any character the two spell differently.
//
// The Mii clause is safe because every caller is already scoped to one team,
// and a team fields at most one Mii — see the note above withNameFallbacks.
function sameCharacterName(left, right) {
  if (!left || !right) return false
  const a = String(left).trim()
  const b = String(right).trim()
  if (a === b) return true
  if (TRACKER_MII_NAME.test(a) && TRACKER_MII_NAME.test(b)) return true
  return normalizeCharacterName(a) === normalizeCharacterName(b)
}

function withNameFallbacks(name, lookup) {
  if (!name) return null
  if (lookup[name] != null) return lookup[name]
  if (name.endsWith('.')) {
    const stripped = name.slice(0, -1).trim()
    if (lookup[stripped] != null) return lookup[stripped]
  }
  if (TRACKER_MII_NAME.test(name) && lookup.Mii != null) return lookup.Mii
  const wanted = normalizeCharacterName(name)
  for (const key of Object.keys(lookup)) {
    if (normalizeCharacterName(key) === wanted) return lookup[key]
  }
  return null
}

function resolveCharacterId(name) {
  return withNameFallbacks(name, charactersByName)
}

function resolvePlayerIdForCharacter(name) {
  return withNameFallbacks(name, rosterPlayerIdByCharacterName)
}

const appliedAlignmentSignaturesByPlayerId = new Map()
const appliedBattingSignaturesByPlayerId = new Map()
// Before the game has begun the saved SITE lineup seeds this game's rows. Once
// play begins, the game's lineups/game_fielders rows are authoritative for this
// game only. They must never be copied back over team_lineups: that table is the
// reusable starting lineup for the next game.
//
// "Begun" means a pitch has actually been thrown. The tracker's own
// __set_starting_lineup fires there (it is what emits [TRACKER_LINEUP], and
// the reason a session stopped before the first pitch has batting orders but
// no fielding), so the alignment feed doubles as the signal. A recorded plate
// appearance counts too, for a bridge that attaches to a game already
// underway.
let trackerGameHasBegun = false

// Returns true only on the transition, so a caller can do the one-time
// handover work without having to track that itself.
function markTrackerGameBegun(reason) {
  if (trackerGameHasBegun) return false
  trackerGameHasBegun = true
  log(`game has begun (${reason}); game-specific lineup history is now authoritative`)
  return true
}

const trackerTeamSideByName = new Map()
let trackerTeamMapping = {}

function rememberTrackerTeamSide(teamName, playerId) {
  const cleanName = String(teamName || '').trim()
  const side = String(playerId) === String(TARGET_TEAM_A_PLAYER_ID)
    ? 'A'
    : String(playerId) === String(TARGET_TEAM_B_PLAYER_ID) ? 'B' : null
  if (!cleanName || !side) return
  trackerTeamSideByName.set(cleanName, side)
  trackerTeamMapping[cleanName] = side
}

function inferTrackerScoreSide(scoreTeamName) {
  const cleanScoreName = String(scoreTeamName || '').trim()
  if (!cleanScoreName) return null
  if (trackerTeamMapping[cleanScoreName]) return trackerTeamMapping[cleanScoreName]

  const normalizedScoreName = cleanScoreName.toLocaleLowerCase()
  const matches = [...trackerTeamSideByName.entries()]
    .filter(([knownName]) => {
      const normalizedKnownName = String(knownName).trim().toLocaleLowerCase()
      return normalizedScoreName === normalizedKnownName || normalizedScoreName.endsWith(` ${normalizedKnownName}`)
    })
    .map(([, side]) => side)
  const uniqueMatches = [...new Set(matches)]
  const side = uniqueMatches.length === 1 ? uniqueMatches[0] : null
  if (side) {
    trackerTeamSideByName.set(cleanScoreName, side)
    trackerTeamMapping[cleanScoreName] = side
  }
  return side
}

function resolveTrackerBattingOrder(alignment) {
  const validation = validateTrackerBattingOrder(alignment)
  if (!validation.valid) throw new Error(validation.errors.join('; '))

  const batting = alignment.batting.map((trackerName) => {
    const characterId = resolveCharacterId(trackerName)
    const playerId = resolvePlayerIdForCharacter(trackerName)
    if (characterId == null || playerId == null) {
      throw new Error(`could not resolve ${trackerName} against this game's rosters`)
    }
    return {
      trackerName,
      characterId,
      characterName: characterNamesById[String(characterId)] || trackerName,
      playerId,
    }
  })

  const playerIds = new Set(batting.map((entry) => String(entry.playerId)))
  if (playerIds.size !== 1) throw new Error('tracker lineup contains characters from multiple site teams')
  const playerId = batting[0].playerId
  if (![String(TARGET_TEAM_A_PLAYER_ID), String(TARGET_TEAM_B_PLAYER_ID)].includes(String(playerId))) {
    throw new Error('tracker lineup does not belong to either team in the selected site game')
  }

  return {
    ...alignment,
    playerId,
    teamId: isSeasonGame() ? TEAM_ID_BY_PLAYER_ID[String(playerId)] : playerId,
    batting,
  }
}

function resolveTrackerAlignment(alignment) {
  const validation = validateTrackerAlignment(alignment)
  if (!validation.valid) throw new Error(validation.errors.join('; '))

  const resolved = resolveTrackerBattingOrder(alignment)
  const battingByTrackerName = new Map(resolved.batting.map((entry) => [entry.trackerName, entry]))
  const fielding = Object.entries(alignment.fielding).map(([position, trackerName]) => {
    const entry = battingByTrackerName.get(trackerName)
    if (!entry) throw new Error(`${trackerName} appears in fielding but not in the batting order`)
    return { ...entry, position, positionNumber: TRACKER_POSITION_NUMBERS[position] }
  })

  return {
    ...resolved,
    fielding,
  }
}

async function replaceTrackerLineupRows(resolved) {
  const { data: existing, error: readError } = await supabase
    .from(GAME_TABLES.lineups)
    .select('id,character_id,batting_order')
    .eq('game_id', TARGET_GAME_ID)
    .eq('player_id', resolved.playerId)
  if (readError) throw readError

  const desiredIds = resolved.batting.map((entry) => String(entry.characterId)).sort()
  const existingIds = (existing || []).map((entry) => String(entry.character_id)).sort()
  const sameCharacters = existingIds.length === 9 && desiredIds.every((id, index) => id === existingIds[index])

  if (sameCharacters) {
    const existingByCharacterId = new Map(existing.map((row) => [String(row.character_id), row]))
    const needsReorder = resolved.batting.some((entry, index) => (
      Number(existingByCharacterId.get(String(entry.characterId))?.batting_order) !== index + 1
    ))
    if (!needsReorder) return

    // Move all rows outside the real 1-9 range first so this also works when
    // the database has a unique (game, player, batting_order) constraint.
    for (let index = 0; index < resolved.batting.length; index++) {
      const row = existingByCharacterId.get(String(resolved.batting[index].characterId))
      const { data, error } = await supabase.from(GAME_TABLES.lineups)
        .update({ batting_order: 101 + index }).eq('id', row.id).select('id')
      if (error) throw error
      if (!data?.length) throw new Error(`lineup row ${row.id} was not updated (check scorebook permissions)`)
    }
    for (let index = 0; index < resolved.batting.length; index++) {
      const row = existingByCharacterId.get(String(resolved.batting[index].characterId))
      const { data, error } = await supabase.from(GAME_TABLES.lineups)
        .update({ batting_order: index + 1 }).eq('id', row.id).select('id')
      if (error) throw error
      if (!data?.length) throw new Error(`lineup row ${row.id} was not updated (check scorebook permissions)`)
    }
    return
  }

  if ((existing || []).length) {
    throw new Error('tracker lineup characters differ from the selected game; existing lineup was preserved')
  }

  const payload = resolved.batting.map((entry, index) => addSourceFields({
    game_id: TARGET_GAME_ID,
    player_id: resolved.playerId,
    character_id: entry.characterId,
    batting_order: index + 1,
  }))
  const data = await insertRowsReconciled(supabase, GAME_TABLES.lineups, payload, {
    keyFields: ['game_id', 'player_id', 'character_id'],
    compareFields: ['game_id', 'player_id', 'character_id', 'batting_order'],
  })
  if (data.length !== 9) throw new Error(`expected to insert 9 lineup rows, inserted ${data.length}`)
}

async function replaceTrackerStartingFielders(resolved) {
  if (resolved.teamId == null) throw new Error('could not resolve the site team id for tracker fielders')
  const { data: existing, error: readError } = await supabase
    .from(GAME_TABLES.gameFielders).select('id,character,position,inning_from,inning_to')
    .eq('game_id', TARGET_GAME_ID).eq('team_id', resolved.teamId)
  if (readError) throw readError

  const hasRecordedChanges = (existing || []).some((row) => (
    Number(row.inning_from || 1) > 1 || row.inning_to != null
  ))
  if (hasRecordedChanges) {
    log(`starting lineup resolved for ${resolved.teamName}, but existing in-game fielder history was preserved`)
    return
  }

  const payload = resolved.fielding.map((entry) => addSourceFields({
    game_id: TARGET_GAME_ID,
    team_id: resolved.teamId,
    player_name: playerNamesById[String(resolved.playerId)] || '',
    character: entry.characterName,
    position: entry.positionNumber,
    inning_from: 1,
    inning_to: null,
  }))
  if ((existing || []).length) {
    const existingByCharacter = new Map(existing.map((row) => [normalizeCharacterName(row.character), row]))
    const sameCharacters = existing.length === 9
      && resolved.fielding.every((entry) => existingByCharacter.has(normalizeCharacterName(entry.characterName)))
    if (!sameCharacters) {
      throw new Error('tracker fielders differ from the selected game; existing fielder rows were preserved')
    }
    const alreadyApplied = resolved.fielding.every((entry) => (
      Number(existingByCharacter.get(normalizeCharacterName(entry.characterName))?.position) === Number(entry.positionNumber)
    ))
    if (alreadyApplied) return
    for (let index = 0; index < resolved.fielding.length; index++) {
      const row = existingByCharacter.get(normalizeCharacterName(resolved.fielding[index].characterName))
      await updateRowsVerified(supabase, GAME_TABLES.gameFielders, { id: row.id }, { position: 101 + index })
    }
    for (const entry of resolved.fielding) {
      const row = existingByCharacter.get(normalizeCharacterName(entry.characterName))
      await updateRowsVerified(supabase, GAME_TABLES.gameFielders, { id: row.id }, {
        position: entry.positionNumber,
        character: entry.characterName,
        inning_from: 1,
        inning_to: null,
      })
    }
    return
  }
  const data = await insertRowsReconciled(supabase, GAME_TABLES.gameFielders, payload, {
    keyFields: ['game_id', 'team_id', 'character'],
    compareFields: ['game_id', 'team_id', 'character', 'position', 'inning_from', 'inning_to'],
  })
  if (data.length !== 9) throw new Error(`expected to insert 9 fielder rows, inserted ${data.length}`)
}

const SHARED_POSITION_BY_FIELD_ID = Object.freeze({
  pitcher: 1,
  catcher: 2,
  firstBase: 3,
  secondBase: 4,
  thirdBase: 5,
  shortStop: 6,
  leftField: 7,
  centerField: 8,
  rightField: 9,
})

// Pull the site's saved lineup into the game, which is what should happen when
// a match starts and before it has begun. The site row already holds the
// fielding map the game itself was set up from (scripts/export_mss_lineup.mjs
// reads it, scripts/mss_autoteam.py writes it into MSS), so this is not a
// guess -- it is the same assignment, recorded against the game so the
// scorebook, spectator view and odds have a real defense to show instead of
// the placeholder Scorebook.jsx builds when game_fielders is empty.
//
// Refuses rather than approximates. A partial or mismatched site map is left
// alone for the tracker's own alignment to settle at the first pitch; writing
// eight of nine positions, or a character who is not in this game's lineup,
// would look authoritative and be wrong.
async function seedGameFieldersFromSiteLineup(resolved) {
  if (resolved.teamId == null) throw new Error('could not resolve the site team id for the seeded fielders')

  const sourceField = GAME_TABLES.teamLineupsSourceField
  const [{ data: existing, error: existingError }, { data: siteLineup, error: siteError }] = await Promise.all([
    supabase.from(GAME_TABLES.gameFielders).select('id,character,position')
      .eq('game_id', TARGET_GAME_ID).eq('team_id', resolved.teamId),
    supabase.from(GAME_TABLES.teamLineups).select('fielding_positions')
      .eq(sourceField, TARGET_SOURCE_ID).eq('player_id', resolved.playerId).maybeSingle(),
  ])
  if (existingError) throw existingError
  if (siteError) throw siteError

  const sitePositions = siteLineup?.fielding_positions && typeof siteLineup.fielding_positions === 'object'
    ? siteLineup.fielding_positions
    : {}
  const battingByCharacterId = new Map(resolved.batting.map((entry) => [String(entry.characterId), entry]))
  const rows = []
  for (const [fieldId, characterId] of Object.entries(sitePositions)) {
    const position = SHARED_POSITION_BY_FIELD_ID[fieldId]
    const entry = battingByCharacterId.get(String(characterId))
    if (!position || !entry) continue
    rows.push(addSourceFields({
      game_id: TARGET_GAME_ID,
      team_id: resolved.teamId,
      player_name: playerNamesById[String(resolved.playerId)] || '',
      character: entry.characterName,
      position,
      inning_from: 1,
      inning_to: null,
    }))
  }

  const teamLabel = resolved.teamName || playerNamesById[String(resolved.playerId)] || resolved.playerId
  if (rows.length !== 9
      || new Set(rows.map((row) => row.position)).size !== 9
      || new Set(rows.map((row) => row.character)).size !== 9) {
    log(`no site fielding map to seed for ${teamLabel}: ` +
      `${rows.length}/9 positions matched this game's lineup, waiting for the tracker's alignment instead`)
    return false
  }

  const desiredKeys = new Set(rows.map((row) => `${normalizeCharacterName(row.character)}:${row.position}`))
  const incompatibleExisting = (existing || []).find((row) => (
    !desiredKeys.has(`${normalizeCharacterName(row.character)}:${row.position}`)
  ))
  if (incompatibleExisting) {
    throw new Error(`existing fielding row ${incompatibleExisting.id} conflicts with the site lineup and was preserved`)
  }

  const data = await insertRowsReconciled(supabase, GAME_TABLES.gameFielders, rows, {
    keyFields: ['game_id', 'team_id', 'character'],
    compareFields: ['game_id', 'team_id', 'character', 'position', 'inning_from', 'inning_to'],
  })
  if (data.length !== 9) throw new Error(`expected to verify 9 seeded fielder rows, verified ${data.length}`)
  log(`seeded ${teamLabel}'s fielding from the site lineup (game has not begun; site is still the source of truth)`)
  return true
}

async function syncTrackerAlignment(alignment) {
  const resolved = resolveTrackerAlignment(alignment)
  // The tracker only knows a defensive alignment once the game hands it one,
  // which is at the first pitch. Its arrival IS the game beginning, and from
  // here the in-game lineup is authoritative for this game.
  markTrackerGameBegun('tracker announced a starting alignment')
  rememberTrackerTeamSide(resolved.teamName, resolved.playerId)
  const signature = JSON.stringify({
    batting: resolved.batting.map((entry) => entry.characterId),
    fielding: resolved.fielding.map((entry) => [entry.positionNumber, entry.characterId]),
  })
  if (appliedAlignmentSignaturesByPlayerId.get(String(resolved.playerId)) === signature) return

  await replaceTrackerLineupRows(resolved)
  await replaceTrackerStartingFielders(resolved)
  appliedBattingSignaturesByPlayerId.set(
    String(resolved.playerId),
    JSON.stringify(resolved.batting.map((entry) => entry.characterId)),
  )
  appliedAlignmentSignaturesByPlayerId.set(String(resolved.playerId), signature)
  liveState.alignments = {
    ...(liveState.alignments || {}),
    [String(resolved.playerId)]: {
      teamName: resolved.teamName,
      batting: resolved.batting.map((entry) => entry.characterName),
      fielding: Object.fromEntries(resolved.fielding.map((entry) => [entry.position, entry.characterName])),
      source: resolved.source,
    },
  }
  log(`lineup synced for ${resolved.teamName || playerNamesById[String(resolved.playerId)]}: ` +
    resolved.batting.map((entry) => entry.characterName).join(', '))
}

async function syncTrackerBattingOrder(order) {
  const resolved = resolveTrackerBattingOrder(order)
  rememberTrackerTeamSide(resolved.teamName, resolved.playerId)
  const signature = JSON.stringify(resolved.batting.map((entry) => entry.characterId))
  if (appliedBattingSignaturesByPlayerId.get(String(resolved.playerId)) === signature) return

  await replaceTrackerLineupRows(resolved)
  if (!trackerGameHasBegun) {
    // Match init, not the first pitch. The batting order the tracker is
    // reading here is the one the site put into the game moments ago, so
    // there is nothing in it to push back -- and the site row still holds the
    // fielding half that the game has not announced yet. Pull that in.
    await seedGameFieldersFromSiteLineup(resolved)
  }
  appliedBattingSignaturesByPlayerId.set(String(resolved.playerId), signature)
  const prior = liveState.alignments?.[String(resolved.playerId)] || {}
  liveState.alignments = {
    ...(liveState.alignments || {}),
    [String(resolved.playerId)]: {
      ...prior,
      teamName: resolved.teamName || prior.teamName,
      batting: resolved.batting.map((entry) => entry.characterName),
      source: resolved.source,
    },
  }
  log(`batting order synced for ${resolved.teamName || playerNamesById[String(resolved.playerId)]}: ` +
    resolved.batting.map((entry) => entry.characterName).join(', '))
}

async function syncTrackerPositionChange(characterName, position) {
  const characterId = resolveCharacterId(characterName)
  const playerId = resolvePlayerIdForCharacter(characterName)
  const positionNumber = TRACKER_POSITION_NUMBERS[position.toUpperCase()]
  if (characterId == null || playerId == null || positionNumber == null) {
    throw new Error(`could not resolve position change: ${characterName} -> ${position}`)
  }
  const teamId = isSeasonGame() ? TEAM_ID_BY_PLAYER_ID[String(playerId)] : playerId
  if (teamId == null) throw new Error(`could not resolve site team for ${characterName}`)

  const { data: openRows, error: readError } = await supabase.from(GAME_TABLES.gameFielders)
    .select('id,character,position,inning_from,inning_to,pa_from')
    .eq('game_id', TARGET_GAME_ID).eq('team_id', teamId).is('inning_to', null)
  if (readError) throw readError

  const canonicalName = characterNamesById[String(characterId)] || characterName
  const resolvedOpenRows = (openRows || []).map((row) => ({
    ...row,
    character_id: resolveCharacterId(row.character),
  }))
  const plan = planTrackerPositionChange(resolvedOpenRows, {
    characterId,
    characterName: canonicalName,
    positionNumber,
  })
  // Keeps the in-memory alignment (used by currentFieldingPositionNumber to
  // credit live putouts/assists) current across mid-game position swaps —
  // otherwise a substitution would go on crediting whoever held the
  // position at the start of the game.
  const applyAssignmentsToLiveAlignment = () => {
    const prior = liveState.alignments?.[String(playerId)] || {}
    const fielding = { ...(prior.fielding || {}) }
    for (const [pos, existingName] of Object.entries(fielding)) {
      if (plan.assignments.some((assignment) => sameCharacterName(existingName, assignment.characterName))) {
        delete fielding[pos]
      }
    }
    for (const assignment of plan.assignments) {
      const positionName = TRACKER_POSITIONS_BY_NUMBER[Number(assignment.positionNumber)]
      const assignmentName = characterNamesById[String(assignment.characterId)] || assignment.characterName
      if (positionName && assignmentName) fielding[positionName] = assignmentName
    }
    liveState.alignments = { ...(liveState.alignments || {}), [String(playerId)]: { ...prior, fielding } }
  }

  if (plan.alreadyApplied) {
    applyAssignmentsToLiveAlignment()
    return
  }

  const currentInning = Math.max(1, Number(parserInning || liveState.inning || 1))
  // Plate appearances are written in this same serialized chain, so the last
  // one saved is the last play before the change. A change after a play in
  // this inning closes the old rows at that play instead of deleting them.
  const { data: lastPa, error: lastPaError } = await supabase.from(GAME_TABLES.plateAppearances)
    .select('pa_number,inning').eq('game_id', TARGET_GAME_ID)
    .order('pa_number', { ascending: false }).limit(1).maybeSingle()
  if (lastPaError) throw lastPaError
  const { toClose, toDelete, closeWith, newRowBounds } = planFielderStintChange(plan.affectedRows, {
    currentInning, lastPa,
  })
  if (toClose.length) {
    const { error } = await supabase.from(GAME_TABLES.gameFielders)
      .update(closeWith).in('id', toClose.map((row) => row.id))
    if (error) throw error
  }
  if (toDelete.length) {
    const { error } = await supabase.from(GAME_TABLES.gameFielders)
      .delete().in('id', toDelete.map((row) => row.id))
    if (error) throw error
  }

  const inserts = plan.assignments.map((assignment) => addSourceFields({
    game_id: TARGET_GAME_ID,
    team_id: teamId,
    player_name: playerNamesById[String(playerId)] || '',
    character: characterNamesById[String(assignment.characterId)] || assignment.characterName,
    position: assignment.positionNumber,
    ...newRowBounds,
    inning_to: null,
  }))
  const { error: insertError } = await supabase.from(GAME_TABLES.gameFielders).insert(inserts)
  if (insertError) throw insertError
  applyAssignmentsToLiveAlignment()
  log(`fielding change synced: ${plan.assignments.map((assignment) => (
    `${characterNamesById[String(assignment.characterId)] || assignment.characterName} -> `
    + TRACKER_POSITIONS_BY_NUMBER[Number(assignment.positionNumber)]
  )).join(', ')} (inning ${currentInning})`)
}

// ── play-by-play recording: turns the tracker's own console text into real
// plate_appearances/pitches/runs_scored/pitching_stints rows — the same
// tables the manual scorebook's saveEnhancedPA writes, so tracker games
// actually credit player stats and keep the live score in sync instead of
// only showing a display-only blob. Mirrors the literal `result` enum and
// derivation helpers from src/utils/statsCalculator.js / Scorebook.jsx.
//
// The stock tracker's log has no way to tell us every detail the manual
// scorebook captures. The experimental advanced-stat build now supplies exit
// velocity, launch angle, spray angle, and landing/catch distance; unsupported
// details are still left null for later review in the site's At-Bat editor.
// Anything the parser can't confidently classify (an unrecognized result
// phrase, an out on a non-batter runner, etc.) is skipped with a console
// warning rather than guessed, so it doesn't write wrong stats — that PA is
// left for manual entry instead.

const OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])

function isHomeRunResult(result) {
  return result === 'HR' || result === 'IPHR'
}

function isOfficialAtBat(result) {
  return !['BB', 'HBP', 'SF', 'SH'].includes(result)
}

function calculateOutsForPa(result, outsOnPlay = null) {
  if (outsOnPlay != null) return Number(outsOnPlay)
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1
  if (OUT_RESULTS.has(result)) return 1
  return 0
}

function inningsPitchedFromOuts(outs = 0) {
  const safeOuts = Math.max(0, Number(outs || 0))
  return Number(`${Math.floor(safeOuts / 3)}.${safeOuts % 3}`)
}

// ── runner-identity replay ──────────────────────────────────────────────────
// PA replay is the fallback for older tracker builds/logs. Current tracker
// output reports each occupied base at the beginning of a matchup; that
// snapshot is applied later as the authoritative state because default hit
// advancement cannot know, for example, that a runner took two bases on a
// single.
const CLEARS_BASES = new Set(['HR', 'IPHR', 'TP'])
const HOLDS_RUNNERS = new Set(['K'])
const HIT_LIKE = new Set(['1B', '2B', '3B', 'BB', 'HBP', 'ROE'])
const OUT_LIKE = new Set(['GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'FC'])

function runnerKey(runner) {
  return runner ? `${runner.characterId}:${runner.playerId}` : null
}

// The generic default advance (e.g. a single sends a runner from 2nd only to
// 3rd, not home) is a guess — real plays routinely score a runner from 2nd
// on a single depending on how it's hit. runs_scored rows are ground truth
// for exactly WHO scored on a given PA (finalizeCurrentPaIfAny already
// records them by resolved character/player id), so once the default
// assignment is computed, clear any pre-play occupant who's a confirmed
// scorer off whatever base the default guess left them on, instead of
// trusting the guess over the fact.
function applyKnownScorers(nextRunners, scorerKeys) {
  if (!scorerKeys || !scorerKeys.size) return nextRunners
  const result = { ...nextRunners }
  for (const base of ['first', 'second', 'third']) {
    // A scoring runner ends up on whatever base the default guess landed
    // them on — not necessarily the same base key they started the play on
    // (that's the whole point of advancing) — so this only needs to check
    // where they ended up, not where they started.
    if (result[base] && scorerKeys.has(runnerKey(result[base]))) {
      result[base] = null
    }
  }
  return result
}

function replayOnePa(pa, runners, scorerKeys) {
  const batterRunner = { characterId: pa.character_id, playerId: pa.player_id }
  if (CLEARS_BASES.has(pa.result)) return { first: null, second: null, third: null }
  if (HOLDS_RUNNERS.has(pa.result)) return runners
  if (HIT_LIKE.has(pa.result)) return applyKnownScorers(extractNextRunners(computePendingState(pa.result, runners, batterRunner)), scorerKeys)
  if (OUT_LIKE.has(pa.result)) return applyKnownScorers(extractNextRunners(computePendingOutState(pa.result, runners, batterRunner)), scorerKeys)
  return runners
}

// Replays every PA in the current half-inning (bases reset at the start of
// each) to reconstruct who is actually on base right now.
function deriveCurrentRunners(sortedPAs, totalOuts, scorerKeysByPaId) {
  const halfInningStartOuts = Math.floor(totalOuts / 3) * 3
  let runners = { first: null, second: null, third: null }
  let runningOuts = 0
  for (const pa of sortedPAs) {
    if (runningOuts >= halfInningStartOuts) {
      runners = replayOnePa(pa, runners, scorerKeysByPaId?.get(String(pa.id)))
    }
    runningOuts += calculateOutsForPa(pa.result, pa.outs_on_play)
  }
  return runners
}

function isSeasonGame() {
  return TARGET_GAMES_TABLE === 'season_schedule'
}

function addSourceFields(payload) {
  if (!isSeasonGame()) return payload
  return { ...payload, season_id: TARGET_SEASON_ID }
}

async function latestGamePitchNumber() {
  const { data, error } = await supabase
    .from(GAME_TABLES.pitches)
    .select('pitch_number_game')
    .eq('game_id', TARGET_GAME_ID)
    .order('pitch_number_game', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return Number(data?.pitch_number_game || 0)
}

async function insertPlateAppearance(payload) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const withPaNumber = { ...payload, pa_number: await nextPaNumber() }
    const { data, error } = await supabase
      .from(GAME_TABLES.plateAppearances).insert(withPaNumber).select().single()
    if (!error) {
      // Belt and braces for a session that never saw [TRACKER_LINEUP] -- a
      // stock tracker build, or a bridge that attached mid-game. A recorded
      // plate appearance means the game is unambiguously underway.
      markTrackerGameBegun('a plate appearance was recorded')
      return data
    }
    if (error.code === '23505') continue // pa_number raced the manual scorebook — refetch and retry
    throw error
  }
  throw new Error('gave up inserting plate appearance after repeated pa_number conflicts')
}

// One row per (game_id, player_id) pitching stint. Tracker games previously
// had zero stint rows (Scorebook.jsx synthesizes the *current* pitcher from
// live_state instead) — this creates real rows so pitching stats have
// somewhere to accumulate, same shape `changePitcher` inserts in Scorebook.jsx.
const stintCacheByPlayerId = {}

async function ensureActiveStint(playerId, characterId) {
  if (playerId == null || characterId == null) return null
  const key = String(playerId)
  const cached = stintCacheByPlayerId[key]
  if (cached && Number(cached.character_id) === Number(characterId)) return cached

  const { data: existing, error } = await supabase
    .from(GAME_TABLES.pitchingStints).select('*')
    .eq('game_id', TARGET_GAME_ID).eq('player_id', playerId)
    .order('created_at', { ascending: false }).limit(1)
  if (error) throw error
  const latest = (existing || [])[0]
  if (latest && Number(latest.character_id) === Number(characterId)) {
    stintCacheByPlayerId[key] = latest
    return latest
  }

  const { data: inserted, error: insertError } = await supabase
    .from(GAME_TABLES.pitchingStints)
    .insert(addSourceFields({
      game_id: TARGET_GAME_ID, player_id: playerId, character_id: characterId,
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0,
      walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0,
    }))
    .select().single()
  if (insertError) throw insertError
  stintCacheByPlayerId[key] = inserted
  return inserted
}

// Rebuilds every stint's cumulative line from scratch off the game's own
// plate_appearances/runs_scored/pitches rows — same approach as Scorebook.jsx's
// recomputePitchingStatsForGame, simplified (no bulk-import re-entry edge cases).
async function recomputePitchingStatsForGame() {
  const [{ data: stints, error: stintsError }, { data: pas, error: pasError },
    { data: runs, error: runsError }, { data: pitches, error: pitchesError }] = await Promise.all([
    supabase.from(GAME_TABLES.pitchingStints).select('*').eq('game_id', TARGET_GAME_ID),
    supabase.from(GAME_TABLES.plateAppearances).select('*').eq('game_id', TARGET_GAME_ID),
    supabase.from(GAME_TABLES.runsScored).select('*').eq('game_id', TARGET_GAME_ID),
    supabase.from(GAME_TABLES.pitches).select('*').eq('game_id', TARGET_GAME_ID),
  ])
  const firstError = stintsError || pasError || runsError || pitchesError
  if (firstError) throw firstError
  if (!stints || !stints.length) return

  const sortedStints = [...stints].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const sortedPAs = [...(pas || [])].sort((a, b) => {
    const paA = Number(a.pa_number)
    const paB = Number(b.pa_number)
    if (Number.isFinite(paA) && Number.isFinite(paB) && paA !== paB) return paA - paB
    return new Date(a.created_at) - new Date(b.created_at)
  })
  const statsByStintId = Object.fromEntries(sortedStints.map((s) => [s.id, {
    innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0,
    walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0, _outs: 0,
  }]))

  const stintFor = (characterId, atOrBefore) => {
    const eligible = sortedStints.filter((s) => (
      String(s.character_id) === String(characterId) && new Date(s.created_at).getTime() <= new Date(atOrBefore).getTime()
    ))
    return eligible[eligible.length - 1] || null
  }

  for (const pa of sortedPAs) {
    const activeStint = pa.pitcher_id != null ? stintFor(pa.pitcher_id, pa.created_at) : null
    if (!activeStint) continue
    const stat = statsByStintId[activeStint.id]
    const outs = calculateOutsForPa(pa.result, pa.outs_on_play)
    stat._outs += outs
    if (isCreditedHit(pa)) stat.hits_allowed += 1
    if (isCreditedHit(pa) && isHomeRunResult(pa.result)) stat.hr_allowed += 1
    if (pa.result === 'BB') stat.walks += 1
    if (pa.result === 'K') stat.strikeouts += 1

    const paPitches = (pitches || []).filter((p) => String(p.pa_id) === String(pa.id))
    stat.pitches_thrown += paPitches.length
    stat.strikes_thrown += paPitches.filter((p) => p.result !== 'ball' && p.result !== 'hbp').length

    const paRuns = (runs || []).filter((r) => String(r.pa_id) === String(pa.id))
    for (const run of paRuns) {
      let target = stat
      if (String(run.charged_to_pitcher_id) !== String(activeStint.character_id)) {
        const chargedStint = stintFor(run.charged_to_pitcher_id, pa.created_at)
        if (chargedStint) target = statsByStintId[chargedStint.id]
      }
      target.runs_allowed += 1
      if (run.is_earned_run !== false) target.earned_runs += 1
    }
  }

  const updates = await Promise.all(sortedStints.map((s) => {
    const { _outs, ...rest } = statsByStintId[s.id]
    rest.innings_pitched = inningsPitchedFromOuts(_outs)
    return supabase.from(GAME_TABLES.pitchingStints).update(rest).eq('id', s.id)
  }))
  const failedUpdate = updates.find((result) => result.error)
  if (failedUpdate) throw failedUpdate.error
}

// ── direct score sync ───────────────────────────────────────────────────────
// The tracker announces the running score by team name after every side
// change ("Mario Fireballs - 3" / "Wario Muscles - 0") and again in the
// final summary. Syncing straight from those lines keeps games.team_a_runs/
// team_b_runs (or season_schedule.away_score/home_score) correct even if
// the play-by-play reconstruction below misses or misclassifies a play.

// The two names the scoreboard lines are keyed by, as the tracker's game
// header printed them ("Waluigi Spitballs", "Luigi Knights"). The ORDER of that
// header is deliberately not stored: see the header handler in
// processPlayEvent for why it is not evidence about which side is which.
let scoreboardTeamNames = []
const scoreState = { a: null, b: null }
let scoreSyncDebounce = null

function setLiveScoreForSide(side, value, { syncGame = true, scoreName = null } = {}) {
  const normalizedSide = String(side || '').toUpperCase()
  const normalizedValue = Number(value)
  if (!['A', 'B'].includes(normalizedSide) || !Number.isFinite(normalizedValue)) return false

  const stateKey = normalizedSide.toLowerCase()
  scoreState[stateKey] = normalizedValue
  liveState.scoreBySide = {
    ...(liveState.scoreBySide || {}),
    [stateKey]: normalizedValue,
  }

  // Keep the legacy named score map current for older clients, but publish a
  // side-keyed score too. The tracker only prints the named scoreboard at a
  // side change, while individual run messages arrive immediately; without
  // this, the snapshot can lag the game row for an entire half inning.
  const names = new Set()
  if (scoreName) names.add(String(scoreName).trim())
  // A scoreboard name belongs to this side when the roster says so, never
  // because of where it appeared in the game header.
  scoreboardTeamNames.forEach((name) => {
    if (inferTrackerScoreSide(name) === normalizedSide) names.add(name)
  })
  Object.entries(trackerTeamMapping).forEach(([name, mappedSide]) => {
    if (mappedSide === normalizedSide) names.add(name)
  })
  names.forEach((name) => {
    if (name) liveState.score[name] = normalizedValue
  })

  if (syncGame) triggerScoreSync()
  return true
}

function triggerScoreSync() {
  clearTimeout(scoreSyncDebounce)
  scoreSyncDebounce = setTimeout(() => {
    syncScoreFromTracker().catch((err) => log('score sync failed:', err.message))
  }, 300)
}

// THE RUNNING SCORE IS THE SAME ROW THE FINAL SCORE IS. It had no lease guard
// at all -- not even the client-side one -- so a bridge that had lost the game
// went on overwriting the score of the game the new owner was recording. It
// takes the completion function's route now, which asserts the lease in the
// transaction that writes.
async function syncScoreFromTracker() {
  if (scoreState.a == null || scoreState.b == null) return
  const gameEnded = liveState.gameEnded
  try {
    assertLeaseWritable('the live score sync')
    const payload = isSeasonGame()
      ? { away_score: scoreState.a, home_score: scoreState.b }
      : { team_a_runs: scoreState.a, team_b_runs: scoreState.b }
    const fenced = await callFencedGameMutation(
      'tracker_apply_game_completion', { p_completion: payload }, 'the live score sync')
    if (!fenced.fenced) {
      const { error } = await supabase.from(TARGET_GAMES_TABLE).update(payload).eq('id', TARGET_GAME_ID)
      if (error) throw error
    }
    if (gameEnded) await finalizeTrackerGame()
  } finally {
    // A failed database finalization must not leave the tracker waiting for
    // someone to stop it by hand. Shutdown retries and reports the failure.
    if (gameEnded) scheduleCompletedGameShutdown()
  }
}

function trackerSourceType() {
  return isSeasonGame() ? 'season' : 'tournament'
}

function expectedTrackerPitchersByPlayer() {
  const result = {}
  Object.entries(liveState.alignments || {}).forEach(([playerId, alignment]) => {
    const pitcherName = alignment?.fielding?.P
    const characterId = resolveCharacterId(pitcherName)
    if (characterId != null) result[playerId] = characterId
  })
  if (liveState.matchup?.left) {
    const playerId = resolvePlayerIdForCharacter(liveState.matchup.left)
    const characterId = resolveCharacterId(liveState.matchup.left)
    if (playerId != null && characterId != null) result[playerId] = characterId
  }
  return result
}

let bettingSyncDebounce = null
let bettingSyncPromise = null
let bettingSyncVersion = 0
let requestedMarketSignature = null
let queuedMarketSignature = null
let lastPricedMarketSignature = null

function buildMarketStateSignature() {
  return buildTrackerMarketInputSignature({
    scoreState,
    liveState: buildLiveStatePayload(),
    expectedPitcherByPlayer: expectedTrackerPitchersByPlayer(),
    completedPaRevision,
  })
}

// THE ODDS LOCK IS PUBLISHED INTO THE SAME ROW EVERY OTHER LIVE WRITE IS
// FENCED ON, and it was the one that still went straight at it. Both of its
// writes are separated from the moment they were decided -- the opening `true`
// waits behind a debounce and the queue, and the closing `false` waits for a
// whole pricing pass -- so either can arrive after another machine has taken
// the game and published its own feed, and an ordinary update would overwrite
// that feed wholesale with this bridge's stale copy of it.
//
// It takes the live-state publish's own route now: ownership asserted inside
// the transaction that writes. A refusal is logged and DROPPED, never retried
// as a plain update -- a bridge that has lost the game has nothing to say about
// whether its odds are still being calculated.
async function publishOddsCalculationState(isCalculating) {
  liveState.oddsCalculating = Boolean(isCalculating)
  liveState.oddsRevision = completedPaRevision
  liveState.oddsStatusUpdatedAt = new Date().toISOString()

  const payload = {
    game_id: TARGET_GAME_ID,
    live_feed: { ...liveState },
    updated_at: new Date().toISOString(),
  }
  try {
    assertLeaseWritable('the live-odds calculation state')
    // The game row's own live_state carries oddsCalculating/oddsRevision too,
    // so the lock the site reads off the game and the lock it reads off the
    // stats row move together instead of the second one lagging until the next
    // unrelated state push.
    const fenced = await callFencedGameMutation('tracker_publish_live_state', {
      p_stats: payload, p_live_state: buildLiveStatePayload(),
    }, 'the live-odds calculation state')
    if (!fenced.fenced) {
      const { error } = await supabase.from(TARGET_STATS_TABLE)
        .update({ live_feed: payload.live_feed, updated_at: payload.updated_at })
        .eq('game_id', TARGET_GAME_ID)
      if (error) throw error
    }
  } catch (error) {
    log('could not publish live-odds calculation state:', error.message)
  }
}

function runQueuedBettingSync(signature) {
  queuedMarketSignature = signature
  if (bettingSyncPromise) return bettingSyncPromise

  bettingSyncPromise = (async () => {
    let calculationPublished = false
    try {
      while (queuedMarketSignature && !liveState.gameEnded) {
        const targetSignature = queuedMarketSignature
        queuedMarketSignature = null
        if (targetSignature === lastPricedMarketSignature || targetSignature !== buildMarketStateSignature()) continue

        if (!calculationPublished) {
          calculationPublished = true
          await publishOddsCalculationState(true)
        }
        await syncTrackerLiveOdds({
          supabase,
          sourceType: trackerSourceType(),
          sourceId: TARGET_SOURCE_ID,
          gameId: TARGET_GAME_ID,
          liveState: buildLiveStatePayload(),
          teamARuns: scoreState.a,
          teamBRuns: scoreState.b,
          expectedPitcherByPlayer: expectedTrackerPitchersByPlayer(),
          regulationInnings: TARGET_GAME_ROW?.innings,
          // If another completed at-bat lands while the data queries are
          // running, do not publish obsolete prices. Keep the game disabled
          // and immediately calculate the newest completed state instead.
          shouldPersist: () => targetSignature === buildMarketStateSignature(),
        })
        if (targetSignature === buildMarketStateSignature()) {
          lastPricedMarketSignature = targetSignature
          requestedMarketSignature = null
        }
      }
    } finally {
      if (calculationPublished) {
        // Let any state pushes that began while pricing finish first. They all
        // carry the shared calculation flag, so publishing `false` last keeps
        // an older request from re-locking the board after prices are ready.
        await pushStateQueue.catch(() => {})
        await publishOddsCalculationState(false)
      }
    }
  })().finally(() => {
    bettingSyncPromise = null
    // A completed at-bat can arrive while the final unlocked state is being
    // published. It has already queued its signature, so start the next pass
    // instead of leaving it stranded until an unrelated tracker event.
    if (queuedMarketSignature && !liveState.gameEnded) {
      const nextSignature = queuedMarketSignature
      runQueuedBettingSync(nextSignature).catch((err) => {
        requestedMarketSignature = null
        log('queued live odds sync failed:', err.message)
      })
    }
  })

  return bettingSyncPromise
}

function triggerBettingSync() {
  if (liveState.gameEnded) return
  // Result/RBI/run messages arrive before the next matchup header closes and
  // persists the PA. Never price that half-written play; finalizeCurrentPaIfAny
  // triggers again after PA, run and pitching rows are all authoritative.
  if (currentPaBuffer?.result || paFinalizationInProgress) {
    requestedMarketSignature = null
    bettingSyncVersion += 1
    clearTimeout(bettingSyncDebounce)
    return
  }
  const signature = buildMarketStateSignature()
  if (signature === lastPricedMarketSignature) {
    if (requestedMarketSignature) {
      requestedMarketSignature = null
      bettingSyncVersion += 1
      clearTimeout(bettingSyncDebounce)
    }
    return
  }
  if (signature === requestedMarketSignature) return

  requestedMarketSignature = signature
  const requestedVersion = ++bettingSyncVersion
  clearTimeout(bettingSyncDebounce)
  bettingSyncDebounce = setTimeout(async () => {
    // A completed play writes its PA, runs and pitching totals through the
    // play queue. Await those writes, then capture the final signature once.
    await Promise.all([
      playEventChain.catch(() => {}),
      pushStateQueue.catch(() => {}),
    ])
    if (requestedVersion !== bettingSyncVersion || liveState.gameEnded || currentPaBuffer?.result) {
      requestedMarketSignature = null
      return
    }
    const finalSignature = buildMarketStateSignature()
    requestedMarketSignature = finalSignature
    runQueuedBettingSync(finalSignature).catch((err) => {
      requestedMarketSignature = null
      log('live odds sync failed:', err.message)
    })
  }, ODDS_REPRICE_DEBOUNCE_MS)
}

let finalizationPromise = null
let finalScoreWorkbookSyncBaseline = null
let completedGameStopScheduled = false

function scheduleCompletedGameShutdown() {
  if (!invokedDirectly || !AUTO_EXIT_AFTER_GAME || completedGameStopScheduled) return
  completedGameStopScheduled = true
  // The prompt has no terminating newline, so readline never reports it.
  // Write the answer as soon as the final score is known; stdin buffers it
  // until the tracker reaches "Continue searching for more games? (Y/N)".
  if (trackerProcess?.stdin?.writable) {
    trackerProcess.stdin.write('N\n')
    log('answered N to the tracker next-game prompt')
  }
  setImmediate(() => (async () => {
    const baseline = finalScoreWorkbookSyncBaseline ?? completedWorkbookSyncs
    const deadline = Date.now() + 10000
    while (completedWorkbookSyncs <= baseline && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (completedWorkbookSyncs <= baseline) {
      log('final workbook did not sync within 10 seconds; stopping capture anyway')
    } else {
      requestPlayerTrackingStop()
      const trackerExitDeadline = Date.now() + 15000
      while (trackerProcess && Date.now() < trackerExitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    await requestCompletedGameStop()
  })().catch((error) => log('automatic game shutdown failed:', error.message)))
}

async function finalizeTrackerGame() {
  if (scoreState.a == null || scoreState.b == null) return
  if (finalizationPromise) return finalizationPromise

  finalizationPromise = (async () => {
    assertLeaseWritable('game completion')
    await playEventChain
    if (currentPaBuffer?.result) {
      enqueuePlayEvent('Changing sides!')
      await playEventChain
    }
    const hadRecoverableJournalEvent = scoringPersistence.journal.events.some((event) => event.stage !== 'complete')
    await scoringPersistence.verifyAll()
    if (requiredPersistenceFailure) {
      if (!hadRecoverableJournalEvent) {
        throw new Error(`game completion blocked by required scoring write: ${requiredPersistenceFailure.message}`)
      }
      requiredPersistenceFailure = null
    }
    await pushStateQueue
    const winnerPlayerId = scoreState.a === scoreState.b
      ? null
      : scoreState.a > scoreState.b ? TARGET_TEAM_A_PLAYER_ID : TARGET_TEAM_B_PLAYER_ID
    const finalInning = Math.max(1, Number(liveState.inning || 1))
    const regulationInnings = Math.max(1, Number(TARGET_GAME_ROW?.innings || 3))
    const completion = isSeasonGame()
      ? {
          status: 'completed',
          away_score: scoreState.a,
          home_score: scoreState.b,
          winner_team_id: winnerPlayerId == null ? null : TEAM_ID_BY_PLAYER_ID[String(winnerPlayerId)] || null,
          final_inning: finalInning,
          is_extra_innings: finalInning > regulationInnings,
          live_state: buildLiveStatePayload(),
        }
      : {
          status: 'complete',
          team_a_runs: scoreState.a,
          team_b_runs: scoreState.b,
          winner_player_id: winnerPlayerId,
          final_inning: finalInning,
          is_extra_innings: finalInning > regulationInnings,
          live_state: buildLiveStatePayload(),
        }
    // The row the whole site treats as the answer to what happened in this
    // game. Written under the lease, in the database's own transaction.
    const fencedCompletion = await callFencedGameMutation(
      'tracker_apply_game_completion', { p_completion: completion }, 'game completion')
    if (!fencedCompletion.fenced) {
      await updateRowsVerified(supabase, TARGET_GAMES_TABLE, { id: TARGET_GAME_ID }, completion)
    }

    await settleCompletedTrackerGame({
      supabase,
      sourceType: trackerSourceType(),
      sourceId: TARGET_SOURCE_ID,
      gameId: TARGET_GAME_ID,
      teamARuns: scoreState.a,
      teamBRuns: scoreState.b,
      teamBPlayerId: TARGET_TEAM_B_PLAYER_ID,
      winnerPlayerId,
    })
    const oddsTable = isSeasonGame() ? 'season_game_odds' : 'game_odds'
    const { error: oddsLockError } = await supabase.from(oddsTable)
      .update({ is_locked: true, updated_at: new Date().toISOString() })
      .eq('game_id', TARGET_GAME_ID)
    if (oddsLockError) throw oddsLockError
    await completeTrackerGameLifecycle({ winnerPlayerId })
    log(`game finalized automatically: ${scoreState.a}-${scoreState.b}; bets settled and markets locked`)
  })().catch((err) => {
    finalizationPromise = null
    throw err
  })
  return finalizationPromise
}

// What the scorebook's End Game does after it writes the final row, done here
// too. Without it a game the tracker finished had no W/L/S stamped on its
// stints, no stadium log row for the park factors, and -- in a season --
// standings that did not move until some other game was finished by hand. The
// final row and the bets are already written by now, so a failing step is
// logged and the rest still run, exactly as End Game toasts and carries on;
// every step is safe to run again.
async function completeTrackerGameLifecycle({ winnerPlayerId }) {
  const steps = [
    ['pitching decisions', assignTrackerPitchingDecisions],
    ['stadium game log', recordTrackerStadiumGameLog],
    [isSeasonGame() ? 'season standings' : 'tournament bracket', advanceTrackerCompetition],
  ]
  for (const [what, step] of steps) {
    try {
      await step({ winnerPlayerId })
    } catch (error) {
      log(`game completion: ${what} failed: ${error.message}`)
    }
  }
}

async function assignTrackerPitchingDecisions({ winnerPlayerId }) {
  const results = await Promise.all(
    [GAME_TABLES.pitchingStints, GAME_TABLES.plateAppearances, GAME_TABLES.runsScored]
      .map((table) => supabase.from(table).select('*').eq('game_id', TARGET_GAME_ID)),
  )
  const failed = results.find((result) => result.error)
  if (failed) throw failed.error
  const [stints, pas, runs] = results.map((result) => result.data || [])
  const { updates } = decideGamePitchingFlags({
    stints, pas, runs,
    teamAPlayerId: TARGET_TEAM_A_PLAYER_ID,
    teamBPlayerId: TARGET_TEAM_B_PLAYER_ID,
    winnerPlayerId,
  })
  for (const { id, patch } of updates) {
    const { error } = await supabase.from(GAME_TABLES.pitchingStints).update(patch).eq('id', id)
    if (error) throw error
  }
}

async function recordTrackerStadiumGameLog() {
  const game = TARGET_GAME_ROW || {}
  if (!game.stadium_id && !game.stadium) return
  const table = isSeasonGame() ? 'season_stadium_game_log' : 'stadium_game_log'
  const { data: existing, error: readError } = await supabase.from(table)
    .select('game_id').eq('game_id', TARGET_GAME_ID).limit(1)
  if (readError) throw readError
  if (existing?.length) return
  const totalRuns = Number(scoreState.a || 0) + Number(scoreState.b || 0)
  const row = isSeasonGame()
    ? { game_id: TARGET_GAME_ID, season_id: TARGET_SEASON_ID, stadium: game.stadium || null,
        is_night: Boolean(game.is_night), total_runs: totalRuns, confidence: 1.0 }
    : { game_id: TARGET_GAME_ID, stadium_id: game.stadium_id, is_night: Boolean(game.is_night),
        total_runs: totalRuns, confidence: 1.0 }
  const { error } = await supabase.from(table).insert(row)
  if (error) throw error
}

async function advanceTrackerCompetition({ winnerPlayerId }) {
  if (isSeasonGame()) {
    const { data: season, error } = await supabase.from('seasons')
      .select('*').eq('id', TARGET_SEASON_ID).single()
    if (error) throw error
    await completeSeasonGameLifecycle({
      supabase, season, selectedGame: TARGET_GAME_ROW, scores: { a: scoreState.a, b: scoreState.b },
    })
    return
  }
  const [tournamentResult, gamesResult] = await Promise.all([
    supabase.from('tournaments').select('*').eq('id', TARGET_SOURCE_ID).single(),
    supabase.from('games').select('*').eq('tournament_id', TARGET_SOURCE_ID),
  ])
  if (tournamentResult.error) throw tournamentResult.error
  if (gamesResult.error) throw gamesResult.error
  const games = gamesResult.data || []
  const completedGame = games.find((game) => String(game.id) === String(TARGET_GAME_ID))
  if (!completedGame) throw new Error(`game ${TARGET_GAME_ID} is not in tournament ${TARGET_SOURCE_ID}`)
  await advanceBracketOnGameComplete({
    supabase,
    tournament: tournamentResult.data,
    games,
    completedGame: { ...completedGame, winner_player_id: winnerPlayerId },
  })
}

// ── play-by-play parser state machine ───────────────────────────────────────

let parserInning = 1
let parserIsTop = true
// Tracks outs within the current half inning purely off completed PAs run
// through this same serialized play-event chain — deliberately independent
// of liveState.outs (which is updated synchronously per log line and can run
// ahead of/behind whichever PA this chain is still slowly writing to
// Supabase) so a sac-fly reclassification always sees the out count as it
// stood when this specific plate appearance actually began.
let parserOutsInHalf = 0
let currentPaBuffer = null
let paFinalizationInProgress = false
let completedPaRevision = 0
let pendingRunnerAssignmentBackfill = null
const pendingMeasuredRunnerAssignments = new Map()
// Saved plate appearances by the preview's PA number -- the number a 60 Hz
// play's join names -- so a joined play can be written against its row.
const savedPaByPreviewNumber = new Map()
let liveTrackingPersistence = null
let liveTrackingClosed = false
let liveTrackingSync = Promise.resolve()
// The tracker runner feed is delta-based: an unchanged runner is omitted from
// the next matchup entirely. Keep the current half-inning state independently
// of each PA buffer, then copy it into every new PA.
let parserRunnersInHalf = { first: null, second: null, third: null }
let parserRunnerStateInitialized = false
// Separate from pendingRunnerAssignmentBackfill (which the next batter's
// first "Count:" line consumes and clears): a batted-ball record for a
// contact that never got a real landing/catch can arrive well after that —
// its flight-timeout flush routinely loses the race against the next
// matchup line, and even against the next batter's first full pitch. This
// stays populated across that whole window so the record still finds its
// way onto the plate appearance it actually belongs to.
let lastFinalizedPa = null

function freshPaBuffer(pitcherName, batterName, pitcherIds, batterIds, battingTeamId, defensiveTeamId) {
  return {
    pitcherName, batterName,
    trackerPaNumber: null,
    pitcherCharacterId: pitcherIds.characterId, pitcherPlayerId: pitcherIds.playerId,
    batterCharacterId: batterIds.characterId, batterPlayerId: batterIds.playerId,
    battingTeamId, defensiveTeamId,
    inning: parserInning, isTop: parserIsTop,
    outsBeforePa: parserOutsInHalf,
    countSeenOnce: false,
    lastCount: { balls: 0, strikes: 0 },
    pendingPitchType: null,
    pendingStarPitch: false,
    pendingStarSwing: false,
    pendingDoublePlay: false,
    pendingTriplePlay: false,
    contactRecorded: false,
    pitches: [],
    pendingPitchTelemetry: [],
    result: null,
    unresolvedReason: null,
    rbi: 0,
    runEvents: [],
    runnersBefore: copyTrackerRunnerState(parserRunnersInHalf),
    starHitUsed: false,
    battedBallTrajectory: null,
    putoutFielderName: null,
    observedPutouts: [],
    assistFielderNames: [],
    isBuddyJump: false,
    buddyJumpFielderName: null,
    bobbleFielderName: null,
    advancedBattedBall: null,
    advancedFielding: null,
  }
}

function recordRunnerSnapshot({ characterName, base }, buf = null) {
  if (!['first', 'second', 'third'].includes(base)) return false
  const characterId = resolveCharacterId(characterName)
  const playerId = resolvePlayerIdForCharacter(characterName)
  if (characterId == null || playerId == null) return false
  const runner = { characterId, playerId }
  parserRunnersInHalf = applyTrackerRunnerDelta(parserRunnersInHalf, { base, runner })
  parserRunnerStateInitialized = true
  if (buf) buf.runnersBefore = copyTrackerRunnerState(parserRunnersInHalf)
  return true
}

function recordRunnerBeforePa(buf, runner) {
  return Boolean(buf && recordRunnerSnapshot(runner, buf))
}

function removeParserRunner(characterName) {
  const characterId = resolveCharacterId(characterName)
  const playerId = resolvePlayerIdForCharacter(characterName)
  if (characterId == null || playerId == null) return false
  parserRunnersInHalf = removeTrackerRunner(parserRunnersInHalf, { characterId, playerId })
  parserRunnerStateInitialized = true
  return true
}

function clearParserRunnerState() {
  parserRunnersInHalf = { first: null, second: null, third: null }
  parserRunnerStateInitialized = true
}

// Persist only runner movements that follow directly from the result. Hits
// with pre-existing runners and batted-ball outs can include discretionary
// advances that are not fully described by the stock play-by-play; those stay
// null until the exact post-play base snapshot is added to the tracker feed.
function runnerAssignmentsFromOutcomePlay(buf, isError, outcomePlay) {
  if (!outcomePlay) return null
  const batter = {
    characterId: Number(buf.batterCharacterId),
    playerId: buf.batterPlayerId,
    ...(isError ? { reachedOnError: true } : {}),
    chargedToPitcherId: buf.pitcherCharacterId,
    chargedToPitcherPlayerId: buf.pitcherPlayerId,
  }
  const entries = [
    {
      id: 'batter', origin: 'plate', isBatter: true,
      characterId: batter.characterId, characterName: buf.batterName, runner: batter,
    },
    ...['first', 'second', 'third'].filter((base) => buf.runnersBefore?.[base]).map((base) => ({
      id: base, origin: base, isBatter: false,
      characterId: buf.runnersBefore[base].characterId,
      characterName: characterNamesById[String(buf.runnersBefore[base].characterId)],
      runner: buf.runnersBefore[base],
    })),
  ]
  const namedIdentity = (name) => ({
    characterId: resolveCharacterId(name),
    characterName: name,
  })
  const destinations = runnerDestinationsFromPlay({
    entries,
    result: buf.result,
    scoringRunners: buf.runEvents.map((run) => namedIdentity(run.scorerName)),
    outRunners: buf.observedPutouts.map((putout) => namedIdentity(putout.runnerName)),
    inningEndedOnThisPlay:
      buf.outsBeforePa + trackerOutsOnPlay(buf, calculateOutsForPa(buf.result, null)) >= 3,
    play: outcomePlay,
  })
  if (!destinations) return null
  return destinations.map((destination, index) => ({
    id: entries[index].id,
    runner: entries[index].runner,
    origin: entries[index].origin,
    destination: destination.destination,
    isBatter: entries[index].isBatter,
    // Which base a retired runner was going for, from the throw that got him.
    ...(destination.attemptedBase ? { attemptedBase: destination.attemptedBase } : {}),
  }))
}

function deterministicRunnerAssignments(buf, isError, outcomePlay = null) {
  const measured = runnerAssignmentsFromOutcomePlay(buf, isError, outcomePlay)
  if (measured) return measured
  const runners = buf.runnersBefore || { first: null, second: null, third: null }
  const batter = {
    characterId: Number(buf.batterCharacterId),
    playerId: buf.batterPlayerId,
    ...(isError ? { reachedOnError: true } : {}),
    chargedToPitcherId: buf.pitcherCharacterId,
    chargedToPitcherPlayerId: buf.pitcherPlayerId,
  }
  const hasRunners = Boolean(runners.first || runners.second || runners.third)

  if (buf.result === 'K') {
    return [
      { id: 'batter', runner: batter, origin: 'plate', destination: 'out', isBatter: true },
      ...['first', 'second', 'third'].filter((base) => runners[base]).map((base) => ({
        id: base, runner: runners[base], origin: base, destination: base, isBatter: false,
      })),
    ]
  }

  if (buf.result === 'HR' || buf.result === 'IPHR') {
    return [
      { id: 'batter', runner: batter, origin: 'plate', destination: 'home', isBatter: true },
      ...['first', 'second', 'third'].filter((base) => runners[base]).map((base) => ({
        id: base, runner: runners[base], origin: base, destination: 'home', isBatter: false,
      })),
    ]
  }
  if (buf.result === 'BB' || buf.result === 'HBP') {
    return computePendingState(buf.result, runners, batter).assignments
  }
  if (!hasRunners && ['1B', '2B', '3B', 'ROE'].includes(buf.result)) {
    return computePendingState(buf.result, runners, batter).assignments
  }
  if (!hasRunners && ['GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'TP', 'K'].includes(buf.result)) {
    return [{ id: 'batter', runner: batter, origin: 'plate', destination: 'out', isBatter: true }]
  }
  if (!hasRunners && buf.result === 'FC') {
    return [{ id: 'batter', runner: batter, origin: 'plate', destination: 'first', isBatter: true }]
  }
  return null
}

async function backfillPriorRunnerAssignments(nextPaBuffer) {
  const pending = pendingRunnerAssignmentBackfill
  pendingRunnerAssignmentBackfill = null
  if (!pending || !nextPaBuffer) return
  const { buf, savedPa, savedPaId, isError } = pending
  // A side change clears the bases; it is not a post-play runner snapshot for
  // the previous offense, so retain the conservative assignments already
  // written for that inning-ending PA.
  if (String(buf.battingTeamId) !== String(nextPaBuffer.battingTeamId)) return

  const runnerForName = (name) => {
    const characterId = resolveCharacterId(name)
    const playerId = resolvePlayerIdForCharacter(name)
    return characterId == null || playerId == null ? null : { characterId, playerId }
  }
  const runnerKey = (runner) => runner ? `${runner.characterId}:${runner.playerId}` : null
  const scoringRunnerKeys = new Set(buf.runEvents.map((run) => runnerKey(runnerForName(run.scorerName))).filter(Boolean))
  const outRunnerKeys = new Set(buf.observedPutouts.map((putout) => runnerKey(runnerForName(putout.runnerName))).filter(Boolean))
  const batter = {
    characterId: Number(buf.batterCharacterId),
    playerId: buf.batterPlayerId,
    ...(isError ? { reachedOnError: true } : {}),
    chargedToPitcherId: buf.pitcherCharacterId,
    chargedToPitcherPlayerId: buf.pitcherPlayerId,
  }
  const assignments = buildExactTrackerRunnerAssignments({
    runnersBefore: buf.runnersBefore,
    batter,
    nextRunners: nextPaBuffer.runnersBefore,
    scoringRunnerKeys,
    outRunnerKeys,
    batterOut: ['K', 'GO', 'FO', 'LO', 'SF', 'SH'].includes(buf.result),
  })
  if (!assignments) {
    log(`runner destinations for ${buf.batterName}'s ${buf.result} were not fully described by the next-base snapshot; retaining conservative values.`)
    return
  }
  const { data, error } = await supabase.from(GAME_TABLES.plateAppearances)
    .update({ runner_assignments: assignments })
    .eq('id', savedPaId)
    .is('runner_assignments', null).select('id')
  if (error) log(`exact runner-assignment update failed for ${buf.batterName}:`, error.message)
  else {
    pendingMeasuredRunnerAssignments.delete(savedPaId)
    if (data?.length) await persistAdvancedOpportunitiesForPa({ ...savedPa, runner_assignments: assignments }, buf)
  }
}

async function backfillMeasuredRunnerAssignments() {
  for (const [paId, pending] of pendingMeasuredRunnerAssignments) {
    const { buf, savedPa, isError } = pending
    const play = trackerPreviewOutcomePlay(previewState, buf.previewPaNumber)
    const assignments = runnerAssignmentsFromOutcomePlay(buf, isError, play)
    if (!assignments) continue
    // Only fill an unresolved record. An editor or the exact next-base
    // snapshot may already have supplied the destinations while we waited.
    const { data, error } = await supabase.from(GAME_TABLES.plateAppearances)
      .update({ runner_assignments: assignments }).eq('id', paId)
      .is('runner_assignments', null).select('id')
    if (error) { log(`late runner-assignment update failed for PA ${paId}:`, error.message); continue }
    if (data?.length) {
      await persistAdvancedOpportunitiesForPa({ ...savedPa, runner_assignments: assignments }, buf)
      if (buf.previewPaNumber != null) {
        savedPaByPreviewNumber.set(buf.previewPaNumber, { ...savedPa, runner_assignments: assignments })
      }
    }
    pendingMeasuredRunnerAssignments.delete(paId)
  }
}

// Movement and fielding facts for every play that has joined a saved plate
// appearance, written as the game goes -- see
// scripts/tracker_live_tracking_persistence.mjs. Never required: a failure here
// is logged and the postgame ingest writes the authoritative version anyway.
function syncLiveTrackingFacts() {
  if (!liveTrackingPersistence || liveTrackingClosed) return liveTrackingSync
  liveTrackingSync = liveTrackingSync.then(async () => {
    if (liveTrackingClosed) return
    const tracking = previewState.playerTracking
    const stem = tracking?.capture?.stem
    if (!stem || !tracking.plays.length) return
    try {
      assertLeaseWritable('live tracking facts')
      const joins = rejoinTrackerPreviewPlays(previewState)
      const { written } = await liveTrackingPersistence.sync({
        stem,
        capture: tracking.capture,
        plays: [...tracking.plays],
        joinFor: (play) => joins.get(Number(play.contact_timer)),
        plateAppearanceFor: (paNumber) => savedPaByPreviewNumber.get(paNumber),
      })
      if (written) log(`live tracking: wrote ${written} play(s) to session ${liveTrackingPersistence.sessionId}`)
    } catch (error) {
      log('live tracking facts were not written (the postgame ingest will write them):', error.message)
    }
  })
  return liveTrackingSync
}

// Resolves a tracker fielder name to their current defensive position number
// (1-9) using the fielding alignment last synced for that side (see
// syncTrackerAlignment/syncTrackerPositionChange) — used to turn the play-by-
// play's fielder names into the position-chain notation the rest of the site
// already expects (see src/utils/notation.js's assembleNotation).
function currentFieldingPositionNumber(playerId, name) {
  if (playerId == null || !name) return null
  const fielding = liveState.alignments?.[String(playerId)]?.fielding
  if (!fielding) return null
  const position = Object.entries(fielding).find(([, charName]) => sameCharacterName(charName, name))?.[0]
  return position ? TRACKER_POSITION_NUMBERS[position.toUpperCase()] ?? null : null
}

function trackedFielderIdentity(playerId, name, fallbackPosition = null) {
  if (!name) return null
  const characterId = resolveCharacterId(name)
  const resolvedPlayerId = resolvePlayerIdForCharacter(name) || playerId || null
  const position = currentFieldingPositionNumber(playerId, name) || fallbackPosition || null
  if (characterId == null && resolvedPlayerId == null && position == null) return null
  return { playerId: resolvedPlayerId, characterId, position, name }
}

function advancedOpportunityFielders(buf, pa) {
  const positions = parseFieldingPositions(pa)
  const chainNames = [...(buf.assistFielderNames || []), buf.putoutFielderName].filter(Boolean)
  const first = trackedFielderIdentity(buf.pitcherPlayerId, chainNames[0], positions[0])
  const pivot = trackedFielderIdentity(buf.pitcherPlayerId, chainNames[1], positions[1])
  return { first, pivot }
}

async function persistAdvancedOpportunitiesForPa(pa, buf) {
  if (!pa?.id || !buf) return
  const competitionType = trackerSourceType()
  const { first, pivot } = advancedOpportunityFielders(buf, pa)
  const dp = buildDoublePlayOpportunityFromPa(pa, {
    competitionType,
    outsBefore: buf.outsBeforePa,
    firstFielder: first,
    pivotFielder: pivot,
  })
  if (dp) {
    const { error } = await supabase.from('double_play_opportunities')
      .upsert(dp, { onConflict: 'competition_type,game_id,pa_id' })
    if (error) log(`double-play opportunity write failed for PA ${pa.id}:`, error.message)
  }

  try {
    await syncRunnerOpportunities(supabase, { pa, competitionType, outsBefore: buf.outsBeforePa, responsibleFielder: first })
  } catch (error) { log(`runner opportunity refresh failed for PA ${pa.id}:`, error.message) }
}

function pushPitch(buf, type, before, after) {
  const telemetry = buf.pendingPitchTelemetry.shift() || null
  buf.pitches.push(consumeTrackerPitch(buf, {
    type,
    before: before || { ...buf.lastCount },
    after: after || { ...buf.lastCount },
    pitchType: telemetry?.pitchType ?? null,
    pitchTelemetry: telemetry,
    isStarPitch: Boolean(telemetry?.isStarPitch),
  }))
}

// The tracker's pitch-flight diagnostic can arrive before or after the
// count-change line that actually closes out the pitch, so it either merges
// straight onto the just-pushed pitch (matched by its 1-based position in
// this PA) or waits in a queue for the next pushPitch to consume — mirrors
// tracker_preview_state.mjs's applyPitchTelemetry.
function applyPitchTelemetry(buf, telemetry) {
  if (!buf || !telemetry) return false
  if (telemetry.pitcherName && telemetry.pitcherName !== 'unknown' && telemetry.pitcherName !== buf.pitcherName) return false
  if (telemetry.batterName && telemetry.batterName !== 'unknown' && telemetry.batterName !== buf.batterName) return false
  const lastPitch = buf.pitches.at(-1)
  if (lastPitch && !lastPitch.pitchTelemetry && telemetry.pitchCounter === buf.pitches.length) {
    lastPitch.pitchType = lastPitch.pitchType || telemetry.pitchType
    lastPitch.pitchTelemetry = telemetry
    lastPitch.isStarPitch = Boolean(lastPitch.isStarPitch || telemetry.isStarPitch)
  } else {
    buf.pendingPitchTelemetry.push(telemetry)
  }
  return true
}

// "Double play!"/"Triple play!" arrive as their own lines, separate from the
// "<batter>'s hit was caught!"/putout lines that set the base FO/GO result —
// and the tracker doesn't guarantee which comes first. Apply whichever
// pending multi-out flag is set the moment a batted-ball out result lands,
// and also re-check here in case the multi-out line itself arrives after.
function applyPendingMultiOut(buf) {
  if (!['FO', 'LO', 'GO'].includes(buf.result)) return
  if (buf.pendingTriplePlay) { buf.result = 'TP'; buf.resultInferredFromPutout = false; buf.pendingTriplePlay = false; buf.pendingDoublePlay = false }
  else if (buf.pendingDoublePlay) { buf.result = 'DP'; buf.resultInferredFromPutout = false; buf.pendingDoublePlay = false }
}

// Caught fly balls never get their own "Fair ball!" line (unlike grounders/
// liners, which always do) — without this, the pitch that ended the PA would
// be silently missing from the pitch log and pitcher pitch/strike counts.
function ensureContactPitch(buf) {
  if (buf.contactRecorded) return
  pushPitch(buf, 'in_play')
  buf.contactRecorded = true
  bumpLivePitchCount(buf, true)
}

function ensureHitByPitch(buf) {
  if (buf.result === 'HBP') return
  pushPitch(buf, 'hbp')
  buf.pendingPitchType = null
  buf.result = 'HBP'
  bumpLivePitchCount(buf, false)
}

async function startNewPa(pitcherName, batterName, previewPaNumber = null) {
  const pitcherIds = { characterId: resolveCharacterId(pitcherName), playerId: resolvePlayerIdForCharacter(pitcherName) }
  const batterIds = { characterId: resolveCharacterId(batterName), playerId: resolvePlayerIdForCharacter(batterName) }
  const battingTeamId = isSeasonGame() ? TEAM_ID_BY_PLAYER_ID[String(batterIds.playerId)] ?? null : batterIds.playerId
  const defensiveTeamId = isSeasonGame() ? TEAM_ID_BY_PLAYER_ID[String(pitcherIds.playerId)] ?? null : pitcherIds.playerId

  let pitcherStint = null
  if (pitcherIds.playerId != null && pitcherIds.characterId != null) {
    try {
      pitcherStint = await ensureActiveStint(pitcherIds.playerId, pitcherIds.characterId)
    } catch (err) {
      log('failed to create/find pitching stint for', pitcherName, ':', err.message)
    }
  }

  currentPaBuffer = freshPaBuffer(pitcherName, batterName, pitcherIds, batterIds, battingTeamId, defensiveTeamId)
  currentPaBuffer.pitcherStint = pitcherStint
  // Which at-bat the preview page is showing for this same matchup. Captured
  // synchronously off the log line (see handleTrackerLogLine) rather than
  // counted here, because a slow Supabase write can leave this queue several
  // at-bats behind the parser that feeds the page.
  currentPaBuffer.previewPaNumber = previewPaNumber
}

async function recoverMissingMatchupFromDiagnostic(record, previewPaNumber) {
  const buf = currentPaBuffer
  if (!buf?.result || !record) return buf
  const pitcherName = record.pitcherName && record.pitcherName !== 'unknown'
    ? record.pitcherName : null
  const batterName = record.batterName && record.batterName !== 'unknown'
    ? record.batterName : null
  if (!pitcherName || !batterName) return buf
  if (sameCharacterName(pitcherName, buf.pitcherName)
    && sameCharacterName(batterName, buf.batterName)) return buf

  log(`matchup banner missing after ${buf.batterName}'s ${buf.result}; recovered ${pitcherName} vs. ${batterName} from structured telemetry.`)
  await finalizeCurrentPaIfAny()
  await startNewPa(pitcherName, batterName, previewPaNumber)
  return currentPaBuffer
}

// Live per-pitch tick so the pitcher's pitch/strike count moves during the
// at-bat instead of jumping all at once when the PA finally gets written —
// recomputePitchingStatsForGame (run after every PA save) is the source of
// truth and will correct any drift, so this is best-effort/non-blocking.
function bumpLivePitchCount(buf, isStrike) {
  const stint = buf.pitcherStint
  if (!stint) return
  stint.pitches_thrown = (stint.pitches_thrown || 0) + 1
  if (isStrike) stint.strikes_thrown = (stint.strikes_thrown || 0) + 1
  supabase.from(GAME_TABLES.pitchingStints)
    .update({ pitches_thrown: stint.pitches_thrown, strikes_thrown: stint.strikes_thrown })
    .eq('id', stint.id)
    .then(({ error }) => { if (error) log('live pitch count update failed:', error.message) })
}

// The durable identity of a plate appearance, contact or no contact.
//
// It has to be unique inside the game and it has to be derivable BEFORE the
// result is known, because a play that never gets a result needs one too --
// that is what ties an operator's later correction back to the play the
// tracker could not score.
//
// buf.trackerPaNumber alone is not it: the tracker counts plate appearances
// PER BATTER ("Plate appearance #2 for Green Magikoopa"), so `tracker-pa:2`
// named every batter's second trip at once. The batter is what makes the
// ordinal a key.
function trackerEventKeyForBuffer(buf) {
  const contactSeq = buf.advancedBattedBall?.contactSeq ?? buf.advancedFielding?.contactSeq ?? null
  if (contactSeq != null) return `contact:${contactSeq}`
  if (buf.trackerPaNumber != null) return `tracker-pa:${buf.batterCharacterId}:${buf.trackerPaNumber}`
  return `preview-pa:${buf.previewPaNumber}:${buf.inning}:${buf.isTop ? 'top' : 'bottom'}:${buf.batterName}`
}

// Did a plate appearance actually HAPPEN in this buffer?
//
// The parser opens a buffer on every matchup line, and a half-inning ends with
// one open for the batter who was announced and never batted -- the tracker
// names the next hitter before the side changes. Flushing that at the side
// change reaches the same "no result" branch as a real play whose outcome was
// never stated, and the two are not remotely the same thing: recording the
// empty one as unresolved would fill an operator's queue with eight plays that
// never existed and hide the one that did. In the acceptance recordings that
// is exactly the ratio -- 8 empty buffers to 1 real unscored plate appearance
// (Red Noki, top of the 5th, two pitches and a run the bridge could not place).
//
// So evidence is required, and any single piece of it is enough: a pitch, a
// count that moved, contact, a run, a putout, or the tracker's own per-batter
// plate-appearance counter having named this trip.
function plateAppearanceHappened(buf) {
  return Boolean(
    (buf.pitches || []).length
    || buf.lastCount?.balls || buf.lastCount?.strikes
    || buf.contactRecorded
    || buf.battedBallTrajectory
    || buf.advancedBattedBall || buf.advancedFielding
    || (buf.runEvents || []).length
    || (buf.observedPutouts || []).length
    || buf.trackerPaNumber != null,
  )
}

// Everything the bridge saw about a play it could not score, written where it
// survives this process.
//
// THIS IS NOT A PLATE APPEARANCE and is never counted in anyone's statistics.
// It is a durable statement that something happened and is NOT known. Before
// it existed the only record was a line of console text, so the acceptance
// recording's one unscored plate appearance left `runs_scored` holding 17 rows
// for an 18-run game with nothing in the database saying why.
//
// A missing table is not fatal: the migration that adds it has to be applied
// by a person, and until it is, this reports what it could not record rather
// than failing a game over it.
async function recordUnresolvedPlay(buf, reason) {
  assertLeaseWritable('recording an unresolved play')
  const eventKey = trackerEventKeyForBuffer(buf)
  const payload = {
    competition_type: trackerSourceType(),
    game_id: TARGET_GAME_ID,
    ...(isSeasonGame() ? { season_id: TARGET_SEASON_ID } : {}),
    tracker_event_key: eventKey,
    tracker_contact_seq: buf.advancedBattedBall?.contactSeq ?? buf.advancedFielding?.contactSeq ?? null,
    preview_pa_number: buf.previewPaNumber ?? null,
    inning: buf.inning ?? null,
    half: buf.isTop ? 'top' : 'bottom',
    batter_name: buf.batterName || null,
    batter_character_id: buf.batterCharacterId ?? null,
    batter_player_id: buf.batterPlayerId ?? null,
    pitcher_name: buf.pitcherName || null,
    pitcher_character_id: buf.pitcherCharacterId ?? null,
    pitcher_player_id: buf.pitcherPlayerId ?? null,
    batting_team_id: buf.battingTeamId == null ? null : String(buf.battingTeamId),
    defensive_team_id: buf.defensiveTeamId == null ? null : String(buf.defensiveTeamId),
    reason,
    // What an operator resolving this in a week's time has to work from.
    evidence: {
      outs_before_pa: buf.outsBeforePa ?? null,
      count: buf.lastCount || null,
      pitches: (buf.pitches || []).map((pitch) => ({
        type: pitch.type ?? null,
        balls_before: pitch.count_balls_before ?? null,
        strikes_before: pitch.count_strikes_before ?? null,
      })),
      runners_before: buf.runnersBefore || null,
      // Runs the tracker announced on this play. They are recorded here and
      // NOT written to runs_scored: without a result there is no plate
      // appearance to attach them to, and inventing one to make the total
      // match is the one thing this must never do.
      observed_runs: (buf.runEvents || []).map((run) => ({
        scorer: run.scorerName ?? null,
        charged_to: run.chargedToPitcherName ?? null,
        earned: run.earnedRun ?? null,
      })),
      observed_putouts: buf.observedPutouts || [],
      bobble_fielder: buf.bobbleFielderName || null,
      batted_ball_trajectory: buf.battedBallTrajectory || null,
      recorded_by: 'live_tracker_bridge',
      recorded_at: new Date().toISOString(),
    },
    status: 'open',
    updated_at: new Date().toISOString(),
  }
  try {
    const fenced = await callFencedGameMutation(
      'tracker_record_unresolved_play', { p_payload: payload }, 'recording an unresolved play')
    if (fenced.fenced) {
      const answer = fenced.data || {}
      if (answer.reason === 'no_tracker_unresolved_plays_table') {
        log(`could not record the unresolved play ${eventKey}: this database has no `
          + 'tracker_unresolved_plays. The play is reported here and in the console only. '
          + 'Apply supabase/migrations/20260908124000_tracker_unresolved_plays.sql.')
        return null
      }
      if (answer.reason === 'resolved_by_operator') {
        log(`unresolved play ${eventKey} has already been ${answer.status} by an operator; `
          + 'leaving it alone')
        return answer.play || null
      }
      if (answer.inserted) {
        log(`recorded an UNRESOLVED play (${eventKey}): ${reason}. `
          + 'It is visible in the At-Bat editor and is scored by nobody until an operator '
          + 'supplies the result.')
      }
      return answer.play || null
    }
    const existing = await selectByKey(supabase, 'tracker_unresolved_plays', {
      competition_type: payload.competition_type,
      game_id: payload.game_id,
      tracker_event_key: eventKey,
    })
    if (existing.length) {
      // A replay or a restart seeing the same play again. If an operator has
      // already answered it, the answer stands: this path never reopens a
      // resolved play and never overwrites the resolution.
      if (existing[0].status !== 'open') {
        log(`unresolved play ${eventKey} has already been ${existing[0].status} by an operator; `
          + 'leaving it alone')
        return existing[0]
      }
      await updateRowsVerified(supabase, 'tracker_unresolved_plays', { id: existing[0].id }, {
        reason: payload.reason, evidence: payload.evidence, updated_at: payload.updated_at,
      })
      return { ...existing[0], ...payload }
    }
    const { row } = await insertOneReconciled(supabase, 'tracker_unresolved_plays', payload, {
      key: {
        competition_type: payload.competition_type,
        game_id: payload.game_id,
        tracker_event_key: eventKey,
      },
      compareFields: ['competition_type', 'game_id', 'tracker_event_key'],
    })
    log(`recorded an UNRESOLVED play (${eventKey}): ${reason}. `
      + 'It is visible in the At-Bat editor and is scored by nobody until an operator '
      + 'supplies the result.')
    return row
  } catch (error) {
    log(`could not record the unresolved play ${eventKey}: ${error.message}. `
      + 'The play is reported here and in the console only. If this says the table does '
      + 'not exist, apply supabase/migrations/20260908124000_tracker_unresolved_plays.sql.')
    return null
  }
}

async function finalizeCurrentPaIfAny() {
  const buf = currentPaBuffer
  currentPaBuffer = null
  if (!buf) return

  if (shouldClassifyTrackerFielderChoice(buf)) {
    buf.result = 'FC'
    buf.unresolvedReason = null
  }

  // The stock executable sometimes omits the terminal hit-announcement line.
  // When the joined 60 Hz play is already complete, its batter runner slot can
  // recover the exact base reached.  This deliberately runs after FC and only
  // fills a missing result; all announced scoring continues to win.
  if (!buf.result) {
    const outcomePlay = trackerPreviewOutcomePlay(previewState, buf.previewPaNumber)
    buf.result = trackerResultFromMeasuredBatterBases(outcomePlay)
  }

  if (!buf.result) {
    log(`could not determine a result for ${buf.batterName}'s plate appearance (vs. ${buf.pitcherName}) — skipping stat write.` +
      (buf.unresolvedReason ? ` Reason: ${buf.unresolvedReason}.` : '') +
      ' Record this play manually via the At-Bat editor.')
    notePreviewWrite(buf, {
      status: 'skipped',
      reason: buf.unresolvedReason
        ? `No result could be determined: ${buf.unresolvedReason}`
        : 'No result could be determined from the tracker log',
    })
    if (plateAppearanceHappened(buf)) {
      await recordUnresolvedPlay(buf, buf.unresolvedReason
        ? `No result could be determined: ${buf.unresolvedReason}`
        : 'No result could be determined from the tracker log')
    }
    return
  }
  if (buf.batterCharacterId == null || buf.batterPlayerId == null || buf.pitcherCharacterId == null || buf.pitcherPlayerId == null
    || buf.battingTeamId == null || buf.defensiveTeamId == null) {
    log(`could not resolve roster ids for ${buf.batterName} vs. ${buf.pitcherName} — skipping stat write. ` +
      'Make sure both characters are drafted/rostered for this game, then record the play manually via the At-Bat editor.')
    notePreviewWrite(buf, {
      status: 'skipped',
      result: buf.result,
      reason: `Roster ids unresolved for ${buf.batterName} vs. ${buf.pitcherName} — is each character rostered for this game?`,
    })
    await recordUnresolvedPlay(buf,
      `Roster ids unresolved for ${buf.batterName} vs. ${buf.pitcherName}: the result was `
      + `${buf.result}, but at least one of the batter, pitcher or team could not be resolved `
      + 'to a rostered identity, so the row could not be written.')
    return
  }

  let completed = false
  let pitchRowsWritten = 0
  let runRowsWritten = 0
  paFinalizationInProgress = true
  try {
    // The measured launch angle separates low airborne contact from a fly.
    // Normalize the result before sacrifice-fly and official-AB rules run.
    if (buf.result === 'FO' && buf.battedBallTrajectory === 'L') buf.result = 'LO'

    // The stock tracker announces bobbles but does not publish a separate
    // official-error counter. When it credits the batter with a safe base on
    // that same bobbled play, store the scorer-facing result as ROE so the hit
    // is not accidentally counted in batting/pitching totals.
    //
    // The 60 Hz play gets a veto over that, on exactly the rules the console
    // applies -- a Yoshi Egg, a ball never touched, and a dive or a leap are
    // all announced as bobbles and none of them is an error. This has to read
    // the same play the console reads, or the database and the page end up
    // disagreeing about the same at-bat.
    const outcomePlay = trackerPreviewOutcomePlay(previewState, buf.previewPaNumber)
    const isBobbleError = shouldChargeTrackerBobbleError({
      bobbleFielderName: buf.bobbleFielderName,
      result: buf.result,
      play: outcomePlay,
    })
    if (isBobbleError && shouldDowngradeTrackerHitToRoe({
      result: buf.result, bobbleFielderName: buf.bobbleFielderName, play: outcomePlay,
    })) buf.result = 'ROE'
    const hitBeforeBoot = isBobbleError && trackerHitBeforeOutfieldBoot({
      result: buf.result, bobbleFielderName: buf.bobbleFielderName, play: outcomePlay,
    })
    if (hitBeforeBoot) {
      log(`${buf.batterName}'s ${buf.result} scored as a ${hitBeforeBoot}: `
        + `${buf.bobbleFielderName} booted it before he reached first`)
      buf.result = hitBeforeBoot
    }

    // Turns the fielder names captured off the play-by-play into the same
    // trajectory+position-chain notation the manual scorebook/editor write
    // (see src/utils/notation.js), so buildFieldingChances in
    // src/utils/statsCalculator.js credits putouts/assists/buddy jumps for
    // tracker games exactly like it does for manually-scored ones. A hit can
    // also carry a chain when a baserunner was put out on the play. BB and K
    // do not (the catcher's strikeout putout is inferred downstream).
    // A sac fly is a scoring rule, not a judgment call — the tracker never
    // says "sacrifice", but a caught fly ball that scores a runner with fewer
    // than 2 outs is one by definition, so reclassify it before it gets
    // written as a plain flyout (which would wrongly count as an official AB).
    const isBunt = trackerContactWasBunt(buf.advancedBattedBall, outcomePlay)
    // How the batter offered at each pitch, measured by the 60 Hz capture. This
    // is what turns the log's `strike_unknown` into the `looking` /
    // `swinging_miss` the scorebook and the At-Bat editor already use, and it
    // has to be the same join the console shows or the database and the page
    // disagree about the same at-bat. With no capture running it returns
    // nothing and every pitch is written exactly as the log reported it.
    const measuredOffers = applyMeasuredPitchOffers(
      buf.pitches,
      trackerPreviewMeasuredPitches(previewState, buf.previewPaNumber),
      { resultKey: 'type' },
    )
    const offeredPitches = measuredOffers.pitches
    if (measuredOffers.unmatched.length) {
      log(`the capture measured ${measuredOffers.unmatched.length} pitch(es) for `
        + `${buf.batterName} that the tracker log never reported`)
    }
    if (shouldReclassifyTrackerFlyOutAsSacFly({
      result: buf.result,
      outsBeforePa: buf.outsBeforePa,
      scoredNonBatterRunner: buf.runEvents.some((run) => run.scorerName !== buf.batterName),
      isBunt,
    })) {
      buf.result = 'SF'
    }
    // A sacrifice bunt is scored by the same kind of rule as the sac fly above,
    // and is detectable because the 60 Hz capture records which offer animation
    // the batter used (falling back to the exit velocity when no play joined).
    // The bunt itself reaches the database through `trajectory` ('B'), written
    // from buf.battedBallTrajectory below.
    if (shouldClassifyTrackerSacrificeBunt({
      isBunt,
      result: buf.result,
      outsBeforePa: buf.outsBeforePa,
      hasRunnerOn: Boolean(buf.runnersBefore.first || buf.runnersBefore.second || buf.runnersBefore.third),
      runnerAdvanced: runnerAdvancedOnPlay({
        runnersBefore: buf.runnersBefore,
        scoringRunners: buf.runEvents.map((run) => ({ characterName: run.scorerName })),
        play: outcomePlay,
      }),
    })) {
      buf.result = 'SH'
    }
    const outsOnPlay = trackerOutsOnPlay(buf, calculateOutsForPa(buf.result, null))
    parserOutsInHalf += outsOnPlay
    let hitNotation = null
    let errorNotation = null
    let buddyJumpAssistPosition = null
    let buddyJumpPutoutPosition = null
    if (buf.isBuddyJump && buf.buddyJumpFielderName) {
      buddyJumpPutoutPosition = currentFieldingPositionNumber(buf.pitcherPlayerId, buf.buddyJumpFielderName)
      if (buf.assistFielderNames.length) {
        buddyJumpAssistPosition = currentFieldingPositionNumber(buf.pitcherPlayerId, buf.assistFielderNames[0])
      }
    } else if (outsOnPlay > 0 && buf.putoutFielderName) {
      const chainNames = [...buf.assistFielderNames, buf.putoutFielderName]
      const capturedPositions = trackerPlayOutChainPositions(outcomePlay)
        .map((position) => TRACKER_POSITION_NUMBERS[position])
        .filter((position) => position != null)
      // "No Player put X out!" -- the tracker lost the fielder; the capture did not.
      const caughtBy = isTrackerMissingPlayerName(buf.putoutFielderName)
        ? TRACKER_POSITION_NUMBERS[trackerPlayCatchPosition(outcomePlay)] ?? null
        : null
      const positions = capturedPositions.length
        ? capturedPositions
        : caughtBy != null
          ? [caughtBy]
          : chainNames.map((name) => currentFieldingPositionNumber(buf.pitcherPlayerId, name))
      if (positions.every((position) => position != null)) {
        const letter = trackerOutNotationLetter({
          result: buf.result, trajectory: buf.battedBallTrajectory, play: outcomePlay,
        })
        hitNotation = `${letter}${positions.join('-')}`
      } else {
        log(`could not resolve a fielding position for ${buf.batterName}'s ${buf.result} (fielder(s): ${chainNames.join(', ')}) — ` +
          'putout/assist credit left for manual entry via the At-Bat editor.')
      }
    }

    const starPitchFlags = trackerStarPitchPaFlags(buf.pitches, outsOnPlay)
    // The play's own reading of the fielder's slot beats the roster's, which a
    // mid-game pitching change leaves stale -- it put an E1 on a second baseman
    // who had swapped positions with the outgoing pitcher.
    const playPosition = trackerPlayFieldingPosition(outcomePlay, buf.bobbleFielderName)
    // The measured throwing error, charged only where the announced bobble did
    // not already charge one. It is an error against the THROWER for the runner
    // it let advance, so it never rewrites the batter's result the way the
    // bobble above does (see the ROE conversion at the top of this block).
    const throwingError = isBobbleError ? null : trackerPlayThrowingError(outcomePlay)
    const isError = isBobbleError || Boolean(throwingError)
    const errorPosition = isBobbleError
      ? (TRACKER_POSITION_NUMBERS[playPosition]
        ?? currentFieldingPositionNumber(buf.pitcherPlayerId, buf.bobbleFielderName))
      : (throwingError ? TRACKER_POSITION_NUMBERS[throwingError.position] ?? null : null)
    if (isBobbleError && errorPosition != null) {
      const leadingPositions = buf.assistFielderNames
        .map((name) => currentFieldingPositionNumber(buf.pitcherPlayerId, name))
        .filter((position) => position != null)
      const fieldingChain = [...leadingPositions, errorPosition]
      errorNotation = assembleErrorNotation(buf.battedBallTrajectory || 'G', fieldingChain, errorPosition)
      hitNotation = errorNotation
    } else if (throwingError && errorPosition != null) {
      const chain = parseFielderChainFromNotation(hitNotation)
      errorNotation = assembleErrorNotation(
        buf.battedBallTrajectory || 'G',
        chain.length ? chain : [errorPosition],
        errorPosition,
      )
    }
    // WHERE THE BALL WAS FIELDED, as a position number. The manual scorebook
    // has always written this column and the bridge never has, so every
    // tracker-scored game read as an empty row in the hit-location tables --
    // BIP and P..RF on Batting > Spray & Location and Pitching > Batted Ball
    // Allowed -- while a hand-scored game filled them. The fielder is already
    // resolved here; only the column was missing.
    //
    // Same rule as Scorebook.jsx: a Buddy Jump belongs to the fielder who made
    // the catch rather than the first one in the chain, a home run to nobody.
    const hitLocation = isHomeRunResult(buf.result)
      ? null
      : buf.isBuddyJump
        ? (buddyJumpPutoutPosition ?? buddyJumpAssistPosition ?? null)
        : (Number(parseFielderChainFromNotation(hitNotation)[0]) || null)
    const batterRun = buf.runEvents.find((run) => run.scorerName === buf.batterName)
    const runnerAssignments = deterministicRunnerAssignments(buf, isBobbleError, outcomePlay)
    const paPayload = addSourceFields({
      game_id: TARGET_GAME_ID,
      player_id: buf.batterPlayerId,
      character_id: buf.batterCharacterId,
      batting_team_id: buf.battingTeamId,
      defensive_team_id: buf.defensiveTeamId,
      pitcher_id: buf.pitcherCharacterId,
      pitcher_player_id: buf.pitcherPlayerId,
      inning: buf.inning,
      result: buf.result,
      outs_on_play: outsOnPlay,
      rbi: normalizeRbiForPaResult(buf.result, trackerRbiForPaResult({
        result: buf.result,
        rbi: buf.rbi,
        scoredNonBatterRunners: buf.runEvents.filter(
          (run) => run.scorerName !== buf.batterName).length,
      }), isBobbleError),
      run_scored: isHomeRunResult(buf.result) || buf.runEvents.some((r) => r.scorerName === buf.batterName),
      is_official_ab: isOfficialAtBat(buf.result),
      is_earned_run: batterRun ? batterRun.earnedRun === true : !isBobbleError,
      runner_on_first_before: Boolean(buf.runnersBefore.first),
      runner_on_second_before: Boolean(buf.runnersBefore.second),
      runner_on_third_before: Boolean(buf.runnersBefore.third),
      runner_assignments: runnerAssignments,
      tracker_contact_seq: buf.advancedBattedBall?.contactSeq ?? buf.advancedFielding?.contactSeq ?? null,
      star_hit_used: Boolean(buf.starHitUsed),
      star_hit_connected: Boolean(
        measuredOffers.pitches.at(-1)?.isStarSwing
        && measuredOffers.pitches.at(-1)?.type === 'in_play',
      ),
      star_pitch_used: starPitchFlags.starPitchUsed,
      star_pitch_successful: starPitchFlags.starPitchSuccessful,
      ...trackerBattedBallPaFields(buf.advancedBattedBall, {
        stadiumKey: TARGET_STADIUM_KEY,
        projectCarryAtImpact: isHomeRunResult(buf.result),
        play: outcomePlay,
      }),
      ...trackerFieldedBallPaFields(buf.advancedFielding, { stadiumKey: TARGET_STADIUM_KEY }),
      // applyTrackerBattedBallToBuffer (tracker_play_events.mjs) derives this
      // from launch angle for any landing/catch endpoint, safe hits included
      // — it is not out-only. It stays null only when no batted-ball record
      // ever arrived for this contact (e.g. the exe in use doesn't emit
      // TRACKER_BATTED_BALL_PROVISIONAL), leaving room for the separately
      // editable At-Bat Editor trajectory.
      trajectory: isBunt ? 'B' : buf.battedBallTrajectory,
      hit_notation: hitNotation,
      hit_location: hitLocation,
      is_error: isError,
      error_position: errorPosition,
      error_character: isBobbleError
        ? characterNamesById[String(resolveCharacterId(buf.bobbleFielderName))] || buf.bobbleFielderName
        : throwingError
          ? characterNamesById[String(resolveCharacterId(throwingError.character))] || throwingError.character
          : null,
      error_player: isError ? playerNamesById[String(buf.pitcherPlayerId)] || null : null,
      error_notation: errorNotation,
      fielder_choice_out: buf.result === 'FC',
      is_nice_play: trackerPlayIsNicePlay({
        play: outcomePlay, hitNotation, outsOnPlay, isBuddyJump: buf.isBuddyJump,
      }),
      is_buddy_jump: Boolean(buf.isBuddyJump),
      buddy_jump_assist_position: buddyJumpAssistPosition,
      buddy_jump_putout_position: buddyJumpPutoutPosition,
      is_robbed_hr: isTrackerRobbedHomeRun({
        record: buf.advancedBattedBall,
        isBuddyJump: buf.isBuddyJump,
        stadiumKey: TARGET_STADIUM_KEY,
      }),
      strikeout_type: buf.result === 'K'
        ? (offeredPitches.at(-1)?.type === 'looking' ? 'KL'
          : offeredPitches.at(-1)?.type === 'swinging_miss' ? 'KS' : null)
        : null,
    })
    const nextPitchNumber = offeredPitches.length ? await latestGamePitchNumber() : 0
    const pitchPayload = offeredPitches.length
      ? numberTrackerPitches(offeredPitches, nextPitchNumber).map((p) => addSourceFields({
          game_id: TARGET_GAME_ID,
          pitcher_id: buf.pitcherName, pitcher_player: '', batter_id: buf.batterName,
          inning: buf.inning, half: buf.isTop ? 'top' : 'bottom',
          pitch_number_pa: p.pitch_number_pa, pitch_number_game: p.pitch_number_game,
          ...trackerPitchStatFields(p),
        }))
      : []

    const runPayload = []
    if (buf.runEvents.length) {
      for (const run of buf.runEvents) {
        const scorerPlayerId = resolvePlayerIdForCharacter(run.scorerName)
        const scorerCharacterId = resolveCharacterId(run.scorerName)
        const chargedName = run.chargedToPitcherName || buf.pitcherName
        const chargedPlayerId = resolvePlayerIdForCharacter(chargedName)
        const chargedCharacterId = resolveCharacterId(chargedName)
        if (scorerPlayerId == null || scorerCharacterId == null
            || chargedPlayerId == null || chargedCharacterId == null) {
          throw new Error(`could not resolve required run identities for ${run.scorerName} / ${chargedName}`)
        }
        runPayload.push(addSourceFields({
          game_id: TARGET_GAME_ID, inning: buf.inning, half: buf.isTop ? 'top' : 'bottom',
          scoring_player_id: scorerPlayerId, scoring_character_id: scorerCharacterId,
          charged_to_pitcher_id: chargedCharacterId, charged_to_pitcher_player_id: chargedPlayerId,
          is_earned_run: run.earnedRun === true,
        }))
      }
    }

    // The durable identity of this plate appearance, and the only thing that
    // stops a redelivery writing it twice. It has to be unique inside the game.
    //
    // `buf.trackerPaNumber` is NOT: the tracker counts plate appearances PER
    // BATTER ("Plate appearance #2 for Green Magikoopa"), so `tracker-pa:2`
    // named every batter's second trip at once. A plate appearance with no
    // contact -- a strikeout, a walk, a hit batter -- falls back to this key,
    // and the second one to arrive was read as a redelivery of the first: the
    // journal handed back the first event, its already-written PA came back as
    // "saved", and the real plate appearance was never written at all. In the
    // Peach Ice Garden recording that silently lost Green Magikoopa's
    // sixth-inning strikeout to Baby Luigi's third-inning one, along with its
    // pitches. The batter is what makes the ordinal a key.
    const durableEventKey = trackerEventKeyForBuffer(buf)
    const persisted = await scoringPersistence.persistEvent({
      eventKey: durableEventKey,
      pa: paPayload,
      pitches: pitchPayload,
      runs: runPayload,
    })
    const savedPa = persisted.pa
    pitchRowsWritten = persisted.pitches
    runRowsWritten = persisted.runs
    requiredPersistenceFailure = null
    markTrackerGameBegun('a plate appearance was durably recorded')
    if (runnerAssignments == null) pendingMeasuredRunnerAssignments.set(savedPa.id, { buf, savedPa, isError: isBobbleError })
    if (buf.previewPaNumber != null) savedPaByPreviewNumber.set(buf.previewPaNumber, savedPa)
    try {
      await persistAdvancedOpportunitiesForPa(savedPa, buf)
    } catch (error) {
      log('advanced opportunity persistence failed after scoring facts were saved:', error.message)
    }
    // Not awaited: it queues behind any live write already running and never
    // holds up the plate appearance that just saved.
    syncLiveTrackingFacts()
    try {
      await recomputeTrackerPitchingStats(supabase, { tables: GAME_TABLES, gameId: TARGET_GAME_ID })
    } catch (error) {
      log('pitching-stat recomputation failed after scoring facts were saved:', error.message)
    }
    try {
      await resolveOnPA(
        TARGET_GAME_ID,
        savedPa,
        buildTrackerBetResolutionConfig({
          supabase,
          sourceType: trackerSourceType(),
          sourceId: TARGET_SOURCE_ID,
        }),
      )
    } catch (bettingError) {
      log('live bet resolution failed for PA', savedPa.pa_number, ':', bettingError.message)
    }
    pendingRunnerAssignmentBackfill = { buf, savedPa, savedPaId: savedPa.id, isError: isBobbleError }
    lastFinalizedPa = { buf, savedPaId: savedPa.id, outcomePlay }
    completedPaRevision += 1
    completed = true
    log(`recorded PA #${savedPa.pa_number}: ${buf.batterName} -> ${buf.result}${buf.rbi ? ` (${buf.rbi} RBI)` : ''}`)
    notePreviewWrite(buf, {
      status: 'written',
      result: buf.result,
      paId: savedPa.id,
      paNumberDb: savedPa.pa_number,
      pitchRows: pitchRowsWritten,
      runRows: runRowsWritten,
    })
  } catch (err) {
    requiredPersistenceFailure = err
    // Named rather than lumped in with a constraint violation or a timeout:
    // this one is not retryable and not a database fault, and the operator's
    // next move is to stop this bridge rather than to look at Supabase.
    log(isLeaseNotHeldError(err)
      ? 'REFUSED to record a plate appearance for ' + buf.batterName + ': ' + err.message
      : 'failed to record plate appearance for ' + buf.batterName + ': ' + err.message)
    notePreviewWrite(buf, { status: 'failed', result: buf.result, reason: err.message })
    throw err
  } finally {
    paFinalizationInProgress = false
    if (completed) triggerBettingSync()
  }
}

async function processPlayEvent(message, previewPaNumber = null) {
  if (/^Match is starting now!$/i.test(String(message || '').trim())) {
    // The testing reset can happen after this bridge has already loaded the
    // previous attempt. Re-check the durable game/PA state at the tracker's
    // actual new-match boundary so stale inning and runner memory cannot leak
    // into the first plate appearance.
    try {
      await resetTrackerStateIfGameIsPristine('new match')
    } catch (err) {
      log('could not verify whether the new match needs a clean tracker state:', err.message)
    }
    try {
      await markTargetGameInProgress()
    } catch (err) {
      log('could not mark the tracker game in progress:', err.message)
    }
    return
  }

  const trackerBatting = parseTrackerBattingMessage(message)
  if (trackerBatting) {
    try {
      await syncTrackerBattingOrder(trackerBatting)
    } catch (err) {
      log(`batting-order sync rejected for ${trackerBatting.teamName || 'unknown tracker team'}:`, err.message)
    }
    return
  }

  const trackerAlignment = parseTrackerLineupMessage(message)
  if (trackerAlignment) {
    try {
      await syncTrackerAlignment(trackerAlignment)
    } catch (err) {
      log(`lineup sync rejected for ${trackerAlignment.teamName || 'unknown tracker team'}:`, err.message)
    }
    return
  }

  const positionChange = parseTrackerPositionChangeMessage(message)
  if (positionChange) {
    try {
      await syncTrackerPositionChange(positionChange.characterName, positionChange.position)
    } catch (err) {
      log('fielding position sync failed:', err.message)
    }
    return
  }

  let buf = currentPaBuffer
  let m

  if ((m = String(message || '').match(/^Plate appearance #(\d+) for (.+)\.$/i))) {
    if (buf && sameCharacterName(buf.batterName, m[2])) buf.trackerPaNumber = Number(m[1])
    return
  }

  if (String(message || '').trim().startsWith(TRACKER_FIELDED_BALL_MARKER)) {
    const advancedFielding = parseTrackerFieldedBallMessage(message)
    if (!advancedFielding) {
      log('ignored malformed advanced fielding record:', message)
      return
    }
    buf = await recoverMissingMatchupFromDiagnostic(advancedFielding, previewPaNumber)
    if (!buf) {
      log(`ignored advanced fielding record with no active plate appearance (contact ${advancedFielding.contactSeq}).`)
      return
    }
    if (!applyTrackerFieldedBallToBuffer(buf, advancedFielding)) {
      log(`ignored advanced fielding record for ${advancedFielding.batterName} vs. ${advancedFielding.pitcherName}; ` +
        `active matchup is ${buf.batterName} vs. ${buf.pitcherName}.`)
    }
    return
  }

  if (String(message || '').trim().startsWith(TRACKER_BATTED_BALL_MARKER)) {
    const advancedBattedBall = attachTrackerTrajectory(
      parseTrackerBattedBallMessage(message), ballSamples,
    )
    if (!advancedBattedBall) {
      log('ignored malformed advanced batted-ball record:', message)
      return
    }
    buf = await recoverMissingMatchupFromDiagnostic(advancedBattedBall, previewPaNumber)
    if (!buf) {
      log(`ignored advanced batted-ball record with no active plate appearance (contact ${advancedBattedBall.contactSeq}).`)
      return
    }
    if (!applyTrackerBattedBallToBuffer(buf, advancedBattedBall)) {
      if (lastFinalizedPa && applyTrackerBattedBallToBuffer(lastFinalizedPa.buf, advancedBattedBall)) {
        const lateOutcomePlay = trackerPreviewOutcomePlay(
          previewState, lastFinalizedPa.buf.previewPaNumber,
        ) ?? lastFinalizedPa.outcomePlay
        const { error } = await supabase.from(GAME_TABLES.plateAppearances)
          .update({
            ...trackerBattedBallPaFields(lastFinalizedPa.buf.advancedBattedBall, {
              stadiumKey: TARGET_STADIUM_KEY,
              projectCarryAtImpact: isHomeRunResult(lastFinalizedPa.buf.result),
              play: lateOutcomePlay,
            }),
            tracker_contact_seq: lastFinalizedPa.buf.advancedBattedBall?.contactSeq ?? null,
            trajectory: lastFinalizedPa.buf.battedBallTrajectory,
          })
          .eq('id', lastFinalizedPa.savedPaId)
        if (error) log('late batted-ball backfill failed for', advancedBattedBall.batterName, ':', error.message)
        return
      }
      log(`ignored advanced batted-ball record for ${advancedBattedBall.batterName} vs. ${advancedBattedBall.pitcherName}; ` +
        `active matchup is ${buf.batterName} vs. ${buf.pitcherName}.`)
      return
    }
    return
  }

  if (String(message || '').trim().startsWith(TRACKER_PITCH_PROVISIONAL_MARKER)) {
    const telemetry = parseTrackerPitchProvisionalMessage(message)
    if (!telemetry) {
      log('ignored malformed pitch diagnostic record:', message)
      return
    }
    buf = await recoverMissingMatchupFromDiagnostic(telemetry, previewPaNumber)
    if (!buf) {
      log(`ignored pitch diagnostic record with no active plate appearance (pitch ${telemetry.pitchCounter}).`)
      return
    }
    if (!applyPitchTelemetry(buf, telemetry)) {
      log(`ignored pitch diagnostic record for ${telemetry.batterName} vs. ${telemetry.pitcherName}; ` +
        `active matchup is ${buf.batterName} vs. ${buf.pitcherName}.`)
    }
    return
  }

  if (buf) {
    const runnerBefore = parseTrackerRunnerMessage(message)
    if (runnerBefore) {
      // Once a result is terminal, base announcements describe the next PA.
      // Keep the half-inning state current without rewriting the completed
      // batter's runners-before snapshot.
      const recorded = buf.result
        ? recordRunnerSnapshot(runnerBefore)
        : recordRunnerBeforePa(buf, runnerBefore)
      if (!recorded) {
        log(`could not resolve ${runnerBefore.characterName} on ${runnerBefore.base} for runner-state persistence.`)
      }
      return
    }
    // Matchup order is: header, outs, Count: 0-0, then zero or more runner
    // deltas. Waiting until the first later event gives all of those deltas a
    // chance to land before the previous PA's destinations are reconstructed.
    if (buf.countSeenOnce && pendingRunnerAssignmentBackfill) {
      await backfillPriorRunnerAssignments(buf)
    }
    if (markPendingTrackerStarPitch(buf, message)) return
    if (isTrackerReplayMessage(message)) return
    if (/^Strike\s+\d+\.$/i.test(message)) { buf.pendingPitchType = 'strike'; return }
    if (/^Foul ball!$/i.test(message)) { buf.pendingPitchType = 'foul'; return }
    if (/^Fair ball!$/i.test(message)) {
      pushPitch(buf, 'in_play')
      buf.contactRecorded = true
      bumpLivePitchCount(buf, true)
      return
    }

    if ((m = message.match(/^Count:\s*(\d)-(\d)$/i))) {
      const newBalls = Number(m[1])
      const newStrikes = Number(m[2])
      if (buf.result) return
      if (
        buf.countSeenOnce && !buf.pendingPitchType
        && newBalls === buf.lastCount.balls && newStrikes === buf.lastCount.strikes
      ) return
      if (!buf.countSeenOnce) {
        // the first "Count: 0-0" after a matchup is the starting count, not a pitch
        buf.countSeenOnce = true
        buf.lastCount = { balls: newBalls, strikes: newStrikes }
        return
      }
      // The stock log only says "Strike"; it does not say whether the batter
      // offered. Preserve that uncertainty instead of corrupting swing/miss
      // metrics by labeling every generic strike a swinging miss.
      const type = buf.pendingPitchType === 'strike' ? 'strike_unknown' : buf.pendingPitchType === 'foul' ? 'foul' : 'ball'
      pushPitch(buf, type, buf.lastCount, { balls: newBalls, strikes: newStrikes })
      buf.pendingPitchType = null
      buf.lastCount = { balls: newBalls, strikes: newStrikes }
      bumpLivePitchCount(buf, type !== 'ball')
      if (newBalls >= 4 && !buf.result) buf.result = 'BB'
      return
    }

    const hitBatter = parseTrackerHitByPitchMessage(message)
    if (hitBatter && hitBatter === buf.batterName) {
      ensureHitByPitch(buf)
      return
    }

    if ((m = message.match(/^(.+?) walked (.+?)!$/i))
        && m[1].trim() === buf.pitcherName
        && m[2].trim() === buf.batterName) {
      const before = buf.lastCount
      const after = { balls: Math.max(4, before.balls + 1), strikes: before.strikes }
      pushPitch(buf, 'ball', before, after)
      buf.pendingPitchType = null
      buf.lastCount = after
      bumpLivePitchCount(buf, false)
      buf.result = 'BB'
      return
    }

    if (/^Double play!$/i.test(message)) {
      if (['FO', 'LO', 'GO'].includes(buf.result)) { buf.result = 'DP'; buf.resultInferredFromPutout = false }
      else buf.pendingDoublePlay = true
      return
    }
    if (/^Triple play!$/i.test(message)) {
      if (['FO', 'LO', 'GO'].includes(buf.result)) { buf.result = 'TP'; buf.resultInferredFromPutout = false }
      else buf.pendingTriplePlay = true
      return
    }
    // The catching/put-out fielder's identity is only ever named on its own
    // line ("<fielder> put <name> out!"), separate from the "<batter>'s hit
    // was caught!" line that actually decides the PA result — so this has to
    // capture the fielder name unconditionally (not gated on `!buf.result`,
    // unlike the result-deciding checks below it) or the fielder gets lost by
    // the time this line arrives.
    if ((m = message.match(/^(.+?)'s hit was caught!$/i)) && m[1].trim() === buf.batterName) {
      if (!buf.result) {
        ensureContactPitch(buf)
        buf.result = trackerCaughtBallResult(buf.advancedBattedBall)
        applyPendingMultiOut(buf)
      }
      buf.battedBallTrajectory = buf.battedBallTrajectory
        || (buf.result === 'LO' ? 'L' : 'F')
      return
    }
    const putout = parseTrackerPutoutMessage(message)
    if (putout) {
      const { runnerName: whoOut } = putout
      captureTrackerPutout(buf, putout)
      removeParserRunner(whoOut)
      // On some star-swing catches the tracker increments the out before its
      // OUT RUNNER memory value updates, then emits "No Player" for the runner.
      // The preceding caught-hit line already proves the batter was retired,
      // so retain the named fielder instead of discarding valid putout credit.
      if (shouldCreditTrackerPutout({ runnerName: whoOut, batterName: buf.batterName, result: buf.result })) {
        if (!buf.result) {
          ensureContactPitch(buf)
          buf.result = 'GO'
          // AN INFERENCE, NOT AN ANNOUNCEMENT. The putout says the batter was
          // retired, not where. A batter who reaches first and is thrown out
          // stretching for second is credited with the hit AND the out, and
          // the game announces both -- putout first, "recorded a single!"
          // after. See tracker_preview_state.mjs, which does the same thing.
          buf.resultInferredFromPutout = true
          applyPendingMultiOut(buf)
          buf.battedBallTrajectory = buf.battedBallTrajectory || 'G'
        }
      } else if (!buf.result) {
        buf.unresolvedReason = `a putout was recorded on ${whoOut}, not the batter — retaining it as a baserunner out while awaiting the batter result`
      }
      return
    }
    // Precedes the putout line for a relay throw (e.g. "SS to 1B" grounder) —
    // the putout fielder is already captured above, so this only adds the
    // earlier link(s) in the chain.
    if ((m = message.match(/^(.+?)\s+recorded an assist!$/i))) {
      buf.assistFielderNames.push(m[1].trim())
      return
    }
    // Keep the bobbler as a candidate; final scoring depends on whether the
    // batter reaches safely or the defense still completes the out.
    if ((m = message.match(/^(.+?)\s+bobbled the ball!$/i))) {
      buf.bobbleFielderName = m[1].trim()
      return
    }
    if ((m = message.match(/^(.+?)\s+is going up for a buddy jump!$/i))) {
      buf.buddyJumpFielderName = m[1].trim()
      return
    }
    // Confirms the buddy jump actually made the catch — a jump attempt with
    // no confirming line (ball got past it, e.g. cleared the fence) should
    // not be flagged, so is_buddy_jump only flips true here, not on the
    // "going up for" announcement above.
    if ((m = message.match(/^(.+?)\s+went high up with the buddy jump to get the out!$/i))) {
      // "No Player went high up..." is the tracker losing the fielder, not a
      // Buddy Jump: it follows "No Player put X out!" when its last-holder read
      // never updates. The one such line in 56 logs was Yoshi's plain diving
      // catch (game 2766), and no real one lacks a named fielder.
      if (isTrackerMissingPlayerName(m[1])) {
        log(`ignored a Buddy Jump announced for "${m[1].trim()}" on ${buf.batterName}'s at-bat`)
        return
      }
      buf.isBuddyJump = true
      buf.buddyJumpFielderName = m[1].trim()
      return
    }

    // An announced result outranks the groundout inferred from a putout above.
    if (!buf.result || buf.resultInferredFromPutout) {
      const announce = (value) => {
        ensureContactPitch(buf)
        buf.result = value
        buf.resultInferredFromPutout = false
      }
      // A star-powered hit gets an extra "star" qualifier inserted
      // ("recorded a star single!" instead of "recorded a single!") — the
      // (?:star )? here is the only difference from the plain wording.
      if ((m = message.match(/^(.+?)\s+recorded an? (?:star )?single!$/i)) && m[1].trim() === buf.batterName) { announce('1B'); return }
      if ((m = message.match(/^(.+?)\s+recorded an? (?:star )?double!$/i)) && m[1].trim() === buf.batterName) { announce('2B'); return }
      if ((m = message.match(/^(.+?)\s+recorded an? (?:star )?triple!$/i)) && m[1].trim() === buf.batterName) { announce('3B'); return }
      // "recorded an inside the park home run!" is worded entirely differently
      // from the over-the-fence "hits a ... home run ... off of ...!" phrasing
      // matched below, so it needs its own pattern or it's silently dropped as
      // an unrecognized result (no HR credit, no run, no stats).
      if ((m = message.match(/^(.+?)\s+recorded an? (?:star )?inside the park home run!$/i)) && m[1].trim() === buf.batterName) { announce('IPHR'); return }
      if ((m = message.match(/^(.+?)\s+hits an?\s+.*(?:homer|home run).*off of\s+.+!$/i)) && m[1].trim() === buf.batterName) { announce('HR'); return }
      if ((m = message.match(/^.+?\s+struck out\s+(.+?)!$/i)) && m[1].trim() === buf.batterName) { buf.result = 'K'; buf.resultInferredFromPutout = false; return }
    }

    if (markTrackerStarSwing(buf, message)) return

    if ((m = message.match(/^(.+?)\s+recorded (\d+) RBI!$/i)) && m[1].trim() === buf.batterName) {
      buf.rbi = Number(m[2])
      return
    }
    if ((m = message.match(/^(.+?)\s+recorded a run!$/i))) {
      // The tracker explicitly follows earned runs with a separate charge
      // line. Start false so the absence of that line correctly means the run
      // was unearned instead of treating every run as earned by default.
      buf.runEvents.push({ scorerName: m[1].trim(), chargedToPitcherName: null, earnedRun: false })
      removeParserRunner(m[1].trim())
      const scorerPlayerId = resolvePlayerIdForCharacter(m[1].trim()) ?? buf.batterPlayerId
      if (String(scorerPlayerId) === String(TARGET_TEAM_A_PLAYER_ID)) {
        setLiveScoreForSide('A', Number(scoreState.a || 0) + 1)
      } else if (String(scorerPlayerId) === String(TARGET_TEAM_B_PLAYER_ID)) {
        setLiveScoreForSide('B', Number(scoreState.b || 0) + 1)
      }
      return
    }
    if ((m = message.match(/^(.+?)\s+was charged with an? earned run$/i))) {
      const openRun = buf.runEvents.at(-1)
      if (openRun) { openRun.chargedToPitcherName = m[1].trim(); openRun.earnedRun = true }
      return
    }
    if ((m = message.match(/^(.+?)\s+inherited this runner from (.+?)\.\s+(.+?)\s+will be charged any earned runs\.$/i))) {
      const openRun = buf.runEvents.at(-1)
      if (openRun && m[2].trim() === m[3].trim()) openRun.chargedToPitcherName = m[2].trim()
      return
    }
  }

  if ((m = message.match(/^Rematch detected\./i))) {
    log('rematch/reset detected mid-session — clearing in-memory play tracking. ' +
      'If plays were already recorded for the previous attempt, review/remove them manually.')
    currentPaBuffer = null
    pendingRunnerAssignmentBackfill = null
    lastFinalizedPa = null
    pendingMeasuredRunnerAssignments.clear()
    savedPaByPreviewNumber.clear()
    clearParserRunnerState()
    parserInning = 1
    parserIsTop = true
    parserOutsInHalf = 0
    scoreboardTeamNames = []
    setLiveScoreForSide('A', 0)
    setLiveScoreForSide('B', 0)
    return
  }
  // The game header, e.g. "Waluigi Spitballs vs. Luigi Knights @ Nighttime
  // Luigi's Mansion". It names the two teams the scoreboard lines are keyed
  // by, and NOTHING ELSE: its order is the order the match screen showed them,
  // which is not away-then-home. Of the saved sessions in this repo, the team
  // the tracker then says "will bat first" -- the away team -- is sometimes
  // the first name and sometimes the second.
  //
  // Reading side A out of that order put the home team's runs on the away
  // team's row: this game's own team_mapping ended up holding "Spitballs":"B"
  // from the roster and "Waluigi Spitballs":"A" from the header, the final
  // 6-12 was published as 12-6, the losing side was recorded as the winner,
  // and every moneyline on the game settled the wrong way. Which side a team
  // is on comes from the roster (rememberTrackerTeamSide), exactly as it does
  // for a run message.
  if ((m = message.match(/^(.+?)\s+vs\.\s+(.+?)\s+@\s+.+$/))) {
    scoreboardTeamNames = [m[1].trim(), m[2].trim()]
    return
  }
  if ((m = message.match(/^Next:\s*(Top|Bottom) of inning (\d+)$/i))) {
    parserInning = Number(m[2])
    parserIsTop = /top/i.test(m[1])
    parserOutsInHalf = 0
    clearParserRunnerState()
    return
  }
  // The stadium header ("Away vs. Home @ Mario Stadium") matches this shape
  // too, and starting a plate appearance from it produced a buffer whose
  // batter is "Home @ Mario Stadium" — unresolvable, so it was always skipped
  // and cost nothing. It costs something now: that phantom at-bat would claim
  // the previous at-bat's preview slot and report it to the page as skipped.
  // The preview parser has always excluded it; match that here.
  if ((m = message.match(/^(.+?)\s+vs\.\s+(.+)$/)) && !message.includes(' @ ')) {
    const pitcherName = m[1].trim()
    const batterName = m[2].trim()
    // Closing the previous plate appearance and opening this one are separate
    // facts, and they are caught separately because they used to share a try:
    // a write that failed while finishing the last batter -- a timeout, a
    // dropped connection -- threw past startNewPa(), so THIS batter never got
    // a buffer at all. Everything he then did was parsed into nothing, and the
    // at-bat vanished with no message of its own (the previous one is
    // recovered from the journal; this one was never journaled). The buffer
    // has already been detached by the time finalize can throw, so opening the
    // next one is always safe.
    try {
      await finalizeCurrentPaIfAny()
    } catch (err) {
      log('play tracking error:', err.message)
    }
    try {
      await startNewPa(pitcherName, batterName, previewPaNumber)
    } catch (err) {
      log('play tracking error:', err.message)
    }
    return
  }
  if (/^Changing sides!$/i.test(message) || /^Final Score:$/i.test(message)) {
    try {
      await finalizeCurrentPaIfAny()
    } catch (err) {
      log('play tracking error:', err.message)
    } finally {
      clearParserRunnerState()
    }
    return
  }
  if ((m = message.match(/^(.+?)\s*-\s*(\d+)$/))) {
    const name = m[1].trim()
    const scoreValue = Number(m[2])
    const side = inferTrackerScoreSide(name)
    if (side) setLiveScoreForSide(side, scoreValue, { scoreName: name })
  }
}

// Log lines arrive one at a time via readline, but recording a play can take
// several awaited Supabase round trips — queue play-event handling so a slow
// PA write can't run concurrently with (and get interleaved by) the next one.
let playEventChain = Promise.resolve()
function enqueuePlayEvent(message, previewPaNumber = null, stateSnapshot = null) {
  const processing = playEventChain.then(() => processPlayEvent(message, previewPaNumber))
  playEventChain = processing.catch((err) => log('play event processing error:', err.message))
  if (stateSnapshot) processing.then(() => triggerLivePush(stateSnapshot)).catch(() => {})
}

// ── xlsx (final box score, written once at game end) ───────────────────────

function sheetToRecords(worksheet) {
  const headerRow = worksheet.getRow(1)
  const headers = []
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? '').trim()
  })

  const records = []
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const record = {}
    let hasValue = false
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const header = headers[colNumber]
      if (!header) return
      const value = cell.value && typeof cell.value === 'object' && 'result' in cell.value
        ? cell.value.result
        : cell.value
      if (value !== null && value !== undefined && value !== '') hasValue = true
      record[header] = value ?? null
    })
    if (hasValue) records.push(record)
  })
  return records
}

function parseGameInfo(worksheet) {
  const cells = []
  worksheet.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const value = cell.value && typeof cell.value === 'object' && 'result' in cell.value
        ? cell.value.result
        : cell.value
      if (value === null || value === undefined || value === '') return
      cells.push({ row: rowNumber, col: colNumber, address: cell.address, value })
    })
  })

  const byPosition = new Map(cells.map((c) => [`${c.row}:${c.col}`, c]))
  const fields = {}
  for (const label of GAME_INFO_LABELS) {
    const labelCell = cells.find((c) => String(c.value).trim() === label)
    if (!labelCell) continue
    const right = byPosition.get(`${labelCell.row}:${labelCell.col + 1}`)
    const below = byPosition.get(`${labelCell.row + 1}:${labelCell.col}`)
    const valueCell = right || below
    if (valueCell) fields[label] = valueCell.value
  }

  return { fields, raw: cells }
}

// ── shared state pushed to Supabase ─────────────────────────────────────────
// Log-driven pushes and xlsx-driven pushes happen on independent schedules;
// each only updates its own slice so neither clobbers the other's data.

const xlsxState = { game_info: {}, batting: [], pitching: [] }
let completedWorkbookSyncs = 0
let xlsxSyncQueue = Promise.resolve()
let lastXlsxSyncError = null
const liveState = {
  matchup: null, outs: null, balls: null, strikes: null, currentBatter: null,
  inning: 1, isTop: true,
  score: {}, scoreBySide: { a: null, b: null }, winner: null, gameEnded: false,
  oddsCalculating: false, oddsRevision: 0, oddsStatusUpdatedAt: null,
  lastEvent: null, lastEventAt: null, events: [],
}
let trackerRunnerSnapshot = null
let pendingTrackerRunnerSnapshot = null
let trackerRunnerFeedDetected = false
let trackerRunnerSnapshotRejected = false
let trackerInningFeedDetected = false

function emptyRunnerState() {
  return { first: null, second: null, third: null }
}

function beginTrackerRunnerSnapshot() {
  trackerRunnerSnapshotRejected = false
  pendingTrackerRunnerSnapshot = trackerRunnerSnapshot
    ? copyTrackerRunnerState(trackerRunnerSnapshot)
    : emptyRunnerState()
  // Until this process has seen at least one runner-location message, keep
  // replay as the fallback so older tracker builds do not make every matchup
  // look like the bases are empty. Once detected, an omitted runner means
  // "unchanged", not "empty", so retain the preceding delta state.
  trackerRunnerSnapshot = trackerRunnerFeedDetected
    ? copyTrackerRunnerState(pendingTrackerRunnerSnapshot)
    : null
  if (trackerRunnerSnapshot) liveState.runners = copyTrackerRunnerState(trackerRunnerSnapshot)
}

function clearTrackerRunnerSnapshot() {
  trackerRunnerSnapshot = null
  pendingTrackerRunnerSnapshot = null
  trackerRunnerSnapshotRejected = false
  liveState.runners = emptyRunnerState()
}

function clearLiveCount() {
  liveState.balls = 0
  liveState.strikes = 0
}

function refreshCurrentMatchup(plateAppearances = []) {
  if (liveState.gameEnded) return
  const resolved = resolveTrackerMatchupForHalf({
    existingMatchup: liveState.matchup,
    inning: liveState.inning,
    isTop: liveState.isTop,
    homeAwaySwapped: Boolean(TARGET_GAME_ROW?.home_away_swapped),
    teamAPlayerId: TARGET_TEAM_A_PLAYER_ID,
    teamBPlayerId: TARGET_TEAM_B_PLAYER_ID,
    alignments: liveState.alignments || {},
    plateAppearances,
    lastConfirmedBatterByPlayer: liveState.lastConfirmedBatterByPlayer || {},
  })
  // If the bridge does not have enough lineup information to make a safe
  // prediction, clear the prior half's matchup instead of publishing known-
  // stale participants. Patched tracker sessions normally have both names.
  liveState.matchup = resolved.matchup
  liveState.predictedOnDeck = resolved.onDeckName || null
}

function applyTrackerRunnerSnapshotEntry({ characterName, base }) {
  const characterId = resolveCharacterId(characterName)
  const playerId = resolvePlayerIdForCharacter(characterName)
  if (characterId == null || playerId == null) {
    log(`could not resolve tracker baserunner ${characterName}; keeping replay-derived runner state for this matchup`)
    trackerRunnerSnapshot = null
    pendingTrackerRunnerSnapshot = null
    trackerRunnerSnapshotRejected = true
    return
  }
  if (trackerRunnerSnapshotRejected) return
  const runner = { characterId, playerId }
  pendingTrackerRunnerSnapshot = applyTrackerRunnerDelta(
    pendingTrackerRunnerSnapshot || trackerRunnerSnapshot || emptyRunnerState(),
    { base, runner },
  )
  trackerRunnerFeedDetected = true
  trackerRunnerSnapshot = copyTrackerRunnerState(pendingTrackerRunnerSnapshot)
  liveState.runners = copyTrackerRunnerState(trackerRunnerSnapshot)
}

function removeTrackerRunnerSnapshotEntry(characterName) {
  if (!trackerRunnerFeedDetected) return
  const characterId = resolveCharacterId(characterName)
  const playerId = resolvePlayerIdForCharacter(characterName)
  if (characterId == null || playerId == null) return
  const runner = { characterId, playerId }
  if (pendingTrackerRunnerSnapshot) {
    pendingTrackerRunnerSnapshot = removeTrackerRunner(pendingTrackerRunnerSnapshot, runner)
  }
  if (trackerRunnerSnapshot) trackerRunnerSnapshot = removeTrackerRunner(trackerRunnerSnapshot, runner)
  liveState.runners = copyTrackerRunnerState(trackerRunnerSnapshot || emptyRunnerState())
}

function buildLiveStatePayload(state = liveState) {
  const batterName = state.matchup?.right || state.currentBatter || null
  const pitcherName = state.matchup?.left || null
  const onDeckName = state.predictedOnDeck || null
  return {
    inning: state.inning || 1,
    isTop: state.isTop !== false,
    outsInHalf: Number(state.outs || 0),
    balls: Number(state.balls || 0),
    strikes: Number(state.strikes || 0),
    // Mirrors the live count already being ticked onto pitching_stints
    // (bumpLivePitchCount) so the game view's pitch counter moves pitch by
    // pitch instead of only jumping once a plate appearance is fully saved.
    pitchNumber: Number(state.pitchNumber ?? currentPaBuffer?.pitcherStint?.pitches_thrown ?? 0),
    pitcherStintId: state.pitcherStintId ?? currentPaBuffer?.pitcherStint?.id ?? null,
    paNumber: Number(state.paNumber || 0),
    batterCharacterId: resolveCharacterId(batterName),
    batterPlayerId: resolvePlayerIdForCharacter(batterName),
    pitcherCharacterId: resolveCharacterId(pitcherName),
    pitcherPlayerId: resolvePlayerIdForCharacter(pitcherName),
    onDeckCharacterId: resolveCharacterId(onDeckName),
    onDeckPlayerId: resolvePlayerIdForCharacter(onDeckName),
    runners: state.runners || { first: null, second: null, third: null },
    oddsCalculating: Boolean(state.oddsCalculating),
    oddsRevision: Number(state.oddsRevision || 0),
    updatedAt: new Date().toISOString(),
  }
}

// PA replay repairs state on startup before the tracker has emitted an inning
// line. Once the tracker explicitly reports "N outs" / "Next: ...", those
// values are authoritative: a PA can be incomplete or miss a baserunner out,
// and must never regress a correctly advanced half inning. Runner identity is
// likewise replayed only as a fallback, then replaced by explicit snapshots.
async function resyncGameStateFromPAs() {
  const [{ data: pas, error }, { data: runs, error: runsError }] = await Promise.all([
    supabase.from(GAME_TABLES.plateAppearances)
      .select('id,result,outs_on_play,character_id,player_id,pa_number').eq('game_id', TARGET_GAME_ID),
    supabase.from(GAME_TABLES.runsScored)
      .select('pa_id,scoring_character_id,scoring_player_id').eq('game_id', TARGET_GAME_ID),
  ])
  if (error) {
    log('game-state resync failed, keeping log-parsed values:', error.message)
    return
  }
  if (!pas || !pas.length) {
    if (!parserRunnerStateInitialized && !currentPaBuffer) clearParserRunnerState()
    return
  }
  if (runsError) log('runs_scored fetch failed during resync (runner scoring won\'t be cross-checked):', runsError.message)
  const scorerKeysByPaId = new Map()
  for (const run of runs || []) {
    const key = String(run.pa_id)
    if (!scorerKeysByPaId.has(key)) scorerKeysByPaId.set(key, new Set())
    scorerKeysByPaId.get(key).add(`${run.scoring_character_id}:${run.scoring_player_id}`)
  }
  const sortedPAs = [...pas].sort((a, b) => Number(a.pa_number) - Number(b.pa_number))
  const totalOuts = sortedPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
  const inningSync = applyPaDerivedTrackerInningState(liveState, totalOuts, {
    hasExplicitTrackerState: trackerInningFeedDetected,
  })
  if (inningSync.halfChanged) {
    // A PA resync can discover the third out before the later "Changing
    // sides!" log line arrives. Never publish the newly-derived half-inning
    // with the completed PA's count still attached to it.
    clearLiveCount()
    clearTrackerRunnerSnapshot()
    liveState.currentBatter = null
  }
  const replayedRunners = deriveCurrentRunners(sortedPAs, totalOuts, scorerKeysByPaId)
  if (!parserRunnerStateInitialized && !currentPaBuffer) {
    parserRunnersInHalf = copyTrackerRunnerState(replayedRunners)
    parserRunnerStateInitialized = true
  }
  liveState.runners = trackerRunnerSnapshot
    ? { ...trackerRunnerSnapshot }
    : replayedRunners
  refreshCurrentMatchup(sortedPAs)
}

async function pushStateOnce(stateSnapshot = null) {
  // A bridge that has released the game publishes nothing more. Both of the
  // callers here are debounces, and one fires from the tracker's own exit
  // handler, so a publish can still be in flight a tick after the lease has
  // been handed back -- into a game the next bridge may already own.
  if (bridgeReleased) return
  assertLeaseWritable('the live-state publish')
  if (requiredPersistenceFailure) {
    throw new Error(`live state held behind failed scoring write: ${requiredPersistenceFailure.message}`)
  }
  await resyncGameStateFromPAs()
  const publishedState = stateSnapshot || structuredClone(liveState)

  const payload = {
    game_id: TARGET_GAME_ID,
    game_info: xlsxState.game_info,
    batting: xlsxState.batting,
    pitching: xlsxState.pitching,
    live_feed: publishedState,
    team_mapping: trackerTeamMapping,
    updated_at: new Date().toISOString(),
  }
  // The bridge's own feed and the site's own live_state column (the same field
  // the manual scorebook uses for in-progress batter/pitcher/count), in one
  // transaction that asserts this bridge still owns the game. They were two
  // requests and neither was fenced: a bridge whose lease had just been taken
  // published a live feed into a game another machine was scoring.
  const livePayload = buildLiveStatePayload(publishedState)
  const fenced = await callFencedGameMutation('tracker_publish_live_state', {
    p_stats: payload, p_live_state: livePayload,
  }, 'the live-state publish')
  if (!fenced.fenced) {
    const { error } = await supabase.from(TARGET_STATS_TABLE).upsert(payload, { onConflict: 'game_id' })
    if (error) throw error
    const { error: liveStateError } = await supabase
      .from(TARGET_GAMES_TABLE).update({ live_state: livePayload }).eq('id', TARGET_GAME_ID)
    if (liveStateError) throw liveStateError
  }
  triggerBettingSync()
}

// Supabase writes from consecutive log events can otherwise finish out of
// order (for example, a slow 0-2 update landing after the side-change reset).
// Keep all bridge state pushes ordered while allowing each caller to observe
// its own failure.
let pushStateQueue = Promise.resolve()
function pushState(stateSnapshot = null) {
  const queuedPush = pushStateQueue.then(() => pushStateOnce(stateSnapshot))
  pushStateQueue = queuedPush.catch(() => {})
  return queuedPush
}

async function readWithRetry(fn, attempts = 5, delayMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

async function syncXlsx(filePath) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  const gameInfoSheet = workbook.getWorksheet('Game Info')
  const statsSheet = workbook.getWorksheet('Stats')
  const pitchingSheet = workbook.getWorksheet('Pitching')
  if (!statsSheet || !pitchingSheet) {
    throw new Error('Workbook is missing the expected Stats/Pitching sheets.')
  }

  xlsxState.game_info = gameInfoSheet ? parseGameInfo(gameInfoSheet) : {}
  xlsxState.batting = sheetToRecords(statsSheet)
  xlsxState.pitching = sheetToRecords(pitchingSheet)

  for (const alignment of parseWorkbookStartingLineups(gameInfoSheet)) {
    try {
      await syncTrackerAlignment(alignment)
    } catch (err) {
      log(`workbook lineup ignored for ${alignment.teamName || 'unknown tracker team'}:`, err.message)
    }
  }

  await pushState()
  log(`box score synced from ${path.basename(filePath)}: ${xlsxState.batting.length} batting rows, ${xlsxState.pitching.length} pitching rows`)
}

function watchXlsx() {
  // Excel-writing tools (this tracker included) typically save by writing a
  // temp file and swapping it in rather than editing in place. Native OS
  // file-change events (what chokidar uses by default) often lose track of
  // the file across that swap, especially on Windows — polling is slower
  // but doesn't have that failure mode.
  let debounce = null
  let pendingPath = null
  const trigger = (filePath) => {
    if (!XLSX_PATH && path.extname(filePath).toLowerCase() !== '.xlsx') return
    pendingPath = filePath
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      const completedPath = pendingPath
      const sync = xlsxSyncQueue.then(() => readWithRetry(() => syncXlsx(completedPath)))
      xlsxSyncQueue = sync.then(() => {
        completedWorkbookSyncs += 1
        lastXlsxSyncError = null
      }).catch((error) => { lastXlsxSyncError = error })
      sync.catch((err) => log('box score sync failed:', err.message))
    }, 300)
  }
  // Chokidar 5 treats a glob as a literal path. Watch the directory and filter
  // events instead, or no newly created game workbook is ever observed.
  const watchTarget = XLSX_PATH || TRACKER_OUTPUT_DIR
  const watcher = xlsxWatcher = chokidar.watch(watchTarget, {
    ignoreInitial: true,
    depth: 0,
    usePolling: true,
    interval: 1000,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })
  watcher.on('change', trigger)
  watcher.on('add', trigger)
  watcher.on('error', (err) => log('xlsx watcher error:', err.message))
  log(`watching completed tracker workbooks at ${watchTarget}`)
}

// ── live log feed (parsed from the tracker's own console output) ──────────

const LOG_LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.*)$/

function applyLogMessage(message) {
  let m
  const inningStateMessage = applyTrackerInningStateMessage(liveState, message)
  if (inningStateMessage) trackerInningFeedDetected = true
  const diagnostic = String(message || '').trim().startsWith(TRACKER_PITCH_PROVISIONAL_MARKER)
    ? parseTrackerPitchProvisionalMessage(message)
    : String(message || '').trim().startsWith(TRACKER_BATTED_BALL_MARKER)
      ? parseTrackerBattedBallMessage(message)
      : null
  // The preview parser has already accepted this structured identity by the
  // time this live-state parser runs. Mirror a recovered missing matchup so the
  // scoreboard/odds view does not remain one batter behind the database writer.
  if (
    diagnostic?.pitcherName && diagnostic?.batterName
    && diagnostic.pitcherName !== 'unknown' && diagnostic.batterName !== 'unknown'
    && (!sameCharacterName(liveState.matchup?.left, diagnostic.pitcherName)
      || !sameCharacterName(liveState.matchup?.right, diagnostic.batterName))
    && sameCharacterName(previewState.current?.pitcherName, diagnostic.pitcherName)
    && sameCharacterName(previewState.current?.batterName, diagnostic.batterName)
  ) {
    liveState.matchup = {
      left: diagnostic.pitcherName,
      right: diagnostic.batterName,
      inning: Math.max(1, Number(liveState.inning || 1)),
      isTop: liveState.isTop !== false,
      predicted: false,
    }
    liveState.currentBatter = diagnostic.batterName
    const batterPlayerId = resolvePlayerIdForCharacter(diagnostic.batterName)
    if (batterPlayerId != null) {
      liveState.lastConfirmedBatterByPlayer = {
        ...(liveState.lastConfirmedBatterByPlayer || {}),
        [String(batterPlayerId)]: diagnostic.batterName,
      }
    }
    refreshCurrentMatchup()
    clearLiveCount()
  }
  if ((m = message.match(/^(.+?)\s+vs\.\s+(.+)$/))) {
    const pitcherName = m[1].trim()
    const batterName = m[2].trim()
    liveState.matchup = {
      left: pitcherName,
      right: batterName,
      inning: Math.max(1, Number(liveState.inning || 1)),
      isTop: liveState.isTop !== false,
      predicted: false,
    }
    const batterPlayerId = resolvePlayerIdForCharacter(batterName)
    if (batterPlayerId != null) {
      liveState.lastConfirmedBatterByPlayer = {
        ...(liveState.lastConfirmedBatterByPlayer || {}),
        [String(batterPlayerId)]: batterName,
      }
    }
    refreshCurrentMatchup()
    clearLiveCount()
    // Runner lines after this header are deltas. Preserve every unchanged
    // runner from the prior matchup and apply only the bases the tracker names.
    beginTrackerRunnerSnapshot()
  } else if (inningStateMessage?.type === 'next_half') {
    liveState.currentBatter = null
    clearLiveCount()
    clearTrackerRunnerSnapshot()
    refreshCurrentMatchup()
  } else if (inningStateMessage?.type === 'outs') {
    // The helper applied this authoritative value before the event-specific
    // side effects in this chain.
  } else if ((m = message.match(/^Count:\s*(\d)-(\d)$/i))) {
    liveState.balls = Number(m[1])
    liveState.strikes = Number(m[2])
  } else if ((m = message.match(/^Plate appearance #(\d+) for (.+)\.$/i))) {
    liveState.paNumber = Number(m[1])
    liveState.currentBatter = m[2]
  } else if ((m = message.match(/^At-bat #(\d+) for (.+)\.$/i))) {
    liveState.abNumber = Number(m[1])
  } else if ((m = parseTrackerRunnerMessage(message))) {
    applyTrackerRunnerSnapshotEntry(m)
  } else if ((m = parseTrackerPutoutMessage(message))) {
    removeTrackerRunnerSnapshotEntry(m.runnerName)
  } else if ((m = message.match(/^(.+?)\s+recorded a run!$/i))) {
    removeTrackerRunnerSnapshotEntry(m[1].trim())
  } else if (inningStateMessage?.type === 'side_change') {
    liveState.currentBatter = null
    clearLiveCount()
    clearTrackerRunnerSnapshot()
  } else if ((m = message.match(/^(.+?) win!$/i))) {
    liveState.winner = m[1].trim()
  } else if (/^Final Score:$/i.test(message)) {
    if (finalScoreWorkbookSyncBaseline == null) finalScoreWorkbookSyncBaseline = completedWorkbookSyncs
    liveState.gameEnded = true
    liveState.oddsCalculating = false
    clearLiveCount()
    clearTrackerRunnerSnapshot()
  } else if ((m = message.match(/^(.+?)\s*-\s*(\d+)$/))) {
    // Running score line, e.g. "Wario Muscles - 9" — printed on every side
    // change and again in the final-score summary.
    const scoreName = m[1].trim()
    const scoreValue = Number(m[2])
    liveState.score[scoreName] = scoreValue
    const side = inferTrackerScoreSide(scoreName)
    if (side) setLiveScoreForSide(side, scoreValue, { scoreName })
  }
  liveState.lastEvent = message
  liveState.lastEventAt = new Date().toISOString()
}

// Every 60Hz ball position the exe emits, in a trailing window.
//
// Kept at module scope rather than per plate appearance because the samples
// arrive BEFORE the contact record that identifies which flight they belong to:
// the record carries contact_seq, and only then can the flight be sliced out.
const ballSamples = new TrackerBallSampleBuffer()

function resetInMemoryTrackerGame({ reason = 'fresh game', gameRow = TARGET_GAME_ROW } = {}) {
  const scoreA = Number(isSeasonGame() ? gameRow?.away_score : gameRow?.team_a_runs) || 0
  const scoreB = Number(isSeasonGame() ? gameRow?.home_score : gameRow?.team_b_runs) || 0

  currentPaBuffer = null
  paFinalizationInProgress = false
  pendingRunnerAssignmentBackfill = null
  lastFinalizedPa = null
  pendingMeasuredRunnerAssignments.clear()
  savedPaByPreviewNumber.clear()
  completedPaRevision = 0
  parserInning = 1
  parserIsTop = true
  parserOutsInHalf = 0
  clearParserRunnerState()

  trackerRunnerSnapshot = null
  pendingTrackerRunnerSnapshot = null
  trackerRunnerFeedDetected = false
  trackerRunnerSnapshotRejected = false
  trackerInningFeedDetected = false
  scoreboardTeamNames = []
  appliedAlignmentSignaturesByPlayerId.clear()
  appliedBattingSignaturesByPlayerId.clear()
  // Only ever reached for a game with no plate appearances against it, so the
  // lineup flow goes back to site-is-the-source-of-truth along with the rest.
  trackerGameHasBegun = false
  trackerTeamSideByName.clear()
  Object.entries(trackerTeamMapping).forEach(([name, side]) => {
    if (side === 'A' || side === 'B') trackerTeamSideByName.set(name, side)
  })
  ballSamples.clear()

  scoreState.a = scoreA
  scoreState.b = scoreB
  Object.assign(liveState, {
    matchup: null,
    predictedOnDeck: null,
    outs: 0,
    balls: 0,
    strikes: 0,
    currentBatter: null,
    inning: 1,
    isTop: true,
    paNumber: 0,
    abNumber: 0,
    runners: emptyRunnerState(),
    score: {},
    scoreBySide: { a: scoreA, b: scoreB },
    alignments: {},
    lastConfirmedBatterByPlayer: {},
    winner: null,
    gameEnded: false,
    oddsCalculating: false,
    oddsRevision: 0,
    oddsStatusUpdatedAt: null,
    lastEvent: null,
    lastEventAt: null,
    events: [],
  })
  delete liveState.inningStateSource
  xlsxState.game_info = {}
  xlsxState.batting = []
  xlsxState.pitching = []

  bettingSyncVersion += 1
  clearTimeout(bettingSyncDebounce)
  bettingSyncDebounce = null
  lastPricedMarketSignature = null
  // The at-bats the preview is holding belong to the discarded attempt, and so
  // do their write outcomes. Leaving them would put at-bats on the live tracker
  // tab that have no rows behind them in the game it is now recording.
  clearTrackerPreviewAtBats(previewState)
  log(`${reason}: cleared stale inning, runner, lineup, score, and event state before PA #1.`)
}

async function fetchTargetGameFreshness() {
  const gameColumns = isSeasonGame()
    ? 'id,status,away_score,home_score'
    : 'id,status,team_a_runs,team_b_runs'
  const [{ data: gameRow, error: gameError }, { count: paCount, error: paError }] = await Promise.all([
    supabase.from(TARGET_GAMES_TABLE).select(gameColumns).eq('id', TARGET_GAME_ID).single(),
    supabase.from(GAME_TABLES.plateAppearances)
      .select('id', { count: 'exact', head: true }).eq('game_id', TARGET_GAME_ID),
  ])
  if (gameError) throw gameError
  if (paError) throw paError
  return { gameRow, paCount: Number(paCount || 0) }
}

async function resetTrackerStateIfGameIsPristine(reason) {
  const { gameRow, paCount } = await fetchTargetGameFreshness()
  TARGET_GAME_ROW = { ...TARGET_GAME_ROW, ...gameRow }
  if (!shouldStartFreshTrackerSession(gameRow, paCount)) return false
  resetInMemoryTrackerGame({ reason, gameRow })
  return true
}

async function markTargetGameInProgress() {
  const currentStatus = String(TARGET_GAME_ROW?.status || '').toLowerCase()
  const pendingStatus = isSeasonGame() ? 'scheduled' : 'pending'
  if (currentStatus !== pendingStatus) return false
  const activeStatus = isSeasonGame() ? 'in_progress' : 'active'
  const { data, error } = await supabase
    .from(TARGET_GAMES_TABLE)
    .update({ status: activeStatus })
    .eq('id', TARGET_GAME_ID)
    .eq('status', pendingStatus)
    .select('status')
    .maybeSingle()
  if (error) throw error
  if (!data) return false
  TARGET_GAME_ROW = { ...TARGET_GAME_ROW, status: data.status }
  log(`marked ${TARGET_GAMES_TABLE} ${TARGET_GAME_ID} ${activeStatus}`)
  return true
}

// ── at-bat preview surface ──────────────────────────────────────────────────
// The same in-memory at-bat view scripts/tracker_at_bat_preview.mjs serves, run
// alongside the real Supabase writes rather than instead of them. Bug-testing a
// live game used to mean choosing: the preview page showed every parsed detail
// but saved nothing, and the bridge saved everything but showed only a console
// log. This runs both parsers over one tracker process, so the page that shows
// what was parsed is the page attached to the game that is being recorded — and
// each at-bat on it now says whether it reached the database.
const previewState = createTrackerPreviewState({ mode: 'live_bridge', writesEnabled: true })

// Opened once sign-in succeeds, which is early enough -- the only thing that
// writes to it is the tracker, and that does not launch until much later --
// and late enough that a bad password does not leave a one-line file behind in
// the directory the flight archive sweeps.
let sessionLog = null
function openSessionLog() {
  if (!SESSION_LOG_ENABLED || sessionLog) return
  const startedAt = new Date()
  sessionLog = createTrackerSessionLog({
    prefix: 'bridge',
    startedAt,
    header: `[tracker-bridge] session started ${startedAt.toISOString()} · exe=${EXE_PATH}`,
  })
}

// The park comes from the games row here rather than from a hand-pick, so the
// marker can be written the moment the target game is known -- which is well
// before the tracker launches, and therefore ahead of every sample it labels.
function noteSessionStadium() {
  sessionLog?.noteStadium(previewState, (record) => log(record))
}

// buf.previewPaNumber is null for any plate appearance that began before the
// preview parser saw its matchup line (e.g. a buffer flushed at side change on
// a bridge restart). Nothing to attach the outcome to, so nothing is claimed.
function notePreviewWrite(buf, status) {
  if (!buf || buf.previewPaNumber == null) return
  recordTrackerPreviewWrite(previewState, buf.previewPaNumber, status)
}

let requestManualStop = async () => {
  await stopTrackerBridge()
  if (invokedDirectly) process.exit(0)
}
let requestCompletedGameStop = async () => {}

const previewServer = PREVIEW_PORT > 0
  ? createTrackerPreviewServer({
    state: previewState,
    port: PREVIEW_PORT,
    // A stadium picked by hand in the browser re-projects the preview's own
    // batted-ball geometry only. TARGET_STADIUM_KEY, which is what actually
    // gets written onto plate_appearances, comes from the games row and is
    // deliberately left alone — the page must not be able to change what is
    // recorded for a game just by changing what it draws.
    onStadiumChange: (key) => {
      log(`preview projection stadium set to ${key} (database rows still use ${TARGET_STADIUM_KEY || 'the game row stadium'})`)
      // Positional attribution again: a correction made mid-session must be in
      // the stream before the flights it applies to, so it is written now.
      noteSessionStadium()
    },
    // Into the session log as well as the console: scripts/fit_park_vertical.mjs
    // greps these records out of the log files, so one that only reached the
    // terminal is a measurement taken and thrown away.
    onCalibrationRecord: (line) => {
      log(line)
      sessionLog?.writeRecord(line)
    },
    // "Something is wrong" writes beside the 60 Hz capture this game produced,
    // so a flag and the frames behind it stay together. It never touches a
    // plate appearance or any other Supabase row -- this bridge writes
    // statistics, and that path is deliberately not connected to this one.
    annotationPath: () => annotationPathFor(
      previewState.playerTracking?.capture?.stem,
      { fallbackDir: PLAYER_TRACKING_DIR, label: sidecarFilePrefix() },
    ),
    onAnnotation: (record, filePath) => {
      log(`operator flagged PA ${record.pa_number} (${record.categories.join(', ')}) -> ${filePath}`)
    },
    onShutdown: () => requestManualStop(),
  })
  : null

function startPreviewServer() {
  if (!previewServer) {
    log('at-bat preview surface disabled (TRACKER_BRIDGE_PREVIEW_PORT=0)')
    return
  }
  previewServer.on('error', (err) => {
    // Overwhelmingly this is the standalone preview already holding the port.
    // It is not fatal — the bridge's job is the database, and it keeps doing
    // it — but it does mean the scorebook's live tracker tab will show nothing.
    log(`at-bat preview surface unavailable on port ${PREVIEW_PORT}: ${err.message}`)
    if (err.code === 'EADDRINUSE') {
      log('something else is already on that port — stop scripts/tracker_at_bat_preview.mjs, ' +
        'or set TRACKER_BRIDGE_PREVIEW_PORT to a free port.')
    }
  })
  previewServer.listen(PREVIEW_PORT, '127.0.0.1', () => {
    log(`at-bat preview surface: http://127.0.0.1:${PREVIEW_PORT}/state (database writes ENABLED)`)
  })
}

// Everything the games row already knows, so the embedded page can prove it is
// watching the game it was opened on rather than a stale bridge left running
// against a different one.
function publishPreviewGameContext() {
  setTrackerPreviewGameContext(previewState, {
    game_id: TARGET_GAME_ID,
    games_table: TARGET_GAMES_TABLE,
    is_season: isSeasonGame(),
    season_id: TARGET_SEASON_ID,
    source_id: TARGET_SOURCE_ID,
    stadium_key: TARGET_STADIUM_KEY,
    team_a_player_id: TARGET_TEAM_A_PLAYER_ID,
    team_b_player_id: TARGET_TEAM_B_PLAYER_ID,
  })
  // The bridge knows the park from the games row, so the preview never has to
  // be told by hand the way the standalone one does. Treated as an override
  // because that is the field the page's selector writes; a "vs. @ Stadium"
  // line detected later must not silently move the projection off the park the
  // game is actually being played in.
  if (TARGET_STADIUM_KEY && !setTrackerPreviewStadiumOverride(previewState, TARGET_STADIUM_KEY)) {
    log(`preview projection has no geometry for stadium "${TARGET_STADIUM_KEY}" — field location will stay blank on the live tracker tab.`)
  }
  noteSessionStadium()
}

function handleTrackerLogLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return
  const match = trimmed.match(LOG_LINE_RE)
  const message = match ? match[3] : trimmed
  const level = match ? match[2] : 'RAW'

  // FIRST, and before the parser: the readers handshake settles on the
  // tracker's own opening line, and it has to settle whether or not anything
  // below makes sense of it.
  noteScoringReaderOutput(message)

  // Both of these come before the ball-sample drop below, on purpose. The
  // 60Hz samples ARE the flight data: the session log exists to keep them, and
  // the preview's projections are built out of them, so either one fed the
  // filtered stream would silently hold nothing worth having.
  //
  // The log takes the whole original line, timestamp and level included, so
  // the file reads the way the console did and the flight pipeline's substring
  // matching still finds its markers.
  sessionLog?.write(trimmed)
  // This parser is synchronous and never awaits, so the page stays exactly
  // current with the tracker even while the Supabase queue is several at-bats
  // behind.
  applyTrackerPreviewMessage(previewState, message)
  noteSessionStadium()
  previewState.trackerPid = trackerProcess?.pid ?? previewState.trackerPid
  // Read now rather than when the queue gets here: this is the at-bat the page
  // is showing for this line, and by the time a slow PA write lets the queue
  // move on, the parser above may be several at-bats further along.
  const previewPaNumber = previewState.current?.localPaNumber ?? null

  // Ball samples are handled first and then dropped. There are ~34,000 per game
  // at 60Hz, and liveState.events is deliberately uncapped so the Admin console
  // can dump a whole game's history -- letting samples into it would bury every
  // readable line and grow that array without bound. Nothing downstream parses
  // them as messages, so returning here changes no other behaviour.
  if (message.startsWith(`${TRACKER_BALL_SAMPLE_MARKER} `)) {
    ballSamples.push(parseTrackerBallSampleMessage(message))
    return
  }

  applyLogMessage(message)
  // Kept for the whole game (no cap) so the Admin console dump has the full
  // history to copy/paste from when reporting a parsing issue, not just
  // whatever happened to still be in a trailing window.
  liveState.events.push({ time: match ? match[1] : new Date().toLocaleTimeString(), level, message })

  // Publish only the snapshot associated with a line whose serialized
  // scoring work completed. Later parsed lines cannot leak ahead of it.
  const stateSnapshot = structuredClone(liveState)
  stateSnapshot.pitchNumber = Number(currentPaBuffer?.pitcherStint?.pitches_thrown || 0)
  stateSnapshot.pitcherStintId = currentPaBuffer?.pitcherStint?.id || null
  enqueuePlayEvent(message, previewPaNumber, stateSnapshot)
}

// The running tracker .exe, so the preview surface can report its pid the same
// way the standalone preview does.
let trackerProcess = null
let playerTrackingProcess = null
let playerTrackingStartupLines = []
let playerTrackingStopPath = null
let playerTrackingManifestPath = null
let playerTrackingFinalization = null
let playerTrackingFinalizationError = null

function sidecarFilePrefix() {
  const source = isSeasonGame() ? 'season' : 'tournament'
  return `${source}-${String(TARGET_GAME_ID).replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function runSidecarCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, { cwd: process.cwd(), windowsHide: true })
    readline.createInterface({ input: child.stdout }).on('line', (line) => log(`[${label}] ${line}`))
    readline.createInterface({ input: child.stderr }).on('line', (line) => log(`[${label}] ${line}`))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} exited with code ${code}`))
    })
  })
}

function playerTrackingCaptureFinished() {
  if (!playerTrackingManifestPath || !fs.existsSync(playerTrackingManifestPath)) return false
  try {
    return JSON.parse(fs.readFileSync(playerTrackingManifestPath, 'utf8')).status === 'captured'
  } catch {
    return false
  }
}

async function finalizePlayerTrackingCapture() {
  assertLeaseWritable('postgame capture finalization')
  // The postgame version replaces the live one, so no live write may start
  // after this point or still be running when the ingest opens it.
  liveTrackingClosed = true
  await liveTrackingSync
  if (!playerTrackingManifestPath || !fs.existsSync(playerTrackingManifestPath)) {
    throw new Error('player-tracking sidecar exited without a manifest')
  }
  const manifest = JSON.parse(fs.readFileSync(playerTrackingManifestPath, 'utf8'))
  if (manifest.status !== 'captured' || !manifest.stem) {
    throw new Error(`player-tracking capture did not finish cleanly (status=${manifest.status || 'unknown'})`)
  }
  const stem = manifest.stem
  await runSidecarCommand(PLAYER_TRACKING_PYTHON, [
    path.resolve('scripts/calibrate_player_tracking.py'), stem,
  ], 'player-calibration')
  setTrackerPreviewCaptureHealth(previewState, { stem })
  await runSidecarCommand(PLAYER_TRACKING_PYTHON, [
    path.resolve('scripts/derive_player_metrics.py'), stem,
  ], 'player-derivation')
  // The authoritative restatement of every play, loaded back so the console
  // can compare the live derivation against it field by field. A disagreement
  // is a warning on the page rather than a line in a log nobody reads.
  try {
    const derived = `${stem}.plays.jsonl`
    if (fs.existsSync(derived)) {
      let loaded = 0
      for (const line of fs.readFileSync(derived, 'utf8').split('\n')) {
        if (!line.trim()) continue
        if (applyTrackerPreviewPostgamePlay(previewState, JSON.parse(line))) loaded += 1
      }
      log(`loaded ${loaded} authoritative plays for live-vs-postgame comparison`)
    }
  } catch (error) {
    log('could not load the postgame plays for comparison:', error.message)
  }
  // Ingestion mutates plate_appearances (tracking_session_id) and the shared
  // runner/double-play links, so it carries this bridge's lease into its own
  // process and the database refuses it from a stale owner exactly as it
  // refuses a scoring write. A bridge that has lost the game does not reach
  // this line at all: assertLeaseWritable throws first.
  const ingestLease = assertLeaseWritable('postgame tracking ingestion')
  await runSidecarCommand(process.execPath, [
    path.resolve('scripts/ingest_player_tracking.mjs'),
    '--session', stem,
    '--game-id', String(TARGET_GAME_ID),
    '--competition-type', trackerSourceType(),
    '--source-id', String(TARGET_SOURCE_ID || ''),
    ...(ingestLease?.ownerId ? ['--lease-owner', ingestLease.ownerId, '--lease-epoch', String(ingestLease.epoch)] : []),
    ...(ingestLease?.ownerId ? [] : ['--unleased-reason', 'this database has no tracker lease functions']),
  ], 'player-ingest')
  log(`player tracking derived and ingested: ${stem}`)
}

function requestPlayerTrackingStop() {
  if (!playerTrackingProcess || !playerTrackingStopPath) return
  try {
    fs.writeFileSync(playerTrackingStopPath, new Date().toISOString())
    log(`requested clean player-tracking stop (${playerTrackingStopPath})`)
  } catch (error) {
    log('could not signal the player-tracking sidecar to stop:', error.message)
  }
}

// The collector's stdout is a data feed as well as a log. The parsing lives in
// tracker_collector_feed.mjs so this bridge and the read-only preview cannot
// disagree about what the capture health bar is saying.
function handlePlayerTrackingLine(line) {
  playerTrackingStartupLines.push(String(line))
  if (playerTrackingStartupLines.length > 6) playerTrackingStartupLines.shift()
  const handled = applyCollectorLine(previewState, line, {
    log: (message) => log(`[player-tracker] ${message}`),
    onCaptureReady: (evidence) => settleCaptureRecording(
      evidence?.ready
        ? { ok: true, evidence }
        : { ok: false, reason: evidence?.reason || 'the collector reported no capture evidence', evidence },
    ),
    onCaptureAttached: (evidence) => settleCaptureAttached(
      evidence?.attached
        ? { ok: true, evidence }
        : { ok: false, reason: evidence?.reason || 'the collector reported it was not attached', evidence },
    ),
  })
  if (!handled) log(`[player-tracker] ${line}`)
  if (line.startsWith('[live-play] ')) {
    playEventChain = playEventChain.then(backfillMeasuredRunnerAssignments)
      .catch((error) => log('late runner assignment processing failed:', error.message))
      .then(syncLiveTrackingFacts)
  }
  // ONLY WHEN THE ROW HAD NOTHING. The games row stays the source of truth for
  // what is written to plate_appearances, and a stadium picked in the browser
  // is still refused. This is neither: it is the game's own stadium byte,
  // read out of memory by the collector, filling a column that would otherwise
  // be null for every plate appearance of the game.
  // stadiumDetectedKey, deliberately, and not stadiumKey: the latter prefers a
  // hand-pick, and a hand-pick must never reach the database.
  if (!TARGET_STADIUM_KEY && previewState.stadiumDetectedKey) {
    TARGET_STADIUM_KEY = previewState.stadiumDetectedKey
    log(`stadium resolved from the game's own memory: ${TARGET_STADIUM_KEY}`)
    noteSessionStadium()
  }
}

function collectorStartupExitReason(code, phase) {
  const detail = playerTrackingStartupLines.slice(-3).join(' | ')
  return `the collector exited with code ${code} ${phase}${detail ? `: ${detail}` : ''}`
}

// ── the recording handshake ──────────────────────────────────────────────────
//
// WHAT IS BEING PROVEN, AND WHY THE OBVIOUS SIGNALS DO NOT PROVE IT. The
// collector's pid exists the instant spawn() returns, before python has
// imported anything. Its first "[live-status] recording" line is printed
// before the capture loop reads a single frame. Its own .bin exists as soon as
// the file is opened, and is 4 bytes of magic at that point. None of those
// distinguish a collector that is recording from one attached to a paused
// emulator, and the whole cost of getting this wrong is the opening pitch.
//
// The collector's frame counter only advances when the game's own clock does,
// and the evidence line is printed only after those frames have been flushed
// to disk and the file's size read back. So "recording" here means: this many
// frames were sampled off a running game and this many bytes of them are on
// disk.
let captureRecordingState = null
let captureRecordingResolve = null
const captureRecordingStartedAt = { at: null }

function settleCaptureRecording(outcome) {
  if (captureRecordingState) return captureRecordingState
  captureRecordingState = {
    ...outcome,
    waitedMs: captureRecordingStartedAt.at == null
      ? null : Math.round(performance.now() - captureRecordingStartedAt.at),
  }
  captureRecordingResolve?.(captureRecordingState)
  captureRecordingResolve = null
  publishCaptureRecording(captureRecordingState)
  return captureRecordingState
}

// Atomic, like the ready file: a launcher polling for existence must never
// read a half-written one.
function publishCaptureRecording(outcome) {
  if (!LAUNCH_RECORDING_PATH) return
  const payload = JSON.stringify({
    pid: process.pid,
    gameId: TARGET_GAME_ID,
    gamesTable: TARGET_GAMES_TABLE,
    recording: Boolean(outcome.ok),
    // Deliberately off is not a failure, and a launcher that reported it as
    // one would train an operator to ignore the warning that matters.
    disabled: Boolean(outcome.disabled),
    reason: outcome.ok ? null : (outcome.reason || 'unknown'),
    waitedMs: outcome.waitedMs ?? null,
    frames: outcome.evidence?.frames ?? null,
    missedFrames: outcome.evidence?.missed_frames ?? null,
    bytesOnDisk: outcome.evidence?.bytes_on_disk ?? null,
    firstFramesSeconds: outcome.evidence?.elapsed_s ?? null,
    collectorPid: previewState.playerTracking?.capture?.collector_pid ?? null,
    stem: outcome.evidence?.stem ?? null,
    // The third member of the triple. A capture and a tracker log recorded from
    // one game are only usable together, and the pairing has until now been
    // reconstructed after the fact from timestamps
    // (scripts/audit_tracking_archive.mjs still has to). Naming it here records
    // it at the moment both are known.
    sessionLogPath: sessionLog?.path ?? null,
    park: outcome.evidence?.park ?? null,
    calibrationStatus: outcome.evidence?.calibration_status ?? null,
    reportedAt: new Date().toISOString(),
  })
  try {
    const staging = `${LAUNCH_RECORDING_PATH}.${process.pid}.tmp`
    fs.writeFileSync(staging, `${payload}
`)
    fs.renameSync(staging, LAUNCH_RECORDING_PATH)
  } catch (error) {
    log(`could not write the capture-recording file ${LAUNCH_RECORDING_PATH}: ${error.message}`)
  }
}

/**
 * Hold the tracker until the collector has proved it is capturing.
 *
 * Every ending settles the same promise once and publishes the same file, so
 * a launcher gets an answer whether the collector recorded, died, was never
 * started, or simply took too long. Never throws: a capture that cannot be
 * confirmed costs the fielding half of a game, and refusing to launch the
 * tracker over it would cost the whole game.
 */
let captureAttachedState = null
let captureAttachedResolve = null

function settleCaptureAttached(outcome) {
  if (captureAttachedState) return captureAttachedState
  captureAttachedState = { ...outcome, at: new Date().toISOString() }
  captureAttachedResolve?.(captureAttachedState)
  captureAttachedResolve = null
  return captureAttachedState
}

/**
 * Hold the tracker .exe only until the collector is ATTACHED.
 *
 * Not until it is recording. Recording evidence needs a running game clock and
 * gameplay is held at this point, so waiting for it here would deadlock the
 * hold against the very thing it is holding for. Attachment is everything the
 * collector can establish with the clock stopped, and it is what makes the
 * capture certain to have the opening play once the clock starts again.
 *
 * Never throws, for the same reason the recording wait does not: a capture that
 * cannot be confirmed costs the fielding half of a game, and refusing to start
 * the scoring reader over it would cost the whole game.
 */
async function awaitCaptureAttached(child) {
  if (!PLAYER_TRACKING_ENABLED) {
    return settleCaptureAttached({ ok: false, disabled: true, reason: 'player tracking is disabled' })
  }
  if (!child) return settleCaptureAttached({ ok: false, reason: 'the collector was not started' })
  const settled = new Promise((resolve) => { captureAttachedResolve = resolve })
  const onExit = (code) => settleCaptureAttached({
    ok: false, reason: collectorStartupExitReason(code, 'before it attached'),
  })
  const onError = (error) => settleCaptureAttached({
    ok: false, reason: `the collector could not be started: ${error.message}`,
  })
  // Real ChildProcess emits exit before its stdio closes; test/replay children
  // may expose either event. The settle function is idempotent, so accepting
  // both reports an early death immediately without double handling it.
  child.once('exit', onExit)
  child.once('close', onExit)
  child.once('error', onError)
  const timer = setTimeout(() => settleCaptureAttached({
    ok: false, reason: `the collector did not attach within ${Math.round(CAPTURE_ATTACH_TIMEOUT_MS / 1000)}s`,
  }), CAPTURE_ATTACH_TIMEOUT_MS)
  timer.unref?.()
  log(`waiting for the 60 Hz collector to attach before releasing gameplay `
    + `(up to ${Math.round(CAPTURE_ATTACH_TIMEOUT_MS / 1000)}s)`)
  const outcome = await settled
  clearTimeout(timer)
  child.off?.('exit', onExit)
  child.off?.('close', onExit)
  child.off?.('error', onError)
  if (!outcome.ok) {
    setTrackerPreviewCaptureHealth(previewState, { note: outcome.reason })
  }
  log(outcome.ok
    ? `collector attached (${outcome.evidence?.park || 'park unknown'}); starting the tracker`
    : `WARNING: the collector is NOT attached (${outcome.reason}). Starting the tracker anyway -- `
      + 'the at-bat feed and the database do not depend on it, but this game will have no '
      + 'fielding or baserunning data.')
  return outcome
}

// The tracker .exe's own statement that it is attached to the emulator.
//
// "Dolphin hooked." is its first line; the other two are printed only after it,
// so a reader that is already past its opening line still settles rather than
// waiting out a timeout it has already earned.
const SCORING_READER_ATTACHED_RE = /dolphin hooked|waiting for match to begin|match is starting/i

/**
 * Whether the SCORING reader is up, in the same shape the collector reports.
 *
 * `ready` is the only one that means a play happening now would be recorded.
 * The rest are named separately because what an operator does next differs:
 * `spawn_failed` and `exited` are a tracker that is not running at all,
 * `timeout` is one that is running and has not said it attached, and
 * `cancelled` is this bridge being stopped while it waited.
 */
const SCORING_READER_STATUS = {
  READY: 'ready',
  NOT_STARTED: 'not_started',
  SPAWN_FAILED: 'spawn_failed',
  EXITED: 'exited',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
}

let scoringReaderState = null
let scoringReaderResolve = null
let scoringReaderStartedAt = null

function settleScoringReader(outcome) {
  if (scoringReaderState) return scoringReaderState
  scoringReaderState = {
    ok: outcome.status === SCORING_READER_STATUS.READY,
    reason: null,
    ...outcome,
    waitedMs: scoringReaderStartedAt == null
      ? 0 : Math.round(performance.now() - scoringReaderStartedAt),
    at: new Date().toISOString(),
  }
  scoringReaderResolve?.(scoringReaderState)
  scoringReaderResolve = null
  return scoringReaderState
}

// Called for every tracker line, before anything else looks at it: the
// handshake has to settle on the tracker's own first words whether or not the
// parser makes anything of them.
function noteScoringReaderOutput(message) {
  if (scoringReaderState || !SCORING_READER_ATTACHED_RE.test(String(message || ''))) return
  settleScoringReader({ status: SCORING_READER_STATUS.READY, evidence: String(message).trim() })
}

/** Stop waiting because this bridge is stopping. Never overrides a settled one. */
function cancelScoringReaderWait(
  reason = 'the bridge was stopped while the scoring reader was starting',
) {
  if (!scoringReaderResolve) return null
  return settleScoringReader({ status: SCORING_READER_STATUS.CANCELLED, reason })
}

/**
 * Wait for the scoring reader to say it is attached.
 *
 * Never throws and never refuses to continue: by this point the match is live
 * and held, and an exception here would strand a paused game. It reports what
 * it found instead, and announceReadersReady() puts that in the handshake so
 * the process holding the pause menu acts on the outcome rather than on the
 * file having appeared.
 */
async function awaitScoringReaderReady(child) {
  scoringReaderStartedAt = performance.now()
  if (!child) {
    return settleScoringReader({
      status: SCORING_READER_STATUS.NOT_STARTED,
      reason: 'the tracker executable was never started',
    })
  }
  const settled = new Promise((resolve) => { scoringReaderResolve = resolve })
  // A tracker that dies during startup -- a missing .exe, a bad build, no
  // Dolphin -- must not be waited out. Its exit is the answer.
  const onExit = (code) => settleScoringReader({
    status: SCORING_READER_STATUS.EXITED,
    reason: `the tracker exited with code ${code} before it attached to Dolphin`,
  })
  const onError = (error) => settleScoringReader({
    status: SCORING_READER_STATUS.SPAWN_FAILED,
    reason: `the tracker could not be started: ${error.message}`,
  })
  child.once('exit', onExit)
  child.once('error', onError)
  const timer = setTimeout(() => settleScoringReader({
    status: SCORING_READER_STATUS.TIMEOUT,
    reason: 'the tracker did not report attaching to Dolphin within '
      + `${Math.round(SCORING_READY_TIMEOUT_MS / 1000)}s`,
  }), SCORING_READY_TIMEOUT_MS)
  timer.unref?.()
  log('waiting for the scoring reader to attach before releasing gameplay '
    + `(up to ${Math.round(SCORING_READY_TIMEOUT_MS / 1000)}s)`)
  const outcome = await settled
  clearTimeout(timer)
  child.off?.('exit', onExit)
  child.off?.('error', onError)
  if (outcome.ok) {
    log(`scoring reader attached after ${outcome.waitedMs}ms (${outcome.evidence})`)
  } else if (outcome.status === SCORING_READER_STATUS.TIMEOUT) {
    log(`WARNING: the scoring reader has NOT said it attached (${outcome.reason}). It is still `
      + 'running, so it may attach yet; releasing gameplay rather than leaving the match paused.')
  } else if (outcome.status === SCORING_READER_STATUS.CANCELLED) {
    log(`the scoring reader handshake was cancelled (${outcome.reason}).`)
  } else {
    log(`ERROR: the scoring reader is not running (${outcome.reason}). NOTHING WILL SCORE THIS `
      + 'GAME. Releasing gameplay anyway -- a paused match is not a recovery -- and saying so in '
      + 'the readers handshake so the launcher can report it.')
  }
  previewState.trackerStatus = outcome.ok
    ? 'scoring reader attached'
    : `scoring reader not confirmed: ${outcome.reason}`
  return outcome
}

/**
 * Tell whoever is holding gameplay what actually came up.
 *
 * Written on failure as well as on success, and always: a launcher waiting on
 * this file must never be left holding a live game because a reader did not
 * start. The hold has its own timeout as well, for the case where this process
 * dies before it can write anything.
 *
 * `status` IS THE ANSWER, AND THE FILE EXISTING IS NOT. The previous version
 * wrote `trackerStarted: true` unconditionally, the moment spawn() had
 * returned, so an ENOENT on the tracker .exe still produced a handshake saying
 * both readers were up -- and scripts/mss_autoteam.py, which only checked that
 * the file existed, resumed a live game that nothing was scoring. Both halves
 * are named here and both are read there.
 */
function announceReadersReady(attached, scoring) {
  if (!LAUNCH_READERS_PATH) return null
  const scoringStatus = scoring?.status || SCORING_READER_STATUS.NOT_STARTED
  const scoringRunning = scoringStatus === SCORING_READER_STATUS.READY
    || scoringStatus === SCORING_READER_STATUS.TIMEOUT
  const payload = {
    pid: process.pid,
    gameId: TARGET_GAME_ID,
    readersReadyAt: new Date().toISOString(),
    // 'ready'       -- the scoring reader is attached; a play now is recorded.
    // 'unconfirmed' -- it is running and has not proved it attached.
    // 'failed'      -- it is not running. Nothing will score this game.
    // 'cancelled'   -- this bridge stopped before it could find out.
    status: scoringStatus === SCORING_READER_STATUS.READY ? 'ready'
      : scoringStatus === SCORING_READER_STATUS.TIMEOUT ? 'unconfirmed'
        : scoringStatus === SCORING_READER_STATUS.CANCELLED ? 'cancelled' : 'failed',
    trackerStarted: scoringRunning,
    scoringReader: scoringStatus,
    scoringReason: scoring?.reason || null,
    scoringWaitedMs: scoring?.waitedMs ?? null,
    collectorAttached: Boolean(attached?.ok),
    collectorReason: attached?.ok ? null : (attached?.reason || null),
    collectorDisabled: Boolean(attached?.disabled),
    stem: attached?.evidence?.stem || null,
    park: attached?.evidence?.park || null,
  }
  try {
    const staging = `${LAUNCH_READERS_PATH}.${process.pid}.tmp`
    fs.writeFileSync(staging, `${JSON.stringify(payload)}\n`)
    fs.renameSync(staging, LAUNCH_READERS_PATH)
    log(payload.status === 'ready'
      ? `both readers up; released the hold on gameplay (${LAUNCH_READERS_PATH})`
      : `readers handshake published as "${payload.status}" (scoring reader: ${scoringStatus}); `
        + `released the hold on gameplay (${LAUNCH_READERS_PATH})`)
  } catch (error) {
    log(`could not write the readers-ready file ${LAUNCH_READERS_PATH}: ${error.message}. `
      + 'Whatever is holding gameplay will release on its own timeout.')
  }
  return payload
}

async function awaitCaptureRecording(child) {
  captureRecordingStartedAt.at = performance.now()
  if (!PLAYER_TRACKING_ENABLED) {
    return settleCaptureRecording({
      ok: false,
      disabled: true,
      reason: 'player tracking is disabled (TRACKER_PLAYER_TRACKING=0)',
    })
  }
  if (!child) {
    return settleCaptureRecording({ ok: false, reason: 'the collector was not started' })
  }
  const settled = new Promise((resolve) => { captureRecordingResolve = resolve })
  // A collector that dies during startup -- no dolphin-memory-engine, no
  // running emulator, a bad park -- must not be waited out. Its exit is the
  // answer.
  const onExit = (code) => settleCaptureRecording({
    ok: false, reason: collectorStartupExitReason(code, 'before it captured anything'),
  })
  const onError = (error) => settleCaptureRecording({
    ok: false, reason: `the collector could not be started: ${error.message}`,
  })
  child.once('exit', onExit)
  child.once('close', onExit)
  child.once('error', onError)
  const timer = setTimeout(() => settleCaptureRecording({
    ok: false,
    reason: `no capture evidence after ${Math.round(CAPTURE_READY_TIMEOUT_MS / 1000)}s`,
  }), CAPTURE_READY_TIMEOUT_MS)
  timer.unref?.()
  log(`waiting for the 60 Hz collector to prove it is recording `
    + `(up to ${Math.round(CAPTURE_READY_TIMEOUT_MS / 1000)}s)`)
  const outcome = await settled
  clearTimeout(timer)
  child.off?.('exit', onExit)
  child.off?.('close', onExit)
  child.off?.('error', onError)
  if (outcome.ok) {
    log(`capture confirmed after ${outcome.waitedMs}ms: `
      + `${outcome.evidence.frames} frames, ${outcome.evidence.bytes_on_disk} bytes on disk`)
  } else if (outcome.disabled) {
    log(`60 Hz capture ${outcome.reason} -- launching the tracker without one.`)
  } else {
    log(`WARNING: the 60 Hz capture is NOT confirmed (${outcome.reason}). `
      + 'Launching the tracker anyway -- the at-bat feed and the database do not '
      + 'depend on it, but this game will have no fielding or baserunning data.')
  }
  return outcome
}

function launchPlayerTracking() {
  if (!PLAYER_TRACKING_ENABLED) {
    log('60 Hz player tracking disabled (TRACKER_PLAYER_TRACKING=0)')
    setTrackerPreviewCaptureHealth(previewState, {
      status: 'disabled', note: 'TRACKER_PLAYER_TRACKING=0',
    })
    return null
  }
  // A GAME ROW WITHOUT A STADIUM IS NOT A REASON TO RECORD NOTHING. This used
  // to refuse outright, which cost the whole fielding and baserunning half of a
  // game over a column the collector does not actually need: it reads the
  // game's own stadium byte at 0x811F769D and overrides whatever it is handed,
  // so `auto` is answered first-hand in one read. The row still wins when it
  // has an answer -- that is the source of truth for what gets written to
  // plate_appearances -- and `auto` is only the fallback when it has none.
  const park = TARGET_STADIUM_KEY || 'auto'
  playerTrackingStartupLines = []
  if (!TARGET_STADIUM_KEY) {
    log('the game row names no stadium; the collector will read the park from the game itself')
  }
  fs.mkdirSync(PLAYER_TRACKING_DIR, { recursive: true })
  const prefix = sidecarFilePrefix()
  playerTrackingStopPath = path.join(PLAYER_TRACKING_DIR, `${prefix}.stop`)
  playerTrackingManifestPath = path.join(PLAYER_TRACKING_DIR, `${prefix}.manifest.json`)
  for (const filePath of [playerTrackingStopPath, playerTrackingManifestPath, `${playerTrackingManifestPath}.tmp`]) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch (error) {
      log(`could not clear stale sidecar file ${filePath}:`, error.message)
    }
  }
  const args = [
    path.resolve('scripts/collect_player_tracking.py'),
    '--park', park,
    '--out', PLAYER_TRACKING_DIR,
    '--stop-file', playerTrackingStopPath,
    '--manifest', playerTrackingManifestPath,
    '--game-id', String(TARGET_GAME_ID),
    '--competition-type', trackerSourceType(),
    '--source-id', String(TARGET_SOURCE_ID || ''),
    '--note', `bridge ${trackerSourceType()} game ${TARGET_GAME_ID}`,
    ...collectorEvidenceArgs(env),
  ]
  log(`launching 60 Hz player tracker for ${park}`)
  const child = spawnChild(PLAYER_TRACKING_PYTHON, args, { cwd: process.cwd(), windowsHide: true })
  playerTrackingProcess = child
  setTrackerPreviewCaptureHealth(previewState, {
    status: 'recording',
    collector_pid: child.pid || null,
    park,
    live_path: `${prefix}.live.jsonl`,
  })
  readline.createInterface({ input: child.stdout })
    .on('line', (line) => handlePlayerTrackingLine(line))
  readline.createInterface({ input: child.stderr })
    .on('line', (line) => handlePlayerTrackingLine(line))
  child.on('error', (error) => {
    log('player-tracking sidecar failed to launch:', error.message)
    setTrackerPreviewCaptureHealth(previewState, { status: 'failed', collector_pid: null })
    playerTrackingProcess = null
  })
  child.on('exit', (code) => {
    playerTrackingProcess = null
    setTrackerPreviewCaptureHealth(previewState, {
      status: code === 0 || playerTrackingCaptureFinished() ? 'stopped' : 'failed',
      collector_pid: null,
    })
    // THE MANIFEST DECIDES, NOT THE EXIT CODE. Ctrl-C in a shared Windows
    // console reaches the sidecar as well as this process, and the sidecar
    // catches it, flushes, and writes a complete manifest -- and can still exit
    // non-zero. Returning here threw away a finished capture and, unlike the
    // read-only preview, also skipped the Supabase ingest, so the game kept its
    // at-bats and lost all of its fielding and baserunning.
    // finalizePlayerTrackingCapture throws on its own if the manifest says the
    // capture did not finish, so an unclean exit costs a message, not a game.
    if (code !== 0) {
      log(`player-tracking sidecar exited with code ${code}; `
        + 'finalizing anyway if it left a finished capture')
    }
    playerTrackingFinalization = finalizePlayerTrackingCapture()
      .catch((error) => {
        playerTrackingFinalizationError = error
        log('player-tracking post-processing failed:', error.message)
      })
  })
  return child
}

let livePushDebounce = null
let pendingLiveStateSnapshot = null
function triggerLivePush(stateSnapshot = null) {
  pendingLiveStateSnapshot = stateSnapshot || structuredClone(liveState)
  clearTimeout(livePushDebounce)
  livePushDebounce = setTimeout(() => {
    const durableSnapshot = pendingLiveStateSnapshot
    pendingLiveStateSnapshot = null
    pushState(durableSnapshot).catch((err) => log('live feed sync failed:', err.message))
  }, 500)
}

// Poll rather than watch. chokidar is already a dependency and would do this
// with an event, but the file is written by another process that may have
// written it before this one got here -- so existence has to be checked
// anyway, and once it is, a watcher is the more complicated way to ask the
// same question twice.
// Written before the wait, not after it, and before the early return below:
// the claim is "this bridge finished starting up", which is true either way,
// and a launcher that only learns it when the wait ends learns it too late to
// act on. Written via a temporary file and a rename so a reader can never see
// a half-written one.
function announceLaunchReady() {
  if (!LAUNCH_READY_PATH) return
  const payload = JSON.stringify({
    pid: process.pid,
    gameId: TARGET_GAME_ID,
    gamesTable: TARGET_GAMES_TABLE,
    readyAt: new Date().toISOString(),
  })
  try {
    const staging = `${LAUNCH_READY_PATH}.${process.pid}.tmp`
    fs.writeFileSync(staging, `${payload}
`)
    fs.renameSync(staging, LAUNCH_READY_PATH)
  } catch (error) {
    log(`could not write the launch-ready file ${LAUNCH_READY_PATH}: ${error.message}`)
  }
}

async function waitForLaunchSignal() {
  if (!LAUNCH_SIGNAL_PATH) {
    announceLaunchReady()
    return
  }
  announceLaunchReady()
  if (fs.existsSync(LAUNCH_SIGNAL_PATH)) return
  log(`holding the tracker until the match is live (${LAUNCH_SIGNAL_PATH})`)
  const deadline = Date.now() + LAUNCH_SIGNAL_TIMEOUT_MS
  while (!fs.existsSync(LAUNCH_SIGNAL_PATH)) {
    if (LAUNCH_OWNER_PID && !processExists(LAUNCH_OWNER_PID)) {
      log(`the launcher (pid ${LAUNCH_OWNER_PID}) that was going to report the first `
        + 'pitch is gone, and no signal was written. Stopping rather than launching '
        + 'the tracker against an unknown screen.')
      trackerGameLock?.release()
      process.exit(1)
    }
    if (Date.now() > deadline) {
      // Launching anyway beats not tracking at all: by this point the game
      // is either up and the signal was lost, or it never started and the
      // tracker will sit waiting for a match exactly as it does standalone.
      log(`WARNING: no launch signal after ${Math.round(LAUNCH_SIGNAL_TIMEOUT_MS / 1000)}s. Launching the tracker anyway.`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  log('launch signal received')
}

// Everything a clean stop has to wait for: the serialized play-event chain,
// the live-state publisher, live tracking facts, postgame capture finalization,
// and game completion. Shutdown drains exactly this list, and so does any
// in-process caller that needs to know the game is fully written.
export function pendingTrackerWork() {
  return [playEventChain, pushStateQueue, liveTrackingSync, playerTrackingFinalization, finalizationPromise]
}

// The game lock, the workbook watcher and the preview socket are all released
// by the process exiting. An in-process caller that means to end this bridge
// without ending the process says so here, so the next bridge over the same
// game sees a free lock rather than this pid's.
export function stopTrackerBridge() {
  // A bridge stopped mid-handshake must not leave the launcher waiting on a
  // file that is never going to be written.
  cancelScoringReaderWait('the bridge was stopped before the scoring reader attached')
  // Nor may it write after it has released the game. Both of these are
  // debounces, and a debounce that was already scheduled fires with the lease
  // gone and the game handed on -- which is a write from a bridge that has
  // stopped, arriving at a game somebody else may now own.
  bridgeReleased = true
  clearTimeout(scoreSyncDebounce)
  clearTimeout(bettingSyncDebounce)
  clearTimeout(livePushDebounce)
  trackerGameLock?.release()
  trackerGameLock = null
  // Released rather than left to expire: the next bridge over this game should
  // not have to wait out a TTL for a process that stopped cleanly.
  trackerGameLease?.release().catch(() => {})
  trackerGameLease = null
  const watcher = xlsxWatcher
  xlsxWatcher = null
  previewServer?.close?.()
  return watcher ? watcher.close() : Promise.resolve()
}

function launchTracker() {
  log(`launching tracker: ${EXE_PATH}`)
  const child = spawnChild(EXE_PATH, [], { cwd: path.dirname(EXE_PATH) })
  trackerProcess = child
  child.stdin?.on?.('error', (error) => log('tracker input closed:', error.message))
  previewState.trackerPid = child.pid || null
  previewState.trackerStatus = 'tracker launched; waiting for Dolphin'
  const workbookSyncsAtLaunch = completedWorkbookSyncs
  let shutdownReason = null

  readline.createInterface({ input: child.stdout }).on('line', handleTrackerLogLine)
  readline.createInterface({ input: child.stderr }).on('line', handleTrackerLogLine)

  child.on('exit', (code) => {
    log(`tracker process exited (code ${code}). The final box score should land shortly via the xlsx watcher.`)
    requestPlayerTrackingStop()
    liveState.gameEnded = true
    liveState.oddsCalculating = false
    trackerProcess = null
    previewState.trackerPid = null
    previewState.trackerStatus = `tracker exited with code ${code}`
    if (invokedDirectly && code !== 0 && shutdownReason !== 'game_completed') process.exitCode = 1
    sessionLog?.summary().forEach((line) => log(line))
    enqueuePlayEvent('Changing sides!') // flush any still-buffered plate appearance
    playEventChain.then(() => pushState(structuredClone(liveState)))
      .catch((err) => log('final live feed sync failed:', err.message))
    if (invokedDirectly && AUTO_EXIT_AFTER_GAME) {
      setImmediate(() => shutdown('tracker_exit'))
    }
  })
  child.on('error', (err) => {
    log('failed to launch tracker:', err.message)
    previewState.trackerStatus = `tracker launch failed: ${err.message}`
  })

  const cleanup = () => {
    requestPlayerTrackingStop()
    try { child.kill() } catch { /* already gone */ }
  }
  let shutdownPromise = null
  const shutdown = (reason = 'signal') => {
    if (shutdownPromise) return shutdownPromise
    shutdownReason = reason
    shutdownPromise = (async () => {
      // Ctrl+C during startup: the handshake is answered rather than abandoned,
      // so the readers file says `cancelled` instead of never appearing.
      cancelScoringReaderWait('the bridge was interrupted before the scoring reader attached')
      cleanup()
      const deadline = setTimeout(() => {
        trackerGameLock?.release()
        process.exit(1)
      }, trackerShutdownTimeoutMs(reason))
      if (playerTrackingProcess) await new Promise((resolve) => playerTrackingProcess.once('exit', resolve))
      // Exit handlers enqueue the last buffered PA and start postgame ingestion.
      // Yield once so both promises exist, then drain every in-flight write.
      await new Promise((resolve) => setImmediate(resolve))
      let shutdownError = null
      try {
        // A tracker exit is the normal end of `npm run game`. Give the polling
        // workbook watcher a bounded chance to publish the final XLSX, then make
        // game completion explicit before taking the final snapshot of pending
        // work. The 60 Hz derivation/ingest above normally provides more than
        // enough time, but neither correctness nor process lifetime should rest
        // on that timing accident.
        if (reason === 'tracker_exit' || reason === 'game_completed') {
          const workbookBaseline = finalScoreWorkbookSyncBaseline ?? workbookSyncsAtLaunch
          const workbookDeadline = Date.now() + 5000
          while (completedWorkbookSyncs <= workbookBaseline && Date.now() < workbookDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          await xlsxSyncQueue
          if (lastXlsxSyncError) throw lastXlsxSyncError
          if (completedWorkbookSyncs <= workbookBaseline) {
            throw new Error('the final tracker workbook was not detected or published')
          }
          await playEventChain
          await syncScoreFromTracker()
          if (!finalizationPromise) {
            throw new Error('the final score was not available, so the game could not be finalized')
          }
        }
      } catch (error) {
        shutdownError = error
        log('shutdown final-score check failed:', error.message)
      }
      // Derivation and ingestion still have to finish when the workbook check
      // or a game-completion write fails. Keeping this outside the check above
      // prevents process.exit() from killing postgame work in progress.
      try {
        await drainTrackerWork(pendingTrackerWork(), { requiredFailure: () => requiredPersistenceFailure })
        if (playerTrackingFinalizationError) throw playerTrackingFinalizationError
      } catch (error) {
        shutdownError ||= error
        log('shutdown could not drain all tracker writes:', error.message)
      }
      clearTimeout(deadline)
      trackerGameLock?.release()
      await trackerGameLease?.release().catch(() => {})
      if (shutdownError) process.exitCode = 1
      if (reason === 'tracker_exit' || reason === 'game_completed') {
        log(shutdownError
          ? 'postgame workflow finished with errors; see the messages above'
          : 'postgame workflow complete: box score published, tracking ingested, game finalized')
      }
      process.exit()
    })()
    return shutdownPromise
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  requestManualStop = () => shutdown('manual_stop')
  requestCompletedGameStop = () => shutdown('game_completed')

  return child
}

// `deps` is the seam an in-process caller uses; a normal run passes nothing
// and everything below resolves to the real client, the real spawn, and the
// real sign-in.
export async function main(deps = {}) {
  spawnChild = deps.spawn || spawn
  if (PLAYER_TRACKING_ENABLED && !deps.supabase) {
    // Check imports before AutoTeam touches the emulator. A missing collector
    // dependency used to surface only after the first pitch, when fielding for
    // that game could no longer be recovered.
    const check = spawnSync(PLAYER_TRACKING_PYTHON,
      ['-c', 'import numpy, dolphin_memory_engine, collect_player_tracking'], {
        cwd: path.resolve('scripts'),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      })
    if (check.error || check.status !== 0) {
      const detail = check.error?.message || check.stderr?.trim() || `exit code ${check.status}`
      throw new Error(`60 Hz collector Python is not ready (${PLAYER_TRACKING_PYTHON}): ${detail}. `
        + 'Set TRACKER_PLAYER_PYTHON to a Python with numpy and dolphin-memory-engine installed.')
    }
    // Same gate as the preview: a comprehensive capture without its session
    // metadata is refused here rather than after the first pitch.
    assertEvidenceProfileReady({ ...env, TRACKER_PLAYER_PYTHON: PLAYER_TRACKING_PYTHON })
  }
  if (deps.supabase) {
    // An injected client is already authorized — there is no credential to
    // exchange and no endpoint to reach. Everything after this point is the
    // same code path a signed-in run takes.
    supabase = deps.supabase
  } else {
    requireBridgeEnvironment()
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    log(`signing in as ${BRIDGE_EMAIL}`)
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: BRIDGE_EMAIL, password: BRIDGE_PASSWORD,
    })
    if (authError) throw new Error(`Sign-in failed: ${authError.message}`)
  }

  TARGET_GAME_ID = await resolveTargetGame()
  log(`syncing into game_id=${TARGET_GAME_ID}`)
  trackerGameLock = acquireTrackerGameLock({
    competitionType: trackerSourceType(),
    gameId: TARGET_GAME_ID,
    // Named only by an in-process caller, so a harness cannot take (or leave
    // behind) the lock a real launcher reads out of the system temp directory.
    ...(deps.lockDirectory ? { directory: deps.lockDirectory } : {}),
  })
  process.once('exit', () => trackerGameLock?.release())

  // Both halves of ownership, in order. The local lock is what refuses a
  // second bridge in this temp directory and is what scripts/mss_autogame.mjs
  // reads; the lease is what refuses one on another machine. A database
  // without the lease functions says so and the local lock carries on alone --
  // see scripts/tracker_game_lease.mjs for why that degrades rather than
  // refuses.
  trackerGameLease = createTrackerGameLease({
    supabase,
    competitionType: trackerSourceType(),
    gameId: TARGET_GAME_ID,
    ttlSeconds: Number(env.TRACKER_LEASE_TTL_SECONDS) || undefined,
    label: `bridge ${trackerSourceType()} game ${TARGET_GAME_ID}`,
    log: (...args) => log(...args),
  })
  const leaseTakeover = ['1', 'true', 'yes'].includes(
    String(env.TRACKER_LEASE_TAKEOVER ?? '').trim().toLowerCase())
  const leaseClaim = await trackerGameLease.acquire({ takeover: leaseTakeover })
  if (!leaseClaim.granted) {
    trackerGameLock?.release()
    throw new Error(
      `${leaseClaim.lease?.owner_id || 'another tracker'} already holds `
      + `${trackerSourceType()} game ${TARGET_GAME_ID} (until ${leaseClaim.lease?.expires_at}). `
      + 'Nothing has been written. If that bridge is genuinely gone, wait for the lease to '
      + 'expire or re-run with TRACKER_LEASE_TAKEOVER=1.',
    )
  }
  trackerGameLease.startRenewing({
    onLost: (reason) => {
      // Not fatal here, deliberately: the game is being played and killing the
      // bridge mid-inning would lose the innings still in its buffers. The
      // database refuses its writes from this point (the epoch moved), so the
      // failure surfaces at the next required write instead of being silent.
      log(`LOST the database game lease: ${reason}. EVERY write from this process is now `
        + 'refused -- scoring, live state, game completion, unresolved plays and postgame '
        + 'ingestion alike -- by this process before it reaches the database. Stop this '
        + 'bridge and let the new owner finish the game.')
      // Nothing here can be renewed back into ownership: renewal refuses on
      // purpose. Stopping the timer keeps the log from repeating the loss
      // every 25 seconds for the rest of the game.
      trackerGameLease?.stopRenewing()
    },
  })
  process.once('exit', () => trackerGameLease?.stopRenewing())

  scoringPersistence = createTrackerScoringPersistence({
    supabase,
    tables: GAME_TABLES,
    competitionType: trackerSourceType(),
    seasonId: TARGET_SEASON_ID,
    gameId: TARGET_GAME_ID,
    journalPath: path.join(BRIDGE_STATE_DIR, `${trackerSourceType()}-${TARGET_GAME_ID}.json`),
    // leaseWriteCredentials, not trackerGameLease.writeCredentials: the lease
    // object is nulled when the bridge stops, and a write arriving after that
    // has to be REFUSED by the database with a reason -- not crash on a null
    // with a message that names neither the game nor the write.
    leaseCredentials: (what) => leaseWriteCredentials(what),
    log: (...args) => log(...args),
  })
  // BEFORE THE GAME STARTS, NOT ON THE FIRST AT-BAT. A database missing the
  // columns this writer reconciles by cannot be tracked into, and the previous
  // version discovered that at the first plate appearance -- reported as a
  // fallback that then failed on every write. Asked once, here, while nothing
  // has been played.
  const schema = await scoringPersistence.assertSchemaSupported()
  if (schema.degraded.length) {
    log(`tracking this game with ${schema.degraded.length} degraded guarantee(s); see above.`)
  }
  const recoveredEvents = await scoringPersistence.recoverPending()
  if (recoveredEvents.length) log(`recovered ${recoveredEvents.length} incomplete scoring event(s) before tracker launch`)
  if (['0', 'false', 'no'].includes(String(env.TRACKER_LIVE_TRACKING ?? '').trim().toLowerCase())) {
    log('live tracking facts are off (TRACKER_LIVE_TRACKING); movement and fielding rows arrive with the postgame ingest')
  } else {
    liveTrackingPersistence = createLiveTrackingPersistence({
      supabase,
      competitionType: trackerSourceType(),
      gameId: TARGET_GAME_ID,
      sourceId: TARGET_SOURCE_ID,
      log: (...args) => log(...args),
    })
  }
  openSessionLog()
  // Up as early as the target is known, well before the tracker launches, so
  // the scorebook's live tracker tab shows "connected, waiting for an at-bat"
  // instead of a connection error for the whole of pregame setup.
  publishPreviewGameContext()
  startPreviewServer()
  log(sessionLog
    ? `session log (kept, not overwritten): ${sessionLog.path}`
    : 'session log DISABLED — ball trajectories from this game will not be archivable')
  scoreState.a = Number(isSeasonGame() ? TARGET_GAME_ROW?.away_score : TARGET_GAME_ROW?.team_a_runs) || 0
  scoreState.b = Number(isSeasonGame() ? TARGET_GAME_ROW?.home_score : TARGET_GAME_ROW?.team_b_runs) || 0

  const [
    { data: existingTrackerStats, error: existingTrackerError },
    { count: existingPaCount, error: existingPaCountError },
  ] = await Promise.all([
    supabase.from(TARGET_STATS_TABLE)
      .select('team_mapping,live_feed').eq('game_id', TARGET_GAME_ID).maybeSingle(),
    supabase.from(GAME_TABLES.plateAppearances)
      .select('id', { count: 'exact', head: true }).eq('game_id', TARGET_GAME_ID),
  ])
  if (existingTrackerError) throw existingTrackerError
  if (existingPaCountError) throw existingPaCountError
  trackerTeamMapping = { ...(existingTrackerStats?.team_mapping || {}) }
  Object.entries(trackerTeamMapping).forEach(([name, side]) => {
    if (side === 'A' || side === 'B') trackerTeamSideByName.set(name, side)
  })
  const previousLiveFeed = existingTrackerStats?.live_feed && typeof existingTrackerStats.live_feed === 'object'
    ? existingTrackerStats.live_feed
    : {}
  if (shouldStartFreshTrackerSession(TARGET_GAME_ROW, existingPaCount)) {
    resetInMemoryTrackerGame({ reason: 'pristine game row at bridge startup' })
  } else {
    // Attaching to a game that already has plate appearances against it. It
    // began before this process existed, so its own lineup is authoritative
    // and must not be re-seeded from the site row.
    if (existingPaCount > 0) markTrackerGameBegun('game already has plate appearances')
    Object.assign(liveState, previousLiveFeed, {
      score: { ...(previousLiveFeed.score || {}) },
      scoreBySide: { ...(previousLiveFeed.scoreBySide || {}) },
      events: [...(previousLiveFeed.events || [])],
      gameEnded: false,
      // A previous bridge process may have exited during a calculation. Never
      // carry that stale UI lock into a newly started tracker session.
      oddsCalculating: false,
    })
    trackerInningFeedDetected = previousLiveFeed.inningStateSource === 'tracker'
      || (previousLiveFeed.events || []).some((event) => parseTrackerInningStateMessage(event?.message))
  }
  setLiveScoreForSide('A', scoreState.a, { syncGame: false })
  setLiveScoreForSide('B', scoreState.b, { syncGame: false })

  await loadRosterAndCharacters()
  log(`loaded roster: ${Object.keys(rosterPlayerIdByCharacterName).length} characters resolved to a team`)

  if (XLSX_PATH && fs.existsSync(XLSX_PATH)) {
    await readWithRetry(() => syncXlsx(XLSX_PATH))
      .catch((err) => log('initial completed-workbook sync failed:', err.message))
  }
  await pushState().catch((err) => log('initial live-state repair failed:', err.message))
  if (path.resolve(EXE_PATH) === path.resolve(STOCK_TRACKER_PATH)) {
    log('WARNING: using the stock tracker executable; full lineups/fielding will only sync from the completed workbook. ' +
      'Run scripts/patch_tracker_lineup_feed.py or set TRACKER_EXE_PATH to the lineup-feed-enabled build for live alignment sync.')
  }
  await waitForLaunchSignal()
  // No tracker workbook can be written before the live-game handoff. Keep
  // polling off the machine while AutoTeam is driving frame-sensitive menus,
  // then attach before starting either game reader.
  watchXlsx()
  // THE ORDER THAT ACTUALLY PROTECTS THE OPENING PLAY.
  //
  // Both readers are started as early as possible and gameplay is held while
  // they come up -- by autoteam, which owns the controller ports; this process
  // owns neither the emulator nor the game clock and never could hold anything.
  // The previous order made the SCORING reader wait out up to 30 s of capture
  // evidence on a match that was already live, which is a delay to the reader
  // rather than a protection of the play.
  //
  // The recording wait still runs, and still publishes its evidence file; it
  // just no longer gates anything, because it cannot be satisfied while the
  // game is held.
  const collector = launchPlayerTracking()
  const recordingEvidence = awaitCaptureRecording(collector)
  const attached = await awaitCaptureAttached(collector)
  const trackerChild = launchTracker()
  // BOTH READERS ARE ASKED THE SAME QUESTION NOW. The collector proves it
  // attached before the tracker is started; the tracker proves the same thing
  // before the hold on gameplay is released. Only when something is holding a
  // game: a standalone bridge has nobody waiting on the answer, and delaying
  // its startup by up to half a minute to publish a file nothing reads would
  // be a cost with no guarantee attached to it.
  if (LAUNCH_READERS_PATH) announceReadersReady(attached, await awaitScoringReaderReady(trackerChild))
  recordingEvidence.catch((error) => log('capture evidence wait failed:', error.message))
  // Stadium and team ids can be settled by the pregame work above; republish so
  // the page is not left holding whatever was known at sign-in.
  publishPreviewGameContext()

  log('live feed + box score watcher running. Ctrl+C to stop.')
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) main().catch((err) => {
  console.error(err.message)
  // Not process.exit(1). A startup failure happens right after the Supabase
  // client has been used, and exiting into undici's still-closing sockets
  // aborts node on Windows with a libuv assertion and exit code 0xC0000409 --
  // which scripts/mss_autogame.mjs would then report as the bridge's own exit
  // code, and which is neither 0 nor 1 to anything else reading it.
  process.exitCode = 1
  const bail = setTimeout(() => process.exit(1), 2000)
  bail.unref?.()
})
