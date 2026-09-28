# Prompt 2 — Codex: final stat expansion, display and acceptance

Recommended model: GPT-6 Astra. Reasoning: Extra High / xhigh. Run after prompt 1 has produced its backend implementation and handoff.

---

Implement the website display and end-to-end acceptance portion of our final stat expansion before the TEST season. Read `CLAUDE.md`, `docs/final-stat-expansion-audit-2026-09-16.md`, `docs/final-stat-expansion-backend-handoff.md`, and the actual updated code first. Preserve existing uncommitted work, including Claude's implementation. This is an implementation and verification assignment, not another plan.

Prompt 1 owns capture/persistence/calculation. Use its canonical events and aggregators. Independently check the contract against the producer and persisted evidence; fix narrow integration defects you find. If the handoff is absent or its required capture contract is unfinished, do useful independent UI work but identify that dependency explicitly; never fabricate completed backend support.

## Required product result

1. **A first-class Baserunning section.** Add discoverable desktop and mobile navigation to the shared Stats page for both Players (human owners) and Characters. `src/pages/SeasonStats.jsx` delegates to `Stats.jsx`; preserve season, tournament and combined scope behavior. Show runs scored using existing run events; XBT opportunities, holds, attempts, safe advances, outs, attempt rate, success per attempt and safe advances per opportunity; and breakdowns for first-to-third/second-to-home on singles, first-to-home on doubles, and each tag-up type. Include Sprint Speed, max qualifying speed, Bolts, Home-to-First, 90-ft Split and sample counts. Show modeled coverage and experimental Rbaser. Explain the distinction from experimental WAR BsR rather than forcing misleading equality. Use the backend's supported descriptive runner outcomes without inventing modeled opportunities.

2. **Actual Gimmick / Stadium Interactions statistics.** Provide per-character and per-owner counts by named type and park: e.g. barrel hits suffered, times frozen, flower sprays, POW effects, table/pipe stuns, manhole launches, Piranha/train hits, fire/bomb effects, plus ball redirects/transits/rebounds/captures and object breaks. Render only semantics supported by the final contract. Separate the actor physically affected, the actor who initiated an action, and the side credited by luck. Keep the existing Gimmick Luck view or make it a clearly separate subview; a luck touch is not a physical hit. Distinguish freeze incidence from a frozen player contacting the ball; retain unknown cause labels when Freezie attribution is unproven. Show durations where measured and distinct affected plays separately from incident counts.

3. **Useful mechanics beyond stadiums.** Surface the validated Buddy and captain-effect summaries in appropriate existing sections or a compact Mechanics section: attacks/contact/object clearing, handoffs, Buddy throws, star effects caused/suffered, and available special fielding attempt/contact/possession outcomes. Reuse official Buddy Jump credit without counting raw attempts as extra completed jumps. Keep star actions out of stadium luck and physical misplays separate from errors. Do not make a giant flat table of unrelated signals.

4. **Expose missing fielding context.** Add relevant throw/Buddy-throw counts, arm opportunities and advances allowed, OAA actual/expected outs and samples, DP run components, Jump reaction/burst/route components and samples, and positioning sample counts where the backend supports them. Counts and definitions should make the existing rate/value columns understandable. Do not invent zero-valued model results for unmodeled data.

5. **Evidence and availability.** Clicking a count should reveal the supporting game/play, actor, event type, park/time of day, and understandable evidence status; use existing detail/expand patterns. Provide compact coverage information distinguishing recorded zero, not tracked, inferred, unknown, not applicable and partially modeled. Unsupported park mechanics must not look like zero incidents. Put raw memory offsets, schema versions and detector details in technical evidence only when useful, not in normal product navigation. No unexplained confidence claims or leaderboard rankings of unmeasured data.

## Integration details

- Inspect `src/pages/Stats.jsx`, `SeasonStats.jsx`, `CharacterPage.jsx`, relevant team/profile pages and their existing data hooks, `src/utils/statsTableView.js`, `statGlossary.js`, active-version and scope helpers, `src/styles/stats-pages.css`, and the backend handoff. Reuse shared calculation logic.
- Preserve completed-game, active-session, quarantine and scope eligibility. Keep competition type in game identity; season IDs and tournament IDs can collide. Use existing paginated reads and fail visibly on unavailable authoritative data rather than showing empty successful totals.
- Aggregate rates from event-level numerators/denominators and measurements from their actual qualifying samples, not averages of player averages. Preserve null sorting, numeric sort direction, identity links, current owner/team naming conventions, filters, responsive behavior and realtime updates.
- Ensure a character with running/fielding events is not hidden merely for lacking a batting PA in the filtered sample. Attribute historical stats to the recorded owner, including roster changes.
- Add consistent glossary definitions, units, sample qualifiers and experimental-value labels. Existing XBT% is attempt rate; migrate labels deliberately rather than silently changing its meaning.
- Wire concise baserunning/mechanics summaries into existing character/team stat detail surfaces where applicable; avoid duplicating whole page layouts or adding unused fetches. Reuse the canonical aggregates so details reconcile with leaderboards.
- Check any existing exports for the same definitions if those exports consume the changed stat tables. Do not build a new export system or modify the separate public standalone tracker.
- Preserve current league exclusions: steals, caught stealing, pickoffs, catcher framing/blocking/throwing and receiving value are not part of this expansion.

## Acceptance work

Use existing test and browser infrastructure. Add focused checks that exercise user-visible behavior and real aggregation, including:

- Player/Character views; season, tournament and combined scopes; regular/postseason semantics consistent with existing filters; same numeric IDs across competition types; roster changes.
- A runner hold, safe extra base, extra-base out and tag-up; third-out animation and doubled-off exclusions; partial/no model coverage; zero-attempt denominators; measured versus missing speed/time.
- A barrel hit and near miss; a freeze without ball contact; a freeze plus ball rebound; manhole-water aliases; two victims on one play; repeated hits on one actor; unknown identity/cause; star effect versus stadium hazard; intentional object clearing; direct versus inferred evidence.
- Count/evidence reconciliation, distinct plays versus events, no double counting of Buddy events, no sum-of-both-luck-sides physical totals.
- Refresh after correction/undo/delete, late identity resolution, re-ingestion and session replacement; quarantined and inactive data excluded; legacy/manual-only games still render honestly.
- Desktop and narrow mobile navigation/tables; numeric and null sorting; loading/read errors; preserved links and active filters.

Run the relevant focused tests, `npm run build`, and the existing acceptance checks appropriate to the touched paths. A passing mock/UI test does not prove live capture or database migration deployment. Trace the backend's real fixtures through persisted representation, scope/aggregation and rendered output. If emulator access or deployment is unavailable, report that exact limit without marking the live check passed.

Finish by creating `docs/final-stat-expansion-acceptance.md` with implemented sections, test/browser evidence, count reconciliation examples, schema/deployment status, the final nine-park capability matrix, and a short TEST-season checklist. Explicitly state whether the requested barrel-hit and freeze cases were proven from real capture, which mechanics remain unsupported, and whether any capture-changing work must happen before game one. Preserve the existing calibration completeness gate; an attractive table does not establish detector completeness.

Complete all authorized implementation and local verification. Report genuine missing inputs with the precise action needed, rather than repeatedly asking whether to continue.
