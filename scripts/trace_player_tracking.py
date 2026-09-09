"""Print raw traces from a recorded session, for looking at with your own eyes.

When a scoring function disagrees with a sanity check, the fastest way through
is usually to stop scoring and look at the numbers. This dumps a window of
frames as a table: the ball, the game situation, and whichever actor offsets you
name, so a candidate field can be watched doing whatever it actually does.

    # what the whole session looks like, one line per second
    python scripts/trace_player_tracking.py SESSION --every 60

    # a window around a particular game frame, for one actor
    python scripts/trace_player_tracking.py SESSION --actor CF \\
        --offsets 0x38 0xE4 0xE8 --from 12000 --to 12200
"""
from __future__ import annotations

import argparse
import struct
import sys

from player_tracking_io import Session


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session")
    parser.add_argument("--actor", default="CF")
    parser.add_argument("--offsets", nargs="*", default=["0x04", "0x38", "0xE4"])
    parser.add_argument("--every", type=int, default=1)
    parser.add_argument("--from", dest="start", type=int, default=0)
    parser.add_argument("--to", dest="end", type=int, default=0)
    parser.add_argument("--hits", action="store_true",
                        help="list the frames where ball_was_hit goes 0->1")
    args = parser.parse_args()

    session = Session(args.session)
    offsets = [int(o, 0) for o in args.offsets]
    actor = next((a for a in session.fielders + session.offense
                  if a["name"] == args.actor), None)
    if actor is None:
        raise SystemExit(f"no actor named {args.actor}")

    if args.hits:
        previous = 0
        count = 0
        for i, frame in enumerate(session.frames()):
            hit = session.state(frame)["ball_was_hit"]
            if previous == 0 and hit == 1:
                state = session.state(frame)
                count += 1
                print(f"  frame {i:6d}  timer {frame.timer}  "
                      f"inning {state['inning']}.{state['inning_half']} "
                      f"{state['outs']} out  batter {state['batter_id']}")
            previous = hit
        print(f"\n{count} contacts")
        return 0

    header = "  frame    hit hold st  " + "  ".join(
        f"{'+0x%03X' % o:^26}" for o in offsets) + "        ball"
    print(header)
    for i, frame in enumerate(session.frames()):
        if i < args.start:
            continue
        if args.end and i > args.end:
            break
        if (i - args.start) % args.every:
            continue
        state = session.state(frame)
        cells = []
        for offset in offsets:
            start = actor["address"] - session.state_base + offset
            x, y, z = struct.unpack(">fff", frame.block[start : start + 12])
            cells.append(f"({x:8.2f},{y:6.2f},{z:8.2f})")
        bx, by, bz = frame.ball
        print(f"  {i:6d}  {state['ball_was_hit']:3d} {state['ball_holder']:4d} "
              f"{state['ball_status']:2d}  " + "  ".join(cells)
              + f"   ({bx:7.2f},{by:6.2f},{bz:8.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
