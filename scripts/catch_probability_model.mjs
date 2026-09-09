import crypto from 'node:crypto'
import fs from 'node:fs'

export const OPPORTUNITY_DEFINITION_VERSION = 'sluggers-of-airborne-opportunity-v1'
export const ARTIFACT_SCHEMA_VERSION = 'sluggers-catch-probability-artifact-v1'
export const MODEL_VERSION = 'sluggers-catch-probability-candidate-v1'
export const OUTFIELD_POSITIONS = Object.freeze(['LF', 'CF', 'RF'])
export const PRE_OUTCOME_FEATURES = Object.freeze([
  'park',
  'position',
  'start_depth_units',
  'start_angle_deg',
  'projected_distance_units',
  'projected_landing_seconds',
  'projected_required_speed_ups',
  'projected_direction',
])

export const ACTIVATION_CRITERIA = Object.freeze({
  declared_before_final_test: true,
  minimum_eligible_opportunities: 500,
  minimum_failures: 100,
  minimum_final_test_opportunities: 100,
  minimum_final_test_failures: 20,
  maximum_session_share: 0.20,
  maximum_park_share: 0.35,
  maximum_test_ece: 0.08,
  minimum_relative_brier_improvement_vs_climatology: 0.02,
  minimum_populated_probability_bins: 3,
  minimum_rows_per_probability_bin: 20,
  maximum_sensitivity_brier_change: 0.03,
  grouped_bootstrap_brier_improvement_lower_bound_must_exceed_zero: true,
  required_predictor_families: ['fielder_start', 'ball_path_or_projected_endpoint', 'time_available'],
  all_predictors_must_be_knowable_before_outcome: true,
})

const EPSILON = 1e-6

export function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function clampProbability(value) {
  return Math.max(EPSILON, Math.min(1 - EPSILON, Number(value)))
}

export function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function rounded(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : Number(number.toFixed(digits))
}

function vectorDistance2d(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null
  const ax = finite(a[0]); const az = finite(a[2])
  const bx = finite(b[0]); const bz = finite(b[2])
  return [ax, az, bx, bz].some((value) => value == null)
    ? null
    : Math.hypot(bx - ax, bz - az)
}

function directionFromVector(start, target) {
  if (!Array.isArray(start) || !Array.isArray(target)) return 'unknown'
  const dx = finite(target[0]) - finite(start[0])
  const dz = finite(target[2]) - finite(start[2])
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.hypot(dx, dz) < 0.5) return 'stationary'
  const back = dz < 0
  const lateral = Math.abs(dx) < 2 ? '' : dx < 0 ? '_left' : '_right'
  return `${back ? 'back' : 'in'}${lateral}`
}

export function difficultyBand(requiredClosingSpeed) {
  const speed = finite(requiredClosingSpeed)
  if (speed == null) return 'unknown'
  if (speed < 2) return 'under_2'
  if (speed < 4) return '2_to_4'
  if (speed < 6) return '4_to_6'
  if (speed < 8) return '6_to_8'
  return '8_plus'
}

function hasUnresolvedFielding(play) {
  return (play.fielding_events || []).some((event) => (
    event?.ball_contact === 'unknown'
    || event?.mechanic === 'unresolved_special'
    || event?.confidence === 'unknown'
  ))
}

function wallPlay(play) {
  const primary = play?.primary_fielder
  const approach = (play?.catch_approaches || []).find((row) => row?.by === primary)
  const height = finite(play?.first_touch?.ball_height_units)
  return Boolean(
    play?.home_run_robbed
    || play?.robbed_home_run
    || approach?.approach === 'clamber'
    || approach?.catch_type === 5
    || (height != null && height > 3),
  )
}

function specialPlay(play) {
  const primary = play?.primary_fielder
  const approach = (play?.catch_approaches || []).find((row) => row?.by === primary)
  return Boolean(
    (play?.forced_misplays || []).length
    || (play?.buddy_handoffs || []).length
    || (play?.buddy_jumps || []).length
    || play?.after_deflection
    || play?.rebound_catch
    || approach?.approach === 'unresolved'
    || approach?.approach === 'unresolved_special',
  )
}

export function classifyPlayForAudit(play = {}) {
  const primary = play.primary_fielder || null
  const fielder = primary ? play.fielders?.[primary] : null
  const caught = Boolean(play.caught_in_flight && play.first_touch?.by === primary)
  const fair = ['fair_caught', 'fair_in_play'].includes(play.batted_ball_class)
  const airborneFailure = Boolean(
    play.batted_ball_class === 'fair_in_play'
    && play.landing
    && finite(play.hang_time_s) != null
    && finite(play.hang_time_s) >= 1,
  )
  const officialError = (play.fielding_events || []).some((event) => event?.official_error === true)
  const unresolved = hasUnresolvedFielding(play) || (fair && !primary)
  const assisted = finite(fielder?.assist_frames) > 0 || finite(fielder?.assist_units) > 0
  const primaryApproach = (play?.catch_approaches || []).find((row) => row?.by === primary)
  return {
    fair,
    caught,
    airborne_failure_candidate: airborneFailure,
    ground_ball_or_low_air: Boolean(play.batted_ball_class === 'fair_in_play' && !airborneFailure),
    wall_play: wallPlay(play),
    official_error: officialError,
    assisted_movement: assisted,
    reach_activation: ['dive', 'leap', 'clamber'].includes(primaryApproach?.approach),
    special_mechanic: specialPlay(play),
    unresolved,
  }
}

export function playFingerprint(play = {}) {
  const landing = play.landing?.at || null
  const touch = play.first_touch?.at || null
  return stableHash(JSON.stringify({
    inning: play.inning,
    half: play.inning_half,
    outs: play.outs,
    balls: play.balls,
    strikes: play.strikes,
    batter: play.batter_id,
    class: play.batted_ball_class,
    contact: (play.contact_at || []).map((value) => rounded(value, 3)),
    endpoint: (landing || touch || []).map((value) => rounded(value, 3)),
    primary: play.primary_fielder,
    caught: Boolean(play.caught_in_flight),
  }))
}

export function buildOpportunity(play, session, annotation = null, preOutcomeFlight = null) {
  const audit = classifyPlayForAudit(play)
  const reasons = []
  const primary = play?.primary_fielder || null
  const fielder = primary ? play?.fielders?.[primary] : null
  const caughtLabel = Boolean(
    audit.caught
    && play?.batted_ball_class === 'fair_caught'
    && play?.primary_fielder_reason === 'catch',
  )
  const failedLabel = Boolean(
    audit.airborne_failure_candidate
    && ['fielded', 'failed_contact', 'closest_at_landing'].includes(play?.primary_fielder_reason),
  )

  if (session?.join_status !== 'validated_all_joined') reasons.push('session_not_join_validated')
  if (session?.quarantined) reasons.push('quarantined_session')
  if (session?.malformed) reasons.push('malformed_session')
  if (play?.truncated) reasons.push('truncated_play')
  if (annotation) reasons.push('operator_annotation')
  if (!audit.fair) reasons.push('not_fair_ball')
  if (!OUTFIELD_POSITIONS.includes(primary)) reasons.push('not_primary_outfielder')
  if (!caughtLabel && !failedLabel) reasons.push('not_defensible_airborne_label')
  if (!fielder) reasons.push('missing_primary_fielder')
  if (audit.special_mechanic) reasons.push('special_or_redirected_mechanic')
  if (audit.wall_play) reasons.push('wall_play')
  if (audit.official_error) reasons.push('official_error')
  if (audit.unresolved) reasons.push('unresolved_fielding_evidence')
  if (finite(fielder?.pitch_release_start?.[0]) == null || finite(fielder?.pitch_release_start?.[2]) == null) {
    reasons.push('missing_pitch_release_start')
  }
  if (!preOutcomeFlight?.valid) reasons.push('missing_preoutcome_flight_projection')

  const start = fielder?.pitch_release_start || null
  const target = caughtLabel ? play?.first_touch?.at : play?.landing?.at
  const startX = finite(start?.[0])
  const startZ = finite(start?.[2])
  const targetDistance = vectorDistance2d(start, target)
  const resolutionSeconds = finite(play?.hang_time_s)
  const requiredClosingSpeed = targetDistance != null && resolutionSeconds > 0
    ? targetDistance / resolutionSeconds
    : null
  const projectedEndpoint = preOutcomeFlight?.features
    ? [preOutcomeFlight.features.projected_endpoint_x_units, 0, preOutcomeFlight.features.projected_endpoint_z_units]
    : null
  const projectedDistance = vectorDistance2d(start, projectedEndpoint)
  const projectedSeconds = finite(preOutcomeFlight?.features?.projected_landing_seconds)
  const projectedSpeed = projectedDistance != null && projectedSeconds > 0
    ? projectedDistance / projectedSeconds
    : null

  return {
    opportunity_id: `${session.stem}:${play.contact_timer}`,
    definition_version: OPPORTUNITY_DEFINITION_VERSION,
    session: session.stem,
    related_capture_group: session.related_capture_group || session.stem,
    park: session.park,
    contact_timer: finite(play.contact_timer),
    inning: finite(play.inning),
    inning_half: finite(play.inning_half),
    primary_fielder: primary,
    primary_fielder_reason: play?.primary_fielder_reason || null,
    primary_character_id: finite(fielder?.character_id),
    primary_character: fielder?.character || null,
    batted_ball_class: play?.batted_ball_class || null,
    outcome: caughtLabel ? 'catch' : failedLabel ? 'failed_catch_opportunity' : null,
    actual_catch: caughtLabel ? 1 : failedLabel ? 0 : null,
    eligible: reasons.length === 0,
    exclusion_reasons: reasons,
    features: {
      park: session.park,
      position: primary,
      start_x_units: startX,
      start_z_units: startZ,
      start_depth_units: startX == null || startZ == null ? null : Math.hypot(startX, startZ),
      start_angle_deg: startX == null || startZ == null ? null : Math.atan2(startX, -startZ) * 180 / Math.PI,
      projected_endpoint_x_units: finite(preOutcomeFlight?.features?.projected_endpoint_x_units),
      projected_endpoint_z_units: finite(preOutcomeFlight?.features?.projected_endpoint_z_units),
      projected_distance_units: projectedDistance,
      projected_landing_seconds: projectedSeconds,
      projected_required_speed_ups: projectedSpeed,
      projected_direction: directionFromVector(start, projectedEndpoint),
    },
    audit_strata: {
      direction: directionFromVector(start, target),
      difficulty_band: difficultyBand(requiredClosingSpeed),
      distance_to_resolution_units: targetDistance,
      resolution_seconds: resolutionSeconds,
      required_closing_speed_ups: requiredClosingSpeed,
      assisted_movement: audit.assisted_movement,
      reach_activation: audit.reach_activation,
      wall_play: audit.wall_play,
      special_mechanic: audit.special_mechanic,
      official_error: audit.official_error,
      unresolved: audit.unresolved,
    },
    leakage_audit: {
      model_features: [...PRE_OUTCOME_FEATURES],
      information_boundary: preOutcomeFlight?.information_boundary || null,
      diagnostic_only_post_outcome_fields: [
        'distance_to_resolution_units',
        'resolution_seconds',
        'required_closing_speed_ups',
        'direction',
        'assisted_movement',
      ],
      warning: 'Catch point/time are observed at a catch while landing point/time are observed on a miss; they are forbidden as predictors.',
    },
    source_fingerprint: playFingerprint(play),
  }
}

export function findRelatedCaptureGroups(sessions) {
  const parents = new Map(sessions.map((session) => [session.stem, session.stem]))
  const find = (value) => {
    let current = value
    while (parents.get(current) !== current) current = parents.get(current)
    let node = value
    while (parents.get(node) !== node) {
      const next = parents.get(node)
      parents.set(node, current)
      node = next
    }
    return current
  }
  const union = (a, b) => {
    const left = find(a); const right = find(b)
    if (left !== right) parents.set(right, left < right ? left : right)
  }
  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      const a = sessions[i]; const b = sessions[j]
      if (a.checksum && a.checksum === b.checksum) {
        union(a.stem, b.stem)
        continue
      }
      const aSet = new Set(a.play_fingerprints || [])
      const bSet = new Set(b.play_fingerprints || [])
      const overlap = [...aSet].filter((value) => bSet.has(value)).length
      const denominator = Math.min(aSet.size, bSet.size)
      if (overlap >= 10 && denominator > 0 && overlap / denominator >= 0.5) union(a.stem, b.stem)
    }
  }
  return Object.fromEntries(sessions.map((session) => [session.stem, find(session.stem)]))
}

function partitionTargets(total) {
  return { train: total * 0.60, validation: total * 0.20, test: total * 0.20 }
}

/**
 * Sessions an operator has deliberately set aside for one partition.
 *
 * WHY THIS EXISTS. The activation standard needs an untouched test of at least
 * 100 opportunities and 20 failures, and
 * docs/catch-probability-calibration-2026-09-05.md says plainly how to get
 * there: "reserve complete new sessions for test rather than topping up with
 * individual plays". Until now nothing could express that -- the split was a
 * pure function of the hash, so a session recorded specifically to be held out
 * had a 60% chance of landing in train, and a person could only find out after
 * the fact.
 *
 * A reservation moves a WHOLE related-capture group, never a play: a partition
 * boundary that cuts through a session is how a model ends up evaluated on
 * plays it was fitted on.
 *
 * It is deliberately not a way to improve a result. A session may only be
 * reserved BEFORE it has ever been trained on -- scripts/reserve_calibration_session.mjs
 * refuses otherwise -- because reserving a session for test after fitting on it
 * is leakage with extra steps.
 */
export function partitionForReservation(reservations, group) {
  if (!reservations?.length) return null
  for (const session of group.sessions) {
    const match = reservations.find((entry) => entry.session === session)
    if (match) return match.partition || 'test'
  }
  return null
}

export function buildGroupedSplit(opportunities, seed = 'sluggers-catch-probability-v1', {
  reservations = [],
} = {}) {
  const eligible = opportunities.filter((row) => row.eligible)
  const groups = new Map()
  for (const row of eligible) {
    const key = row.related_capture_group || row.session
    const group = groups.get(key) || { id: key, sessions: new Set(), rows: [] }
    group.sessions.add(row.session)
    group.rows.push(row)
    groups.set(key, group)
  }
  const ordered = [...groups.values()].sort((a, b) => (
    stableHash(`${seed}:${a.id}`).localeCompare(stableHash(`${seed}:${b.id}`))
  ))
  const target = partitionTargets(eligible.length)
  const assigned = { train: [], validation: [], test: [] }
  const counts = { train: 0, validation: 0, test: 0 }
  const honoured = []
  // Reserved groups first, so the greedy pass below fills around a fixed
  // held-out set rather than competing with it.
  for (const group of ordered) {
    const reserved = partitionForReservation(reservations, group)
    if (!reserved) continue
    assigned[reserved].push(group)
    counts[reserved] += group.rows.length
    group.reserved = reserved
    honoured.push({ group: group.id, partition: reserved, opportunities: group.rows.length })
  }
  for (const group of ordered) {
    if (group.reserved) continue
    const partition = ['train', 'validation', 'test']
      .map((name) => ({ name, deficit: target[name] - counts[name] }))
      .sort((a, b) => b.deficit - a.deficit || a.name.localeCompare(b.name))[0].name
    assigned[partition].push(group)
    counts[partition] += group.rows.length
  }
  const bySession = {}
  const rows = { train: [], validation: [], test: [] }
  for (const [partition, partitionGroups] of Object.entries(assigned)) {
    for (const group of partitionGroups) {
      for (const session of group.sessions) bySession[session] = partition
      rows[partition].push(...group.rows)
    }
  }
  return {
    schema_version: 2,
    seed,
    strategy: 'operator reservations first, then entire related-capture groups in deterministic '
      + 'sha256 order against 60/20/20 greedy count targets',
    // Recorded in the artifact so a split can be reproduced exactly: the hash
    // ordering alone no longer determines it once a reservation exists.
    reservations: honoured,
    by_session: bySession,
    partitions: Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, {
      opportunities: values.length,
      catches: values.filter((row) => row.actual_catch === 1).length,
      failures: values.filter((row) => row.actual_catch === 0).length,
      sessions: [...new Set(values.map((row) => row.session))].sort(),
      related_capture_groups: [...new Set(values.map((row) => row.related_capture_group))].sort(),
    }])),
    rows,
  }
}

function betaRate(successes, total, priorRate, priorStrength) {
  return (successes + priorRate * priorStrength) / (total + priorStrength)
}

function depthBin(depth) {
  if (depth < 60) return 'under_60'
  if (depth < 72) return '60_to_72'
  if (depth < 84) return '72_to_84'
  return '84_plus'
}

function speedBin(speed) {
  if (speed < 2) return 'under_2'
  if (speed < 4) return '2_to_4'
  if (speed < 6) return '4_to_6'
  if (speed < 8) return '6_to_8'
  return '8_plus'
}

export function fitEmpiricalBaseline(rows, { priorStrength = 16 } = {}) {
  const globalRate = rows.reduce((sum, row) => sum + row.actual_catch, 0) / Math.max(1, rows.length)
  const buckets = new Map()
  for (const row of rows) {
    const key = `${row.features.position}|${speedBin(row.features.projected_required_speed_ups)}`
    const entry = buckets.get(key) || { n: 0, catches: 0 }
    entry.n += 1; entry.catches += row.actual_catch
    buckets.set(key, entry)
  }
  return {
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    model_version: MODEL_VERSION,
    opportunity_definition_version: OPPORTUNITY_DEFINITION_VERSION,
    status: 'candidate',
    model_type: 'empirical_binned',
    feature_schema: [...PRE_OUTCOME_FEATURES],
    global_rate: globalRate,
    prior_strength: priorStrength,
    bins: Object.fromEntries([...buckets].map(([key, value]) => [key, {
      ...value,
      probability: betaRate(value.catches, value.n, globalRate, priorStrength),
    }])),
    supported_parks: [...new Set(rows.map((row) => row.park))].sort(),
    supported_positions: [...OUTFIELD_POSITIONS],
  }
}

function empiricalProbability(row, model) {
  const key = `${row.features.position}|${speedBin(row.features.projected_required_speed_ups)}`
  return clampProbability(model.bins[key]?.probability ?? model.global_rate)
}

function logisticFeatureNames(rows) {
  const parks = [...new Set(rows.map((row) => row.park))].sort()
  const directions = [...new Set(rows.map((row) => row.features.projected_direction))].sort()
  return {
    parks,
    directions,
    names: ['intercept', 'start_depth_z', 'abs_start_angle_z', 'projected_required_speed_z', 'projected_time_z',
      'position_CF', 'position_RF', ...parks.slice(1).map((park) => `park_${park}`),
      ...directions.slice(1).map((direction) => `direction_${direction}`)],
  }
}

function meanAndScale(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length)
  return { mean, scale: Math.sqrt(variance) || 1 }
}

function logisticVector(row, model) {
  const depth = (row.features.start_depth_units - model.standardization.start_depth.mean) / model.standardization.start_depth.scale
  const angle = (Math.abs(row.features.start_angle_deg) - model.standardization.abs_start_angle.mean) / model.standardization.abs_start_angle.scale
  const speed = (row.features.projected_required_speed_ups - model.standardization.projected_required_speed.mean) / model.standardization.projected_required_speed.scale
  const time = (row.features.projected_landing_seconds - model.standardization.projected_landing_seconds.mean) / model.standardization.projected_landing_seconds.scale
  return [
    1,
    depth,
    angle,
    speed,
    time,
    row.features.position === 'CF' ? 1 : 0,
    row.features.position === 'RF' ? 1 : 0,
    ...model.categories.parks.slice(1).map((park) => row.park === park ? 1 : 0),
    ...model.categories.directions.slice(1).map((direction) => row.features.projected_direction === direction ? 1 : 0),
  ]
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

export function fitRegularizedLogistic(rows, { lambda = 1, iterations = 4000, learningRate = 0.15 } = {}) {
  const categories = logisticFeatureNames(rows)
  const model = {
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    model_version: MODEL_VERSION,
    opportunity_definition_version: OPPORTUNITY_DEFINITION_VERSION,
    status: 'candidate',
    model_type: 'regularized_logistic',
    feature_schema: [...PRE_OUTCOME_FEATURES],
    feature_names: categories.names,
    lambda,
    standardization: {
      start_depth: meanAndScale(rows.map((row) => row.features.start_depth_units)),
      abs_start_angle: meanAndScale(rows.map((row) => Math.abs(row.features.start_angle_deg))),
      projected_required_speed: meanAndScale(rows.map((row) => row.features.projected_required_speed_ups)),
      projected_landing_seconds: meanAndScale(rows.map((row) => row.features.projected_landing_seconds)),
    },
    categories: { parks: categories.parks, positions: [...OUTFIELD_POSITIONS], directions: categories.directions },
    supported_parks: categories.parks,
    supported_positions: [...OUTFIELD_POSITIONS],
    coefficients: Array(categories.names.length).fill(0),
  }
  const vectors = rows.map((row) => logisticVector(row, model))
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = Array(model.coefficients.length).fill(0)
    for (let index = 0; index < rows.length; index += 1) {
      const vector = vectors[index]
      const prediction = sigmoid(vector.reduce((sum, value, j) => sum + value * model.coefficients[j], 0))
      for (let j = 0; j < gradient.length; j += 1) gradient[j] += (prediction - rows[index].actual_catch) * vector[j]
    }
    for (let j = 1; j < gradient.length; j += 1) gradient[j] += lambda * model.coefficients[j]
    const step = learningRate / Math.sqrt(1 + iteration / 200)
    for (let j = 0; j < gradient.length; j += 1) model.coefficients[j] -= step * gradient[j] / Math.max(1, rows.length)
  }
  return model
}

function logisticProbability(row, model) {
  const vector = logisticVector(row, model)
  return clampProbability(sigmoid(vector.reduce((sum, value, index) => sum + value * model.coefficients[index], 0)))
}

export function predictRows(rows, model) {
  return rows.map((row) => ({
    ...row,
    predicted_probability: model.model_type === 'empirical_binned'
      ? empiricalProbability(row, model)
      : logisticProbability(row, model),
  }))
}

export function calibrationBins(predictions, minimum = 0, width = 0.1) {
  const bins = []
  const count = Math.ceil((1 - minimum) / width)
  for (let index = 0; index < count; index += 1) {
    const low = minimum + index * width
    const high = Math.min(1, minimum + (index + 1) * width)
    const rows = predictions.filter((row) => (
      row.predicted_probability >= low
      && (high === 1 ? row.predicted_probability <= high : row.predicted_probability < high)
    ))
    bins.push({
      low: Number(low.toFixed(2)), high: Number(high.toFixed(2)), n: rows.length,
      mean_probability: rows.length ? rows.reduce((sum, row) => sum + row.predicted_probability, 0) / rows.length : null,
      catch_rate: rows.length ? rows.reduce((sum, row) => sum + row.actual_catch, 0) / rows.length : null,
    })
  }
  return bins
}

export function auc(predictions) {
  const positives = predictions.filter((row) => row.actual_catch === 1)
  const negatives = predictions.filter((row) => row.actual_catch === 0)
  if (!positives.length || !negatives.length) return null
  let wins = 0
  for (const positive of positives) for (const negative of negatives) {
    if (positive.predicted_probability > negative.predicted_probability) wins += 1
    else if (positive.predicted_probability === negative.predicted_probability) wins += 0.5
  }
  return wins / (positives.length * negatives.length)
}

export function evaluatePredictions(predictions) {
  if (!predictions.length) return null
  const brier = predictions.reduce((sum, row) => sum + (row.predicted_probability - row.actual_catch) ** 2, 0) / predictions.length
  const logLoss = predictions.reduce((sum, row) => {
    const probability = clampProbability(row.predicted_probability)
    return sum - row.actual_catch * Math.log(probability) - (1 - row.actual_catch) * Math.log(1 - probability)
  }, 0) / predictions.length
  const bins = calibrationBins(predictions)
  const ece = bins.reduce((sum, bin) => sum + (bin.n / predictions.length) * (
    bin.n ? Math.abs(bin.mean_probability - bin.catch_rate) : 0
  ), 0)
  return {
    n: predictions.length,
    catches: predictions.filter((row) => row.actual_catch === 1).length,
    failures: predictions.filter((row) => row.actual_catch === 0).length,
    brier, log_loss: logLoss, ece, auc: auc(predictions), calibration: bins,
  }
}

export function groupedMetrics(predictions, keyFn) {
  const groups = new Map()
  for (const row of predictions) {
    const key = String(keyFn(row) ?? 'unknown')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, evaluatePredictions(rows)]))
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function groupedBootstrapDifference(candidate, baseline, {
  iterations = 1000,
  seed = 20260905,
} = {}) {
  const bySession = new Map()
  for (let index = 0; index < candidate.length; index += 1) {
    const key = candidate[index].session
    if (!bySession.has(key)) bySession.set(key, [])
    bySession.get(key).push([candidate[index], baseline[index]])
  }
  const sessions = [...bySession.keys()].sort()
  if (!sessions.length) return null
  const random = mulberry32(seed)
  const differences = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampledCandidate = []; const sampledBaseline = []
    for (let draw = 0; draw < sessions.length; draw += 1) {
      const session = sessions[Math.floor(random() * sessions.length)]
      for (const [left, right] of bySession.get(session)) {
        sampledCandidate.push(left); sampledBaseline.push(right)
      }
    }
    differences.push(evaluatePredictions(sampledBaseline).brier - evaluatePredictions(sampledCandidate).brier)
  }
  differences.sort((a, b) => a - b)
  const percentile = (value) => differences[Math.min(differences.length - 1, Math.floor(value * differences.length))]
  return { metric: 'baseline_brier_minus_candidate_brier', iterations, lower_95: percentile(0.025), median: percentile(0.5), upper_95: percentile(0.975) }
}

export function validateArtifact(artifact, { requireActive = true } = {}) {
  const errors = []
  if (artifact?.artifact_schema_version !== ARTIFACT_SCHEMA_VERSION) errors.push('unsupported_artifact_schema')
  if (artifact?.opportunity_definition_version !== OPPORTUNITY_DEFINITION_VERSION) errors.push('unsupported_opportunity_definition')
  if (!['empirical_binned', 'regularized_logistic'].includes(artifact?.model_type)) errors.push('unsupported_model_type')
  if (JSON.stringify(artifact?.feature_schema) !== JSON.stringify(PRE_OUTCOME_FEATURES)) errors.push('unexpected_feature_schema')
  if (requireActive && artifact?.status !== 'active') errors.push('artifact_not_active')
  return { ok: errors.length === 0, errors }
}

export function loadFrozenCatchModel(path) {
  if (!path || !fs.existsSync(path)) return { artifact: null, reason: 'frozen_artifact_missing' }
  let artifact
  try { artifact = JSON.parse(fs.readFileSync(path, 'utf8')) } catch { return { artifact: null, reason: 'frozen_artifact_invalid_json' } }
  const validation = validateArtifact(artifact)
  return validation.ok ? { artifact, reason: null } : { artifact: null, reason: validation.errors.join(',') }
}

function scoringRow(input) {
  const park = input?.park
  const position = input?.position
  const startX = finite(input?.start_x_units ?? input?.pitch_release_x ?? input?.start?.[0])
  const startZ = finite(input?.start_z_units ?? input?.pitch_release_z ?? input?.start?.[2])
  const endpointX = finite(input?.projected_endpoint_x_units)
  const endpointZ = finite(input?.projected_endpoint_z_units)
  const projectedSeconds = finite(input?.projected_landing_seconds)
  if (!park) return { row: null, reason: 'missing_park' }
  if (!position) return { row: null, reason: 'missing_position' }
  if (startX == null || startZ == null) return { row: null, reason: 'missing_pitch_release_start' }
  if (endpointX == null || endpointZ == null || projectedSeconds == null || projectedSeconds <= 0) {
    return { row: null, reason: 'missing_preoutcome_flight_projection' }
  }
  const projectedDistance = Math.hypot(endpointX - startX, endpointZ - startZ)
  const projectedEndpoint = [endpointX, 0, endpointZ]
  return { row: { park, features: {
    park, position, start_x_units: startX, start_z_units: startZ,
    start_depth_units: Math.hypot(startX, startZ),
    start_angle_deg: Math.atan2(startX, -startZ) * 180 / Math.PI,
    projected_endpoint_x_units: endpointX,
    projected_endpoint_z_units: endpointZ,
    projected_distance_units: projectedDistance,
    projected_landing_seconds: projectedSeconds,
    projected_required_speed_ups: projectedDistance / projectedSeconds,
    projected_direction: directionFromVector([startX, 0, startZ], projectedEndpoint),
  } }, reason: null }
}

export function scoreCatchProbability(input, artifact) {
  const validation = validateArtifact(artifact)
  if (!validation.ok) return { probability: null, reason: validation.errors.join(',') }
  const built = scoringRow(input)
  if (!built.row) return { probability: null, reason: built.reason }
  if (!artifact.supported_positions?.includes(built.row.features.position)) return { probability: null, reason: 'unsupported_position' }
  if (!artifact.supported_parks?.includes(built.row.park)) return { probability: null, reason: 'unsupported_park' }
  const probability = artifact.model_type === 'empirical_binned'
    ? empiricalProbability(built.row, artifact)
    : logisticProbability(built.row, artifact)
  return { probability, reason: null, model_version: artifact.model_version }
}

export function opportunityOaa(actualCatch, expectedProbability) {
  if (![true, false, 0, 1].includes(actualCatch)) return { oaa: null, reason: 'missing_or_invalid_outcome' }
  if (!Number.isFinite(expectedProbability) || expectedProbability < 0 || expectedProbability > 1) return { oaa: null, reason: 'missing_or_invalid_probability' }
  return { oaa: (actualCatch ? 1 : 0) - expectedProbability, reason: null }
}

export function aggregateOpportunityOaa(rows) {
  let total = 0
  for (const row of rows || []) {
    if (finite(row?.legacy_range_runs) != null && finite(row?.outs_above_average) != null) {
      return { oaa: null, reason: 'legacy_range_and_oaa_double_count' }
    }
    if (finite(row?.outs_above_average) != null) total += finite(row.outs_above_average)
  }
  return { oaa: total, reason: null }
}
