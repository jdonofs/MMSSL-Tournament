import { useEffect, useRef } from 'react'
import { supabase } from '../../../supabaseClient'
import {
  buildLiveGameStateSnapshot,
  getPersistedLiveStateValue,
  serializeLiveStateForComparison,
} from '../domain/liveState'

export default function useLiveGamePersistence({
  selectedGame,
  selectedGameId,
  selectedGameLiveState,
  canEditScorebook,
  isGameComplete,
  isSeasonGame,
  gamesTable,
  accessToken,
  offense,
  currentHalfIdx,
  runnerStateLoadedScope,
  currentBatter,
  onDeckBatter,
  runners,
  runnersHistory,
  outsInHalf,
  balls,
  strikes,
  pitchNumber,
  currentPitcherStint,
  activePaNumber,
  paPitchRows,
  pendingPA,
  pitchActionSheet,
  pendingPitchEvent,
  inPlayState,
  rbiOverlay,
  starPitchActive,
  starHitUsed,
  starHitPending,
  starHitConnected,
  gamePaCount,
}) {
  const lastPublishedLiveStateRef = useRef('')
  const pendingLiveStateRef = useRef(null)
  const liveStatePublishTimeoutRef = useRef(null)
  const liveStatePublishSeqRef = useRef(0)

  useEffect(() => () => {
    if (liveStatePublishTimeoutRef.current) clearTimeout(liveStatePublishTimeoutRef.current)
  }, [])

  useEffect(() => {
    lastPublishedLiveStateRef.current = serializeLiveStateForComparison(selectedGame?.live_state)
  }, [selectedGame?.id, selectedGame?.live_state])

  useEffect(() => {
    if (!selectedGame || !canEditScorebook || isGameComplete || !offense || !currentBatter) return undefined
    // Do not publish until runner hydration is complete for this half-inning;
    // otherwise an empty initial render can overwrite real baserunners.
    if (runnerStateLoadedScope !== `${selectedGameId}:${currentHalfIdx}`) return undefined

    const { hasLiveContext, liveState: nextLiveState } = buildLiveGameStateSnapshot({
      offense,
      currentBatter,
      onDeckBatter,
      runners,
      runnersHistory,
      outsInHalf,
      balls,
      strikes,
      pitchNumber,
      currentPitcherStint,
      activePaNumber,
      paPitchRows,
      pendingPA,
      pitchActionSheet,
      pendingPitchEvent,
      inPlayState,
      rbiOverlay,
      starPitchActive,
      starHitUsed,
      starHitPending,
      starHitConnected,
    })
    const nextSerialized = serializeLiveStateForComparison(nextLiveState)
    const targetStatus = isSeasonGame ? 'in_progress' : 'active'
    const shouldPromoteStatus = ['pending', 'scheduled'].includes(String(selectedGame.status || '')) && (hasLiveContext || gamePaCount > 0)
    const shouldClearLiveState = !hasLiveContext && Boolean(selectedGameLiveState)

    if (nextSerialized === lastPublishedLiveStateRef.current && !shouldPromoteStatus && !shouldClearLiveState) {
      return undefined
    }

    const updatePayload = {}
    if (nextSerialized !== lastPublishedLiveStateRef.current || shouldClearLiveState) {
      // Both live providers enforce NOT NULL on live_state.
      updatePayload.live_state = getPersistedLiveStateValue(nextLiveState, true)
    }
    if (shouldPromoteStatus) updatePayload.status = targetStatus
    if (!Object.keys(updatePayload).length) return undefined

    pendingLiveStateRef.current = { gameId: selectedGame.id, updatePayload }
    lastPublishedLiveStateRef.current = nextSerialized

    // Collapse rapid pitch changes into one final write so responses cannot
    // resolve out of order and leave a stale count.
    if (liveStatePublishTimeoutRef.current) clearTimeout(liveStatePublishTimeoutRef.current)
    const publishSeq = ++liveStatePublishSeqRef.current
    liveStatePublishTimeoutRef.current = setTimeout(() => {
      liveStatePublishTimeoutRef.current = null
      supabase.from(gamesTable).update(updatePayload).eq('id', selectedGame.id).then(({ error }) => {
        if (liveStatePublishSeqRef.current !== publishSeq) return
        if (error) {
          lastPublishedLiveStateRef.current = serializeLiveStateForComparison(selectedGame?.live_state)
        } else if (pendingLiveStateRef.current?.gameId === selectedGame.id && pendingLiveStateRef.current?.updatePayload === updatePayload) {
          pendingLiveStateRef.current = null
        }
      })
    }, 180)

    return undefined
  }, [
    selectedGame,
    selectedGameId,
    selectedGameLiveState,
    canEditScorebook,
    isGameComplete,
    isSeasonGame,
    gamesTable,
    offense,
    currentHalfIdx,
    runnerStateLoadedScope,
    currentBatter,
    onDeckBatter,
    runners,
    runnersHistory,
    outsInHalf,
    balls,
    strikes,
    pitchNumber,
    currentPitcherStint,
    activePaNumber,
    paPitchRows,
    pendingPA,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    starPitchActive,
    starHitUsed,
    starHitPending,
    starHitConnected,
    gamePaCount,
  ])

  // Best-effort flush of an in-flight live-state write when the tab closes.
  useEffect(() => {
    const flushPendingLiveState = () => {
      const pending = pendingLiveStateRef.current
      if (!pending || !accessToken) return
      const { gameId, updatePayload } = pending
      pendingLiveStateRef.current = null
      const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/${gamesTable}?id=eq.${gameId}`
      fetch(url, {
        method: 'PATCH',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(updatePayload),
      }).catch(() => {})
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushPendingLiveState()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', flushPendingLiveState)
    window.addEventListener('beforeunload', flushPendingLiveState)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', flushPendingLiveState)
      window.removeEventListener('beforeunload', flushPendingLiveState)
    }
  }, [accessToken, gamesTable])
}
