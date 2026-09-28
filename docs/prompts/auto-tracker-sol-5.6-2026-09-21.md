# Handoff to Sol 5.6 — recover live measurement writes after restart

Work in `C:\Users\jdono\Sluggers`. Implement a focused fix for live tracking persistence restart recovery. The current working tree contains substantial unrelated uncommitted work: preserve it. Read applicable repository instructions. Do not start Dolphin, write to Supabase, deploy migrations, regenerate captures, commit unrelated changes, or perform a broad refactor.

Read `docs/auto-tracker-review-2026-09-21.md` and run:

```powershell
node tmp/auto-tracker-review-20260921/reproduce.mjs
```

The review already reproduced these defects in `scripts/tracker_live_tracking_persistence.mjs`:

1. `sync()` checks `written` before `ensureSession()` populates it. On restart, the first already-persisted play is attempted at the next ordinal. Under `20260918135000_tracking_play_pa_version_uniqueness.sql`, this conflicts with the existing PA.
2. `ensureSession()` marks every persisted parent as written without verifying its children. If a fielding insert fails after the parent commits, restart can permanently skip repairing that play's live measurements. The reproduction leaves one parent, zero fielding children, and eventually reports zero work.

Own `scripts/tracker_live_tracking_persistence.mjs` and a new dedicated test file such as `tests/tracker-live-recovery.test.mjs`. Opus is concurrently working on completeness decisions in `scripts/ingest_player_tracking.mjs`; read that shared writer as needed but avoid editing it or shared test helpers unless essential and coordinated. Put any needed fake-client extensions in your own test file. Do not edit package.json merely to register a test; provide its command for integration.

Required behavior:

- A completed live play remains a no-op after restart, with stable session, ordinal, parent ID, and child identities.
- A parent or partially saved child set is reconciled to completion under the original identity. Do not solve this by deleting facts, overwriting conflicts, weakening unique constraints, or blindly trusting the parent.
- Failures before a child commit and lost responses after commit converge without duplicate rows. Failed work remains retryable in-process and after restart.
- New plays continue after recovered plays without ordinal collisions, including fair and foul balls and delayed PA availability.
- Postgame supersession, operator-owned facts, and quarantine behavior retain their current guarantees.
- Investigate whether `loadContext()` excluding the current game causes resumed catch scoring to differ from uninterrupted scoring. Restore prior completed live history only if demonstrated necessary; avoid counting a partially written play against itself or adding a play twice. Account for failed reads after writes before marking recovery complete.

Create deterministic regression tests that fail on the current code. Model the real session/PA uniqueness rule: the fake's default only enforces session/ordinal. Cover a clean restart, a failure after the parent, partial child completion, ambiguous commit, repeated retries, and a new play after restart. Exercise the real production writer. Keep test fixtures synthetic and isolated.

Validate with your new test file, `npm.cmd run test:persistence`, and the relevant tracker tests. If working alone after integration, also run `npm.cmd run test:database` and `npm.cmd run test:acceptance`; coordinate those broader runs if Opus is still editing. Report changed files, actual test results, any remaining limitation, and a short before/after explanation. Stop once these demonstrated recovery defects are fixed; do not expand into general optimization or scoring-model changes.
