# Opus: one workflow/data smoke pass of the existing site

Read `CLAUDE.md`, `docs/msl-optional-smoke-2026-09-29.md`, and the current verdict in `docs/msl-game-readiness-2026-09-28.md`. The user requested this optional follow-up after pushing the tested candidate and successfully playing a real test game. Execute checklist **O1–O5 only**. Do not restart the completed release review or invent another readiness backlog.

Verify a small set of real user actions through persistence and reload: a saved lineup, one pickup/trade scenario, a synthetic bet and retry, existing completion/correction evidence, and season settings/backup behavior. Use the actual page/service code with local/intercepted responses or the existing PGlite fixtures as appropriate. Assert the state after the action and reload, not just that a promise resolved. Use one representative failure per specified workflow; this is not an exhaustive combinatorial audit.

Relevant existing code/evidence:

- `src/pages/SeasonRoster.jsx`, `src/utils/seasonFreeAgentPickup.js`, existing lineup services; `tests/team-lineups.test.mjs`, `tests/season-free-agent-pickup.test.mjs` and their local database fixtures.
- `tests/browser/bettingUiWorld.mjs`, `tests/betting-ui.test.mjs`, betting-system and tracker-integration tests. Most money/retry cases already have passing evidence; reuse it where it answers O3.
- Your completion/recovery suites and `tests/game-completion-recovery-browser.mjs`, plus acceptance and at-bat correction. The release check already passed; O4 can close by confirming candidate/evidence applicability, without replaying every test or changing the design.
- `src/pages/Admin.jsx`: `handleBackup`, the season settings editor and `handleSeasonSaved`. Review their actual query/write scope before exercising them. A backed-up data set must not silently lose a failed required table. Do not execute Delete/Recompute/Award against real data.

Start without real credentials. Use existing fixtures with synthetic season/game/player identities and capture all mutations, realtime and launcher traffic before browser navigation. A live TEST season does not isolate global admin data. The production database, league balances, official games, schema and installed tracker are outside the mutation scope of this assignment. Read-only live validation is optional only if existing access and inspected behavior make it genuinely read-only; label limitations rather than asking for credentials that local cases do not need.

Sol owns S1–S6 and page/component presentation/routing/CSS changes. You own domain/persistence utilities and services, plus isolated workflow regressions. Do not edit Sol's page files (including Admin/SeasonRoster) concurrently. If you prove a page-handler defect, document the precise failure and required minimal change for that owner while completing independent rows. Keep scratch fixtures/scripts separate; do not modify shared helpers gratuitously. Preserve the untracked `public-tracker-release/` directory and existing readiness documentation changes.

If a local fake cannot establish a database guarantee, use the relevant existing PGlite test where practical or state the limit; never equate a canned successful RPC response with atomicity. Do not create a broad new database baseline just to label a row passed. Prior verified production schema/policy evidence can be cited without repeating catalog audits.

A small scratch script extending the existing tooling is authorized by this testing request; use `tmp/msl-optional-smoke-20260929/opus/`. Fix only demonstrated functional defects in your owned code. Preserve scoring rules, payout semantics and identities. No feature expansion, new dependencies/framework, speculative race hardening or deployment. If no bug appears, product code stays unchanged.

Verify any fix with the failing scenario and appropriate existing tests. For changed Supabase persistence run the relevant persistence checks; for actual changed database enforcement also run the database checks. Run `npm.cmd run build` if product code changes. Do not run every existing suite repeatedly or require another physical game without new evidence.

Write `docs/msl-optional-smoke-opus-2026-09-29.md`: one result/evidence entry per O1–O5, each finding's exact action, expected/actual persisted state, cause, fix and regression outcome. Distinguish fixture behavior from production guarantees, and note any Sol-owned fix needed. End with **No new session blocker found; pass complete**, or the exact remaining material defect. Once the rows are accounted for, stop. A no-change result is successful; do not generate another task list.
