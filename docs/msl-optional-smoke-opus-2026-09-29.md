# Optional smoke pass — Opus rows O1–O5 — September 29, 2026

Checklist: [msl-optional-smoke-2026-09-29.md](msl-optional-smoke-2026-09-29.md). Prompt: [prompts/msl-smoke-opus-2026-09-29.md](prompts/msl-smoke-opus-2026-09-29.md).

**Source:** HEAD `4e63f2e` (`Bug fixes`, the deployed candidate) plus one product change made in this pass: `src/utils/teamLineups.js` (O1). No other product file was touched. The readiness report's existing edits and `public-tracker-release/` are untouched.

**Isolation:** No real credentials were used and nothing was written outside the local fixtures. The browser runs used the built app, with every Supabase REST, auth, realtime and launcher request intercepted before navigation. Any other off-machine request was aborted and recorded; none occurred. Three read-only `select`s went to the linked production catalog (`pg_get_functiondef`, `pg_constraint`, `information_schema.columns`); nothing was written. Scripts, logs and screenshots are in `tmp/msl-optional-smoke-20260929/opus/`.

| Row | Result |
| --- | --- |
| O1 | **Fail → fixed.** A failed lineup save reported "All changes saved". Fixed in `teamLineups.js`, then verified at 1280 and 390 px. |
| O2 | **Pass.** Pickup and trade acceptance were run on real PostgreSQL (PGlite), including a stale asset and a rolled-back write. |
| O3 | **Pass.** A season bet went through a failure, then a double-clicked retry, then a reload: one ticket, one debit, and the balance agrees. |
| O4 | **Pass on existing evidence.** The candidate still matches the tested files, and the change does not touch the completion path. |
| O5 | **Pass, with one minor Sol-owned defect.** Settings save, reload and failure all behave. A backup with a failed table says it is incomplete, but the file does not record it and a success toast follows. |

## O1 — saved lineup

**Action.** `o1-lineup-save.mjs` runs the built app at `/season/roster` as the owner of team Alpha (synthetic season 7), with a saved lineup Mario…Boo. It taps spot 1 then spot 3, which swaps Mario and Peach. It presses **Save Lineup** while `POST season_team_lineups` returns 503, then presses **Retry Save** with the write allowed. It reloads the page. Finally it runs the real game-setup export `scripts/export_mss_lineup.mjs` (`MSS_GAME_ID=44`) against the same rows, served over loopback.

**Before the fix (candidate build `app-CwOhEGHu.js`, `o1-before-1280.log`).** The 503 reached the database, and the stored order stayed Mario, Luigi, Peach…. The bar still read **"All changes saved / Saved"** with the button disabled. The edited order (Peach, Luigi, Mario…) was still on screen but no longer marked unsaved. So the unsaved-changes guard was off: leaving or reloading lost the edit, and the export would have sent the old order to the game.

**Cause.** `upsertTeamLineup` returned `{ error }` instead of throwing. Both `SeasonRoster.jsx` and `Roster.jsx` wrap the call in `try/catch` and mark the lineup saved whenever the promise resolves. Their catch branch (status `error`, "Retry Save", and the Save & Leave prompt staying put) could never run. The tournament roster had the same defect.

**Fix.** `upsertTeamLineup` now throws the PostgREST error. It has no other callers, and both pages already handle a throw.

**After the fix (`o1-after-1280.log`, `o1-after-390.log`).** A failed save shows "Save failed — try again / Retry Save", keeps the edited order on screen and leaves the database order unchanged. The retry stores Peach, Luigi, Mario…. After a reload the page shows that order. The export's away slots are Peach, Luigi, Mario…, and the home team's are unchanged. Writes were one `POST season_team_lineups → 503` and one successful `POST`, with no external requests.

**Regression checks.** `npm.cmd run build` passed. `npm.cmd run test:scorebook` passed 64/64 (it includes `team-lineups`). The tournament `Roster.jsx` handler is line-for-line the same as the season one and was not driven separately in a browser.

**For Sol (cosmetic, not blocking).** After a failed save, the page's `throw err` in `handleSaveLineup` becomes an unhandled promise rejection, because `SaveLineupBar` calls it straight from `onClick`. Playwright records it as `pageerror: Object`. The rethrow is still needed by `UnsavedChangesPrompt`. The minimal fix is `onSave={() => handleSaveLineup().catch(() => {})}` on the `SaveLineupBar` in both `SeasonRoster.jsx` and `Roster.jsx`.

## O2 — pickup and trade

**Existing evidence (rerun, unchanged code).** `tests/season-free-agent-pickup.test.mjs` applies the real pickup migration in PGlite: an atomic add, drop and waiver; injected failure rollback; stale drop; retry idempotency; refused callers. It passed together with `betting-ui` (18/18, `test-pickup-bettingui.log`).

**New check (`o2-trade-pglite.mjs`, `o2-trade-pglite.log`).** `accept_season_trade_proposal` is not in the repository. Its production definition was read with `pg_get_functiondef` (`o2-trade-fn.out`), as was the live status constraint, which does include `'failed'` (`o2-trade-constraints.out`). That exact definition was run in PGlite against the existing reconstructed season tables plus migration 039's trade tables, called the way the page calls it (`supabase.rpc('accept_season_trade_proposal', { p_proposal_id })`).

- The pickup went through `submitSeasonFreeAgentPickup`: Boo in, Toad out, still 9 players. An identical retry changed nothing.
- Trade Luigi ⇄ Bowser Jr. The rival accepted, returning `accepted`; both rosters were swapped and both stayed at 9. A second accept raised "no longer pending" and changed nothing.
- Stale asset: Peach ⇄ Toadette was proposed, then the owner dropped Peach in a pickup. The accept returned `failed:roster_changed`, no roster row moved, and the proposal was marked `failed`. The page shows its "Trade failed … marked failed" toast for this outcome.
- Rejected write: a trigger made the roster update raise. The RPC returned an error, and the decision, proposal status and roster were all exactly as before. Once the trigger was removed, the same accept applied.

**Limits.** The season tables are the fixture's reconstruction, not production DDL or RLS, and `season_trade_deadline_passed` was stubbed to false. PGlite runs one connection at a time, so this shows the function re-checks committed rows and rolls back as a unit. It does not show behaviour under truly concurrent transactions. The function does not lock `season_roster` rows; the pickup migration's own header already records that window. No defect was found.

## O3 — synthetic bet and retry

**Existing evidence.** `betting-ui` "a failed placement keeps the slip intact, and the retry places exactly one ticket" covers tournament mode (passed in this run). `betting-tracker-integration` covers settlement, reopen and retry ledger idempotency. Neither checks a season placement after a reload.

**New check (`o3-season-bet.mjs`, `o3-season-bet.json`, `o3-my-bets-*.png`).** It uses the existing betting fixture page (the real `BettingTab` in season mode, with the in-memory client and no network), starting from a $500 balance, at 1280 and 390 px. The `place_season_bets` stand-in fails on the first call and writes nothing. Later calls write the ticket and its `bet_placed` ledger debit together, as migration 072's function does.

- Place $5 on the moneyline. The toast says "Bet failed", the slip is kept, there are 0 tickets, the ledger has only the seed row, and the balance still shows $500.00.
- **Double-click** Place Bets. Exactly two `place_season_bets` calls in total (the failure and one retry), each for season 5 with one bet. One ticket (away +120, $5), one ledger row of −5, balance $495.00, slip cleared, and no tournament tables touched.
- **Reload** (a new page seeded from the tables the placement left). Balance $495.00 and "My Bets (1)", with no page errors.

**Fixture vs production.** The stand-in only lets the UI be checked against the committed outcome; it does not prove atomicity. That comes from `place_season_bets` being a single plpgsql function under a per-player advisory lock. **Limitation, not a defect:** the function takes no idempotency key. If a response is lost after the commit and the user retries, a second, visible ticket and debit are placed. Tickets, ledger and balance still agree. Closing that would be a schema and feature change, which is outside this pass.

## O4 — completion, reopen and correction

**Pass on existing evidence; nothing was replayed.** `sha256sum -c tmp/msl-readiness-20260928/release-check/candidate-files.sha256`: 39 of 41 files match. The two differences are the readiness report and the documented viewport override in `tests/game-completion-recovery-browser.mjs`, both expected. The only product change since then is `upsertTeamLineup`, whose sole callers are the two roster pages. The completion, bridge, scorebook and betting code does not call it (`fetchTeamLineup` is unchanged).

The release evidence therefore still applies to the deployed candidate:
- `node-tests.log`: 1,441/1,441.
- `game-completion-recovery-browser.log` and `-390.log`: a failed completion step keeps the control, the second press finishes W/L/S, and a reload shows no banner.
- `at-bat-correction-browser.log`: a correction saved in one transactional call.
- Acceptance settlement cases.

The user's successful physical test game was not re-audited.

## O5 — season settings and backup

**Scope reviewed.**
- `EditSeasonModal.handleSave` writes `seasons` for the one id, then `season_schedule` only for that season. Once the season has started, that is the scheduled games; before it starts, it is a rebuild of the regular season.
- `handleSeasonSaved` only refreshes and shows a toast.
- `handleBackup` makes 21 read-only `fetchAllRows` selects across all seasons and tournaments (global by design: "Export all stats and seasons"). It does not include bets, ledgers, lineups or transactions.
- A read-only catalog check (`o5-backup-columns.out`) confirms all 21 tables exist in production with `id` and every column the backup orders by. No backup query fails in production today.

**New check (`o5-admin.mjs`, `o5-admin-1280.log`, `o5-admin-390.log`).** The built `/admin` page as a synthetic commissioner, at both widths:
- **Save and reload.** Innings 3 → 5 wrote `PATCH seasons id=7` and `PATCH season_schedule season_id=7 & status=scheduled`. Game 44 became 5; completed game 42 and season 8's game stayed 3. The toast read "Season updated". After a reload, Edit shows 5.
- **Failed save** (`PATCH seasons` → 503). The toast reads "Unable to update season", the modal stays open with the edit, and nothing changed or was written to the schedule.
- **Half-failed save** (season accepted, schedule 503). An error toast shows and the modal stays open. Until the retry, the season says 7 and the scheduled game says 5; the retry brings both to 7. The two writes are not atomic, but the failure is reported and a retry fixes it. This is a limitation, not a defect.
- **Backup, clean.** One download, no writes, all sections present.
- **Backup with `season_plate_appearances` failing (503).** Two toasts appear: "Backup incomplete — 1 table(s) failed…", then "Backup downloaded — All stats saved to your device." The file (`o5-backup-with-failed-table.json`) still downloads with `season.plateAppearances: []` and no marker, so it cannot be told apart from a genuinely empty table.
- Delete, Recompute and Award were not pressed.

**Finding (Sol-owned `Admin.jsx`, minor, not a session blocker).** A failed table does get on-screen feedback, but the exported file looks complete and the success toast contradicts the warning. Minimal change in `handleBackup`:
- When `failedTables.length`, add `incomplete: true` and `failedTables: [<table names>]` to `backup`. Map the indices to names rather than reporting a count.
- Skip the "All stats saved" toast in that case, or show the incomplete warning in its place.

No production table currently fails (see above), so this only matters if a query starts failing.

**Observation, not a defect.** `EditSeasonModal` is always mounted with `season=null`, so on opening, its first frame shows default values (blank name, 3 innings) until the effect fills the real ones. A test reading the form within that frame sees defaults. A person cannot act inside one frame, and nothing wrong can be saved.

**No new session blocker found; pass complete.**
