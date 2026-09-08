import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { loadGameOddsHistory } from '../utils/oddsHistoryPersistence'

const IDLE = { status: 'idle', rows: [], error: null }

// Loads one game's recorded odds observations on demand.
//
// The history tables are an optional schema addition: on a database where the
// migration has not been applied the load reports `unavailable` and the caller
// shows that plainly. It never throws, and it never blocks betting.
//
// A generation counter guards against a slow earlier response repainting a
// newer selection — the user can expand several markets or switch games faster
// than the round trips complete.
export default function useOddsHistory({ sourceType = 'tournament', gameId = null, enabled = true } = {}) {
  const [state, setState] = useState(IDLE)
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    if (!enabled || gameId == null || gameId === '') {
      requestRef.current += 1
      setState(IDLE)
      return
    }
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setState((current) => ({ ...current, status: current.rows.length ? 'refreshing' : 'loading' }))
    try {
      const result = await loadGameOddsHistory({ supabase, sourceType, gameId })
      if (requestId !== requestRef.current) return
      setState({
        status: result.status === 'ok' ? 'ready' : result.status,
        rows: result.rows || [],
        error: result.error || null,
      })
    } catch (error) {
      if (requestId !== requestRef.current) return
      setState({ status: 'error', rows: [], error })
    }
  }, [enabled, gameId, sourceType])

  useEffect(() => {
    load()
    return () => { requestRef.current += 1 }
  }, [load])

  return { ...state, reload: load }
}
