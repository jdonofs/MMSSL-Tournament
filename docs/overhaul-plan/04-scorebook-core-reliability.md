# Batch 4 — Scorebook Core Reliability, Home/Away Source of Truth & New Admin Tab

This is the largest and highest-priority batch. Primary files:
`src/pages/Scorebook.jsx`, `src/components/SeasonGameSessionProvider.jsx`,
`src/components/TournamentGameSessionProvider.jsx`, `src/utils/gameRules.js`,
`src/utils/economy.js`, `src/pages/SeasonSchedule.jsx` (or equivalent
Schedule page), `src/pages/SeasonDraft.jsx`, `src/pages/DraftPresentation.jsx`,
`src/utils/draftOrder.js`, `src/utils/teamIdentity.js`.

---

## PART A — Home/Away Single Source of Truth

- [ ] **Audit every place home/away is read or displayed**: Schedule page,
      Scorebook, Betting tab, Bracket, and any other game-listing component.
      Determine the canonical field: `season_schedule.home_team_id` /
      `away_team_id` (set at schedule generation, balanced per Batch 2 #8).
- [ ] **Fix the flip between Schedule and Scorebook.** QA confirms the home
      and away teams are displayed OPPOSITE of each other between the
      Schedule screen and the Scorebook/game view for the same game. Find
      which one has it backwards (likely the Scorebook/session provider is
      swapping `home`/`away` when mapping `season_schedule` rows to game
      state) and fix it to match `season_schedule.home_team_id`/`away_team_id`.
- [ ] **Establish UI rule: home team is ALWAYS displayed on the BOTTOM of a
      game card.** Apply this to:
  - [ ] Schedule tab game cards
  - [ ] Stadium/game-start selector popup
  - [ ] Scorebook header/scoreboard
  - [ ] Betting tab game cards
  - [ ] Bracket view
  - [ ] Any other game-listing component (search broadly for game card
        renderers)
- [ ] **Stadium picker popup: remove the incorrect "week" text.** It
      currently counts each game as a new "week" — just remove this text
      entirely from the picker.
- [ ] **Fix premature stadium-save bug.** Currently, selecting a stadium in
      the dropdown and then navigating away (without pressing "Start Game")
      still persists the stadium selection. Decide on intended behavior —
      most likely: stadium selection should only be written to
      `season_stadium_game_log` (or `season_schedule`) when "Start Game" is
      pressed. If the stadium picker write happens `onChange` of the
      dropdown, change it to only write on the "Start Game" button handler
      (store the selection in local component state until then).
- [ ] **Mobile: "Start Game" button unreachable due to scroll.** Apply the
      modal scroll pattern from Batch 1 Part 5 to this popup so the
      stadium/day-night selectors scroll independently and "Start Game"
      stays visible/reachable (sticky footer).

---

## PART B — Inning / Game-Over Logic

- [ ] **Fix "skip bottom of final inning if home team already winning"
      rule.** QA: home team still batted in the bottom of the 3rd (in a
      3-inning game) while already winning — should have ended the game
      immediately after the top of the 3rd. Find the inning-advance logic
      (likely in `SeasonGameSessionProvider.jsx` or a shared game-state
      reducer) and add the check: after the top half of the FINAL regulation
      inning (regulation innings now configurable per Batch 2 #6) completes,
      if home team's score > away team's score, end the game immediately
      (don't start bottom half).
- [ ] **Fix game-over message not displaying properly** when the game ends
      early (e.g., home team wins in the 3rd via the rule above, or via
      mercy rule). Find the "game over" UI trigger/modal and ensure it fires
      correctly for early-ending games, not just games that complete a full
      bottom-of-final-inning.
- [ ] **Extra innings**: re-test once the above is fixed — confirm tied games
      after regulation correctly continue to inning N+1, N+2, etc., with no
      bottom-half-skip applied incorrectly to extra innings (the skip rule
      only applies when the home team is winning, not tied).
- [ ] **Mercy rule**: re-test once Batch 2 #7 (mercy rule settings) lands —
      confirm the scorebook reads `seasons.mercy_rule_enabled` /
      `mercy_rule_differential` and ends the game immediately when the
      differential is met at/after the minimum inning.

---

## PART C — Runner Tracking & Run-Scoring Rules

- [ ] **2-out rule: no run scores unless the batter reaches base safely.**
      QA: with 2 outs, if the batter makes an out (ground out, fly out, etc.)
      with runners on, any runs that "would have scored" are currently being
      credited — they should NOT be. Fix the run-crediting logic so that when
      the 3rd out of the inning is recorded on a play, NO runs from that play
      count (regardless of where runners were headed), UNLESS the batter
      reached base safely (i.e., the out was not on the batter — e.g., a
      runner caught stealing for the 3rd out doesn't erase a run that scored
      on an earlier part of the same play... but for the common case
      described — batter makes the 3rd out — zero runs score on that play).
      This is the standard "time play" rule simplified to: 3rd out via the
      batter's own out (not a force/tag elsewhere) wipes out any runs from
      that play.
- [ ] **Persistent bug: runners not removed from bases at end of top
      half-inning.** QA reproduced this — after the top half ends (3 outs),
      base state should fully reset to empty for the bottom half, but
      sometimes runners remain. This needs a PERMANENT fix, not a workaround:
  - [ ] Find where base state is stored (likely a `runners` object/array in
        game session state, possibly mirrored in a `season_*` table or only
        client-side).
  - [ ] Ensure the inning-transition handler explicitly resets base state to
        empty as an atomic part of the same transaction/update that
        increments the inning and flips top/bottom — not a separate
        best-effort step that can race or be skipped.
  - [ ] Add a safeguard: when rendering the diamond/base state for a new
        half-inning, if `outs === 0` and it's the start of a new half-inning,
        force-render empty bases regardless of what the stored state says (a
        belt-and-suspenders client-side guard) WHILE also fixing the root
        cause server/state-side.

---

## PART D — Pitch Count / Strike/Ball Recording Reliability

- [ ] **Fix spam-Strike/Ball causing inaccurate count and stuck
      back-and-forth state.** QA: rapidly tapping "Strike" or "Ball" can
      desync the pitch count and cause the UI to flip between outcomes
      indefinitely, breaking the rest of the game.
  - [ ] Add a submission lock/debounce: disable the Strike/Ball/etc. buttons
        immediately on tap until the resulting state update is confirmed
        (optimistic UI is fine, but must be locked against re-entrancy).
  - [ ] Ensure the count (balls/strikes) is derived from a single source of
        truth (server state via Supabase, or a reducer) and that rapid client
        actions are queued/serialized, not applied to a stale local copy that
        then conflicts with a server response.
- [ ] **Fix flashing/flickering stats** — pitch count, pitcher stats, and the
      inning view all flash between old and new values until the user
      refreshes. This is very likely the SAME root cause as the spam-button
      issue: a race between an optimistic local update and a realtime
      subscription/refetch overwriting it with stale data, then the "real"
      update arriving and overwriting again (flash). Fix by:
  - [ ] Ensuring optimistic updates and realtime-subscription updates don't
        fight — e.g., tag optimistic updates with a version/timestamp and
        ignore incoming realtime updates that are older, OR simply don't
        apply optimistic updates for these fields and accept a brief
        round-trip delay (trade flicker for correctness if needed).
  - [ ] This flicker affects player stats display broadly too (noted under
        Stats in Batch 6) — fix here at the source (game session state
        updates) since that's likely the root cause across the app.

---

## PART E — Strikeout Looking vs Swinging

- [ ] **Audit whether the data model distinguishes strikeout-looking vs
      strikeout-swinging.** Currently play-by-play just says "struck out" for
      both. Check `season_plate_appearances` / `season_pitches` for an
      outcome-type field that could carry this distinction.
  - If the distinction already exists in the data but isn't surfaced: update
    play-by-play text to show "struck out looking" vs "struck out swinging".
  - If it doesn't exist: this is lower priority than the bugs above — at
    minimum ensure play-by-play text is consistent and not misleading. Adding
    full looking/swinging tracking can be deferred unless trivial.

---

## PART F — Errors

- [ ] **Errors must never credit the batter an RBI**, even if a run scores on
      the play. Find the run/RBI attribution logic and add: if the play
      outcome is "error" (reached on error), `rbi = 0` for the batter
      regardless of runs scored.
- [ ] **Default runner advancement on errors.** Currently the "where did
      runners end up" outcome screen does NOT pre-advance runners on an
      error — fix the default/prefill so that on an error, all existing
      runners are pre-filled as advancing exactly ONE base (the user can then
      manually adjust from there, e.g. for a throwing error that scores a
      runner from second).
- [ ] **Error attribution: credit the FIRST fielder to touch the ball.**
      Currently error attribution is unclear/incorrect. When the user selects
      "error" and a fielding sequence (e.g. which fielder(s) were involved),
      the error should be charged to the FIRST fielder in that sequence, not
      the last (or whichever is currently being used).
- [ ] **Fix runner-on-base-via-error disappearing bug.** QA: had a runner
      reach on error (on base at 1st), then a second runner also reached on
      error — only one runner ended up on base, the other vanished. Could not
      be reliably reproduced, but likely related to the same base-state
      management issue as Part C's "runners not removed" bug — i.e., the base
      state update logic for errors may be overwriting rather than merging
      runner positions. When fixing Part C's base-state handling, specifically
      add a test case: runner reaches on error (1st), batter then also reaches
      on error (1st, forcing previous runner to 2nd) — confirm both runners
      end up correctly placed (1st and 2nd).

---

## PART G — Double Play / Triple Play

- [ ] **Remove the "Double Play" and "Triple Play" buttons entirely.**
- [ ] **Auto-infer DP/TP from the outcome.** When the user records a play
      (e.g. ground out) and fills out the "where did runners end up" screen,
      calculate the number of outs recorded on the play from: (a) the batter's
      own out status (out/safe), and (b) how many runners are marked "out" on
      the runner-outcome screen. If the total outs recorded on this single
      play is 2 → it's a double play; if 3 → triple play. No separate
      button/flag needed — this is purely derived from the fielding sequence +
      runner outcomes selected.
  - Example from QA: groundout selected, bases loaded, fielding sequence
    6-5-4-3, and the runner-outcome screen marks 3 runners out → system infers
    triple play (3 total outs on the play).
- [ ] **Fix the runner-outcome PREFILL logic for force plays.** QA found: with
      bases loaded and a ground ball fielded by SS→3B→1B (6-5-4 type sequence,
      "to 2nd and 1st" per QA description), the prefill incorrectly marked the
      RUNNER GOING HOME as "out" — it should have marked the runners forced to
      2nd and 1st as "out" instead (the runner going home from 3rd on a force
      at a different base would actually score if not the front end of the
      relay... the key point is the prefill picked the WRONG runner(s) to mark
      out).
  - [ ] Rewrite the prefill algorithm to use standard force-play logic: given
        the fielding sequence (which bases the ball was thrown to, in order)
        and the pre-play base state, determine which runner(s) are forced at
        each base in the sequence and prefill THOSE as out, advancing other
        runners according to force rules (a runner is only forced to advance
        if the runner behind them is also forced).
  - [ ] This prefill doesn't need to be perfect for every exotic case (QA
        notes "this is okay because we can fix it manually") but should be
        CORRECT for standard force-play scenarios (bases loaded ground ball,
        runner on first ground ball, etc.) since those are the common cases.

---

## PART H — New Scorebook "Admin" Tab

- [ ] **Add a new tab/section to the Scorebook view called "Admin"**,
      visible only to users with scorekeeper privileges for that game
      (commissioner OR player with `scorebook_access` for that
      game/team — same authorization as existing scoring controls).
- [ ] This tab provides manual correction tools:
  - [ ] **Remove a base runner** (select which base, clear it)
  - [ ] **Add a base runner** (select base + player)
  - [ ] **Edit any plate appearance** — full edit of a previously-recorded PA
        (outcome, RBI, runs scored, fielders involved, etc.), with
        recalculation of downstream state (score, inning totals, stats) as
        needed — this likely reuses/extends the existing PA-reopen/edit logic
        from `betResolution.js`/`bracketProgression.js`'s reopen patterns, but
        scoped to a single PA edit rather than a full game reopen.
  - [ ] Any other mid-game/post-game correction deemed necessary (general
        "fix it" tools — keep this extensible).
- [ ] **Remove the existing tap-to-edit-PA interaction** from the main
      scorebook view (currently tapping a recorded PA opens an edit dialog —
      this caused UX issues, e.g. the character-card popup bug below). ALL
      editing moves to the new Admin tab.
- [ ] This Admin tab is the primary mechanism for fixing the runner-tracking
      bugs in Part C/F live during a game, until the root-cause fixes are
      proven reliable.

---

## PART I — Character Card Popup Bug

- [ ] **Fix delayed character-card popup when leaving the lineup view.** QA:
      tapping a character in the scorebook lineup view correctly does NOT
      immediately show the character card — but after navigating away from
      the lineup page, the character card THEN pops up unexpectedly. This
      smells like a click/tap handler that's deferred (e.g. via a timeout, or
      a state update that's queued and only resolves after a re-render
      triggered by navigation). Find the tap handler for characters in the
      lineup view and ensure any "show card" state is either handled
      synchronously and correctly suppressed, or fully cancelled/cleared on
      navigation away (cleanup in a `useEffect` return / unmount handler).

---

## PART J — Mobile Lineup View

- [ ] **Fix batting/pitching lineups not fitting on mobile screens** — the 9th
      character is cut off. Redesign the lineup display for small viewports:
      either a scrollable list (with the scroll pattern from Batch 1) or
      reduce row height/font size responsively so all 9 fit, or paginate.
      Apply to both batting and pitching lineup views in the scorebook.

---

## PART K — Fielding Stat Capture (data pipeline)

- [ ] **Errors, putouts, and assists are not being recorded into player stats
      at all** (errors DO show in the post-game box score, but not on the
      player Stats page; putouts/assists don't show anywhere in player
      stats). Audit the recording pipeline:
  - [ ] When a play is recorded with fielders involved (putout, assist,
        error), confirm `season_game_fielders` (or
        `season_plate_appearances`/`season_pitches`) is written with the
        correct fielder attribution for each role (putout recipient, assist
        credit(s), error charge per Part F).
  - [ ] Confirm the stats-aggregation query/view that powers the Stats page
        (Batch 6 will fix the DISPLAY side) actually reads from these
        records — if the aggregation query doesn't join/sum
        `season_game_fielders` data at all, that's the gap to close here.
  - [ ] This is the DATA CAPTURE half of the fielding stats fix — Batch 6
        covers aggregation/display. Both halves are needed for fielding
        stats to actually appear.

---

## PART L — Mii Color Removal

- [ ] **Remove all remaining Mii-color assumptions from draft/roster code.**
      Per clarified product reality: players draft a Mii character and can
      recolor it themselves in-game — Sluggers does NOT track/assign Mii
      color. Grep the current codebase (`src/pages/Draft.jsx`,
      `src/pages/SeasonDraft.jsx`, `src/pages/DraftPresentation.jsx`,
      `src/utils/draftOrder.js`, `src/utils/teamIdentity.js`, and any
      `season_roster`/`draft_picks` related code) for any "Mii color"
      selection UI, storage, or display, and remove it.
  - [ ] Note: migration `003_draft_pick_mii_color.sql` was already deleted
        from the migrations directory in a prior squash — confirm there's no
        leftover application code still trying to read/write a
        `mii_color`-style column (this would now be a silent no-op or error
        depending on how it's queried — check both).
  - [ ] Migration `033_draft_picks_replica_identity.sql` is recent — read it
        to confirm it doesn't reference Mii color either (likely unrelated,
        just confirm).

---

## PART M — Draft 9th-Player Safeguard

- [ ] **Investigate the intermittent bug where the draft completes with the
      9th player missing from multiple teams** (QA saw 4 teams missing their
      9th pick, one team missing 2 — on a SECOND attempt it worked fine, and
      attempting to reproduce via the "Skip" button didn't reproduce it).
  - [ ] Since it's intermittent and not reliably reproducible, prioritize a
        SAFEGUARD over root-cause-only: at the point where the draft is
        marked "complete" (all picks done), add a validation step that counts
        each team's `season_roster` rows and confirms every team has exactly
        9. If any team is short, do NOT mark the draft complete — surface an
        error to the commissioner identifying which team(s)/slot(s) are
        missing, and allow the draft to continue/resume for just those
        picks.
  - [ ] If time permits, investigate likely root causes: a race condition in
        the pick-advancement logic when multiple picks happen in rapid
        succession near the end of the draft (e.g. last few picks
        auto-advancing quickly), or an off-by-one in determining "draft
        complete" when roster sizes are uneven mid-draft.

---

## PART N — Network/Loading-State Reliability (Scorebook-specific)

- [ ] **Fix stuck "waiting for PA result" greyed-out state on bad
      connection.** Currently requires a full page refresh to recover. Add a
      timeout (e.g. 10-15s) after which the UI re-enables controls and shows
      a "something went wrong, try again" message, rather than staying
      greyed-out indefinitely. Also consider an automatic retry of the
      pending request before giving up.
- [ ] **Fix "nothing happens" when clicking into a game from Schedule on a
      slow connection.** Add an immediate loading indicator on tap (before
      navigation/data-fetch completes) so the user gets feedback. Also
      prevent the user from interacting with a half-loaded scorebook page
      (e.g. scrolling/leaving mid-load causing inconsistent state) — show a
      proper loading screen until the game session is fully initialized.
