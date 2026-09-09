"""Mine recorded fielder memory for a physical ball-contact signal.

This is an offline QA tool.  It never needs Dolphin: the MSSTRK02 recordings
already contain the complete state block and all nine fielder objects on every
frame.  The labelled population below comes from the Peach Ice Garden and Daisy
Cruiser video-note reconciliation reports.

Run from the repository root:

    python scripts/mine_fielding_contact.py --list-actions

The default session directory is data/player_tracking.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

from player_tracking_io import FRAME_HEADER, FRAME_HEADER_SIZE, FRAME_MAGIC, Session

try:
    import numpy as np
except ImportError:  # The analysis remains usable in the collector's stdlib env.
    np = None


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA = ROOT / "data" / "player_tracking"


# These are labels, not official-error decisions.  In particular, an ordinary
# physical boot can still be a difficult play that should not be scored an error.
LABELS = {
    # Peach Ice Garden: visually confirmed ordinary ball contact followed by a
    # failure to secure the ball.
    ("peach_ice_garden-20260826T201820Z", 8727, "2B"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 14937, "3B"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 23233, "1B"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 24333, "SS"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 34599, "2B"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 56402, "3B"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 68429, "2B"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 76176, "SS"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 136143, "2B"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 153057, "2B"): "ordinary_contact",
    ("peach_ice_garden-20260826T201820Z", 157942, "1B"): "ordinary_contact",
    # Daisy Cruiser contacts with surviving human notes.
    ("daisy_cruiser-20260826T185635Z", 10909, "2B"): "ordinary_contact",
    ("daisy_cruiser-20260826T185635Z", 18390, "2B"): "ordinary_contact",
    ("daisy_cruiser-20260826T185635Z", 107414, "SS"): "ordinary_contact",
    # Both Brown Kritter plays were visually described as long diving boots, but
    # the centre coordinate never enters the old 3u gate.  Keep them separate
    # from the confirmed population until memory or physics resolves them.
    ("peach_ice_garden-20260826T201820Z", 40241, "2B"): "difficult_contact",
    ("peach_ice_garden-20260826T201820Z", 142324, "2B"): "difficult_contact",
    # Shy Guy animates at third while Yellow Magikoopa fields at short.
    ("peach_ice_garden-20260826T201820Z", 160922, "3B"): "clear_miss",
    # Ice Garden action-7 sequences: five completed Buddy Throws and two failed
    # attempts which must remain handoffs/dashes rather than manufactured throws.
    ("peach_ice_garden-20260826T201820Z", 11211, "LF"): "buddy_completed",
    ("peach_ice_garden-20260826T201820Z", 25043, "RF"): "buddy_completed",
    ("peach_ice_garden-20260826T201820Z", 27225, "RF"): "buddy_completed",
    ("peach_ice_garden-20260826T201820Z", 114104, "RF"): "buddy_completed",
    ("peach_ice_garden-20260826T201820Z", 124793, "RF"): "buddy_completed",
    ("peach_ice_garden-20260826T201820Z", 70774, "CF"): "buddy_incomplete",
    ("peach_ice_garden-20260826T201820Z", 99086, "CF"): "buddy_incomplete",
    # Forced Yoshi-egg contacts.  The foul contact is intentionally included:
    # physical-mechanic classification is independent of fair/foul scoring.
    ("peach_ice_garden-20260826T201820Z", 66036, "2B"): "egg_contact",
    ("peach_ice_garden-20260826T201820Z", 91165, "2B"): "egg_contact",
    ("peach_ice_garden-20260826T201820Z", 130542, "1B"): "egg_contact",
    ("peach_ice_garden-20260826T201820Z", 132358, "2B"): "egg_contact",
    ("daisy_cruiser-20260826T185635Z", 11993, "2B"): "egg_contact",
    ("daisy_cruiser-20260826T185635Z", 37496, "2B"): "egg_contact",
    ("daisy_cruiser-20260826T185635Z", 57352, "2B"): "egg_contact",
    ("daisy_cruiser-20260826T185635Z", 95144, "1B"): "egg_contact",
}


@dataclass
class ActionWindow:
    session: str
    actor: str
    code: int
    start: int
    end: int
    play_contact: int | None
    label: str
    min_distance: float
    min_distance_frame: int


@dataclass
class MemoryEvent:
    session: str
    play_contact: int
    actor: str
    actor_index: int
    label: str
    mechanic: str
    action_code: int
    start: int
    end: int
    reference_frame: int
    min_distance: float


@dataclass
class EventStats:
    event: MemoryEvent
    actor_base: int
    baseline_actor: object
    actor_min: object
    actor_max: object
    actor_seen: object
    baseline_global: object
    global_min: object
    global_max: object
    global_seen_actor_u8: object
    global_seen_actor_s16: object
    ball_trace: list
    reference_actor: object
    reference_global: object
    contact_signal_frames: list
    global_contact_frames: list


@dataclass
class RawFrame:
    timer: int
    ball: tuple
    block: bytearray


def raw_frames(session: Session):
    """Yield mutable reconstructed blocks, using NumPy for fast XOR if present.

    Consumers must copy data they retain past the next iteration.  The normal
    Session reader returns immutable bytes and intentionally has no dependency;
    this miner touches billions of delta bytes across repeated archive passes,
    so an optional vectorized XOR cuts minutes to seconds without changing the
    production reader.
    """
    path = session.stem.with_suffix(".bin")
    decompressor = zlib.decompressobj()
    buffer = bytearray()
    previous = bytearray(session.state_size)
    previous_array = np.frombuffer(previous, dtype=np.uint8) if np is not None else None
    with path.open("rb") as source:
        if source.read(len(FRAME_MAGIC)) != FRAME_MAGIC:
            raise ValueError(f"{path} is not a player-tracking stream")
        while True:
            chunk = source.read(1 << 20)
            buffer += decompressor.decompress(chunk) if chunk else decompressor.flush()
            while len(buffer) >= 4:
                (length,) = struct.unpack_from(">I", buffer)
                if len(buffer) < 4 + length:
                    break
                record = bytes(buffer[4:4 + length])
                del buffer[:4 + length]
                timer, _elapsed, _pointer = struct.unpack_from(FRAME_HEADER, record)
                cursor = FRAME_HEADER_SIZE
                ball = struct.unpack_from(">fff", record, cursor)
                cursor += 12 + 36  # ball plus the per-frame fielder pointer table
                delta = record[cursor:]
                if previous_array is not None:
                    np.bitwise_xor(previous_array, np.frombuffer(delta, dtype=np.uint8),
                                   out=previous_array)
                else:
                    for index, byte in enumerate(delta):
                        previous[index] ^= byte
                yield RawFrame(timer, ball, previous)
            if not chunk:
                return


def load_plays(stem: Path) -> list[dict]:
    path = stem.with_suffix(".plays.jsonl")
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def containing_play(plays: list[dict], timer: int) -> dict | None:
    # A few action animations persist a frame past the live boundary, so admit a
    # two-frame tail without allowing the following pitch to inherit the event.
    return next((play for play in plays
                 if play["contact_timer"] <= timer
                 <= play["dead_ball_timer"] + 2), None)


def ball_frame_transform(stem: Path):
    calibration = json.loads(
        Path(str(stem) + ".calibration.json").read_text())
    offset = calibration["position_offset"]
    fit = calibration.get("ball_frame", {})
    sign_x = fit.get("sign_x", 1.0)
    sign_z = fit.get("sign_z", -1.0)
    swap = fit.get("swap_xz", False)

    def transform(point):
        x, y, z = point
        px, pz = (z, x) if swap else (x, z)
        return sign_x * px, y, sign_z * pz

    return offset, transform


def action_windows(stem: Path) -> list[ActionWindow]:
    session = Session(stem)
    plays = load_plays(stem)
    position_offset, transform = ball_frame_transform(stem)
    action_offset = session.fields["bobble_flag"]
    active: dict[str, dict] = {}
    output = []

    def finish(actor_name: str) -> None:
        item = active.pop(actor_name, None)
        if item is None:
            return
        play = containing_play(plays, item["start"])
        contact = play["contact_timer"] if play else None
        label = LABELS.get((stem.name, contact, actor_name), "unlabelled")
        if item["code"] == 5:
            label = "egg_contact"
        elif item["code"] == 7 and play:
            completed = any(throw.get("buddy_throw")
                            for throw in play.get("throws", []))
            label = "buddy_completed" if completed else "buddy_incomplete"
        elif item["code"] not in (2, 3) and label in {
                "ordinary_contact", "difficult_contact", "clear_miss"}:
            label = "unlabelled"
        elif item["code"] != 7 and label.startswith("buddy_"):
            label = "special_action"
        output.append(ActionWindow(
            stem.name, actor_name, item["code"], item["start"], item["end"],
            contact, label, item["min_distance"], item["min_frame"]))

    for frame in raw_frames(session):
        bx, _, bz = frame.ball
        has_ball = frame.ball != (0.0, 0.0, 0.0)
        for actor in session.fielders:
            name = actor["name"]
            actor_start = actor["address"] - session.state_base
            code = frame.block[actor_start + action_offset]
            current = active.get(name)
            if current is not None and code != current["code"]:
                finish(name)
                current = None
            if not code:
                continue
            px, _, pz = transform(struct.unpack_from(
                ">fff", frame.block, actor_start + position_offset))
            distance = math.dist((px, pz), (bx, bz)) if has_ball else math.inf
            if current is None:
                active[name] = {
                    "code": code, "start": frame.timer, "end": frame.timer,
                    "min_distance": distance, "min_frame": frame.timer,
                }
            else:
                current["end"] = frame.timer
                if distance < current["min_distance"]:
                    current["min_distance"] = distance
                    current["min_frame"] = frame.timer
    for name in list(active):
        finish(name)
    return output


def memory_events(stem: Path, windows: list[ActionWindow]) -> list[MemoryEvent]:
    session = Session(stem)
    plays = load_plays(stem)
    actor_index = {actor["name"]: index
                   for index, actor in enumerate(session.fielders)}
    events = []
    for window in windows:
        if window.session != stem.name or window.play_contact is None:
            continue
        label = window.label
        if label == "unlabelled" and window.code in (2, 3):
            label = "unlabelled_attempt"
        if label == "unlabelled":
            continue
        mechanic = {
            5: "egg", 7: "buddy",
        }.get(window.code, "ordinary" if window.code in (2, 3) else "special")
        events.append(MemoryEvent(
            stem.name, int(window.play_contact), window.actor,
            actor_index[window.actor], label, mechanic, window.code,
            window.start, window.end, window.min_distance_frame,
            window.min_distance))

    # Possession is a separate fact and a critical negative control.  Exclude
    # rebound/rescue catches and forced contacts so this is the clean population.
    for play in plays:
        touch = play.get("first_touch")
        if (not touch or play.get("deflections") or play.get("forced_misplays")
                or play.get("after_deflection")):
            continue
        name = touch["by"]
        frame = int(touch["frame"])
        events.append(MemoryEvent(
            stem.name, int(play["contact_timer"]), name, actor_index[name],
            "clean_possession", "ordinary", 1, frame, frame, frame, 0.0))
    return events


def collect_event_stats(stem: Path, events: list[MemoryEvent]) -> list[EventStats]:
    """Aggregate every byte over each event without retaining full frame blocks."""
    if np is None:
        raise SystemExit("candidate mining requires NumPy (action listing does not)")
    session = Session(stem)
    by_name = {actor["name"]: actor for actor in session.fielders}
    mutable = {}
    # A 12-frame skirt catches one-frame pulses immediately before the visible
    # action while keeping the baseline outside that skirt.
    skirt = 12
    for event in events:
        if event.session != stem.name:
            continue
        actor = by_name[event.actor]
        mutable[id(event)] = {
            "event": event,
            "actor_base": actor["address"] - session.state_base,
            "baseline_actor": None,
            "baseline_global": None,
            "actor_min": np.full(actor["stride"], 255, dtype=np.uint8),
            "actor_max": np.zeros(actor["stride"], dtype=np.uint8),
            "actor_seen": np.zeros((256, actor["stride"]), dtype=np.bool_),
            "global_min": np.full(session.state_size, 255, dtype=np.uint8),
            "global_max": np.zeros(session.state_size, dtype=np.uint8),
            "global_seen_actor_u8": np.zeros(session.state_size, dtype=np.bool_),
            "global_seen_actor_s16": np.zeros(session.state_size - 1, dtype=np.bool_),
            "ball_trace": [],
            "reference_actor": None,
            "reference_global": None,
            "contact_signal_frames": [],
            "global_contact_frames": [],
        }

    timer_items = {}
    for item in mutable.values():
        event = item["event"]
        for timer in range(event.start - skirt - 1, event.end + skirt + 1):
            timer_items.setdefault(timer, []).append(item)

    for frame in raw_frames(session):
        relevant = timer_items.get(frame.timer)
        if not relevant:
            continue
        block = np.frombuffer(frame.block, dtype=np.uint8)
        for item in relevant:
            event = item["event"]
            baseline_timer = event.start - skirt - 1
            if frame.timer == baseline_timer:
                start = item["actor_base"]
                size = len(item["actor_min"])
                item["baseline_actor"] = block[start:start + size].copy()
                item["baseline_global"] = block.copy()
            if not event.start - skirt <= frame.timer <= event.end + skirt:
                continue
            item["ball_trace"].append((frame.timer, frame.ball))
            if not event.start - skirt <= frame.timer <= event.end:
                continue
            start = item["actor_base"]
            size = len(item["actor_min"])
            actor_values = block[start:start + size]
            if actor_values[0x2C4]:
                item["contact_signal_frames"].append(
                    (frame.timer, int(actor_values[0x2C4])))
            collision_a = struct.unpack_from(">h", frame.block, 0x900D9522 - 0x900D5000)[0]
            collision_b = struct.unpack_from(">h", frame.block, 0x900D9524 - 0x900D5000)[0]
            if collision_a >= 0 or collision_b >= 0:
                item["global_contact_frames"].append(
                    (frame.timer, collision_a, collision_b))
            if frame.timer == event.reference_frame:
                item["reference_actor"] = actor_values.copy()
                item["reference_global"] = block.copy()
            np.minimum(item["actor_min"], actor_values, out=item["actor_min"])
            np.maximum(item["actor_max"], actor_values, out=item["actor_max"])
            item["actor_seen"][actor_values, np.arange(size)] = True
            np.minimum(item["global_min"], block, out=item["global_min"])
            np.maximum(item["global_max"], block, out=item["global_max"])
            item["global_seen_actor_u8"] |= block == event.actor_index
            # Big-endian signed 16-bit actor index, tested at both alignments.
            item["global_seen_actor_s16"] |= (
                (block[:-1] == 0) & (block[1:] == event.actor_index))

    output = []
    for item in mutable.values():
        if item["baseline_actor"] is None or item["baseline_global"] is None:
            raise RuntimeError(f"missing pre-event baseline for {item['event']}")
        if item["reference_actor"] is None or item["reference_global"] is None:
            raise RuntimeError(f"missing reference frame for {item['event']}")
        output.append(EventStats(**item))
    return output


def print_candidate_offsets(stats: list[EventStats]) -> None:
    physical = [item for item in stats
                if item.event.label in {"ordinary_contact", "difficult_contact"}]
    misses = [item for item in stats if item.event.label == "clear_miss"]
    if not physical or not misses:
        print("candidate search needs physical-contact and clear-miss labels")
        return

    def actor_changed(item):
        return ((item.actor_min != item.baseline_actor)
                | (item.actor_max != item.baseline_actor))

    actor_candidates = np.logical_and.reduce([actor_changed(item) for item in physical])
    actor_candidates &= ~np.logical_or.reduce([actor_changed(item) for item in misses])
    # Known coordinates, identity/header data, and the action enum itself are
    # reported separately rather than masquerading as newly discovered fields.
    offsets = np.flatnonzero(actor_candidates)
    print("\nactor-byte offsets changing in every physical contact and no clear miss")
    print("  " + (", ".join(f"+0x{offset:03X}" for offset in offsets)
                    if len(offsets) else "none"))

    global_candidates = np.logical_and.reduce([
        (item.global_min != item.baseline_global)
        | (item.global_max != item.baseline_global)
        for item in physical
    ])
    global_candidates &= ~np.logical_or.reduce([
        (item.global_min != item.baseline_global)
        | (item.global_max != item.baseline_global)
        for item in misses
    ])
    global_offsets = np.flatnonzero(global_candidates)
    print("global-byte offsets changing in every physical contact and no clear miss")
    print("  " + (", ".join(f"0x{0x900D5000 + offset:08X}"
                              for offset in global_offsets[:80])
                    if len(global_offsets) else "none"))
    if len(global_offsets) > 80:
        print(f"  ... {len(global_offsets) - 80} more")

    # Collision-owner candidates: an idle -1 scalar that names the involved
    # fielder by actor-table index during every contact, but not during a miss.
    u8_owner = np.logical_and.reduce([
        (item.baseline_global == 0xFF) & item.global_seen_actor_u8
        for item in physical
    ])
    u8_owner &= ~np.logical_or.reduce([
        item.global_seen_actor_u8 for item in misses
    ])
    u8_offsets = np.flatnonzero(u8_owner)
    print("idle-FF global u8 fields naming the actor on every contact and no miss")
    print("  " + (", ".join(f"0x{0x900D5000 + offset:08X}"
                              for offset in u8_offsets)
                    if len(u8_offsets) else "none"))

    s16_owner = np.logical_and.reduce([
        ((item.baseline_global[:-1] == 0xFF)
         & (item.baseline_global[1:] == 0xFF)
         & item.global_seen_actor_s16)
        for item in physical
    ])
    s16_owner &= ~np.logical_or.reduce([
        item.global_seen_actor_s16 for item in misses
    ])
    s16_offsets = np.flatnonzero(s16_owner)
    print("idle-FFFF global s16 fields naming the actor on every contact and no miss")
    print("  " + (", ".join(f"0x{0x900D5000 + offset:08X}"
                              for offset in s16_offsets)
                    if len(s16_offsets) else "none"))

    print("\n0x900D9522/0x900D9524 actor-index matches by population")
    for label in sorted({item.event.label for item in stats}):
        population = [item for item in stats if item.event.label == label]
        first = sum(any(a == item.event.actor_index
                        for _, a, _ in item.global_contact_frames)
                    for item in population)
        second = sum(any(b == item.event.actor_index
                         for _, _, b in item.global_contact_frames)
                     for item in population)
        either = sum(any(a == item.event.actor_index or b == item.event.actor_index
                         for _, a, b in item.global_contact_frames)
                     for item in population)
        print(f"  {label:<20} first={first:>3}/{len(population):<3} "
              f"second={second:>3}/{len(population):<3} "
              f"either={either:>3}/{len(population):<3}")

    print("\nlabelled action contact-field timing")
    for item in physical + misses:
        matches = [(timer, a, b) for timer, a, b in item.global_contact_frames
                   if a == item.event.actor_index or b == item.event.actor_index]
        timing = (f"{matches[0][0]}..{matches[-1][0]} "
                  f"first=({matches[0][1]},{matches[0][2]})"
                  if matches else "absent")
        print(f"  {item.event.label:<19} play={item.event.play_contact:<6} "
              f"{item.event.actor:>2}: {timing}")

    print("\nlabel counts used in the raw-field sweep")
    counts = {}
    for item in stats:
        counts[item.event.label] = counts.get(item.event.label, 0) + 1
    for label, count in sorted(counts.items()):
        print(f"  {label:<20} {count:>3}")

    print("\n+0x2C4 nonzero by labelled population")
    for label in sorted(counts):
        population = [item for item in stats if item.event.label == label]
        present = [item for item in population if item.actor_max[0x2C4] != 0]
        maxima = [int(item.actor_max[0x2C4]) for item in present]
        extent = (f" range={min(maxima)}..{max(maxima)}" if maxima else "")
        print(f"  {label:<20} {len(present):>3}/{len(population):<3}{extent}")

    unlabelled = [item for item in stats
                  if item.event.label == "unlabelled_attempt"]
    if unlabelled:
        print("\nunlabelled action-2/3 windows under +0x2C4")
        for item in unlabelled:
            event = item.event
            signal = item.contact_signal_frames
            timing = (f"{signal[0][0]}..{signal[-1][0]} max="
                      f"{max(value for _, value in signal)}" if signal else "absent")
            global_matches = [timer for timer, a, b in item.global_contact_frames
                              if a == event.actor_index or b == event.actor_index]
            global_timing = (f"{global_matches[0]}..{global_matches[-1]}"
                             if global_matches else "absent")
            print(f"  {event.session:<36} play={event.play_contact:<6} "
                  f"{event.actor:>2} a{event.action_code} "
                  f"d={event.min_distance:4.2f}: actor={global_timing} "
                  f"counter={timing}")

    action2 = [item for item in unlabelled if item.event.action_code == 2]
    action2_near = [item for item in action2 if item.event.min_distance <= 3.0]
    action2_far = [item for item in action2 if item.event.min_distance > 3.0]
    if action2_near and action2_far:
        near_changed = np.logical_and.reduce([
            (item.actor_min != item.baseline_actor)
            | (item.actor_max != item.baseline_actor)
            for item in action2_near
        ])
        far_changed = np.logical_or.reduce([
            (item.actor_min != item.baseline_actor)
            | (item.actor_max != item.baseline_actor)
            for item in action2_far
        ])
        action2_offsets = np.flatnonzero(near_changed & ~far_changed)
        print("\naction-2 actor offsets changing in every <=3u window and no >3u window")
        print("  " + (", ".join(f"+0x{offset:03X}" for offset in action2_offsets)
                        if len(action2_offsets) else "none"))
        print("action-2 candidate detail")
        detail = [0xDD, 0xDE, 0x1B0, 0x1B1, 0x1B2,
                  0x298, 0x299, 0x29A, 0x29B, 0x29C, 0x29D, 0x29E, 0x29F]
        for item in action2:
            fields = []
            for offset in detail:
                seen = np.flatnonzero(item.actor_seen[:, offset])
                values = "/".join(f"{value:02X}" for value in seen[:8])
                if len(seen) > 8:
                    values += "/..."
                fields.append(f"+{offset:03X} {item.baseline_actor[offset]:02X}>"
                              f"{item.reference_actor[offset]:02X} [{values}]")
            print(f"  d={item.event.min_distance:4.2f} "
                  f"{item.event.session} play={item.event.play_contact}: "
                  + "; ".join(fields))

    print("\n+0x0BC..+0x0C3 changed by labelled population")
    for label in sorted(counts):
        population = [item for item in stats if item.event.label == label]
        changed = sum(1 for item in population if np.any(
            (item.actor_min[0xBC:0xC4] != item.baseline_actor[0xBC:0xC4])
            | (item.actor_max[0xBC:0xC4] != item.baseline_actor[0xBC:0xC4])))
        print(f"  {label:<20} {changed:>3}/{len(population):<3}")

    print("\nactor candidate detail (baseline -> reference; values seen)")
    detail_offsets = [offset for offset in offsets if offset < len(physical[0].actor_min)]
    for item in physical + misses:
        event = item.event
        fields = []
        for offset in detail_offsets:
            seen = np.flatnonzero(item.actor_seen[:, offset])
            values = "/".join(f"{value:02X}" for value in seen[:8])
            if len(seen) > 8:
                values += "/..."
            fields.append(
                f"+{offset:03X} {item.baseline_actor[offset]:02X}>"
                f"{item.reference_actor[offset]:02X} [{values}]")
        response_frame, response = horizontal_response(item.ball_trace,
                                                        event.start, event.end)
        signal = item.contact_signal_frames
        timing = (f"{signal[0][0]}..{signal[-1][0]}"
                  if signal else "absent")
        print(f"  {event.label:<19} play={event.play_contact:<6} {event.actor:>2} "
              f"a{event.action_code} signal={timing} "
              f"response={response:6.3f}@{response_frame}: "
              + "; ".join(fields))

    # Interpret the contiguous +0x0BC..+0x0C3 candidate as two big-endian
    # floats.  Plausible finite values are printed; NaN/huge values make it
    # evident that an interpretation is not useful.
    if all(offset in detail_offsets for offset in range(0xBC, 0xC4)):
        print("\n+0x0BC/+0x0C0 big-endian float view")
        for item in physical + misses:
            before = bytes(item.baseline_actor)
            at = bytes(item.reference_actor)
            values = (*struct.unpack_from(">ff", before, 0xBC),
                      *struct.unpack_from(">ff", at, 0xBC))
            print(f"  {item.event.label:<19} play={item.event.play_contact:<6} "
                  f"{item.event.actor:>2}  before=({values[0]: .5g}, {values[1]: .5g}) "
                  f"reference=({values[2]: .5g}, {values[3]: .5g})")


def horizontal_response(trace: list, start: int, end: int) -> tuple[int | None, float]:
    """Largest one-frame horizontal velocity-vector change in an event."""
    best_frame = None
    best = 0.0
    for (t0, p0), (t1, p1), (t2, p2) in zip(trace, trace[1:], trace[2:]):
        if not start - 1 <= t1 <= end + 1:
            continue
        before = (p1[0] - p0[0], p1[2] - p0[2])
        after = (p2[0] - p1[0], p2[2] - p1[2])
        change = math.dist(before, after)
        if change > best:
            best_frame, best = t1, change
    return best_frame, best


def print_action_windows(windows: list[ActionWindow]) -> None:
    print("session                              play    actor code start..end   min d  label")
    for event in windows:
        if event.play_contact is None and event.label == "unlabelled":
            continue
        distance = "inf" if not math.isfinite(event.min_distance) else f"{event.min_distance:5.2f}"
        print(f"{event.session:<36} {str(event.play_contact):>6}  "
              f"{event.actor:>3}  {event.code:>3}  "
              f"{event.start:>6}..{event.end:<6} {distance:>5}  {event.label}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--list-actions", action="store_true",
                        help="list every in-play nonzero action window")
    parser.add_argument("--mine", action="store_true",
                        help="sweep labelled actor and global bytes for candidates")
    args = parser.parse_args()

    stems = sorted(path.with_suffix("") for path in args.data.glob("*.bin"))
    windows = []
    for stem in stems:
        started = time.perf_counter()
        print(f"reading {stem.name} ...", flush=True)
        windows.extend(action_windows(stem))
        print(f"  {time.perf_counter() - started:.1f}s", flush=True)
    if args.list_actions:
        print()
        print_action_windows(windows)
    if args.mine or not args.list_actions:
        stats = []
        for stem in stems:
            events = memory_events(stem, windows)
            if not events:
                continue
            started = time.perf_counter()
            print(f"mining {stem.name}: {len(events)} events ...", flush=True)
            stats.extend(collect_event_stats(stem, events))
            print(f"  {time.perf_counter() - started:.1f}s", flush=True)
        print_candidate_offsets(stats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
