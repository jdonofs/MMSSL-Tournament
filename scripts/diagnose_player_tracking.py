"""Find the live position offset the direct way: agreement with the ball.

The ranking in calibrate_player_tracking.py is indirect -- it scores continuity
and motion and then checks the ball afterwards. On the first real session that
check failed badly (18u), which means one of its assumptions is wrong rather
than that the data is bad. This tool tests the assumptions separately instead of
in a chain:

  * WHICH FIELDER is `ball_holder` naming? It could be the batting-order index
    at actor+0x29 or the defensive position number 0..8. Guessing wrong pairs
    the ball with the wrong body and inflates every residual.
  * WHICH OFFSET is the position? Tested against the ball with no continuity
    filter at all, because a filter that eliminates the right answer before it
    is scored cannot be detected downstream.

Both are swept together and the winning combination is simply the one where the
ball sits in someone's hand.

    python scripts/diagnose_player_tracking.py data/player_tracking/<session>
"""
from __future__ import annotations

import argparse
import statistics
import struct
import sys
from pathlib import Path

from player_tracking_io import Session

SIGNS = [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--top", type=int, default=10)
    args = parser.parse_args()

    session = Session(args.session)
    stride = min(a["stride"] for a in session.fielders)
    offsets = list(range(0, stride - 12 + 1, 4))
    index_offset = session.fields["batting_index"]

    # Collect possession frames once: the ball, plus every candidate triple for
    # the fielder each interpretation of `ball_holder` would name.
    by_index, by_position = [], []
    holders_seen = set()
    frames = 0
    for frame in session.frames():
        frames += 1
        if args.limit and frames > args.limit:
            break
        holder = session.state(frame)["ball_holder"]
        if holder < 0:
            continue
        holders_seen.add(holder)
        bx, by, bz = frame.ball
        if bx == 0.0 and by == 0.0 and bz == 0.0:
            continue

        for actor in session.fielders:
            if session.byte(frame, actor, index_offset) == holder:
                by_index.append((actor, frame, (bx, by, bz)))
                break
        if 0 <= holder < len(session.fielders):
            by_position.append((session.fielders[holder], frame, (bx, by, bz)))

    print(f"{frames} frames, holder values seen: {sorted(holders_seen)}")
    print(f"possession frames matched by batting index: {len(by_index)}")
    print(f"possession frames matched by position number: {len(by_position)}\n")

    results = []
    for label, pairs in (("batting index", by_index), ("position number", by_position)):
        if not pairs:
            continue
        for offset in offsets:
            for sx, sz in SIGNS:
                residuals = []
                for actor, frame, ball in pairs:
                    start = actor["address"] - session.state_base + offset
                    ax, ay, az = struct.unpack(">fff", frame.block[start : start + 12])
                    if ax != ax or abs(ax) > 1e6 or abs(az) > 1e6:
                        residuals = None
                        break
                    residuals.append(
                        ((sx * ax - ball[0]) ** 2 + (sz * az - ball[2]) ** 2) ** 0.5)
                if not residuals:
                    continue
                residuals.sort()
                results.append((
                    statistics.median(residuals),
                    residuals[len(residuals) // 10],
                    label, offset, sx, sz,
                ))

    results.sort()
    print(f"{'match by':<16} {'offset':>7} {'signs':>8} {'median':>9} {'p10':>9}")
    for median, p10, label, offset, sx, sz in results[: args.top]:
        print(f"{label:<16}  +0x{offset:03X}  {sx:+.0f}x {sz:+.0f}z "
              f"{median:9.3f} {p10:9.3f}")

    if results:
        median, p10, label, offset, sx, sz = results[0]
        print(f"\nbest: +0x{offset:03X} matched by {label}, "
              f"x*{sx:+.0f} z*{sz:+.0f}, median {median:.3f}u")
        if median > 3.0:
            print("  Still too large for a ball in a glove. Neither the offset\n"
                  "  nor the holder mapping explains it on its own.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
