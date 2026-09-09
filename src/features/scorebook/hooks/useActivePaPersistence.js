import { useEffect, useRef, useState } from 'react'
import { getActivePaStorageKey } from '../domain/runnerState'

export default function useActivePaPersistence({
  selectedGameId,
  currentActivePaScope,
  activePaNumber,
  currentPitcherPitchRows,
  currentPitcherStorageKey,
  currentPitcherStintId,
  restorePitchState,
  selectedGameLiveState,
  currentBatterPlayerId,
  currentBatterCharacterId,
  deferRealtimeUntilRef,
  balls,
  strikes,
  pitchNumber,
  paPitchRows,
  paPitchRowsRef,
  starHitUsed,
  starHitPending,
  starHitConnected,
  starPitchActive,
  pitchActionSheet,
  pendingPitchEvent,
  inPlayState,
  rbiOverlay,
  setStarPitchActive,
  setPitchActionSheet,
  setPendingPitchEvent,
  setPaPitchRows,
  setInPlayState,
  setRbiOverlay,
  setStarHitUsed,
  setStarHitPending,
  setStarHitConnected,
}) {
  const [activePaLoadedScope, setActivePaLoadedScope] = useState(null)
  const localActivePaRestoreRef = useRef(null)
  const lastRestoredPitcherStorageKeyRef = useRef(null)

  useEffect(() => {
    if (!selectedGameId || !currentActivePaScope) {
      setActivePaLoadedScope(null)
      return
    }
    const storageKey = getActivePaStorageKey(selectedGameId)
    try {
      const localRestore = localActivePaRestoreRef.current
      const shouldApplyLocalRestore = localRestore
        && String(localRestore.gameId) === String(selectedGameId)
        && Number(localRestore.paNumber) === Number(activePaNumber)
        && String(localRestore.batterPlayerId) === String(currentBatterPlayerId)
        && String(localRestore.batterCharacterId) === String(currentBatterCharacterId)
      if (shouldApplyLocalRestore) {
        const restoredRows = Array.isArray(localRestore.paPitchRows) ? localRestore.paPitchRows : []
        const storedSnapshot = {
          scope: currentActivePaScope,
          pitcherKey: currentPitcherStorageKey,
          balls: Number(localRestore.balls || 0),
          strikes: Number(localRestore.strikes || 0),
          pitchNumber: Number(localRestore.pitchNumber || 0),
          paPitchRows: restoredRows,
          starHitUsed: false,
          starHitPending: false,
          starHitConnected: false,
          starPitchActive: false,
          pitchActionSheet: null,
          pendingPitchEvent: null,
          inPlayState: null,
          rbiOverlay: null,
        }
        sessionStorage.setItem(storageKey, JSON.stringify(storedSnapshot))
        setStarPitchActive(false)
        setPitchActionSheet(null)
        setPendingPitchEvent(null)
        paPitchRowsRef.current = restoredRows
        setPaPitchRows(restoredRows)
        setInPlayState(null)
        setRbiOverlay(null)
        setStarHitUsed(false)
        setStarHitPending(false)
        setStarHitConnected(false)
        restorePitchState(storedSnapshot)
        localActivePaRestoreRef.current = null
        setActivePaLoadedScope(currentActivePaScope)
        return
      }
      // Keep a just-recorded local pitch authoritative during the short
      // realtime/debounced-publish window.
      if (
        activePaLoadedScope === currentActivePaScope
        && Date.now() < deferRealtimeUntilRef.current
      ) return
      const raw = sessionStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : null
      const withinLocalUndoHold = Date.now() < deferRealtimeUntilRef.current
      const shouldHydrateFromLiveState = !withinLocalUndoHold && selectedGameLiveState
        && (!selectedGameLiveState.batterPlayerId || String(selectedGameLiveState.batterPlayerId) === String(currentBatterPlayerId))
        && (!selectedGameLiveState.batterCharacterId || String(selectedGameLiveState.batterCharacterId) === String(currentBatterCharacterId))
      const committedPitchNumber = Number(currentPitcherPitchRows.length)
      const liveStateHasActivePitchCount = Number(selectedGameLiveState?.balls || 0) > 0
        || Number(selectedGameLiveState?.strikes || 0) > 0
      const isPitcherChangeTransition = lastRestoredPitcherStorageKeyRef.current !== null
        && lastRestoredPitcherStorageKeyRef.current !== currentPitcherStorageKey
      const shouldHydratePitchNumberFromLiveState = shouldHydrateFromLiveState
        && !isPitcherChangeTransition
        && (!selectedGameLiveState.pitcherStintId || String(selectedGameLiveState.pitcherStintId) === String(currentPitcherStintId))
        && liveStateHasActivePitchCount
      lastRestoredPitcherStorageKeyRef.current = currentPitcherStorageKey
      const livePitchNumber = Math.max(
        committedPitchNumber,
        Number(selectedGameLiveState?.pitchNumber ?? committedPitchNumber),
      )
      if (parsed?.scope === currentActivePaScope) {
        const shouldReuseStoredPitchCount = !shouldHydratePitchNumberFromLiveState && String(parsed.pitcherKey || '') === String(currentPitcherStorageKey)
        setStarPitchActive(Boolean(parsed.starPitchActive))
        setPitchActionSheet(parsed.pitchActionSheet || null)
        setPendingPitchEvent(parsed.pendingPitchEvent || null)
        const storedRows = Array.isArray(parsed.paPitchRows) ? parsed.paPitchRows : []
        paPitchRowsRef.current = storedRows
        setPaPitchRows(storedRows)
        setInPlayState(parsed.inPlayState || null)
        setRbiOverlay(parsed.rbiOverlay || null)
        setStarHitUsed(Boolean(parsed.starHitUsed))
        setStarHitPending(Boolean(parsed.starHitPending))
        setStarHitConnected(Boolean(parsed.starHitConnected))
        restorePitchState({
          balls: shouldHydrateFromLiveState ? Number(selectedGameLiveState.balls || 0) : Number(parsed.balls || 0),
          strikes: shouldHydrateFromLiveState ? Number(selectedGameLiveState.strikes || 0) : Number(parsed.strikes || 0),
          pitchNumber: shouldHydratePitchNumberFromLiveState
            ? livePitchNumber
            : shouldReuseStoredPitchCount
              ? Math.max(committedPitchNumber, Number(parsed.pitchNumber ?? committedPitchNumber))
              : committedPitchNumber,
        })
      } else {
        setStarPitchActive(false)
        setPitchActionSheet(null)
        setPendingPitchEvent(null)
        const liveRows = shouldHydrateFromLiveState && Array.isArray(selectedGameLiveState.paPitchRows)
          ? selectedGameLiveState.paPitchRows
          : []
        paPitchRowsRef.current = liveRows
        setPaPitchRows(liveRows)
        setInPlayState(null)
        setRbiOverlay(null)
        setStarHitUsed(shouldHydrateFromLiveState && Boolean(selectedGameLiveState.starHitUsed))
        setStarHitPending(shouldHydrateFromLiveState && Boolean(selectedGameLiveState.starHitPending))
        setStarHitConnected(shouldHydrateFromLiveState && Boolean(selectedGameLiveState.starHitConnected))
        setStarPitchActive(shouldHydrateFromLiveState && Boolean(selectedGameLiveState.starPitchActive))
        restorePitchState({
          balls: shouldHydrateFromLiveState ? Number(selectedGameLiveState.balls || 0) : 0,
          strikes: shouldHydrateFromLiveState ? Number(selectedGameLiveState.strikes || 0) : 0,
          pitchNumber: shouldHydratePitchNumberFromLiveState ? livePitchNumber : committedPitchNumber,
        })
        if (!shouldHydrateFromLiveState) sessionStorage.removeItem(storageKey)
      }
    } catch {
      setStarPitchActive(false)
      setPitchActionSheet(null)
      setPendingPitchEvent(null)
      paPitchRowsRef.current = []
      setPaPitchRows([])
      setInPlayState(null)
      setRbiOverlay(null)
      setStarHitUsed(false)
      setStarHitPending(false)
      setStarHitConnected(false)
      restorePitchState({
        balls: 0,
        strikes: 0,
        pitchNumber: Number(currentPitcherPitchRows.length),
      })
    }
    setActivePaLoadedScope(currentActivePaScope)
  }, [selectedGameId, currentActivePaScope, activePaLoadedScope, activePaNumber, currentPitcherPitchRows.length, currentPitcherStorageKey, currentPitcherStintId, restorePitchState, selectedGameLiveState, currentBatterPlayerId, currentBatterCharacterId, deferRealtimeUntilRef, paPitchRowsRef, setInPlayState, setPaPitchRows, setPendingPitchEvent, setPitchActionSheet, setRbiOverlay, setStarHitConnected, setStarHitPending, setStarHitUsed, setStarPitchActive])

  useEffect(() => {
    if (!selectedGameId || !currentActivePaScope) return
    if (activePaLoadedScope !== currentActivePaScope) return
    const storageKey = getActivePaStorageKey(selectedGameId)
    try {
      if (
        !paPitchRows.length
        && !starHitUsed
        && !starHitConnected
        && !starPitchActive
        && !pitchActionSheet
        && !pendingPitchEvent
        && !inPlayState
        && !rbiOverlay
      ) {
        sessionStorage.removeItem(storageKey)
        return
      }
      sessionStorage.setItem(storageKey, JSON.stringify({
        scope: currentActivePaScope,
        pitcherKey: currentPitcherStorageKey,
        balls,
        strikes,
        pitchNumber,
        paPitchRows,
        starHitUsed,
        starHitPending,
        starHitConnected,
        starPitchActive,
        pitchActionSheet,
        pendingPitchEvent,
        inPlayState,
        rbiOverlay,
      }))
    } catch {}
  }, [selectedGameId, currentActivePaScope, activePaLoadedScope, balls, strikes, pitchNumber, paPitchRows, starHitUsed, starHitPending, starHitConnected, starPitchActive, pitchActionSheet, pendingPitchEvent, inPlayState, rbiOverlay, currentPitcherStorageKey])

  return localActivePaRestoreRef
}
