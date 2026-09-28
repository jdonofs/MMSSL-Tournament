# Pitch-input calibration audit — mario_stadium-20260925T165659Z

Third scripted input-calibration game, 41 pitches across 27 plate appearances.
The pitching side followed a block plan; batting was free. This is the first
capture recorded with `STATE_BASE = 0x900D4E00`, so the first one that contains
the team star meters at `0x900D4E24` / `0x900D4E26`.

No production model was activated and no scoring changed. One bug was fixed:
`derive_player_metrics.py` reported 0 for every star spend.

## Outcome

| Input | Separable? | By what | Evidence strength |
|---|---|---|---|
| **Star pitch** | **Yes, exactly** | fielding-side star-meter drop across the release frame | 9/9 against operator annotations, 0 false positives in 32 non-star pitches |
| **Changeup** | Partly | ball deceleration ratio, not any memory byte | 6/6 labelled changeups below every fastball by the same pitcher; 2 pitchers, 2 blocks |
| **Charge** | **No** | nothing in the state block, and nothing in the ball either | 26 labelled pitches, sweep of ~57,000 channels returned only a float-noise byte; release speed splits Daisy's pitches but not along the charge labels |
| **Aim** | Suggestive only | `plate_x_units` sign | 3/3 versus Daisy's other 10 pitches, but n=3 and one half-inning |
| **Charge duration / release timing** | **No** | no pitcher-side counter exists in the capture | `rise` feature returned nothing on any target |

## Side naming

`away_*` and `home_*` in a capture mean *the side batting in half 0* and *the
side batting in half 1*. **This audit uses the capture's convention throughout.**

| Capture side | Bats in | Nine | Pitcher when fielding | Lineup file calls it |
|---|---|---|---|---|
| `away_*` | half 0 (top) | Daisy, Petey Piranha, Red Kritter, Birdo, Boomerang Bro., Blue Toad, Red Koopa Troopa, Yellow Yoshi, Pink Yoshi | Daisy | **home** |
| `home_*` | half 1 (bottom) | Waluigi, Donkey Kong, Bowser Jr., King Boo, Brown Kritter, Purple Toad, Koopa Troopa, Green Noki, Gray Shy Guy | Waluigi | **away** |

`data/calibration/input-signal-lineup.json` has the two sides the other way
round from the capture. The capture agrees with baseball — the side that bats in
the top half is away — so the lineup file is the one that is inverted. The block
plan's "home pitching" in 1T/2T/3T is Waluigi's team, which the capture calls
`home_*`. Everything below is resolved from the capture, never from the lineup.

## Labels

Three fields are kept apart and never merged: `planned_input_mode` (the block),
`actual_input_mode` (the block corrected by the operator), and
`detected_input_mode` (what this audit infers). They are all in
`data/calibration/pitch-input-pitches-v1.jsonl` alongside
`actual_label_source`, so a block default is never mistaken for something the
operator said.

| Block | Pitches | Plan | Corrections applied |
|---|---:|---|---|
| 1T | 5 | plain, uncharged | — |
| 1B | 5 | charged | PA 6 (Waluigi, pitches 6–8) and PA 8 (Bowser Jr., pitch 10) were accidental no-charges |
| 2T | 3 | changeup | — |
| 2B | 5 | alternate by batter | PA 12 charged, PA 13 no charge, PA 14 charged changeups |
| 3T | 20 | star where available, charged otherwise | 6 annotations name the plate appearances with no star: 9 stars, 11 charged |
| 3B | 3 | aim at one corner | the corner was the LEFT side |

Corrected mode counts: 13 charged, 10 plain, 9 star, 3 changeup, 3 charged
changeup, 3 corner.

**The PA 6 correction covers all three of its pitches**, not one of them. The
lineup file's own note format is `pitch=<n if only ONE pitch of the at-bat
differed, else omit>`, and that correction carries no pitch number — the same
rule that resolved game 2 PA 23 of the slap/charge calibration to pitch level
when it *did* carry one. Pitches 6, 7 and 8 are all uncharged.

**Exclusions.** 15 pitches carry no charge label and are excluded from the
charge analysis with the reason recorded per row: 2T (3 pitches — the block
asked for a changeup and said nothing about charge), 3T stars (9 — the block
never specified the charge behind a star), 3B (3 — the block asked for aim
only). That leaves 26 charge-labelled pitches, 16 charged and 10 uncharged.
3B is excluded from the changeup analysis for the same reason, leaving 38.

## Star pitch — exact, and the deriver bug

`derive_player_metrics.py` emitted `fielding_star_meter_spent = 0` for all 41
pitches. **The deduction lands on the release frame itself** — the frame the
game's pitch counter rises, which is the frame the derivation takes as the
pitch's `before` snapshot. Differencing `before` against the pitch's resolution
compared two post-deduction readings, so a real 50-unit spend read as 0.

The fix measures the spend from the frame *before* the release and sums
frame-to-frame falls across the pitch rather than differencing the two ends, so
an award landing mid-pitch cannot cancel a spend. The meter is not a continuous
recharge: it is awarded in discrete jumps, so end-to-end differencing was wrong
in a second way as well.

Corrected numbers: **nine star pitches, 50 units each, 450 total**, all on the
fielding side, zero on the batting side (no star swing occurred in this game).
The raw fielding meter across them reads
250 → 200 → 183 → 133 → 94 → 55 → 5 → … → 55 → 5.

| | Detected star | Detected non-star |
|---|---:|---:|
| **Actual star** (9) | 9 | 0 |
| **Actual non-star** (32) | 0 | 32 |

Every one of the six 3T annotations is reproduced exactly: PA 18 star on pitch 1
only, PA 19 none, PA 20 stars on pitches 1–2 only, PAs 21–23 none, PA 24 star on
pitch 2 only.

**Cost.** All nine spends were 50. The header's cost table is regular 50,
captain 50, non-main captain 100, so **50 does not distinguish an ordinary
character from a team's own captain** — it only rules out a borrowed captain.
Waluigi threw all nine. No 100-unit spend was observed anywhere in the capture,
so the borrowed-captain cost is still untested.

### A second, independent star signal — and why it is not a star flag

`u16 0x900D4F24` is a counter that runs up from 0 and returns to 0. It produced
**exactly nine 125-frame runs, one per star pitch, each ending exactly 31 frames
before that pitch's release**. It is independent of the meter.

It is *not* a star flag. The same counter also ran **three 89-frame runs**, at
t=17494, 20600 and 28194 — immediately after pitches 20, 26 and 35, the three
pitches on which the away side scored. It is a generic cut-in timer whose length
names the cut-in. Within this capture, "a 125-frame run ending 31 frames before a
release" is a perfect star-pitch detector; across other events it is untested,
and in particular **no star swing, fielding star ability or borrowed captain
occurred in this game**, so nothing here shows what length those produce. This
is the same shape of trap as the earlier "star availability flag" that turned out
to be the star animation zeroing actor bytes, and it is reported as a candidate,
not as a detector.

### Where the star signal sits in the evidence hierarchy

- Meter drop at `0x900D4E26`: **independent evidence** for the annotations, and
  now also the detector's own source. Anything validating the detector must not
  use it.
- Cut-in counter at `0x900D4F24`: **candidate feature**, independent of the
  meter.
- Ball release speed 0.307–0.308 u/frame on 9/9 stars (decel ratio 0.38–0.40,
  flight 116–124 frames), against 0.25–0.51 and 0.54–0.89 for everything else:
  **independent evidence**, no memory byte involved.

## Charge — not separable from the capture

### The exhaustive sweep

Every byte of the 28,480-byte state block was read as a `u8` and as a big-endian
`u16` (56,959 channels), summarised per pitch over the 180 frames up to and
including the release frame, under five features: window maximum, value at
release, value one frame before release, fall across the release frame, and the
longest run of consecutive +1 increments (which is how the batter's
`swing_charge_frames` behaves). A positive float's big-endian bytes order exactly
the way the float does, so a charge meter stored as a float in 0..1 is visible to
the `u16` maximum channel; the sweep was not repeated over float reads.

**Positive control.** The same sweep, on the star target, rediscovers
`u16 0x900D4E26` — the fielding star meter — under the `release_drop` feature.
A sweep that cannot find the one answer already known is worth nothing, and
this one finds it.

**Permutation control.** 400 random relabellings of the same 26 pitches at the
same 16/10 split produced a perfect separator in at most 1 trial out of 400 per
feature. A perfect split of 26 pitches is therefore not something this sweep
manufactures by accident.

**Result: one candidate, rejected.** `0x900D710B` separates all 16 charged from
all 10 uncharged pitches at both `at_release` and `pre_release`. It is the
**fourth (low mantissa) byte of a big-endian float32 at `0x900D7108`**, part of
an array that is rewritten every frame the ball is in flight (6,949 frames of
this session) and static in between, so its value at a release frame is a
leftover from the previous ball flight. The audit checks this mechanically: the
leading `u16` of the same aligned word — which orders the way the float does —
does **not** separate the classes. A float's low mantissa byte separating two
groups is numerical noise, not state.

Nothing else in the block separates charge under any of the five features, and
nothing separates changeup at all.

**No pitcher-side charge counter exists in this capture.** The `rise` feature —
the exact shape that finds the batter's counter at `0x900D6A59` — returned no
perfect separator on any target. Consequently **charge duration and release
timing cannot be measured for a pitch**, unlike for a swing.

### What the ball says instead

Release speed is a per-character ladder, so it is only meaningful within one
pitcher. Daisy threw all 13 of her pitches at high stamina in 1B, 2B and 3B:

| Pitch | PA | Actual | Label source | Release u/f | Decel | Flight | plate_x |
|---:|---:|---|---|---:|---:|---:|---:|
| 6 | 6 | plain | operator correction | **0.5059** | 0.876 | 38 | +0.085 |
| 7 | 6 | plain | operator correction | 0.3731 | 0.750 | 60 | +0.185 |
| 8 | 6 | plain | operator correction | **0.5024** | 0.837 | 39 | +0.086 |
| 9 | 7 | charged | block 1B | 0.5030 | 0.888 | 37 | +0.388 |
| 10 | 8 | plain | operator correction | 0.3732 | 0.797 | 55 | +0.198 |
| 14 | 12 | charged | annotation PA12 | 0.4995 | 0.839 | 39 | +0.075 |
| 15 | 13 | plain | annotation PA13 | 0.3731 | 0.767 | 57 | +0.958 |
| 16–18 | 14 | charged changeup | annotation PA14 | 0.308–0.317 | 0.54–0.62 | 89–98 | +0.24…+0.62 |
| 39 | 25 | (corner) | charge not labelled | 0.4964 | 0.828 | 40 | −0.296 |
| 40–41 | 26–27 | (corner) | charge not labelled | 0.379–0.382 | 0.77–0.79 | 54–55 | −0.70…−0.66 |

Daisy's non-changeup pitches fall into exactly two release-speed tiers, ≈0.50
and ≈0.373, with nothing between them. **The tiers are not the charge.** Both
tiers contain uncharged pitches: the fast tier holds pitches 6 and 8, uncharged
by the PA 6 correction, alongside the two confirmed charges; the slow tier holds
pitches 7, 10 and 15, also uncharged. Reading the fast tier as "charged" would
mean overriding an operator correction with a theory, which is backwards.

So a charged pitch and an uncharged one leave Daisy's hand at the same speed
(0.4995–0.5030 charged against 0.5024–0.5059 uncharged — the charged pair is
marginally *slower*), and the tier is some pitch attribute this game never
labelled. The obvious candidate is the pitch type chosen at release, since the
third tier at ≈0.315 is exactly the three pitches annotated as changeups; but
nothing here labels fastball against curve, so that stays a hypothesis. A future
card should ask for pitch type by name.

The release *height* says the same thing from a second direction. It is
quantised per pitcher into a handful of discrete levels — Daisy releases at
1.066–1.078 or at 1.568–1.572 and nowhere between; Waluigi has three non-star
levels (2.840–2.844, 3.020–3.026, 3.030–3.038) and every one of his nine star
pitches leaves at 4.130–4.133. Half a unit is far more than one frame of flight
can account for, so these are separate delivery animations. For Daisy's
non-changeup pitches the level maps one-to-one onto the speed tier (1.07 ↔ 0.50,
1.57 ↔ 0.373) — and it does not track the charge labels at all: charged pitches
release at 1.07 alongside uncharged ones.

Twelve kinematic features were tested against Daisy's 5 charged and 5 uncharged
pitches — release and terminal speed, deceleration, flight length, path length,
lateral break signed and absolute, vertical drop, release height, release depth,
plate crossing and total speed jerk. **None of them separates the classes.**

**Charge is therefore invisible in both places it was looked for** — no state
byte separates it, and neither does the ball.

Release speed also does not transfer across pitchers or across the game. Waluigi's
five 1T plain pitches sit at 0.3855–0.3875 (spread 0.002), but his eleven 3T
charged pitches span 0.251–0.399 and straddle that value from both sides. No
stamina-like quantity was identified in the block — a monotone counter at
`0x900D61A1` was checked and rejected, since it changes only while the away side
bats and belongs to that side's box-score region — so the drift across Waluigi's
28 pitches is unexplained and 3T carries no usable charge contrast.

## Changeup

The only clean signal is deceleration — how much slower the ball is at
mid-flight than at release — and it is in the ball, not in memory.

| Pitcher | Mode | n | Release u/f | Decel ratio | Flight |
|---|---|---:|---|---|---|
| Waluigi | plain | 5 | 0.386–0.388 | 0.800–0.841 | 47–49 |
| Waluigi | changeup | 3 | 0.377–0.388 | 0.593–0.601 | 67–68 |
| Daisy | plain | 5 | 0.373–0.506 | 0.750–0.876 | 38–60 |
| Daisy | charged changeup | 3 | 0.308–0.317 | 0.543–0.624 | 89–98 |

A changeup leaves the hand at roughly the same speed as a fastball from the same
pitcher and then bleeds far more of it. Every labelled changeup has a lower decel
ratio than every fastball by the same pitcher. The two blocks are 3 pitches each
from 2 pitchers, and Waluigi's 3T charged pitches range 0.548–0.788 and overlap
the changeup band, so this is a within-pitcher, within-block contrast only.

The operator's PA 14 note — "you can charge or no charge changeups, doesn't seem
to make a difference" — is consistent with the charged changeups (0.308–0.317)
being slower than Daisy's plain fastball and her charged fastball alike; nothing
here separates a charged changeup from an uncharged one, and no uncharged
changeup by Daisy was thrown to compare against.

## Aim

The known throw-aim addresses are a dead end for pitching. At every pitch's
release, `0x900D6E60` and `0x900D6EB0` hold base coordinates from the previous
play's throw — (18.3, 19.25) first base, (−19.3, 20.0) third, (0.2, 39.5)
second, (0.8, 1.15) home — unchanged across whole half-innings. They describe a
fielder's throw, not a pitch.

What is left is where the ball crossed the plate. In the capture's ball frame,
negative x is the third-base side (confirmed from the plays: LF handles x=−24.6,
1B handles x=+14.4, SS handles −7.2 to −9.9). Within Daisy:

| Group | n | plate_x |
|---|---:|---|
| 3B, "aimed left" every pitch | 3 | −0.296, −0.696, −0.655 |
| all her other pitches | 10 | +0.075 … +0.958 |

13/13 separation, and the largest lateral break in the game outside a wild pitch.
It maps the operator's "left" onto negative `plate_x`. **n=3, one half-inning,
one pitcher** — this is a mapping, not an established detector, and the sign
alone is not enough across pitchers: Waluigi's plain pitches are all slightly
negative (−0.050 to −0.076) while going straight down the middle, so magnitude
matters and no threshold is calibrated.

## Star award rule

Both meters were read every frame. **The meter is not a continuous recharge**: it
moves in discrete jumps at play boundaries. A rise is also sometimes previewed and
reverted a frame or a few frames later before being re-applied (away +28 at
t=3651 reversed at 3652, re-applied at 3829; home +66 at 4243 reversed at 4364,
re-applied at 4479), and two home +50 previews at t=18030 and 19701 were reverted
and never re-applied. Never sample the meter inside those windows.

Award sizes are discrete, and the two sides are on different scales:

| Side | Position | Award amounts seen |
|---|---|---|
| away (led 1–0 … 7–0) | ahead | 7 (×4), 8, 21 (×6), 28, 30 (×2) |
| home (trailed all game, 0 runs) | behind | 11 (×2), 15 (×6), 22 (×2), 30, 33 (×3), 45, 60, 66 (×3) |

Every amount that appears on both scales as a multiple of 7 stands in the ratio
**11/7 ≈ 1.571**: 7→11, 14→22, 21→33, 42→66. The one exception is the first award
each side received — **+30 on both**, both delivered while the score was still
0–0.

That is consistent with a comeback multiplier applied to a shared base award, and
with it being 1.0 when the game is tied. It is **not** evidence that the
multiplier scales with the size of the deficit: the same 11/7 holds at a deficit
of 1 (home +33 at t=6559 and t=16927) and at a deficit of 7 (home's late awards),
and no amount grows as the deficit grows from 1 to 7.

Three things stop this from being a test of the comeback rule at all:

1. One side led from the first inning to the last. There is no crossing, so
   "trailing" is perfectly confounded with "Waluigi's team".
2. The leading side's meter **hit the 250 cap at t=14,922** and received nothing
   for the last three half-innings. All of 3T and 3B are censored on that side.
3. The pairing of a 7 against an 11 assumes the two were the same kind of event.
   Nothing here identifies what event produced any award, so the ratio rests on
   three matched pairs at most.

The per-pitch `away_score` / `home_score` fields do let a future game test this
properly. What that game needs is a lead change and a meter that does not cap.

## Not in this game

The calibration card also asked for deliberate dives, jumps and Buddy Attacks
that touch nothing, a no-shake and a max-shake baserunning advance, and a
manually steered fielder. **None of them were annotated.** Runner shake, fielder
steering and missed action attempts have no labels in this session and nothing
was inferred for them.

Also absent, and therefore untested: any star swing (the batting meter never
fell), any 100-unit borrowed-captain spend, and any uncharged changeup by Daisy.

## Counts and what not to generalise

| Block | Pitches | Plate appearances | Pitcher |
|---|---:|---:|---|
| 1T | 5 | 5 | Waluigi |
| 1B | 5 | 3 | Daisy |
| 2T | 3 | 3 | Waluigi |
| 2B | 5 | 3 | Daisy |
| 3T | 20 | 10 | Waluigi |
| 3B | 3 | 3 | Daisy |

3T alone is half the game. Every result above that rests on 3T is a
one-half-inning, one-pitcher result and is reported as such: that includes all
nine star pitches, all eleven 3T charged pitches and the whole of the late
release-speed drift. The star-pitch detector is the only finding here that is
exact, and even it has seen exactly one pitcher and one cost.

## Artifacts

- `scripts/audit_pitch_input_calibration.py` — reproduces everything above,
  including both controls.
- `data/calibration/pitch-input-pitches-v1.jsonl` — 41 rows with planned,
  actual and detected labels kept separate, the label source, the exclusion
  reason, the raw meter readings and the ball kinematics.
- `data/calibration/pitch-input-audit-v1.json` — the sweep results with their
  permutation counts, the candidate diagnostics, the cut-in runs, the kinematic
  contrasts by pitcher and every meter award in the game.
- `scripts/derive_player_metrics.py` — `_star_meter_drop` / `_star_meter_spend`,
  the release-frame fix.
- `scripts/verify_player_metrics.py` — `verify_star_meter_spend`, now covering
  the release-frame deduction and a mid-pitch award.

Checks run: `npm run test:tracker` (595 pass), `python
scripts/verify_player_metrics.py` (all pass), `npm run build`.
