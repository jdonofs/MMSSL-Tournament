// How far the Catch Probability / OAA model is from its own activation gates.
//
//   node scripts/catch_probability_gate_status.mjs
//   node scripts/catch_probability_gate_status.mjs --json
//
// WHY THIS EXISTS. The decision in docs/catch-probability-calibration-2026-09-05.md
// is "Baseline required (rejected for activation)", and seven predeclared gates
// failed. Everything needed to say HOW FAR from each one is inside the
// artifacts already, but the only way to see it was to re-run the whole
// calibration -- which refits models, rewrites nine files and takes minutes --
// or to read a 84 KB JSON by hand. So the question "are we there yet, and what
// exactly is still missing" had no cheap answer, and the answer is the thing
// that decides whether the next recorded game is worth playing.
//
// WHAT IT WILL NOT DO. It reads. It does not refit, does not re-split, does not
// touch a candidate artifact, and cannot change a threshold: ACTIVATION_CRITERIA
// is imported from the frozen object in scripts/catch_probability_model.mjs and
// every number below is compared against that. A gate that fails is reported as
// failing. There is no flag here that makes one pass.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { ACTIVATION_CRITERIA } from './catch_probability_model.mjs'
import { readReservations } from './reserve_calibration_session.mjs'
import { auditArchive } from './audit_tracking_archive.mjs'

const CALIBRATION_DIR = path.resolve('data/calibration')
const EVALUATION = path.join(CALIBRATION_DIR, 'catch-probability-evaluation-v1.json')
const SPLIT = path.join(CALIBRATION_DIR, 'catch-probability-split-v1.json')
const CANDIDATE = path.join(CALIBRATION_DIR, 'catch-probability-candidate-v1.json')
const OPPORTUNITIES = path.join(CALIBRATION_DIR, 'catch-probability-opportunities-v1.jsonl')

function readJson(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null
}

/** Eligible opportunities, by session, without holding the whole file. */
function readOpportunitySessions(filePath = OPPORTUNITIES) {
  const bySession = new Map()
  if (!fs.existsSync(filePath)) return bySession
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    if (!row.eligible) continue
    const entry = bySession.get(row.session) || { opportunities: 0, failures: 0 }
    entry.opportunities += 1
    if (row.actual_catch === 0) entry.failures += 1
    bySession.set(row.session, entry)
  }
  return bySession
}

function bar(fraction, width = 20) {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`
}

/**
 * Each gate as: what it requires, what the last evaluation measured, and the
 * distance between them.
 *
 * `direction` says which way is better, because "0.1062 against 0.08" reads as
 * progress or as a miss depending on whether more is good.
 */
export function gateProgress(evaluation, split = null) {
  if (!evaluation) return []
  // The strict scenario IS the headline evaluation; the others are the
  // sensitivity scenarios reported beside it.
  const test = evaluation.sensitivity?.strict?.metrics
    || evaluation.final_test?.strict?.metrics
    || evaluation.final_test
    || {}
  const bootstrap = evaluation.final_test?.grouped_bootstrap
    || evaluation.final_test?.strict?.grouped_bootstrap
    || null
  const checks = evaluation.activation?.checks || {}
  const diagnostics = evaluation.activation?.diagnostics || {}
  // The eligible sample is the sum of the per-session counts the activation
  // diagnostics already carry, which is also how the report in
  // docs/catch-probability-calibration-2026-09-05.md arrived at 286.
  const eligibleTotal = Object.values(diagnostics.session?.counts || {})
    .reduce((sum, value) => sum + value, 0) || null
  const eligibleFailures = split
    ? ['train', 'validation', 'test'].reduce(
      (sum, name) => sum + (Number(split.partitions?.[name]?.failures) || 0), 0)
    : null

  return [
    {
      gate: 'eligible_sample',
      requires: `${ACTIVATION_CRITERIA.minimum_eligible_opportunities} eligible opportunities`,
      measured: eligibleTotal,
      target: ACTIVATION_CRITERIA.minimum_eligible_opportunities,
      direction: 'at_least',
      passed: checks.eligible_sample === true,
    },
    {
      gate: 'failures',
      requires: `${ACTIVATION_CRITERIA.minimum_failures} defensible failures`,
      measured: eligibleFailures,
      target: ACTIVATION_CRITERIA.minimum_failures,
      direction: 'at_least',
      passed: checks.failures === true,
    },
    {
      gate: 'final_test_sample',
      requires: `${ACTIVATION_CRITERIA.minimum_final_test_opportunities} untouched test opportunities`,
      measured: test.n ?? null,
      target: ACTIVATION_CRITERIA.minimum_final_test_opportunities,
      direction: 'at_least',
      passed: checks.final_test_sample === true,
    },
    {
      gate: 'final_test_failures',
      requires: `${ACTIVATION_CRITERIA.minimum_final_test_failures} untouched test failures`,
      measured: test.failures ?? null,
      target: ACTIVATION_CRITERIA.minimum_final_test_failures,
      direction: 'at_least',
      passed: checks.final_test_failures === true,
    },
    {
      gate: 'calibration',
      requires: `test ECE at most ${ACTIVATION_CRITERIA.maximum_test_ece}`,
      measured: test.ece ?? null,
      target: ACTIVATION_CRITERIA.maximum_test_ece,
      direction: 'at_most',
      passed: checks.calibration === true,
    },
    {
      gate: 'probability_bin_coverage',
      requires: `${ACTIVATION_CRITERIA.minimum_populated_probability_bins} probability bins with `
        + `${ACTIVATION_CRITERIA.minimum_rows_per_probability_bin}+ rows`,
      measured: (test.calibration || [])
        .filter((bin) => bin.n >= ACTIVATION_CRITERIA.minimum_rows_per_probability_bin).length,
      target: ACTIVATION_CRITERIA.minimum_populated_probability_bins,
      direction: 'at_least',
      passed: checks.probability_bin_coverage === true,
    },
    {
      gate: 'sensitivity',
      requires: `no exclusion scenario moves Brier by more than `
        + `${ACTIVATION_CRITERIA.maximum_sensitivity_brier_change}`,
      measured: Math.max(0, ...(diagnostics.sensitivity_changes || [])
        .map((row) => Number(row.absolute_brier_change) || 0)),
      target: ACTIVATION_CRITERIA.maximum_sensitivity_brier_change,
      direction: 'at_most',
      passed: checks.sensitivity === true,
    },
    {
      gate: 'brier_improvement',
      requires: `${(ACTIVATION_CRITERIA.minimum_relative_brier_improvement_vs_climatology * 100).toFixed(0)}% `
        + 'Brier improvement over climatology',
      measured: diagnostics.relative_brier_improvement ?? null,
      target: ACTIVATION_CRITERIA.minimum_relative_brier_improvement_vs_climatology,
      direction: 'at_least',
      passed: checks.brier_improvement === true,
    },
    {
      gate: 'session_dominance',
      requires: `no session over ${(ACTIVATION_CRITERIA.maximum_session_share * 100).toFixed(0)}% of the sample`,
      measured: diagnostics.session?.maximum_share ?? null,
      target: ACTIVATION_CRITERIA.maximum_session_share,
      direction: 'at_most',
      passed: checks.session_dominance === true,
    },
    {
      gate: 'park_dominance',
      requires: `no park over ${(ACTIVATION_CRITERIA.maximum_park_share * 100).toFixed(0)}% of the sample`,
      measured: diagnostics.park?.maximum_share ?? null,
      target: ACTIVATION_CRITERIA.maximum_park_share,
      direction: 'at_most',
      passed: checks.park_dominance === true,
    },
    {
      gate: 'grouped_uncertainty',
      requires: 'grouped bootstrap improvement strictly above zero',
      measured: bootstrap?.lower_95 ?? null,
      target: 0,
      direction: 'at_least',
      passed: checks.grouped_uncertainty === true,
    },
    {
      gate: 'no_post_outcome_predictors',
      requires: 'every predictor knowable before the outcome',
      measured: checks.no_post_outcome_predictors === true ? 'clean' : 'leakage found',
      target: 'clean',
      direction: 'exact',
      passed: checks.no_post_outcome_predictors === true,
    },
    {
      gate: 'predictor_family_coverage',
      requires: ACTIVATION_CRITERIA.required_predictor_families.join(', '),
      measured: checks.predictor_family_coverage === true ? 'covered' : 'incomplete',
      target: 'covered',
      direction: 'exact',
      passed: checks.predictor_family_coverage === true,
    },
  ]
}

export function gateStatus({ archive = true } = {}) {
  const evaluation = readJson(EVALUATION)
  const split = readJson(SPLIT)
  const candidate = readJson(CANDIDATE)
  const opportunitySessions = readOpportunitySessions()
  const gates = gateProgress(evaluation, split)
  const reservations = readReservations().reservations

  // Sessions on disk that the last calibration never counted. These are the
  // cheapest possible progress: they have already been played.
  let uncounted = []
  if (archive) {
    const audit = auditArchive({ join: false })
    uncounted = audit.sessions
      .filter((row) => !opportunitySessions.has(row.stem))
      .map((row) => ({
        stem: row.stem,
        park: row.park,
        derived_plays: row.derived_plays,
        paired_log: row.paired_log,
        usable: Boolean(row.paired_log && row.derived_plays),
        blockers: row.problems,
      }))
  }

  const reservedTest = reservations.filter((entry) => entry.partition === 'test')
  return {
    generatedAt: new Date().toISOString(),
    analysisDate: evaluation?.analysis_date || null,
    decision: candidate?.status || evaluation?.activation?.decision || 'unknown',
    modelVersion: evaluation?.model_version || null,
    gates,
    failing: gates.filter((gate) => !gate.passed).map((gate) => gate.gate),
    collectionTarget: evaluation?.collection_target || null,
    split: split
      ? {
        seed: split.seed,
        partitions: Object.fromEntries(Object.entries(split.partitions || {}).map(([name, part]) => [
          name, { opportunities: part.opportunities, failures: part.failures, sessions: part.sessions.length },
        ])),
        honouredReservations: split.reservations || [],
      }
      : null,
    reservedForTest: reservedTest.map((entry) => entry.session),
    uncountedSessions: uncounted,
  }
}

function formatMeasured(gate) {
  if (gate.measured == null) return 'not measured'
  if (typeof gate.measured === 'number') {
    return Number.isInteger(gate.measured) ? String(gate.measured) : gate.measured.toFixed(4)
  }
  return String(gate.measured)
}

function shortfall(gate) {
  if (gate.passed || typeof gate.measured !== 'number' || typeof gate.target !== 'number') return ''
  if (gate.direction === 'at_least') return `  ${(gate.target - gate.measured).toFixed(
    Number.isInteger(gate.target) ? 0 : 4)} short`
  if (gate.direction === 'at_most') return `  ${(gate.measured - gate.target).toFixed(4)} over`
  return ''
}

function report(status) {
  console.log(`Catch Probability / OAA activation gates — decision: ${status.decision.toUpperCase()}`)
  console.log(`Last evaluation: ${status.analysisDate || 'unknown'}  (${status.modelVersion || 'no model version'})`)
  console.log()
  for (const gate of status.gates) {
    const fraction = typeof gate.measured === 'number' && typeof gate.target === 'number' && gate.target
      ? (gate.direction === 'at_most'
        ? Math.min(1, gate.target / Math.max(gate.measured, 1e-9))
        : gate.measured / gate.target)
      : (gate.passed ? 1 : 0)
    console.log(`  ${gate.passed ? 'ok' : 'X '} ${gate.gate.padEnd(26)} ${bar(fraction)} `
      + `${formatMeasured(gate).padStart(9)} / ${String(gate.target).padEnd(8)}${shortfall(gate)}`)
    if (!gate.passed) console.log(`        needs: ${gate.requires}`)
  }
  console.log()
  console.log(`${status.failing.length} gate(s) failing. The candidate stays rejected and the frozen `)
  console.log('scorer will not load it; nothing here can change that.')

  if (status.split) {
    console.log()
    console.log('Current split:')
    for (const [name, part] of Object.entries(status.split.partitions)) {
      console.log(`  ${name.padEnd(11)} ${String(part.opportunities).padStart(4)} opportunities, `
        + `${String(part.failures).padStart(3)} failures, ${part.sessions} sessions`)
    }
    if (status.split.honouredReservations.length) {
      console.log(`  honouring ${status.split.honouredReservations.length} operator reservation(s)`)
    }
  }

  if (status.collectionTarget) {
    const target = status.collectionTarget
    console.log()
    console.log('What the last evaluation said is still needed:')
    console.log(`  ${target.additional_eligible_opportunities} more eligible opportunities and `
      + `${target.additional_failures} more failures`)
    console.log(`  of which at least ${target.reserve_new_test_opportunities} opportunities and `
      + `${target.reserve_new_test_failures} failures must be in RESERVED test sessions`)
    for (const context of target.priority_contexts || []) console.log(`  priority: ${context}`)
    const parks = Object.entries(target.park_sessions || {})
    if (parks.length) {
      console.log(`  park sessions wanted: ${parks.map(([park, n]) => `${park} x${n}`).join(', ')}`)
    }
  }

  console.log()
  if (status.reservedForTest.length) {
    console.log(`Reserved for the untouched test: ${status.reservedForTest.join(', ')}`)
  } else {
    console.log('No sessions are reserved for the untouched test. The final-test gates need whole')
    console.log('sessions held out before they are fitted on — see')
    console.log('  node scripts/reserve_calibration_session.mjs --help')
  }

  const usable = status.uncountedSessions.filter((row) => row.usable)
  if (status.uncountedSessions.length) {
    console.log()
    console.log(`${status.uncountedSessions.length} recorded session(s) are not in the current `
      + `opportunity set; ${usable.length} of them are ready to be counted:`)
    for (const row of status.uncountedSessions) {
      console.log(`  ${row.usable ? 'ready ' : 'BLOCKED'} ${row.stem.padEnd(40)} `
        + `${row.derived_plays ?? 0} plays`)
      for (const blocker of row.blockers) console.log(`          - ${blocker}`)
    }
    if (usable.length) {
      console.log()
      console.log('Re-run `node scripts/calibrate_catch_probability.mjs --refresh-features` to fold')
      console.log('them in. That recomputes the gates; it does not activate anything.')
    }
  }
}

function main() {
  const json = process.argv.includes('--json')
  const status = gateStatus({ archive: !process.argv.includes('--no-archive') })
  if (json) console.log(JSON.stringify(status, null, 2))
  else report(status)
  return status.failing.length ? 1 : 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main()
}
