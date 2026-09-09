# Launcher orchestration hardening — 2026-09-05, extended 2026-09-08

The 2026-09-05 pass fixed nine seam defects and named one thing it could not
do: prove the 60 Hz collector was recording before the first pitch. The
2026-09-08 pass closed *that* — see
[the remaining gap, closed](#the-remaining-gap-closed--2026-09-08) — and then
had to be corrected: proving the capture was recording is not the same as
protecting the opening play, and the sequence that proved it did not hold
gameplay at all. See
[holding the opening play](#holding-the-opening-play--2026-09-08).
Everything between is the original write-up, unchanged.

## Outcome

This pass worked only on the seam between processes in `scripts/mss_autogame.mjs`
and the startup contract it holds with `scripts/export_mss_lineup.mjs`,
`scripts/mss_autoteam.py` and `scripts/live_tracker_bridge.mjs`. It fixed nine
confirmed defects, added deterministic launcher tests around the real
orchestration code, and left parsing, persistence, betting, statistics, UI and
the manual scorebook alone.

Nothing in this pass launched Dolphin, operated the emulator, started a writing
bridge, touched Supabase, overwrote `lineup.json`, or read or wrote a raw
recording. Every child process was a fake, every database was a stub or an
in-memory fake, and every file written by a test lives under
`tmp/launcher-hardening-20260905` or a per-test temp directory.

## What each readiness signal actually proves

The launcher used to have one signal and treat it as proof of everything. There
are five distinct states, and the run now says which one it is in:

| State | Proven by | Who can see it |
|---|---|---|
| **spawned** | `spawn()` returned a child | launcher |
| **initialised** | `<signal>.ready` exists | launcher |
| **game live** | `MSS_AUTOTEAM_MATCH_LIVE confirmed` on autoteam's stdout | launcher |
| **attached** | the tracker `.exe` started | bridge only |
| **recording** | `<signal>.recording` says frames were sampled AND flushed | launcher (2026-09-08) |
| **the play is held** | `MSS_AUTOTEAM_GAMEPLAY_HELD` / `..._RESUMED <reason> <seconds>` | launcher (2026-09-08, corrected) |

**spawned proves nothing else.** The bridge signs in, resolves the game, takes
its game lock, loads the roster, repairs live state, starts the preview server
and the xlsx watcher before it can hold the tracker, and any of those can fail.
It now writes `TRACKER_LAUNCH_READY` (atomically, temp file plus rename)
immediately before `waitForLaunchSignal()`, which is exactly the point where
"initialised" becomes true. The launcher will not touch the emulator until that
file appears or the bridge dies.

**game live is a two-valued claim.** `wait_for_match_live()` prints its marker
whether or not it saw a pitch reset — the timeout branch hands off deliberately,
because by then both players have confirmed and refusing would strand a run that
did everything asked of it. But the byte-identical line meant the launcher
announced "match is live" for runs in which nothing of the kind had been
established. The marker now carries `confirmed` or `unconfirmed`; a bare token
(an older `mss_autoteam.py`) is read as `unconfirmed`, which is the reading that
cannot overstate what happened.

**attached is still invisible to the launcher, and recording no longer is.**
See [the remaining gap, closed](#the-remaining-gap-closed--2026-09-08).

## Confirmed defects fixed

Each was reproduced before it was changed. The reproductions are in
`tmp/launcher-hardening-20260905/`.

1. **The handoff decision raced the child's exit.** The autoteam promise
   resolved on `exit` alone, but node's `exit` fires when the process is gone,
   not when its stdout pipe has been drained — and the marker is the last line
   autoteam prints. `repro_orchestration.mjs` shows the marker printed and
   `handedOff=false` read a moment later. On the failure path that killed a
   bridge that should have kept running. The promise now settles only when the
   exit code and the end of stdout have both arrived, with a bounded 2 s grace
   in case a grandchild is holding the pipe open.

2. **A python that could not be spawned leaked the bridge.** `child.on('error',
   reject)` went straight past `stopBridge()` and `cleanupSignal()` to the
   top-level catch. `repro_orchestration.mjs` shows the bridge still running
   with nobody watching it: it would hold the tracker for
   `TRACKER_LAUNCH_SIGNAL_TIMEOUT_MS` (300 s) and then launch it anyway, against
   a menu — the exact failure the wait exists to prevent. Everything past the
   first child now leaves through one `finally` that owns cleanup.

3. **Supabase was mutated before the lineup was validated.** `claimGame()` ran
   before `exportLineup()`, so a game with eight batters, a doubled-up fielding
   position, an unmapped Mii or no stadium was left flipped to
   `stats_source='tracker'` with no lineup exported — scored on the site by a
   tracker that was never going to run. The export now comes first.

4. **An id held by both tables was resolved by search order.**
   `repro_overlap.mjs` shows `resolveTrackerGameTarget(12)` silently returning
   the tournament game and never mentioning the season game with the same
   number. The picker, the exporter and the bridge each flipped that coin
   separately, so the list could show one fixture and the export apply another.
   A shared id is now an error naming both tables; `--table` answers it and
   travels as `MSS_GAME_TABLE` and `TRACKER_GAME_TABLE`.

5. **`MSS_AUTOTEAM_MATCH_LIVE` meant two different things.**
   `repro_marker.py` shows the timeout branch printing the identical line.
   Now `confirmed` / `unconfirmed`, reported as such.

6. **Autoteam exiting 0 without the marker was silent.** The launcher fell
   through to waiting on the bridge, which held the tracker until its timeout
   and then launched it against an unknown screen. That is now a hard failure:
   the bridge is stopped while there is nothing underneath it to orphan.

7. **Numeric options became NaN and changed behaviour.** `--game abc` and
   `--game 0` are both falsy after `Number()`, so they fell through the
   `if (options.gameId)` test and silently opened the interactive picker;
   `--limit -1` reached `listed.slice(0, -1)` and quietly hid the last game.
   Both are validated at parse time now.

8. **`process.exit()` straight after a Supabase call aborted node.**
   `crash_probe.mjs` reproduces it: undici's sockets are still closing, and
   exiting into that on Windows aborts with
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76`
   and exit code `0xC0000409` — so a run that meant to report a clean failure
   reported a crash, and anything reading the exit code got neither 0 nor 1.
   The launcher, the exporter and the bridge now set `process.exitCode` and let
   the loop drain, with an unref'd 2 s backstop.

9. **An occupied preview port could be reported as free.**
   `assertApiPortIsFree()` swallowed every error except its own, so a port held
   by a non-HTTP listener, or by a server that did not answer within 750 ms, was
   read as available. The occupant was then discovered by the backend failing to
   bind, which surfaced as "Tracker backend exited before startup" and named
   neither the port nor the reason. A TCP probe now settles occupancy first, and
   the HTTP request is only used to say *what* is there.

Two smaller corrections went with them: `--dry-run`'s help text claimed it
"touches neither the game nor Supabase" while reading Supabase throughout, and
`--no-tracker` passed `--wait-for-live` and blocked up to three minutes for a
handoff that had nowhere to go.

## Ownership and cleanup

- **Duplicate launches.** The bridge's own game lock (`mss-tracker-<type>-<id>.lock`)
  is now *read* by the launcher before its first external mutation. A second run
  against a game a live bridge owns is refused before the export, before the
  claim, and before any menu is driven. A lock whose pid is gone is a crashed
  bridge, not a running one, and does not block anything.
- **No process is ever matched by executable name.** Only children this
  invocation spawned are killed, and only the lock file's own recorded pid is
  consulted.
- **Cancellation.** `SIGINT`/`SIGTERM` now kills the python child this process
  owns, stops the bridge only while it is still pre-handoff, and exits 130
  rather than 0. Past the handoff the bridge is deliberately left alone: on
  Windows `kill()` is a `TerminateProcess`, which would skip the bridge's own
  handler — the one that flushes the capture and drains the writes.
- **The signal file is not deleted out from under a waiting bridge.** The bridge
  polls for it every 250 ms; clearing it inside that window would strand the
  bridge for its whole five-minute timeout. It is now removed only once nothing
  is waiting on it.
- **An orphaned bridge gives up.** `TRACKER_LAUNCH_OWNER_PID` tells the bridge
  whose handoff it is waiting for; if that process disappears before the signal
  arrives, it stops instead of timing out and launching a tracker into a menu.
  Measured on this machine (`orphan_probe.mjs`), a hard-killed launcher takes its
  child tree with it, so no bridge is orphaned here — but that is an observation
  about this environment, not a guarantee the launcher can make, which is why
  the guard exists at the other end as well.

## Already correct — recorded, not changed

- The signal file's per-run name (`pid` + timestamp) already made a stale file
  from a previous launch effectively impossible. A check was added so the case
  is reported rather than merely improbable; the naming was left alone.
- The bridge treats an occupied preview port (4317) as non-fatal and says so.
  That is the right call — its job is the database — and it was not touched.
- `tracker_preview.mjs` already refused to move off an occupied UI port
  (`strictPort: true`) and already treated a backend that exits 0 without
  serving as a startup failure.
- The bridge's game lock already refused a second local bridge and already
  recovered a lock left by a crashed one.
- Argument forwarding after a bare `--` was already exact, including values
  containing spaces.
- `--dry-run` already made no database writes.

## The remaining gap, closed — 2026-09-08

**The launcher can now say whether the 60 Hz collector was writing frames
before the first pitch, and it says so from evidence rather than from a pid.**

### Why the obvious signals were not evidence

The collector's pid exists the instant `spawn()` returns, before python has
imported anything. Its first `[live-status] recording` line is printed before
the capture loop reads a single frame. Its `.bin` exists as soon as the file is
opened, and is four bytes of magic at that point. None of those distinguishes a
collector that is recording from one attached to a paused emulator — and the
whole cost of getting it wrong is the opening pitch.

Two facts together are evidence, and the collector now prints both:

- **Frames it actually sampled.** The frame counter only advances when the
  game's own clock does, so a non-zero count is itself proof that the emulator
  is running and being read.
- **Bytes on disk.** At the readiness threshold the collector performs one
  `Z_SYNC_FLUSH`, flushes the file, and reads its size back from the
  filesystem. Frames counted with nothing written is a buffered writer, which
  would be the same overstatement the pid was, so both halves are required and
  the failing half is named.

`collect_player_tracking.py` prints
`[capture-ready] {"ready": true, "frames": 31, "bytes_on_disk": 8412, ...}` once,
after `--ready-frames` (default 30 — about half a second) have been captured and
flushed.

### The handshake

`tracker_collector_feed.mjs` parses the marker into the capture health both the
bridge and the read-only preview read, and hands it to a callback. The bridge:

- awaits it between `launchPlayerTracking()` and `launchTracker()`, so the
  tracker `.exe` — the thing that starts reading the game — is not released
  until the capture is proven;
- publishes the result atomically at `TRACKER_LAUNCH_RECORDING`
  (`<signal>.recording`), **on failure as well as on success**, with the reason,
  the timings, the stem and the session-log path;
- settles that wait on any of: the evidence line, the collector exiting, the
  collector failing to spawn, an unparseable marker, `TRACKER_PLAYER_TRACKING=0`
  (reported as *disabled*, not as a fault), or
  `TRACKER_CAPTURE_READY_TIMEOUT_MS` (default 30 s);
- launches the tracker anyway when it cannot be confirmed. A game tracked
  without the 60 Hz capture is worth more than no game at all, and the warning
  says exactly what was lost.

The launcher waits for that file after the handoff, reports what it says, and
prints the three timings — bridge ready, handoff, capture — that until now
existed only in someone's memory. A collector that never records is a warning
and an exit code of 0: by then the match is live, the tracker is released, and
a bridge is writing the game's statistics.

### The startup record

`data/tracker_startup/<competition>-<id>-<timestamp>.json`, written once at the
handoff. It carries which of the five claims each stage actually established,
the three timings, the capture stem with its frames and bytes, and the path of
the tracker log — so the pairing of log and capture is recorded first-hand
instead of being reconstructed from timestamps later, which is what
`scripts/audit_tracking_archive.mjs` still has to do for every session recorded
before this.

### What still needs a real game

- The `[capture-ready]` line against a real Dolphin. Every test writes it from
  a fake child.
- Whether 30 s is generous or tight for python starting, attaching, resolving
  the actors and locking the ball offset on this machine. The startup record is
  where the first real number lands.
- A collector attached to a PAUSED emulator. It should fail the check, because
  the frame counter does not move — that is the behaviour of the counter, not a
  tested path.

See `docs/tracker-real-game-validation.md`.

## The original gap, as it stood — 2026-09-05

### The gap as it was: capture before the first pitch

**The launcher cannot guarantee that the collector is recording before the first
pitch, and this pass did not invent that guarantee.**

What it can now prove: the bridge finished its own startup (`<signal>.ready`),
and autoteam either saw a byte-exact pitch reset or admitted it did not. What
happens after the signal is written is entirely inside the bridge —
`launchPlayerTracking()` then `launchTracker()` — and neither reports back. The
window between the handoff and the collector's first frame is unmeasured.

The bridge does already publish capture health on its preview API
(`http://127.0.0.1:4317/state`, `playerTracking.capture`, with `status` and
`collector_pid`), which is the obvious place for a future "recording" signal:
the launcher could poll it after the handoff and say plainly whether frames are
being written before the first pitch, rather than assuming. That is a separate
change and was not made here.

Until then the honest statement is the one the launcher now prints: a confirmed
handoff means the ball was at a pitch reset when the tracker was released; an
unconfirmed one means autoteam timed out and the release was a judgement call.

*(That paragraph is what this pass replaced. The launcher now waits on the
evidence rather than assuming, exactly as the paragraph above it proposed.)*

## Commands run

```
npm run test:tracker                      462/462 passed
npm run test:defense                       31/31  passed
node --test tests/tracker-persistence.test.mjs tests/tracker-ingestion-reliability.test.mjs
                                           24/24  passed
node --test tests/mss-autogame-launcher.test.mjs        36/36 passed
node --test tests/tracker-preview-launcher.test.mjs      5/5  passed
node "tmp/launcher-hardening-20260905/cli_scenarios.mjs"        14/14 passed
bash tmp/launcher-hardening-20260905/exporter_scenarios.sh       7/7  passed
node scripts/tracker_preview.mjs --api-port 0            refuses, exit 1
node scripts/tracker_preview.mjs --replay                refuses, exit 1
node scripts/tracker_preview.mjs --no-open  (4317 held)  refuses by name, exit 1
node scripts/mss_autogame.mjs --help                     prints the corrected help
```

`npm run build` was not run: no app-facing code changed, only `scripts/` and
`tests/`.

`cli_scenarios.mjs` runs the real `scripts/mss_autogame.mjs` as a real process
against fake child executables in `tmp/launcher-hardening-20260905/fake scripts`
(a path with a space, deliberately) and a local stub of the Supabase endpoints.
`exporter_scenarios.sh` runs the real `scripts/export_mss_lineup.mjs` against
that stub, including a team with eight batters, a doubled-up fielding position
and an unresolvable character id.

## Needs one real-game observation

- **The `<signal>.ready` handshake against the real bridge.** Every test uses a
  fake bridge that writes the file. The real one writes it after sign-in, the
  game lock, the roster load and the live-state repair — verified by reading the
  code, not by watching a game start.
- **How long the real bridge takes to become ready.** The launcher waits 60 s by
  default (`MSS_AUTOGAME_BRIDGE_READY_TIMEOUT_MS`) and then warns and continues.
  Whether 60 s is generous or tight for a real sign-in plus roster load on this
  machine has not been measured.
- **`TRACKER_LAUNCH_OWNER_PID` against the real bridge.** The guard was
  exercised end to end against a fake bridge with a dead owner pid. The real
  bridge's copy of it is the same eight lines in the same poll loop, but has not
  been watched firing.
- **The gap between the handoff and the collector's first frame.** Still needs
  one real game, but it is now measured rather than merely absent: the launcher
  waits on the collector's own evidence and writes the number into
  `data/tracker_startup/<competition>-<id>-<timestamp>.json`. Play one game and
  the file has it. See `docs/tracker-real-game-validation.md`.

## Holding the opening play — 2026-09-08

**The recording handshake proved the capture existed. It did not protect the
first pitch, and the ordering it enforced actively delayed the scoring reader.**

### What the sequence really did

`wait_for_match_live()` returns at the ball's first pitch reset — the match is
already live and a pitch is one button press away. The bridge then, in order,
started the collector, waited up to `TRACKER_CAPTURE_READY_TIMEOUT_MS` (30 s)
for recording evidence, and only afterwards started the tracker `.exe`. Nothing
in that sequence held gameplay, because nothing in it *can*: the bridge owns
neither the emulator nor the controller ports.

So the cost was paid twice. The capture could still miss the opening play, and
the SCORING reader — which does not depend on the collector at all — was held
behind up to thirty seconds of a live game. The test that guarded this proved
collector-before-executable, an ordering between two processes, which is not the
claim anybody wanted.

### Why readiness and a held game are in tension, and how that is resolved

The collector's frame counter only advances when the game's own clock does. That
is exactly what makes `[capture-ready]` good evidence — and exactly why it can
never be produced while gameplay is held, because holding the game stops the
clock. Waiting for recording evidence while paused is a deadlock.

The two claims are therefore separated:

- **`[capture-attached]`** — dolphin-memory-engine attached, the stadium byte
  read, the ball offset resolved, the actors located, the header written and the
  `.bin` open. All provable with the clock stopped. It is printed before the
  first frame is read and it deliberately does not claim the game is running.
- **`[capture-ready]`** — unchanged: frames sampled off a running clock AND
  flushed to disk, with the file's size read back.

### The sequence now

1. autoteam sees the pitch reset and prints `MSS_AUTOTEAM_MATCH_LIVE confirmed`,
   which is what releases the bridge.
2. autoteam immediately presses `+` — MSS's own pause menu — and prints
   `MSS_AUTOTEAM_GAMEPLAY_HELD paused`.
3. The bridge starts the collector, waits for `[capture-attached]`
   (`TRACKER_CAPTURE_ATTACH_TIMEOUT_MS`, default 20 s), starts the tracker
   `.exe`, **waits for the tracker to say it is attached to Dolphin**
   (`TRACKER_SCORING_READY_TIMEOUT_MS`, default 30 s), and writes
   `<signal>.readers`.
4. autoteam reads that file's `status`, presses `+` again, and prints
   `MSS_AUTOTEAM_GAMEPLAY_RESUMED <outcome> <seconds>`.
5. The recording evidence settles in the first half second of live play and is
   published at `<signal>.recording` exactly as before. It no longer gates
   anything.

#### The scoring reader is asked the same question the collector is

Step 3 used to be "starts the tracker `.exe` and writes `<signal>.readers`", on
the next line, with `trackerStarted: true` written unconditionally. Nothing
waited for the process to start, let alone to attach. An `ENOENT` on the tracker
`.exe` produced a handshake saying both readers were up, and `mss_autoteam.py`
— which checked only that the file **existed** — resumed a live match that
nothing was scoring.

The tracker announces its own attachment on its first line of output (`Dolphin
hooked.`), which is the scoring equivalent of `[capture-attached]` and is
provable with the game clock stopped for the same reason. The handshake now
carries what actually happened:

| `status` | `scoringReader` | Meaning |
| --- | --- | --- |
| `ready` | `ready` | attached; a play now is recorded |
| `unconfirmed` | `timeout` | running, and has not said it attached |
| `failed` | `spawn_failed` / `exited` / `not_started` | not running. Nothing will score this game |
| `cancelled` | `cancelled` | the bridge was stopped before it could find out |

The file is still written in every one of those cases, including the bad ones:
whatever is holding the pause menu must never be left holding a live game, and a
paused match is not a recovery. What changed is that the outcome is stated
rather than implied, and read rather than assumed.

Every ending resumes play and says which one it was. `readers_ready` (the
handshake says the scoring reader is up, or is running and unconfirmed — the
bridge has already stopped waiting for it, so there is nothing left for the hold
to wait for either), `readers_failed` (the handshake says it is NOT running;
`mss_autogame.mjs` says so in its own voice, because the game about to be played
will not be recorded), `timeout` (`--hold-timeout`, default 45 s — a hold that
could strand a paused match would be worse than the delay it prevents), or
`not_held` (the pause could not be pressed, or an older `mss_autoteam.py` that
does not hold at all). A handshake file that is absent *or not yet parseable* is
waited out rather than believed; one with no `status` at all was written by an
older bridge and means what that bridge meant by it — both readers up.

The launcher records the outcome and the held duration in the startup record as
`stages.gameplay_hold` and `timings_ms.gameplay_held`; a run with no markers at
all is recorded as `null`, which reads as "not held" rather than as "fine".

A bridge with no `TRACKER_LAUNCH_READERS` — a standalone `npm run
tracker:bridge` — does not run this wait at all. Nobody is holding a game, so
delaying startup by up to half a minute to publish a file nothing reads would be
a cost with no guarantee attached to it.

### What this is not

**It is not a lock.** A player can close the pause menu themselves and nothing
here would know. It is the difference between a capture and a scoring reader
that reliably start before the first pitch and ones that race it.

The suppression window is around each of the two presses only, not around the
wait: taking both controllers away for the whole of a stadium load is what the
comment above `wait_for_match_live` is about, and a hold at the pitch reset is
neither that long nor that early.

### Tested, and what still needs a real game

`tests/gameplay_hold_test.py` drives the hold with a fake controller, an
injected clock and an injected sleep: held-then-resumed, a collector that never
starts (resumes on the timeout), a collector that takes twelve seconds (waited
for, not raced), a pause that cannot be pressed, a resume that fails (said out
loud, because a person then has to close the menu), a scoring reader that did
not start (`readers_failed`, resumed anyway, named), one running but unconfirmed,
a half-written handshake (waited out, not believed), and a handshake from an
older bridge with no `status`.

`tests/tracker-reader-handshake.test.mjs` drives the REAL bridge for the other
half: a tracker that says it is hooked, one that says so late, one that fails to
spawn, one that exits before attaching, one that never says anything, a bridge
stopped mid-handshake, and a bridge with nothing holding gameplay.

`tests/mss-autogame-launcher.test.mjs` covers the launcher's half — the file
path handed to both children, and each outcome reaching the startup record.
`tests/tracker-collector-feed.test.mjs` covers the attach marker, including an
unreadable one still answering the waiter.

Still needs one real game, and nothing offline can establish it:

- **That `+` opens and closes MSS's pause menu from the input word** the way
  every other press in `mss_input.py` works. Every test here uses a fake pad.
- **Whether the game clock stops in the pause menu** as it does when Dolphin
  itself is paused. If it does not, the hold costs nothing and `[capture-ready]`
  would arrive during it; if it does, the hold is what the attach marker exists
  for. Either way the hold is released on attachment, so both are safe — but
  which one is true is unmeasured.
- **How long the collector really takes to attach** on this machine. 20 s is a
  guess; the startup record is where the first real number lands.
- **That the tracker build in use prints a line matching the attach pattern**
  (`Dolphin hooked.`, or the "waiting for match" / "match is starting" lines
  that only follow it) promptly after launch. Every recorded session in the
  acceptance fixtures does, on its first line and within the same second — but
  those recordings are the evidence, not this build on this machine. If it does
  not, the handshake reports `unconfirmed` after
  `TRACKER_SCORING_READY_TIMEOUT_MS` and the game is released anyway, so the
  cost of being wrong is a 30 s hold rather than a lost game. Read
  `<signal>.readers` and autoteam's `MSS_AUTOTEAM_GAMEPLAY_RESUMED` line after
  one real launch to settle it.

See `docs/tracker-real-game-validation.md`.
