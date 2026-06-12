# Batch 6 — Playoffs/Bracket Overhaul, Stats Fixes & Final Mobile Sweep

Primary files: `src/pages/SeasonBracket.jsx`, `src/utils/bracketProgression.js`,
`src/context/SeasonContext.jsx`, `src/components/SeasonGameSessionProvider.jsx`,
`src/pages/SeasonSchedule.jsx` (or equivalent), `src/pages/Stats.jsx`,
`src/pages/SeasonStats.jsx` (if separate), `src/utils/seasonPowerRankings.js`,
`src/pages/SeasonHome.jsx`.

---

## PART A — Playoffs Auto-Transition

- [ ] **Fix: season status never transitions to "playoffs" once all regular
      season games are complete.** Find the completion-check logic (likely in
      `SeasonGameSessionProvider.jsx`'s `onGameComplete`, checking if the
      completed game was the last of the final round — referenced in earlier
      code review at lines ~167-254) and fix whatever condition is failing to
      fire. After this fix:
  - [ ] `seasons.status` becomes `'playoffs'` (or equivalent) once the last
        regular-season game completes.
  - [ ] The bracket (per Part C below) becomes seeded/populated at this point.

---

## PART B — Standings Tiebreakers

- [ ] **Implement tiebreakers for final standings/seeding**, in this order:
  1. **Head-to-head record** between the tied teams (for this season).
  2. **Total season betting winnings** — whichever tied team has the highest
     cumulative net winnings from `season_betting_ledger`/settlements for the
     season gets the tiebreaker.
  - [ ] Implement this as a sort comparator used wherever final standings
        determine seeding (likely in `SeasonContext.jsx`'s standings
        computation, or directly in the bracket-seeding step).
  - [ ] If MORE than 2 teams are tied and head-to-head doesn't fully resolve
        (e.g. 3-way tie where each beat one and lost to another), fall through
        to the betting-winnings tiebreaker for the remaining ties.
  - [ ] Document the exact tiebreaker order in a code comment at the
        comparator, since this affects playoff seeding and will need to be
        explainable to league members.

---

## PART C — New "Playoffs" Tab in Schedule

- [ ] **Add a new "Playoffs" tab inside the Schedule page**, which:
  - [ ] Only appears once the regular season is complete (`seasons.status ===
        'playoffs'` or later, per Part A).
  - [ ] Shows all playoff games from the bracket (seeded per Part B) where AT
        LEAST ONE team has been determined (i.e., shows games progressively as
        earlier rounds complete, not just fully-resolved matchups).
  - [ ] **Home team can select their stadium early** — even before the
        opposing team/slot is determined (if the home team's slot is already
        fixed by seeding but the away team is still TBD pending an earlier
        round's result).
  - [ ] **Enforce sequential play**: a playoff game cannot be started until
        the PREVIOUS game (in bracket order) has completed. Determine "bracket
        order" from `bracketProgression.js`'s existing structure (round +
        position within round, processed in a defined order — e.g. round 1
        game 1 before round 1 game 2, all of round 1 before round 2, etc.)
  - [ ] Clicking a playable playoff game opens the Scorebook scoped to that
        game's playoff `stage` (reuse existing `SeasonGameSessionProvider`
        playoff-stage support — confirm Batch 4's reliability fixes apply
        equally here, no playoff-specific code paths were missed).

---

## PART D — SeasonBracket.jsx: Keep as Read-Only Visualization

- [ ] Per project decision, `SeasonBracket.jsx` remains as a READ-ONLY
      bracket/seeding visualization (seeding, results, champion display) —
      actual gameplay now happens via the new Playoffs tab (Part C).
- [ ] **Remove/disable the current broken tap-to-open-game interaction** on
      `SeasonBracket.jsx` (currently tapping does nothing — either remove the
      tap handler entirely, or repoint it to navigate to the Playoffs tab for
      that game if it's currently playable).
- [ ] Ensure `SeasonBracket.jsx` correctly displays:
  - [ ] Seeding (post Part B tiebreakers)
  - [ ] Results as playoff games complete (via the Playoffs tab)
  - [ ] Champion (`champion_player_id`) once the season completes

---

## PART E — Single-Elimination Bracket Fix (cross-reference Batch 2 #9)

- [ ] This was scoped in Batch 2 as a data/sync issue in
      `bracketProgression.js`. By this batch, confirm the fix from Batch 2
      makes the single-elim bracket display correctly in `SeasonBracket.jsx`
      AND drives the Playoffs tab (Part C) correctly for single-elim seasons.
      If Batch 2 didn't fully resolve it, finish here.

---

## PART F — Bracket/Playoff Regression Tests

Once Parts A-E land, work through this full list:

- [ ] Play and complete a bracket game via the Playoffs tab — winner advances
      to the correct slot in the next round; loser eliminated (single elim) or
      drops to losers bracket (double elim).
- [ ] (Double elim) Team that loses in winners bracket appears correctly in
      losers bracket against the right opponent.
- [ ] (Double elim) Play out losers bracket to determine the losers' finalist.
- [ ] (Double elim) Losers-bracket team wins game 1 of championship →
      reset/"if necessary" game created.
- [ ] (Double elim) Winners-bracket team wins championship outright → no reset
      game created/played.
- [ ] Reopen a completed bracket game from an earlier round — cascade reverses
      advancement in all dependent downstream games (advanced team removed
      from next round's matchup). Re-test the sequential-play enforcement from
      Part C still holds after a reopen (i.e., downstream games that were
      "played" get un-played/locked again).
- [ ] Re-complete a reopened game with a different result — new winner
      advances correctly; previously-played downstream games involving the old
      winner are flagged/reset appropriately.
- [ ] Win the final championship game — `champion_player_id` set, season
      status becomes `'completed'`.
- [ ] Champion displayed prominently on `SeasonBracket.jsx` and/or
      `SeasonHome.jsx`.

---

## PART G — Stats Page Fixes

- [ ] **Add "Runs Scored" and "Runs Allowed" to standings.** Derive from
      `season_inning_scores` (or running totals on `season_teams` if those
      exist/are added) — display alongside W/L/run-differential on the
      standings table.
- [ ] **Remove win/loss and pitching "record" stats from the BATTER stats
      tab.** These belong only on the pitcher tab. Find the batter stats table
      column definitions and remove any W/L/record columns.
- [ ] **Fielding stats display** (depends on Batch 4 Part K's data-capture
      fix): once errors/putouts/assists are correctly recorded, fix the
      aggregation query/view powering the Stats page to surface:
  - [ ] Errors (already shows in box score post-game — extend to season
        aggregate on Stats page)
  - [ ] Clean plays
  - [ ] Error rate
  - [ ] Putouts
  - [ ] Assists
  - [ ] Any other fielding stats the Stats page is intended to show
  - [ ] Verify with the same 2-3 game manual-tally approach used in the
        original QA pass: pick a player who recorded an error/putout/assist in
        a specific game and confirm it appears in their season totals.
- [ ] **Advanced metrics (wRC+, FIP-, etc.) returning NaN/Infinity.** QA
      suspects this is due to minimum-sample-size thresholds not being met.
  - [ ] Add a minimum-sample-size guard: if a player's PA/IP count is below
        the threshold the formula needs, display "—" (or "N/A") instead of
        NaN/Infinity.
  - [ ] Once sample sizes are sufficient (after a full season of testing data
        exists), verify the formulas themselves produce reasonable values —
        if they don't, debug the formula implementations in
        `src/utils/seasonPowerRankings.js` or wherever these are calculated.

---

## PART H — Final Site-Wide Mobile/Scroll Sweep

After all functional work across batches 1-6 is complete, do one dedicated
pass across all of these on a real mobile viewport (or devtools mobile
emulation):

- [ ] Schedule tab (including the new Playoffs tab)
- [ ] Scorebook (including the new Admin tab from Batch 4)
- [ ] Betting (game cards, "More Bets" full page, bet placement)
- [ ] Roster (Roster.jsx + SeasonRoster.jsx)
- [ ] Trades (pending trades view, trade builder)
- [ ] Bracket
- [ ] All modals/popups — confirm they follow the scroll pattern established
      in Batch 1 (scrollable body, sticky action footer, nothing cut off)
- [ ] Sidebar/nav (confirm Batch 1's fixes hold up after all other UI changes)

For each, confirm: no element is cut off, all action buttons are reachable
without awkward scrolling, and text doesn't overflow/wrap incorrectly (e.g.
the letter-by-letter roster name bug from Batch 3 — spot check it doesn't
recur elsewhere).

---

## PART I — Network/Loading-State Sweep (non-scorebook)

Batch 4 Part N covered scorebook-specific loading issues. Here, address the
broader site issue:

- [ ] **On slow connections, pages like Roster and Draft load "immediately"
      but show blank content** before data arrives. Add proper loading
      states/skeletons to these pages (and any others exhibiting this) so
      users see a spinner/skeleton instead of an empty page.
