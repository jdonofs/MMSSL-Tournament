import { supabase } from '../supabaseClient'

export const TOURNAMENT_TEAM_LINEUPS = { table: 'team_lineups', idField: 'tournament_id' }
export const SEASON_TEAM_LINEUPS = { table: 'season_team_lineups', idField: 'season_id' }

// Swaps a lineup entry with whatever character currently occupies `targetIndex`.
// Used by roster and scorebook editors so lineup edits always behave like
// slot-for-slot swaps rather than remove-and-insert reordering.
export function swapLineupSlot(lineupOrder, sourceCharacterId, targetIndex) {
  if (!Array.isArray(lineupOrder)) return lineupOrder
  if (targetIndex < 0 || targetIndex >= lineupOrder.length) return lineupOrder
  const sourceIndex = lineupOrder.indexOf(sourceCharacterId)
  if (sourceIndex === -1 || sourceIndex === targetIndex) return lineupOrder
  const next = [...lineupOrder]
  ;[next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]]
  return next
}

// Fetches the saved lineup order + fielding positions for a team.
// Returns null if no row exists yet (caller should fall back to defaults).
// A failed read also returns null unless `throwOnError` is set. Any caller
// that writes a lineup built from the result must set it: falling back to
// defaults after a failed read overwrites the stored lineup with a guess.
export async function fetchTeamLineup({ table, idField, sourceId, playerId, throwOnError = false }) {
  if (!sourceId || !playerId) return null
  const { data, error } = await supabase
    .from(table)
    .select('lineup_order, fielding_positions')
    .eq(idField, sourceId)
    .eq('player_id', playerId)
    .maybeSingle()
  if (error && throwOnError) throw error
  if (error || !data) return null
  return {
    lineupOrder: Array.isArray(data.lineup_order) ? data.lineup_order : [],
    fieldingPositions: data.fielding_positions && typeof data.fielding_positions === 'object' ? data.fielding_positions : {},
  }
}

// Upserts the lineup order + fielding positions for a team. Throws on a failed
// write: both roster pages mark the lineup saved only if this resolves.
export async function upsertTeamLineup({ table, idField, sourceId, playerId, lineupOrder, fieldingPositions }) {
  if (!sourceId || !playerId) return { error: null }
  const { error } = await supabase
    .from(table)
    .upsert({
      [idField]: sourceId,
      player_id: playerId,
      lineup_order: lineupOrder,
      fielding_positions: fieldingPositions,
      updated_at: new Date().toISOString(),
    }, { onConflict: `${idField},player_id` })
  if (error) throw error
  return { error: null }
}
