import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { TABLES, PLAYED_STATUS } from '../utils/gameSourceTables'

// Loads every completed game for a given source ('tournament' | 'season'),
// most recent first. Shared by every admin tool that starts with "pick a
// finished game" (Video Timestamps, At-Bat Data Entry).
export default function useCompletedGames(source, { enabled = true } = {}) {
  const [games, setGames] = useState([])
  const tables = TABLES[source]

  useEffect(() => {
    if (!enabled) {
      setGames([])
      return undefined
    }

    let cancelled = false
    supabase
      .from(tables.games)
      .select('*')
      .eq('status', PLAYED_STATUS[source])
      .order('id', { ascending: false })
      .then(({ data }) => {
        if (!cancelled) setGames(data || [])
      })
    return () => { cancelled = true }
  }, [enabled, tables.games, source])

  return [games, setGames]
}
