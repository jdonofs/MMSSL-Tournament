// The durable record of a tracker session's raw console output.
//
// Terminal scrollback is finite and gets lost once it fills up mid-session --
// this file is what lets a session be traced after the fact without having kept
// the console open. More importantly it is the ONLY input to the flight
// pipeline: scripts/ball_trajectories.mjs reads TRACKER_BALL_SAMPLE and
// TRACKER_BATTED_BALL_PROVISIONAL records straight out of these files, and
// scripts/distill_flights.mjs folds them into data/flight_archive.jsonl.gz.
// A session that runs without one produces no archivable flights at all.
//
// Both tracker processes write one: scripts/tracker_at_bat_preview.mjs and
// scripts/live_tracker_bridge.mjs. Shared because the flight archive cannot
// tell them apart and must not have to -- findLogs() sweeps every *.log under
// the tracker directory, so the two only differ by filename prefix, which is
// there for the human deciding which session was which.
//
// ONE FILE PER SESSION, never truncated. It used to be a single
// preview-session.log rewritten on every launch, which was fine while the log
// was only a debugging aid. It stopped being fine once the log became the only
// place TRACKER_STADIUM is recorded: relaunching silently destroyed the park
// attribution for everything played before it, and unlabelled trajectories
// cannot be labelled after the fact.
//
// These accumulate on purpose. distill_flights.mjs is what bounds the size --
// it folds every flight into the archive at about 4% of the raw bytes, after
// which this directory can be emptied.
import fs from 'node:fs'
import path from 'node:path'

// Fixed rather than derived from the executable's own directory. The flight
// pipeline scans this tree and only this tree, so a bridge pointed at a
// tracker build living somewhere else must still log in here or its flights
// are invisible to the archive.
export const TRACKER_SESSION_LOG_DIR = path.resolve(
  'sluggers-stat-tracker-advanced-stats-dev/preview-sessions',
)

const BALL_SAMPLE_MARKER = 'TRACKER_BALL_SAMPLE]'
const CONTACT_MARKER = 'TRACKER_BATTED_BALL_PROVISIONAL]'

// Local time, and filename-safe: these get read by a human deciding which
// session was which, and an ISO string with colons is not a legal Windows path.
function stampFor(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-')
    + '_' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('-')
}

// Two launches inside the same second would otherwise land on one filename and
// truncate it -- which is the exact failure this rotation exists to remove, so
// it is not left to luck.
function availablePath(dir, prefix, stamp) {
  const base = path.join(dir, `${prefix}-${stamp}`)
  if (!fs.existsSync(`${base}.log`)) return `${base}.log`
  for (let n = 2; ; n += 1) {
    if (!fs.existsSync(`${base}-${n}.log`)) return `${base}-${n}.log`
  }
}

export function createTrackerSessionLog({
  dir = TRACKER_SESSION_LOG_DIR,
  prefix = 'preview',
  header = '',
  startedAt = new Date(),
} = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = availablePath(dir, prefix, stampFor(startedAt))
  fs.writeFileSync(filePath, header ? `${header}\n` : '')
  const stream = fs.createWriteStream(filePath, { flags: 'a' })

  // Counted so the exit summary can say whether this session is worth
  // distilling. A launch that never reached Dolphin writes a log with no ball
  // in it, and that is worth knowing before the terminal closes.
  const counts = { ballSamples: 0, contacts: 0 }
  let lastLoggedStadiumKey = null

  return {
    path: filePath,

    // Raw tracker output, verbatim. The flight pipeline substring-matches its
    // markers, so the tracker's own "HH:MM:SS [LEVEL] " prefix is harmless and
    // is deliberately kept -- it is what makes the file readable by a human.
    write(line) {
      const clean = String(line || '').trim()
      if (!clean) return
      if (clean.includes(BALL_SAMPLE_MARKER)) counts.ballSamples += 1
      if (clean.includes(CONTACT_MARKER)) counts.contacts += 1
      stream.write(`${clean}\n`)
    },

    // A line of our own, not the tracker's.
    writeRecord(record) {
      stream.write(`${record}\n`)
    },

    // The tracker executable never records which stadium is being played in, so
    // every flight in the logs would otherwise be park-anonymous. That is
    // harmless for fitting the flight model, which has no park in it, but it
    // makes it impossible to ask whether the physics are park-invariant, or to
    // compare one park's carry against another's.
    //
    // Emitted on CHANGE rather than once at startup, because the key can be set
    // late (POST /stadium) or arrive mid-session from a "A vs. B @ Stadium"
    // line. Attribution downstream is POSITIONAL -- ball_trajectories.mjs gives
    // a run of samples the last stadium written before it -- so the marker has
    // to land in the stream ahead of the samples it describes, which emitting
    // on change does and a single startup line would not.
    noteStadium(state, onRecord = null) {
      const key = state?.stadiumKey ?? null
      if (key === lastLoggedStadiumKey) return null
      lastLoggedStadiumKey = key
      if (!key) return null
      const source = state.stadiumOverrideKey ? 'override' : 'detected'
      const record = `TRACKER_STADIUM] key=${key}|name=${state.stadiumName || ''}|source=${source}`
      stream.write(`${record}\n`)
      if (onRecord) onRecord(record)
      return record
    },

    get counts() { return { ...counts } },
    get stadiumKey() { return lastLoggedStadiumKey },

    // What this session left behind, in the order it is worth hearing. A
    // session with flights but no park is the one case worth saying loudly:
    // the flights are fine, but they are unlabelled, and that cannot be
    // repaired later from the log alone.
    summary() {
      const lines = [
        `captured ${counts.contacts} batted ball(s), ${counts.ballSamples} ball samples`,
      ]
      if (!counts.ballSamples) {
        lines.push('no ball data in this session — nothing to distil')
      } else if (!lastLoggedStadiumKey) {
        lines.push("WARNING: no stadium was ever set, so this session's flights will be unlabelled.")
        lines.push('Pick the stadium next time BEFORE playing — POST /stadium, or the selector on the preview page.')
      } else {
        lines.push(`stadium recorded: ${lastLoggedStadiumKey}`)
        lines.push('flight samples are ready for local archive post-processing')
      }
      lines.push(`session log kept at: ${filePath}`)
      return lines
    },

    // Resolves once everything handed to write() is actually on disk. The
    // stream buffers, so a caller that reads the file straight after closing
    // it -- a test, or a distil step chained onto the end of a session -- would
    // otherwise see a truncated file. Production callers can ignore the
    // promise; Node flushes on a normal exit either way.
    close() {
      return new Promise((resolve) => stream.end(resolve))
    },
  }
}
