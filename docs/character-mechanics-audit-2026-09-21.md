# Character mechanics audit — 2026-09-21

Regenerate this file exactly, read only:

```
node scripts/audit_character_mechanics.mjs --ledger --report docs/character-mechanics-audit-2026-09-21.md
```

The related checks, each answering a different question:

```
node scripts/verify_speed_against_attributes.mjs          measured vs the game attributes
node scripts/analyze_run_speed_correction_impact.mjs      the prepared run_speed migration
node --test tests/character-run-speed-migration.test.mjs  that migration, on a throwaway Postgres
```

FOUR SCOPES APPEAR BELOW AND ARE NOT INTERCHANGEABLE.

* **Database-wide** — every active tracking row, whatever the site does with it.
* **Application-visible** — the subset a scouting report reaches, after
  `selectAdvancedRows` drops games that are on no schedule. The SCOPE section
  names those games.
* **Scoped** — one season or tournament, which the page also offers. Not
  reported here; every count below is career-wide.
* **Local archive** — `data/player_tracking`, which holds captures that were
  never ingested and is therefore LARGER than the database for the same check.

Read only. No credentials or configuration are recorded here beyond the
database hostname, which is already public in the client bundle. The ledger
section is the one part that does not go through the anon key: it runs three
SELECTs through the Supabase CLI against the linked project.

```
Character mechanics audit — 2026-09-21T17:56:21.179Z
Database: cfowednmssmbvspbxzyb.supabase.co  (anon key, read only)

SCOPE
  tracking_sessions rows           23  (7 active, 16 superseded)
  active session statuses          {"ingested":7}
  distinct tracked games           7
  ...of those, on a schedule       4
  ...off every schedule            2768, 2767, 2766
       (dropped by selectAdvancedRows, so present here and absent from the character page)
  superseded play ids excluded     427

COVERAGE  (active versions only)
  active tracking_plays            220
  ...with projected landing        220  (100.0%)
  ...with a measured landing       112  (50.9%)
  ...joined to a plate appearance  91  (41.4%)
  ...unmatched                     129
  join methods                     {"inning+batter+order":89,"unmatched":86,"non_fair":43,"order_only":2}
  fielder movement rows            1980
  ...with max speed (ft/s)         1980  (100.0%)
  ...with a resolved character     1969  (99.4%)
  ...quarantined                   0
  offense rows with max speed      0  (expected 0: the offense actor has no such field)

PLATE APPEARANCES behind the tracked games
  games checked                    7
  per game                         {"2766":0,"2767":0,"2768":0,"2811":23,"2812":25,"2813":27,"2814":31}
  games with NO plate appearances  2768, 2767, 2766
       (their plays cannot join; identity still resolves from the capture)

CATCH APPROACHES
  windows on active sessions       369
  by approach                      total  qualifying  secured  qualifying+secured
    ordinary                     128          41      108                  38
    throw                        150          27      139                  19
    dive                          59          54       18                  16
    unresolved                    25          17       23                  16
    leap                           7           4        7                   4
       qualifying = passes catchApproachIsOrdinaryMechanics (not assisted at the
       resolving frame, no Buddy Jump, no stadium/star/special mechanic, not quarantined)
  display threshold                6 SECURED windows (the denominator of the shown number)
  characters with any window       38
  characters at/above threshold    {"ordinary":0,"dive":0,"leap":0}
  characters below threshold       {"ordinary":23,"dive":32,"leap":4}
  tracked games behind these       7
  per tracked game                 qualifying attempts   of those, secured
    ordinary                                  5.86               5.43
    dive                                      7.71               2.29
    leap                                      0.57               0.57
       THE SECOND COLUMN IS THE ONE THAT MOVES THE THRESHOLD. The displayed
       reach is a quantile over SECURED catches, so an attempt that came up
       empty adds coverage of the conversion rate and none of the reach.
  best covered characters (secured/attempts, at qualifying windows):
    Yoshi                  standing 5/5      dive 2/4      leap -
    Kritter                standing 3/3      dive 0/2      leap -
    Red Koopa              standing 3/3      dive 1/3      leap -
    Green Noki             standing 2/2      dive 0/1      leap -
    Tiny Kong              standing 2/2      dive 1/2      leap -
    Blue Shy Guy           standing 2/2      dive 3/4      leap -
    Red Yoshi              standing 2/2      dive 0/1      leap -
    Blue Pianta            standing 2/2      dive -        leap -
    Mario                  standing 2/2      dive 0/1      leap -
    Paratroopa             standing 2/2      dive -        leap -
    Green Shy Guy          standing 1/1      dive 0/1      leap -
    Daisy                  standing 1/1      dive -        leap -

WORKBOOK FIELD-SPEED CURVE vs THE CAPTURED CONSTANT
  scope                            active tracking sessions in the database, non-quarantined fielder rows
  characters with a constant       55
  ...reproducing the curve         53  (tolerance 0.01 ft/s)
  ...of those, interpolated        19  (rating not a published table row)
  median |error|                   0.00026 ft/s
  worst |error|                    0.000484 ft/s
  stored resolution                0.001 ft/s  (max_speed_fps is rounded to 3 dp in FEET)
  capture rounding floor           0.0005 ft/s  (half a step of that grid)
       max_speed_ups and max_speed_fps are rounded to 3 dp independently from the same unrounded constant (derive_player_metrics.py), so the ft/s value is on a 0.001 ft/s grid and is not derived from the rounded u/s value.
  characters with boosted samples  0
  characters matching neither row  2
    Green Paratroopa       characters.run_speed 64: observed [25.722], that rating implies 26.4302
      talent profile says run_speed 52, which implies 25.7223 -- matching the observation.
      THIS IS THE EVIDENCE for the prepared characters.run_speed correction. The
      audit deliberately reads the COLUMN so the disagreement stays visible; the app
      reads resolveCharacterRunSpeed(), which already prefers the profile.
    Dry Bones              characters.run_speed 40: observed [25.565], that rating implies 25.3683
      talent profile says run_speed 50, which implies 25.565 -- matching the observation.
      THIS IS THE EVIDENCE for the prepared characters.run_speed correction. The
      audit deliberately reads the COLUMN so the disagreement stays visible; the app
      reads resolveCharacterRunSpeed(), which already prefers the profile.

SAME CURVE CHECK, LOCAL ARCHIVE SCOPE
  scope                            local archive, data/player_tracking/*.plays.jsonl, fielder actors only
  session files present            59
  sessions scanned                 41  (18 calibration-excluded)
  fielder observations             26910
  characters resolved by name      72
  ...holding a run_speed           72
  ...reproducing the curve         70  (tolerance 0.003 u/s)
  ...of those, interpolated        24  (rating not a published table row)
  median |error|                   0.0002 u/s
  worst |error|                    0.0005 u/s
  characters seen only boosted     0
  characters matching neither row  2
    Green Paratroopa       run_speed 64: observed [7.84] u/s, that rating implies 8.0559
    Dry Bones              run_speed 40: observed [7.792] u/s, that rating implies 7.7323
  characters with no rating        0
  sessions showing the boost       1
    wario_stadium-20260826T005958Z  16 characters  (wario_stadium: 1 of 1 scanned captures boosted)
  capture names with no characters row  0
       characterNameKey resolved every capture name. Contrast
       scripts/verify_speed_against_attributes.mjs, which matches on the exact
       capture name and therefore drops the characters the two sides spell
       differently -- that, and not a different dataset, is why its character
       count is the smaller one.

RUNNER SPRINT SPEED — reconciling two analyses
  local archive sessions scanned   41  (18 calibration-excluded)
  retained cohort                  71 characters  (the denominator both controls are held to)
  verifier method (the retained result)
     r vs run_speed = 0.8723   characters = 71   (cohort its own, >=6 samples)
     ratio to the workbook baserun curve: median 1.1439 (p10 1.1211, p90 1.1678)
     local archive; assist_frames=0, teleports=0, run_path_units>=10; top-two-thirds mean; >=6 samples per character. Same filters and estimator as scripts/verify_speed_against_attributes.mjs.
  control: estimator only (same rows, same cohort, same threshold)
     r vs run_speed = 0.3445   characters = 71   (cohort held at 71, >=6 samples)
     ratio to the workbook baserun curve: median 1.2178 (p10 1.1666, p90 1.3071)
     ISOLATES THE ESTIMATOR. Identical filtered rows, identical characters and identical >=6 threshold as the retained result; p99 instead of the top-two-thirds mean.
  control: filters only (same estimator, same cohort, same threshold)
     r vs run_speed = 0.8758   characters = 71   (cohort held at 71, >=6 samples)
     ratio to the workbook baserun curve: median 1.1426 (p10 1.1181, p90 1.1678)
     ISOLATES THE FILTERS. assist_frames=0 only -- no teleport or run-length filter -- with the same estimator, characters and threshold.
  p99 estimator (SUPERSEDED - do not quote)
     r vs run_speed = 0.3658   characters = 54   (cohort its own, >=15 samples)
     ratio to the workbook baserun curve: median 1.2033 (p10 1.1671, p90 1.2999)
     local archive; assist_frames=0 only, no run-length or teleport filter; p99 of a character's samples; >=15 samples. Three differences from the retained result at once, over its own smaller cohort. A p99 over a few dozen windows is effectively the maximum, so it reports the noisiest run a character ever had rather than how fast they run.

  FULL-COHORT VERSIONS, reported separately because they answer a different
  question: every character clearing the threshold under those filters,
  rather than the same characters measured a different way.
  full cohort: strict filters, p99 estimator
     r vs run_speed = 0.3445   characters = 71   (>=6 samples)
     ratio: median 1.2178 (p10 1.1666, p90 1.3071)
  full cohort: loose filters, top-two-thirds mean
     r vs run_speed = 0.8758   characters = 71   (>=6 samples)
     ratio: median 1.1426 (p10 1.1181, p90 1.1678)

MIGRATION LEDGER  (read only, via the Supabase CLI — not the anon key)
  files from 20260920 on, and whether the ledger records them:
    20260920120000  RECORDED    20260920120000_tracker_max_speed_and_projected_landing.sql
    20260920130000  RECORDED    20260920130000_tracking_catch_approaches.sql
    20260920140000  RECORDED    20260920140000_catch_approach_pa_id_is_bigint.sql
    20260921120000  RECORDED    20260921120000_season_transaction_admin.sql
    20260921130000  NOT RECORDED  20260921130000_character_run_speed_corrections.sql
  20260921130000_character_run_speed_corrections   NOT RECORDED — unapplied
  current column values for its targets:
    Blue Dry Bones         run_speed 50
    Dark Bones             run_speed 50
    Dry Bones              run_speed 40
    Green Dry Bones        run_speed 57
    Green Paratroopa       run_speed 64
    Paratroopa             run_speed 52
  establishes       which versions the ledger currently records as applied, and what public.characters.run_speed currently holds for the correction targets.
  does NOT establish when any row was written, who wrote it, whether the file on disk is the one that ran, or whether anything was applied without being recorded. The table has no timestamp and no author column.

  READ THE RATIO, NOT ONLY THE CORRELATION. Correlating with run_speed says
  the measurement tracks the curve's INPUT. Whether it measures the curve's
  OUTPUT is the ratio column, and a ratio consistently away from 1.00 says it
  does not. Contrast the fielding constant above, which lands on the curve to
  0.00026 ft/s -- that is what agreement looks like.
```

## What this run found

Each statement below is generated from the numbers printed above it, so it
moves when they move. Regenerate rather than quoting it from here.

* The workbook FIELD-speed curve against the constant the fielder actor
  holds. This run:
    - 70 of 72 over the local archive (41 sessions)
    - 53 of 55 over the database
  Median |error| 0.00026 ft/s, worst 0.000484 ft/s, against a rounding
  floor of 0.0005 ft/s -- so for the characters that matched the claim is
  "indistinguishable at the stored resolution", not a precision figure.
* Linear interpolation between published rows, from the characters whose
  rating is not a table row and which matched anyway:
    - 24 of the 70 matched over the local archive (41 sessions)
    - 19 of the 53 matched over the database
* The catch-approach and coverage counts, with their denominators, and the
  per-game rate separated into qualifying ATTEMPTS and qualifying SECURED
  catches. Only the second moves the display threshold. This run, over
  7 tracked games:
    - standing 5.86 attempts a game, 5.43 secured
    - dive 7.71 attempts a game, 2.29 secured
* `characters.run_speed` disagrees with the game for 2 characters:
    - Green Paratroopa, column 64, talent profile says 52, and an observed 25.722 ft/s sits on it
    - Dry Bones, column 40, talent profile says 50, and an observed 25.565 ft/s sits on it
  CORROBORATED BY OBSERVATION: 2 of 2 (within 0.01 ft/s of the profile's own curve row).
  Every exception has a second source that the capture agrees with, which
  is what makes these evidence for a correction rather than a discrepancy.
* The boost appears in 1 archived session, named rather
  than counted so the claim stays falsifiable:
    - `wario_stadium-20260826T005958Z`, 16 characters (wario_stadium: 1 of 1 scanned captures boosted)
* Migration ledger, RECORDED STATUS: 20260921130000 is NOT recorded as applied.
  That is a statement about the LEDGER. It does not establish that the file
  was or was not applied: the table has no timestamp and no author column,
  and migrations here have been live on production while absent from it.
* Migration ledger, OBSERVED TARGET VALUES, which are a separate reading:
  Dry Bones 40 (the prior value) and Green Paratroopa 64 (the prior value).
  Every target still holds the value the correction would change, which is
  consistent with it not having taken effect. Consistent, not proof: a row
  can be set back by hand as easily as it can be corrected.

## What this run does not establish

* What triggers the x1.5 boost. One session shows it, and it is
  `wario_stadium-20260826T005958Z`. What that session is CONFOUNDED WITH is the question, and
  this report measures only part of it.
  It is also the only scanned capture of wario_stadium, so the park cannot be
  separated from whatever else is particular to this session. A second
  wario_stadium capture would separate the park from the rest; it would not
  on its own identify a setting.
  Nothing in this report measures collector format or game settings, so
  neither is asserted or excluded here.
* That the baserunning curve describes anything measured. Runner sprint tracks
  the rating (r = 0.8723 over 71 characters) but sits a consistent 1.1439x
  above the curve's own values (p10 1.1211, p90 1.1678),
  so it measures a different quantity.

## How to read these numbers

THE TOLERANCE IS NOT THE PRECISION. A constant is called ordinary only when it
is already within the match window of the curve row its rating implies, so the
difference the Scouting Report shows on that row cannot come out much larger
than the window. What the window does NOT decide is how much of the cast lands
inside it at all, and that count -- with its denominator -- is the evidence.

THE TWO SCOPES ARE DIFFERENT POPULATIONS. The local archive holds captures that
were never ingested, so it is LARGER than the database for the same check.
Neither count substitutes for the other and both are printed with their scope.

THE VERIFIER COUNTS FEWER CHARACTERS THAN THIS REPORT for the same archive, and
that is NAME MATCHING rather than a different dataset:
`scripts/verify_speed_against_attributes.mjs` looks characters up by their exact
capture name, so the ones the capture and the site spell differently drop out,
along with every Mii. This report resolves through `characterNameKey` and loses
none of them. Worth fixing in the verifier separately; it changes no conclusion
in either place.

A LEDGER ROW ANSWERS ONE QUESTION. `supabase_migrations.schema_migrations` has
`version`, `name` and `statements` -- no timestamp, no author. Its current state
says which versions are RECORDED as applied. It cannot say when a row was
written, who wrote it, whether the file on disk is the file that ran, or whether
something was applied without being recorded. Absence is not proof a migration
never ran, which is why the observed column values are reported beside it as a
separate reading rather than folded into the same sentence.

STANDING QUALIFICATIONS, independent of any run:

* The workbook catch radii and the measured separations are NOT the same
  quantity: one is glove-relative, the other runs from the fielder actor origin.
  No delta between them is published anywhere. The r = 0.73 once cited for
  standing reach is a single archive pass, not reproducible from the database
  the page reads, and it did not hold at the other approaches (dive ranked at
  r = -0.53). It is not a ranking justification.
* Which workbook column is the jump reach, what the glove offset is, and the
  fielder's facing direction are all unidentified. None is a sample-size
  problem, so no number of additional games resolves any of them. They need a
  memory mapping or a controlled scenario suite.
