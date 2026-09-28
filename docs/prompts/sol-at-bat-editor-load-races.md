# Sol: keep the at-bat editor tied to the selected game

Fix asynchronous loading and game identity handling in `src/pages/AtBatEditor.jsx`. Read `CLAUDE.md` first and preserve all existing uncommitted work, including the completed auth changes. Keep this task separate from season roster/database work.

## Evidence and impact

`loadAll` (around lines 275–355) performs several asynchronous queries and then commits game, PA, pitch, lineup, unresolved-play, and loading state without checking whether its source/game/request is still current. The calling effect's `cancelled` flag only protects its catch handler; it does not stop successful stale loads from committing. Realtime and post-save paths also call `loadAll`.

The review executed the actual `loadAll` body with deferred local query responses: start game 1, switch to game 2, finish game 2, then finish game 1. The final displayed game and PA both belonged to game 1, with loading false, although the target was game 2. This is a function-level reproduction, not a completed browser reproduction or a live database corruption report.

This has potential write consequences: `saveAtBat` builds `payload.game_id` from `resolvedGameId`, while an existing PA update filters by `currentPa.id`. Stale loaded data can therefore combine one game's PA with another game's target. Verify the reachable behavior in the real component before claiming an actual bad write. `src/App.jsx` mounts the parameterized editor routes without identity keys, and the editor explicitly supports changing its game/PA props while mounted.

## Requested fix

1. Give each load a source/game/request identity. Commit results, errors, loading state, deep-link selection, and unresolved-play state only when they belong to the current target and latest valid load. Cover route/prop changes, same-game overlapping reloads, cleanup/unmount, realtime reloads, and post-mutation refreshes.
2. Treat deep-link PA resolution as part of the same lifecycle. Clear or invalidate the previous target while resolving a new PA; handle a missing or failed lookup with a settled, actionable state.
3. Prevent save/delete/correction actions, including imperative save, from operating on a stale or incomplete snapshot. Check loaded competition/game identity against the current target before writing. Do not rely solely on a disabled visible button or on database rejection to make a mismatched payload safe.
4. Inspect required query errors instead of silently substituting empty arrays and making an incomplete game editable. Preserve the deliberate optional behavior for an unavailable unresolved-plays table. Keep the error handling tied to the current request.
5. Preserve unsaved-edit guards, deep-link PA selection, season team normalization, and existing correction behavior. Avoid a broad scorebook refactor or changing database schemas. Do not make remounting the only fix: overlapping requests for the same mounted game also matter.

## Verification

Use the existing local browser fixture approach (`tests/at-bat-correction-browser.mjs`, `tests/browser/`, and the auth tests provide examples), with deterministic deferred responses and no live database writes. Test the actual editor rather than only a new guard helper.

- Switch A to B; complete B then A. B's game, PAs, pitches, and selection remain visible, and no action writes A's PA under B's game ID.
- Switch competition source with colliding numeric IDs; stale results cannot cross sources.
- Finish an older same-game realtime reload after a newer reload; old state cannot replace the latest snapshot.
- Exercise a failed/missing PA deep link, required-query failure, stale failure, and unmount during loading. Loading settles correctly and incomplete data cannot be edited.
- Verify legitimate edits and unresolved-play correction still work for both season and tournament, and existing unsaved drafts retain their intended protection.

Run the focused regression tests, `npm run test:correction-browser`, `npm run test:scorebook`, and `npm run build`. Run `npm run test:persistence` if mutation code changes. Use `npm.cmd` if PowerShell blocks `npm.ps1`. Report the cause, targeted implementation, exact test results, and any remaining limits. No new test framework or unrelated cleanup.
