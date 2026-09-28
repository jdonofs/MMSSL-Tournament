// A season free-agent pickup is one request: the add, the drop and the dropped
// player's waiver commit together or not at all, inside
// season_free_agent_pickup. There is deliberately no fallback to separate
// writes when the function is missing -- that sequence is what left rosters at
// ten players and swaps without waivers.

export const SEASON_PICKUP_FUNCTION = 'season_free_agent_pickup'
export const SEASON_PICKUP_MIGRATION = 'supabase/migrations/20260914120000_season_free_agent_pickup.sql'

// PGRST202 is PostgREST's "no such function in the schema cache"; 42883 is the
// server's own, which is what a direct connection reports.
export function isMissingSeasonPickupFunction(error) {
  if (!error) return false
  if (error.code === 'PGRST202') return true
  return error.code === '42883' && String(error.message || '').includes(SEASON_PICKUP_FUNCTION)
}

/**
 * Returns { ok: true, status: 'applied' | 'already_applied', result } or
 * { ok: false, reason, title, message }. `reason` is the function's refusal key
 * (stale_drop, not_free_agent, ...), 'migration_missing', or the error code.
 */
export async function submitSeasonFreeAgentPickup(supabase, { seasonId, teamId, addCharacter, dropRosterId }) {
  let response
  try {
    response = await supabase.rpc(SEASON_PICKUP_FUNCTION, {
      p_season_id: seasonId,
      p_team_id: teamId,
      p_add_character: addCharacter,
      p_drop_roster_id: dropRosterId,
    })
  } catch (error) {
    response = { data: null, error }
  }

  const { data, error } = response
  if (!error) return { ok: true, status: data?.status || 'applied', result: data }

  if (isMissingSeasonPickupFunction(error)) {
    return {
      ok: false,
      reason: 'migration_missing',
      title: 'Pickup migration not applied',
      message: `This database has no ${SEASON_PICKUP_FUNCTION} function, so pickups are disabled and nothing was changed. Apply ${SEASON_PICKUP_MIGRATION}.`,
    }
  }

  return {
    ok: false,
    reason: error.hint || error.code || 'failed',
    title: 'Pickup failed',
    message: error.message || 'The pickup was not saved.',
  }
}
