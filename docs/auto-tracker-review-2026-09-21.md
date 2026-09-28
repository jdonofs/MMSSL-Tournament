# Auto tracker review — September 21, 2026

Two bounded improvement tasks are justified: live restart recovery, and postgame completeness checks. A broad cleanup or rewrite is not justified by this review.

Reviewed the current working tree, including existing uncommitted changes. No production code, captures, migrations, or external database records were changed. Review artifacts are under `tmp/auto-tracker-review-20260921/`.

## Findings

### 1. Live restart can abandon partially saved measurement rows

`scripts/tracker_live_tracking_persistence.mjs:137-166,198-239`

`ensureSession()` resumes a live session by adding every existing play's contact frame to `written`, without checking its fielding, movement, throw, or catch-approach children. Those rows are written through separate requests. A parent row can therefore survive a failed child write without representing a complete play.

There is also an initialization ordering defect: `sync()` checks `written` before `ensureSession()` populates it. The first replayed play is attempted with the next ordinal instead of its existing ordinal. With the session/PA uniqueness constraint from `20260918135000_tracking_play_pa_version_uniqueness.sql`, that conflicts.

Offline reproduction using the existing fake database, augmented with that migration's uniqueness rule:

- A clean restart attempts to write an existing PA at ordinal 2 and fails reconciliation.
- Injecting a fielding insert failure leaves one parent and zero fielding children.
- Restart attempt 1 hits the ordinal conflict; attempt 2 reports `{ written: 0 }` while the children remain absent.

Impact: live advanced measurements can remain incomplete until a successful postgame replacement repairs them. This is not evidence that official scoring rows are lost. The new uniqueness rule was modeled in this reproduction, not executed against production.

Adjacent restart behavior worth checking within this task: `loadContext()` excludes the current game's opportunities, and resuming does not restore the completed live plays to `fieldingHistory`. Verify restart scoring parity before changing this behavior.

Handoff: [Sol 5.6 prompt](prompts/auto-tracker-sol-5.6-2026-09-21.md).

### 2. Postgame completeness checks both miss data and redo completed work

`scripts/ingest_player_tracking.mjs:255-281,908-975,1217-1238`

**Missing catch approaches:** the writer deliberately tolerates a missing `tracking_catch_approaches` table, but completeness checks count only plays, fielding, movement, and throws. A later ingest, after the table becomes available, returns `alreadyComplete: true` without importing the omitted approaches.

Reproduction: ingest one play with one catch approach while simulating SQLSTATE `42P01` for the table. The first ingest finishes. Restore the table and ingest identical input: it reports complete with zero of the one expected approach saved. This is a schema-recovery case, not a claim that every catch-approach write currently fails.

**Truncated counts:** `existingFactCounts()` obtains child rows with unpaginated `.select('id').in(...)` calls and counts the returned array. The repository documents a default 1,000-row PostgREST limit in `src/utils/fetchAllRows.js`. Complete sessions above the limit appear incomplete and re-enter per-row reconciliation.

Reproduction with a fake client imposing that response cap: a 120-play session has 1,080 fielding and 1,200 movement rows. An unchanged second ingest fails to take the complete-session shortcut and makes **2,539 database operations**. This is a request-count measurement, not a live network timing benchmark.

This is a realistic size: 21 of 59 readable local `.plays.jsonl` files imply more than 1,000 fielding or movement rows. Those files are not necessarily distinct official games or current active sessions; the scan establishes scale only.

Impact: catch measurements omitted during deployment remain missing on ordinary retry, while larger complete sessions incur avoidable database work and recomputation. These defects share one completeness decision and belong in one task.

Handoff: [Opus 5 prompt](prompts/auto-tracker-opus-5-2026-09-21.md).

## Verification and limits

All existing checks run for this review passed, with zero skips:

| Command on this Windows machine | Passed |
| --- | ---: |
| `npm.cmd run test:tracker` | 584 |
| `npm.cmd run test:persistence` | 51 |
| `npm.cmd run test:database` | 90 |
| `npm.cmd run test:acceptance` | 43 |
| Total | 768 |

Reproduce the findings with:

```powershell
node tmp/auto-tracker-review-20260921/reproduce.mjs
```

The script imports production functions and a scratch copy of existing fixture builders. It creates only synthetic files in that review directory and in-memory database rows. Supporting output is `reproduction-results.log`; each existing suite has a separate log there.

The passing tests do not cover these reproduced cases. In addition, the database fixture's migration list ends at the September 18 UUID function migration and omits the newer session/PA uniqueness, projected-landing/max-speed, and catch-approach migrations. The fake's default tracking-play uniqueness also lacks the session/PA rule. Targeted tests should represent the constraints needed for these fixes. This is a coverage limitation, not evidence of a production migration failure.

This review did not launch Dolphin, exercise actual memory collection, query production, or establish new accuracy claims about the statistical models. Existing documented requirements for real-game observation remain separate from these offline tasks.

## Working arrangement

The prompts have separate production-file ownership and request new, separate regression test files so both agents can work concurrently. Sol owns the live writer; Opus owns postgame completeness. Both should preserve existing uncommitted work. Run the combined tracker, persistence, database, and acceptance checks after integrating both results. Neither task requires a deployment or a production backfill.
