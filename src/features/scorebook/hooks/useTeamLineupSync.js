import { useEffect } from 'react'
import { supabase } from '../../../supabaseClient'
import {
  fetchTeamLineup,
  SEASON_TEAM_LINEUPS,
  TOURNAMENT_TEAM_LINEUPS,
} from '../../../utils/teamLineups'

export default function useTeamLineupSync({
  sourceId,
  isSeasonGame,
  teamAPlayerId,
  teamBPlayerId,
  applyIncomingTeamLineup,
}) {
  useEffect(() => {
    if (!sourceId || (!teamAPlayerId && !teamBPlayerId)) return

    const teamLineupsTable = isSeasonGame ? SEASON_TEAM_LINEUPS : TOURNAMENT_TEAM_LINEUPS
    const channel = supabase
      .channel(`scorebook-team-lineups-${sourceId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: teamLineupsTable.table,
        filter: `${teamLineupsTable.idField}=eq.${sourceId}`,
      }, (payload) => {
        const row = payload.new
        if (!row) return
        let team = null
        if (String(row.player_id) === String(teamAPlayerId)) team = 'A'
        else if (String(row.player_id) === String(teamBPlayerId)) team = 'B'
        if (!team) return

        const lineupOrder = Array.isArray(row.lineup_order) ? row.lineup_order : []
        const fieldingPositions = row.fielding_positions && typeof row.fielding_positions === 'object' ? row.fielding_positions : {}
        applyIncomingTeamLineup(team, lineupOrder, fieldingPositions)
      })
      .subscribe()

    // Realtime can be throttled or unavailable, so retain the existing
    // visibility-aware polling fallback.
    const pollTeamLineups = () => {
      const teams = [
        ['A', teamAPlayerId],
        ['B', teamBPlayerId],
      ]
      teams.forEach(([team, playerId]) => {
        if (!playerId) return
        fetchTeamLineup({ ...teamLineupsTable, sourceId, playerId }).then((saved) => {
          if (!saved) return
          const lineupOrder = Array.isArray(saved.lineupOrder) ? saved.lineupOrder : []
          const fieldingPositions = saved.fieldingPositions && typeof saved.fieldingPositions === 'object' ? saved.fieldingPositions : {}
          applyIncomingTeamLineup(team, lineupOrder, fieldingPositions)
        })
      })
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') pollTeamLineups()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    pollTeamLineups()
    const pollInterval = setInterval(() => {
      if (document.hidden) return
      pollTeamLineups()
    }, 5000)

    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', handleVisibility)
      clearInterval(pollInterval)
    }
  }, [sourceId, isSeasonGame, teamAPlayerId, teamBPlayerId, applyIncomingTeamLineup])
}
