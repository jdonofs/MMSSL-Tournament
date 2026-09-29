# Sol: close the existing browser-verification gap, then stop

The user wants a finite readiness push for the next MSL 1 session, not indefinite cleanup. Your first season-data assignment is implemented; the follow-up review ran `node --test tests/season-context.test.mjs` and all nine tests passed. Do not redesign or extend it. Read `CLAUDE.md` and the current-status/stopping-rule section of `docs/msl-game-readiness-2026-09-28.md`.

## Why this task exists

The original broad run could not execute 56 existing browser assertions because the fixture servers failed with `listen EACCES: permission denied 127.0.0.1:5173`. The follow-up just reran `node --test tests/auth-context.test.mjs`; all eight cases still fail in setup for that exact reason (`tmp/msl-readiness-20260928/auth-followup.log`). This is an observed verification gap, not evidence that auth is broken.

These five files configure Vite with `server.port: 0`:

- `tests/auth-context.test.mjs`
- `tests/at-bat-editor-identity.test.mjs`
- `tests/betting-ui.test.mjs`
- `tests/betting-experience-ui.test.mjs`
- `tests/character-mechanics-browser.test.mjs`

The installed Vite's `startServer` in `node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js` uses a falsy `configPort` branch, followed by `DEFAULT_DEV_PORT`; zero does not select an ephemeral port on this startup path. Inspect it to confirm the mechanism, but do not edit node_modules. Your new season-context fixture already obtains a nonzero available loopback port with `node:net` and passes it to Vite with `strictPort: true`. Reuse that approach with the smallest practical change. This task should primarily repair test startup and establish the results of tests that already exist.

## Scope and ownership

Own the five test files above and their necessary browser fixtures. A tiny shared test utility is acceptable if it removes identical startup code; no new test framework, generalized harness, dependency upgrade, package-script churn, machine configuration changes, or new product feature. Preserve cleanup of only the servers/browsers created by the tests. Do not kill unknown processes or alter firewall/port reservations.

Opus is actively editing completion/reopen behavior: `scripts/live_tracker_bridge.mjs`, `src/features/scorebook/hooks/useGameCompletion.js`, `src/features/scorebook/services/gameService.js`, lifecycle services, `src/components/SeasonGameSessionProvider.jsx`, `src/pages/Scorebook.jsx`, `src/utils/betResolution.js`, and `src/utils/seasonPlayoffs.js`. Treat that area and any new lifecycle files/tests as reserved. Do not revert unrelated work or touch `public-tracker-release/`.

If an unblocked browser test exposes a real defect in an existing screen outside Opus's area, reproduce and make the smallest necessary fix. If it intersects Opus's work, report the exact failure and continue independent checks; do not race to fix the same files. Distinguish an outdated fixture/locator from incorrect product behavior before changing expectations. Do not weaken identity, money, save/retry, accessibility or missing-data assertions just to get green results.

## Work and completion condition

1. Correct fixture-server binding in those five suites. Handle startup/cleanup reliably without assuming 5173 is available. Verify failures are surfaced rather than converted to skipped tests.
2. Execute their existing assertions. Close observed fixture defects and independently owned product defects, if any. An initial season-context follow-up once timed out, but isolated reruns passed all nine tests; investigate only if it recurs during this work, rather than starting a separate speculative flakiness project.
3. Stop when all 56 existing browser cases execute and pass, or provide precise remaining failures tied to active Opus work or a genuine external blocker. Include the season-context suite in the focused integration run. Do not add an all-pages audit, new feature coverage, or another task list after that condition is satisfied.

Focused command after the startup repair:

```powershell
node --test --test-concurrency=1 tests/auth-context.test.mjs tests/at-bat-editor-identity.test.mjs tests/betting-ui.test.mjs tests/betting-experience-ui.test.mjs tests/character-mechanics-browser.test.mjs tests/season-context.test.mjs
```

The expected current total is 65 tests (56 previously blocked plus nine season-context tests); explain any change rather than merely citing the number. If you modify product code, run its relevant focused regressions and `npm.cmd run build`. Avoid a broad repeat of every suite while Opus is editing the shared checkout. Use local/intercepted data only; no live bets, game resets or database changes.

Two separate tracker-acceptance assertions about capture-pitch warnings were already failing before your task. They are outside this assignment. Do not touch the ingestion/parser path or silence those warnings. They do not justify extending this browser task.

Deliver the cause, minimal changes, exact pass/fail/skip counts, and whether any session-blocking defect remains from these tests. State explicitly when this browser-verification item is closed. “Existing behavior passes; no production change needed” is a successful outcome. Do not manufacture follow-up work or claim the entire deployed project is ready from these browser checks alone.
