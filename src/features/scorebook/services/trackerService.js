import { supabase } from '../../../supabaseClient'

export async function fetchTrackerLiveStats({ tables, gameId }) {
  return supabase
    .from(tables.trackerLiveStats)
    .select('*')
    .eq('game_id', gameId)
    .maybeSingle()
}

export async function updateTrackerTeamMapping({ tables, gameId, teamMapping }) {
  return supabase
    .from(tables.trackerLiveStats)
    .update({ team_mapping: teamMapping })
    .eq('game_id', gameId)
}
