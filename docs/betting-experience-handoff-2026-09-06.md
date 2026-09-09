# Betting experience overhaul — handoff, 2026-09-06

Detailed bet receipts, a personal betting dashboard, odds-movement history and
prop research cards. Built on the existing board, live progress meters,
leaderboard and tracker-driven betting updates; wagering rules, accepted ticket
terms, pricing formulas and settlement semantics are unchanged.

The field/source map this was built from is `docs/betting-field-source-map.md`.
Read that first if a number here looks surprising — it records what the schema
actually retains.

---

## 1. Features and where to find them

Everything is in `BettingTab`, which serves both `/betting` (tournament) and
`/season/bets` (season) from the same component.

### Bet receipts — My Bets tab

Every ticket in the list is now a button that opens a dedicated receipt dialog
(`src/components/betting/BetReceiptModal.jsx`, model built by
`src/utils/betReceipt.js`). It carries:

- competition, market, matchup, target character and chosen outcome;
- accepted odds and accepted line, in their own **Accepted terms** block,
  separate from a **Current market** block that reports the board's price now;
- placement time, and score/inning at placement reported as *not recorded*
  (see §3);
- plain-language winning conditions ("Mario (Aidan) must finish with more than
  1.5 hits in this game.");
- a live progress meter for open tickets;
- the settled outcome, explained from the scoring facts — `Over 1.5 hits —
  finished with 2 hits.`; for a spread, the final score plus the adjusted result
  from the selected side (`Aces 3, Dukes 6. Dukes -1.5: 6 - 1.5 = 4.5 against 3
  for Aces.`);
- wager / potential net profit / potential total return / actual credited
  return, each labelled, with a status pill on the credited return;
- a settlement record built from the ticket and its ledger rows, with an
  explicit statement of what the database does not keep;
- links to the game, the target character and both team pages;
- an expandable odds history for the ticket's own market, with the accepted
  terms shown alongside for comparison.

### Personal dashboard — My Bets tab

`src/components/betting/MyBetsPanel.jsx`, aggregation in
`src/utils/bettingPerformance.js`.

Six stat tiles (open exposure, open potential return, settled net profit,
settled wagered, ROI, won/lost/void), a cumulative net-profit chart
(`CumulativeProfitChart.jsx`), a results-by-market table with sample counts, and
four filters (competition, market, status, placed-date range) plus Reset. The
ticket list paginates at 20.

### Odds movement history — board detail view and receipts

`src/components/betting/OddsHistoryPanel.jsx`, logic in
`src/utils/oddsHistory.js`, I/O in `src/utils/oddsHistoryPersistence.js`, loaded
by `src/hooks/useOddsHistory.js`.

Every market row in the detail view gains an **Odds history** disclosure showing
the first recorded and latest recorded observation, a timestamped table of
changes with per-side deltas, explicit line-change markers, and the game context
(inning and score) at each observation.

### Prop research — Batter Props / Pitcher Props tabs

`src/components/betting/PropResearchCard.jsx`, logic in
`src/utils/propResearch.js`. A **Research** disclosure beside each hit, home-run
and strikeout market: per-game average with its denominator spelled out, the
eligible sample count against the competition's completed games, total, a
compact recent-game strip linking to each game, the batter/pitcher identity and
matchup, and the live game's current total reported separately.

### Shared

`src/utils/bettingMarkets.js` now owns the market-language helpers
(`getTeamLabels`, `formatBetTitle`, `getBetProgress`,
`buildGameResolutionTotals`, …) that used to live inside `BettingTab.jsx`, so
the board, the ticket list and the receipt cannot describe the same market two
different ways. `BetProgressMeter` moved to `src/components/betting/`.

---

## 2. Financial definitions used

`calculatePayout()` returns **net profit**, not total return. Every figure below
follows from that.

| Term | Definition |
|---|---|
| **Wager** | `wager_dollars` — the stake. |
| **Potential net profit** | `potential_payout_dollars` — profit only. |
| **Potential total return** | wager + potential net profit. |
| **Actual credited return** | the `bet_settled:<type>:<side>` ledger row for that `bet_id`, and nothing else. |
| **Realized profit (settled ticket)** | won → +potential net profit; lost → −wager; void → 0. |
| **Settled net profit** | sum of realized profit over settled tickets. |
| **Settled wagered** | sum of wager over settled tickets (won + lost + void). |
| **At-risk wagered** | sum of wager over won + lost tickets only. |
| **ROI** | settled net profit ÷ at-risk wagered. Voids/pushes return the stake, so they are out of the denominator and reported separately. `null` (shown as `--`) when nothing is at risk. |
| **Win rate** | wins ÷ (wins + losses). Voids are not in the denominator. |
| **Open exposure / potential return** | wager, and wager + potential net profit, over open and pending tickets. |

**Chart basis: final ticket results, plotted by settlement time.** Each ticket
contributes exactly once, from its current status — which is what makes a
reversal followed by a resettlement count once rather than twice. The x-axis is
`resolved_at`. Both statements are printed on the panel, and the same basis is
applied to the tiles and the market breakdown.

**Credited vs calculated.** A ticket graded `won` with no settlement ledger row
shows "AWAITING CREDIT" and says nothing has been paid. A losing ticket with a
placement debit shows "NO CREDIT DUE" rather than a missing credit. A settlement
row that disagrees with the ticket's terms shows "AWAITING RESETTLEMENT" with
both numbers. A ticket from a competition whose ledger is not loaded shows "NOT
CONFIRMED HERE".

**Units.** Tournament ledger deltas are `points_change`, season deltas are
`dollars_change`. `BettingTab` mounts for one competition type at a time and
nothing totals across the two. Deposits, admin awards, sip purchases, transfers
and any ledger row with `bet_id = null` are excluded from every betting figure
by construction — the dashboard reads tickets, and the receipt reads only ledger
rows keyed to its own `bet_id`.

**Competition scope.** Tournament tickets load unscoped, so the competition
filter genuinely spans tournaments; season tickets are query-scoped to the
selected season, so it resolves to one there. The filter defaults to the
currently selected competition.

---

## 3. Historical fields that remain unavailable

1. **Score and inning at ticket placement.** No column has ever stored them, and
   placement goes through a server RPC (`place_tournament_bets` /
   `place_season_bets`) that accepts a fixed payload. The receipt prints "Not
   recorded" and explains it. It is never back-filled from the current or final
   game state, or from a nearby odds observation.
2. **True opening odds for existing games.** The history recorder starts when
   its tables exist; anything priced before that has no history at all. The
   panel labels the earliest row **first recorded**, never "open", and shows an
   empty state rather than inventing a curve.
3. **A reversal/resettlement log.** `syncLedger` rebuilds the settled row rather
   than appending, and a reversal deletes it, so only the current settlement
   state survives. The receipt shows that state plus the detectable signals — a
   ticket reopened on a finished game, a missing credit, a credit that does not
   match the terms — and states plainly that earlier settlements are not
   retained.
4. **Push vs void.** Both are stored as `status = 'void'` with
   `result_correct = null`. The dashboard counts them as one category and says
   so; the receipt distinguishes them where the final score makes it derivable
   (an exact landing on the line, or a tie).
5. **Participation vs a recorded zero.** A completed game with no rows for a
   character cannot be told apart from a game whose rows were never recorded.
   Prop research excludes those games from the denominator and reports the count;
   a receipt for a prop graded against a total of 0 says whether an appearance
   was recorded.
6. **Odds history for browser-priced games.** Only the automatic tracker sync
   records observations (see §5), so a game priced only by a scorekeeper's
   browser has none.

---

## 4. Migration prepared, and what waits on it

`supabase/migrations/20260906180000_add_odds_history.sql` — **written, not
applied.** It was not run against the linked project and no local database was
available to verify it against.

It creates `public.game_odds_history` and `public.season_game_odds_history`:
the priced fields (`line`, six odds columns, `predicted_probability`,
`is_locked`), the game context at the observation (`inning`, `is_top_inning`,
`away_score`, `home_score`, `game_status`), `source`, `change_key`,
`observed_at`, and `previous_observation_id` naming the observation each row
followed.

Duplicate suppression is structural: a unique index on
`(game_id, bet_type, coalesce(target_entity, ''), coalesce(previous_observation_id, 0))`
permits at most one successor per predecessor, so two concurrent writers that
read the same latest observation collide and only one lands, and "the first
observation of this market" is unique. A market that legitimately returns to an
earlier price later has a different predecessor, so real history is never
collapsed.

RLS is enabled on both tables: `select` for any authenticated user (these hold
public market data — no account, balance or ledger information), `insert`
restricted to commissioners and accounts with scorebook access, which is how the
tracker bridge signs in. Existing tables' RLS and permissions are untouched.

**Awaiting the migration:** odds-movement history — the recording in
`scripts/tracker_betting_sync.mjs` and the history panels in the board detail
view and the receipt. Until it is applied the app is fully usable: the reader
reports `unavailable`, the panel says "Odds history is unavailable — this
database does not have the odds-history tables yet… Betting is unaffected", and
the recorder logs once and skips. Everything else in this pass works today
against the current schema.

---

## 5. Where odds history is recorded, and why there

`scripts/tracker_betting_sync.mjs :: syncTrackerLiveOdds` — the writer the
tracker bridge drives. It already prices every market and compares the result
field-by-field against the stored row before persisting, so it is the one place
that knows what actually moved; it runs once per game rather than once per open
browser tab; and it is authenticated as an account that may write. It appends a
snapshot only when a market's priced values differ from the newest observation
already recorded for it, which is what makes a repeated sync — or a retry after
a timed-out write — append nothing.

The browser's own repricing path (scorekeeper, tracker-free game) deliberately
does not write history.

History is derived work: a missing table, a rejected duplicate or a failed
append is reported through the optional `logOddsHistory` callback and never
interrupts pricing or settlement.

---

## 6. Test and build results

All run locally, against in-memory fixtures. No Supabase call left the machine,
no bet was placed, no balance moved, no migration was applied.

| Command | Result |
|---|---|
| `npm run test:betting` | **162 pass, 0 fail** (was 77 — adds the four new suites) |
| `npm run test:betting-ui` | **26 pass, 0 fail** (was 5 — adds 21 browser tests) |
| `npm run test:tracker` | 462 pass, 0 fail |
| `npm run test:acceptance` | 35 pass, 0 fail |
| `npm run test:defense` | 31 pass, 0 fail |
| `npm run build` | ✓ built |

New suites:

- `tests/betting-receipts.test.mjs` (28) — money separation, credited vs
  awaiting credit vs no-credit-due vs mismatch, outcome explanations for every
  market including both sides of a spread and both push paths, accepted-vs-
  current odds, missing line and missing placement context, equal numeric game
  ids across competitions.
- `tests/betting-dashboard.test.mjs` (21) — totals, ROI denominators, reversal
  and resettlement counted once, undated settlements excluded from the curve and
  reported, empty and zero-settled datasets, filters including a timezone-safe
  date range, a 250-ticket history.
- `tests/betting-odds-history.test.mjs` (22) — drives the real
  `syncTrackerLiveOdds` for both competitions: first observation, an unchanged
  market writing nothing, a chained move with game context, a retry after a
  write that timed out, a missing history table, a rejected duplicate,
  tournament/season isolation under the same game id, plus the pure
  summarizers.
- `tests/betting-prop-research.test.mjs` (14) — participation as evidence, a
  real zero vs an unrecorded game, live excluded from the average, credited-hit
  rules, pitcher props, competition isolation, empty datasets.
- `tests/betting-experience-ui.test.mjs` (21) — real BettingTab in Chromium:
  dashboard figures, chart basis/keyboard readout/data table, market breakdown
  withholding an uncomputable rate, filters and rapid filter changes,
  pagination, four receipt scenarios, focus trap + Escape + focus restoration,
  a 390px mobile layout with no horizontal overflow, odds history including the
  line-move and unavailable-schema states, prop research including a check that
  the card never says "safe bet", "edge", "chance" or "likely", the empty
  dashboard, and four season-mode tests whose fixture also carries the
  tournament tables so a cross-competition leak would double every figure.

Independent expectations: every money figure asserted in the suites is a literal
worked out by hand from the ticket's accepted odds ($25 at +150 → $37.50 profit,
$62.50 return; settled net +$35.50 on $87 settled / $75 at risk → 47.3% ROI).
None is generated by calling the production payout helper.

**What the tests do not prove.** These are mocked clients. They do not
demonstrate database concurrency, the unique index in the migration, or the RLS
policies — those are properties of the schema and can only be verified once it is
applied. What they do show is that the client never depends on writing a
duplicate, and that it survives one being rejected.

---

## 7. Browser results and screenshots

Chromium, at 1280×900 desktop and 390×844 mobile, against local fixtures
(`node tests/browser/captureBettingScreenshots.mjs` regenerates these).

Checked: desktop and narrow-mobile layouts, keyboard navigation (chart arrow
keys, dialog Tab cycle), receipt focus management (close button focused on open,
focus trapped, Escape closes, focus returns to the ticket), the chart, filters
and rapid filter changes, loading and error recovery for odds history, and long
ticket lists with pagination. The receipt goes full-screen under 720px and
neither the page nor the dialog scrolls sideways; the breakdown tables scroll
horizontally rather than collapsing into single-character columns. Long names
wrap (`overflow-wrap: anywhere` on the receipt heading and value cells).

| | |
|---|---|
| Dashboard, desktop | `docs/betting-experience/dashboard-desktop.png` |
| Dashboard, mobile | `docs/betting-experience/dashboard-mobile.png` |
| Receipt — settled winner, credited | `docs/betting-experience/receipt-desktop.png` |
| Receipt — graded winner awaiting credit | `docs/betting-experience/receipt-awaiting-credit.png` |
| Receipt, mobile | `docs/betting-experience/receipt-mobile.png` |
| Odds history | `docs/betting-experience/odds-history.png` |
| Prop research | `docs/betting-experience/prop-research.png` |

Broken image placeholders in the board screenshots are the fixture's missing
team-logo and character-portrait assets, not a regression — the same harness
already showed them before this pass.

---

## 8. Not touched

Parlays, cash-out, new wager types, manual scorebook behaviour, the pricing
engine, and the rest of the site. `src/utils/oddsEngine.js`,
`src/utils/oddsContext.js` and `src/utils/betResolution.js` are unmodified by
this pass. No deploy, no push, no production migration, no wager, no live record,
no raw capture. Every other uncommitted change in the working tree was left
alone.
