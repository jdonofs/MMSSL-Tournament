"""Find the stadium object table, by standing next to it.

THE PROBLEM. Every park's hazards are invisible to the tracker. The 27,968-byte
state block holds the game state and the thirteen actors and nothing else --
`docs/tracker-validation-console.md` section 11 has the evidence for Peach
(every 4-byte-aligned float triple tested for proximity to a frozen fielder at
24 freeze onsets, no offset clearing more than 10) and for DK Jungle (the whole
block swept by run structure and again by value histogram against six annotated
barrel and flower events, nothing). The barrier is not "the consequence cannot
be attributed to a cause": it is "the object is outside the capture window".

THE METHOD. A hazard that hits a fielder is TOUCHING that fielder, so at the
moment it fires its object holds a position a unit or two from theirs. That is
a search that does not need to know what the object looks like: scan a wide
region for 4-byte-aligned float triples near the affected fielder, at several
labelled hazard onsets, and intersect. An offset adjacent to the affected
fielder at every barrel and at no control play is the object.

This does NOT capture memory. Scanning at the event and keeping only the
surviving offsets is what makes a wide region affordable -- a full MEM2 image
per event is 64 MB, and twenty events would be 1.3 GB of mostly padding.

TWO KINDS OF TARGET, and one session can hunt both. The fielders are always
targets, which is how you catch something that MOVES -- a barrel rolling past.
`--near X Z` adds a fixed world point, which is how you catch something that does
NOT -- a flower, which is stadium geometry and is equally there during a pitch,
during a play and between innings. A moving hazard has to be caught at the right
instant; a static one can be scanned at leisure with the game paused.

    pip install dolphin-memory-engine

    # start Dolphin, load DK Jungle, start the game, then one command for both:
    python scripts/probe_stadium_objects.py --watch --radius 12 \
        --near 15.6 85.0 --near -45 73 \
        --out data/calibration/dk_objects.jsonl

    # press ENTER and answer two prompts:
    #    a barrel rolling near the centre fielder -> CF     / barrel_rolling
    #    any moment at all                        -> POINT1 / flower_static
    #    a play with no barrel on screen          -> CF     / control

    # the moving hazard, against its control plays:
    python scripts/probe_stadium_objects.py --analyze data/calibration/dk_objects.jsonl
    # the static one, and then the same question asked of bare grass:
    python scripts/probe_stadium_objects.py --analyze ... --target POINT1
    python scripts/probe_stadium_objects.py --analyze ... --target POINT2

PUT THE CONTROL POINT THE SAME DISTANCE FROM THE ORIGIN as the real one. The
density of plausible-looking triples in arbitrary memory falls off with distance
from (0, 0), so a control nearer the plate is not comparable: measured live at
DK Jungle, a point 54 units out drew 892 candidates against 33 for one 86 units
out, while a control moved to a matched 86 units drew 30. Same noise, so a
difference means something.

ONE PRESS IS ONE SCAN, and it records distances to every target at once, so
POINT2 is never an event of its own -- it is the same scans re-read by --target.
A control PLAY is meaningless for a flower, which is present at every moment
there is; its control is spatial and comes free from the same data. Two
persistent offsets at the flower against two at bare grass is nothing; two
against zero is the object.

Catch the barrel while it is still ROLLING -- one that hits a fielder breaks, so
the collision is the one moment the object is already gone.

Never writes to the game, and never writes to Supabase.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from collect_player_tracking import (
    FIELDER_POINTER_TABLE,
    FIELDER_STRIDE,
    POSITION_NAMES,
    STATE_BASE,
    STATE_SIZE,
)
from player_live_derivation import DEFAULT_POSITION_OFFSET
from probe_ball_memory import hook, plausible_position

# MEM2 on the Wii. The state block already lives here at 0x900D5000, so do the
# ball object and the actors, so this is where the game keeps the kind of thing
# this probe is looking for. MEM1 is reachable with --region if a park's objects
# turn out to live there instead.
DEFAULT_REGION = (0x90000000, 0x94000000)
CHUNK = 1 << 20

# A hazard that hits a fielder is touching them. Three units is generous -- a
# fielder is about a unit across -- and generosity is right here, because a
# candidate missed at scan time cannot be recovered from the stored result,
# while a spurious one is thrown out by the next event.
DEFAULT_RADIUS = 3.0

# How far a fielder may drift between the reads bracketing a scan before that
# scan is discarded. A wide scan is not instantaneous, and a candidate found
# beside a fielder who has since run four units away means nothing.
MAX_DRIFT_UNITS = 1.5

# A real park puts a few dozen plausible triples near a fielder. Tens of
# thousands means the filter is broken, and saying so at the time is the
# difference between a wasted prompt and a wasted session.
CANDIDATE_ALARM = 20000

# The world origin is unsearchable, and no filter can fix that. Colours,
# normalised vectors, unit quaternions, UVs and ratios all live in [-1, 1], so
# an enormous fraction of arbitrary memory decodes to a triple sitting within a
# few units of (0, 0). A target standing there matches all of it.
#
# The catcher stands on the origin. At radius 3 that was survivable; at radius
# 12 one scan produced 280,803 candidates. So a target this close to the origin
# is dropped rather than searched, and it is said out loud -- DK Jungle's
# barrels and flowers are outfield hazards, so nothing is lost, but a park whose
# hazard hits the catcher would need a different approach entirely.
ORIGIN_DEAD_ZONE = 6.0


def fielder_positions(dme, position_offset: int) -> dict:
    """Every fielder's (x, y, z), straight out of the known state block."""
    block = dme.read_bytes(STATE_BASE, STATE_SIZE)
    pointers = dme.read_bytes(FIELDER_POINTER_TABLE, 36)
    out = {}
    for i, name in enumerate(POSITION_NAMES):
        (address,) = struct.unpack(">I", pointers[i * 4 : i * 4 + 4])
        if not (STATE_BASE <= address
                and address + FIELDER_STRIDE <= STATE_BASE + STATE_SIZE):
            continue
        start = address - STATE_BASE + position_offset
        out[name] = struct.unpack(">fff", block[start : start + 12])
    return out


# Anything smaller than this, and not exactly zero, is not a coordinate. It is
# the boundary between a run of zero padding and whatever follows it, read as a
# float: denormals like 1.1e-44 and 1.2e-38.
#
# THIS IS THE WHOLE BALLGAME, and getting it wrong the first time cost a probe
# session. `plausible_position` is the BALL's filter and it accepts the world
# origin, because the ball legitimately goes there. Memory is mostly zeros, so
# millions of those padding-boundary triples decode to a position at or beside
# (0, 0) -- and the catcher stands at (0.8, 0.0, 1.1). Every one of them was
# therefore "within 3 units of a fielder". One run produced 3.1 million
# candidates an event and a 1.15 GB file, of which 3.1 million were the catcher.
COORDINATE_EPSILON = 1e-3


def plausible_mask(x, y, z):
    """Is this triple a position an OBJECT could be at?

    Stricter than `probe_ball_memory.plausible_position`, deliberately and in
    one specific direction: that function asks whether the ball could be there,
    and this one has to survive being pointed at 64 MB of arbitrary memory. A
    component is allowed to be exactly 0.0, because real positions sit on an
    axis -- the pitch resting spot is (0, 1, 18.6) -- but no more than one may
    be, and a non-zero component below COORDINATE_EPSILON is padding.
    """
    import numpy as np
    finite = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
    inside = (x > -70) & (x < 70) & (y >= 0) & (y < 80) & (z > -140) & (z < 140)
    real = finite & inside
    zeros = np.zeros(x.shape, dtype=np.int8)
    for value in (x, y, z):
        magnitude = np.abs(value)
        zeros += (value == 0.0)
        # Non-zero but far too small to be a coordinate: padding, not an object.
        real &= (value == 0.0) | (magnitude >= COORDINATE_EPSILON)
    return real & (zeros <= 1)


def scan_region(dme, region: tuple, targets: dict, radius: float) -> dict:
    """Every 4-byte-aligned float triple within `radius` of a fielder.

    Returns {offset_from_region_start: {position: distance}}. The plausibility
    filter does most of the work: the overwhelming majority of a 64 MB region is
    code, padding and integers, and almost none of that reads as three floats
    inside a baseball stadium.

    Vectorised because it has to be. A pure-Python walk over 16 million
    4-byte-aligned triples takes the better part of a minute, and a scan that
    slow measures a fielder who has already run somewhere else and a hazard that
    has already despawned -- it would answer a different question than the one
    asked.
    """
    import numpy as np
    start, end = region
    found = {}
    address = start
    while address < end:
        size = min(CHUNK, end - address)
        # Read a triple past the chunk so a candidate straddling the seam is not
        # lost, but only step `size`, so nothing is scanned twice.
        raw = dme.read_bytes(address, min(size + 12, end - address))
        values = np.frombuffer(raw, dtype=">f4", count=len(raw) // 4)
        if len(values) < 3:
            address += size
            break
        x, y, z = values[:-2], values[1:-1], values[2:]
        with np.errstate(invalid="ignore"):
            hits = np.flatnonzero(plausible_mask(x, y, z))
            # Only triples that START inside this chunk belong to it.
            hits = hits[hits < size // 4]
            if len(hits):
                hx = x[hits].astype(np.float64)
                hy = y[hits].astype(np.float64)
                hz = z[hits].astype(np.float64)
                for name, target in targets.items():
                    distance = np.hypot(hx - target[0], hz - target[2])
                    for index in np.flatnonzero(distance <= radius):
                        offset = address + int(hits[index]) * 4 - start
                        entry = found.setdefault(offset, {
                            # The VALUE, not just the distance. Storing only the
                            # distance meant a run that came out empty could not
                            # be re-analysed at all -- the offsets were there and
                            # what sat at them was gone.
                            "at": [round(float(hx[index]), 4),
                                   round(float(hy[index]), 4),
                                   round(float(hz[index]), 4)],
                            "near": {},
                        })
                        entry["near"][name] = round(float(distance[index]), 4)
        address += size
    return found


def watch(args) -> int:
    dme = hook()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    region = (args.region[0], args.region[1])
    megabytes = (region[1] - region[0]) / (1 << 20)
    print(f"Scanning 0x{region[0]:08X}..0x{region[1]:08X} ({megabytes:.0f} MB) "
          f"within {args.radius} units of a fielder.")
    print("Press ENTER the moment a hazard fires. Ctrl-C to stop.\n")
    recorded = 0
    while True:
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            break
        began = time.time()
        before = fielder_positions(dme, args.position_offset)
        targets = dict(before)
        # FIXED world points, for objects that do not move. The flowers at DK
        # Jungle are stadium geometry: there during the pitch, during the play
        # and between innings, so nothing has to be caught at the right instant
        # -- pause anywhere and the flower is still there. Point the first one
        # where a fielder stood when one sprayed them, which the previous run's
        # records give directly.
        #
        # These sit ALONGSIDE the fielders rather than replacing them, so one
        # session can hunt a static flower and a rolling barrel at once: label
        # the event POINT1 when it is the flower and CF/RF when it is a barrel.
        # A second point on empty grass is the control a static object needs,
        # since a flower is always present and so cannot have a control PLAY.
        for i, point in enumerate(args.near or [], start=1):
            targets[f"POINT{i}"] = (point[0], 0.0, point[1])
        blinded = {name for name, t in targets.items()
                   if math.hypot(t[0], t[2]) < ORIGIN_DEAD_ZONE}
        searchable = {n: t for n, t in targets.items() if n not in blinded}
        candidates = scan_region(dme, region, searchable, args.radius)
        after = fielder_positions(dme, args.position_offset)
        elapsed = time.time() - began
        if blinded:
            print(f"  ({', '.join(sorted(blinded))} within {ORIGIN_DEAD_ZONE}u of the "
                  "world origin; not searchable, skipped)")

        # A fielder who moved during the scan invalidates their own adjacency.
        # POINT is not a fielder and cannot drift, so it is never in this list.
        drifted = [name for name in before
                   if name in after
                   and math.dist(before[name][::2], after[name][::2]) > MAX_DRIFT_UNITS]
        if drifted:
            print(f"  !! {', '.join(drifted)} moved more than {MAX_DRIFT_UNITS} units "
                  f"during the {elapsed:.1f}s scan; their hits are dropped.")
            trimmed = {}
            for offset, near in candidates.items():
                kept = {n: d for n, d in near.items() if n not in drifted}
                if kept:
                    trimmed[offset] = kept
            candidates = trimmed

        per_target = {}
        for entry in candidates.values():
            for name in entry["near"]:
                per_target[name] = per_target.get(name, 0) + 1
        breakdown = "  ".join(f"{n}:{c}" for n, c in
                              sorted(per_target.items(), key=lambda kv: -kv[1]))
        print(f"  {len(candidates)} candidate triples in {elapsed:.1f}s")
        if breakdown:
            print(f"    {breakdown}")
        if len(candidates) > CANDIDATE_ALARM:
            worst = max(per_target.items(), key=lambda kv: kv[1])[0] if per_target else "?"
            print(f"  !! more than {CANDIDATE_ALARM} candidates, most of them on "
                  f"{worst}.")
            print("     Noise, not a discovery. Either the radius is reaching into")
            print("     the origin, where every colour and normal in memory lives,")
            print("     or that target is sitting somewhere unsearchable. Stop.")
        try:
            position = input("  position affected (CF / RF / POINT1, Enter to skip): ").strip().upper()
            # "blank" is what a person types when told "blank for none".
            if position in {"BLANK", "NONE", "-", "N/A"}:
                position = ""
            label = input("  label (objective id, or 'control'): ").strip() or "unlabelled"
        except (EOFError, KeyboardInterrupt):
            break
        record = {
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "region": [region[0], region[1]],
            "radius": args.radius,
            "scan_seconds": round(elapsed, 3),
            "label": label,
            "is_control": label.lower().startswith("control"),
            "position_affected": position or None,
            "fielders": {k: [round(v, 4) for v in val] for k, val in targets.items()},
            "near_points": {f"POINT{i}": list(pt)
                            for i, pt in enumerate(args.near or [], start=1)},
            "drifted": drifted,
            "candidates": {str(k): v for k, v in candidates.items()},
        }
        with out.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
        recorded += 1
        print(f"  recorded '{label}' ({recorded} total) -> {out}\n")
    print(f"\n{recorded} events written to {out}")
    return 0


def rank(subset: list, controls: list, top: int, name: str, target=None) -> None:
    """Offsets adjacent to the affected fielder at every event in `subset`."""
    counts = {}
    values = {}
    for event in subset:
        affected = target or event["position_affected"]
        for offset, entry in event["candidates"].items():
            near = entry["near"] if isinstance(entry, dict) and "near" in entry else entry
            if affected in near:
                counts.setdefault(int(offset), []).append(near[affected])
                if isinstance(entry, dict) and "at" in entry:
                    values.setdefault(int(offset), []).append(entry["at"])
    # An offset next to SOMEBODY on a control play is a fielder-shaped
    # coincidence -- another actor, a camera target, the ball -- not a hazard.
    control_hits = {}
    for event in controls:
        for offset in event["candidates"]:
            control_hits[int(offset)] = control_hits.get(int(offset), 0) + 1
    ranked = sorted(((len(d), control_hits.get(o, 0), o, d) for o, d in counts.items()),
                    key=lambda row: (-row[0], row[1]))
    base = subset[0]["region"][0]
    print(f"=== {name}: {len(subset)} events ===")
    shown = 0
    for covered, hit, offset, distances in ranked:
        if covered < len(subset):
            break
        mean = sum(distances) / len(distances)
        seen = values.get(offset) or []
        moved = ""
        if seen:
            spread = max(math.dist(a, b) for a in seen for b in seen)
            moved = f"  spread {spread:6.2f}u" if spread else "  STATIC"
        print(f"  0x{base + offset:08X}  adjacent at {covered}/{len(subset)}  "
              f"control hits {hit}  mean {mean:.2f}u{moved}")
        shown += 1
        if shown >= top:
            break
    if not shown:
        best = ranked[0][0] if ranked else 0
        print(f"  NOTHING is adjacent at all {len(subset)} events "
              f"(the best offset clears {best}).")
        print("  Try more events, a wider --radius, or a different --region.")
    print()


def analyze(args) -> int:
    path = Path(args.analyze)
    events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
              if line.strip()]
    hazards = [e for e in events if not e["is_control"] and e.get("position_affected")]
    controls = [e for e in events if e["is_control"]]
    if not hazards:
        print("No labelled hazard events with an affected position. Nothing to intersect.")
        return 1

    by_label = {}
    for event in hazards:
        by_label.setdefault(event["label"], []).append(event)
    summary = ", ".join(f"{k} x{len(v)}" for k, v in sorted(by_label.items()))
    print(f"{len(events)} events: {len(hazards)} hazards ({summary}), "
          f"{len(controls)} controls\n")

    rank(hazards, controls, args.top, "all hazards")
    if len(by_label) > 1:
        for label, subset in sorted(by_label.items()):
            rank(subset, controls, args.top, label)
    return 0


def analyze_target(args) -> int:
    """Rank one named target across every event, whatever each was labelled.

    This is how a STATIC object is found, and it is not the same question the
    control plays answer. A barrel is present or absent, so absence is the
    control. A flower is always there -- there is no moment without it -- so the
    comparison that means something is spatial and comes out of the same scans:
    run this on the flower's point, then run it on a point of empty ground, and
    the second number is the false-positive rate of the first. Two persistent
    offsets at the flower against two at bare grass is nothing; two against zero
    is the object.
    """
    path = Path(args.analyze)
    events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
              if line.strip()]
    usable = [e for e in events if args.target in (e.get("fielders") or {})]
    if not usable:
        named = sorted({k for e in events for k in (e.get("fielders") or {})})
        print(f"No event carries a target called {args.target!r}. Recorded: {', '.join(named)}")
        return 1
    print(f"{len(usable)} of {len(events)} events carry {args.target}. "
          f"An offset adjacent at all {len(usable)} and marked STATIC is an object "
          f"that was there every time and never moved.")
    print()
    rank(usable, [], args.top, f"target {args.target}", target=args.target)
    return 0


class _FakeDme:
    """A memory image in a bytes buffer, for the selftest."""

    def __init__(self, blob, base):
        self.blob = blob
        self.base = base

    def read_bytes(self, address, size):
        start = address - self.base
        return bytes(self.blob[start : start + size])


def selftest(args) -> int:
    """Prove the search finds a planted object and stays honest about the rest."""
    import random
    random.seed(7)
    base = 0x90000000
    fielders = {"CF": (10.0, 0.0, 40.0), "RF": (30.0, 0.0, 25.0)}

    size = 1 << 16
    blob = bytearray(random.getrandbits(8) for _ in range(size))
    blob[0x1000:0x100C] = struct.pack(">fff", 10.4, 1.0, 40.3)   # touching CF
    blob[0x2000:0x200C] = struct.pack(">fff", -50.0, 2.0, -90.0)  # valid, far away
    found = scan_region(_FakeDme(blob, base), (base, base + size), fielders, DEFAULT_RADIUS)
    assert 0x1000 in found and "CF" in found[0x1000]["near"], "planted object not found"
    assert found[0x1000]["near"]["CF"] < 0.6, found[0x1000]
    assert 0x2000 not in found, "a distant but valid position must not be a candidate"

    # The chunk seam: an object straddling a 1 MB boundary must survive.
    span = 2 * CHUNK
    seam_blob = bytearray(span)
    seam = CHUNK - 4
    seam_blob[seam : seam + 12] = struct.pack(">fff", 10.1, 1.0, 40.1)
    seam_found = scan_region(_FakeDme(seam_blob, base), (base, base + span),
                             fielders, DEFAULT_RADIUS)
    assert seam in seam_found, "a candidate straddling a chunk boundary was lost"

    # An all-zero region must produce nothing: (0,0,0) is not a position, and a
    # probe that reported it would name padding as the object in every park.
    empty = scan_region(_FakeDme(bytearray(1 << 16), base), (base, base + (1 << 16)),
                        fielders, DEFAULT_RADIUS)
    assert not empty, f"zeroed memory produced {len(empty)} candidates"

    # THE REGRESSION. Zero padding with one stray byte decodes to a denormal, and
    # a triple of those lands at the world origin -- where the catcher stands.
    # The first version of this filter accepted them and produced 3.1 million
    # candidates an event, a 1.15 GB file and no answer. These are real values
    # read out of the real memory that did it.
    import numpy as np
    junk = [
        (1.1210388e-44, 1.1581519e-38, -2.7889969e-29),  # padding boundary
        (-9.865052e-39, 0.0, 0.0),                       # two exact zeros
        (0.0, 0.0, 0.5),                                 # sits at the origin
        (0.0, 0.0, 0.0),                                 # pure padding
    ]
    for triple in junk:
        arr = [np.array([v], dtype=">f4") for v in triple]
        with np.errstate(invalid="ignore"):
            assert not plausible_mask(*arr)[0], f"padding accepted: {triple}"

    # ... while real positions, including ones sitting exactly on an axis, stay.
    for triple in [(0.0, 1.0, 18.6),        # the pitch resting spot
                   (13.8, 0.0, 86.5),       # a fielder in centre field
                   (-0.53, 1.7, -1.37)]:    # the ball at contact
        arr = [np.array([v], dtype=">f4") for v in triple]
        with np.errstate(invalid="ignore"):
            assert plausible_mask(*arr)[0], f"real position rejected: {triple}"

    # This filter is deliberately STRICTER than the ball's, never looser: anything
    # it accepts, probe_ball_memory would accept too. If that ever inverts, this
    # probe is finding things the rest of the tracker calls impossible.
    sample = np.frombuffer(
        bytearray(random.getrandbits(8) for _ in range(3 * 4 * 20000)),
        dtype=">f4")
    sx, sy, sz = sample[0::3], sample[1::3], sample[2::3]
    with np.errstate(invalid="ignore"):
        vector = plausible_mask(sx, sy, sz)
    scalar = np.array([plausible_position(float(a), float(b), float(c))
                       for a, b, c in zip(sx, sy, sz)])
    looser = int(np.count_nonzero(vector & ~scalar))
    assert looser == 0, f"{looser} triples accepted that plausible_position rejects"
    print(f"  padding rejected, real positions kept, strictly within "
          f"plausible_position on {len(scalar)} random triples")

    # And the intersection: an offset next to the affected fielder at every
    # hazard survives; one that is only there sometimes does not.
    def event(label, affected, offsets, control=False):
        return {"label": label, "is_control": control, "position_affected": affected,
                "region": [base, base + span],
                "candidates": {str(o): {affected: 0.5} for o in offsets}}

    import io
    import contextlib
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        rank([event("barrel_collision", "CF", [0x1000, 0x1400]),
              event("barrel_collision", "CF", [0x1000, 0x1800]),
              event("barrel_collision", "CF", [0x1000, 0x1C00])],
             [event("control", "CF", [0x1800], control=True)], 20, "test")
    text = buffer.getvalue()
    assert f"0x{base + 0x1000:08X}" in text, text
    assert f"0x{base + 0x1400:08X}" not in text, text
    print("selftest OK")
    print("  planted object found, distant position rejected")
    print("  chunk seam covered, zeroed memory produces nothing")
    print("  intersection keeps the offset present at every hazard and drops the rest")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--watch", action="store_true",
                        help="record hazard events from a live game")
    parser.add_argument("--analyze", metavar="FILE",
                        help="intersect a recorded event file")
    parser.add_argument("--selftest", action="store_true",
                        help="verify the search itself, with no game running")
    parser.add_argument("--out", default="data/calibration/stadium_objects.jsonl")
    parser.add_argument("--radius", type=float, default=DEFAULT_RADIUS)
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--target", metavar="NAME",
                        help="with --analyze: rank this target (POINT1, CF, ...) "
                             "across every event instead of each event's own "
                             "victim. How a static object is found.")
    parser.add_argument("--position-offset", type=int, default=DEFAULT_POSITION_OFFSET)
    parser.add_argument("--region", type=lambda v: int(v, 0), nargs=2,
                        default=list(DEFAULT_REGION), metavar=("START", "END"))
    parser.add_argument("--near", type=float, nargs=2, metavar=("X", "Z"),
                        action="append",
                        help="also hunt near this fixed world point, named POINT1, "
                             "POINT2, ... Repeatable. For static stadium geometry, "
                             "which needs no hazard to fire and can be scanned at "
                             "any moment; a second point on empty ground is the "
                             "control such an object cannot otherwise have.")
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest(args)
    if args.analyze:
        return analyze_target(args) if args.target else analyze(args)
    if args.watch:
        return watch(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
