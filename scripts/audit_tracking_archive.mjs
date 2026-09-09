// What the 60 Hz archive is missing, per session.
//
//   node scripts/audit_tracking_archive.mjs
//   node scripts/audit_tracking_archive.mjs --json
//   node scripts/audit_tracking_archive.mjs --join           (slower; joins every paired session)
//   node scripts/audit_tracking_archive.mjs --session <stem> --join
//
// WHY THIS EXISTS. Three facts decide whether a recorded game can be used for
// anything, and all three were established by hand, one session at a time, in
// docs/tracker-reliability-review-2026-09-05.md:
//
//   * Is there a saved tracker log beside the capture? Without one the plays
//     cannot be joined to plate appearances, so the session contributes to no
//     metric that needs the batter -- Catch Probability included. Wario
//     Stadium's only capture has no paired log, which is why it is the first
//     priority for the next recorded game.
//   * Is the capture complete? Three sessions in this archive have no final
//     `frames`, `duration_seconds` or `missed_frames`, because the collector
//     did not write its footer. Their surviving plays are usable and they make
//     no claim about frames after the last recoverable one.
//   * Was the session derived at all? The counts every calibration report
//     reads come from `.plays.jsonl`, which only derive_player_metrics.py
//     writes -- so an underived capture is silently absent from every number.
//
// This reads the archive and answers all three, and with --join it also
// replays each paired log through the real preview state machine and reports
// how many plays actually joined. It writes nothing and touches no database.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  applyTrackerPreviewMessage,
  applyTrackerPreviewPlay,
  createTrackerPreviewState,
  trackerPreviewSnapshot,
} from './tracker_preview_state.mjs'

const TRACKING_DIR = path.resolve('data/player_tracking')
const SESSION_LOG_DIR = path.resolve('sluggers-stat-tracker-advanced-stats-dev/preview-sessions')

// The collector starts after the tracker in every recorded pairing, and the
// acceptance fixtures put the gap at ~35 s. Two minutes is generous enough to
// survive a slow stadium load and tight enough that two games recorded in one
// sitting cannot claim each other's log.
const PAIRING_WINDOW_MS = 120_000

// A capture footer the collector writes at a clean stop. Missing means the
// process did not get to write it -- the surviving frames are still readable.
const FOOTER_FIELDS = ['frames', 'duration_seconds', 'missed_frames']

// The tracker executable's own line shape, exactly as
// scripts/live_tracker_bridge.mjs reads it: "13:46:45 [INFO] message". A
// regex that assumed the session-log header's bracket form instead matched
// nothing, so every line reached the parser with its timestamp and level
// still attached and almost nothing was recognised.
const LOG_LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.*)$/

function parseArgs(argv) {
  const args = { json: false, join: false, session: null }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--json') args.json = true
    else if (flag === '--join') args.join = true
    else if (flag === '--session') args.session = argv[++index]
    else if (flag === '--help' || flag === '-h') args.help = true
  }
  return args
}

function captureStamp(name) {
  const match = String(name).match(/-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!match) return null
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`)
}

/** Every saved tracker log, with the UTC instant its own first line names. */
export function readSessionLogIndex(directory = SESSION_LOG_DIR) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory).filter((name) => name.endsWith('.log')).map((name) => {
    const filePath = path.join(directory, name)
    let startedAt = null
    try {
      const handle = fs.openSync(filePath, 'r')
      const buffer = Buffer.alloc(512)
      const read = fs.readSync(handle, buffer, 0, 512, 0)
      fs.closeSync(handle)
      const header = buffer.slice(0, read).toString('utf8').split('\n')[0]
      startedAt = Date.parse(header.match(/session started (\S+)/)?.[1] || '') || null
    } catch { /* unreadable: reported as unpaired rather than crashing the audit */ }
    return { name, path: filePath, startedAt, size: fs.statSync(filePath).size }
  })
}

export function listCaptures(directory = TRACKING_DIR) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.calibration.json')
      && !name.endsWith('.manifest.json'))
    .map((name) => path.join(directory, name.replace(/\.json$/, '')))
    .sort()
}

function readHeader(stem) {
  try {
    return JSON.parse(fs.readFileSync(`${stem}.json`, 'utf8'))
  } catch (error) {
    return { _unreadable: error.message }
  }
}

function countLines(filePath) {
  if (!fs.existsSync(filePath)) return null
  let count = 0
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) if (line.trim()) count += 1
  return count
}

/**
 * Replay one saved tracker log and its derived plays through the real preview
 * state, and report what joined.
 *
 * This is the same code path the validation console runs, deliberately: an
 * audit that re-implemented the join would be measuring its own copy of it.
 */
export function joinPairedSession(stem, logPath) {
  const state = createTrackerPreviewState({ mode: 'archive_audit', writesEnabled: false })
  for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // The first line of a saved session log is the harness header the writer
    // prepends ("[tracker-preview] session started ..."); the tracker never
    // emits it and feeding it to the parser is feeding it something no real
    // run produces.
    if (trimmed.startsWith('[tracker-preview]') || trimmed.startsWith('[tracker-bridge]')) continue
    const match = trimmed.match(LOG_LINE_RE)
    const message = match ? match[3] : trimmed
    // The 60 Hz ball samples are the flight archive's input and are not
    // messages the parser wants; the bridge drops them here too.
    if (message.startsWith('[TRACKER_BALL_SAMPLE] ')) continue
    applyTrackerPreviewMessage(state, message)
  }
  let plays = 0
  for (const line of fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').split('\n')) {
    if (!line.trim()) continue
    applyTrackerPreviewPlay(state, JSON.parse(line))
    plays += 1
  }
  const snapshot = trackerPreviewSnapshot(state)
  const statuses = {}
  for (const play of snapshot.player_tracking_plays || []) {
    const status = play.join_status || 'unknown'
    statuses[status] = (statuses[status] || 0) + 1
  }
  return {
    plays,
    at_bats: (snapshot.at_bats || []).length,
    statuses,
    joined: statuses.joined || 0,
    warnings: (snapshot.warnings || []).length,
  }
}

export function auditArchive({
  trackingDir = TRACKING_DIR,
  logDir = SESSION_LOG_DIR,
  join = false,
  session = null,
} = {}) {
  const logs = readSessionLogIndex(logDir)
  const used = new Set()
  const stems = listCaptures(trackingDir)
    .filter((stem) => !session || stem.endsWith(session) || path.basename(stem) === path.basename(session))
  const sessions = stems.map((stem) => {
    const header = readHeader(stem)
    const stamp = captureStamp(path.basename(stem))
    // Nearest saved log that started BEFORE the capture: the tracker is always
    // started first, so a log stamped after the capture belongs to a later game.
    const paired = logs
      .filter((log) => log.startedAt != null && stamp != null
        && log.startedAt <= stamp && stamp - log.startedAt <= PAIRING_WINDOW_MS)
      .sort((left, right) => right.startedAt - left.startedAt)[0] || null
    if (paired) used.add(paired.name)
    const missingFooter = FOOTER_FIELDS.filter((field) => header[field] == null)
    const row = {
      stem: path.basename(stem),
      park: header.park || null,
      stadium_byte: header.stadium_byte ?? null,
      recorded_utc: header.recorded_utc || null,
      // Only sessions recorded from 2026-09-02 carry these at all, so "unknown"
      // is a real third answer and not a synonym for day.
      day_night_bytes: header.day_night_bytes ?? null,
      is_night: header.is_night ?? null,
      game_id: header.game_id ?? null,
      competition_type: header.competition_type ?? null,
      raw_present: fs.existsSync(`${stem}.bin`),
      derived_plays: countLines(`${stem}.plays.jsonl`),
      live_plays: countLines(`${stem}.live.jsonl`),
      calibration_present: fs.existsSync(`${stem}.calibration.json`),
      frames: header.frames ?? null,
      missed_frames: header.missed_frames ?? null,
      duration_seconds: header.duration_seconds ?? null,
      incomplete_footer: missingFooter,
      paired_log: paired?.name || null,
      paired_gap_seconds: paired && stamp != null ? (stamp - paired.startedAt) / 1000 : null,
      problems: [],
    }
    if (header._unreadable) row.problems.push(`header unreadable: ${header._unreadable}`)
    if (!row.raw_present) row.problems.push('no .bin: the frames are gone; only the derived plays remain')
    if (row.derived_plays == null) {
      row.problems.push('never derived: run scripts/derive_player_metrics.py, or this session '
        + 'is absent from every calibration count')
    } else if (row.derived_plays === 0) {
      row.problems.push('derived to zero plays')
    }
    if (missingFooter.length) {
      row.problems.push(`incomplete capture footer (${missingFooter.join(', ')}): the surviving `
        + 'plays are usable and say nothing about frames after the last recoverable one')
    }
    if (!paired) {
      row.problems.push('no paired tracker log: nothing can join these plays to plate '
        + 'appearances, so this session contributes to no metric that needs the batter')
    }
    if (join && paired && row.derived_plays) {
      try {
        row.join = joinPairedSession(stem, paired.path)
        const unjoined = row.join.plays - row.join.joined
        if (unjoined > 0) row.problems.push(`${unjoined} of ${row.join.plays} plays did not join`)
      } catch (error) {
        row.join = { error: error.message }
        row.problems.push(`join failed: ${error.message}`)
      }
    }
    return row
  })

  return {
    generatedAt: new Date().toISOString(),
    trackingDir,
    logDir,
    sessions,
    unpairedLogs: logs.filter((log) => !used.has(log.name) && log.size > 0)
      .map((log) => ({ name: log.name, startedAt: log.startedAt, size: log.size })),
    totals: {
      sessions: sessions.length,
      derived: sessions.filter((row) => row.derived_plays).length,
      paired: sessions.filter((row) => row.paired_log).length,
      incompleteFooters: sessions.filter((row) => row.incomplete_footer.length).length,
      withProblems: sessions.filter((row) => row.problems.length).length,
      plays: sessions.reduce((sum, row) => sum + (row.derived_plays || 0), 0),
      joinedPlays: sessions.reduce((sum, row) => sum + (row.join?.joined || 0), 0),
    },
  }
}

function report(audit) {
  const { totals } = audit
  console.log(`60 Hz archive: ${totals.sessions} sessions, ${totals.plays} derived plays`)
  console.log(`  ${totals.paired}/${totals.sessions} have a paired tracker log`)
  console.log(`  ${totals.derived}/${totals.sessions} have been derived`)
  console.log(`  ${totals.incompleteFooters} have an incomplete capture footer`)
  console.log()
  for (const row of audit.sessions) {
    const flags = [
      row.derived_plays == null ? 'UNDERIVED' : `${row.derived_plays} plays`,
      row.paired_log ? 'paired' : 'NO LOG',
      row.incomplete_footer.length ? 'NO FOOTER' : null,
      row.join ? `${row.join.joined}/${row.join.plays} joined` : null,
    ].filter(Boolean).join(', ')
    console.log(`${row.problems.length ? 'X ' : 'ok'} ${row.stem.padEnd(40)} ${flags}`)
    for (const problem of row.problems) console.log(`      - ${problem}`)
  }
  if (audit.unpairedLogs.length) {
    console.log()
    console.log(`${audit.unpairedLogs.length} saved tracker log(s) have no capture beside them:`)
    for (const log of audit.unpairedLogs.slice(0, 20)) console.log(`      ${log.name}`)
    if (audit.unpairedLogs.length > 20) console.log(`      ... and ${audit.unpairedLogs.length - 20} more`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node scripts/audit_tracking_archive.mjs [--join] [--session <stem>] [--json]')
    return 0
  }
  const audit = auditArchive({ join: args.join, session: args.session })
  if (args.json) console.log(JSON.stringify(audit, null, 2))
  else report(audit)
  return audit.totals.withProblems ? 1 : 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main()
}
