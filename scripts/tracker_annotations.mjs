// "Something is wrong" — the operator's side of the validation console.
//
// WHAT AN ANNOTATION IS. A timestamped statement that the tracker's
// interpretation of one play does not match what the operator saw, captured
// with everything needed to investigate it later WITHOUT the game, the
// emulator, or the operator's memory. That last part is the whole design
// constraint: a flag that records "PA 17 looked wrong" is nearly worthless a
// week later, because the state that produced the interpretation is gone.
//
// So an annotation carries the complete structured payload -- the narrative,
// every clause, the joined play, the automatic warnings, the identity of the
// session and the game -- rather than a reference to it.
//
// WHAT AN ANNOTATION IS NOT. It never touches a statistic, a plate appearance,
// or a Supabase row. It is written to a JSONL file beside the capture and
// nowhere else. An operator flagging a play mid-game must not be able to
// corrupt the game's own record by doing so, and the only way to guarantee
// that is for this path to have no write access to anything else.

import fs from 'node:fs'
import path from 'node:path'

// Text is optional; a category is not. A flag with no category is an
// observation nobody can act on, and the categories are the ones that map to
// the seven separated facts the narrative keeps apart.
export const ANNOTATION_CATEGORIES = Object.freeze([
  'wrong_result',
  'wrong_player',
  'wrong_location',
  'wrong_trajectory',
  'wrong_attempt',
  'wrong_contact',
  'wrong_possession',
  'wrong_ability',
  'wrong_throw',
  'wrong_runner',
  'missing_event',
  'wrong_measurement',
  'stadium_event',
  'other',
])

export const ANNOTATION_CATEGORY_LABELS = Object.freeze({
  wrong_result: 'Wrong result',
  wrong_player: 'Wrong player',
  wrong_location: 'Wrong location',
  wrong_trajectory: 'Wrong trajectory',
  wrong_attempt: 'Wrong attempt',
  wrong_contact: 'Wrong contact',
  wrong_possession: 'Wrong possession',
  wrong_ability: 'Wrong ability',
  wrong_throw: 'Wrong throw',
  wrong_runner: 'Wrong runner',
  missing_event: 'Missing event',
  wrong_measurement: 'Wrong measurement',
  stadium_event: 'Stadium event',
  other: 'Other',
})

/**
 * Pull the structured half out of a stadium-event note.
 *
 * `scripts/next_calibration_game.mjs` has always prescribed the shape --
 * `stadium_event=<objective id>; outcome=<what happened>; control=<yes|no>` --
 * and nothing has ever read it back, so eleven labelled DK Jungle barrel and
 * flower events across two sessions exist only as English prose in `note`.
 * Counting them meant reading them. This is the missing half of that contract:
 * whatever the operator types is preserved verbatim in `note` either way, and
 * anything matching the format is ALSO recorded as fields a script can group by.
 *
 * Returns null for a note that does not use the format, which is not an error
 * -- most annotations are not stadium events.
 */
export function parseStadiumEventNote(note) {
  const text = String(note || '')
  const first = (pattern) => {
    const found = pattern.exec(text)
    return found ? found[1].trim() : null
  }
  const id = first(/\bstadium_event\s*=\s*([^;\r\n]*)/i)
  if (!id) return null
  const control = first(/\bcontrol\s*=\s*([^;\r\n]*)/i)
  return {
    objective_id: id,
    outcome: first(/\boutcome\s*=\s*([^;\r\n]*)/i),
    // A control is a deliberate negative -- a comparable play where the hazard
    // did NOT fire. Absent means "not stated", which is not the same as "no".
    is_control: control == null ? null : /^(y|yes|true|1)$/i.test(control),
  }
}

export const ANNOTATION_SCHEMA_VERSION = 4

/**
 * Build the record for one flag.
 *
 * `snapshot` is the preview snapshot the operator was looking at, so what gets
 * recorded is exactly what was on screen -- not a re-derivation that might
 * since have changed its mind.
 */
export function buildTrackerAnnotation({
  snapshot,
  categories = [],
  note = '',
  clauseId = null,
  playContactTimer = null,
  playEvidence = null,
  recordedAt = null,
} = {}) {
  const atBat = snapshot?.display_at_bat || null
  if (!atBat) return { error: 'There is no at-bat on screen to flag' }

  const clean = [...new Set(
    (Array.isArray(categories) ? categories : [categories])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )]
  const unknown = clean.filter((value) => !ANNOTATION_CATEGORIES.includes(value))
  if (unknown.length) return { error: `Unknown annotation category: ${unknown.join(', ')}` }
  if (!clean.length) return { error: 'Pick at least one category' }

  const narrative = snapshot.interpretation || null
  const clause = clauseId
    ? (narrative?.clauses || []).find((entry) => entry.id === clauseId) || null
    : null
  if (clauseId && !clause) return { error: `No narrative clause with id ${clauseId}` }

  const contactTimer = playContactTimer
    ?? playEvidence?.play?.contact_timer
    ?? narrative?.play_contact_timer
    ?? null
  const decisivePitch = (atBat.pitches || []).at(-1) || null

  return {
    record: {
      schema_version: ANNOTATION_SCHEMA_VERSION,
      recorded_at: recordedAt || new Date().toISOString(),
      // Never modifies statistics or Supabase rows. Stated in the record
      // itself so a file of these cannot be mistaken for a correction feed.
      effect: 'local_annotation_only',

      // --- session and game identity ---
      session: {
        mode: snapshot.mode || null,
        writes_enabled: Boolean(snapshot.writes_enabled),
        started_at: snapshot.started_at || null,
        tracker_pid: snapshot.tracker_pid ?? null,
        stadium_key: snapshot.stadium_key || null,
        stadium_name: snapshot.stadium_name || null,
        capture_stem: snapshot.capture?.stem || null,
        collector_pid: snapshot.capture?.collector_pid ?? null,
      },
      game: snapshot.game || null,

      // --- which play ---
      pa_number: atBat.pa_number,
      inning: atBat.inning,
      half: atBat.half,
      batter_name: atBat.batter_name,
      pitcher_name: atBat.pitcher_name,
      result: atBat.result,
      outs_before_pa: atBat.outs_before_pa ?? null,
      count_at_contact: decisivePitch
        ? `${decisivePitch.count_balls_before}-${decisivePitch.count_strikes_before}`
        : null,
      contact_seq: atBat.advanced_batted_ball_raw?.contactSeq ?? null,
      endpoint_seq: atBat.advanced_batted_ball_raw?.endpointSeq ?? null,
      play_contact_timer: contactTimer,
      pitch_release_timer: playEvidence?.play?.pitch_release_timer
        ?? snapshot.display_play?.pitch_release_timer
        ?? null,

      // --- what the operator flagged ---
      categories: clean,
      category_labels: clean.map((value) => ANNOTATION_CATEGORY_LABELS[value]),
      note: String(note || '').slice(0, 4000),
      // The machine-readable half of a stadium-event note, when there is one.
      stadium_event: parseStadiumEventNote(note),
      clause: clause ? { ...clause } : null,

      // --- the complete interpretation, so this is investigable alone ---
      narrative: narrative
        ? {
          status: narrative.status,
          summary: narrative.summary,
          sentences: narrative.sentences,
          clauses: narrative.clauses,
          timeline: narrative.timeline,
          join: narrative.join,
        }
        : null,
      warnings: snapshot.warnings || [],
      checks: snapshot.checks || null,
      advanced_metrics: snapshot.advanced_metrics || null,
      join: snapshot.display_play
        ? {
          status: snapshot.display_play.join_status,
          pa_number: snapshot.display_play.join_pa_number,
          reason: snapshot.display_play.join_reason,
          candidates: snapshot.display_play.join_candidates,
        }
        : null,

      // --- the structured payload behind it ---
      plate_appearance: atBat,
      player_tracking_play: playEvidence?.play || snapshot.display_play || null,
      player_tracking_postgame: playEvidence?.postgame || null,
      play_geometry: playEvidence?.geometry || snapshot.play_geometry || null,
      capture: snapshot.capture || null,
    },
  }
}

/**
 * Where a session's annotations live: beside the capture, named for the
 * session, one JSON object per line so a half-written file is still readable
 * and an append can never corrupt an earlier flag.
 */
export function annotationPathFor(stem, { fallbackDir = 'data/player_tracking', label = 'preview' } = {}) {
  if (stem) return `${String(stem).replace(/\.(json|bin)$/, '')}.annotations.jsonl`
  return path.join(fallbackDir, `${label}.annotations.jsonl`)
}

export function appendTrackerAnnotation(filePath, record) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
  return filePath
}

export function readTrackerAnnotations(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter(Boolean)
}
