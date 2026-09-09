// Refit every Sluggers-native opportunity model and persist versioned outputs.
// Safe to rerun: source opportunity rows stay unchanged and only modeled
// probability/run-value columns are updated.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import { fetchSupersededTrackingPlayIds, onlyActiveTrackingFacts } from '../src/utils/activeTrackingVersions.js'
import {
  ADVANCED_METRIC_VERSION,
  buildRunExpectancy,
  modelDoublePlayOpportunities,
  modelFieldingOpportunities,
  modelRunnerOpportunities,
} from '../src/utils/advancedDefense.js'

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

export async function recomputeAdvancedMetrics(supabase) {
  const [
    tournamentPasResult,
    seasonPasResult,
    runnerResult,
    dpResult,
    fieldingResult,
    activeVersionsResult,
  ] = await Promise.all([
    fetchAllRows(() => supabase.from('plate_appearances').select('*')),
    fetchAllRows(() => supabase.from('season_plate_appearances').select('*')),
    fetchAllRows(() => supabase.from('runner_opportunities').select('*')),
    fetchAllRows(() => supabase.from('double_play_opportunities').select('*')),
    fetchAllRows(() => supabase.from('fielding_opportunities').select('*')),
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
  ])
  const firstError = tournamentPasResult.error || seasonPasResult.error || runnerResult.error
    || dpResult.error || fieldingResult.error || activeVersionsResult.error
  if (firstError) throw firstError
  if (activeVersionsResult.legacy) {
    console.log(`note: ${activeVersionsResult.legacy}; every tracking fact is being modelled.`)
  }

  const plateAppearances = [
    ...(tournamentPasResult.data || []).map((row) => ({ ...row, competition_type: 'tournament' })),
    ...(seasonPasResult.data || []).map((row) => ({ ...row, competition_type: 'season' })),
  ]
  const expectancy = buildRunExpectancy(plateAppearances)
  const modeledRunner = modelRunnerOpportunities(runnerResult.data || [], expectancy)
  const modeledDp = modelDoublePlayOpportunities(dpResult.data || [], expectancy)
  const modeledFielding = modelFieldingOpportunities(
    onlyActiveTrackingFacts(fieldingResult.data, activeVersionsResult.data))

  const [runnerUpdated, dpUpdated, fieldingUpdated] = await Promise.all([
    updateRows(supabase, 'runner_opportunities', modeledRunner, (row) => ({
      expected_attempt_probability: row.expected_attempt_probability ?? null,
      expected_success_probability: row.expected_success_probability ?? null,
      runner_run_value: row.runner_run_value ?? null,
      arm_run_value: row.arm_run_value ?? null,
      model_version: row.model_version || ADVANCED_METRIC_VERSION,
    })),
    updateRows(supabase, 'double_play_opportunities', modeledDp, (row) => ({
      expected_double_play_probability: row.expected_double_play_probability ?? null,
      double_plays_added: row.double_plays_added ?? null,
      run_value: row.run_value ?? null,
      model_version: row.model_version || ADVANCED_METRIC_VERSION,
    })),
    updateRows(supabase, 'fielding_opportunities', modeledFielding, (row) => ({
      expected_out_probability: row.expected_out_probability ?? null,
      outs_above_average: row.outs_above_average ?? null,
      star_difficulty: row.star_difficulty ?? null,
      model_version: row.model_version || ADVANCED_METRIC_VERSION,
    })),
  ])

  return {
    modelVersion: ADVANCED_METRIC_VERSION,
    runExpectancyStates: expectancy.size,
    runnerOpportunities: runnerUpdated,
    doublePlayOpportunities: dpUpdated,
    fieldingOpportunities: fieldingUpdated,
  }
}

async function main() {
  const supabase = await createAdvancedMetricsClient()
  const summary = await recomputeAdvancedMetrics(supabase)
  console.log(JSON.stringify(summary, null, 2))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
