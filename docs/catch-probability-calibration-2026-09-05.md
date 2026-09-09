# Catch Probability and experimental OAA calibration — 2026-09-05

## Decision

**Baseline required (rejected for activation).** The predeclared gates that failed were: `eligible_sample`, `failures`, `final_test_sample`, `final_test_failures`, `calibration`, `probability_bin_coverage`, `sensitivity`. No production scorer or WAR input was changed.

## Dataset and exclusions

The archive audit read 31 sessions and 2673 derived plays. 12 sessions (1060 plays) had documented all-play joins to saved tracker logs. Opportunity definition `sluggers-of-airborne-opportunity-v1` retained 286 primary-outfielder airborne opportunities: 211 catches and 75 defensible failures. Fouls, home runs without a defensible attempt, ground/low-air balls, non-primary fielders, unjoined sessions, malformed/quarantined rows, annotations, unresolved events, errors, rebounds, Buddy/special mechanics, wall plays, truncation, and missing fixed-window projections were excluded.

Class imbalance is substantial: 73.8% catches and 26.2% failures. No malformed authoritative play rows or quarantined sessions were found. Three otherwise join-validated captures have incomplete final headers; their surviving joined plays were retained, but they make no claim about frames after the last recoverable play. Official-error rulings are not exhaustively persisted in standalone play files; 29 error-labelled annotation snapshots were excluded, and physical bobbles were never promoted to official errors.

| Eligible position | Count |
|---|---:|
| CF | 117 |
| LF | 81 |
| RF | 88 |

| Eligible direction | Count |
|---|---:|
| back | 14 |
| back_left | 69 |
| back_right | 75 |
| in | 17 |
| in_left | 49 |
| in_right | 62 |

| Eligible park | Count |
|---|---:|
| bowser_castle | 61 |
| bowser_jr_playroom | 23 |
| daisy_cruiser | 25 |
| dk_jungle | 29 |
| luigis_mansion | 13 |
| mario_stadium | 51 |
| peach_ice_garden | 29 |
| wario_city | 23 |
| yoshi_park | 32 |

The audit found 0 duplicate capture checksums and 0 exact high-precision play fingerprints shared across sessions; no near-duplicate capture group crossed a partition. Full session, class, outcome, missingness, exclusion, and primary-fielder counts are in the audit JSON.

The legacy catch-point/landing-point distance and resolution-time pair is post-outcome asymmetric and was not used. The replacement features project endpoint and time from exactly 12 frames beginning at contact; the exporter never reads the catch, landing, possession, route completion, or result. Among uncaught eligible balls, mean absolute early-projection distance error was 6.764 units and time error was 0.316 seconds.

## Split strategy

Entire capture sessions—and captures detected as related—were assigned together by a deterministic SHA-256 ordering with seed `sluggers-catch-probability-v1-held-out-20260905`. Counts were train 166, validation 69, and untouched test 51. Model/hyperparameter selection used validation only; final-test metrics were computed afterward.

## Candidate models and held-out results

The transparent baseline is a beta-shrunk empirical table by outfield position and projected required-speed band. The second candidate is L2-regularized logistic regression using only park, position, pitch-release start geometry, and fixed-window projected flight geometry. Validation selected `logistic_lambda_0.1`. On final test it produced Brier 0.1221, log loss 0.3709, ECE 0.1062, and AUC 0.8718 across 51 opportunities (12 failures). The train-climatology comparison Brier was 0.1799. Grouped bootstrap uncertainty resampled whole test sessions. Leave-one-park-out results are reported only where both classes and at least 20 rows were available.

| Final-test model | N | Catches | Failures | Brier | Log loss | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|---:|
| climatology | 51 | 39 | 12 | 0.1799 | 0.5456 | 0.0004 | 0.5000 |
| empirical_prior_32 | 51 | 39 | 12 | 0.1741 | 0.5295 | 0.0472 | 0.6581 |
| logistic_lambda_0.1 | 51 | 39 | 12 | 0.1221 | 0.3709 | 0.1062 | 0.8718 |

### Selected-model calibration

| Probability bin | N | Mean prediction | Catch rate |
|---|---:|---:|---:|
| 0.0–0.1 | 2 | 0.092 | 0.000 |
| 0.1–0.2 | 1 | 0.164 | 0.000 |
| 0.2–0.3 | 1 | 0.244 | 1.000 |
| 0.3–0.4 | 3 | 0.360 | 0.333 |
| 0.4–0.5 | 4 | 0.456 | 0.500 |
| 0.5–0.6 | 0 | n/a | n/a |
| 0.6–0.7 | 4 | 0.640 | 1.000 |
| 0.7–0.8 | 9 | 0.756 | 0.556 |
| 0.8–0.9 | 7 | 0.852 | 0.857 |
| 0.9–1.0 | 20 | 0.961 | 1.000 |

### Final-test slices

Park:

| Park | N | Catches | Failures | Brier | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|
| bowser_castle | 38 | 29 | 9 | 0.1232 | 0.1358 | 0.8736 |
| luigis_mansion | 13 | 10 | 3 | 0.1190 | 0.2161 | 0.8667 |

Direction:

| Direction | N | Catches | Failures | Brier | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|
| back | 1 | 1 | 0 | 0.5714 | 0.7559 | n/a |
| back_left | 15 | 12 | 3 | 0.1099 | 0.2442 | 0.9722 |
| back_right | 15 | 13 | 2 | 0.1016 | 0.1393 | 0.8462 |
| in | 1 | 1 | 0 | 0.0066 | 0.0812 | n/a |
| in_left | 6 | 4 | 2 | 0.0345 | 0.1450 | 1.0000 |
| in_right | 13 | 8 | 5 | 0.1747 | 0.2812 | 0.9000 |

Position:

| Position | N | Catches | Failures | Brier | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|
| CF | 16 | 13 | 3 | 0.0478 | 0.0974 | 0.9744 |
| LF | 16 | 13 | 3 | 0.1616 | 0.2011 | 0.6923 |
| RF | 19 | 13 | 6 | 0.1515 | 0.2170 | 0.8462 |

Difficulty (audit stratum from actual resolution geometry, never a predictor):

| Band (u/s) | N | Catches | Failures | Brier | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|
| 2_to_4 | 11 | 11 | 0 | 0.0296 | 0.1344 | n/a |
| 4_to_6 | 17 | 17 | 0 | 0.0316 | 0.1184 | n/a |
| 6_to_8 | 14 | 10 | 4 | 0.2460 | 0.2827 | 0.5750 |
| 8_plus | 8 | 0 | 8 | 0.2402 | 0.4105 | n/a |
| under_2 | 1 | 1 | 0 | 0.0000 | 0.0043 | n/a |

### Sensitivity and uncertainty

| Scenario | Train N | Test N | Test catches | Test failures | Brier | ECE |
|---|---:|---:|---:|---:|---:|---:|
| strict | 166 | 51 | 39 | 12 | 0.1221 | 0.1062 |
| exclude_assisted_movement | 5 | 1 | 1 | 0 | 0.0010 | 0.0317 |
| exclude_dive_leap_reach | 136 | 40 | 37 | 3 | 0.0537 | 0.0511 |
| include_wall_plays | 167 | 51 | 39 | 12 | 0.1220 | 0.1061 |
| include_special_mechanics | 177 | 54 | 41 | 13 | 0.1212 | 0.0987 |

The unassisted-only population collapses to 1 test play, so it cannot validate a separate no-glide model. The grouped bootstrap improvement over climatology was 0.0575 to 0.0585 Brier points (95% interval), but only 2 test sessions contributed; the minimum test-size gates still fail. Leave-one-park-out ECE ranged from 0.1019 to 0.2126 in parks with enough outcomes, and every reported park exceeded the 0.08 calibration target.

## Activation standard

Acceptance criteria were encoded before final-test evaluation in the model utility and copied verbatim into the evaluation artifact. Activation requires at least 500 eligible opportunities and 100 failures; an untouched test of at least 100/20; ECE at most 0.08; at least 2% Brier improvement; populated probability ranges; no session/park dominance; stable exclusions; positive grouped-bootstrap improvement; and zero post-outcome leakage.

## Files and reproducibility

- `scripts/export_catch_preoutcome_features.py`
- `scripts/catch_probability_model.mjs`
- `scripts/calibrate_catch_probability.mjs`
- `tests/catch-probability.test.mjs`
- `tests/catch_preoutcome_features_test.py`
- `data/calibration/catch-probability-preoutcome-features-v1.jsonl`
- `data/calibration/catch-probability-opportunities-v1.jsonl`
- `data/calibration/catch-probability-opportunity-definition-v1.json`
- `data/calibration/catch-probability-audit-v1.json`
- `data/calibration/catch-probability-feature-audit-v1.json`
- `data/calibration/catch-probability-split-v1.json`
- `data/calibration/catch-probability-evaluation-v1.json`
- `data/calibration/catch-probability-candidate-v1.json`
- `docs/catch-probability-calibration-2026-09-05.md`

Reproduce with `node scripts/calibrate_catch_probability.mjs --refresh-features`. The candidate artifact is explicitly status `rejected`; rejected artifacts cannot be loaded by the frozen scorer.

## Verification

- `node --test tests/catch-probability.test.mjs`: 7/7 passed.
- `python -m unittest tests/catch_preoutcome_features_test.py`: 2/2 passed.
- `npm.cmd run test:tracker`: 400/400 passed.
- `npm.cmd run test:defense`: 31/31 passed.
- A repeated calibration run produced byte-identical SHA-256 hashes for every generated artifact and this report.
- `npm run test:metrics`, `npm run test:war`, and `npm run build` were not required: expected-stat utilities, WAR inputs, and runtime JavaScript were deliberately untouched.

## Exact next collection needs

Collect at least 214 additional eligible opportunities and 25 additional failures, whichever takes longer, while keeping every new game paired with its saved tracker log. Because grouped final testing also needs 100 opportunities and 20 failures, reserve complete new sessions for test rather than topping up with individual plays. Allocate at least 100 of the new opportunities and 20 failures to untouched test sessions. Prioritize the 6–8 u/s boundary band with both catches and failures, plus successful catches above 8 u/s; the existing easy bands contain almost no failures and should not be force-balanced artificially. Rotate LF/CF/RF and add one full join-validated game at Bowser Jr. Playroom, Daisy Cruiser, DK Jungle, Luigi's Mansion, Peach Ice Garden, and Wario City, plus two at Wario Stadium, before repeating Bowser/Mario/Yoshi. Record ordinary airborne misses deliberately; do not substitute CPU-only fielding, wall catches, Buddy/special plays, or ground balls.

---

## Tooling added 2026-09-08 — the decision is unchanged

The decision above stands: **Baseline required (rejected for activation)**. The
candidate artifact is still status `rejected`, the frozen scorer still refuses
to load it, and no threshold in `ACTIVATION_CRITERIA` has moved. What follows
is the tooling that was missing between "the gates failed" and "here is what to
record next".

### `npm run calibration:gates`

`scripts/catch_probability_gate_status.mjs` reads the artifacts and reports
each predeclared gate with the distance to it. Reading it required either
re-running the whole calibration — which refits models and rewrites nine files
— or reading an 84 KB JSON by hand, so the one question that decides whether
the next recorded game is worth playing had no cheap answer.

It reads and never writes. Every threshold is read from the frozen
`ACTIVATION_CRITERIA`, and a gate the evaluation recorded as failed is reported
as failed; there is no flag that makes one pass.

It also names the sessions on disk that the last calibration never counted —
the cheapest progress available, because those games have already been played.
At the time of writing that is 20 sessions, 14 of them ready to be folded in
and 6 blocked for want of a paired tracker log.

### `npm run calibration:reserve`

`scripts/reserve_calibration_session.mjs`, and reservation support in
`buildGroupedSplit`. The report above says how to reach the final-test gates —
"reserve complete new sessions for test rather than topping up with individual
plays" — and nothing could express that: the split was a pure function of the
SHA-256 ordering, so a game recorded specifically to be held out had a 60%
chance of landing in train, and nobody found out until after it was fitted on.

A reservation moves a whole related-capture group, never a play. **It refuses a
session the current split already assigns to train or validation**, because
reserving a session for test after fitting on it is leakage with extra steps;
`--force` exists for a split being discarded and is recorded as forced. Honoured
reservations are written into the split artifact, so the assignment stays
reproducible from the files alone even though the hash no longer determines it.

### `npm run calibration:archive`

`scripts/audit_tracking_archive.mjs` answers the three questions that decide
whether a recorded game can be used at all — is there a paired tracker log, is
the capture complete, has it been derived — and with `--join` replays each
paired log through the real preview state machine and reports how many plays
actually joined.

Its first full run reproduces the numbers in
`docs/tracker-reliability-review-2026-09-05.md` and adds one that pass did not
examine: **`dk_jungle-20260828T211713Z` joins 90 of 94 plays.** The other 25
paired sessions join every play. Those four are worth looking at before the
next calibration run counts that session.

### What has NOT changed

- No model was refit, and no artifact in `data/calibration/` was regenerated.
- The reported numbers below the gates are the same ones this document already
  published: 286 eligible, 75 failures, a 51-play untouched test with 12
  failures, test ECE 0.1062, one populated probability bin, worst sensitivity
  swing 0.1211.
- The collection needs in "Exact next collection needs" are unchanged. The gate
  report restates them from the artifact rather than from this prose.
