# Batch 5 — Betting: Full Sportsbook Rewrite

Primary files: `src/utils/oddsEngine.js`, `src/utils/oddsContext.js`,
`src/utils/betResolution.js`, `src/components/BettingTab.jsx`,
`src/pages/SeasonBetting.jsx`, `src/components/SettleUp.jsx`, plus new
migrations for liability/volume tracking if needed.

**Scope note**: per project decision, this batch is a FULL rewrite of the
odds engine — house edge/vig on all markets, dynamic volume-based line
movement, liability caps, and arbitrage-proofing — not just the targeted bug
fixes. This is the largest single piece of new system design in the overall
plan; budget accordingly and consider prototyping the pricing model
separately before wiring it into the UI.

---

## PART A — Fix Known Broken Odds Formulas (do first — these are needed
regardless of the rewrite's final shape)

- [ ] **HR prop odds overreact to a single recent game.** QA example: Yellow
      Toad hit a HR last game → now has +165 (implying ~38% chance) to hit
      another HR, which is far too generous for his power stat. Rebalance the
      HR prop formula's weighting:
  - PRIMARY weight: character's power/HR-rate stat (intrinsic rating)
  - SECONDARY weight: stadium HR factor (some stadiums favor HR more)
  - TERTIARY weight: recent/historical performance — should be a SMALL
    modifier, not capable of swinging odds from (whatever baseline) to +165
    after one game.
  - [ ] Audit `src/utils/oddsContext.js`'s historical-performance weighting
        and `src/utils/oddsEngine.js`'s blend — likely the historical
        component's weight is too high relative to sample size (n=1 game
        shouldn't move odds this much — tie weight to sample size more
        aggressively, e.g. shrink toward the power-stat baseline when n is
        small).

- [ ] **Run line scaling vs moneyline is nonsensical.** QA example: Kings
      favored ML -179 over Bompkins, but run line shows Kings -0.5 +139 —
      i.e., laying only half a run gives a HUGE plus-money payout, which
      doesn't track with a team favored by ~64% to win outright (a -0.5 run
      line is essentially "win the game by any margin", which should price
      very similarly to the moneyline, not swing to heavy plus money).
  - [ ] Fix the run-line pricing formula so a -0.5 spread prices close to the
        moneyline (same win condition, just minor vig difference).
- [ ] **Run line spread shouldn't always default to ±0.5.** Implement dynamic
      spread selection based on team power-rating differential — bigger
      mismatches should generate -1.5/-2.5 (or larger) lines with
      correspondingly different odds, smaller mismatches stay at ±0.5.
      Define a mapping from power-rating differential → spread value (e.g.
      thresholds at various differential bands).

---

## PART B — House Edge / Vig

- [ ] **Apply a consistent vig/overround to every market** (moneyline, run
      line, totals, all props). For a 2-outcome market, both sides' implied
      probabilities should sum to something like 105-110% (standard
      sportsbook range — pick a target, e.g. ~107%, and make it configurable).
- [ ] For multi-outcome markets (if any), distribute the vig proportionally.
- [ ] Centralize vig application as a single function/step in
      `oddsEngine.js` that runs AFTER the "fair" probability model produces a
      base probability for each side — i.e., keep the fair-probability model
      and vig application as separate, composable steps (fair model → apply
      vig → convert to American odds for display).

---

## PART C — Dynamic Line Movement Based on Bet Volume

- [ ] **Track total wagered per outcome per market** for each
      game/market — this can be computed on-demand from `season_bets` /
      `season_betting_ledger` (sum of wagers grouped by `game_id`,
      `bet_type`, `target_entity`/side) rather than a new table, if query
      performance allows; otherwise consider a summary table updated on each
      bet placement.
- [ ] **As money comes in on one side, move that side's odds worse (and the
      other side's odds better)** — implement a volume-weighted adjustment
      layer applied AFTER the vig-adjusted "fair" odds (Part B), so:
      `final_odds = vig_adjusted_odds + volume_adjustment`.
  - [ ] Define the adjustment function: e.g. a function of
        `(money_on_this_side - money_on_other_side) / total_market_liquidity`
        that shifts the line by some bounded amount. Start with a simple
        linear or sigmoid adjustment and make the sensitivity tunable.
  - [ ] **Cap maximum line movement** — define a max shift per market so a
        single large bet can't push odds to absurd values.
- [ ] **Market suspension/closing.** If a market becomes too lopsided (e.g.
      volume adjustment hits its cap and the market is still receiving
      one-sided action), allow the market to be marked "closed" — no new bets
      accepted on it, existing bets still settle normally. Surface this in
      the UI (e.g. "Line closed" badge, bet button disabled). QA explicitly
      signed off on this: "If odds need to be closed off because they don't
      work, that's fine because real sportsbooks do that."

---

## PART D — Arbitrage-Proofing

- [ ] **Ensure opposite-side odds can't be arbitraged.** After vig (Part B)
      and volume adjustment (Part C) are applied, add a validation/consistency
      check: for any 2-sided market, `1/decimal_odds_side_A +
      1/decimal_odds_side_B > 1` must always hold (this falls out naturally
      from vig > 0%, but volume adjustments could theoretically violate it if
      not careful — add an explicit check/clamp after volume adjustment to
      guarantee it never drops to ≤1).
- [ ] Add this as an automated check (unit test or runtime assertion in dev)
      that runs against generated odds for a sample of games/markets.

---

## PART E — Bet Liability Caps

- [ ] **Implement per-market liability limits.** Define a max payout
      liability the "house" (collective player pool / virtual bank) is
      willing to take on for a given market/outcome. Once total potential
      payout for one side exceeds this cap, either:
  - Suspend new bets on that side (preferred, consistent with Part C's
    closing mechanism), or
  - Apply a steep additional odds penalty to discourage further action.
- [ ] **Consider per-player limits** too, if relevant to how the economy
      works (e.g. a player's individual bet on a single market capped
      relative to their balance) — this may already be implicitly handled by
      balance checks (Part G), but confirm liability caps and balance checks
      are not redundant/conflicting.

---

## PART F — Settlement Timing Fixes ("confirm via next play")

General principle to implement across all live/in-progress props: **a bet
tied to a specific in-game event should not settle the instant that event
appears to occur — wait for the NEXT recorded play to "confirm" the game
state before settling.** This avoids premature/incorrect settlement when a
play is later edited/corrected (ties into Batch 4's Admin tab edit
capability).

- [ ] **First-inning-runs prop bug**: QA — a run scored in the 1st inning, but
      the bet stayed "pending" and was incorrectly VOIDED when the game ended,
      instead of paying out as a winner.
  - [ ] Fix the settlement trigger for this prop type:
    - If a run scores in the 1st inning: settle (pay out the "over"/correct
      side) once a play in the 1st inning AFTER the scoring play occurs (or,
      if the scoring play was the 3rd out of the inning, once the first play
      of the 2nd inning occurs).
    - If NO run scores in the 1st inning: settle (the "under"/no-runs side
      wins) once the first play of the 2nd inning occurs.
    - Either way, settlement should NOT wait until the entire game ends, and
      should NOT void due to "game ended" logic that doesn't apply to
      first-inning props.
- [ ] **Apply the same "confirm via next play" pattern to other live props**
      (hit props, K props, etc. — see Part G) wherever a prop could
      technically resolve mid-game.
- [ ] **HR prop reopen behavior — already correct, add regression test.** QA
      confirmed: undoing a HR does NOT un-pay the bet (a known gap), but
      redoing it does NOT double-pay (correct). Since "doesn't double-pay" is
      the safe failure mode, leave as-is for now, but:
  - [ ] Add a regression test/assertion documenting this known behavior so
        future changes don't accidentally make it WORSE (i.e., starting to
        double-pay would be worse than the current under-correction). If time
        allows, also fix the "undo doesn't un-pay" half — likely requires the
        reopen logic to track which HR-prop bets were settled by which
        specific PA, and reverse that specific settlement when that PA is
        edited/removed (ties into Batch 4 Part H's per-PA edit in the Admin
        tab).

---

## PART G — Live Prop Baseline Bug (hit/K props placed mid-game)

- [ ] **Critical bug: live prop bets use the player's TOTAL stat instead of a
      delta from bet-placement time.** QA example: "King K over 4.5
      strikeouts" placed when the pitcher ALREADY had 4 strikeouts. The bet
      should have been priced assuming he needs to get MORE strikeouts from
      this point forward (and odds should reflect how close he already is —
      QA suggests something like -500 instead of the -190 shown). Then, when
      he recorded his 5th strikeout (1 more after the bet), the bet should
      have paid out as a winner — but it didn't.
  - [ ] **Fix the odds calculation at bet-placement time**: when a prop is
        placed mid-game, the line/odds should account for the player's
        CURRENT progress toward the total (e.g., if the line is "4.5
        strikeouts" and the pitcher already has 4, the odds should reflect
        that he only needs 1 more — very likely to hit, hence much steeper
        odds like -500).
  - [ ] **Fix settlement to use the END-OF-GAME total, not a delta.** The
        prop line (e.g. "over 4.5 strikeouts") refers to the player's
        FULL-GAME total — so once the pitcher's season-long recorded
        strikeouts-in-this-game reaches 5, the bet should settle as a winner,
        regardless of when the bet was placed. The bug here is the bet didn't
        settle when it should have — find why (likely the settlement check is
        comparing against a stat snapshot taken at bet-placement time instead
        of the live/final total).
  - [ ] To summarize the correct model: **odds at placement = priced based on
        "how much more does this player need, given where they already are";
        settlement = based on the player's actual FULL-GAME total vs the
        stated line.** These are two different calculations and the bug
        appears to be in BOTH (wrong odds at placement, AND wrong/missing
        settlement check).
  - [ ] Apply the same fix to hit props (untested per QA, but "I assume this
        is the same for hits" — confirm and fix identically). Hit props DID
        correctly pay out when the player got a hit per QA — so hit props may
        only need the ODDS-AT-PLACEMENT fix, not the settlement fix. Verify
        both independently.

---

## PART H — Odds Lock Cutoffs

- [ ] **First-inning props (and similar time-boxed props) don't lock for new
      bets once their window closes.** Implement a lock check before accepting
      ANY new bet: for props with a defined "window" (e.g. first-inning props
      lock once the 1st inning ends), reject new bets on that prop for that
      game once the window has passed, with a clear UI indication (e.g. "This
      bet is no longer available").
- [ ] Audit all prop types for whether they have a meaningful lock cutoff and
      implement consistently (first-inning runs is the one QA explicitly
      found broken, but check HR/hit/K props too — e.g. should a HR prop lock
      once that player's final at-bat of the game has occurred?).

---

## PART I — UI/UX Fixes

- [ ] **"More Bets" button required to open full betting page** — currently
      tapping anywhere on a game card opens it. Change so the game card shows
      a summary (or just basic info) and ONLY the "More Bets" button
      navigates to the full betting page for that game.
- [ ] **Insufficient balance error message.** Currently placing a bet larger
      than your balance is correctly BLOCKED but shows NO message. Add small
      red error text (e.g. "Insufficient balance") near the bet input,
      auto-dismissing after a few seconds (e.g. 3-4s via a timeout that clears
      the error state).

---

## PART J — Apply Home/Away Source of Truth (depends on Batch 4 Part A)

- [ ] Once Batch 4 establishes the canonical home/away source and the
      "home team always on the bottom of the card" UI rule, apply it to all
      betting UI (game cards, matchup headers on the full betting page).
