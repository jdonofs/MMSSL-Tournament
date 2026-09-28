// Join a derived 60 Hz player-tracking session to persisted plate appearances
// and load normalized fielding/throw facts into Supabase.
//
//   node scripts/ingest_player_tracking.mjs --session data/player_tracking/<stem>

// game/source metadata normally comes from the collector header in bridge
// sidecar mode. --game-id/--competition-type can override it for old sessions.

import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import {
  METRES_TO_FEET,
  MPS_TO_MPH,
  RUNNER_SLOT_BY_ORIGIN,
  extraBaseContext,
  normalizeRunnerAssignments,
} from '../src/utils/advancedDefense.js'
import { HOME_PLATE, WALL_HEIGHT_UNITS, fenceRadiusAt } from '../src/utils/parkGeometry.js'
import { buildGimmickEvents, buildStadiumRunsInput } from '../src/utils/gimmickLuck.js'
import { buildStadiumIncidents, stadiumDecidedFielding } from '../src/utils/stadiumIncidents.js'
import { buildPlayMechanics } from '../src/utils/playerMechanics.js'
import { fielderCoversPa } from '../src/utils/fielderStints.js'
import { trackerPitchStatFields, trackerPlayIsNicePlay } from './tracker_play_events.mjs'
import { createAdvancedMetricsClient, recomputeAdvancedMetrics } from './recompute_advanced_metrics.mjs'
import {
  indexCharactersByName,
  normalizeCharacterName,
  resolveTrackerCharacterId,
  unresolvableTrackerCharacters,
} from './tracker_character_ids.mjs'
import {
  insertOneReconciled,
  insertRowsReconciled,
  selectByKey,
  updateRowsVerified,
} from './tracker_persistence.mjs'

const POSITION_NUMBER = { P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9 }
const BATTED_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'ROE', 'FC', 'GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'TP'])
// Bumped for the stadium-incident contract. The checksum identifies the
// persisted INTERPRETATION, not only the bytes on disk, so raising this makes a
// deliberate re-ingest build a versioned replacement session even when the
// derived play file is byte-for-byte identical -- which is exactly the case for
// every session already on disk.
const INGEST_NORMALIZATION_VERSION = 'tracking-v4-close-play-runner-v1'

// The inverse of RUNNER_SLOT_BY_ORIGIN, named once: the measured runner rows
// and the close-play contest both have a capture slot in hand and need the
// origin base the scorebook's runner assignments are keyed by.
const RUNNER_ORIGIN_BY_SLOT = Object.freeze(Object.fromEntries(
  Object.entries(RUNNER_SLOT_BY_ORIGIN)
    .filter(([origin]) => origin !== 'plate')
    .map(([origin, slot]) => [slot, origin]),
))
// A session version written play by play during the game by
// scripts/tracker_live_tracking_persistence.mjs. Readers treat it like any
// active version; the postgame ingest always replaces it.
export const LIVE_SESSION_STATUS = 'live'

// Capture-derived pitch fields that may be restated after the game. Scoring
// fields are deliberately absent: the tracker log remains authoritative for a
// pitch's result, while the 60 Hz capture is authoritative for the batter input
// and plate location that the log cannot see.
const DERIVED_PITCH_EVIDENCE_FIELDS = Object.freeze([
  'is_star_pitch',
  'swing_offer',
  'swing_mode',
  'swing_mode_source',
  'swing_charge_frames',
  'swing_charge_release_timing_frames',
  'plate_x_units',
  'plate_y_units',
  'plate_z_units',
  'pitch_zone',
  'pitch_zone_source',
  'is_chase',
])

/**
 * Day, night, or genuinely unknown -- never guessed from the park.
 *
 * Sessions recorded before 2026-09-02 carry no day/night bytes at all, and
 * "unknown" is a real third answer: two Luigi's Mansion captures sit in exactly
 * that state, and calling them day would invent an exposure denominator. Kept
 * in step with timeOfDayFor() in scripts/review_stadium_events.mjs.
 */
function captureTimeOfDay(header = {}) {
  if (header.is_night === true) return 'night'
  if (header.is_night === false) return 'day'
  const bytes = header.day_night_bytes
  if (Array.isArray(bytes) && bytes.length) return bytes.some((value) => value) ? 'night' : 'day'
  return 'unknown'
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) continue
    const key = argv[index].slice(2)
    args[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true
  }
  return args
}

export function sessionStem(value) {
  const resolved = path.resolve(String(value || ''))
  return resolved.replace(/\.(?:plays\.jsonl|calibration\.json|json|bin)$/i, '')
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) } catch (error) {
      throw new Error(`${filePath}:${index + 1}: ${error.message}`)
    }
  })
}

export function recordedTimestamp(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : null
}

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function sameDerivedPitchPa(left, right) {
  return Number(left?.inning) === Number(right?.inning)
    && Number(left?.inning_half) === Number(right?.inning_half)
    && Number(left?.batter_index) === Number(right?.batter_index)
    && Number(left?.batter_id) === Number(right?.batter_id)
}

/**
 * Split the capture's chronological pitch stream into plate appearances.
 *
 * A batter can bat around in the same inning, so the identity tuple alone is
 * not a key. The game's pitch counter resetting to one is the boundary in that
 * case; otherwise a change of inning/half/batter is the boundary.
 */
export function groupDerivedPitches(pitches = []) {
  const groups = []
  for (const pitch of pitches || []) {
    const current = groups.at(-1)
    const previous = current?.at(-1)
    const pitchNumber = finite(pitch?.pitch_in_pa)
    const previousNumber = finite(previous?.pitch_in_pa)
    if (!current || !sameDerivedPitchPa(previous, pitch)
        || (pitchNumber != null && previousNumber != null && pitchNumber <= previousNumber)) {
      groups.push([pitch])
    } else {
      current.push(pitch)
    }
  }
  return groups
}

function sortedPlateAppearances(rows = []) {
  return [...rows].sort((left, right) => {
    const leftNumber = finite(left?.pa_number)
    const rightNumber = finite(right?.pa_number)
    if (leftNumber != null && rightNumber != null && leftNumber !== rightNumber) {
      return leftNumber - rightNumber
    }
    return String(left?.created_at || '').localeCompare(String(right?.created_at || ''))
  })
}

function derivedPitchEvidenceFields(pitch) {
  const all = trackerPitchStatFields(pitch)
  return Object.fromEntries(DERIVED_PITCH_EVIDENCE_FIELDS
    // A positive meter spend is exact evidence. Zero/absent meter data is not
    // permission to erase a star flag supplied by the live tracker or scorer.
    .filter((field) => Object.hasOwn(all, field) && (field !== 'is_star_pitch' || all[field] === true))
    .map((field) => [field, all[field]]))
}

/**
 * Plan the postgame restatement of capture-only evidence onto canonical pitch
 * rows. This never writes scoring results and never guesses a PA when the
 * capture named a batter that does not match the scorebook.
 */
export function planDerivedPitchEvidenceUpdates({
  derivedPitches = [], plateAppearances = [], pitchRows = [], charactersByName,
} = {}) {
  const groups = groupDerivedPitches(derivedPitches)
  const pas = sortedPlateAppearances(plateAppearances)
  const unused = new Set(pas.map((_, index) => index))
  const pitchRowByPaAndNumber = new Map((pitchRows || []).map((row) => [
    `${String(row.pa_id)}:${String(row.pitch_number_pa)}`, row,
  ]))
  const updates = []
  const unmatchedGroups = []
  const unmatchedPitches = []
  let floor = 0

  for (const group of groups) {
    const first = group[0]
    const batterId = resolveTrackerCharacterId(first?.batter_id, charactersByName)
    const candidates = [...unused].filter((index) => index >= floor)
    const exact = batterId == null ? null : candidates.find((index) => (
      Number(pas[index]?.inning) === Number(first?.inning)
      && Number(pas[index]?.character_id) === Number(batterId)
    ))
    // Only an unresolvable game character may fall back to order. A resolved
    // batter that disagrees with the scorebook is evidence against the join.
    const selected = exact ?? (batterId == null
      ? candidates.find((index) => Number(pas[index]?.inning) === Number(first?.inning))
      : null)
    if (selected == null) {
      unmatchedGroups.push({
        inning: first?.inning ?? null,
        inning_half: first?.inning_half ?? null,
        batter: first?.batter ?? null,
        batter_id: first?.batter_id ?? null,
        pitches: group.length,
      })
      continue
    }
    const pa = pas[selected]
    unused.delete(selected)
    floor = selected + 1
    for (const pitch of group) {
      const pitchNumber = finite(pitch?.pitch_in_pa)
      const row = pitchNumber == null ? null
        : pitchRowByPaAndNumber.get(`${String(pa.id)}:${String(pitchNumber)}`)
      if (!row) {
        unmatchedPitches.push({
          pa_id: pa.id,
          pa_number: pa.pa_number ?? null,
          pitch_number_pa: pitchNumber,
          pitch_timer: pitch?.pitch_timer ?? null,
        })
        continue
      }
      updates.push({
        id: row.id,
        pa_id: pa.id,
        pa_number: pa.pa_number ?? null,
        pitch_number_pa: pitchNumber,
        fields: derivedPitchEvidenceFields(pitch),
      })
    }
  }
  return { updates, matchedGroups: groups.length - unmatchedGroups.length, unmatchedGroups, unmatchedPitches }
}

async function persistDerivedPitchEvidence(supabase, {
  table, derivedPitches, plateAppearances, pitchRows, charactersByName, warn,
}) {
  const plan = planDerivedPitchEvidenceUpdates({
    derivedPitches, plateAppearances, pitchRows, charactersByName,
  })
  for (const update of plan.updates) {
    await updateRowsVerified(supabase, table, { id: update.id }, update.fields)
  }
  if (plan.unmatchedGroups.length) {
    warn(`capture pitch evidence left ${plan.unmatchedGroups.length} plate-appearance group(s) `
      + 'unmatched; no batter-input fields were guessed for them')
  }
  if (plan.unmatchedPitches.length) {
    warn(`capture pitch evidence found ${plan.unmatchedPitches.length} pitch(es) absent from the `
      + `${table} scoring rows; they remain in the capture artifact only`)
  }
  return plan
}

function positionDirection(start, end) {
  if (!Array.isArray(start) || !Array.isArray(end)) return null
  const dx = finite(end[0], 0) - finite(start[0], 0)
  const dz = finite(end[2], 0) - finite(start[2], 0)
  const depth = dz < -0.25 ? 'back' : dz > 0.25 ? 'in' : ''
  const side = dx < -0.25 ? 'left' : dx > 0.25 ? 'right' : ''
  return [depth, side].filter(Boolean).join('_') || 'stationary'
}

function positioningFromRelease(start) {
  if (!Array.isArray(start) || finite(start[0]) == null || finite(start[2]) == null) {
    return { depthFeet: null, angleDeg: null }
  }
  const x = finite(start[0])
  const z = finite(start[2])
  return {
    depthFeet: Math.hypot(x, z) * METRES_TO_FEET,
    angleDeg: Math.atan2(x, -z) * 180 / Math.PI,
  }
}

// How a catch sat against the wall, from the measured fence for this park.
//
// This is the only way a robbed home run is identifiable. The game does not
// raise its home-run flag on one -- across six catches made off the ground in
// the Bowser Castle session it read false every time -- so a ball taken back
// over the fence is, in the game's own flags, an ordinary fly out. It is also
// the hardest opportunity a catch-probability model will ever be shown, so
// leaving it in the routine bucket would flatten the top of the difficulty
// range rather than merely add noise.
//
// The measurement holds up: Tiny Kong's first-inning catch was 1.2u BEYOND the
// fence line with the ball 4.335u up, against a wall top measured independently
// from ball strikes at 4.645u. He was reaching over the top of the wall.
function wallContext(park, at, ballHeightUnits) {
  const x = finite(at?.[0])
  const z = finite(at?.[2])
  if (x == null || z == null) return { beyondFenceM: null, robbedHomeRun: null }
  const dx = x - HOME_PLATE.x
  const dz = z - HOME_PLATE.z
  const fence = fenceRadiusAt(park, Math.atan2(dx, -dz) * 180 / Math.PI)
  if (fence == null) return { beyondFenceM: null, robbedHomeRun: null }
  const beyond = Math.hypot(dx, dz) - fence
  const height = finite(ballHeightUnits, 0)
  return {
    beyondFenceM: beyond,
    // At the wall and off the ground. Both halves matter: a ball fielded on the
    // warning track is not a robbery, and neither is a leap in the infield.
    robbedHomeRun: beyond >= -BODY_REACH_UNITS && height >= WALL_HEIGHT_UNITS / 2,
  }
}

// A character can reach this far inside the fence line and still take a ball
// that was leaving. Deliberately about one body width rather than zero, because
// the fence radius is measured to the padding and a fielder cannot stand in it.
const BODY_REACH_UNITS = 1.5

function eligiblePa(pa) {
  return BATTED_RESULTS.has(pa.result) || Boolean(pa.trajectory) || finite(pa.tracker_contact_seq) != null
}

// Which of the derived classes put the ball in fair territory. The classes come
// from the game's own fair/foul and home-run flags, read inside the live window
// -- both are cleared on the frame the play closes, so an earlier version that
// read them from the final frame saw 0 for every batted ball and called the
// whole session fair.
const FAIR_CLASSES = new Set(['fair_in_play', 'fair_caught', 'home_run', 'home_run_robbed'])

export function playLooksFair(play) {
  if (!play.batted_ball_class) {
    throw new Error(
      'This session was derived before batted-ball classification existed, so '
      + 'its fair/foul labels cannot be trusted. Re-run '
      + 'scripts/derive_player_metrics.py on it before ingesting.',
    )
  }
  return FAIR_CLASSES.has(play.batted_ball_class)
}

// The batter the tracker names, as a ROSTER character id. `play.batter_id` is
// the game's own id and `pa.character_id` is this app's, and comparing them
// directly is the bug that made this join look like it worked: the ids overlap
// almost perfectly and name different characters, so the exact match never
// fires and every play silently falls back to positional order.
function matchPlaysToPas(plays, plateAppearances, charactersByName) {
  const pas = [...plateAppearances].filter(eligiblePa).sort((a, b) => finite(a.pa_number, 0) - finite(b.pa_number, 0))
  const unused = new Set(pas.map((_, index) => index))
  let floor = 0
  return plays.map((play) => {
    if (!playLooksFair(play)) return { pa: null, method: 'non_fair', confidence: 1 }
    const candidates = [...unused].filter((index) => index >= floor)
    const batterId = resolveTrackerCharacterId(play.batter_id, charactersByName)
    const exact = batterId == null ? null : candidates.find((index) => (
      finite(pas[index].character_id) === batterId
      && finite(pas[index].inning, 1) === finite(play.inning, 1)
    ))
    // The batter matches but the inning does not. That happens when one side
    // recorded the half-inning boundary a play early, so the fallback is
    // deliberately narrow: an adjacent inning only. Reaching further ahead is
    // not a repair, it is a different trip to the plate -- and because
    // `floor` only moves forward, taking it strands every play behind it. One
    // such jump in the Luigi's Mansion recording (a fifth-inning play matched
    // to the same batter's seventh-inning PA) cost 19 of 77 fair plays.
    const batterOnly = exact == null && batterId != null ? candidates.find((index) => (
      finite(pas[index].character_id) === batterId
      && Math.abs(finite(pas[index].inning, 1) - finite(play.inning, 1)) <= 1
    )) : null
    // Position alone, and only when the batter could not be resolved at all.
    // A play whose batter IS known and does not match is evidence against the
    // link, not for it: attaching it anyway put twelve fielding trees on other
    // batters' plate appearances, which reads as a fielder making a catch on
    // someone else's at-bat rather than as an error.
    const selected = exact ?? batterOnly ?? (batterId == null ? candidates[0] : null)
    if (selected == null) return { pa: null, method: 'unmatched', confidence: 0 }
    unused.delete(selected)
    floor = selected + 1
    return {
      pa: pas[selected],
      method: exact != null ? 'inning+batter+order' : batterOnly != null ? 'batter+order' : 'order_only',
      confidence: exact != null ? 0.98 : batterOnly != null ? 0.82 : 0.55,
    }
  })
}

// `at` is the plate appearance ({ inning, pa_number }) the play belongs to.
function activeFielder(fielders, position, at) {
  return fielders.find((row) => (
    Number(row.position) === Number(position) && fielderCoversPa(row, at)
  )) || null
}

function fielderIdentity(fielders, seasonTeamPlayerById, charactersByName, position, at, trackedCharacterId) {
  const positional = activeFielder(fielders, POSITION_NUMBER[position], at)
  const characterIdOf = (row) => charactersByName.get(normalizeCharacterName(row?.character))?.id
  // The capture's character first: it saw who stood at this position on this
  // play. The scorebook only knows who held it for the INNING, and a position
  // change mid-inning rewrites that row -- which handed Toadette's first-inning
  // catch in RF to Red Pianta when he moved in behind her. The scorebook name
  // is the fallback for characters the game's table cannot name (every Mii).
  // Never the raw tracked id -- see tracker_character_ids.mjs for why that
  // writes the wrong player.
  const trackedId = resolveTrackerCharacterId(trackedCharacterId, charactersByName)
  const tracked = trackedId == null ? null : fielders.find((row) => (
    characterIdOf(row) === trackedId
    && (!positional || String(row.team_id) === String(positional.team_id))
  ))
  const row = tracked || positional
  const characterId = trackedId ?? characterIdOf(positional)
  const playerId = row
    ? seasonTeamPlayerById.get(String(row.team_id)) || row.team_id || null
    : null
  return { row, characterId, playerId }
}

// Warned once per process, not once per play: a missing table is one fact
// about the database, and 400 copies of it hides the rest of the report.
let warnedMissingCatchApproaches = false

// WHAT "ALREADY COMPLETE" MEANS, and why it is keys rather than totals.
//
// The check this replaced compared four numbers: one total per table across
// the whole session. Two separate faults came out of that.
//
// It could not see tracking_catch_approaches at all, so a session ingested
// against a database that did not yet have the table read as complete forever
// afterwards and the reach measurements were never saved -- the ordinary retry
// that should have repaired them returned without writing anything.
//
// And a total is not an identity. A child set holding two fielding rows for
// one play and none for the next sums to exactly the expected total, so a
// skewed tree reads as finished. These are the same natural keys
// insertRowsReconciled reconciles each row on, so "complete" now means what
// the writer means by it.
const KEY_FIELD_SEPARATOR = '\u0000'
// Each child table and the key columns that identify a row within its play.
// The play itself is carried by its ORDINAL rather than its id, so the
// comparison is about the capture rather than about which ids a previous
// attempt happened to allocate.
const FACT_TABLES = {
  fielding: { table: 'fielding_opportunities', keyColumns: ['position'] },
  movement: { table: 'movement_metrics', keyColumns: ['actor_type', 'actor_slot'] },
  throws: { table: 'tracking_throws', keyColumns: ['throw_sequence'] },
  catchApproaches: { table: 'tracking_catch_approaches', keyColumns: ['position', 'start_frame'] },
}
// Bounded on purpose. The read this replaced put every play id of the session
// into one in(...), which is a URL that grows with the game; a real Postgres
// is untroubled by it, the gateway in front of it is not.
const PLAY_ID_CHUNK = 200

function factKey(...parts) {
  return parts.map((part) => (part == null ? '' : String(part))).join(KEY_FIELD_SEPARATOR)
}

function emptyFactKeys() {
  return {
    plays: new Set(),
    ...Object.fromEntries(Object.keys(FACT_TABLES).map((name) => [name, new Set()])),
  }
}

// Every row this capture is going to write, named the way the database will
// hold it. Built from the same expressions writeTrackingPlayFacts builds the
// rows from -- a key derived some other way would be a second definition of a
// fielding opportunity, which is the mistake that writer's own comment warns
// about.
function expectedFactKeys(plays) {
  const keys = emptyFactKeys()
  plays.forEach((play, index) => {
    const ordinal = index + 1
    keys.plays.add(factKey(ordinal))
    for (const position of Object.keys(play.fielders || {})) {
      keys.fielding.add(factKey(ordinal, position))
      keys.movement.add(factKey(ordinal, 'fielder', position))
    }
    for (const slot of Object.keys(play.runners || {})) {
      keys.movement.add(factKey(ordinal, slot === 'BAT' ? 'batter' : 'runner', slot))
    }
    const throwRows = (play.throws || []).filter((row) => row.is_throw !== false)
    throwRows.forEach((row, throwIndex) => {
      keys.throws.add(factKey(ordinal, row.sequence ?? throwIndex + 1))
    })
    for (const row of play.catch_approaches || []) {
      if (!row.position && !row.by) continue
      keys.catchApproaches.add(factKey(ordinal, row.by, finite(row.start_frame)))
    }
  })
  return keys
}

// A missing TABLE, and nothing else -- the same narrow reading
// beginSessionReplacement takes of a missing function, for the same reason. A
// missing column (42703, PGRST204), a permission failure (42501) and a
// statement timeout all carry their own code, and reading one of those as
// "this database does not have the feature" would hide a real fault behind a
// zero.
function isMissingTableError(error) {
  const code = String(error?.code || '')
  if (code === 'PGRST205' || code === '42P01') return true
  if (code) return false
  return /relation [^ ]* does not exist|could not find the table/i
    .test(String(error?.message || ''))
}

// Every page, never the first thousand rows. The un-ranged reads this replaced
// counted whatever PostgREST chose to return, and src/utils/fetchAllRows.js
// documents that as 1,000 -- so a session with more fielding or movement rows
// than that (21 of the 59 derived sessions on disk) read as incomplete and was
// reconciled row by row on every retry.
async function readAllRows(supabase, table, columns, filter) {
  const { data, error } = await fetchAllRows(() => filter(supabase.from(table).select(columns)))
  if (error) throw error
  return data || []
}

/**
 * The keys of the fact rows a session already holds.
 *
 * `supported.catchApproaches` is false only when the table itself is absent:
 * the deliberate degradation the writer makes, stated here as well so the
 * completeness decision can leave that fact out openly rather than count zero
 * of them and call the session finished.
 */
async function existingFactKeys(supabase, trackingSessionId) {
  const keys = emptyFactKeys()
  const supported = { catchApproaches: true }
  // Rows read, beside keys held. A duplicate collapses into the set, so a
  // tree with one play written twice would read as complete on keys alone.
  // Every one of these natural keys is backed by a unique index that
  // 20260908120000 creates -- but that migration SKIPS a table that was not
  // present when it ran, quietly, so whether a given deployment actually holds
  // the index is not something this can assume. Counting the rows as well
  // costs nothing and does not depend on the answer.
  const rowCounts = { plays: 0, ...Object.fromEntries(Object.keys(FACT_TABLES).map((name) => [name, 0])) }
  const playRows = await readAllRows(supabase, 'tracking_plays', 'id,play_ordinal',
    (query) => query.eq('tracking_session_id', trackingSessionId))
  const ordinalByPlayId = new Map()
  rowCounts.plays = playRows.length
  for (const row of playRows) {
    ordinalByPlayId.set(String(row.id), row.play_ordinal)
    keys.plays.add(factKey(row.play_ordinal))
  }
  if (!playRows.length) return { keys, supported, rowCounts }
  const playIds = playRows.map((row) => row.id)
  for (const [name, { table, keyColumns }] of Object.entries(FACT_TABLES)) {
    const columns = ['tracking_play_id', ...keyColumns].join(',')
    for (let from = 0; from < playIds.length; from += PLAY_ID_CHUNK) {
      const chunk = playIds.slice(from, from + PLAY_ID_CHUNK)
      let rows
      try {
        rows = await readAllRows(supabase, table, columns, (query) => query.in('tracking_play_id', chunk))
      } catch (error) {
        if (name !== 'catchApproaches' || !isMissingTableError(error)) throw error
        supported.catchApproaches = false
        if (!warnedMissingCatchApproaches) {
          warnedMissingCatchApproaches = true
          console.warn('  tracking_catch_approaches is missing; catch reach not persisted.')
          console.warn('  Apply supabase/migrations/20260920130000_tracking_catch_approaches.sql')
        }
        break
      }
      rowCounts[name] += rows.length
      for (const row of rows) {
        keys[name].add(factKey(
          ordinalByPlayId.get(String(row.tracking_play_id)),
          ...keyColumns.map((column) => row[column]),
        ))
      }
    }
  }
  return { keys, supported, rowCounts }
}

/**
 * What a stored session still owes this capture, per fact table, or [] when it
 * owes nothing.
 *
 * Rows that are there and are not expected count too. A child set that is not
 * the expected one is not a finished ingest even when nothing is missing from
 * it, and naming them is the difference between a rebuild that says why and
 * one that looks like a loop.
 */
function outstandingFacts(expected, existing) {
  const report = []
  for (const name of ['plays', ...Object.keys(FACT_TABLES)]) {
    if (existing.supported[name] === false) continue
    const want = expected[name]
    const have = existing.keys[name]
    const missing = [...want].filter((key) => !have.has(key)).length
    const unexpected = [...have].filter((key) => !want.has(key)).length
      + Math.max(0, (existing.rowCounts?.[name] ?? have.size) - have.size)
    if (missing || unexpected) report.push({ fact: name, missing, unexpected })
  }
  return report
}

function describeOutstanding(report) {
  return report.map(({ fact, missing, unexpected }) => (
    `${fact} ${missing} missing${unexpected ? `, ${unexpected} unexpected` : ''}`
  )).join('; ')
}

// Open a new version of a completed session, beside it.
//
// Returns null when this database has no such function, which is the signal to
// keep the old behaviour: refuse, and preserve the completed ingest. It is
// never an error to be missing -- the migration that adds it has to be applied
// by a person -- but it IS an error to replace a good session without it.
async function beginSessionReplacement(supabase, previous, payload, lease) {
  if (typeof supabase.rpc !== 'function') return null
  const { data, error } = await supabase.rpc('tracker_begin_session_replacement', {
    p_session_id: previous.id,
    p_payload: { ...payload, status: 'ingesting' },
    ...leaseArgs(lease),
  })
  if (error) {
    // Only a missing FUNCTION is the degraded case. A bare /does not exist/
    // also matches a missing column or table, and reading one of those as
    // "apply the migration" hid a real schema fault behind a refusal message
    // that named the wrong file.
    const code = String(error.code || '')
    const missing = code === 'PGRST202' || code === 'PGRST203' || code === '42883'
      || (!code && /could not find the function|function [^ ]* does not exist/i.test(String(error.message || '')))
    if (missing) return null
    throw error
  }
  return data?.session || null
}

// PostgREST reports a function that is not there as PGRST202/PGRST203 and
// Postgres itself as 42883. Narrow on purpose, for the reason
// beginSessionReplacement states: a missing column or table is a schema fault,
// not a migration nobody has run.
function isMissingRpc(error) {
  const code = String(error?.code || '')
  if (code === 'PGRST202' || code === 'PGRST203' || code === '42883') return true
  if (code) return false
  return /could not find the function|function [^ ]* does not exist/i.test(String(error?.message || ''))
}

// Move the active pointer, and everything official that points at a version,
// in the database's own transaction -- under the lease, which it asserts.
//
// Idempotent, and used by a FIRST ingest as well as a replacement. A first
// ingest's session is already the active one, so the call comes back
// `already_active` and does the only part that is left: applying the official
// links. That is the point. Those links -- the plate appearance's tracking
// pointer, the runner and double-play opportunities' tracking_play_id, the
// measured runner kinematics -- are rows the SITE reads and another owner of
// the same game could be writing, and the ingest used to write them one
// unfenced update at a time.
//
// Returns null when this database has no such function, which is the signal to
// write them directly as the ingest did before there was one.
async function activateSessionVersion(supabase, session, lease, runnerFacts) {
  if (typeof supabase.rpc !== 'function') return null
  const { data, error } = await supabase.rpc('tracker_activate_session_version', {
    p_session_id: session.id,
    ...leaseArgs(lease),
    p_official_links: { runner_opportunities: runnerFacts || [] },
  })
  if (error) {
    if (isMissingRpc(error)) return null
    throw error
  }
  if (!data?.activated && data?.reason !== 'already_active') {
    throw new Error(`the replacement session ${session.id} was built but not activated`)
  }
  return data
}

/**
 * The official links, written one request at a time.
 *
 * The pre-versioning path, kept only for a database that has no
 * tracker_activate_session_version(). It is NOT fenced -- each update is its
 * own transaction and the lease is checked by the caller before them all --
 * which is exactly the guarantee the migration exists to add, and is why this
 * is the fallback rather than the route.
 */
async function applyOfficialLinksDirectly(supabase, {
  paTable, competitionType, gameId, sessionId, playLinks, runnerFacts,
}) {
  for (const link of playLinks) {
    await updateRowsVerified(supabase, paTable, { id: link.paId }, {
      tracking_contact_frame: link.contactFrame,
      tracking_session_id: sessionId,
    })
    await Promise.all([
      updateRowsVerified(supabase, 'runner_opportunities', {
        competition_type: competitionType, game_id: gameId, pa_id: link.paId,
      }, { tracking_play_id: link.trackingPlayId }, { allowMissing: true }),
      updateRowsVerified(supabase, 'double_play_opportunities', {
        competition_type: competitionType, game_id: gameId, pa_id: link.paId,
      }, { tracking_play_id: link.trackingPlayId }, { allowMissing: true }),
    ])
  }
  for (const measured of runnerFacts) {
    const { id, ...values } = measured
    await updateRowsVerified(supabase, 'runner_opportunities', { id }, values)
  }
}

/**
 * Set is_nice_play from the joined capture, where the live bridge could not.
 *
 * Separate from the official links because those move with the fenced
 * activation transaction and this does not: it is an ordinary column on a row
 * that already exists, derived from a play the activation has just confirmed
 * belongs to it. Only rows whose stored value actually differs are written, so
 * a re-run of a finished session writes nothing.
 */
async function applyCaptureDerivedPaFields(supabase, { paTable, playLinks }) {
  const changed = playLinks.filter((link) => (
    !link.corrected && typeof link.isNicePlay === 'boolean' && link.isNicePlay !== link.storedNicePlay
  ))
  for (const link of changed) {
    await updateRowsVerified(supabase, paTable, { id: link.paId }, { is_nice_play: link.isNicePlay })
  }
  // Reported in the summary rather than as a warning: correcting a column the
  // live pass could not derive is this pass's job, not a surprise. A re-run of
  // a finished session writes nothing and reports zero.
  return changed.length
}

// WHAT IS LEFT TO DO AFTER THE RAW FACTS ARE SAVED, written down where it
// survives the process.
//
// Ingesting a session is two halves. The raw half -- tracking_plays and their
// fielding, movement and throw rows -- is reconciled by natural key, so a
// re-run of an interrupted one converges. The DERIVED half is not: moving the
// active pointer and recomputing the advanced metrics leave no rows a later
// run can compare against, so a failure in either one was invisible to the
// next attempt. A replacement that activated and then failed to recompute was
// marked `ingested`, was active, and had exactly the fact counts the input
// expected -- so the retry read "already complete" and returned without
// recomputing anything, permanently. The unfinished stage is now recorded on
// the session itself and resumed rather than inferred from counts that cannot
// express it.
export const DERIVED_STAGES = ['activate', 'recompute']

/** The derived stage a session still owes, or null when it owes nothing. */
export function pendingDerivedStage(session) {
  const stage = session?.quality?.derived_stage
  return DERIVED_STAGES.includes(stage) ? stage : null
}

/**
 * The official links a pending activation still owes, rebuilt from the raw
 * facts the interrupted run had already committed.
 *
 * THE STAGED LIST DIED WITH THE PROCESS THAT BUILT IT, and retrying the
 * activation with an empty one is worse than not retrying at all: the call
 * moves the pointer, re-derives the links it can derive, answers `activated`,
 * and leaves the measured runner kinematics -- which it can only get from the
 * caller -- missing for good, with the stage cleared behind it. `is_active` is
 * no evidence to the contrary: a FIRST ingest's session is already the active
 * one before activation is ever called, so it is true for a session whose
 * measurements never landed.
 *
 * Nothing here re-reads the capture. Every value the activation needs came from
 * a row the raw half wrote and verified before the stage was recorded --
 * movement_metrics for where each runner started and how fast, tracking_throws
 * for the throw the opportunity was timed against, tracking_plays for the
 * contact frame -- so the list is rebuilt from the database by the same rules
 * that staged it.
 */
async function reconstructOfficialLinks(supabase, session, { competitionType, gameId }) {
  const plays = await selectByKey(supabase, 'tracking_plays', { tracking_session_id: session.id })
  const playLinks = []
  const runnerFacts = []
  for (const play of plays) {
    if (play.pa_id == null) continue
    playLinks.push({
      paId: play.pa_id,
      trackingPlayId: play.id,
      contactFrame: finite(play.contact_frame),
    })
    const [opportunities, movement, throws] = await Promise.all([
      selectByKey(supabase, 'runner_opportunities', {
        competition_type: competitionType, game_id: gameId, pa_id: play.pa_id,
      }),
      selectByKey(supabase, 'movement_metrics', {
        tracking_play_id: play.id, actor_type: 'runner',
      }),
      selectByKey(supabase, 'tracking_throws', { tracking_play_id: play.id }),
    ])
    for (const opportunity of opportunities) {
      const slot = RUNNER_SLOT_BY_ORIGIN[opportunity.origin_base]
      const track = movement.find((row) => row.actor_slot === slot) || null
      // The same pairing the staging pass makes: the throw to the base this
      // opportunity is about, by the fielder it holds responsible when it names
      // one.
      const linkedThrow = throws.find((row) => (
        row.target_base === opportunity.target_base
        && (!opportunity.responsible_fielder_position
          || row.thrower_position === opportunity.responsible_fielder_position)
      ))
      runnerFacts.push({
        id: opportunity.id,
        runner_x: finite(track?.start_x),
        runner_z: finite(track?.start_z),
        runner_speed_mps: finite(track?.sprint_speed_mps),
        tracking_throw_id: linkedThrow?.id || null,
      })
    }
  }
  return { playLinks, runnerFacts }
}

/**
 * Finish the derived work a previous run recorded and did not complete.
 *
 * The raw facts are already in the database and are not touched: nothing here
 * re-reads the capture, re-inserts a play or opens another version. Only the
 * two steps that leave no reconcilable trace are re-run.
 *
 * WHAT IS RE-RUN IS THE WHOLE STAGE, not the part of it that needed no
 * arguments. The activation is repeated with the official links rebuilt from
 * the raw facts -- see reconstructOfficialLinks for why `is_active` does not
 * stand in for them -- and on a database with no versioning function the direct
 * writes that activation would have replaced are finished rather than skipped.
 * A lost response and a rolled-back transaction both land here and both
 * converge: every link is addressed by id and states the value it wants, so the
 * ones that did commit are rewritten unchanged.
 *
 * The stage comes off the session only after that work returns. Anything that
 * throws leaves it on the row for the next run to finish.
 */
async function resumeDerivedWork(supabase, session, {
  stage, lease, recompute, recomputeFn, warn, paTable, competitionType, gameId,
}) {
  const quality = { ...(session.quality || {}) }
  delete quality.derived_stage
  let modelSummary = null
  if (stage === 'activate') {
    // The raw facts and activation marker may have committed while the final
    // status update did not. Activation requires an ingested candidate, so a
    // retry must finish that transition before replaying the fenced step.
    if (session.status !== 'ingested') {
      await updateRowsVerified(supabase, 'tracking_sessions', { id: session.id }, {
        status: 'ingested', updated_at: new Date().toISOString(),
      })
    }
    warn(`tracking session ${session.id} was left with its activation unconfirmed; `
      + 'reapplying it rather than re-ingesting the capture')
    const { playLinks, runnerFacts } = await reconstructOfficialLinks(supabase, session, {
      competitionType, gameId,
    })
    const activated = await activateSessionVersion(supabase, session, lease, runnerFacts)
    if (!activated) {
      // No versioning function on this database, so the interrupted run was
      // writing these one update at a time and stopped partway through. The
      // same fallback finishes them.
      await applyOfficialLinksDirectly(supabase, {
        paTable, competitionType, gameId, sessionId: session.id, playLinks, runnerFacts,
      })
    }
    await recordDerivedStage(supabase, session, quality, 'recompute')
  } else {
    warn(`tracking session ${session.id} was ingested but its advanced-metric `
      + 'recomputation never finished; resuming it')
  }
  if (recompute) modelSummary = await recomputeFn(supabase)
  await recordDerivedStage(supabase, session, quality, null)
  return modelSummary
}

function withDerivedStage(quality, stage) {
  return { ...(quality || {}), derived_stage: stage }
}

async function recordDerivedStage(supabase, session, quality, stage) {
  await updateRowsVerified(supabase, 'tracking_sessions', { id: session.id }, {
    quality: withDerivedStage(quality, stage),
    updated_at: new Date().toISOString(),
  })
}

// What every fenced tracking function needs from the caller. A bridge hands in
// its live lease; an operator running this by hand states an unleased reason
// and the database records that it was stated -- see tracker_lease_assert.
function leaseArgs(lease) {
  return {
    p_owner_id: lease?.ownerId ?? null,
    p_epoch: lease?.epoch ?? null,
    p_unleased_intent: lease?.ownerId ? null : (lease?.unleasedIntent ?? null),
  }
}

/**
 * One play's tracking facts: its tracking_plays row and the fielding, movement
 * and throw rows under it.
 *
 * THE ONLY WRITER OF THOSE ROWS. The postgame ingest calls it once per play of
 * a finished session; the bridge calls it as each play arrives during the game
 * (scripts/tracker_live_tracking_persistence.mjs). Two row builders would be two
 * definitions of a fielding opportunity, and the live rows would quietly stop
 * meaning what the postgame rows mean.
 *
 * `decorateOpportunity` lets the live writer add the modelled catch-probability
 * columns before the row is written. `stageRunnerFacts` is off for the live
 * writer: the measured runner links are official rows that only the fenced
 * activation of a finished session may write.
 */
export async function writeTrackingPlayFacts(supabase, {
  play,
  playOrdinal,
  match,
  trackingSession,
  header = {},
  competitionType,
  gameId,
  fielders = [],
  seasonTeamPlayerById = new Map(),
  charactersByName,
  quarantined = false,
  decorateOpportunity = (row) => row,
  stageRunnerFacts = true,
}) {
  const runnerFacts = []
  const pa = match.pa
  // The game's fielder rows hold BOTH teams, and a position and inning alone
  // match one row from each; only the fielding side's can be on the field.
  if (pa?.defensive_team_id != null) {
    fielders = fielders.filter((row) => String(row.team_id) === String(pa.defensive_team_id))
  }
  const playAt = { inning: play.inning, pa_number: pa?.pa_number }
  const firstTouch = play.first_touch || null
  const primaryFielder = play.primary_fielder || firstTouch?.by || null
  const contact = play.contact_at || []
  const deflections = play.deflections || []
  const forcedMisplays = play.forced_misplays || []
  const buddyHandoffs = play.buddy_handoffs || []
  // ONE RESOLVER, used by both contracts, so luck and the descriptive
  // incidents can never disagree about who was on the field. Ownership is
  // resolved AT GAME TIME from that game's own fielder rows, which is what
  // stops a later roster move from rewriting historical credit.
  const resolveFielderIdentity = ({ position, characterId }) => {
    if (!position) return {}
    const identity = fielderIdentity(
      fielders, seasonTeamPlayerById, charactersByName,
      position, playAt, characterId,
    )
    return {
      position,
      playerId: identity.playerId,
      characterId: identity.characterId,
    }
  }
  // WHO WAS ON THE BASES, from the scorebook rather than from the capture. The
  // capture knows a slot and a tracker character id; the plate appearance knows
  // which runner is standing there, and that is the identity every official
  // baserunning row already uses.
  const runnerAssignments = new Map(normalizeRunnerAssignments(pa?.runner_assignments)
    .filter((row) => !row.isBatter).map((row) => [row.origin, row]))
  const resolveRunnerIdentity = ({ slot, characterId }) => {
    if (!slot) return {}
    if (slot === 'BAT') {
      return {
        slot,
        playerId: pa?.player_id || null,
        characterId: finite(pa?.character_id ?? resolveTrackerCharacterId(characterId, charactersByName)),
      }
    }
    const origin = RUNNER_ORIGIN_BY_SLOT[slot] || null
    const assignment = origin ? runnerAssignments.get(origin) : null
    return {
      slot,
      playerId: assignment?.runner?.playerId ?? assignment?.runner?.player_id ?? null,
      characterId: finite(assignment?.runner?.characterId ?? assignment?.runner?.character_id
        ?? resolveTrackerCharacterId(characterId, charactersByName)),
    }
  }
  const gimmickEvents = buildGimmickEvents(play, {
    plateAppearance: pa,
    resolveFielder: resolveFielderIdentity,
  })
  // THE DESCRIPTIVE SIDE, independent of luck. A luck event names a
  // beneficiary and an unlucky side; neither is necessarily the character the
  // stadium actually touched, so "times frozen" cannot be recovered from it.
  // See src/utils/stadiumIncidents.js.
  const stadiumIncidents = buildStadiumIncidents(play, {
    park: header.park || null,
    timeOfDay: captureTimeOfDay(header),
    competitionType,
    gameId,
    // The version is part of the identity: a replacement session's incidents
    // must not collide with the superseded version's while both are on disk.
    sessionVersion: finite(trackingSession.version, 1),
    playOrdinal,
    // Only used to reconstruct an absolute frame for an event the producer
    // recorded with a relative time alone -- a freeze derived before the
    // onset timer was carried. A session that never recorded the rate keeps
    // the Wii's NTSC clock, which is what every capture on disk actually ran.
    fps: finite(header.frame_rate, 59.94),
    resolveFielder: resolveFielderIdentity,
  })
  // What the park's interference was worth in runs. Only the facts are stored
  // here; recompute_advanced_metrics.mjs scores the catch and prices it, so a
  // better catch model or run table reprices every stored play.
  const stadiumRuns = buildStadiumRunsInput(play, {
    incidents: stadiumIncidents,
    plateAppearance: pa,
    park: header.park || null,
    resolveFielder: resolveFielderIdentity,
  })
  // The deliberate player mechanics the capture measures and nothing has ever
  // persisted: 538 Buddy attacks, 54 Buddy Jump windows, 14 close plays and
  // the causing side of every captain star swing. Kept apart from stadium
  // luck on purpose -- a fielder clearing a Freezie made a play.
  const playMechanics = buildPlayMechanics(play, {
    competitionType,
    gameId,
    sessionVersion: finite(trackingSession.version, 1),
    playOrdinal,
    plateAppearance: pa,
    resolveFielder: resolveFielderIdentity,
    resolveRunner: resolveRunnerIdentity,
    park: header.park || null,
    timeOfDay: captureTimeOfDay(header),
  })
  const excludeFromOaa = Boolean(
    play.after_deflection || forcedMisplays.length || buddyHandoffs.length,
  )
  const playPayload = {
    tracking_session_id: trackingSession.id,
    competition_type: competitionType,
    game_id: gameId,
    pa_id: pa?.id || null,
    play_ordinal: playOrdinal,
    inning: finite(play.inning),
    inning_half: finite(play.inning_half) === 0 ? 'top' : finite(play.inning_half) === 1 ? 'bottom' : null,
    batter_character_id: resolveTrackerCharacterId(play.batter_id, charactersByName),
    tracker_contact_seq: finite(pa?.tracker_contact_seq),
    contact_frame: finite(play.contact_timer),
    pitch_release_frame: finite(play.pitch_release_timer),
    first_touch_frame: finite(firstTouch?.frame),
    dead_ball_frame: finite(play.dead_ball_timer),
    landing_frame: finite(play.landing?.frame),
    landing_x: finite(play.landing?.at?.[0]),
    landing_y: finite(play.landing?.at?.[1]),
    landing_z: finite(play.landing?.at?.[2]),
    // Where the ball was GOING, as the game worked it out on the contact
    // frame, as against where it was actually first touched down above. The
    // two agree to a median 0.14u when both exist; this one also exists for
    // the caught balls and the home runs, where the measured landing either
    // never happens or stops at the fence. Ground plane only -- there is no y.
    projected_landing_frame: finite(play.projected_landing?.frame),
    projected_landing_x: finite(play.projected_landing?.at?.[0]),
    projected_landing_z: finite(play.projected_landing?.at?.[1]),
    projected_landing_distance_m: finite(play.projected_landing?.distance_units),
    hang_time_seconds: finite(play.hang_time_s),
    caught_in_flight: Boolean(play.caught_in_flight),
    duration_seconds: finite(play.duration_s),
    live_seconds: finite(play.live_s),
    fair_ball: playLooksFair(play),
    batted_ball_class: play.batted_ball_class || null,
    home_run: Boolean(play.home_run),
    truncated: Boolean(play.truncated),
    first_touch_position: firstTouch?.by || null,
    first_touch_character_id: resolveTrackerCharacterId(firstTouch?.character_id, charactersByName),
    contact_x: finite(contact[0]),
    contact_y: finite(contact[1]),
    contact_z: finite(contact[2]),
    join_method: match.method,
    join_confidence: match.confidence,
    quality: {
      quarantined_session: quarantined,
      fair_or_foul: play.fair_or_foul,
      batted_ball_class: play.batted_ball_class,
      deflections,
      forced_misplays: forcedMisplays,
      buddy_handoffs: buddyHandoffs,
      after_deflection: Boolean(play.after_deflection),
      rebound_catch: play.rebound_catch || null,
      // The raw detector arrays remain in the capture on disk. This compact,
      // versioned contract is the part the website can aggregate without
      // having to understand each park's memory layout.
      gimmick_events: gimmickEvents,
      // Physical incidents, ball interactions and object changes, each with
      // the actor it actually affected and the evidence that named its cause.
      // Deliberately NOT derived from gimmick_events: the two answer
      // different questions and one cannot be recovered from the other.
      stadium_incidents: stadiumIncidents,
      stadium_runs: stadiumRuns,
      // Bases, where the ball was first secured and where each runner stood
      // then: what the recompute prices a send or hold against.
      runner_context: extraBaseContext(play),
      play_mechanics: playMechanics,
    },
  }
  const { row: trackingPlay } = await insertOneReconciled(supabase, 'tracking_plays', playPayload, {
    key: { tracking_session_id: trackingSession.id, play_ordinal: playOrdinal },
  })

  const opportunityRows = Object.entries(play.fielders || {}).map(([position, row]) => {
    const identity = fielderIdentity(fielders, seasonTeamPlayerById, charactersByName, position, playAt, row.character_id)
    const primary = primaryFielder === position
    const deflection = deflections.find((event) => event.by === position) || null
    const forcedMisplay = forcedMisplays.find((event) => event.by === position) || null
    const buddyHandoff = buddyHandoffs.find((event) => event.by === position) || null
    const positioning = positioningFromRelease(row.pitch_release_start)
    const wall = primary
      ? wallContext(header.park, firstTouch?.at, firstTouch?.ball_height_units)
      : { beyondFenceM: null, robbedHomeRun: null }
    return {
      tracking_play_id: trackingPlay.id,
      competition_type: competitionType,
      game_id: gameId,
      pa_id: pa?.id || null,
      fielder_player_id: identity.playerId,
      fielder_character_id: identity.characterId,
      position,
      is_primary: primary,
      // Catch Probability asks whether THIS batted-ball opportunity became a
      // catch. A baserunner thrown out later on the same play is not a catch,
      // and after a boot the teammate who picks it up is not the original
      // opportunity owner.
      actual_out: primary ? Boolean(
        play.caught_in_flight
        && firstTouch?.by === position
        && !deflection
        && !forcedMisplay
      ) : null,
      fielded: Boolean(row.fielded),
      pitch_release_x: finite(row.pitch_release_start?.[0]),
      pitch_release_y: finite(row.pitch_release_start?.[1]),
      pitch_release_z: finite(row.pitch_release_start?.[2]),
      position_depth_ft: positioning.depthFeet,
      position_angle_deg: positioning.angleDeg,
      start_x: finite(row.start?.[0]), start_y: finite(row.start?.[1]), start_z: finite(row.start?.[2]),
      end_x: finite(row.end?.[0]), end_y: finite(row.end?.[1]), end_z: finite(row.end?.[2]),
      // The catch-probability pair is measured to where the ball had to be
      // REACHED -- the glove on a catch, the landing spot on a ball that fell
      // in -- not to where somebody picked it up after the bounce. Measured
      // the old way the two were indistinguishable: every difficulty band
      // converted at 52%. Measured this way the curve is monotone, from 90%
      // inside 6 u/s of required closing speed to 0% beyond 8.
      distance_needed_m: finite(row.distance_to_landing_units) ?? finite(row.distance_to_touch_units),
      distance_to_touch_m: finite(row.distance_to_touch_units),
      distance_covered_m: finite(row.path_units),
      opportunity_seconds: finite(play.hang_time_s) ?? finite(row.opportunity_s),
      touch_seconds: finite(row.opportunity_s),
      reaction_seconds: finite(row.reaction_s),
      route_efficiency: finite(row.route_efficiency),
      // PER-PLAY CONTEXT FOR A RANGE MODEL, NOT A SPEED RATING. How fast a
      // fielder moved on one ball is mostly how far they had to go: a
      // two-unit shuffle reads 0.5 u/s and a full outfield run reads 7.8, on
      // the same character. Averaging this column by fielder measures their
      // position, not their legs. The speed rating comes off the runner and
      // batter rows, where the whole run is a maximum-effort sprint --
      // summarizeMovementMetrics in src/utils/advancedDefense.js reads only
      // those two actor types, and it should stay that way.
      sprint_speed_mps: finite(row.sprint_speed_ups),
      sprint_speed_fps: finite(row.sprint_speed_ups) == null ? null : finite(row.sprint_speed_ups) * METRES_TO_FEET,
      direction: positionDirection(row.start, row.end),
      catch_height_m: primary ? finite(firstTouch?.ball_height_units) : null,
      beyond_fence_m: wall.beyondFenceM,
      robbed_home_run: wall.robbedHomeRun,
      quality: {
        teleports: finite(row.teleports, 0),
        airborne_frames: finite(row.airborne_frames, 0),
        bobble_frames: finite(row.bobble_frames, 0),
        forced_misplay_frames: finite(row.forced_misplay_frames, 0),
        buddy_handoff_frames: finite(row.buddy_handoff_frames, 0),
        fielding_action_frames: row.fielding_action_frames || {},
        primary_fielder_reason: play.primary_fielder_reason || null,
        deflection,
        forced_misplay: forcedMisplay,
        buddy_handoff: buddyHandoff,
        after_deflection: Boolean(play.after_deflection),
        rebound_catch: play.rebound_catch || null,
        // A rebound catch was manufactured by the boot, while a Buddy
        // handoff can hide the original possession from `ball_holder`.
        // Preserve both plays, but do not teach the ordinary OAA curve from
        // geometry that no longer describes the batted ball.
        exclude_from_oaa: excludeFromOaa,
        // A table, arrow or stun decided this one, not the fielder's range.
        stadium_affected: stadiumDecidedFielding(stadiumIncidents, position, {
          firstTouchFrame: finite(firstTouch?.frame),
        }),
        quarantined_session: quarantined,
      },
    }
  }).map(decorateOpportunity)
  if (opportunityRows.length) {
    await insertRowsReconciled(supabase, 'fielding_opportunities', opportunityRows, {
      keyFields: ['tracking_play_id', 'position'],
    })
  }

  const fielderMovementRows = Object.entries(play.fielders || {}).map(([position, row]) => {
    const identity = fielderIdentity(fielders, seasonTeamPlayerById, charactersByName, position, playAt, row.character_id)
    return {
      tracking_play_id: trackingPlay.id,
      competition_type: competitionType,
      game_id: gameId,
      pa_id: pa?.id || null,
      actor_type: 'fielder', actor_slot: position,
      player_id: identity.playerId, character_id: identity.characterId, position,
      start_x: finite(row.start?.[0]), start_y: finite(row.start?.[1]), start_z: finite(row.start?.[2]),
      end_x: finite(row.end?.[0]), end_y: finite(row.end?.[1]), end_z: finite(row.end?.[2]),
      path_distance_m: finite(row.path_units),
      run_path_distance_m: finite(row.run_path_units),
      assist_distance_m: finite(row.assist_units),
      assist_frames: finite(row.assist_frames),
      displacement_m: finite(row.displacement_units),
      sprint_speed_mps: finite(row.sprint_speed_ups), sprint_speed_fps: finite(row.sprint_speed_fps),
      // The character's ceiling, not this play's effort. The sprint columns
      // above are a fielder's DISTANCE as much as their speed, which is the
      // reason the note further up tells summarizeMovementMetrics to ignore
      // them on fielder rows; this one is identical on every play the
      // character appears in, so it is the column to average.
      max_speed_mps: finite(row.max_speed_ups), max_speed_fps: finite(row.max_speed_fps),
      is_bolt: Boolean(row.bolt), reaction_seconds: finite(row.reaction_s),
      route_efficiency: finite(row.route_efficiency),
      jump_distance_feet: finite(row.jump_distance_feet),
      reaction_distance_feet: finite(row.reaction_distance_feet),
      burst_distance_feet: finite(row.burst_distance_feet),
      jump_route_efficiency: finite(row.jump_route_efficiency),
      quality: { teleports: finite(row.teleports, 0), quarantined_session: quarantined },
    }
  })
  const runnerMovementRows = Object.entries(play.runners || {}).map(([slot, row]) => {
    const origin = RUNNER_ORIGIN_BY_SLOT[slot] || null
    const assignment = origin ? runnerAssignments.get(origin) : null
    const actorType = slot === 'BAT' ? 'batter' : 'runner'
    return {
      tracking_play_id: trackingPlay.id,
      competition_type: competitionType,
      game_id: gameId,
      pa_id: pa?.id || null,
      actor_type: actorType, actor_slot: slot,
      player_id: slot === 'BAT' ? pa?.player_id || null : assignment?.runner?.playerId ?? assignment?.runner?.player_id ?? null,
      character_id: finite(slot === 'BAT'
        ? pa?.character_id ?? resolveTrackerCharacterId(row.character_id, charactersByName)
        : assignment?.runner?.characterId ?? assignment?.runner?.character_id
          ?? resolveTrackerCharacterId(row.character_id, charactersByName)),
      position: origin,
      start_x: finite(row.start?.[0]), start_y: finite(row.start?.[1]), start_z: finite(row.start?.[2]),
      end_x: finite(row.end?.[0]), end_y: finite(row.end?.[1]), end_z: finite(row.end?.[2]),
      path_distance_m: finite(row.path_units),
      run_path_distance_m: finite(row.run_path_units),
      assist_distance_m: finite(row.assist_units),
      assist_frames: finite(row.assist_frames),
      displacement_m: finite(row.displacement_units),
      sprint_speed_mps: finite(row.sprint_speed_ups), sprint_speed_fps: finite(row.sprint_speed_fps),
      // Explicitly null, and not simply left out: the offense actor class does
      // not carry the max-speed field at all, and every row in this batch has
      // to agree on its columns.
      max_speed_mps: null, max_speed_fps: null,
      is_bolt: Boolean(row.bolt),
      home_to_first_seconds: slot === 'BAT' ? finite(play.home_to_first_s) : null,
      ninety_foot_split_seconds: slot === 'BAT' ? finite(play.ninety_foot_split_s) : null,
      five_foot_splits: row.five_foot_splits_s || {},
      reaction_seconds: finite(row.reaction_s), route_efficiency: finite(row.route_efficiency),
      quality: { teleports: finite(row.teleports, 0), quarantined_session: quarantined },
    }
  })
  const movementRows = [...fielderMovementRows, ...runnerMovementRows]
  if (movementRows.length) {
    await insertRowsReconciled(supabase, 'movement_metrics', movementRows, {
      keyFields: ['tracking_play_id', 'actor_type', 'actor_slot'],
    })
  }

  // EVERY approach, including the ones that never reached the ball. A dive that
  // comes up empty produces no fielding event and so has no opportunity row,
  // and it is the observation that bounds a reach from above -- see the table
  // comment in 20260920130000_tracking_catch_approaches.sql.
  const catchApproachRows = (play.catch_approaches || [])
    .filter((row) => row.position || row.by)
    .map((row) => {
      const position = row.by
      const identity = fielderIdentity(
        fielders, seasonTeamPlayerById, charactersByName, position, playAt, row.character_id)
      return {
        tracking_play_id: trackingPlay.id,
        game_id: gameId,
        pa_id: pa?.id || null,
        competition_type: competitionType,
        position,
        fielder_character_id: identity.characterId ?? null,
        fielder_player_id: identity.playerId ?? null,
        catch_type: finite(row.catch_type),
        approach: row.approach || 'unresolved',
        start_frame: finite(row.start_frame),
        end_frame: finite(row.end_frame),
        frames: finite(row.frames),
        closest_frame: finite(row.closest_frame),
        closest_seconds: finite(row.closest_t),
        separation_units: finite(row.separation_units),
        separation_3d_units: finite(row.separation_3d_units),
        relative_height_units: finite(row.relative_height_units),
        ball_height_units: finite(row.ball_height_units),
        outcome: row.outcome || 'no_contact',
        secured: Boolean(row.secured),
        touched: Boolean(row.touched),
        outcome_source: row.outcome_source || null,
        assisted: Boolean(row.assisted),
        assisted_at_closest: Boolean(row.assisted_at_closest),
        assist_frames: finite(row.assist_frames, 0),
        buddy_jump_frames: finite(row.buddy_jump_frames, 0),
        airborne_frames: finite(row.airborne_frames, 0),
        mechanics: row.mechanics || null,
        max_speed_mps: finite(row.max_speed_ups),
        quality: {
          quarantined_session: quarantined,
          // A table, arrow or stun decided this reach, not the fielder.
          stadium_affected: stadiumDecidedFielding(stadiumIncidents, position, {
            firstTouchFrame: finite(row.closest_frame),
          }),
          star_swing: Boolean(play.star_swing),
        },
      }
    })
  let catchApproachCount = 0
  if (catchApproachRows.length) {
    try {
      await insertRowsReconciled(supabase, 'tracking_catch_approaches', catchApproachRows, {
        keyFields: ['tracking_play_id', 'position', 'start_frame'],
      })
      catchApproachCount = catchApproachRows.length
    } catch (error) {
      // A database that has not had 20260920130000 applied yet keeps working
      // and loses only this one fact, the same bargain the session-replacement
      // function makes above. Only a MISSING TABLE degrades; anything else is
      // a real fault and must not be swallowed.
      const code = String(error?.code || '')
      const missing = code === 'PGRST205' || code === '42P01'
      if (!missing) throw error
      if (!warnedMissingCatchApproaches) {
        warnedMissingCatchApproaches = true
        console.warn('  tracking_catch_approaches is missing; catch reach not persisted.')
        console.warn('  Apply supabase/migrations/20260920130000_tracking_catch_approaches.sql')
      }
    }
  }

  // A possession release caused by the holder's own knockdown remains in the
  // raw play for narrative custody, but it is not an arm measurement and
  // must never become a tracking_throws fact.
  const throwRows = (play.throws || []).filter((row) => row.is_throw !== false).map((row, throwIndex) => {
    const thrower = fielderIdentity(fielders, seasonTeamPlayerById, charactersByName, row.thrower_position, playAt, row.thrower_character_id)
    const receiver = fielderIdentity(fielders, seasonTeamPlayerById, charactersByName, row.receiver_position, playAt, row.receiver_character_id)
    return {
      tracking_play_id: trackingPlay.id,
      competition_type: competitionType,
      game_id: gameId,
      pa_id: pa?.id || null,
      throw_sequence: row.sequence ?? throwIndex + 1,
      thrower_player_id: thrower.playerId,
      thrower_character_id: thrower.characterId,
      thrower_position: row.thrower_position || null,
      receiver_player_id: receiver.playerId,
      receiver_character_id: receiver.characterId,
      receiver_position: row.receiver_position || null,
      possession_frame: finite(row.possession_frame),
      release_frame: finite(row.release_frame),
      launch_frame: finite(row.launch_frame),
      is_buddy_throw: Boolean(row.buddy_throw),
      buddy_freeze_seconds: finite(row.buddy_freeze_s),
      flight_frames: finite(row.flight_frames),
      arrival_frame: finite(row.arrival_frame),
      start_x: finite(row.start?.[0]), start_y: finite(row.start?.[1]), start_z: finite(row.start?.[2]),
      end_x: finite(row.end?.[0]), end_y: finite(row.end?.[1]), end_z: finite(row.end?.[2]),
      target_base: row.target_base || null,
      intended_target_position: row.intended_target_position || null,
      buddy_partner_position: row.buddy_partner_position || null,
      peak_speed_mps: finite(row.peak_speed_mps),
      peak_speed_mph: finite(row.peak_speed_mph) ?? (finite(row.peak_speed_mps) == null ? null : finite(row.peak_speed_mps) * MPS_TO_MPH),
      median_speed_mps: finite(row.median_speed_mps),
      sample_count: finite(row.sample_count),
      outs_recorded: finite(row.outs_recorded, 0),
      result: row.result || null,
      is_relay: Boolean(row.is_relay),
      quality: { ...(row.quality || {}), quarantined_session: quarantined },
    }
  })
  const insertedThrows = throwRows.length ? await insertRowsReconciled(supabase, 'tracking_throws', throwRows, {
    keyFields: ['tracking_play_id', 'throw_sequence'],
  }) : []

  if (pa && stageRunnerFacts) {
    const runnerRowsResult = await supabase.from('runner_opportunities').select('*')
      .eq('competition_type', competitionType).eq('game_id', gameId).eq('pa_id', pa.id)
    if (runnerRowsResult.error) throw runnerRowsResult.error
    // The fielder who first secured the ball, for the rows no out chain names.
    // A batter-runner deciding whether to stretch a single is answering the
    // outfielder who got to it, but nothing was scored 8 or 9 on that play, so
    // `parseFieldingPositions` has nothing to give and the opportunity was
    // built with no responsible fielder -- which is exactly the case where the
    // defensive half of the decision is the interesting one. Only ever filled
    // in, never overwritten: an out chain names the fielder deliberately.
    const securedBy = firstTouch?.by
      ? fielderIdentity(fielders, seasonTeamPlayerById, charactersByName,
        firstTouch.by, playAt, firstTouch.character_id)
      : null
    for (const runnerOpportunity of runnerRowsResult.data || []) {
      const slot = RUNNER_SLOT_BY_ORIGIN[runnerOpportunity.origin_base]
      const track = play.runners?.[slot]
      const linkedThrow = insertedThrows.find((row) => (
        row.target_base === runnerOpportunity.target_base
        && (!runnerOpportunity.responsible_fielder_position || row.thrower_position === runnerOpportunity.responsible_fielder_position)
      ))
      const measured = {
        runner_x: finite(track?.start?.[0]),
        runner_z: finite(track?.start?.[2]),
        runner_speed_mps: finite(track?.sprint_speed_ups),
        tracking_throw_id: linkedThrow?.id || null,
        ...(runnerOpportunity.responsible_fielder_character_id == null && securedBy?.characterId != null ? {
          responsible_fielder_player_id: securedBy.playerId,
          responsible_fielder_character_id: securedBy.characterId,
          responsible_fielder_position: String(POSITION_NUMBER[firstTouch.by] ?? firstTouch.by),
        } : {}),
      }
      runnerFacts.push({ id: runnerOpportunity.id, ...measured })
    }
  }
  return {
    trackingPlay,
    fieldingCount: opportunityRows.length,
    movementCount: movementRows.length,
    throwCount: insertedThrows.length,
    catchApproachCount,
    runnerFacts,
  }
}

export async function ingestPlayerTrackingSession(supabase, {
  session,
  gameId = null,
  competitionType = null,
  sourceId = null,
  recompute = true,
  recomputeFn = recomputeAdvancedMetrics,
  warn = console.warn,
  // The bridge's live lease, or an explicitly stated reason for writing
  // without one. Never absent by default: a null owner with no reason is
  // refused by the database.
  lease = null,
  // Rebuild beside the active version even though nothing on disk changed.
  // The join reads the plate appearances, so correcting or renumbering them
  // after an ingest is otherwise invisible to it: every count still matches.
  replace = false,
} = {}) {
  const stem = sessionStem(session)
  const headerPath = `${stem}.json`
  const playsPath = `${stem}.plays.jsonl`
  const pitchesPath = `${stem}.pitches.jsonl`
  if (!fs.existsSync(headerPath)) throw new Error(`Missing tracking header: ${headerPath}`)
  if (!fs.existsSync(playsPath)) throw new Error(`Missing derived plays: ${playsPath}`)
  const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'))
  const plays = readJsonLines(playsPath)
  // Optional for old captures, authoritative when present. The live bridge
  // usually wrote these fields already; replaying them here closes races where
  // the scoring PA completed before its live capture pitch arrived.
  const derivedPitches = fs.existsSync(pitchesPath) ? readJsonLines(pitchesPath) : []
  // The checksum identifies the persisted interpretation, not only the bytes
  // on disk. Bumping this version makes an explicit re-ingest build a safe
  // replacement session when the normalization contract changes, even when
  // the raw derived play file is byte-for-byte identical.
  const derivedChecksum = crypto.createHash('sha256')
    .update(fs.readFileSync(playsPath))
    .update(`\0${INGEST_NORMALIZATION_VERSION}`)
    .digest('hex')
  const resolvedGameId = finite(gameId ?? header.game_id)
  const resolvedType = competitionType || header.competition_type
  const resolvedSourceId = finite(sourceId ?? header.source_id)
  if (resolvedGameId == null) throw new Error('A game id is required (collector header or --game-id)')
  if (!['tournament', 'season'].includes(resolvedType)) throw new Error('competition type must be tournament or season')

  const paTable = resolvedType === 'season' ? 'season_plate_appearances' : 'plate_appearances'
  const pitchTable = resolvedType === 'season' ? 'season_pitches' : 'pitches'
  const fielderTable = resolvedType === 'season' ? 'season_game_fielders' : 'game_fielders'
  const [paResult, pitchResult, fielderResult, characterResult, seasonTeamResult] = await Promise.all([
    fetchAllRows(() => supabase.from(paTable).select('*').eq('game_id', resolvedGameId)),
    derivedPitches.length
      ? fetchAllRows(() => supabase.from(pitchTable).select('*').eq('game_id', resolvedGameId))
      : Promise.resolve({ data: [], error: null }),
    fetchAllRows(() => supabase.from(fielderTable).select('*').eq('game_id', resolvedGameId)),
    fetchAllRows(() => supabase.from('characters').select('id,name')),
    resolvedType === 'season'
      ? fetchAllRows(() => supabase.from('season_teams').select('id,player_id'))
      : Promise.resolve({ data: [], error: null }),
  ])
  const firstError = paResult.error || pitchResult.error || fielderResult.error
    || characterResult.error || seasonTeamResult.error
  if (firstError) throw firstError

  const missedRate = finite(header.frames, 0) + finite(header.missed_frames, 0) > 0
    ? finite(header.missed_frames, 0) / (finite(header.frames, 0) + finite(header.missed_frames, 0))
    : null
  const quarantined = Boolean(header.fielder_pointers_left_region) || (missedRate != null && missedRate > 0.02)
  const sessionPayload = {
    competition_type: resolvedType,
    game_id: resolvedGameId,
    source_id: resolvedSourceId,
    stadium_key: header.park || null,
    format_version: header.format || 'MSSTRK02',
    status: quarantined ? 'quarantined' : 'derived',
    recorded_utc: recordedTimestamp(header.recorded_utc),
    completed_utc: new Date().toISOString(),
    raw_stem: stem,
    raw_manifest_path: header.manifest_path || null,
    frame_rate: finite(header.frame_rate, 59.94),
    frames: finite(header.frames),
    missed_frames: finite(header.missed_frames),
    duration_seconds: finite(header.duration_seconds),
    checksum_sha256: header.checksum_sha256 || null,
    calibration: fs.existsSync(`${stem}.calibration.json`)
      ? JSON.parse(fs.readFileSync(`${stem}.calibration.json`, 'utf8'))
      : {},
    quality: {
      missed_frame_rate: missedRate,
      fielder_pointers_left_region: Boolean(header.fielder_pointers_left_region),
      derived_sha256: derivedChecksum,
      normalization_version: INGEST_NORMALIZATION_VERSION,
    },
    updated_at: new Date().toISOString(),
  }

  const fielders = fielderResult.data || []
  const charactersByName = indexCharactersByName(characterResult.data || [])
  const matches = matchPlaysToPas(plays, paResult.data || [], charactersByName)
  // matchPlaysToPas validates every fair/foul classification. It runs before
  // any session or canonical-pitch mutation so malformed replacement input
  // cannot damage a good completed ingest.
  const pitchEvidence = derivedPitches.length
    ? await persistDerivedPitchEvidence(supabase, {
        table: pitchTable,
        derivedPitches,
        plateAppearances: paResult.data || [],
        pitchRows: pitchResult.data || [],
        charactersByName,
        warn,
      })
    : { updates: [], matchedGroups: 0, unmatchedGroups: [], unmatchedPitches: [] }
  const expectedKeys = expectedFactKeys(plays)

  let trackingSession = null
  const existingSessions = await selectByKey(supabase, 'tracking_sessions', {
    competition_type: resolvedType, game_id: resolvedGameId, raw_stem: stem,
  })
  // Once 20260908123000_tracking_session_versions.sql has run a stem can hold
  // several versions and exactly one of them is active. On a database without
  // that migration there is no is_active column, every row reads undefined,
  // and the single row is the one that comes back -- which is the same answer.
  const existingSession = existingSessions.find((row) => row.is_active !== false)
    || existingSessions[0] || null

  // A REPLACEMENT THAT DIED IS RESUMED, NOT RE-OPENED. Without this a crash
  // (or a lost response) between opening version N+1 and activating it left
  // that version behind and the next run opened N+2, so a game accumulated a
  // version per attempt and the facts were re-ingested from scratch each time.
  // A non-active version of this stem carrying the SAME derivation is the same
  // attempt, and is finished rather than duplicated.
  const resumableReplacement = existingSessions.find((row) => (
    row.is_active === false
    && row.id !== existingSession?.id
    // AND NOTHING HAS TAKEN OVER FROM IT. A version that was superseded by a
    // LATER one is also inactive and also `ingested`, so without this a second
    // deliberate --replace reached back past the active version and tried to
    // rewrite the retired one, which refused on its own play data: "durable
    // key ... already belongs to different data". Superseded is finished
    // history; an unfinished replacement is one nothing has replaced.
    && !row.superseded_by
    && ['ingesting', 'raw_ingested', 'ingested'].includes(row.status)
    && (!row.checksum_sha256 || !sessionPayload.checksum_sha256
        || row.checksum_sha256 === sessionPayload.checksum_sha256)
    && (!row.quality?.derived_sha256 || row.quality.derived_sha256 === derivedChecksum)
  )) || null

  let replacementOf = null
  if (existingSession && ['ingested', 'quarantined', LIVE_SESSION_STATUS].includes(existingSession.status)) {
    const sameChecksum = !existingSession.checksum_sha256 || !sessionPayload.checksum_sha256
      || existingSession.checksum_sha256 === sessionPayload.checksum_sha256
    const sameDerived = !existingSession.quality?.derived_sha256
      || existingSession.quality.derived_sha256 === derivedChecksum
    const priorPlays = finite(existingSession.quality?.plays)
    // THE LIVE VERSION IS ALWAYS REPLACED. It was written play by play while
    // the game went on, from the live derivation and the live join, with no
    // checksum to compare -- so "same checksum" says nothing about it. The
    // postgame pass is authoritative and becomes the active version beside it.
    const liveVersion = existingSession.status === LIVE_SESSION_STATUS
    if (liveVersion || replace || !sameChecksum || !sameDerived
        || (priorPlays != null && priorPlays !== plays.length)) {
      // A genuinely different recording of the same stem: a re-derivation, a
      // recovered capture, a fixed derivation. The old behaviour was to refuse
      // outright, because deleting a good tree of tracking facts and then
      // failing halfway through rebuilding it would lose a game's fielding.
      // With the versioning migration applied there is a third option: build
      // the replacement BESIDE the good one and move the active pointer only
      // once it is finished.
      const opened = resumableReplacement
        || await beginSessionReplacement(supabase, existingSession, sessionPayload, lease)
      if (resumableReplacement) {
        warn(`resuming the unfinished replacement version ${resumableReplacement.version} `
          + `(session ${resumableReplacement.id}) rather than opening another; the completed `
          + `version ${existingSession.version ?? 1} is still the active one`)
      }
      if (!opened) {
        throw new Error(
          `Refusing to replace completed tracking session ${existingSession.id}: this database `
          + 'has no tracker_begin_session_replacement(). The existing completed ingest was '
          + 'preserved. Apply supabase/migrations/20260908123000_tracking_session_versions.sql '
          + 'to allow versioned replacement.',
        )
      }
      replacementOf = existingSession
      trackingSession = opened
    }
    // Only when this is NOT a replacement. A re-derivation can produce the
    // same NUMBER of plays with different contents -- which is most of the
    // reason to re-derive one -- so a count match past this point would return
    // "already complete" and quietly discard the replacement that was just
    // opened.
    if (!trackingSession) {
      if (existingSession.status === 'quarantined') {
        return { trackingSessionId: existingSession.id, status: 'quarantined', plays: 0, linkedPlays: 0,
          fieldingOpportunities: 0, movementMetrics: 0, throws: 0,
          pitchEvidenceRows: pitchEvidence.updates.length,
          modelSummary: null, alreadyComplete: true }
      }
      const existingKeys = await existingFactKeys(supabase, existingSession.id)
      const outstanding = outstandingFacts(expectedKeys, existingKeys)
      if (!outstanding.length) {
        // A MATCHING FACT SET IS NOT A FINISHED INGEST. It says the raw half
        // landed; the derived half writes nothing these rows can see.
        // Returning here on a session that still owed its activation or its
        // recomputation is what made a failed replacement permanent -- the
        // retry saw the same facts and did nothing at all.
        const pendingStage = pendingDerivedStage(existingSession)
        const modelSummary = pendingStage
          ? await resumeDerivedWork(supabase, existingSession, {
            stage: pendingStage, lease, recompute, recomputeFn, warn,
            paTable, competitionType: resolvedType, gameId: resolvedGameId,
          })
          : null
        return {
          trackingSessionId: existingSession.id, status: 'ingested', plays: plays.length,
          linkedPlays: finite(existingSession.quality?.linked_plays, 0),
          fieldingOpportunities: existingKeys.keys.fielding.size,
          movementMetrics: existingKeys.keys.movement.size,
          throws: existingKeys.keys.throws.size,
          // null, not 0: this database cannot hold them, so there is no count
          // of them to report and none is claimed.
          catchApproaches: existingKeys.supported.catchApproaches
            ? existingKeys.keys.catchApproaches.size
            : null,
          pitchEvidenceRows: pitchEvidence.updates.length,
          modelSummary, alreadyComplete: true,
          ...(pendingStage ? { resumedStage: pendingStage } : {}),
        }
      }
      // Said out loud. A session that has been ingested and is about to be
      // ingested again is worth one line explaining which facts are not there,
      // because the commonest cause is a table that was missing the first time.
      warn(`tracking session ${existingSession.id} is stored but incomplete `
        + `(${describeOutstanding(outstanding)}); re-importing the capture to finish it`)
    }
  }

  if (trackingSession) {
    // The replacement version above is already open; nothing else to do here.
  } else if (existingSession) {
    const [data] = await updateRowsVerified(supabase, 'tracking_sessions', { id: existingSession.id }, {
      ...sessionPayload,
      status: quarantined ? 'quarantined' : 'ingesting',
    })
    trackingSession = data
  } else {
    const saved = await insertOneReconciled(supabase, 'tracking_sessions', {
      ...sessionPayload,
      status: quarantined ? 'quarantined' : 'ingesting',
    }, {
      key: { competition_type: resolvedType, game_id: resolvedGameId, raw_stem: stem },
    })
    trackingSession = saved.row
  }

  // A quarantined capture writes no facts. Replacing a live version it still
  // has to finish and activate -- empty -- or the facts the live writer took
  // from this same failed capture would stay the active ones.
  const replacingLive = replacementOf?.status === LIVE_SESSION_STATUS
  if (quarantined && !replacingLive) {
    return { trackingSessionId: trackingSession.id, status: 'quarantined', plays: 0, linkedPlays: 0,
      fieldingOpportunities: 0, movementMetrics: 0, throws: 0,
      pitchEvidenceRows: pitchEvidence.updates.length, modelSummary: null }
  }
  const factPlays = quarantined ? [] : plays

  const unnamed = unresolvableTrackerCharacters(charactersByName)
  if (unnamed.length) {
    warn(`${unnamed.length} tracked characters have no roster entry and will ingest without one: `
      + unnamed.map((row) => `${row.name} (game id ${row.gameCharacterId})`).join(', '))
  }
  // STAGED, NOT WRITTEN, ALWAYS. Everything below that would change a row the
  // SITE reads -- the plate appearance's tracking pointer, the runner and
  // double-play opportunities' link to a tracking play, the measured runner
  // kinematics -- is collected here instead of applied, and handed to
  // tracker_activate_session_version so it lands in ONE transaction that
  // asserts this caller's lease.
  //
  // A first ingest used to write them as it went, on the reasoning that it has
  // no previous version to protect. It does have a GAME to protect: those rows
  // are shared with whatever else is writing the game, and a per-row update
  // guarded only by a client-side lease check is not fenced by anything. It
  // now takes the same route, where the call comes back `already_active` and
  // applies the links; the direct writes remain only as the fallback for a
  // database with no versioning function at all.
  const stagedRunnerFacts = []
  // The plate appearance each play belongs to, collected the same way and
  // applied by the same transaction. Only used by the direct fallback below --
  // tracker_activate_session_version re-derives these from the session's own
  // tracking_plays, which is what makes a re-run apply the same links rather
  // than a remembered copy of them.
  const stagedPlayLinks = []
  const seasonTeamPlayerById = new Map((seasonTeamResult.data || []).map((row) => [String(row.id), row.player_id]))
  let linked = 0
  let fieldingCount = 0
  let movementCount = 0
  let throwCount = 0
  let catchApproachCount = 0

  for (let index = 0; index < factPlays.length; index++) {
    const play = factPlays[index]
    const match = matches[index]
    const written = await writeTrackingPlayFacts(supabase, {
      play,
      playOrdinal: index + 1,
      match,
      trackingSession,
      header,
      competitionType: resolvedType,
      gameId: resolvedGameId,
      fielders,
      seasonTeamPlayerById,
      charactersByName,
      quarantined,
    })
    if (match.pa) {
      linked += 1
      stagedPlayLinks.push({
        paId: match.pa.id,
        trackingPlayId: written.trackingPlay.id,
        contactFrame: finite(play.contact_timer),
        // The live bridge usually gets this and sometimes does not: it
        // writes the plate appearance when the tracker log says the at-bat
        // resolved, which can be before the capture has closed the play, and
        // `trackerPreviewOutcomePlay` then hands it null. Game 2947 recorded
        // both of its Nice Plays live; game 2946 missed its only one, Red
        // Pianta's diving 4-3 double play. Here the play and the plate
        // appearance are joined by the postgame join, so the answer does not
        // depend on which feed arrived first.
        isNicePlay: trackerPlayIsNicePlay({
          play,
          hitNotation: match.pa.hit_notation,
          outsOnPlay: match.pa.outs_on_play,
          isBuddyJump: match.pa.is_buddy_jump,
        }),
        storedNicePlay: match.pa.is_nice_play === true,
        // Never overwrite a human. The At-Bat editor can set this by hand and
        // that decision outranks the capture's.
        corrected: Boolean(match.pa.correction_source),
      })
    }
    fieldingCount += written.fieldingCount
    movementCount += written.movementCount
    throwCount += written.throwCount
    catchApproachCount += written.catchApproachCount || 0
    stagedRunnerFacts.push(...written.runnerFacts)
  }

  // The stage the derived half is about to enter, written BEFORE it is
  // attempted. Both paths still owe their official links, which travel with the
  // activation call -- so both start at `activate`.
  const finishedQuality = {
    ...sessionPayload.quality,
    plays: factPlays.length,
    linked_plays: linked,
    link_rate: factPlays.length ? linked / factPlays.length : null,
  }
  await updateRowsVerified(supabase, 'tracking_sessions', { id: trackingSession.id }, {
    status: 'raw_ingested',
    quality: withDerivedStage(finishedQuality, 'activate'),
    updated_at: new Date().toISOString(),
  })

  let modelSummary = null
  // ORDER MATTERS, AND IT IS NOW ONE ORDER. Recomputation reads the ACTIVE
  // version's facts, so running it while a replacement is still staged either
  // models the old version (and leaves the new one unmodeled) or, if it did not
  // filter, mixes two versions of the same plays into one set of model inputs.
  // So: the raw facts, then `ingested` (which is what lets the pointer move at
  // all), then the official links and the pointer in one fenced transaction,
  // then the recomputation. A first ingest takes the same path -- its session
  // is already the active one, so the activation call applies its links and
  // says `already_active`.
  const runRecompute = async () => {
    if (!recompute) return
    try {
      modelSummary = await recomputeFn(supabase)
    } catch (error) {
      error.message = `Raw tracking facts were saved, but advanced-metric recomputation failed: ${error.message}`
      throw error
    }
  }
  await updateRowsVerified(supabase, 'tracking_sessions', { id: trackingSession.id }, {
    status: 'ingested',
    updated_at: new Date().toISOString(),
  })
  // LAST, and only now. Everything above could still have failed, and until
  // this statement runs the previous version is the active one, is intact, and
  // is what every official row still points at.
  const activated = await activateSessionVersion(supabase, trackingSession, lease, stagedRunnerFacts)
  if (!activated) {
    if (replacementOf) {
      // Unreachable in practice and refused rather than assumed: a replacement
      // could not have been OPENED without the versioning migration.
      throw new Error(`the replacement session ${trackingSession.id} was built but this database `
        + 'has no tracker_activate_session_version() to activate it with. The previous version '
        + 'is still active and intact.')
    }
    await applyOfficialLinksDirectly(supabase, {
      paTable,
      competitionType: resolvedType,
      gameId: resolvedGameId,
      sessionId: trackingSession.id,
      playLinks: stagedPlayLinks,
      runnerFacts: stagedRunnerFacts,
    })
  }
  const nicePlaysSet = await applyCaptureDerivedPaFields(supabase, { paTable, playLinks: stagedPlayLinks })
  await recordDerivedStage(supabase, trackingSession, finishedQuality, 'recompute')
  await runRecompute()
  // Cleared only now: a recomputation that threw above leaves the stage on the
  // row, and the next run finishes it instead of reading the matching fact
  // counts as a finished ingest.
  await recordDerivedStage(supabase, trackingSession, finishedQuality, null)
  if (quarantined) {
    await updateRowsVerified(supabase, 'tracking_sessions', { id: trackingSession.id }, {
      status: 'quarantined',
      updated_at: new Date().toISOString(),
    })
  }
  return {
    trackingSessionId: trackingSession.id,
    status: quarantined ? 'quarantined' : 'ingested',
    ...(replacementOf ? { replacedSessionId: replacementOf.id } : {}),
    plays: factPlays.length,
    linkedPlays: linked,
    fieldingOpportunities: fieldingCount,
    movementMetrics: movementCount,
    throws: throwCount,
    catchApproaches: catchApproachCount,
    pitchEvidenceRows: pitchEvidence.updates.length,
    nicePlaysSet,
    modelSummary,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.session) throw new Error('--session is required')
  const supabase = await createAdvancedMetricsClient()
  // The bridge passes its live lease; a person running this by hand has to say
  // why they are writing without one. There is no third option: an unnamed
  // unleased write is exactly what a tracker that lost its lease would look
  // like, and the database refuses it.
  const lease = args['lease-owner']
    ? { ownerId: String(args['lease-owner']), epoch: Number(args['lease-epoch']) }
    : { ownerId: null, epoch: null, unleasedIntent: String(args['unleased-reason'] || '').trim() }
  if (!lease.ownerId && !lease.unleasedIntent) {
    throw new Error('this ingest writes plate appearances and shared opportunity rows, so it needs '
      + 'either --lease-owner/--lease-epoch (the bridge passes its own) or --unleased-reason '
      + '"why this run has no lease" (a repair, a backfill, an old session loaded by hand).')
  }
  const summary = await ingestPlayerTrackingSession(supabase, {
    session: args.session,
    gameId: args['game-id'],
    competitionType: args['competition-type'],
    sourceId: args['source-id'],
    recompute: args.recompute !== '0',
    replace: Boolean(args.replace),
    lease,
  })
  console.log(JSON.stringify(summary, null, 2))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
