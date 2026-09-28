# Fielding and Baserunning Advanced Metrics Update Plan

**Status:** Proposed implementation plan  
**Prepared:** 2026-08-26  
**Scope:** Every publicly documented, currently active MLB/Baseball Savant fielding, catching, and running metric; the measurements needed to calculate them; and the legacy advanced defensive metrics still defined by MLB.

## Executive decision

The production tracker does **not yet fully auto-track any current Statcast fielding or baserunning metric using MLB's definition**. It does already auto-track the event outcomes needed for conventional fielding statistics, Range Factor, team Defensive Efficiency Ratio (DER), and portions of future opportunity models. Its existing `Range Runs` is useful, but it is a local coarse-zone estimate—not Outs Above Average (OAA) or Fielding Run Value (FRV).

The experimental 60 Hz player-tracking pipeline materially changes the outlook. It already captures the raw motion needed for positioning, player speed, routes, first touch, leads, and home-to-first time. Once that feed is integrated with the live tracker and corrected to use MLB-compatible event boundaries, it can support the first release of Statcast-style metrics. The next new detectors should focus on throws, eligible double-play opportunities, and extra-base advance/hold decisions.

League rules and game mechanics remove several MLB families from the implementation scope: there is no stealing or pickoff game in this league, every first baseman catches a received throw, and Sluggers has no meaningful catcher throwing, blocking, or framing system. Pop Time, exchange time, first-base Receiving OAA, basestealing metrics, and catcher metrics will therefore remain in the MLB inventory for completeness but will be explicitly marked **not applicable** rather than treated as missing product work.

The recommended product language is **“Sluggers OAA,” “Sluggers FRV,” or “OAA-style”** until each local model passes calibration. MLB publishes the metric definitions, but not every fitted coefficient or its complete tracking dataset; the game also has different timing, dimensions, characters, abilities, and run environment.

## What “every metric” means here

The inventory includes:

1. Every active fielding, catching, running, and fielder-positioning family exposed in Baseball Savant's 2026 navigation and leaderboards.
2. Every named output or component shown by those leaderboards that could become a product column.
3. The raw Statcast movement measurements required to reproduce or explain those metrics.
4. MLB's legacy advanced-defense glossary metrics, listed separately so they are not confused with Statcast.

It excludes hitting- and pitching-only metrics, private club models, and third-party systems that MLB cannot fully specify. DRS and UZR are included for completeness, but exact copies should not be claimed because their implementations are proprietary or externally owned.

## Locked league decisions

| Metric area | Decision |
|---|---|
| Arm Strength and Arm Value | **Build.** Track throw velocity, advances, outs, and deterrent holds. |
| Eligible double-play opportunities | **Build.** Track every eligible chance, expected DP probability, result, and player responsibility. |
| Holds on extra-base opportunities | **Build.** A hold is a required outcome, not an inferred absence of data. |
| Exchange and Pop Time | **Not applicable.** There is no stealing game to make these useful. |
| First-base receiving | **Not applicable.** Characters catch every received throw, so receiving skill has no variance to measure. |
| Steals, caught stealing, pickoffs, and stealing opportunities | **Not applicable.** They do not occur under league rules. |
| Catcher throwing, blocking, and framing | **Not applicable.** Those mechanics do not exist in Sluggers. |
| Catcher stance | **Out of scope.** It has no demonstrated fielding-value pathway in this league. |

## Capability status legend

| Status | Meaning |
|---|---|
| **Production now** | Persisted by the live system and automatically derivable today. |
| **Prototype capture** | The raw signal exists in the offline 60 Hz collector, but is not joined to production games or sufficiently validated. |
| **Model required** | Required raw events can be captured after integration, but an opportunity/probability or run-value model must be trained. |
| **New detector required** | A new memory signal, event detector, or tracked event type is needed. |
| **Mechanics test required** | First prove that the game exposes a meaningful version of the MLB mechanic. It may ultimately be non-applicable. |
| **Not applicable** | MLB tracks it, but the underlying mechanic or league event does not exist here. No implementation work is planned. |

## Current-system audit

### What production already captures

- Plate-appearance result, outs on play, base occupancy before the play, exact runner destinations where resolvable, and separately persisted runs scored.
- Fielder position spans, putout/assist chains, errors, and bobbles. Nice Plays are set when the first fielder to secure the ball dove (`catch_type` 3) and the play recorded an out (`trackerPlayIsNicePlay`); the At-Bat editor can still toggle one.
- Hit endpoint, first fielded location, hang time, hit world coordinates, exit velocity, launch angle, and batted-ball trajectory.
- Conventional fielding totals: putouts, assists, errors, chances, fielding percentage, and Range Factor per game.
- A local Range Runs model based on the first fielder, generic position origins, hit/fielded location, hang time, positional difficulty tiers, and local conversion rates.

Relevant implementation points are [the live bridge](../scripts/live_tracker_bridge.mjs), [tracker play parsing](../scripts/tracker_play_events.mjs), [runner assignment logic](../src/utils/runnerAssignment.js), [fielding statistics](../src/utils/statsCalculator.js), and [the current Range Runs model](../src/utils/fieldingRange.js).

### What the offline prototype captures

[The player collector](../scripts/collect_player_tracking.py) records the ball, all nine fielders, the batter, three runners, and game state at roughly 60 Hz. [The derivation script](../scripts/derive_player_metrics.py) currently emits:

- Actual starting and ending positions and sampled movement paths.
- Fastest one-second speed.
- A threshold-based reaction time and route efficiency.
- First touch, distance to touch, and opportunity time.
- Batter home-to-first time.
- Lead at contact, runner paths, and a raw stealing flag. The stealing flag is not used because league rules have no stealing.

These are promising inputs, not production metrics. The collector is not launched or health-checked by `npm run tracker:bridge`, its records lack a durable join to a persisted plate appearance, and its derived definitions do not always match MLB's. For example, MLB Jump starts at pitch release and measures feet gained in the correct direction over three seconds; the current prototype's `reaction_s` is a movement threshold measured from contact.

### Second session: Bowser Castle, nine innings

A 72,233-frame capture at a second park (101 batted balls after the later cut-short replay fix, 1 missed frame) confirmed the open questions and exposed three more defects.

**Confirmed.** `buddy_partner` names the chemistry partner. Across eight Buddy Throws in two parks it took four different values, was never the fielder holding the ball and never the receiver, and every pairing it produced has positive chemistry in the league's own table — Donkey Kong with Funky Kong, Dixie Kong with Tiny Kong, Goomba with Monty Mole. The velocity, though, belongs to the fielder who HAD the ball: grouped by that fielder it is constant to within 0.03 mph across different receivers and distances (Donkey Kong 152.1 twice, Goomba 129.4 twice), and grouped by partner it is not. It is still a pair's output rather than an arm, so it stays out of Arm Strength.

**Also found and fixed:**

| Defect | What it produced | Fix |
|---|---|---|
| **Character identity** | The game's character ids and this app's are different id spaces — of the 71 the game uses, 70 exist in `characters` and exactly one names the same character. Game id 2 is Donkey Kong; app id 2 is Luigi. Every tracked id was being written straight into a character column, producing valid foreign keys pointing at the wrong player | Every tracked id resolves through the game's name table to a roster character, with an alias for the two names the game spells differently (`Koopa Troopa` → `Koopa`). Unresolvable characters return null rather than a stand-in, and are reported at ingest |
| **Robbery possession** | A wall-climb catch was dropped entirely. The ball sat exactly on the centre fielder at 4.33u for ninety frames with the catch already called, and `ball_holder` stayed -1 throughout | Possession accepts either the game's carrier byte or its caught-in-the-air call. Coverage went to 109 of 110 fair balls across both parks, the only miss being the play the capture ended mid-way through |
| **Catch-probability features** | Every difficulty band converted at 52%, because the opportunity was measured to FIRST TOUCH — which on a ball that falls in is a pickup after the bounce, at a different place and a later time than where it landed. A fly ball's catch point and a base hit's pickup point looked like the same feature | The ball's landing is extracted as its own event, and the opportunity is measured to where the ball had to be *reached*. The curve is now monotone: 100% inside 2 u/s of required closing speed, 92% at 2–4, 86% at 4–6, **42% at 6–8**, and 0% beyond 8 |

**Home-run robberies are identifiable, and only geometrically.** The game raises no flag: across seven catches made off the ground its home-run flag read false every time, so a ball taken back over the fence is, in its own flags, an ordinary fly out. They are found by catch position against the measured fence — Tiny Kong's first-inning catch was 1.2u *beyond* the fence line with the ball 4.335u up, against a wall top measured independently from ball strikes at 4.645u. He was reaching over the wall. Four of 71 catches qualify. This matters more than its frequency: it is the top of the difficulty range a catch model has to learn.

### Third session: Mario Stadium and the fielding-action enum

The first Mario Stadium test added 72,860 frames and 83 batted balls. It also proved that the byte originally named `bobble_flag` is an enum, not a boolean: `1` is the secure-fielding animation, `2` is a real boot/misplay, `7` is the Buddy handoff/dash, and `3` is a separate attempt animation whose exact meaning is not yet confirmed. Treating every non-zero value as a bobble produced 27 false “deflections,” including every Buddy Throw and every clean pickup. Using only value `2` leaves four genuine misplays and twelve separate Buddy handoffs.

The reported Green Paratroopa play is preserved correctly: right fielder Light Blue Yoshi booted the ball, and centre fielder Mario caught the redirected ball 1.418 seconds later after covering 6.047u. It is stored as a rebound/rescue catch. Rebound catches and Buddy-created chances remain visible but are excluded from the ordinary OAA training population because their geometry no longer describes the original batted ball.

### Is range a skill? Not answered yet, but now answerable

The earlier curve incorrectly treated all three outfielders as independent opportunities on every ball. The model population is the responsible/primary fielder only. After that correction, exclusion of rebound/Buddy-created chances, and three human-fielded games, there are 83 usable outfield opportunities: 100% caught below 4 u/s of required closing speed, 94% at 4–6, 59% at 6–8, and 0% above 8. The contested band is real, but contains only 17 observations.

The working collection target is **about 15 human-played games total**. At the current rate that should provide roughly 80–90 contested chances—enough to fit and validate one league-average catch curve. Character value will be the residual from that shared curve; no per-character model is required or justified.

**2026-08-30 sample update:** ten fully derived sessions now contain 860 batted balls, 621 fair balls, 264 usable primary-outfielder opportunities, and 54 opportunities in the contested 6-8 u/s band. Reaching 80-90 contested chances therefore needs about 26-36 more, or roughly **5-7 additional nine-inning calibration games** at the observed rate. Yoshi Park has no completed derived session, and the Luigi's Mansion capture has no calibration/derived play file, so the first four games should be two at each of those parks. After that, park selection can be random while lineups continue to rotate pitchers and outfielders across speed/ability classes.

For contact-quality metrics, the linked season data currently has 133 non-star plate appearances with both exit velocity and launch angle across eight games. The first publishable xBA/xSLG/xwOBA checkpoint is 500 eligible balls in play (about **22 more normal games** at the observed rate); 1,000 is the preferred stable version-one checkpoint (about **52 more normal games**). These are league-pooled models with game-level holdouts, not separate per-character curves.

### What the first real-session audit changed

The synthetic verifier passed throughout, but a frame-by-frame audit of `wario_stadium-20260826T005958Z` (37,298 frames, 636 seconds, Wario Stadium) found five defects that the synthetic fixture could not have caught, because each depended on how the game behaves rather than on the arithmetic. All five are fixed, and the fixture was extended so each one now fails a check if it returns.

| Defect | What it produced | Root cause | Fix |
|---|---|---|---|
| Play segmentation | 74 batted balls where there were 57; one play in four was a duplicate with its contact point in the outfield | `ball_was_hit` rises again during the dead-ball aftermath — a home-run replay, an inning change | A swing only opens a play when the ball is at the plate and `game_state` is live. The split is total: 57 genuine contacts within 0.9u of the origin, 17 replays between 45u and 109u |
| Live-play boundary | First touch discarded on most plays; route efficiency and sprint speed measured through the between-play reset | The boundary was inferred from the first physically impossible fielder jump, which a pitcher's follow-through and an outfielder's dive both trip | The boundary is `game_state`, which leaves its live value two frames before the ball snaps to the mound. The old inference was wrong on 36 of 57 plays, ranging 0.48s–11.21s against true windows of 3.0s–10.7s |
| Fair/foul and home-run labels | Every batted ball in the session labelled fair and not a home run | Both flags are cleared on the same frame the play window closes — the exact frame they were read from | Read inside the live window, and classified. Every value cross-checked against the trajectory: foul balls all outside the lines, home runs all 96u–109u |
| Throw velocity | Long throws pinned to an 80 m/s cap; velocities inconsistent with their own flight distance | The cap existed to remove the possession snaps at either end of the window, but the game's own throws exceed it | Rejected on smoothness instead. Every throw now reports a peak at or above its average, decaying under drag, and launch is separated from release |
| Possession | Three home runs recorded as catches; fly balls passing over a fielder's head read as first touch | First touch matched on x and z only, ignoring height and the game's own `ball_holder` byte | One shared possession definition requiring both. All 37 fair balls now have a first touch; no home run or foul does |

Two mechanics surfaced that the metric definitions have to account for, both now measured and carried as covariates rather than hidden:

- **Fielders are glided, not run.** Characters run at a fixed per-character speed — the whole batting order measured between 8.2 and 10.3 u/s — but a fielder converging on a ball is moved by the game at up to 29 u/s. Both are straight-line constant-velocity motion, so only magnitude separates them. Sprint Speed measured through the glide was measuring the fielding assist: one 8.4 u/s outfielder read 20.7. Glide distance is now reported separately from run distance, and speed comes only from the latter.
- **Buddy Throws are a separate population, and not an arm at all.** A Buddy Throw is two chemistry-linked fielders combining: the first dashes and bounces the ball to the second, who fires it in. The game plays it as a cutscene—all nine fielder actors freeze for a full second while the ball hangs unheld—so coordinates cannot identify the chemistry partner. The `buddy_partner` scalar does: across eight Buddy Throws in two parks it took four values and every resulting pair has positive chemistry. The high-speed flight is attributed to the fielder holding the ball immediately before launch, but it is still a pair-created outcome and stays out of Arm Strength. The value-`7` handoff/dash animation is stored separately from value-`2` fielding misplays.
- **Kongs climb walls, and a catch made off the ground is invisible in the fielder's own coordinates.** A fielder's tracked height never leaves 0.00, in any of the 19,326 live frames — including the 2,180 where the game's own airborne flag was set. A wall climb, a leaping rob and a dive all read as standing still at ground level. The **ball's** height at the moment of possession is the only signal that a catch left the ground, and it is now recorded on every first touch. Three catches in the first session were made with the ball 18u to 24u up. This matters more than its frequency suggests: a robbed home run is the hardest opportunity a catch-probability model will ever see, and recording it as a seven-second can of corn poisons the top of the difficulty range. `home_run_robbed` is named as its own class for the case where the game raises both its home-run and its caught-in-air flag on the same ball — whether it does is unconfirmed, and if it does not the class simply never fires and nothing is mislabelled.

Diffing the whole state block across both triggers did find named scalars, all three idling at -1 and naming a fielder by its actor-table index:

| Scalar | What it is | Confidence |
|---|---|---|
| `throw_target` (`0x900D951A`) | The fielder the throw is **aimed at**. Set on all 37 detected throws and matching the fielder who caught it on 35. The two it disagreed on were both throws to second base that named the second baseman while the shortstop covered — the extra fact, not an error, and the half an arm-value or double-play model needs. | Confirmed |
| `buddy_thrower` (`0x900D66D0`) | Set for exactly the two Buddy Throws and nothing else, naming the fielder who had the ball. Agrees with the frozen-cutscene detector on both. | Confirmed |
| `buddy_partner` (`0x900D66CE`) | The chemistry partner. Across eight Buddy Throws it took four different values, was never the receiver or the fielder holding the ball, and every resulting pairing has positive chemistry in the league table. | Confirmed |

All three are now named in the collector and readable from sessions captured before they were found, since the whole state region was always recorded.

## Complete current metric inventory

### Fielding and positioning

| MLB/Savant family and displayed components | MLB definition/input summary | Current capability | Plan |
|---|---|---|---|
| **Fielder Positioning**: depth, angle, batter-specific positioning, all/situational/pitcher/team views, shade/shift rates | Actual fielder location at pitch release; depth is distance from home and angle is measured relative to center field | **Prototype capture** | Persist calibrated position-at-release for every defender. Derive depth/angle and configurable shade/shift classifications in Phase 2. |
| **Outfield Catch Probability**: expected catch probability, 1–5 star opportunity, actual catch percentage | Distance needed, opportunity time beginning at pitch release, direction of travel, and wall proximity | **Model required** | Correct first-touch/play boundaries, add wall geometry and catch outcome, then train a calibrated local probability model in Phase 3. |
| **Outfield OAA**: OAA, expected catch percentage, actual catch percentage, catch percentage added | Credit/debit for each opportunity equals its catch probability difficulty and whether the out was made | **Model required** | Sum held-out-calibrated catch credits after Catch Probability is stable. Publish opportunities and expected/actual values alongside OAA. |
| **Infield OAA**: OAA and success probability per opportunity | Intercept distance/time, distance from fielded point to the relevant base, and batter Sprint Speed | **Model required** | Add target-base and throw-completion events, then train separate ground-ball/infield models in Phase 3. |
| **Directional OAA**: back-left, back, back-right, in-left, in, in-right | OAA split into six travel directions | **Model required** | Derive direction from actual start-to-intercept vectors after the OAA opportunity model exists. |
| **Outfield Jump**: Jump, Reaction, Burst, Route | Feet gained versus average in the correct direction over the first three seconds after pitch release; Reaction is the first 1.5 seconds, Burst the next 1.5, and Route is path efficiency/value | **Prototype capture**, definition mismatch | Add pitch-release frame and projected intercept direction. Replace `reaction_s` with MLB-compatible windows and units in Phase 2. |
| **Arm Strength**: throw velocity, position-specific leaderboard aggregate | Maximum tracked velocity of each qualifying throw; MLB's leaderboard aggregates a player's hardest subset by position | **New detector required — build** | Segment possession, release, ball flight, and receiver acquisition; convert world units to feet; retain every qualifying throw; and publish per-throw velocity plus a position-aware hard-throw aggregate in Phase 4. |
| **Arm Value / Fielder Throwing Runs**: runs, advances, thrown out, holds, opportunity/attempt/success outputs | Extra-base opportunity model using runner speed/location, fielder arm/location, ball location, and available bases | **New detector + model required — build** | Build runner opportunity and throw detectors; explicitly label advances, outs, and holds; estimate attempt/success probabilities; and use the local run-expectancy table in Phases 4–5. |
| **First Base Receiving OAA / Scoops**: Receiving OAA plus on-target, bounce, scoop, low, high, and wide throw categories | Every 2B/SS/3B throw within the first baseman's reachable perimeter receives an out probability using throw location/type and runner speed/location | **Not applicable** | Do not build. Every character catches a throw that reaches first base, so there is no receiving-skill variance to value. Throw arrival can still close a groundout or DP event. |
| **Double-Play value**: double plays added and FRV contribution | Actual double plays relative to expected double plays on eligible opportunities; current FRV converts one added DP to about 0.4 runs | **Outcomes partly available; detector/model required — build** | Define structural eligibility at contact, record zero/one/two-out results and every chain stage, then train an expected-DP model and derive DP Added/run value in Phase 4. |
| **Fielding Run Value (FRV)**: total and components from range/OAA, arm, first-base receiving, double plays, catcher blocking, framing, and catcher throwing | MLB's composite defensive runs, with each component converted from its natural units to runs | **Blocked by applicable component metrics** | Sluggers FRV will combine validated range/OAA, arm, and double-play value only. Nonexistent receiving and catcher components are omitted—not estimated as player skill. Release in Phase 6. |

MLB's published 2026 FRV conversions are useful reference points, not constants to copy blindly into this game: about 0.9 runs per OF out, 0.75 per IF out, 1:1 for throwing runs, and 0.4 per added double play. MLB also converts receiving and catcher components, but those are not part of Sluggers FRV because the underlying league mechanics do not exist.

### Catching

| MLB/Savant family and displayed components | MLB definition/input summary | Current capability | Plan |
|---|---|---|---|
| **Catcher Blocking**: Blocks Above Average, blocking runs, opportunities, passed ball/wild pitch outcomes | Probability of a passed ball or wild pitch from pitch location, speed/movement, catcher location, handedness, and outcome | **Not applicable** | Do not build. Sluggers has no catcher-blocking value mechanic. |
| **Catcher Framing**: called-strike rate/extra strikes and framing runs by attack zone | Called-ball/strike results on takes, adjusted for pitch location and context; value is concentrated around the zone boundary | **Not applicable** | Do not build. Sluggers has no catcher-framing mechanic. |
| **Pop Time**: pop time, exchange time, catcher arm strength | Time from catcher receipt to projected arrival at the receiving base, split into exchange and throw travel | **Not applicable** | Do not build. The league has no stealing, so this has no relevant play population. |
| **Catcher Throwing**: Caught Stealing Above Average, catcher throwing runs, CS/SB/opportunities and expected success | Steal success probability using runner distance/speed, pitch location, pitcher/batter handedness, pitchouts, and delayed steals | **Not applicable** | Do not build. The league has no stealing or catcher-throwing system. |
| **Catcher Stance**: knee-down rate and count/context splits | Catcher knee height at pitch release; MLB classifies knee-down below a height threshold | **Out of scope** | Do not build for this update because it has no demonstrated path to defensive value in this league. |

### Baserunning

| MLB/Savant family and displayed components | MLB definition/input summary | Current capability | Plan |
|---|---|---|---|
| **Sprint Speed** | Fastest one-second window; season value uses a player's fastest qualifying competitive runs rather than every jog | **Prototype capture** | Convert calibrated units/second to ft/s, implement MLB-style qualifying-run filters, and publish play samples plus season aggregate in Phase 2. |
| **Bolts** | Count of individual qualifying runs reaching at least 30 ft/s | **Prototype capture** | Derive after unit calibration and Sprint Speed qualification. A zero league total is valid if the game's speed scale never reaches the MLB threshold; optionally show a game-relative “Sluggers Bolt” separately. |
| **90-foot Running Splits** | Home-to-first motion divided into five-foot increments and extrapolated to a standard 90 feet | **Prototype capture**, only total time today | Persist start/finish crossings and resample calibrated paths at five-foot intervals in Phase 2. Retain raw game-distance time separately. |
| **Lead Distance**: lead at pitcher first move and pitch release; distance gained | Runner-to-base distance at key pitch events | **Out of scope as a standalone metric** | With no stealing/pickoffs, do not build an MLB-style lead leaderboard. Preserve runner location at contact as an input to extra-base opportunity and success models. |
| **Extra Bases Taken Run Value**: runner runs, advances, thrown out, holds, opportunities, actual/estimated attempt rate, attempt rate above average, safe rate per opportunity/attempt | Decision and success models for taking an extra base on balls in play, using runner/fielder speed and locations, arm, ball, and base state | **Outcomes partly available; detector/model required — build** | Exact runner destinations can reconstruct many outcomes, but holds and all eligible opportunities need explicit events. Add them, then train attempt/success models and local run values in Phase 5. This opportunity set also drives Arm Value. |
| **Basestealing Run Value**: runner stealing runs, Net Bases Gained, Bases Gained vs Average, Outs Created vs Average, opportunities, attempt rate, SB, CS, pickoffs, balk/forced-balk events, lead/distance gained | Every eligible pitch opportunity values an attempt or non-attempt from success probability and base/out run impact | **Not applicable** | Do not build or create synthetic zero-opportunity rows. There is no stealing or pickoff play in this league. |
| **Baserunning Run Value** | MLB combines Extra Bases Taken Run Value and Basestealing Run Value | **Blocked only by Extra Bases Taken Run Value** | In Sluggers, `Rbaser` is Extra Bases Taken Run Value because the stealing component is non-applicable. Replace the current hard-coded `rbaser = 0` after Phase 5 validation. |

### Supporting movement measurements

These are measurements rather than separate current headline leaderboards. The applicable measurements should be stored because they explain the metrics and preserve compatibility with MLB's Statcast glossary: first step, acceleration, maximum speed, dig speed, extra-base times, home-run trot time, total distance covered, pivot time, route efficiency, and first-step efficiency. Stealing first step, secondary lead for stealing, and catcher exchange are excluded from the implementation scope.

The player prototype can already estimate several of these. Pivot, throwing, and ball-in-play runner decisions require the new event detectors described below.

### Legacy MLB advanced-defense metrics

| Metric | Current capability | Product decision |
|---|---|---|
| **Range Factor (RF/G)** = (PO + A) / games | **Production now** | Already shown. Keep it clearly labeled as a conventional opportunity-sensitive measure. |
| **Defensive Efficiency Ratio (DER)** = share of fieldable balls converted to outs | **Production now at team level** | Add from existing PA outcomes after explicitly classifying reached-on-error and excluding BB, SO, HBP, and HR. Do not present individual DER. |
| **Defensive Runs Saved (DRS)** | **Cannot reproduce exactly** | DRS is a third-party system. A validated Sluggers FRV may answer a similar product question, but must not be labeled DRS. |
| **Ultimate Zone Rating (UZR/150)** | **Cannot reproduce exactly** | UZR is externally specified and depends on proprietary zone/opportunity data. Do not manufacture a namesake metric; use local OAA/FRV. |

## Capability conclusion

### Auto-trackable with the production system now

- Putouts, assists, errors, chances, fielding percentage, and Range Factor.
- Team DER after a small derivation update.
- Completed double-play counts and many runner advance outcomes, but **not** above-average or run-value versions.
- Existing local Range Runs, provided it remains labeled local/provisional and is not presented as OAA.

### Auto-trackable after productionizing the existing player feed

- Fielder positioning, distance covered, player speed, Sprint Speed, Bolts, home-to-first and 90-foot splits.
- MLB-compatible Jump components after adding pitch-release timing, plus runner location at contact for extra-base models.
- Raw route and first-touch measurements after fixing play boundaries.
- The raw inputs for Catch Probability, OAA, and Directional OAA; the metrics themselves still require calibrated models.

### Not auto-trackable until new detectors exist

- **Committed work:** Arm Strength/Value, eligible double-play opportunities, and eligible extra-base opportunities including holds.
- **Explicitly not applicable:** exchange/Pop Time, first-base Receiving OAA, stealing/pickoffs, catcher throwing, catcher blocking, and catcher framing. Catcher stance is out of scope.

### Shared dependency for Arm Value and extra-base running value

Arm Value and Extra Bases Taken Run Value must come from the same opportunity rows. For each eligible runner/base pair, capture the ball and fielder locations, runner position/speed, available destination, responsible fielder, whether the runner attempted or held, whether an attempt was safe or out, and any throw. The runner model values the decision/result from the offense's perspective; the arm model assigns the inverse value to the responsible defender. This prevents holds from disappearing merely because no throw occurred.

### Proposed eligible double-play definition

A version-1 double-play opportunity begins when all of the following are true at contact:

- Fewer than two outs.
- At least one runner is forced, normally a runner on first.
- The ball is fair and in play.
- The batted-ball class and location make a two-out sequence possible under the trained model; line/fly catches with a possible force-after-catch should be tracked separately from ground-ball DPs.

Persist the pre-play base/out state, contact/ball features, fielder starts and identities, first possession, pivot/release/arrival frames, runner arrival frames, intended bases, and zero/one/two-out result. Start with team DP Added so failures are not assigned to the wrong character; add player credit/debit once each chain stage can be attributed reliably.

### Arm Strength implementation contract

Each detected throw should retain the thrower, defensive position, possession frame, release frame, receiver/target, arrival frame, sampled ball path, peak stable speed, outcome, and quality flags. Release is the first frame of sustained ball separation from the possessing fielder; arrival is receiver possession, a tag/out event, dead ball, or the end of a valid flight window.

Calculate speed from calibrated ball displacement over consecutive in-flight frames. Use a short rolling median and require multiple consistent samples so a one-frame memory jump cannot become the player's hardest throw. Preserve the raw per-throw speeds, then apply an MLB-inspired position-specific hard-throw subset only at aggregation time. Publish the qualifying-throw count, average qualifying velocity, hardest throw, and aggregate Arm Strength.

### Arm Value and hold implementation contract

An extra-base opportunity is a runner/destination pair for which advancing was physically and legally possible on a live ball. It must be created before reading the runner's final choice. Its outcome is exactly one of `hold`, `advance_safe`, `advance_out`, `forced_advance`, or `not_applicable`; forced advances and non-opportunities do not enter discretionary attempt-rate models.

For every discretionary opportunity, store:

- Runner origin, proposed destination, location and speed when the fielder controls the ball.
- Ball location, responsible fielder, fielder location, defensive position, target base, and cutoff/relay context.
- Base/out state, other runners, outs available, and park geometry.
- Whether the runner held or attempted, whether an attempt was safe/out, and the linked throw if one occurred.

Train one model for probability of attempting and another for probability of success conditional on an attempt. Arm Value is the reduction in expected offensive run value attributable to the responsible fielder: positive for more or more-valuable holds and outs than expected, negative for excess or more-valuable advances. Use out-of-fold, leave-one-fielder-out, or prior-period arm inputs so the same player's observed outcome does not define their own baseline. Start with single-fielder plays; keep relay/cutoff plays at team level until responsibility allocation is validated.

## Target data architecture

### 1. Productionize the frame collector as a bridge-managed sidecar

`npm run tracker:bridge` should launch, health-check, and stop the player collector for a tracked game. The raw 60 Hz stream should remain a compressed replay artifact in local/object storage, with a checksum, schema version, game/stadium/calibration metadata, sampling statistics, and capture status. Do not put every raw frame in Postgres.

### 2. Create a stable join between ball, actor, and scoring feeds

Every feed needs a common `game_id` and emulator/game frame counter. Persist pitch-release, contact, first-touch, release, arrival, and dead-ball frame IDs. Join a tracking play to the final plate appearance using game ID, half-inning, local PA/pitch/contact sequence, and frame boundaries. A timestamp-only join is not sufficient.

### 3. Persist normalized opportunities, not only season aggregates

Prefer source-agnostic tables with a tournament/season discriminator instead of duplicating every tracking table:

- `tracking_plays`: PA link; release/contact/touch/dead frames; ball path/end point; park; batted-ball/outcome labels; quality status.
- `fielding_opportunities`: fielder identity/position; actual start/intercept; distance, direction, wall proximity, timing, outcome; expected out probability; OAA; model version.
- `tracking_throws`: thrower/receiver; release/arrival; start/end/target/base; peak speed; out/result; linked arm-value and DP opportunity.
- `runner_opportunities`: runner, origin/destination, eligibility reason, attempt/hold, start/arrival, safe/out, speed/splits, responsible arm, and linked throw if any.
- `double_play_opportunities`: structural eligibility, expected probability, ball/contact context, force bases, chain stages, zero/one/two-out result, DP Added, and credit status.
- `metric_results` or materialized views: versioned play/game/season outputs. Store `metric_version`, `model_version`, `computed_at`, sample size, and input-quality rollup.

The event rows are the source of truth so that a model change can backfill every game without replaying the emulator.

### 4. Add explicit quality and mechanics metadata

At minimum: missed-frame rate, calibration version, actor identity confidence, unmatched-PA flag, measured-versus-estimated timestamps, false/post-play possession, foul/dead-ball ambiguity, and truncated capture. Star abilities, Buddy Jumps, stadium hazards, and unusual walls should be explicit covariates or separate splits—not silently mixed into normal opportunities.

## Event detectors to build

1. **Pitch timeline:** pitch release, contact or take, and dead-ball frame.
2. **Possession/first touch:** distinguish playable touch, bobble, catch, pickup, and post-play automatic possession.
3. **Throw segmentation:** fielder possession → release → flight/bounces → receiver possession, with target/base and peak velocity.
4. **Ball-in-play runner state machine:** force status, eligible next base, hold/advance decision, departure, base crossing, safe/out, and return.
5. **Double-play state machine:** structural eligibility, first possession, force targets, pivot, throws, receiver possession, runner arrivals, and outs recorded.
6. **Catch/fielding opportunity:** identify the responsible fielder and all plausible opportunities, outcome, wall/hazard interaction, and target out.

## Phased delivery plan

### Phase 0 — Metric contract and instrumentation

- Freeze the inventory and define each Sluggers metric, qualifying play, exclusion, unit, aggregation, and display name in a versioned metric contract.
- Add the common frame clock and deterministic identifiers to both trackers.
- Formalize field dimensions/base coordinates for each park and wall/hazard geometry where possible.
- Build a small manual video-label workflow and golden game set covering routine and edge cases.

**Exit:** The same tracked play can be joined deterministically across raw frames, bridge events, Supabase PA/runner rows, and video labels.

### Phase 1 — Production player tracking and data quality

- Make the collector a bridge sidecar with start/stop/health/recovery behavior.
- Persist normalized tracking plays and raw-session manifests.
- Correct live-play and first-touch boundaries; add data-quality reports and automatic quarantine.
- Capture actual position-at-pitch-release instead of using generic field markers.

**Exit:** At least 98% of fair batted balls in the golden set link to the correct PA, actor identity is at least 99% accurate, and first-touch precision/recall are each at least 98% on manually labeled plays.

### Phase 2 — Measurement-first release

- Release fielder positioning, distance covered, calibrated fastest-one-second speed, Sprint Speed, Bolts, home-to-first, and 90-foot splits.
- Add pitch-release frames for fielding positioning and Jump.
- Reimplement Jump/Reaction/Burst/Route according to the public MLB time windows and correct-direction definition.
- Show sample counts and quality status on every leaderboard.

**Exit:** Timing error is no more than one captured frame for labeled boundaries; distance/speed error is within 2% of calibrated replays; outputs are reproducible from persisted event rows.

### Phase 3 — Range and OAA models

- Train separate out-probability models for outfield catches and infield plays.
- Include actual start, ball path/end point, opportunity time, distance/direction, wall/park, character/position, runner speed, base target, and special-mechanic flags as appropriate.
- Generate Catch Probability/star bands, OF/IF OAA, expected/actual conversion, catch percentage added, and Directional OAA.
- Keep the current Range Runs visible as “legacy local Range Runs” during comparison; do not feed new OAA into WAR until validation passes.

**Exit:** Holdout Brier/log-loss and reliability curves beat simple position/tier baselines; calibration is acceptable across probability bands, parks, and characters; model version and confidence are visible.

### Phase 4 — Arm strength, Arm Value inputs, and double plays

- Build throw segmentation: possession, release, stable in-flight samples, receiver acquisition, target base, and result.
- Calculate peak throw velocity from consecutive stable flight frames, excluding possession-transition frames and obvious teleport/lock artifacts. Retain every qualifying throw and the samples used to calculate it.
- Release per-throw velocity, hardest throw, and a position-aware hard-throw aggregate. Keep raw velocity separate from Arm Value.
- Create the shared fielder-arm/runner opportunity dataset with advances, outs, and **explicit holds**, even when no throw is made.
- Implement the structural double-play opportunity detector and zero/one/two-out chain results.
- Train expected-DP probability and release team DP Added/run value first. Add player attribution only after fielding, pivot, throw, and timing responsibility can be separated reliably.

**Exit:** On at least 50 manually labeled throws per major type, thrower/receiver/target and release/arrival detection each meet 98% precision/recall; velocity agrees with frame-derived ground truth within 2%. Double-play eligibility and zero/one/two-out results each meet 98% precision/recall on the labeled set.

### Phase 5 — Extra-base decisions, holds, and run values

- Build controlled hold, advance, thrown-out, retreat, tag-up, forced-advance, cutoff, and throw-to-base scenarios.
- Define eligible extra-base opportunities independently of what the runner ultimately chose, so a hold is a positive recorded outcome rather than missing data.
- Release opportunities, attempts, holds, advances, thrown out, actual/estimated attempt rate, attempt rate above average, and safe rates.
- Train separate attempt and conditional-success models. Use out-of-fold or prior-season fielder estimates so the model can measure arm deterrence without leaking the same outcome into its expectation.
- Assign offensive value to the runner and inverse throwing value to the responsible fielder, including deterrent hold credit and advancement debit.
- Fit a Sluggers base-out run-expectancy table and calculate Extra Bases Taken Run Value, Arm Value, and Sluggers Baserunning Run Value.
- Replace `rbaser = 0` in WAR after the extra-base component is stable.

**Exit:** Eligible-opportunity, hold/attempt, and safe/out labels each meet 98% precision/recall on the golden set; attempt and success models pass holdout calibration; every run value is derived from a versioned local RE24 table and reconstructs per play.

### Phase 6 — Composite FRV, WAR, backfill, and UI

- Convert validated components with the local run environment and assemble Sluggers FRV.
- Expose FRV by applicable component so range, throwing, and double-play value remain auditable.
- Switch `rfield` and `rbaser` in WAR only after side-by-side shadow seasons and sign-off.
- Backfill all sessions with compatible raw archives; clearly mark older games that cannot be reconstructed.
- Add metric tooltips with definition, units, qualifier, version, sample size, and confidence.

**Exit:** Every aggregate drills into its opportunity rows, recomputes deterministically, and has a migration/backfill report with no silent mixture of model versions.

## Validation program

### Controlled scenario suites

- **Range/catches:** routine, boundary, wall, dive, Buddy Jump, star ability, foul/dead-ball, bobble, and post-play possession.
- **Throws:** infield groundout, OF relay, cutoff, throw home/third/second, force/tag, unnecessary throw, and no-throw hold.
- **Double plays:** structurally eligible completions and failures at fielding, pivot, throw, and runner-arrival stages, plus similar-looking ineligible plays.
- **Running:** straight home-to-first, two-base runs, retreat, hold, tag-up, forced advance, discretionary advance, thrown out, and non-opportunity controls.

### Model controls

- Use train/validation/test splits by game, plus leave-one-character and leave-one-park-out checks.
- Publish calibration curves, Brier score/log loss for probability models, and uncertainty/minimum-sample rules.
- Use shrinkage for sparse characters and contexts rather than unstable raw rates.
- Keep a simple baseline model and block promotion if a new model does not improve out-of-sample accuracy.
- Recompute historical aggregates under a new version; never combine incompatible model versions in one leaderboard.

### Run-value policy

Use this league's own base/out run expectancy rather than importing MLB's fixed conversions. Three-inning games, scoring levels, roster construction, star powers, and stadium hazards change the value of an out or base. MLB's conversions remain useful sanity checks. Until the local sample is stable, use hierarchical shrinkage and display wide confidence bands or suppress run-value rankings.

## Immediate backlog

Done: team DER; the bridge sidecar (capture, calibrate, derive, ingest); normalized opportunity tables; throw segmentation; eligible double-play and extra-base/arm opportunity rows; the live-play, first-touch and landing boundaries; batted-ball classification; deterministic physical-contact actor detection (`0x900D9524`) with separate attempt/contact/possession/mechanic facts; Buddy Throw detection and its partner; home-run robbery geometry; tracked-character identity resolution.

Next, in order:

The dated ten-session update above supersedes the original three-game snapshot retained in item 1 for audit history.

1. **Capture volume — now the only thing gating the catch model.** The original three-game model set has 241 batted balls after removing two cut-short Bowser Castle replays, 169 fair, 83 usable primary-outfielder opportunities, and 17 in the contested 6–8 u/s band. The target is about 15 human-played games total, which should provide roughly 80–90 contested chances for one shared catch curve. CPU-only fielding is not a valid substitute because it does not reproduce the league's jump/dive behavior.
2. **Run the whole chain against the database on one tracked game in season 71 and check the plate-appearance join.** `matchPlaysToPas` has still never seen real data, and until the duplicate-play defect was fixed it could not have matched anyway — one session reported 74 batted balls where there were 57. The counts should now line up. Exit: every fair play joins the correct plate appearance, and the fielder and runner identities on the joined rows match the scorebook.
3. **Build the golden labeled set.** The Phase 0 item still outstanding, and the gate on Phase 3. Everything found so far was catchable from physics and from the game's own state flags; double-play eligibility and hold-versus-advance are judgement calls that need eyes on video.
4. Write the versioned metric contract and event taxonomy.
5. Release the Phase 2 measurement metrics before any modeled run-value leaderboard.

## Key risks and decisions

- **Public definition versus exact replication:** MLB definitions are public; full fitted models are not. The product must use local names/qualifiers until validated.
- **Sample size:** opportunity models require far more plays than counting stats. Pool by position/context, shrink sparse results, and show uncertainty.
- **Identity/linkage:** a beautiful model on mismatched PA/player data is worse than no metric. Deterministic frame joins are a release blocker.
- **Special mechanics:** star powers, Buddy Jumps, stadium hazards, unusual wall catches, and character abilities need explicit taxonomy.
- **Missing mechanics:** receiving, stealing/pickoffs, Pop Time/exchange, and catcher defense are deliberately non-applicable. They should remain visible in the inventory but must not return synthetic zero-valued player rows.
- **Raw-data volume:** archive compressed frame streams outside relational tables and persist compact, versioned opportunity facts in Supabase.

## Official MLB sources

All sources were reviewed on 2026-08-26.

- [Baseball Savant Fielding Run Value leaderboard](https://baseballsavant.mlb.com/leaderboard/fielding-run-value) and [MLB Statcast FRV glossary](https://www.mlb.com/glossary/statcast/fielding-run-value)
- [MLB Statcast Catch Probability glossary](https://www.mlb.com/glossary/statcast/catch-probability)
- [MLB Statcast Outs Above Average glossary](https://www.mlb.com/glossary/statcast/outs-above-average)
- [Baseball Savant Directional OAA](https://baseballsavant.mlb.com/leaderboard/outfield_directional_outs_above_average)
- [MLB Statcast Jump glossary](https://www.mlb.com/glossary/statcast/jump)
- [MLB Statcast Arm Strength glossary](https://www.mlb.com/glossary/statcast/arm-strength)
- [Baseball Savant Fielder Positioning](https://baseballsavant.mlb.com/visuals/fielder-positioning-all)
- [MLB Statcast First Base Receiving/Scoops glossary](https://www.mlb.com/glossary/statcast/first-base-receiving-scoops) and [August 2026 Baseball Savant changelog](https://baseballsavant.mlb.com/changelog/2026-08-21-first-base-receiving-scoops)
- [Baseball Savant Catcher Blocking](https://baseballsavant.mlb.com/leaderboard/catcher-blocking), [Catcher Framing](https://baseballsavant.mlb.com/leaderboard/catcher-framing), [Pop Time](https://baseballsavant.mlb.com/leaderboard/poptime), [Catcher Throwing](https://baseballsavant.mlb.com/leaderboard/catcher-throwing), and [Catcher Stance](https://baseballsavant.mlb.com/leaderboard/catcher-stance)
- [MLB Statcast Sprint Speed glossary](https://www.mlb.com/glossary/statcast/sprint-speed), [Bolt glossary](https://www.mlb.com/glossary/statcast/bolt), and [90-foot Running Splits glossary](https://www.mlb.com/glossary/statcast/90-foot-running-splits)
- [Baseball Savant Extra Bases Taken](https://baseballsavant.mlb.com/leaderboard/baserunning), [Basestealing Run Value](https://baseballsavant.mlb.com/leaderboard/basestealing-run-value), and [combined Baserunning Run Value](https://baseballsavant.mlb.com/leaderboard/baserunning-run-value)
- [MLB Statcast Baserunning glossary](https://www.mlb.com/glossary/statcast/baserunning) and [Statcast tracking-term glossary](https://www.mlb.com/news/major-league-baseballs-statcast-glossary-of-terms-of-state-of-the-art-tracking-technology/c-118508858)
- [MLB Defensive Efficiency Ratio](https://www.mlb.com/glossary/advanced-stats/defensive-efficiency-ratio), [Range Factor](https://www.mlb.com/glossary/advanced-stats/range-factor), [Defensive Runs Saved](https://www.mlb.com/glossary/advanced-stats/defensive-runs-saved), and [Ultimate Zone Rating](https://www.mlb.com/glossary/advanced-stats/ultimate-zone-rating)
