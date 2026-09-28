"""Find Yoshi Park's train in the memory copies taken at knockdowns.

    python scripts/search_memory_probe.py data/player_tracking/<session> [<session> ...]

Reads the whole-memory copies scripts/memory_probe.py took beside a capture,
against each session's own .plays.jsonl -- which the preview and the bridge
write after the game. Several sessions pool: allocations repeat between matches
(the ball object is 0x8131E064 at two different parks), and the per-copy track
shows which session supports a candidate.

A knockdown the derivation named hazard="train" puts the train within reach of
the floored fielder. Floored fielders are all round the wall, so an address that
holds the train is near every one of them, while anything that stands still --
the wall's own vertices -- is near one spot. The survivors are then read at every
copy, where a train moves and a vertex does not. Day and night are different
objects (the train, the Wiggler), so pool one or the other.

Checked against a synthetic session with a moving position planted in real
copies of game memory: it ranks first, 3 of 3, while wall vertices reach 1 of 3.
Two real day probes identified the stable copy at 0x811F84DC; this script still
prints candidates and evidence so the result can be reproduced and the night
Wiggler can be researched separately.
"""
from __future__ import annotations

import argparse
import json
import zlib
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from derive_player_metrics import inside_fence_units

# How far from a floored fielder the train's position can be: its body is
# several units long, and the copy lands a few frames after the flag rises.
TRAIN_RADIUS_UNITS = 12.0
TRAIN_MAX_LAG_FRAMES = 20
# Closer than this is the floored fielder's own position, copied.
FIELDER_COPY_UNITS = 0.25
MATCH_FRAMES = 3
TOP = 20
TRACKED_CANDIDATES = 5000
# Where y and z sit after x: packed (x, y, z), a bare (x, z) pair, or the
# translation column of a 3x4 matrix (+0x0C, +0x1C, +0x2C), which is how the
# placed props at Wario City and Daisy Cruiser hold theirs.
LAYOUTS = {"xyz": (1, 2), "pair": (None, 1), "matrix": (4, 8)}


def near(floats: np.ndarray, point, radius: float, layout: str):
    """Float indexes whose (x, z) in this layout is within radius of point."""
    dz = LAYOUTS[layout][1]
    x, z = floats[:-dz], floats[dz:]
    with np.errstate(invalid="ignore"):   # memory is full of inf and NaN bytes
        index = np.flatnonzero((np.abs(x - point[0]) <= radius)
                               & (np.abs(z - point[2]) <= radius))
    distance = np.hypot(x[index] - point[0], z[index] - point[2])
    keep = distance <= radius
    return index[keep], distance[keep]


def probe_address(regions, offset: int) -> str:
    for start, size in regions:
        if offset < size:
            return f"0x{start + offset:08X}"
        offset -= size
    return f"+0x{offset:X}"


class Evidence:
    """One session: its derived knockdowns, its ball frame, and its probe copies."""

    def __init__(self, stem):
        stem = Path(stem)
        if stem.suffix in (".json", ".bin"):
            stem = stem.with_suffix("")
        self.stem = stem
        self.name = stem.name
        self.header = json.loads(stem.with_suffix(".json").read_text())
        self.park = self.header.get("park")
        plays_path = Path(str(stem) + ".plays.jsonl")
        if not plays_path.exists():
            raise SystemExit(f"{plays_path} is missing. Run\n"
                             f"  python scripts/calibrate_player_tracking.py {stem}\n"
                             f"  python scripts/derive_player_metrics.py {stem}")
        plays = [json.loads(line) for line in plays_path.read_text().splitlines() if line.strip()]
        self.knockdowns = [knock for play in plays for knock in play.get("knockdowns") or ()]
        calibration = Path(str(stem) + ".calibration.json")
        frame = (json.loads(calibration.read_text()).get("ball_frame")
                 if calibration.exists() else None) or {"sign_x": 1.0, "sign_z": -1.0, "swap_xz": False}
        self.sign_x, self.sign_z, self.swap = frame["sign_x"], frame["sign_z"], frame["swap_xz"]
        self.probe_dir = stem.with_suffix(".probe")

    def to_ball(self, point):
        x, y, z = point
        px, pz = (z, x) if self.swap else (x, z)
        return (self.sign_x * px, y, self.sign_z * pz)

    def regions(self):
        return json.loads((self.probe_dir / "probe.json").read_text())["regions"]

    def copies(self):
        """(index entry, bytes) for every probe copy, undoing the XOR chain in order."""
        index = self.probe_dir / "index.jsonl"
        if not index.exists():
            return
        previous = None
        for line in index.read_text().splitlines():
            entry = json.loads(line)
            payload = np.frombuffer(
                zlib.decompress((self.probe_dir / entry["file"]).read_bytes()), dtype=np.uint8)
            current = np.bitwise_xor(payload, previous) if entry["xor_previous"] else payload
            previous = current
            yield entry, current


def search_train(sessions) -> None:
    counts: Counter = Counter()
    distances = defaultdict(list)
    used = []
    for evidence in sessions:
        for entry, current in evidence.copies():
            if entry["label"] != "knockdown":
                continue
            request = entry["request"]
            knock = next((k for k in evidence.knockdowns
                          if k["by"] == request.get("fielder")
                          and abs(k["frame"] - request["timer"]) <= MATCH_FRAMES), None)
            if knock is None or knock.get("hazard") != "train":
                continue
            if (entry["lag_frames"] or 0) > TRAIN_MAX_LAG_FRAMES:
                continue
            fielder = request["fielders"][request["fielder"]]
            used.append(f"{evidence.name} {request['fielder']}@{request['timer']} "
                        f"lag {entry['lag_frames']}")
            floats = current.view(">f4").astype(np.float32)
            for frame_name, point in (("actor", fielder), ("ball", evidence.to_ball(fielder))):
                for layout in LAYOUTS:
                    index, distance = near(floats, point, TRAIN_RADIUS_UNITS, layout)
                    keep = distance > FIELDER_COPY_UNITS
                    for i, units in zip(index[keep].tolist(), distance[keep].tolist()):
                        key = (4 * i, frame_name, layout)
                        counts[key] += 1
                        distances[key].append(units)
    print(f"\ntrain: {len(used)} knockdown cop{'y' if len(used) == 1 else 'ies'} "
          "the derivation named train")
    for line in used:
        print(f"  {line}")
    if len(used) < 2:
        print("  one knockdown cannot isolate anything; it takes two at different spots")
        if not used:
            return

    # Every candidate, read at every copy: a train moves, a vertex does not.
    keys = [key for key, _ in counts.most_common(TRACKED_CANDIDATES)]
    tracks = [[] for _ in keys]
    by_layout = defaultdict(list)
    for n, key in enumerate(keys):
        by_layout[key[2]].append(n)
    for evidence in sessions:
        for entry, current in evidence.copies():
            floats = current.view(">f4")
            for layout, members in by_layout.items():
                dy, dz = LAYOUTS[layout]
                index = np.array([keys[n][0] // 4 for n in members])
                xs = floats[index].astype(float)
                ys = floats[index + dy].astype(float) if dy else np.zeros(len(index))
                zs = floats[index + dz].astype(float)
                for n, x, y, z in zip(members, xs, ys, zs):
                    point = (x, y, z)
                    tracks[n].append((entry["timer_before"], entry["label"],
                                      point if keys[n][1] == "ball" else evidence.to_ball(point)))
    rows = []
    for n, key in enumerate(keys):
        points = np.array([p[::2] for _, _, p in tracks[n] if np.isfinite(p).all()])
        moved = float(np.hypot(*np.ptp(points, axis=0))) if len(points) > 1 else 0.0
        rows.append((counts[key], moved, n))
    rows.sort(key=lambda row: (-row[0], -row[1]))
    park = sessions[0].park
    regions = next((e.regions() for e in sessions if (e.probe_dir / "probe.json").exists()), [])
    print(f"  {'address':10s}  {'frame':5s}  {'layout':6s}  near  mean u  moved u  by the wall")
    for count, moved, n in rows[:TOP]:
        key = keys[n]
        inside = [inside_fence_units(park, p) for _, _, p in tracks[n] if np.isfinite(p).all()]
        by_wall = sum(1 for units in inside if units is not None and -2.0 <= units <= 15.0)
        print(f"  {probe_address(regions, key[0]):10s}  {key[1]:5s}  {key[2]:6s}  "
              f"{count}/{len(used)}  {np.mean(distances[key]):6.1f}  {moved:7.1f}  "
              f"{by_wall}/{len(tracks[n])}")
    for count, moved, n in [row for row in rows[:3] if row[0] >= 2]:
        print(f"\n  {probe_address(regions, keys[n][0])} {keys[n][1]} {keys[n][2]} at every copy:")
        for timer, label, point in tracks[n]:
            inside = inside_fence_units(park, point) if np.isfinite(point).all() else None
            print(f"    {timer:7d} {label:9s} x {point[0]:8.2f}  z {point[2]:8.2f}"
                  + (f"  {inside:6.1f} u inside the wall" if inside is not None else ""))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sessions", nargs="+", help="data/player_tracking/<session> stems")
    args = parser.parse_args()
    sessions = [Evidence(stem) for stem in args.sessions]
    for evidence in sessions:
        index = evidence.probe_dir / "index.jsonl"
        copies = len(index.read_text().splitlines()) if index.exists() else 0
        print(f"{evidence.name}: {copies} probe copies, "
              f"{sum(1 for k in evidence.knockdowns if k.get('hazard') == 'train')} train knockdowns, "
              f"{'night' if evidence.header.get('is_night') else 'day'}")
    search_train(sessions)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
