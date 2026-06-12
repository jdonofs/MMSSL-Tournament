# Batch 1 — Auth, Logged-Out Access Control, Global Nav & Mobile Scroll Pattern

Do this batch first. It establishes the scrollable-modal/popup pattern that
later batches will reuse, and locks down access control before other batches
add new protected UI.

## 1. Mobile sidebar / nav cleanup

- [ ] **Remove both login buttons from the mobile sidebar.** Only the top bar
      login button should remain. Find the mobile sidebar component (likely
      `src/components/Navbar.jsx` or a dedicated mobile nav/drawer component)
      and remove the duplicate "Login" entries.
- [ ] **Fix sidebar scroll so the logout button is reachable.** Currently the
      mobile sidebar can't be scrolled all the way down, so the logout button
      is unreachable/hard to press. Audit the sidebar's container for a fixed
      height + `overflow: hidden` (or missing `overflow-y: auto`) and fix.

## 2. Login page

- [ ] **Remove the text "Select your name to sign in."** from the login page
      player grid (`src/pages/Login.jsx`).
- [ ] **Mobile: scroll to the password field on tap.** When a player is
      selected and the password input section appears, the viewport doesn't
      scroll down to show it on mobile — user has to manually scroll. Add a
      `scrollIntoView({ behavior: 'smooth', block: 'center' })` (or similar)
      on the password field/container when `selectedPlayer` is set.
- [ ] **Change post-login redirect to the Season page, not Tournament.**
      Find where `navigate('/')` or similar happens after successful login in
      `src/pages/Login.jsx` / `AuthContext.jsx`, and change the default landing
      route to the Season home page (e.g. `/season` or whatever the Season
      home route is).

## 3. Session/auth loading-state flicker

- [ ] **Eliminate the "flash of logged-out screen" on refresh.** On page
      refresh while logged in, there's a brief flash of the logged-out state
      before the authenticated UI renders. In `AuthContext.jsx`, the
      `loading` state should gate ALL route rendering (not just specific
      components) until `supabase.auth.getSession()` + player resolution have
      both completed. Audit `App.jsx` / route guards to ensure they wait on
      `loading` from `useAuth()` before deciding logged-in vs logged-out UI.
- [ ] **Eliminate the "flash of no tournament/season data" screen** that
      appears before the real data loads, after the auth flash is fixed.
      Likely `SeasonContext.jsx` / `TournamentContext.jsx` have their own
      `loading` state that isn't being respected by the page that renders
      first — make sure pages show a loading spinner/skeleton until BOTH auth
      loading and season/tournament data loading are complete, rather than
      briefly rendering an "empty" state.

## 4. Logged-out access control (sitewide audit)

For each item below: the page/control must not be visible/reachable at all
when logged out — not just disabled/non-functional.

- [ ] **Stadium/game-start selection screen** must not be visible to
      logged-out users at all (currently visible, dropdown just doesn't work).
      Add an auth guard to whatever route/component renders this (likely
      reached from Schedule → click a scheduled game).
- [ ] **Stadium selector popup is not scrollable on mobile**, which can trap a
      logged-out (or any) user on the page since they can't reach a way back.
      Fix scroll on this modal/popup (see "modal scroll pattern" below) —
      this is needed regardless of the auth fix, since logged-in users hit it
      too.
- [ ] **Draft page: hide the Draft button entirely for logged-out users**
      (currently shown greyed-out). Wrap the button render in an
      `is_logged_in` check rather than just `disabled`.
- [ ] **Trade center: hide entirely for logged-out users.** Likely
      `SeasonTrades.jsx` or a trade section within `SeasonRoster.jsx` —
      gate the whole section/page behind `is_logged_in`.
- [ ] **Free agents "+" add icon: hide for logged-out users.** It's currently
      visible (and non-functional) — gate behind `is_logged_in`.
- [ ] **"My Bets": hide entirely for logged-out users.**
- [ ] **"Buy Sips": hide entirely for logged-out users.**

## 5. Reusable "scrollable modal/popup" pattern

Several batches below report popups/modals that don't scroll on mobile,
trapping the user or hiding action buttons (stadium picker, draft order,
trade builder, scorebook lineup popups, etc.). Rather than patch each one
individually:

- [ ] Identify the shared modal/popup component(s) used across the app (or
      note that there isn't one — multiple ad-hoc implementations).
- [ ] Establish (or fix) a single CSS pattern: modal container uses
      `max-height: 90vh` (or similar), `overflow-y: auto`, and a fixed/sticky
      footer for primary action buttons (e.g. "Start Game", "Save") so the
      action button is ALWAYS visible without scrolling, while the body
      content scrolls independently.
- [ ] Document this pattern (e.g. a shared CSS class like `.modal-shell`,
      `.modal-body`, `.modal-footer`) so later batches can apply it
      consistently instead of reinventing per-popup fixes.

## 6. Change password flow

- [ ] **Investigate whether a change-password flow currently exists.**
      `AuthContext.jsx` has `changePassword(newPassword)` calling
      `supabase.auth.updateUser({ password })` — confirm there's a UI entry
      point for it (e.g. on a profile/settings page). If no UI exists, add a
      simple "Change Password" form (current behavior is unverified per QA).
- [ ] Test: change password, log out, log back in with the new password
      (old password should fail).
