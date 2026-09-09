// Distil raw tracker logs into data/flight_archive.jsonl.gz, so the logs can be
// deleted without losing anything the projection work needs.
//
//   node scripts/distill_flights.mjs             # merge new flights in
//   node scripts/distill_flights.mjs --verify    # check the archive reproduces the logs
//   node scripts/distill_flights.mjs --dry-run   # report what would change
//
// The workflow this is built for: play, distil, verify, THEN delete the logs.
// Nothing here deletes anything -- that stays a deliberate act, because a
// distilled flight cannot be un-distilled.
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFlights, findLogs, loadSessions } from './ball_trajectories.mjs'
import {
  ARCHIVE_PATH, POS_SCALE, RETENTION_SEC, flightKey,
  loadArchivedFlights, mergeFlights, readArchive, writeArchive,
} from './flight_archive.mjs'
import { scorableFlights } from './backtest_hr_projection.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOG_ROOT = join(repoRoot, 'sluggers-stat-tracker-advanced-stats-dev')

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
const kb = (n) => `${(n / 1024).toFixed(0)} KB`

function logBytes() {
  let total = 0
  for (const f of findLogs(LOG_ROOT)) {
    try { total += statSync(f).size } catch { /* vanished mid-run */ }
  }
  return total
}

/**
 * Does the archive still support the same conclusions as the logs?
 *
 * The only check worth running: score the projection from BOTH and require the
 * scorable sets to match flight for flight. If they do, deleting the logs costs
 * nothing measurable. Compares the label each flight contributes rather than
 * just counting them, because a truncated trajectory would still count.
 */
function verify() {
  const fromLogs = buildFlights(loadSessions([LOG_ROOT]))
  const fromArchive = loadArchivedFlights()
  console.log(`logs    ${fromLogs.length} flights`)
  console.log(`archive ${fromArchive.length} flights`)

  const logScorable = new Map(scorableFlights(fromLogs).map((f) => [flightKey(f), f]))
  const archScorable = new Map(scorableFlights(fromArchive).map((f) => [flightKey(f), f]))
  console.log(`\nscorable: logs ${logScorable.size}, archive ${archScorable.size}`)

  const missing = [...logScorable.keys()].filter((k) => !archScorable.has(k))
  const extra = [...archScorable.keys()].filter((k) => !logScorable.has(k))
  let worstTouch = 0
  let worstApex = 0
  for (const [key, a] of archScorable) {
    const b = logScorable.get(key)
    if (!b) continue
    worstTouch = Math.max(
      worstTouch,
      Math.hypot(a.touch.x - b.touch.x, a.touch.z - b.touch.z),
    )
    worstApex = Math.max(worstApex, Math.abs(a.apex - b.apex))
  }
  console.log(`  present in logs but not archive: ${missing.length}`)
  console.log(`  present in archive but not logs: ${extra.length}`)
  console.log(`  worst first-touch disagreement:  ${worstTouch.toFixed(6)} units`)
  console.log(`  worst apex disagreement:         ${worstApex.toFixed(6)} units`)

  // A round trip can move a coordinate by at most half the quantisation step.
  // Anything larger means real frames were lost, not merely rounded.
  const tolerance = 1 / POS_SCALE
  const ok = missing.length === 0 && worstTouch <= tolerance && worstApex <= tolerance
  console.log(ok
    ? '\nPASS — the archive supports every scorable flight the logs do.'
      + '\nThe raw logs can be deleted.'
    : '\nFAIL — the archive does NOT reproduce the logs. Do not delete anything.')
  return ok ? 0 : 1
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--verify')) return verify()
  const dryRun = args.includes('--dry-run')

  const loaded = loadSessions([LOG_ROOT])
  const flights = buildFlights(loaded)
  const before = readArchive()
  // Which source file each flight came from, resolved BEFORE the merge, so a
  // file can be reported as fully-absorbed rather than merely "seen".
  const priorKeys = new Set(before.map((r) => r.key))
  const bySource = new Map()
  for (const f of flights) {
    const name = f.source.split(/[\\/]/).pop()
    const e = bySource.get(name) ?? { total: 0, novel: 0 }
    e.total += 1
    if (!priorKeys.has(flightKey(f))) e.novel += 1
    bySource.set(name, e)
  }
  const { rows, added, improved } = mergeFlights(before, flights)

  const rawBytes = logBytes()
  console.log(`${flights.length} flights in the logs (${mb(rawBytes)} on disk)`)
  console.log(`archive: ${before.length} rows -> ${rows.length}`)
  console.log(`  ${added} new, ${improved} replaced by a longer trajectory, `
    + `${flights.length - added - improved} already present`)

  const kept = new Map()
  for (const r of rows) {
    const e = kept.get(r.kind) ?? { n: 0, frames: 0, total: 0 }
    e.n += 1
    e.frames += r.s.length
    e.total += r.frames_total ?? r.s.length
    kept.set(r.kind, e)
  }
  console.log('\nretention by kind (seconds kept, frames stored / frames seen):')
  for (const [kind, e] of [...kept].sort((a, b) => b[1].n - a[1].n)) {
    const cap = RETENTION_SEC[kind]
    const label = cap === Infinity ? 'all' : `${cap}s`
    console.log(`  ${kind.padEnd(11)} ${label.padStart(4)}   n=${String(e.n).padStart(4)}   `
      + `${String(e.frames).padStart(6)} / ${String(e.total).padStart(6)} frames`)
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written')
    return 0
  }

  const uncompressed = writeArchive(rows)
  const archiveBytes = statSync(ARCHIVE_PATH).size
  console.log(`\nwrote ${ARCHIVE_PATH}`)
  console.log(`  ${kb(uncompressed)} uncompressed -> ${kb(archiveBytes)} gzipped`)
  if (rawBytes > 0) {
    console.log(`  ${(archiveBytes / rawBytes * 100).toFixed(2)}% of the raw logs `
      + `(${(rawBytes / archiveBytes).toFixed(0)}x smaller)`)
  }
  console.log(`  ${(archiveBytes / Math.max(rows.length, 1)).toFixed(0)} bytes per flight`)

  // Which files are now fully represented in the archive. Reported per FILE
  // because that is the unit actually deleted, and a file is only safe to
  // remove once every flight in it is stored -- "the run added nothing" is not
  // the same statement, since a file can contribute nothing new while still
  // being the only copy of something.
  const archivedKeys = new Set(rows.map((r) => r.key))
  const partial = new Set()
  for (const f of flights) {
    if (!archivedKeys.has(flightKey(f))) partial.add(f.source.split(/[\\/]/).pop())
  }
  // Every log on disk is accounted for, including the ones that produced no
  // flights at all. Those are the majority here, and leaving them unmentioned
  // is what would stop someone deleting anything: silence reads as "unknown".
  const absorbed = []
  const empty = []
  for (const full of loaded.files) {
    const name = full.split(/[\\/]/).pop()
    if (partial.has(name)) continue
    const e = bySource.get(name)
    if (e) absorbed.push([name, e])
    else empty.push(name)
  }
  if (absorbed.length) {
    console.log(`\n${absorbed.length} log file(s) fully absorbed — safe to delete:`)
    for (const [name, e] of absorbed.sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${String(e.total).padStart(4)} flights (${e.novel} new)  ${name}`)
    }
  }
  if (empty.length) {
    console.log(`\n${empty.length} log file(s) hold no batted balls — nothing to preserve:`)
    for (const name of empty) console.log(`       —              ${name}`)
  }
  if (partial.size) {
    console.log(`\n${partial.size} log file(s) NOT fully absorbed — keep these:`)
    for (const name of partial) console.log(`  ${name}`)
  }
  console.log('\nNow run --verify before deleting any logs.')
  return 0
}

process.exit(main())
