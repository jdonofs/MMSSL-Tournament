# The live tracker validation console

**Status:** Implemented
**Scope:** Deciding, during a live game, whether the tracker understood each play — and flagging it in two clicks when it did not.

---

## 1. What this is

### Advanced-metric review (2026-09-04)

Start `npm.cmd run tracker:preview`, select a completed at-bat, and expand
**Advanced metrics** below the warnings. The selected play now exposes primary
fielder distance, opportunity time, reaction, route efficiency, movement speed,
Jump components, assisted movement, each throw's peak speed, runner sprint speed,
run distance, leads, home-to-first time and the 90-foot split. Structural DP
eligibility is shown from the scored PA context.

Use **Flag** on a measurement, enter what you observed after `observed:`, and
save. The wrong-measurement category and source/value are prefilled. Annotations
include the compact `advanced_metrics` snapshot and definition version alongside
the existing full play evidence. All writes remain local to the capture.

Missing values stay missing; zero is a real measurement. Ambiguous/unjoined
plays cannot populate this panel. Buddy Throws and incomplete throws are marked
excluded from ordinary arm strength. Short runs, teleport runs and truncated
plays are marked excluded from speed ratings. Values remain visible for review.
The panel shows individual measurements, not an aggregate player rating.

Two findings constrain the next modeling pass:

- The current Jump derivation samples from pitch release and may use the last
  available frame for short windows. Its components are explicitly prototype
  measurements; validate the timing boundaries before interpreting them as a
  calibrated Jump rating.
- Catch probability/OAA and arm/baserunning/DP run values currently require the
  post-ingestion opportunity models. The preview has no frozen independent
  baseline, so these display **Baseline required**. Fitting on the game being
  reviewed would not provide an independent accuracy test. The next step is a
  versioned baseline trained on separate captures, then held-out probability
  scoring against validated catches, advances/holds and DP outcomes.

`GET /state.advanced_metrics` contains scalar rows only for the selected play;
per-frame trails and split histories still stay behind `/play`.

Two independent systems watch a Mario Super Sluggers game. Neither one knows about the other:

| | Tracker log | 60 Hz player tracking |
|---|---|---|
| Source | the tracker `.exe`'s console output | a memory reader against Dolphin |
| Produces | plate appearances, pitches, batted-ball measurements | fielder routes, contacts, throws, runner splits |
| Identifier | plate-appearance number | the game frame contact happened on |

The console joins them, states in plain English what the two together say happened, and makes every word of that statement traceable to the field it came from.

`npm run tracker:preview` is permanently local-only. It does not create a
Supabase client, select a database game, or ingest results. Startup verifies
that the API reports `writes_enabled: false` and refuses to attach to an
existing writing bridge. Its durable outputs are local capture files, derived
play files, tracker logs, and annotations.

**The centrepiece is the interpretation**, not the statistics:

> Pink Yoshi hit a fly ball toward left field.
> Birdo (LF) secured the ball before it landed.
> The tracker charges this ball to the left fielder, because they caught it.
> The plate appearance is scored as a flyout, 1 out on the play.
> Birdo has Suction Catch, but its activation was not confirmed on this play.

A sentence can be judged at a glance against a play you just watched. A grid of two hundred statistics cannot.

---

## 2. Live data flow

```
Dolphin
  ├── tracker .exe ──stdout──► live_tracker_bridge.mjs / tracker_at_bat_preview.mjs
  │                              └── applyTrackerPreviewMessage()  ──► plate appearances
  │
  └── collect_player_tracking.py (sidecar, 60 Hz)
        ├── .bin + .json          the recording. AUTHORITATIVE. Untouched by any of this.
        ├── .live.jsonl           completed plays, written at each dead ball
        └── stdout markers        [live-play] {...}   [live-status] {...}
                                     └──► bridge ──► applyTrackerPreviewPlay()
                                                     setTrackerPreviewCaptureHealth()

                    ┌─────────────────────────────────────────┐
                    │  tracker_preview_state.mjs (in memory)  │
                    │   plate appearances + plays + capture   │
                    └───────────────────┬─────────────────────┘
                                        │ trackerPreviewSnapshot()
                                        │   ├── join every play        tracker_play_join.mjs
                                        │   ├── interpret the at-bat   tracker_narrative.mjs
                                        │   └── check for contradictions  tracker_validation.mjs
                                        ▼
                    tracker_preview_server.mjs  (localhost:4317)
                      GET  /state          the whole console, compact
                      GET  /play           one play's full evidence, on demand
                      GET  /annotations    what has been flagged
                      POST /annotations    flag something
                      POST /stadium        re-project against another park
                      POST /landing-calibration
                      POST /shutdown       save and end the local session
                      GET  /pitch-diagnostics
                                        ▼
                    src/components/TrackerLivePreview.jsx   (polls /state at 2 Hz)
```

After a preview capture stops, it runs the authoritative pass over the `.bin`
(`calibrate_player_tracking.py` then `derive_player_metrics.py`) and stops. It
never calls `ingest_player_tracking.mjs`; database ingestion is a separate,
deliberate production operation outside the preview workflow.

### The pipeline gap this closed

The 60 Hz measurements used to exist only *after* the tracker exited. The frame-to-play
derivation was already an incremental forward state machine — it just happened to be spelled
as a loop inside `derive_player_metrics.main()`, so the only thing that could run it was a
finished recording.

That loop is now `derive_player_metrics.PlayDeriver`, and **both** callers use it:

- **Postgame** — `main()` feeds it frames decoded from the `.bin`.
- **Live** — `player_live_derivation.LiveDerivation` feeds it frames the collector already
  has in hand.

Snapshots come from one `player_tracking_io.SnapshotBuilder` in both cases, so there is no
live-specific derivation that could drift. Verified: see §8.

---

## 3. Preview state contract (`GET /state`)

Additive — every field the previous console read is still present and unchanged.

| Field | What it carries |
|---|---|
| `situation` | inning, half, outs, count, batter, pitcher — the live game state |
| `capture` | collector status/pid, frames, missed frames, frame rate, latest-frame age, calibration status and lock margin, position offset, plays emitted/withheld, derivation cost, `join_tally` |
| `player_tracking_plays[]` | one **compact summary** per 60 Hz play: situation, class, primary fielder, badges, join status and reason |
| `interpretation` | the narrative for the displayed at-bat (see §4) |
| `warnings[]` | contradictions found in the displayed at-bat (see §7) |
| `checks` | `{pitching, batting, fielding, running}`, each `ok` / `warn` / `missing` / `pending` / `n/a` |
| `play_geometry` | fielders at pitch release, flight, routes, throws, contact events — enough to draw the play, nothing more |
| `display_play` | the compact summary of the play this at-bat's narrative was built from |
| `at_bats[]` | now also `checks`, `warning_count`, `error_count`, `join_status`, `narrative_summary` |

### Performance rule

**A poll never carries per-frame data.** One play record holds every fielder's route, every
runner's five-foot splits and the whole throw chain; five of them outweigh everything else on
the page. So the snapshot carries summaries, and the full record is fetched from
`GET /play?contact_timer=N` only when an operator opens the evidence for one.

This is enforced by a test (`tests/tracker-console-ui.test.mjs`): the serialized snapshot must
not contain `five_foot_splits_s` anywhere, and must stay under 200 KB.

---

## 4. Narrative schema and grammar

`buildTrackerNarrative({ atBat, play, join })` → deterministic, no language model.

```js
{
  status,      // complete | partial | pending | unavailable
  summary,     // one line, for the history strip
  sentences,   // string[]
  clauses: [{ id, category, text, status, source, evidence }],
  timeline: [{ id, category, t, frame, text }],   // ordered by game frame
  join,
  play_contact_timer,
}
```

**One fact per sentence.** A fielding attempt, physical contact with the ball, and possession
of it are three different observations from three different sources, and a play can have any
combination of them. Collapsing them into "made the play" is what makes a tracker bug
invisible.

### Clause statuses

| Status | Meaning | Rendered |
|---|---|---|
| `observed` | the game or the tracker log declared it | white, green rule |
| `derived` | computed from measurements | light, blue rule |
| `inferred` | follows from the rules of baseball, not a measurement | light, violet rule |
| `unknown` | a signal fired whose meaning is unresolved — *the sentence says so* | amber |
| `pending` | not available yet | grey |
| `not_applicable` | context, explicitly not a claim | grey |
| `mismatch` | two sources contradict | red |

### Chronology

1. Batter contact, trajectory, location
2. Fielder attempt and mechanic
3. Physical ball contact
4. Whether possession was secured
5. Recovery, by the same or another fielder
6. Throw, relay, Buddy interaction, target and receiver
7. Outs, runner destinations, runs, and the official PA result

### Fact separation, in the exact words used

| Situation | Sentence |
|---|---|
| Attempt, no contact | "Waluigi (SS) attempted to field the ball but did not make contact." |
| Contact, no possession | "Brown Kritter (2B) contacted the ball but failed to secure it." |
| Possession | "Birdo (CF) secured the ball before it landed." |
| Contact unknown | "The tracker detected an attempt by Shy Guy (3B) but could not determine whether contact occurred." |
| Physical boot, no ruling | "No official error determination is available for that failure to secure." |
| Recovery by another | "The center fielder recovered the ball after the second baseman could not hold it." |
| Unresolved special action | "Daisy (LF) used an unresolved special fielding action; the tracker could not determine whether contact occurred." |
| Yoshi Egg | "A Yoshi Egg forced Peach (1B) to misplay the first contact." |
| Buddy handoff | "King K. Rool (CF) made a Buddy handoff to the right fielder." — only when a Buddy Throw on the same play names that fielder as the partner. Otherwise: "…redirected the ball to another fielder without securing it." |
| Buddy Throw | "Blue Pianta (SS) and the center fielder completed a Buddy Throw to Dark Bones (1B) at first." |
| Coverage, not a bad throw | "That throw was aimed at the shortstop; the second baseman covered and took it." |
| Unclassified trajectory | "…hit a ball the tracker did not classify toward right field." |

An **official error is never inferred from a physical bobble.** The capture observes
possession; the scorer's ruling is a different claim, and only the tracker log carries it.

### Direction

Taken from the play's measured endpoint in the ball frame (`atan2(x, −z)`, positive toward
first base) when one exists, and from the tracker's spray angle otherwise. The clause's
evidence records which — `direction_source: measured_endpoint_coordinates | tracker_spray_angle`.
Ground balls and bunts get infield vocabulary (`shortstop`, `second base`), everything else
outfield vocabulary (`left-center`, `the right-field line`).

"Deep" is said only when a **measured** distance is ≥ 300 ft, and the distance travels in the
clause's evidence.

---

## 5. Ability activation rules

`scripts/tracker_abilities.mjs`. **A character mapping is never evidence of activation.**

Birdo has Suction Catch in every game she appears in, including the ones where she catches an
ordinary fly ball standing still. "Birdo used Suction Catch" would be true of ~100% of Birdo's
catches and correct about far fewer, and the reader has no way to tell which they are looking at.

| Status | When | What the narrative says |
|---|---|---|
| `confirmed` | observed activation **and** it agrees with the mapping | "Mario used Fire Swing." |
| `unresolved` | a special action fired that is not mapped to a name | "…used an unresolved special fielding action" + the raw action code in evidence |
| `unconfirmed` | the character has the ability; nothing says it fired | "Birdo has Suction Catch, but its activation was not confirmed on this play." |
| `mismatch` | an observed activation the character cannot have | reported as a contradiction |
| `not_applicable` | the character has no ability of this kind | nothing |

### What actually reaches `confirmed` today

**Star swings and star pitches.** The tracker log announces those by name
("X used a star swing!"), so the activation is observed and `CHARACTER_STAR_SWING` /
`CHARACTER_STAR_PITCH` only supplies which of the thirteen it is.

**A fielding ability is named only when its mechanic is observed.** A character mapping alone
is never activation evidence. Approach, throw, and confirmed-possession telemetry provide the
ability-specific signals described below; action code 4 remains explicitly unresolved.

**A dive, however, IS observed.** The fielder actor's `catch_type` byte (+0x2AC) holds the
approach the fielding AI committed to before the ball arrived -- 1 ordinary, 2 catching a
throw, 3 dive, 6 leap, 7 an unresolved dash -- and it is cleared on the frame the glove
closes. Derivation reports it as `dive` / `leap` / `approach` on every fielding event, as
`dove` and `dive_frames` on every fielder, and as `play.dives`, which includes the dives that
never reached the ball and so produce no fielding event at all. The console says
"X dove for the ball" as its own sentence, separate from whether the ball was then secured.

`airborne_near_contact` is still only attempt context: the airborne flag at +0x22E accompanies
a LEAP and never a dive, which is why every dive in the archive read as an ordinary play until
+0x2AC was named.

A dive is not an ability activation **by itself**. Type-3 windows were recorded for characters
mapped to Super Dive, Clamber, Laser Beam, Hammer Throw and None alike, so a dive by a
character mapped to something else names nothing, and the console says so in as many words:
"Hammer Bro. dove, which every character can do, so this is not evidence of Hammer Throw."

**But the approach IS the activation when the two are the same act.** The game gives the
player one dive/jump/special-action input. Type 3 therefore names the character's mapped reach:
Super Dive, Tongue Catch, Suction Catch, Magical Catch, Piranha Catch, Keeper Catch, or one of
the three Bro throws. Type 6 names Super Jump. The console can say "Green Magikoopa (RF) used
Magical Catch to reach the ball," while an ordinary standing catch by the same character says
nothing about Magical Catch. The observed input is the evidence; the mapping supplies its name.

**`catch_type` 5 is Clamber.** Every occurrence in the whole archive plus the live sessions
belongs to a character mapped to Clamber — Tiny Kong twice, Donkey Kong twice — and to no one
else, while those same Kongs also produce ordinary 1/3/6/7 windows, so the code is the
mechanic and not a Kong fingerprint. One of the live pair is an operator-confirmed wall climb.
A type-5 window on a character who cannot Clamber is reported as a mismatch rather than
quietly renamed.

Names and mappings are read directly from `src/data/characterAbilities.js` — Super Dive,
Tongue Catch, Magical Catch, Ball Dash, Laser Beam, Quick Throw, Super Jump, Suction Catch,
Piranha Catch, Clamber, Keeper Catch, Hammer Throw, Fireball Throw, Boomerang Throw, and the
baserunning / star tables beside them. Quick Throw is confirmed by an actual throw and Laser
Beam by a mapped throw to home.

**Ball Dash is passive, and passives are a third case.** It has no move, no animation and no
input — a Noki or a Goomba carrying the ball simply runs faster. There is nothing for the
capture to witness, so "has it" and "used it" are the same statement, and both halves of the
usual treatment were wrong: the console said "used Ball Dash" (an activation that does not
exist) and could equally have reported it as an ability the tracker never saw (a miss that can
never be made). It resolves to `passive`: named on any measured carry by a mapped character,
never counted as unobserved, never claimed as a move. `PASSIVE_FIELDING_ABILITIES` in
`tracker_abilities.mjs` is the list, and it is the place to add the next one.

---

## 6. Join strategy

`scripts/tracker_play_join.mjs`. This is the only inference in the pipeline, and a play
attached to the wrong at-bat does not look like an error — it looks like a fielder who made a
catch on a strikeout. So it refuses rather than guesses.

- **Coarse key:** inning, half, batter name (the two game/roster spelling differences are
  aliased).
- **Discriminator:** the count. The same batter can face the same pitcher twice in an inning
  but cannot see the same count twice inside one plate appearance.
- **Many-to-one by design:** foul balls are batted balls and produce their own plays. Only the
  *fair* ball is an at-bat's outcome.

| Status | Meaning |
|---|---|
| `joined` | exactly one at-bat, no contradiction |
| `pending` | no match, and the tracker log has not reached this point yet |
| `orphaned` | no match, and the log is already past it |
| `ambiguous` | more than one at-bat is plausible — **nothing is attached** |
| `mismatch` | one at-bat matches but a fact disagrees (a count it never saw; a fair ball on a strikeout) |

Two fair balls joined to one plate appearance is impossible, so both are demoted to
`ambiguous` rather than one being preferred.

**An ambiguous or mismatched play is never narrated.** The fielding half of the interpretation
is withheld and the reason is stated in its place — silence would read as "no fielder was
involved", which is a different and much worse claim. The play still surfaces on the at-bat it
*names*, so an ambiguous join is visible rather than invisible.

---

## 7. Automatic validation rules

`scripts/tracker_validation.mjs`. Every check states two fields that directly disagree; none
of them is a quality score or a heuristic about whether a play looked unusual.

| id prefix | Catches |
|---|---|
| `count-gap` / `count-step` / `count-range` | a count transition the rules forbid |
| `telemetry-pitch` / `telemetry-count` / `telemetry-pitcher` | flight telemetry on the wrong pitch, count or pitcher |
| `contact-without-in-play` | a batted ball on a walk, HBP or strikeout |
| `contact-without-in-play-pitch` | a batted ball with no pitch recorded as put in play |
| `batted-ball-unresolved-endpoint` | no endpoint **and** no explicit unresolved status |
| `projection-flag-disagrees` | measured presented as projected, or the reverse |
| `possession-without-contact` | secured with `ball_contact` not confirmed |
| `catch-after-landing` | caught in flight with a confirmed prior landing |
| `attempt-without-classification` | an attempt with no `ball_contact` value at all |
| `error-inferred` | a fielding event claiming an official error the PA does not charge |
| `putout-outside-chain` | a putout by someone who never held or received the ball |
| `runner-no-destination` | a runner who neither reached, scored, nor was retired |
| `runner-two-destinations` / `base-shared` | a runner in two places, or two runners on one base |
| `outs-disagree` / `runs-disagree` / `out-result-no-outs` | runner outcomes against the recorded outs and runs |
| `runners-unresolved` | runners on base and no resolved assignments |
| `join-ambiguous` / `join-orphaned` / `join-mismatch` / `join-pending` | the join |
| `derivation-disagrees-*` | live and postgame disagreeing on a shared fact |
| `ability-claimed` / `ability-mismatch` | an ability named as used without confirmed activation |

Warnings are ordered most severe first. **A warning is never a reason to change data** — it is
a reason to look, and to press "Something is wrong" if the operator agrees.

---

## 8. Replay workflow

Nothing below needs an emulator, a controller, or another played game.

### Prove live and postgame agree

```bash
python scripts/replay_player_tracking.py --all         # npm run tracker:verify-live
```

Feeds each recorded `.bin` through `LiveDerivation` exactly as the collector will — same
seeded position offset, same collector scalar table, same emit-at-dead-ball — and diffs every
field of every play against the authoritative `.plays.jsonl`.

Result on the five archived sessions:

```
bowser_castle    live 101  postgame 101   agree on every field of every play
daisy_cruiser    live  93  postgame  93   agree on every field of every play
mario_stadium    live  83  postgame  83   agree on every field of every play
peach_ice_garden live 111  postgame 111   agree on every field of every play
wario_stadium    live  57  postgame  57   agree on every field of every play

derivation cost  0.028-0.039 ms/frame mean   66-134 ms worst play
```

This harness deliberately does **not** report emission latency. It feeds frames
as fast as it can decode them — roughly nine times real speed — so a frame count
from it would say nothing about a real capture. The worst per-play build time
bounds it, and the paced benchmark below measures it properly.

### Prove the capture survives deriving live

```bash
python scripts/benchmark_live_derivation.py data/player_tracking/<session> --frames 9000
```

Replays at true 60 Hz against a wall clock, doing the same XOR-delta and compression the
collector does, and counts frames that overran the 16.68 ms budget with derivation on and off.

```
wario_stadium (9,000 frames, 15 plays)
  recording only    mean 1.990 ms   worst  4.11 ms   overruns 0
  recording + live  mean 2.073 ms   worst 14.89 ms   overruns 0
peach_ice_garden (12,000 frames, 7 plays)
  recording only    mean 1.999 ms   worst  7.14 ms   overruns 0
  recording + live  mean 2.065 ms   worst 16.32 ms   overruns 0
```

Live derivation costs **+0 over-budget frames** and adds **+0.07–0.08 ms** to the mean frame.

### Drive the console from an archived session

```bash
npm run tracker:preview -- --replay data/player_tracking/peach_ice_garden-20260826T201820Z
```

Starts and opens the same console with **real** recorded 60 Hz plays. The at-bat side is
**reconstructed** from each play's own recorded situation, because the archived sessions were
captured with the collector running alone and no matching tracker log exists. The page says so
in its own banner (`ARCHIVE REPLAY`), and the mode is `archive_replay` in the snapshot.

What is exercised end to end: joins, narrative, warnings, badges, the play diagram, the
history strip, annotations. What is not: the tracker's own parsing of things the 60 Hz capture
never saw — pitch telemetry, walks, strikeouts, RBI lines.

---

## 9. Annotation format

`<session-stem>.annotations.jsonl` — one JSON object per line, beside the capture. Written by
`POST /annotations`, and **by nothing else**: this path has no access to statistics or Supabase,
which is the only way to guarantee that flagging a play mid-game cannot corrupt the game's record.

Categories (a category is required; text is optional):
`wrong_result`, `wrong_player`, `wrong_location`, `wrong_trajectory`, `wrong_attempt`,
`wrong_contact`, `wrong_possession`, `wrong_ability`, `wrong_throw`, `wrong_runner`,
`missing_event`, `wrong_measurement`, `other`.

Each record carries enough to investigate it a week later with none of the original context:

```
schema_version, recorded_at, effect: "local_annotation_only"
session { mode, writes_enabled, started_at, tracker_pid, stadium_key, capture_stem, collector_pid }
game
pa_number, inning, half, batter_name, pitcher_name, result, outs_before_pa,
count_at_contact, contact_seq, endpoint_seq, play_contact_timer, pitch_release_timer
categories, category_labels, note
clause { id, category, text, status, source, evidence }      ← when one clause was flagged
narrative { status, summary, sentences, clauses, timeline, join }
warnings[], checks, join
plate_appearance, player_tracking_play, play_geometry, capture
```

---

## 10. One operator command

`tracker:preview` is the single testing workflow. It starts the visual app,
local API, patched tracker, and 60 Hz memory collector. Stadium is detected
automatically from the game's complete 0..8 stadium menu byte. On exit it saves
the raw capture, derives the authoritative play file, and merges the session's
hitting/flight samples into the local flight archive. **Supabase is always
disabled.** Pitch evidence remains in the session log and downloadable session
diagnostics; fielding and baserunning remain in the raw and derived player files.

```bash
# Live test game: this is the normal command.
npm run tracker:preview

# Archived capture, same page and same command family.
npm run tracker:preview -- --replay data/player_tracking/<stem>
```

The command opens `/tracker-preview.html` automatically. This standalone entry
does not mount the authenticated tournament app or any Supabase provider. Use
the page's **Save & end
session** button (or Ctrl-C) when the test is over; it waits for capture flush
and derivation. Research scripts and the production Supabase bridge remain
implementation tools, not alternate preview launch workflows.

---

## 11. What is measured, what is derived, and what remains unknown

### Available live, per play, within ~1.5 s of the dead ball

First touch and who made it · caught in flight or landed · catch height · landing point ·
hang time · every fielding attempt with contact classified as confirmed / missed / unknown,
and its three-dimensional closest reach · mechanic (ordinary / egg / fireball / Buddy /
unresolved special) · primary fielder and why · route, path, displacement, route efficiency ·
sprint speed · glide-assisted distance · airborne frames · required closing distance and the
hang time paired with it · the throw chain with thrower, intended target, actual receiver,
target base, velocity, possession-to-release hold, and how far the nearest runner was from
that base when the ball got there · Buddy Throws with the chemistry pair and freeze duration ·
Buddy handoffs · Buddy Jumps · runner tracks, bases ran, lead at contact, home-to-first,
90-foot split, five-foot splits, stealing state.

### Postgame only

Catch Probability, OAA and Directional OAA · Expected DP and DP Added · Arm Value, Rbaser, FRV
· anything needing league baselines or a fitted model. These need capture volume that does not
exist yet, not a sequencing decision.

### Explicitly unknown, and reported as unknown

1. **An ability without its required event.** Every named fielding ability that HAS an
   activation has an activation rule, and a roster mapping is never substituted for the event.
   A routine standing catch by Magikoopa does not receive Magical Catch credit, and a Laser
   Beam character who never throws home receives no ability sentence. Passives (Ball Dash) are
   excluded from this by definition — see §5.
2. **What action code 7 actually is.** The ball leaves at a fixed 23.28 u/s on a new heading
   whatever it came in at, so it is a deliberate redirection rather than a deflection — but it
   fires between players with no chemistry as well as between real Buddy partners. The word
   "Buddy" is used only when the game's own buddy thrower/partner state on a throw corroborates
   it; otherwise the console reports the redirection and names no relationship.
3. **A fielding action code the derivation has no name for.** Reported as "an unresolved
   special fielding action" with the raw code exposed, so a later annotation session can
   resolve it without re-recording anything. That is how **code 4** was carried until this
   game: every action-4 window in the archive belongs to a ball MARIO hit, and the operator
   named the mechanic — the Fire Swing fireball, which the first fielder to reach it cannot
   hold. It is now handled as what it is, a BATTER's ability acting on a fielder, exactly like
   Yoshi's egg (5): forced misplay, no fielding ability attributed, no error charged.
4. **Three action-2 contacts in the archive.** `last_contact_fielder` does not name an actor
   and action 2 has no labelled miss, so contact stays `unknown` rather than being promoted by
   widening a distance radius.
5. **Official scoring errors.** Only present when the tracker log says so, AND only when the
   60 Hz capture agrees the fielder had an ordinary-effort chance. A physical failure to secure
   the ball is never promoted to one. Confirmed forced contacts (Yoshi's egg or Mario's
   fireball) and balls reached on a dive or leap remain real bobbles but are vetoed as errors,
   with the reason stated in the narrative. An announced "bobble" where the capture proves no
   contact or no reachable chance is different: it is a false shared-animation signal and is
   discarded before narrative and validation. So is one naming a fielder the capture places
   nowhere on the play — no event and no approach — while a DIFFERENT fielder made confirmed
   contact with the ball. That last pair of conditions is what makes it evidence rather than
   silence: the capture is not failing to see the named fielder boot it, it saw who handled
   the ball and it was somebody else. Peach Ice Garden PA 38 is the case, where an announced
   Koopa Troopa bobble on a ball down the LEFT-field line overrode the executable's own
   "recorded a double" and charged E9 to the right fielder. The raw name and reason remain in
   `bobble_signal_discarded` / `bobble_signal_discarded_reason` for audit.
6. **Whether a fielder was ever near the ball.** The action byte is an animation state, not a
   claim about the ball: it fires for one frame as a home run sails overhead, and the tracker
   .exe turns that single frame into "X bobbled the ball!". Across 233 contacts the game's own
   `last_contact_fielder` confirms, the largest fielder-to-ball separation in three dimensions
   is 6.29u; the two windows in the archive beyond 12u are 26.0u and 34.9u — balls 26 and 35
   units above a fielder's head. Those are classified `missed` with `within_reach: false` and
   the measured `closest_reach_units`, and the console reports the measured miss instead of
   turning the executable's animation line into a bobble warning.
7. **Reaction time** is emitted only for fielders who moved more than a step; a fielder the
   game glided has no honest reaction or sprint number and is marked as glide-assisted. A
   fielder the game FROZE has neither either, and unlike a glide a freeze cannot be subtracted
   — it does not inflate the path, it changes what the fielder was doing, so `reaction_s` and
   `route_efficiency` are withheld and `frozen_frames` says why. See item 10.
8. **Why a fielder held the ball.** Possession-to-release is measured on every throw (median
   0.70 s, p95 1.43 s over 558 of them), and past two seconds the console says so. The delay
   alone never says why. DK Jungle's flower effect is now independently named from the fielder
   state (`+0x242` by day, `+0x2CA` by night); without one of those effect flags the console
   continues to report only the measured hold.
9. **Who won a close play.** The console measures the MARGIN: how far the nearest runner was
   from the base on the frame the ball got there, and how much of that gap they closed in the
   half second before, which is what separates a runner sliding in from one who has been
   standing on the bag since the last pitch. Whether they were safe is the game's call and is
   already in the throw's `outs_recorded`; it is never inferred from the margin.
10. **A fielder the game froze.** The fielder actor carries a flag at `+0x240` that is up for
    exactly the 120 frames (2.000 s) a frozen fielder cannot move, with the countdown beside it
    at `+0x20D` and a 60-frame recovery at `+0x20F`. It is a Peach Ice Garden Freezie and not a
    generic stun: six sessions at other parks — 511,473 frames carrying labelled manhole
    knockdowns, ghost attacks, flower gas, Chain Chomp hits and table stuns — produce zero runs
    of it, and the two Peach sessions produce 54. It is emitted as `play.freezes[]` and as
    `frozen_frames` / `frozen_seconds` / `frozen_at_s` on the fielder, and it withholds that
    fielder's reaction and route for the play. This is a measured player STATE, not a stadium
    event: the console says a fielder was held and never says what held him, because the object
    that did is not in the captured region. It is therefore not what the gate below is about,
    and it does not open it.
11. **A fielder driven back while holding the ball.** A ball hit hard enough shoves the fielder
    who caught it, and that motion has a shape a run does not: fastest on the very first frame,
    never faster again, and dead straight because nothing is steering it. `possession_carries[]`
    now carries `motion`, `"knockback"` or `"carry"`, from `classify_carry_motion`. In
    `dk_jungle-20260902T171957Z` it splits the 27 ball-holding moves over a unit into 15 and 12,
    with every knockback at displacement/path = 1.000 against 0.28-0.99 for the carries. It
    matters because Ball Dash is read off a carry: a Blue Noki being shoved was being credited
    with a passive carry-speed bonus, which the operator flagged twice in that one session
    (PA 40 and PA 61, "they got pushed back by the power of the hit"). Ball Dash is now refused
    on a knockback. **The cause is not claimed.** The force of the hit does this and so does a
    DK Jungle barrel, and nothing in the capture separates them — so this is the consequence
    side only, exactly like item 10, and it does not open the gate either.

12. **What raises the fielding max-speed constant.** `+0x0F0 * 15` reproduces the
    datamine workbook's field-speed curve at the character's `run_speed`: across 58
    sessions, 70 of the 72 characters holding a constant land on the published row,
    interpolated ratings included, with a median absolute error of 0.0002 u/s against
    a stored resolution of 0.001 — so they are indistinguishable at the resolution
    the capture keeps, which is a stronger statement than any precision figure.
    In exactly ONE session, `wario_stadium-20260826T005958Z`, 16 of the 18 fielders
    instead hold the curve value at `floor(run_speed * 1.5)`: Bowser Jr. (70) at the
    stat-105 row, Wiggler (75) at stat-112. The modifier acts on the STAT and re-reads
    the curve; multiplying the speed by 1.5 predicts 12.1 u/s where the game holds
    8.63. **The arithmetic is established. The trigger is not, and is not even a
    ranked hypothesis.** That session is also the only Wario Stadium capture and the
    oldest MSSTRK02 one, so park, game setting and collector artifact are perfectly
    confounded and nothing in the data favours one. A second Wario Stadium capture
    with the current collector separates the PARK from the other two; it does not
    identify a setting. Meanwhile `summarizeMovementMetrics` classifies each
    observation against this character's own ordinary and boosted curve rows and
    leaves anything matching neither UNCLASSIFIED — it does not take the modal value
    as ordinary, which reported the boosted constant as a character's top speed
    whenever boosted rows outnumbered ordinary ones.

    **That classification now reaches the page.** Classifying correctly and then
    dropping the result on the way to the UI produced the same wrong answer in a
    different place: `buildRawValueRows` read the ordinary sample count alone, so a
    character with fourteen boosted observations and no ordinary one rendered as
    "no samples", n = 0 — indistinguishable from a character nobody has tracked.
    The row now carries ordinary, boosted, unmatched and total counts, and the
    Scouting Report draws four distinct states: `boosted only · n`,
    `matches neither row · n`, `no ordinary observation · n`, and `no rating · n`
    for a character with nothing to classify against. Where ordinary observations
    DO support a value, the excluded ones are shown beside it as `· n excluded`
    with the breakdown in the title, and `n` stays the ordinary count, because it
    is the denominator of the number displayed. An unchecked constant no longer
    reaches a percentile or a difference against the curve at all.

    **The difference column on that row is not independent confirmation of the
    curve**, and the note under it now says so: classification admits a value only
    within 0.01 ft/s of the curve row — 0.007 mph, which is the unit the table
    displays — so the difference cannot come out much larger than that. What IS
    independent is how much of the cast has any value inside that window at all,
    which is the audit's count and its denominator.

    Covered by `tests/character-mechanics-traits.test.mjs` through the row builder
    and `npm run test:scouting-browser` through a real browser against fixed rows.

13. **The baserunning half of the same workbook.** Published as
    `BASERUN_SPEED_CURVE` and flagged `validated: false`. The offense actor class
    carries no speed constant at all (ACTOR_FIELDS, `collect_player_tracking.py`),
    so there is nothing to check the rows against directly. The measured runner is
    not a substitute, and the reason is the ratio rather than the correlation:
    runner sprint tracks the rating closely — r = 0.87 against `run_speed` over 71
    characters, the top-two-thirds-mean estimator — while sitting a consistent
    **1.14x above the curve's own values**, p10 1.12 to p90 1.17. Correlating with
    the curve's INPUT axis says nothing about its OUTPUT; the fielding constant
    above lands ON the published value, and that is the difference.

    A superseded figure is recorded here because it was quoted in a handoff: an
    earlier pass reported r = 0.36 and 1.26x. Those came from a p99 estimator over
    unfiltered windows, which is effectively each character's noisiest single run.
    `node scripts/audit_character_mechanics.mjs` runs both controls, and both now
    hold the CHARACTER COHORT, the `>=6` sample threshold and the input rows fixed
    so exactly one thing changes at a time. Over the same 71 characters: swapping
    the ESTIMATOR takes r from 0.8723 to 0.3445, and swapping the FILTERS takes it
    from 0.8723 to 0.8758. The estimator was the whole effect.
    **r = 0.87 is the retained result.**

    An earlier version of those controls also moved the threshold from 6 to 15, so
    they ran over 53-54 characters against the retained result's 71 and attributed a
    cohort change to whichever knob the label named. The full-cohort variants - every
    character clearing the threshold under each filter set - are reported separately
    and labelled as such, because "the same characters measured differently" and
    "every character these filters admit" are different questions.

14. **Which workbook column is the jump catch radius.** The revised import names
    column J `jump`, but J repeats the facing-away radius in 94 of 101 profiles and
    sits BELOW the standing radius in 96 of them (median 0.47x), and a jumping catch
    does not reach less far than a standing one. Column K behaves the way a jump
    reach should — above `regular` in 76 of 101, median 1.13x — which is why the
    catch-coverage rating still uses it, but "behaves plausibly" is not an
    identification. Both are carried under names that say so and neither is
    presented to a reader as the jump reach. **More tracked games do not resolve
    this.** It needs a controlled leap suite: the same character leaping at balls
    at measured separations until the radius shows itself.

15. **Catch reach in absolute units.** `tracking_catch_approaches.separation_3d_units`
    is measured from the fielder actor ORIGIN and the workbook radius is
    glove-relative, so the two are not the same number — across the archive the
    observed separation on a secured standing catch runs about 1.4x the published
    radius for every character. **No delta between them is published**, not a
    subtraction and not a difference of ranks. A one-off archive pass put the
    per-character medians at r = 0.73 over 30 characters for standing reach, which
    is not reproducible from the database the page reads and is not enough to
    stand in for an equivalence; dive reach ranked NEGATIVELY over 13 characters,
    r = -0.53, because how far a dive travels is mostly how far the ball was. The
    missing piece is the glove offset from the body origin, which the landmark work
    has not measured — **again not a sample-size problem**.

    **The r = 0.73 is not a justification for ranking them either**, and an earlier
    comment in `src/utils/advancedDefense.js` said it was. It is one pass over the
    local archive, it is not reproducible from the database the page reads, and it
    covers standing reach only. The page publishes no delta of any kind on these
    rows — `compare: false` in `src/utils/measuredAttributes.js` — and the code
    comments now say the same thing the page does. Related:
    `docs/character-mechanics-audit-2026-09-21.md`.

16. **Height reach and facing-away reach.** Both are shown as published values with
    no measured counterpart. Height reach needs the ball's height above the glove,
    which the capture does not separate from the actor origin; facing-away needs the
    direction the fielder is facing, and the capture holds angular velocity
    (`+0x0DC`) and a steering target (`+0x038`), neither of which is an orientation.
    Neither is impossible — both need a memory mapping that does not exist yet.

### Catch-reach sample state (2026-09-21)

Produced by `node scripts/audit_character_mechanics.mjs`; regenerate rather than
trusting the numbers below, which move whenever a game is tracked.

At the time of writing, the seven tracked league games hold 369 approach windows on
active sessions. Of those, 99 pass `catchApproachIsOrdinaryMechanics` — 41 standing,
54 dive, 4 leap — and **58 of the 99 were secured**: 38 standing, 16 dive, 4 leap.
The secured count is the one that matters, because the displayed reach is a quantile
over the catches that were held. The display threshold is 6 SECURED catches, and no
character reaches it at any approach yet; the best covered is Yoshi at 5 standing.

The loss between 128 standing windows and 41 qualifying ones is not waste: 78 of them
are the game still gliding the body on the frame the catch resolved, which is exactly
the observation that disqualifies a reach measurement.

Per-character state is reported per approach and never summarised as one verdict — a
character can be above the threshold at one approach, below it at another, and have
attempted a third without completing any. The report distinguishes all of those.

**Capture estimate, labelled as one.** The rate has two numerators and only one of
them moves the threshold. Per tracked game the seven games hold **5.86 qualifying
standing ATTEMPTS and 5.43 qualifying standing SECURED catches**, and **7.71
qualifying dive attempts against 2.29 secured**. The displayed reach is a quantile
over SECURED catches, so it is the second column that accumulates: a dive that came
up empty bounds the reach from above and contributes nothing to the threshold. At
5.43 secured standing catches a game, spread across whoever is playing, the
best-covered character needs a small number of further games and cast-wide coverage
needs considerably more; dive coverage at 2.29 a game is more than twice as slow.
That extrapolates from seven games and assumes the same characters keep playing and
the glide rate holds; both can move it. (An earlier version of this paragraph quoted
"9.0 qualifying dive windows per game". 54 qualifying dives over 7 games is 7.71, and
the figure that matters is the 16 secured ones, which is 2.29.)

### The prepared `characters.run_speed` correction (2026-09-21)

`supabase/migrations/20260921130000_character_run_speed_corrections.sql` sets Dry
Bones 40 to 50 and Green Paratroopa 64 to 52. **It is not applied, and applying it
is Jason's call, not a step in this work.** The ledger says so directly:
`node scripts/audit_character_mechanics.mjs --ledger` reports it NOT RECORDED while
every other migration from 20260920 on is recorded, and the two column values on
production still read 40 and 64.

**What the ledger cannot tell you.** `supabase_migrations.schema_migrations` has
three columns — `version`, `name`, `statements` — with no timestamp and no author.
Its current state says which versions are recorded as applied and nothing about
when a row was written, who wrote it, or whether the file on disk is the file that
ran. Two migrations in this repository were live on production while absent from
that table, so absence is evidence about the LEDGER first and about the schema only
weakly; read the column values alongside it, which the ledger section does.

**Measured impact, not asserted impact.** An earlier note on the migration said it
reaches only the verifier and the audit. That was incomplete:
`scripts/recompute_advanced_metrics.mjs` reads this column into `extraBaseFeatures`,
and `runner_speed` is one of the four inputs of the ACTIVE extra-base decision
model, so a recompute after the correction CAN move expected attempt probabilities,
runner and arm run values, and WAR.
`node scripts/analyze_run_speed_correction_impact.mjs` runs the existing model twice
over today's rows — the second time with the two ratings patched in memory only —
and measures what it does:

| | |
|---|---|
| `runner_opportunities` rows | 17 |
| ...scored by the fitted model | 13 |
| ...with either corrected character as the runner | **0** |
| ...of those, reaching the fitted model | **0** |
| rows whose modelled values change | **0** |
| runner-side run value moved, by player | none |
| arm-side run value moved, by player | none |
| downstream WAR | 0 exactly, for every player |

The zero is CLASSIFIED rather than assumed: the script reports *why* nothing moved,
and "neither corrected character appears as a runner" is only one of the four
answers it can give. The others are a corrected character being present but on rows
that never reach the fitted model (they fall back to the context average, which has
no `runner_speed` in it), the column already holding the corrected value so the
patched copy is identical, and modelled rows producing identical values anyway —
which would be a bug rather than a finding. Today's answer is the first one.

**The two sides are never added together.** `arm_run_value` is the negation of
`runner_run_value` on the same row, so a league-wide total of the two is zero on any
dataset whatsoever — including one where a runner gained half a run and the fielder
he ran on lost half a run. The report gives the runner side and the arm side
separately, each carrying the character and player id it belongs to, and prints the
cancelling totals only to show that they cancel.

**WAR is quantified only where it can be.** With no run-value change at all it is
exactly 0 for every player, because each player's run total is divided by a positive
`runsPerWin` and zero divided by anything positive is zero — no denominator needed.
As soon as there IS a change, the script reports the per-player run-value deltas and
leaves WAR **unquantified**, because `runsPerWin` comes from league RA9 over inputs
it does not read. It does not divide by a guessed denominator.

**Nothing stored changes until a recompute runs either way**; the app reads the
persisted columns.

Model SENSITIVITY is reported separately by the same command and must not be read as
impact: over today's 13 eligible rows with the runner swapped, 40 to 50 moves
P(send) by a mean +0.017 (range +0.000 to +0.045) and 64 to 52 by a mean -0.021
(range -0.052 to -0.001).

The verifier's correlations were recomputed both ways rather than predicted: fielder
sprint 0.9721 to 0.9761, runner sprint 0.8636 to 0.8756, and throw velocity 0.8712 to
0.8712 — **unchanged, as it must be**, because it correlates against `throwing_speed`
and this migration does not touch that column. No gate flips; the thresholds are
0.8 / 0.6 / 0.8.

One consumer is NOT covered by any of the above. `scripts/calibrate_runner_decisions.mjs`
reads the same column for its own fit over the local archive, where Dry Bones has 16
runner windows and Green Paratroopa 22, so re-running the calibration after the
correction would move the fitted artifact. The recompute does not run it and nothing
in this work does.

`node --test tests/character-run-speed-migration.test.mjs` applies the file itself to
a throwaway PostgreSQL (PGlite, in process) and covers the apply, a repeat apply, the
refusal on an unexpected prior value, the duplicate-name guard, and the rollback —
including that submitting the file as one multi-statement query makes it a single
implicit transaction, so a post-condition failure undoes the corrections too. Apply
it inside an explicit begin/commit anyway, as every other migration here is applied,
so that does not depend on how the runner splits the file.

### Stadium-event completeness gate (2026-09-02)

The nine parks and every researched gameplay-changing stadium event are catalogued below. This
is deliberately **not** an event schema yet. The product requirement is one individually named
record for every event type in every park, not a Wario-only or geometry-only approximation.

| Stadium | Gameplay events that would need individual records | Present capture evidence |
|---|---|---|
| [Mario Stadium](https://www.mariowiki.com/Mario_Stadium_(baseball_stadium)) | None; day/night is cosmetic | Complete by definition |
| [Wario City](https://www.mariowiki.com/Wario_City) | Directional-arrow redirect (stronger at night); manhole water launch/knockdown | **Manhole knockdown readable at `fielder+0x23F`**; the arrow has seven annotated ball redirects and no detector yet |
| [Peach Ice Garden](https://www.mariowiki.com/Peach_Ice_Garden) | Freezie collision, player freeze, Freezie break; night snowflake blackout/spotlight | Prior labelled captures prove freeze/break causation is absent |
| [Daisy Cruiser](https://www.mariowiki.com/Daisy_Cruiser_(baseball_stadium)) | Day table collision/break/player stun; night Cheep Cheep collision; night Gooper Blooper field tilt | Ball/player consequences are visible, but no object/cause identifier is captured |
| [Yoshi Park](https://www.mariowiki.com/Yoshi_Park) | Day pipe entry/exit; night Piranha Plant eat/spit/player hit; train collision | **Complete (2026-09-12).** `pipe_transits[]` names entry and exit pipe, `pipe_stuns[]` names a fielder stunned (`+0x243`) running or diving into one, and three Piranha knockdowns are named when `+0x23F` rises beside the held ball during the measured plant transport. Train/player and train/ball collisions are independently regression-tested, with the direct day-train position used where captured and the validated fence-band fallback retained for older/night captures. |
| [DK Jungle](https://www.mariowiki.com/DK_Jungle_(baseball_stadium)) | Root/pathing obstruction; barrel collision (flaming at night); flower gas; night DK-statue POW stun | **Complete for measurable player effects (2026-09-12).** Barrel hits use `fielder+0x23F`; flower hits use `fielder+0x242` by day and `fielder+0x2CA` by night; night POW hits use `fielder+0x243` value 1. No root slowdown effect was found, so occasional refusal to traverse the roots is treated as CPU pathing and is not emitted. |
| [Bowser Jr. Playroom](https://www.mariowiki.com/Bowser_Jr._Playroom) | Thwomp impact/break; Chain Chomp spawn/hit; Bullet Bill spawn/hit | Raised impacts and stuns are visible; the object and trigger are not |
| [Luigi's Mansion](https://www.mariowiki.com/Luigi%27s_Mansion_(stadium)) | Gravestone hit/ghost attack; tall-grass ball concealment | No gravestone/ghost/grass state is captured |
| [Bowser Castle](https://www.mariowiki.com/Bowser_Castle_(baseball_stadium)) | Podoboo burn/drop; Bowser-statue fire; Thwomp block; fireball puddle/burn; King Bob-omb bomb | Collision and player movement can be measured, but none of the five causes has an identity field |

**Update (2026-09-11, Yoshi Park train).** The second full-memory probe supplied the
cross-game evidence the first one lacked. `0x811F84DC` is stable across both day captures,
follows the train's complete outfield loop, and was within the train body's 12u reach at all
26 train-classified knockdown samples. New captures append those twelve bytes to every frame.
A knockdown or ball jolt is therefore `observed` only when the train position is beside it;
the position also vetoes the old fence-band inference when the train is elsewhere. Existing
captures cannot gain a per-frame value they never recorded, so they remain `inferred` and use
the stricter fallback.

The same pass added two negative controls from `yoshi_park-20260911T203017Z`: PA 34's ball
was already secured before the train crossed it, and PA 106 was a left-field wall/foul-pole
rebound 0.956u inside the surveyed fence. The legacy detector now requires a genuinely loose
ball, a turn or speed gain rather than ordinary deceleration, plausible speed, and at least
1.5u clearance from the wall. Re-derivation leaves only the two operator-reviewed train/ball
impacts and removes both controls.

**Update (2026-09-12, Yoshi Park Piranha knockdown).** The confirmed night capture
`yoshi_park-20260912T143842Z` supplied the third Piranha-player knockdown and made the shared
signature explicit. The two prior reviewed hits were at frames 1834 and 1974 of
`yoshi_park-20260831T031212Z`; the new annotated hit is frame 23967. In all three, the game's
`fielder+0x23F` knockdown flag rises within 21-25 frames of the eat/spit endpoint while the
fielder is only 0.85-1.81u horizontally from the ball held by the plant. No other archived
play has a knockdown during any pipe transit. The deriver therefore names the plant from that
measured compound event: Piranha transport, endpoint timing, held-ball proximity and the
knockdown flag. The full-memory object address is no longer required to recognize the effect;
the attribution remains `derived`, because the plant model itself is not captured.

**Correction (2026-09-04, the night-only parks).** The operator reports that Bowser Castle had no
gimmicks at all in `bowser_castle-20260904T011909Z` — King Bob-omb was not even on the field — and
the capture agrees: zero `fielder+0x23F` onsets in 115,795 frames, against 5 in
`bowser_castle-20260828T182145Z` and 9 in `bowser_castle-20260826T153516Z`.

The cause is the setup path, not the capture. Bowser Castle and Luigi's Mansion exist only at
night in MSS (Bowser Jr. Playroom is Bowser Castle's daytime cover-up, and is itself day-only);
`next_calibration_game.mjs` hardcoded `isNight = false`, `mss_autoteam.py` wrote that to
`0x811F769E/F`, and the session header records `day_night_bytes: [0, 0]` for stadium byte 1. The
field loads; the hazards do not. Fixed by `STADIUM_FIXED_TIME_OF_DAY` in `mss_roster.mjs`, which
both the calibration selector and the site exporter now clamp through.

It also puts two rows of the table above in doubt. Only sessions from 2026-09-02 on record the
day/night bytes at all, and every one of those four reads day; the two Luigi's Mansion sessions
predate that and record neither, so the variant they were played in is unknown, and both have zero
`+0x23F` onsets. Until a Luigi's Mansion session is recorded that is known to be at night, "no
gravestone/ghost/grass state is captured" cannot be separated from "the ghosts were never there",
and Bowser Castle's five causes rest on the two August sessions alone. Re-record both parks before
reading their rows as a capture limitation.

**Update (2026-09-02, Peach Ice Garden).** One row above now has a measured signal on the
CONSEQUENCE side and still not on the cause side, and the distinction is the whole gate. A
frozen fielder is readable exactly (item 10) — but the Freezie is not. Every 4-byte-aligned
float triple in the 27,968-byte state block was tested for proximity to the frozen fielder at
all 24 freeze onsets of one session, and no offset clears more than 10 of them; the near-misses
are the ball echoed at a fielder holding it. The block holds the game state and the thirteen
actors, and the stadium's own objects live outside it. So Freezie collision, Freezie break and
the near-miss control still have nothing, and the barrier has changed from "consequences cannot
be attributed to a cause" to "the object table is outside the capture window" — which is
addressable. Widening the collector to a second region and re-running that same adjacency search
against the known freeze onsets is the test that would settle Peach, and the same widening is
what every other park's object identity needs.

**Update (2026-09-02, DK Jungle).** `dk_jungle-20260902T171957Z` carries eight operator-labelled
flower sprays and three barrel hits, and the tracker recorded none of them. The same search that
settled Peach was run over the whole 27,968-byte block — every byte, by non-zero run structure
and then again by value histogram — against the six annotated hazard windows. Nothing fires on
the hazard plays and only on the hazard plays; the bytes that cover all six windows fire ~50
times a session, once per ball in play. The control matters more than the negative: run
unchanged against the Peach session's five annotated player freezes, the same search finds
`fielder+0x240` at 24 runs covering 5/5, and that byte is flat zero for all 75,539 DK frames. So
the method works and DK's hazards are genuinely absent, which puts DK in the same place as Peach
— **the object is outside the capture window** — rather than in a worse one.

Two further facts about this session, both about WHEN the hazards happened. All eleven landed
after the ball was already resolved: after the catch, after the throw, after the ball left the
park. So the one existing proxy, the >=2.0 s hold at `LONG_HOLD_SECONDS`, fired zero times, and
this session added no evidence at all about what a flower does to a live play. The Aug 28 flower
that dazed Mario mid-play (2.94 s hold, four times the median) is still the only hazard event in
the archive that has ever moved a measurement. A generic all-fielder impulse scan was tried as a
barrel detector and rejected: it fires on ordinary between-play repositioning and still misses
two of the three barrels. Item 11 above is the part that survived, and it only sees a fielder
who is holding the ball.

**Reviewing what has been collected (2026-09-08).** `scripts/review_stadium_events.mjs` gathers
every annotation across the archive, parses the structured `stadium_event=` labels, and aligns each
one with the frame and the actors the capture holds for it — plus the session's day/night bytes,
reported as `unknown` for every session recorded before 2026-09-02 rather than assumed to be day.

```
node scripts/review_stadium_events.mjs --park dk_jungle
node scripts/review_stadium_events.mjs --park dk_jungle --unstructured
```

The catalogue below is encoded in `PARK_EVENTS` there, so a park with no detector still lists every
event it would need a record for, and the report says which of two things each row is waiting on:
labelled events (and a matched control) where a detector exists, or the object itself where one does
not. **It never converts prose into a label.** A note mentioning a barrel is listed as an
unstructured CANDIDATE with the exact label to write, and is counted as nothing. Nothing in it opens
the gate or enables a detector.

**What the next DK capture needs.** Hazards triggered while the ball is LIVE and in a fielder's
hands — a flower spraying a fielder who still has to throw, a barrel hitting one who is holding
the ball. Those two are the only hazard events the current capture can register at all, through
item 11 and the long hold. Every other hazard needs the second region below. Label them with
`stadium_event=<objective id>; outcome=...; control=<yes|no>` under the `stadium_event`
annotation category, which `parseStadiumEventNote` now parses into structured fields; the eleven
DK labels to date exist only as English prose and had to be read by hand to be counted.

**The probe game (2026-09-02).** `scripts/probe_stadium_objects.py` is the test the two
updates above both point at, and it is a dedicated session rather than a passenger on a
calibration game. The method is the Peach adjacency search widened past the state block: a hazard
that hits a fielder is touching them, so at the onset its object holds a position a unit or two
from theirs. The probe scans a wide region for 4-byte-aligned float triples near each fielder and
stores only the surviving offsets, which is what makes 64 MB affordable -- a full MEM2 image per
event is 64 MB and twenty events would be 1.3 GB of padding.

```
python scripts/probe_stadium_objects.py --selftest          # no game needed
python scripts/probe_stadium_objects.py --watch --out data/calibration/dk_objects.jsonl
python scripts/probe_stadium_objects.py --analyze data/calibration/dk_objects.jsonl
```

Measured: a 64 MB scan takes 0.32 s and random memory yields essentially no candidates, because
the plausibility filter from `probe_ball_memory` rejects anything that is not three floats inside
a stadium. The fielders are re-read after every scan and a fielder who drifted more than 1.5
units during it has their hits dropped, since a candidate beside someone who has since run away
means nothing. It never writes to the game and never writes to Supabase.

Run it on DK Jungle first: it has the most labelled hazards, two hazard types that fire often,
and both are ordinary day events needing no night variant. Ten barrels and ten flowers with a
handful of control plays is enough to intersect. If an offset survives, it is the object table
and every park's row above becomes answerable; if nothing survives at any radius, the objects are
not in MEM2 and `--region` moves the search to MEM1. **Untested against a live game** -- the
search, the seam, the filter agreement and both analysis paths are covered by `--selftest`, but
nobody has yet pressed ENTER on a real barrel.

**Probe run 1 (2026-09-02, DK Jungle, 12 hazards + 4 controls).** No object was adjacent to the
victim at every event; the best offset cleared 8 of 12. Three things came out of it.

*A bug in the probe, which did not cause the miss but wrecked the file.* `plausible_position` is
the BALL's filter and it accepts the world origin, because the ball goes there. Memory is mostly
zeros, so every boundary between a run of padding and the data after it decodes as a denormal
triple sitting at or beside (0, 0) -- and the catcher stands at (0.8, 0.0, 1.1). Result: 3.1
million candidates an event, essentially all of them "near the catcher", and a 1.15 GB file.
`plausible_mask` is now stricter than the ball's filter in exactly one direction (a component may
be exactly 0.0, but not two of them, and a non-zero component below 1e-3 is padding), the real
values are recorded and not just the distances, and more than 20,000 candidates prints an alarm
at the time. The selftest carries the actual denormals that caused it. The outfielders were never
affected -- CF and RF are far from the origin -- so the analysis above is unchanged by the fix.

*What the surviving stride-12 hits were.* `0x900D6D40` is a ring buffer of past BALL positions:
array[k] equals the ball 39 + k frames earlier, median error 0.000 units over a whole pitch and
the batted ball after it. It is inside the captured block, it is exact, and it is not a hazard --
it scored 5/12 on hazards and 0/4 on controls only because a fielder involved in a play is near
the ball's recent path by definition.

*Why the barrels were probably not there.* A barrel that hits a fielder BREAKS. Pausing at or
just after the collision catches the object after the game has destroyed it, which is consistent
with a search that found the ball trail and nothing else. The next run should pause while a
barrel is still ROLLING toward a fielder, which needs no collision at all and is a far easier
moment to catch.

**The flower, specifically.** It was not found either, and the reason is different from the
barrel's. Four of the six flower events turned up only 2-4 candidate triples anywhere in the 64 MB
of MEM2 within 3 units of the sprayed fielder, and the closest in every event is the fielder's own
position echoed back at 0.00 units. The search was starved, not outvoted -- so the flower's
position is not a world-space float triple within 3 units of its victim in MEM2. Only one offset
appeared in three or more flower events, and trilaterating it against the victim positions gives
an 11-unit residual, so it is not a fixed point either.

But the flower events answered a better question than the one asked. A flower is stadium geometry:
it is there during the pitch, during the play and between innings. Three of the four CF sprays put
the fielder within 5 units of **(15.6, 85.0)**, and a static hazard means that cluster is where a
flower is. That converts the problem from "catch a transient object at the right instant" to
"scan a fixed point at any moment", which is why `--near X Z` now exists: it adds a fixed world
point named POINT to the target list, so a flower can be hunted with the game paused at leisure
and no hazard firing at all. The two live hypotheses for why 3 units found nothing are that the
gas has range -- the fielder need not be touching the flower, unlike the barrel, which has to
make contact -- and that MEM1 has never been scanned. `--radius` and `--region` test both.

**Probe run 2 (2026-09-03, DK Jungle, radius 12, with a matched control point).** Negative for
both hazards, and this time with the controls that make a negative mean something.

*Two more bugs found and fixed before the data was usable.* At radius 12 the catcher, who stands
on the world origin, drew 280,803 candidates in a single scan: colours, normalised vectors, unit
quaternions and ratios all live in [-1, 1], so a large slice of arbitrary memory decodes to a
triple within a few units of (0, 0), and no filter can fix that. A target inside
`ORIGIN_DEAD_ZONE` is now skipped and said out loud. Separately, the density of plausible-looking
triples falls off with distance from the origin, so a control point must sit at the SAME radial
distance as the real one -- measured live, a point 54 units out drew 892 candidates against 33
for one 86 units out, and moving the control to a matched 86 units brought it to 30.

*The flower.* Nine independent scans. At the spray point: 32 offsets present in every scan and
never moving. At bare grass the same distance out: 30. The control's nearest static candidate is
1.35 units away against the flower point's 3.21 -- the control is CLOSER. There is nothing
selective here; a persistent static triple near an arbitrary outfield point is simply common.

*The barrel.* The only offsets clearing 4 of 4 are `0x900D6CD4` through `0x900D6D40` at stride 12
-- the ball-position ring buffer identified in run 1, reached from its other end. A barrel rolls
past the centre fielder while the ball is near the centre fielder, so the trail scores every time.
It is also weaker evidence than 4/4 suggests: three of the four scans caught the fielder at an
identical position, so they are two samples, not four.

*Where that leaves it.* MEM2 has now been searched twice, with a working filter and a matched
control, for a moving hazard and a static one, and both times the only thing adjacent to the
victim was the ball. The assumption the whole method rests on -- that a hazard holds a
world-space float triple near whoever it hits -- has not survived either test. MEM1 has still
never been scanned and is the one cheap thing left; if it comes back the same, the adjacency
search is exhausted and the next attempt should be a differential one (what memory differs
between a barrel present and no barrel), which does not assume the object stores a position at
all.

**A method that can prove a negative (2026-09-03).** `scripts/probe_stadium_signals.py`. Runs 1
and 2 shared a fatal weakness: an empty result could not be told apart from a broken search, so
"we found nothing" was worth almost nothing. Both modes here carry a positive control, and a run
that fails its own control reports itself void rather than reporting a finding.

`--motion` replaces adjacency with the question a barrel actually answers. A barrel is fired from
a cannon and rolls across the field, so wherever it lives it holds a position that changes
SMOOTHLY. The search takes six full snapshots of the region a few hundred milliseconds apart and
keeps every 4-byte-aligned triple that was a plausible stadium position in all six, travelled at
least a unit, never jumped more than 25, and whose step sizes are consistent. That is enormously
more selective than proximity: measured on 6 x 64 MB of realistic memory it took 2.6 s and
returned exactly one mover, the planted one. THE CONTROL: the nine fielders are running during
the same snapshots and their position fields are at addresses this repo already knows. The search
is never told where they are, and an event that fails to rediscover them is marked void. Adjacency
could never do this -- there was no known object guaranteed to be near a fielder.

`--stun` goes after the flower's EFFECT rather than its cause, which is what matters for tracking
anyway. Every one of the 27,968 bytes of the state block is recorded at moments an operator calls
a fielder dazed and at moments they call the field clean, and every byte is tested for separating
the two groups. It is exhaustive, so there is no search heuristic to be wrong about. THE CONTROL
is a permutation test, and it is not optional: with eight samples over 400 random bytes, 11.4
bytes separate the groups perfectly BY CHANCE. Without the null, that is eleven false leads that
all look like discoveries. A candidate has to beat the shuffled-label distribution.

The two modes also answer different questions, and both are worth having. If `--motion` finds a
barrel, the barrel is trackable. If `--stun` finds a daze byte, the flower is trackable through
its consequence even if its object is never located -- which is exactly how Peach's Freezie is
handled today (item 10): the console says a fielder was held and never says what held him.

**Probe run 3 (2026-09-03, DK Jungle, --motion): a candidate for the barrel.** Eight offsets are
present in all four barrel events and in none of the four controls. Six are misaligned windows
onto one structure; `0x92AF5490` reads as a clean position triple, with `0x92AF5570` holding the
same values.

| event | travel | speed |
|---|---|---|
| ev0 | x -20.2 -> -33.2 | 24.7 u/s |
| ev1 | x -16.6 -> -8.3 | 19.8 u/s |
| ev2 | x -25.7 -> -36.9 | 24.3 u/s |
| ev3 | x -0.5 -> +11.6 | 24.6 u/s |

In every event `y` is pinned at 1.8 -- just off the ground -- while the object crosses the
outfield in x and drifts slowly infield in z. It is not a player: fielders read `y = 0.0` exactly
and their sprint ceiling is `ASSIST_SPEED_UPS_FIELDER` = 8.7 u/s, against 19-25 here, and their
addresses were excluded by name before the intersection ran. It is not the ball trail that
defeated runs 1 and 2: that lives at `0x900D6D40`, inside the state block, and this is 45 MB away.

The control did its job for the first time. Of eight events, seven recovered at least one known
moving fielder without being told where to look, and one control recovered none and was marked
void. The recovery rate is 1-5 of 9 rather than 9 of 9 because only some fielders are running at
any instant, which is expected and sufficient: the search demonstrably finds moving objects it
was not shown.

What is NOT yet established is that this object is the barrel rather than some other thing that
moves during barrel plays. That is what `--follow` is for, and it is not a statistical test:
these addresses are printed live at 4 Hz so a person can watch a barrel roll and see whether the
numbers move with it. A gimmick you can see is identified by looking at it.

**THE BARREL IS IDENTIFIED (2026-09-03).** `0x92AF5490` holds DK Jungle's barrel position, and
the operator confirmed it by eye: the numbers move every time a barrel rolls and only then. This
is the first stadium hazard object located in any park, and the live trace settles more than the
address.

*The barrel parks at its cannon.* When nothing is rolling the slot holds one of exactly two
sentinel values -- `(-39.0, 4.0, -93.5)` and `(+39.0, 4.0, -93.5)` -- symmetric in x, 93.5 units
out past the outfield, 4 units up. Those are the two cannons, and which one the slot holds is
which cannon is loaded. The operator's own observation, that the cannons track the ball at all
times, is what pointed the search at a persistent object in the first place.

*The flight is visible in full.* A shot begins at y 14.9-17.9 and 35-40 u/s, arcs down, and
settles to y = 1.8 rolling at 25-29 u/s. So the capture holds launch, arc and roll, not just
presence -- enough for a barrel's path to be reconstructed the way a batted ball's already is.

*The detection rule is clean.* A barrel is live exactly when `0x92AF5490` is away from both
cannon sentinels. No heuristic, no threshold.

`0x92AF5570` mirrors the position while a barrel is live and keeps the last rolling value once it
despawns, so `0x92AF5490` is the authoritative slot. `0x92AE57F0` and `0x92AE5808` are misaligned
windows onto the same structure and are not separate objects.

**CORRECTION (2026-09-16): that address is dead, and the allocation moves.** Everything above is
still true of the match it was traced in; it is no longer true of the address. The barrel was
captured from the next session onward and reads nothing in **both** captures that record it:

| session | what the slot holds |
|---|---|
| `dk_jungle-20260904T161731Z` | all-zero on 77,371 of 77,581 frames, garbage (`-8.9e33`) on 73, and one 137-frame run of a **constant** `(0.2523, -0.1100, 0.0)` |
| `dk_jungle-20260912T150755Z` | all-zero on 108,535 of 110,962, garbage on the remaining 2,427, **zero** live frames |

No cannon sentinel appears in either. So DK Jungle recorded 384 plays against an empty slot, the
archive holds **zero** barrel events, and the six barrel hits the operator annotated have no object
behind them — they survive only as the generic knockdown flag.

The cause is the same one Peach's Freezie array already had, and its comment already stated: *the
allocation MOVES between matches, so that address is a signature seed and never the address a new
capture trusts.* The Freezie is therefore located structurally at capture time; the barrel was the
one stadium object still trusting a remembered address.

`locate_barrel` in `collect_player_tracking.py` now gives it the same treatment. A parked barrel
sits on one of exactly two cannon sentinels, so three exact floats identify the slot. It fails
safely (nothing found → the old fixed region, capture unaffected), it does not require uniqueness
(the mirror is expected and clustered with it), and the captured region covers **every** candidate
with the shortlist in the header — so a wrong pick is re-chosen offline rather than re-played.
Measured: 67 MB scanned in 0.28 s once before recording, a 768-byte region, DK Jungle's frame
growing 37,068 → 37,324 bytes (+0.7%).

Two consequences for this document. `BARREL_HIT_UNITS` remains provisional and uncalibrated for the
same reason as before — still no session on disk contains a barrel. And the detector line in the
gate table below should be read as *the effect* (`fielder+0x23F`) plus *an object located per
match*, not as a fixed address.

*What this cost, and what made it work.* Two adjacency runs found nothing but the ball's own
trail, because "is near a fielder" is a question a coincidence can answer. Motion is not: a
smooth physical trajectory is rare in arbitrary memory, and on 6 x 64 MB of realistic data the
search returns essentially nothing by chance. The positive control is what made the run
interpretable -- seven of eight events rediscovered a known moving fielder without being told
where to look, and the one that did not was marked void automatically.

*Still to establish before this becomes a tracker feature.* `0x92AF5490` is outside the captured
state block (`0x900D5000..0x900DBD40`) by about 45 MB, so the collector cannot see it today. It
held across a whole session and across every event, but whether it survives a game reload is
unverified -- `--follow` after restarting the game answers that in under a minute. If it is
stable, capturing a second region makes barrels trackable, and `--motion` is the method that
should now be pointed at every other park's moving hazards.

**The barrel is wired into the tracker (2026-09-03).** Address confirmed stable across a game
reload, so it is captured rather than probed.

- `collect_player_tracking.py` gains `EXTRA_REGIONS`: 896 bytes a frame beside the 27,968-byte
  state block, appended to the same buffer so one XOR delta still covers a frame and the record
  stays a single block. Captured at EVERY park -- the read is trivial, a park with no barrel
  deltas to runs of zeros, and a uniform format is worth more than the bytes. What is
  park-specific is the interpretation.
- `player_tracking_io.py` gains `capture_offset` and `capture_size`. Sessions recorded before this
  carry no `extra_regions`, resolve the barrel offset to None, and read back byte-identically.
- `SnapshotBuilder` exposes `snapshot["barrel"]` with `pos`, `live` and `cannon`, so the live and
  postgame derivations see the barrel through the same code that already keeps them in agreement
  about everything else.
- `detect_barrel_events` emits `play.barrel_events[]`: each interval the barrel was live, which
  cannon fired it, its path and peak height, and its closest approach to every fielder.
- The narrative names a barrel that REACHED someone and stays silent about one that crossed an
  empty outfield. It may name the cause here, unlike the knockback clause, because the capture
  does name it.

`BARREL_HIT_UNITS` is 2.5 and is **provisional** -- chosen from the geometry, not measured, since
no session on disk contains a barrel. `closest_units`, `closest_frame` and
`fielder_moved_units_after` are recorded on every approach whether or not the flag trips, so the
first session that records a barrel next to an operator's annotation calibrates it without
re-capturing anything. `fielder_moved_units_after` is the independent corroboration: the distance
says the two were in the same place, the displacement says one of them was moved.

**The flower: what --stun needs to work (2026-09-03).** Two fixes before it is run for real.

*It was searching too small a space.* The barrel gave up a lead worth more than the barrel: DK
Jungle keeps stadium objects around `0x92AE5000`-`0x92AF5600`. `--stun` now records 160 KB of that
neighbourhood alongside the 27,968-byte state block, so one session tests both hypotheses at once
-- that the daze is written into the fielder actor the way Peach's Freezie is, and that the
flower has state of its own near its neighbours.

*The statistic was wrong, and it produced a FALSE NEGATIVE on a planted signal.* Counting perfect
separators and comparing that count to a shuffled null cannot see one real byte hiding among the
accidental ones. A byte taking two values separates n dazed from n clean under 2 of the C(2n, n)
possible labelings, so at 5 against 5 over 4,000 bytes about 32 separate by chance -- and 33 is
not distinguishable from 32. A synthetic run with a genuine daze byte planted in it was reported
as "no signal". The count-level p-value is retained, but it is no longer the verdict: the run now
prints the chance expectation from the arithmetic, lists the candidate addresses whatever the
p-value says, and solves for the sample size that would settle it. The selftest carries the
false-negative case.

The sample count is not a matter of taste. Across the 191,808 bytes now captured:

| dazed vs clean | separators expected from chance |
|---|---|
| 5 v 5 | ~1522 |
| 8 v 8 | ~30 |
| 10 v 10 | ~2 |
| 11 v 11 | ~0.5 |

So the flower needs about **twelve dazed and twelve clean**, and five of each -- which is what an
earlier version of this document suggested -- could not have concluded anything. A second session
intersected against the first is the fallback if the count lands short: a chance separator almost
never repeats and a real one always does.

**THE FLOWER IS IDENTIFIED: `fielder+0x242` (2026-09-03).** Both DK Jungle hazards are now
readable, and this one works retroactively on every session already on disk.

*The first analysis asked the wrong question and got the right answer to it.* A whole-capture test
compares a fixed byte offset across events, and a per-actor flag cannot survive that when the
victim changes: the session dazed CF twice and RF three times, so CF's flag is set in the CF
events and clear in the RF ones. The flat test found one separator and it was ball-trail noise.
Aligning the test to the fielder the operator NAMED fixes it, and fixes the power problem at the
same time -- five dazed events become five dazed actor-samples against ninety-four clean ones,
over 748 bytes instead of 191,808. So five stuns and six controls were enough, where the flat test
would have needed twelve of each.

Result: `+0x242` is 1 for the sprayed fielder and 0 for all ninety-four others, with ZERO chance
separators across 2,000 permutations (p = 0.0005).

*Confirmed against annotations written before it was found*, which is the part that makes this
more than a fit. `dk_jungle-20260902T171957Z` was captured and hand-annotated a day earlier:

- fires at all four labelled flower sprays (5406, 10904, 22861, 68122)
- fires at NEITHER labelled barrel hit (37591, 42863), so it is the flower and not a generic stun
- fires on two fielders at once at frame 11154 -- the play the operator wrote as "blue noki and
  boomerang bro get sprayed"
- fires at DK Jungle and, unlabelled, at Daisy Cruiser -- and at none of the other seven parks

It sits two bytes from the Freezie flag. The game keeps its "this player is disabled" states
together, which is also why the Freezie search kept landing in this neighbourhood.

*Wired in.* `flower_gas_flag` is named in the collector AND in `LATE_ACTOR_FIELDS`, so every DK
Jungle session ever recorded reports its sprays without re-capture -- the fielder structs were
always captured whole. The deriver emits `play.flower_sprays[]` alongside `freezes[]`, with
`sprayed_frames` / `sprayed_seconds` / `sprayed_at_s` per fielder. The narrative names the cause,
which the Freezie clause may not, because the evidence above says it may.
`verify_player_metrics.py` now checks the flag against those annotations on every run.

*Reader speed.* Naming the field made the verification read whole sessions, which exposed a
byte-at-a-time XOR in `Session.frames()` -- two billion interpreted operations per session. Now
vectorised: 75,539 frames in 6.7 s instead of minutes, same output.

*Moving flower layout.* The flowers move between innings, which retires the "static stadium
geometry" assumption behind the failed adjacency searches. In inning 1 of the 2026-09-12 night
game, three formed a triangle in center field and one sat down the left-field line. In inning 2,
one was down the left-field line, one was in dead center and two were in right-center. These two
observations are documented, not hard-coded: the tracker reads the affected fielder's state and
does not need a guessed flower coordinate.

**The disabled-state cluster, and a correction (2026-09-03).** `+0x242` was described above as
DK-Jungle-only on the strength of five parks showing zero runs. Sweeping `fielder+0x200..0x260`
across one session for all nine parks corrects that: it fires at DK Jungle (7 runs) and at Daisy
Cruiser (4), and nowhere else. None of Daisy's four annotations mentions a stun, so what it means
there is untested -- but Daisy's listed gimmicks include a table player stun, and a shared
"stunned by a stadium object" primitive that several parks write would explain it. The DK Jungle
finding is unaffected: the annotations establish it is the flower AT THIS PARK, and the narrative
is gated on the park for exactly this reason.

The sweep is worth more than the correction. The neighbourhood really is where the game keeps
these states, and several bytes fire at one park and no other:

| offset | fires at | note |
|---|---|---|
| `+0x240` | Peach only (24) | the Freezie, already named |
| `+0x242` | DK (7), Daisy (4) | the flower at DK; unknown at Daisy |
| `+0x243`, `+0x244`, `+0x245` | Daisy only (2, 2, 1) | candidates for the table stun |
| `+0x25A` | DK only (1) | unknown |
| `+0x25C` | Peach only (477) | unknown, far too frequent to be a freeze |

So the method that closed the flower is not a one-off, and the remaining parks have candidate
bytes waiting rather than an empty search. Each still needs what DK Jungle needed: labelled
moments, and the actor-aligned test. A byte firing at one park is a lead, not a finding -- `+0x242`
looked park-exclusive too until nine parks were checked instead of five.

**The statue POW, and why it is a short test (2026-09-03).** The actor-aligned test is powerful
enough that a handful of events settles it. With 748 bytes and roughly nine fielder-samples per
event, the separators expected from chance are:

| POW events (+6 clean) | dazed vs clean samples | chance separators |
|---|---|---|
| 2 | 2 vs 70 | 0.59 |
| 3 | 3 vs 78 | 0.018 |
| 4 | 4 vs 86 | 0.0006 |
| 5 | 5 vs 94 | 0.00002 |

So **four POW stuns and six clean moments** is decisive, and the flower was found on five.

`--stun` now accepts **ALL** as the dazed answer. That is not a convenience: a POW disables the
whole defence at once, and forcing that into one fielder's name would file the other eight
genuinely-disabled players as clean and bury the flag being hunted. Labelled ALL, a whole-defence
stun contributes nine dazed samples an event -- 36 against 54 in the selftest, which recovers the
planted flag at p = 0.002.

The same night session also settles `flaming_barrel_collision` in about thirty seconds:
`--follow` on `0x92AF5490` while a flaming barrel rolls says whether it is the same object with a
different skin or a separate one.

Do NOT run the collector and `--stun` in the same session. `--stun` needs the game paused and the
collector has a stall detector watching the game timer; pausing repeatedly during a capture is a
good way to lose the capture.

**A rare gimmick does not need repeated occurrences (2026-09-03).** The operator reports the
statue POW fires seldom, so four labelled stuns is not a realistic ask. `--stun` is the wrong tool
for that and `--sweep-session` is the right one: a 60 Hz capture already holds every fielder
struct on every frame, so ONE occurrence supplies roughly 120 disabled frames against 75,000
undisabled ones. No pausing, no labelling, no minimum count.

It ranks on two signatures. RARE -- a hazard flag is up for a second or two a handful of times a
game, so thousands of onsets means ordinary fielding state. And SIMULTANEOUS -- a POW disables the
whole defence, which almost nothing else does, since ordinary fielding flags fire on one player at
a time. Eight or nine fielders switching a byte on in the same frame is either that kind of hazard
or the Buddy Throw cutscene, and those are separated by duration and by `buddy_thrower`.

Validated against a session whose answer is known: run over `dk_jungle-20260902T171957Z` it
surfaces `+0x242` at 7 onsets, correctly, from a capture that was never paused or labelled for it.
The same run reports NO whole-defence flag anywhere in that session, which is the right answer for
a day game -- so a night capture showing one is signal rather than background.

One bug found in the writing. Seeding the previous-frame state from zeros makes every already
non-zero byte look like it switched on at capture start, and because that happens to all nine
fielders at once it counterfeits precisely the whole-defence signature being hunted -- the first
run reported fourteen, all on the first frame, all artefacts. Seeded from the first frame instead.

So the night session is an ordinary recorded game: `TRACKER_PARK=dk_jungle npm run tracker:preview`,
play, annotate the POW play through the console when it happens, and sweep afterwards. That
session also captures barrels, which is what calibrates `BARREL_HIT_UNITS`, and `--follow` answers
the flaming barrel in thirty seconds. One night game closes every remaining DK Jungle objective
except root slowdown.

**DK JUNGLE NIGHT PASS COMPLETE (2026-09-12).** `dk_jungle-20260912T150755Z` has 110,962 frames,
zero missed frames and 111 emitted plays. It supplies the missing night-variant evidence:

- Day's `fielder+0x242` is silent at night. `fielder+0x2CA` has exactly four onsets, aligned to
  the four operator-noted flower hits at contacts 8950, 55573, 69773 and 74823. The annotated
  near miss at 7330 has no onset. Two daytime DK controls and the preceding night Yoshi capture
  also have no `+0x2CA` onsets.
- `fielder+0x243` value 1 has exactly three runs, all 91 frames: CF at contacts 76817, 81230 and
  89729, precisely the three annotated statue-POW knockdowns. Bowser Jr.'s paint on the same byte
  is value 2, so the causes remain separable. Three visible POW activations that hit nobody emit
  no player event, as expected from a consequence detector.
- The confirmed barrel at 25014 and the other DK barrel markings remain on the generic physical
  knockdown byte `+0x23F`. The night object address was not required to name an affected player.
- No repeatable slowdown state was found around the left/left-center roots. The observed symptom
  is that CPU-controlled fielders sometimes decline to walk onto them, which is path selection,
  not a measurable player debuff. It stays out of the tracker unless a later capture shows a
  distinct effect.

The deriver now emits `flower_sprays[]` from the correct day/night byte and `dk_pow_stuns[]` for
the value-1 night effect. The narrative names both causes and keeps no-hit activations silent.

**A GENERIC KNOCKDOWN FLAG: `fielder+0x23F` (2026-09-03).** Six parks at once, found without
playing anything new.

Wario City's session already carried two annotated manhole knockdowns. `+0x23F` has three onsets
in that whole game and all three fall inside the two annotated windows -- two of them together at
frames 6660 and 6789, which is what the operator meant by the manhole doing it "twice to koopa
troopa".

It is not park-specific, and testing it at DK Jungle is what showed what it actually is:

| | annotated flower sprays | annotated barrel hits |
|---|---|---|
| `+0x242` | **4 / 4** | 0 / 2 |
| `+0x23F` | 0 / 4 | **2 / 2** |

Perfectly complementary. `0x242` is the GAS half of the disabled cluster and `0x23F` is the
PHYSICAL-IMPACT half. The clearest single confirmation is PA11: `0x242` fires on CF and RF at
frame 11154 and `0x23F` on RF at 11168, against an operator note reading "blue noki and boomerang
bro get sprayed by the flower... and then boomerang bro gets hit by a barrel".

Across the archive, with the control that matters first:

| park | knockdowns | |
|---|---|---|
| Mario Stadium | **0** | the one park with no gimmicks at all |
| Peach Ice Garden | **0** | Freezies FREEZE (`0x240`); they do not knock down |
| Luigi's Mansion | 0 | |
| Wario City | 3 | manhole |
| DK Jungle | 7 | barrel |
| Daisy Cruiser | 4 | table |
| Bowser Castle | 5 | podoboo / thwomp / bob-omb |
| Yoshi Park | 4 | piranha / train |
| Bowser Jr. Playroom | 16 | Chain Chomp / Bullet Bill |

*It removes the provisional threshold from the critical path.* `BARREL_HIT_UNITS = 2.5` was chosen
from geometry and never measured, and it was deciding whether a barrel hit somebody. A barrel hit
is now read off the flag: `hit_source` says `knockdown_flag` when the game supplied the answer and
`distance_fallback` only for a session recorded before the flag was named. `closest_units` is
still reported either way, which is what makes a disagreement between the two visible rather than
silent.

*Wired in.* `knockdown_flag` is named in the collector and in `LATE_ACTOR_FIELDS`, so six parks'
knockdowns are readable in captures recorded weeks before it was found. The deriver emits
`play.knockdowns[]`, park-neutral. The narrative reports one only when nothing else on the play
explains it -- at DK Jungle the barrel clause names the cause, and two sentences for one event is
worse than one. `verify_player_metrics.py` checks it against the Wario annotations AND against
Mario Stadium reading zero.

What knocked a fielder down is still not named by this byte, only that something did. DK Jungle's
barrel and new Yoshi Park captures now pair it with the object's own position; the other parks
still require that cause evidence.

**Decision:** stadium-event output stays gated off. Existing memory provides stadium identity,
ball trajectory, generic actor action, contact and possession, which is enough to describe many
consequences but not to attribute every one to exactly one stadium object. Peach's Freezies and
DK's flowers are already counterexamples to complete causation. Enabling only arrows, pipes or
teleports would therefore be the partial system explicitly ruled out. The gate can open only
after dedicated day/night captures locate stable object tables or trigger flags for every row;
until then, annotations remain ground truth and no causal stadium labels enter calibration.

### Team score, hits and star meters (2026-09-25)

Six team-level scalars the vendored public tracker reads and this project never named
(`public-tracker-release/stat_tracker.py`, `_assign_score_and_meter_fields`). "Away" is the team
batting in half 0; every counter rises only during its own half-inning, which is how the naming
was checked rather than assumed.

| field | address | retroactive |
|---|---|---|
| `away_score` / `home_score` | `0x900D5D98` / `0x900D5DB2`, u16 | yes |
| `away_hits` / `home_hits` | `0x900D5DCD` / `0x900D5DE7`, u8 | yes |
| `away_star_meter` / `home_star_meter` | `0x900D4E24` / `0x900D4E26`, u16 | **no** |

The score and hits fields were always inside the captured block, so every archived session reads
them back now: `daisy_cruiser-20260831T212804Z` is 12-10 on 20 and 19 hits,
`peach_ice_garden-20260826T201820Z` 7-6 on 15 and 15.

The star meters were not. They sit 476 bytes below the old `STATE_BASE` of `0x900D5000`, so no
session recorded before 2026-09-25 contains them and none ever will. An exhaustive search of the
old region for a byte that steps down by 1 or 2 at each of 18 captain star swings, sampled 30
frames before each pitch so no sample could land inside the star animation, found nothing that
beat its permutation ceiling — the correct answer for a counter outside the bytes being searched.
An earlier version of that search compared a frame before the swing to one 45 frames after and
appeared to find a star flag on the batter; it was reading the star animation clearing a block of
actor bytes, and the same "finding" reproduces on fielders and runners. `STATE_BASE` is now
`0x900D4E00`, and old sessions skip the two meter fields on the bounds check rather than reading
a neighbouring byte as a meter.

The meter is a bar, not a count of stars. A star swing or star pitch subtracts one of three costs
read from MEM1 at `0x8062BD48` (regular), `0x8062BD4A` (captain) and `0x8062BD42` (non-main
captain) — a captain playing for the team he captains pays the regular price. Those are recorded
once in the capture header as `star_costs`, so a meter drop can be priced from the session alone.

**Still unknown:** how the meter is awarded. Stars are a comeback mechanic that favours the
trailing team and reportedly scales with the deficit, which means star availability is correlated
with score state. Nothing prices star decisions yet, and nothing should until that award rule is
measured, or the model will re-measure the deficit and call it a decision.

---

## 12. Design decisions worth knowing

**The dead-ball tail.** `ball_was_hit` stays latched for up to 9.8 s past the dead ball while
the game runs replays and inning changes. The play window now also closes
`DEAD_BALL_TAIL_FRAMES` (90 frames, 1.5 s) after the game's own `game_state` transition. The
tail is not arbitrary: the one measurement that legitimately reads past the dead ball is
`final_bases_ran`, following a runner's count through the actor teardown, and the widest real
advance-after-dead-ball in the archive is 62 frames. Verified by re-deriving all five sessions
— every derived field unchanged except the frame counters that had been counting through
celebration animation, which are now honest.

**Deferred play builds.** Closing a play costs 42–87 ms. Inline, that would drop about five
frames at every dead ball. The live path passes a single-worker executor to `PlayDeriver`; the
postgame path passes nothing and runs inline. Same function, same arguments, same order — one
worker preserves the order plays closed in, which is what keeps replay suppression and the
postgame comparison valid.

**Calibration is confirmed, not assumed.** Postgame the position offset is scored over the
whole session before anything is derived; live it must be chosen at frame zero, and the wrong
one produces confident wrong numbers rather than an error. `+0x004` is seeded and then checked
against the session itself — a fielder holding the ball stands exactly on it, to the float.
Plays derived before confirmation are **held, not published**, and released in order the moment
the offset is proven. Four plays with no lock at all and live derivation gives up for the
session; the recording continues and the postgame pass does it properly.
