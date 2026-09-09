import { hasAnyActiveRunners, normalizeLiveRunners } from '../../../utils/runnerAssignment.js'
import { sanitizeRunnersForOffense } from './runnerState.js'

export function buildLiveGameStateSnapshot({
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
  updatedAt = new Date().toISOString(),
}) {
  const normalizedRunners = sanitizeRunnersForOffense(
    normalizeLiveRunners(runners),
    offense,
  )
  const normalizedRunnersHistory = runnersHistory.map((entry) => sanitizeRunnersForOffense(
    normalizeLiveRunners(entry),
    offense,
  ))
  const hasLiveContext = hasAnyActiveRunners(normalizedRunners)
    || outsInHalf > 0
    || balls > 0
    || strikes > 0
    || paPitchRows.length > 0
    || Boolean(pendingPA)
    || Boolean(pitchActionSheet)
    || Boolean(pendingPitchEvent)
    || Boolean(inPlayState)
    || Boolean(rbiOverlay)
    || starPitchActive
    || starHitPending
    || starHitConnected
    || normalizedRunnersHistory.length > 0

  return {
    hasLiveContext,
    liveState: hasLiveContext
      ? {
          inning: offense.inning,
          isTop: offense.isTop,
          outsInHalf,
          balls,
          strikes,
          pitchNumber,
          pitcherStintId: currentPitcherStint?.id ?? null,
          paNumber: activePaNumber,
          batterCharacterId: currentBatter.character_id,
          batterPlayerId: currentBatter.player_id,
          onDeckCharacterId: onDeckBatter?.character_id ?? null,
          onDeckPlayerId: onDeckBatter?.player_id ?? null,
          runners: normalizedRunners,
          runnersHistory: normalizedRunnersHistory,
          paPitchRows,
          starHitUsed,
          starHitPending,
          starHitConnected,
          starPitchActive,
          updatedAt,
        }
      : null,
  }
}

export function hasMeaningfulLiveStatePayload(liveState = null) {
  if (!liveState || typeof liveState !== 'object' || Array.isArray(liveState)) return false
  const hasTrackedValue = [
    'inning',
    'isTop',
    'is_top',
    'outsInHalf',
    'outs_in_half',
    'balls',
    'strikes',
    'pitchNumber',
    'pitch_number',
    'pitcherStintId',
    'pitcher_stint_id',
    'paNumber',
    'pa_number',
    'batterCharacterId',
    'batter_character_id',
    'batterPlayerId',
    'batter_player_id',
    'onDeckCharacterId',
    'on_deck_character_id',
    'onDeckPlayerId',
    'on_deck_player_id',
    'pitcherCharacterId',
    'pitcher_character_id',
    'pitcherPlayerId',
    'pitcher_player_id',
    'updatedAt',
    'updated_at',
  ].some((key) => liveState[key] != null)

  return hasTrackedValue || hasAnyActiveRunners(normalizeLiveRunners(liveState.runners))
}

export function normalizeLiveState(liveState = null) {
  if (!hasMeaningfulLiveStatePayload(liveState)) return null
  return {
    inning: Number(liveState.inning || 1),
    isTop: Boolean(liveState.isTop ?? liveState.is_top),
    outsInHalf: Number((liveState.outsInHalf ?? liveState.outs_in_half) || 0),
    balls: Number(liveState.balls || 0),
    strikes: Number(liveState.strikes || 0),
    pitchNumber: Number((liveState.pitchNumber ?? liveState.pitch_number) || 0),
    pitcherStintId: liveState.pitcherStintId ?? liveState.pitcher_stint_id ?? null,
    paNumber: Number((liveState.paNumber ?? liveState.pa_number) || 0),
    batterCharacterId: liveState.batterCharacterId ?? liveState.batter_character_id ?? null,
    batterPlayerId: liveState.batterPlayerId ?? liveState.batter_player_id ?? null,
    onDeckCharacterId: liveState.onDeckCharacterId ?? liveState.on_deck_character_id ?? null,
    onDeckPlayerId: liveState.onDeckPlayerId ?? liveState.on_deck_player_id ?? null,
    // Only ever populated by the tracker bridge — manual scoring tracks the
    // current pitcher via a real pitching_stints row instead.
    pitcherCharacterId: liveState.pitcherCharacterId ?? liveState.pitcher_character_id ?? null,
    pitcherPlayerId: liveState.pitcherPlayerId ?? liveState.pitcher_player_id ?? null,
    runners: normalizeLiveRunners(liveState.runners),
    // The baserunner undo stack has to survive a reload along with the active
    // diamond so the first undo in a new browser session restores both.
    runnersHistory: Array.isArray(liveState.runnersHistory) ? liveState.runnersHistory.map(normalizeLiveRunners) : [],
    // Active pitches are not database rows until the PA completes, so retain
    // the serializable in-progress sequence in the game snapshot.
    paPitchRows: Array.isArray(liveState.paPitchRows) ? liveState.paPitchRows : [],
    starHitUsed: Boolean(liveState.starHitUsed),
    starHitPending: Boolean(liveState.starHitPending),
    starHitConnected: Boolean(liveState.starHitConnected),
    starPitchActive: Boolean(liveState.starPitchActive),
    updatedAt: liveState.updatedAt ?? liveState.updated_at ?? null,
  }
}

export function getPersistedLiveStateValue(liveState = null, requireNonNullObject = false) {
  if (liveState && typeof liveState === 'object') return liveState
  return requireNonNullObject ? {} : null
}

export function serializeLiveStateForComparison(liveState = null) {
  const normalized = normalizeLiveState(liveState)
  if (!normalized) return ''
  return JSON.stringify({
    ...normalized,
    updatedAt: null,
  })
}
