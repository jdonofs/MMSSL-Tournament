import { useEffect } from 'react'
import { supabase } from '../../../supabaseClient'
import { createRefreshCoordinator } from '../../../utils/refreshCoordinator'
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
    // Reconcile once initially and after visibility/reconnect gaps. Realtime
    // rows are applied directly below, so healthy idle tabs do not poll.
    const refreshTeamLineups = async () => {
      const teams = [
        ['A', teamAPlayerId],
        ['B', teamBPlayerId],
      ]
      await Promise.all(teams.map(async ([team, playerId]) => {
        if (!playerId) return
        const saved = await fetchTeamLineup({ ...teamLineupsTable, sourceId, playerId })
        if (!saved) return
        const lineupOrder = Array.isArray(saved.lineupOrder) ? saved.lineupOrder : []
        const fieldingPositions = saved.fieldingPositions && typeof saved.fieldingPositions === 'object' ? saved.fieldingPositions : {}
        applyIncomingTeamLineup(team, lineupOrder, fieldingPositions)
      }))
    }
    const refreshCoordinator = createRefreshCoordinator({
      run: refreshTeamLineups,
      delayMs: 100,
      maxWaitMs: 500,
      isPaused: () => document.visibilityState === 'hidden',
    })
    let hasSubscribed = false
    const channel = supabase
      .channel(`scorebook-team-lineups-${sourceId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: teamLineupsTable.table,
        filter: `${teamLineupsTable.idField}=eq.${sourceId}`,
      }, (payload) => {
        const row = payload.new
        if (!row) {
          refreshCoordinator.request()
          return
        }
        let team = null
        if (String(row.player_id) === String(teamAPlayerId)) team = 'A'
        else if (String(row.player_id) === String(teamBPlayerId)) team = 'B'
        if (!team) return

        const lineupOrder = Array.isArray(row.lineup_order) ? row.lineup_order : []
        const fieldingPositions = row.fielding_positions && typeof row.fielding_positions === 'object' ? row.fielding_positions : {}
        applyIncomingTeamLineup(team, lineupOrder, fieldingPositions)
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (hasSubscribed) refreshCoordinator.request({ immediate: true })
        hasSubscribed = true
      })
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshCoordinator.request({ immediate: true })
    }
    const handleOnline = () => refreshCoordinator.request({ immediate: true })
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnline)
    refreshCoordinator.request({ immediate: true })

    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
      refreshCoordinator.dispose()
    }
  }, [sourceId, isSeasonGame, teamAPlayerId, teamBPlayerId, applyIncomingTeamLineup])
}
