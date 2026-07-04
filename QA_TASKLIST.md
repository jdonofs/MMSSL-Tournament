# Sluggers — Manual QA Checklist

All code fixes have been verified by code inspection. The items below are what still need a real browser and live app to confirm. Work top-to-bottom. Check off as you go.

---

## 1. Auth & Route Guards

- [ ] **Protected routes redirect when logged out** — Open a private/incognito window (not logged in). Type each of these URLs directly into the address bar. Every one should redirect to `/login`, not show any content:
  - `/admin`
  - `/draft`
  - `/roster`
  - `/betting`
  - `/stats`
  - `/bracket`
  - `/tournament/create`
  - `/season/create`
  - `/season/schedule`
  - `/season/roster`
  - `/season/bets`
  - `/season/trades`

- [ ] **RLS blocks non-commissioner writes** — Log in as a non-commissioner player. Open browser DevTools → Console. Run each of these and confirm they all fail with a permission/RLS error (not succeed silently):
  ```js
  // Replace YOUR_ID with your own player id (check the URL or network tab)
  supabase.from('players').update({ is_commissioner: true }).eq('id', 'YOUR_ID')
  supabase.from('balance_awards').insert({ player_id: 'YOUR_ID', amount: 999 })
  supabase.from('seasons').delete().eq('id', 1)
  ```

- [ ] **Two tabs, different players** — Log in as Player A in Tab 1, Player B in Tab 2. Make sure neither tab shows the other player's name/balance/team anywhere on the page.

- [ ] **Lock Trades with a future deadline already set** — In Admin, set a trade deadline for tomorrow. Then click "Lock Trades" again immediately. Confirm it moves the deadline to *now* (or at minimum doesn't silently no-op).

- [ ] **Recompute Pitching Stats is idempotent** — Click "Recompute Pitching Stats" in Admin. Check a pitcher's stat line. Click it again. Confirm the numbers didn't double.

---

## 2. Admin

- [ ] **Backup error surfacing** — If you can temporarily block a Supabase table (e.g. via a broken RLS policy or just observing a network failure), click "Download Backup" and confirm you get an error toast saying the backup is incomplete rather than a silent download with missing data. *(Low priority — hard to reproduce intentionally.)*

- [ ] **Resolve Waivers partial failure** — Run "Resolve Waivers" when there's at least one claim in the queue. Confirm it either succeeds fully with a success toast, or fails with an error toast that tells you to check the roster manually. No silent half-applied state.

- [ ] **PlayerTeamRow unsaved edits survive realtime** — In Admin, start editing a player's team name (type something, don't click Save). While your edit is in progress, have another player log in or trigger a realtime update from another tab. Confirm your typed text is still there.

---

## 3. Draft & Bracket

- [ ] **Generate Bracket is blocked on a completed bracket** — Finish a full tournament. Go back to the Bracket page and click "Generate Bracket." Confirm you get an error toast ("Bracket exists") and no duplicate games are created.

- [ ] **Bracket cascade on result flip** — Play out at least 2 rounds of a bracket. Then go back and flip an early-round result (change the winner). Confirm the downstream games update their participants to match the new result — they should not silently keep the old, now-wrong, teams.

- [ ] **Declare Champion picks the right player** — In a double-elimination bracket, have the lower-bracket winner win the Championship game (triggering a reset). Complete the reset game. Click "Declare Champion." Confirm it correctly shows the reset game winner, not the original Championship winner.

- [ ] **Double-elim Championship Reset invalidation** — Start and complete the Championship Reset game. Then go back and flip the original Championship result so a reset is no longer needed. Confirm the Reset game clears its participants (or is handled gracefully).

- [ ] **Out-of-order bracket completion + Champion** — Complete losers-bracket consolation games in a non-standard order. Click "Declare Champion" and confirm it identifies the correct player.

- [ ] **Pending-reveal pick survives a refresh** — *(Known limitation, not a bug — just verify behavior.)* Commissioner uses "Force Pick" to put a pick in pending-reveal state, then hard-refreshes the page. Confirm the pending state is gone and the commissioner has to re-do the force pick. No data corruption, just lost ephemeral state.

---

## 4. Roster & Characters

- [ ] **Free agent "Owned by" label** — On the Tournament Roster page, go to the Free Agents tab. Click into any undrafted character's card. Confirm the "Owned by" section says "Undrafted" (or similar) — not the name of whatever team you were looking at before.

- [ ] **Season Roster and Tournament Roster stay in sync** — Make a change on one (e.g. update a lineup). Check the other. They should reflect the same underlying data. *(This is a parity sanity check, not a specific bug.)*

---

## 5. Betting

- [ ] **Two-tab overdraw** — Log in as the same player in two browser tabs. Both tabs should show the same balance. In Tab 1, quickly place a bet that uses most of the balance. Before Tab 2 refreshes, place another bet in Tab 2 that would overdraw if both went through. Confirm the second bet either fails or the balance doesn't go negative.

- [ ] **Concurrent settlement from two tabs** — Open the same game in two tabs as commissioner. Mark the game complete in Tab 1. Immediately reload Tab 2 (which may also try to settle). Check the betting ledger — confirm there are no duplicate entries for the same bet. *(This is the main thing the DB unique constraint was added to prevent.)*

- [ ] **Full bet lifecycle** — Place a $10 bet at +150. Confirm your balance decreases by $10. Lose the bet. Confirm net is -$10. Place another $10 at +150 and win. Confirm the payout is +$15 (not double-counted, not missing).

- [ ] **Settle Up transaction vs displayed balance** — Complete a "Settle Up" between two players. Confirm the balance bar at the top of the page does or doesn't change — just be clear on which behavior is correct (Settle Up is for tracking IRL drink obligations, not the in-app balance).

- [ ] **$0 bet in slip** — Build a bet slip with one normal bet and one at $0. Confirm the slip is blocked and the error message makes it clear which entry is the problem.

---

## 6. Scorebook

- [ ] **HR RBI count** — Score each of these in a live game and confirm RBI = total runs scored on the play (batter counts):
  - Solo HR → 1 RBI
  - HR with 1 runner on → 2 RBI
  - HR with 2 runners on → 3 RBI
  - Grand slam → 4 RBI

- [ ] **Undo doesn't leave orphaned data** — Record 3–4 plate appearances in a live game. Undo the last one. Check that the pitch count and inning run totals are exactly as if that PA never happened. Undo again. Repeat a few times and confirm no drift.

- [ ] **Scoreless inning shows 0, not dash** — Score a clean 1-2-3 inning with no runs. Confirm the scoreboard shows `0` for that half-inning, not `-`.

- [ ] **Mercy rule fires once** — Trigger the mercy rule condition. Confirm the game ends cleanly exactly once — not double-triggered if someone also clicks "End Game" at the same moment.

- [ ] **Extra innings** — Play a game tied through regulation into extra innings. Confirm the scoreboard grid expands correctly and a walk-off ends the game at the right moment.

- [ ] **FC with runner scoring** — Score a Fielder's Choice (FC) with a runner on 3rd who scores on the play. Decide and confirm: does the batter get an RBI? *(The app currently awards it — confirm whether that's your ruling.)*

---

## 7. Season

- [ ] **Season creation rollback** — *(Hard to test without breaking RLS temporarily.)* If possible, trigger a failure partway through season creation (e.g. temporarily break permissions on `season_schedule`). Confirm no orphaned season row is left behind in the seasons list.

- [ ] **Playoff seeding change after regular season edit** — Start playoffs in a season. Go back and change a regular-season result that affects standings/seeding. Confirm the playoff bracket correctly updates (or at minimum doesn't silently keep stale seeds).

- [ ] **Standings with 0 games played** — View standings for a brand-new season before any games are played. Confirm nothing shows `NaN` or blank — all stat columns should show `0` or a sensible default.

- [ ] **Trade acceptance race** — Propose a trade involving Character X. Before accepting it, drop Character X via waivers in a second tab. Then go back and accept the trade. Confirm the trade doesn't silently "succeed" while Character X is already off the roster.

- [ ] **Completed season trade block** — Finish a season (status → completed). Navigate directly to `/season/trades`. Confirm you cannot submit a new trade proposal for a completed season.

- [ ] **Waiver priority for winless team** — Submit a waiver claim as a team with zero wins (or zero games played). Confirm where their priority lands — best or worst — and make sure it matches the ruling you intend.

---

## Notes

- All of the above bugs have been **fixed in code**. You are confirming the fixes work end-to-end in the live app, not finding new bugs.
- If something on this list fails, report which test and what you saw — the fix will be a targeted code change, not a re-investigation.
- Items marked *(hard to test)* are lower priority and can be skipped if they require temporarily breaking the database.
