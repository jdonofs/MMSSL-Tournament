"""Record ball coordinates during play so each park's real fence can be measured.

The original stadium geometry used three hand-tapped points per park -- LF
pole, CF, RF pole -- and interpolated between them. Measured parks now keep a
dense world-coordinate fence in parkGeometry.js and derive the three artwork
references from it; this collector is how the remaining parks can be moved to
the same measured path.

The ball's own coordinates can settle it. A ball that strikes the wall stops
being a guess about the fence and becomes a measurement of it, in the same
world units every tracked distance already uses -- so the fence and the hit
distances end up on one scale by construction. World units are metres; feet are
only a display conversion at the edge.

This script is deliberately a separate Dolphin reader rather than another
patch to the tracker executable: no rebuild/verify cycle, nothing that can
break the working stat feed, and it can run at the same time as the tracker.

    pip install dolphin-memory-engine
    python scripts/collect_fence_samples.py --park mario_stadium

The practical way to use this is a WALL RUN: field the ball, then run the
warning track from one foul pole to the other while holding it. The ball's
coordinates follow whoever is carrying it, so one lap traces the whole fence at
every angle. Waiting for balls to actually strike the wall was tried first and
is not worth it -- they are hard to produce on purpose and a full session of
ordinary play yields almost none.

A carried ball reads short by the fielder's body radius. That bias is constant,
so the fence SHAPE comes out right and only the overall radius needs a single
correction later (--offset on the analysis step).

The live coverage map shows which angles have been traced, so gaps are visible
while you are still out there. Ctrl-C to stop; samples go to
scripts/fence_samples/<park>-<timestamp>.csv, and multiple sessions per park
accumulate. Then:

    python scripts/derive_fence_geometry.py --park mario_stadium
"""
from __future__ import annotations

import argparse
import csv
import math
import struct
import sys
import time
from datetime import datetime
from pathlib import Path

from probe_ball_memory import (
    BALL_POINTER_SLOT,
    FALLBACK_OFFSET,
    hook,
    plausible_position,
    resolve_offset,
)

# Matches the park keys in tracker_field_projection.mjs. Restricting the flag to
# this list keeps a typo from quietly starting a session whose samples no
# analysis step will ever look for.
PARK_KEYS = (
    "mario_stadium",
    "yoshi_park",
    "wario_city",
    "dk_jungle",
    "bowser_castle",
    "bowser_jr_playroom",
    "daisy_cruiser",
    "peach_ice_garden",
    "luigis_mansion",
    "generic_field",
)

# Matches derive_fence_geometry.py. Only ever used to label the live readout --
# every stored sample stays in units -- but the label has to be right, because
# placing presses adaptively means comparing it against a park's reference
# distances while still out on the field. World coordinates use metres: the
# measured base paths cluster around 27u, and raw flight gravity is 9.9316u/s^2.
METERS_PER_UNIT = 1.0
FEET_PER_METER = 3.280839895013123
FEET_PER_UNIT = METERS_PER_UNIT * FEET_PER_METER

SAMPLE_HZ = 120
# While a hold is in progress the coordinates stop changing; write anyway at
# this interval so the hold's duration and position survive into the file.
HOLD_HEARTBEAT_SEC = 0.05
OUTPUT_DIR = Path(__file__).resolve().parent / "fence_samples"

# A wall strike is a sharp reversal of horizontal travel: the ball is moving
# outward, then is moving inward, within a frame or two, with real speed still
# on it. Detected live only to give the session useful feedback -- the
# authoritative pass runs offline in derive_fence_geometry.py, which can afford
# to look both directions in time around a candidate.
MIN_WALL_RADIUS_UNITS = 40.0
MIN_WALL_SPEED_UNITS_PER_SEC = 8.0
# Above this the ball is over the fence rather than off it, so a reversal is
# something else (a catch, or the top of an arc). The tallest walls in this
# game sit well under 10 units.
MAX_WALL_HEIGHT_UNITS = 12.0

# Fence measurements are binned by spray angle, straightaway centre = 0.
BIN_DEGREES = 5.0
MIN_ANGLE = -50.0
MAX_ANGLE = 50.0


def angle_degrees(x: float, z: float) -> float:
    return math.degrees(math.atan2(x, -z))


def radius_units(x: float, z: float) -> float:
    return math.sqrt((x * x) + (z * z))


def bin_index(angle: float) -> int | None:
    if angle < MIN_ANGLE or angle >= MAX_ANGLE:
        return None
    return int((angle - MIN_ANGLE) // BIN_DEGREES)


def bin_count() -> int:
    return int((MAX_ANGLE - MIN_ANGLE) / BIN_DEGREES)


class CoverageMap:
    """Best radius seen per angle bin, and confirmed wall strikes per bin."""

    def __init__(self) -> None:
        self.max_radius = [0.0] * bin_count()
        self.wall_hits = [0] * bin_count()

    def record_sample(self, angle: float, radius: float) -> None:
        index = bin_index(angle)
        if index is not None and radius > self.max_radius[index]:
            self.max_radius[index] = radius

    def record_wall_hit(self, angle: float) -> None:
        index = bin_index(angle)
        if index is not None:
            self.wall_hits[index] += 1

    def render(self) -> str:
        # One column per bin, left field on the left. A digit is the number of
        # confirmed wall strikes there; '.' means the bin has only envelope
        # samples, ' ' means nothing has ever gone there.
        cells = []
        for index in range(bin_count()):
            if self.wall_hits[index]:
                cells.append(str(min(9, self.wall_hits[index])))
            elif self.max_radius[index] > 0:
                cells.append(".")
            else:
                cells.append(" ")
        return "".join(cells)


# A press is the ball sitting still, far from home, for long enough that it is
# clearly a character leaning on the wall rather than passing through. Held
# head-on, the collision resolves to the same spot every time, which is what
# makes this repeatable in a way a tangential run is not.
PRESS_STILL_SPEED = 2.0
PRESS_MIN_HOLD_SEC = 0.40


class PressDetector:
    """Detect 'held against the wall' intervals in the coordinate stream."""

    def __init__(self, min_radius: float = MIN_WALL_RADIUS_UNITS) -> None:
        # Landmarks (bases, the rubber) sit far inside the fence, so the radius
        # floor that keeps a fence press from catching infield noise has to
        # come off when the target IS the infield.
        self.min_radius = min_radius
        self.previous: tuple[float, float, float, int] | None = None
        self.hold: list[tuple[float, float]] = []
        self.hold_start_ns: int | None = None
        self.reported = False

    def push(self, x: float, y: float, z: float, t_ns: int):
        result = None
        radius = radius_units(x, z)
        speed = None
        if self.previous is not None:
            px, py, pz, pt = self.previous
            dt = (t_ns - pt) / 1_000_000_000
            if dt > 0:
                speed = math.hypot(x - px, z - pz) / dt
        self.previous = (x, y, z, t_ns)

        still = (
            speed is not None
            and speed < PRESS_STILL_SPEED
            and radius >= self.min_radius
        )
        if still:
            if self.hold_start_ns is None:
                self.hold_start_ns = t_ns
                self.reported = False
            self.hold.append((angle_degrees(x, z), radius))
            held = (t_ns - self.hold_start_ns) / 1_000_000_000
            if held >= PRESS_MIN_HOLD_SEC and not self.reported:
                self.reported = True
                angles = sorted(a for a, _ in self.hold)
                radii = sorted(r for _, r in self.hold)
                mid = len(radii) // 2
                result = (angles[mid], radii[mid], len(radii))
        else:
            self.hold = []
            self.hold_start_ns = None
            self.reported = False
        return result


class WallDetector:
    """Live, best-effort wall-strike detection over the coordinate stream."""

    def __init__(self) -> None:
        self.previous: tuple[float, float, float, int] | None = None
        self.previous_velocity: tuple[float, float] | None = None
        self.last_hit_ns = 0

    def push(self, x: float, y: float, z: float, t_ns: int):
        result = None
        if self.previous is not None:
            px, py, pz, pt = self.previous
            dt = (t_ns - pt) / 1_000_000_000
            if dt > 0:
                vx = (x - px) / dt
                vz = (z - pz) / dt
                speed = math.sqrt((vx * vx) + (vz * vz))
                if self.previous_velocity is not None and speed >= MIN_WALL_SPEED_UNITS_PER_SEC:
                    ovx, ovz = self.previous_velocity
                    # Reversal: horizontal travel now opposes what it was.
                    if (ovx * vx) + (ovz * vz) < 0:
                        radius = radius_units(px, pz)
                        # One strike per bounce, not one per frame of it.
                        recently = (t_ns - self.last_hit_ns) / 1_000_000_000 < 0.5
                        if (
                            radius >= MIN_WALL_RADIUS_UNITS
                            and py <= MAX_WALL_HEIGHT_UNITS
                            and not recently
                        ):
                            self.last_hit_ns = t_ns
                            result = (angle_degrees(px, pz), radius, py)
                if speed > 0:
                    self.previous_velocity = (vx, vz)
        self.previous = (x, y, z, t_ns)
        return result


def open_writer(park: str, mode: str):
    # The mode is in the filename because the two kinds of session must never
    # be pooled. A wall run is read as "the furthest point at this angle is the
    # fence", which is true of a carried ball and badly false of a home run --
    # mixing one batting session in would push the fence out past the wall.
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    path = OUTPUT_DIR / f"{park}-{mode}-{stamp}.csv"
    handle = path.open("w", newline="", encoding="utf-8")
    writer = csv.writer(handle)
    writer.writerow(["seq", "t_ns", "x", "y", "z"])
    return path, handle, writer


def lock_offset(dme) -> int:
    """Block until the coordinate offset is known good, before any recording.

    The offset is chosen PER STADIUM LOAD, not once per build -- switching
    parks moves it (Bowser Castle came up 0x558 against a 0x720 seed), so
    FALLBACK_OFFSET is wrong more often than right and there is nothing to
    "update" it to.

    resolve_offset() only matches at a pitch reset, and a press or landmark
    session never returns to one -- the ball is carried from the first press to
    the last. So starting mid-play silently takes the stale fallback and reads
    (0, 0, 0) forever: a full Bowser Castle session wrote 4301 all-zero rows
    with nothing printed and nothing raised. Waiting a few seconds here for a
    real signature match is the whole cost of never doing that again.
    """
    warned = False
    while True:
        try:
            pointer = int.from_bytes(dme.read_bytes(BALL_POINTER_SLOT, 4), "big")
            if pointer:
                offset = resolve_offset(dme, pointer)
                if offset is not None:
                    x, y, z = struct.unpack(">fff", dme.read_bytes(pointer + offset, 12))
                    if plausible_position(x, y, z):
                        print(f"coordinate offset  0x{offset:03X}  (pitch-reset signature)")
                        if offset != FALLBACK_OFFSET:
                            print(
                                f"                   differs from the 0x{FALLBACK_OFFSET:03X} seed"
                                f" -- expected, the offset is chosen per\n"
                                f"                   stadium load. Nothing to update; the tracker"
                                f" exe resolves it the same way."
                            )
                        return offset
        except Exception:
            pass
        if not warned:
            print("\nWaiting for a pitch reset to calibrate -- stand at the plate between")
            print("pitches with the ball on the mound. Recording starts once it locks.")
            warned = True
        time.sleep(0.25)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--park",
        required=True,
        choices=PARK_KEYS,
        help="which stadium this session is being played in",
    )
    parser.add_argument(
        "--mode",
        choices=("press", "landmark", "wallrun", "play"),
        default="press",
        help=(
            "press (default): carrying the ball, run straight INTO the wall at "
            "a series of angles and hold. wallrun: run along the warning track "
            "instead -- easier, but a tangential run's offset varies with how "
            "well the wall is hugged, so it is the less precise method. play: "
            "ordinary batting, kept separate so batted balls never contaminate "
            "a fence measurement."
        ),
    )
    args = parser.parse_args()

    dme = hook()
    path, handle, writer = open_writer(args.park, args.mode)
    coverage = CoverageMap()
    detector = WallDetector()
    presses = PressDetector(min_radius=0.0 if args.mode == "landmark" else MIN_WALL_RADIUS_UNITS)

    print(f"park     {args.park}")
    print(f"mode     {args.mode}")
    print(f"writing  {path}")
    locked_offset = lock_offset(dme)
    if args.mode == "landmark":
        print("\nCarry the ball and stand still on each landmark in turn -- home plate,")
        print("first, second, third, the pitcher's rubber. Hold about a second on each.")
        print("These fix the infield in game units, which is what converts every other")
        print("measurement into feet without timing anything. Ctrl-C when done.\n")
    elif args.mode == "press":
        print("\nCarry the ball. At each angle, run STRAIGHT INTO the wall, hold for")
        print("about a second, then move to the next angle and repeat. Work across")
        print("the outfield in even steps -- pole, gap, centre, gap, pole.")
        print("Each hold prints below once it registers. Ctrl-C when done.\n")
    else:
        print("\nField the ball, then run the warning track from pole to pole while")
        print("holding it. Watch samples= climb to confirm the ball is tracking you.")
        print("Keep the run continuous; the coverage bar fills as you go. Ctrl-C when done.\n")

    coordinate_offset = locked_offset
    last_coordinates = None
    last_change_ns = time.perf_counter_ns()
    last_write_ns = 0
    sequence = 0
    wall_hits = 0
    last_render = 0.0

    try:
        while True:
            time.sleep(1 / SAMPLE_HZ)
            now_ns = time.perf_counter_ns()

            try:
                pointer = int.from_bytes(dme.read_bytes(BALL_POINTER_SLOT, 4), "big")
                if pointer == 0:
                    continue
                # Same runtime calibration the tracker uses: the offset of the
                # position field inside the ball object is not stable across
                # builds/loads, so it is found from the pitch-reset signature
                # rather than hardcoded, and re-found if the feed freezes.
                if coordinate_offset is None:
                    # Falls back to the offset locked at startup, not the
                    # module constant: the constant is the value that was
                    # already proven stale, and re-taking it mid-session would
                    # turn a recoverable freeze into silent zeros.
                    coordinate_offset = resolve_offset(dme, pointer) or locked_offset
                raw = dme.read_bytes(pointer + coordinate_offset, 12)
                x, y, z = struct.unpack(">fff", raw)
            except Exception:
                continue

            unchanged = (x, y, z) == last_coordinates
            if unchanged:
                # A frozen feed during play is the signature of the offset
                # having moved; drop it so the next pass recalibrates.
                if (now_ns - last_change_ns) / 1_000_000_000 >= 15:
                    coordinate_offset = None
                    last_change_ns = now_ns
                # Skipping unchanged coordinates keeps flight tracking clean,
                # but for press/landmark work the unchanged samples ARE the
                # measurement: a character standing perfectly still emits no
                # change at all, so the most careful holds would write nothing
                # and vanish. Keep a slow heartbeat during those so a hold is
                # visible as data rather than as a silence to be inferred.
                if args.mode not in ("press", "landmark"):
                    continue
                if (now_ns - last_write_ns) / 1_000_000_000 < HOLD_HEARTBEAT_SEC:
                    continue
            else:
                last_coordinates = (x, y, z)
                last_change_ns = now_ns

            sequence += 1
            last_write_ns = now_ns
            writer.writerow([sequence, now_ns, f"{x:.9g}", f"{y:.9g}", f"{z:.9g}"])

            radius = radius_units(x, z)
            angle = angle_degrees(x, z)
            if radius >= MIN_WALL_RADIUS_UNITS and y <= MAX_WALL_HEIGHT_UNITS:
                coverage.record_sample(angle, radius)

            if args.mode in ("press", "landmark"):
                press = presses.push(x, y, z, now_ns)
                if press is not None:
                    press_angle, press_radius, held_samples = press
                    wall_hits += 1
                    coverage.record_wall_hit(press_angle)
                    if args.mode == "landmark":
                        # Landmarks are read as raw coordinates: a base sits at
                        # a specific spot, not merely a distance from home.
                        print(
                            f"  landmark #{wall_hits:<3} x={x:+8.3f} z={z:+8.3f}"
                            f"  dist_from_home={press_radius:7.3f}u"
                            f"  n={held_samples}"
                        )
                    else:
                        print(
                            f"  press #{wall_hits:<3} angle={press_angle:+6.1f}deg"
                            f"  radius={press_radius:6.2f}u"
                            f"  ({press_radius * FEET_PER_UNIT:5.1f} ft)"
                            f"  n={held_samples}"
                        )

            hit = detector.push(x, y, z, now_ns) if args.mode == "play" else None
            if hit is not None:
                hit_angle, hit_radius, hit_height = hit
                wall_hits += 1
                coverage.record_wall_hit(hit_angle)
                print(
                    f"  wall strike  angle={hit_angle:+6.1f}deg"
                    f"  radius={hit_radius:6.1f}u"
                    f"  height={hit_height:5.1f}u"
                    f"  (total {wall_hits})"
                )

            if now_ns - last_render > 2_000_000_000:
                last_render = now_ns
                sys.stdout.write(
                    f"\r  coverage [{coverage.render()}]  samples={sequence}  "
                )
                sys.stdout.flush()
    except KeyboardInterrupt:
        print("\n")
    finally:
        handle.close()

    print(f"samples       {sequence}")
    print(f"wall strikes  {wall_hits}")
    print(f"written to    {path}")
    print(f"\nLF{' ' * (bin_count() - 4)}RF")
    print(f"  [{coverage.render()}]")
    print(f"\nNext: python scripts/derive_fence_geometry.py --park {args.park}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
