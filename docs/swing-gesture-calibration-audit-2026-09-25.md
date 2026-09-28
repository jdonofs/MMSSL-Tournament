# Slap/charge calibration audit — 2026-09-25

## Outcome

The two games are **mario_stadium-20260925T122709Z** (Game 1) and
**mario_stadium-20260925T123759Z** (Game 2). The in-game charge-state memory
cleanly separates every corrected slap from every corrected charge in these
captures. The raw Wii Remote motion does not: the strongest stable exploratory
motion feature reached only 70.0% and 75.9% when trained on one whole game and
tested on the other.

That distinction matters. `swing_charge_frames` is direct game-state evidence
and is also the signal that already produces `detected_swing_mode`; it is not an
independent feature with which to validate that same detector. A memory-state
rule is supported by these games. A controller-motion-only fallback is not.

No learned classifier or scoring model was activated. Production tracking uses
the deterministic, validated in-game charge-counter rule and preserves its raw
source fields.

## Session selection and order

| | Selected stem | Preview start | Capture/header time | Capture end | Evidence |
|---|---|---:|---:|---:|---|
| Game 1 | `mario_stadium-20260925T122709Z` | 2026-09-25 12:25:57Z | 12:27:09Z | 12:36:56Z | manifest points to this stem; header and manifest agree on 26,144 frames, 586.422 s, and SHA-256 `ec19a334…b739c87` |
| Game 2 | `mario_stadium-20260925T123759Z` | 2026-09-25 12:37:58Z | 12:37:59Z | 12:45:24Z | next consecutive preview; header and manifest agree on 25,683 frames, 444.447 s, and SHA-256 `b5eaebf8…4ac52b` |

Both headers say `calibration_excluded: true` with the exact reason
`scripted slap-charge calibration`, and both include the two 1,336-byte Wii
Remote regions for slap/charge calibration. Their tracker logs cover all three
innings and end with a final score.

The older `mario_stadium-20260923T012536Z` session is not one of these games.
Its lineup was generated on September 23, labels the session
`gesture_discovery_only`, and its header uses the longer discovery-session
exclusion reason. It was used to discover the memory field, not included in
this two-game evaluation.

## Corrected samples

Only ordinary swings are gold examples. The three takes in Game 2 are retained
in the pitch artifact but excluded; neither game contains a bunt or star swing.

| Group | Slap | Charge | Gold total |
|---|---:|---:|---:|
| Game 1 | 14 | 15 | 29 |
| Game 2 | 11 | 19 | 30 |
| Port 1, both games | 13 | 18 | 31 |
| Port 2, both games | 12 | 16 | 28 |
| All | 25 | 34 | 59 |

By game and inning, the slap/charge counts are G1: 6/5, 5/5, 3/5; and
G2: 3/4, 3/5, 5/10. Contact-result counts are:

| Result | Slap | Charge |
|---|---:|---:|
| Fair caught | 15 | 12 |
| Fair in play | 8 | 11 |
| Foul | 1 | 3 |
| Home run | 0 | 6 |
| Swinging miss | 1 | 2 |

The machine-readable audit also reports every sample by game/port, side,
inning, batter, and contact result. Across both games, 16 of 18 batters have at
least one example of each class; King Boo and Yellow Yoshi have only charges,
and Red Koopa Troopa has one of each. Logical controller port is recoverable
from the calibration assignment (top/Flowers = port 1, bottom/Spitballs = port
2). Physical remote identity or a device serial was not captured, so the
planned physical-device swap cannot be independently proven from these files.

## Corrected deviations and focused pitches

The schedule, corrected actual label, and detector output remain separate in
the artifact. These are all planned-versus-actual disagreements:

| Game / PA / pitch | Batter | Planned | Corrected actual | Detector | Charge frames | Release to swing | Evidence |
|---|---|---|---|---|---:|---:|---|
| G1 PA10 P1 | Blue Toad | slap | charge | charge | 14 | 1 | counter rose; meter reached 0.2333; release was 1 frame before swing onset |
| G1 PA11 P1 | Red Koopa Troopa | slap | charge | charge | 41 | 1 | counter rose; meter 0.6833; release 1 frame before swing |
| G1 PA12 P1 | Yellow Yoshi | slap | charge | charge | 79 | 1 | counter rose; meter clamped at 1.0; release 1 frame before swing; foul |
| G1 PA12 P2 | Yellow Yoshi | slap | charge | charge | 39 | 1 | a new counter rise; meter 0.65; release 1 frame before swing; ball in play |
| G1 PA13 P1 | Pink Yoshi | charge | slap | slap | 0 | — | operator correction; no charge rise and meter remained 0 |
| G2 PA23 P1 | Gray Shy Guy | slap | charge | charge | 21 | 1 | operator correction; counter rose and released 1 frame before the miss |

G2 PA23 P2 is the same PA but is not a schedule disagreement: it was a planned
and actual slap, detected slap, with zero charge frames. The meter still held
the prior pitch's stale 0.35 value, while the counter did not rise. This is a
particularly useful check that the detector must use a counter **rise**, not a
nonzero meter level.

The Game 1 PA10–12 evidence is strong enough to resolve the operator's
uncertainty as charge rather than `unsure`: all four pitches have a fresh charge
counter rise, a nonzero duration, a meter consistent with that duration, and a
release exactly one frame before the swing animation begins. They are included
in the 59-pitch gold set with label source `capture_charge_state`. Because that
is also the detector's source signal, they are excluded from the independent
detector check described next.

## Detector and timing results

Against all corrected labels, the current detector's confusion matrix is:

| Actual \ detected | Slap | Charge |
|---|---:|---:|
| Slap | 25 | 0 |
| Charge | 0 | 34 |

There are zero false charges, zero false slaps, and no detector-versus-actual
disagreements. On the independent subset that omits the four Game 1 swings
whose labels came from the detector's own source signal, it is still 55/55:
25/25 slaps and 30/30 charges.

Charge duration is completely separated: all 25 slaps have 0 frames; the 34
charges span 12–137 frames (median 45, mean 50.29). By game:

| | Charge frames, min / median / mean / max | Release-to-swing frames |
|---|---|---|
| Game 1 | 12 / 46 / 44.47 / 79 | 1 / 1 / 1 / 1 |
| Game 2 | 21 / 42 / 54.89 / 137 | 1 / 1 / 1 / 1 |

`swing_charge_release_timing_frames` is now measured from the last charge rise
to swing-animation onset. It is exactly one frame on all 34 charges, including
G2 PA23 P1; the former 33-frame value measured to the later count change on a
miss and has been corrected throughout the archived pitch derivations.

## Independent raw-controller motion

The audit decodes the captured KPAD acceleration, acceleration magnitude and
variation, pointing/angle differences, down vector, and the first raw sample-
array accelerometer values. It summarizes a fixed 120-to-15-frame pre-swing
window and a 30-frame release window. No derived swing mode or charge counter
is an input.

The most stable exploratory feature was total absolute path in KPAD
`angle_diff_y` during the pre-swing window. Its class means differ—0.108 for
slaps versus 0.278 for charges—but the ranges overlap severely: 0–0.997 for
slaps and 0–1.765 for charges (standardized mean difference 0.52).

| Train whole game | Test whole game | Test accuracy | Majority baseline | Port 1 | Port 2 |
|---|---|---:|---:|---:|---:|
| Game 1 | Game 2 | 21/30 = 70.0% | 63.3% | 68.8% | 71.4% |
| Game 2 | Game 1 | 22/29 = 75.9% | 51.7% | 66.7% | 85.7% |

The raw-feature misses are fully retained in the audit. For completeness, they
are G2 PA1P1, PA2P1, PA4P1, PA8P1, PA9P1, PA15P1, PA24P2, PA26P1, PA26P3
when trained on Game 1; and G1 PA6P2, PA11P1, PA12P1, PA12P2, PA13P1, PA14P1,
PA16P1 when trained on Game 2. In particular, the raw feature does not
independently recover three of the four uncertain G1 PA10–12 swings.

This raw-motion estimate is exploratory, not a final untouched holdout: with
only two game groups, feature selection and validation cannot both have
independent games. It is nevertheless enough to reject a motion-only detector
for now.

## Decision and remaining confounds

The captured **memory state is sufficient to implement the simple detector
already represented by the tracker derivation**: for an ordinary swing, a live
`swing_charge_frames` rise means charge; no rise means slap. It generalized
without error across both games, both logical ports, 18 batters, contact and
miss outcomes, and corrected off-plan behavior.

The captured **raw controller motion is not sufficient for a reliable
detector**. Remaining limitations are two games, one operator, no recorded
physical-device identity, incomplete crossing of character/inning/result with
mode, all six home runs occurring on charges, and post-hoc raw-feature
selection. Additional motion-only work needs more operators, device IDs, and
whole-game held-out sessions.

Production tracking now uses the memory-counter rule in the live pitch stream
and persists its source and charge duration on each pitch. Postgame ingestion
also restates those capture-derived fields onto the canonical pitch rows, so a
late live join cannot lose the label and mixed-mode plate appearances remain
pitch-level records. Scoring results are never rewritten by that backfill.

Artifacts:

- `scripts/audit_swing_gesture_calibration.py`
- `data/calibration/swing-gesture-pitches-v1.jsonl`
- `data/calibration/swing-gesture-audit-v1.json`
