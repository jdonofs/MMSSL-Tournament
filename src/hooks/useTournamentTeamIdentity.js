import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import { buildTournamentTeamIdentityMap } from '../utils/teamIdentity'

export default function useTournamentTeamIdentity(tournamentId) {
  const [draftPicks, setDraftPicks] = useState([])
  const [charactersById, setCharactersById] = useState({})

  useEffect(() => {
    if (!tournamentId) {
      setDraftPicks([])
      return undefined
    }

    let active = true

    async function load() {
      const [{ data: picksData }, { data: charactersData }] = await Promise.all([
        supabase.from('draft_picks').select('*').eq('tournament_id', tournamentId).order('pick_number'),
        supabase.from('characters').select('id,name'),
      ])

      if (!active) return
      setDraftPicks(picksData || [])
      setCharactersById(Object.fromEntries((charactersData || []).map((entry) => [entry.id, entry])))
    }

    load()

    const channel = supabase
      .channel(`team-identity-${tournamentId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks', filter: `tournament_id=eq.${tournamentId}` }, load)
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [tournamentId])

  const identitiesByPlayerId = useMemo(
    () => buildTournamentTeamIdentityMap(draftPicks, charactersById),
    [draftPicks, charactersById],
  )

  return {
    draftPicks,
    identitiesByPlayerId,
  }
}
