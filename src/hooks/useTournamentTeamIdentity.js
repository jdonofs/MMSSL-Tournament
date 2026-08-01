import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import { buildTournamentTeamIdentityMap } from '../utils/teamIdentity'

export default function useTournamentTeamIdentity(tournamentId) {
  const [draftPicks, setDraftPicks] = useState([])
  const [charactersById, setCharactersById] = useState({})
  const [playerProfilesByPlayerId, setPlayerProfilesByPlayerId] = useState({})

  useEffect(() => {
    if (!tournamentId) {
      setDraftPicks([])
      setPlayerProfilesByPlayerId({})
      return undefined
    }

    let active = true

    async function load() {
      const [{ data: picksData }, { data: charactersData }, { data: playersData }] = await Promise.all([
        supabase.from('draft_picks').select('*').eq('tournament_id', tournamentId).order('pick_number'),
        supabase.from('characters').select('id,name'),
        supabase.from('players').select('id,color,team_name,team_mascot,team_location,team_abbreviation,team_primary_color,team_secondary_color,team_logo_url'),
      ])

      if (!active) return
      setDraftPicks(picksData || [])
      setCharactersById(Object.fromEntries((charactersData || []).map((entry) => [entry.id, entry])))
      setPlayerProfilesByPlayerId(Object.fromEntries((playersData || []).map((p) => [p.id, p])))
    }

    load()

    const channel = supabase
      .channel(`team-identity-${tournamentId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks', filter: `tournament_id=eq.${tournamentId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, load)
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [tournamentId])

  const identitiesByPlayerId = useMemo(
    () => buildTournamentTeamIdentityMap(draftPicks, charactersById, {}, playerProfilesByPlayerId),
    [draftPicks, charactersById, playerProfilesByPlayerId],
  )

  return {
    draftPicks,
    identitiesByPlayerId,
  }
}
