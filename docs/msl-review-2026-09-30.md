# MSL review — September 30, 2026

## Final coordinator closure

**Tasks A and B accepted; the finite review is closed. No further coding assignment is needed for the next MSL session.** The manual scorebook-save gap described below is fixed by [Opus's follow-up](msl-roster-followup-opus-2026-09-30.md). The earlier finding is retained as historical evidence, not an outstanding task.

The coordinator reviewed the follow-up source, browser assertions and logs. Unknown game lineups no longer expose editable fallback controls or claim to be saved. The save action also refuses an uninitialized lineup and propagates write failures, preserving dirty state and preventing failed Save & Leave navigation. Existing game-specific lineups remain usable through saved-team read failures; delayed seed reads for a game the user has left are ignored.

A fresh isolated coordinator build passed (`tmp/msl-roster-followup-review-build-20260930.log`); all 79 built assets match Opus's tested candidate byte-for-byte, including `app-D5ODMoBB.js` and `ScorebookRoute-BcQ6HrS2.js`. Inspected evidence includes four passing season/tournament browser runs at 1280/390 px, the passing prior seed checks, and the recorded 64/64 scorebook and 64/64 persistence suites. Those unchanged successful cases were not rerun merely for closure. The old reproduction timing out on now-absent controls is not itself treated as a passing test; the new guard fixture makes explicit assertions for zero writes, truthful state, retry, save/reload, failed save/navigation, absent saved rows, and game switching.

Nonblocking limits: if game lineup rows are absent and automatic seeding cannot run (for example a completed or tracker game), the editor may remain on “Setting game lineup…”. This is misleading status text in that state, not a reason to restore writes from guessed lineups. No new session blocker was established. The save-action refusal for rows disappearing under a dirty draft was inspected in source, not separately browser-tested. Writes already in progress after a successful seed read may finish for their original game. Intercepted tests do not establish production permissions or atomicity.

The fixes remain local and uncommitted; this closure did not push, deploy, mutate production, start an emulator, or modify product code. Preserve the accepted roster/performance work and earlier optional-smoke fixes together. Shipping is the remaining release action. Cleanup and broader performance exploration stay deferred; do not automatically launch another audit.

---

## Coordinator review of Opus's completed work

**Task B accepted; Task A needs one focused scorebook follow-up.** The roster-page recovery fix and the history refresh improvement are supported by Opus's browser evidence. A fresh coordinator build passed and all 79 asset names/content hashes exactly match Opus's tested A+B build (`app-QDhW2x3V.js`). The recorded 64/64 scorebook, 64/64 persistence and 9/9 focused results were inspected; unchanged successful suites were not repeated. All changes remain local and uncommitted.

The remaining issue is in the manually scored game's **Scorebook → Lineups → Save Team A Lineup** path. With saved-lineup GETs returning 503 and a fresh game's lineups empty, automatic seeding correctly makes no lineup/fielding writes. However, Lineups still shows fallback order/positions and two “All changes saved” bars. Swap spots 1 and 3 and press Save: the client posts nine default fielders, leaves batting-order rows empty, clears dirty state, and still reports saved. This was reproduced on season at 1280 px and tournament at 390 px against the exact final build. The claim that the remaining provider fallback is display-only is therefore insufficient: users can save from that display.

Cause: `ScorebookLineupsView.jsx:92` does not supply loading/error state or block editing. `useLineupEditor.js:229` accepts that draft; its update list drops entries with no existing lineup row, then it still writes fielders. `handleSaveLineupTeam` at line 477 marks a resolving call saved. Guarding only the automatic seed does not protect this manual path. This is not a new tracker/gameplay blocker, but it prevents closing the assigned saved-lineup recovery work.

Evidence: `tmp/msl-roster-review-build-20260930.log`; `tmp/msl-roster-review-20260930/scorebook-manual-save.mjs`; `manual-save-season.log`; `manual-save-tournament-390.log`; corresponding screenshots. The probe extends Opus's existing `scorebook-seed-read.mjs`; all writes are intercepted, with zero launcher calls, unexpected external requests, unsupported fake REST requests or page errors. No product code was changed by the coordinator.

Use [the narrow follow-up prompt](prompts/msl-roster-followup-opus-2026-09-30.md). Leave the accepted roster/performance work alone. Once this manual-save path is verified, review that small diff and close the pass; do not start a new cleanup or performance audit.

---

No new tracker/game-completion blocker was established. One newly reproduced lineup-read defect is worth fixing before the next session. A measured roster-refresh inefficiency is optional follow-up work. No broad site audit, cleanup sweep, migration, or tracker rebuild is recommended.

## Candidate and deployment

- Read `CLAUDE.md` and the four September 28–29 readiness/smoke reports. No applicable `AGENTS.md` was found in the repository or ancestor paths checked.
- Local HEAD and a fresh `git ls-remote origin refs/heads/main` both identify `4e63f2e697530bd4f039f4944fc04ddd0aa5ee94`.
- Existing uncommitted product changes remain in `UnsavedChangesPrompt.jsx`, `Admin.jsx`, `Roster.jsx`, `SeasonRoster.jsx`, and `teamLineups.js`. These are the optional smoke fixes, not new work from this review.
- Fresh read-only HTTPS requests to `https://msl-tournament.vercel.app/` returned `app-B3Dxl2-1.js`, which references `Admin-iRLPR4ch.js`. That Admin bundle lacks both `failedTables` and the new incomplete-file warning. The optional fixes remain uncommitted and unshipped. No push/deployment was performed.
- The earlier 1,441-test release result and 64/64 scorebook plus 64/64 persistence closure results describe their recorded candidates. This review did not rerun those suites or the successful emulator rehearsal.
- Fresh build of today's source passed, isolated to `tmp/msl-review-20260930/dist`; app asset `app-AT30nqDt.js`. Nine targeted team-lineup/refresh-coordinator tests passed. No product source was changed.

## Findings and finite queue

| Priority | Classification | Result / next action |
| --- | --- | --- |
| Before next session recommended | Reproduced reliability defect | A failed saved-lineup GET is treated as an absent row. Season Roster shows default order with “All changes saved,” although the stored order differs. Editing two slots and saving overwrites the custom stored order with the edited defaults; reload confirms that overwrite. Fix read-error handling and safe retry. |
| Optional later task | Measured performance improvement | Three synthetic `season_pitches` realtime notifications on the actual SeasonRoster history subscription produce 33 HTTP reads: all 11 history queries run three times. Reuse the existing refresh coordinator to combine a burst and avoid overlapping full reloads. Do not remove career data required by OVR calculations. |
| Deferred | Cleanup with limited session benefit | HEAD tracks 545 files under `tmp/`, totaling 37,687,546 bytes. The ignored directory still contains tracked files, including backups, workbooks and historical evidence. A future selective index cleanup could reduce checkout clutter; it would not erase history or speed the website. Do not blanket-delete or untrack these files. `src/pages/SeasonTrades.jsx` also appears unused, but removing a tiny redirect wrapper is not worth a session task. |
| Passed; no change | Utility recovery hypothesis | Video Timestamps retained an unsaved start time and URL after reload with a deliberately delayed PA query at 1280 and 390 px. Its document width matched both viewports. The suspected restoration race did not reproduce in this case. |
| Existing evidence sufficient | Tracker/session transitions and earlier smoke cases | Completion/reopen/correction, next-game launch, betting, backup, settings and save-failure closure are already covered in the reports. No relevant new code or observed failure justifies replaying that entire checklist. |

### Lineup evidence and scope

`src/utils/teamLineups.js:21` returns `null` for both an error and no row. Initial loaders at `src/pages/SeasonRoster.jsx:1117` and `src/pages/Roster.jsx:757` reconcile `null` to defaults and mark that snapshot synchronized. This is a distinct read-path issue; the existing local change correctly fixes failed writes.

Reproduction uses the existing optional-smoke O1 fixture and `fakeRest.mjs`, against the fresh built application. Seed a custom order reversed from roster order; return 503 only for lineup GETs; open `/season/roster`; observe default order and no error toast; swap spots 1 and 3; save; restore reads; reload. The fake stored row now contains the edited defaults. Both desktop and mobile reproduce. Synthetic writes only; this is not evidence of real database permissions or production corruption.

Additional bounded verification belongs with this fix: tournament parity, absent-row defaults, selection changes during delayed reads, and pregame scorebook seeding. `useLineupEditor.js:506` also reads this helper before constructing writable game lineups, so a failed-read/no-write/retry case is important and was not exercised by this review. Other callers are `useTeamLineupSync.js` and `BettingTab.jsx`; preserve their behavior or handle errors explicitly if changing the helper contract.

### Performance evidence and limits

The browser's real Supabase client joined an intercepted realtime socket; the probe delivered three INSERT notifications to its actual season history channel. Each triggered the loader at `SeasonRoster.jsx:710`, with subscriptions beginning at line 752. There were exactly three requests for each of its 11 query URLs, including unscoped season/tournament pitch history. This establishes request amplification, not a measured production latency or database-cost claim. The tiny local fixture loaded in roughly one second; failed-read probe timings include request retries and must not be presented as normal page speed.

Routes are already lazy-loaded in `App.jsx`; Stats already uses table-level invalidation and a refresh coordinator. Do not repeat that completed optimization or introduce a cache/framework as a default response. Site-wide production latency, large-history CPU cost, and real mobile hardware speed remain unmeasured, not established defects. No site-wide performance assignment is necessary to fix the specific burst above.

## Evidence

All new probes reuse existing Playwright/Vite tooling. Supabase REST/auth/realtime and launcher traffic were intercepted before navigation; unrecognized external requests were aborted. Successful new probes recorded no unexpected external requests or unhandled page errors.

- `tmp/msl-review-build-20260930.log`: fresh build.
- `tmp/msl-review-20260930/focused-tests.log`: 9 passed, zero failed/skipped.
- `tmp/msl-review-20260930/lineup-read.mjs`, `lineup-read-1280.log`, `lineup-read-390.log`, and `lineup-read-*.png`: reproduced read failure and persisted overwrite.
- `tmp/msl-review-20260930/video-reload.mjs`, `video-reload-1280.log`, `video-reload-390.log`, and `video-reload-*.png`: retained local drafts after delayed reload.
- `tmp/msl-review-20260930/roster-performance.mjs`, `roster-performance-1280.log`: actual-browser realtime burst and request counts. The first fixture attempt used the wrong socket protocol; the final probe handles the installed client's array protocol and passes. That fixture failure was not an application bug.

Only this report, its handoff prompt, and ignored scratch artifacts were added. Pre-existing edits and `public-tracker-release/` were preserved. No credentials requested, production mutations, deployment, data deletion, agent spawning or emulator game.

## Handoff and stopping point

Use [the Opus prompt](prompts/msl-roster-reliability-opus-2026-09-30.md) for the lineup fix. It also contains a separately marked optional performance task, which can be omitted or scheduled later. Both touch SeasonRoster, so assigning them to different agents concurrently would create overlapping ownership. No Sol assignment is needed merely to fill a slot.

After the chosen task(s), review the combined diff with the existing local smoke fixes, run the affected checks once, record remaining limitations, and close this pass. A supported “passed; no code change needed” closes each verification case. Do not automatically generate another audit. Shipping remains a separate user-controlled action.
