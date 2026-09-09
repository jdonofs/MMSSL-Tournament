"""Turn recorded ball coordinates into a measured fence curve for a park.

Reads the CSVs written by collect_fence_samples.py and reports, per spray-angle
bin, how far the outfield wall actually is -- in game units, and in feet under
the canonical 1-metre-per-unit convention.

Two independent signals are used, and they are reported separately because they
are not equally trustworthy:

  wall strike  The ball's horizontal travel reverses within a frame or two,
               with real speed still on it, low to the ground and far from
               home. That is the wall, measured directly. High confidence.

  envelope     The furthest any ball has been seen at that angle while below
               wall height. The fence is at least this far out. A lower bound
               that tightens as more balls are hit there.

The awkward case is an outfielder who catches a ball and throws it back in:
horizontal travel does reverse. What separates it from a wall is time -- a
catch-and-throw holds the ball for a beat, a wall does not -- so a reversal is
only believed if it completes within REVERSAL_WINDOW_SEC and never drops near
a standstill. Ground bounces are ignored for free, since they reverse the
vertical axis and leave horizontal travel alone.

    python scripts/derive_fence_geometry.py --park mario_stadium
    python scripts/derive_fence_geometry.py --park mario_stadium --emit-js

The comparison table at the end is useful on a first run: it puts the measured
fence next to the current LF/CF/RF artwork references. On an unmeasured park
those are still timing-derived; once the measured curve is adopted, they are
regenerated from it and become a consistency check.
"""
from __future__ import annotations

import argparse
import csv
import math
import re
import statistics
from pathlib import Path

# Fence geometry is measured and stored in UNITS; feet are only ever a label
# applied at the end. World coordinates use metres -- see FEET_PER_UNIT in
# patch_tracker_advanced_stats.py and the independent infield/gravity checks in
# fit_infield_scale.py and backtest_hr_projection.mjs.
METERS_PER_UNIT = 1.0
FEET_PER_METER = 3.280839895013123
FEET_PER_UNIT = METERS_PER_UNIT * FEET_PER_METER

SAMPLES_DIR = Path(__file__).resolve().parent / "fence_samples"
GEOMETRY_FILE = Path(__file__).resolve().parent / "tracker_field_projection.mjs"

BIN_DEGREES = 5.0
MIN_ANGLE = -50.0
MAX_ANGLE = 50.0

# A flight ends when the feed goes quiet; the next samples are a new play.
FLIGHT_GAP_SEC = 0.75
# Velocity is measured across this many samples on each side of a candidate, so
# a single noisy frame cannot manufacture or hide a reversal.
VELOCITY_SPAN = 3
# A wall reversal is effectively instantaneous. A catch-and-throw is not.
REVERSAL_WINDOW_SEC = 0.06
MIN_APPROACH_SPEED = 8.0
# A wall returns a real share of the ball's speed. A glove does not.
MIN_REBOUND_FRACTION = 0.20
MIN_WALL_RADIUS_UNITS = 40.0
MAX_WALL_HEIGHT_UNITS = 12.0


def angle_degrees(x: float, z: float) -> float:
    return math.degrees(math.atan2(x, -z))


def radius_units(x: float, z: float) -> float:
    return math.sqrt((x * x) + (z * z))


def bin_count() -> int:
    return int((MAX_ANGLE - MIN_ANGLE) / BIN_DEGREES)


def bin_index(angle: float) -> int | None:
    if angle < MIN_ANGLE or angle >= MAX_ANGLE:
        return None
    return int((angle - MIN_ANGLE) // BIN_DEGREES)


def bin_center(index: int) -> float:
    return MIN_ANGLE + (index * BIN_DEGREES) + (BIN_DEGREES / 2)


def load_samples(park: str, mode: str) -> list[list[tuple[int, float, float, float]]]:
    """Session CSVs for this park, split into individual flights.

    A wall run reads the furthest point at each angle as the fence, which holds
    for a carried ball and fails badly for a home run -- so it only ever loads
    files recorded in wallrun mode. Impact hunting wants live play instead.
    """
    suffix = {"press": "press", "wall-run": "wallrun", "impacts": "play"}[mode]
    pattern = f"{park}-{suffix}-*.csv"
    paths = sorted(SAMPLES_DIR.glob(pattern))
    if not paths:
        legacy = sorted(SAMPLES_DIR.glob(f"{park}-2*.csv"))
        hint = (
            f"\n({len(legacy)} untagged file(s) from before sessions were "
            f"labelled are being skipped -- they are batting data, and a\n"
            f"batted ball is not evidence of where the wall is.)"
            if legacy and mode == "wall-run" else ""
        )
        raise SystemExit(
            f"No {mode} sample files for {park} in {SAMPLES_DIR}.{hint}\n\n"
            f"  python scripts/collect_fence_samples.py --park {park}"
        )

    flights: list[list[tuple[int, float, float, float]]] = []
    for path in paths:
        current: list[tuple[int, float, float, float]] = []
        previous_ns = None
        with path.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                try:
                    t_ns = int(row["t_ns"])
                    x, y, z = float(row["x"]), float(row["y"]), float(row["z"])
                except (KeyError, ValueError):
                    continue
                if previous_ns is not None and (t_ns - previous_ns) / 1e9 > FLIGHT_GAP_SEC:
                    if len(current) > VELOCITY_SPAN * 2:
                        flights.append(current)
                    current = []
                current.append((t_ns, x, y, z))
                previous_ns = t_ns
        if len(current) > VELOCITY_SPAN * 2:
            flights.append(current)
    print(f"read {len(paths)} session file(s), {len(flights)} flights")
    return flights


def horizontal_velocity(samples, start: int, end: int):
    t0, x0, _, z0 = samples[start]
    t1, x1, _, z1 = samples[end]
    dt = (t1 - t0) / 1e9
    if dt <= 0:
        return None, 0.0
    vx, vz = (x1 - x0) / dt, (z1 - z0) / dt
    return (vx, vz), math.sqrt((vx * vx) + (vz * vz))


def find_wall_strikes(flight) -> list[tuple[float, float, float]]:
    """(angle, radius, height) for each reversal that looks like a wall."""
    strikes = []
    for index in range(VELOCITY_SPAN, len(flight) - VELOCITY_SPAN):
        t_ns, x, y, z = flight[index]
        radius = radius_units(x, z)
        if radius < MIN_WALL_RADIUS_UNITS or y > MAX_WALL_HEIGHT_UNITS:
            continue

        before, approach_speed = horizontal_velocity(flight, index - VELOCITY_SPAN, index)
        after, rebound_speed = horizontal_velocity(flight, index, index + VELOCITY_SPAN)
        if before is None or after is None:
            continue
        if approach_speed < MIN_APPROACH_SPEED:
            continue
        if rebound_speed < approach_speed * MIN_REBOUND_FRACTION:
            continue
        # Travel must actually oppose itself, not merely turn.
        if (before[0] * after[0]) + (before[1] * after[1]) >= 0:
            continue
        # A wall reverses the ball at once. A fielder holds it first, so the
        # samples spanning the reversal cover a longer stretch of time.
        window = (flight[index + VELOCITY_SPAN][0] - flight[index - VELOCITY_SPAN][0]) / 1e9
        if window > REVERSAL_WINDOW_SEC:
            continue
        # The contact should sit at the outermost point of the flight, not
        # partway up a curve that happens to wobble.
        if radius < max(radius_units(s[1], s[3]) for s in flight) - 3.0:
            continue
        strikes.append((angle_degrees(x, z), radius, y))
    # Collapse the frames of a single bounce into one measurement.
    collapsed = []
    for strike in strikes:
        if collapsed and abs(strike[0] - collapsed[-1][0]) < 2.0:
            continue
        collapsed.append(strike)
    return collapsed


def build_fence(flights):
    strikes_by_bin: list[list[float]] = [[] for _ in range(bin_count())]
    envelope = [0.0] * bin_count()
    heights: list[float] = []

    for flight in flights:
        for t_ns, x, y, z in flight:
            if y > MAX_WALL_HEIGHT_UNITS:
                continue
            radius = radius_units(x, z)
            if radius < MIN_WALL_RADIUS_UNITS:
                continue
            index = bin_index(angle_degrees(x, z))
            if index is not None and radius > envelope[index]:
                envelope[index] = radius
        for angle, radius, height in find_wall_strikes(flight):
            index = bin_index(angle)
            if index is not None:
                strikes_by_bin[index].append(radius)
                heights.append(height)

    return strikes_by_bin, envelope, heights


def report(park: str, strikes_by_bin, envelope, heights):
    print(f"\n{'angle':>8}  {'n':>3}  {'fence(u)':>9}  {'fence(ft)':>9}  source")
    print("-" * 52)
    measured = {}
    for index in range(bin_count()):
        strikes = strikes_by_bin[index]
        if strikes:
            radius = statistics.median(strikes)
            source = "wall strike"
        elif envelope[index] > 0:
            radius = envelope[index]
            source = "envelope (min)"
        else:
            continue
        measured[index] = (radius, bool(strikes))
        print(
            f"{bin_center(index):+8.1f}  {len(strikes):>3}  {radius:>9.2f}  "
            f"{radius * FEET_PER_UNIT:>9.1f}  {source}"
        )

    if not measured:
        print("  nothing usable yet -- collect more samples")
        return measured
    confirmed = sum(1 for _, is_strike in measured.values() if is_strike)
    print(f"\n{confirmed}/{bin_count()} bins have a confirmed wall strike")
    if heights:
        print(
            f"wall height  median {statistics.median(heights):.2f}u "
            f"({statistics.median(heights) * FEET_PER_UNIT:.1f} ft) "
            f"over {len(heights)} strikes"
        )
    return measured


def parse_existing_geometry(park: str):
    """The current hand-entered wallRefs for this park, as (angle, dist)."""
    try:
        text = GEOMETRY_FILE.read_text(encoding="utf-8")
    except OSError:
        return None
    block = re.search(
        rf"{park}:\s*\{{\s*homePlate:\s*\{{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+)\s*\}},"
        rf"\s*wallRefs:\s*\[(.*?)\]",
        text,
        re.DOTALL,
    )
    if not block:
        return None
    home_x, home_y = float(block.group(1)), float(block.group(2))
    refs = []
    for ref_x, ref_y, dist in re.findall(
        r"\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+),\s*dist:\s*([\d.]+)\s*\}", block.group(3)
    ):
        dx, dy = float(ref_x) - home_x, float(ref_y) - home_y
        refs.append((math.degrees(math.atan2(dx, -dy)), float(dist)))
    return sorted(refs)


# The stored wallRefs are LF pole / CF / RF pole. Their x/y percentages were
# tapped on a perspective-rendered image, so the angles derived from them are
# distorted and are NOT world angles -- comparing at those angles put our
# fence at 32.5 degrees next to a foul-pole number belonging at 45, and
# manufactured a 40-foot disagreement out of nothing. The refs' real world
# angles are the geometry they describe: the foul lines and straightaway
# centre.
CANONICAL_REF_ANGLES = (-45.0, 0.0, 45.0)


def measured_at_angle(points, angle):
    """Interpolate the measured curve at one angle, or None if uncovered."""
    below = [p for p in points if p[0] <= angle]
    above = [p for p in points if p[0] >= angle]
    # A press taken a fraction of a degree inside the foul line is the pole for
    # this purpose; refusing to answer because it fell barely short of an exact
    # 45.0 would report "no data" for a measurement that plainly exists.
    if not below:
        nearest = min(points)
        return nearest[1] if nearest[0] - angle <= 2.0 else None
    if not above:
        nearest = max(points)
        return nearest[1] if angle - nearest[0] <= 2.0 else None
    low = max(below)
    high = min(above)
    if low[0] == high[0]:
        return low[1]
    fraction = (angle - low[0]) / (high[0] - low[0])
    return low[1] + fraction * (high[1] - low[1])


def compare_at_poles(park: str, points):
    existing = parse_existing_geometry(park)
    if not existing or not points:
        return
    print("\nagainst the Reddit run-timing numbers, at the angles they describe:")
    print(f"{'':>10}  {'theirs(ft)':>10}  {'ours(ft)':>9}  {'diff':>8}  {'':>6}")
    print("-" * 50)
    labels = ("LF pole", "CF", "RF pole")
    dists = [d for _a, d in existing]
    for label, angle, stored in zip(labels, CANONICAL_REF_ANGLES, dists):
        radius = measured_at_angle(points, angle)
        if radius is None:
            print(f"{label:>10}  {stored:>10.0f}  {'--':>9}  {'no data':>8}")
            continue
        ours = radius * FEET_PER_UNIT
        print(
            f"{label:>10}  {stored:>10.0f}  {ours:>9.1f}  {ours - stored:>+8.1f}  "
            f"{(ours - stored) / stored * 100:>+5.1f}%"
        )
    print("Ours is the FIELDER limit, so the true wall is further still --")
    print("which widens these gaps rather than closing them.")


def compare(park: str, measured):
    existing = parse_existing_geometry(park)
    if not existing:
        print(f"\n(no stored wallRefs found for {park} to compare against)")
        return
    print(f"\nstored wallRefs vs measured, at the angles those refs sit at:")
    print(f"{'angle':>8}  {'stored(ft)':>10}  {'measured(ft)':>12}  {'diff':>8}")
    print("-" * 46)
    for angle, stored in existing:
        index = bin_index(angle)
        if index is None or index not in measured:
            print(f"{angle:+8.1f}  {stored:>10.0f}  {'--':>12}  {'no data':>8}")
            continue
        radius, is_strike = measured[index]
        measured_ft = radius * FEET_PER_UNIT
        flag = "" if is_strike else "  (lower bound)"
        print(
            f"{angle:+8.1f}  {stored:>10.0f}  {measured_ft:>12.1f}  "
            f"{measured_ft - stored:>+8.1f}{flag}"
        )


def emit_js(park: str, measured):
    print(f"\n  // Measured from tracked ball coordinates, not hand-tapped.")
    print(f"  {park}: {{")
    print(f"    fenceUnits: [")
    for index in sorted(measured):
        radius, is_strike = measured[index]
        note = "measured" if is_strike else "lower bound"
        print(
            f"      {{ angle: {bin_center(index):.1f}, r: {radius:.2f} }},"
            f"  // {note}"
        )
    print(f"    ],")
    print(f"  }},")


# --- wall-run mode ---------------------------------------------------------
#
# Waiting for balls to strike the wall turned out to be impractical: they are
# hard to produce on purpose, and a session of ordinary play yields almost
# none. Carrying the ball along the warning track instead traces the fence
# directly -- the ball's coordinates follow whoever is holding it, so a lap of
# the outfield is a dense sweep of every angle at once, which is strictly more
# information than a handful of scattered impacts.
#
# The cost is a constant inward bias: a fielder pressed against the wall still
# has a body between the ball and the padding. That bias is systematic rather
# than noisy, so the recovered fence SHAPE is right and only the overall radius
# is short by roughly a body's width. --offset applies the correction once the
# size of it is known; the shape is usable before then.


def wall_run_curve(flights, offset_units: float):
    outer = [0.0] * bin_count()
    for flight in flights:
        for _t, x, y, z in flight:
            if y > MAX_WALL_HEIGHT_UNITS:
                continue
            radius = radius_units(x, z)
            index = bin_index(angle_degrees(x, z))
            if index is not None and radius > outer[index]:
                outer[index] = radius
    return {
        index: (radius + offset_units)
        for index, radius in enumerate(outer)
        if radius >= MIN_WALL_RADIUS_UNITS
    }


def report_wall_run(park: str, curve, offset_units: float):
    if not curve:
        print("\nNo samples far enough out to be a wall run.")
        print("Field the ball and run the warning track with it, then re-run.")
        return {}

    print(f"\n{'angle':>8}  {'fence(u)':>9}  {'fence(ft)':>9}")
    print("-" * 32)
    for index in sorted(curve):
        radius = curve[index]
        print(
            f"{bin_center(index):+8.1f}  {radius:>9.2f}  {radius * FEET_PER_UNIT:>9.1f}"
        )

    filled = sorted(curve)
    span = filled[-1] - filled[0] + 1
    gaps = span - len(filled)
    print(f"\n{len(filled)}/{bin_count()} bins traced, "
          f"{bin_center(filled[0]):+.1f} to {bin_center(filled[-1]):+.1f} degrees")
    if gaps:
        print(f"{gaps} gap(s) inside the traced arc -- keep the run continuous")
    if offset_units:
        print(f"offset applied: {offset_units:+.2f}u "
              f"({offset_units * FEET_PER_UNIT:+.1f} ft)")
    else:
        print("no offset applied -- these read short by the fielder's body radius")
    # Reported as a lower bound so a carried-ball trace is never mistaken for a
    # direct measurement of the padding itself.
    return {index: (radius, False) for index, radius in curve.items()}


# --- press mode ------------------------------------------------------------
#
# The most precise method available. Running ALONG a wall leaves the offset
# between character and padding at the mercy of how well the wall was hugged,
# moment to moment, and that error is tangential as well as radial. Running
# straight INTO the wall removes both problems: a head-on collision resolves to
# the same spot every time, so the residual offset is a single constant in the
# radial direction. Repeating an angle then measures the method's own precision
# instead of leaving it assumed.

PRESS_STILL_SPEED = 2.0
PRESS_MIN_HOLD_SEC = 0.40


def find_presses(flight):
    """(angle, radius) for each interval the ball is held still, far out."""
    found = []
    run: list[tuple[float, float]] = []
    start_ns = None
    for index in range(1, len(flight)):
        t_ns, x, y, z = flight[index]
        pt, px, _py, pz = flight[index - 1]
        dt = (t_ns - pt) / 1e9
        speed = math.hypot(x - px, z - pz) / dt if dt > 0 else 0.0
        radius = radius_units(x, z)
        if speed < PRESS_STILL_SPEED and radius >= MIN_WALL_RADIUS_UNITS:
            if start_ns is None:
                start_ns = t_ns
            run.append((angle_degrees(x, z), radius))
        else:
            if start_ns is not None and (pt - start_ns) / 1e9 >= PRESS_MIN_HOLD_SEC:
                found.append(_summarise_press(run))
            run, start_ns = [], None
    if start_ns is not None and run and (flight[-1][0] - start_ns) / 1e9 >= PRESS_MIN_HOLD_SEC:
        found.append(_summarise_press(run))
    return found


def _summarise_press(run):
    angles = sorted(a for a, _ in run)
    radii = sorted(r for _, r in run)
    mid = len(radii) // 2
    return angles[mid], radii[mid]


# Two presses count as a repeat only if they are this close in angle. Wider
# apart, the fence has genuinely curved between them, and calling that
# disagreement measures the park rather than the measurement -- which is
# exactly what binning into 5-degree buckets did, inflating a real 0.8 ft
# error to a reported 4.5 ft near the foul poles where the fence turns fastest.
REPEAT_ANGLE_TOLERANCE_DEG = 1.5
# Coverage is judged by the largest angular gap rather than by bucket counts:
# a fence is a smooth curve, so evenly spaced points anywhere are worth more
# than clustered points that happen to fill named bins.
MAX_ACCEPTABLE_GAP_DEG = 6.0
TARGET_SPAN_DEG = 44.0


def collect_presses(flights):
    points = []
    for flight in flights:
        points.extend(find_presses(flight))
    points.sort()
    return points


def press_repeatability(points):
    """Spread between presses at effectively the same angle, in units."""
    diffs = []
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if abs(points[i][0] - points[j][0]) <= REPEAT_ANGLE_TOLERANCE_DEG:
                diffs.append(abs(points[i][1] - points[j][1]))
    return diffs


def report_presses(park: str, flights, offset_units: float):
    points = collect_presses(flights)
    if not points:
        print("\nNo presses found -- hold against the wall for a full second at each spot.")
        return {}

    print(f"\n{'angle':>9}  {'fence(u)':>9}  {'fence(ft)':>9}")
    print("-" * 33)
    for angle, radius in points:
        adjusted = radius + offset_units
        print(f"{angle:+9.2f}  {adjusted:>9.2f}  {adjusted * FEET_PER_UNIT:>9.1f}")

    gaps = [
        (points[i + 1][0] - points[i][0], points[i][0], points[i + 1][0])
        for i in range(len(points) - 1)
    ]
    worst_gap = max(gaps) if gaps else (0.0, 0.0, 0.0)
    diffs = press_repeatability(points)

    print(f"\n{len(points)} presses spanning {points[0][0]:+.1f} to {points[-1][0]:+.1f} degrees")
    print(f"largest gap    {worst_gap[0]:.1f} deg (between {worst_gap[1]:+.1f} and {worst_gap[2]:+.1f})")
    if diffs:
        median = statistics.median(diffs)
        print(
            f"repeatability  {median:.2f}u ({median * FEET_PER_UNIT:.1f} ft) median, "
            f"{max(diffs):.2f}u ({max(diffs) * FEET_PER_UNIT:.1f} ft) worst"
            f"  [{len(diffs)} pairs within {REPEAT_ANGLE_TOLERANCE_DEG} deg]"
        )
    else:
        print(f"repeatability  unmeasured -- press two spots within "
              f"{REPEAT_ANGLE_TOLERANCE_DEG} deg of each other")
    if offset_units:
        print(f"offset applied {offset_units:+.2f}u ({offset_units * FEET_PER_UNIT:+.1f} ft)")
    else:
        print("no offset applied -- reads short by one constant body radius")

    covered = min(abs(points[0][0]), abs(points[-1][0])) >= TARGET_SPAN_DEG
    even = worst_gap[0] <= MAX_ACCEPTABLE_GAP_DEG
    precise = bool(diffs) and statistics.median(diffs) * FEET_PER_UNIT < 1.5
    print()
    if covered and even and precise:
        print("READY: both foul lines reached, no large gaps, presses repeat cleanly.")
    else:
        if not covered:
            print(f"- reach further into the corners (want +/-{TARGET_SPAN_DEG:.0f} deg)")
        if not even:
            print(f"- fill the {worst_gap[0]:.1f} deg gap near {(worst_gap[1] + worst_gap[2]) / 2:+.1f} deg")
        if not precise:
            print("- press a few angles twice so repeatability can be measured")

    by_bin: dict[int, list[float]] = {}
    for angle, radius in points:
        index = bin_index(angle)
        if index is not None:
            by_bin.setdefault(index, []).append(radius)
    # The stored-geometry comparison downstream still speaks in bins, so
    # summarise into them for that purpose only -- the curve itself keeps every
    # press at the angle it was actually taken at.
    return {
        index: (statistics.median(radii) + offset_units, True)
        for index, radii in by_bin.items()
    }


PARK_KEYS = (
    "mario_stadium", "yoshi_park", "wario_city", "dk_jungle", "bowser_castle",
    "bowser_jr_playroom", "daisy_cruiser", "peach_ice_garden", "luigis_mansion",
)


def report_status() -> int:
    """One line per park: how much of its fence has been measured, how well."""
    print(f"{'park':>20}  {'span':>7}  {'presses':>7}  {'repeatability':>14}  status")
    print("-" * 72)
    done = 0
    for park in PARK_KEYS:
        paths = sorted(SAMPLES_DIR.glob(f"{park}-press-*.csv"))
        if not paths:
            print(f"{park:>20}  {'-':>7}  {'-':>7}  {'-':>14}  not started")
            continue
        try:
            flights = load_samples(park, "press")
        except SystemExit:
            print(f"{park:>20}  {'-':>7}  {'-':>7}  {'-':>14}  no usable holds")
            continue
        points = collect_presses(flights)
        if not points:
            print(f"{park:>20}  {'-':>7}  {'-':>7}  {'-':>14}  no usable presses")
            continue
        gaps = [points[i + 1][0] - points[i][0] for i in range(len(points) - 1)]
        worst_gap = max(gaps) if gaps else 0.0
        span = min(abs(points[0][0]), abs(points[-1][0]))
        diffs = press_repeatability(points)
        repeat = (
            f"{statistics.median(diffs) * FEET_PER_UNIT:.1f} ft"
            if diffs else "unmeasured"
        )
        covered = span >= TARGET_SPAN_DEG and worst_gap <= MAX_ACCEPTABLE_GAP_DEG
        precise = bool(diffs) and statistics.median(diffs) * FEET_PER_UNIT < 1.5
        ready = covered and precise
        if ready:
            done += 1
        if ready:
            note = "ready"
        elif not covered and span < TARGET_SPAN_DEG:
            note = f"reach the corners (+/-{span:.0f} so far)"
        elif not covered:
            note = f"fill a {worst_gap:.0f} deg gap"
        else:
            note = "press repeats to measure precision"
        print(
            f"{park:>20}  {f'+/-{span:.0f}':>7}  {len(points):>7}  "
            f"{repeat:>14}  {note}"
        )
    print(f"\n{done}/{len(PARK_KEYS)} parks measured")
    print(f"feet per unit in use: {FEET_PER_UNIT:.4f}")
    return 0


# --- offset mode -----------------------------------------------------------
#
# Presses measure where a CHARACTER stops, which is one body radius short of
# the padding. A ball has no such problem: a regulation ball is about 0.036
# units across at this scale, so a ball touching the wall is the wall.
#
# One ball that reaches the padding therefore pins the constant that every
# press in every park is short by. Balls that fall short of the wall read
# LOW, never high, so the largest ball-minus-press difference is the best
# estimate and it converges upward as more balls arrive -- which is why this
# reports every candidate rather than averaging them into a wrong answer.

# At the moment it touches the wall a ball is low. A ball clearing the fence is
# not, and would otherwise be read as a wall contact beyond the wall.
MAX_BALL_CONTACT_HEIGHT_UNITS = 6.0
# Ignore flights that never got near the fence at all.
NEAR_WALL_TOLERANCE_UNITS = 20.0


# Speed thresholds are deliberately low. A ball usually reaches the wall AFTER
# bouncing off the ground, which costs it most of its pace -- a real observed
# impact arrived at 2.4 units/sec. Demanding a fast liner rejects the common
# case and keeps the measurement permanently out of reach.
#
# Being permissive is safe here because of how the estimate is chosen. A ball
# caught short of the padding, or one that merely dribbled close, reads a
# SMALLER gap than a true wall contact -- never a larger one -- so taking the
# maximum across candidates is self-protecting. The one error that reads too
# large is a ball passing OVER the fence, which the height ceiling excludes.
MIN_BALL_OUTWARD_SPEED = 1.5
MIN_BALL_RETURN_SPEED = 0.5
CONTACT_VELOCITY_SPAN = 3


def radial_velocity(samples, start: int, end: int) -> float:
    """Rate of change of distance-from-home; the axis a wall actually acts on."""
    dt = (samples[end][0] - samples[start][0]) / 1e9
    if dt <= 0:
        return 0.0
    r0 = radius_units(samples[start][1], samples[start][3])
    r1 = radius_units(samples[end][1], samples[end][3])
    return (r1 - r0) / dt


def find_ball_wall_candidates(flights, press_points):
    """Per flight, the furthest a FAST-moving ball got, vs the press curve."""
    candidates = []
    for flight in flights:
        best = None
        for index in range(CONTACT_VELOCITY_SPAN, len(flight) - CONTACT_VELOCITY_SPAN):
            _t, x, y, z = flight[index]
            if y > MAX_BALL_CONTACT_HEIGHT_UNITS:
                continue
            radius = radius_units(x, z)
            if best is not None and radius <= best[0]:
                continue
            approach = radial_velocity(flight, index - CONTACT_VELOCITY_SPAN, index)
            rebound = radial_velocity(flight, index, index + CONTACT_VELOCITY_SPAN)
            # Driving outward, then travelling back inward: the ball met
            # something solid rather than simply running out of momentum.
            if approach < MIN_BALL_OUTWARD_SPEED:
                continue
            if rebound > -MIN_BALL_RETURN_SPEED:
                continue
            best = (radius, angle_degrees(x, z), y, approach, -rebound)
        if best is None:
            continue
        radius, angle, height, approach, rebound = best
        press_radius = measured_at_angle(press_points, angle)
        if press_radius is None:
            continue
        if radius < press_radius - NEAR_WALL_TOLERANCE_UNITS:
            continue
        candidates.append(
            (radius - press_radius, angle, radius, press_radius, height, approach, rebound)
        )
    candidates.sort(reverse=True)
    return candidates


def report_offset(park: str) -> int:
    try:
        press_flights = load_samples(park, "press")
    except SystemExit:
        print(f"Measure {park}'s fence with --mode press first.")
        return 1
    press_points = collect_presses(press_flights)
    if not press_points:
        print(f"No presses found for {park}.")
        return 1
    try:
        play_flights = load_samples(park, "impacts")
    except SystemExit:
        print(
            f"No play-mode recordings for {park}.\n"
            f"  python scripts/collect_fence_samples.py --park {park} --mode play\n"
            "Then hit a ball off the wall."
        )
        return 1

    candidates = find_ball_wall_candidates(play_flights, press_points)
    if not candidates:
        print("\nNo batted ball got near the fence in these recordings.")
        return 1

    print(
        f"\n{'angle':>8}  {'ball(u)':>8}  {'press(u)':>9}  {'gap(u)':>7}  "
        f"{'gap(ft)':>8}  {'height':>7}  {'out':>6}  {'back':>6}"
    )
    print("-" * 74)
    for gap, angle, radius, press_radius, height, approach, rebound in candidates[:12]:
        print(
            f"{angle:+8.1f}  {radius:>8.2f}  {press_radius:>9.2f}  {gap:>7.2f}  "
            f"{gap * FEET_PER_UNIT:>8.1f}  {height:>7.2f}  {approach:>6.1f}  {rebound:>6.1f}"
        )

    best_gap = candidates[0][0]
    print(f"\n{len(candidates)} candidate(s); best gap {best_gap:.2f}u "
          f"({best_gap * FEET_PER_UNIT:.1f} ft)")
    if best_gap <= 0:
        print("Every ball fell short of the press line, so no ball reached the")
        print("padding yet. Hit one off the wall.")
        return 1
    print(f"\nBODY RADIUS ESTIMATE  {best_gap:.2f}u ({best_gap * FEET_PER_UNIT:.2f} ft)")
    print(f"Apply to any park:  --mode press --offset {best_gap:.2f}")
    print("This is a lower bound: a ball that merely came close reads small, so")
    print("more wall balls can only push it up. Two or three agreeing settles it.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--park", required=True, help="park key, or 'all' for a status table")
    parser.add_argument(
        "--mode",
        choices=("press", "offset", "wall-run", "impacts"),
        default="press",
        help=(
            "press (default): discrete head-on pushes into the wall, the most "
            "repeatable method. offset: use a batted ball that reached the "
            "padding to measure how far short the presses read. wall-run: a "
            "continuous trace along the warning track. impacts: balls striking "
            "the wall during ordinary play."
        ),
    )
    parser.add_argument(
        "--offset",
        type=float,
        default=0.0,
        metavar="UNITS",
        help="add this to every radius, to correct the fielder-to-wall gap",
    )
    parser.add_argument(
        "--emit-js",
        action="store_true",
        help="print the measured curve as a JS block to paste into the geometry file",
    )
    args = parser.parse_args()

    if args.park == "all":
        return report_status()

    if args.mode == "offset":
        return report_offset(args.park)

    flights = load_samples(args.park, args.mode)
    if args.mode == "press":
        measured = report_presses(args.park, flights, args.offset)
        compare_at_poles(args.park, collect_presses(flights))
    elif args.mode == "wall-run":
        measured = report_wall_run(
            args.park, wall_run_curve(flights, args.offset), args.offset
        )
    else:
        strikes_by_bin, envelope, heights = build_fence(flights)
        measured = report(args.park, strikes_by_bin, envelope, heights)
    if measured:
        compare(args.park, measured)
        if args.emit_js:
            emit_js(args.park, measured)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
