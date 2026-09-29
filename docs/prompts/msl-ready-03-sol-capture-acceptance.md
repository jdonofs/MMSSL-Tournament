# Sol: resolve the two capture-ingestion acceptance failures, then stop

Read `CLAUDE.md` and the current-status/stopping-rule section of `docs/msl-game-readiness-2026-09-28.md`. This is a finite MSL 1 readiness task. Your browser verification is closed: its saved log records all 65 tests passing, zero failures/skips. Do not expand that work.

## Observed problem and completion condition

The follow-up review just ran:

```powershell
node --test --test-name-pattern='postgame capture ingests' tests/tracker-acceptance.test.mjs
```

Both cases still fail at line 530 because `first.warnings.length` is expected to be zero. Full output: `tmp/msl-readiness-20260928/ingestion-followup.log`.

- Tournament: one unmatched capture plate-appearance group, plus two pitches absent from canonical `pitches` rows.
- Season: two capture pitches absent from canonical `season_pitches` rows.

These assertions fail before checking ingestion counts and whether an unchanged re-ingest is a no-op. The failure does **not** establish that official scores are wrong, or that all warnings should disappear.

Finish when each mismatch is explained from source evidence, a demonstrated current defect is fixed if one exists, and both ingestion/retry cases execute their meaningful assertions successfully. If these are correctly reported historical capture/scoring differences, document and narrowly assert that behavior; no production change is required. Stop at that point.

## Investigate before changing behavior

Use the existing recording pairings in `tests/helpers/trackerAcceptanceWorld.mjs`, replay/ingestion helpers in `tests/helpers/trackerAcceptanceRun.mjs`, and actual `planDerivedPitchEvidenceUpdates` / `groupDerivedPitches` in `scripts/ingest_player_tracking.mjs`.

The two captures are:

- `data/player_tracking/luigis_mansion-20260904T171123Z` (tournament fixture).
- `data/player_tracking/peach_ice_garden-20260904T152214Z` (season fixture).

The helper names their paired tracker logs and independent workbooks. Trace the one unmatched group and four unmatched pitches to their inning/half, batter, pitch number/timer and corresponding scoring evidence. Determine whether each is historical missing/ambiguous evidence, a fixture pairing/identity issue, or a defect in current grouping/join logic. Do not infer that a missing last pitch makes every earlier pitch align correctly: verify identity/order around each affected PA. Inspect the existing restatement audit and `docs/batting-uva-feasibility-2026-09-28.md` for context; those describe other games and do not prove these particular mismatches are expected.

Keep source recordings and independent score/workbook expectations intact. Do not manufacture scoring rows, guess unresolved results, weaken identity matching, disable restatement, or suppress runtime warnings to turn the test green. Avoid running the corpus audit CLI if importing its existing helpers is enough; it writes an unrelated calibration report.

If the warnings are correct, replace the blanket zero-warning expectation with precise, independently justified fixture expectations. Assert the relevant unmatched identities as well as diagnostic behavior, and keep unexpected discrepancies failing. Ensure normal matching still has coverage; do not make all warnings globally acceptable. Preserve the existing scoring/count/no-duplication assertions and actually reach the second-ingest checks. Evidence restatement must not alter official results/counts or erase a previously true star-pitch flag.

## Ownership and boundaries

Own the affected postgame-ingestion assertion block in `tests/tracker-acceptance.test.mjs`, necessary fixture expectations, and a focused new regression file if needed. You may make a targeted change to the derived-pitch grouping/evidence-restatement portion of `scripts/ingest_player_tracking.mjs` if the investigation proves a defect there. Preserve unrelated sections and any concurrent edits.

Opus owns completion/reopen recovery, including `scripts/live_tracker_bridge.mjs`, scorebook completion hooks/services/UI, betting reversal, season lifecycle, and new game-completion tests. Do not edit those files or shared replay/database helpers. If evidence places a defect in the bridge/scoring parser, report its exact reproduction and required behavior for that owner; complete the independent diagnosis/tests instead of racing to modify the file. Do not change scoring semantics or hide the defect in the ingestion test.

No new framework, broad capture audit, model calibration, advanced-stat expansion, production database edits, historical backfill, or changes to `public-tracker-release/`. Work with the existing local fixtures and preserved recordings.

## Verification and delivery

Run the two isolated cases above and your focused regression tests. Then run `npm.cmd run test:acceptance` to ensure both sources still score and settle correctly and the ingestion retry assertions pass. If production ingestion/persistence changes, also run `npm.cmd run test:persistence`; add database checks only if database enforcement actually changes. Do not repeatedly run the entire project while Opus is editing it. Distinguish any failures caused by that ongoing work from this assignment's findings.

Provide a short record of each mismatch's cause/evidence, whether it affects current session scoring or only historical capture evidence, exact test results, and any genuinely unresolved session blocker. Add a concise resolution to the capture-acceptance item in the readiness document so the item cannot be assigned again. State when it is closed. An evidence-backed fixture-only correction is a successful result; do not invent additional work afterward.
