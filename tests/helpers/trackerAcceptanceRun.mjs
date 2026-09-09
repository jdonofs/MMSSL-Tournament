// One complete game, start to finish, through the real pipeline.
//
//   saved tracker log  -> the real bridge (parsing, automatic scoring)
//                      -> the real scoring persistence (journal + database)
//                      -> the real odds sync and the real settlement
//   saved 60 Hz capture -> the real postgame ingestion
//
// Everything in that chain is production code. This file only supplies the
// database, the child process, and the clock the replay has to yield to.

import { ingestPlayerTrackingSession } from '../../scripts/ingest_player_tracking.mjs'
import { GAME_ID, RECORDINGS, SOURCE_ID } from './trackerAcceptanceWorld.mjs'
import {
  endTrackerProcess,
  feedLines,
  makeRunDirectory,
  readTrackerLogLines,
  shutdownBridge,
  startBridge,
  waitForBridge,
} from './trackerBridgeReplay.mjs'

export const GAME_TABLE = { tournament: 'games', season: 'season_schedule' }

export const SCORING_TABLES = {
  tournament: {
    game: 'games', pas: 'plate_appearances', pitches: 'pitches', runs: 'runs_scored',
    stints: 'pitching_stints', fielders: 'game_fielders', lineups: 'lineups',
    odds: 'game_odds', bets: 'bets', ledger: 'points_ledger', ledgerChange: 'points_change',
    live: 'tracker_live_stats',
  },
  season: {
    game: 'season_schedule', pas: 'season_plate_appearances', pitches: 'season_pitches',
    runs: 'season_runs_scored', stints: 'season_pitching_stints', fielders: 'season_game_fielders',
    lineups: 'season_lineups', odds: 'season_game_odds', bets: 'season_bets',
    ledger: 'season_betting_ledger', ledgerChange: 'dollars_change', live: 'season_tracker_live_stats',
  },
}

const COMPLETE_STATUS = { tournament: 'complete', season: 'completed' }

/**
 * Replay one recording into `world`.
 *
 * `pauseAtFraction` stops the feed once, long enough for the bridge's own
 * debounced live-odds pass to run. In a real game that pass happens in the
 * seconds between at-bats; a replay that never yields would prove only that
 * the market code is never reached.
 */
export async function replayRecording(world, competitionType, {
  pauseAtFraction = 0.45,
  pauseAtLine = null,
  pauseMs = 1400,
  chunk = 1000,
  failures = null,
  stopBeforeFinish = false,
  onPaused = null,
  // A restart keeps the run directory (and therefore the journal) and picks
  // the log up where the previous process stopped.
  directory: existingDirectory = null,
  fromLine = 0,
  toLine = null,
  replayLines = null,
  completionTimeoutMs = 90_000,
} = {}) {
  const recording = RECORDINGS[competitionType]
  const tables = SCORING_TABLES[competitionType]
  const directory = existingDirectory || makeRunDirectory()
  const allLines = readTrackerLogLines(recording.trackerLog)
  const lines = allLines.slice(fromLine, toLine == null ? allLines.length : toLine)
  const messages = []
  const originalLog = console.log
  console.log = (...args) => { messages.push(args.join(' ')) }
  let handle = null
  try {
    handle = await startBridge({
      supabase: world,
      directory,
      gameId: GAME_ID,
      gamesTable: GAME_TABLE[competitionType],
      quiet: false,
    })
    const { bridge, child } = handle
    const pauseIndex = pauseAtLine == null ? Math.floor(lines.length * pauseAtFraction) : pauseAtLine
    await feedLines(child, lines.slice(0, pauseIndex), { chunk })
    await new Promise((resolve) => setTimeout(resolve, pauseMs))
    await Promise.allSettled(bridge.pendingTrackerWork().filter(Boolean))
    const atPause = {
      odds: (world.db[tables.odds] || []).length,
      plateAppearances: (world.db[tables.pas] || []).length,
      gameStatus: world.db[tables.game][0].status,
    }
    onPaused?.(atPause, { bridge, world, messages })
    // A redelivery of lines the bridge has already parsed, through the same
    // readline it read them from the first time. The block belongs inside the
    // part already fed, and is re-sent while the game is still in progress:
    // that is what a repeated console buffer looks like, as opposed to a stale
    // block arriving after the final score, which is time travel rather than
    // duplication.
    if (replayLines) {
      await feedLines(child, allLines.slice(replayLines[0], replayLines[1]), { chunk })
      await Promise.allSettled(bridge.pendingTrackerWork().filter(Boolean))
    }
    if (failures) world.failures.push(...failures.map((rule) => ({ remaining: rule.times ?? 1, ...rule })))
    await feedLines(child, lines.slice(pauseIndex), { chunk })
    if (stopBeforeFinish) {
      await Promise.allSettled(bridge.pendingTrackerWork().filter(Boolean))
      return { world, directory, messages, atPause, lines, finished: false, bridge }
    }
    await endTrackerProcess(bridge, child)
    let completed = true
    try {
      await waitForBridge(
        bridge,
        `${competitionType} game completion`,
        () => world.db[tables.game][0].status === COMPLETE_STATUS[competitionType],
        { timeoutMs: completionTimeoutMs },
      )
    } catch {
      completed = false
    }
    return { world, directory, messages, atPause, lines, finished: completed, bridge }
  } finally {
    console.log = originalLog
    if (handle) await shutdownBridge(handle.bridge)
  }
}

/** The recorded 60 Hz capture, through the real postgame ingestion. */
export async function ingestRecording(world, competitionType, options = {}) {
  const recording = RECORDINGS[competitionType]
  const warnings = []
  const summary = await ingestPlayerTrackingSession(world, {
    session: recording.capture,
    gameId: GAME_ID,
    competitionType,
    sourceId: SOURCE_ID,
    // Model refitting reads the whole tracking corpus and is a separate,
    // separately-authorized step; the acceptance pass is about the raw facts
    // reaching the database once. The prior Catch Probability / OAA decision
    // ("Baseline required") is untouched by this suite.
    recompute: false,
    warn: (...args) => warnings.push(args.join(' ')),
    ...options,
  })
  return { summary, warnings }
}

export function problemMessages(messages) {
  return messages.filter((line) => /error|failed|could not|WARNING/i.test(line))
}
