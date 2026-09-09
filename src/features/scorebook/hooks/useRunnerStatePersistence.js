import { useEffect, useState } from 'react'
import { normalizeLiveRunners } from '../../../utils/runnerAssignment'
import {
  getRunnerHistoryStorageKey,
  getRunnerStateStorageKey,
  sanitizeRunnersForOffense,
} from '../domain/runnerState'

export default function useRunnerStatePersistence({
  selectedGameId,
  currentHalfIdx,
  offense,
  selectedGame,
  selectedGameLiveState,
  runners,
  setRunners,
  runnersHistory,
  setRunnersHistory,
}) {
  const [runnerStateLoadedScope, setRunnerStateLoadedScope] = useState(null)

  useEffect(() => {
    if (!selectedGameId) return
    // Wait for the game itself (and thus `offense`) to finish loading before
    // deciding what to hydrate. Otherwise the still-null offense can lock in
    // an empty runner state for the scope after a remount.
    if (!selectedGame || !offense) return
    if (runnerStateLoadedScope === `${selectedGameId}:${currentHalfIdx}`) return
    const runnerKey = getRunnerStateStorageKey(selectedGameId, currentHalfIdx)
    const historyKey = getRunnerHistoryStorageKey(selectedGameId, currentHalfIdx)
    try {
      const stored = sessionStorage.getItem(runnerKey)
      const storedHistory = sessionStorage.getItem(historyKey)
      const parsed = stored ? JSON.parse(stored) : null
      const parsedHistory = storedHistory ? JSON.parse(storedHistory) : []
      const storedBattingPlayerId = parsed?.runners ? parsed.battingPlayerId : null
      const storedRunners = parsed?.runners ?? parsed
      const rawHistory = Array.isArray(parsedHistory?.history) ? parsedHistory.history : (Array.isArray(parsedHistory) ? parsedHistory : [])
      const historyBattingPlayerId = Array.isArray(parsedHistory?.history) ? parsedHistory.battingPlayerId : null
      const normalizedRunners = {
        first: storedRunners?.first || null,
        second: storedRunners?.second || null,
        third: storedRunners?.third || null,
      }
      const shouldTrustStoredRunners = !storedBattingPlayerId || String(storedBattingPlayerId) === String(offense?.battingPlayerId)
      const shouldTrustStoredHistory = !historyBattingPlayerId || String(historyBattingPlayerId) === String(offense?.battingPlayerId)
      const shouldTrustLiveStateRunners = selectedGameLiveState
        && (!selectedGameLiveState.batterPlayerId || String(selectedGameLiveState.batterPlayerId) === String(offense?.battingPlayerId))
      const fallbackRunners = shouldTrustLiveStateRunners
        ? normalizeLiveRunners(selectedGameLiveState.runners)
        : { first: null, second: null, third: null }
      const useStoredRunners = shouldTrustStoredRunners && stored && !shouldTrustLiveStateRunners
      setRunners(sanitizeRunnersForOffense(
        useStoredRunners ? normalizedRunners : fallbackRunners,
        offense,
      ))
      // Prefer the same server-side snapshot as the runner fallback so the
      // first Undo after a fresh session retains its prior runner stack.
      const fallbackHistory = shouldTrustLiveStateRunners && Array.isArray(selectedGameLiveState?.runnersHistory)
        ? selectedGameLiveState.runnersHistory
        : []
      const useStoredHistory = shouldTrustStoredHistory && storedHistory && !shouldTrustLiveStateRunners
      setRunnersHistory(
        (useStoredHistory ? rawHistory : fallbackHistory).map((entry) => sanitizeRunnersForOffense(entry, offense))
      )
    } catch {
      setRunners({ first: null, second: null, third: null })
      setRunnersHistory([])
    }
    setRunnerStateLoadedScope(`${selectedGameId}:${currentHalfIdx}`)
  }, [selectedGameId, currentHalfIdx, offense, selectedGame, selectedGameLiveState, runnerStateLoadedScope, setRunners, setRunnersHistory])

  useEffect(() => {
    if (!selectedGameId || runnerStateLoadedScope !== `${selectedGameId}:${currentHalfIdx}`) return
    const runnerKey = getRunnerStateStorageKey(selectedGameId, currentHalfIdx)
    const historyKey = getRunnerHistoryStorageKey(selectedGameId, currentHalfIdx)
    try {
      sessionStorage.setItem(runnerKey, JSON.stringify({
        battingPlayerId: offense?.battingPlayerId || null,
        runners: sanitizeRunnersForOffense(runners, offense),
        updatedAt: new Date().toISOString(),
      }))
      sessionStorage.setItem(historyKey, JSON.stringify({
        battingPlayerId: offense?.battingPlayerId || null,
        history: runnersHistory.map((entry) => sanitizeRunnersForOffense(entry, offense)),
      }))
    } catch {}
  }, [selectedGameId, currentHalfIdx, runnerStateLoadedScope, runners, runnersHistory, offense])

  return runnerStateLoadedScope
}
