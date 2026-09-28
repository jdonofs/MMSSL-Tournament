# Final stat expansion before the TEST season

Audit date: 2026-09-16. This is a plan and implementation handoff, not an implemented expansion or a certification of the live database.

## Recommendation

Run the Claude backend prompt first, then the Codex display/validation prompt. The two stages share event definitions and should not be implemented independently against different contracts.

1. [Claude: capture, persistence, and calculations](prompts/claude-final-stat-expansion-backend.md) — Claude Opus 5, **Extra High / xhigh** effort.
2. [Codex: stats display and acceptance](prompts/codex-final-stat-expansion-display.md) — GPT-6 Astra, **Extra High / xhigh** reasoning.

These are task-specific recommendations, not a measured comparison between the models. Anthropic recommends stepping Opus 5 up to xhigh for demanding coding work ([effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort)). OpenAI recommends Astra for difficult end-to-end work and documents its Extra High option ([model documentation](https://learn.chatgpt.com/docs/models)). Availability depends on the account/client; verify the picker before starting.

## What was inspected

- The shared season/tournament Stats page, calculators, glossary, character page, runner assignment/persistence code, tracking ingestion, active-version filtering, model recomputation, and existing tests.
- The Python capture/derivation pipeline, stadium review registry, local annotation inventory, and **50 `.plays.jsonl` files containing 3,940 play records**.
- No production writes, ingestion, backfill, game launch, deployment, or application-code changes were performed. No live database query was made. The repository is already heavily modified; preserve that work.
- Archive counts below are raw local record counts, not deduplicated official season statistics. Files differ in capture generation, park, time of day, annotation coverage, and calibration status.

## 1. Baserunning: partly implemented, poorly surfaced

`src/pages/SeasonStats.jsx` renders `Stats`, so one shared UI change reaches both routes. `Stats.jsx` already loads `runner_opportunities` and `movement_metrics`. Its batting tables define Sprint Speed, Bolts, Home-to-First, 90-ft Split, XBT Opp, XBT%, XBT Safe%, XBT Outs, and Rbaser (around lines 2902–2910 and 3039–3047). There is **no dedicated baserunning navigation section**. This is a display/discoverability gap plus missing detail, not an empty backend.

`src/utils/advancedDefense.js` implements the following opportunity types:

| Opportunity | Current capture/calculation | Expansion |
|---|---|---|
| First to third on a single | Assignment-derived opportunity | Show separate opportunities, holds, attempts, safe advances, outs, and rates |
| Second to home on a single | Assignment-derived opportunity | Same |
| First to home on a double | Assignment-derived opportunity | Same |
| Tag first to second | Assignment-derived opportunity | Separate tag-up breakdown |
| Tag second to third | Assignment-derived opportunity | Same |
| Tag third to home | Assignment-derived opportunity | Same |
| Batter stretching a hit, advances on errors/other plays, doubled-off runners | Not covered by those six XBT types | Audit descriptive outcome coverage separately; do not silently count them as modeled XBT opportunities |

`summarizeAdvancedBaserunning` already computes attempts, holds, advances, and modeledOpportunities, but the stats columns do not expose them. `summarizeMovementMetrics` also returns maximum speed and speed/home-to-first sample counts that are not displayed.

Required baserunning view:

- **Results:** runs scored from the existing run-event source; XBT opportunities, attempts, holds, safe advances, and outs; the six opportunity splits above.
- **Rates:** attempts/opportunities, safe advances/attempts, and safe advances/opportunities as distinct, clearly named metrics. Existing `XBT%` means attempt rate, not success rate; preserve or explicitly migrate that definition.
- **Movement:** Sprint Speed, maximum qualifying speed, Bolts, Home-to-First, 90-ft Split, and the relevant sample counts. Preserve the existing competitive-run qualification and unit conventions.
- **Value:** modeled opportunity count/coverage and experimental Rbaser. Expected attempt/success probabilities already exist on modeled rows; expose useful comparisons only with their denominators and experimental label.
- **Evidence:** game/play details showing runner identity, origin, target, hold/safe/out result, and measurement availability.

Preserve existing exclusions: incomplete assignments, unidentifiable runners, third-out animation advances, doubled-off runners mistaken for tag attempts, forced advances mistaken for discretionary attempts, and outs without known attempted targets. Historical missing measurements must not become zero-valued observations.

The current model is a context-bucket model with shrinkage, not a fully calibrated geometry-based Statcast model. Also distinguish **Rbaser** (extra-base run value) from experimental WAR **BsR**, which includes double-play avoidance. `experimentalWar.js` models runners on demand while `recompute_advanced_metrics.mjs` persists model outputs using run expectancy; verify their inputs and definitions before claiming equal totals.

**League rules:** the existing fielding/baserunning plan explicitly excludes steals, caught stealing, pickoffs, catcher framing/blocking/throwing, and first-base receiving skill. Do not add those merely because the upstream standalone tracker contains steal counters. See `docs/fielding-baserunning-advanced-metrics-plan.md:13` and `docs/baserunning-assignment-wiring.md`.

## 2. Gimmicks: actual incidents need their own accounting

Current flow:

`collect_player_tracking.py` → `player_tracking_io.py` → shared `PlayDeriver` → live/postgame play evidence → `ingest_player_tracking.mjs` → `tracking_plays.quality.gimmick_events` → `summarizeGimmickLuck` → Stats.

`src/utils/gimmickLuck.js` converts selected raw arrays into beneficiary/unlucky events. The summary keeps luck points, total touches, affected plays, and a set of labels. It does **not** retain a per-type frequency table. A luck beneficiary is not the character physically hit, and a redirected ball has no necessary victim. Counts must preserve that distinction.

### Concrete failures and limitations

| Finding | Evidence | Required work |
|---|---|---|
| Freeze incidents are not normalized | Archive has **116 `freezes`**, all in Peach Ice Garden; adapter ignores this array. It reads **13 `frozen_fielder_ball_contacts`** instead. | Store freeze onsets/durations and affected actors. Count “times frozen” separately from ball contact while frozen. Attribute a Freezie cause only when supported. |
| Manhole knockdowns are silently dropped | Deriver writes `hazard: 'manhole_water'` (`derive_player_metrics.py:2136`); adapter whitelist accepts `'manhole'`. All **19** archived manhole knockdowns disappear when passed through the adapter. | Canonical alias mapping with producer-shaped regression fixtures. |
| Barrel support is not demonstrated by the archive | `detect_barrel_events` and adapter support exist, but all 50 derived files have empty/missing barrel events. DK files have **24 unnamed knockdowns**. `player_tracking_io.py` documents an all-zero barrel address in one capture. | Verify the active capture address/objects and a real hit plus near-miss control. Do not rename those 24 knockdowns “barrels” by park alone. |
| Barrel/star exclusion appears to read the wrong structure | `name_star_swing_knockdowns` reads `event.by`/`event.hit` from `barrel_events`; detector puts these in `barrel_events[].approaches[]`. | Reproduce with a producer-shaped fixture, then correct if confirmed; prevent dual attribution to a star swing and barrel. |
| “Confirmed” currently includes different evidence strengths | Of **79** normalized train knockdowns, **56** raw records use `hazard_source: 'fence_band'` and **23** use `'train_position'`. Adapter does not separate these. Barrel normalization also accepts `distance_fallback`. | Preserve observed/inferred/unknown evidence status and make count eligibility explicit. A named output alone is not proof of causation. |
| Intentional object clearing is lost to the site | Archive has **13 Freezie breaks**, but only **4 batted-ball breaks** enter luck; throws/Buddy actions are intentionally excluded. **13 table breaks** are also not included in the current archive's luck output. | Keep all supported break events in descriptive mechanics stats, separating cause/actor; only the existing eligible subset belongs in luck. |
| Identity and correction risks need tests | Events contain stored beneficiary/unlucky identities and result-derived luck. `mergeIdentity` has raw-ID/fallback paths; the ingester normally resolves names/IDs. | Missing resolvers must not turn game IDs into database IDs or assign an unknown victim to the pitcher. Edits/deletes and version replacement must refresh or invalidate derived attribution. |
| Quarantine handling differs between summaries | Movement/arm summaries explicitly reject quarantined evidence; gimmick summary does not. Stats' completed-game/active-version filtering does not itself exclude quarantined plays. | Establish one consistent eligibility policy for official totals; retain rejected evidence for diagnostics. |

Use separate concepts: **physical incident**, **actor involvement**, **distinct affected play**, **duration**, **ball/object interaction**, and **luck point**. One POW affecting three fielders is one activation with three affected actors if the capture proves the shared activation; never guess a shared activation just from proximity in time. A freeze followed by a rebound is one freeze plus a separate ball interaction, not two freezes.

### Complete park inventory to reconcile

This inventory comes from the repository's stadium review registry and current derivation, not a claim that every detector is validated. The review registry is stale in places: it says no detector for some mechanics that now appear in derived arrays. Reconcile it with the implementation and labeled captures.

| Park | Existing derived families / evidence | Remaining verification or capture gap |
|---|---|---|
| Mario Stadium | No stadium gimmicks expected | Negative control; must not inherit other parks' memory interpretations |
| DK Jungle | Barrel pipeline; flower sprays (21 archive records); night POW stuns (3) | Actual barrel hit capture, flaming/day-night distinction only if measured; root slowdown currently has no effect evidence and is treated as pathing |
| Peach Ice Garden | Freezes (116), frozen-fielder ball contacts (13), Freezie rebounds (4), breaks (13) | Freeze cause vs observed effect; collision/near-miss evidence; night blackout/spotlight |
| Daisy Cruiser | Table ball contacts (14), table stuns (8), table breaks (13) | Night Cheep Cheep and Gooper Blooper tilt; day/night coverage |
| Wario City | Arrow redirects (37), manhole knockdowns (19), manhole ball strike (1) | Fix manhole alias, validate day/night behavior and negative controls |
| Yoshi Park | Pipe transits (5), pipe stuns (4), Piranha knockdowns (3), train knockdowns (79), train ball hits (6), train captures (1) | Separate direct object evidence from fence-band inference; distinguish ball transport, player hits, and train-capture HR |
| Bowser Castle | 13 fire-hazard records, of which 12 survive current normalization; Bob-omb knockdowns (14) | Audit discarded fire record and causal confidence; reconcile Podoboo/falling lava, statue fire, puddles, Thwomp blocks, and King Bob-omb registry |
| Bowser Jr. Playroom | 16 unnamed knockdowns in archive | Thwomp impacts/breaks, Chain Chomp spawn/hit, Bullet Bill spawn/hit lack demonstrated specific attribution |
| Luigi's Mansion | Generic impact-stun evidence; review registry names a possible ghost signal | Gravestone hit/ghost attack and tall-grass concealment have no demonstrated named stats path |

Every supported hazard should have per-character and per-owner **times affected**, plus park/type breakdowns and an evidence drilldown. Ball interactions belong to the ball/play and optionally the identified initiator, not an invented fielder victim. Unknown actor/cause records should remain visible in coverage diagnostics. Park and day/night exposure denominators require real capture metadata, including an explicit unknown state for old files.

The existing `docs/tracker-validation-console.md` completeness gate remains closed, and `node scripts/review_stadium_events.mjs` still reports it closed. Current Gimmick Luck already coexists with that unresolved gate. Neither this audit nor an expanded table opens it. Label partial coverage and unresolved causes honestly; do not claim all parks are complete based on synthetic tests.

## 3. Additional gaps beyond the requested categories

| Family | Current state | Recommended inclusion |
|---|---|---|
| Fielding denominators/components | Summary calculates throws, Buddy throws, arm opportunities/advances, actual/expected outs, DP runs, positioning samples; many are absent from columns | Add relevant counts/coverage beside Arm Strength, OAA, FRV, DP Added, and positioning. Do not render unmodeled components as measured zero. |
| Jump components | Movement summary returns reaction, burst, route efficiency, and samples; fielding table primarily shows total Jump | Expose components and samples in an advanced fielding view if supported by the same valid rows. |
| Buddy actions | 538 attacks, 366 handoffs, 54 jump records in archive; official BJ credits already displayed; Buddy throws already stored and max speed displayed | Preserve attempts, successful contact, object clearing, handoffs, and throw counts separately. Do not double-count a single Buddy Jump through raw and official credit paths. |
| Captain star effects | 48 non-knockdown star effects plus 38 star-swing knockdowns locally; batting/pitching Star usage already exists | Add effects caused/suffered by named type, victim counts, and supported durations. Keep star actions out of stadium luck. |
| Fielding mechanics | 7,371 catch-approach records, 44 forced misplays, raw dives/leaps/fielding events; some deflections/forced misplays already persisted | Preserve useful attempt/contact/possession/mechanic summaries; distinguish physical bobble from official error. Only name abilities the detector resolves. |
| Movement detail | Paths, reaction, route efficiency and five-foot splits already persisted; contact lead exists in raw runner records but not a dedicated ingested field | Keep as evidence/model inputs; optional detailed view. No standalone lead leaderboard under current rules. |
| Other play diagnostics | 14 close-play records and 4,524 possession carries locally; not dedicated league stats | Preserve in play evidence where useful. Do not invent success rates or new modeled value from incomplete samples. |
| Coverage and historical compatibility | Active versions and completed-game filtering exist; provenance/capability denominators are not uniformly shown | Required: measured zero vs missing vs inferred vs not applicable; tracked/eligible samples, unresolved identities, per-type availability, and model version/status. |

Do not turn this into a new WAR formula, catch-probability research project, pitch metric overhaul, or dashboard for every memory field. Existing batting/pitching/contact/expected/Star sections already cover those broad families. The valuable remaining work is descriptive mechanics, baserunning visibility, missing denominators, and trustworthy persistence.

## 4. Data contract requirements

- Prefer the existing versioned tracking-play JSON/evidence path for incident arrays unless querying or integrity requirements justify a table. Do not preselect a new table merely because counts are new.
- Stable event/incident identity scoped to competition, game, session version, play and occurrence; canonical type and aliases; actor roles (victim, initiator, partner) distinct from beneficiary/unlucky roles.
- Database character ID and game/tracker ID must stay separate. Resolve owner/team at game time; current roster changes must not rewrite historical credit.
- Preserve park, day/night/unknown, absolute frame or documented relative time, onset/end/duration where captured, source/evidence strength, cause classification, detector/schema version, and unresolved status.
- Define which event types were actually supported by each capture. Empty arrays in an old capture do not establish a measured zero.
- Aggregate from authoritative facts with completed-game and active-session selection, pagination, quarantine policy, and competition-scoped IDs. Never sum two sides' luck touches as the number of physical events.
- Corrections, undo/redo, PA deletion, retries, session replacement and late identity resolution must be idempotent and preserve manual corrections. Do not backfill from guessed narrative or overwrite existing raw archives during routine UI work.
- Reuse denominators and event IDs across the leaderboard, character/team pages, play evidence and any existing exports. Audit dependencies before claiming those consumers are wired.
- `public-tracker-release/README.md` explicitly states that its standalone build has **no stadium-specific measurement**. That release is a separate product; this handoff targets the root league app/pipeline.

## 5. TEST-season readiness

Before treating the season as a complete validation of this expansion:

1. Capture requirements and event schema are installed before the first game; raw capture, park/time-of-day metadata, and version information survive restart and ingestion.
2. A measured DK barrel hit and a near miss, plus a freeze incident distinct from a frozen-player rebound, are traced from capture to correct character/owner totals. The current archive does not establish the barrel case.
3. Runner hold/safe/out/tag-up examples reconcile to their assignments and to the new baserunning view, with third-out and doubled-off exclusions intact.
4. All nine parks have an explicit supported/partial/unsupported status. Unresolved families have a precise missing signal/capture requirement; they do not silently display zero.
5. Re-ingestion, active-version replacement, edits, undo/delete and season/tournament/combined scope checks preserve totals and attribution. Manual-only/legacy games remain usable with missing advanced evidence.
6. The shared page works on desktop and mobile; event evidence explains the displayed counts and model coverage.
7. The final handoff distinguishes locally tested readiness, migrations actually applied, and live-capture checks still pending. Unit tests alone cannot certify emulator capture or production schema.

## Validation performed during this audit

- Passed **36 existing tests** using: `node --test --test-reporter=dot tests/gimmick-luck.test.mjs tests/advanced-defense.test.mjs tests/runner-assignment-persistence.test.mjs tests/stats-table-view.test.mjs`.
- Ran `node scripts/review_stadium_events.mjs`; completeness gate remains closed.
- Read all 50 local derived play files and passed their records through the actual `buildGimmickEvents` adapter, reproducing the 19 dropped manhole records and the distinction between freeze incidents and frozen-player ball contacts.
- No application code changed, so no production build or broad regression suite was needed for this planning-only task.
