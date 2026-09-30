# One optional site smoke-test pass — September 29, 2026

The user requested this extra pass after the readiness work, deployment and successful test game. The current readiness verdict remains in `msl-game-readiness-2026-09-28.md`; this does not reopen its old backlog. The purpose is to exercise existing site controls and check for concrete bugs, not to find a quota of issues or improve test coverage indefinitely.

## Closure — September 29, 2026

**Pass complete. No new session blocker; no further agent assignment.** Sol accounted for S1–S6 and Opus for O1–O5 in their separate reports. Sol fixed the Admin edit-modal initialization race; Opus fixed lineup writes reporting success after a database error. The coordinator reviewed the combined changes and closed Opus's two remaining follow-ups:

- Download Backup now records `incomplete` and named `failedTables` in the JSON and emits only the incomplete warning when a table fails. Successful table data is preserved.
- Both roster pages handle failed Save button promises after setting the visible retry state. The shared Save & Leave dialog also handles rejection, retaining the route and edits for retry.

Combined-candidate verification: build passed; scorebook 64/64 and persistence 64/64 passed. Existing Opus browser fixtures were extended in scratch files to assert these follow-ups against the rebuilt app at 1280 and 390 px. Clean/partial backup downloads, settings save/failure/retry, lineup save/failure/retry/reload/export, and failed Save & Leave passed with no unhandled browser errors or unexpected remote requests. The first navigation assertion selected the hidden mobile menu; using the visible navigation at each width resolved that test-locator failure. Tournament Save wiring was reviewed for parity; the new lineup browser checks exercised season mode.

Evidence: `tmp/msl-optional-smoke-20260929/closure/`, `closure-build.log`, and `closure-scorebook.log`; scratch fixture extensions: `opus/o1-closure.mjs` and `opus/o5-closure.mjs` under the same smoke directory. These checks used intercepted data and do not establish production RLS. Opus's documented lost-response betting limitation remains nonblocking and outside this pass.

The optional smoke fixes are local and still need committing and deployment. No migration or additional physical rehearsal is required by these changes. Once shipped, stop readiness work unless an actual new problem appears.

## Completed checklist

Use one representative season, two teams, and the existing local/intercepted test data. Exercise browser actions on the actual application, not a newly implemented copy of its behavior. Run desktop (1280 px) and narrow-screen (390 px) UI checks where specified. Existing recent evidence may satisfy overlapping cases: name the test and evidence rather than rerunning or rebuilding it solely for this pass.

| ID | Owner | Case and observable result |
| --- | --- | --- |
| S1 | Sol | Logged-out protected navigation redirects; fixture admin and ordinary-player sessions show appropriate controls; changing season updates the heading/selected game without a broken route. This is UI behavior, not proof of production RLS. |
| S2 | Sol | From season home, follow schedule, roster, bets, stats, a team link and a character link; use one visible filter/search/sort and browser Back. The intended content appears, with no new uncaught error or stuck loading state. |
| S3 | Sol | On the roster, change a lineup order, exercise unsaved-changes cancellation, and reach Save on desktop/mobile. Verify button feedback and modal usability. Opus owns the saved-data checks in O1. |
| S4 | Sol | Open a scheduled game and stadium setup on desktop/mobile, cancel once and reopen. Correct matchup and game URL persist. Existing next-game/playoff evidence may satisfy this; do not actually start Dolphin. |
| S5 | Sol | Open a betting slip and receipt, enter/clear a wager, close dialogs with available controls, and follow a game link at 390 px. Existing betting cases may supply assertions; Opus owns money/retry behavior. |
| S6 | Sol | On the fixture-backed Admin page, open Edit Season, verify validation/Cancel/reachable Save at 390 px, and inspect confirmation/cancellation for deletion/recompute/award controls. Confirm cancellation sends no mutation. Do not execute destructive actions merely for coverage. |
| O1 | Opus | Save a valid lineup through the real site path, reload, and show the same order; game setup/export receives that order. An injected failed save does not falsely report success or discard the editable order. |
| O2 | Opus | One free-agent pickup and one trade acceptance with local fake/PGlite data: valid ownership changes are consistent, a stale asset or rejected write cannot silently succeed. Reuse existing transaction tests; a fake RPC returning success is not proof of database atomicity. |
| O3 | Opus | Place one synthetic bet, double-submit/retry the relevant failure case, and verify ticket/ledger/balance agree after reload. Reuse existing betting fixtures. No duplicate debit or credit, no lost slip on failure. |
| O4 | Opus | Verify recent completion/reopen/correction evidence still applies to the deployed candidate: final score, standings, stats and settlement agree; failed follow-up remains recoverable. The already passing release tests can close this row unless code changed. No need for another emulator game. |
| O5 | Opus | Exercise one season-settings save/reload and the existing Download Backup utility using intercepted data. Check returned errors, source scoping and that a missing required table produces incomplete-backup feedback rather than a falsely complete export. |

## Execution boundaries

- Start without real credentials. Use the project's existing Playwright/Vite fixtures or interception pattern with realistic admin/player identities. Install interception before navigation, including realtime/local-launcher traffic. Unexpected remote requests should fail visibly rather than reaching a real database or emulator. Synthetic writes are authorized; production mutations are not.
- A TEST season in the live database does not isolate global players, balances, admin operations or shared RPC side effects. Keep mutation cases fully local/intercepted. Do not request admin credentials just to reproduce a flow already testable locally. If a useful live-only read genuinely needs an authenticated session, report that precise limitation; it is not a reason to stop independent cases or claim those reads were verified.
- Preserve the current working tree and `public-tracker-release/`. Use separate ports and scratch directories: `tmp/msl-optional-smoke-20260929/sol/` and `/opus/`. Stop only your own processes. Do not change the shared checklist or readiness report concurrently; each agent writes a separate findings file.
- Sol owns page/component presentation, navigation and CSS changes if necessary. Opus owns shared domain/persistence utilities, services and their tests. Do not edit the other agent's files. For defects crossing that boundary, supply the reproduction and owner instead of making competing edits. No package/dependency/build-system changes except a demonstrated obstacle to this pass, and no new framework.
- Fix only reproduced functional bugs with a small, reviewable local change and an appropriate regression check. If no bug appears, change no product code. Do not convert minor visual preferences, old notes or speculative edge cases into release blockers. Do not auto-deploy fixes.

## Finish and reporting

Each assigned row gets one result: pass with evidence, fail with exact reproduction, or not exercised with a concrete reason. Distinguish existing evidence, newly executed checks, fixture limitations and real deployed observations. Record source revision/working changes, viewport, relevant console/network errors, and screenshot/trace paths for failures. Never include credentials or auth tokens in reports/artifacts.

Sol writes `docs/msl-optional-smoke-sol-2026-09-29.md`; Opus writes `docs/msl-optional-smoke-opus-2026-09-29.md`. Each ends with either **No new session blocker found; pass complete** or the exact remaining material defect and its impact. Stop when assigned rows are accounted for and any in-scope fixes are verified. Do not generate another audit or task list. If product code changes, the coordinator will review the combined diff and relevant tests before treating it as a new release candidate; the currently deployed, tested version remains available.
