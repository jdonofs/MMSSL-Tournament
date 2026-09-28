import { supabase } from '../../../supabaseClient'

export async function updateGameLineupRows({ tables, updates }) {
  return Promise.all(updates.map(({ rowId, characterId, battingOrder }) => (
    supabase
      .from(tables.lineups)
      .update({ character_id: characterId, batting_order: battingOrder })
      .eq('id', rowId)
      .select()
  )))
}

// `closeWith` is { inning_to } at an inning boundary, plus pa_to mid-inning.
export async function closeGameFielderRows({ tables, rowIds, closeWith }) {
  return supabase.from(tables.gameFielders).update(closeWith).in('id', rowIds).select()
}

export async function deleteGameFielderRows({ tables, rowIds }) {
  return supabase.from(tables.gameFielders).delete().in('id', rowIds).select()
}

export async function insertGameFielderRows({ tables, rows }) {
  return supabase.from(tables.gameFielders).insert(rows).select()
}

export async function deleteGameLineupProjection({ tables, gameId }) {
  return Promise.all([
    supabase.from(tables.lineups).delete().eq('game_id', gameId),
    supabase.from(tables.gameFielders).delete().eq('game_id', gameId),
  ])
}

export async function insertGameLineupRows({ tables, rows }) {
  return supabase.from(tables.lineups).insert(rows).select()
}
