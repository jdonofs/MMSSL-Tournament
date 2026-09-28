// Refit every Sluggers-native opportunity model and persist versioned outputs.
// Safe to rerun: source opportunity rows stay unchanged and only modeled
// probability/run-value columns are updated.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import { fetchSupersededTrackingPlayIds, onlyActiveTrackingFacts, onlyActiveTrackingPlays } from '../src/utils/activeTrackingVersions.js'
import {
  ADVANCED_METRIC_VERSION,
  buildRunExpectancy,
  extraBaseFeatures,
  isFieldingModelEligible,
  modelDoublePlayOpportunities,
  modelFieldingOpportunities,
  modelRunnerOpportunities,
} from '../src/utils/advancedDefense.js'
import { stadiumDecidedFielding } from '../src/utils/stadiumIncidents.js'
import { priceStadiumRuns } from '../src/utils/gimmickLuck.js'
import { characterNameKey, indexByCharacterName } from '../src/utils/characterNames.js'
import { loadFrozenCatchModel, scoreCatchProbability } from './catch_probability_model.mjs'

// The catch model the calibration writes, active or not. Stadium runs are an
// experimental luck column and use it even while it is rejected; OAA and WAR
// never read it from here.
export const STADIUM_CATCH_MODEL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'calibration', 'catch-probability-candidate-v1.json',
)

// The CPU's send/hold policy, fitted from the local archive by
// scripts/calibrate_runner_decisions.mjs. Used only while its status is
// 'active' (it beat the context average out of fold); otherwise every row keeps
// the context average.
export const RUNNER_DECISION_MODEL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'calibration', 'runner-decision-model-v1.json',
)

function loadRunnerDecisionModel(filePath = RUNNER_DECISION_MODEL_PATH) {
  try {
    const model = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return model?.status === 'active' ? model : null
  } catch {
    return null
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return []
    const index = trimmed.indexOf('=')
    return index > 0 ? [[trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim()]] : []
  }))
}

export function advancedMetricsEnv() {
  return {
    ...loadEnvFile(path.resolve('.env')),
    ...loadEnvFile(path.resolve('.env.tracker-bridge')),
    ...process.env,
  }
}

export async function createAdvancedMetricsClient() {
  const env = advancedMetricsEnv()
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required')
  }
  const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  if (env.TRACKER_BRIDGE_EMAIL && env.TRACKER_BRIDGE_PASSWORD) {
    const { error } = await supabase.auth.signInWithPassword({
      email: env.TRACKER_BRIDGE_EMAIL,
      password: env.TRACKER_BRIDGE_PASSWORD,
    })
    if (error) throw new Error(`Sign-in failed: ${error.message}`)
  }
  return supabase
}

async function updateRows(supabase, table, rows, pick) {
  let updated = 0
  for (let index = 0; index < rows.length; index += 25) {
    const batch = rows.slice(index, index + 25)
    const results = await Promise.all(batch.map((row) => (
      supabase.from(table).update(pick(row)).eq('id', row.id)
    )))
    const failed = results.find((result) => result.error)
    if (failed) throw failed.error
    updated += batch.length
  }
  return updated
}

export async function recomputeAdvancedMetrics(supabase, { excludeSeasonIds = [] } = {}) {
  const [
    tournamentPasResult,
    seasonPasResult,
    runnerResult,
    dpResult,
    fieldingResult,
    playsResult,
    activeVersionsResult,
    charactersResult,
  ] = await Promise.all([
    fetchAllRows(() => supabase.from('plate_appearances').select('*')),
    fetchAllRows(() => supabase.from('season_plate_appearances').select('*')),
    fetchAllRows(() => supabase.from('runner_opportunities').select('*')),
    fetchAllRows(() => supabase.from('double_play_opportunities').select('*')),
    fetchAllRows(() => supabase.from('fielding_opportunities').select('*')),
    // For each play's stadium incidents, so rows ingested before
    // `stadium_affected` existed are judged by the same rule as new ones.
    fetchAllRows(() => supabase.from('tracking_plays').select('id,competition_type,pa_id,first_touch_frame,quality')),
    // A replacement tracking version is built beside the active one and only
    // becomes authoritative when it is finished. Modelling both at once fed
    // the catch-probability curve two copies of the same play -- one of them
    // from a version nothing on the site reads.
    //
    // THIS ONE IS CHECKED WITH THE REST, and that is the point. This function
    // WRITES the models it builds back onto the opportunity rows, so an
    // unknown version membership is not a degraded run, it is a run that would
    // persist a curve fitted to the same play counted twice. It fails instead;
    // the previously computed columns stay exactly as they are.
    fetchSupersededTrackingPlayIds(supabase),
    // Run speed and arm are fixed per character, so the attributes are the
    // decision model's speed and arm inputs.
    fetchAllRows(() => supabase.from('characters').select('id,name,run_speed,throwing_speed')),
  ])
  const firstError = tournamentPasResult.error || seasonPasResult.error || runnerResult.error
    || dpResult.error || fieldingResult.error || playsResult.error || activeVersionsResult.error
    || charactersResult.error
  if (firstError) throw firstError
  if (activeVersionsResult.legacy) {
    console.log(`note: ${activeVersionsResult.legacy}; every tracking fact is being modelled.`)
  }

  const plateAppearances = [
    ...(tournamentPasResult.data || []).map((row) => ({ ...row, competition_type: 'tournament' })),
    ...(seasonPasResult.data || []).map((row) => ({ ...row, competition_type: 'season' })),
  ]
  const excludedSeasons = new Set(excludeSeasonIds.map(String))
  const writeScopeEnabled = excludedSeasons.size > 0
  const writablePaKeys = new Set(plateAppearances
    .filter((pa) => pa.competition_type !== 'season' || !excludedSeasons.has(String(pa.season_id)))
    .map((pa) => `${pa.competition_type}:${pa.id}`))
  const writableFact = (row) => !writeScopeEnabled
    || writablePaKeys.has(`${row.competition_type}:${row.pa_id}`)
  const expectancy = buildRunExpectancy(plateAppearances)
  const decisionModel = loadRunnerDecisionModel()
  const charactersById = new Map((charactersResult.data || []).map((row) => [String(row.id), row]))
  const charactersByName = indexByCharacterName(charactersResult.data || [], (row) => row.name, { collapseMii: true })
  const contextByPa = new Map(onlyActiveTrackingPlays(playsResult.data || [], activeVersionsResult.data)
    .filter((play) => play.pa_id != null && play.quality?.runner_context)
    .map((play) => [`${play.competition_type}:${play.pa_id}`, play.quality.runner_context]))
  const modeledRunner = modelRunnerOpportunities(runnerResult.data || [], expectancy, {
    decisionModel,
    featuresFor: (row) => {
      const context = contextByPa.get(`${row.competition_type}:${row.pa_id}`)
      // The arm of whoever first secured the ball, as the fit uses; the
      // scorebook's first fielder only when the capture did not name one.
      const fielder = charactersByName.get(characterNameKey(context?.touch?.character, { collapseMii: true }))
        || charactersById.get(String(row.responsible_fielder_character_id))
      return extraBaseFeatures(row, context, {
        runnerSpeed: charactersById.get(String(row.runner_character_id))?.run_speed,
        fielderArm: fielder?.throwing_speed,
      })
    },
  })
  const modeledDp = modelDoublePlayOpportunities(dpResult.data || [], expectancy)
  const playsById = new Map((playsResult.data || []).map((play) => [String(play.id), play]))
  const modeledFielding = modelFieldingOpportunities(
    onlyActiveTrackingFacts(fieldingResult.data, activeVersionsResult.data).map((row) => {
      const play = playsById.get(String(row.tracking_play_id))
      const incidents = play?.quality?.stadium_incidents
      if (!Array.isArray(incidents)) return row
      const stadiumAffected = stadiumDecidedFielding(incidents, row.position, {
        firstTouchFrame: play.first_touch_frame,
      })
      return { ...row, quality: { ...(row.quality || {}), stadium_affected: stadiumAffected } }
    }))

  // Stadium runs: every play the ingest recorded park interference on, scored
  // with the current catch model and priced with this run's table.
  const { artifact: catchModel } = loadFrozenCatchModel(STADIUM_CATCH_MODEL_PATH, { allowRejected: true })
  const scoreCatch = (input) => scoreCatchProbability(input, catchModel, { allowRejected: true })
  const pasByKey = new Map(plateAppearances.map((pa) => [`${pa.competition_type}:${pa.id}`, pa]))
  const pricedPlays = (playsResult.data || [])
    .filter((play) => play.quality?.stadium_runs && writableFact(play))
    .map((play) => ({
    id: play.id,
    quality: {
      ...play.quality,
      stadium_runs: priceStadiumRuns(
        play.quality.stadium_runs,
        pasByKey.get(`${play.competition_type}:${play.pa_id}`),
        expectancy,
        { scoreCatch },
      ),
    },
  }))

  const writableRunner = modeledRunner.filter(writableFact)
  const writableDp = modeledDp.filter(writableFact)
  const writableFielding = modeledFielding.filter((row) => {
    const play = playsById.get(String(row.tracking_play_id))
    return play && writableFact(play)
  })
  const [runnerUpdated, dpUpdated, fieldingUpdated, stadiumRunsUpdated] = await Promise.all([
    updateRows(supabase, 'runner_opportunities', writableRunner, (row) => ({
      expected_attempt_probability: row.expected_attempt_probability ?? null,
      expected_success_probability: row.expected_success_probability ?? null,
      runner_run_value: row.runner_run_value ?? null,
      arm_run_value: row.arm_run_value ?? null,
      model_version: row.model_version || ADVANCED_METRIC_VERSION,
    })),
    updateRows(supabase, 'double_play_opportunities', writableDp, (row) => ({
      expected_double_play_probability: row.expected_double_play_probability ?? null,
      double_plays_added: row.double_plays_added ?? null,
      run_value: row.run_value ?? null,
      model_version: row.model_version || ADVANCED_METRIC_VERSION,
    })),
    updateRows(supabase, 'fielding_opportunities', writableFielding, (row) => {
      // A row the model no longer scores loses its old values rather than
      // keeping an OAA from before it was excluded.
      const scored = isFieldingModelEligible(row)
      return {
        expected_out_probability: scored ? row.expected_out_probability ?? null : null,
        outs_above_average: scored ? row.outs_above_average ?? null : null,
        star_difficulty: scored ? row.star_difficulty ?? null : null,
        model_version: row.model_version || ADVANCED_METRIC_VERSION,
        quality: row.quality ?? null,
      }
    }),
    updateRows(supabase, 'tracking_plays', pricedPlays, (row) => ({ quality: row.quality })),
  ])

  return {
    modelVersion: ADVANCED_METRIC_VERSION,
    excludedSeasonIds: [...excludedSeasons],
    runnerDecisionModel: decisionModel?.model_version || null,
    runnerDecisionScored: writableRunner.filter((row) => String(row.model_version || '').includes('+decision:')).length,
    runExpectancyStates: expectancy.size,
    runnerOpportunities: runnerUpdated,
    doublePlayOpportunities: dpUpdated,
    fieldingOpportunities: fieldingUpdated,
    stadiumRunsPlays: stadiumRunsUpdated,
  }
}

async function main() {
  const excludeSeasonIds = process.argv.flatMap((arg, index, args) => {
    if (arg === '--exclude-season') return args[index + 1] ? [args[index + 1]] : []
    if (arg.startsWith('--exclude-season=')) return [arg.slice('--exclude-season='.length)]
    return []
  })
  const supabase = await createAdvancedMetricsClient()
  const summary = await recomputeAdvancedMetrics(supabase, { excludeSeasonIds })
  console.log(JSON.stringify(summary, null, 2))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
