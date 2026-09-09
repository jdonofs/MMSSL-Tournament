# Scorebook refactor baseline

Recorded 2026-08-31 on `main` at `33fd939` before the first structural extraction.

## Working-tree safety

The repository was already heavily modified and included both tracked and untracked work. In particular, `src/pages/Scorebook.jsx` already had 346 inserted and 76 deleted lines relative to `HEAD`. Other user-owned work includes tracker scripts and components, stat utilities, provider changes, calibration assets, migrations, generated logs/workbooks, executables, and research/QA data.

All of that pre-existing work is out of scope for cleanup and must be preserved. No reset, broad formatting, generated-file deletion, migration edit, or repository-hygiene deletion is part of the initial Scorebook refactor.

## Baseline verification

All requested checks passed before any refactor edit:

| Command | Result |
| --- | --- |
| `npm run build` | Pass; Vite production build, 1,837 modules |
| `npm run test:betting` | Pass; 22 tests |
| `npm run test:tracker` | Pass; 370 tests |
| `npm run test:defense` | Pass; 14 tests |
| `npm run test:metrics` | Pass; 4 tests |

There were no pre-existing failures in the requested matrix.

## Current Scorebook shape

At the first extraction boundary, `src/pages/Scorebook.jsx` had 9,139 lines, 72 `useState` calls, 42 effects plus 2 layout effects, 89 callbacks, 71 memos, 79 direct `supabase.from(...)` calls, and 476 inline `style={{...}}` objects. Its main component begins around line 1,638; component-local orchestration and rendering still occupy most of the file.

Responsibilities currently grouped in the page:

- session selection and tournament/season source-table mapping through `GameSessionContext`
- initial data hydration, selected-game refreshes, and realtime subscriptions
- live-state publication, comparison, local storage, and reload restoration
- lineup drafts, ordering, fielding assignments, and pitcher changes
- pitch count/actions, star pitch/hit state, in-play selection, and runner resolution
- plate-appearance, pitch, run, inning-score, and pitching-stint persistence
- odds generation/update and bet settlement/reopening
- undo/redo, corrections, inning transitions, game reset, completion, and reopening
- tracker source selection, tracker team mapping, tracker final result, and live preview
- scorekeeper, spectator, game, lineups, admin, tracker, and at-bat-editor views
- stadium selection/editing, game video, add-game flow, and all confirmation modals
- score/line-score, batting/pitching summaries, scoring-play descriptions, and win probability

The lazy imports for `AtBatEditor` and `TrackerLivePreview` are explicit boundaries and must remain lazy throughout the refactor.

## Data-source compatibility

The page receives a table map rather than choosing one set of tables globally. Tournament games use `games`, `lineups`, `plate_appearances`, `pitching_stints`, `pitches`, `game_fielders`, `runs_scored`, `inning_scores`, and tournament betting/tracker tables. Season games use the corresponding `season_*` tables, with `season_schedule` as the game table. Season writes also require source metadata supplied by the session context.

Every extracted persistence operation must continue accepting that table/source configuration. A tournament-only hard-coded table in a shared workflow is a compatibility regression.

## Existing characterization seams

The new `npm run test:scorebook` command runs the focused Node suites that already characterize:

- authoritative game pitch numbering, including a mid-PA pitching change
- forced-runner chains and inning-ending force-play run nullification
- runner destination serialization/hydration and correct scoring-runner identity
- reusable lineup eligibility and lineup reconciliation
- active season pitcher resolution and tournament game-specific pitcher keys
- live-state normalization, runner/undo history, active pitch/star state, and reload comparison

## Highest-risk gaps

The following remain weakly protected and should receive characterization tests as their pure seams are made explicit:

1. plate-appearance payload construction plus the ordered PA/pitch/run write and rollback sequence
2. persistent undo/redo restoration of PA, pitch, run, runner, inning, and pitching-stint state
3. inning transitions, walk-off/final-inning rules, and inning-score synchronization
4. completion, reopening, and reset coordination across games, pitching decisions, stadium logs, brackets/playoffs, odds, bets, and ledger rows
5. end-to-end tournament versus season table selection and required source fields for every write
6. realtime hydration deferral and conflict handling during local writes
7. manual versus tracker-fed game switching, tracker team mapping, and final-result application
8. spectator/scorekeeper/admin/lineup rendering and navigation guards
9. lineup/fielding changes that also trigger the correct live pitcher and odds updates

UI/E2E coverage should be reserved for the view-mode and cross-system workflows that cannot be protected through extracted pure logic or a fake persistence client.

## Extraction ledger

| Stage | Change | Verification |
| --- | --- | --- |
| Baseline | Recorded the dirty worktree, source-table compatibility, lazy boundaries, responsibility map, and pre-edit verification results | Build plus betting, tracker, defense, and metrics suites |
| Pure domain | Extracted live state, score/line-score derivation, batted-ball descriptions, PA/pitch/run transformations, display summaries, runner sanitation, in-play finalization, and lifecycle payloads into eight modules under `src/features/scorebook/domain/` | 60 focused tests, including new reload, pitch numbering, scoring, Buddy Jump, and tournament/season lifecycle cases |
| Data ownership | Moved initial hydration, selected-game refresh, realtime subscriptions, focus resync, roster/stadium updates, and betting feeds into `useScorebookData` and `useScorebookBettingData` | Focused suite and build after each hook boundary |
| Reload persistence | Moved runner-session persistence, live-state publication, active-PA restoration, stale-realtime guards, and team-lineup polling into focused hooks | Focused reload/runner tests and build |
| Lineup workflow | Moved lineup draft seeding, roster projection, drag/drop ordering, fielding assignments, dirty tracking, realtime reconciliation, pitcher handoff, and explicit saves into `useLineupEditor` | Existing lineup characterization tests, focused suite, and build |
| Game lifecycle | Moved completion, reopening, destructive test reset, pitching decisions, stadium history, bracket/season callbacks, and wager coordination into `useGameCompletion`; source-specific patches are pure and tested | Six lifecycle tests plus betting suite, focused suite, and build |
| Persistence services | Centralized PA bundles, game/inning/stint writes, lineups/fielders, odds, tracker mappings, and bracket synchronization in six explicitly named service modules accepting the session table map | Focused suite and build after each service migration; zero direct Supabase references remain in the page |
| Presentation foundation | Extracted theme, primitives, diamond, lineup column, stats tables, runner panels, stadium controls, and action modals | Focused suite and build |
| Major views | Extracted game/spectator, lineups, admin, lazy tracker/editor wrappers, scorekeeper header, lineup status, end banner, pitch controls, in-play panel, and action bar | Focused suite and build after each cohesive view boundary |
| Lazy-loading audit | Kept the `AtBatEditor` and `TrackerLivePreview` `lazy(...)` declarations in `Scorebook.jsx`; production output still emits separate chunks | Production build |
| Final stage audit | Ran diff hygiene, checked source metrics and direct data access, and reran the entire baseline matrix | Build; 60 scorebook; 22 betting; 370 tracker; 14 defense; 4 metrics tests |

## Post-cleanup stage audit

`src/pages/Scorebook.jsx` is now 4,882 lines. It has 42 direct `useState` calls, 20 effects plus one layout effect, 68 callbacks, zero direct Supabase references, and 12 remaining inline `style={{...}}` objects. The baseline was 9,139 lines, 72 state calls, 42 effects plus two layout effects, 89 callbacks, 79 direct `supabase.from(...)` calls, and 476 inline style objects.

The new scorebook feature boundary contains eight domain modules, eighteen presentation components, eight hooks, and six persistence services. Tournament versus season behavior continues to flow from `GameSessionContext` through the table map and source-field adapter; the shared service layer does not choose tournament tables itself. No migration was added or modified by this refactor.

The page now owns route/session composition, derived view models, and the live scoring sequence. Data loading, realtime feeds, reload persistence, lineups, lifecycle coordination, database primitives, and all major rendering surfaces are outside it.

The deliberately deferred next boundary is the tightly coupled live at-bat plus persistent undo/redo engine. It still contains the ordered PA/pitch/run save, correction replay, and rollback orchestration. Moving it now as one block would produce an opaque hook with an enormous interface. The safer next stage is to add fake-client transaction characterization around its ordered failure/rollback paths, then separate `useAtBatWorkflow` and `useScorebookUndoRedo`. No reducer conversion was attempted in this stage because the existing state transitions are not yet protected deeply enough to justify changing their model.
