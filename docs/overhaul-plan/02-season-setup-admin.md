# Batch 2 — Season Creation, League Settings & Admin

Primary files: `src/pages/SeasonCreate.jsx`, `src/utils/season.js`,
`src/pages/Admin.jsx`, `src/context/SeasonContext.jsx`,
`src/pages/SeasonBracket.jsx`, `src/utils/bracketProgression.js`,
relevant `supabase/migrations/*.sql`.

## 1. Season name validation

- [ ] **Require a non-blank season name.** `SeasonCreate.jsx` step 1
      currently allows creating a season with no name — add client-side
      validation (and ideally a `not null`/`check` constraint or trigger on
      `seasons.name` in a new migration) blocking blank names.
- [ ] **Enforce season name uniqueness** (case-insensitive). Currently two
      seasons can share a name. Add a check before insert (and consider a
      unique index, case-insensitive, e.g.
      `create unique index on seasons (lower(name))` in a new migration —
      confirm no existing duplicates would violate it first).

## 2. Setup flow navigation

- [ ] **Add a "Back" button to the tournament/season creation flow.**
      Currently there's no way to go back a step once in `SeasonCreate.jsx`
      (or the equivalent tournament creation flow in `TournamentCreate.jsx`,
      since QA note says "when making a tournament"). Add prev/next step
      navigation consistent with the existing step indicator.

## 3. Admin: season deletion UX

- [ ] **Fix delete-season redirect.** Currently deleting a season from
      `Admin.jsx` redirects to the home page. It should keep the user on the
      Admin page (just refresh the season list in place).

## 4. New: Edit Season (mid-season settings editing)

- [ ] **Add an "Edit Season" feature** accessible from Admin (or SeasonHome
      for commissioners) allowing editing of season rules while the season is
      in progress:
  - [ ] Games per matchup
  - [ ] Regulation innings (see #6 below)
  - [ ] Mercy rule on/off + differential (see #7 below)
  - [ ] Playoff format (single/double elimination) — note: changing this
        mid-regular-season should be allowed since playoffs haven't started
        yet; changing it AFTER playoffs have begun should probably be
        blocked or require explicit confirmation since the bracket may
        already be partially built (flag this as a decision point if it
        comes up — default to blocking changes once `season.status ===
        'playoffs'` or bracket games exist).
  - [ ] Season name (respecting validation/uniqueness from #1)
  - [ ] Persist changes to the `seasons` row; no schema change needed unless
        new columns are added for innings/mercy rule (see #6/#7).

## 5. Games-per-matchup validation

- [ ] **Reject `0` games per matchup** at creation time (client-side
      validation in `SeasonCreate.jsx`). Currently `0` is accepted and
      silently defaults to `3` somewhere downstream (likely in
      `src/utils/season.js` `buildRoundRobinSchedule` or a DB default) —
      find that silent fallback and replace it with an upfront validation
      error (minimum value: `1`).

## 6. Regulation innings setting (currently missing from UI)

- [ ] Migration `030_default_regulation_innings.sql` added a DB-level default
      for regulation innings, but **there is currently no UI to set this at
      season creation.** Add a "Regulation Innings" field to `SeasonCreate.jsx`
      step 1 (e.g. number input, default from migration 030's default, common
      values 3/6/9).
- [ ] Wire this field through to whatever column/table migration 030 added
      the default to (read that migration to confirm the column name/table —
      likely `seasons.regulation_innings` or similar).
- [ ] Make this field editable via the new "Edit Season" feature (#4). Changing
      it should only affect games that haven't started yet (don't retroactively
      change in-progress/completed games' recorded innings).

## 7. Mercy rule setting (currently missing entirely)

- [ ] **Add mercy rule settings to season creation**: a toggle (on/off) and a
      run-differential input (numeric). This does not currently exist in the
      schema or UI at all — will need:
  - [ ] New migration adding `mercy_rule_enabled boolean default false` and
        `mercy_rule_differential int` (or similar names — match existing
        naming conventions) to `seasons`.
  - [ ] UI fields in `SeasonCreate.jsx` step 1.
  - [ ] Wire into scorebook game-over logic (this is consumed in Batch 4 —
        the mercy rule check in `SeasonGameSessionProvider.jsx` /
        `gameRules.js` should read these season-level settings instead of any
        hardcoded value).
  - [ ] Make editable via "Edit Season" (#4), affecting future games only.

## 8. Home/away balancing algorithm (round-robin schedule generation)

- [ ] **Rewrite the home/away balancing logic** in `src/utils/season.js`
      (`buildRoundRobinSchedule` / circle-method implementation). QA found a
      1-matchup season where one team ended up with 4 home games (should be
      balanced).

  General rule to implement: for a team playing `N` total games, its home
  game count should be `floor(N/2)` or `ceil(N/2)` — i.e. as close to 50/50
  as possible:
  - N=5 → 2 or 3 home games
  - N=10 → 5 home games
  - N=15 → 7 or 8 home games

  Implementation approach: after generating the round-robin pairings (circle
  method), do a balancing pass — for each team, count assigned home games vs
  away games across all rounds; if a team's home count deviates from
  `floor(N/2)`..`ceil(N/2)`, flip the home/away assignment on one of its
  games (preferring a flip that doesn't break the OTHER team's balance) until
  all teams are within that range. This needs to work for `games_per_matchup`
  values of 1, 2, 3+ — the 1-matchup case is the one that's currently broken
  (likely because the existing "random flip" logic in `season.js:31`, per
  earlier code review, isn't constrained per-team).

- [ ] Add a unit test (or at least a manual verification script) that
      generates schedules for various team counts (4, 6, 8) and
      `games_per_matchup` values (1, 2, 3) and asserts every team's home game
      count is within `floor(N/2)`..`ceil(N/2)`.

## 9. Single-elimination bracket generation bug

- [ ] **Fix single-elimination bracket not filling.** When playoff format is
      set to single elimination, the bracket (`SeasonBracket.jsx` /
      `bracketProgression.js`) does not populate. Investigate the bracket
      template sync logic — it likely assumes double-elimination structure
      (winners/losers brackets + championship reset) and has a missing or
      broken code path for single-elim. Compare against the double-elim path
      (which works) to find the gap.
- [ ] Note: per the overall plan, actual playoff GAMEPLAY is moving to a new
      "Playoffs" tab in Schedule (Batch 6), but `SeasonBracket.jsx` remains as
      the read-only seeding/results visualization — so this fix is about the
      bracket DATA STRUCTURE/seeding being correctly generated and synced for
      single-elim, which both the visualization and the new Playoffs tab will
      depend on.

## 10. Regression checks (already passing, just confirm after changes)

- [ ] Double-clicking "Create" on season creation does not create duplicate
      seasons (already verified OK — just don't regress it while making the
      above changes).
