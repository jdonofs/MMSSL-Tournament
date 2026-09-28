# Final stat expansion — backend handoff

**Date:** 2026-09-16
**Scope:** capture, persistence and calculation. The display layer is prompt 2's.
**Status:** implemented and locally verified. **No database migration and no
backfill are required** — production's tracking tables are empty and season 71
is greenfield. The stadium-event completeness gate remains CLOSED and nothing
here opens it.

**TEST-season readiness:** ready to record. Every capture requirement is in place
before game one, including DK Jungle's barrel, which the collector now locates
per match instead of trusting a remembered address. The two things that can only
be proven by playing are named in §7 and both are self-proving on the first
game — neither needs a research session, a probe run, or any special procedure.

This document is written for whoever implements the display prompt. It states
the contract, what each number means, what is proven, and — just as important —
what is measured but *not* attributable, so the UI does not render a confident
label over an unknown cause.

---

## 1. What was actually wrong

The audit's findings were reproduced against the real archive (50 derived
sessions, 3,940 plays). All five are confirmed:

| Defect | Evidence | Status |
|---|---|---|
| Manhole knockdowns silently dropped | The deriver writes `hazard: 'manhole_water'`; `gimmickLuck.js` whitelisted `'manhole'`. A whitelist miss returns nothing, never an error, so **all 19** archived manhole knockdowns died between the deriver and the site. | Fixed |
| Freezes never reached the site | **116** `freezes[]` records exist, all Peach Ice Garden. The adapter read only the **13** `frozen_fielder_ball_contacts`, so "times frozen" was showing a ninth of the truth. | Fixed |
| Star-swing exclusion read the wrong nesting level | `name_star_swing_knockdowns` took `event.by` / `event.hit` off a barrel *interval*; those fields live on `barrel_events[].approaches[]`. It was collecting a set of `None`, so the exclusion never fired. Latent only because the archive contains no barrel events. | Fixed |
| Evidence strengths were indistinguishable | 56 of 79 train knockdowns come from the `fence_band` inference and 23 from the captured `train_position`. Both rendered as one "Train knockdown". | Fixed — `cause.confidence` |
| Quarantine applied everywhere except luck | Movement/arm/catch-probability summaries reject a quarantined session; the gimmick summary did not. | Fixed |

**Net effect on the archive:** the old adapter produced **229** events from 3,940
plays. The new descriptive contract produces **519** incidents plus **1,049**
player-mechanics records, with 519 and 1,049 distinct stable ids and zero
duplicates.

---

## 2. The two new event contracts

Both are persisted inside the **existing** `tracking_plays.quality` jsonb. No new
table, no new column, no migration.

### 2.1 `quality.stadium_incidents[]` — what the park did

`src/utils/stadiumIncidents.js`, `STADIUM_INCIDENT_SCHEMA_VERSION = 1`.

```js
{
  schema_version, id, family, type, label,
  park, time_of_day,                    // 'day' | 'night' | 'unknown'
  frame, t, duration_frames, duration_seconds,
  victim:    { position, characterId, playerId, trackerCharacterId, unresolved } | null,
  initiator: { ...same } | null,
  cause: { type, confidence, source, player_caused },
  intentional, capability, detector_version, evidence: { ... }
}
```

**`family`** is the concept separator, and it is the whole point of the module:

| family | meaning | has a victim? |
|---|---|---|
| `actor_effect` | something happened **to** a character | yes |
| `ball_interaction` | the ball was moved, held or struck | **no** |
| `object_change` | a stadium object broke | no (has an initiator) |

A redirected ball has no victim. Inventing a fielder for one is how a ball
interaction becomes a fake injury, so `victim` is `null` by construction for
everything that is not an `actor_effect`.

**`cause.confidence`** — earned from measured provenance, never a score:

| value | what earned it | archive count |
|---|---|---|
| `object_confirmed` | the object's own captured state/position | 62 |
| `flag_named` | an established game flag, park-gated | 215 |
| `inferred` | geometry/kinematics excluded everything else | 79 |
| `unknown` | the **effect** is measured, the cause is not | 163 |

`unknown` is a first-class answer and is **counted, never dropped**. 46 of the
archive's 199 knockdowns are unnamed; hiding them would claim a completeness the
capture does not have.

**`cause.player_caused`** marks a captain star swing. It writes the same fielder
bytes a hazard does, so it is counted (as "star effects suffered") but must never
appear as a park mechanic or enter stadium luck.

### 2.2 `quality.play_mechanics[]` — what the players did

`src/utils/playerMechanics.js`, `PLAY_MECHANICS_SCHEMA_VERSION = 1`.

Types: `buddy_attack`, `buddy_jump_attempt`, `buddy_handoff`, `close_play`,
`star_effect_caused`. Archive totals: 538 / 54 / 366 / 14 / 77.

Two deliberate refusals, both of which the UI must respect:

- **`buddy_jump_attempt` is not a Buddy Jump credit.** The official BJ credit is
  already scored from the tracker log and displayed. This is the raw `+0x223`
  window, which fires on attempts the log never announces. **Adding the two
  together double-counts one jump.**
- **A Buddy attack's three bytes are three different claims.** `+0x265` says the
  animation ran (`buddyAttacks`, 538), `+0x267` latches only on contact
  (`buddyAttacksWithContact`, 404), and clearing an object requires the object's
  own disappearance (`buddyObjectClears`, **5**). The contact latch alone does
  not prove anything broke.

`star_effect_caused` is **one record per activation with a `victims` count**, not
one per victim, and is credited to the batter. The fielders it disabled are
counted separately on the stadium side as effects suffered.

---

## 3. Aggregator interfaces

```js
summarizeStadiumIncidents(trackingPlays, 'player' | 'character', { includeQuarantined = false })
stadiumIncidentTotals(trackingPlays, { includeQuarantined = false })
summarizeMechanics(trackingPlays, 'player' | 'character', { includeQuarantined = false })
summarizeAdvancedBaserunning(runnerOpportunities, 'player' | 'character')
```

All are **pure**, take already-scoped rows, and reject quarantined sessions by
default. They do not fetch, and they do not know about competitions — pass them
rows you have already scoped, exactly as `Stats.jsx` does today.

### Count definitions — these are five different numbers

| field | means |
|---|---|
| `incidents` | physical incidents whose **victim** is this actor |
| `distinctPlays` | plays touched — **not** the incident count |
| `durationSeconds` | summed measured duration of those incidents |
| `ballInteractions` | ball events credited to an **identified initiator** only |
| `objectBreaks` / `intentionalObjectClears` | objects broken / broken on purpose |

**Never derive a physical total by summing a luck column.** Every luck event
credits one owner and debits another, so that sum is exactly twice the number of
events and reads as a doubling nobody notices.

### Baserunning (`src/utils/advancedDefense.js`)

Existing fields are unchanged. **`attemptRate` still means attempt rate** — the
XBT% column's definition is preserved, not silently migrated. Added:

- `safeRate` — safe advances **per opportunity** (the third rate; `successRate`
  remains per *attempt*).
- `splits` — all six opportunity types **always present**, each with counts and
  all three rates, so a table's columns cannot move between rows.
- `byType` — retained unchanged in its original counts-only shape for the
  existing consumer.
- `modeledCoverage`, `expectedAttemptRate`, `expectedSuccessRate` — `null`, never
  zero, when the model priced nothing. A zero there ranks an unmodeled runner as
  the most passive runner alive.

### Fielding components — already available, no backend work needed

Prompt 2's item 4 asks for fielding denominators and components. **These already
exist** and need nothing from the backend; they are simply not rendered. From
`summarizeAdvancedFielding(...)`: `throws`, `buddyThrows`, `armStrengthMph`,
`hardestThrowMph`, `hardestBuddyThrowMph`, `armOpportunities`, `armHolds`,
`armAdvances`, `armKills`, `armValue`, `doublePlayOpportunities`, `doublePlays`,
`doublePlaysAdded`, `doublePlayRuns`, `fieldingOpportunities`, `actualOuts`,
`expectedOuts`, `outsAboveAverage`, `directionalOaa`, `directionalOpportunities`,
`positioningSamples`, `averagePositionDepthFeet`, `averagePositionAngleDeg`,
`fieldingRunValue`. From `summarizeMovementMetrics(...)`: `speedSamples`,
`sprintSpeedFps`, `maxSprintSpeedFps`, `bolts`, `homeToFirstSamples`,
`homeToFirstSeconds`, `ninetyFootSplitSeconds`, `jumpSamples`,
`jumpDistanceFeet`, `jumpReactionFeet`, `jumpBurstFeet`, `jumpRouteEfficiency`.

Two cautions carried from the existing code: a Buddy Throw is a chemistry pair's
output and is deliberately **excluded** from Arm Strength (a fielder seen only in
Buddy Throws has `armStrengthMph: null`, not a borrowed one); and the Jump
components remain explicitly **prototype** measurements — see
`docs/tracker-validation-console.md` — so do not present them as a calibrated
Statcast Jump.

**Rbaser vs experimental WAR BsR.** They are not the same quantity and must not be
presented as equal. `Rbaser` is extra-base taking only. WAR's BsR additionally
carries double-play avoidance (`experimentalWar.js` subtracts DP run value from
the batter). `recompute_advanced_metrics.mjs` persists model outputs fitted with
run expectancy; `experimentalWar.js` re-models on demand over its own cohort.
Expect them to differ; label them separately.

---

## 4. Files changed

**Created by this work:** `src/utils/stadiumIncidents.js`,
`src/utils/playerMechanics.js`, `tests/stadium-incidents.test.mjs`,
`tests/player-mechanics.test.mjs`.

**Edited by this work:** `src/utils/gimmickLuck.js` (canonical alias, quarantine),
`src/utils/advancedDefense.js` (baserunning contract),
`scripts/collect_player_tracking.py` (**locate the barrel per match** by cannon
sentinel; `resolve_extra_regions` now returns a 4-tuple and the header records
the located address plus the candidate shortlist),
`scripts/derive_player_metrics.py` (freeze onset frame, star-swing/barrel nesting
fix, barrel travel guard), `scripts/ingest_player_tracking.mjs` (persist both
contracts, version bump), `scripts/review_stadium_events.mjs` (registry
reconciliation), `scripts/verify_player_metrics.py` (stuck-slot and barrel-locator
controls), `tests/gimmick-luck.test.mjs`,
`tests/tracker-ingestion-reliability.test.mjs`, `tests/calibration-tooling.test.mjs`.

**Read `git diff --stat` carefully here.** The repository was already heavily
modified before this work and remains so; `src/utils/gimmickLuck.js` and
`tests/gimmick-luck.test.mjs` are **untracked**, because the whole Gimmick Luck
feature is itself uncommitted. Git therefore reports them as new files rather
than as edits, and the very large diffs on `derive_player_metrics.py` (~2,600
lines) and `verify_player_metrics.py` (~1,200 lines) are overwhelmingly
**pre-existing uncommitted work, not this change** — my edits to those two files
are roughly fifty lines combined. Nothing was committed and nothing was reverted.

`public-tracker-release/` was **not** touched: it is a separate standalone
product that deliberately excludes stadium measurement.

---

## 5. Schema, versioning and backfill

- **No migration.** Both contracts live in the existing `tracking_plays.quality`
  jsonb (`default '{}'`). `test:database` was therefore not required and was not
  run; nothing in this change alters what the database enforces.
- `INGEST_NORMALIZATION_VERSION` is bumped to `tracking-v3-stadium-incidents-v1`.
  It feeds the derived checksum, so a deliberate re-ingest of an already-ingested
  session builds a **versioned replacement beside** the active one and only moves
  the pointer once it is finished — the existing `tracker_begin_session_replacement`
  / `tracker_activate_session_version` path, unchanged.
- **Event ids are stable** across retries, re-ingestion, late identity resolution
  and PA corrections, and **distinct** across session versions and across the two
  competitions (season and tournament game ids collide; the id includes the
  competition). Verified by test.
- **There is nothing to backfill.** A read-only query against production on
  2026-09-16 returns **0 rows** in `tracking_plays`, `tracking_sessions` and
  `runner_opportunities`. Season 71 (`TEST`, status `draft`) is greenfield, so
  every game it records will be written under this contract from the first
  ingest. No migration, no backfill, no re-ingest of historical games.
- Should a local session ever need loading anyway:
  `node scripts/ingest_player_tracking.mjs --session <stem> --unleased-reason "<why>"`.
  It is idempotent, never overwrites a raw capture, and the previous version
  stays active until the replacement finishes. Re-derivation is **not** required
  — freezes recorded before the onset frame existed have their absolute frame
  reconstructed exactly from the play's own contact timer.

### Where the contracts are built — postgame only

Both contracts are built in `scripts/ingest_player_tracking.mjs`, which runs
**after** the capture, from the authoritative `.plays.jsonl`. There is no live or
preview stadium surface and this change did not add one: `tracker:preview` and
`tracker:replay` remain permanently Supabase-free, and the live derivation path
(`player_live_derivation.py`) emits the same raw detector arrays it always did —
it simply has no consumer that normalises them mid-game. The console's stadium
*narrative* clauses (`scripts/tracker_narrative.mjs`) are unchanged and read the
raw arrays directly, so live commentary and postgame totals cannot disagree by
construction: one of them does not exist during the game.

The practical consequence for the TEST season: stadium and mechanics numbers
appear on the site only once a game's capture has been derived and ingested, on
the existing deliberate `finalizePlayerTrackingCapture` path in the bridge. They
are not live-updating stats.

### Unverifiable from this repository

A **read-only** query against production (no insert, update or delete) confirms
that `tracking_plays`, `tracking_sessions` and `runner_opportunities` all exist
and are selectable, and that `seasons` holds `37 MSL Season 1 (active)` and
`71 TEST (draft)`. So the tracking schema is deployed.

Still **not** observed, because those three tables are empty: whether
`tracking_plays.quality` is jsonb rather than json, and whether RLS permits the
ingest role to *write* it. Both are near-certain — the existing `gimmick_events`
write targets the same column through the same code path — but a read cannot
establish either, and no write was attempted. The first real ingest of a season
71 game is what proves it, and it will fail loudly rather than silently if the
column type is wrong.

---

## 6. Park-by-park status

| Park | Status | What is produced | What is missing |
|---|---|---|---|
| Mario Stadium | **Supported** (negative control) | 6 incidents, **all** `player_caused` star swings | nothing; the control holds |
| Wario City | **Supported** | arrow redirect 37, manhole knockdown 19, manhole rebound 1 | day/night arrow object naming only where props captured |
| Yoshi Park | **Supported** | train knockdown 79 (23 object-confirmed / 56 inferred), pipe transit 5, pipe stun 4, Piranha 3, train ball hit 6, capture 1 | night Wiggler object not located |
| Daisy Cruiser | **Supported (day)** | table rebound 14, break 13, stun 8 | night Cheep Cheep and Gooper tilt: no capture |
| Peach Ice Garden | **Partial** | freeze 116, break 13, rebound 4, frozen-ball contact 13 | night blackout; freeze cause proven in only 4 of 10 sessions |
| Bowser Castle | **Partial** | statue fire 6, falling lava 6, Bob-omb 14 | Podoboo, Thwomp block, fireball puddle; 4 unnamed knockdowns, 1 discarded burn |
| DK Jungle | **Partial** | flower spray 21, POW stun 3 | **barrel cause unsupported** — 24 unnamed knockdowns retained as `unknown` |
| Bowser Jr. Playroom | **Unsupported** | 16 knockdowns, all `unknown` | Thwomp / Chain Chomp / Bullet Bill: no object |
| Luigi's Mansion | **Unsupported** | 8 impact stuns unnamed; 3 star-swing knockdowns | gravestone / ghost / grass: no named path; 2 of 3 sessions have unknown time of day |

**Unsupported must never render as zero incidents.** Use `capability` on each
incident and the absence of a detector row in `review_stadium_events.mjs` to show
"not tracked" rather than "0".

---

## 7. The barrel and freeze checks — performed vs still required

### Barrel: **the object address is dead.** Traced from the archive, not assumed.

`0x92AF5490` was identified live on 2026-09-03 and captured from the next session
on. In both DK Jungle captures that record it:

- `dk_jungle-20260904T161731Z` — 77,371 of 77,581 frames all-zero, 73 garbage
  (`-8.9e33`), and one 137-frame run of a **constant** `(0.2523, -0.1100, 0.0)`.
- `dk_jungle-20260912T150755Z` — 108,535 of 110,962 all-zero, 2,427 garbage,
  **zero** live frames. No cannon sentinel ever appears in either.

That constant cleared every existing guard (finite, in range, non-zero, away from
both sentinels) and read as a live barrel parked 0.28u from home plate. It emitted
nothing only because those frames fell outside every play window — luck, not a
guard. **Fixed** by `BARREL_MIN_TRAVEL_UNITS`, with a synthetic 137-frame
stuck-slot control in `verify_player_metrics.py`.

**A hit and a near miss are nonetheless evidenced**, from the knockdown flag plus
the operator's own labels — not by renaming knockdowns by elimination:

| session | contact | annotation | measured |
|---|---|---|---|
| 20260904 | 9677 | "barrel reached and knocked out the cf" | CF knockdown f9850, 79f |
| 20260904 | 23563 | "the barrel reached and knocked out the right fielder" | RF knockdown f23790, 79f |
| 20260904 | 65250 | "cf was knocked out by the barrel" | CF knockdown f65462, 79f |
| 20260904 | 37140, 72413 | *no annotation* | knockdowns 62f and 40f — the near-miss/other-cause controls |

These remain `knockdown_unknown_cause`. The 79-frame duration is the generic
knockdown length (Wario City's manhole runs 79–80f too), so it is **not** a barrel
signature. Note also that the night session's annotated barrel shows phase shape
`1×39 → 2×40` — the shape `name_bomb_knockdowns` treats as King Bob-omb. The shape
is **not park-unique**; only the park gate makes it specific.

#### The barrel no longer needs a research session

The root cause was not that the object is unfindable — it is that the barrel was
the only stadium object the collector **remembered** instead of **locating**.
Peach's Freezie array is searched for structurally at capture time, and its own
comment says why: "the allocation MOVES between matches, so that address is a
signature seed and never the address a new Peach capture trusts." The barrel had
no such search, so it kept pointing at a 2026-09-03 address that has since moved.

The barrel now gets the same treatment (`locate_barrel` in
`collect_player_tracking.py`). A parked barrel sits on one of exactly two cannon
positions, so **three exact floats in a row** identify the slot — a tighter
signature than the arrow matrix, needing no cluster to be convincing.

Three properties make this safe:

- **It fails safely.** Finding nothing prints why and records the old fixed
  region, exactly as before. A session is never lost to this.
- **It does not require uniqueness.** The authoritative slot has a mirror (0xE0
  later in the original allocation), so several candidates are expected. The
  lowest is chosen, which reproduces the one relationship the live trace
  established without hardcoding the gap.
- **A wrong pick is recoverable without replaying the game.** The captured
  region covers *every* candidate on *every* frame and the full shortlist goes
  into the header (`barrel_candidates`, `barrel_cluster`, `barrel_located`), so
  the authoritative slot can be re-chosen offline and the session re-derived.

Nothing downstream changed: `session_snapshot_builder` already preferred
`header.barrel_position` over the constant, so a located address flows through
derivation untouched, and every existing capture reads back byte-identically.

**What it costs the capture, measured** — this runs on the capture-start path, so
it was exercised end to end against a fake Dolphin rather than argued about:

| | measured |
|---|---|
| MEM2 scan, once, before recording | 67 MB in **0.28 s** |
| candidates found | the slot **and** its mirror, clustered as one allocation |
| chosen address | the authoritative slot, not the mirror |
| capture region | **768 bytes/frame** (cap is 4,096) |
| DK Jungle frame size | 37,068 → **37,324 bytes (+0.7%)** |

For comparison, `locate_freezie_array` already scans the same 64 MB range at
Peach Ice Garden, so this adds a cost the capture path has always carried at one
park to a second park, and it happens before the first frame is recorded.

> **Still required — but it is now self-proving.** The locator is verified against
> synthetic memory and its controls (zeros, a rolling barrel, a half-unit near
> miss), **never against a live match**. The first DK Jungle game answers it with
> no probing, no labelling and no special procedure: the header will carry
> `barrel_located: true` and a real address, and `barrel_events[]` will be
> non-empty on a play where a barrel rolls. If it instead reports that no
> sentinel was found, the capture is still good and the stadium dump beside it is
> the fallback. **Just play a DK Jungle game and check the header.**

### Freeze: **causation is proven, from the archive.**

Across the three Peach sessions that captured the Freezie object array
(`20260909T184001Z`, `192448Z`, `195355Z`), **all 24 freeze onsets** had an
**active** Freezie as the nearest object, at **2.64–3.59u** (median 2.9) — over 8
different characters and 3 sessions. That band is the Freezie's own contact
radius, and it is a measurement rather than an assumption.

- Those onsets emit `cause.confidence = object_confirmed`.
- The other **92** onsets are in six sessions that never captured the array. They
  are counted as freezes with `cause.confidence = unknown`. **The UI must not
  label them "Freezie".**
- Freeze incidence and frozen-fielder ball contact are **separate**: 99 plays have
  one or both; 10 have both; **0** have a contact without a freeze. A freeze
  followed by a rebound is one freeze plus one ball interaction, never two freezes.

> **Still required (capture):** none for the freeze contract itself. To promote the
> remaining 92 onsets, only a re-capture at Peach Ice Garden with `freezie_array`
> in the header would help; the six old sessions cannot gain a value they never
> recorded.

### Live checks NOT performed

No emulator was run and no production database was touched. Specifically **not**
verified: that a live bridge run writes both contracts end to end against
Supabase; that production RLS permits the write; and the barrel relocation above.
**This is not full TEST-season readiness** — the barrel capture check is
outstanding.

---

## 8. Verification actually run

Every command below was run in this repository and passed.

```
node --test tests/stadium-incidents.test.mjs        16/16
node --test tests/player-mechanics.test.mjs          8/8
npm run test:metrics                                11/11
npm run test:defense                                33/33
npm run test:scorebook                              64/64
npm run test:tracker                              572/572
npm run test:persistence                            39/39
npm run test:acceptance                             42/42
npm run build                                       built in 4.43s
python scripts/verify_player_metrics.py             all checks passed
python -m unittest ... collector_capture_ready_test  5/5
node scripts/verify_speed_against_attributes.mjs    r=0.97 / 0.87 / 0.87
node scripts/review_stadium_events.mjs              gate still closed
```

Three controls added to `verify_player_metrics.py` by this work, all passing:

- `stuck barrel slot rejected` — 137 frames of one constant produce 0 events.
- `barrel located by cannon sentinel` — the slot and its mirror are found; a
  rolling barrel, a half-unit near miss and a block of zeros are all rejected.
- plus the collector's own import/arity check: `resolve_extra_regions` returns
  its new 4-tuple at every park and touches memory at none of the ones with no
  structural search.

`test:database` was not run: no migration was added and nothing changed what the
database enforces.

**On baselines, precisely.** Only `test:metrics` (9/9) and `test:defense` (32/32)
were run *before* any change, and both were green, so the additions there are
genuinely additive. The other suites were run only *after* the change. They all
pass, so nothing in this work regressed them — but that is not the same as an
audit for pre-existing failures, and I am not claiming one. One real regression
was introduced and fixed during the work: adding rate fields inside
`summarizeAdvancedBaserunning`'s `byType` broke an exact-shape assertion in
`advanced-defense.test.mjs`. Since `byType` is pre-existing uncommitted work, the
shape was restored and the new rates live in `splits` instead; that test was not
edited to accommodate me.

**One test WAS deliberately changed, and the distinction matters.**
`calibration-tooling.test.mjs` asserted that every Bowser Castle registry row has
`detector: null`, using that park as its example of one where nothing is
captured. That is no longer true: `name_bowser_castle_burns` separates statue
fire from falling lava against a surveyed centre-field front, and
`name_bomb_knockdowns` names King Bob-omb — 12 fires and 14 bombs in the archive,
both checked against the operator's own annotations by `verify_player_metrics.py`.
Reconciling that stale claim was the assigned work, so the registry is right and
the assertion was encoding the old state. The test's *invariant* ("a row with no
detector must say the object has to be found first") was preserved and
strengthened rather than weakened: it now checks that rule over the rows that
genuinely have no detector (`podoboo`, `thwomp_block`) **and** the converse,
previously untested — that a row which HAS a detector asks for labelled plays
instead. Getting those two backwards is how a park with a working detector ends
up looking unreachable.

Coverage includes: producer-shaped manhole aliasing, freeze vs frozen-ball
contact, barrel/star overlap at the correct nesting level, repeated hits on one
actor, two victims on one play, confidence status, intentional vs incidental
object clearing, unresolved identity (never falling back to the pitcher),
quarantine, zero vs missing, distinct plays vs incidents, and id stability across
re-ingestion, session replacement and late identity resolution.

The acceptance run is the end-to-end proof: its season recording
(`peach_ice_garden-20260904T152214Z`) carries **17 freeze onsets that previously
produced no site-visible output at all**, and it ingests twice with the second run
a verified no-op.

---

## 9. What prompt 2 must not assume

1. **`unknown` cause is data, not a gap.** 163 incidents carry it. Render it as an
   explicit state.
2. **Unsupported ≠ zero.** Bowser Jr. Playroom has 16 real knockdowns and no
   attributable cause; Luigi's Mansion has no named path at all.
3. **Do not label the 92 uncaptured Peach freezes "Freezie".**
4. **Do not add `buddyJumpAttempts` to official Buddy Jump credits.**
5. **Do not sum both luck sides** to get a physical event count.
6. **`attemptRate` is the existing XBT%.** Migrate the label deliberately if at all.
7. **The barrel has no confirmed hits in any data recorded so far** — the type
   exists in the contract and all 50 archived sessions contain zero of them.
   Games recorded from now on should produce them, because the collector now
   locates the object rather than remembering its address; but do not build a UI
   that assumes the type is populated, and do not treat an empty barrel column as
   evidence that DK Jungle has no barrels.
