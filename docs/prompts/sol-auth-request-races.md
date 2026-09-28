# Sol: prevent stale auth requests from replacing the current player

Review and fix asynchronous player resolution in `src/context/AuthContext.jsx`. Read `CLAUDE.md` and preserve all existing uncommitted changes. Keep this assignment focused on auth state and its regression coverage; another agent is working on season free-agent pickups and their database migration.

## Confirmed problem

`resolvePlayerForSession` (around lines 47–70) commits `setPlayer` after an asynchronous lookup/link operation without checking whether the originating session is still current. During review, its actual callback was executed with deferred lookups: start session A, start session B, resolve B, then resolve A. The final player belongs to A even though B is the current session.

This is a local reproduction, not a live account test. `is_logged_in` currently checks only that both a session user and a player exist, and role flags come from that player. A mismatch can therefore display the wrong identity or controls; this finding does not establish a database authorization bypass.

The realtime player refresh and `refreshPlayer` also commit asynchronous results without checking that the session remains current. The effect's `active` flag guards some loading/error updates but not these successful player commits. Initialization calls `initialize()` without handling lookup/link rejection.

## Work requested

Make all asynchronous player resolution paths respect the current auth identity and request lifecycle: initialization, auth events, linking, realtime refresh, explicit refresh, logout, and unmount. Older success, error, and loading completions must not overwrite state belonging to a newer session or repopulate a logged-out player. Clear the previous identity appropriately when the user changes, and ensure role flags cannot derive from a mismatched player.

Preserve the deliberate behavior already documented in the file: same-user `SIGNED_IN` and `TOKEN_REFRESHED` events should update session information without blanking/remounting the app or discarding edits. Keep player auto-linking functional. Handle initialization and refresh failures cleanly without unhandled rejections. Use the smallest reliable change within the existing provider; do not replace the auth system or change database permissions.

## Acceptance and verification

Add deterministic regression coverage using the existing test tooling, with controlled asynchronous completion order:

- A lookup resolves after a newer B lookup: session and player remain B.
- A pending lookup or refresh resolves after logout: the player stays cleared.
- An old request fails after a new one succeeds: it cannot clear the new player or change that session's loading state.
- Unmount/StrictMode cleanup prevents obsolete requests from committing state.
- Same-user token refresh/re-establishment preserves mounted content and current player identity.
- Initialization lookup/link failure settles loading and produces no unhandled rejection.

Test the actual provider behavior, rather than only a parallel implementation of its request guard. Run the focused tests and `npm run build`; use `npm.cmd` on PowerShell if needed. Keep tests local with mocked auth/network responses, and report exactly what was verified. Deliver the cause, targeted fix, and results without a broad refactor or new test framework.
