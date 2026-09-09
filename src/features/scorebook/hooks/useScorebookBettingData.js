import { useEffect, useState } from 'react'
import { supabase } from '../../../supabaseClient'

export default function useScorebookBettingData({ selectedGameId, betsTable }) {
  const [gameBets, setGameBets] = useState([])
  const [oddsEngineWeights, setOddsEngineWeights] = useState(null)

  // Load the game-history-calibrated weights and keep them live so the win
  // probability model improves mid-session as other games get resolved.
  useEffect(() => {
    let active = true
    supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle().then(({ data }) => {
      if (active && data) setOddsEngineWeights(data)
    })
    const channel = supabase
      .channel(`scorebook-odds-weights-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'odds_engine_weights' }, async () => {
        const { data } = await supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle()
        if (active && data) setOddsEngineWeights(data)
      })
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [])

  // Load currently-open bets for this game so live odds recalculation can
  // apply volume-based line movement and liability caps, same as BettingTab.
  useEffect(() => {
    if (!selectedGameId || !betsTable) {
      setGameBets([])
      return
    }
    let cancelled = false
    async function load() {
      const { data } = await supabase.from(betsTable).select('*').eq('game_id', selectedGameId)
      if (!cancelled) setGameBets(data || [])
    }
    load()
    const channel = supabase
      .channel(`sb-bets-${selectedGameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: betsTable, filter: `game_id=eq.${selectedGameId}` }, load)
      .subscribe()
    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [selectedGameId, betsTable])

  return { gameBets, oddsEngineWeights }
}
