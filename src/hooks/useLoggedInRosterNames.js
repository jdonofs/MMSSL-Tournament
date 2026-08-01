import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'

// Chemistry highlighting on CharacterPage should reflect the *logged-in* player's own
// roster ("would this character mesh with my team?"), not the roster of whatever character
// happens to be on screen. Resolves that roster for the given scope (season/tournament/career),
// falling back to the player's most recently active season team or tournament draft when the
// scope has none of theirs (e.g. viewing a career page, or a season/tournament they didn't play
// in). Returns [] when logged out so callers can skip chemistry highlighting entirely.
export default function useLoggedInRosterNames(scope) {
  const { player } = useAuth()
  const [rosterNames, setRosterNames] = useState([])

  useEffect(() => {
    if (!player?.id) {
      setRosterNames([])
      return undefined
    }
    let cancelled = false

    async function load() {
      const [
        { data: seasonTeams }, { data: seasons }, { data: draftPicks }, { data: tournaments }, { data: characters },
      ] = await Promise.all([
        supabase.from('season_teams').select('id,player_id,season_id').eq('player_id', player.id),
        supabase.from('seasons').select('id,created_at'),
        supabase.from('draft_picks').select('player_id,tournament_id,character_id').eq('player_id', player.id),
        supabase.from('tournaments').select('id,tournament_number'),
        supabase.from('characters').select('id,name'),
      ])
      if (cancelled) return

      const nameById = Object.fromEntries((characters || []).map((c) => [c.id, c.name]))
      const seasonById = Object.fromEntries((seasons || []).map((s) => [s.id, s]))
      const tournamentById = Object.fromEntries((tournaments || []).map((t) => [t.id, t]))

      let seasonTeam = scope?.type === 'season'
        ? (seasonTeams || []).find((t) => String(t.season_id) === String(scope.id)) || null
        : null
      let tournamentId = scope?.type === 'tournament' && (draftPicks || []).some((p) => String(p.tournament_id) === String(scope.id))
        ? scope.id
        : null

      if (!seasonTeam && !tournamentId) {
        const sortedSeasonTeams = [...(seasonTeams || [])].sort((a, b) =>
          new Date(seasonById[b.season_id]?.created_at || 0) - new Date(seasonById[a.season_id]?.created_at || 0))
        if (sortedSeasonTeams[0]) {
          seasonTeam = sortedSeasonTeams[0]
        } else {
          const tournamentIdsForPlayer = [...new Set((draftPicks || []).map((p) => p.tournament_id).filter(Boolean))]
          tournamentId = tournamentIdsForPlayer.sort((a, b) =>
            Number(tournamentById[b]?.tournament_number || 0) - Number(tournamentById[a]?.tournament_number || 0))[0] || null
        }
      }

      if (seasonTeam) {
        const { data: rosterRows } = await supabase
          .from('season_roster')
          .select('character_name')
          .eq('team_id', seasonTeam.id)
          .eq('is_active', true)
        if (!cancelled) setRosterNames((rosterRows || []).map((r) => r.character_name).filter(Boolean))
        return
      }

      if (tournamentId) {
        const names = (draftPicks || [])
          .filter((p) => String(p.tournament_id) === String(tournamentId))
          .map((p) => nameById[p.character_id])
          .filter(Boolean)
        if (!cancelled) setRosterNames(names)
        return
      }

      if (!cancelled) setRosterNames([])
    }

    load()
    return () => { cancelled = true }
  }, [player?.id, scope?.type, scope?.id])

  return rosterNames
}
