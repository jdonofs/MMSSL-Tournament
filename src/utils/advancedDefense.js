// Sluggers-native fielding and baserunning opportunity models.
//
// The database stores one row per opportunity. Everything in this module is
// deterministic from those rows so a model-version change can backfill history
// without replaying Dolphin. MLB definitions inspire the outputs, but the
// probabilities and run values are fitted to this league's environment.

import { calculateOutsForPa } from './defensiveEfficiency.js'
import { getFieldSpeed } from '../data/gameSpeedCurves.js'

export const ADVANCED_METRIC_VERSION = 'sluggers-advanced-v2'
export const METRES_TO_FEET = 3.280839895
export const MPS_TO_MPH = 2.2369362921
export const FEET_PER_SECOND_TO_MPH = 3600 / 5280

const BASE_BIT = { first: 1, second: 2, third: 4 }
const BASE_ORDER = { plate: 0, first: 1, second: 2, third: 3, home: 4, out: -1 }
const AIR_OUT_RESULTS = new Set(['FO', 'LO', 'SF'])
const GROUND_RESULTS = new Set(['GO', 'FC', 'DP', 'SH'])

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

export function normalizeRunnerAssignments(value) {
  let rows = value
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows) } catch { return [] }
  }
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const destination = row?.destination ?? row?.position
    if (!row?.id || !row?.runner || !['first', 'second', 'third', 'home', 'out'].includes(destination)) return []
    return [{
      id: String(row.id),
      runner: row.runner,
      origin: row.origin || null,
      destination,
      isBatter: Boolean(row.isBatter ?? row.is_batter ?? row.id === 'batter'),
      ...(['first', 'second', 'third', 'home'].includes(row.attemptedBase) ? { attemptedBase: row.attemptedBase } : {}),
    }]
  })
}

export function baseStateMask({ first = false, second = false, third = false } = {}) {
  return (first ? BASE_BIT.first : 0) | (second ? BASE_BIT.second : 0) | (third ? BASE_BIT.third : 0)
}

export function baseStateMaskFromPa(pa = {}) {
  return baseStateMask({
    first: Boolean(pa.runner_on_first_before),
    second: Boolean(pa.runner_on_second_before),
    third: Boolean(pa.runner_on_third_before),
  })
}

export function baseStateMaskFromAssignments(assignments = []) {
  return assignments.reduce((mask, row) => (
    row.destination in BASE_BIT ? mask | BASE_BIT[row.destination] : mask
  ), 0)
}

export function parseFieldingPositions(pa = {}) {
  const notation = String(pa.error_notation || pa.hit_notation || '')
  return (notation.split('-E')[0].match(/\d+/g) || [])
    .map(Number)
    .filter((position) => position >= 1 && position <= 9)
}

function paTrajectory(pa = {}) {
  const explicit = String(pa.trajectory || '').toUpperCase()
  if (explicit) return explicit
  if (AIR_OUT_RESULTS.has(pa.result)) return pa.result === 'LO' ? 'L' : 'F'
  if (GROUND_RESULTS.has(pa.result)) return pa.result === 'SH' ? 'B' : 'G'
  return null
}

export function isEligibleDoublePlayPa(pa = {}, outsBefore = 0) {
  if (finite(outsBefore, 0) >= 2 || !pa.runner_on_first_before) return false
  if (['K', 'BB', 'HBP', 'HR', 'IPHR', 'FO', 'LO', 'SF'].includes(pa.result)) return false
  const trajectory = paTrajectory(pa)
  return trajectory === 'G' || trajectory === 'B' || pa.result === 'DP'
}

export function buildDoublePlayOpportunityFromPa(pa = {}, {
  competitionType = 'tournament',
  outsBefore = 0,
  firstFielder = null,
  pivotFielder = null,
} = {}) {
  if (!isEligibleDoublePlayPa(pa, outsBefore)) return null
  const actualOuts = clamp(Math.trunc(finite(pa.outs_on_play, pa.result === 'DP' ? 2 : 0)), 0, 3)
  return {
    competition_type: competitionType,
    game_id: pa.game_id,
    pa_id: pa.id,
    outs_before: Math.trunc(finite(outsBefore, 0)),
    base_state_before: baseStateMaskFromPa(pa),
    trajectory: paTrajectory(pa),
    structural_eligible: true,
    actual_outs: actualOuts,
    double_play_completed: actualOuts >= 2 || pa.result === 'DP',
    first_fielder_player_id: firstFielder?.playerId || firstFielder?.player_id || null,
    first_fielder_character_id: finite(firstFielder?.characterId ?? firstFielder?.character_id),
    first_fielder_position: firstFielder?.position ? String(firstFielder.position) : null,
    pivot_fielder_player_id: pivotFielder?.playerId || pivotFielder?.player_id || null,
    pivot_fielder_character_id: finite(pivotFielder?.characterId ?? pivotFielder?.character_id),
    pivot_fielder_position: pivotFielder?.position ? String(pivotFielder.position) : null,
    credit_status: firstFielder ? 'team' : 'unresolved',
    model_version: null,
    context: {
      result: pa.result || null,
      exit_velocity_mph: finite(pa.exit_velocity_mph),
      hit_world_x: finite(pa.hit_world_x),
      hit_world_z: finite(pa.hit_world_z),
      fielded_x: finite(pa.fielded_x),
      fielded_y: finite(pa.fielded_y),
      positions: parseFieldingPositions(pa),
    },
  }
}

// The base a hit puts the batter-runner on without anyone deciding anything.
// Everything past it is his decision and the defence's problem.
const BATTER_GUARANTEED_BASE = Object.freeze({ '1B': 'first', '2B': 'second' })

function extraBaseSpecs(pa = {}) {
  if (pa.is_error || pa.result === 'ROE') return []
  if (pa.result === '1B') return [
    // THE BATTER-RUNNER IS A BASERUNNER. Leaving him out meant the most common
    // extra-base decision in the game -- stretch it or stop -- generated no
    // opportunity at all, and so neither did the defensive play that settled
    // it. A fielder who cuts a ball off in the gap and holds the hitter to a
    // single was doing the single most valuable thing an outfielder does on a
    // ball that falls in, and it priced at zero for him and at zero for the
    // runner. Across the local archive the batter took two or more bases 305
    // times and stopped at the guaranteed one 1,234 times; the opportunity
    // table held 18 rows, none of them a batter.
    { runnerId: 'batter', origin: 'plate', target: 'second', type: 'batter_to_second_on_single' },
    { runnerId: 'first', origin: 'first', target: 'third', type: 'first_to_third_on_single' },
    { runnerId: 'second', origin: 'second', target: 'home', type: 'second_to_home_on_single' },
  ]
  if (pa.result === '2B') return [
    { runnerId: 'batter', origin: 'plate', target: 'third', type: 'batter_to_third_on_double' },
    { runnerId: 'first', origin: 'first', target: 'home', type: 'first_to_home_on_double' },
  ]
  if (AIR_OUT_RESULTS.has(pa.result)) return [
    { runnerId: 'first', origin: 'first', target: 'second', type: 'tag_first_to_second' },
    { runnerId: 'second', origin: 'second', target: 'third', type: 'tag_second_to_third' },
    { runnerId: 'third', origin: 'third', target: 'home', type: 'tag_third_to_home' },
  ]
  return []
}

function runnerIds(row = {}) {
  return {
    playerId: row.runner?.playerId ?? row.runner?.player_id ?? null,
    characterId: finite(row.runner?.characterId ?? row.runner?.character_id),
  }
}

export function buildExtraBaseOpportunitiesFromPa(pa = {}, {
  competitionType = 'tournament',
  outsBefore = 0,
  responsibleFielder = null,
} = {}) {
  const assignments = normalizeRunnerAssignments(pa.runner_assignments)
  if (!assignments.length) return []
  const assignmentById = new Map(assignments.map((row) => [row.id, row]))
  const expectedIds = ['batter', ...['first', 'second', 'third'].filter((base) => pa[`runner_on_${base}_before`])]
  if (expectedIds.some((id) => !assignmentById.has(id))) return []
  const outsOnPlay = clamp(Math.trunc(finite(pa.outs_on_play, 0)), 0, 3)
  const afterMask = baseStateMaskFromAssignments(assignments)
  // There is no tag-up decision after a catch records the third out.
  // A doubled-off runner on a caught ball is not an extra-base attempt.
  if (AIR_OUT_RESULTS.has(pa.result) && (outsBefore >= 2 || outsOnPlay > 1)) return []

  return extraBaseSpecs(pa).flatMap((spec) => {
    const batterSpec = spec.runnerId === 'batter'
    const assignment = assignmentById.get(spec.runnerId)
    if (!assignment || assignment.isBatter !== batterSpec) return []
    // The batter-runner's origin is the plate, which is not a base anyone can
    // have been standing on. Every other spec still has to start from an
    // occupied one.
    if (!batterSpec && !pa[`runner_on_${spec.origin}_before`]) return []
    if (assignment.origin && assignment.origin !== spec.origin) return []
    const ids = runnerIds(assignment)
    if (ids.playerId == null && ids.characterId == null) return []
    const targetOccupied = assignments.some((row) => (
      row.id !== spec.runnerId
      && !row.isBatter
      && row.destination === spec.target
    ))
    if (targetOccupied) return []
    const actualRank = BASE_ORDER[assignment.destination] ?? -1
    const targetRank = BASE_ORDER[spec.target]
    // A batter who did not even reach the base his hit guaranteed him was
    // retired somewhere this decision never got to happen -- a rundown, an
    // appeal, a runner passed on the bases. It is not a failed stretch.
    if (batterSpec && assignment.destination !== 'out'
      && actualRank < BASE_ORDER[BATTER_GUARANTEED_BASE[pa.result]]) return []
    let outcome
    if (assignment.destination === 'out') {
      // Being retired before reaching the guaranteed base on a hit, or
      // doubled off after a catch, cannot be charged as a failed extra base.
      if (assignment.attemptedBase !== spec.target) return []
      outcome = 'advance_out'
    }
    else if (actualRank >= targetRank) outcome = 'advance_safe'
    else outcome = 'hold'
    if (outcome === 'hold' && outsBefore + outsOnPlay >= 3) return []
    return [{
      competition_type: competitionType,
      game_id: pa.game_id,
      pa_id: pa.id,
      runner_id: spec.runnerId,
      runner_player_id: ids.playerId,
      runner_character_id: ids.characterId,
      origin_base: spec.origin,
      target_base: spec.target,
      opportunity_type: spec.type,
      outcome,
      is_discretionary: true,
      attempted: outcome !== 'hold',
      safe: outcome === 'advance_safe' ? true : outcome === 'advance_out' ? false : null,
      responsible_fielder_player_id: responsibleFielder?.playerId || responsibleFielder?.player_id || null,
      responsible_fielder_character_id: finite(responsibleFielder?.characterId ?? responsibleFielder?.character_id),
      responsible_fielder_position: responsibleFielder?.position ? String(responsibleFielder.position) : null,
      outs_before: Math.trunc(finite(outsBefore, 0)),
      outs_after: Math.min(3, Math.trunc(finite(outsBefore, 0)) + outsOnPlay),
      base_state_before: baseStateMaskFromPa(pa),
      base_state_after: afterMask,
      model_version: null,
      quality: { result: pa.result || null, destination: assignment.destination },
    }]
  })
}

function betaMean(successes, attempts, priorMean, priorStrength) {
  return (successes + priorMean * priorStrength) / (attempts + priorStrength)
}

function rowContextKey(row = {}) {
  return [row.opportunity_type, finite(row.outs_before, 0), row.origin_base, row.target_base].join('|')
}

function dpContextKey(row = {}) {
  const context = row.context || {}
  const ev = finite(context.exit_velocity_mph)
  const evBucket = ev == null ? 'na' : Math.floor(ev / 10) * 10
  return [row.trajectory || 'G', finite(row.outs_before, 0), row.base_state_before || 0, evBucket].join('|')
}

// Approximately MLB's 2010-15 RE24 table, keyed `${outs}:${baseMask}`. Only its
// SHAPE is used: buildRunExpectancy rescales it to this league's scoring level
// and lets any state the league has seen often enough outweigh it.
const MLB_RE24_SHAPE = Object.freeze({
  '0:0': 0.481, '0:1': 0.859, '0:2': 1.100, '0:3': 1.437, '0:4': 1.350, '0:5': 1.784, '0:6': 1.964, '0:7': 2.292,
  '1:0': 0.254, '1:1': 0.509, '1:2': 0.664, '1:3': 0.884, '1:4': 0.950, '1:5': 1.130, '1:6': 1.376, '1:7': 1.541,
  '2:0': 0.098, '2:1': 0.224, '2:2': 0.319, '2:3': 0.429, '2:4': 0.353, '2:5': 0.478, '2:6': 0.580, '2:7': 0.752,
})

// How many observed half-inning samples a state needs before its own mean
// counts as much as the prior. Most states have fewer than 15: with no prior,
// 1 out with runners on the corners (4 samples) read 0.25 runs against 0.63 for
// a runner on first alone, which priced a single as costing the offense runs.
const RUN_EXPECTANCY_PRIOR_STRENGTH = 20

// Runs that scored DURING this plate appearance. `run_scored` is not that: it
// says the batter scored at some point in the inning, so counting it here
// charged the same run to his own PA and again to the PA that drove him in --
// 69 runs where 50 scored across the tournament games.
function runsOnPlay(pa = {}) {
  const assignments = normalizeRunnerAssignments(pa.runner_assignments)
  if (assignments.length) return assignments.filter((row) => row.destination === 'home').length
  return Math.max(0, Math.trunc(finite(pa.rbi, 0)))
}

export function buildRunExpectancy(plateAppearances = []) {
  const groups = new Map()
  for (const pa of plateAppearances) {
    const halfKey = `${pa.competition_type || pa.source_type || 'tournament'}:${pa.game_id}:${pa.inning || 1}:${pa.batting_team_id || pa.player_id || 'unknown'}`
    if (!groups.has(halfKey)) groups.set(halfKey, [])
    groups.get(halfKey).push(pa)
  }

  const samples = new Map()
  for (const rows of groups.values()) {
    rows.sort((a, b) => finite(a.pa_number, 0) - finite(b.pa_number, 0))
    const runs = rows.map(runsOnPlay)
    let futureRuns = runs.reduce((sum, value) => sum + value, 0)
    let outs = 0
    rows.forEach((pa, index) => {
      const key = `${Math.min(2, outs)}:${baseStateMaskFromPa(pa)}`
      if (!samples.has(key)) samples.set(key, [])
      samples.get(key).push(futureRuns)
      futureRuns -= runs[index]
      // Inferred from the result when the row predates outs_on_play, as 564 of
      // the first 660 PAs do. Reading those as zero outs put nearly every PA in
      // the 0-out states.
      outs += clamp(Math.trunc(calculateOutsForPa(pa.result, pa.outs_on_play)), 0, 3)
    })
  }

  let observedRuns = 0
  let priorRuns = 0
  for (const [key, values] of samples) {
    observedRuns += values.reduce((sum, value) => sum + value, 0)
    priorRuns += values.length * (MLB_RE24_SHAPE[key] ?? 0)
  }
  const scale = priorRuns > 0 ? observedRuns / priorRuns : 1
  const expectancy = new Map([['3:0', 0]])
  for (const [key, shape] of Object.entries(MLB_RE24_SHAPE)) {
    const values = samples.get(key) || []
    const total = values.reduce((sum, value) => sum + value, 0)
    expectancy.set(key, (total + RUN_EXPECTANCY_PRIOR_STRENGTH * scale * shape)
      / (values.length + RUN_EXPECTANCY_PRIOR_STRENGTH))
  }
  return expectancy
}

function fallbackStateValue(outs, mask) {
  if (outs >= 3) return 0
  const base = ((mask & 1) ? 0.25 : 0) + ((mask & 2) ? 0.42 : 0) + ((mask & 4) ? 0.62 : 0)
  return base + [0.45, 0.25, 0.1][outs]
}

export function runExpectancyValue(expectancy, outs, mask) {
  const safeOuts = clamp(Math.trunc(finite(outs, 0)), 0, 3)
  const safeMask = clamp(Math.trunc(finite(mask, 0)), 0, 7)
  return expectancy?.get?.(`${safeOuts}:${safeMask}`) ?? fallbackStateValue(safeOuts, safeMask)
}

function moveRunnerMask(mask, origin, target) {
  let next = mask & ~BASE_BIT[origin]
  if (target in BASE_BIT) next |= BASE_BIT[target]
  return next
}

// The base a batter-runner's opportunity is measured from: the one before the
// one he is trying for.
const BASE_BEFORE = Object.freeze({ second: 'first', third: 'second', home: 'third' })

/**
 * What advancing and what being thrown out are each worth, against holding.
 *
 * `base_state_before` is the state at CONTACT, so for a runner already on base
 * it is also the state he holds at and the baseline is simply that. A
 * batter-runner is not on it: the hit puts him on his guaranteed base whatever
 * he decides, so his baseline is the state WITH him standing there, and being
 * thrown out stretching leaves the bases as they were at contact rather than
 * emptying a base he never occupied. Measuring him from the contact state
 * instead would have priced the hit itself as part of his baserunning.
 */
function opportunityOutcomeValues(row, expectancy) {
  const outs = clamp(Math.trunc(finite(row.outs_before, 0)), 0, 2)
  const mask = clamp(Math.trunc(finite(row.base_state_before, 0)), 0, 7)
  const batter = row.origin_base === 'plate'
  const guaranteed = batter ? BASE_BEFORE[row.target_base] : null
  const holdMask = batter && guaranteed in BASE_BIT ? mask | BASE_BIT[guaranteed] : mask
  const before = runExpectancyValue(expectancy, outs, holdMask)
  const safeMask = batter
    ? (row.target_base in BASE_BIT ? mask | BASE_BIT[row.target_base] : mask)
    : moveRunnerMask(mask, row.origin_base, row.target_base)
  const safeRuns = row.target_base === 'home' ? 1 : 0
  const safeValue = safeRuns + runExpectancyValue(expectancy, outs, safeMask) - before
  const outMask = batter ? mask : mask & ~BASE_BIT[row.origin_base]
  const outValue = runExpectancyValue(expectancy, outs + 1, outMask) - before
  return { safeValue, outValue }
}

// ── extra-base decisions from the 60 Hz capture ─────────────────────────────
//
// The CPU decides every send and hold -- the human never does -- so the
// attempt model is learning the game's own policy from what it could see when
// a fielder first had the ball. The context below is stored per play at ingest
// (tracking_plays.quality.runner_context); the fit and the recompute both turn
// it into features with extraBaseFeatures, so the two cannot disagree.

/** The capture's actor slot for a runner who started this opportunity there. */
export const RUNNER_SLOT_BY_ORIGIN = Object.freeze({ plate: 'BAT', first: 'R1', second: 'R2', third: 'R3' })

// Marks a row whose attempt probability came from the fitted decision model,
// in model_version, e.g. "sluggers-advanced-v2+decision:runner-decision-v1".
const DECISION_MODEL_TAG = '+decision:'

export const EXTRA_BASE_DECISION_FEATURES = Object.freeze([
  'runner_to_target_units', 'ball_to_target_units', 'runner_speed', 'fielder_arm',
])

function planarDistance(a, b) {
  return Math.hypot(finite(a?.[0], NaN) - finite(b?.[0], NaN), finite(a?.[1], NaN) - finite(b?.[1], NaN))
}

/** The compact facts an extra-base decision is made against, or null. */
export function extraBaseContext(play = {}) {
  const touch = play.first_touch
  if (!Array.isArray(touch?.at) || !play.bases) return null
  const round = (value) => Number(Number(value).toFixed(3))
  return {
    schema_version: 1,
    bases: Object.fromEntries(Object.entries(play.bases)
      .filter(([, xz]) => Array.isArray(xz) && xz.length >= 2)
      .map(([base, xz]) => [base, [round(xz[0]), round(xz[1])]])),
    // The capture's spelling of who secured it -- resolve through
    // characterNames.js, never by raw string.
    touch: {
      by: touch.by || null, character: touch.character || null,
      frame: finite(touch.frame), at: [round(touch.at[0]), round(touch.at[2])],
    },
    // Where each runner stood when the ball was first secured, keyed by the
    // slot he occupied at contact. BAT is included: the batter-runner's own
    // stretch-or-stop decision is measured from where HE was when the fielder
    // got to it, and leaving him out left that decision unscoreable.
    runners: Object.entries(play.runners || {}).flatMap(([slot, runner]) => (
      Array.isArray(runner?.at_first_possession)
        ? [{ slot, character: runner.character || null,
          at: [round(runner.at_first_possession[0]), round(runner.at_first_possession[2])] }]
        : []
    )),
  }
}

/**
 * The model's inputs for one runner opportunity, or null when the capture
 * cannot supply them. Speed and arm are the character's fixed attributes
 * (characters.run_speed / throwing_speed): in this game they do not vary, so a
 * measured value would only re-measure them with noise.
 */
export function extraBaseFeatures(row = {}, context = null, { runnerSpeed = null, fielderArm = null } = {}) {
  if (!context?.touch?.at || !context.bases) return null
  const target = context.bases[row.target_base]
  const runner = (context.runners || []).find((entry) => entry.slot === RUNNER_SLOT_BY_ORIGIN[row.origin_base])
  const speed = finite(runnerSpeed)
  const arm = finite(fielderArm)
  if (!Array.isArray(target) || !Array.isArray(runner?.at) || speed == null || arm == null) return null
  const runnerToTarget = planarDistance(runner.at, target)
  const ballToTarget = planarDistance(context.touch.at, target)
  if (!Number.isFinite(runnerToTarget) || !Number.isFinite(ballToTarget)) return null
  return {
    runner_to_target_units: runnerToTarget,
    ball_to_target_units: ballToTarget,
    runner_speed: speed,
    fielder_arm: arm,
  }
}

/** The design row the fitted model multiplies; shared by the fit and the scorer. */
export function extraBaseDecisionVector(model, row = {}, features = {}) {
  const outs = Math.trunc(finite(row.outs_before, 0))
  return [
    1,
    ...EXTRA_BASE_DECISION_FEATURES.map((name) => (
      (features[name] - model.standardization[name].mean) / model.standardization[name].scale)),
    outs === 1 ? 1 : 0,
    outs === 2 ? 1 : 0,
    ...model.opportunity_types.slice(1).map((type) => (row.opportunity_type === type ? 1 : 0)),
  ]
}

/** P(the CPU sends the runner), or null when the model cannot score the row. */
export function scoreExtraBaseDecision(model, row, features) {
  if (!model || model.status !== 'active' || !features) return null
  if (!model.opportunity_types.includes(row.opportunity_type)) return null
  const linear = extraBaseDecisionVector(model, row, features)
    .reduce((sum, value, index) => sum + value * model.coefficients[index], 0)
  if (!Number.isFinite(linear)) return null
  return linear >= 0 ? 1 / (1 + Math.exp(-linear)) : Math.exp(linear) / (1 + Math.exp(linear))
}

/**
 * `decisionModel` + `featuresFor(row)` score the attempt probability from the
 * capture (the recompute). `useStoredDecision` reuses a probability the
 * recompute already stored from that model (WAR, which cannot load the fitted
 * artifact in the browser). Anything else falls back to the context average.
 */
export function modelRunnerOpportunities(rows = [], expectancy = new Map(), {
  decisionModel = null,
  featuresFor = () => null,
  useStoredDecision = false,
} = {}) {
  const eligible = rows.filter((row) => row.is_discretionary !== false && ['hold', 'advance_safe', 'advance_out'].includes(row.outcome))
  const globalAttempts = eligible.filter((row) => row.attempted).length
  const globalAttemptRate = eligible.length ? globalAttempts / eligible.length : 0.35
  const attempted = eligible.filter((row) => row.attempted)
  const globalSuccessRate = attempted.length ? attempted.filter((row) => row.safe).length / attempted.length : 0.7
  const byContext = new Map()
  for (const row of eligible) {
    const key = rowContextKey(row)
    const entry = byContext.get(key) || { n: 0, attempts: 0, safe: 0 }
    entry.n += 1
    if (row.attempted) {
      entry.attempts += 1
      if (row.safe) entry.safe += 1
    }
    byContext.set(key, entry)
  }

  return rows.map((row) => {
    if (!eligible.includes(row)) return { ...row }
    const bucket = byContext.get(rowContextKey(row))
    // Leave the current outcome out of its own expectation, then shrink hard
    // while the league is small. This prevents one attempt defining itself.
    const n = Math.max(0, bucket.n - 1)
    const attempts = Math.max(0, bucket.attempts - (row.attempted ? 1 : 0))
    const safe = Math.max(0, bucket.safe - (row.attempted && row.safe ? 1 : 0))
    const modelledAttempt = decisionModel ? scoreExtraBaseDecision(decisionModel, row, featuresFor(row)) : null
    const storedAttempt = useStoredDecision && String(row.model_version || '').includes(DECISION_MODEL_TAG)
      ? finite(row.expected_attempt_probability) : null
    const expectedAttempt = modelledAttempt ?? storedAttempt ?? betaMean(attempts, n, globalAttemptRate, 12)
    const successTrials = attempts
    // Still the context average: thrown-out runners are too rare in the
    // archive (one in thirty games) for the capture to say what makes one.
    const expectedSuccess = betaMean(safe, successTrials, globalSuccessRate, 10)
    const { safeValue, outValue } = opportunityOutcomeValues(row, expectancy)
    const expectedValue = expectedAttempt * (expectedSuccess * safeValue + (1 - expectedSuccess) * outValue)
    const actualValue = row.outcome === 'advance_safe' ? safeValue : row.outcome === 'advance_out' ? outValue : 0
    return {
      ...row,
      expected_attempt_probability: expectedAttempt,
      expected_success_probability: expectedSuccess,
      runner_run_value: actualValue - expectedValue,
      arm_run_value: row.responsible_fielder_character_id != null ? expectedValue - actualValue : null,
      model_version: modelledAttempt != null
        ? `${ADVANCED_METRIC_VERSION}${DECISION_MODEL_TAG}${decisionModel.model_version}`
        : storedAttempt != null ? row.model_version : ADVANCED_METRIC_VERSION,
    }
  })
}

export function modelDoublePlayOpportunities(rows = [], expectancy = new Map()) {
  const eligible = rows.filter((row) => row.structural_eligible !== false)
  const globalRate = eligible.length
    ? eligible.filter((row) => row.double_play_completed).length / eligible.length
    : 0.25
  const byContext = new Map()
  for (const row of eligible) {
    const key = dpContextKey(row)
    const entry = byContext.get(key) || { n: 0, completed: 0 }
    entry.n += 1
    if (row.double_play_completed) entry.completed += 1
    byContext.set(key, entry)
  }
  return rows.map((row) => {
    if (!eligible.includes(row)) return { ...row }
    const bucket = byContext.get(dpContextKey(row))
    const n = Math.max(0, bucket.n - 1)
    const completed = Math.max(0, bucket.completed - (row.double_play_completed ? 1 : 0))
    const expected = betaMean(completed, n, globalRate, 15)
    const added = (row.double_play_completed ? 1 : 0) - expected
    const outs = clamp(Math.trunc(finite(row.outs_before, 0)), 0, 1)
    const mask = clamp(Math.trunc(finite(row.base_state_before, 0)), 0, 7)
    const oneOutState = runExpectancyValue(expectancy, outs + 1, mask & ~BASE_BIT.first)
    const twoOutState = runExpectancyValue(expectancy, outs + 2, mask & ~BASE_BIT.first)
    const secondOutRuns = Math.max(0.1, oneOutState - twoOutState)
    return {
      ...row,
      expected_double_play_probability: expected,
      double_plays_added: added,
      run_value: added * secondOutRuns,
      model_version: ADVANCED_METRIC_VERSION,
    }
  })
}

function fieldingBucket(row = {}) {
  const distance = finite(row.distance_needed_m)
  const time = finite(row.opportunity_seconds)
  const distanceBucket = distance == null ? 'na' : Math.floor(distance / 5) * 5
  const timeBucket = time == null ? 'na' : Math.floor(time * 2) / 2
  return `${row.position || 'unknown'}|${distanceBucket}|${timeBucket}`
}

export function catchProbabilityStar(probability) {
  if (!Number.isFinite(probability)) return null
  if (probability <= 0.10) return 5
  if (probability <= 0.25) return 4
  if (probability <= 0.50) return 3
  if (probability <= 0.75) return 2
  return 1
}

/**
 * Whether an opportunity is kept out of OAA: a manufactured chance (boot,
 * forced misplay, Buddy handoff) or one the stadium decided. `stadium_affected`
 * is stamped at ingest and restamped by the recompute from the play's incidents.
 */
export function isExcludedFromOaa(row = {}) {
  return row.quality?.exclude_from_oaa === true || row.quality?.stadium_affected === true
}

// How long a fair ball has to stay up before failing to catch it means
// anything. This is the same threshold the frozen catch-probability dataset
// uses for its failure label (see
// data/calibration/catch-probability-opportunity-definition-v1.json: "fair_in_play
// with observed landing at least 1.0 s after contact").
export const AIRBORNE_OPPORTUNITY_SECONDS = 1.0

/**
 * Whether this batted ball was ever catchable in the air.
 *
 * `actual_out` on a fielding opportunity means CAUGHT IN FLIGHT and nothing
 * else (see the primary-fielder branch in scripts/ingest_player_tracking.mjs),
 * so a ground ball fielded cleanly and thrown to first arrives here as
 * `actual_out: false` -- an opportunity the fielder converted into an out,
 * recorded as one he failed. Buckets hold two or three plays, so each row's
 * expectation is dominated by the shrinkage prior, which is the POSITION's
 * overall catch rate; mixing balls that could be caught with balls that never
 * could gave every groundout a small debit and every line drive a large
 * credit. Across the 160 eligible rows the league had at the time, a fielder
 * whose chances were caught in the air averaged +0.445 OAA and one whose were
 * fielded off the ground -0.349, and per-fielder OAA correlated 0.67 with
 * nothing but the share of their chances that happened to be hit in the air.
 *
 * So this model's population is the one it can actually model: balls that were
 * catchable. A catch is self-evidently a catch opportunity; a ball that was not
 * caught had to stay up long enough for reaching it to be the question. Ground
 * balls now leave OAA UNMODELLED rather than scored as failures -- Infield OAA
 * needs its own out-at-the-base model, which docs/fielding-baserunning-advanced-metrics-plan.md
 * schedules for Phase 3 and which does not exist yet. An unmeasured fielder is
 * neutral; a mismeasured one is worse than neutral.
 */
export function isAirborneCatchOpportunity(row = {}) {
  if (row.actual_out === true) return true
  const seconds = finite(row.opportunity_seconds)
  return seconds != null && seconds >= AIRBORNE_OPPORTUNITY_SECONDS
}

export function isFieldingModelEligible(row = {}) {
  return Boolean(
    row.is_primary
    && row.actual_out != null
    && finite(row.distance_needed_m) != null
    && finite(row.opportunity_seconds) != null
    && isAirborneCatchOpportunity(row)
    && !isExcludedFromOaa(row)
    && row.quality?.quarantined_session !== true,
  )
}

/** Position and difficulty-bucket catch counts over the eligible rows. */
export function fitFieldingModel(rows = []) {
  const byPosition = new Map()
  const byBucket = new Map()
  for (const row of rows) {
    if (!isFieldingModelEligible(row)) continue
    const position = String(row.position || 'unknown')
    const pos = byPosition.get(position) || { n: 0, outs: 0 }
    pos.n += 1
    if (row.actual_out) pos.outs += 1
    byPosition.set(position, pos)
    const key = fieldingBucket(row)
    const bucket = byBucket.get(key) || { n: 0, outs: 0 }
    bucket.n += 1
    if (row.actual_out) bucket.outs += 1
    byBucket.set(key, bucket)
  }
  return { byPosition, byBucket }
}

/**
 * The modelled columns for one opportunity, or null when it is not eligible.
 *
 * `inSample` says the row was one of the rows the model was fitted on, so its
 * own catch is taken back out of its bucket. A row scored live, against a model
 * fitted before it was played, was never in it.
 */
export function scoreFieldingOpportunity(model, row, { inSample = false } = {}) {
  if (!isFieldingModelEligible(row)) return null
  const position = model.byPosition.get(String(row.position || 'unknown')) || { n: 0, outs: 0 }
  const positionRate = position.n ? position.outs / position.n : 0.5
  const bucket = model.byBucket.get(fieldingBucket(row)) || { n: 0, outs: 0 }
  const self = inSample ? 1 : 0
  const n = Math.max(0, bucket.n - self)
  const outs = Math.max(0, bucket.outs - (inSample && row.actual_out ? 1 : 0))
  const expected = betaMean(outs, n, positionRate, 12)
  return {
    expected_out_probability: expected,
    outs_above_average: (row.actual_out ? 1 : 0) - expected,
    star_difficulty: catchProbabilityStar(expected),
    model_version: ADVANCED_METRIC_VERSION,
  }
}

export function modelFieldingOpportunities(rows = []) {
  const model = fitFieldingModel(rows)
  return rows.map((row) => {
    const scored = scoreFieldingOpportunity(model, row, { inSample: true })
    return scored ? { ...row, ...scored } : { ...row }
  })
}

function hardestThrowShare(position) {
  if (position === '1B') return 0.01
  if (['2B', '3B', 'SS'].includes(position)) return 0.05
  return 0.10
}

// A Buddy Throw is two chemistry-linked fielders combining: the first dashes and
// bounces the ball to the second, who fires it in. It is not one player's arm,
// and it is not even clear from the capture whose arm it is -- the game freezes
// every actor for the cutscene, so the partner who releases the ball never
// appears in the position data. On the first real session the only two Buddy
// Throws were also the only two above 122 mph, at 182 and 208 against a normal
// spread of 79 to 123. Counting them would rank fielders by their chemistry
// pairings rather than by their arms, so they are held apart.
export function aggregateArmStrength(throws = []) {
  const valid = throws.filter((row) => (
    row.is_throw !== false
    && finite(row.peak_speed_mph) != null
    && row.quality?.quarantined_session !== true
  ))
  const buddy = valid.filter((row) => row.is_buddy_throw === true)
  const normal = valid.filter((row) => row.is_buddy_throw !== true)
  const empty = {
    throws: valid.length,
    armStrengthMph: null,
    hardestThrowMph: null,
    buddyThrows: buddy.length,
    hardestBuddyThrowMph: buddy.length
      ? Math.max(...buddy.map((row) => finite(row.peak_speed_mph)))
      : null,
  }
  if (!normal.length) return empty
  const byPosition = new Map()
  normal.forEach((row) => {
    const key = row.thrower_position || 'unknown'
    if (!byPosition.has(key)) byPosition.set(key, [])
    byPosition.get(key).push(finite(row.peak_speed_mph))
  })
  const qualifying = []
  for (const [position, speeds] of byPosition) {
    speeds.sort((a, b) => b - a)
    const count = Math.max(1, Math.ceil(speeds.length * hardestThrowShare(position)))
    qualifying.push(...speeds.slice(0, count))
  }
  return {
    ...empty,
    armStrengthMph: qualifying.reduce((sum, value) => sum + value, 0) / qualifying.length,
    hardestThrowMph: Math.max(...normal.map((row) => finite(row.peak_speed_mph))),
  }
}

function groupRows(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const value = row?.[key]
    if (value == null) continue
    const normalized = String(value)
    if (!groups.has(normalized)) groups.set(normalized, [])
    groups.get(normalized).push(row)
  }
  return groups
}

function groupRowsByKeys(rows, keys) {
  const groups = new Map()
  for (const row of rows) {
    const seen = new Set()
    for (const key of keys) {
      const value = row?.[key]
      if (value == null || seen.has(String(value))) continue
      const normalized = String(value)
      seen.add(normalized)
      if (!groups.has(normalized)) groups.set(normalized, [])
      groups.get(normalized).push(row)
    }
  }
  return groups
}

export function summarizeAdvancedFielding({
  throws = [], runnerOpportunities = [], doublePlayOpportunities = [], fieldingOpportunities = [],
} = {}, identity = 'character') {
  const keySuffix = identity === 'player' ? 'player_id' : 'character_id'
  const throwKey = `thrower_${keySuffix}`
  const armKey = `responsible_fielder_${keySuffix}`
  const dpKey = `first_fielder_${keySuffix}`
  const dpPivotKey = `pivot_fielder_${keySuffix}`
  const fieldKey = `fielder_${keySuffix}`
  const groupedThrows = groupRows(throws, throwKey)
  const groupedArm = groupRows(runnerOpportunities, armKey)
  const groupedDp = groupRows(doublePlayOpportunities, dpKey)
  const groupedDpParticipants = groupRowsByKeys(doublePlayOpportunities, [dpKey, dpPivotKey])
  const groupedField = groupRows(fieldingOpportunities, fieldKey)
  const ids = new Set([...groupedThrows.keys(), ...groupedArm.keys(), ...groupedDpParticipants.keys(), ...groupedField.keys()])
  return Object.fromEntries([...ids].map((id) => {
    const arm = groupedArm.get(id) || []
    // Both fielders who complete the play receive the traditional DP count.
    // Modeled value remains with the resolved owner/first fielder so summing
    // character rows cannot double-count one defensive play.
    const dpParticipation = groupedDpParticipants.get(id) || []
    const dp = (groupedDp.get(id) || []).filter((row) => (
      identity === 'player' || row.credit_status === 'player'
    ))
    const allField = (groupedField.get(id) || []).filter((row) => row.quality?.quarantined_session !== true)
    const field = allField.filter((row) => row.is_primary && !isExcludedFromOaa(row)
      && finite(row.outs_above_average) != null)
    const positioned = allField.filter((row) => finite(row.position_depth_ft) != null)
    const strength = aggregateArmStrength(groupedThrows.get(id) || [])
    const armValue = arm.reduce((sum, row) => sum + finite(row.arm_run_value, 0), 0)
    const dpRuns = dp.reduce((sum, row) => sum + finite(row.run_value, 0), 0)
    const oaa = field.reduce((sum, row) => sum + finite(row.outs_above_average, 0), 0)
    const directionalOaa = Object.fromEntries(
      ['back_left', 'back', 'back_right', 'in_left', 'in', 'in_right'].map((direction) => [
        direction,
        field.filter((row) => row.direction === direction)
          .reduce((sum, row) => sum + finite(row.outs_above_average, 0), 0),
      ]),
    )
    const directionalOpportunities = Object.fromEntries(
      ['back_left', 'back', 'back_right', 'in_left', 'in', 'in_right'].map((direction) => [
        direction,
        field.filter((row) => row.direction === direction).length,
      ]),
    )
    return [id, {
      ...strength,
      armOpportunities: arm.length,
      armHolds: arm.filter((row) => row.outcome === 'hold').length,
      armAdvances: arm.filter((row) => row.outcome === 'advance_safe').length,
      armKills: arm.filter((row) => row.outcome === 'advance_out').length,
      armValue,
      doublePlayOpportunities: dpParticipation.length,
      doublePlays: dpParticipation.filter((row) => row.double_play_completed).length,
      doublePlaysAdded: dp.length ? dp.reduce((sum, row) => sum + finite(row.double_plays_added, 0), 0) : null,
      doublePlayRuns: dp.length ? dpRuns : null,
      fieldingOpportunities: field.length,
      actualOuts: field.filter((row) => row.actual_out).length,
      expectedOuts: field.reduce((sum, row) => sum + finite(row.expected_out_probability, 0), 0),
      outsAboveAverage: oaa,
      directionalOaa,
      directionalOpportunities,
      positioningSamples: positioned.length,
      averagePositionDepthFeet: positioned.length
        ? positioned.reduce((sum, row) => sum + finite(row.position_depth_ft, 0), 0) / positioned.length
        : null,
      averagePositionAngleDeg: positioned.length
        ? positioned.reduce((sum, row) => sum + finite(row.position_angle_deg, 0), 0) / positioned.length
        : null,
      fieldingRunValue: oaa * 0.8 + armValue + dpRuns,
    }]
  }))
}

// The six opportunity types buildExtraBaseOpportunitiesFromPa can produce, in
// the order a reader expects them. Named rather than discovered from the rows,
// so a summary always carries all six: a runner who never had a tag-up chance
// has to read 0 opportunities there, or the split silently disappears and the
// table's columns move from row to row.
export const EXTRA_BASE_OPPORTUNITY_TYPES = Object.freeze([
  'first_to_third_on_single',
  'second_to_home_on_single',
  'first_to_home_on_double',
  'tag_first_to_second',
  'tag_second_to_third',
  'tag_third_to_home',
])

function baserunningCounts(rows) {
  const attempts = rows.filter((row) => row.attempted)
  const advances = rows.filter((row) => row.outcome === 'advance_safe')
  return {
    opportunities: rows.length,
    attempts: attempts.length,
    holds: rows.filter((row) => row.outcome === 'hold').length,
    advances: advances.length,
    outs: rows.filter((row) => row.outcome === 'advance_out').length,
    // THREE DIFFERENT RATES, and the site has been showing one of them under a
    // name that reads like another. `attemptRate` is what the XBT% column has
    // always meant -- how often the runner went -- and its definition is
    // unchanged here. `successRate` is per ATTEMPT, `safeRate` is per
    // OPPORTUNITY, and the two coincide only for a runner who attempts
    // everything, which is exactly the runner nobody is trying to measure.
    attemptRate: rows.length ? attempts.length / rows.length : null,
    successRate: attempts.length ? advances.length / attempts.length : null,
    safeRate: rows.length ? advances.length / rows.length : null,
  }
}

export function summarizeAdvancedBaserunning(rows = [], identity = 'character') {
  const key = identity === 'player' ? 'runner_player_id' : 'runner_character_id'
  return Object.fromEntries([...groupRows(rows, key)].map(([id, opportunities]) => {
    const modeled = opportunities.filter((row) => finite(row.runner_run_value) != null)
    return [id, {
      ...baserunningCounts(opportunities),
      // Per opportunity type, so first-to-third on a single reads apart from a
      // tag-up. TWO KEYS ON PURPOSE. `byType` keeps the exact counts-only shape
      // an existing consumer already reads, listing only the types that came
      // up; `splits` is the new contract -- all six types always present, with
      // the rates beside the counts -- so a table's columns cannot move from
      // row to row just because a runner never had a tag-up chance.
      byType: Object.fromEntries([...new Set(opportunities.map((row) => row.opportunity_type))]
        .map((type) => {
          const typed = opportunities.filter((row) => row.opportunity_type === type)
          return [type, {
            opportunities: typed.length,
            holds: typed.filter((row) => row.outcome === 'hold').length,
            attempts: typed.filter((row) => row.attempted).length,
            advances: typed.filter((row) => row.outcome === 'advance_safe').length,
            outs: typed.filter((row) => row.outcome === 'advance_out').length,
          }]
        })),
      splits: Object.fromEntries(EXTRA_BASE_OPPORTUNITY_TYPES.map((type) => [
        type, baserunningCounts(opportunities.filter((row) => row.opportunity_type === type)),
      ])),
      modeledOpportunities: modeled.length,
      // How much of this runner's record the model actually priced. It belongs
      // beside Rbaser: a run value fitted on two of eleven chances must not be
      // read as though it covered all eleven.
      modeledCoverage: opportunities.length ? modeled.length / opportunities.length : null,
      // The model's own expectations, over the rows it priced, and NULL when it
      // priced none. Not zero -- an unmodeled runner has no expected attempt
      // rate, and a zero there ranks them as the most passive runner alive.
      expectedAttemptRate: modeled.length
        ? modeled.reduce((sum, row) => sum + finite(row.expected_attempt_probability, 0), 0) / modeled.length
        : null,
      expectedSuccessRate: modeled.length
        ? modeled.reduce((sum, row) => sum + finite(row.expected_success_probability, 0), 0) / modeled.length
        : null,
      baserunningRunValue: modeled.length
        ? opportunities.reduce((sum, row) => sum + finite(row.runner_run_value, 0), 0) : null,
    }]
  }))
}

export const MIN_QUALIFYING_RUN_UNITS = 15

/**
 * @param {object[]} rows  movement_metrics rows.
 * @param {'character'|'player'} identity
 * @param {{ speedStatByCharacterId?: Map<string, number> }} [options]
 *   the characters table's `run_speed` per character id. WITHOUT IT the
 *   max-speed constant cannot be classified as ordinary or boosted, and this
 *   says so rather than guessing -- see maxSpeedClassified below.
 */
export function summarizeMovementMetrics(rows = [], identity = 'character', options = {}) {
  const speedStatByCharacterId = options.speedStatByCharacterId || null
  const key = identity === 'player' ? 'player_id' : 'character_id'
  const usableRows = rows.filter((row) => row.quality?.quarantined_session !== true)
  return Object.fromEntries([...groupRows(usableRows, key)].map(([id, samples]) => {
    // A run has to be long enough for the character to reach top speed before
    // it says anything about how fast they are. Measured against the game's own
    // run_speed attribute, the qualifying distance is most of the metric: this
    // estimator correlates at 0.69 admitting every run over 1 unit and 0.72
    // over 15. It keeps climbing to 0.78 at 20 units, but the characters that
    // qualify drop from 31 to 24, which is a worse trade at the sample sizes
    // this league has.
    //
    // Only runner and batter rows, deliberately. A FIELDER's per-play speed is
    // context for a range model, not a rating -- see the note in
    // scripts/ingest_player_tracking.mjs.
    const running = samples.filter((row) => (
      ['runner', 'batter'].includes(row.actor_type)
      && finite(row.sprint_speed_fps) > 0
      && (finite(row.path_distance_m) == null
        || finite(row.path_distance_m) >= MIN_QUALIFYING_RUN_UNITS)
    ))
    const competitive = [...running].sort((a, b) => finite(b.sprint_speed_fps, 0) - finite(a.sprint_speed_fps, 0))
    const qualifying = competitive.slice(0, Math.max(1, Math.ceil(competitive.length * 2 / 3)))
    const homeToFirst = samples.filter((row) => finite(row.home_to_first_seconds) != null)
    const ninety = samples.filter((row) => finite(row.ninety_foot_split_seconds) != null)
    const jump = samples.filter((row) => row.actor_type === 'fielder' && finite(row.jump_distance_feet) != null)
    const average = (source, accessor) => source.length
      ? source.reduce((sum, row) => sum + finite(accessor(row), 0), 0) / source.length
      : null

    // ── The character's top speed, which is not the same thing as the speeds
    // above ────────────────────────────────────────────────────────────────
    //
    // `max_speed_fps` is the fielder actor's own max-speed constant. It is a
    // CAPACITY -- the game's stored answer for how fast this character can run
    // -- and every other number in this function is a PERFORMANCE: how fast
    // they went, how long they took, how far they got. The two must never be
    // averaged together or presented as the same measurement.
    //
    // CLASSIFICATION IS AGAINST THE CURVE, NOT AGAINST THE MODE. An earlier
    // version took the most common value as "ordinary" and counted anything
    // above it as boosted. That is only right when ordinary rows outnumber
    // boosted ones, and it fails in exactly the cases that matter: a character
    // seen ONLY in the boosted session reports the boosted constant as their
    // ordinary top speed, with a boosted-sample count of ZERO beside it,
    // because nothing sits above the mode. Scoped to one season or one park,
    // boosted rows can dominate just as easily.
    //
    // So each value is matched against what the workbook curve says this
    // character's rating allows -- getFieldSpeed(run_speed) for ordinary, and
    // the floor(run_speed * 1.5) row for boosted. A value matching neither is
    // left UNCLASSIFIED rather than assigned to whichever is nearer.
    const maxSpeedRows = samples.filter((row) => (
      row.actor_type === 'fielder' && finite(row.max_speed_fps) != null
    ))
    const observed = maxSpeedRows.map((row) => Number(finite(row.max_speed_fps).toFixed(3)))
    const distinctValues = new Set(observed)

    const speedStat = speedStatByCharacterId ? finite(speedStatByCharacterId.get(String(id))) : null
    const ordinaryCurve = speedStat == null
      ? null : getFieldSpeed(speedStat).speedPerSecond * METRES_TO_FEET
    const boostedCurve = speedStat == null
      ? null : getFieldSpeed(speedStat, { boosted: true }).speedPerSecond * METRES_TO_FEET
    // derive_player_metrics.py rounds max_speed_fps to three decimals IN FEET,
    // independently of max_speed_ups, so the stored value sits on a 0.001 ft/s
    // grid and lands within 0.0005 ft/s of the curve -- not the 0.0017 a u/s
    // grid converted to feet would give, which is what this comment used to
    // say. This window is twenty times that and far narrower than the gap
    // between the ordinary and boosted rows, which is never below 0.09 ft/s
    // for any rating.
    const MATCH_WINDOW_FPS = 0.01
    const near = (value, target) => target != null && Math.abs(value - target) <= MATCH_WINDOW_FPS

    const ordinaryValues = observed.filter((value) => near(value, ordinaryCurve))
    const boostedValues = observed.filter((value) => !near(value, ordinaryCurve) && near(value, boostedCurve))
    const unclassifiedValues = observed.filter((value) => (
      !near(value, ordinaryCurve) && !near(value, boostedCurve)
    ))

    // WITHOUT A RATING there is nothing to classify against. Reporting the mode
    // anyway is the same guess under another name, so the value is still
    // offered -- a caller may hold one constant and no roster row -- but
    // `maxSpeedClassified` says it was never checked, and the UI keeps that
    // uncertainty visible instead of calling it ordinary.
    const modal = observed.length
      ? [...observed.reduce((counts, value) => counts.set(value, (counts.get(value) || 0) + 1), new Map())]
        .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0][0]
      : null

    return [id, {
      // Populated only when an observation actually matched this character's
      // ordinary curve row. A character seen only in a boosted state reports
      // null here and a boosted count above zero, which is the truthful pair.
      maxSpeedFps: speedStat == null ? modal : (ordinaryValues.length ? ordinaryValues[0] : null),
      maxSpeedSamples: speedStat == null ? observed.length : ordinaryValues.length,
      maxSpeedBoostedFps: boostedValues.length ? boostedValues[0] : null,
      maxSpeedBoostedSamples: boostedValues.length,
      maxSpeedUnclassifiedSamples: speedStat == null ? 0 : unclassifiedValues.length,
      maxSpeedUnclassifiedValues: speedStat == null ? [] : [...new Set(unclassifiedValues)],
      maxSpeedObservedSamples: observed.length,
      // False when no rating was supplied: the value above is then the modal
      // observation and has NOT been shown to be the ordinary constant.
      maxSpeedClassified: speedStat != null,
      // More than one distinct value for one character is worth surfacing
      // whether or not classification succeeded.
      maxSpeedDistinctValues: distinctValues.size,
      speedSamples: running.length,
      sprintSpeedFps: average(qualifying, (row) => row.sprint_speed_fps),
      maxSprintSpeedFps: running.length ? Math.max(...running.map((row) => finite(row.sprint_speed_fps, 0))) : null,
      bolts: running.filter((row) => row.is_bolt).length,
      homeToFirstSamples: homeToFirst.length,
      homeToFirstSeconds: average(homeToFirst, (row) => row.home_to_first_seconds),
      ninetyFootSplitSamples: ninety.length,
      ninetyFootSplitSeconds: average(ninety, (row) => row.ninety_foot_split_seconds),
      jumpSamples: jump.length,
      jumpDistanceFeet: average(jump, (row) => row.jump_distance_feet),
      jumpReactionFeet: average(jump, (row) => row.reaction_distance_feet),
      jumpBurstFeet: average(jump, (row) => row.burst_distance_feet),
      jumpRouteEfficiency: average(jump.filter((row) => finite(row.jump_route_efficiency) != null), (row) => row.jump_route_efficiency),
    }]
  }))
}

// ─── Catch reach ─────────────────────────────────────────────────────────────
//
// How far a fielder actually had to stretch, from tracking_catch_approaches.
// One row per approach window, including the windows that never reached the
// ball -- see the table comment in
// supabase/migrations/20260920130000_tracking_catch_approaches.sql.
//
// WHAT THIS IS NOT. It is not the workbook catch radius and it is not
// `jump_distance_feet`. The workbook publishes a radius measured from the
// glove; this is measured from the fielder actor's own origin, and across the
// archive the observed separation on a secured ordinary catch runs about 1.4x
// the published radius for every character.
//
// THEY ARE NOT RANKED AGAINST EACH OTHER EITHER. An earlier version of this
// comment said they could be, on the strength of r = 0.73 between the
// per-character medians over 30 characters. That figure came from a one-off
// pass over the local archive, is not reproducible from the database the page
// reads, and covers STANDING reach only -- dive reach ranked NEGATIVELY over
// 13 characters, r = -0.53, because how far a dive travels is mostly how far
// the ball was. The Scouting Report therefore publishes no delta of any kind
// on these rows, not a subtraction and not a difference of ranks
// (`compare: false` in src/utils/measuredAttributes.js), and this comment no
// longer says otherwise.
//
// THE LARGEST SECURED CATCH IS A FLOOR, NOT A CEILING. A fielder is never
// obliged to catch at full stretch, so `reachSecuredMax` says only "at least
// this far". `reachFailedMin` is the other side: the shortest separation this
// character failed at. The ordinary-approach band across the whole archive is
// a secured 90th percentile of 3.67u against a failed 10th percentile of
// 4.06u, so the two do separate -- but only in aggregate, and per character
// the samples are small. Report both or neither.
const CATCH_REACH_APPROACHES = ['ordinary', 'dive', 'leap']

// A window that any of these touched is not a measurement of the character's
// own mechanics. Kept as one list so the UI can name what was excluded.
export function catchApproachIsOrdinaryMechanics(row) {
  if (!row) return false
  if (row.quality?.quarantined_session === true) return false
  // THE GAME MOVING THE BODY ON THE RESOLVING FRAME is what disqualifies a
  // reach, and only that. A glide earlier in the approach is how the fielder
  // GOT there -- it changes where they started stretching from, not how far
  // they stretched -- which is the distinction derive_player_metrics.py draws
  // when it writes these two flags. Gating on `assisted` as well threw away
  // the 20 ordinary windows in the current database where the glide ended
  // before the catch did, and they are measurements like any other.
  if (row.assisted_at_closest === true) return false
  // A Buddy Jump is a different mechanic, not a glide: two characters combine
  // for a reach neither one has.
  if (finite(row.buddy_jump_frames, 0) > 0) return false
  // A table, an arrow, a stun or a hazard decided this reach.
  if (row.quality?.stadium_affected === true) return false
  if (row.quality?.star_swing === true) return false
  // Egg, star ball, Buddy receive: a special action, not an ordinary catch.
  const mechanics = Array.isArray(row.mechanics) ? row.mechanics : []
  if (mechanics.length && mechanics.some((mechanic) => mechanic !== 'ordinary')) return false
  return true
}

function quantile(sorted, fraction) {
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)))
  return sorted[index]
}

/**
 * Per character (or player), per approach: attempts, conversions and the reach
 * envelope, in world units.
 *
 * `approach: 'throw'` is dropped outright -- receiving a throw is a different
 * mechanic from reaching a batted ball, and it is 2,902 of the archive's 7,744
 * windows, enough to swamp the ones that mean something.
 */
export function summarizeCatchReach(rows = [], identity = 'character') {
  const key = identity === 'player' ? 'fielder_player_id' : 'fielder_character_id'
  const eligible = (rows || []).filter((row) => (
    CATCH_REACH_APPROACHES.includes(row?.approach)
    && finite(row?.separation_3d_units) != null
  ))
  const ordinaryMechanics = eligible.filter(catchApproachIsOrdinaryMechanics)

  return Object.fromEntries([...groupRows(ordinaryMechanics, key)].map(([id, samples]) => {
    const byApproach = {}
    for (const approach of CATCH_REACH_APPROACHES) {
      const windows = samples.filter((row) => row.approach === approach)
      if (!windows.length) continue
      const secured = windows.filter((row) => row.outcome === 'secured')
        .map((row) => finite(row.separation_3d_units)).sort((a, b) => a - b)
      const failed = windows.filter((row) => row.outcome === 'missed' || row.outcome === 'no_contact')
        .map((row) => finite(row.separation_3d_units)).sort((a, b) => a - b)
      const touched = windows.filter((row) => row.outcome === 'touched').length
      const heights = windows.map((row) => finite(row.relative_height_units))
        .filter((value) => value != null).sort((a, b) => a - b)
      byApproach[approach] = {
        attempts: windows.length,
        secured: secured.length,
        touched,
        failed: failed.length,
        conversion: windows.length ? secured.length / windows.length : null,
        reachSecuredMedian: quantile(secured, 0.5),
        reachSecuredP90: quantile(secured, 0.9),
        // A floor on capability, never a ceiling -- see the note above.
        reachSecuredMax: secured.length ? secured[secured.length - 1] : null,
        // The other side of the bound: the shortest reach this character did
        // NOT complete. Null when they never failed, which is not the same as
        // having no limit.
        reachFailedMin: failed.length ? failed[0] : null,
        relativeHeightMedian: quantile(heights, 0.5),
      }
    }
    const excluded = eligible.filter((row) => (
      String(row[key]) === String(id) && !catchApproachIsOrdinaryMechanics(row)
    )).length
    return [id, {
      approaches: byApproach,
      totalWindows: samples.length,
      excludedWindows: excluded,
    }]
  }))
}
