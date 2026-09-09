"""Does live derivation cost the recording any frames?

    python scripts/benchmark_live_derivation.py data/player_tracking/<session>

WHY A SEPARATE BENCHMARK. replay_player_tracking.py proves the live derivation
computes the right thing; it cannot prove the capture survives doing it,
because it feeds frames as fast as it can decode them. That is the worst
possible contention case and nothing like the real loop, which does about 1.8
ms of work per 16.7 ms frame and spends the rest waiting on the game clock.

So this replays a recorded session at TRUE 60 Hz pace against a wall clock,
does the same XOR-delta and compression the collector does, and counts the
frames whose total work overran the budget -- with live derivation on and with
it off. The difference between those two counts is what live derivation costs
the recording, in the only unit that matters: frames that would have been
missed.

The acceptance criterion is the collector's own: no material increase.
"""
from __future__ import annotations

import argparse
import struct
import sys
import time
import zlib
from pathlib import Path

import collect_player_tracking as collector
from player_live_derivation import LiveDerivation
from player_tracking_io import Session

FRAME_SECONDS = 1.0 / 59.94


def run(stem: Path, frames_wanted: int, derive: bool) -> dict:
    session = Session(stem)
    actors = ([dict(a, kind="fielder") for a in session.fielders]
              + [dict(a, kind="offense") for a in session.offense])
    live = LiveDerivation(
        state_base=session.state_base, actors=actors, fields=session.fields,
        state_fields=[[n, a, f] for n, a, f in collector.STATE_FIELDS],
        out_path=None,
    ) if derive else None

    compressor = zlib.compressobj(6)
    previous = bytes(session.state_size)
    overruns = 0
    worst = 0.0
    total = 0.0
    count = 0
    plays = 0
    deadline = time.perf_counter()

    for frame in session.frames():
        # Pace to the game clock, exactly as the collector's timer poll does.
        deadline += FRAME_SECONDS
        now = time.perf_counter()
        if now < deadline:
            time.sleep(deadline - now)

        started = time.perf_counter()
        # --- what the collector does for the recording, every frame ---
        delta = bytes(a ^ b for a, b in zip(frame.block, previous))
        previous = frame.block
        record = (struct.pack(">IdI", frame.timer, 0.0, frame.ball_pointer)
                  + struct.pack(">fff", *frame.ball)
                  + struct.pack(">9I", *frame.fielder_pointers) + delta)
        compressor.compress(struct.pack(">I", len(record)) + record)
        # --- what live derivation adds ---
        if live is not None:
            plays += len(live.feed(frame.timer, frame.ball, frame.block,
                                   frame.fielder_pointers))
        elapsed = time.perf_counter() - started

        total += elapsed
        worst = max(worst, elapsed)
        if elapsed > FRAME_SECONDS:
            overruns += 1
        count += 1
        if count >= frames_wanted:
            break

    if live is not None:
        plays += len(live.close())
    return {
        "frames": count,
        "plays": plays,
        "mean_ms": total / max(count, 1) * 1000,
        "worst_ms": worst * 1000,
        "overruns": overruns,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session")
    parser.add_argument("--frames", type=int, default=9000,
                        help="frames to pace through (9000 = 2.5 minutes of play)")
    args = parser.parse_args()
    stem = Path(args.session)
    if stem.suffix in (".json", ".bin"):
        stem = stem.with_suffix("")

    print(f"pacing {args.frames} frames of {stem.name} at 60 Hz "
          f"({args.frames / 59.94 / 60:.1f} minutes of play)\n")
    print(f"  frame budget {FRAME_SECONDS * 1000:.2f} ms\n")

    baseline = run(stem, args.frames, derive=False)
    print(f"  recording only        mean {baseline['mean_ms']:6.3f} ms  "
          f"worst {baseline['worst_ms']:6.2f} ms  "
          f"overruns {baseline['overruns']}")

    derived = run(stem, args.frames, derive=True)
    print(f"  recording + live      mean {derived['mean_ms']:6.3f} ms  "
          f"worst {derived['worst_ms']:6.2f} ms  "
          f"overruns {derived['overruns']}   "
          f"({derived['plays']} plays emitted)")

    print()
    delta = derived["overruns"] - baseline["overruns"]
    print(f"  live derivation costs {delta:+d} over-budget frame(s) "
          f"in {args.frames} ({delta / args.frames * 100:+.3f}%)")
    print(f"  and adds {derived['mean_ms'] - baseline['mean_ms']:+.3f} ms "
          "to the mean frame")
    return 0


if __name__ == "__main__":
    sys.exit(main())
