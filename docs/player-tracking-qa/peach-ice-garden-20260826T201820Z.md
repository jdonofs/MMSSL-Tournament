# Peach Ice Garden tracking QA — 2026-08-26

## Capture health

- 175,538 frames, zero missed frames, 61 minutes of wall clock at 80% emulator
  speed. Eleven full innings, both halves of each.
- Fielder pointers stayed inside the captured region for the full game.
- Position calibration selected `+0x004` with 19,844 possession locks; the
  nearest alternative had 1,248. That is a far wider margin than Daisy Cruiser
  (13,928 against 299) and the coordinates can be trusted on a park whose ice
  slides the fielders around.
- Post-replay result: 111 real batted-ball plays, 14 immediate game replay
  copies removed. Every retained play now carries a fair/foul class; nothing
  is left `unknown`.

## What the session contains

| Signal | Count |
|---|---:|
| fair, in play | 43 |
| fair, caught | 48 |
| home run (over the fence) | 1 |
| inside-the-park home run (batter ran all four) | 2 |
| foul | 19 |
| Yoshi-egg forced first contact | 4 |
| Buddy handoff / dash | 7 |
| Buddy Throws | 5 (CF+RF x4, CF+LF x1) |
| actor-confirmed ordinary contacts | 14 (13 fair, 1 foul; 4 then caught by someone else) |
| catches taken off the ground | 2 (ball 12u–16u up) |
| throws taken by a covering fielder | 2 |
| plays where a fielder took possession | 91 / 111 |

Session medians: fielder reaction 0.667 s (n=682), route efficiency 0.920,
sprint speed 6.671 u/s (best 10.976), home-to-first 3.537 s (n=53), throw
velocity 72.669 mph (n=68).

## Video-note reconciliation

All 51 play notes were located in the 111-play stream. The memory feed got the
core result right on every one: foul/fair/caught, responsible area, eventual
fielder, throw destinations, posted outs, and runner advancement. The table
groups the notes by what they test; note numbers are their order in the attached
source.

| Notes | What memory established | QA decision |
|---|---|---|
| 1, 4, 40 -- foul attempts | Mario's foul names Shy Guy in `last_contact_fielder` during action `3`; Birdo's retains Shy Guy action `1`; Yoshi's foul egg retains Pink Yoshi action `5` | Mario's is a confirmed physical boot and Yoshi's is a forced egg contact, but foul contacts remain excluded from ordinary OAA/error opportunities |
| 2, 13, 21, 45 -- rescue catches | Brown Kritter -> Light Blue Yoshi, Yellow Magikoopa -> Green Magikoopa twice, and Brown Kritter -> Mario | All four are marked rebound/rescue catches and excluded from the ordinary catch curve; note 45's unknown hitter was **Shy Guy** |
| 3 -- Bowser Jr. inside-the-park homer | Birdo action `7`, Light Blue Yoshi + Birdo Buddy Throw to home, no out, Bowser Jr. `bases_ran=4` | The result is automatic; paint, repeated misses, and the close-play animation are not |
| 5, 8, 9 -- early boots | Pink Yoshi, Green Toad, and Green Shy Guy action `3`; the last play continues CF -> 2B with one out | Note 9 is correctly a fielder's choice, not an error |
| 6, 7 -- icicle catches | Bowser Jr. catches Green Dry Bones; Green Magikoopa catches Brown Kritter | Catch/out ordering is right, but the icicle break/freeze/drop cause is not in memory |
| 10, 11 -- close plays at third | CF+RF Buddy Throws arrive at third with zero outs recorded; Yellow Shy Guy and Paratroopa both reach third | Safe outcomes are automatic; the A/B contest and knock-the-ball-out presentation are not |
| 12 -- egg breaks without contact | Yoshi's ball lands, then Yellow Shy Guy collects it; no forced-contact action fires | Correctly not a Yoshi-egg fielding failure |
| 14, 43 -- Brown Kritter's long dives | Brown Kritter action `3` is present; `last_contact_fielder` changes from `-1` to 2B at frames 40294 and 142382 even though the tracked centre stays 5.11u and 4.63u from the ball | Confirmed physical boots without widening the radius. Difficulty and official-error judgment remain separate |
| 15, 33, 38 -- successful infield plays | Brown Kritter records two 2B -> 1B outs; Pink Yoshi's hard grounder is secured and converted at first | Outcomes agree. A hypothetical tag/double play is not credited because it did not occur |
| 16, 28, 42, 48 -- wand/tongue plays | Correct eventual fielders and outcomes: Green Magikoopa catch, Yoshi catch, Light Blue Yoshi pickup, Yellow Magikoopa pickup and throw to second | The character ability itself is not identified. Note 28 was **bottom 6**, not top 6 |
| 17, 19, 27, 29, 37, 46, 50 -- range/wall plays | The catch/miss and primary fielder agree on all seven; Brown Kritter reaches second on note 46 | Geometry is measured, but "saved a double," "poor angle," and "would have been a homer" are not labels. Birdo's note-50 catch is 2.1u high with no HR flag, so the possible robbery remains unconfirmed |
| 18 -- Yellow Yoshi to Paratroopa | Paratroopa action `3`, no out, Yellow Yoshi reaches third | Confirmed failed contact, but memory does not know it was a Star swing. The situation was **bottom 4, one out**, not zero outs |
| 20, 30, 40 -- forced Yoshi-egg contacts | Action `5` is separated on T5, T7, and both T9 egg contacts; T5 occurs after the detected landing | Correctly excluded from ordinary error/OAA training. The note still helps interpret the post-landing mechanic |
| 22 -- Mario fireball | Bowser Jr. actions `4` and `7`, no confirmed ordinary contact, no Buddy Throw, Mario reaches third | Correctly no error candidate; fireball immunity is not auto-labelled |
| 23, 25, 31, 34, 49, 51 -- hazards/user action | All final hit/catch/HR outcomes agree, including the final Birdo catch | Icicle collisions, freeze timing, the deliberate Mario jump, and Buddy-dive intent are not detectable and remain exception annotations |
| 24, 41, 47 -- failed contacts that stay hits | Yoshi, Yellow Shy Guy, and Pink Yoshi are the primary failed fielders; Brown Kritter scores on note 47 | Outcome and advancement agree; official error judgment remains review-only |
| 26, 35, 44 -- Bowser Jr. paint | Note 26 is caught by Yoshi at 12.23u; note 35 is a double; note 44 is caught by Light Blue Yoshi at 15.61u, followed by an out at second | High catches and the double/out are automatic; paint, freeze, and Buddy-jump causation are not |
| 32 -- second inside-the-park homer | The batter is **Shy Guy**, runs 122.3u and reaches home; the attempted handoff does not become a Buddy Throw | The note's Brown Kritter identity was wrong; memory is definitive here |
| 36, 39 -- unusual automatic throws | Note 36 is a CF+RF Buddy Throw aimed at first while Green Dry Bones reaches third; note 39 is a CF+RF Buddy Throw to second with no out | Both odd target/safe outcomes are captured without annotation |
| 40 -- Yoshi's second-pitch throw | Pink Yoshi throws to Yellow Magikoopa/SS and no out posts | Endpoints are automatic; negative chemistry and throw quality are not yet classified |
| 47 -- extra-inning run | Pink Yoshi action `3`; Brown Kritter advances from second through home (`bases_ran=4`) | The run-producing advance is retained by the recycle-boundary fix |
| 49 -- unknown T11 batter | Bowser Jr. catches **Light Blue Yoshi** in center | Memory resolves the hitter; the icicle break remains manual |
| 51 -- game-ending catch | Birdo catches Pink Yoshi with two outs; the ball then remains locked in her glove | Complete third-out catch, not truncated |

### Corrections supplied by memory

- Note 18 was bottom 4 with one out, not zero outs.
- Note 28 was bottom 6 with one out, not top 6.
- Note 32's inside-the-park-homer batter was Shy Guy, not Brown Kritter.
- Note 45's unknown hitter was Shy Guy.
- Note 49's unknown hitter was Light Blue Yoshi.

These are lineup/state facts, so memory should take precedence over the notes.

## Defects this game exposed, and what changed

Three derivation bugs surfaced here. All three are fixed in
`scripts/derive_player_metrics.py` and covered by new cases in
`scripts/verify_player_metrics.py`.

### 1. Unknown and cut-short replays were scored as real plays

The game re-runs a batted ball from home plate while `game_state` stays live and
`ball_was_hit` rises again, which defeats both launch gates. Two Ice Garden
copies survived the old post-pass for different reasons. Bottom 5's Yellow
Magikoopa replay had no fair/foul call, so its `unknown` class was not compared
with the labelled original. Top 9's Light Blue Yoshi replay was also `unknown`
and was cut short, so its full 2.5 s signature differed from the original.

The ninth-inning copy here was identical to the original for 1.42 s and was then
cut, parking the ball at its reset position `(0, 0, -18.6)` for the rest of the
window. The two signatures therefore differed and the copy survived as a second
`unknown` batted ball for a batter whose plate appearance had already ended.

Suppression now admits `unknown` candidates and compares the *leading* samples:
five samples, 1.0 s of flight agreeing to the millimetre, within 20 s, same
batter, count, outs and lineup slot. Across the whole archive the prefix rule
caught four more shortened copies that the full-signature rule missed -- Bowser
Castle 1/top and 9/bottom, Daisy Cruiser 7/bottom, and Ice Garden 9/top. Every
one shares its `contact_at` to three decimals with a kept fair ball, which no
two distinct swings do.

Play counts: Bowser Castle 103 → 101, Daisy Cruiser 94 → 93, Ice Garden
112 → 111. Mario Stadium (83) and Wario Stadium (57) were unaffected.

### 2. The game-ending catch was quarantined as truncated

Birdo caught the third out in the bottom of the 11th to end the game. The game
never returned to a dead-ball state afterwards: the ball stayed locked in her
glove and `ball_was_hit` stayed latched to the end of the capture, so the play
ran to the 30 s cap and was marked `truncated`.

It is not truncated — it is complete and terminal. A catch with two outs already
recorded ends the inning, and the game. Such a play is now accepted even when
the end-of-game state never clears the hit flag. Its metrics were never in doubt:
`live_s` is 9.26 s, so the 30 s window only padded the frame list and Birdo's
route (35.3 u covered, 0.813 efficiency, 0.667 s reaction) is measured against
the live window.

### 3. Baserunner advancement was never recorded — every session, every play

This is the significant one. The two inside-the-park-homer notes make the bad
old values obvious once the notes and memory stream are compared.

`bases_ran` was read from the last frame of the play. The offense actors are
recycled for the next batter a few frames either side of the dead ball, and the
teardown reverts every count. The last frame is therefore almost always past the
reset. Before the fix, the batter read `0` on 111 of 112 Ice Garden plays, and
runners read exactly the base they started from — R1 always 1, R2 always 2, R3
always 3, on all 21 caught flies including four sacrifice flies. No advance by
any runner in any captured session had ever been recorded.

Traced against the raw stream:

- Sacrifice fly, 3/top: R3 goes 3 → **4** on frame 32035 and back to 3 on frame
  32155 — two frames after the ball goes dead on 32153, and inside the play
  window. The run was scored and then discarded.
- Shy Guy's inside-the-park homer, 7/bottom: the batter climbs 0 → 4 across
  frames 99300–99867 and is zeroed on 99988. The play's last frame is ~100039.

The count is now read at the recycle boundary — the last value before it first
drops, ignoring frames where the slot holds no runner. Ice Garden now records 14
runners reaching home, batters spread across 0–4, and both inside-the-park
homers (Bowser Jr. 1/bottom, 107.4 u of running; Shy Guy 7/bottom, 122.3 u).
Of the five caught flies with a runner on third, four runners attempted/reached
home: two are valid sacrifice flies and two occurred on the inning-ending third
out and do not score. The fifth (5/top, one out) held.

Nothing downstream reads `bases_ran` yet — `ingest_player_tracking.mjs` and the
app never touch it — so no consumer had to change with it.

## A note correction

The 7/bottom inside-the-park home run was hit by **Shy Guy**, not Brown Kritter.
Brown Kritter (character 61) was the defending second baseman on that play. The
captured batting order and character id both agree, and this is the class of
detail the memory feed should be trusted over a hand-written note.

## Open items

**`bases_ran == 4` means the runner reached home, not that a run scored.** Two
of the fourteen are runners who reached home on a caught fly that was already
the third out — 5/bottom and 8/top, both with two outs — where no run counts.
The field is a measurement of the actor, and the out/inning state has to be
applied on top of it before it becomes a run. Anything crediting runs directly
from this field will over-count.

**Over-the-fence home-run teardown is now handled explicitly.** The game clears
runner slots before the ball goes dead instead of counting them to 4. On the
7/bottom homer, R2 runs 2 → 3 → 0 at frame 108297 while the ball dies around
108381. The over-the-fence HR class guarantees that the batter and every
occupied runner scored, so their derived `bases_ran` value is now set to 4. The
override does not apply to foul homers or a future `home_run_robbed` class.

**Official-error judgment remains review-only.** The contact-actor field confirms
14 ordinary physical contacts: 13 fair and one foul. The fair contacts are kept
as failed fielding opportunities for OAA but are not automatically accepted as
official errors, and the four Yoshi-egg contacts are held out of ordinary
error/OAA training.

## Are full-game annotations still needed?

**No. Stop writing a play-by-play log like this.** The feed recovered the core
outcome for all 51 notes and corrected five situation/identity details. Routine
hits, catches, fielders, throws, targets, outs, and runner destinations no longer
need manual annotation.

A short exception-only log is still valuable for facts not present in memory:

- stadium causes: icicle break/collision/freeze, paint, fireball, and egg state;
- user-caused outcomes: unnecessary jump/dive, bad route by choice, or
  no-nunchuck automatic runner/throw decisions;
- official-scoring judgment on a difficult attempt versus a routine error;
- claims such as "would have been a homer" or "saved extra bases" until the
  expected-out/park model is validated.

One line is enough, for example:

> B5, 2 outs -- Yellow Magikoopa: Mario intentionally jumped after avoiding an
> icicle; catchable fly dropped.

That should reduce a 51-line game to roughly the handful of true exceptions,
while preserving the human evidence still needed for 100% accurate mechanism
and official-error labels.
