# Real-game validation checklist

Everything in `npm run test:acceptance`, `npm run test:database` and
`npm run test:tracker` runs without an emulator, without Dolphin and without
Supabase. That is what makes them repeatable, and it is also exactly what they
cannot establish. This is the list of things that need a person, a controller
and a real game.

**Wario Stadium is first.** It is the only park in the archive whose single
capture has no paired tracker log
(`node scripts/audit_tracking_archive.mjs` names it), so nothing there has ever
been joined to a plate appearance, and the Catch Probability collection plan
asks for two Wario Stadium sessions before any park is repeated.

---

## Before the game

```
node scripts/audit_tracking_archive.mjs          # what the archive is missing
node scripts/catch_probability_gate_status.mjs   # what this game should try to produce
node scripts/next_calibration_game.mjs           # who should be on the field
```

If this game is meant to be part of the untouched final test, reserve it the
moment the capture exists and **before** any calibration run counts it:

```
node scripts/reserve_calibration_session.mjs --session <stem> --reason "held out for final test"
```

Reserving it afterwards is refused, and should be: holding out a session a
model has already been fitted on is leakage with extra steps.

## Starting the game

```
npm run game            # scripts/mss_autogame.mjs
```

Watch for these lines, in this order. Each is a different claim and none of
them implies the next:

| Line | What it actually proves |
|---|---|
| `bridge ready: signed in, game locked, holding the tracker. (N ms)` | the bridge finished its own startup |
| `game lease acquired (epoch N, owner ...)` | no other machine can write to this game |
| `match is live at a pitch reset` | autoteam saw a byte-exact pitch reset. `handed off anyway` instead means it timed out and the release was a judgement call |
| `gameplay is HELD at the pitch reset while both readers start` | the match is paused. **The opening play is not being thrown while the readers come up.** |
| `both readers were up N.Ns into the hold; play resumed` | the tracker `.exe` and the collector were both up before play restarted |
| `60 Hz capture CONFIRMED: N frames and N bytes on disk` | the collector sampled frames off a running game and flushed them |
| `startup record: data/tracker_startup/...json` | all of the above, and the log/capture pairing, written down |

**If the hold does not appear at all**, gameplay was not held and the readers
are starting against a live game — which is the race the hold exists to remove.
The startup record says which: `stages.gameplay_hold` is `readers_ready`,
`timeout`, `not_held`, or `null` for an autoteam that predates the hold.

**If the capture is not confirmed**, the game is still being scored — the
at-bat feed and the database do not depend on the collector — but it will have
no fielding, baserunning or throw measurements. The warning names the reason.
Check the bridge window before the first pitch; a collector that failed to
attach can be restarted, and a game replayed from its saved log later cannot
recover frames that were never captured.

### The gameplay hold, first game only

This is the one part of the startup sequence that has never run against a real
emulator, and there are exactly four things to watch for on the first game:

1. **Does `+` open the pause menu?** The press goes through `mss_input.py`'s
   input word like every other press in a run, but no test has ever driven it at
   a live game rather than at a menu. If it does not, the log says
   `MSS_AUTOTEAM_GAMEPLAY_RESUMED not_held` or the pause simply never appears on
   screen, and the fix is a controller-port or button-mask question rather than
   a sequencing one.
2. **Does the second `+` close it?** If play does not resume, close the menu by
   hand — the log warns and names the press — and say so, because it decides
   whether the resume needs a different button (B on "Continue") instead.
3. **Does the game clock stop while it is open?** Watch whether
   `60 Hz capture CONFIRMED` arrives DURING the hold or only after play resumes.
   Either is safe, because the hold is released on the collector attaching
   rather than on recording evidence — but which one is true is currently
   unknown and decides whether the attach marker was necessary.

4. **Does the tracker `.exe` announce that it hooked Dolphin?** The bridge now
   holds the game until the scoring reader says so, and publishes the answer in
   `<signal>.readers`. Open that file after the handoff and read `status`:
   `ready` is the scoring reader attached, `unconfirmed` means it is running and
   never said so within `TRACKER_SCORING_READY_TIMEOUT_MS` (30 s), and `failed`
   means it is not running at all and the game will not be scored. Every
   recorded session in the acceptance fixtures prints `Dolphin hooked.` on its
   first line within the same second, so `ready` in a fraction of a second is
   the expected answer — `unconfirmed` means the pattern needs widening for this
   build, and costs a 30 s hold rather than a lost game.

Note the held duration in `timings_ms.gameplay_held`. It is the first real
measurement of how long the collector takes to attach on this machine, and
`TRACKER_CAPTURE_ATTACH_TIMEOUT_MS` (20 s), `TRACKER_SCORING_READY_TIMEOUT_MS`
(30 s) and `--hold-timeout` (45 s) are guesses until it exists.

### The three things to confirm during the first inning

1. **Capture health** in the Live Tracker tab: frames climbing, missed frames
   at or near zero, calibration `confirmed`.
2. **Plate appearances landing**: the bridge logs `recorded PA #n` per at-bat.
3. **No unresolved plays piling up.** One is a real gap to correct later; a
   run of them means the parser is losing the play-by-play and the game is
   worth stopping.

## During the game

Flag anything wrong from the console rather than remembering it. For a stadium
hazard, use the structured form so it can be counted:

```
stadium_event=<objective id>; outcome=<what it did>; control=<yes|no>
```

The objective ids are in `scripts/review_stadium_events.mjs` (`PARK_EVENTS`),
and `node scripts/review_stadium_events.mjs --park <key>` says which of them
still have no labelled evidence. A note in prose is collected as a *candidate*
and counted as nothing.

**What a hazard label needs to be worth recording.** A hazard that fires after
the ball is dead moves no measurement — every one of the eleven DK Jungle
labels to date landed after the catch, the throw, or the ball leaving the park.
Label the ones that hit a fielder **while the ball is live and in their hands**,
and label at least one matched **control**: the same situation with the hazard
absent.

## After the game

```
node scripts/audit_tracking_archive.mjs --join --session <stem>
```

Expect `N/N joined`, no warnings, and a complete footer. Then:

| Check | Command | What it means if it fails |
|---|---|---|
| Startup record | `cat data/tracker_startup/<...>.json` | the handoff-to-frames gap for this game, and which log and capture belong together |
| Scoring reconciliation | `npm run audit:stats` | the game's own totals disagree with its rows |
| Unresolved plays | the At-Bat editor's banner for this game | one or more plate appearances the tracker watched and could not score |
| Duplicate keys | `node scripts/audit_tracker_duplicates.mjs --game <id>` | two rows share a durable key; decide which is right before any migration |

### Correcting an unresolved play

The At-Bat editor shows every open one at the top of the game with what the
tracker did see: the batter, the pitcher, the inning, the pitches, the runners
on base, and any run it heard announced and could not attribute.

1. Press **Record the result** on the play.
2. Supply the result and the runners from the video. Nothing is pre-filled with
   a guess.
3. Save. The correction is written under the tracker's own event key with
   `correction_source = 'operator'`, so replaying this game's log will find it
   and leave it alone.

**Do not** invent a result to make a total match. An unresolved play with a run
announced on it is exactly why a game's `runs_scored` can be one row short of
its scoreboard, and that gap is supposed to stay visible until someone has
watched the play.

---

## Still needs a real game — the open list

These are the claims the offline suites cannot make. Each names the observation
that would settle it.

### The capture-readiness handshake (workstream 1)

- **The collector's `[capture-ready]` line against a real Dolphin.** Every test
  writes that line from a fake child. The real one is printed after
  `--ready-frames` (30) frames have been sampled and flushed, and the frame
  counter only advances when the game clock does — but nobody has watched it
  fire.
- **How long the gap actually is.** `TRACKER_CAPTURE_READY_TIMEOUT_MS` defaults
  to 30 s for python starting, attaching to Dolphin, resolving the actors and
  locking the ball offset. Whether that is generous or tight on this machine is
  unmeasured; the startup record is where the first real number will land.
- **A collector that attaches to a PAUSED emulator.** The design says it should
  fail the READINESS check (no frames, because the game clock is not moving)
  while still printing `[capture-attached]`, which needs no clock. That split is
  what makes the gameplay hold possible at all, and it is the behaviour of the
  counter rather than a tested path.
- **The gameplay hold itself.** `+` opening and closing MSS's pause menu from
  the input word, whether the game clock stops while it is open, and how long
  the collector actually takes to attach. See
  [the gameplay hold, first game only](#the-gameplay-hold-first-game-only)
  above — four things to watch on the next real game, all of them unmeasured.
- **The scoring reader's own attach line.** The bridge holds the game until the
  tracker prints `Dolphin hooked.` (or a later line that only follows it) and
  publishes `status: ready|unconfirmed|failed|cancelled` in `<signal>.readers`;
  `tests/tracker-reader-handshake.test.mjs` drives every one of those outcomes
  against the real bridge with a scripted child. What no offline test can
  establish is that the tracker build in use prints that line promptly. Read
  `<signal>.readers` and the `MSS_AUTOTEAM_GAMEPLAY_RESUMED` line after one real
  launch.

### The database guarantees (workstream 2)

- **The migrations against production.** They have been applied to a real
  PostgreSQL 18 (PGlite) with a reconstructed schema, not to the real database.
  Run `node scripts/audit_tracker_duplicates.mjs` first: the unique indexes
  fail the migration if two rows share a key, which is deliberate, and the
  audit is how you find out before rather than during.
- **Two machines against one game.** The lease is exercised with two clients
  inside one process against a real database. Nobody has started a bridge on a
  second laptop against a game this one holds.
- **A lease lost mid-game.** The bridge now refuses every write of its own from
  that point — scoring, live state, game completion, unresolved plays and
  postgame ingestion alike — and the database refuses anything that somehow
  reaches it. What that looks like from the operator's side, with innings still
  in the buffers, has not been watched.
- **A replacement tracking version against production.** The activation moves
  the active pointer and every official link
  (`plate_appearances.tracking_session_id`, the runner and double-play
  `tracking_play_id`) in one transaction, tested against PGlite with a
  reconstructed schema. Production's `runner_opportunities` and
  `double_play_opportunities` carry columns the harness does not; the function
  only names the ones it writes, but the first real replacement is the check.
  A FIRST ingest now takes the same route, so this is the check for every
  ingest rather than only for a re-derivation.
- **`20260909120000_tracker_fenced_game_mutations.sql` against production.**
  The three functions build their statements from `information_schema.columns`
  intersected with the payload, so a column the harness does not carry is
  written only if production has it — but the harness's `games`,
  `season_schedule` and `tracker_live_stats` are reconstructions, and the first
  real live-state publish and game completion through them is the check. Until
  the migration is applied the bridge falls back to the ordinary updates and
  says so once per run; grep the bridge log for `Cross-machine exclusion on
  THOSE writes is NOT in force` to tell which path a game actually took.
- **A `derived_stage` left behind by a real failure.** The resume is exercised
  with an injected recomputation failure and an injected lost activation
  response. What a genuinely interrupted postgame ingest leaves on
  `tracking_sessions.quality` — and that re-running
  `scripts/ingest_player_tracking.mjs --session <stem>` finishes it rather than
  reporting `alreadyComplete` — has not been watched on a real capture.

### Corrections (workstream 3)

- **A correction against the real editor.** `npm run test:correction-browser`
  now drives the real page against intercepted Supabase endpoints: it opens the
  unresolved play, reads back the half-inning, the batter, the pitcher, the
  runners and the pitches the editor put on screen, picks a result and saves,
  and inspects the single transactional call that results. What it cannot do is
  supply the ANSWER: the fixture's own unresolved play (Red Noki, top of the 5th
  of the tournament recording) still has **no known result**, deliberately. Only
  video can settle that one, and the browser check uses a synthetic correction
  so the historical fixture stays honest.
- **A correction against a production game's real pa_number ordering.** The
  answer is inserted at its chronological slot and everything at or after it is
  renumbered, in one transaction. That has run against PGlite; it has not run
  against a game whose plate appearances people are looking at.

### Calibration (workstream 5)

- **214 more eligible opportunities and 25 more failures**, with at least 100
  opportunities and 20 failures in reserved test sessions. `npm run
  calibration:gates` reports the current distance every time.
- **A Luigi's Mansion session known to be at night**, and a Bowser Castle one,
  before either park's "no hazard state is captured" row can be read as a
  capture limitation rather than as hazards that were never on the field.
- **DK Jungle hazards while the ball is live**, labelled with the structured
  form and with matched controls. `BARREL_HIT_UNITS` is 2.5 and is still
  provisional — chosen from geometry, not measured — and the first session that
  records a barrel beside an operator's annotation calibrates it.
- **One session where a play does not join.** `dk_jungle-20260828T211713Z`
  reports 90 of 94 plays joined. It has never been examined; the four are worth
  a look before the next calibration run counts that session.
