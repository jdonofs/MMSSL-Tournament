// Pull every batted-ball record out of the tracker logs, correctly.
//
// This exists because getting it wrong is easy and silent. The preview log is
// JSON, and a single line can carry a whole recent_messages array — dozens of
// records on one line. An extractor that finds the first marker on a line and
// then reads pipe-delimited fields to the end of that line will happily merge
// separate balls into each other: it takes contact_seq from one, the landing
// coordinates from another, exit velocity from a third. Nothing errors. The
// output looks like a plausible dataset and is entirely fictional.
//
// That happened here. It turned 4 real contacts into "61 records" and "45
// usable pairs", which were then fitted into a distance model that had to be
// thrown away. The fix is to bound each record at the first character that
// cannot appear inside one — a quote, a backslash escape, or a newline.
//
//   node scripts/extract_batted_balls.mjs                 # summary
//   node scripts/extract_batted_balls.mjs --csv out.csv   # for fitting
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { FEET_PER_UNIT, HOME_PLATE } from '../src/utils/parkGeometry.js'

const MARKER = 'TRACKER_BATTED_BALL_PROVISIONAL] '

/**
 * Every record in a blob of log text.
 *
 * Deliberately does NOT split on lines first: line boundaries mean nothing
 * here, and splitting by them is what invites reading past the end of a record.
 */
export function extractBattedBallRecords(text) {
  const out = []
  let from = 0
  for (;;) {
    const at = String(text).indexOf(MARKER, from)
    if (at < 0) break
    const start = at + MARKER.length
    let end = start
    while (end < text.length) {
      const c = text[end]
      // A record lives inside a JSON string, so a quote or an escape ends it.
      if (c === '"' || c === '\\' || c === '\n' || c === '\r') break
      end += 1
    }
    const fields = {}
    for (const part of text.slice(start, end).split('|')) {
      const j = part.indexOf('=')
      // First value wins: a duplicated key means the bounds are wrong, and
      // taking the later one would silently import a neighbouring record.
      if (j > 0 && !Object.hasOwn(fields, part.slice(0, j))) {
        fields[part.slice(0, j)] = part.slice(j + 1)
      }
    }
    if (fields.contact_seq && fields.batter) out.push(fields)
    from = end
  }
  return out
}

const number = (v) => (v == null || v === 'none' || v === '') ? null : Number(v)

/** One entry per contact; the same record appears in many log snapshots. */
export function dedupeBattedBallRecords(records) {
  const byKey = new Map()
  for (const r of records) byKey.set(`${r.contact_seq}|${r.batter}|${r.exit_speed_mph}`, r)
  return [...byKey.values()]
}

/**
 * Records usable for calibrating batted-ball flight: a REAL tracked endpoint,
 * so the distance is observed rather than modelled.
 */
export function calibrationRows(records) {
  return records
    .filter((r) => (r.endpoint === 'landing' || r.endpoint === 'catch')
      && number(r.x) != null && number(r.z) != null && number(r.exit_speed_mph) > 0)
    .map((r) => {
      const dx = number(r.x) - HOME_PLATE.x
      const dz = number(r.z) - HOME_PLATE.z
      return {
        batter: r.batter,
        // The executable converts to feet with whatever scale it was built
        // with, so exit velocity is rescaled and distance is taken from the
        // raw coordinates. Neither trusts the exe's own feet.
        exitVelocityMph: number(r.exit_speed_mph) * (FEET_PER_UNIT / (number(r.feet_per_unit) ?? 3.0)),
        launchAngleDeg: number(r.launch_degrees),
        sprayAngleDeg: number(r.spray_degrees),
        distanceFeet: Math.hypot(dx, dz) * FEET_PER_UNIT,
        landingAngleDeg: (Math.atan2(dx, -dz) * 180) / Math.PI,
        landingHeightUnits: number(r.y),
        endpoint: r.endpoint,
      }
    })
}

function findLogs(dir, found = []) {
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

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const csvIndex = process.argv.indexOf('--csv')
  const all = []
  const perFile = []
  for (const file of findLogs(root)) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const recs = extractBattedBallRecords(text)
    if (!recs.length) continue
    perFile.push([file.replace(root, '').replace(/^[\\/]/, ''), recs.length])
    all.push(...recs)
  }

  const records = dedupeBattedBallRecords(all)
  const rows = calibrationRows(records)

  console.log('logs with batted-ball records:')
  for (const [f, n] of perFile) console.log(`  ${String(n).padStart(5)}  ${f}`)
  console.log(`\n${all.length} record instances -> ${records.length} distinct contacts`)
  for (const e of ['landing', 'catch', 'unresolved', 'foul']) {
    console.log(`  ${e.padEnd(11)} ${records.filter((r) => r.endpoint === e).length}`)
  }
  console.log(`\n${rows.length} usable for calibration (real tracked endpoint)`)

  if (rows.length) {
    const v = rows.map((r) => r.exitVelocityMph)
    const a = rows.map((r) => r.launchAngleDeg)
    const d = rows.map((r) => r.distanceFeet)
    const span = (x) => `${Math.min(...x).toFixed(1)} .. ${Math.max(...x).toFixed(1)}`
    console.log(`  exit velocity ${span(v)} mph`)
    console.log(`  launch angle  ${span(a)} deg`)
    console.log(`  distance      ${span(d)} ft`)
    // A model with four free parameters wants a few dozen observations spread
    // across the input range, not a handful clustered at one launch angle.
    console.log(`\n${rows.length < 30
      ? `NOT ENOUGH to fit anything — ${rows.length} rows. Aim for 30+ with a real spread of launch angles.`
      : 'Enough rows to attempt a fit; check the spread above is genuine and not one cluster.'}`)
  }

  if (csvIndex >= 0 && process.argv[csvIndex + 1]) {
    const header = 'batter,exit_velocity_mph,launch_angle_deg,spray_angle_deg,distance_ft,landing_angle_deg,landing_height_units,endpoint'
    const body = rows.map((r) => [
      JSON.stringify(r.batter), r.exitVelocityMph.toFixed(3), r.launchAngleDeg,
      r.sprayAngleDeg, r.distanceFeet.toFixed(2), r.landingAngleDeg.toFixed(2),
      r.landingHeightUnits, r.endpoint,
    ].join(','))
    writeFileSync(process.argv[csvIndex + 1], `${header}\n${body.join('\n')}\n`)
    console.log(`\nwrote ${rows.length} rows to ${process.argv[csvIndex + 1]}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('extract_batted_balls.mjs')) main()
