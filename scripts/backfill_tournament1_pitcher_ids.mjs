// Backfill: plate_appearances.pitcher_id/pitcher_player_id for Tournament 1 (MST 1).
//
// Tournament 1 was bulk-imported from a spreadsheet via the one-time "Import
// Tournament 1" button (src/utils/dataImport.jsx, triggered from Home.jsx) rather
// than live-scored through Scorebook — that importer never set pitcher_id, leaving
// 265 of 266 plate_appearances rows with no pitcher attribution. Core ERA/W-L/K/BB
// were unaffected (those read from pitching_stints, a separately-populated table),
// but anything keyed off plate_appearances.pitcher_id (vs Star Pitch, FIP/BABIP,
// pitch mix, batted-ball-against splits) was empty for every Tournament 1 pitcher.
//
// Reconstruction: pitching_stints only stores total innings_pitched per outing, not
// which specific innings — so for the 8/10 games with a pitching change mid-game,
// the exact PA/pitcher boundary isn't stored anywhere. This is a best-effort
// reconstruction (user-approved), not a data-verified fix:
//   1. Replay each game's plate_appearances in pa_number order, accumulating outs
//      via the same calculateOutsForPa() logic Scorebook uses live, to derive each
//      PA's top/bottom half-inning (mirrors deriveOffense() in gameRules.js).
//   2. That gives the batting team (away on top, home on bottom, per
//      games.home_away_swapped) and therefore the defensive/pitching team for
//      every PA.
//   3. Map each pitching_stints row to its team via draft_picks (tournament_id=1,
//      character_id -> player_id).
//   4. Within a team's stints, assumed to be used in id (chronological) order,
//      walk that team's defensive PAs assigning the current stint's character_id
//      until its innings_pitched (converted to outs) is exhausted, then advance to
//      the next stint. This assumes substitutions happen at PA boundaries, never
//      mid-plate-appearance — standard, but not guaranteed for every scoring entry.
//
// Sanity check before applying: PA 3491 (game 247, pa_number 1)'s reconstructed
// batting team matched its already-recorded `player_id` exactly, confirming the
// top/bottom replay logic. All 266 rows resolved (0 unresolved) and were applied
// in 14 batched PATCH requests grouped by (pitcher_id, pitcher_player_id) — each
// batch's updated-row count matched its expected count exactly.
//
// This script is a record of what ran, not a re-runnable idempotent migration —
// the source game/PA/stint data lives in Supabase and isn't re-derivable from a
// static file here. See git history / conversation log for the exact assignment
// table if this ever needs to be re-verified or redone.
