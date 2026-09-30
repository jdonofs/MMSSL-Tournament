# Sol: one browser smoke pass of the existing site

The user has explicitly requested one extra browser-testing pass after MSL readiness was established. Read `CLAUDE.md`, `docs/msl-optional-smoke-2026-09-29.md`, and the current verdict in `docs/msl-game-readiness-2026-09-28.md`. Execute checklist **S1–S6 only**. This is a real browser test assignment, not a request for another plan or an unlimited bug hunt.

Use Playwright against the actual built app with local/intercepted data. Check navigation, visible controls, dialogs, validation, mobile usability and console/network failures by performing the actions. Simply loading a page or reading JSX is not a completed check. No admin login is needed to start: fixture users can carry the existing admin/player flags.

Start from the existing interception in `tests/season-playoffs-browser.mjs`, `tests/tracker-acceptance-browser.mjs`, `tests/at-bat-correction-browser.mjs`, and `tests/game-completion-recovery-browser.mjs`. Prior next-game smoke code is at `tmp/msl-readiness-20260928/release-check/next-game-start-browser.mjs` if still present. Existing fixtures in `tests/browser/` and `tests/browser/bettingUiWorld.mjs` supply identities and data. Reuse the established available-loopback-port approach; Vite `port: 0` previously selected blocked port 5173.

Cover the named season routes from `src/App.jsx`: `/season`, `/season/roster`, `/season/schedule`, `/season/bets`, `/season/stats`, team/character links and `/admin`. Use the actual configured game route rather than inventing a path. Focus fresh work on roster/admin controls and link navigation not established by the release check. Cite applicable existing evidence for already-covered betting, auth and schedule cases; do not rerun the 1,441-test suite just for this assignment.

All real database mutations and local tracker launches must be intercepted before navigation. Some page loads trigger background processing, so do not assume a page is read-only merely because you never press Save. Treat unexpected outbound traffic as a test failure to investigate. Do not use the live TEST season for global admin actions.

Own page/component presentation, routing and CSS fixes only when a reproducible functional bug appears. Opus owns persistence/domain services and workflow correctness. If a request is correct but persistence is wrong, provide its reproduction to the workflow findings rather than changing shared services. If Opus needs an Admin/roster page change, keep a single owner for that file. Preserve all existing work. No redesign, additional features, new test framework or speculative accessibility/performance project.

Store scratch artifacts in `tmp/msl-optional-smoke-20260929/sol/`. A small focused scratch browser script is within this request; build on existing helpers, and create permanent regression coverage only for a demonstrated bug. Include useful failure screenshots and errors with secrets excluded. Stop only servers/browsers you created.

After a fix, rerun the failed case and relevant nearby regression checks. Run `npm.cmd run build` if product code changes. Do not repeatedly broaden testing after the required cases pass. No push/deployment.

Write `docs/msl-optional-smoke-sol-2026-09-29.md` with one outcome/evidence entry per S1–S6, any exact reproduction and minimal fix, verification results and remaining material limitations. Be explicit that intercepted admin UI tests do not prove production RLS. If no defect is found, say so and leave product code unchanged. End with **No new session blocker found; pass complete**, or name a specific blocker. Stop; do not invent the next assignment.
