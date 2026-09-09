import { supabase } from '../../../supabaseClient'
import { syncRunnerOpportunities } from '../../../utils/runnerOpportunityPersistence.js'

export function syncPlateAppearanceRunnerOpportunities({ tables, pa, outsBefore }) {
  return syncRunnerOpportunities(supabase, {
    pa, outsBefore,
    competitionType: tables.plateAppearances === 'season_plate_appearances' ? 'season' : 'tournament',
  })
}

async function deleteRunnerOpportunities(tables, plateAppearanceId) {
  return supabase.from('runner_opportunities').delete()
    .eq('competition_type', tables.plateAppearances === 'season_plate_appearances' ? 'season' : 'tournament')
    .eq('pa_id', plateAppearanceId)
}

export async function savePlateAppearanceRecord({ tables, payload, plateAppearanceId = null }) {
  const query = plateAppearanceId != null
    ? supabase.from(tables.plateAppearances).update(payload).eq('id', plateAppearanceId).select().single()
    : supabase.from(tables.plateAppearances).insert(payload).select().single()
  return query
}

export async function fetchCommittedPitchSequence({ tables, gameId }) {
  return supabase
    .from(tables.pitches)
    .select('pitcher_id,pitch_number_game')
    .eq('game_id', gameId)
}

export async function deletePlateAppearanceChildren({ tables, plateAppearanceId }) {
  return Promise.all([
    supabase.from(tables.pitches).delete().eq('pa_id', plateAppearanceId),
    supabase.from(tables.runsScored).delete().eq('pa_id', plateAppearanceId),
  ])
}

export async function insertPlateAppearancePitches({ tables, rows }) {
  return supabase.from(tables.pitches).insert(rows)
}

export async function insertPlateAppearanceRuns({ tables, rows }) {
  return supabase.from(tables.runsScored).insert(rows)
}

export async function restorePlateAppearanceBundle({
  tables,
  plateAppearanceId,
  plateAppearancePayload,
  pitchRows,
  runRows,
}) {
  await deletePlateAppearanceChildren({ tables, plateAppearanceId })
  if (pitchRows.length) {
    const { error } = await insertPlateAppearancePitches({ tables, rows: pitchRows })
    if (error) throw error
  }
  if (runRows.length) {
    const { error } = await insertPlateAppearanceRuns({ tables, rows: runRows })
    if (error) throw error
  }
  const { error } = await supabase
    .from(tables.plateAppearances)
    .update(plateAppearancePayload)
    .eq('id', plateAppearanceId)
  if (error) throw error
}

export async function deletePlateAppearanceBundle({ tables, plateAppearanceId }) {
  await Promise.all([
    supabase.from(tables.pitches).delete().eq('pa_id', plateAppearanceId),
    supabase.from(tables.runsScored).delete().eq('pa_id', plateAppearanceId),
    supabase.from(tables.plateAppearances).delete().eq('id', plateAppearanceId),
    deleteRunnerOpportunities(tables, plateAppearanceId),
  ])
}

export async function rollbackRestoredPlateAppearance({ tables, plateAppearanceId }) {
  await deletePlateAppearanceChildren({ tables, plateAppearanceId })
  await supabase.from(tables.plateAppearances).delete().eq('id', plateAppearanceId)
  await deleteRunnerOpportunities(tables, plateAppearanceId)
}

export async function refreshPlateAppearanceBundle({ tables, gameId }) {
  return Promise.all([
    supabase.from(tables.plateAppearances).select('*').eq('game_id', gameId).order('created_at'),
    supabase.from(tables.pitches).select('*').eq('game_id', gameId).order('created_at'),
    supabase.from(tables.runsScored).select('*').eq('game_id', gameId).order('created_at'),
  ])
}

export async function undoLatestPlateAppearance({ isSeasonGame, gameId, plateAppearanceId }) {
  const functionName = isSeasonGame
    ? 'undo_latest_season_pa'
    : 'undo_latest_tournament_pa'
  const result = await supabase.rpc(functionName, {
    p_game_id: gameId,
    p_pa_id: plateAppearanceId,
  })
  if (!result.error) {
    const { error } = await deleteRunnerOpportunities({ plateAppearances: isSeasonGame ? 'season_plate_appearances' : 'plate_appearances' }, plateAppearanceId)
    if (error) console.warn('PA undone; runner opportunity cleanup failed:', error.message)
  }
  return result
}
