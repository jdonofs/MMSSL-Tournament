# Sol: make season data reliable throughout an MSL session

Implement this assignment, including regression coverage and verification. The user has limited PC time and wants existing features ready for the next MSL 1 session. Make routine implementation decisions yourself; do not stop at a plan or ask for preferences. Preserve league rules, existing data, and unrelated work. Read `CLAUDE.md` and `docs/msl-game-readiness-2026-09-28.md` first.

## Ownership

You own `src/context/SeasonContext.jsx`, necessary changes in `src/App.jsx`, and focused new season-context tests/fixtures. Inspect tournament context for the same issue and fix equivalent defects there if justified. Opus owns game completion/reopening, `src/components/SeasonGameSessionProvider.jsx`, and the tracker bridge. Do not edit those files or shared test helpers owned by that task. Use separate test files; avoid package-script changes. Preserve the pre-existing untracked `public-tracker-release/` directory.

## Confirmed defects

In `SeasonContext.jsx`, `refreshSeasons()` and the selected-season reload effect commit results without checking whether the request/selection is still current. Realtime slice refreshes also lack a guard around commits after their awaits. Disposing `createRefreshCoordinator` stops scheduling; it does not cancel a running callback's state writes.

The actual `refreshSeasons` callback was executed locally with controlled responses: refresh season 1, refresh season 2, finish 2, finish 1. Selected season remained 2 while the stored schedule belonged to season 1. This can mislead the user about the games, teams, standings, and balances they are viewing.

The same callback destructures only `data` from four query results. Injected `{ data: null, error }` responses erased loaded teams/schedule/ledger, cleared loading, and resolved successfully. The selected-season reload has the same pattern. Errors must not look like an empty season.

Mechanism reproduction: `node tmp/msl-readiness-20260928/reproduce.mjs`. This scratch file executes current source callbacks with injected boundaries; it is not a substitute for testing the mounted provider.

## Required behavior

1. Make initial loading, explicit refresh, selection changes, realtime updates, reconnect/visibility refresh, and unmount respect selection identity and request ordering. A late result or failure must not overwrite a newer snapshot or settle its loading state. Keep related data associated with its season; do not expose season B controls with season A rows during a transition.
2. Check every required query result. For a failed refresh of the same season, retain the last valid snapshot and expose an understandable error/retry state. For a failed switch or first load, expose an unavailable state rather than a plausible empty schedule. A later retry must recover without reloading the whole browser. Only a successful empty response should mean there are no rows.
3. Preserve live updates and the existing refresh coalescing. Background refreshes of the same season must not unnecessarily unmount the scorebook or discard unsaved edits. Inspect how `AppLayout` uses provider `loading` before deciding the loading/error contract. Keep existing callers of `refreshSeasons` working.
4. Check the tournament provider for equivalent stale-selection/loading behavior and repair it within the same contract if present. Do not reopen the already separate AuthProvider implementation without new evidence.
5. Use the smallest change in the existing React/context structure. No new state-management library, new test framework, redesign, or league-rule change.

## Verification

Add deterministic mounted-provider coverage using the existing Vite/Playwright approach: A-to-B requests resolving backwards; same-season old refresh resolving last; old success/error after unmount or selection change; one required slice failing; real empty results; retry recovery; background refresh preserving mounted content. Confirm schedule, teams and ledger remain scoped together. Test the actual provider, not a parallel implementation of its guard.

The review's baseline was 1,348 passing Node tests, 56 browser tests blocked by `listen EACCES: permission denied 127.0.0.1:5173`, and two tracker acceptance assertions failing on pitch-evidence warnings. The auth/scouting port failure reproduced in isolated commands; preview on 4173 and the correction/acceptance browser scripts worked. Diagnose test-server binding and use an available loopback port for your fixture; do not kill unknown processes or loosen machine security. Report environmental limitations separately from application assertions.

Run your focused regressions, `node --test tests/refresh-coordinator.test.mjs`, `node --test tests/season-playoffs-lifecycle.test.mjs`, and `npm.cmd run build`. Exercise the built schedule on desktop and mobile with intercepted/local data. The existing `tests/season-playoffs-browser.mjs` still looks for `Start Game` although the current modal says `Open Game`; if using this test, update the obsolete locator while preserving its disabled-game, identity and overflow assertions. This browser script is within your ownership.

Use local fixtures for mutations. Do not apply migrations or change live MSL records. Finish with the cause, files changed, exact test outcomes, and any remaining deployment/real-game checks. Work through fixable failures autonomously and distinguish known baseline failures from regressions.
