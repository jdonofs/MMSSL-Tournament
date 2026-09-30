# MSL roster follow-up — scorebook manual lineup save (September 30, 2026)

**All four acceptance cases pass** for season and tournament, at 1280 px and at 390 px. Manual Scorebook → Lineups → Save can no longer write from a fallback lineup. While the saved-lineup reads fail, the editor shows a load error with Retry Load. It offers no editable lineup, no "All changes saved" message and no save action. Recovery seeds only the intended game. After that, editing and saving work normally. The fix is local and uncommitted. Nothing was pushed or deployed.

## Cause and fix

**Cause:** the Lineups view rendered a draft for every game. It did this even when the game had no `lineups` rows of its own. In that case the draft was only a fallback, either roster order or a provider snapshot that had failed to load. `applyLineupToGame` dropped every batting-order update that had no existing row. It then wrote nine fielders anyway and returned normally, including after its own write failures, which it only reported with a toast. `handleSaveLineupTeam` treated any return as success, so it cleared the dirty state and reported "saved".

**Fix:** readiness is based on the game's own rows. A team's editor is `ready` once that team has game-specific `lineups` rows. Until then it is `loading`, or `error` if the pregame seed's saved-lineup read failed for this game. The provider is unchanged.

- `useLineupEditor.js`
  - Exposes `lineupLoadStatus` (per team) and `retryLineupLoad`. The retry clears the pending 5-second timer and runs the seed again immediately.
  - `applyLineupToGame` now refuses to write when the team has no game lineup rows, and shows the toast "Lineup not saved". It resolves `true` only when every write succeeds. Any failure returns `false`.
  - `handleSaveLineupTeam` throws on `false`. The draft stays dirty, the status becomes `error`, and Save & Leave rejects. The existing local `UnsavedChangesPrompt` change catches that rejection and keeps both the prompt and the route.
  - The seed ignores any read that resolves after the user has left or switched games. It writes nothing for the old game and does not set that game's error. It triggers the new game's seed, which `isSyncingLineupsRef` had skipped while the old read was in flight.
- `ScorebookLineupsView.jsx`
  - A card that is not ready shows a one-line status and a `SaveLineupBar` with `loadStatus`/`onRetryLoad`. It shows no draft or edit controls.
  - The save click catches its promise, so a rejected save does not produce a page error.
- `Scorebook.jsx`: passes `lineupLoadStatus` and `retryLineupLoad` through. No other change.

A game that already has its own lineup rows is always `ready`, whatever happens to the saved-team-lineup read. The roster pages, providers, `SaveLineupBar`, tracker, betting and migrations are unchanged.

## Changed files

- `src/features/scorebook/hooks/useLineupEditor.js`
- `src/features/scorebook/components/ScorebookLineupsView.jsx`
- `src/pages/Scorebook.jsx` (4 lines)
- Probe: `tmp/msl-roster-followup-20260930/scorebook-lineups-guard.mjs`. It reuses the coordinator's fixture tables and `fakeRest.mjs`, and adds games 45–47, write-failure injection and a held-read gate.

## Case → evidence

Build: `tmp/msl-roster-followup-20260930/dist`, app asset `app-D5ODMoBB.js`. Logs: `guard-{season,tournament}-{1280,390}.log`. Every run reported:

- zero page errors
- zero unhandled promise rejections
- zero external requests
- zero unsupported fake REST requests
- zero launcher actions

| Case | Result |
| --- | --- |
| 1. Failing reads on fresh game 44 | Both cards show "Saved lineup failed to load — nothing can be saved until it does" with Retry Load. Neither shows "All changes saved", a lineup-spot button or a save button. A manual retry and the automatic 5-second retry both fail again. Result: **0** lineup/fielding writes. Screenshot: `guard-*-failing.png`. |
| 2. Restore reads and retry | Game 44 seeds in the stored order and positions for both teams. Swapping Team A slots 1 and 3 and saving puts the swapped batting order in the stored rows, keeps the fielders and leaves Team B unchanged. After a reload the edit is still there, with no further writes and both bars saved. Games 45, 46 and 47 received no writes. |
| 3. Dirty draft, failed Save and Save & Leave | Lineup PATCHes return 503. Save shows "Save failed — try again" and keeps Retry Save, and the stored rows are unchanged. Save & Leave (from a Stats link) stays on `…/scorebook?game=44` with the prompt open. After Cancel the draft is still dirty. Once writes recover, Retry Save stores the draft. **No-saved-row game 47** initializes from roster defaults and becomes editable. |
| 4. Initialized game, and switching games | Game 44 was reloaded while saved-lineup GETs returned 503. No load error appeared, and swapping and saving slots 2 and 4 succeeded. For game 46, the seed read was held in flight (both cards showed "Loading saved lineup…"). The user then switched in the app to game 45, and the held read was released as a success. After waiting more than 5 seconds, game 46 had **0 writes**. Game 45 seeded from its own read and is editable, and game 44 is unchanged. |

**Coordinator reproducer** (`scorebook-manual-save.mjs`) against the new build, season at 1280 px and tournament at 390 px (`coordinator-repro-*.log`): it now stops at "Lineup spot 1" because no editable fallback is rendered. The script therefore reports FAIL, and that is the intended result: `savedLabels: 0` and `gameWrites: []`.

**Earlier seed fixture** (`scorebook-seed-read.mjs`), season at 1280 px and tournament at 390 px: OK.

## Test results

- Build passed (`tmp/msl-roster-followup-20260930/build.log`).
- `npm.cmd run test:scorebook`: 64/64 passed.
- `npm.cmd run test:persistence`: 64/64 passed.
- The four focused browser runs listed above: all OK.

The other checks recorded earlier are unaffected and were not repeated.

## Remaining limitations

- **The refusal inside `applyLineupToGame` is not exercised in the browser.** A card that is not ready renders no save button. A team also cannot become dirty until it is ready. This guard is reached only if the game's lineup rows disappear while a draft is dirty, for example because another session deletes them. It is verified by reading the code, not by a probe.
- **Some games with no lineup rows now show "Setting game lineup…" indefinitely.** This applies where the automatic seed never runs: a completed game, a tracker game, or a game with plate appearances already recorded. Before this change such a game showed an editable fallback, and saving it wrote fielders with no batting order. No fixture covers these states.
- **A seed that is already writing is not cancelled.** If the read succeeded and its writes are in flight when the user switches games, those writes complete for the original game. That game's rows are then built from a successful read, not a fallback.
- All evidence uses the intercepted fake REST layer. It says nothing about real database permissions or production data.
