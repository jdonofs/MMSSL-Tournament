# Fielding contact memory mining — 2026-08-27

## Result

A deterministic physical-contact actor was found in the already recorded state
block. No wider reach radius is needed.

- `0x900D9524`, big-endian signed 16-bit: persistent/last ball-contact fielder.
  It idles at `-1` and names the involved fielder by the nine-entry fielder
  pointer-table order: P=0, C=1, 1B=2, 2B=3, 3B=4, SS=5, LF=6, CF=7, RF=8.
- `0x900D9522`, big-endian signed 16-bit: a shorter-lived companion contact
  fielder. It has the same encoding, but is absent on some later possession and
  incomplete-Buddy windows, so `0x900D9524` is the primary signal.
- Fielder object `+0x2C4`, unsigned byte: an action-3 contact/animation counter.
  It begins at 1 on the same frame that the global actor fields change and then
  advances once per frame. It corroborates every labelled action-3 boot and
  remains zero for the clear miss, but it is not universal across other action
  codes and is not the primary detector.

The fields were already present in every MSSTRK02 frame. Naming them in the
collector and reader does not require a new recording.

## Labelled populations

The labels are encoded in `scripts/mine_fielding_contact.py` and come from the
Peach Ice Garden and Daisy Cruiser video-note reconciliation reports.

| Population | Events | `0x900D9524` names actor |
|---|---:|---:|
| visually confirmed ordinary boot | 14 | 14 / 14 |
| difficult Brown Kritter diving contact | 2 | 2 / 2 |
| clear unrelated action-3 miss | 1 | 0 / 1 |
| clean possession | 286 | 286 / 286 |
| Buddy handoff/dash, completed throw | 26 | 26 / 26 |
| Buddy handoff/dash, no completed throw | 24 | 24 / 24 |
| forced Yoshi-egg contact | 8 | 8 / 8 |
| known fireball/special action | 1 | 1 / 1 |

The Buddy totals cover the complete five-session archive. Ice Garden remains
seven handoffs and five completed Buddy Throws; the two incomplete handoffs are
not manufactured into throws.

For ordinary physical contact versus the labelled miss, the contact-actor rule
has 16 true positives, zero false positives, zero false negatives, and one true
negative: 100% precision and 100% recall on the labelled set. The negative set
is only one human-confirmed unrelated action, so this is exact archive evidence,
not a claim of broad statistical validation.

## Key Ice Garden evidence

| Batted-ball frame | Fielder/action | Action starts | `0x900D9524` starts | Minimum centre distance | Result |
|---:|---|---:|---:|---:|---|
| 40241 | 2B Brown Kritter, action 3 | 40291 | 40294 | 5.11u | physical contact confirmed |
| 142324 | 2B Brown Kritter, action 3 | 142379 | 142382 | 4.63u | physical contact confirmed |
| 160922 | 3B Shy Guy, action 3 | 160957 | never | 4.41u | miss; SS fields the ball |

At the first contact-actor frame, Brown Kritter's tracked centre is even farther
from the ball (6.27u and 5.92u). This is expected: the coordinate is the body
centre rather than the extended glove/body. A radius cannot separate those two
contacts from the 4.41u Shy Guy miss, while the actor scalar separates them
exactly.

The 11 other labelled Ice Garden ordinary contacts first name their actor at
frames 8782, 14970, 23268, 24388, 34654, 56438, 68481, 76222, 136196, 153107,
and 157976. Daisy Cruiser's three video-labelled contacts do so at 10954, 18444,
and 107460.

The actor-local `+0x2C4` counter starts on those same frames. Across the 16
ordinary/difficult contacts it reaches values from 175 through 225 (the shorter
Ice Garden foul window reaches 59); it remains zero for frame 160922. Read as a
signed byte it wraps above 127, as a 16/32-bit field it merely combines the
counter with static adjacent bytes, and as a float it is implausible. The
unsigned-byte interpretation is the useful one.

The absolute `+0x2C4` addresses in these recordings are:

| Position | Object base | Counter address |
|---|---:|---:|
| P | `0x900D9B1C` | `0x900D9DE0` |
| C | `0x900D9E08` | `0x900DA0CC` |
| 1B | `0x900DA0F4` | `0x900DA3B8` |
| 2B | `0x900DA3E0` | `0x900DA6A4` |
| 3B | `0x900DA6CC` | `0x900DA990` |
| SS | `0x900DA9B8` | `0x900DAC7C` |
| LF | `0x900DACA4` | `0x900DAF68` |
| CF | `0x900DAF90` | `0x900DB254` |
| RF | `0x900DB27C` | `0x900DB540` |

## Search performed

The miner reconstructed 470,411 frames across all five archives. The two
labelled sessions have zero missed frames; Bowser Castle has the archive's only
missed frame, outside this labelled population.

For every labelled action window and clean-possession control it searched:

- every byte in each involved `0x2EC` fielder object;
- every byte in the captured `0x900D5000..0x900DBD40` state block;
- pre-event baselines, changes, pulses, counters, fixed values, and fields that
  name the involved actor;
- unsigned and signed byte views, overlapping big-endian signed/unsigned 16-bit
  views, overlapping 32-bit views, and plausible big-endian float views.

The changing-byte sweep is type-complete for the recorded region: any changing
16-bit, 32-bit, or float candidate necessarily contributes changing component
bytes. Candidate runs were then decoded in the wider interpretations. The
global contact pair is unambiguous as signed 16-bit: both idle at `0xFFFF`, then
become `0x0000..0x0008`. The overlapping 32-bit view combines the two actor
indices (for example, actor 3 becomes `0x00030003`), and the float view is a tiny
denormal, so neither is a plausible scalar interpretation.

Two floats at fielder `+0x0BC` and `+0x0C0` changed on all labelled ordinary
contacts and no clear miss, often resetting to `(10000, 0)`. They also changed
on all egg contacts but almost no clean possessions or Buddy actions. Their
values behave like an AI movement/target point, so they are retained only as
supporting evidence and are not used for classification.

No equally deterministic actor-local field was found for every action-2 window.
The global contact actor confirms two action-2 contacts. Three other action-2
windows—Bowser Castle 70156 and Mario Stadium 35903/44045—lack the global actor
transition. They are stored as `ball_contact: "unknown"`, not guessed from
distance.

## Derived event contract

Every derived play now has `fielding_events`. Each event stores independent
facts:

- `fielding_attempt`: an action or secured fielding event occurred;
- `ball_contact`: `confirmed`, `missed`, or `unknown`;
- `secured`: whether possession followed for this event;
- `mechanic`: `ordinary`, `buddy`, `egg`, or `special_unknown`;
- `official_error`: nullable and never inferred from a boot;
- the actor, frame, action code, confidence, source field, and audit values.

Legacy `deflections`, `forced_misplays`, and `buddy_handoffs` remain for existing
consumers, but now contain only contact-actor-confirmed events. Action-3 without
the actor transition is a miss. Action-2 without it is unknown because the
archive does not yet contain a labelled action-2 miss/control pair.

## Re-derived archive

Play counts remain Wario 57, Bowser 101, Mario 83, Daisy 93, and Peach 111, with
zero retained unknown batted-ball classes or truncated plays.

Contact-confirmed ordinary deflection totals are Wario 0, Bowser 4, Mario 3,
Daisy 5, and Peach 14. Peach's total is the previous 11 plus both long Brown
Kritter contacts and the visually noted top-first foul boot. The foul contact is
physical evidence but remains excluded from fair OAA/error opportunities.

Across action events, the archive now stores 83 confirmed contacts, nine misses,
and three action-2 unknowns. Buddy and egg actions never enter ordinary
deflections. Official errors remain unassigned.

## Remaining uncertainty and calibration

The contact actor does not name the cause of every special interaction. Action
5 identifies eggs, action 7 identifies Buddy handoffs, and the one action-4
fireball interaction is conservatively `special_unknown`; paint, flower rings,
and icicle freeze/break causation still require exception notes when that cause
matters.

No new controlled session is necessary for safe operation: the three unresolved
action-2 cases are explicitly quarantined as unknown. Eliminating those unknowns
would require only a short action-2 calibration with one visually verified
physical contact and one visually verified no-contact attempt, not another
annotated full game.
