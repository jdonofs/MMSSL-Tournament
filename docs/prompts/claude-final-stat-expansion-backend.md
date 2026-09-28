# Prompt 1 — Claude: final stat expansion, capture and backend

Recommended model: Claude Opus 5. Effort: Extra High / xhigh. Run this before the Codex display prompt, in the Sluggers repository.

---

Implement the capture, persistence, and calculation portion of our final stat expansion before the TEST season. Read `CLAUDE.md`, `docs/final-stat-expansion-audit-2026-09-16.md`, and relevant implementation first. Preserve all existing uncommitted work. The audit is the starting evidence, not a substitute for checking current code. This is an implementation assignment, not another proposal.

The user needs complete baserunning visibility and actual per-character/per-owner counts of stadium incidents such as barrel hits and freezes, plus other useful captured stats currently lost before they reach the website. A second prompt will implement the UI after your contract is stable. Own the backend and provide that handoff; make necessary existing-consumer compatibility fixes, but leave the new stats layouts to prompt 2.

## Scope and existing paths

Inspect at least:

- `scripts/collect_player_tracking.py`, `scripts/player_tracking_io.py`, `scripts/derive_player_metrics.py`, `scripts/player_live_derivation.py`.
- `scripts/ingest_player_tracking.mjs`, `scripts/live_tracker_bridge.mjs`, `scripts/tracker_runner_telemetry.mjs`, existing correction/version/reconciliation helpers.
- `src/utils/gimmickLuck.js`, `src/utils/advancedDefense.js`, `src/utils/runnerAssignment.js`, `src/utils/runnerOpportunityPersistence.js`, `src/utils/activeTrackingVersions.js`, `src/utils/experimentalWar.js`.
- `scripts/recompute_advanced_metrics.mjs`, `scripts/review_stadium_events.mjs`, `scripts/next_calibration_game.mjs`.
- Existing tracker migrations and tests, `docs/baserunning-assignment-wiring.md`, `docs/tracker-validation-console.md`, and the final-expansion audit.

Target the root league website/tracker. `public-tracker-release/` is a separate standalone product that deliberately excludes stadium hazards; do not add stadium detection to it or rebuild its binaries as part of this task.

## Required implementation

1. **Finish the baserunning contract.** Reuse runner assignments/opportunities and movement measurements. Expose opportunities, attempts, holds, advances, outs, modeled coverage, and the six existing single/double/tag-up splits. Distinguish attempt rate, success per attempt, and safe advances per opportunity. Preserve competitive-run qualification, speed/time units, and sample counts. Keep unmodeled values null. Document Rbaser versus WAR BsR (which also includes double-play avoidance) and reconcile model inputs/cohorts where equivalent values are expected. Audit other runner outcomes, including batter stretching, errors, and doubled-off outs, but do not manufacture XBT opportunities from incomplete assignments. Reuse existing scoring run events.

2. **Persist descriptive incidents independently of luck.** Extend the existing tracking evidence path with a versioned, canonical event contract and pure aggregators. Prefer existing JSON persistence unless a separate table has a demonstrated need. Keep physical incident counts, actor involvements, distinct plays, durations, ball interactions, intentional actions and luck points distinct. The victim must be the character actually affected; beneficiary/unlucky fields are not a victim counter. Preserve unknown causes/actors without inventing IDs or silently losing their existence.

3. **Fix the confirmed integration gaps.** The deriver produces `manhole_water`, while the adapter accepts `manhole`. Raw `freezes` are ignored, while frozen-fielder ball contacts are normalized: implement separate freeze incidents and durations. Explicitly verify Freezie causation instead of assuming every generic flag proves it. The archive inspected on 2026-09-16 has no barrel events and 24 unnamed DK knockdowns: trace barrel capture/interpretation and provide real evidence for a hit and near miss; do not rename generic DK knockdowns by elimination. Investigate `name_star_swing_knockdowns`, which appears to read hit/by at the wrong level of nested barrel events. Use actual producer output shape in tests.

4. **Preserve evidence quality.** Fence-band train inference, old barrel distance fallback, direct object contacts, unknown freezes, and verified causal events must not become indistinguishable “confirmed hits.” Preserve source, confidence/status, detector capability/version, park, day/night/unknown, frame/time, affected actor and duration. Handle continuous effects, repeated hits on the same actor, simultaneous victims, object break plus contact, and duplicate evidence channels without overcounting. Do not invent a shared activation ID where the data only proves individual effects.

5. **Cover the full park inventory.** Reconcile every row of the nine-park matrix in the audit with current detectors and annotations. Wire validated emitted types, correct stale aliases/registry claims, and retain unresolved evidence. Specifically account for barrels/flowers/POW, freezes/Freezie collisions-breaks-rebounds, tables and night ship mechanics, arrows/manholes, pipes/Piranhas/trains, castle fire/bombs/blocks, Playroom objects, and Mansion ghost/grass mechanics. Respect measured park/time-of-day constraints and Mario Stadium negative controls. Unsupported mechanics need an explicit status and exact missing signal or labeled capture, never fabricated zeros. Preserve the existing calibration completeness gate; do not claim it passed because counters exist.

6. **Close adjacent useful data gaps.** Preserve and aggregate validated Buddy attacks/contact/object clears/handoffs, Buddy throw counts, captain star effects caused/suffered, and useful fielding attempt/contact/possession/mechanic summaries. Retain unknown special actions as unknown. Reuse already recorded official Buddy Jump credits; do not double-count them with raw attempt records. Expose existing fielding counts/components (throw/arm/opportunity samples, advances allowed, actual/expected outs, DP runs, Jump components and positioning coverage). Keep star actions and intentional object clears separate from stadium luck, and physical bobbles separate from official errors. Avoid new speculative value models.

7. **Make the whole persistence lifecycle work.** Wire shared live and postgame derivation plus root preview/bridge/replay/ingestion paths where relevant. Preserve raw evidence needed for future re-derivation and keep preview/replay free of Supabase writes. Use the existing lease, version activation, reconciliation and correction conventions. Event IDs and totals must be stable across retries, late joins/identity resolution, re-ingestion, session replacement, PA corrections, undo/redo and deletion. Check stale result-derived luck after edits. Reject quarantined/inactive evidence from official aggregates under a documented policy. Resolve ownership at game time and keep tracker IDs distinct from DB IDs; missing resolution must not fall back to the pitcher or raw game ID. Handle season/tournament game-ID collisions and pagination.

8. **Preserve historical compatibility.** Missing events/capabilities in old or manual-only games mean unavailable, not observed zero. Add schema changes only if needed and test real migrations using the existing PostgreSQL/PGlite approach. The repository is not a complete production schema: identify unverifiable assumptions. Provide an idempotent, reviewable dry-run/re-derivation/backfill procedure if required; do not silently execute production backfills or overwrite raw captures. Ordinary scoped implementation and local tests should proceed without repeated confirmation requests.

Existing league rules exclude stealing, caught stealing, pickoffs, catcher framing/blocking/throwing, and first-base receiving value. Do not build these. Do not redesign WAR or recalibrate unrelated models to pad this expansion.

## Verification and handoff

Extend focused existing tests with producer-shaped and real-archive fixtures. Cover manhole alias loss, freeze versus frozen-ball-contact counts, barrel/star overlap, repeated/simultaneous incidents, confidence status, intentional actions, unresolved identities, quarantine, zero versus missing, denominator math, and version/correction idempotency.

Run the checks in `CLAUDE.md` appropriate to changed paths: tracker/defense/metrics/scorebook tests as affected; persistence tests for Supabase paths; database tests for migrations/invariants; acceptance tests for the complete pipeline; Python metric verification and attribute-based speed verification if derivation changes. Build if JS/client contracts change. Inspect failures and fix regressions; state pre-existing failures with evidence. Use the exact working commands in your report.

Create `docs/final-stat-expansion-backend-handoff.md` containing the final event schemas, aggregator interfaces and field meanings, count/coverage definitions, files changed, schema/deployment requirements, version/backfill behavior, fixtures/test results, and park-by-park supported/partial/unsupported status. List the exact barrel/freeze and other live checks actually performed versus still required. Do all work possible from the available archive before requesting a new capture; for a genuine capture blocker, provide the precise park, day/night, trigger, negative control, and missing signal. Do not claim full TEST-season readiness while required capture checks remain unverified.

The Codex prompt must be able to consume your handoff and implement the UI without reverse-engineering your choices.
