export const REVERSE_SEASON_PICKUP_FUNCTION = 'admin_reverse_season_free_agent_pickup'
export const SEASON_TRANSACTION_ADMIN_MIGRATION = 'supabase/migrations/20260921120000_season_transaction_admin.sql'

const PICKUP_PAIR_WINDOW_MS = 5 * 60 * 1000

function timestamp(value) {
  const parsed = new Date(value || 0).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

// A free-agent pickup predates a dedicated transaction table. Its durable
// footprint is the added roster row plus the dropped player's waiver row. Pair
// those one-to-one by team and creation time; the database function repeats
// every important check under row locks before it changes anything.
export function buildSeasonFreeAgentTransactions(roster = [], waivers = []) {
  const unusedWaiverIds = new Set(waivers.map((waiver) => String(waiver.id)))
  const additions = roster
    .filter((entry) => entry.acquired_via === 'free_agent')
    .sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at))

  return additions.map((added) => {
    const matchedWaiver = waivers
      .filter((waiver) => (
        unusedWaiverIds.has(String(waiver.id))
        && String(waiver.source_team_id) === String(added.team_id)
        && Math.abs(timestamp(waiver.created_at) - timestamp(added.created_at)) <= PICKUP_PAIR_WINDOW_MS
      ))
      .sort((a, b) => (
        Math.abs(timestamp(a.created_at) - timestamp(added.created_at))
        - Math.abs(timestamp(b.created_at) - timestamp(added.created_at))
      ))[0] || null

    if (matchedWaiver) unusedWaiverIds.delete(String(matchedWaiver.id))

    const dropped = matchedWaiver
      ? roster
        .filter((entry) => (
          String(entry.team_id) === String(added.team_id)
          && entry.character_name === matchedWaiver.claiming_character
          && entry.is_active === false
          && timestamp(entry.created_at) <= timestamp(matchedWaiver.created_at)
        ))
        .sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at))[0] || null
      : null

    let unavailableReason = ''
    if (!matchedWaiver) unavailableReason = 'The matching drop record could not be identified safely.'
    else if (!dropped) unavailableReason = 'The original roster row is missing or already active.'
    else if (added.is_active === false) unavailableReason = 'The added player has moved again since this pickup.'
    else if (matchedWaiver.status !== 'active') unavailableReason = 'The dropped player has already moved through waivers.'

    return {
      id: added.id,
      added,
      dropped,
      waiver: matchedWaiver,
      canReverse: !unavailableReason,
      unavailableReason,
    }
  })
}

export function isMissingSeasonTransactionAdminFunction(error) {
  if (!error) return false
  if (error.code === 'PGRST202') return true
  return error.code === '42883' && String(error.message || '').includes(REVERSE_SEASON_PICKUP_FUNCTION)
}

export async function reverseSeasonFreeAgentPickup(supabase, { seasonId, addedRosterId, waiverId }) {
  let response
  try {
    response = await supabase.rpc(REVERSE_SEASON_PICKUP_FUNCTION, {
      p_season_id: seasonId,
      p_added_roster_id: addedRosterId,
      p_waiver_id: waiverId,
    })
  } catch (error) {
    response = { data: null, error }
  }

  const { data, error } = response
  if (!error) return { ok: true, result: data }

  if (isMissingSeasonTransactionAdminFunction(error)) {
    return {
      ok: false,
      reason: 'migration_missing',
      message: `Season transaction tools are not installed. Apply ${SEASON_TRANSACTION_ADMIN_MIGRATION}.`,
    }
  }

  return {
    ok: false,
    reason: error.hint || error.code || 'failed',
    message: error.message || 'The transaction was not reversed.',
  }
}
