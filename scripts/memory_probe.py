"""Whole-memory copies on request, for values the 60 Hz capture never reads.

Run by collect_player_tracking.py as a separate process. Each line on stdin is a
JSON request -- {"label": "knockdown", "timer": 12345, "fielder": "CF", ...} --
and each is answered with a copy of all of MEM1 and MEM2, written under --out
the moment it is taken.

WHY A SEPARATE PROCESS. The collector reads 28 KB a frame against a 16.6 ms
budget. These two regions are 88 MB: reading them costs 0.05-0.15 s and
compressing them another 0.3-0.6 s, which inside the frame loop is 25-45 frames
missing from the capture -- and those frames are exactly the collision the copy
was taken for. Out here it costs the capture nothing.

WHAT IT IS FOR. Yoshi Park's train, which the capture has been searched for and
does not contain (2026-09-11): nothing beside a floored fielder and nothing
circling the outfield anywhere in the state block. The game draws it from
somewhere; scripts/search_memory_probe.py looks for it in these copies against
the session's own derived knockdowns.

THE FILES. index.jsonl lists every copy in order. The first is both regions
whole; each later one is XORed against the copy before it, because two copies
seconds apart differ in a few megabytes and zeros compress to nothing -- so they
can only be read back in order. A copy is written under a temporary name and
renamed, so a file that exists is complete. Measured against a paused game: 28
MB for the first copy, 0.5 MB for each after it.
"""
from __future__ import annotations

import argparse
import json
import queue
import struct
import sys
import threading
import time
import zlib
from pathlib import Path

import numpy as np

from collect_player_tracking import GAME_TIMER
from probe_ball_memory import BALL_POINTER_SLOT, hook

# MEM1 then MEM2, concatenated in this order in every copy.
REGIONS = ((0x80000000, 0x01800000), (0x90000000, 0x04000000))
READ_CHUNK = 1 << 22


def read_regions(dme) -> np.ndarray:
    buffer = bytearray()
    for start, size in REGIONS:
        for offset in range(0, size, READ_CHUNK):
            buffer += dme.read_bytes(start + offset, min(READ_CHUNK, size - offset))
    return np.frombuffer(buffer, dtype=np.uint8)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="directory for the copies")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dme = hook()

    # Drained by their own thread, so the collector's pipe never fills while a
    # copy is compressing: a full pipe blocks the collector's write, and with it
    # the frame loop.
    requests: queue.Queue = queue.Queue()

    def drain():
        for line in sys.stdin:
            if line.strip():
                requests.put(json.loads(line))
        requests.put(None)

    threading.Thread(target=drain, daemon=True).start()

    (out / "probe.json").write_text(json.dumps({
        "regions": [[start, size] for start, size in REGIONS],
        "game_timer": GAME_TIMER,
        "ball_pointer_slot": BALL_POINTER_SLOT,
        "xor_previous": "every copy after the first is XORed against the one before it",
    }, indent=2))

    def timer() -> int:
        return struct.unpack(">I", dme.read_bytes(GAME_TIMER, 4))[0]

    previous = None
    written = 0
    total_bytes = 0
    request = {"label": "start", "timer": None}
    while request is not None:
        before = timer()
        started = time.perf_counter()
        raw = read_regions(dme)
        read_s = time.perf_counter() - started
        after = timer()
        ball_pointer = struct.unpack(">I", dme.read_bytes(BALL_POINTER_SLOT, 4))[0]
        payload = raw if previous is None else np.bitwise_xor(raw, previous)
        compressed = zlib.compress(payload.tobytes(), 1)
        name = f"{written:03d}-{request['label']}-{before}.zlib"
        temporary = out / (name + ".tmp")
        temporary.write_bytes(compressed)
        temporary.replace(out / name)
        entry = {
            "seq": written,
            "file": name,
            "label": request["label"],
            "xor_previous": previous is not None,
            # The copy spans these two game frames. How far the first is past
            # the request says whether it still shows the moment asked for: a
            # moving train does not wait.
            "timer_before": before,
            "timer_after": after,
            "lag_frames": (before - request["timer"]
                           if request.get("timer") is not None else None),
            "read_s": round(read_s, 4),
            "ball_pointer": ball_pointer,
            "compressed_bytes": len(compressed),
            "request": request,
        }
        with (out / "index.jsonl").open("a") as index:
            index.write(json.dumps(entry) + "\n")
        previous = raw
        written += 1
        total_bytes += len(compressed)
        print(f"{name}  lag {entry['lag_frames']}  {len(compressed) / 1e6:.1f} MB", flush=True)
        request = requests.get()
    print(f"{written} copies, {total_bytes / 1e6:.0f} MB", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
