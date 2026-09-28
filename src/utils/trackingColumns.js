// WHICH COLUMNS THE BROWSER ACTUALLY NEEDS FROM THE TRACKING FACT TABLES.
//
// These are the widest tables in the database and three pages read them whole
// -- Stats, the character page and the team page -- so `select('*')` was the
// single largest source of Supabase egress in the app. Measured league-wide,
// compressed, as the wire sees it:
//
//   fielding_opportunities   890 KB -> 152 KB   (41 columns -> 15)
//   movement_metrics        1015 KB -> 250 KB   (37 columns -> 18)
//
// A page load costs that much every time, and a scope change or a realtime
// event pays it again.
//
// HOW THESE LISTS WERE BUILT, and how to change one. Every column of every
// table was checked against a word-boundary search of `src/`; a column no
// browser code reads is not requested. Two things that search cannot see were
// added by hand:
//
//   * the identity keys advancedDefense.js builds with template literals
//     (`thrower_${player_id|character_id}` and friends) -- a literal grep
//     never finds those, and dropping one silently empties a whole metric;
//   * `quality`, a JSONB blob on every one of these tables of which only a
//     few booleans are ever read. Those come back as top-level aliases and
//     restoreQuality() puts them back where the readers expect them.
//
// ADDING A METRIC MEANS ADDING ITS COLUMN HERE. A reader asking for a column
// that was not selected gets `undefined`, not an error, so the stat quietly
// reads as zero or blank. That is the failure mode to watch for: if a number
// goes empty after a change here, a column is missing rather than the data.
//
// Scripts are unaffected. They fetch their own rows server-side and pay no
// egress, so they keep reading whole tables.

// A row's own `id`, its `pa_id` and the provenance columns (`model_version`,
// `star_difficulty`, `fielded`) are deliberately absent: nothing in the browser
// reads them, and as 36-character uuids and repeated version strings they cost
// far more than their share of a row. Dropping them alone took these two tables
// from 526/555 KB to 296/302 KB compressed. `tracking_play_id` stays -- the
// active-version gate is keyed on it.

// The identity suffixes summarizeAdvancedFielding and friends switch between.
const identityKeys = (prefix) => [`${prefix}player_id`, `${prefix}character_id`]

export const FIELDING_OPPORTUNITY_COLUMNS = [
  // `pa_id` is the plate-appearance link experimentalWar.js keys on
  // (`row.pa_id ?? row.id`); without it every opportunity fell out of the WAR
  // fielding component silently. It is a bigint and costs almost nothing --
  // the expensive identity column is the uuid `id`, which nothing reads.
  'tracking_play_id', 'competition_type', 'game_id', 'pa_id',
  ...identityKeys('fielder_'),
  'position', 'is_primary', 'actual_out', 'expected_out_probability',
  'outs_above_average', 'direction',
  'position_depth_ft', 'position_angle_deg',
  'distance_needed_m', 'opportunity_seconds', 'reaction_seconds',
  'route_efficiency', 'sprint_speed_fps',
  'exclude_from_oaa:quality->exclude_from_oaa',
  'stadium_affected:quality->stadium_affected',
  'quarantined_session:quality->quarantined_session',
].join(',')

export const MOVEMENT_METRIC_COLUMNS = [
  'tracking_play_id', 'competition_type', 'game_id',
  'player_id', 'character_id',
  'actor_type', 'path_distance_m',
  'sprint_speed_fps', 'max_speed_fps', 'is_bolt',
  'home_to_first_seconds', 'ninety_foot_split_seconds',
  'reaction_seconds', 'route_efficiency',
  'jump_distance_feet', 'reaction_distance_feet', 'burst_distance_feet',
  'jump_route_efficiency',
  'quarantined_session:quality->quarantined_session',
].join(',')

export const TRACKING_THROW_COLUMNS = [
  'id', 'tracking_play_id', 'competition_type', 'game_id', 'pa_id',
  ...identityKeys('thrower_'),
  'thrower_position', 'receiver_position',
  'is_buddy_throw', 'is_relay', 'peak_speed_mph',
  'target_base', 'intended_target_position', 'buddy_partner_position',
  'outs_recorded', 'result',
  'quarantined_session:quality->quarantined_session',
].join(',')

export const RUNNER_OPPORTUNITY_COLUMNS = [
  'id', 'tracking_play_id', 'competition_type', 'game_id', 'pa_id',
  'runner_id', ...identityKeys('runner_'),
  ...identityKeys('responsible_fielder_'), 'responsible_fielder_position',
  'origin_base', 'target_base', 'opportunity_type', 'outcome',
  'is_discretionary', 'attempted', 'safe',
  'outs_before', 'outs_after', 'base_state_before', 'base_state_after',
  'expected_attempt_probability', 'expected_success_probability',
  'runner_run_value', 'arm_run_value', 'model_version',
  'quarantined_session:quality->quarantined_session',
].join(',')

export const DOUBLE_PLAY_OPPORTUNITY_COLUMNS = [
  'id', 'tracking_play_id', 'competition_type', 'game_id', 'pa_id',
  ...identityKeys('first_fielder_'), 'first_fielder_position',
  ...identityKeys('pivot_fielder_'), 'pivot_fielder_position',
  'outs_before', 'base_state_before', 'trajectory', 'structural_eligible',
  'actual_outs', 'double_play_completed', 'expected_double_play_probability',
  'double_plays_added', 'run_value', 'credit_status', 'model_version', 'context',
  'quarantined_session:quality->quarantined_session',
].join(',')

// Only the mechanics off a play's `quality`. For the character and team pages,
// which show close plays and nothing else the blob carries -- the rest of it is
// gimmick events, stadium incidents, stadium runs and the runner context, and
// asking for all of that costs 747 KB against this slice's 192 KB.
export const TRACKING_PLAY_MECHANICS_COLUMNS = [
  'id', 'tracking_session_id', 'competition_type', 'game_id', 'play_ordinal',
  'play_mechanics:quality->play_mechanics',
  'quarantined_session:quality->quarantined_session',
].join(',')

// The aliases the selects above introduce, and where each one belongs inside
// the `quality` object its readers expect. A row is only given the keys its
// own select asked for, so a table that never requests `exclude_from_oaa` does
// not gain a false `false` for it.
const QUALITY_ALIASES = [
  'quarantined_session', 'exclude_from_oaa', 'stadium_affected', 'play_mechanics',
]

/**
 * Put the selected `quality->…` aliases back inside `quality`.
 *
 * Readers ask for `row.quality?.quarantined_session`; PostgREST returns a
 * JSON path as a top-level column. Rather than teach every reader about two
 * shapes, the rows are restored to the one shape they have always had.
 *
 * Idempotent, and safe on rows that were fetched whole: a row with no aliases
 * keeps whatever `quality` it already carries.
 */
export function restoreQuality(rows = []) {
  return (rows || []).map((row) => {
    if (!row || typeof row !== 'object') return row
    const present = QUALITY_ALIASES.filter((key) => key in row)
    if (!present.length) return row
    const restored = { ...row.quality }
    const stripped = { ...row }
    for (const key of present) {
      // A JSON path that resolved to SQL null comes back as null, which for
      // every one of these flags means the same thing as absent.
      if (row[key] != null) restored[key] = row[key]
      delete stripped[key]
    }
    return { ...stripped, quality: restored }
  })
}
