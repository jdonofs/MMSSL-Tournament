# Handoff to Opus 5 — make postgame completeness accurate and efficient

Work in `C:\Users\jdono\Sluggers`. Implement a bounded correction to postgame tracking completeness. Preserve the substantial existing uncommitted changes. Read applicable repository instructions. Keep all verification offline: no Dolphin, production database writes, migration deployment, archive regeneration, or production backfill.

Read `docs/auto-tracker-review-2026-09-21.md`, then run:

```powershell
node tmp/auto-tracker-review-20260921/reproduce.mjs
```

Two confirmed defects share the completeness decision in `scripts/ingest_player_tracking.mjs`:

1. `expectedFactCounts()` / `existingFactCounts()` omit `tracking_catch_approaches`. The writer tolerates a missing approach table. Once it becomes available, retrying the same session reports `alreadyComplete: true` and never saves the omitted approaches. The reproduction expects one approach and gets zero after recovery.
2. `existingFactCounts()` uses unpaginated child-row reads, so a 1,000-row PostgREST cap understates complete sessions. A 120-play fixture containing 1,080 fielding and 1,200 movement rows makes 2,539 database operations on an unchanged retry. Twenty-one of 59 readable local play files exceed this child-row scale; it is not an extreme synthetic size.

Own completeness/recovery changes in `scripts/ingest_player_tracking.mjs` and a new test file such as `tests/tracker-ingest-completeness.test.mjs`. Sol is concurrently fixing `scripts/tracker_live_tracking_persistence.mjs`; do not modify that file. Preserve the exported shared writer's contract, and coordinate any unavoidable change to it. Avoid editing package.json or shared helpers merely for test convenience; local test wrappers can simulate caps and missing capabilities.

Required behavior:

- Make completeness independent of a server response cap. Choose reliable exact counts or complete paginated reads, with bounded query sizes. A completed session above 1,000 child rows must return without per-row reconciliation or recomputation.
- Include supported catch-approach facts in completeness and recovery. When the table is genuinely unavailable, keep the current deliberate degradation explicit; once available, ordinary retry must repair omitted facts without requiring the user to guess that `--replace` is needed.
- A timeout, permissions failure, or unrelated missing column must remain a failure, not become an empty count or an unsupported-capability result.
- Preserve version replacement, pending activation/recomputation stages, stable natural keys, operator corrections, quarantine, and conflict detection. Do not trade correctness for fewer requests.
- Test whether a same-count but wrong-key child set can be mistaken for completion. If reproduced, address it within this decision or clearly report a bounded follow-up; do not silently claim that count equality proves content identity.
- Do not introduce general batching, change statistical formulas, or refactor the entire ingester unless the confirmed issue requires it.

Add deterministic tests using the real ingester. Include counts below, at, and above the cap; missing approach table followed by recovery; partially saved approaches; lost write responses; errors while checking completeness; and unchanged completed input. Assert row identities and contents as well as counts. Measure database operations before and after on the same capped 120-play fixture, without presenting fake-client timing as a live benchmark.

Mind the test-schema gap: `tests/helpers/trackerTestDatabase.mjs` does not currently apply `20260918135000_tracking_play_pa_version_uniqueness.sql`, `20260920120000_tracker_max_speed_and_projected_landing.sql`, or `20260920130000_tracking_catch_approaches.sql`. The baseline also models some tracking IDs as integers. Use a targeted real-database fixture with the relevant types/constraints where feasible, and state exactly what is covered. Do not casually rewrite all existing database fixtures or treat passing fake tests as proof of SQL compatibility.

Run your new regression file and `npm.cmd run test:persistence`. After both agents' changes are integrated, run `npm.cmd run test:tracker`, `npm.cmd run test:database`, and `npm.cmd run test:acceptance`. Report the reproduced failures, resulting behavior, request-count improvement, actual validation, and remaining limits. Stop when the concrete completeness issues are resolved; do not manufacture extra work.
