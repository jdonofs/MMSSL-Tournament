Work in C:\Users\jdono\Sluggers. Read CLAUDE.md and the coordinator follow-up at the top of docs/msl-review-2026-09-30.md. Do not ask questions or spawn agents. This is one remaining Task A case, not another audit. Task B and the roster-page fixes are accepted; preserve them and all earlier local smoke fixes.

Reproduced issue: automatic scorebook seeding is protected, but manual Scorebook → Lineups → Save can still write from fallback defaults while saved-lineup reads fail.

Evidence:
- tmp/msl-roster-review-20260930/scorebook-manual-save.mjs extends your scorebook-seed-read.mjs against the exact final A+B build.
- manual-save-season.log (1280 px) and manual-save-tournament-390.log (390 px) in that directory reproduce it.
- Fresh build passed and all 79 built assets match your tested build byte-for-byte.
- Start a fresh manually scored game 44 with custom saved team lineups and no game lineup/fielding rows. Return 503 for saved-team-lineup GETs. Wait for “Saved lineups unavailable.” Open Lineups: both bars say “All changes saved.” Swap Team A slots 1 and 3 and press Save Team A Lineup. One POST writes nine default fielders; batting lineup rows remain empty; the editor returns to saved/clean. No real data was touched.

Cause to address: ScorebookLineupsView.jsx leaves editing/save available without readiness state. applyLineupToGame in useLineupEditor.js filters out updates that have no existing game-lineup row, then proceeds to write fielders; handleSaveLineupTeam marks the resolved call saved. The provider's missing saved-lineup snapshot is therefore not merely display-only when users act on it.

Ownership: src/features/scorebook/hooks/useLineupEditor.js; src/features/scorebook/components/ScorebookLineupsView.jsx; src/pages/Scorebook.jsx only for passing the necessary state/actions; focused regression/browser fixtures and a short follow-up report. Use existing SaveLineupBar loadStatus/onRetryLoad support where useful. Do not change roster pages, betting, tracker, migrations, or shared providers merely to broaden the fix. If provider changes prove necessary, report the exact obstacle rather than expanding the audit. No new framework or dependencies.

Implement the smallest complete correction: expose truthful readiness/error state for this manual editor, block writes from unknown/default fallback state, and enforce the same guard in the save action (not only a disabled button). A refused/failed save must not clear dirty state or resolve as a successful Save & Leave. Handle button promises without page errors. Successful recovery must make the trustworthy lineup available for normal editing. Existing valid game-specific lineups must remain usable if a separate saved-team-lineup refresh fails; do not gate an already initialized/live game on an unrelated pregame read.

Finite acceptance:
1. Season and tournament, desktop 1280 and mobile 390: failing saved-lineup reads on a fresh manual game produce truthful loading/error state and zero lineup/fielding writes through automatic seeding or manual Save. No “All changes saved” claim for an unknown lineup.
2. Restore reads and retry: saved order/positions initialize only game 44. Swap/edit, save and reload: batting order and fielders agree with the intended edit, and the other team/game is unchanged.
3. Where the guarded editor has a dirty draft, failed Save/Save & Leave keeps the draft and route, with no unhandled rejection. A legitimate no-saved-row response still allows initialization from defaults.
4. An already initialized game's valid game-specific lineup stays editable through a saved-team-lineup read failure. A retry or delayed response after leaving/switching games must not write the old game's fallback or affect the new game's editor.

Reuse your existing interception fixtures and the coordinator reproducer. Run the focused new browser/regression cases, build, npm.cmd run test:scorebook and npm.cmd run test:persistence. Other successful checks stand unless affected. All browser REST/auth/realtime/local-launcher traffic must be intercepted before navigation; abort unexpected outbound requests. No credentials, production mutations, real emulator game, push, deploy, deletion or cleanup. Preserve public-tracker-release/ and unrelated edits.

Stop when those four cases pass or a concrete limitation is recorded. “Passed; no code change needed” closes verification-only cases. Write docs/msl-roster-followup-opus-2026-09-30.md with cause/fix, changed files, case → evidence, test results and remaining limitations. Do not generate another task list. The coordinator will review the small follow-up and close the pass.
