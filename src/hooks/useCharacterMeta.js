import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'

// Character identity for a direct URL load or a refresh, where there is no router state to read
// it from. Pages that were navigated into WITH state (from Stats, Roster, Scorebook...) pass
// `hasPreset` and this fetch never runs.
export default function useCharacterMetaFallback(characterId, hasPreset) {
  const [meta, setMeta] = useState(null)

  useEffect(() => {
    if (hasPreset || !characterId) return undefined
    let cancelled = false
    setMeta(null)

    async function load() {
      const [{ data: charactersData }, { data: playersData }, { data: draftPicksData }] = await Promise.all([
        supabase.from('characters').select('*').order('name'),
        supabase.from('players').select('*'),
        supabase.from('draft_picks').select('*'),
      ])
      if (cancelled) return

      const characters = charactersData || []
      const allCharactersById = Object.fromEntries(characters.map((c) => [c.name, c]))
      const character = characters.find((c) => String(c.id) === String(characterId)) || null
      const playersById = Object.fromEntries((playersData || []).map((p) => [p.id, p]))
      const picksForCharacter = (draftPicksData || []).filter((p) => String(p.character_id) === String(characterId) && p.player_id)
      const pick = picksForCharacter[picksForCharacter.length - 1] || null
      const currentOwner = pick ? { player_id: pick.player_id } : null

      if (!cancelled) {
        setMeta({ character, allCharactersById, playersById, identitiesByPlayerId: {}, currentOwner })
      }
    }

    load()
    return () => { cancelled = true }
  }, [characterId, hasPreset])

  return meta
}
