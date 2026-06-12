# Season Mode Overhaul — Implementation Plan Index

Source: full manual QA pass on Season Mode (2026-06-11). This plan is split into
6 themed batches, meant to be handed off and executed independently in separate
conversations. Each batch file is self-contained: it restates the relevant bug
reports/notes verbatim from QA, then lists concrete action items.

## Suggested execution order

1. **[01-auth-access-mobile-nav.md](01-auth-access-mobile-nav.md)** — Auth flows, logged-out access control, global nav/sidebar, and the modal/popup scroll pattern. Do this first: several other batches depend on the scrollable-modal pattern established here.
2. **[02-season-setup-admin.md](02-season-setup-admin.md)** — Season creation validation, new league settings (innings, mercy rule, edit-mid-season), home/away schedule balancing algorithm, single-elim bracket generation bug.
3. **[03-roster-trades-waivers.md](03-roster-trades-waivers.md)** — Remove bench/inactive concepts, fix waiver schema bug, trade UI/flow cleanup, mobile roster formatting.
4. **[04-scorebook-core-reliability.md](04-scorebook-core-reliability.md)** — THE BIG ONE. Home/away source of truth, game-over/inning logic, runner tracking bugs, new scorebook Admin tab, DP/TP auto-detection, error handling, fielding stat capture, Mii color removal, draft 9th-player safeguard.
5. **[05-betting-sportsbook-rewrite.md](05-betting-sportsbook-rewrite.md)** — Full odds engine rewrite: house edge/vig, volume-based line movement, liability caps, arbitrage-proofing, settlement timing fixes, UI fixes.
6. **[06-playoffs-bracket-stats.md](06-playoffs-bracket-stats.md)** — Playoffs auto-transition, new "Playoffs" tab in Schedule, tiebreakers, bracket fixes, stats page fixes (fielding stats display, runs scored/allowed, advanced stat fallbacks), final mobile sweep.

## Cross-batch dependencies

- Batch 1's scrollable-modal/popup fix pattern should be reused by batches 2, 3, 4, 5, 6 wherever they touch a popup/modal.
- Batch 2's mercy rule + regulation innings settings must land before re-testing mercy rule / bottom-of-final-inning logic in batch 4.
- Batch 4's home/away source-of-truth fix must land before batch 5 (betting displays home/away) and batch 6 (bracket/playoffs displays home/away).
- Batch 4's fielding-stat *capture* fixes must land before batch 6's fielding-stat *display* fixes.
- Batch 6's Playoffs tab reuses `SeasonGameSessionProvider`'s playoff `stage` scoping — confirm batch 4's scorebook reliability fixes apply equally to playoff-stage games.

## Cross-cutting themes (apply throughout, not just their "home" batch)

- **Mobile usability/scrollability**: every batch below has mobile-specific items. Treat each one as part of that batch, not deferred — but do a final dedicated mobile sweep in batch 6 after all functional work lands.
- **Logged-out access control**: batch 1 covers the known list, but while working on batches 2-6, double-check any new/changed page also respects logged-out visibility rules (no protected controls visible, no protected pages reachable).
- **Home/away consistency**: once batch 4 establishes the single source of truth (`season_schedule.home_team_id` / `away_team_id`, home team always rendered on the bottom of a game card), every other batch that renders a game card/matchup must follow it.
