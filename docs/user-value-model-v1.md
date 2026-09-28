# User Value Added v1

Model version: `sluggers-uva-v1`

This pass separates three questions that the old combined value views could not:

1. How much run value did the team/character performance produce?
2. How much of that value came from an input the human was allowed to make?
3. How much remains character capability, automatic game behavior, interaction, or outcome variance?

UVA answers the second question. It is a companion to WAR, not a replacement
for it. WAR remains the performance ledger; UVA is the human-agency ledger.

## Evidence reviewed

The reproducible audit is `npm run audit:value`. Its machine-readable result is
`data/calibration/user-value-audit-v1.json`.

At the September 25 pass it read every non-pre-recovery local pitch/play file:

- 134 JSONL files, 5,572 pitch records, and 4,377 contact-play records.
- 159 observed slaps, 4,932 observed charges, 195 star swings, 686 dives,
  130 jumps, 57 Buddy Jumps, 562 unique Buddy Attacks, and 96 Buddy Throws.
- 8,188 runner segments and 39,393 fielder routes with measured speed.
- All 5,572 pitches have an absolute plate endpoint. All ordinary swings in
  the derived archive now have explicit slap/charge state; pitching charge,
  user aim target, and shake input remain unobserved.
- The one capture with team star meters contains 41 pitches and identifies 9
  star pitches from exact 50-unit fielding-side spends.

All 69 non-pre-recovery capture headers cover the full original state range
and therefore the swing-charge memory field. Only the four scripted
calibration sessions contain both raw Wii Remote structs, and no competitive
session does. The memory-state evidence is retroactive; raw controller evidence
is not. One session uses the expanded 28,480-byte block that also includes both
team star meters; the other 68 predate that addition.

TEST games 2946-2948 contribute 123 pitches, 117 swings, 6 takes, 97 contacts,
8 star swings, 178 runner segments, 17 dives, 3 jumps, and 6 unique Buddy
Attacks. The scorebook has 88 official PAs across those games; contact records
also include fouls, so the totals should not be expected to match.

The audit distinguishes capture records from official events and de-duplicates
bridge pitches by game plus game pitch number. Pre-recovery copies are excluded.

## Attribution contract

Every value event uses one run scale and a conserving sequence of
counterfactual expectations:

```text
league -> game/environment -> character -> chosen action -> execution -> result
```

The successive differences produce:

- game/environment runs;
- character runs;
- user decision runs, only when the action was human-controlled;
- user execution runs, only when execution was human-controlled;
- automatic decision/execution runs;
- residual runs (defense, stadium bounce, model error, and luck).

These components sum exactly to observed runs above average. A missing input is
not zero. It is `unobserved`, and no user value is awarded from it. Models must
be trained out of sample by game (preferably leave-one-game-out until the archive
is larger), with player/character effects shrunk toward league means. Otherwise
the same play teaches the baseline and receives credit against that baseline.

The production helper is `src/utils/userValue.js`. It enforces the agency gates,
refuses to infer charge from animation counters, and exposes the conserving
decomposition used by future event models.

## Batting

### Performance ledger

Keep wOBA/wRAA for realized offense and add a Sluggers xwOBA model based on exit
velocity, launch angle, spray angle, batter sprint speed on weak/topped balls,
park, and explicit star/swing mode. This follows MLB Statcast's principle that
xwOBA values comparable contact rather than the fielding result:
https://www.mlb.com/glossary/statcast/expected-woba

### User ledger

Track four additive pieces:

- **Swing Decision Runs:** expected run value of swing, take, or bunt minus the
  best contextual baseline, conditional on count, pitch endpoint, pitch type,
  velocity/movement, pitcher character, batter character, and star state.
- **Contact Execution Runs:** expected contact value after the swing minus the
  expectation for that batter character, swing mode, pitch, and count. Use
  xwOBA-like contact value, not the eventual hit/out.
- **Power Timing Runs:** charged-contact expectation at the measured charge and
  release timing minus that character's ordinary charged-swing expectation.
- **Star Swing Decision Runs:** expected value of the star swing minus the best
  non-star action, including the opportunity cost of the shared star resource.

`swing_frames` is valid for swing versus take; it is not a charge signal.
`swing_to_launch_s` also varies by character animation. Neither is used to label
slap versus charge. For captures carrying the game's `swing_charge_frames`
counter, the tracker now classifies an ordinary swing from live counter
activity: a fresh rise is `charge`, while an ordinary swing with a readable
counter and no rise is `slap`. A missing counter remains `ordinary_unknown`.
The source and measured charge duration are persisted beside the label.
Charge release timing is measured from the last charge-counter rise to the
first swing-animation frame, rather than to the later pitch-resolution frame.

Both Wii Remote input structs, including their 16-entry sample arrays, remain
available as raw evidence. They are not used for the production label: the
two-game calibration reached only 70.0% and 75.9% in the cross-game directions
with raw motion, versus 55/55 independently labelled ordinary swings for the
memory-counter detector. See `docs/swing-gesture-calibration-audit-2026-09-25.md`.

Plate discipline follows the MLB/Statcast chase-rate definition: swings at
pitches outside the zone divided by pitches outside the zone. The tracker now
retains the pitch's nearest plate-plane XYZ. A calibration of 141 taken pitches
found called strikes through `|x| = 0.6344` and called balls beginning at
`|x| = 0.6250`, so the edge is not forced into one class. Taken calls are
authoritative; offered-at pitches inside `|x| <= 0.60` are `in`, outside
`|x| >= 0.70` are `out`, and the overlap is `shadow`. Shadow pitches are
excluded from both Chase% and Zone Swing%.

New batting stats should be `SwDec`, `ConEx`, `PowTime`, `StarDec`, and their sum
`BatUVA`, all in runs. Keep rates beside totals: good choices per 100 pitches,
contact added per 100 swings, and charge-timing value per 100 charged swings.

## Pitching

### Performance ledger

Keep FIP WAR as the defense-independent season framework, but add xwOBA allowed
for contact quality. MLB's xERA rationale is directly applicable: value the
pitcher at contact before park and defense decide the outcome:
https://www.mlb.com/glossary/statcast/expected-era

Per-pitch run value should use the run impact of the event given bases, outs,
and count, matching Baseball Savant's pitch-arsenal convention:
https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats

### User ledger

- **Pitch Selection Runs:** chosen normal/changeup/star/charge state versus the
  contextual mix expected against this batter in this count and base/out state.
- **Command Runs:** expected pitch result at the measured plate endpoint minus
  the expectation at the character's typical endpoint for that intended target.
- **Charge Execution Runs:** value from measured charge duration/release versus
  the same character and selected pitch without that execution difference.
- **Star Pitch Decision Runs:** incremental expected value net of the shared-star
  opportunity cost.

Velocity and movement belong first to the character baseline. The user earns
only the marginal change explained by charge/aim inputs. The existing
fastball/curveball movement classifier does not independently prove normal
versus charged input. TEST has 122 classified scorebook pitches but no pitch
charge or absolute plate endpoint, so selection/command UVA is not publishable
yet.

The expanded capture can identify a star pitch exactly from a positive
fielding-side star-meter spend: 9/9 annotated stars and 0/32 false positives.
That positive evidence is now restated onto canonical pitch rows without ever
using a zero or absent meter delta to erase an existing tracker/scorer flag.
The same calibration did **not** expose a valid pitcher charge byte, duration,
or release marker. Changeup deceleration and plate endpoint were suggestive but
were not promoted to input labels. See
`docs/pitch-input-calibration-audit-2026-09-25.md`.

New stats: `PitchSel`, `Cmd`, `PitchCharge`, `StarPitchDec`, and `PitchUVA`.

## Baserunning

The no-Nunchuk control fact changes attribution: advance/hold, runner selection,
and route are automatic. Existing extra-base and arm run values remain useful
team/character context, following MLB Baserunning/Throwing Value's probability
framework, but **must not enter user decision value**:
https://www.mlb.com/glossary/statcast/baserunning

Human value is **Run Execution Runs**: the change in safe/out and advancement
probabilities produced by measured shake execution versus the same character's
neutral effort. Model effort as time to sprint onset, fraction of calibrated
character top speed, and time sustained—not raw speed, which would credit fast
characters to the user. One shake affects all runners; compute one play-level
team value, then allocate only the runners' marginal probability changes so the
sum is not multiplied by the number of runners.

Until shake onset/duration is captured, speed-based value is labeled
`inferred_from_speed`, never `observed_input`. New stats: `RunEx`, `SprintEffort`,
and `BsRUVA`. Automatic advance/hold value should be shown separately as
`AutoBR`, not added to UVA.

## Fielding

Keep OAA's core play equation: made out gets `1 - p(out)`; missed out gets
`-p(out)`. Difficulty should use time, distance, direction, wall/stadium
proximity, and for infield plays throw distance plus runner speed. This follows
MLB's OAA construction:
https://www.mlb.com/glossary/statcast/outs-above-average

The WAR conversion now follows current MLB Fielding Run Value rather than a
blanket 0.8: outfield range uses 0.90 runs per OAA and infield range 0.75:
https://www.mlb.com/glossary/statcast/fielding-run-value

For user attribution:

- fielder selection, positioning, automatic route, ordinary catch, and ordinary
  throw target are game/character value;
- sprint value is the catch/out-probability delta from observed effort versus
  neutral effort for the same character;
- dive/jump value is `p(out | action) - p(out | no action)` on the position's
  run scale;
- Buddy Jump/Attack/Throw Trick value is the full play-state expected-run delta
  versus the best legal ordinary action, including failures and attempts that
  never touch the ball;
- gimmick breaks/avoidance are priced from the downstream state they preserve,
  not a flat bonus.

The current ordinary OAA remains valid for character/team performance, but it
cannot all be called human fielding skill. New stats: `FldSprint`, `DiveJump`,
`BuddyAct`, `GimmickSave`, and `FldUVA`.

## Tracker additions required for publishable UVA

Highest priority, in order:

1. Batter `swing_mode` (`slap`, `charge`, `bunt`, `star`), charge duration,
   swing onset, and release-to-swing timing are implemented; an independently
   calibrated power/contact-quality timing marker remains.
2. Pitch input (`normal`, `changeup`, `star`), charge-start/release frames,
   absolute plate endpoint (now captured), and ideally the user's aim target
   before movement. Positive star-meter spends are implemented for expanded
   captures; normal/changeup intent and pitch charge remain unresolved.
3. Runner and selected-fielder shake onset, active frames, gaps, and intensity
   if the game exposes it.
4. Explicit A/B action edges for dive, jump, and Buddy Attack, so attempts that
   miss completely are retained—not just animations/contacts.
5. Stars available before and after each pitch to price resource decisions.
   This is implemented in the expanded capture format but exists in only one
   scripted session so far.

Store raw observations and model outputs separately. Every published UVA row
should retain model version, counterfactual values, confidence, and evidence
source. Refit only after a held-out validation report shows calibration by
character, action type, park, and player.

## What changed in this pass

- Added the agency map and conserving UVA primitives.
- Added reliable swing/pitch/action classifiers that preserve unknown states.
- Corrected WAR's OAA-to-runs conversion by field group.
- Added a repeatable all-archive/TEST coverage audit and regression tests.
- Added **Stats -> Value -> User Value**, with separate batting, pitching,
  baserunning, and fielding tables in both Players and Characters views. The
  page publishes observed input/action rates now and automatically consumes
  versioned per-event UVA run fields when they become available.
- UVA run cells remain blank rather than zero where the archive lacks charge,
  aim, shake, or counterfactual evidence. Each row names the missing evidence,
  so the interface does not make an unpublishable leaderboard look complete.
- Added plate-crossing XYZ, conservative in/out/shadow classification, per-pitch
  chase evidence, and Chase%/Chase Contact%/Zone Swing% to batting UVA.
- Backfilled slap/charge, charge duration, swing onset, release timing, and
  plate endpoints from every calibrated archived capture without rewriting
  existing play files. Three short competitive captures were newly calibrated;
  the only remaining uncalibrated non-pre-recovery capture contains no pitch.
- Raw input capture retains complete controller structs for ports 1 and 2 in
  the four scripted sessions. The production slap/charge label uses the
  validated in-game charge-state counter, not the weaker raw-motion classifier.
- Added exact positive star-pitch classification from fielding-side meter spend
  and conservative postgame persistence that cannot erase an older live flag.
