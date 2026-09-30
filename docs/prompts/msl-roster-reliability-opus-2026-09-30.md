Work in C:\Users\jdono\Sluggers. Read CLAUDE.md, docs/msl-review-2026-09-30.md and the four September 28–29 readiness/smoke reports before changing code. This is a bounded implementation handoff, not another audit. Do not ask questions or spawn agents.

Task A — recommended: recover safely from failed saved-lineup reads.

Evidence: tmp/msl-review-20260930/lineup-read.mjs and lineup-read-{1280,390}.log reproduce the current bug against the real built SeasonRoster. A stored custom order is reversed from default roster order. GET season_team_lineups returns 503; the page shows defaults and “All changes saved” with no warning. Swapping two slots and saving overwrites the custom stored lineup with edited defaults; reload confirms it. The helper fetchTeamLineup in src/utils/teamLineups.js returns null for both read errors and absent rows. Initial roster loaders reconcile null to defaults and mark them synchronized. The recent local upsert/save-error fixes are already completed work; preserve them.

Authorized ownership for Task A:
- src/utils/teamLineups.js
- src/pages/Roster.jsx and src/pages/SeasonRoster.jsx
- src/components/SaveLineupBar.jsx, only if necessary for truthful load/retry state
- src/features/scorebook/hooks/useLineupEditor.js and useTeamLineupSync.js, only for the saved-lineup read/error path
- src/components/BettingTab.jsx, only to preserve/handle its fetchTeamLineup contract if that contract changes
- Focused lineup regression files and your own scratch fixtures/report. Do not modify unrelated betting/scoring behavior or shared contexts. No migration should be needed.

Implement the smallest end-to-end fix. Distinguish confirmed absence from failed reads. Failed initial loads must visibly offer recovery, must not label guessed defaults as saved, and must not permit saving/seeding guessed data over unknown stored data. Preserve the last trustworthy same-team snapshot and local edits on failed refresh. New team/competition selection must not expose an old team's lineup as current. Handle asynchronous errors without unhandled rejections. Check all helper callers if changing its contract; a backwards-compatible opt-in strict read is acceptable if it protects every mutating path in scope.

Finite acceptance checklist:
1. Real season AND tournament roster at 1280 and 390 px: seeded custom order and fielding positions; failed initial GET; truthful error and reachable retry; zero lineup writes until a trustworthy read; successful retry displays stored values; edit/save/reload retains the intended values and leaves the other team unchanged.
2. A successful no-row response still permits the existing default-lineup workflow. A failed same-team refresh retains valid local state. A delayed read for the previous team/competition cannot replace the newly selected team's data.
3. Existing failed Save and Save & Leave behavior remains recoverable, with dirty state and edits retained. Reuse the O1 closure fixture; do not change UnsavedChangesPrompt.jsx or Admin.jsx.
4. Pregame scorebook seeding, season and tournament: inject saved-lineup read failure before a fresh game's lineup exists; verify no guessed game-lineup/fielding writes. Retry with reads restored; verify the saved lineup seeds only the intended game. This is an important unverified consumer, not a previously reproduced scorebook failure. Keep local launcher/emulator calls intercepted.
5. Reuse the existing lineup exporter fixture to confirm exported order agrees with successfully saved rows. Mocked browser writes do not establish database guarantees or production permissions.

Checks: fresh isolated build; relevant new regression/browser checks; npm.cmd run test:scorebook; npm.cmd run test:persistence. Run focused scorebook/betting consumer checks only if those consumers change. No database suite is required unless database enforcement changes, which is outside the intended scope. Reuse prior unrelated passing evidence.

Task B — OPTIONAL separate performance task; omit this section if only commissioning Task A. If this entire prompt is handed off unchanged, complete A and B as separately reported changes.

Evidence: tmp/msl-review-20260930/roster-performance.mjs and roster-performance-1280.log. Three intercepted realtime season_pitches INSERT notifications on the real SeasonRoster history channel trigger 33 reads: three copies of its 11-query all-history load. Ownership is limited to the history-loading/subscription effect in src/pages/SeasonRoster.jsx and focused tests. Use src/utils/refreshCoordinator.js as an existing dependency; do not redesign it, change stat formulas, drop career history, add caching frameworks, or change packages.

Combine bursts and avoid overlapping history reloads while keeping OVR/history current. Finite acceptance: (a) the same three-event idle burst produces one 11-query load with the small single-page fixture; (b) events arriving during a load cause at most one trailing load, and final displayed data includes the last update; (c) a hidden tab defers work and refreshes when visible; (d) failed refresh retains the last good history and can recover; (e) disposed/older requests cannot replace current state; (f) roster editing, saved lineups and history/OVR values still agree before/after, with controls usable at both widths. Test slow/multipage data where needed; the acceptance is reduced redundant work, not an invented production speed target. Existing refresh-coordinator tests are relevant. Build and focused browser/regression checks suffice beyond Task A's checks.

Common boundaries: no questions, credentials, production writes, real emulator game, push, deployment, data deletion, dependency churn or broad refactor. Preserve all existing uncommitted fixes and public-tracker-release/. Use tmp/msl-roster-opus-20260930/ for scratch and an allocated loopback port. Intercept REST/auth/realtime and local launcher traffic before navigation; fail unexpected outbound requests. Stop only your own processes. Do not modify the earlier reports or the coordinator's September 30 report. No cleanup sweep.

Stopping rule: stop when the selected task's numbered cases pass or have a concrete access/environment limitation recorded. “Passed; no code change needed” is valid for verification-only cases. Do not turn adjacent observations into more tasks. Write docs/msl-roster-opus-2026-09-30.md with: revision + changed files; cause/fix; case → result/evidence; tests and request counts; fixture/production limits; remaining blocker or “assigned pass complete.” Identify Task B as completed or not commissioned. The coordinator will review the combined changes once and close the pass; do not generate another audit.
