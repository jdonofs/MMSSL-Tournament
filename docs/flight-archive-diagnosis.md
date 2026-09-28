# Flight-archive verification failure — diagnosis, 2026-09-15

`node scripts/distill_flights.mjs --verify` fails for **two independent reasons**, and
neither is lost or corrupted archive data. No frames are missing from the archive; the
lossy side is the *log* side.

Read-only throughout: `--verify`, the two backtest modes, and four temporary scripts run
from the OS temp directory. Nothing was written except this file.

## 1. Reproduction

```
$ node scripts/distill_flights.mjs --verify        # 6.0 s, exit 1
logs    5686 flights
archive 5687 flights

scorable: logs 686, archive 686
  present in logs but not archive: 0
  present in archive but not logs: 0
  worst first-touch disagreement:  0.487952 units
  worst apex disagreement:         0.000050 units
```

Matches the number recorded in `docs/cleanup-audit.md:134` exactly. Tolerance is
`1 / POS_SCALE` = 1e-4 ([flight_archive.mjs:63](../scripts/flight_archive.mjs#L63)).

**Map dedup hides nothing.** Distinct `flightKey`s: logs 5686 of 5686 flights, archive
5687 of 5687 rows — zero duplicate keys on either side, so no second copy is being
silently discarded by the `Map`s in `verify()`. The real dedup loss happens one stage
earlier, in `buildFlights` (§3).

## 2. The 0.487952-unit disagreement — a threshold flip, not lost frames

One scorable flight disagrees, and only one:

**`22702|Red Pianta|106.5|7.5|-13.8`**, `landed`, peach_ice_garden, from
`preview-sessions/preview-2026-09-07_19-46-33.log`.

| | log | archive |
|---|---|---|
| stored frames | 110 | 110 |
| contiguous run | 89 | 89 |
| first-touch index | 86 | **85** |
| touch (x, z) | −17.2764, −68.9877 | −17.1514, −68.5160 |

The stored sample streams are **identical** — first differing sample index is −1 (no
sample differs by more than 1e-4 in any axis, nor by more than 2 µs in time). Both copies
contain both candidate frames. What differs is *which frame is chosen*.

[backtest_hr_projection.mjs:90](../scripts/backtest_hr_projection.mjs#L90) selects the
first post-apex frame that is **not** above `BALL_RADIUS_UNITS + 0.35` = exactly `0.6`:

```js
if (flight[i].y > BALL_RADIUS_UNITS + 0.35) continue
```

Frame 85 of this flight has

```
y_raw       = 0.600044847000000050   ->  y > 0.6 is TRUE   -> skipped, touch is frame 86
y_quantised = 0.600000000000000000   ->  y > 0.6 is FALSE  -> touch is frame 85
```

`Math.round(0.600044847 * 10000) = 6000`, so the archive's 1e-4 integer encoding lands the
sample exactly *on* the cutoff. The frame moves one step down the descent, and one frame at
this flight's speed is 0.487952 units = **1.60 ft**.

Confirmed in isolation: `decodeFlight(encodeFlight(f))` on this single flight in memory,
with no archive file involved, moves the touch index 86 → 85 and the touch point by
0.487952 u. Quantising every log flight's samples and re-scoring flips exactly **1 of 686**
scorable flights, worst 0.487952 u — i.e. the archive file reproduces precisely what
quantisation predicts, with nothing left over.

**Root cause.** `--verify` applies a tolerance derived for a *continuous* quantity
(`1 / POS_SCALE`, the most a coordinate can move) to a *discontinuous* one (which frame a
`>` comparison selects). Quantisation cannot move a coordinate by more than half a step,
but it can move the *selection* by a whole frame, and a frame is ~0.5 u. The comment at
[distill_flights.mjs:76-77](../scripts/distill_flights.mjs#L76-L77) ("anything larger means
real frames were lost") does not hold for a threshold-crossing index.

**It will recur.** Distance from the cutoff of the frame immediately before first touch,
across the 686 scorable flights: 1 within 1e-4 (this one), 7 within 1e-3, 35 within 1e-2.
Any of those seven is one re-encoding away from the same flip. (No touch frame sits within
one step *below* the cutoff, so the flip only ever goes earlier, never later.)

## 3. 5,686 vs 5,687 — the log side drops a real ball

The extra archive row is **legitimate and current**, not stale:

```
key=53|Baby Mario|95.4|17.1|31.5  kind=caught  s=155/172 frames  t0_ns=15206730308300
```

Two genuinely different at-bats collide:

| ball | launch / spray | endpoint | logs holding it |
|---|---|---|---|
| A | 17.1° / 31.5° | catch at (50.40, 0, −65.60), endpoint_seq 224 | `output/Bows vs DK Wilds - 2026-09-11 13-20-51.log`, `preview-sessions/preview-2026-09-11_12-47-27.log` |
| B | 18.0° / −34.2° | landing at (−52.29, 3.76, −62.93), endpoint_seq 228 | `output/Bows vs DK Wilds - 2026-09-11 15-48-47_368394.log`, `preview-sessions/preview-2026-09-11_15-37-32.log` |

Same batter, same pitcher, same seq 53, same `exit_speed_mph=95.4`, different games
(t0_ns 15,206,730,308,300 vs 25,385,516,901,700), opposite fields.

[ball_trajectories.mjs:339](../scripts/ball_trajectories.mjs#L339) dedups on
`` `${from}|${contact.batter}|${contact.exit_speed_mph}` `` — no launch, no spray — while
`flightKey` ([flight_archive.mjs:72-76](../scripts/flight_archive.mjs#L72-L76)) includes
both. So `buildFlights` collapses A and B into one flight and keeps B (176 frames), and
ball A never reaches the log-side comparison at all. Re-running `buildFlights`' own logic
with `flightKey` as the dedup key yields **5687 flights and an exact key match with the
archive in both directions** (0 in archive not logs, 0 in logs not archive).

Exactly 1 of 5,686 collapse keys currently covers more than one ball, so this is rare —
but it is silent, and it collides precisely where seq numbers are small and reused (early
in every session).

The archive holds both because they were distilled on separate runs: within any single run
`buildFlights` can only emit one of them. The committed archive blob at HEAD (4,303 rows)
contains neither Baby Mario row; the working archive adds 1,384 rows including both, and
drops none of HEAD's.

*Related, not part of this failure:* the archived row for ball A has `stadium=null`. Its two
log copies are both 172 frames, so the tie-break at
[ball_trajectories.mjs:343-347](../scripts/ball_trajectories.mjs#L343-L347) — which
considers frame count and endpoint but not the stadium label — kept the unlabelled `output/`
copy over the `preview-*` copy that names `yoshi_park`.

## 4. Demonstrated impact

Both backtests, run read-only:

| | `backtest_hr_projection.mjs` (logs) | `--archive` |
|---|---|---|
| fitted gravity | 13.2849 u/s² | 13.2860 u/s² |
| fitted linear drag | 0.00100 /s | 0.00100 /s |
| first-touch rms | 6.64 ft | 6.64 ft |
| every backtest row (0.5 s … 2.5 s), n and all medians/rms | — | **identical** |
| scorable n / unresolved n | 686 / 271 | 686 / 271 |

So the measured impact of the touch flip is a **0.0011 u/s² (0.008%) shift in fitted
gravity and nothing else visible**. The impact of the collision is one `caught` flight —
which is not scorable anyway — being absent from any log-derived analysis.

**Which consumers are affected.** Only three read the archive:
`backtest_hr_projection.mjs --archive`, `ball_trajectories.mjs --archive`, and
`distill_flights.mjs`. Nothing under `src/` references the archive or
`ball_flight_model.mjs`; `tracker_play_events.mjs` uses the model's *constants*
(`GRAVITY_UNITS_PER_SEC2 = 9.9316`, `LINEAR_DRAG_PER_SEC = 0.16874`), which are hand-copied
from an earlier 65-flight fit and are not read from either the archive or the logs.

**No live statistic is affected by this failure.** The only path from here to shipped
numbers is a human copying a newly fitted constant into `ball_flight_model.mjs`, and the
two fits differ by 0.0011 u/s² — far below the gap between those constants and *either*
current fit, which is a separate question this diagnosis does not address.

One live-behaviour note worth flagging: `tracker_at_bat_preview.mjs:327-334` runs
`distill_flights.mjs` in **default (write) mode** at preview shutdown. That is where §3's
collision matters going forward — a newly played ball that collides with an
already-archived one on `seq|batter|exit_speed` is dropped by `buildFlights` before the
merge ever sees it, and never enters the archive.

## 5. Smallest fixes

Two separate defects, two separate one-line fixes. Neither is applied here.

**(a) The verify tolerance (the actual failure).** Smallest correct change: in `verify()`,
when the two touch points disagree, accept the pair if the archive's touch frame is present
in the log's run within tolerance — i.e. compare frames, not just coordinates — and print
the flip rather than failing. Changes **no** numerical behaviour anywhere.

Alternative, if the boundary itself should be stable: make the comparison at
[backtest_hr_projection.mjs:90](../scripts/backtest_hr_projection.mjs#L90) quantisation-aware
(`> CUT + 1 / POS_SCALE`, or compare the rounded `y`). That makes the log and archive agree
by construction, at the cost of moving one flight's touch by 1.6 ft: the log-side fit
becomes the archive-side fit (gravity 13.2849 → 13.2860), with every backtest row unchanged.
Prefer (a) unless the threshold is wanted robust for its own sake.

**(b) The collapse-key collision.** Use `flightKey(built)` as the `byContact` key in
`buildFlights` instead of `` `${from}|${batter}|${exit_speed_mph}` ``. Measured result:
5,687 flights and an exact match with the archive. This changes `buildFlights` output
(+1 flight today) and so touches every log-reading consumer — small, but it is a behaviour
change, not a comment change.

**Regression cases** (both suites are already in `npm run test:tracker`):

- `tests/flight-archive.test.mjs` — a flight whose post-apex frame sits just above
  `BALL_RADIUS_UNITS + 0.35` (y = 0.600044847 is the real value) must select the same
  first-touch frame before and after `decodeFlight(encodeFlight(f))`.
- `tests/ball-trajectories.test.mjs` — two contacts in different sessions sharing
  `contact_seq`, batter and `exit_speed_mph` but differing in launch/spray must yield
  **two** flights from `buildFlights`, not one. (The existing "two sessions that reuse the
  same seq numbers" test at line 78 varies the batter and exit speed, so it does not cover
  this.)

## 6. Data repair

**None required, and none should be attempted.** The archive is not damaged: it holds all
110 frames of the Red Pianta flight and a legitimate extra observation of a real ball. Both
defects are in the reading code.

One standing risk follows from §3: **do not rebuild the archive from scratch.** Deleting
`data/flight_archive.jsonl.gz` and re-distilling would permanently drop the caught Baby
Mario ball, because today's `buildFlights` cannot emit it from the logs that hold it. Until
fix (b) lands, the archive is the only place that flight is reachable.
