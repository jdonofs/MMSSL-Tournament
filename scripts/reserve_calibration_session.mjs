// Set a whole recorded session aside for the untouched test partition.
//
//   node scripts/reserve_calibration_session.mjs --list
//   node scripts/reserve_calibration_session.mjs --session wario_stadium-20260910T... --reason "..."
//   node scripts/reserve_calibration_session.mjs --release wario_stadium-20260910T...
//
// WHY. The Catch Probability activation standard needs an untouched final test
// of at least 100 opportunities and 20 failures, and
// docs/catch-probability-calibration-2026-09-05.md is explicit about how to get
// one: "reserve complete new sessions for test rather than topping up with
// individual plays". Nothing could express that. The split was a pure function
// of a SHA-256 ordering, so a game recorded specifically to be held out had a
// 60% chance of landing in train, and nobody found out until after it was
// fitted on.
//
// WHAT IT WILL NOT DO. It refuses to reserve a session that the CURRENT split
// already assigns to train or validation. Reserving a session for test after a
// model has been fitted on it is leakage with extra steps, and a tool that
// allowed it would be a tool for improving a held-out score by choosing the
// hold-out afterwards. Releasing a reservation is allowed and is recorded.
//
// It never refits, never activates and never touches a model artifact. The
// only thing it writes is the reservation list, which
// scripts/calibrate_catch_probability.mjs reads on its next run.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const RESERVATIONS_PATH = path.resolve(
  'data/calibration/catch-probability-test-reservations-v1.json')
const SPLIT_PATH = path.resolve('data/calibration/catch-probability-split-v1.json')
const TRACKING_DIR = path.resolve('data/player_tracking')

const PARTITIONS = new Set(['test', 'validation'])

export function readReservations(filePath = RESERVATIONS_PATH) {
  if (!fs.existsSync(filePath)) {
    return { schema_version: 1, reservations: [], released: [] }
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return {
    schema_version: parsed.schema_version || 1,
    reservations: Array.isArray(parsed.reservations) ? parsed.reservations : [],
    released: Array.isArray(parsed.released) ? parsed.released : [],
  }
}

function writeReservations(document, filePath = RESERVATIONS_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify({
    schema_version: 1,
    note: 'Whole sessions set aside for a partition before they were ever fitted on. '
      + 'scripts/catch_probability_model.mjs honours these ahead of the hash ordering; '
      + 'the split artifact records which ones it used.',
    ...document,
  }, null, 2)}\n`)
}

function readSplit() {
  if (!fs.existsSync(SPLIT_PATH)) return null
  return JSON.parse(fs.readFileSync(SPLIT_PATH, 'utf8'))
}

function parseArgs(argv) {
  const args = { partition: 'test' }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--list') args.list = true
    else if (flag === '--session') args.session = argv[++index]
    else if (flag === '--release') args.release = argv[++index]
    else if (flag === '--reason') args.reason = argv[++index]
    else if (flag === '--by') args.by = argv[++index]
    else if (flag === '--partition') args.partition = argv[++index]
    else if (flag === '--force') args.force = true
    else if (flag === '--help' || flag === '-h') args.help = true
  }
  return args
}

/**
 * Reserve one session, or explain why it cannot be reserved.
 *
 * `force` exists for the one legitimate case: a session whose plays were only
 * ever counted by a split the operator is about to discard. It is recorded in
 * the reservation so a later reader can see the override was deliberate.
 */
export function reserveSession({
  session,
  partition = 'test',
  reason = null,
  by = null,
  force = false,
  split = readSplit(),
  document = readReservations(),
  captureExists = (stem) => fs.existsSync(path.join(TRACKING_DIR, `${stem}.json`)),
} = {}) {
  if (!session) throw new Error('--session is required')
  if (!PARTITIONS.has(partition)) {
    throw new Error(`--partition must be one of ${[...PARTITIONS].join(', ')}`)
  }
  if (!captureExists(session)) {
    throw new Error(`no capture named ${session} in ${TRACKING_DIR}. Reserve a session that exists, `
      + 'so the reservation cannot silently point at nothing.')
  }
  if (document.reservations.some((entry) => entry.session === session)) {
    return { changed: false, reason: 'already reserved', document }
  }
  const current = split?.by_session?.[session] || null
  if (current && current !== partition && !force) {
    throw new Error(
      `${session} is already in the ${current} partition of the published split. Reserving it for `
      + `${partition} now would hold out a session that has already been fitted on, which is `
      + 'leakage. Reserve sessions BEFORE they are calibrated with, or pass --force if this '
      + 'split is being discarded (the override is recorded).',
    )
  }
  document.reservations.push({
    session,
    partition,
    reserved_at: new Date().toISOString(),
    reserved_by: by,
    reason,
    previous_partition: current,
    forced: Boolean(force && current && current !== partition),
  })
  return { changed: true, document }
}

export function releaseSession(session, { document = readReservations(), by = null } = {}) {
  const index = document.reservations.findIndex((entry) => entry.session === session)
  if (index < 0) return { changed: false, reason: 'not reserved', document }
  const [removed] = document.reservations.splice(index, 1)
  // Kept rather than deleted: a hold-out that was released and then re-created
  // differently is exactly the history a reader of a model artifact needs.
  document.released.push({ ...removed, released_at: new Date().toISOString(), released_by: by })
  return { changed: true, document }
}

function report(document, split) {
  if (!document.reservations.length) {
    console.log('No sessions are reserved.')
    console.log('The split is decided entirely by the deterministic hash ordering.')
  } else {
    console.log(`${document.reservations.length} reserved session(s):`)
    for (const entry of document.reservations) {
      const active = split?.by_session?.[entry.session]
      console.log(`  ${entry.session.padEnd(40)} -> ${entry.partition}`
        + (active ? `  (current split: ${active})` : '  (not in the current split yet)')
        + (entry.forced ? '  [FORCED]' : ''))
      if (entry.reason) console.log(`      ${entry.reason}`)
    }
  }
  if (document.released.length) {
    console.log()
    console.log(`${document.released.length} released reservation(s) kept as history.`)
  }
  console.log()
  console.log('Reservations take effect on the next `node scripts/calibrate_catch_probability.mjs`.')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node scripts/reserve_calibration_session.mjs --list')
    console.log('node scripts/reserve_calibration_session.mjs --session <stem> [--partition test] '
      + '[--reason "..."] [--by name] [--force]')
    console.log('node scripts/reserve_calibration_session.mjs --release <stem>')
    return 0
  }
  const split = readSplit()
  if (args.release) {
    const result = releaseSession(args.release, { by: args.by })
    if (result.changed) writeReservations(result.document)
    console.log(result.changed ? `Released ${args.release}.` : `${args.release} was not reserved.`)
    report(readReservations(), split)
    return 0
  }
  if (args.session) {
    const result = reserveSession({
      session: args.session,
      partition: args.partition,
      reason: args.reason,
      by: args.by,
      force: args.force,
      split,
    })
    if (result.changed) writeReservations(result.document)
    console.log(result.changed
      ? `Reserved ${args.session} for ${args.partition}.`
      : `${args.session} was ${result.reason}.`)
    report(readReservations(), split)
    return 0
  }
  report(readReservations(), split)
  return 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
