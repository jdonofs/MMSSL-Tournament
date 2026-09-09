import { supabase } from '../../../supabaseClient'
import { persistOddsRowsWithFallback } from '../../../utils/oddsPersistence'

export async function fetchGameOdds({ tables, gameId }) {
  return supabase.from(tables.gameOdds).select('*').eq('game_id', gameId)
}

export async function persistScorebookOddsRows({ tables, updates, inserts }) {
  return persistOddsRowsWithFallback({
    supabase,
    table: tables.gameOdds,
    updates,
    inserts,
  })
}

export async function hasRelatedPitcherPropBets({
  tables,
  isSeasonGame,
  gameId,
  gameOddsId,
  targetEntity,
}) {
  const query = isSeasonGame
    ? supabase.from(tables.bets).select('id').eq('game_id', gameId).eq('bet_type', 'k_prop').eq('target_entity', targetEntity).limit(1)
    : supabase.from(tables.bets).select('id').eq('game_odds_id', gameOddsId).limit(1)
  const { data } = await query
  return Boolean(data?.length)
}

export async function deleteGameOddsRow({ tables, gameOddsId }) {
  return supabase.from(tables.gameOdds).delete().eq('id', gameOddsId)
}
