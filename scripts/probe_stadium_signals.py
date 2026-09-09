"""Decide whether a stadium gimmick is observable at all -- provably.

WHY THIS EXISTS. Two adjacency searches for DK Jungle's barrel and flower came
back empty (`docs/tracker-validation-console.md`, probe runs 1 and 2). Neither
could distinguish "the object is not there" from "the search is broken", which
makes an empty result worth almost nothing. Both modes here carry a POSITIVE
CONTROL: something whose answer is already known has to be found by the same
search, in the same run, or the run is void. A negative from a search that just
proved itself on a known object is evidence; a negative from an unvalidated
search is not.

    --motion   Find things that MOVE. A barrel is shot from a cannon and rolls
               across the field, so wherever it lives it must hold a position
               that changes smoothly frame to frame. That is a far stronger
               signature than "is near a fielder", which is what the adjacency
               probe tested and which the ball's own trail kept satisfying.

               POSITIVE CONTROL: the nine fielders are running during the same
               snapshots and their position fields are at addresses this repo
               already knows. The search is not told where they are. If it does
               not rediscover them, it is broken and says so.

    --stun     Find a hazard's effect rather than its cause. Every byte of the
               fielder actor, at moments an operator says a player is disabled,
               against moments they say nobody is. Exhaustive, so there is no
               search heuristic to be wrong about. Answer ALL when a gimmick
               disables the whole defence at once.

               ALIGN IT TO THE VICTIM. Comparing a fixed offset across whole
               captures cannot find a per-actor flag when the victim changes:
               DK Jungle's flower dazed CF twice and RF three times, so no fixed
               byte separated the groups and the flat test returned ball-trail
               noise. Aligning turned five events into five dazed actor-samples
               against ninety-four clean ones over 748 bytes instead of 191,808,
               and found +0x242 with zero chance separators in 2,000 shuffles.

               POSITIVE CONTROL: a permutation test. The same counting is redone
               against shuffled labels, many times, which measures how many
               bytes separate the two groups BY CHANCE. A real signal has to beat
               that null; anything that does not is noise, however clean it looks.

Neither mode writes to the game, and neither writes to Supabase.

    python scripts/probe_stadium_signals.py --selftest        # no game needed

    # a barrel: press ENTER while one is rolling, game RUNNING (do not pause)
    python scripts/probe_stadium_signals.py --motion --out data/calibration/dk_motion.jsonl
    python scripts/probe_stadium_signals.py --analyze-motion data/calibration/dk_motion.jsonl

    # the flower's daze: pause, press ENTER, say who is dazed (or 'none')
    python scripts/probe_stadium_signals.py --stun --out data/calibration/dk_stun.jsonl
    python scripts/probe_stadium_signals.py --analyze-stun data/calibration/dk_stun.jsonl
"""
from __future__ import annotations

import argparse
import json
import struct
from math import comb
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from collect_player_tracking import (
    FIELDER_POINTER_TABLE,
    FIELDER_STRIDE,
    POSITION_NAMES,
    STATE_BASE,
    STATE_SIZE,
)
from player_live_derivation import DEFAULT_POSITION_OFFSET
from probe_ball_memory import BALL_POINTER_SLOT, hook
from probe_stadium_objects import CHUNK, DEFAULT_REGION, plausible_mask

# How many snapshots one ENTER takes. Each is a full read of the region, so this
# is the whole cost of an event; six spans a couple of seconds, which is long
# enough for a rolling barrel to travel several units and short enough that the
# operator can hold a moment in view.
SNAPSHOTS = 6

# A moving object must actually move. Below this over the whole burst it is
# indistinguishable from a static value with float noise.
MIN_TRAVEL_UNITS = 1.0

# ...and must not teleport. Half a second of a very fast object is a few units;
# 25 allows for a slow snapshot without admitting a value that is simply being
# rewritten with unrelated numbers.
MAX_STEP_UNITS = 25.0

# A body under physics moves by similar amounts each interval. A memory location
# being reused for unrelated values does not. This is the ratio of the standard
# deviation of the step sizes to their mean, and it is deliberately loose --
# the snapshots are not evenly spaced in time.
MAX_STEP_VARIATION = 1.5

# What --stun records at each labelled moment. The state block is where a daze
# would live if the flower works like Peach's Freezie, which writes its effect
# into the fielder actor at +0x240. The second region is the lead the barrel
# gave us: DK Jungle's barrel sits at 0x92AF5490 with a companion cluster at
# 0x92AE57C0, so this park keeps stadium objects in that neighbourhood, and a
# flower with any state at all is a good bet to be near its neighbours. 160 KB
# is nothing to record a few dozen times, and it collapses the search space by
# three orders of magnitude against sweeping all of MEM2 again.
STUN_REGIONS = [
    ("state_block", STATE_BASE, STATE_SIZE),
    ("stadium_objects", 0x92AE0000, 0x28000),
]


def snapshot(dme, region):
    """One full read of the region as bytes."""
    start, end = region
    out = bytearray()
    address = start
    while address < end:
        size = min(CHUNK, end - address)
        out += dme.read_bytes(address, size)
        address += size
    return bytes(out)


def fielder_position_addresses(dme, position_offset):
    """Where the nine fielder positions live right now. THE ANSWER KEY.

    Used only to score the search after the fact. It is never given to
    find_moving_triples, which is the point: the control is worthless if the
    thing being validated is told where to look.
    """
    pointers = dme.read_bytes(FIELDER_POINTER_TABLE, 36)
    out = {}
    for i, name in enumerate(POSITION_NAMES):
        (address,) = struct.unpack(">I", pointers[i * 4 : i * 4 + 4])
        if STATE_BASE <= address and address + FIELDER_STRIDE <= STATE_BASE + STATE_SIZE:
            out[name] = address + position_offset
    return out


def find_moving_triples(snapshots, region_start):
    """Every 4-byte-aligned float triple that traced a smooth path.

    `snapshots` is a list of raw byte strings, all the same length, in time
    order. Returns {absolute address: [(x, y, z), ...]} for the triples that
    were a plausible stadium position in every one and moved between them like
    something under physics rather than like memory being reused.
    """
    count = len(snapshots)
    length = min(len(s) for s in snapshots)
    found = {}
    for base in range(0, length, CHUNK):
        size = min(CHUNK, length - base)
        if size < 16:
            break
        # One triple of overlap so an object on the chunk seam is not lost.
        end = min(base + size + 12, length)
        views = [np.frombuffer(s[base:end], dtype=">f4") for s in snapshots]
        n = min(len(v) for v in views) - 2
        if n <= 0:
            continue
        keep = np.ones(n, dtype=bool)
        points = np.empty((count, n, 3), dtype=np.float64)
        with np.errstate(invalid="ignore", over="ignore"):
            for k, v in enumerate(views):
                x, y, z = v[0 : n], v[1 : n + 1], v[2 : n + 2]
                keep &= plausible_mask(x, y, z)
                points[k, :, 0] = x
                points[k, :, 1] = y
                points[k, :, 2] = z
            if not keep.any():
                continue
            idx = np.flatnonzero(keep)
            # Only triples starting inside this chunk belong to it.
            idx = idx[idx < size // 4]
            if not len(idx):
                continue
            p = points[:, idx, :]
            steps = np.linalg.norm(np.diff(p, axis=0), axis=2)      # (count-1, m)
            travel = steps.sum(axis=0)
            mean = steps.mean(axis=0)
            std = steps.std(axis=0)
            moving = (
                (travel >= MIN_TRAVEL_UNITS)
                & (steps.max(axis=0) <= MAX_STEP_UNITS)
                & (mean > 0)
                & (std <= MAX_STEP_VARIATION * mean)
            )
            for j in np.flatnonzero(moving):
                address = region_start + base + int(idx[j]) * 4
                found[address] = [tuple(round(float(c), 4) for c in p[k, j])
                                  for k in range(count)]
    return found


def motion(args):
    dme = hook()
    region = (args.region[0], args.region[1])
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Region 0x{region[0]:08X}..0x{region[1]:08X}, {SNAPSHOTS} snapshots per event.")
    print("Do NOT pause -- this one needs the game running, so things move.")
    print("Press ENTER while a barrel is rolling. Ctrl-C to stop.\n")
    recorded = 0
    while True:
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            break
        began = time.time()
        answer_key = fielder_position_addresses(dme, args.position_offset)
        shots, stamps = [], []
        for _ in range(SNAPSHOTS):
            stamps.append(time.time() - began)
            shots.append(snapshot(dme, region))
        found = find_moving_triples(shots, region[0])
        elapsed = time.time() - began

        # THE CONTROL. Nine runners, known addresses, never disclosed to the
        # search. Whatever it says about barrels is worth exactly as much as
        # its score here.
        hit = {n: a for n, a in answer_key.items() if a in found}
        missed = sorted(set(answer_key) - set(hit))
        print(f"  {len(found)} moving triples across {elapsed:.1f}s")
        print(f"  CONTROL: recovered {len(hit)}/{len(answer_key)} fielder position "
              f"fields without being told where they are"
              + (f" (missed {', '.join(missed)})" if missed else ""))
        if not answer_key:
            print("  !! no fielder addresses resolved; the control cannot run.")
        elif not hit:
            print("  !! THE SEARCH FOUND NO KNOWN MOVING OBJECT. This event proves")
            print("     nothing about barrels -- most likely nobody was moving.")
            print("     Take it while fielders are running.")

        try:
            label = input("  label (barrel_rolling / control): ").strip() or "unlabelled"
        except (EOFError, KeyboardInterrupt):
            break
        unknown = {a: v for a, v in found.items() if a not in set(answer_key.values())}
        record = {
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "region": [region[0], region[1]],
            "label": label,
            "is_control": label.lower().startswith("control"),
            "elapsed_s": round(elapsed, 3),
            "stamps": [round(s, 4) for s in stamps],
            "answer_key": {n: a for n, a in answer_key.items()},
            "control_recovered": sorted(hit),
            "control_missed": missed,
            "moving": {str(a): v for a, v in unknown.items()},
        }
        with out.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
        recorded += 1
        print(f"  recorded '{label}' ({recorded}) -- {len(unknown)} unexplained movers\n")
    print(f"\n{recorded} events written to {out}")
    return 0


def analyze_motion(args):
    rows = [json.loads(l) for l in Path(args.analyze_motion).read_text(
        encoding="utf-8").splitlines() if l.strip()]
    if not rows:
        print("No events.")
        return 1
    hazards = [r for r in rows if not r["is_control"]]
    controls = [r for r in rows if r["is_control"]]

    valid = [r for r in rows if r["control_recovered"]]
    print(f"{len(rows)} events: {len(hazards)} hazard, {len(controls)} control")
    print(f"CONTROL: {len(valid)}/{len(rows)} events recovered at least one known "
          f"moving fielder.")
    for r in rows:
        got, key = len(r["control_recovered"]), len(r["answer_key"])
        print(f"   {r['label']:16s} {got}/{key} fielders  "
              f"{len(r['moving'])} unexplained movers")
    if not valid:
        print("\nNo event passed its own control. The search never demonstrated it")
        print("can find a moving object, so nothing here is evidence either way.")
        return 1
    print()

    seen = {}
    for r in hazards:
        if not r["control_recovered"]:
            continue
        for address in r["moving"]:
            seen.setdefault(int(address), 0)
            seen[int(address)] += 1
    in_control = set()
    for r in controls:
        in_control |= {int(a) for a in r["moving"]}
    usable = [r for r in hazards if r["control_recovered"]]
    survivors = sorted(((c, a) for a, c in seen.items()
                        if c == len(usable) and a not in in_control), reverse=True)
    print(f"Movers present in all {len(usable)} validated barrel events and in no "
          f"control: {len(survivors)}")
    for c, a in survivors[: args.top]:
        track = next(r["moving"][str(a)] for r in usable if str(a) in r["moving"])
        path = " -> ".join(f"({p[0]:.1f},{p[2]:.1f})" for p in track[:4])
        print(f"   0x{a:08X}  {path} ...")
    if not survivors:
        print("   NONE.")
        print("\n   The control passed, so the search demonstrably finds moving")
        print("   objects. Nothing moved with the barrels that did not also move")
        print("   without them, in this region.")
    return 0


def stun(args):
    dme = hook()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    total = sum(size for _, _, size in STUN_REGIONS)
    print(f"Recording {total} bytes per event: "
          + ", ".join(f"{n} ({sz})" for n, _, sz in STUN_REGIONS))
    print("Pause the game at the moment you judge.")
    print("Press ENTER, then name the dazed fielder, or 'none'. Ctrl-C to stop.\n")
    recorded = 0
    while True:
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            break
        block = b"".join(dme.read_bytes(base, size)
                         for _, base, size in STUN_REGIONS)
        pointers = dme.read_bytes(FIELDER_POINTER_TABLE, 36)
        try:
            who = input("  dazed fielder (CF / RF / ..., ALL, or 'none'): ").strip().upper()
        except (EOFError, KeyboardInterrupt):
            break
        if who in {"BLANK", "-", "N/A", ""}:
            who = "NONE"
        record = {
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "dazed": None if who == "NONE" else who,
            "fielder_pointers": list(struct.unpack(">9I", pointers)),
            "state_base": STATE_BASE,
            "regions": [[n, b, sz] for n, b, sz in STUN_REGIONS],
            "block_hex": block.hex(),
        }
        with out.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
        recorded += 1
        print(f"  recorded {'dazed ' + who if who != 'NONE' else 'clean'} "
              f"({recorded})\n")
    print(f"\n{recorded} events written to {out}")
    return 0


def separators(blocks, flags):
    """Byte offsets whose values never overlap between the two groups."""
    a = np.stack([b for b, f in zip(blocks, flags) if f])
    b = np.stack([b for b, f in zip(blocks, flags) if not f])
    if not len(a) or not len(b):
        return np.array([], dtype=int)
    # A perfect separator: every value in one group is unlike every value in
    # the other. Ranges are enough for that and are far cheaper than set logic.
    return np.flatnonzero((a.min(axis=0) > b.max(axis=0))
                          | (a.max(axis=0) < b.min(axis=0)))


def analyze_stun_actors(rows, blocks, top, permutations):
    """The daze test aligned to the fielder it happened to.

    THE WHOLE-CAPTURE TEST CANNOT FIND A PER-ACTOR FLAG, and Peach's Freezie is
    a per-actor flag -- `fielder+0x240`, set on whoever was frozen. When one
    session dazes CF twice and RF three times, no fixed byte separates the two
    groups: CF's flag is set in the CF events and clear in the RF ones. The
    first pass over this data reported one separator and it was ball-trail
    noise, which is the correct answer to the wrong question.

    Aligning fixes the power problem at the same time. Each fielder in each
    event becomes its own sample of a 748-byte actor struct, labelled by whether
    THAT fielder was the one named. Five dazed events yield five dazed samples
    and roughly ninety clean ones, over 748 bytes instead of 191,808.
    """
    samples, labels, tags = [], [], []
    for row, block in zip(rows, blocks):
        base = row["state_base"]
        for index, pointer in enumerate(row["fielder_pointers"]):
            offset = pointer - base
            if offset < 0 or offset + FIELDER_STRIDE > len(block):
                continue
            name = POSITION_NAMES[index]
            samples.append(block[offset : offset + FIELDER_STRIDE])
            # ALL is not a convenience: a POW or a screen-shake disables every
            # fielder at once, and forcing that into one name would label eight
            # genuinely dazed players as clean and bury the flag being hunted.
            labels.append(row["dazed"] in (name, "ALL"))
            tags.append((name, row["dazed"]))
    dazed = sum(labels)
    if dazed < 2 or len(labels) - dazed < 2:
        print("Not enough labelled actors to run the aligned test.")
        return
    print()
    print(f"=== aligned to the dazed fielder: {dazed} dazed actor-samples, "
          f"{len(labels) - dazed} clean, {FIELDER_STRIDE} bytes each ===")
    real = separators(samples, labels)
    rng = np.random.default_rng(0)
    null = []
    for _ in range(permutations):
        shuffled = list(labels)
        rng.shuffle(shuffled)
        if 0 < sum(shuffled) < len(shuffled):
            null.append(len(separators(samples, shuffled)))
    null = np.array(null) if null else np.array([0])
    beat = int(np.count_nonzero(null >= len(real)))
    p = (beat + 1) / (len(null) + 1)
    print(f"{len(real)} bytes separate a dazed fielder from an undazed one.")
    print(f"Shuffled labels give {null.mean():.2f} on average (max {null.max()}); "
          f"p = {p:.4f}")
    for offset in real[:top]:
        d = sorted({int(s[offset]) for s, f in zip(samples, labels) if f})
        c = sorted({int(s[offset]) for s, f in zip(samples, labels) if not f})
        known = {0x223: "buddy_jump", 0x22E: "airborne", 0x2AC: "catch_type",
                 0x2B2: "fielding_action", 0x2C4: "contact_counter",
                 0x240: "frozen (Peach)", 0x20D: "frozen_timer"}
        label = known.get(int(offset), "")
        print(f"   fielder+0x{int(offset):03X} {label:16s} dazed={d}  clean={c[:8]}")
    if not len(real):
        print("Nothing in the fielder actor marks a dazed player.")
    elif p > 0.05:
        print("Not past chance; treat these as a candidate list, not a finding.")
    else:
        print("Past chance. This is the daze flag, or a very short list holding it.")


def analyze_stun(args):
    rows = [json.loads(l) for l in Path(args.analyze_stun).read_text(
        encoding="utf-8").splitlines() if l.strip()]
    blocks = [np.frombuffer(bytes.fromhex(r["block_hex"]), dtype=np.uint8) for r in rows]
    flags = [r["dazed"] is not None for r in rows]
    dazed, clean = sum(flags), len(flags) - sum(flags)
    width = len(blocks[0])
    print(f"{len(rows)} events: {dazed} dazed, {clean} clean, {width} bytes each")
    if dazed < 2 or clean < 2:
        print("Need at least two of each to say anything.")
        return 1

    regions = [tuple(r) for r in rows[0].get(
        "regions", [["state_block", rows[0]["state_base"], width]])]

    def address_of(offset):
        cursor = 0
        for name, base, size in regions:
            if offset < cursor + size:
                return f"0x{base + offset - cursor:08X} ({name})"
            cursor += size
        return f"+{offset}"

    analyze_stun_actors(rows, blocks, args.top, args.permutations)

    real = separators(blocks, flags)

    # HOW MANY WOULD SEPARATE ANYWAY. A byte taking two values splits a group of
    # n dazed and m clean perfectly under 2 of the C(n+m, n) possible labelings,
    # so the expected count from chance alone is that rate times the number of
    # bytes -- and it is the number that decides whether this run can conclude
    # anything at all. At 5 against 5 over 190,000 bytes it is in the thousands,
    # which is why counting separators is not by itself a test.
    splits = comb(dazed + clean, dazed)
    expected = 2 * width / splits
    print()
    print(f"{len(real)} bytes separate dazed from clean perfectly.")
    print(f"Chance alone would give about {expected:.0f} "
          f"({dazed} vs {clean} is {splits} possible labelings).")

    # The empirical null, which needs no assumption about how many values a byte
    # takes. Kept alongside the arithmetic because they check each other.
    rng = np.random.default_rng(0)
    null = []
    for _ in range(args.permutations):
        shuffled = list(flags)
        rng.shuffle(shuffled)
        if 0 < sum(shuffled) < len(shuffled):
            null.append(len(separators(blocks, shuffled)))
    null = np.array(null) if null else np.array([0])
    beat = int(np.count_nonzero(null >= len(real)))
    p = (beat + 1) / (len(null) + 1)
    print(f"Shuffled labels give {null.mean():.1f} on average (max {null.max()}) "
          f"over {len(null)} permutations; p = {p:.3f}")

    # WHAT WOULD BE ENOUGH. Solved rather than guessed, and printed whatever the
    # outcome, because "collect more" is useless advice without a number.
    need = None
    for k in range(dazed + 1, 26):
        if 2 * width / comb(2 * k, k) < 1.0:
            need = k
            break
    if need:
        print(f"For chance to yield under one separator across {width} bytes, "
              f"this needs about {need} dazed and {need} clean.")

    if not len(real):
        print()
        print("VERDICT: nothing separates the two groups at all. With enough "
              "samples that is a real negative.")
        return 0

    # The candidates are worth printing even when the count is unremarkable: a
    # true signal is IN this list, it is simply buried, and the way to dig it out
    # is a second session intersected against this one -- not a bigger p-value.
    print()
    print(f"Candidates ({min(len(real), args.top)} of {len(real)}):")
    for offset in real[: args.top]:
        values = [(int(b[offset]), f) for b, f in zip(blocks, flags)]
        d = sorted({v for v, f in values if f})
        c = sorted({v for v, f in values if not f})
        print(f"   {address_of(int(offset))}  dazed={d}  clean={c}")

    if p > 0.05:
        print()
        print(f"VERDICT: inconclusive. {len(real)} separators against about "
              f"{expected:.0f} from chance is not a signal, but a real byte would "
              f"be hidden in exactly this list.")
        print("Collect a second session and intersect: a chance separator almost "
              "never repeats, and a real one always does.")
    else:
        print()
        print("VERDICT: the real labels beat chance. The candidates above are "
              "the daze byte or a very short list containing it.")
    return 0


def sweep_session(args):
    """Find hazard flags in a RECORDED session, with no pausing and no minimum
    event count.

    WHY THIS BEATS --stun FOR A RARE GIMMICK. --stun needs the operator to pause
    at the moment and label it, so it needs several occurrences. A 60 Hz capture
    already holds every fielder struct on every frame, so ONE occurrence supplies
    about 120 disabled frames against 75,000 undisabled ones. The statue POW does
    not fire often enough for the first approach and does not need to for this
    one.

    Two signatures, and the second is the useful one for a POW:

      RARE          A hazard flag is up for a couple of seconds a few times a
                    game. A byte with thousands of runs is ordinary fielding
                    state, not a hazard.
      SIMULTANEOUS  A POW disables the WHOLE defence at once. Almost nothing
                    else does: ordinary fielding flags fire on one player at a
                    time. A byte that goes up on eight or nine fielders in the
                    same frame is either a hazard of that kind or the Buddy
                    Throw cutscene, and those are told apart by how long they
                    last and by `buddy_thrower` being set.
    """
    from player_tracking_io import Session
    stem = Path(args.sweep_session)
    session = Session(stem)
    lo, hi = args.actor_range
    starts = [f["address"] - session.state_base for f in session.fielders]
    names = [f["name"] for f in session.fielders]
    width = hi - lo

    runs = np.zeros(width, dtype=int)            # onsets, summed over fielders
    together = np.zeros(width, dtype=int)        # onsets with >=8 fielders at once
    examples = {}
    # Seeded from the FIRST frame, not from zeros. Starting at zero makes every
    # byte that is already non-zero at capture start look like it just switched
    # on, and since that happens to all nine fielders at once it counterfeits
    # exactly the whole-defence signature this is hunting -- the first run of
    # this sweep reported fourteen of them, all on frame 1016, all artefacts.
    previous = None
    frames = 0
    for frame in session.frames():
        block = np.frombuffer(frame.block, dtype=np.uint8)
        up = np.stack([block[st + lo : st + hi] != 0 for st in starts])
        if previous is None:
            previous = up
            frames += 1
            continue
        onset = up & ~previous
        runs += onset.sum(axis=0)
        wide = onset.sum(axis=0) >= min(args.simultaneous, len(starts))
        together += wide
        for index in np.flatnonzero(wide):
            examples.setdefault(int(index), []).append(
                (frame.timer, [names[i] for i in np.flatnonzero(onset[:, index])]))
        previous = up
        frames += 1

    print(f"{stem.name}: {frames} frames, "
          f"fielder+0x{lo:03X}..0x{hi:03X}")
    known = {0x223: "buddy_jump", 0x22E: "airborne", 0x2AC: "catch_type",
             0x2B2: "fielding_action", 0x2C4: "contact_counter",
             0x240: "frozen (Peach)", 0x242: "flower gas (DK)",
             0x20D: "frozen_timer"}
    rows = [(int(together[i]), int(runs[i]), lo + i) for i in range(width)
            if runs[i] and runs[i] <= args.max_runs]
    rows.sort(key=lambda r: (-r[0], r[1]))
    print()
    print(f"{'offset':>10} {'all-at-once':>12} {'total onsets':>13}  note")
    for wide, total, offset in rows[: args.top]:
        tag = known.get(offset, "")
        flag = "  <-- WHOLE DEFENCE" if wide else ""
        print(f"  +0x{offset:03X} {wide:12d} {total:13d}  {tag}{flag}")
        for timer, who in examples.get(offset - lo, [])[:3]:
            print(f"           frame {timer}: {len(who)} fielders")
    if not rows:
        print(f"  nothing fires {args.max_runs} times or fewer in this range")
    return 0


def selftest(args):
    rng = np.random.default_rng(3)
    region_start = 0x90000000

    # --- motion: a planted object that moves, among memory that does not ---
    size = 1 << 16
    frames = []
    for k in range(SNAPSHOTS):
        buf = bytearray(int(v) for v in rng.integers(0, 256, size))
        buf[0x100:0x10C] = struct.pack(">fff", 0.0, 1.0, 40.0)          # static
        buf[0x200:0x20C] = struct.pack(">fff", 10.0 + k * 1.5, 1.0, 40.0)  # rolling
        buf[0x300:0x30C] = struct.pack(">fff", 3.0 + k * 90.0, 1.0, 40.0)  # teleports
        frames.append(bytes(buf))
    found = find_moving_triples(frames, region_start)
    assert region_start + 0x200 in found, "a smoothly moving object was not found"
    assert region_start + 0x100 not in found, "a static value was called moving"
    assert region_start + 0x300 not in found, "a teleporting value was called moving"
    track = found[region_start + 0x200]
    assert len(track) == SNAPSHOTS and abs(track[-1][0] - track[0][0] - 7.5) < 1e-3, track

    # a seam-straddling mover survives the chunk boundary
    seam = CHUNK - 4
    big = []
    for k in range(SNAPSHOTS):
        buf = bytearray(2 * CHUNK)
        buf[seam : seam + 12] = struct.pack(">fff", 10.0 + k * 1.5, 1.0, 40.0)
        big.append(bytes(buf))
    assert region_start + seam in find_moving_triples(big, region_start), "seam mover lost"

    # --- stun: the permutation control must reject a planted non-signal ---
    blocks = [rng.integers(0, 256, 400, dtype=np.uint8) for _ in range(8)]
    flags = [True, True, True, True, False, False, False, False]
    # A byte that separates because it DRIFTS with time, not with the label.
    for i, b in enumerate(blocks):
        b[7] = i * 10
    drift = separators(blocks, flags)
    assert 7 in drift, "a drifting byte should look like a separator"
    null = []
    r2 = np.random.default_rng(1)
    for _ in range(300):
        s = list(flags)
        r2.shuffle(s)
        if 0 < sum(s) < len(s):
            null.append(len(separators(blocks, s)))
    assert np.mean(null) > 0, "the permutation null must find chance separators too"

    # ...and must accept a real one: a byte set only when the label is set.
    for i, b in enumerate(blocks):
        b[11] = 99 if flags[i] else 0
    assert 11 in separators(blocks, flags), "a true signal must separate"

    # THE FALSE NEGATIVE THIS METHOD NEARLY SHIPPED WITH. Counting separators
    # and comparing the count to a shuffled null cannot see one real byte
    # hiding among the chance ones: at 5 against 5 over 4,000 bytes, 32
    # separate by accident, and 33 is not distinguishable from 32. The fix is
    # sample size, and it is arithmetic rather than opinion -- so the check is
    # that the recommendation actually delivers what it promises.
    wide = 4000
    small = 2 * wide / comb(10, 5)
    big = 2 * wide / comb(20, 10)
    assert small > 20, f'5v5 should be hopeless over {wide} bytes, got {small}'
    assert big < 1, f'10v10 should be decisive over {wide} bytes, got {big}'

    # ...and end to end: with 10 of each, the planted byte is the ONLY one left.
    r3 = np.random.default_rng(9)
    many = [r3.integers(0, 256, wide, dtype=np.uint8) for _ in range(20)]
    labels = [i < 10 for i in range(20)]
    for i, b in enumerate(many):
        b[2500] = 99 if labels[i] else 0
    found = separators(many, labels)
    assert list(found) == [2500], f'expected only the planted byte, got {found}'

    # A gimmick that disables the WHOLE defence. Labelled ALL, every fielder
    # in that event is a dazed sample; labelled with one name, the other eight
    # would be filed as clean and the flag would never separate.
    stride, poses = 0x2EC, 9
    r4 = np.random.default_rng(5)
    rows, blocks = [], []
    for e in range(10):
        powed = e < 4
        blk = r4.integers(0, 256, stride * poses, dtype=np.uint8)
        for i in range(poses):
            blk[i * stride + 0x244] = 1 if powed else 0
        rows.append({"dazed": "ALL" if powed else None, "state_base": 0,
                     "fielder_pointers": [i * stride for i in range(poses)]})
        blocks.append(blk)
    import contextlib as _c, io as _io
    buf = _io.StringIO()
    with _c.redirect_stdout(buf):
        analyze_stun_actors(rows, blocks, 5, 200)
    out = buf.getvalue()
    assert "fielder+0x244" in out, out
    assert "36 dazed actor-samples" in out, out
    print("selftest OK")
    print("  motion: finds a rolling object, rejects a static one and a teleport")
    print("  motion: an object on the chunk seam survives")
    print(f"  stun:   a real signal separates; chance separators appear "
          f"{np.mean(null):.1f} times per shuffle, which is why the null matters")
    print("  stun:   5v5 is arithmetically hopeless and 10v10 is decisive; with "
          "10 of each")
    print("          the planted byte is the only separator left")
    print("  stun:   a whole-defence stun labelled ALL is found, 36 dazed vs 54 clean")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--motion", action="store_true", help="hunt things that move")
    p.add_argument("--stun", action="store_true", help="record state blocks by daze")
    p.add_argument("--analyze-motion", metavar="FILE")
    p.add_argument("--analyze-stun", metavar="FILE")
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--sweep-session", metavar="STEM",
                   help="find hazard flags in a recorded session: rare flags, and "
                        "flags that fire on the whole defence at once. Needs no "
                        "pausing and works from a single occurrence.")
    p.add_argument("--max-runs", type=int, default=60,
                   help="ignore bytes with more onsets than this; a hazard is rare")
    p.add_argument("--simultaneous", type=int, default=8,
                   help="how many fielders at once counts as a whole-defence stun")
    p.add_argument("--actor-range", type=lambda v: int(v, 0), nargs=2,
                   default=[0x200, 0x2E0], metavar=("LO", "HI"))
    p.add_argument("--follow", nargs="*", metavar="ADDR",
                   help="print these addresses live (default: the barrel "
                        "candidates) so they can be checked against the screen")
    p.add_argument("--follow-interval", type=float, default=0.25)
    p.add_argument("--out", default="data/calibration/stadium_signals.jsonl")
    p.add_argument("--top", type=int, default=20)
    p.add_argument("--permutations", type=int, default=2000)
    p.add_argument("--position-offset", type=int, default=DEFAULT_POSITION_OFFSET)
    p.add_argument("--region", type=lambda v: int(v, 0), nargs=2,
                   default=list(DEFAULT_REGION), metavar=("START", "END"))
    args = p.parse_args(argv)
    if args.selftest:
        return selftest(args)
    if args.analyze_motion:
        return analyze_motion(args)
    if args.analyze_stun:
        return analyze_stun(args)
    if args.follow is not None:
        return follow(args)
    if args.sweep_session:
        return sweep_session(args)
    if args.motion:
        return motion(args)
    if args.stun:
        return stun(args)
    p.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
