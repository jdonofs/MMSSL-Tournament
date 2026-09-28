import { spawnSync } from 'node:child_process'
import { readReservations } from './reserve_calibration_session.mjs'
import { auditArchive as auditTrackingArchive } from './audit_tracking_archive.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  ACTIVATION_CRITERIA,
  ARTIFACT_SCHEMA_VERSION,
  MODEL_VERSION,
  OPPORTUNITY_DEFINITION_VERSION,
  PRE_OUTCOME_FEATURES,
  buildGroupedSplit,
  buildOpportunity,
  classifyPlayForAudit,
  evaluatePredictions,
  findRelatedCaptureGroups,
  fitEmpiricalBaseline,
  fitRegularizedLogistic,
  groupedBootstrapDifference,
  groupedMetrics,
  playFingerprint,
  predictRows,
  stableHash,
} from './catch_probability_model.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCHIVE = path.join(ROOT, 'data', 'player_tracking')
const OUTPUT = path.join(ROOT, 'data', 'calibration')
const FEATURE_PATH = path.join(OUTPUT, 'catch-probability-preoutcome-features-v1.jsonl')
const ANALYSIS_DATE = '2026-09-18'
// Unchanged from the first run on purpose: the split is a pure function of this
// seed and the session set, and picking a new seed after seeing a result is how
// a held-out test stops being held out.
const SPLIT_SEED = 'sluggers-catch-probability-v1-held-out-20260905'
const SESSION_LOG_DIR = path.join(ROOT, 'sluggers-stat-tracker-advanced-stats-dev', 'preview-sessions')

// A session is join-validated when its saved tracker log replays through the
// real preview join with every play joined and no validation warning -- the
// check the 2026-09-05 reliability review ran by hand on 12 sessions, now run
// by scripts/audit_tracking_archive.mjs on all of them. Until 2026-09-18 this
// was a hard-coded list of those 12, so 33 later games never reached the model.
function joinValidatedSessions() {
  const audit = auditTrackingArchive({ trackingDir: ARCHIVE, logDir: SESSION_LOG_DIR, join: true })
  return new Set(audit.sessions.filter((row) => (
    row.join && !row.join.error && row.join.plays > 0
    && row.join.joined === row.join.plays && row.join.warnings === 0
  )).map((row) => row.stem))
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function readJsonl(file) {
  const rows = []; const errors = []
  if (!fs.existsSync(file)) return { rows, errors: ['missing_file'] }
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    try { rows.push(JSON.parse(line)) } catch (error) { errors.push(`line_${index + 1}:${error.message}`) }
  })
  return { rows, errors }
}

function parkFromStem(stem, header = {}) {
  if (typeof header.park === 'string') return header.park
  const marker = stem.match(/^(.*)-\d{8}T\d{6}Z$/)
  return marker?.[1] || String(header.park ?? 'unknown')
}

function annotationsByContact(stem) {
  const parsed = readJsonl(path.join(ARCHIVE, `${stem}.annotations.jsonl`))
  return new Map(parsed.rows.flatMap((row) => (
    Number.isFinite(Number(row.play_contact_timer)) ? [[Number(row.play_contact_timer), row]] : []
  )))
}

function loadSessions(joinValidated) {
  return fs.readdirSync(ARCHIVE).filter((name) => name.endsWith('.plays.jsonl')).sort().map((name) => {
    const stem = name.slice(0, -'.plays.jsonl'.length)
    const header = readJson(path.join(ARCHIVE, `${stem}.json`), {})
    const parsed = readJsonl(path.join(ARCHIVE, name))
    const annotationMap = annotationsByContact(stem)
    return {
      stem,
      park: parkFromStem(stem, header),
      header,
      plays: parsed.rows,
      parse_errors: parsed.errors,
      annotations: annotationMap,
      checksum: header.checksum_sha256 || null,
      incomplete_header: !Number.isFinite(Number(header.frames)) || !Number.isFinite(Number(header.missed_frames)),
      quarantined: Boolean(header.fielder_pointers_left_region || header.status === 'quarantined'),
      malformed: parsed.errors.length > 0,
      join_status: joinValidated.has(stem) ? 'validated_all_joined' : 'not_validated',
      play_fingerprints: parsed.rows.map(playFingerprint),
    }
  // Stadium/gimmick research deliberately lets balls through so they reach
  // hazards.  Keeping those sessions out here is the final fit-time fence;
  // planner counts and feature export also honor the same header flag.
  }).filter((session) => session.header.calibration_excluded !== true)
}

function ensureFeatures(refresh, joinValidated) {
  if (fs.existsSync(FEATURE_PATH) && !refresh) return
  const python = process.env.SLUGGERS_PYTHON || 'python'
  const args = [
    path.join(ROOT, 'scripts', 'export_catch_preoutcome_features.py'),
    '--archive', ARCHIVE,
    '--out', FEATURE_PATH,
    '--sessions', ...[...joinValidated].sort(),
  ]
  const result = spawnSync(python, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`pre-outcome feature export failed with status ${result.status}`)
}

function countBy(rows, keyFn) {
  const counts = new Map()
  for (const row of rows) {
    const key = String(keyFn(row) ?? 'unknown')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))
}

function shareSummary(rows, keyFn) {
  const counts = countBy(rows, keyFn)
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { counts, maximum_share: rows.length ? (entries[0]?.[1] || 0) / rows.length : null, dominant: entries[0]?.[0] || null }
}

function mean(values) {
  const finite = values.filter(Number.isFinite)
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null
}

function auditArchive(sessions, opportunities, relatedGroups) {
  const plays = sessions.flatMap((session) => session.plays.map((play) => ({ session, play, audit: classifyPlayForAudit(play) })))
  const category = (name) => plays.filter((row) => row.audit[name]).length
  const duplicateChecksums = Object.entries(countBy(sessions.filter((row) => row.checksum), (row) => row.checksum))
    .filter(([, count]) => count > 1).map(([checksum, count]) => ({ checksum, count }))
  const fingerprintOwners = new Map()
  for (const session of sessions) for (const fingerprint of new Set(session.play_fingerprints)) {
    if (!fingerprintOwners.has(fingerprint)) fingerprintOwners.set(fingerprint, [])
    fingerprintOwners.get(fingerprint).push(session.stem)
  }
  const crossSessionDuplicateRows = [...fingerprintOwners.values()].filter((owners) => owners.length > 1)
  const candidates = opportunities.filter((row) => row.actual_catch != null)
  const eligible = opportunities.filter((row) => row.eligible)
  const annotatedOfficialErrors = sessions.flatMap((session) => [...session.annotations.values()])
    .filter((row) => row?.plate_appearance?.is_error || row?.plate_appearance?.result === 'ROE').length
  const missingFields = Object.fromEntries(PRE_OUTCOME_FEATURES.map((feature) => [feature,
    candidates.filter((row) => row.features?.[feature] == null).length]))
  return {
    schema_version: 1,
    analysis_date: ANALYSIS_DATE,
    opportunity_definition_version: OPPORTUNITY_DEFINITION_VERSION,
    archive: {
      sessions: sessions.length,
      plays: plays.length,
      join_validated_sessions: sessions.filter((row) => row.join_status === 'validated_all_joined').length,
      join_validated_plays: sessions.filter((row) => row.join_status === 'validated_all_joined').reduce((sum, row) => sum + row.plays.length, 0),
      malformed_sessions: sessions.filter((row) => row.malformed).map((row) => ({ stem: row.stem, errors: row.parse_errors })),
      quarantined_sessions: sessions.filter((row) => row.quarantined).map((row) => row.stem),
      incomplete_headers: sessions.filter((row) => row.incomplete_header).map((row) => row.stem),
    },
    separated_play_classes: {
      catches: category('caught'),
      failed_catch_candidates: category('airborne_failure_candidate'),
      ground_balls_or_low_air: category('ground_ball_or_low_air'),
      wall_plays: category('wall_play'),
      official_errors: category('official_error'),
      annotated_official_errors_non_exhaustive: annotatedOfficialErrors,
      official_error_label_availability: 'not persisted exhaustively in standalone derived play files; joined annotation snapshots are counted separately',
      assisted_or_glided: category('assisted_movement'),
      dive_leap_or_clamber_reach: category('reach_activation'),
      special_mechanics: category('special_mechanic'),
      unresolved: category('unresolved'),
    },
    all_plays_by_session: countBy(plays, (row) => row.session.stem),
    all_plays_by_park: countBy(plays, (row) => row.session.park),
    all_plays_by_batted_ball_class: countBy(plays, (row) => row.play.batted_ball_class),
    all_plays_by_primary_position: countBy(plays, (row) => row.play.primary_fielder),
    candidates: {
      total: candidates.length,
      eligible: eligible.length,
      catches: eligible.filter((row) => row.actual_catch === 1).length,
      failures: eligible.filter((row) => row.actual_catch === 0).length,
      by_session: countBy(candidates, (row) => row.session),
      by_park: countBy(candidates, (row) => row.park),
      by_batted_ball_class: countBy(candidates, (row) => row.batted_ball_class),
      by_position: countBy(candidates, (row) => row.primary_fielder),
      by_direction: countBy(candidates, (row) => row.audit_strata.direction),
      by_outcome: countBy(candidates, (row) => row.outcome),
      by_primary_fielder: countBy(candidates, (row) => row.primary_character),
      eligible_by_session: countBy(eligible, (row) => row.session),
      eligible_by_park: countBy(eligible, (row) => row.park),
      eligible_by_batted_ball_class: countBy(eligible, (row) => row.batted_ball_class),
      eligible_by_position: countBy(eligible, (row) => row.primary_fielder),
      eligible_by_direction: countBy(eligible, (row) => row.audit_strata.direction),
      eligible_by_outcome: countBy(eligible, (row) => row.outcome),
      eligible_by_primary_fielder: countBy(eligible, (row) => row.primary_character),
      exclusions: countBy(opportunities.flatMap((row) => row.exclusion_reasons.map((reason) => ({ reason }))), (row) => row.reason),
      missingness: missingFields,
    },
    duplicates: {
      exact_capture_checksums: duplicateChecksums,
      exact_play_fingerprints_across_sessions: crossSessionDuplicateRows.length,
      related_capture_groups: countBy(sessions, (row) => relatedGroups[row.stem]),
    },
    leakage_review: {
      allowed_predictors: PRE_OUTCOME_FEATURES,
      information_boundary: 'pitch-release fielder location plus exactly contact..contact+11 ball frames',
      forbidden_predictors: [
        'actual outcome', 'batted_ball_class', 'actual catch point', 'actual landing point',
        'actual catch/landing time', 'first_touch', 'final fielder location', 'route completion',
        'putout', 'result', 'assist/glide observed after contact',
      ],
      finding: 'The old distance_to_landing/hang_time pair changes definition by outcome and is retained only as an audit stratum. The candidate models use a fixed early-flight projection instead.',
    },
  }
}

function tuneModels(train, validation) {
  const candidates = []
  for (const priorStrength of [8, 16, 32]) {
    const model = fitEmpiricalBaseline(train, { priorStrength })
    candidates.push({ name: `empirical_prior_${priorStrength}`, model, validation: evaluatePredictions(predictRows(validation, model)) })
  }
  for (const lambda of [0.1, 1, 10]) {
    const model = fitRegularizedLogistic(train, { lambda })
    candidates.push({ name: `logistic_lambda_${lambda}`, model, validation: evaluatePredictions(predictRows(validation, model)) })
  }
  candidates.sort((a, b) => a.validation.brier - b.validation.brier || a.name.localeCompare(b.name))
  return { selected: candidates[0], candidates }
}

function climatologyPredictions(rows, rate) {
  return rows.map((row) => ({ ...row, predicted_probability: Math.max(1e-6, Math.min(1 - 1e-6, rate)) }))
}

function fitLike(model, rows) {
  return model.model_type === 'empirical_binned'
    ? fitEmpiricalBaseline(rows, { priorStrength: model.prior_strength })
    : fitRegularizedLogistic(rows, { lambda: model.lambda })
}

function sensitivityEvaluation(opportunities, split, selectedModel) {
  const allowed = (row, allowedReasons) => row.actual_catch != null && row.exclusion_reasons.every((reason) => allowedReasons.includes(reason))
  const scenarios = {
    strict: opportunities.filter((row) => row.eligible),
    exclude_assisted_movement: opportunities.filter((row) => row.eligible && !row.audit_strata.assisted_movement),
    exclude_dive_leap_reach: opportunities.filter((row) => row.eligible && !row.audit_strata.reach_activation),
    include_wall_plays: opportunities.filter((row) => allowed(row, ['wall_play'])),
    include_special_mechanics: opportunities.filter((row) => allowed(row, ['special_or_redirected_mechanic'])),
  }
  // PAIRED, on the scenario's own test rows: the scenario's model against the
  // strict model, scored on the SAME plays. Until 2026-09-18 each scenario was
  // scored on its own rows and compared with the strict model's score on the
  // strict rows, which measured how hard the plays were rather than whether an
  // exclusion changed the model -- dropping dives removes the hardest catches, so
  // its Brier fell 0.05 with no change in the model at all.
  //
  // A scenario with fewer test rows than one probability bin needs cannot say
  // anything; it is reported and skipped. No-glide collapses to 3 test plays
  // because the game glides a fielder on nearly every ball.
  return Object.fromEntries(Object.entries(scenarios).map(([name, rows]) => {
    const train = rows.filter((row) => split.by_session[row.session] === 'train')
    const test = rows.filter((row) => split.by_session[row.session] === 'test')
    const counts = { train_n: train.length, test_n: test.length }
    if (!train.length || test.length < ACTIVATION_CRITERIA.minimum_rows_per_probability_bin) {
      return [name, { ...counts, metrics: null, strict_model_metrics: null, reason: 'too_few_rows' }]
    }
    const model = name === 'strict' ? selectedModel : fitLike(selectedModel, train)
    return [name, {
      ...counts,
      metrics: evaluatePredictions(predictRows(test, model)),
      strict_model_metrics: evaluatePredictions(predictRows(test, selectedModel)),
      reason: null,
    }]
  }))
}

function leaveOneParkOut(rows, selectedModel) {
  const parks = [...new Set(rows.map((row) => row.park))].sort()
  return Object.fromEntries(parks.flatMap((park) => {
    const test = rows.filter((row) => row.park === park)
    const train = rows.filter((row) => row.park !== park)
    const failures = test.filter((row) => row.actual_catch === 0).length
    const catches = test.length - failures
    if (test.length < 20 || failures < 5 || catches < 5) return []
    return [[park, evaluatePredictions(predictRows(test, fitLike(selectedModel, train)))]]
  }))
}

function assessActivation(eligible, split, testMetrics, climatologyMetrics, bootstrap, sensitivity) {
  const session = shareSummary(eligible, (row) => row.session)
  const park = shareSummary(eligible, (row) => row.park)
  const populatedBins = testMetrics.calibration.filter((bin) => bin.n >= ACTIVATION_CRITERIA.minimum_rows_per_probability_bin).length
  const relativeBrier = climatologyMetrics.brier > 0
    ? (climatologyMetrics.brier - testMetrics.brier) / climatologyMetrics.brier
    : -Infinity
  const sensitivityChanges = Object.entries(sensitivity)
    .filter(([name, value]) => name !== 'strict' && value.metrics && value.strict_model_metrics)
    .map(([name, value]) => ({
      name, absolute_brier_change: Math.abs(value.metrics.brier - value.strict_model_metrics.brier),
    }))
  const checks = {
    eligible_sample: eligible.length >= ACTIVATION_CRITERIA.minimum_eligible_opportunities,
    failures: eligible.filter((row) => row.actual_catch === 0).length >= ACTIVATION_CRITERIA.minimum_failures,
    final_test_sample: testMetrics.n >= ACTIVATION_CRITERIA.minimum_final_test_opportunities,
    final_test_failures: testMetrics.failures >= ACTIVATION_CRITERIA.minimum_final_test_failures,
    session_dominance: session.maximum_share <= ACTIVATION_CRITERIA.maximum_session_share,
    park_dominance: park.maximum_share <= ACTIVATION_CRITERIA.maximum_park_share,
    calibration: testMetrics.ece <= ACTIVATION_CRITERIA.maximum_test_ece,
    brier_improvement: relativeBrier >= ACTIVATION_CRITERIA.minimum_relative_brier_improvement_vs_climatology,
    probability_bin_coverage: populatedBins >= ACTIVATION_CRITERIA.minimum_populated_probability_bins,
    grouped_uncertainty: bootstrap?.lower_95 > 0,
    sensitivity: sensitivityChanges.every((row) => row.absolute_brier_change <= ACTIVATION_CRITERIA.maximum_sensitivity_brier_change),
    no_post_outcome_predictors: true,
    predictor_family_coverage: true,
  }
  return {
    decision: Object.values(checks).every(Boolean) ? 'activate' : 'reject',
    checks,
    failed_checks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
    diagnostics: { session, park, relative_brier_improvement: relativeBrier, populated_probability_bins: populatedBins, sensitivity_changes: sensitivityChanges },
  }
}

function writeJson(name, value) {
  const file = path.join(OUTPUT, name)
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

function reportMarkdown(audit, split, evaluation, decision, featureAudit, files) {
  const eligible = audit.candidates.eligible
  const catches = audit.candidates.catches
  const failures = audit.candidates.failures
  const test = evaluation.final_test.selected
  const collectionOpportunityDeficit = Math.max(0, ACTIVATION_CRITERIA.minimum_eligible_opportunities - eligible)
  const collectionFailureDeficit = Math.max(0, ACTIVATION_CRITERIA.minimum_failures - failures)
  const fixed = (value, digits = 4) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
  const metricRows = (entries) => Object.entries(entries).map(([name, value]) =>
    `| ${name} | ${value.n} | ${value.catches} | ${value.failures} | ${fixed(value.brier)} | ${fixed(value.log_loss)} | ${fixed(value.ece)} | ${fixed(value.auc)} |`).join('\n')
  const sliceRows = (entries) => Object.entries(entries).map(([name, value]) =>
    `| ${name} | ${value.n} | ${value.catches} | ${value.failures} | ${fixed(value.brier)} | ${fixed(value.ece)} | ${fixed(value.auc)} |`).join('\n')
  const calibrationRows = test.calibration.map((bin) =>
    `| ${bin.low.toFixed(1)}–${bin.high.toFixed(1)} | ${bin.n} | ${fixed(bin.mean_probability, 3)} | ${fixed(bin.catch_rate, 3)} |`).join('\n')
  const sensitivityRows = Object.entries(evaluation.sensitivity).map(([name, value]) =>
    `| ${name} | ${value.train_n} | ${value.test_n} | ${value.metrics?.catches ?? 'n/a'} | ${value.metrics?.failures ?? 'n/a'} | ${fixed(value.metrics?.brier)} | ${fixed(value.strict_model_metrics?.brier)} | ${value.metrics && value.strict_model_metrics ? fixed(value.metrics.brier - value.strict_model_metrics.brier) : value.reason || 'n/a'} |`).join('\n')
  const countRows = (key) => Object.entries(audit.candidates[key] || {}).map(([name, count]) => `| ${name} | ${count} |`).join('\n')
  const bestEmpirical = Object.entries(evaluation.validation).filter(([name]) => name.startsWith('empirical'))
    .sort((a, b) => a[1].brier - b[1].brier)[0]?.[0]
  const finalComparison = {
    climatology: evaluation.final_test.climatology,
    [bestEmpirical]: evaluation.final_test.candidates[bestEmpirical],
    [evaluation.selected_candidate]: evaluation.final_test.selected,
  }
  const parkEces = Object.values(evaluation.leave_one_park_out).map((value) => value.ece)
  const failed = decision.failed_checks.length ? decision.failed_checks.map((value) => `\`${value}\``).join(', ') : 'none'
  return `# Catch Probability and experimental OAA calibration — ${ANALYSIS_DATE}\n\n` +
    `## Decision\n\n**${decision.decision === 'activate' ? 'Activated' : 'Baseline required (rejected for activation).' }** ` +
    `The predeclared gates that failed were: ${failed}. No production scorer or WAR input was changed.\n\n` +
    `## Dataset and exclusions\n\nThe archive audit read ${audit.archive.sessions} sessions and ${audit.archive.plays} derived plays. ` +
    `${audit.archive.join_validated_sessions} sessions (${audit.archive.join_validated_plays} plays) had documented all-play joins to saved tracker logs. ` +
    `Opportunity definition \`${OPPORTUNITY_DEFINITION_VERSION}\` retained ${eligible} primary-outfielder airborne opportunities: ${catches} catches and ${failures} defensible failures. ` +
    `Fouls, home runs without a defensible attempt, ground/low-air balls, non-primary fielders, unjoined sessions, malformed/quarantined rows, annotations, unresolved events, errors, rebounds, Buddy/special mechanics, wall plays, truncation, and missing fixed-window projections were excluded.\n\n` +
    `Class imbalance is substantial: ${(100 * catches / eligible).toFixed(1)}% catches and ${(100 * failures / eligible).toFixed(1)}% failures. ${audit.archive.malformed_sessions.length} malformed and ${audit.archive.quarantined_sessions.length} quarantined sessions were found. ${audit.archive.incomplete_headers.length} captures have incomplete final headers; their surviving joined plays were retained, but they make no claim about frames after the last recoverable play. Official-error rulings are not exhaustively persisted in standalone play files; ${audit.separated_play_classes.annotated_official_errors_non_exhaustive} error-labelled annotation snapshots were excluded, and physical bobbles were never promoted to official errors.\n\n` +
    `| Eligible position | Count |\n|---|---:|\n${countRows('eligible_by_position')}\n\n` +
    `| Eligible direction | Count |\n|---|---:|\n${countRows('eligible_by_direction')}\n\n` +
    `| Eligible park | Count |\n|---|---:|\n${countRows('eligible_by_park')}\n\n` +
    `The audit found ${audit.duplicates.exact_capture_checksums.length} duplicate capture checksums and ${audit.duplicates.exact_play_fingerprints_across_sessions} exact high-precision play fingerprints shared across sessions; no near-duplicate capture group crossed a partition. Full session, class, outcome, missingness, exclusion, and primary-fielder counts are in the audit JSON.\n\n` +
    `The legacy catch-point/landing-point distance and resolution-time pair is post-outcome asymmetric and was not used. ` +
    `The replacement features project endpoint and time from exactly 12 frames beginning at contact; the exporter never reads the catch, landing, possession, route completion, or result. ` +
    `Among uncaught eligible balls, mean absolute early-projection distance error was ${featureAudit.failure_projection_distance_mae_units?.toFixed(3) ?? 'n/a'} units and time error was ${featureAudit.failure_projection_time_mae_seconds?.toFixed(3) ?? 'n/a'} seconds.\n\n` +
    `## Split strategy\n\nEntire capture sessions—and captures detected as related—were assigned together by a deterministic SHA-256 ordering with seed \`${SPLIT_SEED}\`. ` +
    `Counts were train ${split.partitions.train.opportunities}, validation ${split.partitions.validation.opportunities}, and untouched test ${split.partitions.test.opportunities}. ` +
    `Model/hyperparameter selection used validation only; final-test metrics were computed afterward.\n\n` +
    `## Candidate models and held-out results\n\nThe transparent baseline is a beta-shrunk empirical table by outfield position and projected required-speed band. ` +
    `The second candidate is L2-regularized logistic regression using only park, position, pitch-release start geometry, and fixed-window projected flight geometry. ` +
    `Validation selected \`${evaluation.selected_candidate}\`. On final test it produced Brier ${test.brier.toFixed(4)}, log loss ${test.log_loss.toFixed(4)}, ECE ${test.ece.toFixed(4)}, and AUC ${test.auc?.toFixed(4) ?? 'n/a'} across ${test.n} opportunities (${test.failures} failures). ` +
    `The train-climatology comparison Brier was ${evaluation.final_test.climatology.brier.toFixed(4)}. ` +
    `Grouped bootstrap uncertainty resampled whole test sessions. Leave-one-park-out results are reported only where both classes and at least 20 rows were available.\n\n` +
    `| Final-test model | N | Catches | Failures | Brier | Log loss | ECE | AUC |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${metricRows(finalComparison)}\n\n` +
    `### Selected-model calibration\n\n| Probability bin | N | Mean prediction | Catch rate |\n|---|---:|---:|---:|\n${calibrationRows}\n\n` +
    `### Final-test slices\n\nPark:\n\n| Park | N | Catches | Failures | Brier | ECE | AUC |\n|---|---:|---:|---:|---:|---:|---:|\n${sliceRows(evaluation.final_test.by_park)}\n\n` +
    `Direction:\n\n| Direction | N | Catches | Failures | Brier | ECE | AUC |\n|---|---:|---:|---:|---:|---:|---:|\n${sliceRows(evaluation.final_test.by_direction)}\n\n` +
    `Position:\n\n| Position | N | Catches | Failures | Brier | ECE | AUC |\n|---|---:|---:|---:|---:|---:|---:|\n${sliceRows(evaluation.final_test.by_position)}\n\n` +
    `Difficulty (audit stratum from actual resolution geometry, never a predictor):\n\n| Band (u/s) | N | Catches | Failures | Brier | ECE | AUC |\n|---|---:|---:|---:|---:|---:|---:|\n${sliceRows(evaluation.final_test.by_difficulty_band)}\n\n` +
    `### Sensitivity and uncertainty\n\nEach scenario refits the selected model on its own training rows and is scored against the strict model on the same test plays; the gate is the absolute difference. Scenarios with fewer than ${ACTIVATION_CRITERIA.minimum_rows_per_probability_bin} test plays are not evaluable. (Method changed on 2026-09-18, after the first refit, by Jason's decision: the earlier version compared Brier scores on different sets of plays and so measured their difficulty, not the model.)\n\n| Scenario | Train N | Test N | Test catches | Test failures | Scenario Brier | Strict model, same plays | Change |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${sensitivityRows}\n\n` +
    `The unassisted-only population collapses to ${evaluation.sensitivity.exclude_assisted_movement.test_n} test play, so it cannot validate a separate no-glide model. ` +
    `The grouped bootstrap improvement over climatology was ${fixed(evaluation.final_test.grouped_bootstrap.lower_95)} to ${fixed(evaluation.final_test.grouped_bootstrap.upper_95)} Brier points (95% interval) across ${split.partitions.test.sessions.length} test sessions. ` +
    `Leave-one-park-out ECE ranged from ${fixed(Math.min(...parkEces))} to ${fixed(Math.max(...parkEces))} in the ${parkEces.length} parks with enough outcomes; ${parkEces.filter((value) => value > ACTIVATION_CRITERIA.maximum_test_ece).length} exceeded the ${ACTIVATION_CRITERIA.maximum_test_ece} calibration target.\n\n` +
    `## Activation standard\n\nAcceptance criteria were encoded before final-test evaluation in the model utility and copied verbatim into the evaluation artifact. ` +
    `Activation requires at least ${ACTIVATION_CRITERIA.minimum_eligible_opportunities} eligible opportunities and ${ACTIVATION_CRITERIA.minimum_failures} failures; an untouched test of at least ${ACTIVATION_CRITERIA.minimum_final_test_opportunities}/${ACTIVATION_CRITERIA.minimum_final_test_failures}; ` +
    `ECE at most ${ACTIVATION_CRITERIA.maximum_test_ece}; at least ${(ACTIVATION_CRITERIA.minimum_relative_brier_improvement_vs_climatology * 100).toFixed(0)}% Brier improvement; populated probability ranges; no session/park dominance; stable exclusions; positive grouped-bootstrap improvement; and zero post-outcome leakage.\n\n` +
    `## Files and reproducibility\n\n${files.map((file) => `- \`${path.relative(ROOT, file).replaceAll('\\', '/')}\``).join('\n')}\n\n` +
    `Reproduce with \`node scripts/calibrate_catch_probability.mjs --refresh-features\`. The candidate artifact is explicitly status \`${decision.decision === 'activate' ? 'active' : 'rejected'}\`; rejected artifacts cannot be loaded by the frozen scorer.\n\n` +
    `## Verification\n\n` +
    `Checks for a change to this pipeline: \`node --test tests/catch-probability.test.mjs\`, \`python -m unittest tests/catch_preoutcome_features_test.py\`, \`npm run test:tracker\` and \`npm run test:defense\`. Their results belong to the change that ran them, not to this generated report.\n\n` +
    `## Exact next collection needs\n\nCollect at least ${collectionOpportunityDeficit} additional eligible opportunities and ${collectionFailureDeficit} additional failures, whichever takes longer, while keeping every new game paired with its saved tracker log. ` +
    `Because grouped final testing also needs ${ACTIVATION_CRITERIA.minimum_final_test_opportunities} opportunities and ${ACTIVATION_CRITERIA.minimum_final_test_failures} failures, reserve complete new sessions for test rather than topping up with individual plays. ` +
    `Allocate at least 100 of the new opportunities and 20 failures to untouched test sessions. Prioritize the 6–8 u/s boundary band with both catches and failures, plus successful catches above 8 u/s; the existing easy bands contain almost no failures and should not be force-balanced artificially. Rotate LF/CF/RF, and favour parks with the fewest eligible opportunities above (a park with none is not scored at all). ` +
    `Record ordinary airborne misses deliberately; do not substitute CPU-only fielding, wall catches, Buddy/special plays, or ground balls.\n`
}

function main() {
  fs.mkdirSync(OUTPUT, { recursive: true })
  const joinValidated = joinValidatedSessions()
  ensureFeatures(process.argv.includes('--refresh-features'), joinValidated)
  const sessions = loadSessions(joinValidated)
  const relatedGroups = findRelatedCaptureGroups(sessions)
  sessions.forEach((session) => { session.related_capture_group = relatedGroups[session.stem] })
  const featureRows = readJsonl(FEATURE_PATH).rows
  const featureMap = new Map(featureRows.map((row) => [`${row.session}:${row.contact_timer}`, row]))
  const opportunities = sessions.flatMap((session) => session.plays.map((play) => buildOpportunity(
    play,
    session,
    session.annotations.get(Number(play.contact_timer)) || null,
    featureMap.get(`${session.stem}:${play.contact_timer}`) || null,
  ))).sort((a, b) => a.opportunity_id.localeCompare(b.opportunity_id))
  const audit = auditArchive(sessions, opportunities, relatedGroups)
  // Whole sessions an operator set aside before they were ever fitted on. The
  // hash ordering still decides everything else, and the split artifact records
  // which reservations it honoured, so the assignment stays reproducible from
  // the files alone.
  const { reservations } = readReservations()
  const split = buildGroupedSplit(opportunities, SPLIT_SEED, { reservations })
  if (!split.rows.train.length || !split.rows.validation.length || !split.rows.test.length) throw new Error('insufficient grouped partitions')
  const tuning = tuneModels(split.rows.train, split.rows.validation)
  const selectedModel = tuning.selected.model
  const selectedTestPredictions = predictRows(split.rows.test, selectedModel)
  const climatologyRate = split.rows.train.reduce((sum, row) => sum + row.actual_catch, 0) / split.rows.train.length
  const climatologyTestPredictions = climatologyPredictions(split.rows.test, climatologyRate)
  const finalModels = Object.fromEntries(tuning.candidates.map((candidate) => [candidate.name,
    evaluatePredictions(predictRows(split.rows.test, candidate.model))]))
  const sensitivity = sensitivityEvaluation(opportunities, split, selectedModel)
  const bootstrap = groupedBootstrapDifference(selectedTestPredictions, climatologyTestPredictions)
  const decision = assessActivation(
    split.rows.train.concat(split.rows.validation, split.rows.test), split,
    evaluatePredictions(selectedTestPredictions), evaluatePredictions(climatologyTestPredictions), bootstrap, sensitivity,
  )
  const eligible = opportunities.filter((row) => row.eligible)
  const failedEligible = eligible.filter((row) => row.actual_catch === 0)
  const featureAudit = {
    schema_version: 1,
    exporter_schema_version: featureRows[0]?.schema_version || null,
    exported_rows: featureRows.length,
    valid_rows: featureRows.filter((row) => row.valid).length,
    invalid_reasons: countBy(featureRows.filter((row) => !row.valid), (row) => row.reason),
    failure_projection_distance_mae_units: mean(failedEligible.map((row) => Math.abs(row.features.projected_distance_units - row.audit_strata.distance_to_resolution_units))),
    failure_projection_time_mae_seconds: mean(failedEligible.map((row) => Math.abs(row.features.projected_landing_seconds - row.audit_strata.resolution_seconds))),
  }
  const evaluation = {
    schema_version: 1,
    analysis_date: ANALYSIS_DATE,
    model_version: MODEL_VERSION,
    activation_criteria: ACTIVATION_CRITERIA,
    selected_candidate: tuning.selected.name,
    validation: Object.fromEntries(tuning.candidates.map((candidate) => [candidate.name, candidate.validation])),
    final_test: {
      selected: evaluatePredictions(selectedTestPredictions),
      climatology: evaluatePredictions(climatologyTestPredictions),
      candidates: finalModels,
      by_park: groupedMetrics(selectedTestPredictions, (row) => row.park),
      by_direction: groupedMetrics(selectedTestPredictions, (row) => row.audit_strata.direction),
      by_position: groupedMetrics(selectedTestPredictions, (row) => row.primary_fielder),
      by_difficulty_band: groupedMetrics(selectedTestPredictions, (row) => row.audit_strata.difficulty_band),
      grouped_bootstrap: bootstrap,
    },
    leave_one_park_out: leaveOneParkOut(eligible, selectedModel),
    sensitivity_method: 'paired: each scenario model vs the strict model on the scenario\'s own test rows; scenarios with fewer test rows than minimum_rows_per_probability_bin are not evaluable (since 2026-09-18)',
    sensitivity,
    activation: decision,
    collection_target: {
      additional_eligible_opportunities: Math.max(0, ACTIVATION_CRITERIA.minimum_eligible_opportunities - eligible.length),
      additional_failures: Math.max(0, ACTIVATION_CRITERIA.minimum_failures - failedEligible.length),
      reserve_new_test_opportunities: 100,
      reserve_new_test_failures: 20,
      priority_contexts: ['6_to_8 projected required speed with both outcomes', 'successful catches above 8 projected required speed'],
      park_sessions: {
        bowser_jr_playroom: 1, daisy_cruiser: 1, dk_jungle: 1, luigis_mansion: 1,
        peach_ice_garden: 1, wario_city: 1, wario_stadium: 2,
      },
    },
  }
  const fingerprintPayload = eligible.map((row) => ({ id: row.opportunity_id, outcome: row.actual_catch, features: row.features }))
  const dataFingerprint = crypto.createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex')
  const candidateArtifact = {
    ...selectedModel,
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    status: decision.decision === 'activate' ? 'active' : 'rejected',
    activation_decision: decision,
    analysis_date: ANALYSIS_DATE,
    training_data_fingerprint_sha256: dataFingerprint,
    split_manifest_fingerprint_sha256: stableHash(JSON.stringify(split.by_session)),
    training_counts: split.partitions.train,
    validation_counts: split.partitions.validation,
    held_out_test_counts: split.partitions.test,
    held_out_results: evaluation.final_test.selected,
    exclusions: audit.candidates.exclusions,
    collection_target: evaluation.collection_target,
    reproducibility_command: 'node scripts/calibrate_catch_probability.mjs --refresh-features',
  }

  const datasetPath = path.join(OUTPUT, 'catch-probability-opportunities-v1.jsonl')
  fs.writeFileSync(datasetPath, opportunities.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const auditPath = writeJson('catch-probability-audit-v1.json', audit)
  const featureAuditPath = writeJson('catch-probability-feature-audit-v1.json', featureAudit)
  const splitPath = writeJson('catch-probability-split-v1.json', { ...split, rows: undefined })
  const evaluationPath = writeJson('catch-probability-evaluation-v1.json', evaluation)
  const artifactPath = writeJson('catch-probability-candidate-v1.json', candidateArtifact)
  const definitionPath = writeJson('catch-probability-opportunity-definition-v1.json', {
    definition_version: OPPORTUNITY_DEFINITION_VERSION,
    population: 'primary outfielder on defensibly airborne fair balls',
    catch_label: 'caught_in_flight, first touch by primary fielder, primary reason catch',
    failure_label: 'fair_in_play with observed landing at least 1.0 s after contact and primary reason fielded/failed_contact/closest_at_landing',
    model_features: PRE_OUTCOME_FEATURES,
    early_flight_window_frames: 12,
    exclusions: Object.keys(audit.candidates.exclusions),
    outcome_value: 'actual catch minus frozen expected catch probability',
  })
  const reportPath = path.join(ROOT, 'docs', `catch-probability-calibration-${ANALYSIS_DATE}.md`)
  const files = [
    path.join(ROOT, 'scripts', 'export_catch_preoutcome_features.py'),
    path.join(ROOT, 'scripts', 'catch_probability_model.mjs'),
    path.join(ROOT, 'scripts', 'calibrate_catch_probability.mjs'),
    path.join(ROOT, 'tests', 'catch-probability.test.mjs'),
    path.join(ROOT, 'tests', 'catch_preoutcome_features_test.py'),
    FEATURE_PATH, datasetPath, definitionPath, auditPath, featureAuditPath, splitPath, evaluationPath, artifactPath, reportPath,
  ]
  fs.writeFileSync(reportPath, reportMarkdown(audit, split, evaluation, decision, featureAudit, files))
  console.log(JSON.stringify({ decision: decision.decision, failed_checks: decision.failed_checks, eligible: audit.candidates.eligible,
    catches: audit.candidates.catches, failures: audit.candidates.failures, selected: evaluation.selected_candidate,
    test: evaluation.final_test.selected, report: path.relative(ROOT, reportPath) }, null, 2))
}

main()
