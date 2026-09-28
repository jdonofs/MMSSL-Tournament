# Catch Probability and experimental OAA calibration — 2026-09-18

## Decision

**Baseline required (rejected for activation).** The predeclared gates that failed were: `probability_bin_coverage`. No production scorer or WAR input was changed.

## Dataset and exclusions

The archive audit read 37 sessions and 2911 derived plays. 30 sessions (2355 plays) had documented all-play joins to saved tracker logs. Opportunity definition `sluggers-of-airborne-opportunity-v1` retained 633 primary-outfielder airborne opportunities: 470 catches and 163 defensible failures. Fouls, home runs without a defensible attempt, ground/low-air balls, non-primary fielders, unjoined sessions, malformed/quarantined rows, annotations, unresolved events, errors, rebounds, Buddy/special mechanics, wall plays, truncation, and missing fixed-window projections were excluded.

Class imbalance is substantial: 74.2% catches and 25.8% failures. 0 malformed and 1 quarantined sessions were found. 5 captures have incomplete final headers; their surviving joined plays were retained, but they make no claim about frames after the last recoverable play. Official-error rulings are not exhaustively persisted in standalone play files; 31 error-labelled annotation snapshots were excluded, and physical bobbles were never promoted to official errors.

| Eligible position | Count |
|---|---:|
| CF | 269 |
| LF | 182 |
| RF | 182 |

| Eligible direction | Count |
|---|---:|
| back | 34 |
| back_left | 150 |
| back_right | 160 |
| in | 36 |
| in_left | 122 |
| in_right | 131 |

| Eligible park | Count |
|---|---:|
| bowser_castle | 80 |
| bowser_jr_playroom | 51 |
| daisy_cruiser | 73 |
| dk_jungle | 95 |
| luigis_mansion | 41 |
| mario_stadium | 73 |
| peach_ice_garden | 81 |
| wario_city | 71 |
| yoshi_park | 68 |

The audit found 0 duplicate capture checksums and 33 exact high-precision play fingerprints shared across sessions; no near-duplicate capture group crossed a partition. Full session, class, outcome, missingness, exclusion, and primary-fielder counts are in the audit JSON.

The legacy catch-point/landing-point distance and resolution-time pair is post-outcome asymmetric and was not used. The replacement features project endpoint and time from exactly 12 frames beginning at contact; the exporter never reads the catch, landing, possession, route completion, or result. Among uncaught eligible balls, mean absolute early-projection distance error was 6.785 units and time error was 0.341 seconds.

## Split strategy

Entire capture sessions—and captures detected as related—were assigned together by a deterministic SHA-256 ordering with seed `sluggers-catch-probability-v1-held-out-20260905`. Counts were train 387, validation 121, and untouched test 125. Model/hyperparameter selection used validation only; final-test metrics were computed afterward.

## Candidate models and held-out results

The transparent baseline is a beta-shrunk empirical table by outfield position and projected required-speed band. The second candidate is L2-regularized logistic regression using only park, position, pitch-release start geometry, and fixed-window projected flight geometry. Validation selected `logistic_lambda_0.1`. On final test it produced Brier 0.0922, log loss 0.3255, ECE 0.0350, and AUC 0.8668 across 125 opportunities (25 failures). The train-climatology comparison Brier was 0.1651. Grouped bootstrap uncertainty resampled whole test sessions. Leave-one-park-out results are reported only where both classes and at least 20 rows were available.

| Final-test model | N | Catches | Failures | Brier | Log loss | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|---:|
| climatology | 125 | 100 | 25 | 0.1651 | 0.5141 | 0.0713 | 0.5000 |
| empirical_prior_8 | 125 | 100 | 25 | 0.1634 | 0.5068 | 0.0831 | 0.5730 |
| logistic_lambda_0.1 | 125 | 100 | 25 | 0.0922 | 0.3255 | 0.0350 | 0.8668 |

### Selected-model calibration

| Probability bin | N | Mean prediction | Catch rate |
|---|---:|---:|---:|
| 0.0–0.1 | 7 | 0.014 | 0.000 |
| 0.1–0.2 | 4 | 0.152 | 0.250 |
| 0.2–0.3 | 1 | 0.247 | 0.000 |
| 0.3–0.4 | 2 | 0.347 | 0.500 |
| 0.4–0.5 | 2 | 0.452 | 0.500 |
| 0.5–0.6 | 4 | 0.572 | 0.500 |
| 0.6–0.7 | 13 | 0.643 | 0.692 |
| 0.7–0.8 | 9 | 0.754 | 0.889 |
| 0.8–0.9 | 17 | 0.858 | 0.882 |
| 0.9–1.0 | 66 | 0.965 | 0.955 |

### Final-test slices

Park:

| Park | N | Catches | Failures | Brier | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|
| bowser_jr_playroom | 23 | 18 | 5 | 0.1024 | 0.1163 | 0.8778 |
| daisy_cruiser | 41 | 31 | 10 | 0.0982 | 0.1191 | 0.8194 |
| dk_jungle | 29 | 23 | 6 | 0.1515 | 0.1833 | 0.7754 |
| yoshi_park | 32 | 28 | 4 | 0.0234 | 0.0743 | 0.9911 |

Direction:

| Direction | N | Catches | Failures | Brier | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|
| back | 8 | 8 | 0 | 0.0376 | 0.1398 | n/a |
| back_left | 25 | 22 | 3 | 0.1005 | 0.1455 | 0.8182 |
| back_right | 31 | 26 | 5 | 0.0917 | 0.1335 | 0.8846 |
| in | 10 | 7 | 3 | 0.1047 | 0.1133 | 0.7143 |
| in_left | 23 | 18 | 5 | 0.0666 | 0.1297 | 0.9667 |
| in_right | 28 | 19 | 9 | 0.1176 | 0.1047 | 0.9240 |

Position:

| Position | N | Catches | Failures | Brier | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|
| CF | 53 | 43 | 10 | 0.0522 | 0.0949 | 0.9791 |
| LF | 31 | 23 | 8 | 0.1260 | 0.1269 | 0.9076 |
| RF | 41 | 34 | 7 | 0.1184 | 0.1382 | 0.7101 |

Difficulty (audit stratum from actual resolution geometry, never a predictor):

| Band (u/s) | N | Catches | Failures | Brier | ECE | AUC |
|---|---:|---:|---:|---:|---:|---:|
| 2_to_4 | 35 | 35 | 0 | 0.0153 | 0.0780 | n/a |
| 4_to_6 | 40 | 36 | 4 | 0.1158 | 0.1210 | 0.5972 |
| 6_to_8 | 25 | 17 | 8 | 0.1992 | 0.1383 | 0.6544 |
| 8_plus | 13 | 0 | 13 | 0.0841 | 0.1765 | n/a |
| under_2 | 12 | 12 | 0 | 0.0236 | 0.0821 | n/a |

### Sensitivity and uncertainty

Each scenario refits the selected model on its own training rows and is scored against the strict model on the same test plays; the gate is the absolute difference. Scenarios with fewer than 20 test plays are not evaluable. (Method changed on 2026-09-18, after the first refit, by Jason's decision: the earlier version compared Brier scores on different sets of plays and so measured their difficulty, not the model.)

| Scenario | Train N | Test N | Test catches | Test failures | Scenario Brier | Strict model, same plays | Change |
|---|---:|---:|---:|---:|---:|---:|---:|
| strict | 387 | 125 | 100 | 25 | 0.0922 | 0.0922 | 0.0000 |
| exclude_assisted_movement | 7 | 3 | n/a | n/a | n/a | n/a | too_few_rows |
| exclude_dive_leap_reach | 294 | 98 | 86 | 12 | 0.0420 | 0.0454 | -0.0034 |
| include_wall_plays | 388 | 126 | 101 | 25 | 0.0922 | 0.0922 | -0.0000 |
| include_special_mechanics | 423 | 134 | 103 | 31 | 0.1041 | 0.1051 | -0.0010 |

The unassisted-only population collapses to 3 test play, so it cannot validate a separate no-glide model. The grouped bootstrap improvement over climatology was 0.0425 to 0.1052 Brier points (95% interval) across 6 test sessions. Leave-one-park-out ECE ranged from 0.0743 to 0.1335 in the 9 parks with enough outcomes; 8 exceeded the 0.08 calibration target.

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
- `docs/catch-probability-calibration-2026-09-18.md`

Reproduce with `node scripts/calibrate_catch_probability.mjs --refresh-features`. The candidate artifact is explicitly status `rejected`; rejected artifacts cannot be loaded by the frozen scorer.

## Verification

Checks for a change to this pipeline: `node --test tests/catch-probability.test.mjs`, `python -m unittest tests/catch_preoutcome_features_test.py`, `npm run test:tracker` and `npm run test:defense`. Their results belong to the change that ran them, not to this generated report.

## Exact next collection needs

Collect at least 0 additional eligible opportunities and 0 additional failures, whichever takes longer, while keeping every new game paired with its saved tracker log. Because grouped final testing also needs 100 opportunities and 20 failures, reserve complete new sessions for test rather than topping up with individual plays. Allocate at least 100 of the new opportunities and 20 failures to untouched test sessions. Prioritize the 6–8 u/s boundary band with both catches and failures, plus successful catches above 8 u/s; the existing easy bands contain almost no failures and should not be force-balanced artificially. Rotate LF/CF/RF, and favour parks with the fewest eligible opportunities above (a park with none is not scored at all). Record ordinary airborne misses deliberately; do not substitute CPU-only fielding, wall catches, Buddy/special plays, or ground balls.
