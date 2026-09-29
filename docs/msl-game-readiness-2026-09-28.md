# MSL 1 game-readiness review — September 28, 2026

The first work should make season data and game finalization dependable. Both have reproduced defects that can disrupt a session even while the underlying scoring tests pass. Keep new metrics, visual redesigns, and broad refactors behind these repairs.

## Current status and stopping rule

User clarification: this is a finite game-readiness push. An available agent is not a reason to invent an assignment. The queue below records the original review; it is not a requirement to implement every possible improvement.

- **Sol assignment 1: implemented; focused local verification passed.** The season/tournament context and App changes are present, and `node --test tests/season-context.test.mjs` passed all nine tests in this follow-up. The playoff browser locator has been corrected. Final combined integration remains to be checked after Opus finishes. An initial combined run encountered a first-test timeout and was stopped; the isolated case and full isolated season suite then passed. Investigate that startup only if it recurs; do not treat it as an established application defect.
- **Opus assignment 1: implemented; focused local verification passed.** The user reports completion. The follow-up review ran the recovery, hook and bridge-recovery suites together: 22 passed, zero failed/skipped (`tmp/msl-readiness-20260928/completion-review.log`). Full combined/build/browser and deployment checks are owned by the final release check below; do not reassign the original implementation.
- **Sol assignment 2: closed.** The five browser fixtures now use an explicitly allocated available loopback port. `tmp/msl-readiness-20260928/browser-verification.log` records 65 passes, zero failures/skips, including the nine season-context tests. The follow-up review inspected the changes and saved results; it did not repeat that successful run. Do not reassign browser-startup work without new evidence.
- **Assignment 3 (capture-ingestion acceptance): closed 2026-09-28.** [Prompt](prompts/msl-ready-03-sol-capture-acceptance.md). Four of the five warnings came from a live bridge scoring defect, not from missing historical evidence. `scripts/live_tracker_bridge.mjs` recorded a pitch only on a `Count:` line. (1) A strikeout prints `Strike 3.` and then the strikeout line, never `Count: x-3`, so every K lost its final pitch: tournament PAs 1 and 63, season PAs 22 and 44. (2) When a contact is called `Fair ball!` and then `Foul ball!`, the bridge wrote an `in_play` row plus a `foul` row, and the pitch really put in play then got no row or a stray one: tournament PA 55 and season PAs 4 and 17. The fix mirrors the preview parser's existing `ensureStrikeoutPitch` and `retractPrematureFairBall` (parser lines only; Opus's finalization hunks untouched). Pitch rows are now 106 and 110, equal to both workbooks' Pitching totals. PA results, runs, outs and settlement are unchanged. The remaining tournament warning is correct: it is the top-5th Red Noki trip the tracker never stated an outcome for, which the bridge refuses to score (`skippedPlateAppearances`), so its 2 capture pitches have no PA. `tests/tracker-acceptance.test.mjs` now asserts the exact warnings, that unmatched identity, zero unmatched pitches, count-by-count order agreement, and that restatement leaves official pitch fields and star flags alone; it also reaches the retry/no-op checks. Results: `npm run test:acceptance` 47/47, `test:tracker` 602/602, `test:persistence` 64/64, `game-completion-bridge-recovery` 2/2. Do not reassign.

Only assign further work for (a) a reproduced defect that materially affects the next session, or (b) a specific unchecked release condition below. Each assignment needs evidence, an affected user action, a completion condition, and separate ownership. A supported “no change needed” result closes an investigation. Do not automatically convert missing test coverage, old checklist items, cosmetic imperfections, or hypothetical races into release blockers.

## Release check result — 2026-09-28 (final)

**Verdict: Code work complete; awaiting these specific checks/actions.** No coding assignments remain. [Prompt](prompts/msl-ready-02-opus-release-check.md). Logs: `tmp/msl-readiness-20260928/release-check/`.

**Handoff closure:** the coordinating review checked the saved combined-test, build, mobile recovery and next-game logs and compared all 41 recorded candidate-file hashes. Only this report and the documented browser viewport override differ; the product code matches the tested candidate. Do not issue another coding prompt merely because an agent is available. The remaining deployment and physical check below are the release actions, not a new bug-fixing backlog.

**Candidate tested:** HEAD `9ac8f05` plus the uncommitted working tree (18 modified, 17 untracked files excluding `public-tracker-release/`; `git diff` sha256 `0c4bad82…`, per-file hashes in `candidate-files.sha256`). Nothing else changed during the check; the only edit this pass made is a one-line `SLUGGERS_QA_WIDTH` viewport override in `tests/game-completion-recovery-browser.mjs`. No product code was changed.

| # | Condition | Result |
| --- | --- | --- |
| 1 | Known material defects closed | **Verified.** All four reproduced mechanisms (season scoping, failed reads, manual completion/reopen, tracker finalization) are covered by passing suites in the combined run and by the recovery browser check. No new defect was found. |
| 2 | Existing checks reconciled | **Verified.** `npm run build` passed. `node --test --test-concurrency=1 tests/*.test.mjs`: **1,441 tests, 1,441 passed, 0 failed, 0 skipped** (this includes the 65 browser-fixture tests, acceptance and persistence). The earlier port-binding and warning failures do not recur. |
| 3 | Representative session rehearsal | **Verified locally (intercepted).** See the step map below. Every standalone browser script passed against a fresh preview of this build (`app-CwOhEGHu.js`, port 58161). |
| 4 | Deployed version usable | **Schema verified; site awaiting deployment.** Read-only catalog queries against the linked project `cfowednmssmbvspbxzyb` (`schema-check.out`, `policy-check.out`, `migration-check.out`): all 14 session-path RPCs exist with `authenticated` EXECUTE; all 21 tables exist with grants and scorekeeper RLS policies covering every completion/reopen write; the capability columns `assertSchemaSupported` probes are present; migrations through `20260922233000` are applied; the bridge account (Jason) has scorebook access; MSL Season 1 is id 37, `active`. The candidate needs **no migration** (the new lifecycle code uses existing tables and columns). The deployed site `msl-tournament.vercel.app` serves `app-nf8WHXtJ.js` / `ScorebookRoute-i-Tgykh-.js`, which lack the recovery banner ("Finish completion steps" absent), so **the fixes are not deployed**. |
| 5 | Installed tracker handoff | **Awaiting one physical check.** Configuration verified (see below). The last live game on this machine, TEST game 2948 (2026-09-22, same executable), started with readers ready and reached `completed` with an active `ingested` tracking version. That is historical evidence; the uncommitted bridge parser and finalization changes have not run against the real emulator. |

**Session flow → evidence**

| Step | Evidence |
| --- | --- |
| Sign in, select season | `auth-context`, `season-context` (9) suites; every browser script signs in through an intercepted session |
| Roster and saved lineup | `team-lineups`, `mss-autogame-launcher` suites (lineup injection from saved rows) |
| Open scheduled game + stadium setup | **New focused check** `next-game-start-browser.mjs` at 390 px and 1280 px: finished game 42, opened game 44 from the Schedule, chose a stadium, Open Game → `PATCH season_schedule id=44 {"stadium":"Mario Stadium","is_night":false}` (no other schedule row written) → `/season/scorebook?game=44`. `season-playoffs-browser` covers the locked playoff game on desktop and mobile. |
| Start tracker/scoring | Same check: the start control → `POST /game-control/start {"gameId":44,"table":"season_schedule"}`. The deployed-site link path (`sluggers-game://` → launcher → service) is covered by `game-protocol-launcher` and `game-control-service`. |
| Live state | `tracker-live-feed`, `tracker-console-ui`, `scorebook-live-state`, `tracker-live-recovery` suites |
| Finish | `game-completion-hook`, `game-completion-bridge-recovery`, acceptance "completion waits for the scoring writes it requires" |
| Bets, standings, stats | acceptance settlement cases, betting suites, `tracker-acceptance-browser` (tournament, season and career stats) |
| Correct, reopen, retry | `at-bat-correction-browser`; `game-completion-recovery-browser` at 1280 px **and 390 px**: a failed retry keeps the control, the second press clears it, no bet is paid twice, a reload shows nothing owed |
| Open the next game | `next-game-start-browser.mjs` (above) |

**Tracker configuration (read-only):** `sluggers-game` is registered under HKCU to `scripts/game_protocol_handler.ps1` in this checkout. The bridge selects `sluggers-stat-tracker-advanced-stats-v28.exe` (no `TRACKER_EXE_PATH` override); that is the executable named in the 2948 log. `TRACKER_PLAYER_PYTHON` is Python 3.10 with numpy 2.2.6; the Mii DB and `D:\Wii\Dolphin-x64\Dolphin.exe` exist. `scripts/verify_tracker_build.py` (run with Python 3.13, as it requires): `_check_if_ball_was_hit` and `_check_for_star_pitch_usage` are current; `_refresh_game_values` is **stale**. The source added knuckleball pitch-type labelling after v28 was built. The 1 m/unit scale is already in v28 (`feet_per_unit=3.2808` in the 2948 log).

**Confirmed defects:** none open.

**Nonblocking limitations**
- v28 never labels a pitch `knuckleball`. This affects pitch-type metrics only, not scoring. Rebuilding is outside this push.
- The scorebook has 6 px of horizontal overflow at 390 px from the tab pill row. Every control stays on screen and usable (`next-game-failure-390.png`).
- The rehearsal ran against intercepted Supabase and an intercepted launcher. The real login, live writes and emulator were deliberately not exercised.
- The one historical unresolved Red Noki PA in the acceptance capture remains correctly reported.

**Remaining actions (the user's, not coding work)**
1. Commit and push the candidate so Vercel deploys it. Then confirm `msl-tournament.vercel.app` serves a `ScorebookRoute` chunk containing "Finish completion steps". No migration is needed.
2. Run one short physical check before the MSL game: a TEST-season game (not MSL Season 1) launched from the deployed site through Dolphin. Confirm the startup record shows `readers_ready` with capture recording, a few PAs score, End Game completes with no recovery banner, and `tracking_sessions` shows an active `ingested` version.

---

*Pre-check note (superseded by the result above):* the release check consolidated the remaining conditions into one bounded verification pass.

The release conditions are finite:

1. **Known material defects closed:** season data remains correctly scoped; completion/reopen recovery is correct in site and tracker. No known unresolved issue prevents play, loses/corrupts scoring, changes the wrong game/team, or misstates settlement.
2. **Relevant existing checks reconciled:** build and focused regression/acceptance/browser checks pass, or an observed historical/environmental limitation is specifically explained and alternative evidence covers the session behavior. Never suppress unexpected warnings or mark unexecuted assertions as passed. No requirement for exhaustive new coverage or every possible edge case.
3. **One representative session rehearsal succeeds:** sign in, select MSL, confirm roster/lineup and game setup, start tracking, view live scoring, complete, see bets/standings/stats, correct/reopen if needed, and open the next game. Include narrow-screen checks for the controls people will actually use. Existing test/replay evidence can satisfy steps; do not duplicate it without a reason. Exercise other existing utilities only where intended session use or a concrete finding warrants it.
4. **The deployed version is usable:** verify the release build and required database tables/RPCs/permissions for those flows. Local test success alone does not establish deployment. Resolve actual discrepancies rather than proposing blanket migration/backfill work.
5. **The installed emulator/tracker handoff is confirmed:** a short representative check establishes the current installed build starts scoring/capture and finishes cleanly. Reuse applicable recent evidence; do not demand another full calibration program.

When these conditions are met, explicitly report **“Ready for the next MSL 1 session”**, list any nonblocking limitations, and stop issuing readiness prompts. If only the physical/deployment confirmation remains, say **“Code work complete; awaiting these specific checks”** rather than generating more coding tasks. Deferred features, model research, refactors and polish stay outside this release push. There is no claim that all software is permanently bug-free.

This is a local code, test, and recorded-evidence review. It did not modify application code, start Dolphin, reset games, apply migrations, deploy, or mutate the live database. The pre-existing untracked `public-tracker-release/` directory was preserved. It is not an exhaustive interactive audit of every site control or a certification of the deployed database.

## First pair — ready to hand off together

| Agent | Assignment | Why first |
| --- | --- | --- |
| Sol | [Reliable season loading, switching and recovery](prompts/msl-ready-01-sol-season-data.md) | Wrong-season or silently empty data can make the schedule, standings and balances misleading throughout a session. |
| Opus | [Recoverable game completion and reopening](prompts/msl-ready-01-opus-game-completion.md) | A completed score must not hide failed pitching, betting, stadium-log or competition updates. Covers the manual site and tracker paths. |

These are implementation prompts, not requests for another plan. They specify causes, behavior, ownership, tests, existing failures, and what can be done without user input. Sol owns the competition contexts/App loading behavior; Opus owns the completion hook, game-session adapter and tracker bridge. Each should use separate regression files. Neither should change live MSL data to demonstrate a fix.

## Confirmed findings

### 1. Season responses can overwrite the current selection's data

`src/context/SeasonContext.jsx:46` — `refreshSeasons` has no request/selection check around its asynchronous state commits. The selection-change reload at line 117 has the same problem. Realtime slice commits at line 170 remain possible after their effect is disposed; the refresh coordinator does not cancel a callback already executing.

Local reproduction using the actual refresh callback: start season 1, start season 2, finish 2, finish 1. The selected ID is 2; the stored schedule is from 1. This establishes a state-consistency defect, not a reproduced production write into the wrong season.

### 2. Failed season reads become a successful empty snapshot

`src/context/SeasonContext.jsx:87` and `:118` discard the errors returned by the teams, schedule, ledger and players queries. Injecting failed responses clears the loaded arrays, settles loading and resolves successfully. Users cannot distinguish unavailable data from an empty season. Same-season refresh should retain the last good data with a visible error; a failed selection change must not expose old rows under the new season identity.

### 3. Manual completion ignores failed pitching writes; reopen retains saves

`src/features/scorebook/hooks/useGameCompletion.js:293` awaits pitching updates without examining their returned errors. `src/features/scorebook/services/gameService.js:21` returns the Supabase response. Injecting a returned error still changed the local winner stint to `win: true` and emitted `Game complete` without an error toast.

Reopen at hook line 382 selects only `win || loss` stints, and the service at line 25 clears only those flags. A save-only stint remains credited after reopening. The same callback invokes `reopenGameBets` at both lines 351 and 392. The duplicate invocation is an integration loose end; it is not by itself evidence of duplicate money movement.

### 4. Tracker finalization can treat unfinished lifecycle work as successful

`scripts/live_tracker_bridge.mjs:1813` catches/logs each failed pitching-decision, stadium-log and competition-advancement step. Executing that function with all three steps failing still resolves successfully. Its caller at line 1797 therefore retains a successful `finalizationPromise`; subsequent finalization calls return that promise at line 1732. This branch cannot retry those failed steps during the same process just by calling finalization again.

The manual completion/reopen hook also catches downstream failures and emits unconditional success. Recovery must remain usable after status changes and realtime refresh/reload. The prompts require examining actual persistence and UI behavior rather than assuming a second click is always available.

All four mechanisms are captured in `tmp/msl-readiness-20260928/reproduce.mjs`, runnable with:

```powershell
node tmp/msl-readiness-20260928/reproduce.mjs
```

It executes current source callbacks with injected boundaries. Its results establish the mechanisms; mounted React, real database and bridge integration tests are still required for the fixes. Output is in `tmp/msl-readiness-20260928/reproduction.log`. Scratch artifacts are ignored by Git; the handoff prompts restate the findings independently.

## Original review candidates — superseded by the final verdict

The rows below preserve the initial review and its then-current evidence. They are not outstanding assignments or current failures. Use the final release result and its two remaining actions above for current status; do not restart work from this historical table.

| Priority | Area | Evidence and bounded next task |
| --- | --- | --- |
| Closed | Capture pitch reconciliation and acceptance | Resolved 2026-09-28; see assignment 3 above. Original finding: two acceptance cases fail because the test demands no warnings. Tournament capture: one unmatched PA group and two pitches absent from scoring rows. Season capture: two pitches absent from scoring rows. Trace each mismatch against existing logs/capture and determine whether it is expected historical evidence or a current join/scoring defect. Preserve ambiguous evidence; do not fabricate pitches or silence warnings. The assertions fail before reaching their retry/no-op assertions, so those cases do not currently establish idempotency. |
| High | Browser verification reliability | 56 tests fail during setup with `listen EACCES` on `127.0.0.1:5173`. Auth and scouting reproduce it in isolation. These are blocked tests, not 56 proven feature bugs. Repair/configure fixture server binding and rerun actual browser assertions. Preview on 4173 works. |
| High | Schedule/playoff browser coverage | `tests/season-playoffs-browser.mjs:134` waits for `Start Game`; the current schedule modal renders `Open Game` (`src/pages/SeasonSchedule.jsx:264`). Update that obsolete locator and retain disabled-stage and mobile checks. The original script timed out before those checks could finish. Sol may handle this while verifying the first assignment. |
| High | Deployed schema and permissions | Local PGlite tests passing is not evidence that the deployed schema has the migrations. The shared tracker fixture lists a subset and omits, among others, the September 18 session/PA uniqueness and tracking RLS migrations and September 20 catch-approach migration. Audit relevant fixture coverage and prepare a read-only deployment/preflight check for required tables, RPCs and permissions. Report exact missing requirements before any migration application. |
| Next | Roster, lineups, trades, waivers and admin utilities | Source inspection shows existing atomic pickup/trade/waiver RPC paths; the old QA list should not be treated as a fresh bug list. Exercise these in local browser/database fixtures: saved lineup reaches game setup, failed transaction is surfaced, stale roster acceptance cannot partially succeed, pending actions cannot double-submit, and commissioner controls behave correctly. End-to-end browser coverage remains incomplete here. |
| Next | Start, stop, reconnect and next-game handoff | Launcher/control/lease/recovery tests passed in the broad run, and newer startup records show successful captures. Verify the current build across sequential games, interrupted local service, unavailable reader, and final ingestion. Distinguish a started process from confirmed scoring/capture readiness. Use fixtures/replays first, then a short actual pre-session check. |
| Next | Remaining page utilities/mobile controls | Follow links and actions on betting, stats, team/character, admin, roster and game views using local/intercepted responses; check loading, failed requests, empty states, disabled controls and mobile modals. The passing stats/correction browser checks below cover specific paths, not every control. |

The combined release check has now completed. No further coding pair is scheduled.

## Verification recorded for this review

Logs are in `tmp/msl-readiness-20260928/`.

| Check | Result |
| --- | --- |
| `npm.cmd run build` | Passed. |
| `node --test --test-concurrency=1 tests/*.test.mjs` | 1,406 tests: 1,348 passed, 58 failed, zero skipped. 56 failures are the shared port-binding setup error; two are the capture-pitch warning assertions. |
| `npm.cmd run test:acceptance` separately | 41 passed, two failed on the same warnings. Recorded scoring totals, source isolation, settlement and the tested scoring recovery cases passed. |
| Isolated `--test-name-pattern='postgame capture ingests'` | Both warning failures reproduced independently. |
| `node tests/tracker-acceptance-browser.mjs` | Passed on the built app with intercepted responses: tournament/season/career stats, character profile and visible unresolved play. |
| `node tests/at-bat-correction-browser.mjs` | Passed with intercepted responses: opened an unresolved play with its context and saved through one transactional call. |
| `node tests/season-playoffs-browser.mjs` | Failed waiting for obsolete `Start Game` label; full desktop/mobile assertions not completed. |
| Isolated auth and scouting browser suites | Blocked by the same `127.0.0.1:5173` bind error. |
| Local callback reproductions | All five output checks reproduced the defects described above. |
| `python scripts/verify_player_metrics.py` | Passed all checks, including synthetic measurements and archived-session assertions. |

The production preview server was used only for local intercepted browser checks. The browser scripts did not write live MSL game data. Build/test success does not establish production migration status or controller/emulator behavior.

## Existing work that should not be redone blindly

The September 21 live-restart and postgame-completeness prompts have corresponding implemented code and passing regression files (`tracker-live-recovery.test.mjs`, `tracker-ingest-completeness.test.mjs`). The prior auth and at-bat race work also has implementation/tests, although its browser assertions were blocked in this environment. The older betting odds failures quoted in an earlier handoff did not recur in this broad run.

`docs/tracker-real-game-validation.md` contains historical statements that startup behavior has never been observed. The local startup directory now contains 18 records: 15 report `readers_ready` with capture recording and 30 initial frames, including the latest record, `season-2948-2026-09-22T21-49-05-252Z.json`. That is evidence of prior successful startup on this machine. It does not prove an entire game's capture was complete or certify today's binary. Update the checklist around current evidence instead of requiring all old experiments again.

## Practical release condition

Before calling this game ready, finish the first pair, reconcile the remaining acceptance/browser failures, and verify the deployed schema/build. A representative local rehearsal should preserve game identity from schedule and lineup through start, live scoring, finish, bets, standings, stats and correction, with failed requests safely retryable. Then reserve only the unavoidable physical check for the actual emulator/controllers and the installed tracker build. No new metric calibration or feature expansion is required merely to make the existing session workflow reliable.
