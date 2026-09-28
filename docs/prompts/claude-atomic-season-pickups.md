# Claude: make season free-agent pickups atomic

Review and fix the free-agent pickup flow in this project. Read `CLAUDE.md` and the current implementation before editing. Preserve all existing uncommitted work. Keep this assignment focused on season free-agent pickups; another agent is working on `src/context/AuthContext.jsx`.

## Confirmed problem

In `src/pages/SeasonRoster.jsx`, `submitPickup` (around lines 1570–1626) performs three separate writes:

1. Insert the new active player into `season_roster`.
2. Deactivate the dropped roster row.
3. Call `createDroppedPlayerWaiver` (around line 1330) to insert the waiver.

Each failure returns with a toast, leaving earlier writes committed. During review, the actual handler was executed with injected write failures: a failed drop left 10 active players, and a failed waiver insert left the roster swap applied without a waiver. These are local reproductions, not observations against the live database. The initial nine-player check also uses client state, so concurrent requests need server-side validation.

## Work requested

Replace the three-request mutation with one transactional database operation and wire the existing UI to it. Validate the authenticated caller, team/season ownership, pickup eligibility, captain protection, the current drop row, and the nine-player roster invariant inside the transaction. Preserve the project's existing season and waiver rules. Serialize conflicting pickups and prevent a stale request or retry from creating another swap or duplicate waiver. Retain the dropped row's history as the current behavior does.

Use the existing migration conventions. Inspect the real schema and relevant policies/functions through available read-only access if possible: the repository does not contain a complete season schema, and `tests/fixtures/tracker-database-baseline.sql` is a reconstructed tracker subset. Do not present an invented fixture as proof of production compatibility. Explicitly identify any schema assumptions you cannot verify.

Wire clear pending, success, and failure states into the pickup modal, refresh the roster after the operation, and prevent repeated submission while it is pending. Do not fall back to the current partial-write sequence when the RPC is missing; show an actionable migration error. Keep trade proposal and waiver-resolution rewrites outside this task.

## Acceptance and verification

- Success leaves exactly nine active players, the intended replacement, and one appropriate waiver for the dropped player.
- A failure at any database step leaves the original roster and waiver state intact.
- Stale drop targets, competing claims on the same free agent, unauthorized callers, and repeated submissions cannot partially change the roster.
- Add focused regression coverage using the existing test infrastructure. Exercise rollback against PGlite where feasible; distinguish a serialized local test from proof of concurrent behavior on PostgreSQL.
- Run the new focused tests, `npm run test:persistence`, `npm run test:database`, and `npm run build`. On PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`.

Deliver the implementation, migration, test results, and any schema/deployment assumptions. Prepare migration files locally; applying them to the live database is outside this assignment. No broad refactor or new test framework.
