"""Work out which bytes of an actor struct are its live world position.

An actor struct holds several position-shaped float triples and only one of them
is the coordinate that moves with the character. Between pitches they are
indistinguishable -- everyone stands on their assigned spot, so every candidate
reads the same thing -- which is why this cannot be settled by staring at a
paused game.

THE TEST THAT ACTUALLY SETTLES IT is coincidence with the ball. Whenever anybody
is holding the ball, the ball's coordinates and that person's coordinates are
describing one point in the world, and on the real field they agree to three
decimal places:

    ball       (5.932, 0.000, -78.895)
    CF +0x004  (5.932, 0.000,  78.895)

That is not a similarity to be scored, it is an identity, and it is worth more
than any indirect heuristic. So the primary criterion is simply: under this
candidate offset and this sign convention, how many frames put SOME actor
exactly where the ball is? A wrong offset scores zero. It also recovers the
actor-to-ball frame conversion for free, since the sign convention is swept
alongside the offset.

Two earlier criteria were tried and are deliberately no longer fatal:

  * CONTINUITY. "A body cannot teleport" sounds safe and is wrong: the live
    position DOES jump, when the sides change and the nine fielder objects are
    rewritten with the other team, and again when players reset between plays.
    Eliminating on a large single-frame step threw out the correct answer on
    the very first real session. Teleports are now counted, not punished.
  * MOTION AND GROUND CONTACT. Both are true of the right answer, but they are
    also true of several near-copies of it -- smoothed positions, previous-frame
    positions, AI target points -- which is exactly the set the ball test cuts
    through. They are reported as context.

Matching by the game's `ball_holder` field was also tried and is unreliable: it
goes stale between plays, naming a fielder while the ball sits on the mound.
Taking the nearest actor instead needs no such field.

    python scripts/calibrate_player_tracking.py data/player_tracking/<session>

Writes <session>.calibration.json, which derive_player_metrics.py reads.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

from player_tracking_io import Session

# How close counts as "the ball is in this person's hands". The observed match
# is exact to the float, so this is loose by three orders of magnitude and still
# cannot be hit by an unrelated field.
LOCK_UNITS = 0.05

# Between pitches the ball rests on the rubber, and one of the candidate fields
# is each fielder's ANCHOR SPOT -- which for the pitcher is the rubber. So that
# field "holds the ball" on every idle frame of the session without ever being a
# body position, and idle frames are most of a session. Measured on the first
# real session: the anchor scored 6280 of its 8404 locks there, against 57 for
# the true position. Locks at the reset are therefore not counted at all; only
# the ball being somewhere a body carried it is evidence.
RESET_BALL = (0.0, -18.6)
RESET_EXCLUSION_UNITS = 0.3

# A step larger than this is a teleport rather than a stride. Only counted.
TELEPORT_UNITS = 1.5

# Loose park bounds; this rejects garbage, it does not adjudicate geometry.
BOUNDS = {"x": (-160.0, 160.0), "y": (-6.0, 70.0), "z": (-220.0, 220.0)}

# The four sign conventions two axis-aligned frames can differ by, plus the x/z
# swap. Which one the game uses is measured, never assumed.
FRAME_CANDIDATES = [(sx, sz, swap)
                    for swap in (False, True)
                    for sx in (1.0, -1.0)
                    for sz in (1.0, -1.0)]


def actor_list(session: Session) -> list:
    return ([dict(a, kind="fielder") for a in session.fielders]
            + [dict(a, kind="offense") for a in session.offense])


def prefilter(session: Session, actors: list, frames_to_read: int) -> list:
    """Drop offsets that are not float triples in park-shaped coordinates.

    Cheap, and it takes the sweep from ~184 candidates to a couple of dozen, so
    the expensive ball test runs over a small set.
    """
    widest = max(a["stride"] for a in actors)
    alive = {o: True for o in range(0, widest - 12 + 1, 4)}
    read = 0
    for frame in session.frames():
        read += 1
        if read > frames_to_read:
            break
        for actor in actors:
            limit = actor["stride"] - 12
            for offset, ok in alive.items():
                if not ok or offset > limit:
                    continue
                start = actor["address"] - session.state_base + offset
                x, y, z = struct.unpack(">fff", frame.block[start : start + 12])
                if any(v != v or abs(v) == float("inf") for v in (x, y, z)) or not (
                        BOUNDS["x"][0] < x < BOUNDS["x"][1]
                        and BOUNDS["y"][0] <= y < BOUNDS["y"][1]
                        and BOUNDS["z"][0] < z < BOUNDS["z"][1]):
                    alive[offset] = False
    return [o for o, ok in alive.items() if ok]


def score(session: Session, actors: list, offsets: list, limit: int) -> dict:
    """For each offset and sign convention, count frames where the ball is held."""
    stats = {
        (o, sx, sz, swap): {"locks": 0, "path": 0.0, "teleports": 0,
                            "grounded": 0, "samples": 0}
        for o in offsets for sx, sz, swap in FRAME_CANDIDATES
    }
    previous = {}
    read = 0
    for frame in session.frames():
        read += 1
        if limit and read > limit:
            break
        bx, by, bz = frame.ball
        ball_live = not (bx == 0.0 and by == 0.0 and bz == 0.0)
        at_reset = (abs(bx - RESET_BALL[0]) < RESET_EXCLUSION_UNITS
                    and abs(bz - RESET_BALL[1]) < RESET_EXCLUSION_UNITS)

        for offset in offsets:
            points = []
            for actor in actors:
                if offset > actor["stride"] - 12:
                    continue
                start = actor["address"] - session.state_base + offset
                points.append((actor["name"],) + struct.unpack(
                    ">fff", frame.block[start : start + 12]))

            for name, x, y, z in points:
                # Motion statistics describe the field itself and do not depend
                # on which sign convention is being tested, so they are gathered
                # once against the identity convention.
                stat = stats[(offset, 1.0, 1.0, False)]
                stat["samples"] += 1
                if abs(y) < 0.5:
                    stat["grounded"] += 1
                last = previous.get((name, offset))
                previous[(name, offset)] = (x, z)
                if last is not None:
                    step = math.dist((x, z), last)
                    if step > TELEPORT_UNITS:
                        stat["teleports"] += 1
                    else:
                        stat["path"] += step

            if not ball_live or at_reset:
                continue
            for sx, sz, swap in FRAME_CANDIDATES:
                for name, x, y, z in points:
                    px, pz = (z, x) if swap else (x, z)
                    if abs(sx * px - bx) < LOCK_UNITS and \
                            abs(sz * pz - bz) < LOCK_UNITS:
                        stats[(offset, sx, sz, swap)]["locks"] += 1
                        break
    for (offset, sx, sz, swap), stat in stats.items():
        if (sx, sz, swap) != (1.0, 1.0, False):
            base = stats[(offset, 1.0, 1.0, False)]
            stat["path"] = base["path"]
            stat["teleports"] = base["teleports"]
            stat["grounded"] = base["grounded"]
            stat["samples"] = base["samples"]
    return {"frames": read, "stats": stats}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session")
    parser.add_argument("--limit", type=int, default=0,
                        help="stop after this many frames (0 = whole session)")
    parser.add_argument("--top", type=int, default=8, help="candidates to print")
    parser.add_argument("--prefilter", type=int, default=3000,
                        help="frames used for the cheap elimination pass")
    args = parser.parse_args()

    session = Session(args.session)
    actors = actor_list(session)
    print(f"session {session.stem.name}  park={session.header['park']}  "
          f"{session.header.get('frames', '?')} frames recorded")

    survivors = prefilter(session, actors,
                          min(args.limit or args.prefilter, args.prefilter))
    widest = max(a["stride"] for a in actors)
    print(f"prefilter kept {len(survivors)} of "
          f"{len(range(0, widest - 12 + 1, 4))} offsets", flush=True)

    result = score(session, actors, survivors, args.limit)
    ranked = sorted(result["stats"].items(),
                    key=lambda kv: (-kv[1]["locks"], -kv[1]["path"]))
    print(f"read {result['frames']} frames\n")

    print(f"{'offset':>8} {'signs':>11} {'in-play locks':>14} {'path':>9} "
          f"{'teleports':>10} {'grounded':>9}")
    for (offset, sx, sz, swap), stat in ranked[: args.top]:
        convention = f"{'z/x' if swap else 'x/z'} {sx:+.0f}{sz:+.0f}"
        print(f"  +0x{offset:03X} {convention:>11} {stat['locks']:14d} "
              f"{stat['path']:9.0f} {stat['teleports']:10d} "
              f"{stat['grounded'] / max(stat['samples'], 1):8.1%}")

    (offset, sx, sz, swap), best = ranked[0]
    if best["locks"] == 0:
        print("\nNo offset ever put an actor exactly where the ball was.\n"
              "Either no one handled the ball in this session, or the live\n"
              "position is not inside the captured region at all.")
        return 1

    print(f"\nlive position: +0x{offset:03X}")
    print(f"  an actor stood exactly on the ball for {best['locks']} frames "
          "of live play")
    print(f"  ball_x = {sx:+.0f} * actor_{'z' if swap else 'x'}")
    print(f"  ball_z = {sz:+.0f} * actor_{'x' if swap else 'z'}")
    print(f"  {best['path']:.0f}u of tracked movement, {best['teleports']} "
          "teleports (side changes and between-play resets)")

    runner_up = next((s for k, s in ranked[1:] if k[0] != offset), None)
    if runner_up and runner_up["locks"] > best["locks"] * 0.5:
        print(f"\n  NOTE: a different offset scored {runner_up['locks']} locks, "
              "close to the winner.\n  Treat the choice as unconfirmed.")

    out = Path(str(session.stem) + ".calibration.json")
    out.write_text(json.dumps({
        "session": session.stem.name,
        "position_offset": offset,
        "ball_frame": {"sign_x": sx, "sign_z": sz, "swap_xz": swap,
                       "lock_frames": best["locks"], "lock_units": LOCK_UNITS},
        "movement_units": round(best["path"], 1),
        "teleports": best["teleports"],
        "candidates": [
            {"offset": o, "sign_x": a, "sign_z": b, "swap_xz": c,
             "locks": s["locks"], "path": round(s["path"], 1),
             "teleports": s["teleports"]}
            for (o, a, b, c), s in ranked[: args.top]
        ],
    }, indent=2))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
