"""Hunt for the stadium's collision geometry in the game's memory.

RESULT: NEGATIVE. Run against Mario Stadium loaded and live, this found 41
X/Z vertex pairs for the real measured fence and 109 for a decoy fence rotated
90 degrees -- a wall that does not exist scored BETTER, which is what two
samples of the same noise look like. Individual blocks matching 20+ distinct
fence points are coincidence at this scan size; with ~156k raw matches over
88MB, a 4KB block collects several by chance.

So the collision geometry is not stored as a plain world-space float list.
It is most likely in model space behind a transform, or held in a structure
that is not a flat vertex array. Either way this technique cannot reach it,
and the next step would be disassembling collision routines -- a much larger
job than this was, and deliberately not taken.

The press measurements in parkGeometry.js remain the best available source.
Keeping this script for the record: the negative is worth knowing, and the
decoy-control method is reusable for any similar "is this signal or noise"
memory search.


The fence is currently measured by walking a character into the wall about
forty times per park. That works and repeats to under a foot, but it measures
where a CHARACTER stops rather than where the wall is, and it carries whatever
bias the person driving had that session. The game itself holds the real thing:
it must test the ball against the wall every frame, so the geometry exists in
memory exactly.

Finding an unlabelled mesh in tens of megabytes with no symbols is normally
hopeless. This search is not blind, which is the whole reason it is worth
trying: the wall's world coordinates are ALREADY KNOWN to under a foot from
the press measurements, so we can scan for floats that match values we can name
in advance. That turns "find the geometry" into "find where these specific
numbers live".

    pip install dolphin-memory-engine
    python scripts/probe_wall_geometry.py --park mario_stadium

WHAT SUCCESS LOOKS LIKE: one small region matching MANY DISTINCT wall points.
A few scattered hits mean nothing -- values like 79.1 and 96.5 occur all over a
running game by chance. Several different fence points inside one kilobyte,
at a regular stride, is a vertex table and is very unlikely to be coincidence.

WHAT FAILURE LOOKS LIKE, and it is a real possibility worth stating up front:
the geometry may be stored in model space with a separate transform, as a BSP
or octree rather than a flat vertex list, quantized to fixed point, or the
collision wall may be a different object from the painted one. Any of those
and the scan finds nothing. That is a clean negative -- the press measurements
remain the best available and nothing is lost but the time to run this.
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Wii memory. MEM1 is the original GameCube-sized arena; MEM2 is the extra
# 64MB the Wii adds, and level geometry very often lives there.
REGIONS = [
    ("MEM1", 0x80000000, 0x01800000),
    ("MEM2", 0x90000000, 0x04000000),
]
CHUNK_BYTES = 1 << 20

# How far a stored vertex may sit from our measured point and still count.
# Presses stop one body radius short of the padding and the fit itself is good
# to about a foot, so a unit of slack is generous without being meaningless.
MATCH_TOLERANCE_UNITS = 1.2
# Coordinates this small are not outfield wall; excluding them removes a huge
# number of incidental floats (counters, normals, timers) for free.
MIN_INTERESTING_RADIUS = 25.0
# Addresses closer together than this are treated as one candidate structure.
CLUSTER_BYTES = 4096


def load_fence(park: str):
    """The measured fence, read straight out of the JS geometry module."""
    import re
    source = (Path(__file__).resolve().parent.parent
              / "src" / "utils" / "parkGeometry.js").read_text(encoding="utf-8")
    home = re.search(r"HOME_PLATE = \{ x: (-?[\d.]+), z: (-?[\d.]+) \}", source)
    block = re.search(rf"{park}: \[(.*?)\],\s*\n\}}", source, re.DOTALL)
    if not home or not block:
        raise SystemExit(f"No measured fence for {park} in parkGeometry.js")
    home_x, home_z = float(home.group(1)), float(home.group(2))
    points = []
    for angle, radius in re.findall(r"\[(-?[\d.]+), ([\d.]+)\]", block.group(1)):
        radians = math.radians(float(angle))
        points.append((
            home_x + float(radius) * math.sin(radians),
            home_z - float(radius) * math.cos(radians),
        ))
    return points


def build_index(points):
    """Quantised lookup so each scanned float is one set membership test.

    Matching by distance directly would mean comparing every float against
    every target. Rounding both onto a grid and checking neighbouring cells is
    the same answer at a fraction of the cost, which matters over ~17 million
    floats.
    """
    step = MATCH_TOLERANCE_UNITS
    index = defaultdict(set)
    for number, (x, z) in enumerate(points):
        for value, axis in ((x, "x"), (z, "z")):
            if abs(value) < 1.0:
                continue
            cell = int(math.floor(value / step))
            for neighbour in (cell - 1, cell, cell + 1):
                index[neighbour].add((number, axis, value))
    return index, step


def scan(dme, park_points, regions):
    index, step = build_index(park_points)
    hits = []
    for name, base, size in regions:
        print(f"scanning {name} ({size / (1 << 20):.0f} MB)...", flush=True)
        for offset in range(0, size, CHUNK_BYTES):
            length = min(CHUNK_BYTES, size - offset)
            try:
                raw = dme.read_bytes(base + offset, length)
            except Exception:
                continue
            count = length // 4
            values = struct.unpack(f">{count}f", raw[: count * 4])
            for position, value in enumerate(values):
                # Reject NaN/inf and anything outside a plausible field extent
                # before doing any work.
                if not (-200.0 < value < 200.0):
                    continue
                if abs(value) < MIN_INTERESTING_RADIUS:
                    continue
                candidates = index.get(int(math.floor(value / step)))
                if not candidates:
                    continue
                for number, axis, target in candidates:
                    if abs(value - target) <= MATCH_TOLERANCE_UNITS:
                        hits.append((base + offset + position * 4, value, number, axis))
                        break
    return hits


# A wall point is only evidence if its X and its Z sit NEXT TO EACH OTHER, the
# way a vertex stores them. Counting distinct points per block does not test
# that, and at 88MB it barely tests anything: matches turn up roughly every
# 560 bytes, so a 4KB block collects several by chance and the top of the
# ranking fills with coincidence.
#
# Requiring the pair is a far stronger filter. Two specific values, both near
# ours, within a few bytes, describing the SAME fence point, is the actual
# signature of stored geometry.
VERTEX_STRIDES = (4, 8, 12, 16, 20, 24, 32)


def find_vertex_pairs(hits):
    """Hits where one fence point's X and Z are adjacent in memory."""
    by_address = {}
    for address, value, number, axis in hits:
        by_address.setdefault(address, []).append((number, axis))
    pairs = []
    for address, entries in by_address.items():
        for number, axis in entries:
            if axis != "x":
                continue
            for stride in VERTEX_STRIDES:
                for other in by_address.get(address + stride, ()):
                    if other[0] == number and other[1] == "z":
                        pairs.append((address, number, stride))
    return pairs


def decoy_points(points, home=(-0.067, -0.714)):
    """The same fence rotated a quarter turn about home plate.

    Identical radii and an identical spread of magnitudes, describing a wall
    that does not exist. Whatever this scores is what coincidence scores, so
    the real fence has to beat it to mean anything. Without a control, a big
    number from an 88MB sweep is not interpretable at all.
    """
    return [
        (home[0] + (z - home[1]), home[1] - (x - home[0]))
        for x, z in points
    ]


def cluster(hits):
    """Group hits by address and rank by how many DISTINCT fence points match.

    Distinct points is the whole discriminator. One region echoing the same
    value repeatedly is a coincidence or a copied constant; one region carrying
    a dozen different fence points is the wall.
    """
    groups = defaultdict(list)
    for address, value, number, axis in sorted(hits):
        groups[address // CLUSTER_BYTES].append((address, value, number, axis))
    ranked = []
    for block, entries in groups.items():
        distinct = {number for _a, _v, number, _x in entries}
        ranked.append((len(distinct), len(entries), block * CLUSTER_BYTES, entries))
    ranked.sort(reverse=True)
    return ranked


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--park", default="mario_stadium")
    parser.add_argument("--mem1-only", action="store_true", help="skip the Wii MEM2 arena")
    parser.add_argument("--dump", help="dump floats around an address, e.g. 0x91234560")
    args = parser.parse_args()

    from probe_ball_memory import hook
    dme = hook()

    if args.dump:
        address = int(args.dump, 16)
        raw = dme.read_bytes(address - 128, 512)
        print(f"floats around 0x{address:08X}:")
        for i in range(0, 512, 4):
            value = struct.unpack(">f", raw[i : i + 4])[0]
            marker = "  <--" if i == 128 else ""
            if -1e6 < value < 1e6:
                print(f"  0x{address - 128 + i:08X}  {value:12.4f}{marker}")
        return 0

    points = load_fence(args.park)
    print(f"{len(points)} measured fence points for {args.park}")
    print(f"matching within {MATCH_TOLERANCE_UNITS}u, ignoring |value| < {MIN_INTERESTING_RADIUS}\n")

    regions = REGIONS[:1] if args.mem1_only else REGIONS
    hits = scan(dme, points, regions)
    print(f"\n{len(hits)} raw float matches")

    # The control. Same sweep, same tolerances, a wall that does not exist.
    print("\nre-scanning with a decoy fence (rotated 90deg) as a control...")
    decoy_hits = scan(dme, decoy_points(points), regions)
    print(f"{len(decoy_hits)} decoy matches (vs {len(hits)} real)")

    real_pairs = find_vertex_pairs(hits)
    decoy_pairs = find_vertex_pairs(decoy_hits)

    print(f"\n{'':>18}  {'real':>8}  {'decoy':>8}")
    print("-" * 40)
    print(f"{'raw matches':>18}  {len(hits):>8}  {len(decoy_hits):>8}")
    print(f"{'X/Z vertex pairs':>18}  {len(real_pairs):>8}  {len(decoy_pairs):>8}")

    ranked = cluster(hits)
    if ranked:
        print(f"\n{'distinct':>8}  {'hits':>5}  {'pairs':>6}  {'address':>10}")
        print("-" * 40)
        pair_blocks = defaultdict(int)
        for address, _number, _stride in real_pairs:
            pair_blocks[address // CLUSTER_BYTES] += 1
        for distinct, total, address, _entries in ranked[:10]:
            print(f"{distinct:>8}  {total:>5}  {pair_blocks.get(address // CLUSTER_BYTES, 0):>6}"
                  f"  0x{address:08X}")

    print()
    # Pair count is the verdict, and it is judged against the decoy rather than
    # against zero. Some pairs will occur by chance; the question is whether
    # the real fence produces meaningfully more of them than a fake one.
    if len(real_pairs) >= max(8, 3 * (len(decoy_pairs) + 1)):
        print(f"SIGNAL: {len(real_pairs)} real vertex pairs against {len(decoy_pairs)} decoy.")
        print("The real fence is being found where a fake one is not. Dump the")
        print("densest block and look for a regular stride:")
        best = max(
            {address // CLUSTER_BYTES for address, _n, _s in real_pairs},
            key=lambda block: sum(1 for a, _n, _s in real_pairs if a // CLUSTER_BYTES == block),
        )
        print(f"\n  python scripts/probe_wall_geometry.py --dump 0x{best * CLUSTER_BYTES:08X}")
    else:
        print(f"NEGATIVE: {len(real_pairs)} real vertex pairs vs {len(decoy_pairs)} for a")
        print("fence that does not exist. The real geometry is not being found any")
        print("better than a fake one, so the block rankings above are coincidence.")
        print("\nThe collision data is not a plain world-space float list -- most")
        print("likely model space with a transform, or a non-array structure.")
        print("Reaching it means disassembling collision code, which is a much")
        print("bigger job than this. The press measurements stand.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
