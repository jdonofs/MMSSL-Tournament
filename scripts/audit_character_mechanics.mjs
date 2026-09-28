// The evidence behind the character-mechanics traits on the Scouting Report.
//
//   node scripts/audit_character_mechanics.mjs
//   node scripts/audit_character_mechanics.mjs --json
//   node scripts/audit_character_mechanics.mjs --report docs/…-audit.md
//   node scripts/audit_character_mechanics.mjs --ledger      (adds the migration
//     ledger, read only, through `npx supabase db query --linked`; the anon key
//     cannot see supabase_migrations at all)
//
// READ ONLY. It signs in as nobody, uses the anon key the app itself uses, and
// issues no write of any kind. Every database count below is paginated through
// fetchAllRows (PostgREST silently caps a plain select at 1000) and filtered by
// the same active-version rule the character page applies, so a number here is
// the number the page is working from and not a bigger one.
//
// WHY IT EXISTS. The first version of this feature was handed off with counts
// quoted from a transcript. A count in prose cannot be re-checked, goes stale
// the next time anything is ingested, and hides which denominator it came from
// -- so every figure that gets stated about these traits is produced here
// instead, with its units, its exclusions and what it was divided by.
//
// NOTHING IS ASSERTED AGAINST A HARD-CODED EXPECTATION. This is a report, not
// a test. If a total moves because a session was re-ingested, that is the
// report doing its job; the run that produced a saved report is dated in it.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import { fetchOptionalRows } from '../src/utils/fetchOptionalRows.js'
import {
  fetchSupersededTrackingPlayIds,
  onlyActiveTrackingFacts,
  onlyActiveTrackingPlays,
} from '../src/utils/activeTrackingVersions.js'
import { catchApproachIsOrdinaryMechanics } from '../src/utils/advancedDefense.js'
import { characterNameKey } from '../src/utils/characterNames.js'
import {
  GAME_FRAME_RATE,
  getBaserunSpeed,
  getFieldSpeed,
} from '../src/data/gameSpeedCurves.js'

// Read as a file rather than imported: src/utils/characterAnalysis.js pulls
// JSON through Vite's loader and will not import from plain Node. Only the one
// field is needed, and characterNameKey resolves the aliases both sides use.
const TALENT_PROFILES = JSON.parse(
  fs.readFileSync(path.resolve('src/data/characterTalentProfiles.json'), 'utf8'),
)
const TALENT_RUN_SPEED_BY_KEY = new Map(
  Object.entries(TALENT_PROFILES).map(([name, profile]) => [characterNameKey(name), profile?.runSpeed]),
)

const METRES_TO_FEET = 3.280839895
const TRACKING_DIR = path.resolve('data/player_tracking')
const NEWLINE = String.fromCharCode(10)

// Mirrors scripts/verify_speed_against_attributes.mjs exactly, so the two
// cannot drift apart without this file failing to reproduce its number.
const VERIFIER_MIN_RUN_UNITS = 10
const VERIFIER_MIN_SAMPLES = 6

function loadEnv(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

const finite = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const topFraction = (values, fraction) => {
  const sorted = [...values].sort((a, b) => b - a)
  const take = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * fraction)))
  return take.reduce((sum, value) => sum + value, 0) / take.length
}
const quantile = (values, fraction) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}
function pearson(xs, ys) {
  const n = xs.length
  if (n < 5) return null
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  const sx = Math.sqrt(xs.reduce((s, v) => s + (v - mx) ** 2, 0))
  const sy = Math.sqrt(ys.reduce((s, v) => s + (v - my) ** 2, 0))
  if (!sx || !sy) return null
  return xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / (sx * sy)
}

// ─── Database ────────────────────────────────────────────────────────────────

async function readDatabase(supabase) {
  const [
    charactersResult, sessionsResult, playsResult, movementResult,
    approachesResult, supersededResult, seasonScheduleResult, gamesResult,
  ] = await Promise.all([
    fetchAllRows(() => supabase.from('characters').select('id,name,run_speed,throwing_speed')),
    fetchAllRows(() => supabase.from('tracking_sessions')
      .select('id,game_id,version,status,raw_stem,stadium_key,superseded_by,competition_type')),
    fetchAllRows(() => supabase.from('tracking_plays')
      .select('id,tracking_session_id,game_id,pa_id,join_method,fair_ball,landing_x,projected_landing_x')),
    fetchAllRows(() => supabase.from('movement_metrics')
      .select('id,tracking_play_id,actor_type,character_id,max_speed_fps,max_speed_mps,quality')),
    fetchOptionalRows(supabase, 'tracking_catch_approaches'),
    fetchSupersededTrackingPlayIds(supabase),
    fetchAllRows(() => supabase.from('season_schedule').select('id,season_id,status')),
    fetchAllRows(() => supabase.from('games').select('id,tournament_id,status')),
  ])

  const failures = Object.entries({
    characters: charactersResult, tracking_sessions: sessionsResult,
    tracking_plays: playsResult, movement_metrics: movementResult,
    tracking_catch_approaches: approachesResult, superseded: supersededResult,
    season_schedule: seasonScheduleResult, games: gamesResult,
  }).filter(([, result]) => result.error)
  if (failures.length) {
    throw new Error(`read failed: ${failures.map(([name, r]) => `${name}: ${r.error.message}`).join('; ')}`)
  }
  return {
    characters: charactersResult.data,
    sessions: sessionsResult.data,
    // The exclusion set is keyed by tracking_play id, so plays filter by their
    // OWN id and child facts by their tracking_play_id. Two different helpers.
    allPlays: playsResult.data,
    plays: onlyActiveTrackingPlays(playsResult.data, supersededResult.data),
    movement: onlyActiveTrackingFacts(movementResult.data, supersededResult.data),
    approaches: onlyActiveTrackingFacts(approachesResult.data, supersededResult.data),
    approachTableMissing: approachesResult.missing === true,
    supersededPlayIds: supersededResult.data,
    supersededLegacy: supersededResult.legacy || null,
    seasonSchedule: seasonScheduleResult.data,
    games: gamesResult.data,
  }
}

function auditScope(db) {
  const active = db.sessions.filter((row) => row.superseded_by == null)
  const scheduledGameIds = new Set([
    ...db.seasonSchedule.map((row) => String(row.id)),
    ...db.games.map((row) => String(row.id)),
  ])
  const byStatus = {}
  for (const row of active) byStatus[row.status] = (byStatus[row.status] || 0) + 1
  return {
    sessionRowsTotal: db.sessions.length,
    activeSessions: active.length,
    supersededSessions: db.sessions.length - active.length,
    activeSessionStatuses: byStatus,
    distinctTrackedGames: new Set(active.map((row) => String(row.game_id))).size,
    trackedGamesOnASchedule: [...new Set(active.map((row) => String(row.game_id)))]
      .filter((id) => scheduledGameIds.has(id)).length,
    // A game with no schedule row is dropped by selectAdvancedRows on the
    // character page, so its facts exist in the database and never reach a
    // scouting report. That gap is why a raw count here can exceed what the
    // page shows.
    trackedGamesOffEverySchedule: [...new Set(active.map((row) => String(row.game_id)))]
      .filter((id) => !scheduledGameIds.has(id)),
    supersededPlayIdsKnown: db.supersededPlayIds.size,
    supersededReadWasLegacy: db.supersededLegacy,
  }
}

function auditCoverage(db) {
  const plays = db.plays
  const fielderRows = db.movement.filter((row) => row.actor_type === 'fielder')
  const offenseRows = db.movement.filter((row) => row.actor_type !== 'fielder')
  return {
    activePlays: plays.length,
    playsWithProjectedLanding: plays.filter((row) => finite(row.projected_landing_x) != null).length,
    playsWithMeasuredLanding: plays.filter((row) => finite(row.landing_x) != null).length,
    fielderMovementRows: fielderRows.length,
    fielderRowsWithMaxSpeed: fielderRows.filter((row) => finite(row.max_speed_fps) != null).length,
    fielderRowsWithCharacter: fielderRows.filter((row) => row.character_id != null).length,
    // Expected to be zero: the offense actor class does not carry the field.
    offenseRowsWithMaxSpeed: offenseRows.filter((row) => finite(row.max_speed_fps) != null).length,
    quarantinedFielderRows: fielderRows.filter((row) => row.quality?.quarantined_session === true).length,
    playsUnmatchedToPa: plays.filter((row) => row.pa_id == null).length,
    playsMatchedToPa: plays.filter((row) => row.pa_id != null).length,
    joinMethods: plays.reduce((acc, row) => {
      const key = row.join_method || 'null'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {}),
  }
}

async function auditPlateAppearances(supabase, db) {
  const active = db.sessions.filter((row) => row.superseded_by == null)
  const gameIds = [...new Set(active.map((row) => Number(row.game_id)))].filter(Number.isFinite)
  if (!gameIds.length) return { gamesChecked: 0, gamesWithNoPlateAppearances: [] }
  const [seasonPa, tournamentPa] = await Promise.all([
    fetchAllRows(() => supabase.from('season_plate_appearances').select('id,game_id').in('game_id', gameIds)),
    fetchAllRows(() => supabase.from('plate_appearances').select('id,game_id').in('game_id', gameIds)),
  ])
  if (seasonPa.error || tournamentPa.error) {
    throw new Error(`plate appearance read failed: ${(seasonPa.error || tournamentPa.error).message}`)
  }
  const counts = new Map(gameIds.map((id) => [String(id), 0]))
  for (const row of [...seasonPa.data, ...tournamentPa.data]) {
    counts.set(String(row.game_id), (counts.get(String(row.game_id)) || 0) + 1)
  }
  return {
    gamesChecked: gameIds.length,
    plateAppearancesByGame: Object.fromEntries(counts),
    gamesWithNoPlateAppearances: [...counts].filter(([, n]) => n === 0).map(([id]) => id),
  }
}

// ─── Catch reach ─────────────────────────────────────────────────────────────

function auditCatchReach(db, { minWindows, trackedGames }) {
  if (db.approachTableMissing) return { tableMissing: true }
  const rows = db.approaches
  const byApproach = {}
  for (const row of rows) {
    const key = row.approach || 'unknown'
    byApproach[key] = byApproach[key] || { total: 0, qualifying: 0, secured: 0, qualifyingSecured: 0 }
    byApproach[key].total += 1
    if (row.outcome === 'secured') byApproach[key].secured += 1
    if (catchApproachIsOrdinaryMechanics(row)) {
      byApproach[key].qualifying += 1
      if (row.outcome === 'secured') byApproach[key].qualifyingSecured += 1
    }
  }

  // Per character, per approach: attempts and SECURED separately, because the
  // displayed reach is a quantile over the secured ones alone and the two
  // denominators are not interchangeable.
  const nameById = new Map(db.characters.map((c) => [String(c.id), c.name]))
  const perCharacter = new Map()
  for (const row of rows) {
    if (!['ordinary', 'dive', 'leap'].includes(row.approach)) continue
    if (finite(row.separation_3d_units) == null) continue
    if (!catchApproachIsOrdinaryMechanics(row)) continue
    const id = String(row.fielder_character_id)
    if (id === 'null' || id === 'undefined') continue
    if (!perCharacter.has(id)) perCharacter.set(id, {})
    const buckets = perCharacter.get(id)
    buckets[row.approach] = buckets[row.approach] || { attempts: 0, secured: 0 }
    buckets[row.approach].attempts += 1
    if (row.outcome === 'secured') buckets[row.approach].secured += 1
  }

  const displayable = { ordinary: 0, dive: 0, leap: 0 }
  const attemptsOnly = { ordinary: 0, dive: 0, leap: 0 }
  const characterRows = [...perCharacter].map(([id, buckets]) => {
    for (const [approach, bucket] of Object.entries(buckets)) {
      if (bucket.secured >= minWindows) displayable[approach] += 1
      else if (bucket.attempts > 0) attemptsOnly[approach] += 1
    }
    return { characterId: id, name: nameById.get(id) || `#${id}`, ...buckets }
  }).sort((a, b) => (b.ordinary?.secured || 0) - (a.ordinary?.secured || 0))

  // ── The coverage rate, with its two different numerators ────────────────
  //
  // A QUALIFYING ATTEMPT is a window that passes the mechanics filter. A
  // QUALIFYING SECURED CATCH is one of those that was also held, and it is the
  // only one that moves a character towards the display threshold -- the
  // shown reach is a quantile over secured catches. An earlier note quoted the
  // attempt rate and then reasoned about the threshold with it, which
  // overstates how fast coverage arrives by the conversion rate.
  const perGame = {}
  for (const approach of ['ordinary', 'dive', 'leap']) {
    const bucket = byApproach[approach] || { qualifying: 0, qualifyingSecured: 0 }
    perGame[approach] = {
      qualifyingAttempts: bucket.qualifying,
      qualifyingSecured: bucket.qualifyingSecured,
      qualifyingAttemptsPerGame: trackedGames ? +(bucket.qualifying / trackedGames).toFixed(2) : null,
      qualifyingSecuredPerGame: trackedGames ? +(bucket.qualifyingSecured / trackedGames).toFixed(2) : null,
    }
  }

  return {
    tableMissing: false,
    windowsTotal: rows.length,
    byApproach,
    trackedGames: trackedGames ?? null,
    perTrackedGame: perGame,
    minSecuredWindowsToDisplay: minWindows,
    charactersWithAnyQualifyingWindow: characterRows.length,
    charactersAtOrAboveThreshold: displayable,
    charactersWithWindowsButBelowThreshold: attemptsOnly,
    topCharacters: characterRows.slice(0, 12),
  }
}

// ─── Workbook versus captured constants ──────────────────────────────────────

function auditSpeedAgreement(db) {
  const byKey = new Map(db.characters.map((c) => [characterNameKey(c.name), c]))
  const fielderRows = db.movement.filter((row) => (
    row.actor_type === 'fielder'
    && finite(row.max_speed_fps) != null
    && row.character_id != null
    && row.quality?.quarantined_session !== true
  ))
  const byCharacter = new Map()
  for (const row of fielderRows) {
    const id = String(row.character_id)
    if (!byCharacter.has(id)) byCharacter.set(id, [])
    byCharacter.get(id).push(Number(finite(row.max_speed_fps).toFixed(3)))
  }
  const charactersById = new Map(db.characters.map((c) => [String(c.id), c]))

  const rows = []
  for (const [id, values] of byCharacter) {
    const character = charactersById.get(id)
    if (!character || character.run_speed == null) continue
    const counts = new Map()
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
    const ordinaryCurve = getFieldSpeed(character.run_speed).speedPerSecond * METRES_TO_FEET
    const boostedCurve = getFieldSpeed(character.run_speed, { boosted: true }).speedPerSecond * METRES_TO_FEET
    const near = (a, b) => Math.abs(a - b) <= 0.01
    const ordinaryValues = values.filter((v) => near(v, ordinaryCurve))
    const boostedValues = values.filter((v) => !near(v, ordinaryCurve) && near(v, boostedCurve))
    const unclassified = values.length - ordinaryValues.length - boostedValues.length
    rows.push({
      characterId: id,
      name: character.name,
      runSpeed: character.run_speed,
      // What the data-mined talent profile says, where it disagrees with the
      // column. The app resolves in this order already; the audit reports both.
      profileRunSpeed: finite(TALENT_RUN_SPEED_BY_KEY.get(characterNameKey(character.name))),
      // Is this rating a published table row, or does it interpolate?
      interpolated: getFieldSpeed(character.run_speed).exactTableEntry === false,
      expectedOrdinaryFps: +ordinaryCurve.toFixed(4),
      observedOrdinaryFps: ordinaryValues.length ? ordinaryValues[0] : null,
      ordinarySamples: ordinaryValues.length,
      boostedSamples: boostedValues.length,
      unclassifiedSamples: unclassified,
      unclassifiedValues: unclassified
        ? [...new Set(values.filter((v) => !near(v, ordinaryCurve) && !near(v, boostedCurve)))]
        : [],
      absErrorFps: ordinaryValues.length ? Math.abs(ordinaryValues[0] - ordinaryCurve) : null,
    })
  }

  const matched = rows.filter((row) => row.absErrorFps != null)
  const interpolated = matched.filter((row) => row.interpolated)
  const errors = matched.map((row) => row.absErrorFps)
  const exceptions = rows.filter((row) => row.absErrorFps == null && row.unclassifiedSamples > 0)
  return {
    // EVERY number here is scoped to the DATABASE, not to the local archive.
    // The two differ: the archive holds sessions that were never ingested.
    scope: 'active tracking sessions in the database, non-quarantined fielder rows',
    charactersWithConstant: rows.length,
    charactersReproducingTheCurve: matched.length,
    ofWhichInterpolatedRatings: interpolated.length,
    toleranceFps: 0.01,
    medianAbsErrorFps: errors.length ? +median(errors).toFixed(6) : null,
    worstAbsErrorFps: errors.length ? +Math.max(...errors).toFixed(6) : null,
    // THE STORED RESOLUTION IS IN FEET, NOT CONVERTED FROM u/s.
    // derive_player_metrics.py rounds the SAME unrounded constant twice and
    // independently: max_speed_ups = round(v, 3) and max_speed_fps =
    // round(v * 3.280839895, 3). movement_metrics.max_speed_fps is double
    // precision, so nothing rounds again. The ft/s grid is therefore 0.001 and
    // half a step is 0.0005 -- not the 0.00164 a u/s grid converted to feet
    // would give, which is what an earlier version of this line reported.
    // The observed worst error below is the corroboration: it sits just under
    // 0.0005 and never near 0.0016.
    storedResolutionFps: 0.001,
    roundingFloorFps: 0.0005,
    roundingNote: 'max_speed_ups and max_speed_fps are rounded to 3 dp '
      + 'independently from the same unrounded constant (derive_player_metrics.py), '
      + 'so the ft/s value is on a 0.001 ft/s grid and is not derived from the '
      + 'rounded u/s value.',
    charactersWithNoCurveMatch: exceptions.map((row) => ({
      name: row.name, runSpeed: row.runSpeed, observed: row.unclassifiedValues,
      expectedOrdinaryFps: row.expectedOrdinaryFps,
      profileRunSpeed: row.profileRunSpeed,
      expectedFromProfileFps: row.profileRunSpeed == null ? null
        : +(getFieldSpeed(row.profileRunSpeed).speedPerSecond * METRES_TO_FEET).toFixed(4),
    })),
    charactersWithBoostedSamples: rows.filter((row) => row.boostedSamples > 0)
      .map((row) => ({ name: row.name, boosted: row.boostedSamples, ordinary: row.ordinarySamples })),
    rows,
  }
}

// ─── The LOCAL ARCHIVE scope of the same curve check ─────────────────────────
//
// WHY A SECOND SCOPE. The database section above reports the characters whose
// constant reached an INGESTED session -- 55 of them at the time of writing.
// SPEED_CURVE_VALIDATION in src/data/gameSpeedCurves.js instead claimed "70 of
// 72 characters across 58 sessions", which is the local archive: it holds
// sessions that were captured and never ingested. Those are two different
// populations and neither number checks the other, so the claim was reproduced
// here rather than left as prose nobody could re-run.
//
// INCLUSION RULES, stated because every count below depends on them:
//
//   sessions      every *.plays.jsonl in data/player_tracking, EXCEPT the ones
//                 whose header sets calibration_excluded (balls are missed on
//                 purpose in those). Session count is files scanned, not games.
//   observations  fielder actors only, with a non-null max_speed_ups. The
//                 offense actor class does not carry the field at all.
//   identity      resolved by characterNameKey against the characters table.
//                 The capture and the site spell six characters differently
//                 and every Mii differently again, so an exact-name match
//                 silently drops them; the unresolved names are counted and
//                 listed rather than quietly excluded.
//   rating        the character must have a run_speed to be classified. One
//                 without is counted separately and is not a curve failure.
//
// Everything is classified against the character's own curve rows, the same
// way summarizeMovementMetrics does it: ordinary, boosted at floor(stat*1.5),
// or matching neither.
function auditArchiveSpeedAgreement(db) {
  const byKey = new Map(db.characters.map((c) => [characterNameKey(c.name), c]))
  const observations = new Map()
  const sessionsWithBoost = new Map()
  const unresolvedNames = new Map()
  let sessions = 0
  let excluded = 0
  let rows = 0
  let files = 0
  // WHICH PARKS WERE SCANNED, AND HOW OFTEN. Without this the epilogue can say
  // a boosted session is "the only capture of that park" only by remembering
  // that it was, which stops being true the moment a second one is recorded.
  const scannedByPark = new Map()

  if (!fs.existsSync(TRACKING_DIR)) {
    return { scanned: false, reason: 'data/player_tracking is not present in this checkout' }
  }
  for (const file of fs.readdirSync(TRACKING_DIR).filter((n) => n.endsWith('.plays.jsonl'))) {
    files += 1
    const stem = file.slice(0, -'.plays.jsonl'.length)
    const headerPath = path.join(TRACKING_DIR, `${stem}.json`)
    if (fs.existsSync(headerPath)) {
      const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'))
      if (header.calibration_excluded === true) { excluded += 1; continue }
    }
    sessions += 1
    const park = stem.replace(/-\d{8}T\d{6}Z$/, '')
    scannedByPark.set(park, (scannedByPark.get(park) || 0) + 1)
    for (const line of fs.readFileSync(path.join(TRACKING_DIR, file), 'utf8').split(NEWLINE)) {
      if (!line.trim()) continue
      const play = JSON.parse(line)
      for (const actor of Object.values(play.fielders || {})) {
        const value = finite(actor?.max_speed_ups)
        if (value == null || !actor.character) continue
        rows += 1
        const key = characterNameKey(actor.character)
        if (!byKey.has(key)) {
          unresolvedNames.set(actor.character, (unresolvedNames.get(actor.character) || 0) + 1)
          continue
        }
        if (!observations.has(key)) observations.set(key, { name: actor.character, values: [] })
        // The SESSION is carried with each value, not with the character: a
        // character appears in many sessions and the question is which session
        // the boosted constant was read in. Attributing it to every session
        // that character played in turns one boosted session into thirty-nine.
        observations.get(key).values.push({ value: Number(value.toFixed(3)), stem })
      }
    }
  }

  const matched = []
  const boostedOnly = []
  const neither = []
  const noRating = []
  let interpolated = 0
  const errors = []
  for (const [key, entry] of observations) {
    const character = byKey.get(key)
    if (character.run_speed == null) { noRating.push(entry.name); continue }
    const ordinary = getFieldSpeed(character.run_speed).speedPerSecond
    const boosted = getFieldSpeed(character.run_speed, { boosted: true }).speedPerSecond
    // The capture rounds u/s to three decimals, so half a step is 0.0005.
    // The window is wider than that and far narrower than the gap between the
    // two rows, which is never below 0.027 u/s for any rating.
    const near = (a, b) => Math.abs(a - b) <= 0.003
    const ordinaryValues = entry.values.filter((v) => near(v.value, ordinary))
    const boostedValues = entry.values.filter((v) => !near(v.value, ordinary) && near(v.value, boosted))
    const unmatched = entry.values.filter((v) => !near(v.value, ordinary) && !near(v.value, boosted))
    for (const stem of new Set(boostedValues.map((v) => v.stem))) {
      sessionsWithBoost.set(stem, (sessionsWithBoost.get(stem) || 0) + 1)
    }
    if (ordinaryValues.length) {
      matched.push(character.name)
      errors.push(Math.abs(ordinaryValues[0].value - ordinary))
      if (getFieldSpeed(character.run_speed).exactTableEntry === false) interpolated += 1
    } else if (boostedValues.length) {
      boostedOnly.push({ name: character.name, boosted: boostedValues.length })
    } else {
      neither.push({
        name: character.name,
        runSpeed: character.run_speed,
        observed: [...new Set(unmatched.map((v) => v.value))],
        expectedOrdinaryUps: +ordinary.toFixed(4),
      })
    }
  }

  // WHICH SESSIONS THE BOOST APPEARS IN. The claim that has to stay falsifiable
  // is "one session", so the session stems are named rather than counted.
  const boostSessions = [...sessionsWithBoost.entries()]
    .map(([stem, characters]) => {
      const park = stem.replace(/-\d{8}T\d{6}Z$/, '')
      return {
        stem,
        characters,
        park,
        // How many sessions of THIS park were scanned at all, and how many of
        // them showed the boost. A boosted session at a park with three clean
        // captures is a different fact from a park with only that one.
        parkSessionsScanned: scannedByPark.get(park) || 0,
      }
    })
    .sort((a, b) => b.characters - a.characters)
  for (const row of boostSessions) {
    row.parkSessionsBoosted = boostSessions.filter((other) => other.park === row.park).length
  }

  return {
    scanned: true,
    scope: 'local archive, data/player_tracking/*.plays.jsonl, fielder actors only',
    sessionFilesPresent: files,
    sessionsScanned: sessions,
    calibrationExcludedSessions: excluded,
    fielderObservations: rows,
    charactersResolved: observations.size,
    charactersWithARating: observations.size - noRating.length,
    charactersReproducingTheCurve: matched.length,
    ofWhichInterpolatedRatings: interpolated,
    toleranceUnitsPerSecond: 0.003,
    medianAbsErrorUps: errors.length ? +median(errors).toFixed(6) : null,
    worstAbsErrorUps: errors.length ? +Math.max(...errors).toFixed(6) : null,
    charactersSeenOnlyBoosted: boostedOnly,
    charactersMatchingNeitherRow: neither,
    charactersWithNoRating: noRating,
    // Names the capture uses that no characters row resolves to. These are the
    // difference between this count and the full cast, and they are a naming
    // problem rather than a measurement one.
    unresolvedCaptureNames: Object.fromEntries([...unresolvedNames.entries()].sort((a, b) => b[1] - a[1])),
    sessionsShowingTheBoost: boostSessions,
    sessionsScannedByPark: Object.fromEntries([...scannedByPark.entries()].sort()),
  }
}

// ─── Runner sprint: the two analyses, side by side ───────────────────────────

function collectArchiveRunnerSamples() {
  const strict = new Map()
  const loose = new Map()
  const push = (map, key, value) => {
    if (!key) return
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(value)
  }
  let sessions = 0
  let excluded = 0
  if (!fs.existsSync(TRACKING_DIR)) return { strict, loose, sessions, excluded }
  for (const file of fs.readdirSync(TRACKING_DIR).filter((n) => n.endsWith('.plays.jsonl'))) {
    const stem = file.slice(0, -'.plays.jsonl'.length)
    const headerPath = path.join(TRACKING_DIR, `${stem}.json`)
    if (fs.existsSync(headerPath)) {
      const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'))
      if (header.calibration_excluded === true) { excluded += 1; continue }
    }
    sessions += 1
    for (const line of fs.readFileSync(path.join(TRACKING_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const play = JSON.parse(line)
      for (const actor of Object.values(play.runners || {})) {
        if (!actor || !actor.sprint_speed_ups) continue
        if (actor.assist_frames) continue
        push(loose, actor.character, actor.sprint_speed_ups)
        if (actor.teleports) continue
        if ((actor.run_path_units || 0) < VERIFIER_MIN_RUN_UNITS) continue
        push(strict, actor.character, actor.sprint_speed_ups)
      }
    }
  }
  return { strict, loose, sessions, excluded }
}

/**
 * One correlation, with the cohort it was computed over reported beside it.
 *
 * `cohort`, when given, restricts the characters considered to exactly that
 * set. That is what makes a CONTROL a control: changing the estimator while
 * the threshold also changes swaps two things at once and attributes the whole
 * difference to whichever one the label names. The earlier version of this
 * function did exactly that -- the retained result used >=6 samples and both
 * "controls" used >=15, so they ran over 53-54 characters against 71 and the
 * cohort was never held fixed.
 */
function runnerAnalysis(samples, characters, {
  minSamples, estimator, label, method, cohort = null,
}) {
  const byKey = new Map(characters.map((c) => [characterNameKey(c.name), c]))
  const xs = []
  const ys = []
  const ratios = []
  const included = []
  const droppedBelowThreshold = []
  const droppedUnresolved = []
  for (const [name, values] of samples) {
    const key = characterNameKey(name)
    if (cohort && !cohort.has(key)) continue
    if (values.length < minSamples) { droppedBelowThreshold.push(name); continue }
    const character = byKey.get(key)
    if (!character || character.run_speed == null) { droppedUnresolved.push(name); continue }
    const estimate = estimator(values)
    xs.push(estimate)
    ys.push(character.run_speed)
    ratios.push(estimate / getBaserunSpeed(character.run_speed).speedPerSecond)
    included.push(key)
  }
  const sortedRatios = [...ratios].sort((a, b) => a - b)
  return {
    label,
    method,
    characters: xs.length,
    minSamplesPerCharacter: minSamples,
    cohortHeldFixed: Boolean(cohort),
    cohortSize: cohort ? cohort.size : null,
    droppedBelowThreshold: droppedBelowThreshold.length,
    droppedUnresolvedName: droppedUnresolved.length,
    pearsonVsRunSpeed: xs.length >= 5 ? +pearson(xs, ys).toFixed(4) : null,
    ratioToBaserunCurve: {
      median: sortedRatios.length ? +median(sortedRatios).toFixed(4) : null,
      p10: sortedRatios.length ? +quantile(sortedRatios, 0.1).toFixed(4) : null,
      p90: sortedRatios.length ? +quantile(sortedRatios, 0.9).toFixed(4) : null,
    },
    // The exact set, so a reader can check that two rows claiming to differ in
    // one thing really do share a denominator.
    cohortKeys: included.sort(),
  }
}

function auditRunnerSprint(db) {
  const { strict, loose, sessions, excluded } = collectArchiveRunnerSamples()

  // THE RETAINED RESULT FIRST, because its cohort is what every control is
  // then held to. Strict filters, top-two-thirds mean, >=6 samples -- the same
  // rows, estimator and threshold as scripts/verify_speed_against_attributes.mjs.
  const retained = runnerAnalysis(strict, db.characters, {
    minSamples: VERIFIER_MIN_SAMPLES,
    estimator: (values) => topFraction(values, 2 / 3),
    label: 'verifier method (the retained result)',
    method: 'local archive; assist_frames=0, teleports=0, run_path_units>=10; '
      + 'top-two-thirds mean; >=6 samples per character. '
      + 'Same filters and estimator as scripts/verify_speed_against_attributes.mjs.',
  })
  const cohort = new Set(retained.cohortKeys)

  // ── The two controls, each changing exactly one thing ────────────────────
  //
  // Both run over the SAME characters as the retained result and the same
  // >=6 threshold. A character who clears 6 samples under the strict filters
  // has at least as many under the loose ones, so the loose-filter control can
  // hold the cohort without dropping anyone; what changes is which windows go
  // into each character's estimate.
  const estimatorControl = runnerAnalysis(strict, db.characters, {
    minSamples: VERIFIER_MIN_SAMPLES,
    cohort,
    estimator: (values) => quantile(values, 0.99),
    label: 'control: estimator only (same rows, same cohort, same threshold)',
    method: 'ISOLATES THE ESTIMATOR. Identical filtered rows, identical characters '
      + 'and identical >=6 threshold as the retained result; p99 instead of the '
      + 'top-two-thirds mean.',
  })
  const filterControl = runnerAnalysis(loose, db.characters, {
    minSamples: VERIFIER_MIN_SAMPLES,
    cohort,
    estimator: (values) => topFraction(values, 2 / 3),
    label: 'control: filters only (same estimator, same cohort, same threshold)',
    method: 'ISOLATES THE FILTERS. assist_frames=0 only -- no teleport or '
      + 'run-length filter -- with the same estimator, characters and threshold.',
  })

  // ── The superseded figure, kept because it was quoted ────────────────────
  //
  // Reproduced exactly as it was originally computed, cohort and all, so the
  // number in the old handoff can be recognised. It is NOT a control: it
  // differs from the retained result in the estimator, the filters AND the
  // threshold at once, which is precisely why it could not be attributed.
  const superseded = runnerAnalysis(loose, db.characters, {
    minSamples: 15,
    estimator: (values) => quantile(values, 0.99),
    label: 'p99 estimator (SUPERSEDED - do not quote)',
    method: 'local archive; assist_frames=0 only, no run-length or teleport filter; '
      + 'p99 of a character\'s samples; >=15 samples. Three differences from the '
      + 'retained result at once, over its own smaller cohort. A p99 over a few '
      + 'dozen windows is effectively the maximum, so it reports the noisiest run '
      + 'a character ever had rather than how fast they run.',
  })

  // ── Full-cohort versions of the two controls ─────────────────────────────
  //
  // Reported separately and labelled, because "every character who clears the
  // threshold under these filters" is a different and also useful question
  // from "the same characters, measured differently".
  const fullCohort = [
    runnerAnalysis(strict, db.characters, {
      minSamples: VERIFIER_MIN_SAMPLES,
      estimator: (values) => quantile(values, 0.99),
      label: 'full cohort: strict filters, p99 estimator',
      method: 'no cohort restriction; every character clearing >=6 strict samples.',
    }),
    runnerAnalysis(loose, db.characters, {
      minSamples: VERIFIER_MIN_SAMPLES,
      estimator: (values) => topFraction(values, 2 / 3),
      label: 'full cohort: loose filters, top-two-thirds mean',
      method: 'no cohort restriction; every character clearing >=6 loose samples.',
    }),
  ]

  return {
    archiveSessionsScanned: sessions,
    calibrationExcludedSessions: excluded,
    retainedCohortSize: cohort.size,
    analyses: [retained, estimatorControl, filterControl, superseded],
    fullCohort,
  }
}

// ─── The migration ledger, when it is asked for ──────────────────────────────
//
// OPT IN, with `--ledger`. Everything else in this file goes through the anon
// key, which cannot see `supabase_migrations.schema_migrations` at all -- that
// schema is not exposed through PostgREST. The ledger therefore needs the
// Supabase CLI against the linked project, and the two queries below are
// SELECTs and nothing else.
//
// WHAT A LEDGER ROW ESTABLISHES, AND WHAT IT DOES NOT. The table has exactly
// three columns -- `version`, `name`, `statements` -- with no timestamp and no
// author. Its current state says WHICH versions are recorded as applied. It
// cannot say when a row was written, who wrote it, whether the file on disk is
// the file that ran, or whether a migration was applied without being
// recorded. Two of the versions in this repository were live on production
// while absent from this table, so absence is evidence about the LEDGER and
// only weak evidence about the schema; the column values are read alongside it
// for that reason.
// ─── What the prepared migration declares ────────────────────────────────────
//
// READ FROM THE FILE, not restated here. The epilogue needs to say what the
// correction would change in order to say whether it has taken effect, and a
// second copy of those numbers in this script is a second place for them to go
// stale. Parsing the one authority instead means editing the migration edits
// the report.
const PREPARED_MIGRATION = '20260921130000_character_run_speed_corrections.sql'
const PREPARED_CORRECTION = /jsonb_build_object\('name',\s*'([^']+)',\s*'from',\s*(\d+),\s*'to',\s*(\d+)\)/g

export function readPreparedMigration(file = PREPARED_MIGRATION) {
  const full = path.resolve('supabase/migrations', file)
  if (!fs.existsSync(full)) return { file, version: file.slice(0, 14), found: false, corrections: [] }
  const sql = fs.readFileSync(full, 'utf8')
  const corrections = [...sql.matchAll(PREPARED_CORRECTION)].map((match) => ({
    name: match[1], from: Number(match[2]), to: Number(match[3]),
  }))
  return { file, version: file.slice(0, 14), found: true, corrections }
}

const LEDGER_QUERIES = {
  recentVersions: "select version, name from supabase_migrations.schema_migrations"
    + " where version >= '20260920000000' order by version",
  preparedMigration: "select count(*)::int as present from supabase_migrations.schema_migrations"
    + " where version = '20260921130000'",
  correctionTargets: "select name, run_speed from public.characters where name in"
    + " ('Dry Bones','Green Paratroopa','Paratroopa','Blue Dry Bones','Dark Bones','Green Dry Bones')"
    + " order by name",
}

// Through a temporary FILE rather than as an argument. `shell: true` is needed
// to find npx on Windows and concatenates arguments without quoting, so a SQL
// string containing quotes arrives at the CLI in pieces. The file is written to
// the OS temp directory, contains one SELECT, and is removed either way.
function ledgerQuery(sql) {
  const file = path.join(os.tmpdir(), `sluggers-ledger-${process.pid}-${Date.now()}.sql`)
  fs.writeFileSync(file, `${sql};`, 'utf8')
  try {
    const raw = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '--file', file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true,
    })
    const start = raw.indexOf('{')
    if (start < 0) throw new Error(`unexpected CLI output: ${raw.slice(0, 200)}`)
    return JSON.parse(raw.slice(start)).rows || []
  } finally {
    try { fs.unlinkSync(file) } catch { /* the query is what mattered */ }
  }
}

function auditMigrationLedger() {
  try {
    const recent = ledgerQuery(LEDGER_QUERIES.recentVersions)
    const prepared = ledgerQuery(LEDGER_QUERIES.preparedMigration)
    const targets = ledgerQuery(LEDGER_QUERIES.correctionTargets)
    const onDisk = fs.existsSync(path.resolve('supabase/migrations'))
      ? fs.readdirSync(path.resolve('supabase/migrations'))
        .filter((name) => name.endsWith('.sql') && name >= '20260920000000')
        .map((name) => ({ version: name.slice(0, 14), file: name }))
        .sort((a, b) => a.version.localeCompare(b.version))
      : []
    const recorded = new Set(recent.map((row) => row.version))
    return {
      checked: true,
      queries: LEDGER_QUERIES,
      recentRecordedVersions: recent,
      filesOnDiskFrom20260920: onDisk.map((row) => ({
        ...row, recordedInLedger: recorded.has(row.version),
      })),
      preparedMigrationRecorded: (prepared[0]?.present ?? 0) > 0,
      correctionTargetValues: targets,
      establishes: 'which versions the ledger currently records as applied, and what '
        + 'public.characters.run_speed currently holds for the correction targets.',
      doesNotEstablish: 'when any row was written, who wrote it, whether the file on '
        + 'disk is the one that ran, or whether anything was applied without being '
        + 'recorded. The table has no timestamp and no author column.',
    }
  } catch (error) {
    return {
      checked: false,
      queries: LEDGER_QUERIES,
      reason: `the Supabase CLI read failed: ${String(error.message).split(NEWLINE)[0]}`,
      note: 'Run the three SELECTs above by hand with `npx supabase db query --linked`. '
        + 'They are read only. Nothing else in this report needs them.',
    }
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────

function formatText(audit) {
  const out = []
  const line = (s = '') => out.push(s)
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')

  line(`Character mechanics audit — ${audit.generatedUtc}`)
  line(`Database: ${audit.databaseHost}  (anon key, read only)`)
  line()

  line('SCOPE')
  const s = audit.scope
  line(`  tracking_sessions rows           ${s.sessionRowsTotal}  (${s.activeSessions} active, ${s.supersededSessions} superseded)`)
  line(`  active session statuses          ${JSON.stringify(s.activeSessionStatuses)}`)
  line(`  distinct tracked games           ${s.distinctTrackedGames}`)
  line(`  ...of those, on a schedule       ${s.trackedGamesOnASchedule}`)
  if (s.trackedGamesOffEverySchedule.length) {
    line(`  ...off every schedule            ${s.trackedGamesOffEverySchedule.join(', ')}`)
    line('       (dropped by selectAdvancedRows, so present here and absent from the character page)')
  }
  line(`  superseded play ids excluded     ${s.supersededPlayIdsKnown}`)
  line()

  line('COVERAGE  (active versions only)')
  const c = audit.coverage
  line(`  active tracking_plays            ${c.activePlays}`)
  line(`  ...with projected landing        ${c.playsWithProjectedLanding}  (${pct(c.playsWithProjectedLanding, c.activePlays)})`)
  line(`  ...with a measured landing       ${c.playsWithMeasuredLanding}  (${pct(c.playsWithMeasuredLanding, c.activePlays)})`)
  line(`  ...joined to a plate appearance  ${c.playsMatchedToPa}  (${pct(c.playsMatchedToPa, c.activePlays)})`)
  line(`  ...unmatched                     ${c.playsUnmatchedToPa}`)
  line(`  join methods                     ${JSON.stringify(c.joinMethods)}`)
  line(`  fielder movement rows            ${c.fielderMovementRows}`)
  line(`  ...with max speed (ft/s)         ${c.fielderRowsWithMaxSpeed}  (${pct(c.fielderRowsWithMaxSpeed, c.fielderMovementRows)})`)
  line(`  ...with a resolved character     ${c.fielderRowsWithCharacter}  (${pct(c.fielderRowsWithCharacter, c.fielderMovementRows)})`)
  line(`  ...quarantined                   ${c.quarantinedFielderRows}`)
  line(`  offense rows with max speed      ${c.offenseRowsWithMaxSpeed}  (expected 0: the offense actor has no such field)`)
  line()

  line('PLATE APPEARANCES behind the tracked games')
  const pa = audit.plateAppearances
  line(`  games checked                    ${pa.gamesChecked}`)
  line(`  per game                         ${JSON.stringify(pa.plateAppearancesByGame)}`)
  if (pa.gamesWithNoPlateAppearances.length) {
    line(`  games with NO plate appearances  ${pa.gamesWithNoPlateAppearances.join(', ')}`)
    line('       (their plays cannot join; identity still resolves from the capture)')
  }
  line()

  line('CATCH APPROACHES')
  const r = audit.catchReach
  if (r.tableMissing) {
    line('  tracking_catch_approaches is not present in this database.')
  } else {
    line(`  windows on active sessions       ${r.windowsTotal}`)
    line('  by approach                      total  qualifying  secured  qualifying+secured')
    for (const [approach, b] of Object.entries(r.byApproach)) {
      line(`    ${approach.padEnd(12)}               ${String(b.total).padStart(5)}  ${String(b.qualifying).padStart(10)}  ${String(b.secured).padStart(7)}  ${String(b.qualifyingSecured).padStart(18)}`)
    }
    line('       qualifying = passes catchApproachIsOrdinaryMechanics (not assisted at the')
    line('       resolving frame, no Buddy Jump, no stadium/star/special mechanic, not quarantined)')
    line(`  display threshold                ${r.minSecuredWindowsToDisplay} SECURED windows (the denominator of the shown number)`)
    line(`  characters with any window       ${r.charactersWithAnyQualifyingWindow}`)
    line(`  characters at/above threshold    ${JSON.stringify(r.charactersAtOrAboveThreshold)}`)
    line(`  characters below threshold       ${JSON.stringify(r.charactersWithWindowsButBelowThreshold)}`)
    line(`  tracked games behind these       ${r.trackedGames}`)
    line('  per tracked game                 qualifying attempts   of those, secured')
    for (const [approach, entry] of Object.entries(r.perTrackedGame)) {
      line(`    ${approach.padEnd(12)}               ${String(entry.qualifyingAttemptsPerGame).padStart(19)}`
        + `   ${String(entry.qualifyingSecuredPerGame).padStart(16)}`)
    }
    line('       THE SECOND COLUMN IS THE ONE THAT MOVES THE THRESHOLD. The displayed')
    line('       reach is a quantile over SECURED catches, so an attempt that came up')
    line('       empty adds coverage of the conversion rate and none of the reach.')
    line('  best covered characters (secured/attempts, at qualifying windows):')
    for (const row of r.topCharacters) {
      const fmt = (b) => (b ? `${b.secured}/${b.attempts}` : '-')
      line(`    ${row.name.padEnd(22)} standing ${fmt(row.ordinary).padEnd(8)} dive ${fmt(row.dive).padEnd(8)} leap ${fmt(row.leap)}`)
    }
  }
  line()

  line('WORKBOOK FIELD-SPEED CURVE vs THE CAPTURED CONSTANT')
  const a = audit.speedAgreement
  line(`  scope                            ${a.scope}`)
  line(`  characters with a constant       ${a.charactersWithConstant}`)
  line(`  ...reproducing the curve         ${a.charactersReproducingTheCurve}  (tolerance ${a.toleranceFps} ft/s)`)
  line(`  ...of those, interpolated        ${a.ofWhichInterpolatedRatings}  (rating not a published table row)`)
  line(`  median |error|                   ${a.medianAbsErrorFps} ft/s`)
  line(`  worst |error|                    ${a.worstAbsErrorFps} ft/s`)
  line(`  stored resolution                ${a.storedResolutionFps} ft/s  (max_speed_fps is rounded to 3 dp in FEET)`)
  line(`  capture rounding floor           ${a.roundingFloorFps} ft/s  (half a step of that grid)`)
  line(`       ${a.roundingNote}`)
  line(`  characters with boosted samples  ${a.charactersWithBoostedSamples.length}`)
  for (const row of a.charactersWithBoostedSamples) {
    line(`    ${row.name.padEnd(22)} boosted ${row.boosted}, ordinary ${row.ordinary}`)
  }
  line(`  characters matching neither row  ${a.charactersWithNoCurveMatch.length}`)
  for (const row of a.charactersWithNoCurveMatch) {
    line(`    ${row.name.padEnd(22)} characters.run_speed ${row.runSpeed}: observed ${JSON.stringify(row.observed)}, that rating implies ${row.expectedOrdinaryFps}`)
    if (row.profileRunSpeed != null && row.profileRunSpeed !== row.runSpeed) {
      line(`      talent profile says run_speed ${row.profileRunSpeed}, which implies ${row.expectedFromProfileFps} -- matching the observation.`)
      line('      THIS IS THE EVIDENCE for the prepared characters.run_speed correction. The')
      line('      audit deliberately reads the COLUMN so the disagreement stays visible; the app')
      line('      reads resolveCharacterRunSpeed(), which already prefers the profile.')
    }
  }
  line()

  line('SAME CURVE CHECK, LOCAL ARCHIVE SCOPE')
  const ar = audit.archiveSpeedAgreement
  if (!ar.scanned) {
    line(`  not scanned: ${ar.reason}`)
  } else {
    line(`  scope                            ${ar.scope}`)
    line(`  session files present            ${ar.sessionFilesPresent}`)
    line(`  sessions scanned                 ${ar.sessionsScanned}  (${ar.calibrationExcludedSessions} calibration-excluded)`)
    line(`  fielder observations             ${ar.fielderObservations}`)
    line(`  characters resolved by name      ${ar.charactersResolved}`)
    line(`  ...holding a run_speed           ${ar.charactersWithARating}`)
    line(`  ...reproducing the curve         ${ar.charactersReproducingTheCurve}  (tolerance ${ar.toleranceUnitsPerSecond} u/s)`)
    line(`  ...of those, interpolated        ${ar.ofWhichInterpolatedRatings}  (rating not a published table row)`)
    line(`  median |error|                   ${ar.medianAbsErrorUps} u/s`)
    line(`  worst |error|                    ${ar.worstAbsErrorUps} u/s`)
    line(`  characters seen only boosted     ${ar.charactersSeenOnlyBoosted.length}`)
    for (const row of ar.charactersSeenOnlyBoosted) {
      line(`    ${row.name.padEnd(22)} ${row.boosted} boosted observations, no ordinary one`)
    }
    line(`  characters matching neither row  ${ar.charactersMatchingNeitherRow.length}`)
    for (const row of ar.charactersMatchingNeitherRow) {
      line(`    ${row.name.padEnd(22)} run_speed ${row.runSpeed}: observed ${JSON.stringify(row.observed)} u/s, that rating implies ${row.expectedOrdinaryUps}`)
    }
    line(`  characters with no rating        ${ar.charactersWithNoRating.length}`)
    line(`  sessions showing the boost       ${ar.sessionsShowingTheBoost.length}`)
    for (const row of ar.sessionsShowingTheBoost) {
      line(`    ${row.stem}  ${row.characters} characters`
        + `  (${row.park}: ${row.parkSessionsBoosted} of ${row.parkSessionsScanned} scanned captures boosted)`)
    }
    const unresolved = Object.entries(ar.unresolvedCaptureNames)
    line(`  capture names with no characters row  ${unresolved.length}`)
    for (const [name, count] of unresolved.slice(0, 12)) {
      line(`    ${String(name).padEnd(28)} ${count} observations`)
    }
    if (!unresolved.length) {
      line('       characterNameKey resolved every capture name. Contrast')
      line('       scripts/verify_speed_against_attributes.mjs, which matches on the exact')
      line('       capture name and therefore drops the characters the two sides spell')
      line('       differently -- that, and not a different dataset, is why its character')
      line('       count is the smaller one.')
    }
  }
  line()

  line('RUNNER SPRINT SPEED — reconciling two analyses')
  const run = audit.runnerSprint
  line(`  local archive sessions scanned   ${run.archiveSessionsScanned}  (${run.calibrationExcludedSessions} calibration-excluded)`)
  line(`  retained cohort                  ${run.retainedCohortSize} characters`
    + '  (the denominator both controls are held to)')
  for (const entry of run.analyses) {
    line(`  ${entry.label}`)
    line(`     r vs run_speed = ${entry.pearsonVsRunSpeed}   characters = ${entry.characters}`
      + `   (cohort ${entry.cohortHeldFixed ? `held at ${entry.cohortSize}` : 'its own'},`
      + ` >=${entry.minSamplesPerCharacter} samples)`)
    line(`     ratio to the workbook baserun curve: median ${entry.ratioToBaserunCurve.median} (p10 ${entry.ratioToBaserunCurve.p10}, p90 ${entry.ratioToBaserunCurve.p90})`)
    line(`     ${entry.method}`)
  }
  line()
  line('  FULL-COHORT VERSIONS, reported separately because they answer a different')
  line('  question: every character clearing the threshold under those filters,')
  line('  rather than the same characters measured a different way.')
  for (const entry of run.fullCohort) {
    line(`  ${entry.label}`)
    line(`     r vs run_speed = ${entry.pearsonVsRunSpeed}   characters = ${entry.characters}`
      + `   (>=${entry.minSamplesPerCharacter} samples)`)
    line(`     ratio: median ${entry.ratioToBaserunCurve.median} (p10 ${entry.ratioToBaserunCurve.p10}, p90 ${entry.ratioToBaserunCurve.p90})`)
  }
  line()
  if (audit.migrationLedger) {
    const l = audit.migrationLedger
    line('MIGRATION LEDGER  (read only, via the Supabase CLI — not the anon key)')
    if (!l.checked) {
      line(`  not checked: ${l.reason}`)
      line(`  ${l.note}`)
      for (const [name, sql] of Object.entries(l.queries)) line(`    ${name}: ${sql}`)
    } else {
      line('  files from 20260920 on, and whether the ledger records them:')
      for (const row of l.filesOnDiskFrom20260920) {
        line(`    ${row.version}  ${row.recordedInLedger ? 'RECORDED  ' : 'NOT RECORDED'}  ${row.file}`)
      }
      line(`  20260921130000_character_run_speed_corrections   ${l.preparedMigrationRecorded ? 'RECORDED' : 'NOT RECORDED — unapplied'}`)
      line('  current column values for its targets:')
      for (const row of l.correctionTargetValues) {
        line(`    ${String(row.name).padEnd(22)} run_speed ${row.run_speed}`)
      }
      line(`  establishes       ${l.establishes}`)
      line(`  does NOT establish ${l.doesNotEstablish}`)
    }
    line()
  }

  line('  READ THE RATIO, NOT ONLY THE CORRELATION. Correlating with run_speed says')
  line('  the measurement tracks the curve\'s INPUT. Whether it measures the curve\'s')
  line('  OUTPUT is the ratio column, and a ratio consistently away from 1.00 says it')
  line('  does not. Contrast the fielding constant above, which lands on the curve to')
  line(`  ${audit.speedAgreement.medianAbsErrorFps} ft/s -- that is what agreement looks like.`)

  return out.join('\n')
}

// The interpretation, carried in the generator so regenerating the report keeps
// it. It was prose appended to the file by hand before, which meant the next
// regeneration silently dropped it and the numbers arrived with no statement of
// what they do and do not support.
// ─── The epilogue: what this run found, and how to read it ───────────────────
//
// TWO DIFFERENT KINDS OF SENTENCE, KEPT APART ON PURPOSE.
//
//   A FINDING is this run's answer and moves when the data moves: how many
//   characters reproduced the curve, which characters did not, how many
//   sessions show the boost, what the ledger says today. Every one of these is
//   derived below from the audit object and none is written down here.
//
//   A METHOD note explains why the check is the check -- what the units mean,
//   what the tolerance is for, why two scopes give two counts, what a ledger
//   row can and cannot answer. Those do not move with the data and are
//   constants.
//
// The previous version of this file wrote the findings out as prose: "70 of 72
// ... 53 of 55 ... exactly two ... exactly one boosted session ... not recorded
// in the ledger". Every one of those was true on the day it was typed and none
// of them was connected to the numbers printed above it, so the first
// re-ingest, the first correction applied, or the first Wario Stadium capture
// would have left the report contradicting its own summary.

const plural = (n, word, suffix = 's') => `${n} ${word}${n === 1 ? '' : suffix}`
const oxford = (items) => (items.length <= 1 ? (items[0] || '')
  : items.length === 2 ? `${items[0]} and ${items[1]}`
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

// ── Findings ─────────────────────────────────────────────────────────────────

function curveAgreementFindings(audit) {
  const db = audit.speedAgreement
  const ar = audit.archiveSpeedAgreement
  const lines = []

  // EVERY CLAIM BELOW IS SCOPED TO OBSERVATIONS THAT WERE ACTUALLY CHECKED.
  // The previous version asserted agreement at the stored resolution and
  // confirmed interpolation unconditionally, so a run with nothing to check,
  // nothing matching, or errors above the rounding floor produced the same
  // confident paragraph as a clean one.
  const scopes = []
  if (ar?.scanned && ar.charactersWithARating > 0) {
    scopes.push({
      name: `the local archive (${plural(ar.sessionsScanned, 'session')})`,
      matched: ar.charactersReproducingTheCurve,
      checked: ar.charactersWithARating,
      interpolated: ar.ofWhichInterpolatedRatings,
    })
  }
  if (db.charactersWithConstant > 0) {
    scopes.push({
      name: 'the database',
      matched: db.charactersReproducingTheCurve,
      checked: db.charactersWithConstant,
      interpolated: db.ofWhichInterpolatedRatings,
    })
  }

  if (!scopes.length) {
    return ['* NOTHING was checked against the workbook FIELD-speed curve on this run:',
      '  no scope produced a character holding a constant with a rating to check it',
      '  against. The curve is neither supported nor contradicted here.']
  }

  const matchedTotal = scopes.reduce((total, scope) => total + scope.matched, 0)
  lines.push('* The workbook FIELD-speed curve against the constant the fielder actor')
  lines.push('  holds. This run:')
  for (const scope of scopes) lines.push(`    - ${scope.matched} of ${scope.checked} over ${scope.name}`)

  if (matchedTotal === 0) {
    lines.push('  NOT ONE of the characters checked reproduced its curve row. Whatever the')
    lines.push('  error figures below say, this run does not support the curve at all.')
  }

  // The error figures describe the MATCHED characters only, and only exist
  // when something matched in the database scope.
  const median = db.medianAbsErrorFps
  const worst = db.worstAbsErrorFps
  const floor = db.roundingFloorFps
  if (median == null || worst == null) {
    lines.push('  No error figures: no database-scope character matched, so there is no')
    lines.push('  residual to summarise.')
  } else if (floor != null && worst > floor) {
    // THE CASE THE OLD WORDING COULD NOT EXPRESS. Above the rounding floor the
    // agreement is a measured closeness, not an identity, and saying
    // "indistinguishable at the stored resolution" would be false.
    lines.push(`  Median |error| ${median} ft/s, worst ${worst} ft/s, which EXCEEDS the`)
    lines.push(`  ${floor} ft/s the capture rounds to. The values are close but they are`)
    lines.push('  distinguishable at the stored resolution, so this is a closeness figure')
    lines.push('  and not an identity claim.')
  } else {
    lines.push(`  Median |error| ${median} ft/s, worst ${worst} ft/s, against a rounding`)
    lines.push(`  floor of ${floor} ft/s -- so for the characters that matched the claim is`)
    lines.push('  "indistinguishable at the stored resolution", not a precision figure.')
  }

  // Interpolation is only confirmed by characters whose rating is NOT a
  // published row and which matched anyway. Zero of those confirms nothing.
  const interpolated = scopes.filter((scope) => scope.interpolated > 0)
  if (!interpolated.length) {
    lines.push('* Linear interpolation between published rows is NOT exercised by this run:')
    lines.push('  every character that matched sits on a published table row, so nothing')
    lines.push('  here distinguishes interpolation from a lookup.')
  } else {
    lines.push('* Linear interpolation between published rows, from the characters whose')
    lines.push('  rating is not a table row and which matched anyway:')
    for (const scope of interpolated) {
      lines.push(`    - ${scope.interpolated} of the ${scope.matched} matched over ${scope.name}`)
    }
  }
  return lines
}

function coverageFindings(audit) {
  const reach = audit.catchReach
  if (reach?.tableMissing) {
    return ['* No catch-approach coverage: the tracking_catch_approaches table was not',
      '  readable on this run, so every reach row on the page is unsupported.']
  }
  const ordinary = reach.perTrackedGame?.ordinary
  const dive = reach.perTrackedGame?.dive
  return [
    '* The catch-approach and coverage counts, with their denominators, and the',
    '  per-game rate separated into qualifying ATTEMPTS and qualifying SECURED',
    '  catches. Only the second moves the display threshold. This run, over',
    `  ${plural(reach.trackedGames ?? 0, 'tracked game')}:`,
    `    - standing ${ordinary?.qualifyingAttemptsPerGame ?? 'n/a'} attempts a game,`
    + ` ${ordinary?.qualifyingSecuredPerGame ?? 'n/a'} secured`,
    `    - dive ${dive?.qualifyingAttemptsPerGame ?? 'n/a'} attempts a game,`
    + ` ${dive?.qualifyingSecuredPerGame ?? 'n/a'} secured`,
  ]
}

// A profile-implied speed counts as CORROBORATED only when an observed
// constant actually sits on it, within the same window the classifier uses.
function corroboration(row, toleranceFps) {
  const expected = finite(row.expectedFromProfileFps)
  const observed = (row.observed || []).map(finite).filter((value) => value != null)
  if (row.profileRunSpeed == null) return { state: 'no-profile' }
  if (row.profileRunSpeed === row.runSpeed) return { state: 'profile-matches-column' }
  if (expected == null || !observed.length) return { state: 'unverified', expected }
  const hit = observed.find((value) => Math.abs(value - expected) <= toleranceFps)
  return hit == null
    ? { state: 'contradicted', expected, observed }
    : { state: 'corroborated', expected, observed: hit }
}

function attributeExceptionFindings(audit) {
  const exceptions = audit.speedAgreement.charactersWithNoCurveMatch || []
  const tolerance = finite(audit.speedAgreement.toleranceFps) ?? 0.01
  if (!exceptions.length) {
    return [
      '* `characters.run_speed` agrees with the game for every character holding a',
      '  constant on this run. The exceptions this report was built to surface are',
      '  GONE -- which is what applying the prepared correction would look like, and',
      '  also what a re-ingest that dropped those characters would look like. The',
      '  ledger and the coverage counts tell those two apart; this line does not.',
    ]
  }

  // TWO DIFFERENT CLAIMS, AND THE OLD CODE MADE ONE DO FOR BOTH. "The profile
  // disagrees with the column" is a comparison of two stored numbers and says
  // nothing about the game. "The profile is corroborated by observations"
  // needs the profile's curve value to actually appear in the capture, which
  // is what makes it evidence for a correction.
  const judged = exceptions.map((row) => ({ ...row, ...corroboration(row, tolerance) }))
  const lines = [
    `* \`characters.run_speed\` disagrees with the game for`
    + ` ${plural(exceptions.length, 'character')}:`,
  ]
  for (const row of judged) {
    const suffix = row.state === 'no-profile' ? 'no talent profile'
      : row.state === 'profile-matches-column' ? `talent profile agrees with the column (${row.profileRunSpeed})`
        : row.state === 'unverified'
          ? `talent profile says ${row.profileRunSpeed}, not checkable against an observation here`
          : row.state === 'contradicted'
            ? `talent profile says ${row.profileRunSpeed} (implying ${row.expected} ft/s), which NO observation matches`
            : `talent profile says ${row.profileRunSpeed}, and an observed ${row.observed} ft/s sits on it`
    lines.push(`    - ${row.name}, column ${row.runSpeed}, ${suffix}`)
  }

  const corroborated = judged.filter((row) => row.state === 'corroborated')
  const contradicted = judged.filter((row) => row.state === 'contradicted')
  const unverified = judged.filter((row) => row.state === 'unverified')
  lines.push(`  CORROBORATED BY OBSERVATION: ${corroborated.length} of ${judged.length}`
    + ` (within ${tolerance} ft/s of the profile's own curve row).`)
  if (corroborated.length === judged.length) {
    lines.push('  Every exception has a second source that the capture agrees with, which')
    lines.push('  is what makes these evidence for a correction rather than a discrepancy.')
  } else if (contradicted.length) {
    lines.push(`  ${plural(contradicted.length, 'exception')} differ from the column and match`)
    lines.push('  NO observation either, so the profile is not evidence for them -- a')
    lines.push('  correction to the profile\'s value would not be supported by this capture.')
  }
  if (unverified.length) {
    lines.push(`  ${plural(unverified.length, 'exception')} UNVERIFIED: no observation was`)
    lines.push('  available to check the profile against, so nothing is claimed either way.')
  }
  return lines
}

function boostFindings(audit) {
  const ar = audit.archiveSpeedAgreement
  if (!ar?.scanned) {
    return ['* Nothing about the boost: the local archive was not scanned on this run',
      `  (${ar?.reason || 'no reason recorded'}), and it is the only scope that shows it.`]
  }
  const sessions = ar.sessionsShowingTheBoost || []
  if (!sessions.length) {
    return ['* NO archived session shows the x1.5 boost on this run. The arithmetic that',
      '  reproduces a boosted row is still in the curve module, and nothing in this',
      '  report currently supports it.']
  }
  const named = sessions.slice(0, 8)
  return [
    `* The boost appears in ${plural(sessions.length, 'archived session')}, named rather`,
    '  than counted so the claim stays falsifiable:',
    ...named.map((row) => `    - \`${row.stem}\`, ${plural(row.characters, 'character')}`
      + (row.parkSessionsScanned
        ? ` (${row.park}: ${row.parkSessionsBoosted} of ${row.parkSessionsScanned} scanned captures boosted)`
        : '')),
    ...(sessions.length > named.length
      ? [`    - and ${sessions.length - named.length} more`] : []),
  ]
}

// ── Ledger, which has four different answers ─────────────────────────────────
//
// Absent, unverified, recorded, not recorded -- and the last two are reported
// SEPARATELY from what the columns actually hold, because the ledger is not
// evidence about the schema. Migrations in this repository have been live on
// production while missing from that table.
function ledgerFindings(audit) {
  const prepared = audit.preparedMigration
  const declared = prepared?.corrections || []
  const version = prepared?.version || 'the prepared migration'
  const ledger = audit.migrationLedger

  if (ledger == null) {
    return [
      `* Migration ledger: NOT CHECKED on this run. Re-run with \`--ledger\` to read it.`,
      '  Nothing below is claimed about whether any migration is recorded as applied.',
    ]
  }
  if (!ledger.checked) {
    return [
      '* Migration ledger: UNVERIFIED. The read did not complete, so its state is',
      `  unknown rather than empty. ${ledger.reason || 'No reason was recorded.'}`,
      '  Run the SELECTs printed in the ledger section by hand; they are read only.',
    ]
  }

  const lines = []
  lines.push(`* Migration ledger, RECORDED STATUS: ${version} is`
    + ` ${ledger.preparedMigrationRecorded ? 'recorded' : 'NOT recorded'} as applied.`)
  lines.push('  That is a statement about the LEDGER. It does not establish that the file')
  lines.push('  was or was not applied: the table has no timestamp and no author column,')
  lines.push('  and migrations here have been live on production while absent from it.')

  if (!declared.length) {
    lines.push('* Observed values: the prepared migration could not be read from disk, so')
    lines.push('  there is nothing to compare the columns against.')
    return lines
  }
  const observed = new Map((ledger.correctionTargetValues || [])
    .map((row) => [row.name, finite(row.run_speed)]))
  const classify = (correction) => {
    const value = observed.get(correction.name)
    if (value == null) return { ...correction, value: null, state: 'absent' }
    if (value === correction.to) return { ...correction, value, state: 'corrected' }
    if (value === correction.from) return { ...correction, value, state: 'prior' }
    return { ...correction, value, state: 'other' }
  }
  const states = declared.map(classify)
  const describe = (row) => {
    if (row.state === 'absent') return `${row.name} not found`
    if (row.state === 'corrected') return `${row.name} ${row.value} (the corrected value)`
    if (row.state === 'prior') return `${row.name} ${row.value} (the prior value)`
    return `${row.name} ${row.value} (neither ${row.from} nor ${row.to})`
  }
  lines.push('* Migration ledger, OBSERVED TARGET VALUES, which are a separate reading:')
  lines.push(`  ${oxford(states.map(describe))}.`)
  const allPrior = states.every((row) => row.state === 'prior')
  const allCorrected = states.every((row) => row.state === 'corrected')
  if (allPrior) {
    lines.push('  Every target still holds the value the correction would change, which is')
    lines.push('  consistent with it not having taken effect. Consistent, not proof: a row')
    lines.push('  can be set back by hand as easily as it can be corrected.')
  } else if (allCorrected) {
    lines.push('  Every target already holds the corrected value, however the ledger reads,')
    lines.push('  so applying the file would be a no-op on these rows.')
  } else {
    lines.push('  The targets DISAGREE with each other, so neither "applied" nor "not')
    lines.push('  applied" describes the current state. Look before doing anything.')
  }
  if (ledger.preparedMigrationRecorded !== allCorrected) {
    lines.push('  NOTE: the recorded status and the observed values do not agree. The')
    lines.push('  ledger and the data are maintained separately and this is exactly the')
    lines.push('  disagreement that makes reading only one of them unsafe.')
  }
  return lines
}

function boostTriggerCaveat(audit) {
  const ar = audit.archiveSpeedAgreement
  if (!ar?.scanned) {
    return ['* What triggers the x1.5 boost. The local archive was not scanned, so this',
      '  run says nothing about it either way.']
  }
  const sessions = ar.sessionsShowingTheBoost || []
  if (!sessions.length) {
    return [
      '* What triggers the x1.5 boost. No session in this run shows it at all, so',
      '  there is nothing here to attribute to a park, a setting or anything else.',
    ]
  }

  // THE SESSION'S OWN IDENTITY, not a remembered one. The previous version
  // described any single boosted session as the Wario Stadium capture and
  // asserted it was the only capture of that park AND the oldest collector
  // format. The park is derivable; the park's coverage is now measured; the
  // collector format is not measured anywhere in this report, so it is not
  // claimed.
  if (sessions.length === 1) {
    const only = sessions[0]
    const lines = [
      '* What triggers the x1.5 boost. One session shows it, and it is',
      `  \`${only.stem}\`. What that session is CONFOUNDED WITH is the question, and`,
      '  this report measures only part of it.',
    ]
    if (only.parkSessionsScanned > 1) {
      // A second capture of the same park that did NOT boost rules the park
      // out as a sufficient explanation, which is the opposite of the old
      // claim.
      lines.push(`  ${only.park} has ${plural(only.parkSessionsScanned, 'scanned capture')} and only`)
      lines.push('  this one boosts, so the PARK ALONE does not explain it -- something that')
      lines.push('  varies between captures of the same park does.')
    } else if (only.parkSessionsScanned === 1) {
      lines.push(`  It is also the only scanned capture of ${only.park}, so the park cannot be`)
      lines.push('  separated from whatever else is particular to this session. A second')
      lines.push(`  ${only.park} capture would separate the park from the rest; it would not`)
      lines.push('  on its own identify a setting.')
    }
    lines.push('  Nothing in this report measures collector format or game settings, so')
    lines.push('  neither is asserted or excluded here.')
    return lines
  }

  const parks = [...new Set(sessions.map((row) => row.park))]
  const lines = [
    `* What triggers the x1.5 boost. ${plural(sessions.length, 'session')} show it`,
    `  across ${plural(parks.length, 'park')} (${oxford(parks)}).`,
  ]
  // Parks where some captures boost and others do not are the informative
  // ones, and they are measured rather than assumed.
  const mixed = sessions.filter((row) => row.parkSessionsScanned > row.parkSessionsBoosted)
  if (mixed.length) {
    lines.push(`  At least one park has captures that do NOT boost`)
    lines.push(`  (${oxford([...new Set(mixed.map((row) => `${row.park}: ${row.parkSessionsBoosted} of ${row.parkSessionsScanned}`))])}),`)
    lines.push('  so the park alone does not explain the boost.')
  }
  lines.push('  Whatever the earlier single-session confounding argument said, it does')
  lines.push('  not describe this run; the comparison is worth redoing and nothing here')
  lines.push('  has done it.')
  return lines
}

function baserunningCaveat(audit) {
  const retained = (audit.runnerSprint?.analyses || [])[0]
  if (!retained) {
    return ['* Whether the baserunning curve describes anything measured: no runner',
      '  analysis ran on this report, so there is no comparison to draw.']
  }
  const ratio = retained.ratioToBaserunCurve || {}
  const median = finite(ratio.median)
  const r = finite(retained.pearsonVsRunSpeed)
  const support = `r = ${r ?? 'n/a'} over ${plural(retained.characters ?? 0, 'character')}`

  if (median == null) {
    return ['* Whether the baserunning curve describes anything measured. The runner',
      `  analysis produced no ratio to the curve (${support}), so the only thing`,
      '  available is the correlation, and a correlation with the curve\'s INPUT axis',
      '  says nothing about its OUTPUT.']
  }

  // A RATIO NEAR 1 IS AGREEMENT, and the old wording said "sits a consistent
  // 1.14x ABOVE" whatever the number was -- including below 1, and including
  // 1.00 itself, where the conclusion reverses.
  const band = 0.02
  const within = Math.abs(median - 1) <= band
  const direction = median > 1 ? 'above' : 'below'
  if (within) {
    return [
      '* That the baserunning curve describes something OTHER than what is measured',
      `  is NOT what this run shows. Measured runner sprint tracks the rating`,
      `  (${support}) and sits at ${median}x the curve's own values`,
      `  (p10 ${ratio.p10}, p90 ${ratio.p90}) -- within ${band} of 1.00, so on this run the`,
      '  measurement and the curve agree in magnitude as well as in rank. The curve',
      '  is still flagged unvalidated because the offense actor holds no constant to',
      '  check it against directly; this is agreement with a measurement, not with',
      '  the game\'s own stored answer.',
    ]
  }
  return [
    '* That the baserunning curve describes anything measured. Runner sprint tracks',
    `  the rating (${support}) but sits a consistent ${median}x`,
    `  ${direction} the curve's own values (p10 ${ratio.p10}, p90 ${ratio.p90}),`,
    '  so it measures a different quantity.',
  ]
}

// ── Method: the parts that do not move with the data ─────────────────────────

const EPILOGUE_METHOD = [
  '## How to read these numbers',
  '',
  'THE TOLERANCE IS NOT THE PRECISION. A constant is called ordinary only when it',
  'is already within the match window of the curve row its rating implies, so the',
  'difference the Scouting Report shows on that row cannot come out much larger',
  'than the window. What the window does NOT decide is how much of the cast lands',
  'inside it at all, and that count -- with its denominator -- is the evidence.',
  '',
  'THE TWO SCOPES ARE DIFFERENT POPULATIONS. The local archive holds captures that',
  'were never ingested, so it is LARGER than the database for the same check.',
  'Neither count substitutes for the other and both are printed with their scope.',
  '',
  'THE VERIFIER COUNTS FEWER CHARACTERS THAN THIS REPORT for the same archive, and',
  'that is NAME MATCHING rather than a different dataset:',
  '`scripts/verify_speed_against_attributes.mjs` looks characters up by their exact',
  'capture name, so the ones the capture and the site spell differently drop out,',
  'along with every Mii. This report resolves through `characterNameKey` and loses',
  'none of them. Worth fixing in the verifier separately; it changes no conclusion',
  'in either place.',
  '',
  'A LEDGER ROW ANSWERS ONE QUESTION. `supabase_migrations.schema_migrations` has',
  '`version`, `name` and `statements` -- no timestamp, no author. Its current state',
  'says which versions are RECORDED as applied. It cannot say when a row was',
  'written, who wrote it, whether the file on disk is the file that ran, or whether',
  'something was applied without being recorded. Absence is not proof a migration',
  'never ran, which is why the observed column values are reported beside it as a',
  'separate reading rather than folded into the same sentence.',
  '',
  'STANDING QUALIFICATIONS, independent of any run:',
  '',
  '* The workbook catch radii and the measured separations are NOT the same',
  '  quantity: one is glove-relative, the other runs from the fielder actor origin.',
  '  No delta between them is published anywhere. The r = 0.73 once cited for',
  '  standing reach is a single archive pass, not reproducible from the database',
  '  the page reads, and it did not hold at the other approaches (dive ranked at',
  '  r = -0.53). It is not a ranking justification.',
  '* Which workbook column is the jump reach, what the glove offset is, and the',
  '  fielder\'s facing direction are all unidentified. None is a sample-size',
  '  problem, so no number of additional games resolves any of them. They need a',
  '  memory mapping or a controlled scenario suite.',
  '',
]

/**
 * The report's closing sections, derived from the audit it is closing.
 *
 * Exported so tests can hand it a synthetic audit and check that the prose
 * followed the numbers -- see tests/character-mechanics-audit-report.test.mjs.
 */
export function buildReportEpilogue(audit) {
  return [
    '## What this run found',
    '',
    'Each statement below is generated from the numbers printed above it, so it',
    'moves when they move. Regenerate rather than quoting it from here.',
    '',
    ...curveAgreementFindings(audit),
    ...coverageFindings(audit),
    ...attributeExceptionFindings(audit),
    ...boostFindings(audit),
    ...ledgerFindings(audit),
    '',
    '## What this run does not establish',
    '',
    ...boostTriggerCaveat(audit),
    ...baserunningCaveat(audit),
    '',
    ...EPILOGUE_METHOD,
  ]
}

async function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const reportIndex = args.indexOf('--report')
  const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : null
  const withLedger = args.includes('--ledger')
  const minWindowsIndex = args.indexOf('--min-windows')
  const minWindows = minWindowsIndex >= 0 ? Number(args[minWindowsIndex + 1]) : 6

  const env = { ...loadEnv(path.resolve('.env')), ...process.env }
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required')
  }
  // Anon, unauthenticated, and never signed in: this command must not be able
  // to write even by accident.
  const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

  const db = await readDatabase(supabase)
  const audit = {
    generatedUtc: new Date().toISOString(),
    databaseHost: new URL(env.VITE_SUPABASE_URL).hostname,
    gameFrameRate: GAME_FRAME_RATE,
    units: {
      maxSpeed: 'feet per second (movement_metrics.max_speed_fps)',
      catchSeparation: 'world units (tracking_catch_approaches.separation_3d_units)',
      workbookCurve: 'world units per frame, converted at GAME_FRAME_RATE then to feet',
    },
    scope: auditScope(db),
    coverage: auditCoverage(db),
    plateAppearances: await auditPlateAppearances(supabase, db),
    catchReach: auditCatchReach(db, { minWindows, trackedGames: auditScope(db).distinctTrackedGames }),
    speedAgreement: auditSpeedAgreement(db),
    archiveSpeedAgreement: auditArchiveSpeedAgreement(db),
    runnerSprint: auditRunnerSprint(db),
    // A local file read, so it happens whether or not the ledger was asked for:
    // what the correction WOULD change is knowable without a database.
    preparedMigration: readPreparedMigration(),
    // Only when asked for: it needs the Supabase CLI rather than the anon key.
    migrationLedger: withLedger ? auditMigrationLedger() : null,
  }

  const text = formatText(audit)
  if (asJson) console.log(JSON.stringify(audit, null, 2))
  else console.log(text)

  if (reportPath) {
    const body = [
      `# Character mechanics audit — ${audit.generatedUtc.slice(0, 10)}`,
      '',
      'Regenerate this file exactly, read only:',
      '',
      '```',
      `node scripts/audit_character_mechanics.mjs --ledger --report ${reportPath}`,
      '```',
      '',
      'The related checks, each answering a different question:',
      '',
      '```',
      'node scripts/verify_speed_against_attributes.mjs          measured vs the game attributes',
      'node scripts/analyze_run_speed_correction_impact.mjs      the prepared run_speed migration',
      'node --test tests/character-run-speed-migration.test.mjs  that migration, on a throwaway Postgres',
      '```',
      '',
      'FOUR SCOPES APPEAR BELOW AND ARE NOT INTERCHANGEABLE.',
      '',
      '* **Database-wide** — every active tracking row, whatever the site does with it.',
      '* **Application-visible** — the subset a scouting report reaches, after',
      '  `selectAdvancedRows` drops games that are on no schedule. The SCOPE section',
      '  names those games.',
      '* **Scoped** — one season or tournament, which the page also offers. Not',
      '  reported here; every count below is career-wide.',
      '* **Local archive** — `data/player_tracking`, which holds captures that were',
      '  never ingested and is therefore LARGER than the database for the same check.',
      '',
      'Read only. No credentials or configuration are recorded here beyond the',
      'database hostname, which is already public in the client bundle. The ledger',
      'section is the one part that does not go through the anon key: it runs three',
      'SELECTs through the Supabase CLI against the linked project.',
      '',
      '```',
      text,
      '```',
      '',
      ...buildReportEpilogue(audit),
    ].join(NEWLINE)
    fs.writeFileSync(path.resolve(reportPath), body, 'utf8')
    console.log(`\nreport written to ${reportPath}`)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`audit_character_mechanics: ${error.message}`)
    process.exit(1)
  })
}
