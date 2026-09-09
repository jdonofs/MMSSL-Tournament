# Tracker acceptance pass — 2026-09-06

An automatically tracked game, replayed end to end through the real pipeline
and checked against results the pipeline did not produce.

## How to run it

```
npm run test:acceptance            # 42 checks, ~90 s, no network, no emulator
npm run test:database              # 27 checks against a real PostgreSQL, ~30 s

# the browser half needs the built app served:
npm run build
npm run preview                    # leave running on 127.0.0.1:4173
npm run test:acceptance-browser
```

`npm run test:acceptance` writes `tmp/tracker-acceptance/pipeline-rows.json` —
every row the replay produced. `npm run test:acceptance-browser` serves *that
file* behind the Supabase REST endpoints the app already calls, so the browser
check renders the pipeline's own output rather than a separately written
fixture. It refuses any non-GET request.

## Fixtures

| | Tournament | Season |
|---|---|---|
| tracker log (input) | `sluggers-stat-tracker-advanced-stats-dev/preview-sessions/preview-2026-09-04_13-10-49.log` | `.../preview-2026-09-04_11-21-37.log` |
| 60 Hz capture (input) | `data/player_tracking/luigis_mansion-20260904T171123Z` | `data/player_tracking/peach_ice_garden-20260904T152214Z` |
| workbook (oracle, never fed in) | `sluggers-stat-tracker-advanced-stats-dev/output/Knights vs Spitballs - 2026-09-04 13-33-40.xlsx` | `.../Fireballs vs DK Wilds - 2026-09-04 11-47-26.xlsx` |
| park | Luigi's Mansion | Peach Ice Garden |
| final | Knights 6, Spitballs 12 | Fireballs 6, DK Wilds 8 |

The three artefacts in each column are one played game. The suite checks the
pairing before replaying anything: the session log's opening timestamp, the
capture stem's UTC stamp (35 s later), and the workbook the log's own last
lines say the tracker saved.

Both recordings are **unowned calibration exhibitions** — their capture headers
carry `"note": "standalone preview (no database writes)"` and a null game id.
Every player, team and game identity is invented for this suite and named
`acceptance-*`. Nothing here claims a league player batted in these innings.

- Identities: `tests/helpers/trackerAcceptanceWorld.mjs`
- Expected results: `tests/fixtures/tracker-acceptance-expected.json` (literal
  values with an `_audit` note on every block saying where each came from)
- Replay driver: `tests/helpers/trackerBridgeReplay.mjs`,
  `tests/helpers/trackerAcceptanceRun.mjs`
- Reproductions of the four defects: `tmp/acceptance-20260906/`

Both games are id **4242** inside competition **909**, in one shared database.
That collision is deliberate: it is what makes the season/tournament isolation
checks mean something.

## What is real in the execution path

```
saved tracker log  -> scripts/live_tracker_bridge.mjs         parse + automatic scoring
                   -> scripts/tracker_scoring_persistence.mjs journal, then PA/pitch/run rows
                   -> scripts/tracker_pitching_persistence.mjs
                   -> scripts/tracker_betting_sync.mjs        live odds, then settlement
saved 60 Hz capture-> scripts/ingest_player_tracking.mjs      postgame tracking facts
resulting rows     -> src/utils/statReconciliation.js         official selection
                   -> src/utils/statsCalculator.js            aggregation
                   -> the built app                           Stats + CharacterPage
```

Three things are injected, and nothing else: the Supabase client (the existing
in-memory fake), `spawn` (so the saved log arrives on the stdout the tracker
.exe would have written it to, through the bridge's own readline), and the run
directory. `scripts/live_tracker_bridge.mjs` gained `export async function
main(deps)` with `deps.supabase`, `deps.spawn` and `deps.lockDirectory`, plus
`pendingTrackerWork()` and `stopTrackerBridge()`, following the same convention
`scripts/mss_autogame.mjs` already uses. Run as a script it behaves exactly as
before.

## Verification limits

- **The fake database is not a database.** It enforces the natural keys the
  schema is expected to hold and it can lose a response after a commit, but it
  is a single-process object. It establishes nothing about real transaction
  atomicity, real constraint enforcement, or exclusion between two machines.
  The restart variant restarts a module inside one process; it does not prove
  a second host would be kept out. That still needs the database-backed lease
  and the unique constraints `docs/tracker-persistence-reliability.md` lists.
- **The tracker's workbook is an oracle, not the truth.** Where it and the
  pipeline disagree, the fixture says which is right and why (three plate
  appearances the tracker's own counter missed, one sac-fly RBI it did not
  credit, one inning of pitching it mis-totalled, and the hit/ROE difference
  that is a deliberate scoring-model decision in this repo).
- **One plate appearance in the tournament recording has no stated outcome.**
  The bridge refuses to score it and reports it. Its run is lost with it, so
  `runs_scored` holds 17 rows for an 18-run game; the scoreboard total on the
  game row is unaffected. Resolving that needs an operator or video, not code.
- The prior **Catch Probability / OAA decision ("Baseline required")** is
  untouched: postgame ingestion runs with `recompute: false`, so no model is
  refit or activated by this suite.

---

## Extended — 2026-09-08

Seven checks were added to this suite and a new one was created beside it.

### New here

| Check | What it establishes |
|---|---|
| the tracker is held until the collector has frames on disk | the real `awaitCaptureRecording()` waits for evidence, and the file the launcher reads carries the frames and bytes behind it |
| a collector that dies before capturing | its exit settles the wait immediately; the game is still tracked and the reason is published |
| evidence that proves nothing | frames counted with nothing flushed is reported as NOT recording |
| a bridge takes the game lease before it writes anything | epoch 1 taken at startup, released on a clean stop |
| a second bridge against a game another owner holds | refused before any row is written, and the held lease is not taken |
| the play the tracker could not score is unresolved, not invented | exactly one row — the real unscored plate appearance, not the eight empty buffers a side change flushes |
| an operator correction survives a replay of the whole game | a second bridge with no journal re-derives every plate appearance and leaves the correction alone |

### `npm run test:database` — the limits this suite named, answered

The previous version of this document said plainly what the in-memory fake
could not establish: "It establishes nothing about real transaction atomicity,
real constraint enforcement, or exclusion between two machines." A new suite,
`tests/tracker-database-guarantees.test.mjs`, applies the real migration files
to a real PostgreSQL 18 (PGlite, the server compiled to WebAssembly, in
process) and tests them by their effects — 27 checks covering unique keys on
every natural identity, transaction rollback, the lease with its fencing epoch,
season/tournament isolation on the shared id 4242, and versioned session
replacement.

Two limits remain, and they are different from the old ones:

- **The schema is a reconstruction.** `tests/fixtures/tracker-database-baseline.sql`
  carries the columns the tracker writes, rebuilt from the code, because no DDL
  for the season and tracking tables exists in this repository.
- **Still one process.** Two clients race each other against a real database
  with real row locking; two machines have not.

### The unresolved plate appearance, restated

It is still unresolved, and deliberately. What changed is that the pipeline now
records it: one row in `tracker_unresolved_plays` naming Red Noki, top of the
fifth, two pitches seen, and one run announced that could not be attributed.
`runs_scored` still holds 17 rows for an 18-run game, and the gap is now stated
rather than merely missing.

The correction test uses a **synthetic** result. Nobody here knows what Red
Noki actually did, and the fixture keeps that unknown honest.
