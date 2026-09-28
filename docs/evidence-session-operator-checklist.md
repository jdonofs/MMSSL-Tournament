# Evidence session — operator checklist

One 9-inning scripted game at Mario Stadium (day). About 60 minutes: 10 of
setup, 40–50 of play. Everything runs in PowerShell from `C:\Users\jdono\Sluggers`.
Nothing here writes to Supabase.

## Before the game (do not start a match yet)

1. **Label the two remotes** with stickers (e.g. `WHITE`, `BLACK`). Both on,
   both paired as real Wii Remotes (Dolphin ports 1 and 2). No Nunchuk.
2. Start Dolphin, boot MSS, stop at the **main menu**.
3. `python scripts/evidence_preflight.py live --seconds 10`
   While it samples, wave both remotes (no buttons needed). It must print
   `"passed": true`.
4. `python scripts/evidence_preflight.py map-remotes --assign "WHITE=Jason" --assign "BLACK=Jason" --out data/calibration/evidence-session-metadata.json`
   Hold **D-pad Up** on the remote it names (it only moves the menu cursor),
   touch nothing else, release when told.
5. `python scripts/evidence_preflight.py report` — every line must say `pass`.
6. Launch the capture (one line):

   ```powershell
   $env:TRACKER_EVIDENCE_PROFILE='comprehensive'; $env:TRACKER_SESSION_METADATA='data/calibration/evidence-session-metadata.json'; $env:TRACKER_CALIBRATION_EXCLUDED='1'; $env:TRACKER_CALIBRATION_EXCLUDED_REASON='scripted comprehensive evidence-expansion calibration'; $env:TRACKER_PARK='mario_stadium'; npm run tracker:preview
   ```

   It must print `comprehensive evidence capture; ports: 1=Jason (...), 2=Jason (...)`
   and `Supabase: HARD DISABLED`.
7. In a second window: `python scripts/mss_autoteam.py --lineup data/calibration/evidence-expansion-lineup.json`
8. On the rules screen confirm **9 innings, Stars ON, Mercy OFF, Items off**.
   Fix any of them by hand.
9. Decide which remote plays **Team Mario** and which plays **Team Peach**, and
   keep it that way all game. Write it down here: Team Mario = ______.
10. Start the match. In the console, wait for the capture bar to show
    **recording** and frames climbing before the first pitch. The collector log
    should show `comprehensive evidence profile: 113068 bytes/frame` and about
    60 frames/s with 0 missed.

## During the game

- Open `docs/evidence-session-cards.md`. **The console PA number is the card
  number.** Do the card's batter action and pitcher action on every pitch of that
  PA, aiming where the card says.
- At each half-inning, apply that half's **fielding condition** (fielding team)
  and **running condition** (batting team) from the second table.
- A star card with no star available: do the fallback and annotate.
- **Anything you did not do as planned, annotate immediately** in the console:
  category `input_mode`, note
  `plan=PA<n>; field=<batter|pitch|aim|fielding|running>; actual=<value|unsure>; pitch=<n>; reason=<text>`.
  `unsure` is a valid answer; a guess is not.
- Glance at the capture bar every half-inning: missed frames should stay under
  0.5 %. If the collector restarts, keep going — both files are kept.
- Do not pause for long in Dolphin, do not switch windows mid-pitch, do not swap
  remotes between people unless you annotate it (`field=control_change`).

## After the game

1. Let the game finish, then press **Ctrl-C once** in the preview window and
   wait for it to finish deriving.
2. `python scripts/evidence_preflight.py offline data/player_tracking/<stem>` — it
   must read every frame.
3. `python scripts/extract_input_evidence.py data/player_tracking/<stem>`
4. Fill `data/calibration/evidence-expansion-annotations-template-v1.json`
   (save a copy named for the session): mark `confirmed_no_deviation: true` only
   for PAs and half-innings you are sure of.

Recovery, output paths and what each file holds: `docs/evidence-capture-v3.md` §4.
