# Live tracking and game view plan

**Status:** Proposed
**Prepared:** 2026-08-26
**Scope:** Making the fielding and baserunning measurements available during a game, and what the game view should do with them.

## The finding that shapes both halves

**The live tracker and the fielding/baserunning tracker are two separate pipelines that never meet while a game is being played.**

| | Live path | Fielding/baserunning path |
|---|---|---|
| Source | the tracker `.exe`'s console log | a 60 Hz reader of the emulator's memory |
| Parsed by | `tracker_preview_state.mjs` | `derive_player_metrics.py` |
| Timing | line by line, during the game | **after the tracker exits** |
| Lands in | `live_state` jsonb → Game View | `.bin` on disk → Supabase |
| Carries | count, outs, matchup, pitch telemetry, hit location | positions, routes, speeds, catches, throws, landings |

So none of the new measurements exist while the game is on. Adding them to the live tracker is not a UI change — the data is sitting in a compressed file that nobody reads until the tracker process ends. Part 1 is what closes that gap; Part 2 is what to do with it once closed.

---

## Part 1 — Make the fielding feed live

### Why this is tractable

The derivation is already an incremental forward state machine. It reads frames in order, opens a play when the ball leaves the plate, and closes one at the dead ball. Nothing in it looks backwards past the play it is in. That means the same code can run against a live frame instead of a recorded one, and a completed play can be emitted within a frame or two of the ball going dead.

### Steps

**1. Extract the state machine.** Pull the loop out of `derive_player_metrics.py`'s `main()` into a `PlayDeriver` class with `feed(frame, state)` → optional completed play. `main()` then becomes a thin loop over a recorded session, and the collector becomes a thin loop over live frames. One code path, so live and post-hoc cannot drift — which matters, because post-hoc stays authoritative.

**2. Feed it from the collector.** `collect_player_tracking.py` already reads every frame. It appends each completed play to a `.live.jsonl` beside the `.bin` and prints a one-line marker to stdout, which the bridge is already reading and logging.

**3. Fix calibration up front.** Today the position offset is scored *after* capture, over the whole session. Live derivation needs it at frame zero. It has been `+0x004` in both captures, with a decisive margin (9,234 locks against 3,993 for the runner-up). Add `--position-offset` with a live self-check — an actor standing exactly on the ball within the first N possessions — and if the check fails, keep capturing and skip live derivation rather than emitting wrong numbers.

**4. Merge into the bridge.** The bridge reads the play lines, attaches them to the at-bat it already has open, and includes them in the `live_state` payload it writes.

**5. Leave post-game alone.** It re-derives from the `.bin` and remains the source of truth. Live is a preview, and should be labelled one.

### Risk

The collector's budget is 16.6 ms per frame and it currently uses a fraction of it — 1 missed frame in 72,233. Per-frame derivation work is a few list appends; the expensive part (route summaries, throw segmentation) runs once per play at the dead ball. It must still be measured, and the missed-frame count is the acceptance test: **no increase over a baseline capture.**

### What can be live, and what cannot

| Live, per play | Post-game only |
|---|---|
| First touch, who made it, hang time | Catch Probability, OAA, Directional OAA |
| Landing spot; caught in flight or not | Expected DP, DP Added |
| Catch height, and robbery at the wall | Arm Value, Rbaser, FRV |
| Distance covered, required closing speed | Anything needing the plate-appearance join |
| Throw chain: thrower, target, receiver, velocity | Season and career aggregates |
| Buddy Throws and the chemistry pair | Percentiles and league baselines |
| Sprint speed, home-to-first, 90-foot splits | |

The right-hand column is not a sequencing choice. Those need a trained model and league baselines, and the models need capture volume that does not exist yet.

---

## Part 2 — Game view

### What is there now

`Game View | Live Tracker | At-Bat Editor | Lineups | Admin`, where Live Tracker replaces Scorebook for tracker games. Game View is the spectator view; Live Tracker is a diagnostic dump aimed at whoever is running the capture. The split is right and should stay — the new work goes mostly into Game View, with capture health in Live Tracker.

Existing pieces to build on rather than reinvent: `FieldPlayBuilder`, `BaserunnerField`, `SprayChart`, `VectorSprayChart`, `stadiumFieldGeometry.js`, and the measured fences in `parkGeometry.js`.

### A. Field panel — the centrepiece

Everything needed for this is measured and none of it is modeled.

- All nine fielders at their **actual** positions at pitch release, not at generic markers.
- The ball's flight path, and where it landed or was caught.
- The primary fielder's route from start to the ball.
- The park's measured fence, drawn from `PARK_FENCES`.
- A robbery marker when the catch sits at or beyond the fence line.

This is the display that justifies the whole tracking effort: it shows the play as it actually happened rather than as a notation string.

### B. Play card

Replaces the current at-bat readout for balls in play:

```
  Funky Kong  ·  fly out to LF
  hang 4.2s   ·  LF covered 18.3u of 21.6u needed  ·  5.1 u/s required
  THROW  LF → 3B   122.6 mph   aimed at 3B
```

With badges where they apply: **ROBBED** (catch at the wall), **BUDDY** (with the pair), **ASSISTED** (the game glided the fielder), **AIMED ELSEWHERE** (the covering infielder took it).

### C. Session strip

Session-only measurements, no league context needed: hardest throw, fastest home-to-first, longest catch made, robberies. These are honest the moment the game starts and need no baseline.

### D. Live Tracker tab — capture health

Operator-facing, and currently missing entirely: frames captured, missed frames, calibration status and margin, plays derived, and per-play PA-join status. A capture that is silently producing garbage should be obvious within an inning, not after the game.

### E. Post-game

The Stats columns already exist. Add robberies, catch distance, and Buddy Throws once there are enough to rank.

### Rules for all of it

- **Measurements now, models later.** Nothing modeled ships before the volume exists to fit it, and nothing modeled ships without its sample size and version next to it.
- **Live is labelled live.** A live play card is a preview of a number the post-game pass will restate authoritatively.
- **Quality is visible.** Quarantined captures, glide-assisted plays and unjoined plate appearances are marked, not hidden.

## Sequencing

| Phase | Work | Done when |
|---|---|---|
| **1** | Extract `PlayDeriver`; live emission; calibration up front | A live capture emits the same plays the post-game pass derives, byte for byte, with no increase in missed frames |
| **2** | Field panel and play card in Game View | A ball in play is visible as a field diagram within a second of the ball going dead |
| **3** | Capture-health panel in Live Tracker | A miscalibrated or quarantined capture is obvious during the game |
| **4** | Session strip; new Stats columns | — |
| **5** | Modeled metrics | After the capture volume exists |

Phase 1 is the only one with unknowns in it. Phases 2–4 are display work over data that already exists.
