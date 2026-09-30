# Roster reliability pass (Opus): September 30, 2026

Prompt: [prompts/msl-roster-reliability-opus-2026-09-30.md](prompts/msl-roster-reliability-opus-2026-09-30.md). Review: [msl-review-2026-09-30.md](msl-review-2026-09-30.md).

**Task A (failed saved-lineup reads): completed. Task B (roster history burst): completed.** They are reported separately below. Both are local and uncommitted; nothing was pushed or deployed.

## Revision and changed files

HEAD is `4e63f2e`. The uncommitted working tree already contained the September 29 smoke fixes, and they are preserved: the `upsertTeamLineup` throw, the `.catch` on both `SaveLineupBar` `onSave` handlers, and the `Admin.jsx` and `UnsavedChangesPrompt.jsx` changes. This pass did not touch `Admin.jsx`, `UnsavedChangesPrompt.jsx`, the earlier reports or `public-tracker-release/`.

| File | Task | Change |
| --- | --- | --- |
| `src/utils/teamLineups.js` | A | `fetchTeamLineup` gains an opt-in `throwOnError`. The default is unchanged: it still returns `null` for a missing row or an error. |
| `src/components/SaveLineupBar.jsx` | A | New `loadStatus`/`onRetryLoad` props. While the read is loading or has failed, the bar shows "Loading saved lineup…" or "Saved lineup failed to load — nothing can be saved until it does" with a **Retry Load** button. Previously it showed "All changes saved". |
| `src/pages/SeasonRoster.jsx` | A, B | A: lineup load state, strict reads, retry, and guards against races. B: history reload goes through `createRefreshCoordinator`. |
| `src/pages/Roster.jsx` | A | The same Task A change as SeasonRoster, for tournaments. |
| `src/features/scorebook/hooks/useLineupEditor.js` | A | Pregame seeding uses a strict read. If the read fails, it writes nothing, shows a toast and retries after 5 s. |

`useTeamLineupSync.js` and `BettingTab.jsx` are unchanged. Both only apply data that was actually read, so a `null` from a failed read already made them skip, and they keep the default contract. The exporter (`scripts/export_mss_lineup.mjs`) has its own reader, which already throws on an error.

Scratch fixtures and logs are in `tmp/msl-roster-opus-20260930/`. The final combined build is `dist/`, app asset `app-QDhW2x3V.js` (`build-ab.log`).

## Task A: cause and fix

**Cause.** `fetchTeamLineup` returned `null` for both a missing row and a failed read. The initial loaders in both roster pages treated `null` as "no saved lineup". They filled in roster-order defaults, recorded those as the synced snapshot and set the load key. The page then read "All changes saved", and Save wrote the edited defaults over the stored lineup. Pregame scorebook seeding had the same fault. On the pre-change build (`before/scorebook-seed-season-1280-prefix-build.log`), a failed read produced `DELETE` and `POST` on `season_lineups` and `season_game_fielders` for game 44, with no warning. Seeding also skips any game that already has lineup rows, so after that first write the saved lineup could never replace the guessed one.

**Fix, roster pages.**
- The load reads strictly.
- A new team, a new season/tournament, or a retry after a failure first clears the editor and sets the load key to `null`. The previous team's lineup is therefore never shown as current, and nothing counts as dirty or saveable.
- A failed read leaves the page in `error`. The bar shows the failure and Retry Load, and the list shows "Saved lineup failed to load."; view-only users get a Retry button there. Auto Lineup/Fielding and fielding edits are disabled until a read succeeds.
- A failed refresh for the same team keeps the lineup on screen and any edits, and the page stays `ready`.
- `handleSaveLineup` refuses to write unless the snapshot was loaded for the current key.
- The visibility/online refresh now has a `disposed` guard. Before, a slow refresh for the previous team could resolve after a switch and be reconciled against the new team's roster.
- If a realtime row for the viewed team arrives, it ends an error state, because the row is itself a trustworthy read.
- Every async failure is caught, so there are no unhandled rejections.

**Fix, scorebook seeding.** On a failed read it makes no writes. It shows the toast "Saved lineups unavailable" once per game and retries after 5 s. The timer is cleared when the game changes and on unmount. The first successful read seeds the saved lineup, as before.

## Task A: case results

All browser runs used the built app with REST, auth, realtime and `/game-control/` intercepted before navigation. Unrecognised outbound requests were aborted and counted. **Every run: 0 external requests, 0 page errors, 0 unsupported fake-REST requests.**

| Case | Result and evidence |
| --- | --- |
| **1. Failed initial GET: season and tournament, 1280 and 390 px** | **Pass** (`lineup-read-recovery.mjs`, logs `lineup-read-recovery-{season,tournament}-{1280,390}.log`, screenshots `lineup-read-*-failed.png`).<br>Setup: A's stored lineup is reversed from roster order, and each character's stored fielding position differs from the default. Every lineup GET returns 503.<br>With reads failing: the bar reads "Saved lineup failed to load…", no lineup rows are shown, "All changes saved" never appears, and Retry Load is inside the viewport. There is no horizontal overflow and no Auto Lineup. One retry while reads still fail stays in the error state, with **0 lineup writes**.<br>With reads restored: Retry Load shows the stored order and positions, still with 0 writes. Swapping spots 1 and 3 and saving makes exactly one POST. The stored order changes, the fielding is kept, and team B's row is unchanged. After a reload the page shows the edit. |
| **2. Absent row / same-team refresh / delayed reads** | **Pass** (same logs).<br>Absent row: team C has no row. It shows defaults and "All changes saved", and an edit and save creates the row.<br>Failed refresh, same team: a GET 503 during an `online` refresh keeps the saved lineup and the "All changes saved" state. With a local edit, the edit and the dirty state survive.<br>Late reads for a previous team:<br>• B's initial read is delayed 3 s. While it loads, A's lineup is not shown. C is selected before B's read lands, and C's stored order remains.<br>• C's refresh is delayed 3 s and B is selected. B's stored order remains.<br>Late reads for a previous tournament (tournament mode only):<br>• A delayed refresh for tournament 1 does not replace tournament 2's order.<br>• A delayed initial read for tournament 2 does not replace tournament 1 after switching back. |
| **3. Failed Save / Save & Leave** | **Pass, no further change** (`o1-closure.mjs`, a copy of the September 29 O1 closure fixture with only the import path, dist and output directory changed; logs `o1-closure-{1280,390}.log`).<br>A failed Save shows "Save failed — try again / Retry Save". A failed Save & Leave keeps the dialog, the route and the edits. Retry persists and reload shows the edit. Writes: 503, 503, then one successful POST. The fixture is season-only. The tournament save path is the same code and is exercised by case 1's tournament save. |
| **4. Pregame scorebook seeding: season and tournament, 1280 and 390 px** | **Pass after the fix** (`scorebook-seed-read.mjs`, logs `scorebook-seed-{season,tournament}-{1280,390}.log`).<br>Setup: games 44 and 45 are fresh, manually scored and pregame. The commissioner opens `?game=44`, and team-lineup GETs return 503.<br>The toast appears, and over 7 s, including one automatic retry, there are **0** lineup or fielder writes.<br>With reads restored, the retry makes exactly 4 writes: DELETE ×2 and POST ×2, all with `game_id` 44. Both teams are seeded in their stored order with their stored fielding. Game 45 has no rows.<br>The launcher is intercepted; this page made 0 launcher calls. |
| **5. Exported order matches saved rows** | **Pass** (case 3's run). The real `scripts/export_mss_lineup.mjs` reads the saved rows over loopback. The away order equals the saved edit and the home team is unchanged. |

**Suites.**

| Command | Result | Log |
| --- | --- | --- |
| Isolated build (`vite build --outDir tmp/msl-roster-opus-20260930/dist`) | Passed, after A and again after A+B | `build-a.log`, `build-ab.log` |
| `npm run test:scorebook` | 64/64 | `test-scorebook.log` |
| `npm run test:persistence` | 64/64 | `test-persistence.log` |
| `node --test tests/refresh-coordinator.test.mjs tests/team-lineups.test.mjs` | 9/9 | `focused-tests.log` |

Scorebook and persistence were run after Task A. Task B touches only SeasonRoster, which neither suite covers; the rebuild and the browser runs cover it. All Task A browser cases were rerun on the final A+B build and passed.

## Task B: cause, fix and results

**Cause.** The history effect ran `load()` directly for each of ten realtime table events. A burst therefore ran several full 11-query reloads, and they overlapped. A failed query also set that dataset to `[]`, which wiped the history on screen.

**Fix, confined to that effect.** Events now call `refreshCoordinator.request()`, using the existing `createRefreshCoordinator` with its default 250 ms delay and 1500 ms maximum wait. It is paused while the tab is hidden, resumed on `visibilitychange`, and also requested on `online`.
- The load checks every result. On any error it throws, and the coordinator logs a warning, so the previous state is kept.
- A `disposed` flag drops results that arrive after unmount, and `dispose()` cancels any pending trailing load.
- Queries, stat formulas and career scope are unchanged.

**Results** (`roster-history-refresh.mjs`, logs `roster-history-{1280,390}.log`). The probe sends realtime notifications on the real history channel. It counts only the loader's 11 unfiltered queries. As a visible check, it reads the Free Agents OVR row of a free agent, Yoshi, whose history the probe changes.

| Case | 1280 and 390 px |
| --- | --- |
| **(a)** Idle burst of three events | **11 requests**, each query once. The pre-change build made **33** (`before/roster-history-1280-prefix-build.log`), matching the review. |
| **(b)** Events during a slow (1.5 s) load | 22 requests: one load plus **one** trailing load, issued after the last event. Yoshi's displayed ratings changed from `65 66 99 92 82` to `62 64 99 92 80`, so the new rows reached the screen. |
| **(c)** Hidden tab | 3 events while hidden: 0 requests. On becoming visible: one 11-query load. |
| **(d)** Failed refresh | `season_plate_appearances` returns 503. supabase-js retries it three times, so the load gives up after about 7 s. The displayed ratings stay `62 64 99 92 80`; before the change, the failure would have cleared the loaded history. The next event after recovery made 11 requests and showed the current data. |
| **(e)** Dispose | A slow load in flight plus one queued event, then navigating to Schedule: 0 history requests afterwards and no page errors. The coordinator already prevents overlapping loads within one mount. |
| **(f)** Lineup and controls | The saved lineup was unchanged after all the history reloads. The Save bar is visible and there is 0 px overflow at both widths. All Task A roster, editing and saved-lineup cases passed on this same build. |

## Fixture and production limits

- All writes went to fake REST in the browser. That shows the page's behaviour, not database guarantees, RLS or production permissions.
- The scorebook's own provider snapshot (`savedTeamLineups`, loaded in the Season/Tournament game-session providers, which were outside my ownership) still ignores its read error. It only feeds the display draft, and the only automatic write path is the one now guarded.
- MSL games that use `stats_source: 'tracker'` never run browser seeding, because `canEditScorebook` is false for them. Case 4 applies to manually scored games.
- The injected failure is a 503, which supabase-js retries three times. The failure states therefore appear after about 7 s, and these timings do not show normal page speed.
- Task B measures request counts on a small single-page fixture. It establishes less redundant work, not a production latency figure.
- The comparison runs against the review's build (`tmp/msl-review-20260930/dist`) are in `tmp/msl-roster-opus-20260930/before/`.

**Assigned pass complete.**
