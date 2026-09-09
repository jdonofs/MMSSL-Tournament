// Plays the automatic tracker watched and could not score.
//
// The bridge writes one row per such play (see `recordUnresolvedPlay` in
// scripts/live_tracker_bridge.mjs) carrying the batter, the pitcher, the
// inning, the pitches it saw, the runners it had on base, and any runs it
// heard announced but could not attribute. Nothing in it is counted in
// anybody's statistics: it is a durable, visible statement that something
// happened and is NOT known.
//
// This module is the other end -- how the At-Bat editor finds those plays, and
// what it stamps on the plate appearance an operator writes to answer one.
//
// THE KEY IS THE WHOLE POINT. The correction carries the SAME
// `tracker_event_key` the unresolved play had, so a bridge replaying the same
// log finds the operator's row already sitting under that key. It recognises
// `correction_source = 'operator'` and leaves the row exactly as it is --
// see `isOperatorCorrection` in scripts/tracker_scoring_persistence.mjs. That
// is what makes a correction survive a restart and a replay without being
// duplicated or silently overwritten by automatic ingestion.

export const UNRESOLVED_PLAYS_TABLE = 'tracker_unresolved_plays'

// PostgREST reports a table the schema cache has never seen as PGRST205, and
// an undefined table as 42P01. Either means this deployment has not applied
// supabase/migrations/20260908124000_tracker_unresolved_plays.sql, which is a
// different thing from "there are no unresolved plays".
export function isMissingTableError(error) {
  const code = String(error?.code || '')
  return code === 'PGRST205' || code === 'PGRST204' || code === '42P01'
    || /could not find the table|relation .* does not exist/i.test(String(error?.message || ''))
}

/**
 * Open unresolved plays for one game.
 *
 * Returns `{ rows, unavailable, error }`. `unavailable` means the table is not
 * installed; the caller shows nothing rather than an error, because a
 * deployment without the migration has no unresolved plays to show and saying
 * "failed to load" would be misleading.
 */
export async function fetchUnresolvedPlays(supabase, {
  competitionType,
  gameId,
  status = 'open',
} = {}) {
  if (gameId == null) return { rows: [], unavailable: false, error: null }
  let query = supabase.from(UNRESOLVED_PLAYS_TABLE).select('*')
    .eq('competition_type', competitionType)
    .eq('game_id', gameId)
  if (status) query = query.eq('status', status)
  const { data, error } = await query
  if (error) {
    if (isMissingTableError(error)) return { rows: [], unavailable: true, error: null }
    return { rows: [], unavailable: false, error }
  }
  const rows = (data || []).slice().sort((a, b) => (
    (Number(a.inning) || 0) - (Number(b.inning) || 0)
    || String(a.half).localeCompare(String(b.half))
    || (Number(a.preview_pa_number) || 0) - (Number(b.preview_pa_number) || 0)
  ))
  return { rows, unavailable: false, error: null }
}

/**
 * The columns that mark a plate appearance as an operator's answer.
 *
 * `correction_source` is read by the bridge, not just by people: it is the
 * flag that stops journal replay from restating the row.
 */
export function operatorCorrectionFields(unresolved, { userId = null, at = new Date() } = {}) {
  if (!unresolved) return {}
  return {
    tracker_event_key: unresolved.tracker_event_key,
    // Kept even though the tracker never determined a result for it: it is how
    // postgame tracking ingestion joins this plate appearance to the 60 Hz
    // play, and losing it would leave the corrected at-bat with no fielding.
    ...(unresolved.tracker_contact_seq == null
      ? {} : { tracker_contact_seq: unresolved.tracker_contact_seq }),
    correction_source: 'operator',
    corrected_at: at.toISOString(),
    ...(userId ? { corrected_by: userId } : {}),
  }
}

/**
 * Close an unresolved play against the plate appearance that answered it.
 *
 * Deliberately separate from writing the plate appearance: the row is only
 * marked resolved once the scoring record it points at actually exists, so a
 * failed save leaves the gap visible instead of closing it over nothing.
 */
export async function markUnresolvedPlayResolved(supabase, {
  id,
  paId,
  note = null,
  resolvedBy = null,
  status = 'resolved',
} = {}) {
  const { error } = await supabase.from(UNRESOLVED_PLAYS_TABLE).update({
    status,
    resolved_pa_id: paId ?? null,
    resolved_at: new Date().toISOString(),
    ...(resolvedBy ? { resolved_by: resolvedBy } : {}),
    resolution_note: note,
    updated_at: new Date().toISOString(),
  }).eq('id', id)
  return { error: error && !isMissingTableError(error) ? error : null }
}

/** A one-line description of what the tracker saw, for the operator's list. */
export function describeUnresolvedPlay(row) {
  if (!row) return ''
  const where = `${row.half === 'bottom' ? 'Bot' : 'Top'} ${row.inning ?? '?'}`
  const pitches = row.evidence?.pitches?.length || 0
  const runs = row.evidence?.observed_runs?.length || 0
  const parts = [
    `${where}: ${row.batter_name || 'unknown batter'} vs ${row.pitcher_name || 'unknown pitcher'}`,
    pitches ? `${pitches} pitch${pitches === 1 ? '' : 'es'} seen` : 'no pitches recorded',
  ]
  // The runs matter more than anything else in this line: an unresolved play
  // that had a run announced on it is why a game's run rows can be short of
  // its scoreboard.
  if (runs) parts.push(`${runs} run${runs === 1 ? '' : 's'} announced and NOT recorded`)
  return parts.join(' · ')
}

/** Runners the tracker had on base before the play, as editor-shaped entries. */
export function runnersBeforeFromEvidence(row) {
  const before = row?.evidence?.runners_before
  if (!before) return null
  const asRunner = (value) => (value && value.characterId != null
    ? { characterId: value.characterId, playerId: value.playerId ?? null } : null)
  return {
    first: asRunner(before.first),
    second: asRunner(before.second),
    third: asRunner(before.third),
  }
}

/**
 * Where in the game's own order the answer to this play belongs.
 *
 * NOT AT THE END. Half-innings in this app are derived from the running out
 * count (src/utils/trackerGameState.js `deriveGameStateAtIndex`), not from the
 * `inning` column -- so a fifth-inning plate appearance appended after the
 * ninth both takes its own context from the end of the game and, once it
 * carries outs, shifts the derived inning of every at-bat after it. The
 * unresolved row says which half-inning it was, and its evidence says how many
 * outs there were; the slot is the first index where the game's own derivation
 * agrees with both.
 *
 * `deriveAt(index)` is passed in rather than imported so this stays a pure
 * function over the editor's own derivation.
 */
export function correctionInsertionIndex({ unresolved, paCount, deriveAt }) {
  const wantInning = Number(unresolved?.inning)
  if (!Number.isFinite(wantInning)) return paCount
  const wantTop = unresolved?.half !== 'bottom'
  const wantOuts = Number(unresolved?.evidence?.outs_before_pa)
  let halfInningMatch = null
  for (let index = 0; index <= paCount; index++) {
    const state = deriveAt(index)
    if (!state) continue
    if (Number(state.inning) !== wantInning || Boolean(state.isTop) !== wantTop) continue
    if (halfInningMatch == null) halfInningMatch = index
    // The out count is the only evidence that places a play WITHIN a
    // half-inning, and it is real evidence: the bridge recorded what it had
    // seen before the play it could not score.
    if (!Number.isFinite(wantOuts) || Number(state.outsInHalf) === wantOuts) return index
  }
  return halfInningMatch == null ? paCount : halfInningMatch
}

/**
 * The historical context an operator is answering in, from the play's own
 * evidence where there is any and from the game's derivation where there is not.
 *
 * The batter, the pitcher, the pitches and the runners are what the tracker DID
 * see and are preserved. The result is not evidence and is never filled in --
 * that is the whole reason this row exists.
 */
export function correctionContext(unresolved, derivedAtSlot) {
  if (!unresolved || !derivedAtSlot) return null
  const runners = runnersBeforeFromEvidence(unresolved)
  const wantInning = Number(unresolved.inning)
  const wantTop = unresolved.half ? unresolved.half !== 'bottom' : derivedAtSlot.isTop
  // THE HALF-INNING IS NOT OVERRIDDEN, IT IS AGREED WITH -- OR REPORTED.
  // inning, isTop, the batting and pitching teams and both lineups all come out
  // of the same derivation, so writing one of them over the top would produce a
  // page reading "Top 5" with the ninth inning's lineup in it. The slot is
  // chosen so the derivation already agrees (correctionInsertionIndex); when no
  // slot can agree -- the game's recorded outs cannot place this play -- the
  // derivation stands and the disagreement is stated rather than papered over.
  const matchesEvidence = (!Number.isFinite(wantInning) || Number(derivedAtSlot.inning) === wantInning)
    && Boolean(derivedAtSlot.isTop) === Boolean(wantTop)
  return {
    ...derivedAtSlot,
    // The runners are a straight observation and cost nothing to prefer: the
    // derivation is reconstructing them from a game missing this very play.
    ...(runners ? { runnersBefore: runners } : {}),
    matchesEvidence,
    evidenceHalfLabel: Number.isFinite(wantInning)
      ? `${wantTop ? 'Top' : 'Bot'} ${wantInning}` : null,
  }
}

/** The pitches the tracker saw, as editor-shaped draft rows. */
export function draftPitchesFromEvidence(unresolved) {
  const seen = unresolved?.evidence?.pitches
  if (!Array.isArray(seen) || !seen.length) return []
  return seen.map((pitch, index) => ({
    // The tracker records that a pitch happened and what the count was; it does
    // not always record what the pitch DID, and a blank result is left blank
    // rather than guessed into a strike.
    result: pitch.result || 'strike_unknown',
    pitch_type: pitch.type || null,
    is_star_pitch: Boolean(pitch.is_star_pitch),
    is_star_swing: Boolean(pitch.is_star_swing),
    pitch_number_pa: index + 1,
    count_balls_before: pitch.balls_before ?? null,
    count_strikes_before: pitch.strikes_before ?? null,
  }))
}

export const CORRECTION_RPC = 'tracker_record_corrected_plate_appearance'

/**
 * Write the correction and close the gap in one transaction.
 *
 * Deliberately one call. The editor used to insert the plate appearance, then
 * its pitches, then its runs, then mark the play resolved -- and a failure
 * after the first step left a plate appearance holding the unresolved play's
 * tracker_event_key, which the unique index then used to refuse every retry.
 * The function completes its own half-written attempt instead.
 */
export async function recordUnresolvedPlayCorrection(supabase, {
  competitionType,
  unresolved,
  pa,
  pitches = [],
  runs = [],
  paNumber = null,
  resolvedBy = null,
  note = null,
} = {}) {
  const { data, error } = await supabase.rpc(CORRECTION_RPC, {
    p_competition_type: competitionType,
    p_unresolved_id: unresolved.id,
    p_pa: pa,
    p_pitches: pitches,
    p_runs: runs,
    p_pa_number: paNumber,
    p_resolved_by: resolvedBy,
    p_note: note,
  })
  if (error) return { data: null, error }
  return { data, error: null }
}
