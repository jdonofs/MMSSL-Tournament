import { computePendingState, normalizeStoredRunnerAssignments } from '../../../utils/runnerAssignment.js'

export function runnerAssignmentsForSave({ assignments = null, result, runners = {}, batter, cancelRuns = false }) {
  let resolved = normalizeStoredRunnerAssignments(assignments)
  if (!resolved && batter) {
    const entries = [
      { id: 'batter', runner: batter, origin: 'plate', isBatter: true },
      ...['first', 'second', 'third'].filter((base) => runners[base]).map((base) => ({
        id: base, runner: runners[base], origin: base, isBatter: false,
      })),
    ]
    if (['HR', 'IPHR'].includes(result)) resolved = entries.map((entry) => ({ ...entry, destination: 'home' }))
    else if (result === 'K') resolved = entries.map((entry) => ({ ...entry, destination: entry.isBatter ? 'out' : entry.origin }))
    else if (['BB', 'HBP'].includes(result)) resolved = computePendingState(result, runners, batter).assignments
  }
  // A force third out cancels runs, not the identities of the stranded
  // runners. Keep those participants so a later replay can distinguish them.
  return resolved?.map((entry) => ({
    ...entry,
    destination: cancelRuns && entry.destination === 'home' && !entry.isBatter ? entry.origin : entry.destination,
  })) ?? null
}

export function normalizePa(pa) {
  if (!pa || pa.trajectory !== 'B') return pa
  return { ...pa, trajectory: 'F' }
}

// The number a new plate appearance takes. Highest + 1, not count + 1: after a
// deletion the count reuses a number an existing row already holds, and
// (game_id, pa_number) is unique.
export function nextPaNumber(pas = []) {
  return pas.reduce((max, pa) => Math.max(max, Number(pa?.pa_number) || 0), 0) + 1
}

export function stripDbManagedFields(row = {}) {
  const next = { ...row }
  delete next.id
  delete next.created_at
  // Added only for display/analytics, not stored in either PA source table.
  delete next.hit_tracking_source
  return next
}

export function didRunEventsScoreBatter(runEvents = [], batter = null) {
  if (!batter) return false
  return runEvents.some((run) => (
    String(run.playerId) === String(batter.player_id)
    && String(run.characterId) === String(batter.character_id)
  ))
}

export function normalizeSavedPaRunScored(result, runScored, runEvents = [], batter = null) {
  return Boolean(runScored) || result === 'HR' || result === 'IPHR' || didRunEventsScoreBatter(runEvents, batter)
}

// Bulk-inserted pitches can share timestamps; the persisted game sequence is
// authoritative, with created_at retained only for legacy rows.
export function comparePitchOrder(a, b) {
  const diff = Number(a.pitch_number_game || 0) - Number(b.pitch_number_game || 0)
  if (diff !== 0) return diff
  return new Date(a.created_at) - new Date(b.created_at)
}

export function buildPitchRowsForSave({
  pitchRows = [],
  gameId,
  paId,
  currentPitcherName = '',
  currentPitcherStint,
  playersById = {},
  batterName = '',
  inning,
  isTop,
  pitchNumber = 0,
}) {
  return pitchRows.map((pitch, index) => ({
    game_id: gameId,
    pa_id: paId,
    pitcher_id: pitch.pitcherId || currentPitcherName || '',
    pitcher_player: pitch.pitcherPlayer || playersById[pitch.pitcherPlayerId || currentPitcherStint.player_id]?.name || '',
    batter_id: batterName || '',
    inning,
    half: isTop ? 'top' : 'bottom',
    pitch_number_pa: pitch.pitchNumberPa || index + 1,
    pitch_number_game: pitch.pitchNumberGame || pitchNumber,
    is_star_pitch: Boolean(pitch.pitch?.is_star_pitch),
    is_star_swing: Boolean(pitch.pitch?.is_star_swing),
    result: pitch.pitch?.result,
    count_balls_before: pitch.pitch?.count_balls_before ?? 0,
    count_strikes_before: pitch.pitch?.count_strikes_before ?? 0,
    count_balls_after: pitch.pitch?.count_balls_after ?? 0,
    count_strikes_after: pitch.pitch?.count_strikes_after ?? 0,
  }))
}

export function buildRunRowsForSave({
  runEvents = [],
  gameId,
  paId,
  inning,
  isTop,
  currentPitcherStint,
}) {
  return runEvents.map((run) => ({
    game_id: gameId,
    pa_id: paId,
    inning,
    half: isTop ? 'top' : 'bottom',
    scoring_player_id: run.playerId,
    scoring_character_id: run.characterId,
    charged_to_pitcher_id: run.chargedToPitcherId ?? currentPitcherStint.character_id,
    charged_to_pitcher_player_id: run.chargedToPitcherPlayerId ?? currentPitcherStint.player_id,
    is_earned_run: run.isEarnedRun !== false,
  }))
}
