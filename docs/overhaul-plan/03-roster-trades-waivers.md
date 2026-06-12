# Batch 3 — Roster, Trades & Waivers

Primary files: `src/pages/SeasonRoster.jsx`, `src/pages/Roster.jsx`,
`src/pages/SeasonTrades.jsx`, `src/utils/teamIdentity.js`,
`src/components/RosterLineupWidgets.jsx`, `supabase/migrations/*.sql`
(particularly `season_waivers`-related migrations).

**Reminder ([[feedback_season_tournament_parity]]):** `Roster.jsx` and
`SeasonRoster.jsx` must be kept in parity — any structural change to one
(e.g. removing bench concepts, mobile layout fixes) should be mirrored in the
other.

## 1. Remove all "bench"/inactive roster concepts

- [ ] **Sluggers has no bench/inactive roster — remove this assumption
      entirely.** Audit `SeasonRoster.jsx`, `Roster.jsx`, and any shared
      roster components for:
  - UI sections labeled "Active Roster" vs "Bench"/"Inactive"
  - Any `is_active` filtering/toggling logic on `season_roster` rows used to
    distinguish bench vs active
  - Any move-to-bench / move-to-active actions
  Remove these. A team's roster is simply its set of (up to 9) drafted/
  acquired players — no active/inactive distinction.
- [ ] Confirm the 9-player roster cap is still enforced after removing bench
      logic (QA confirmed this currently works — don't regress it).
- [ ] Check `season_roster.is_active` column usage across the codebase
      (queries, filters) — if it's now meaningless, either remove the column
      (migration) or leave it but stop reading/writing it (prefer removing if
      truly unused, to avoid future confusion — grep for all references
      first).

## 2. Mobile roster formatting

- [ ] **Fix character names rendering one letter per line vertically** on
      mobile for some teams. This is a CSS overflow/flex issue — likely a
      fixed-width container with `white-space` or `word-break` set
      incorrectly, or a flex column that's too narrow forcing each character
      to wrap. Identify the roster card/list component and fix so long
      character names wrap normally (word-level) or truncate with ellipsis,
      not letter-by-letter.
- [ ] Apply the fix to BOTH `Roster.jsx` and `SeasonRoster.jsx` (parity).

## 3. Free agent screen text

- [ ] **Remove the text "Immediate free-agent pickup."** from the free agent
      info/description text (location: free agent list/section in
      `SeasonRoster.jsx`).

## 4. Prevent dropping a team's captain

- [ ] **Add validation to block dropping the team captain** to free agency.
      Find the "drop player" action in `SeasonRoster.jsx` and add a check:
      if the character being dropped is the team's captain (however captain
      is identified — likely via `teamIdentity.js` mapping or a
      `season_roster`/`season_teams` flag), block the action with an error
      message.

## 5. Trades UI cleanup

- [ ] **Remove the "New Trade" button at the top** of `SeasonTrades.jsx` —
      QA found it confusing. Determine what the actual trade-proposal entry
      point should be (likely initiated from a specific player's roster card
      — "Propose Trade" on a player you want, or similar) and consolidate to
      that flow.
- [ ] **Add a "Pending Trades" view** — currently there's no way to see
      pending trade proposals at all. Add a section/tab showing:
  - Trades you've proposed (status: pending, sent to which team)
  - Trades proposed TO you (status: pending, awaiting your accept/reject)
  This should surface both `season_trades` (legacy table) and/or
  `season_trade_proposals`/`season_trade_proposal_teams`/
  `season_trade_proposal_moves` (the multi-team trade system from migration
  013) — confirm which table(s) `SeasonTrades.jsx` actually reads/writes
  today and build the pending view from that.

## 6. Trades should never expire

- [ ] **Remove all trade expiry logic.** Find any code that auto-expires a
      pending trade proposal after a time window (likely in
      `SeasonTrades.jsx`, `SeasonContext.jsx`, or a Supabase scheduled
      function/trigger) and remove it. Pending trades should remain pending
      indefinitely until accepted, rejected, or cancelled by the proposer.
- [ ] Check for any `expires_at`/`expiry` column on trade-related tables —
      if it exists and is now unused, either stop reading it or remove via
      migration (prefer leaving the column but ignoring it if removal is
      risky; note this as a judgment call for whoever implements).

## 7. CRITICAL BUG: waiver creation fails — missing `denied_team_ids` column

- [ ] **Fix immediately — this blocks ALL downstream waiver/free-agency
      testing.** Error observed: `Waiver creation failed: Could not find the
      'denied_team_ids' column of 'season_waivers' in the schema cache`.
  - The application code expects a `denied_team_ids` column on
    `season_waivers` that doesn't exist in the database.
  - [ ] Add a new migration (next sequential number after 034, i.e. `035_...`)
        adding `denied_team_ids` to `season_waivers`. Determine the correct
        type by reading how the code uses it (likely an array of team IDs —
        `int[]` or `jsonb`) — grep for `denied_team_ids` in the codebase to
        find the exact shape expected.
  - [ ] After adding the column, run through the full waiver flow end-to-end
        (drop → claim → commissioner resolves → roster updated) to confirm
        nothing else is broken downstream of this.

## 8. Regression tests — blocked until #7 is fixed

Once the `denied_team_ids` migration lands, work through this full list (all
were "cannot check" in QA due to the blocking bug above):

- [ ] Drop a player → appears in free agents, removed from team roster, does
      NOT simultaneously appear on another team's roster.
- [ ] Submit a waiver claim for a dropped player → appears as pending for
      commissioner.
- [ ] Submit competing waiver claims from two different teams for the same
      player.
- [ ] As commissioner, process pending waivers in Admin — highest-priority
      claim awarded, others denied.
- [ ] Awarded player gets new `season_roster` row with `acquired_via =
      'waiver'`, old row deactivated/removed appropriately (consistent with
      #1 — no "bench", so "deactivated" likely means the old row is simply
      gone/replaced).
- [ ] Denied claims show as "denied" to those teams (and confirm
      `denied_team_ids` is populated correctly as part of this — this is the
      column we're adding in #7).
- [ ] Waiver priority updates after a successful claim, if priority rotates.
- [ ] Verify the 7-day waiver hold window behaves as intended.
- [ ] Free agents list excludes any player on any team's roster.
- [ ] Post-waiver-period direct pickup (if that's an intended path) works
      without commissioner approval.

## 9. Other trade regression tests — also revisit once roster/waiver work lands

- [ ] Pending trade details show correct players on both sides.
- [ ] Accept a trade → both teams' `season_roster` update, transaction history
      logs it.
- [ ] Reject a trade → status becomes rejected, no roster changes, doesn't
      reappear as pending.
- [ ] Cancel your own pending trade proposal.
- [ ] 3-team trades: all three teams' rosters update correctly on acceptance.
- [ ] A player involved in one pending trade can't be double-traded via
      another simultaneous pending trade (or: accepting one auto-invalidates
      conflicting pending trades involving the same player — pick a consistent
      behavior and implement it).
- [ ] Trade deadline (last round complete, per `SeasonContext.jsx`
      `tradeDeadlinePassed`) blocks new trade proposals with a clear message.
- [ ] After the deadline, any still-pending trades remain visible/actionable
      (accept/reject) or are explicitly frozen — confirm actual behavior is
      intentional (trades themselves don't expire per #6, but NEW proposals
      should be blocked post-deadline).
- [ ] Transaction history shows correct date/time, players, and both team
      names for completed trades AND waiver moves.

## 10. Roster page general regression (revisit)

- [ ] Roster page reflects trades/waivers immediately after they occur
      (real-time subscription or refresh).
- [ ] Viewing another team's roster is read-only for non-commissioners.
