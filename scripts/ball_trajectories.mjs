// Full 60Hz flight paths for batted balls, and what each flight actually ENDED in.
//
// Why this exists. The tracker labels an endpoint `landing` whenever the ball
// stops being tracked in fair territory, and that label is wrong roughly half
// the time: 65 of 139 "landings" across the logs in this repo ended with the
// ball 0.3 to 12 units in the AIR. Those are walls, backdrops, deck structures
// and scoreboards, not landings. A ball that struck a wall 30 ft up at 340 ft
// did not carry 340 ft, so every such record understates carry -- and they are
// concentrated at the deep end, which is exactly the range the distance model
// is used in. Fitting carry against those labels teaches the model where the
// walls are instead of how far the ball goes.
//
// The discriminator needs no park geometry at all: a ball at rest reads
// y = 0.25 EXACTLY -- one ball radius, confirmed across 74 records with a
// minimum of 0.250000 and a standard deviation of 0.013. Anything higher
// touched something. That matters because the alternative (comparing against a
// measured fence) would make the label depend on how well a park is calibrated,
// and only three of nine parks are calibrated at all.
//
//   node scripts/ball_trajectories.mjs            # classify every flight
//   node scripts/ball_trajectories.mjs --csv f.csv
//   node scripts/ball_trajectories.mjs --archive  # read the distilled archive
//                                                 # instead of the raw logs
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadArchivedFlights } from './flight_archive.mjs'

const SAMPLE_MARKER = 'TRACKER_BALL_SAMPLE] '
const CONTACT_MARKER = 'TRACKER_BATTED_BALL_PROVISIONAL] '
// Written by scripts/tracker_at_bat_preview.mjs whenever the effective stadium
// changes, because the tracker executable never records one. Without it every
// flight in this repo is park-anonymous, which is fine for fitting the flight
// model (it has no park in it) but makes it impossible to ask whether the
// physics are park-invariant -- an assumption currently resting on nothing.
export const STADIUM_MARKER = 'TRACKER_STADIUM] '

// A ball at rest sits one radius above the surface. Hard constant in this
// engine, not a fitted value.
export const BALL_RADIUS_UNITS = 0.25
// Slack on that constant. Wide enough for float noise (observed max 0.2989),
// far below the 0.3+ that means real contact with a structure.
export const AT_REST_TOLERANCE_UNITS = 0.05

/**
 * Every marker-delimited record in a blob of log text.
 *
 * Bounded exactly like extract_batted_balls.mjs, and for the same reason: the
 * preview log is JSON, one line can carry dozens of records, and reading to
 * end-of-line silently splices separate balls together. Stop at the first
 * character that cannot appear inside a record.
 */
export function scanRecords(text, marker) {
  const out = []
  let from = 0
  for (;;) {
    const at = String(text).indexOf(marker, from)
    if (at < 0) break
    const start = at + marker.length
    let end = start
    while (end < text.length) {
      const c = text[end]
      if (c === '"' || c === '\\' || c === '\n' || c === '\r') break
      end += 1
    }
    const fields = {}
    for (const part of text.slice(start, end).split('|')) {
      const j = part.indexOf('=')
      // First value wins; a duplicate key means the bounds are wrong.
      if (j > 0 && !Object.hasOwn(fields, part.slice(0, j))) {
        fields[part.slice(0, j)] = part.slice(j + 1)
      }
    }
    // `at` is kept because stadium attribution is POSITIONAL: TRACKER_STADIUM
    // carries no seq, so the only thing tying it to the samples it describes is
    // that it was written before them.
    out.push({ fields, at })
    from = end
  }
  return out
}

export function extractRecords(text, marker) {
  return scanRecords(text, marker).map((r) => r.fields)
}

const num = (v) => (v == null || v === 'none' || v === '') ? null : Number(v)

export function findLogs(dir, found = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return found }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) findLogs(full, found)
    else if (name.endsWith('.log')) found.push(full)
  }
  return found
}

/**
 * Which stadium a run of samples was played in, or null when it cannot be told.
 *
 * The rule is POSITIONAL, because TRACKER_STADIUM carries no seq: the samples
 * belong to the last marker written before the first of them.
 *
 * Applied PER CONTACT rather than per session, which matters more than it
 * sounds. A tracker restart resets seq and starts a new session, but leaving
 * the preview running across two games does not -- so a session can legitimately
 * span a stadium change, and attributing by the session's first sample would
 * hand every flight in it the same answer, or refuse them all.
 *
 * The backfill below is the case that will actually happen. The stadium is
 * chosen by hand in the preview, and it is easy to play a few at-bats before
 * getting round to selecting it -- those samples precede every marker and would
 * otherwise be thrown away. They are not ambiguous: a game cannot change
 * stadium partway through, so if the whole file names exactly ONE stadium, the
 * samples before the marker were played there too. When a file names more than
 * one that reasoning fails -- the second marker may be a correction of the
 * first, or a genuine second game -- so only the leading samples stay null,
 * while everything after a marker is still attributed normally.
 */
export function stadiumForRun(samples, stadiums, distinctStadiums) {
  if (!stadiums.length || !samples.length) return null
  const firstAt = samples[0].at
  let found = null
  for (const s of stadiums) {
    if (s.at <= firstAt) found = s.key
    else break
  }
  if (found) return found
  return distinctStadiums.size === 1 ? stadiums[0].key : null
}

/**
 * Load ball samples and contacts, grouped into SESSIONS.
 *
 * Sessions matter and getting this wrong is silent. `seq` is per-session, not
 * global: every log file starts again at 1. Keying samples by seq across files
 * therefore collides them -- contacts from one game get handed another game's
 * trajectory, and nothing errors. The symptom is a flight model that fits
 * gravity at 67 u/s^2 against a true 7.2 and landing errors of 200 ft, which is
 * how this was caught.
 *
 * A single file can also contain more than one session if the tracker was
 * restarted, so the seq stream is split wherever it stops increasing rather
 * than trusting file boundaries alone.
 */
export function loadSessions(roots) {
  const sessions = []
  const files = []
  for (const root of roots) {
    for (const path of findLogs(root)) {
      files.push(path)
      const text = readFileSync(path, 'utf8')

      const raw = []
      for (const { fields: s, at } of scanRecords(text, SAMPLE_MARKER)) {
        const seq = num(s.seq)
        if (seq == null || num(s.x) == null) continue
        raw.push({ seq, timeNs: num(s.time_ns), x: num(s.x), y: num(s.y), z: num(s.z), at })
      }
      const contacts = extractRecords(text, CONTACT_MARKER)
        .filter((c) => c.contact_seq && c.batter)
      const stadiums = scanRecords(text, STADIUM_MARKER)
        .filter((r) => r.fields.key)
        .map((r) => ({ key: r.fields.key, at: r.at }))
      const distinctStadiums = new Set(stadiums.map((s) => s.key))

      // Split on a seq reset. Within a run, phase=raw and phase=post_contact
      // report the same seq, so first-seen wins.
      const runs = []
      let current = new Map()
      let previousSeq = -Infinity
      for (const s of raw) {
        if (s.seq < previousSeq) {
          if (current.size) runs.push(current)
          current = new Map()
        }
        if (!current.has(s.seq)) current.set(s.seq, s)
        previousSeq = s.seq
      }
      if (current.size) runs.push(current)

      for (const run of runs) {
        const ordered = [...run.values()].sort((a, b) => a.seq - b.seq)
        const lo = ordered[0].seq
        const hi = ordered[ordered.length - 1].seq
        // Attach the contacts whose flight could lie inside this run. A contact
        // whose seq falls outside every run keeps no trajectory, which is
        // correct: better no flight than another ball's flight.
        const mine = contacts.filter((c) => {
          const seq = num(c.contact_seq)
          return seq != null && seq >= lo && seq <= hi
        })
        if (mine.length) {
          sessions.push({
            path,
            samples: ordered,
            contacts: mine,
            // Carried rather than resolved here: each flight resolves its own,
            // since one session can span a stadium change.
            stadiums,
            distinctStadiums,
            stadiumKey: stadiumForRun(ordered, stadiums, distinctStadiums),
          })
        }
      }
    }
  }
  return { sessions, files }
}

// Frame spacing is ~16.5 ms (60.5 Hz). A gap outside this band is a dropped
// sample or a tracker re-acquisition, and differencing across it produces
// nonsense velocities.
export const FRAME_MIN_SEC = 0.008
export const FRAME_MAX_SEC = 0.030

/**
 * The sample run belonging to one contact.
 *
 * A resolved contact is bounded by endpoint_seq. An UNRESOLVED one has no
 * endpoint at all, so it is bounded by the next contact instead -- that is the
 * whole point of this function: an unresolved ball still has most of a
 * trajectory logged, and that trajectory is the thing the projection should be
 * using rather than a polynomial in launch conditions.
 */
export function flightFor(contact, samples, nextContactSeq = Infinity) {
  const from = num(contact.contact_seq)
  if (from == null) return []
  const endpointSeq = num(contact.endpoint_seq)
  // endpoint_seq belongs to THIS ball, so it is included. The next contact's seq
  // belongs to the NEXT ball, so it is not — that frame is a different flight,
  // and taking it puts another ball's position at the end of this trajectory.
  const lastInclusive = endpointSeq ?? Math.min(nextContactSeq - 1, from + 2000)
  const out = []
  for (const s of samples) {
    if (s.seq < from) continue
    if (s.seq > lastInclusive) break
    out.push(s)
  }
  return out
}

/** Central-difference velocity/acceleration, skipping frame gaps. */
export function kinematics(flight) {
  const out = []
  for (let i = 1; i < flight.length - 1; i += 1) {
    const p = flight[i - 1], c = flight[i], n = flight[i + 1]
    const dtp = (c.timeNs - p.timeNs) / 1e9
    const dtn = (n.timeNs - c.timeNs) / 1e9
    if (dtp < FRAME_MIN_SEC || dtp > FRAME_MAX_SEC) continue
    if (dtn < FRAME_MIN_SEC || dtn > FRAME_MAX_SEC) continue
    const vx = (n.x - p.x) / (dtp + dtn)
    const vy = (n.y - p.y) / (dtp + dtn)
    const vz = (n.z - p.z) / (dtp + dtn)
    out.push({ ...c, vx, vy, vz, speed: Math.hypot(vx, vy, vz) })
  }
  return out
}

/**
 * What did this flight actually end in?
 *
 * `landed`     — came to rest on a surface (y at the ball radius). Carry is a
 *                real measurement and the record is safe to fit against.
 * `struck`     — stopped while ELEVATED. Contact with a wall, backdrop or
 *                structure; carry is a LOWER BOUND, never the true distance.
 * `caught`     — a fielder took it; carry is a lower bound too.
 * `unresolved` — outran tracking. No endpoint, but a partial trajectory exists.
 * `foul`       — outside fair territory.
 *
 * Deliberately does NOT consult a fence: that would make the label depend on
 * park calibration, and six of nine parks have none.
 */
export function classifyEndpoint(contact) {
  if (contact.endpoint === 'foul') return 'foul'
  if (contact.endpoint === 'unresolved') return 'unresolved'
  if (contact.endpoint === 'catch') return 'caught'
  const y = num(contact.y)
  if (contact.endpoint !== 'landing' || y == null) return 'unknown'
  return Math.abs(y - BALL_RADIUS_UNITS) <= AT_REST_TOLERANCE_UNITS
    ? 'landed'
    : 'struck'
}

/**
 * Contacts joined to their flights, with a trustworthy endpoint label.
 *
 * Takes SESSIONS, and links each contact only against samples from its own
 * session — see loadSessions for why that is not optional. The same contact can
 * appear in several logs (a rolling preview log plus a per-game log), so
 * duplicates are collapsed keeping whichever copy recovered the most samples.
 */
export function buildFlights({ sessions }) {
  const byContact = new Map()
  for (const session of sessions) {
    const starts = session.contacts
      .map((c) => num(c.contact_seq))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b)
    const nextStart = (seq) => {
      for (const v of starts) if (v > seq) return v
      return Infinity
    }
    for (const contact of session.contacts) {
      const from = num(contact.contact_seq)
      if (from == null) continue
      const flight = flightFor(contact, session.samples, nextStart(from))
      const durationSec = flight.length > 1
        ? (flight[flight.length - 1].timeNs - flight[0].timeNs) / 1e9
        : 0
      const built = {
        contactSeq: from,
        batter: contact.batter,
        endpoint: contact.endpoint,
        kind: classifyEndpoint(contact),
        exitSpeedMph: num(contact.exit_speed_mph),
        launchDeg: num(contact.launch_degrees),
        sprayDeg: num(contact.spray_degrees),
        endpointX: num(contact.x),
        endpointY: num(contact.y),
        endpointZ: num(contact.z),
        projectedX: num(contact.projected_x),
        projectedZ: num(contact.projected_z),
        flight,
        durationSec,
        apexUnits: flight.length ? Math.max(...flight.map((s) => s.y)) : null,
        source: session.path,
        // This flight's own position in the file, falling back to the session's
        // when the contact kept no samples to be positioned by.
        stadiumKey: (flight.length && session.stadiums
          ? stadiumForRun(flight, session.stadiums, session.distinctStadiums)
          : null) ?? session.stadiumKey ?? null,
      }
      const key = `${from}|${contact.batter}|${contact.exit_speed_mph}`
      const existing = byContact.get(key)
      // Prefer the copy with more trajectory; on a tie prefer one whose
      // endpoint resolved, since a later snapshot may have filled it in.
      const better = !existing
        || built.flight.length > existing.flight.length
        || (built.flight.length === existing.flight.length
          && existing.kind === 'unresolved' && built.kind !== 'unresolved')
      if (better) byContact.set(key, built)
    }
  }
  return [...byContact.values()]
}

const DEFAULT_ROOTS = ['sluggers-stat-tracker-advanced-stats-dev']

function main() {
  const args = process.argv.slice(2)
  const csvAt = args.indexOf('--csv')
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const roots = DEFAULT_ROOTS.map((r) => join(repoRoot, r))

  let flights
  if (args.includes('--archive')) {
    flights = loadArchivedFlights()
    console.log(`${flights.length} flights from the distilled archive\n`)
  } else {
    const loaded = loadSessions(roots)
    const sampleCount = loaded.sessions.reduce((n, s) => n + s.samples.length, 0)
    console.log(`${loaded.files.length} log file(s), ${loaded.sessions.length} session(s), `
      + `${sampleCount} ball samples\n`)
    flights = buildFlights(loaded)
  }
  const groups = new Map()
  for (const f of flights) {
    if (!groups.has(f.kind)) groups.set(f.kind, [])
    groups.get(f.kind).push(f)
  }

  const median = (arr) => {
    const s = arr.filter(Number.isFinite).sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length / 2)] : NaN
  }

  console.log('endpoint classification (no park geometry involved):')
  console.log(`  ${'kind'.padEnd(11)} ${'n'.padStart(4)}  ${'frames'.padStart(7)}  `
    + `${'seconds'.padStart(8)}  ${'apex(u)'.padStart(8)}  meaning`)
  const meaning = {
    landed: 'came to rest — carry is MEASURED',
    struck: 'hit something elevated — carry is a LOWER BOUND',
    caught: 'fielded — carry is a lower bound',
    unresolved: 'outran tracking — partial trajectory only',
    foul: 'foul ground',
    unknown: 'could not classify',
  }
  // A kind the archive stores metadata-only for has no samples to summarise,
  // so those columns are blank rather than NaN -- which reads as "not stored"
  // instead of "computed and went wrong".
  const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—')
  for (const kind of ['landed', 'struck', 'caught', 'unresolved', 'foul', 'unknown']) {
    const g = groups.get(kind)
    if (!g || !g.length) continue
    console.log(`  ${kind.padEnd(11)} ${String(g.length).padStart(4)}  `
      + `${String(median(g.map((f) => f.flight.length))).padStart(7)}  `
      + `${fmt(median(g.map((f) => f.durationSec))).padStart(8)}  `
      + `${fmt(median(g.map((f) => f.apexUnits))).padStart(8)}  ${meaning[kind]}`)
  }

  // Per-park breakdown. `scorable` is the number that actually limits the
  // projection backtest: a flight only carries a usable label if it came to
  // rest, so a deep park where balls land in play is worth more per game than
  // a shallow one where they hit walls or leave the field.
  const parks = new Map()
  for (const f of flights) {
    const key = f.stadiumKey ?? '(unlabelled)'
    if (!parks.has(key)) parks.set(key, [])
    parks.get(key).push(f)
  }
  if (parks.size > 1 || !parks.has('(unlabelled)')) {
    console.log('\nby park (TRACKER_STADIUM, written by the preview):')
    console.log(`  ${'park'.padEnd(18)} ${'n'.padStart(4)} ${'landed'.padStart(7)} `
      + `${'struck'.padStart(7)} ${'unres'.padStart(6)} ${'caught'.padStart(7)} ${'foul'.padStart(6)}`)
    const order = [...parks.keys()].sort((a, b) => parks.get(b).length - parks.get(a).length)
    for (const key of order) {
      const g = parks.get(key)
      const count = (kind) => g.filter((f) => f.kind === kind).length
      console.log(`  ${key.padEnd(18)} ${String(g.length).padStart(4)} `
        + `${String(count('landed')).padStart(7)} ${String(count('struck')).padStart(7)} `
        + `${String(count('unresolved')).padStart(6)} ${String(count('caught')).padStart(7)} `
        + `${String(count('foul')).padStart(6)}`)
    }
    if (parks.has('(unlabelled)')) {
      console.log('\n  (unlabelled) is every log written before the preview began'
        + '\n  recording the stadium — not an error, just older data.')
    }
  }

  const struck = groups.get('struck') ?? []
  if (struck.length) {
    console.log(`\nthe ${struck.length} mislabelled "landings", by contact height:`)
    for (const [lo, hi] of [[0.3, 1], [1, 3], [3, 6], [6, 12], [12, Infinity]]) {
      const band = struck.filter((f) => f.endpointY >= lo && f.endpointY < hi)
      if (!band.length) continue
      const dists = band.map((f) => Math.hypot(f.endpointX, f.endpointZ))
      console.log(`  y ${String(lo).padStart(4)}-${String(hi).padEnd(4)} n=${String(band.length).padStart(3)}`
        + `   radius ${Math.min(...dists).toFixed(0)}-${Math.max(...dists).toFixed(0)} units`)
    }
    console.log('\nThese are the records a carry model must NOT be fitted against,')
    console.log('and the ones a trajectory model can still use in full.')
  }

  if (csvAt >= 0 && args[csvAt + 1]) {
    const header = 'contact_seq,batter,kind,endpoint,exit_speed_mph,launch_deg,spray_deg,'
      + 'endpoint_x,endpoint_y,endpoint_z,frames,duration_sec,apex_units,stadium_key\n'
    const body = flights.map((f) => [
      f.contactSeq, JSON.stringify(f.batter), f.kind, f.endpoint,
      f.exitSpeedMph ?? '', f.launchDeg ?? '', f.sprayDeg ?? '',
      f.endpointX ?? '', f.endpointY ?? '', f.endpointZ ?? '',
      f.flight.length, f.durationSec.toFixed(3), f.apexUnits ?? '',
      f.stadiumKey ?? '',
    ].join(',')).join('\n')
    writeFileSync(args[csvAt + 1], header + body + '\n')
    console.log(`\nwrote ${flights.length} rows to ${args[csvAt + 1]}`)
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main()
}
