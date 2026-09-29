# Opus: final MSL 1 integration check and readiness verdict

Read `CLAUDE.md` and the current-status/stopping-rule section of `docs/msl-game-readiness-2026-09-28.md`. The user explicitly wants this readiness push to end. This assignment is a bounded release check, not another general audit. Close the remaining stated release conditions using existing evidence and tools, fix only reproduced material blockers, and deliver a readiness verdict.

## Starting point

The review has just run your three new suites together:

```powershell
node --test --test-concurrency=1 tests/game-completion-recovery.test.mjs tests/game-completion-hook.test.mjs tests/game-completion-bridge-recovery.test.mjs
```

All 22 tests passed, zero skipped (`tmp/msl-readiness-20260928/completion-review.log`). Your code is present in the shared working tree. Do not redo that assignment or introduce a replacement architecture.

Sol's browser work has 65 passing checks. The capture task is also closed in the readiness document: strikeout-terminal pitches and fair-then-foul handling were repaired in the bridge parser; one historical unresolved Red Noki PA remains correctly reported. Saved results show acceptance 47/47, tracker 602/602, and the document records persistence 64/64. Preserve those parser fixes and exact fixture expectations. Do not treat the old zero-warning failures as current blockers.

## 1. Verify the combined candidate once

Record the working-tree state before testing; there are uncommitted changes, so HEAD alone does not identify this candidate. Preserve them and the unrelated untracked `public-tracker-release/` directory. Confirm no agent is still changing the candidate before drawing a final conclusion; if files change during a check, recheck only what that change affects.

Run `npm.cmd run build` and one combined `node --test --test-concurrency=1 tests/*.test.mjs` pass. Use existing logs to avoid additional redundant suite runs. Classify every failure as a product defect, an outdated fixture, or an environmental limitation based on its actual cause. Do not skip failing tests or weaken behavioral assertions to obtain a green total. Fix a demonstrated defect that threatens the next session; otherwise document the specific remaining limitation. Broaden testing only when a fix warrants it.

## 2. Close the representative session-rehearsal condition

Serve the freshly built candidate on an available loopback port and use the existing intercepted browser scripts, including:

- `tests/tracker-acceptance-browser.mjs`
- `tests/at-bat-correction-browser.mjs`
- `tests/game-completion-recovery-browser.mjs`
- `tests/season-playoffs-browser.mjs`

Inspect each script's assumptions and interception before running it; set its supported base URL if your preview uses another port. These checks must exercise the current build, not stale dist files. Stop only the preview/browser processes you create.

Map the existing tests/replay evidence to this finite session flow: sign in; select the correct season; confirm roster and saved lineup; open the scheduled game and stadium setup; start tracker/scoring; view live state; finish; verify bets, standings and stats; correct/reopen/retry a failed finalization; open the next game. Include the actual narrow-screen schedule/recovery controls. Reuse evidence already establishing a step. For a genuinely uncovered critical link, do one focused local/intercepted check using the existing tooling rather than building another general harness. Do not expand into exhaustive admin utilities, all possible trades, every stadium, new metric calibration, or visual redesign.

A UI that renders is not proof its save/start action works: follow the important local request through to the corresponding data or launcher boundary. Use synthetic games/local intercepted writes. Do not launch an official game or mutate live MSL records as a rehearsal.

## 3. Establish deployment and installed-tracker prerequisites

Use available configuration and existing authenticated tools for read-only checks. Identify the configured deployed site and Supabase project without exposing keys/passwords. Determine whether the deployed assets include these uncommitted fixes; report them as pending deployment if they do not, rather than treating a successful local build as deployed.

Check only the tables, columns, RPCs and permissions required by the MSL session path: season schedule/lineups, canonical scoring, tracker lease and fenced writes, tracking-version activation, bets/ledger, and completion recovery. Start from actual calls and existing schema checks such as `scoringPersistence.assertSchemaSupported`; inspect helpers before invoking them. Use metadata, read-only queries and available policy/function definitions. Do not call a mutating RPC with a made-up game merely to see whether it exists, and do not infer write permission from an empty SELECT. If credentials or metadata access are insufficient, name exactly which property remains unverified and the smallest final check; continue the independent work. Do not create a new monitoring/preflight product.

Read the local protocol registration and launcher configuration to confirm they point to this checkout and the intended tracker executable/Python paths. Verify files and dependencies without changing registration or starting a real game. `scripts/verify_tracker_build.py` can compare the installed executable's embedded code with source, but read its Python-version requirement and confirm applicability to the configured build first. Older successful startup records may satisfy historical startup evidence, not today's deployment or changed executable. Prepare only the shortest unavoidable controller/emulator check still unsupported by existing evidence.

Do not deploy, push, apply migrations, rebuild/replace the installed tracker, run repair/backfill scripts, alter balances, or reset official games. If a release action is needed, prepare the exact reviewed change and name the remaining action; this verification assignment does not authorize production mutation. Absence of external access is not a reason to invent more coding work.

## Scope, stopping point and deliverable

Keep product changes limited to a reproducible material failure in the flow above. Preserve Sol's changes; do not reopen completed tasks on hypothetical concerns. If all local behavior passes, no additional product code is required. No new dependencies/frameworks, broad refactors, catch-probability research or optional polish.

Update the readiness document with a compact result for each of its five release conditions: verified (with evidence), blocked (exact cause), or awaiting a named deployment/physical check. Separate confirmed defects from nonblocking limitations. Record test counts, which build was tested, and whether live schema/deployment was actually verified. Use a short checklist of only the remaining actions, not another broad task backlog.

End with one honest verdict:

- **Ready for the next MSL 1 session** — all material conditions are established; list nonblocking limitations and stop.
- **Code work complete; awaiting these specific checks/actions** — only named deployment/access/physical confirmations remain; stop assigning coding tasks.
- **Not ready: these concrete blockers remain** — name the reproduced blocker, session impact and smallest remaining fix. Do not manufacture additional assignments beyond that evidence.

There is no requirement to prove software permanently bug-free. Once the agreed session conditions are satisfied, the readiness project is done.
