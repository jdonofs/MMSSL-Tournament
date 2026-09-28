// Fit the CPU's send/hold policy on extra-base chances from the local archive.
//
//   node scripts/calibrate_runner_decisions.mjs
//
// WHY THE ARCHIVE. Production holds a handful of runner opportunities; the
// local test games hold hundreds. Every game whose saved tracker log replays
// with every play joined (scripts/audit_tracking_archive.mjs) is replayed
// through the real preview state, which rebuilds each plate appearance -- outs,
// bases and runner destinations -- exactly as the bridge would have written it.
// Research games (header `calibration_excluded`) are skipped.
//
// WHAT IS FITTED. Baserunning is decided by the CPU, not the player, so this is
// the game's own policy: P(send) from where the runner and the ball were when a
// fielder first had it, the runner's speed and the fielder's arm (both fixed
// character attributes), the outs and the kind of chance. Whether an attempt is
// SAFE is not modelled -- one runner was thrown out in the first thirty games.
//
// THE GATE, fixed before the first fit: leave-one-game-out, the model must beat
// the context average the site already uses (same folds), with the 95% lower
// bound of a game-level bootstrap of that improvement above zero, on at least
// 200 chances and 50 sends. Otherwise the artifact is written as 'rejected' and
// the recompute keeps the context average.
//
// Reads Supabase once for the characters table's attributes and writes only
// data/calibration/runner-decision-model-v1.json.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { auditArchive } from './audit_tracking_archive.mjs'
import {
  applyTrackerPreviewMessage,
  applyTrackerPreviewPlay,
  createTrackerPreviewState,
  trackerPreviewOutcomePlay,
  trackerPreviewSnapshot,
} from './tracker_preview_state.mjs'
import { auc, evaluatePredictions, groupedBootstrapDifference } from './catch_probability_model.mjs'
import { createAdvancedMetricsClient } from './recompute_advanced_metrics.mjs'
import {
  EXTRA_BASE_DECISION_FEATURES,
  buildExtraBaseOpportunitiesFromPa,
  extraBaseContext,
  extraBaseDecisionVector,
  extraBaseFeatures,
} from '../src/utils/advancedDefense.js'
import { characterNameKey, indexByCharacterName } from '../src/utils/characterNames.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCHIVE = path.join(ROOT, 'data', 'player_tracking')
const LOG_DIR = path.join(ROOT, 'sluggers-stat-tracker-advanced-stats-dev', 'preview-sessions')
const OUTPUT = path.join(ROOT, 'data', 'calibration', 'runner-decision-model-v1.json')

export const MODEL_VERSION = 'runner-decision-v1'
export const ACTIVATION = Object.freeze({
  minimum_chances: 200,
  minimum_sends: 50,
  must_beat: 'context average, leave-one-game-out',
  bootstrap_lower_95_above: 0,
})
const LAMBDA = 1
const LOG_LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.*)$/

function replaySession(stem, logPath) {
  const state = createTrackerPreviewState({ mode: 'archive_audit', writesEnabled: false })
  for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('[tracker-preview]') || trimmed.startsWith('[tracker-bridge]')) continue
    const match = trimmed.match(LOG_LINE_RE)
    const message = match ? match[3] : trimmed
    if (message.startsWith('[TRACKER_BALL_SAMPLE] ')) continue
    applyTrackerPreviewMessage(state, message)
  }
  for (const line of fs.readFileSync(path.join(ARCHIVE, `${stem}.plays.jsonl`), 'utf8').split('\n')) {
    if (line.trim()) applyTrackerPreviewPlay(state, JSON.parse(line))
  }
  trackerPreviewSnapshot(state)
  return state
}

function chancesForSession(stem, logPath, characterByName) {
  const byName = (name) => characterByName.get(characterNameKey(name, { collapseMii: true })) || null
  const state = replaySession(stem, logPath)
  const rows = []
  for (const buffer of state.completedBuffers) {
    const pa = trackerPreviewSnapshot(state, { selectedPaNumber: buffer.localPaNumber }).display_at_bat
    if (!pa?.runner_assignments?.length) continue
    const play = trackerPreviewOutcomePlay(state, pa.pa_number)
    const context = extraBaseContext(play || {})
    if (!context) continue
    // The replay names runners the tracker's way; the opportunity builder
    // wants a character id, and the attributes are keyed the site's way.
    const assignments = pa.runner_assignments.map((row) => ({
      ...row, runner: { ...(row.runner || {}), characterId: byName(row.runner?.characterName)?.id ?? null },
    }))
    const fielder = byName(context.touch.character)
    const opportunities = buildExtraBaseOpportunitiesFromPa({ ...pa, runner_assignments: assignments }, {
      outsBefore: pa.outs_before_pa,
      responsibleFielder: fielder ? { characterId: fielder.id, position: context.touch.by } : null,
    })
    for (const row of opportunities) {
      const runner = assignments.find((entry) => entry.id === row.runner_id)
      const features = extraBaseFeatures(row, context, {
        runnerSpeed: byName(runner?.runner?.characterName)?.run_speed,
        fielderArm: fielder?.throwing_speed,
      })
      if (!features) continue
      rows.push({ session: stem, pa_number: pa.pa_number, ...row, features })
    }
  }
  return rows
}

function standardize(rows) {
  return Object.fromEntries(EXTRA_BASE_DECISION_FEATURES.map((name) => {
    const values = rows.map((row) => row.features[name])
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    return [name, { mean, scale: Math.sqrt(variance) || 1 }]
  }))
}

function sigmoid(value) {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value))
}

export function fitDecisionModel(rows, { lambda = LAMBDA, iterations = 4000, learningRate = 0.15 } = {}) {
  const model = {
    model_version: MODEL_VERSION,
    status: 'candidate',
    features: [...EXTRA_BASE_DECISION_FEATURES],
    standardization: standardize(rows),
    opportunity_types: [...new Set(rows.map((row) => row.opportunity_type))].sort(),
    lambda,
  }
  const vectors = rows.map((row) => extraBaseDecisionVector(model, row, row.features))
  const labels = rows.map((row) => (row.attempted ? 1 : 0))
  const coefficients = Array(vectors[0].length).fill(0)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = Array(coefficients.length).fill(0)
    vectors.forEach((vector, index) => {
      const error = sigmoid(vector.reduce((sum, value, j) => sum + value * coefficients[j], 0)) - labels[index]
      for (let j = 0; j < gradient.length; j += 1) gradient[j] += error * vector[j]
    })
    for (let j = 1; j < gradient.length; j += 1) gradient[j] += lambda * coefficients[j]
    const step = learningRate / Math.sqrt(1 + iteration / 200)
    for (let j = 0; j < gradient.length; j += 1) coefficients[j] -= step * gradient[j] / rows.length
  }
  return { ...model, coefficients }
}

function predict(model, row) {
  // Types a fold never saw score at the baseline type, so a rare chance in
  // the held-out game still gets a probability.
  const vector = extraBaseDecisionVector(model, row, row.features)
  return sigmoid(vector.reduce((sum, value, index) => sum + value * model.coefficients[index], 0))
}

// The site's current expectation: attempts in the same kind of chance, outs and
// bases, shrunk toward the overall rate (advancedDefense.js modelRunnerOpportunities).
function contextAverage(train) {
  const overall = train.filter((row) => row.attempted).length / Math.max(1, train.length)
  const buckets = new Map()
  for (const row of train) {
    const key = [row.opportunity_type, row.outs_before, row.origin_base, row.target_base].join('|')
    const entry = buckets.get(key) || { n: 0, attempts: 0 }
    entry.n += 1
    if (row.attempted) entry.attempts += 1
    buckets.set(key, entry)
  }
  return (row) => {
    const entry = buckets.get([row.opportunity_type, row.outs_before, row.origin_base, row.target_base].join('|'))
      || { n: 0, attempts: 0 }
    return (entry.attempts + overall * 12) / (entry.n + 12)
  }
}

function clampProbability(value) {
  return Math.max(1e-6, Math.min(1 - 1e-6, value))
}

function outOfFold(rows) {
  const sessions = [...new Set(rows.map((row) => row.session))].sort()
  const model = []
  const baseline = []
  for (const session of sessions) {
    const train = rows.filter((row) => row.session !== session)
    const test = rows.filter((row) => row.session === session)
    if (!train.some((row) => row.attempted) || !train.some((row) => !row.attempted)) continue
    const fitted = fitDecisionModel(train)
    const average = contextAverage(train)
    for (const row of test) {
      const base = { session, actual_catch: row.attempted ? 1 : 0 }
      // evaluatePredictions and the bootstrap were written for catches; a
      // send is the event here.
      model.push({ ...base, predicted_probability: clampProbability(predict(fitted, row)) })
      baseline.push({ ...base, predicted_probability: clampProbability(average(row)) })
    }
  }
  return { model, baseline }
}

async function main() {
  const supabase = await createAdvancedMetricsClient()
  const { data: characters, error } = await supabase.from('characters').select('id,name,run_speed,throwing_speed')
  if (error) throw error
  const characterByName = indexByCharacterName(characters, (row) => row.name, { collapseMii: true })

  const audit = auditArchive({ trackingDir: ARCHIVE, logDir: LOG_DIR, join: true })
  const sessions = audit.sessions.filter((row) => {
    if (!row.join || row.join.error || !row.join.plays || row.join.joined !== row.join.plays || row.join.warnings) return false
    const header = JSON.parse(fs.readFileSync(path.join(ARCHIVE, `${row.stem}.json`), 'utf8'))
    return header.calibration_excluded !== true
  })
  const rows = sessions.flatMap((row) => chancesForSession(row.stem, path.join(LOG_DIR, row.paired_log), characterByName))
  const discretionary = rows.filter((row) => ['hold', 'advance_safe', 'advance_out'].includes(row.outcome))
  const sends = discretionary.filter((row) => row.attempted)
  const { model: oofModel, baseline: oofBaseline } = outOfFold(discretionary)
  const modelMetrics = evaluatePredictions(oofModel)
  const baselineMetrics = evaluatePredictions(oofBaseline)
  const bootstrap = groupedBootstrapDifference(oofModel, oofBaseline)
  const checks = {
    minimum_chances: discretionary.length >= ACTIVATION.minimum_chances,
    minimum_sends: sends.length >= ACTIVATION.minimum_sends,
    beats_context_average: modelMetrics.brier < baselineMetrics.brier,
    bootstrap_lower_95: bootstrap?.lower_95 > ACTIVATION.bootstrap_lower_95_above,
  }
  const final = fitDecisionModel(discretionary)
  const artifact = {
    ...final,
    status: Object.values(checks).every(Boolean) ? 'active' : 'rejected',
    fitted_at: new Date().toISOString(),
    activation: { criteria: ACTIVATION, checks, failed: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) },
    sample: {
      games: new Set(discretionary.map((row) => row.session)).size,
      chances: discretionary.length,
      sends: sends.length,
      thrown_out: discretionary.filter((row) => row.outcome === 'advance_out').length,
      by_type: Object.fromEntries(final.opportunity_types.map((type) => {
        const typed = discretionary.filter((row) => row.opportunity_type === type)
        return [type, { chances: typed.length, sends: typed.filter((row) => row.attempted).length }]
      })),
    },
    out_of_fold: {
      scheme: 'leave-one-game-out',
      model: { brier: modelMetrics.brier, log_loss: modelMetrics.log_loss, ece: modelMetrics.ece, auc: auc(oofModel) },
      context_average: { brier: baselineMetrics.brier, log_loss: baselineMetrics.log_loss, ece: baselineMetrics.ece, auc: auc(oofBaseline) },
      bootstrap_brier_improvement: bootstrap,
    },
    sessions: [...new Set(discretionary.map((row) => row.session))].sort(),
  }
  fs.writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(JSON.stringify({
    status: artifact.status, failed: artifact.activation.failed, sample: artifact.sample,
    out_of_fold: artifact.out_of_fold,
    coefficients: Object.fromEntries(['intercept', ...final.features, 'outs_1', 'outs_2',
      ...final.opportunity_types.slice(1).map((type) => `type_${type}`)]
      .map((name, index) => [name, Number(final.coefficients[index].toFixed(3))])),
    artifact: path.relative(ROOT, OUTPUT),
  }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}
