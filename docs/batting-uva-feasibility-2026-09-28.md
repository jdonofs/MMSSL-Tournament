# Batting UVA feasibility evaluation — 2026-09-28

## Decision

No Batting User Value Added component is ready for publication. No production
scoring model or leaderboard was activated.

The existing archive supports useful out-of-game checks of swing behavior,
contact probability, and contact-quality estimation. It does not support a
defensible player-minus-character run attribution. In this cohort every one of
the 54 batter characters belongs to only one of the six players, all 54
player/character cells are sparse, and five of seven parks appear in only one
game. Player, character, opponent, and park effects therefore cannot be
separated reliably.

The reproducible artifacts are:

- `data/calibration/pitch-evidence-restatement-audit-v1.json`
- `data/calibration/batting-uva-evaluation-v1.json`

## Archive-to-database restatement dry run

The restatement audit examines all 69 non-pre-recovery pitch sessions and
selects only the session named by each season game's manifest. It never writes
to the database.

| Scope | Sessions/games | Capture pitches | Canonical pitches | Safe updates |
| --- | ---: | ---: | ---: | ---: |
| Saved bridge-state mirror | 11 games | 511 | 510 | 474 |
| Live database rows visible to tracker account | 3 games | 123 relevant capture pitches | 124 | 122 |

The 69 archive sessions divide into 11 selected game sessions, four duplicate
game captures, 22 calibration-excluded sessions, and 32 sessions without a
durable game identity. Only the selected sessions are eligible for canonical
restatement. A missing game identity is not guessed from date, park, lineup, or
file order.

The local bridge-state mirror produces 474 safe updates across 281 matched
plate-appearance groups. It leaves seven complete PA groups and 19 individual
pitch-number mismatches unapplied. Fifty-five PAs contain multiple swing modes;
each update remains keyed to one canonical pitch row. There are no duplicate
targets.

The read-only remote check found 88 PAs and 124 canonical `season_pitches` rows
for games 2946–2948. It planned 122 updates: 31 in game 2946, 59 in game 2947,
and 32 in game 2948. The tracker account saw no canonical rows for games
2751–2814; those rows may be absent or outside its row-level-security scope, so
the dry run treats them as unavailable. They must not be written from the
archive unless a future read audit can identify their canonical rows.

Every planned update is restricted to input/evidence fields: swing offer,
swing mode and source, charge frames, release timing, plate XYZ, zone/source,
chase state, and positive star-pitch evidence. The audit found:

- zero scoring-field update attempts;
- zero false/negative star-pitch updates;
- zero duplicate canonical targets;
- no positive star-pitch update in the eligible official-game cohort.

The scripted star-pitch calibration has exact positive meter evidence but no
official game identity, so it is correctly excluded from canonical database
restatement. The persistence rule still permits only `is_star_pitch = true`;
absent or zero meter evidence can never clear an existing flag.

## Evaluation cohort

The feasibility evaluator uses the saved scorebook state for all 11 existing
season games. This is broader than the currently visible remote database cohort
and is intentionally labeled as an offline evaluation cohort.

| Sample | Count |
| --- | ---: |
| Whole games | 11 |
| Safely aligned pitches | 474 |
| Offers / takes | 403 / 71 |
| Ordinary swings | 384 |
| Slap / charge swings | 31 / 353 |
| Swings with contact labels | 403 |
| Charged swings with duration and release timing | 353 |
| Star swings | 19 |
| Non-star terminal contacts with post-contact physics | 234 |
| Official pitches with star availability observed | 0 |
| Official pitches with controller side observed | 0 |

Missing fields are omitted from model vectors and remain unobserved. They are
never converted to numeric zero.

## Whole-game held-out results

All predictions use leave-one-whole-game-out evaluation. No pitch from the held
out game is present in its training baseline. The behavioral models use only
count, measured pitch/plate context, player, character, opponent, park, and—when
appropriate—swing mode and charge timing. Realized hit/out/RBI is not a
pre-contact input.

| Check | N | OOF Brier | Game-baseline Brier | OOF AUC | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| Swing/take behavior | 474 | 0.1165 | 0.1309 | 0.7289 | Predictive behavior, not decision value |
| Slap/charge behavior | 384 | 0.0960 | 0.0770 | 0.2039 | Worse than baseline; strong game/distribution shift |
| Contact probability | 403 | 0.1441 | 0.1804 | 0.7722 | Useful feasibility signal, not player-minus-character runs |
| Charged contact, context only | 353 | 0.1490 | 0.1796 | 0.7467 | Association only |
| Charged contact, plus counter timing | 353 | 0.1508 | 0.1796 | 0.7378 | Timing worsened held-out Brier by 0.0018 |

The swing/take Brier score ranges from 0.0001 to 0.1929 by held-out game; the
contact model ranges from 0.0314 to 0.2121. This spread is too wide for a
published value model.

The existing out-of-fold contact kernel evaluated 234 non-star terminal
contacts using measured exit velocity and launch angle. It achieved hit AUC
0.7068 and Brier 0.1856, but its wOBA-value MAE was 0.5073 and RMSE was 0.6149.
Realized results are training/evaluation targets for this post-contact model,
never input features. The residual wOBA variance is 0.3779 and still combines
defense, stadium interactions, automatic behavior, model error, and luck.

## Component readiness

- **Swing Decision Runs — not publishable.** The archive observes and predicts
  swing/take/bunt behavior, but it does not identify the value of the unchosen
  action.
- **Slap-versus-charge choice — provisional behavior only.** There are only 31
  slaps against 353 charges, and the grouped model performs worse than its
  baseline.
- **Contact Execution Runs — not publishable.** Contact prediction is promising,
  but contact-quality error and player/character confounding are too large.
- **Power/Charge Timing Runs — not publishable.** Adding charge-counter timing
  does not improve held-out contact prediction, and the same counter is not an
  independent power/contact execution marker.
- **Star Swing Decision Runs — not publishable.** Nineteen star swings exist,
  but official-game star availability and shared-resource opportunity cost are
  unobserved.
- **Automatic/character contribution — unidentified.** Every batter character
  in the cohort is exclusive to one player.
- **Residual outcome variance — descriptive only.** It cannot be allocated to a
  user, character, defense, stadium, or luck.
- **Total Batting UVA — not publishable.** Its required component run values are
  not independently identified or calibrated.

## Confounding and remaining blind spots

The cohort contains six players and 54 batter characters across seven parks.
All 54 characters are observed with exactly one player, so character effects
are nested inside player effects. Every player/character cell has fewer than 20
pitches or appears in only one game. Daisy Cruiser contributes four games and
Mario Stadium two; each other park contributes one. Park and matchup slices are
therefore descriptive, not stable adjustments.

The tracker still cannot observe pitch charge input, intended pitch aim,
runner/fielder shake effort, missed dive/jump/Buddy-action button attempts,
independent batter power/contact timing beyond the charge counter, controller
side in official games, or official per-pitch star availability. None receives
UVA credit.

## Reproduction

```text
npm run audit:uva-restatement
npm run audit:uva-restatement:remote
npm run evaluate:batting-uva
npm run test:batting-uva
```

The remote audit performs authenticated reads of `characters`,
`season_plate_appearances`, and `season_pitches`; it contains no database write
operation. Production restatement remains a separate, explicitly approved
future action.

