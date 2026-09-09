"""Measure the infield and test the game's one-metre world-unit convention.

The landmark coordinates are the measurement; feet are only a display unit.
Earlier versions divided an assumed 90-foot base path by the measured 26.840
units and called the result a measured scale. That established the diamond's
shape, but it could not establish its absolute size: a slightly compressed
diamond has the same shape.

Two parks instead put their base paths at 26.840u and 26.991u, close to a round
27 metres, while Mario Stadium puts the rubber at 17.979u, close to 18 metres.
The independent check is ball flight: a scale-free fit recovers gravity at
9.9316u/s^2, within 1.28% of standard gravity if one unit is one metre. The
project therefore uses exactly 1 metre/unit (3.280839895 feet/unit).

This script still fits a square template to all four bases so centring errors
average out and so the residual exposes a malformed landmark pass. The
pitcher's rubber is held out by default and reported separately. Regulation
feet remain a comparison, never an input to the canonical conversion.

    python scripts/collect_fence_samples.py --park mario_stadium --mode landmark
    python scripts/fit_infield_scale.py --park mario_stadium
"""
from __future__ import annotations

import argparse
import csv
import math
import statistics
from pathlib import Path

SAMPLES_DIR = Path(__file__).resolve().parent / "fence_samples"

# Unitless regulation proportions in a canonical frame: home at the origin,
# second base straight out along -z, first base toward +x. The fit's scale is
# therefore the measured base path in game units, not units per assumed foot.
METERS_PER_UNIT = 1.0
FEET_PER_METER = 3.280839895013123
FEET_PER_UNIT = METERS_PER_UNIT * FEET_PER_METER
REGULATION_BASE_PATH_FT = 90.0
REGULATION_RUBBER_FT = 60.5
REGULATION_RUBBER_M = REGULATION_RUBBER_FT / FEET_PER_METER
ROUND_METRIC_BASE_PATH_M = 27.0
ROUND_METRIC_RUBBER_M = 18.0
_HALF = 1.0 / math.sqrt(2)
TEMPLATE = {
    "home": (0.0, 0.0),
    "1B": (_HALF, -_HALF),
    "2B": (0.0, -math.sqrt(2)),
    "3B": (-_HALF, -_HALF),
}
RUBBER_TEMPLATE = (0.0, -(REGULATION_RUBBER_FT / REGULATION_BASE_PATH_FT))

# A hold is the ball sitting still while a character stands on a landmark.
STILL_SPEED = 2.0
MIN_HOLD_SEC = 0.35
# Total drift allowed across a gap for it to count as standing still.
STILL_DRIFT_UNITS = 2.0
# Holds nearer than this to each other are the same landmark, revisited.
CLUSTER_RADIUS_UNITS = 6.0
# Landmarks get visited deliberately and repeatedly; a spot touched once or
# twice is the character wandering between them, or a stray throw. Dropping
# those keeps a wanderer from being mistaken for a base -- which matters
# because identification keys off which points are furthest apart.
MIN_VISITS = 3


def load_holds(park: str):
    # Landmark sessions only, when there are any. Press files are read as a
    # LAST RESORT -- they can yield infield holds for a park nobody ran a
    # landmark pass in, but mixing them into a real landmark session is
    # actively destructive: every wall press becomes a "hold", and identify()
    # keys off the two clusters furthest apart, so a pair of foul-pole presses
    # 84 units out gets labelled home and second. That produced a base path of
    # 78.6u base path for Luigi's Mansion -- not a worse fit, a
    # fit of the wrong shape entirely, and one that still prints a tidy table.
    paths = sorted(SAMPLES_DIR.glob(f"{park}-landmark-*.csv"))
    if not paths:
        paths = sorted(SAMPLES_DIR.glob(f"{park}-press-*.csv"))
    if not paths:
        raise SystemExit(
            f"No landmark files for {park}.\n"
            f"  python scripts/collect_fence_samples.py --park {park} --mode landmark"
        )

    holds = []
    for path in paths:
        rows = []
        for row in csv.DictReader(path.open(newline="", encoding="utf-8")):
            try:
                rows.append(
                    (int(row["t_ns"]), float(row["x"]), float(row["y"]), float(row["z"]))
                )
            except (KeyError, ValueError):
                continue
        run, start = [], None
        for index in range(1, len(rows)):
            t_ns, x, _y, z = rows[index]
            pt, px, _py, pz = rows[index - 1]
            dt = (t_ns - pt) / 1e9
            speed = math.hypot(x - px, z - pz) / dt if dt > 0 else 0.0

            # A perfectly still character emits no coordinate CHANGE, and the
            # collector only wrote changed values -- so the stillest, most
            # deliberate holds appear in the file as a gap between two nearly
            # identical rows rather than as a run of samples. That silence is
            # the measurement. Reading it as one recovers holds that would
            # otherwise be invisible precisely when they were performed best.
            if dt >= MIN_HOLD_SEC and math.hypot(x - px, z - pz) < STILL_DRIFT_UNITS:
                holds.append((px, pz))
                run, start = [], None
                continue

            if speed < STILL_SPEED:
                if start is None:
                    start = t_ns
                run.append((x, z))
            else:
                if start is not None and (pt - start) / 1e9 >= MIN_HOLD_SEC and run:
                    holds.append(
                        (
                            statistics.median([p[0] for p in run]),
                            statistics.median([p[1] for p in run]),
                        )
                    )
                run, start = [], None
        if start is not None and run and (rows[-1][0] - start) / 1e9 >= MIN_HOLD_SEC:
            holds.append(
                (
                    statistics.median([p[0] for p in run]),
                    statistics.median([p[1] for p in run]),
                )
            )
    return holds, len(paths)


def cluster(holds):
    """Group repeat visits to one landmark; the mean cancels centring error."""
    groups: list[list[tuple[float, float]]] = []
    for x, z in holds:
        for group in groups:
            cx = statistics.fmean([p[0] for p in group])
            cz = statistics.fmean([p[1] for p in group])
            if math.hypot(x - cx, z - cz) <= CLUSTER_RADIUS_UNITS:
                group.append((x, z))
                break
        else:
            groups.append([(x, z)])
    return [
        (
            statistics.fmean([p[0] for p in g]),
            statistics.fmean([p[1] for p in g]),
            len(g),
            # Scatter across repeat visits is the honest per-landmark error.
            max((math.hypot(p[0] - statistics.fmean([q[0] for q in g]),
                            p[1] - statistics.fmean([q[1] for q in g])) for p in g),
                default=0.0),
        )
        for g in groups
    ]


def identify(clusters):
    """Label clusters as home/1B/2B/3B/rubber by their layout.

    Home and second are the two furthest apart along the centre line; first and
    third are the pair either side of it. Nothing here assumes a scale -- only
    the shape -- so a wrong scale cannot cause a mislabel.
    """
    if len(clusters) < 4:
        return None, "need at least 4 landmarks (home, 1B, 2B, 3B)"

    best = None
    for i, a in enumerate(clusters):
        for j, b in enumerate(clusters):
            if i == j:
                continue
            span = math.hypot(a[0] - b[0], a[1] - b[1])
            if best is None or span > best[0]:
                best = (span, a, b)
    _span, end1, end2 = best
    # Home is the end nearer the world origin: pitches were already shown to
    # cross the plate within about a unit of it.
    home, second = sorted((end1, end2), key=lambda c: math.hypot(c[0], c[1]))

    axis = (second[0] - home[0], second[1] - home[1])
    length = math.hypot(*axis)
    if length == 0:
        return None, "degenerate layout"
    ux, uz = axis[0] / length, axis[1] / length

    sides = []
    for c in clusters:
        if c is home or c is second:
            continue
        dx, dz = c[0] - home[0], c[1] - home[1]
        along = dx * ux + dz * uz
        across = dx * (-uz) + dz * ux
        sides.append((across, along, c))
    corners = [s for s in sides if 0.15 * length < s[1] < 0.85 * length]
    if len(corners) < 2:
        return None, "could not find first and third base"
    corners.sort(key=lambda s: s[0])
    third, first = corners[0][2], corners[-1][2]

    # The rubber, if present, sits near the axis well inside first/third.
    rubber = None
    for across, along, c in sides:
        if c in (third, first):
            continue
        if abs(across) < 0.15 * length and 0.2 * length < along < 0.65 * length:
            rubber = c
            break
    return {"home": home, "1B": first, "2B": second, "3B": third, "rubber": rubber}, None


def procrustes(template_pts, measured_pts):
    """Best-fit similarity transform; returns (units_per_template_side, rotation, rms)."""
    n = len(template_pts)
    tcx = statistics.fmean([p[0] for p in template_pts])
    tcz = statistics.fmean([p[1] for p in template_pts])
    mcx = statistics.fmean([p[0] for p in measured_pts])
    mcz = statistics.fmean([p[1] for p in measured_pts])
    tc = [(p[0] - tcx, p[1] - tcz) for p in template_pts]
    mc = [(p[0] - mcx, p[1] - mcz) for p in measured_pts]

    # Closed-form 2D similarity fit: the rotation that best aligns the two
    # centred sets, then the scale that best matches their spreads.
    num = sum(t[0] * m[0] + t[1] * m[1] for t, m in zip(tc, mc))
    cross = sum(t[0] * m[1] - t[1] * m[0] for t, m in zip(tc, mc))
    theta = math.atan2(cross, num)
    denom = sum(t[0] * t[0] + t[1] * t[1] for t in tc)
    if denom == 0:
        raise SystemExit("degenerate template")
    scale = math.hypot(num, cross) / denom

    cos_t, sin_t = math.cos(theta), math.sin(theta)
    residuals = []
    for t, m in zip(tc, mc):
        px = scale * (t[0] * cos_t - t[1] * sin_t)
        pz = scale * (t[0] * sin_t + t[1] * cos_t)
        residuals.append(math.hypot(px - m[0], pz - m[1]))
    rms = math.sqrt(sum(r * r for r in residuals) / n)
    origin = (mcx - scale * (tcx * cos_t - tcz * sin_t),
              mcz - scale * (tcx * sin_t + tcz * cos_t))
    return scale, theta, rms, residuals, origin


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--park", required=True)
    parser.add_argument(
        "--include-rubber",
        action="store_true",
        help="fit the rubber too instead of holding it out as a blind test",
    )
    args = parser.parse_args()

    holds, file_count = load_holds(args.park)
    all_clusters = cluster(holds)
    clusters = [c for c in all_clusters if c[2] >= MIN_VISITS]
    dropped = len(all_clusters) - len(clusters)
    print(f"{len(holds)} holds in {file_count} file(s) -> {len(all_clusters)} distinct spots")
    if dropped:
        print(f"{dropped} spot(s) visited fewer than {MIN_VISITS} times dropped as transit/strays")
    print()

    labels, error = identify(clusters)
    if error:
        print(f"Could not identify the infield: {error}")
        for x, z, n, spread in clusters:
            print(f"  ({x:+8.3f}, {z:+8.3f})  visits={n}  scatter={spread:.3f}u")
        return 1

    print(f"{'landmark':>8}  {'x':>9}  {'z':>9}  {'visits':>6}  {'scatter':>8}")
    print("-" * 48)
    for name in ("home", "1B", "2B", "3B", "rubber"):
        c = labels[name]
        if c is None:
            print(f"{name:>8}  {'not measured':>30}")
            continue
        print(f"{name:>8}  {c[0]:+9.3f}  {c[1]:+9.3f}  {c[2]:>6}  {c[3]:>7.3f}u")

    order = ["home", "1B", "2B", "3B"]
    template = [TEMPLATE[k] for k in order]
    measured = [(labels[k][0], labels[k][1]) for k in order]
    if args.include_rubber and labels["rubber"] is not None:
        order.append("rubber")
        template.append(RUBBER_TEMPLATE)
        measured.append((labels["rubber"][0], labels["rubber"][1]))

    base_path_units, theta, rms, residuals, origin = procrustes(template, measured)

    print(f"\nfit over {len(order)} landmarks ({', '.join(order)})")
    print(f"{'landmark':>8}  {'residual(u)':>12}  {'residual(ft)':>13}")
    print("-" * 38)
    for name, residual in zip(order, residuals):
        print(f"{name:>8}  {residual:>12.3f}  {residual * FEET_PER_UNIT:>13.2f}")
    print(f"\nRMS residual   {rms:.3f}u ({rms * FEET_PER_UNIT:.2f} ft)")
    print(f"home plate at  ({origin[0]:+.3f}, {origin[1]:+.3f})")
    base_path_m = base_path_units * METERS_PER_UNIT
    base_path_ft = base_path_units * FEET_PER_UNIT
    print(f"\nCANONICAL SCALE  {METERS_PER_UNIT:.4f} m/unit "
          f"({FEET_PER_UNIT:.6f} ft/unit)")
    print(f"base path        {base_path_units:.3f}u = {base_path_m:.3f} m "
          f"= {base_path_ft:.2f} ft")
    print(f"round metric     {ROUND_METRIC_BASE_PATH_M:.3f} m "
          f"({base_path_m - ROUND_METRIC_BASE_PATH_M:+.3f} m)")
    print(f"regulation       {REGULATION_BASE_PATH_FT:.2f} ft "
          f"({base_path_ft - REGULATION_BASE_PATH_FT:+.2f} ft)")

    # The residual is the whole verdict. A regulation infield forced onto
    # geometry that is not one leaves an unmistakable signature.
    tolerance = 0.02 * base_path_units
    print()
    if rms <= tolerance:
        print(f"VERDICT: residual is under 2% of the base path ({tolerance:.2f}u).")
        print("The layout is a clean square. This validates the landmark measurement;")
        print("it does not turn the regulation-size comparison into a scale input.")
    else:
        print(f"VERDICT: residual EXCEEDS 2% of the base path ({tolerance:.2f}u).")
        print("Either the landmarks were not centred well, or this game's infield")
        print("is not square. Re-measure before trusting the geometry above.")

    if labels["rubber"] is not None and not args.include_rubber:
        rx, rz = labels["rubber"][0], labels["rubber"][1]
        measured_units = math.hypot(rx - origin[0], rz - origin[1])
        measured_m = measured_units * METERS_PER_UNIT
        measured_ft = measured_units * FEET_PER_UNIT
        print("\nHELD-OUT RUBBER -- did not inform the base fit:")
        print(f"  measured       {measured_units:.3f}u = {measured_m:.3f} m "
              f"= {measured_ft:.2f} ft")
        print(f"  round metric   {ROUND_METRIC_RUBBER_M:.3f} m "
              f"({measured_m - ROUND_METRIC_RUBBER_M:+.3f} m)")
        print(f"  regulation     {REGULATION_RUBBER_M:.3f} m / "
              f"{REGULATION_RUBBER_FT:.2f} ft "
              f"({measured_ft - REGULATION_RUBBER_FT:+.2f} ft)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
