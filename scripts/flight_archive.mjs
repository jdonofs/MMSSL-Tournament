// A compact, permanent store of batted-ball flights, so the raw logs can be
// deleted after a session instead of accumulating forever.
//
// WHY THIS EXISTS. The tracker logs everything the ball does at 60.5 Hz for the
// whole time it is loaded, and TRACKER_BALL_SAMPLE is 71% of the bytes. Across
// the 13 logs in this repo that is 18.5 MB for 328 flights, and a third of
// those samples are the ball sitting still between plays. Keeping raw logs to
// keep flights is paying ~30x for the part that matters.
//
// WHAT IS ACTUALLY NEEDED. Tuning the projection needs, per flight: the
// trajectory samples, the endpoint, and the launch conditions. It does not need
// pitches, lineups, runners, or the ball at rest in a fielder's glove between
// at-bats. Distilling to just the flights, encoded compactly and gzipped, is
// 3.5% of the raw logs -- ~2 KB per flight, so a thousand games costs tens of
// megabytes rather than gigabytes.
//
// WHAT IS DELIBERATELY KEPT AT FULL RESOLUTION. `landed` flights are the
// labels the whole backtest rests on. `struck` flights are how wall heights get
// measured (see the note on WALL_HEIGHT_UNITS in parkGeometry.js) and a
// truncated one cannot show the reversal that identifies a crest hit.
// `unresolved` flights are the balls the projection exists FOR. Those three
// keep every frame. A `caught` ball is a lower bound whose arc is still real
// physics, so it keeps the first seconds; a `foul` keeps its metadata only,
// because it contributes to neither carry, wall height, nor projection.
//
// POSITIONS ARE STORED AS INTEGER TEN-THOUSANDTHS of a unit, and that exponent
// was chosen by measurement rather than taste. The tracker's own frame-to-frame
// second difference in x -- the scale at which real per-frame structure lives --
// runs a median of 8.1e-4 units. Quantising at 1e-3 is therefore COMPARABLE to
// the signal, not far below it, and it visibly moved the backtest (gravity by
// 0.0005 u/s^2, the medians by 0.1 ft). 1e-4 sits an order of magnitude under
// the second difference and costs 14% more on disk, which is the right trade.
// Integers also compress better than decimal strings.
//
//   node scripts/distill_flights.mjs            # add new flights to the archive
//   node scripts/distill_flights.mjs --verify   # prove it reproduces the logs
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Bumped only when the on-disk shape changes in a way older readers cannot
// handle. Written on every row so a mixed-version archive is still readable.
export const ARCHIVE_VERSION = 1

export const ARCHIVE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', 'data', 'flight_archive.jsonl.gz',
)

// Seconds of flight retained per endpoint kind. Infinity keeps everything;
// 0 keeps metadata with no samples at all.
export const RETENTION_SEC = {
  landed: Infinity,      // the labels the backtest scores against
  struck: Infinity,      // wall-height measurement needs the full approach
  unresolved: Infinity,  // the balls the projection is for
  caught: 3,             // a real arc, but only a lower bound on carry
  foul: 0,               // no carry, no wall, no projection value
  unknown: 3,
}

export const POS_SCALE = 10000

/**
 * A stable identity for a flight, so re-distilling the same log is a no-op.
 *
 * Deliberately NOT the source filename: the same game can be re-logged, and a
 * preview session log is truncated and rewritten on every launch. Contact seq
 * plus batter plus launch conditions identifies the ball itself.
 */
export function flightKey(f) {
  return [
    f.contactSeq, f.batter, f.exitSpeedMph ?? '', f.launchDeg ?? '', f.sprayDeg ?? '',
  ].join('|')
}

/** One flight -> one archive row, trimmed by the retention policy. */
export function encodeFlight(f, retention = RETENTION_SEC) {
  const t0 = f.flight.length ? f.flight[0].timeNs : 0
  const cap = retention[f.kind] ?? Infinity
  const kept = cap === 0 ? [] : f.flight.filter((s) => (s.timeNs - t0) / 1e9 <= cap)
  return {
    v: ARCHIVE_VERSION,
    key: flightKey(f),
    seq: f.contactSeq,
    batter: f.batter,
    kind: f.kind,
    endpoint: f.endpoint,
    exit_mph: f.exitSpeedMph,
    launch: f.launchDeg,
    spray: f.sprayDeg,
    end: [f.endpointX, f.endpointY, f.endpointZ],
    proj: [f.projectedX, f.projectedZ],
    stadium: f.stadiumKey,
    t0_ns: t0,
    // Kept so a trimmed flight still reports its true length rather than
    // silently looking like a short one.
    frames_total: f.flight.length,
    trimmed: kept.length !== f.flight.length,
    s: encodeSamples(kept, t0),
  }
}

/**
 * Samples as [dt_us, x, y, z], time delta-encoded in MICROSECONDS.
 *
 * Both halves of that are deliberate. Milliseconds are not enough: frames are
 * ~16.5 ms apart and the tracker records to 100 ns, so rounding to a
 * millisecond perturbs an individual frame gap by up to 1 ms -- SIX PERCENT --
 * which feeds straight into the fitted velocity and moved the backtest medians
 * by 0.1 ft. Microseconds cut that to 0.003%.
 *
 * Absolute microsecond offsets would cost 12% more on disk than milliseconds;
 * delta-encoding them costs under 1%, because consecutive gaps are all ~16500
 * and gzip does the rest. Precision here is effectively free.
 */
export function encodeSamples(samples, t0) {
  let previous = 0
  return samples.map((s) => {
    const t = Math.round((s.timeNs - t0) / 1e3)
    const delta = t - previous
    previous = t
    return [
      delta,
      Math.round(s.x * POS_SCALE),
      Math.round(s.y * POS_SCALE),
      Math.round(s.z * POS_SCALE),
    ]
  })
}

// A caught or landed flight whose stored endpoint is the origin was recorded on
// the frame the game blanked the ball coordinate -- see
// trackerEndpointIsCoordinateReset in tracker_play_events.mjs, and v28 of the
// executable, which stopped producing them. The archive keeps every sample, so
// the real endpoint is the last one the flight actually holds; a foul or
// unresolved row stores zeros because it genuinely has no endpoint, and keeps
// them.
const ARCHIVE_ENDPOINT_KINDS = new Set(['caught', 'landed', 'struck'])

function archiveEndpoint(row, flight) {
  const end = row.end
  const stored = {
    x: end?.[0] ?? null,
    y: end?.[1] ?? null,
    z: end?.[2] ?? null,
  }
  if (!ARCHIVE_ENDPOINT_KINDS.has(row.kind)) return stored
  if (Number(stored.x) !== 0 || Number(stored.y) !== 0 || Number(stored.z) !== 0) return stored
  for (let index = flight.length - 1; index >= 0; index -= 1) {
    const sample = flight[index]
    if (sample.x !== 0 || sample.y !== 0 || sample.z !== 0) {
      return { x: sample.x, y: sample.y, z: sample.z }
    }
  }
  return stored
}

/** An archive row -> the same shape buildFlights() produces. */
export function decodeFlight(row) {
  const t0 = row.t0_ns ?? 0
  let elapsedUs = 0
  const flight = (row.s ?? []).map(([deltaUs, x, y, z]) => {
    elapsedUs += deltaUs
    return {
      timeNs: t0 + (elapsedUs * 1e3),
      x: x / POS_SCALE,
      y: y / POS_SCALE,
      z: z / POS_SCALE,
    }
  })
  const durationSec = flight.length > 1
    ? (flight[flight.length - 1].timeNs - flight[0].timeNs) / 1e9
    : 0
  const endpoint = archiveEndpoint(row, flight)
  return {
    contactSeq: row.seq,
    batter: row.batter,
    endpoint: row.endpoint,
    kind: row.kind,
    exitSpeedMph: row.exit_mph ?? null,
    launchDeg: row.launch ?? null,
    sprayDeg: row.spray ?? null,
    endpointX: endpoint.x,
    endpointY: endpoint.y,
    endpointZ: endpoint.z,
    projectedX: row.proj?.[0] ?? null,
    projectedZ: row.proj?.[1] ?? null,
    flight,
    durationSec,
    apexUnits: flight.length ? Math.max(...flight.map((s) => s.y)) : null,
    source: 'archive',
    stadiumKey: row.stadium ?? null,
    framesTotal: row.frames_total ?? flight.length,
    trimmed: Boolean(row.trimmed),
  }
}

export function readArchive(path = ARCHIVE_PATH) {
  if (!existsSync(path)) return []
  const text = gunzipSync(readFileSync(path)).toString('utf8')
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    rows.push(JSON.parse(line))
  }
  return rows
}

export function writeArchive(rows, path = ARCHIVE_PATH) {
  mkdirSync(dirname(path), { recursive: true })
  const text = rows.map((r) => JSON.stringify(r)).join('\n')
  writeFileSync(path, gzipSync(text, { level: 9 }))
  return Buffer.byteLength(text)
}

/** Flights from the archive, in the shape the analysis scripts expect. */
export function loadArchivedFlights(path = ARCHIVE_PATH) {
  return readArchive(path).map(decodeFlight)
}

/**
 * Merge new flights into an archive, newest wins on a tie.
 *
 * "Newest wins" matters because a flight can be re-read with MORE of its
 * trajectory: the preview log holds the live session while output/ holds the
 * finished game, and one may have seen frames the other missed.
 */
export function mergeFlights(existingRows, incomingFlights, retention = RETENTION_SEC) {
  const byKey = new Map(existingRows.map((r) => [r.key, r]))
  let added = 0
  let improved = 0
  for (const f of incomingFlights) {
    const row = encodeFlight(f, retention)
    const prior = byKey.get(row.key)
    if (!prior) {
      byKey.set(row.key, row)
      added += 1
      continue
    }
    // Prefer the copy with more retained samples; on a tie prefer one whose
    // endpoint resolved, matching buildFlights' own preference.
    const better = row.s.length > prior.s.length
      || (row.s.length === prior.s.length && prior.kind === 'unresolved' && row.kind !== 'unresolved')
    if (better) {
      byKey.set(row.key, row)
      improved += 1
    }
  }
  return { rows: [...byKey.values()], added, improved }
}
