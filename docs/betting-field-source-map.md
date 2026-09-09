# Betting field/source map

What the database actually retains for a ticket, a market, a ledger credit and a
live game, and therefore what a receipt/dashboard/history view is allowed to
claim. Compiled from `supabase-schema.sql`, the applied migration set in
`tmp/supabase_repair_apply/supabase/migrations/`, `src/utils/betResolution.js`,
`src/utils/oddsEngine.js` and `scripts/tracker_betting_sync.mjs`.

Nothing here was read from the live database — the project is linked to a remote
Supabase project and this pass never queried or wrote to it.

## Tables, by competition

Tournament and season are parallel table sets. Numeric `game_id` values collide
across them, so every key in this feature is `(<competition>, game_id)`, never a
bare number.

| Concept | Tournament | Season |
|---|---|---|
| Games | `games` | `season_schedule` |
| Tickets | `bets` | `season_bets` |
| Markets | `game_odds` | `season_game_odds` |
| Ledger | `points_ledger` (`points_change`) | `season_betting_ledger` (`dollars_change`) |
| Drink settle-up | `game_settlements` | `season_game_settlements` |
| Scoring facts | `plate_appearances`, `pitching_stints`, `runs_scored` | `season_*` equivalents |
| Odds history (new) | `game_odds_history` | `season_game_odds_history` |

## Ticket (`bets` / `season_bets`)

| Column | Meaning | Notes |
|---|---|---|
| `bet_type` | `moneyline`, `run_line`, `over_under`, `first_inning_run`, `hit_prop`, `hr_prop`, `k_prop` | |
| `target_entity` | `"Character (Player)"` for props, `null` for game markets | Built by `buildBettingEntityLabel` |
| `chosen_side` | `home`/`away`, `over`/`under`, `yes`/`no` | |
| `odds` | **accepted** American odds | Frozen at placement |
| `line` | **accepted** line | Frozen at placement; may be an alt line the board no longer shows |
| `predicted_probability` | model probability for side A at placement | |
| `wager_dollars` | stake | numeric(12,2) since migration 029 |
| `potential_payout_dollars` | **potential net profit**, not total return | `calculatePayout()` returns profit only |
| `status` | `open` / `pending` / `won` / `lost` / `void` | `void` covers both a push and a genuine void |
| `result_correct` | true/false, `null` for `void` | |
| `placed_at`, `resolved_at` | timestamps | `resolved_at` is **rewritten** on resettlement |
| `game_odds_id` | market row the ticket came from | Nullable; the market row is mutated in place afterwards |

**Retained placement context: `placed_at` only.** There is no
`score_at_placement`, `inning_at_placement`, or any snapshot of the board at the
moment of acceptance. Placement is a server RPC (`place_tournament_bets` /
`place_season_bets`) that accepts the payload columns above and nothing else.
A receipt must therefore report score/inning at placement as *not recorded*, and
must never back-fill it from the current game state or from a nearby odds
observation.

## Money definitions that fall out of the schema

`calculatePayout(stake, odds)` returns the **net profit**. `betResolution.js`
credits the settled ledger row as:

| Status | Placement debit exists | Ledger delta |
|---|---|---|
| `won` | yes | `wager + payout` (= total return) |
| `won` | no | `payout` (profit only) |
| `void` | yes | `wager` (stake refund = total return) |
| `void` | no | `0` |
| `lost` | yes | `0` |
| `lost` | no | `-wager` |

So:

- **Wager** = `wager_dollars`
- **Potential net profit** = `potential_payout_dollars`
- **Potential total return** = `wager_dollars + potential_payout_dollars`
- **Actual credited return** = the `bet_settled:*` ledger row, and it only equals
  the total return when a `bet_placed:*` row exists for the same ticket. With no
  placement debit the settled row is a net adjustment, not a return.

`syncLedger` is idempotent and *rebuilds* the `bet_settled:*` rows from current
ticket status rather than appending, and migration 047 adds
`unique (bet_id, reason)`. So a ticket has at most one placement row and at most
one settlement row no matter how many times it is settled, reversed
(`reopenGameBets` deletes the settled row) and resettled. Summing ledger rows by
`bet_id` therefore cannot double-count a resettlement.

Deposits, admin awards, sip purchases and transfers live in `balance_awards`,
`sip_transactions`, `sip_redemptions` and in ledger rows with `bet_id = null`.
Scoping every money figure to `bet_id != null` keeps them out of betting profit
by construction.

Units are per competition: tournament ledger deltas are `points_change`, season
deltas are `dollars_change`. `BettingTab` is mounted for exactly one competition
type at a time, so figures inside one mount share a unit. Nothing in this feature
totals across the two.

## Market (`game_odds` / `season_game_odds`)

`(game_id, bet_type, target_entity)` is unique (migrations 045/046) and the row
is **mutated in place** by every reprice. Columns: `line`, `odds_home`,
`odds_away`, `odds_over`, `odds_under`, `odds_yes`, `odds_no`,
`predicted_probability`, `is_locked`, `updated_at`, plus the optional
`prop_current_count` / `prop_lambda` / `prop_variance_multiplier` from migration
041 (`oddsPersistence.js` strips them if absent).

`updated_at` is the only temporal field, and it is overwritten. **No prior value
of any market is retained anywhere.** `odds_calibration_log` stores the odds a
*ticket* was graded at, not the market's path.

Conclusion: durable odds history does not exist. It has to be added.

## Live game state

`games.live_state` / `season_schedule.live_state` (jsonb: `inning`, `isTop`,
`outsInHalf`, `runners`) plus `current_inning`, `is_top_inning` and the score
columns (`team_a_runs`/`team_b_runs`, `away_score`/`home_score`). All are
mutated in place; there is no historical series. `tracker_live_stats` /
`season_tracker_live_stats` hold the current tracker publication only.

## The authoritative automatic update path

`scripts/tracker_betting_sync.mjs :: syncTrackerLiveOdds` is the writer the
tracker bridge drives. It loads the game, rebuilds the odds context, prices every
market, compares against the stored rows field-by-field (`oddsValuesMatch` over
`LIVE_ODDS_FIELDS`) and persists only genuine changes through
`persistOddsRowsWithFallback`. That comparison is exactly the "meaningful change"
test an odds-history recorder needs, which is why the snapshot writer is attached
there and not to the browser.

`BettingTab` also reprices in the browser, but only for a scorekeeper on a game
no tracker owns, and every open tab does it independently. It is not a
trustworthy historical recorder and does not write history.

## Scoring facts available for prop research

`plate_appearances` / `season_plate_appearances` (`result`, `is_error`,
`character_id`, `player_id`, `game_id`, `inning`) and `pitching_stints` /
`season_pitching_stints` (`strikeouts`, `innings_pitched`). A hit is
`isCreditedHit()` (`src/utils/creditedHit.js`), a home run adds
`result in (HR, IPHR)`.

Participation is evidenced only by the presence of rows: a character with no PA
row in a game either did not bat or the game was never recorded. There is no
"appeared but went 0-for" marker distinct from "was not in this game", so a game
with no rows for a character must be **excluded** from the denominator, never
counted as a 0.

## What remains unavailable after this pass

- Score and inning at ticket placement (never stored; would need new ticket
  columns and a change to the placement RPC).
- Any market's value before the first snapshot written by the new recorder — in
  particular, true *opening* odds for every game that already exists.
- Reversal/resettlement history as an event log. The ledger keeps the current
  settled row only; a reversal deletes it. What a receipt can show is the current
  settlement state plus whether it is confirmed in the ledger, not a timeline of
  past settlements.
