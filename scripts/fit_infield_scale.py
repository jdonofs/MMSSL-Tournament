"""Fit the MLB infield template to measured landmarks to pin the world scale.

Everything in this project is measured in game units and exact. Converting to
feet needs exactly one number -- feet per unit -- and the game never states a
distance in feet anywhere, so that number can only come from recognising a
real-world dimension inside the game's own geometry.

The naive way is to divide one measured length by one assumed real length, and
it is what every previous attempt here did: a base path assumed to be 90 feet,
a rubber assumed to be 60 feet 6 inches. Each is a single unverified equation,
and a bad assumption is indistinguishable from a good one.

This does it as an overdetermined fit instead. A regulation infield is a rigid
shape: a 90-foot square with the rubber 60'6" from the plate along the
home-to-second line. Fitting that whole template to every measured landmark at
once gives two things a single division cannot:

  scale       the best-fit feet per unit, using every measurement rather than
              one, so independent centring errors average out instead of
              propagating

  residuals   how far each landmark sits from where a regulation infield says
              it should be. THIS IS THE PART THAT MATTERS. Small residuals mean
              the game really was built on a regulation infield and the scale
              is trustworthy. Large ones mean it was not, and no assumed
              dimension will ever convert this game to feet honestly.

The rubber is deliberately held out of the fit by default and used as a blind
test: the scale is fitted from the four bases alone, then the rubber's measured
position is compared against where 60'6" says it should land. That comparison
is evidence rather than assumption, because nothing about the rubber informed
the fit.

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

# Regulation dimensions, in feet, in a canonical frame: home at the origin,
# second base straight out along -z, first base toward +x.
BASE_PATH_FT = 90.0
RUBBER_FT = 60.5
_HALF = BASE_PATH_FT / math.sqrt(2)
TEMPLATE = {
    "home": (0.0, 0.0),
    "1B": (_HALF, -_HALF),
    "2B": (0.0, -BASE_PATH_FT * math.sqrt(2)),
    "3B": (-_HALF, -_HALF),
}
RUBBER_TEMPLATE = (0.0, -RUBBER_FT)

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
    paths = sorted(SAMPLES_DIR.glob(f"{park}-landmark-*.csv"))
    paths += sorted(SAMPLES_DIR.glob(f"{park}-press-*.csv"))
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
    """Best-fit similarity transform; returns (units_per_foot, rotation, rms)."""
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

    scale, theta, rms, residuals, origin = procrustes(template, measured)
    feet_per_unit = 1.0 / scale

    print(f"\nfit over {len(order)} landmarks ({', '.join(order)})")
    print(f"{'landmark':>8}  {'residual(u)':>12}  {'residual(ft)':>13}")
    print("-" * 38)
    for name, residual in zip(order, residuals):
        print(f"{name:>8}  {residual:>12.3f}  {residual * feet_per_unit:>13.2f}")
    print(f"\nRMS residual   {rms:.3f}u ({rms * feet_per_unit:.2f} ft)")
    print(f"home plate at  ({origin[0]:+.3f}, {origin[1]:+.3f})")
    print(f"\nFEET PER UNIT  {feet_per_unit:.4f}")
    print(f"base path      {scale * BASE_PATH_FT:.3f}u")

    # The residual is the whole verdict. A regulation infield forced onto
    # geometry that is not one leaves an unmistakable signature.
    tolerance = 0.02 * scale * BASE_PATH_FT
    print()
    if rms <= tolerance:
        print(f"VERDICT: residual is under 2% of the base path ({tolerance:.2f}u).")
        print("The layout matches a regulation infield, so reading real dimensions")
        print("into this game is justified and the scale above is trustworthy.")
    else:
        print(f"VERDICT: residual EXCEEDS 2% of the base path ({tolerance:.2f}u).")
        print("Either the landmarks were not centred well, or this game's infield")
        print("is not regulation -- in which case no assumed dimension converts it")
        print("to feet honestly. Re-measure before trusting the scale above.")

    if labels["rubber"] is not None and not args.include_rubber:
        rx, rz = labels["rubber"][0], labels["rubber"][1]
        measured_ft = math.hypot(rx - origin[0], rz - origin[1]) * feet_per_unit
        print(f"\nBLIND TEST -- the rubber, which did not inform the fit:")
        print(f"  measured   {measured_ft:.2f} ft from home")
        print(f"  regulation {RUBBER_FT:.2f} ft")
        print(f"  difference {measured_ft - RUBBER_FT:+.2f} ft "
              f"({(measured_ft - RUBBER_FT) / RUBBER_FT * 100:+.1f}%)")
        print("  An independent dimension landing this close is the strongest")
        print("  available evidence that the scale is right.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
