# Opus: make game completion and reopening recover reliably

Implement this assignment through regression tests and verification. The goal is a smooth next MSL 1 session using the existing site and automated tracker, with no routine user input needed. Read `CLAUDE.md` and `docs/msl-game-readiness-2026-09-28.md`. Diagnose before editing, preserve current league rules and unrelated work, and choose conservative implementation details yourself.

## Ownership

Own `src/features/scorebook/hooks/useGameCompletion.js`, necessary lifecycle services/UI, `src/components/SeasonGameSessionProvider.jsx`, `scripts/live_tracker_bridge.mjs`, and focused new completion-recovery tests. You may change `src/utils/seasonPlayoffs.js` and related betting/competition services only where required by the recovery path. Sol owns season/tournament contexts, `src/App.jsx`, and season-context/browser fixtures. Do not edit those files. Avoid shared package-script/test-helper changes; add isolated tests. Preserve the untracked `public-tracker-release/` directory.

## Confirmed defects

The review executed current source callbacks with injected boundaries (`node tmp/msl-readiness-20260928/reproduce.mjs`):

- `markGameComplete` awaits `Promise.all(updatePitchingStint(...))` but ignores returned `{ error }` values. `gameService.js` returns Supabase responses rather than throwing. With a failed pitching update, the hook still set local `win: true`, produced no error, and announced `Game complete`.
- Reopening selects only stints with `win || loss`; `clearPitchingStintDecisions` clears only those two columns. A `save: true` stint remains credited on a reopened game. The callback also invokes `reopenGameBets` twice.
- The tracker bridge's `completeTrackerGameLifecycle` catches and logs errors independently. Injecting failures into all three steps (pitching decisions, stadium log, competition advancement) still returned success. `finalizeTrackerGame` then retains its successful promise and logs successful finalization. A later call returns that promise rather than retrying unfinished lifecycle work.
- The manual hook marks the game complete before downstream work, catches downstream errors, and still emits unconditional success. Reopen similarly changes the game row before all work succeeds. Inspect realtime refresh/remount and reload: a toast saying to retry is insufficient if the retry control disappears when persisted status changes.

These are local reproductions/code findings, not proof that existing MSL records are damaged. Do not repair historical records speculatively.

## Required behavior

1. Check both rejected promises and resolved Supabase errors. Do not optimistically credit pitching decisions when persistence fails. Clear W/L/S correctly on reopen, including a save-only stint. Preserve source/game scoping and unrelated pitching rows.
2. Make completion/reopen side effects repeatable after partial failure, including a response lost after commit. Preserve the final score and authoritative scoring facts. Betting settlement/reversal, pitching decisions, stadium logs, standings and bracket advancement must converge without duplicate credit, duplicate logs/stages, or lost facts.
3. Keep successful steps safe to retry and failed steps discoverable. Provide a concrete recovery path for a game whose status write already succeeded; verify recovery after refresh/reload or bridge restart, not just a second call using stale in-memory state. Prefer existing persistence/lifecycle mechanisms over introducing a broad orchestration system.
4. Check double-clicks and overlapping tracker/site completion. Preserve database lease fencing and operator corrections. Ensure a stale completion cannot undo a newer reopen/correction. If a guarantee requires database support, implement the minimal local migration and PGlite coverage with existing authorization conventions; do not claim JavaScript flags coordinate two clients.
5. The tracker must not cache a successful finalization when required lifecycle work failed. Continue independent safe steps, but expose incomplete work honestly and ensure shutdown/restart does not silently discard its recovery path. Keep required scoring writes ahead of completion and preserve capture/workbook shutdown behavior.
6. Keep manual season, tournament, regular-season, and playoff paths consistent. Do not rewrite the odds model, scoring parser, advanced metric models, or reset-for-testing workflow. Inspect existing betting reversal repairs before changing them; the old failed-ledger-delete prompt is historical and should not be reimplemented blindly.

## Verification

Add tests against the actual hook/services and bridge behavior using existing local fixtures. Cover returned `{ error }`, thrown errors, partial pitching updates, save-only reopen, repeated/concurrent completion, failed settlement or advancement followed by retry after reload/restart, after-commit response loss, and season/tournament numeric-ID collisions. Verify unchanged scores/PAs, exactly-once balance effects, correct W/L/S, and no duplicate stadium/bracket rows. Include a browser check proving the recovery control is usable after the persisted status changes. Do not treat helper-only patch-builder tests as coverage of the hook.

Run focused new tests, `npm.cmd run test:scorebook`, `npm.cmd run test:betting`, `npm.cmd run test:persistence`, `node --test tests/season-playoffs-lifecycle.test.mjs`, `npm.cmd run test:acceptance`, and `npm.cmd run build`. Run `npm.cmd run test:tracker` for bridge changes and `npm.cmd run test:database` for changed database enforcement. Use intercepted/local databases; no live balances, game resets, production backfills, or deployment.

Baseline: the broad review had 1,348 passes, 56 browser tests blocked on binding `127.0.0.1:5173`, and two acceptance failures. A separate acceptance run had 41 passes and two failures at `tracker-acceptance.test.mjs:530`: a tournament capture has one unmatched PA group and two capture-only pitches; the season capture has two capture-only pitches. The test expects zero warnings. These need a separate evidence/fixture investigation; do not suppress warnings, fabricate pitches, or change the parser to make this assignment green. Browser rendering of acceptance stats and the unresolved-at-bat correction both passed on preview port 4173.

Finish with the concrete cause/fix, exact verification results, any migration requirement, and the remaining real-game/deployment checks. Complete all independently fixable work without asking routine questions. If external validation remains, prepare the result and a short checklist rather than claiming it has been performed.
