# Statistics reconciliation — 2026-09-05

## Outcome

Official Stats, SeasonStats, character profiles, and team profiles now select the same
completed persisted game facts before aggregating them. A completed automatic tracker game
contributes once; active, reopened, excluded, abandoned, scheduled, and orphaned rows do not
contribute. Tournament and season identities are namespaced, so equal numeric game and PA ids
cannot cross-select facts.

This pass did not change tracker persistence or derivation, manual scorebook behavior, raw
captures, database records, migrations, WAR methodology, or betting. Experimental WAR remains
qualified. The Catch Probability/OAA decision remains **Baseline required (rejected for
activation)**.

## Authoritative inputs

| Quantity | Official input | Overlap and missingness rule |
|---|---|---|
| PA, AB, H, hit type, BB, HBP, K, TB, RBI, sacrifices | Persisted PA rows in a completed parent game | Repeated tracker contact keys select one durable PA. Unknown legacy results remain ambiguous and do not become an AB. |
| Runs | `runs_scored` / `season_runs_scored` | Run rows are authoritative within a game. `pa.run_scored` is only a per-game legacy fallback when no run rows exist. Runs are not forced to equal RBI. |
| Pitching outs, H/BB/R/ER allowed | Persisted pitching stints | Multiple and zero-out stints remain distinct. An absent measurement stays `null`; a stored zero stays zero. |
| Pitch total and final pitcher for a PA | Persisted pitches, selected by source-qualified PA identity | Every pitch counts once. The last ordered pitch identifies the pitcher after a mid-PA change. |
| E, PO, A and DER | Persisted PA attribution plus `game_fielders` / `season_game_fielders` | Only attributable evidence is credited. Team outs are not forced to equal putouts when the fielder chain is incomplete. |
| Live tracker summary | Not an official statistical input | Persisted rows win over an overlapping summary projection. |

All database reads use the repository's paginated `fetchAllRows` path rather than relying on a
PostgREST default page. Historical team ownership comes from each persisted performance row,
not the character's current roster.

## Confirmed mismatches and fixes

| Reproducer | Cause | Consumer fix |
|---|---|---|
| Completed and active rows for the same player | Stats/profile queries aggregated rows before checking parent game status | Added one shared completed-game selection boundary to Stats and the character/team hooks, including CharacterPage's auxiliary history/fielding hook. |
| Tournament game 7 / PA 1 and season game 7 / PA 1 | Bare numeric game and PA ids collided in career pitch/run selection | Source-qualified game and PA keys now drive selection and aggregation. |
| Two persisted PAs with one tracker contact plus a live summary run | Retries and display projections overlapped official rows | Natural-key deduplication retains one persisted fact, preferring the original durable PA identity so dependent rows remain attached. |
| A character moves from tournament player Alpha to season player Charlie | Current roster identity could be mistaken for historical ownership | Player/team totals filter persisted `player_id`; character totals span both without transferring the old line. |
| Season earned runs absent versus a recorded zero | Numeric coercion collapsed missing data into zero | Pitching totals and rates preserve field coverage and `null` when every contributing stint lacks the measurement. |
| A pitcher changes during a four-pitch PA | PA association could use a bare id or unordered pitch | Pitches are source-qualified and ordered; the final pitch participant owns the PA outcome while all four pitches remain counted. |
| Character/team/scope changed while prior queries were in flight | A slower prior response could repaint the new route | Stats and profile hooks use load generations and only publish/cache the newest response; stale identity is cleared on navigation. |
| Season advanced rows after game-id namespacing | Completed-game filtering compared source id `7` with normalized id `season-7` | The completed advanced-row gate now compares the season schedule's source id. |

`SeasonStats` delegates to `Stats`, so it uses the corrected selector directly.

## Independent fixture totals

The local snapshot hand-tallies 1B, 2B, BB, HBP, K, SF, SH, ROE, FC, DP, and an inside-the-park
home run. Expected values are literal JSON values; tests do not generate expectations with the
production calculator.

| Line | G | PA | AB | H | BB | HBP | K | TB | R | RBI | AVG | OBP | SLG |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Alpha, tournament 101 | 1 | 11 | 7 | 3 | 1 | 1 | 1 | 7 | 4 | 4 | 3/7 | 1/2 | 1.000 |
| Charlie, season 201 | 1 | 4 | 3 | 2 | 1 | 0 | 0 | 7 | 2 | 2 | 2/3 | 3/4 | 7/3 |
| Red Pianta, career | 2 | 6 | 5 | 3 | 1 | 0 | 1 | 9 | 3 | 4 | 3/5 | 4/6 | 9/5 |

Pitching literals are Magikoopa: 6 outs (`2.0`), 11 pitches, 3 H, 1 BB, 4 R, 4 ER,
1 K; and Peach: 1 out (`0.1`), 4 pitches, 2 H, 1 BB, 2 R, ER unknown, 0 K. The defensive
literal is 1 E, 5 PO, 4 A, and 4 conversions in 7 DER opportunities (`4/7`).

The recorded-game excerpt is `Monsters vs Fireballs - 2026-09-05 15-08-29.xlsx`, SHA-256
`6AA0CB067EE1DA98215AECA5822A49021E585C2A470070B3549602F86D8238A6`, Stats row 2. Its
header-mapped Red Pianta line is independently observed as 1 PA, 1 AB, 1 H, 1 HR, 1 R,
1 RBI, and 4 TB.

## Verification

- `node --test tests/stats-reconciliation.test.mjs ...`: 67 passed, 0 failed across reconciliation,
  expected metrics, defense/DER, experimental WAR, identity, and table behavior.
- `npm run test:defense`: 31 passed, 0 failed.
- Credential-free audit against the fixture: zero PA, pitching, or fielding issues. It reported
  the expected nonfinal exclusions and retry/summary deduplication in
  `tmp/stats-reconciliation-audit.json`.
- Playwright with intercepted read-only fixture data: Stats tournament/season/career,
  CharacterPage career and rapid character/scope switching, and TeamPage tournament/season all
  rendered the reconciled lines. Old character and team responses were deliberately held until
  after the next route rendered. The browser intercept rejects any non-GET request.
- `npm run build`: passed; 1,892 modules transformed.

## Records requiring separate authorization

No production database correction was established by this credential-free pass, so no repair or
backfill was run. The local season fixture intentionally retains an unknown ER measurement and an
ambiguous older PA rather than inventing values.

The previously documented raw-archive exceptions also remain unchanged: 22 non-JSON `NaN` rows
in `mario_stadium-20260904T000419Z.live.jsonl`, and incomplete final headers in
`bowser_castle-20260904T011909Z`, `mario_stadium-20260831T174649Z`, and
`yoshi_park-20260831T134815Z`. Any assertion about frames after their last recoverable play needs
video/operator evidence and a separately authorized repair. Wario Stadium still lacks a paired
saved tracker log. These limitations do not justify synthetic statistical attribution.
