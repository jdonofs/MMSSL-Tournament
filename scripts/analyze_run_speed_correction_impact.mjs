// What correcting `characters.run_speed` for Dry Bones and Green Paratroopa
// would actually change.
//
//   node scripts/analyze_run_speed_correction_impact.mjs
//   node scripts/analyze_run_speed_correction_impact.mjs --json
//
// READ ONLY, AND IN MEMORY. It reads with the anon key the app uses, applies
// the two corrected ratings to a COPY of the characters it just read, and runs
// the existing model twice over the same rows. Nothing is written, no stored
// column is touched, and the prepared migration stays unapplied.
//
// WHY IT EXISTS. The migration's own notes said the correction reaches only the
// verifier and the audit. That was incomplete:
// `scripts/recompute_advanced_metrics.mjs` reads this column straight into
// `extraBaseFeatures`, and `runner_speed` is one of the four inputs of the
// ACTIVE extra-base decision model -- so a recompute after the correction could
// move expected attempt probabilities, and with them runner and arm run values
// and every WAR built on those. "Could" is not "does", and the difference is
// entirely a question of whether the current data contains the two characters
// in the affected role. That is what this measures, rather than reasoning
// about it.
//
// TWO THINGS ARE REPORTED SEPARATELY AND MUST NOT BE READ AS ONE:
//
//   IMPACT       the before/after difference over the rows that exist today.
//   SENSITIVITY  what the model does to a rating change in the abstract,
//                measured on today's rows with the runner swapped. It says how
//                much the correction WOULD matter, not how much it does.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import {
  fetchSupersededTrackingPlayIds,
  onlyActiveTrackingPlays,
} from '../src/utils/activeTrackingVersions.js'
import {
  buildRunExpectancy,
  extraBaseFeatures,
  modelRunnerOpportunities,
  scoreExtraBaseDecision,
} from '../src/utils/advancedDefense.js'
import { characterNameKey, indexByCharacterName } from '../src/utils/characterNames.js'
import { getFieldSpeed } from '../src/data/gameSpeedCurves.js'

const DECISION_MODEL_PATH = path.resolve('data/calibration/runner-decision-model-v1.json')
const TRACKING_DIR = path.resolve('data/player_tracking')
const TALENT_PROFILES_PATH = path.resolve('src/data/characterTalentProfiles.json')
const METRES_TO_FEET = 3.280839895

// Exactly what supabase/migrations/20260921130000_character_run_speed_corrections.sql
// would write, named the same way so the two cannot drift apart unnoticed.
const CORRECTIONS = [
  { name: 'Dry Bones', from: 40, to: 50 },
  { name: 'Green Paratroopa', from: 64, to: 52 },
]

// Every place in the repository that reads this column directly, found by
// grepping for `run_speed` and classified by hand. Printed so the inventory is
// part of the report rather than a claim made once in a migration comment.
const DIRECT_CONSUMERS = [
  ['scripts/recompute_advanced_metrics.mjs', 'WRITES DERIVED VALUES',
    'runnerSpeed into extraBaseFeatures; the active decision model scores it, and the '
    + 'result is persisted to runner_opportunities. The only consumer that can change '
    + 'a stored number.'],
  ['scripts/calibrate_runner_decisions.mjs', 'REFITS THE MODEL',
    'the same feature, over the LOCAL ARCHIVE, when the decision model is re-fitted. '
    + 'Changes the artifact rather than the database, and only when it is re-run.'],
  ['scripts/verify_speed_against_attributes.mjs', 'REPORTS',
    'correlates measured speeds against this column. Output only.'],
  ['scripts/audit_character_mechanics.mjs', 'REPORTS',
    'deliberately reads the COLUMN rather than the resolver, so the disagreement '
    + 'stays visible. Output only.'],
  ['src/utils/characterAnalysis.js', 'FALLBACK ONLY',
    'resolveCharacterRunSpeed() prefers the talent profile and reaches this column '
    + 'only for a character with no profile.'],
  ['src/utils/measuredAttributes.js', 'FALLBACK ONLY',
    'buildMinedIndex takes profile.runSpeed first, through the same resolver.'],
  ['src/pages/Stats.jsx', 'SELECTED, NOT READ DIRECTLY',
    'the column is in the select list; the page uses the resolver.'],
]

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
const round = (value, digits = 6) => (value == null ? null : Number(value.toFixed(digits)))
const topFraction = (values, fraction) => {
  const sorted = [...values].sort((a, b) => b - a)
  const take = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * fraction)))
  return take.reduce((sum, value) => sum + value, 0) / take.length
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

function loadDecisionModel() {
  if (!fs.existsSync(DECISION_MODEL_PATH)) return null
  return JSON.parse(fs.readFileSync(DECISION_MODEL_PATH, 'utf8'))
}

// ─── The database, exactly as the recompute reads it ─────────────────────────

async function readDatabase(supabase) {
  const [characters, runners, plays, tournamentPas, seasonPas, superseded] = await Promise.all([
    fetchAllRows(() => supabase.from('characters').select('id,name,run_speed,throwing_speed')),
    fetchAllRows(() => supabase.from('runner_opportunities').select('*')),
    fetchAllRows(() => supabase.from('tracking_plays')
      .select('id,competition_type,pa_id,first_touch_frame,quality')),
    fetchAllRows(() => supabase.from('plate_appearances').select('*')),
    fetchAllRows(() => supabase.from('season_plate_appearances').select('*')),
    fetchSupersededTrackingPlayIds(supabase),
  ])
  const failures = Object.entries({
    characters, runner_opportunities: runners, tracking_plays: plays,
    plate_appearances: tournamentPas, season_plate_appearances: seasonPas,
    superseded,
  }).filter(([, result]) => result.error)
  if (failures.length) {
    throw new Error(`read failed: ${failures.map(([n, r]) => `${n}: ${r.error.message}`).join('; ')}`)
  }
  return {
    characters: characters.data,
    runners: runners.data,
    plays: plays.data,
    activePlays: onlyActiveTrackingPlays(plays.data, superseded.data),
    plateAppearances: [
      ...(tournamentPas.data || []).map((row) => ({ ...row, competition_type: 'tournament' })),
      ...(seasonPas.data || []).map((row) => ({ ...row, competition_type: 'season' })),
    ],
  }
}

/**
 * The runner-opportunity model, run over one set of character attributes.
 *
 * Identical to the call in scripts/recompute_advanced_metrics.mjs, so what is
 * compared here is what a recompute would persist -- not a re-derivation of it.
 */
function modelWith(db, characters, decisionModel) {
  const expectancy = buildRunExpectancy(db.plateAppearances)
  const charactersById = new Map(characters.map((row) => [String(row.id), row]))
  const charactersByName = indexByCharacterName(characters, (row) => row.name, { collapseMii: true })
  const contextByPa = new Map(db.activePlays
    .filter((play) => play.pa_id != null && play.quality?.runner_context)
    .map((play) => [`${play.competition_type}:${play.pa_id}`, play.quality.runner_context]))

  return modelRunnerOpportunities(db.runners, expectancy, {
    decisionModel,
    featuresFor: (row) => {
      const context = contextByPa.get(`${row.competition_type}:${row.pa_id}`)
      const fielder = charactersByName.get(characterNameKey(context?.touch?.character, { collapseMii: true }))
        || charactersById.get(String(row.responsible_fielder_character_id))
      return extraBaseFeatures(row, context, {
        runnerSpeed: charactersById.get(String(row.runner_character_id))?.run_speed,
        fielderArm: fielder?.throwing_speed,
      })
    },
  })
}

/**
 * Before against after, row by row, keeping every identity the change touches.
 *
 * TWO IDENTITIES PER ROW, NOT ONE. `runner_run_value` is credited to the
 * RUNNER and `arm_run_value` to the RESPONSIBLE FIELDER, and they are equal and
 * opposite by construction -- the model computes arm value as the negation of
 * runner value. Summing them together therefore always gives zero and says
 * nothing, while the two players underneath it can both have moved. Both sides
 * are carried here so the aggregation can keep them apart.
 *
 * Deltas are RAW. Rounding belongs to presentation; rounding into the record
 * and then summing the records loses precision the comparison is made of.
 */
export function diffModelled(before, after) {
  const key = (row) => `${row.competition_type}:${row.id}`
  const afterByKey = new Map(after.map((row) => [key(row), row]))
  const changes = []
  let eligible = 0
  let fitted = 0
  for (const row of before) {
    const other = afterByKey.get(key(row))
    if (!other) continue
    if (finite(row.expected_attempt_probability) != null) eligible += 1
    // A row only reaches the FITTED model when extraBaseFeatures could build
    // its four inputs; the rest fall back to the shrunk context average, which
    // has no run_speed in it and therefore cannot move.
    if (String(other.model_version || '').includes('decision:')) fitted += 1
    const deltas = {
      attempt: (finite(other.expected_attempt_probability) ?? 0) - (finite(row.expected_attempt_probability) ?? 0),
      success: (finite(other.expected_success_probability) ?? 0) - (finite(row.expected_success_probability) ?? 0),
      runner: (finite(other.runner_run_value) ?? 0) - (finite(row.runner_run_value) ?? 0),
      arm: (finite(other.arm_run_value) ?? 0) - (finite(row.arm_run_value) ?? 0),
    }
    if (Object.values(deltas).every((value) => Math.abs(value) < 1e-12)) continue
    changes.push({
      id: row.id,
      competition_type: row.competition_type,
      pa_id: row.pa_id,
      opportunity_type: row.opportunity_type,
      // WHO EACH HALF OF THIS ROW BELONGS TO.
      runner_character_id: row.runner_character_id ?? null,
      runner_player_id: row.runner_player_id ?? null,
      responsible_fielder_character_id: row.responsible_fielder_character_id ?? null,
      responsible_fielder_player_id: row.responsible_fielder_player_id ?? null,
      responsible_fielder_position: row.responsible_fielder_position ?? null,
      before: {
        expected_attempt_probability: finite(row.expected_attempt_probability),
        runner_run_value: finite(row.runner_run_value),
        arm_run_value: finite(row.arm_run_value),
      },
      after: {
        expected_attempt_probability: finite(other.expected_attempt_probability),
        runner_run_value: finite(other.runner_run_value),
        arm_run_value: finite(other.arm_run_value),
      },
      deltas,
    })
  }
  return { changes, eligibleRows: eligible, fittedRows: fitted }
}

/**
 * Per-beneficiary totals, runner side and arm side kept apart.
 *
 * THE REASON THIS IS NOT ONE NUMBER. A league-wide total of runner plus arm
 * deltas is zero on every row by construction, so a report that adds them
 * concludes "nothing moved" precisely when two different players moved in
 * opposite directions. The only honest aggregate is per side, per identity.
 *
 * A BENEFICIARY IS A CHARACTER *AND* A PLAYER, NOT A CHARACTER. The same
 * character is fielded by different players across a league, and an earlier
 * version keyed these maps on the character id alone while keeping whichever
 * player id it saw first. Two owners of the same character moving in opposite
 * directions collapsed into one row reading zero, under one of their names --
 * exactly the cancellation this function exists to prevent, reintroduced one
 * level down.
 *
 * A MISSING ID IS ITS OWN GROUP. An unresolved character or player is never
 * folded into a resolved one: the pairs (37, null) and (37, "p-a") are
 * different beneficiaries, because the first is "character 37, owner unknown"
 * and attaching its runs to a named player would be an attribution nobody
 * made.
 *
 * Summed at full precision; callers round for display.
 */
export function attributeImpact(changes = []) {
  const runners = new Map()
  const fielders = new Map()
  const bump = (map, characterId, playerId, delta) => {
    const character = characterId == null ? null : String(characterId)
    const player = playerId == null ? null : String(playerId)
    // Both halves in the key, and the null case spelled rather than blank, so
    // a character id of the literal string "none" cannot collide with an
    // absent one.
    const key = `character:${character ?? '\u0000none'}|player:${player ?? '\u0000none'}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        characterId: characterId ?? null,
        playerId: playerId ?? null,
        characterKnown: character != null,
        playerKnown: player != null,
        // True only when NEITHER side is known. A row with one of the two is
        // still attributable, just not completely.
        unattributed: character == null && player == null,
        rows: 0,
        runValueDelta: 0,
      })
    }
    const entry = map.get(key)
    entry.rows += 1
    entry.runValueDelta += delta
  }
  for (const change of changes) {
    if (Math.abs(change.deltas.runner) > 0) {
      bump(runners, change.runner_character_id, change.runner_player_id, change.deltas.runner)
    }
    if (Math.abs(change.deltas.arm) > 0) {
      bump(fielders, change.responsible_fielder_character_id,
        change.responsible_fielder_player_id, change.deltas.arm)
    }
  }
  const sorted = (map) => [...map.values()]
    .sort((a, b) => Math.abs(b.runValueDelta) - Math.abs(a.runValueDelta))
  const runnerSide = sorted(runners)
  const armSide = sorted(fielders)
  const distinct = (rows, field) => new Set(
    rows.filter((row) => row[`${field}Known`]).map((row) => String(row[`${field}Id`])),
  ).size
  return {
    runnerSide,
    armSide,
    // Reported so a reader can SEE that the two sides cancel, rather than
    // being handed the cancelled total as if it were the finding.
    runnerTotal: changes.reduce((total, change) => total + change.deltas.runner, 0),
    armTotal: changes.reduce((total, change) => total + change.deltas.arm, 0),
    // NAMED FOR WHAT THEY COUNT. A beneficiary is one character/player pair;
    // the character and player counts are the distinct resolved ids behind
    // those pairs, and the three are not the same number whenever a character
    // is shared or an id is missing.
    runnerBeneficiaries: runnerSide.length,
    armBeneficiaries: armSide.length,
    distinctRunnerCharacters: distinct(runnerSide, 'character'),
    distinctRunnerPlayers: distinct(runnerSide, 'player'),
    distinctFielderCharacters: distinct(armSide, 'character'),
    distinctFielderPlayers: distinct(armSide, 'player'),
  }
}

/**
 * Why nothing moved, when nothing moved.
 *
 * "Neither corrected character appears" is ONE of several reasons and was
 * being printed for all of them. A corrected character can be in the data and
 * still produce no change: their opportunities may not be model-eligible, may
 * not reach the fitted model, or the column may already hold the corrected
 * value so the patched copy is identical to the live one.
 */
export function classifyNoChange({
  rowsWithCorrectedRunner = 0,
  fittedRowsWithCorrectedRunner = 0,
  correctionsAlreadyApplied = [],
  correctionsPending = [],
} = {}) {
  if (!correctionsPending.length && correctionsAlreadyApplied.length) {
    return {
      reason: 'already-corrected',
      text: 'every correction target already holds the corrected value, so the patched '
        + 'copy is identical to the live column and nothing could move.',
    }
  }
  if (rowsWithCorrectedRunner === 0) {
    return {
      reason: 'no-corrected-runner',
      text: 'no opportunity row has a corrected character as its runner, so no row\'s '
        + 'runner_speed feature changed.',
    }
  }
  if (fittedRowsWithCorrectedRunner === 0) {
    return {
      reason: 'present-but-unmodelled',
      text: `${rowsWithCorrectedRunner} opportunity row(s) DO have a corrected character `
        + 'as the runner, but none of them reaches the fitted model -- they fall back to '
        + 'the shrunk context average, which has no runner_speed in it. The rating change '
        + 'is real and the model never reads it on these rows.',
    }
  }
  return {
    reason: 'modelled-but-identical',
    text: `${fittedRowsWithCorrectedRunner} fitted row(s) have a corrected character as the `
      + 'runner and still produced identical values. That is not expected from a non-zero '
      + 'coefficient; look at the features before trusting it.',
  }
}

// ─── Sensitivity: what the model does to a rating change, on today's rows ────
//
// DELIBERATELY NOT THE IMPACT. Every eligible row is re-scored with its runner
// replaced by a runner at each of the four ratings, so the numbers below say
// how much this model cares about `runner_speed` at the feature values that
// actually occur. They are a property of the model, not of these two
// characters, and they apply to the correction only if a row like these ever
// has one of them as the runner.
function sensitivity(db, characters, decisionModel) {
  if (!decisionModel || decisionModel.status !== 'active') return null
  const charactersById = new Map(characters.map((row) => [String(row.id), row]))
  const charactersByName = indexByCharacterName(characters, (row) => row.name, { collapseMii: true })
  const contextByPa = new Map(db.activePlays
    .filter((play) => play.pa_id != null && play.quality?.runner_context)
    .map((play) => [`${play.competition_type}:${play.pa_id}`, play.quality.runner_context]))

  const pairs = []
  for (const row of db.runners) {
    if (row.is_discretionary === false) continue
    if (!['hold', 'advance_safe', 'advance_out'].includes(row.outcome)) continue
    const context = contextByPa.get(`${row.competition_type}:${row.pa_id}`)
    const fielder = charactersByName.get(characterNameKey(context?.touch?.character, { collapseMii: true }))
      || charactersById.get(String(row.responsible_fielder_character_id))
    const at = (speed) => {
      const features = extraBaseFeatures(row, context, {
        runnerSpeed: speed, fielderArm: fielder?.throwing_speed,
      })
      return features ? scoreExtraBaseDecision(decisionModel, row, features) : null
    }
    for (const correction of CORRECTIONS) {
      const from = at(correction.from)
      const to = at(correction.to)
      if (from == null || to == null) continue
      pairs.push({ name: correction.name, from, to, delta: to - from })
    }
  }
  const byName = {}
  for (const correction of CORRECTIONS) {
    const mine = pairs.filter((entry) => entry.name === correction.name)
    if (!mine.length) continue
    const deltas = mine.map((entry) => entry.delta)
    byName[correction.name] = {
      ratingChange: `${correction.from} → ${correction.to}`,
      rowsScored: mine.length,
      meanProbabilityDelta: round(deltas.reduce((s, v) => s + v, 0) / deltas.length),
      minProbabilityDelta: round(Math.min(...deltas)),
      maxProbabilityDelta: round(Math.max(...deltas)),
    }
  }
  // The arithmetic behind those numbers, so the report does not depend on a
  // reader trusting the loop: the feature is standardized and the model is a
  // logistic, so the change in the LINEAR predictor is exact and constant.
  const standardization = decisionModel.standardization?.runner_speed
  const index = 1 + (decisionModel.features || []).indexOf('runner_speed')
  const coefficient = decisionModel.coefficients?.[index]
  return {
    note: 'MODEL SENSITIVITY, NOT CURRENT-DATA IMPACT. Every eligible row re-scored '
      + 'with its runner replaced by a runner at each rating.',
    linearPredictorShift: Object.fromEntries(CORRECTIONS.map((correction) => [
      correction.name,
      round(((correction.to - correction.from) / (standardization?.scale ?? 1)) * (coefficient ?? 0)),
    ])),
    runnerSpeedCoefficient: round(coefficient),
    runnerSpeedScale: round(standardization?.scale),
    byCharacter: byName,
  }
}

// ─── The verifier's correlations, before and after ───────────────────────────
//
// The migration predicted these would "move up slightly". A correlation is not
// obliged to move in the direction that makes a story, so it is measured. The
// THROW correlation is included precisely because it must not move at all:
// editing run_speed cannot change a correlation against throwing_speed, and a
// report that showed it moving would be reporting a bug in itself.

function collectArchiveSamples() {
  const fielder = new Map()
  const runner = new Map()
  const throwing = new Map()
  const push = (map, key, value) => {
    if (!key) return
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(value)
  }
  if (!fs.existsSync(TRACKING_DIR)) return { fielder, runner, throwing, sessions: 0, excluded: 0 }
  let sessions = 0
  let excluded = 0
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
      for (const [map, actors] of [[fielder, play.fielders], [runner, play.runners]]) {
        for (const actor of Object.values(actors || {})) {
          if (!actor || !actor.sprint_speed_ups) continue
          if (actor.assist_frames || actor.teleports) continue
          if ((actor.run_path_units || 0) < 10) continue
          push(map, actor.character, actor.sprint_speed_ups)
        }
      }
      for (const record of play.throws || []) {
        if (record.is_throw === false || !record.peak_speed_mph || record.buddy_throw) continue
        push(throwing, record.thrower_character, record.peak_speed_mph)
      }
    }
  }
  return { fielder, runner, throwing, sessions, excluded }
}

function correlate(samples, attribute, characters, estimator) {
  const byName = new Map(characters.map((row) => [row.name, row]))
  const xs = []
  const ys = []
  for (const [name, values] of samples) {
    if (values.length < 6) continue
    const character = byName.get(name)
    if (!character || character[attribute] == null) continue
    xs.push(estimator(values))
    ys.push(character[attribute])
  }
  return { r: round(pearson(xs, ys), 4), characters: xs.length }
}

function verifierDelta(archive, before, after) {
  const pairs = [
    ['fielder sprint speed', archive.fielder, 'run_speed', (v) => topFraction(v, 2 / 3)],
    ['runner sprint speed', archive.runner, 'run_speed', (v) => topFraction(v, 2 / 3)],
    ['throw velocity (non-Buddy)', archive.throwing, 'throwing_speed', (v) => topFraction(v, 0.1)],
  ]
  return pairs.map(([label, samples, attribute, estimator]) => {
    const was = correlate(samples, attribute, before, estimator)
    const now = correlate(samples, attribute, after, estimator)
    return {
      metric: label,
      attribute,
      before: was.r,
      after: now.r,
      delta: was.r == null || now.r == null ? null : round(now.r - was.r, 4),
      charactersMatched: now.characters,
      // The verifier matches characters by their exact capture name, so a
      // correction only reaches it if the capture spells the name the same way.
      // Only the run_speed comparisons can move. Named explicitly rather than
      // left to the reader, because "both characters have samples here" is
      // true of the throw comparison too and means nothing there.
      correctionCanMoveThis: attribute === 'run_speed',
      correctedCharactersInThisComparison: CORRECTIONS
        .filter((correction) => samples.has(correction.name)
          && samples.get(correction.name).length >= 6)
        .map((correction) => correction.name),
    }
  })
}

// ─── How many archive rows a REFIT would see differently ─────────────────────

function refitExposure(archive) {
  return CORRECTIONS.map((correction) => ({
    name: correction.name,
    runnerWindowsInArchive: archive.runner.get(correction.name)?.length ?? 0,
    fielderWindowsInArchive: archive.fielder.get(correction.name)?.length ?? 0,
  }))
}

// ─── Output ──────────────────────────────────────────────────────────────────

// Small presentation helpers. Every number reaching them was summed at full
// precision; this is the only place rounding and sign formatting happen.
const signed = (value) => (value == null ? 'n/a' : `${value > 0 ? '+' : ''}${value}`)
// BOTH HALVES OF THE IDENTITY, always, and an explicit word for a missing one.
// `character 37` alone read as if there were only one beneficiary per
// character, which is the grouping bug this label was printing the result of.
const label = (row) => `${row.characterKnown ? `character ${row.characterId}` : 'character unknown'}`
  + ` / ${row.playerKnown ? `player ${row.playerId}` : 'player unknown'}`
function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    if (current && (current.length + 1 + word.length) > width) { lines.push(current); current = word }
    else current = current ? `${current} ${word}` : word
  }
  if (current) lines.push(current)
  return lines
}

/**
 * The text report.
 *
 * Exported because today's data produces ZERO changes, so the branch that
 * renders a non-zero impact would otherwise never run until the day it
 * mattered. tests/run-speed-impact-attribution.test.mjs renders it from a
 * synthetic report.
 */
export function formatText(report) {
  const out = []
  const line = (text = '') => out.push(text)

  line(`run_speed correction impact — ${report.generatedAt}`)
  line(`Database: ${report.host}  (anon key, read only; nothing was written)`)
  line()
  line('THE CORRECTION')
  for (const row of report.corrections) {
    line(`  ${row.name.padEnd(20)} ${row.from} → ${row.to}`
      + `   live column now: ${row.liveValue ?? 'not found'} [${row.state}]`
      + `   talent profile: ${row.profileRunSpeed ?? 'none'}`)
    line(`  ${' '.repeat(20)} curve at ${row.from}: ${row.fpsFrom} ft/s;`
      + ` at ${row.to}: ${row.fpsTo} ft/s`)
  }
  line()
  line('DIRECT CONSUMERS OF characters.run_speed')
  for (const [file, kind, what] of report.directConsumers) {
    line(`  ${kind.padEnd(24)} ${file}`)
    line(`      ${what}`)
  }
  line()
  line('IMPACT ON CURRENT DATA  (the active runner-decision model, today\'s rows)')
  line(`  decision model                   ${report.decisionModel.model_version} (${report.decisionModel.status})`)
  line(`  runner_opportunities rows        ${report.impact.totalRows}`)
  line(`  ...eligible for the model        ${report.impact.eligibleRows}`)
  line(`  ...scored by the FITTED model    ${report.impact.fittedRows}`
    + '  (the rest fall back to the context average, which has no run_speed in it)')
  line(`  ...with a corrected character as the runner   ${report.impact.rowsWithCorrectedRunner}`)
  line(`  ...of those, reaching the fitted model        ${report.impact.fittedRowsWithCorrectedRunner}`)
  line(`  rows whose modelled values move  ${report.impact.changedRows}`)

  if (report.impact.changedRows === 0) {
    // THE REASON IS CLASSIFIED, NOT ASSUMED. "Neither corrected character
    // appears" used to print for every zero, including the cases where one of
    // them did appear.
    const reason = report.impact.noChangeReason
    line(`     no change, because: ${reason?.reason ?? 'unclassified'}`)
    for (const chunk of wrap(reason?.text || 'no reason was recorded.', 72)) line(`     ${chunk}`)
    line('     This is a fact about the CURRENT data, not about the model: see')
    line('     SENSITIVITY below for what the model does with the rating change.')
  } else {
    line()
    line('  THE TWO SIDES ARE NOT ADDED. arm_run_value is the negation of')
    line('  runner_run_value on the same row, so a league-wide total of the two is')
    line('  zero however much individual players moved. Each side is reported with')
    line('  the identity it belongs to.')
    line()
    line(`  RUNNER SIDE  (baserunning runs)   ${report.impact.runnerBeneficiaries} beneficiaries`
      + `  (${report.impact.distinctRunnerCharacters} characters,`
      + ` ${report.impact.distinctRunnerPlayers} players)`)
    for (const row of report.impact.runnerSide) {
      line(`    ${label(row).padEnd(44)} ${signed(row.runValueDelta)}`
        + `  over ${row.rows} row${row.rows === 1 ? '' : 's'}`)
    }
    line(`  ARM SIDE  (fielding runs)         ${report.impact.armBeneficiaries} beneficiaries`
      + `  (${report.impact.distinctFielderCharacters} characters,`
      + ` ${report.impact.distinctFielderPlayers} players)`)
    for (const row of report.impact.armSide) {
      line(`    ${label(row).padEnd(44)} ${signed(row.runValueDelta)}`
        + `  over ${row.rows} row${row.rows === 1 ? '' : 's'}`)
    }
    line('     A BENEFICIARY IS A CHARACTER/PLAYER PAIR. The same character owned by')
    line('     two players is two beneficiaries and their run values do not merge.')
    line(`  runner side total                ${signed(report.impact.runnerTotalRunValueDelta)}`)
    line(`  arm side total                   ${signed(report.impact.armTotalRunValueDelta)}`
      + '   (the mirror of the line above; not a finding)')
    line()
    line('  per-row detail:')
    for (const change of report.impact.changes) {
      line(`    ${change.competition_type} PA ${change.pa_id} (${change.opportunity_type}):`
        + ` p ${change.before.expected_attempt_probability} → ${change.after.expected_attempt_probability}`
        + ` (${signed(change.deltas.attempt)})`)
      line(`      runner ${change.runner_character_id ?? 'unresolved'}`
        + ` (player ${change.runner_player_id ?? 'unresolved'}) ${signed(change.deltas.runner)}`)
      line(`      fielder ${change.responsible_fielder_character_id ?? 'unresolved'}`
        + ` (player ${change.responsible_fielder_player_id ?? 'unresolved'},`
        + ` ${change.responsible_fielder_position || 'position unknown'}) ${signed(change.deltas.arm)}`)
    }
  }
  line(`  downstream WAR                   ${report.impact.war.quantified ? String(report.impact.war.delta) : 'not quantified'}`)
  for (const chunk of wrap(report.impact.war.note, 72)) line(`     ${chunk}`)
  line(`  stored columns today             ${report.impact.storedNote}`)
  line()
  if (report.sensitivity) {
    line('SENSITIVITY  (NOT the impact above — a property of the model)')
    line(`  runner_speed coefficient         ${report.sensitivity.runnerSpeedCoefficient}`)
    line(`  runner_speed standardized scale  ${report.sensitivity.runnerSpeedScale}`)
    for (const [name, entry] of Object.entries(report.sensitivity.byCharacter)) {
      line(`  ${name.padEnd(20)} ${entry.ratingChange}`
        + `  linear shift ${report.sensitivity.linearPredictorShift[name]}`)
      line(`  ${' '.repeat(20)} over ${entry.rowsScored} eligible rows re-scored with this runner:`)
      line(`  ${' '.repeat(20)}   mean Δp ${entry.meanProbabilityDelta}`
        + `, range ${entry.minProbabilityDelta} to ${entry.maxProbabilityDelta}`)
    }
    line('  Read this as "if one of these two were the runner on a play like the ones')
    line('  tracked so far, the model would send them this much more or less often".')
    line()
  }
  line('THE VERIFIER\'S CORRELATIONS, RECOMPUTED BOTH WAYS')
  line(`  local archive: ${report.archive.sessions} sessions scanned, ${report.archive.excluded} calibration-excluded`)
  for (const row of report.verifier) {
    const moved = row.delta == null ? 'n/a'
      : row.delta === 0 ? 'unchanged'
        : `${row.delta > 0 ? '+' : ''}${row.delta}`
    line(`  ${row.metric.padEnd(28)} vs ${row.attribute.padEnd(15)}`
      + ` ${row.before} → ${row.after}  (${moved}, ${row.charactersMatched} characters)`)
    if (!row.correctionCanMoveThis) {
      line(`      correlated against ${row.attribute}, which this correction does not touch,`
        + ' so it must not move')
    } else if (row.correctedCharactersInThisComparison.length) {
      line(`      corrected characters in this comparison: ${row.correctedCharactersInThisComparison.join(', ')}`)
    } else {
      line('      neither corrected character clears the 6-sample threshold here,'
        + ' so this correlation cannot move')
    }
  }
  line()
  line('A REFIT OF THE DECISION MODEL WOULD SEE THESE ROWS DIFFERENTLY')
  for (const row of report.refitExposure) {
    line(`  ${row.name.padEnd(20)} runner windows ${row.runnerWindowsInArchive}`
      + `, fielder windows ${row.fielderWindowsInArchive}`)
  }
  line('  scripts/calibrate_runner_decisions.mjs reads the column for its own fit, so')
  line('  re-running it after the correction would move the ARTIFACT. It is not run by')
  line('  the recompute and nothing here re-runs it.')
  return out.join('\n')
}

async function main() {
  const json = process.argv.includes('--json')
  const env = { ...loadEnv(path.resolve('.env')), ...process.env }
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required (.env or the environment)')
  }
  const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const db = await readDatabase(supabase)
  const decisionModel = loadDecisionModel()
  const profiles = JSON.parse(fs.readFileSync(TALENT_PROFILES_PATH, 'utf8'))
  const profileByKey = new Map(Object.entries(profiles)
    .map(([name, profile]) => [characterNameKey(name), profile?.runSpeed]))

  // The corrected cast, built as a COPY. `db.characters` is left exactly as it
  // was read so the "before" side is the live column and not a mutated one.
  const corrected = db.characters.map((row) => {
    const correction = CORRECTIONS.find((entry) => entry.name === row.name)
    return correction ? { ...row, run_speed: correction.to } : { ...row }
  })

  const before = modelWith(db, db.characters, decisionModel)
  const after = modelWith(db, corrected, decisionModel)
  const { changes, eligibleRows, fittedRows } = diffModelled(before, after)

  const correctedRows = db.characters.filter((row) => CORRECTIONS.some((entry) => entry.name === row.name))
  const correctedIds = new Set(correctedRows.map((row) => String(row.id)))
  const withCorrectedRunner = db.runners.filter((row) => correctedIds.has(String(row.runner_character_id)))
  // A row only reads runner_speed when it reaches the FITTED model; the rest
  // fall back to the context average. Counted from the BEFORE run, so it says
  // how many rows the correction could possibly have moved.
  const beforeByKey = new Map(before.map((row) => [`${row.competition_type}:${row.id}`, row]))
  const fittedWithCorrectedRunner = withCorrectedRunner.filter((row) => String(
    beforeByKey.get(`${row.competition_type}:${row.id}`)?.model_version || '',
  ).includes('decision:')).length

  // A correction whose target already holds the corrected value patches
  // nothing, so it cannot be the cause of any change or of any absence of one.
  const correctionState = CORRECTIONS.map((correction) => {
    const live = correctedRows.find((row) => row.name === correction.name)
    const liveValue = live?.run_speed ?? null
    return {
      ...correction,
      liveValue,
      characterId: live?.id ?? null,
      state: liveValue == null ? 'absent'
        : liveValue === correction.to ? 'already-corrected'
          : liveValue === correction.from ? 'pending' : 'unexpected',
    }
  })
  const attribution = attributeImpact(changes)
  const noChange = changes.length === 0 ? classifyNoChange({
    rowsWithCorrectedRunner: withCorrectedRunner.length,
    fittedRowsWithCorrectedRunner: fittedWithCorrectedRunner,
    correctionsAlreadyApplied: correctionState.filter((row) => row.state === 'already-corrected'),
    correctionsPending: correctionState.filter((row) => row.state !== 'already-corrected'),
  }) : null

  const archive = collectArchiveSamples()

  const report = {
    generatedAt: new Date().toISOString(),
    host: new URL(env.VITE_SUPABASE_URL).host,
    corrections: correctionState.map((correction) => ({
      ...correction,
      profileRunSpeed: profileByKey.get(characterNameKey(correction.name)) ?? null,
      fpsFrom: round(getFieldSpeed(correction.from).speedPerSecond * METRES_TO_FEET, 4),
      fpsTo: round(getFieldSpeed(correction.to).speedPerSecond * METRES_TO_FEET, 4),
    })),
    directConsumers: DIRECT_CONSUMERS,
    decisionModel: {
      model_version: decisionModel?.model_version ?? 'none',
      status: decisionModel?.status ?? 'absent',
    },
    impact: {
      totalRows: db.runners.length,
      eligibleRows,
      fittedRows,
      rowsWithCorrectedRunner: withCorrectedRunner.length,
      fittedRowsWithCorrectedRunner: fittedWithCorrectedRunner,
      changedRows: changes.length,
      // Rounded HERE, for display, from raw deltas summed at full precision.
      changes: changes.map((change) => ({
        ...change,
        before: Object.fromEntries(Object.entries(change.before).map(([k, v]) => [k, round(v)])),
        after: Object.fromEntries(Object.entries(change.after).map(([k, v]) => [k, round(v)])),
        deltas: Object.fromEntries(Object.entries(change.deltas).map(([k, v]) => [k, round(v)])),
      })),
      // ── The two sides, never added together ──────────────────────────────
      //
      // arm_run_value is the negation of runner_run_value on the same row, so
      // their sum is zero whatever happened. Reported side by side, with the
      // identities underneath, because "the league total is zero" and "nobody
      // was affected" are different statements and only the first is implied.
      runnerSide: attribution.runnerSide.map((row) => ({ ...row, runValueDelta: round(row.runValueDelta) })),
      armSide: attribution.armSide.map((row) => ({ ...row, runValueDelta: round(row.runValueDelta) })),
      runnerTotalRunValueDelta: round(attribution.runnerTotal),
      armTotalRunValueDelta: round(attribution.armTotal),
      runnerBeneficiaries: attribution.runnerBeneficiaries,
      armBeneficiaries: attribution.armBeneficiaries,
      distinctRunnerCharacters: attribution.distinctRunnerCharacters,
      distinctRunnerPlayers: attribution.distinctRunnerPlayers,
      distinctFielderCharacters: attribution.distinctFielderCharacters,
      distinctFielderPlayers: attribution.distinctFielderPlayers,
      noChangeReason: noChange,
      // ── WAR ──────────────────────────────────────────────────────────────
      //
      // runner_run_value reaches a player's baserunningRuns and arm_run_value
      // reaches a DIFFERENT player's fieldingRuns; each player's total is then
      // divided by runsPerWin, which is computed from league RA9 across inputs
      // this script does not read. So a per-player WAR figure is not
      // reproducible here and is not invented.
      //
      // The one case that IS faithfully calculable is zero: with no run-value
      // change at all, every player's WAR delta is zero for any positive
      // divisor, and no denominator is needed to say so.
      war: changes.length === 0
        ? {
          quantified: true,
          delta: 0,
          note: 'exactly 0 for every player. WAR divides each player\'s run total by a '
            + 'positive runsPerWin, so a run-value change of exactly 0 is a WAR change '
            + 'of exactly 0 without computing the divisor.',
        }
        : {
          quantified: false,
          note: 'NOT QUANTIFIED. The run-value changes above are per player and per side; '
            + 'converting them to WAR needs runsPerWin, which comes from league RA9 over '
            + 'inputs this script does not read. Re-run the WAR audit after a recompute '
            + 'rather than dividing these numbers by a guessed denominator.',
        },
      storedNote: 'unchanged either way until scripts/recompute_advanced_metrics.mjs is run. '
        + 'The app reads the stored columns; applying the migration alone moves nothing.',
    },
    sensitivity: sensitivity(db, db.characters, decisionModel),
    archive: { sessions: archive.sessions, excluded: archive.excluded },
    verifier: verifierDelta(archive, db.characters, corrected),
    refitExposure: refitExposure(archive),
  }

  console.log(json ? JSON.stringify(report, null, 2) : formatText(report))
}

// ONLY WHEN RUN AS A COMMAND. This module exports its diff and attribution
// helpers so they can be tested against synthetic rows, and without this guard
// importing it ran main() -- which reads the production database. A test that
// quietly opens a network connection to production is a test that fails on a
// machine with no .env and passes for the wrong reason on this one.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`analyze_run_speed_correction_impact: ${error.message}`)
    process.exit(1)
  })
}
