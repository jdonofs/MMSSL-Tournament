# Tracker reliability review — 2026-09-05

## Outcome

This pass found and fixed seven narrow reliability defects in the offline tracker pipeline. It did not change UI code, dependencies, migrations, database data, generated statistics, or the raw capture archive.

The strongest end-to-end check replayed 12 captures with their saved tracker logs: 1,060 player-tracking plays, all joined, with zero pending, ambiguous, orphaned, or mismatched joins and zero validation warnings after the fixes. The selected set spans nine parks with a saved matching log. Wario Stadium has no matching saved tracker log, so it was checked with raw live/postgame parity and archive replay instead.

## Confirmed defects fixed

1. **The live/postgame parity harness did not reproduce the collector configuration.** `replay_player_tracking.py` omitted the recorded park, state size, extra memory regions, barrel address/cannons, and explicit position offset. DK Jungle therefore produced six false flower-spray disagreements, and barrel behavior was not actually under test. The harness now passes the session configuration used by the collector. Its previously unused `--live-out` option now works, and `--postgame` permits comparison with a freshly derived file in a separate output directory.

2. **Synthetic archive replay invented count mismatches.** Its rebuilt text deliberately contains contact pitches only, but join candidates used only those rebuilt pitches even though the measured pitch stream held the omitted count changes. DK Jungle consequently showed two mismatches. Measured before/after counts are now added only as join evidence; they do not become invented tracker-log pitches or results. The actual replay now joins 98/98 DK Jungle plays.

3. **Same-frame contact was classified as happening after a landing.** The derivation used `landing.t <= event.t`. Bowser Castle PA 12 had the landing turning point and Boomerang Bro. RF contact both stamped at frame 12567. The operator annotation says the ball was booted in the air, but the old flag preserved a double. Equality is not evidence of an earlier landing, so derivation now requires `landing.frame < event.frame`. Fresh derivation plus the saved tracker log scores the play `ROE`, produces `L9-E9`, joins cleanly, and reports no warnings.

4. **Archive replay converted missing flight measurements to zero.** Missing `live_s` and `hang_time_s` values were emitted as `0`, contrary to the missing-data contract. Reconstructed log records now emit `none` for unavailable flight updates, sampled duration, and hang time.

5. **The last replayed plate appearance remained permanently current.** The replay claimed to close it but performed no state transition. A dedicated end-of-input finalizer now closes the final active buffer once and is used by both immediate and paced archive replay.

6. **A restarted tracker preview retained stale game state.** Session clearing dropped at-bats but retained inning, half, outs, alignments, tracker messages, and the detected stadium. A new session with an omitted opening line could inherit the previous session's situation or fielder names. Clearing now resets all session-owned state while preserving an explicit operator stadium override.

7. **A known foul timing sequence produced a false validation warning.** Bowser Jr. Playroom PA 13 ended provisional flight telemetry after four samples at 0-0; the tracker log then applied the foul strike to reach 0-1. Because `forward_z_ended` was not a contact terminal, validation called the two correct timestamps contradictory. A logged foul is now accepted as definitive contact evidence for the one-strike lag. The recorded session has no warnings afterward.

## Sessions examined

| Park | Capture | Plays | Evidence used |
|---|---|---:|---|
| Bowser Castle | `bowser_castle-20260905T005948Z` | 98 | saved tracker log; fresh derivation; live/postgame parity; PA 12 annotation |
| Bowser Castle | `bowser_castle-20260904T011909Z` | 129 | saved tracker log; incomplete-header behavior |
| Bowser Jr. Playroom | `bowser_jr_playroom-20260828T155225Z` | 118 | saved tracker log; fresh derivation; live/postgame parity |
| Daisy Cruiser | `daisy_cruiser-20260904T202047Z` | 109 | saved tracker log; error and sacrifice-fly annotations |
| DK Jungle | `dk_jungle-20260904T161731Z` | 98 | saved tracker log; actual archive replay; fresh derivation; live/postgame parity; flower, bunt, and Laser Beam cases |
| Luigi's Mansion | `luigis_mansion-20260904T171123Z` | 89 | saved tracker log |
| Mario Stadium | `mario_stadium-20260904T213725Z` | 110 | saved tracker log |
| Mario Stadium | `mario_stadium-20260831T174649Z` | 33 | saved tracker log; incomplete-header behavior |
| Mario Stadium | `mario_stadium-20260904T000419Z` | 91 | historical malformed live output; fresh strict-JSON derivation |
| Peach Ice Garden | `peach_ice_garden-20260904T152214Z` | 89 | saved tracker log; Buddy Throw and 3-6-3 annotations |
| Wario City | `wario_city-20260904T144308Z` | 82 | saved tracker log |
| Wario Stadium | `wario_stadium-20260826T005958Z` | 57 | live/postgame parity; no paired tracker log available |
| Yoshi Park | `yoshi_park-20260831T140742Z` | 84 | saved tracker log; fresh derivation; live/postgame parity |
| Yoshi Park | `yoshi_park-20260831T134815Z` | 21 | saved tracker log; actual archive replay; incomplete-header behavior |

The main paired-log result is 1,060/1,060 joined plays with no validation warnings. Fresh current-code live/postgame comparisons agreed on every field for Bowser Castle (98), DK Jungle (98), Bowser Jr. Playroom (118), and Yoshi Park (84). Wario Stadium's existing 57-play derivation also agreed field-for-field. The saved annotations checked included Bowser Castle PA 12; DK Jungle PAs 48 and 50; Peach Ice Garden PAs 34 and 35; and Daisy Cruiser PAs 10 and 23.

## Archive integrity and negative findings

The strict archive scan covered 106 JSONL files and 8,153 parseable records. It found no duplicate contact/pitch timers, no out-of-order contact/pitch timers, and no play records marked truncated. The selected real-log replays found no evidence of forced or misattributed joins. Previously annotated sac bunt, Laser Beam, Buddy Throw, 3-6-3 double play, sacrifice fly, and ordinary error cases already produce the expected current output, so no speculative fixes were made for them.

One historical file, `mario_stadium-20260904T000419Z.live.jsonl`, contains 22 non-JSON `NaN` rows. The current worktree already had two relevant protections before this pass: implausible barrel coordinates are rejected and non-finite values serialize as `null`. A fresh 91-play derivation in `tmp/tracker-reliability-20260905` is strict JSON and contains no false barrel events. The historical file was deliberately left unchanged.

Three capture headers lack final `frames`, `duration_seconds`, and `missed_frames`: `bowser_castle-20260904T011909Z`, `mario_stadium-20260831T174649Z`, and `yoshi_park-20260831T134815Z`. Their binaries remain readable and their 129, 33, and 21 plays respectively all join cleanly to saved logs. That proves graceful replay of the surviving data, but not that no final frames were lost before collection stopped.

## Regression results

- Baseline before edits: `npm run test:tracker` — 396/396 passed.
- Final: `npm run test:tracker` — 400/400 passed.
- Final: `npm run test:defense` — 31/31 passed.
- Python syntax compilation passed for the replay, derivation, live derivation, and session I/O modules.
- Actual `npm run tracker:replay -- --session data/player_tracking/yoshi_park-20260831T134815Z --port 4393` served 21 plays, joined 21/21, left no non-joined plays, and closed the final PA.
- Actual DK Jungle archive replay served 98 plays, joined 98/98, left no non-joined plays, and closed the final PA.
- Fresh raw-frame derivation and live replay agreed field-for-field for 398 plays across four parks; the existing Wario Stadium parity check adds 57 more.

## Cases needing human observation

- Record a future Wario Stadium game with both the collector and saved tracker log; this archive has no paired log, so cross-process joining there was tested only with replay reconstruction.
- If any of the three incomplete-header sessions matters past its last recorded play, video or an operator note is required to establish whether gameplay continued after the final recoverable frame. The files themselves cannot prove a negative.
- Re-derive old authoritative play files before treating live/postgame differences in `ball_landed_before_contact` as regressions. Equality is now conservatively “not proven before”; Bowser Castle PA 12 has direct operator support, while other same-frame contacts lack video confirmation.
