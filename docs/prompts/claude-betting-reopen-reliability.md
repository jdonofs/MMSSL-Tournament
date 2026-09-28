# Claude: make betting reversals recover correctly after failure

Fix the failed-reopen recovery path in `src/utils/betResolution.js`, for both tournament and season betting. Read `CLAUDE.md` and preserve all existing uncommitted work, including your completed free-agent pickup changes. Sol is working on `src/pages/AtBatEditor.jsx`; keep that file outside this assignment.

## Confirmed reproduction

`reopenGameBets` (around lines 468–510) loads only bets in `won`, `lost`, or `void` status, changes them to `open`, then deletes their `bet_settled:*` ledger rows. If the status changes commit and ledger deletion fails, retrying finds no resolved bets and skips the deletion entirely. It returns success while the old settlement credit remains.

The review reproduced this with the actual exported functions and existing `tests/helpers/bettingFixtures.mjs` / `bettingFakeSupabase.mjs`, for both competition types:

1. Create a home moneyline bet with wager 10, profit payout 15, and its placement debit.
2. Call `resolveGameBets` with a home win. The settlement credit is 25 and ledger net is +15.
3. Inject one `before` failure on the ledger table's `delete` operation.
4. Call `reopenGameBets`: it throws, but the bet is already `open` and the 25 credit remains.
5. Retry `reopenGameBets`: it returns an empty update array without error. The 25 credit is still there. Expected ledger net for the reopened ticket is -10; actual net remains +15.

This is a deterministic local reproduction, not a live balance inspection. A later successful resettlement may reconcile the ledger, but the reopened game itself remains incorrectly credited until then.

## Requested work

- Make reversal reliable under failures and retries, including recovery of the already-open/credited state created by older code. Returning success must mean the intended reversible bets and settlement ledger agree.
- Preserve placement debits, unrelated ledger reasons, unrelated games, and the other competition's records, including when numeric game IDs collide. Retain the existing reversible market types and payout semantics.
- Inspect `updateBets`, `syncLedger`, and `rollbackSettlement` before selecting the smallest fix. Do not simply reverse the write order: either boundary can fail or time out after committing. If a transaction/RPC is needed, prepare a local migration with existing permission conventions and verify relevant schema assumptions.
- Cover partial status-update failure and lost responses after a committed write. A retry must be safe regardless of which step committed. Do not conceal a failed cleanup behind a successful return.
- Check how reversal interacts with a concurrent settlement. A cleanup must not silently erase a newer valid settlement. Use the existing lifecycle/locking conventions where applicable, and distinguish tested guarantees from remaining concurrency limits.
- Inspect callers in `src/features/scorebook/hooks/useGameCompletion.js` and `src/utils/seasonPlayoffs.js`, plus shared configuration in `scripts/tracker_betting_sync.mjs`, so a failed reversal is surfaced and can actually be retried. Change callers only where necessary. Preserve calibration cleanup behavior without treating calibration failure as a reason to repeat an already-completed balance change unsafely.

Keep this focused on settlement reversal/recovery and necessary coordination. Do not rewrite odds generation, bet placement, receipts, or the editor. Do not run live audit scripts, alter live balances, or apply migrations to Supabase as part of this task.

## Tests and baseline

Add regression coverage to the existing betting tests for both sources: failed ledger deletion followed by retry, partial status updates, after-commit errors, repeated reopen, corrected-result resettlement, source/game isolation, preserved placement debits, and the relevant interleaving with settlement. Use existing local failure injection; if changing database enforcement, add focused PGlite coverage with explicit fixture/schema limits.

During this review, `npm.cmd run test:betting` completed with **159 passed and 3 failed** before any fix for this issue:

- `tests/betting-system.test.mjs`: `generateGameOdds carries current in-game counts into generated prop markets`, assertion around line 462: actual 2.5 versus expected 1.5.
- `tests/betting-tracker-integration.test.mjs`: `[tournament] a new PA reprices the board without adding a second odds row for any market`, assertion around line 159: actual 4.5 versus expected 1.5.
- The same integration test for `[season]`: actual 4.5 versus expected 1.5.

Those failures concern odds expectations and are an observed baseline, not a diagnosed cause. Do not weaken them or change the odds model to make this task pass. Report whether they remain and distinguish them from new regressions.

Run the focused new regressions, `npm run test:betting`, `npm run test:persistence`, and `npm run build`. If migrations/database enforcement change, also run `npm run test:database`. Use `npm.cmd` on PowerShell if needed. If playoff callers change, run `node --test tests/season-playoffs-lifecycle.test.mjs` too.

Deliver the targeted implementation, tests, cause, and verification results. Clearly identify any deployment requirements and concurrency limits. No new test framework or unrelated cleanup.
