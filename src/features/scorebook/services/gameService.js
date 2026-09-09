import { supabase } from '../../../supabaseClient'

export async function updateGameRecord({ tables, gameId, patch }) {
  return supabase.from(tables.games).update(patch).eq('id', gameId)
}

export async function replaceInningScoreRows({ tables, gameId, rows }) {
  await supabase.from(tables.inningScores).delete().eq('game_id', gameId)
  if (!rows.length) return { error: null }
  return supabase.from(tables.inningScores).insert(rows)
}

export async function insertStadiumGameLog({ tables, row }) {
  return supabase.from(tables.stadiumGameLog).insert(row)
}

export async function deleteStadiumGameLog({ tables, gameId }) {
  return supabase.from(tables.stadiumGameLog).delete().eq('game_id', gameId)
}

export async function updatePitchingStint({ tables, stintId, patch }) {
  return supabase.from(tables.pitchingStints).update(patch).eq('id', stintId)
}

export async function clearPitchingStintDecisions({ tables, stintIds }) {
  return supabase.from(tables.pitchingStints).update({ win: false, loss: false }).in('id', stintIds)
}

export async function insertPitchingStint({ tables, row }) {
  return supabase.from(tables.pitchingStints).insert(row).select().single()
}

export async function deletePitchingStint({ tables, stintId }) {
  return supabase.from(tables.pitchingStints).delete().eq('id', stintId)
}

export async function deleteGameScopedRows({ table, gameId }) {
  return supabase.from(table).delete().eq('game_id', gameId)
}

export async function createTournamentGame({ row }) {
  return supabase.from('games').insert(row).select().single()
}

export async function countGameScopedRows({ table, gameId }) {
  return supabase.from(table).select('*', { count: 'exact', head: true }).eq('game_id', gameId)
}

export async function updatePitchingStintStats({ tables, updates }) {
  return Promise.all(updates.map(({ stintId, patch }) => (
    supabase.from(tables.pitchingStints).update(patch).eq('id', stintId)
  )))
}

export async function clearTournamentCompletion({ tournamentId }) {
  return supabase
    .from('tournaments')
    .update({ champion_player_id: null, status: 'active' })
    .eq('id', tournamentId)
}
