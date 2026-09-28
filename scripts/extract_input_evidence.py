"""Raw input and resource evidence out of a capture, and nothing derived.

    python scripts/extract_input_evidence.py data/player_tracking/<stem>
    python scripts/extract_input_evidence.py <stem> --summary-only

Writes <stem>.evidence.jsonl beside the capture: one JSON record per event, all
stamped with the same clock -- `seq` (frame index in the capture), `timer` (the
game's own 60 Hz counter) and `elapsed_s` (collector wall clock since the
header's clock.started_epoch_s) -- so every stream can be joined on one key.

WHAT THIS IS NOT. It does not classify a swing, a pitch, a shake or a dive. It
records that port 2 pressed A on timer 18230 during a fielding half, and it
leaves the question of whether that was a dive request to an analysis that has
independent labels to check it against. It also carries no outcome: a hit, an
out, a run -- none of it is in this file, so nothing built on the pre-release
evidence here can learn from what happened afterwards. Outcomes stay in the
deriver's .pitches.jsonl / .plays.jsonl.

MISSING STAYS MISSING. A capture that predates a region reports the evidence as
"unobserved" in its session record and writes null wherever a value would have
come from it. Zero is only ever a reading.

The record kinds:

    session            schema version, profile, metadata, identity, what is observed
    side_ports         which port drives away/home, on every change (memory basis)
    button_edge        per port: buttons pressed and released on this frame
    controller_state   per port: device type / error byte changed (connect, drop)
    star_meter_change  per side: before, after, delta, and who was batting
    swing_onset        swing/bunt animation started; each port's accel peak nearby
    pitch_window       pre-release evidence for every counted pitch release
    frame_gap          game-clock frames that were never sampled
    clock_stall        the game clock stopped (pause, focus loss, menu)
    replay_interval    the game's in_replay byte was up (comprehensive only)
    summary            counts, port independence, meter independence, timing
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import struct
import sys
from pathlib import Path

import capture_evidence_schema as evidence
from derive_player_metrics import PITCH_GAME_STATE
from player_tracking_io import Session

EVIDENCE_SCHEMA = "sluggers-input-evidence"
EVIDENCE_VERSION = 1

# The window of input kept for each pitch, in frames before the release frame.
# 180 frames (3 s) covers every charge the swing audit saw (max 137) with room.
PRE_RELEASE_FRAMES = 180
# Around a swing onset, where to look for the batting remote's motion.
SWING_WINDOW = (-10, 5)
# A frame whose wall-clock gap to the previous sampled frame exceeds this while
# the game timer advanced by exactly one is the clock having stopped.
STALL_SECONDS = 0.5

STAR_METERS = (("away", 0x900D4E24), ("home", 0x900D4E26))


def _finite(value):
    return value if value is not None and math.isfinite(value) else None


class PortReader:
    """KPAD fields for one port out of one frame, or None if not recorded."""

    def __init__(self, session: Session, port: int):
        self.port = port
        self.offset = evidence.field_offset(
            evidence.PORT_BASES[port], evidence.PORT_STRIDE, session.state_base,
            session.state_size, session.extra_regions)

    @property
    def observed(self) -> bool:
        return self.offset is not None

    def read(self, block) -> dict | None:
        if self.offset is None:
            return None
        out = {}
        for name, offset, fmt in evidence.KPAD_FIELDS:
            value = struct.unpack_from(fmt, block, self.offset + offset)[0]
            out[name] = _finite(value) if fmt == ">f" else value
        sample = self.offset + evidence.SAMPLE_ARRAY_OFFSET
        out["raw_button"] = struct.unpack_from(">H", block, sample)[0]
        out["raw_acc"] = list(struct.unpack_from(">hhh", block, sample + 2))
        return out


class FieldReader:
    """Named scalars that may live in the state block or an extra region."""

    def __init__(self, session: Session):
        self.offsets = {}
        for name, address, fmt, _source in evidence.EVIDENCE_FIELDS:
            offset = evidence.field_offset(address, struct.calcsize(fmt),
                                           session.state_base, session.state_size,
                                           session.extra_regions)
            if offset is not None:
                self.offsets[name] = (offset, fmt)
        for side, address in STAR_METERS:
            offset = evidence.field_offset(address, 2, session.state_base,
                                           session.state_size, session.extra_regions)
            if offset is not None:
                self.offsets[f"{side}_star_meter"] = (offset, ">H")
        replay = ((session.header.get("capture_schema") or {}).get("replay") or {})
        if replay.get("address") is not None:
            offset = evidence.field_offset(replay["address"], 1, session.state_base,
                                           session.state_size, session.extra_regions)
            if offset is not None:
                self.offsets["in_replay"] = (offset, "B")

    def has(self, name: str) -> bool:
        return name in self.offsets

    def read(self, block, name: str):
        entry = self.offsets.get(name)
        if entry is None:
            return None
        offset, fmt = entry
        return struct.unpack_from(fmt, block, offset)[0]


def availability(session: Session, ports: dict, fields: FieldReader) -> dict:
    """What this capture can and cannot say. `unobserved` is never a zero."""
    def status(flag):
        return "observed" if flag else "unobserved"
    return {
        "controller_input": {str(p): status(r.observed) for p, r in ports.items()},
        "star_meters": status(fields.has("away_star_meter") and fields.has("home_star_meter")),
        "player_type_ports": status(fields.has("team1_player_type")),
        "team_batting_bytes": status(fields.has("team1_batting_or_fielding")),
        "replay_flag": status(fields.has("in_replay")),
        "game_timer_mirror": status(fields.has("game_timer_mirror")),
        # Named nowhere in memory yet, whatever the capture holds. Listed so a
        # reader never mistakes their absence from the records for "none".
        "pitch_charge": "unobserved",
        "pitch_aim_target": "unobserved",
        "shake_effort": "unobserved_as_label; raw accelerometer recorded when controller_input is observed",
        "independent_batter_timing": "unobserved",
        "physical_player_identity": ("declared_in_session_metadata"
                                     if (session.header.get("capture_schema") or {}).get("session_metadata")
                                     else "unobserved"),
    }


def extract(stem, *, write=True) -> dict:
    session = Session(stem)
    header = session.header
    schema = header.get("capture_schema") or {}
    metadata = (schema.get("session_metadata") or {}).get("content")
    ports = {port: PortReader(session, port) for port in (1, 2, 3, 4)}
    ports = {port: reader for port, reader in ports.items() if reader.observed}
    fields = FieldReader(session)
    out_path = session.stem.with_suffix(".evidence.jsonl")
    sink = out_path.open("w", encoding="utf-8") if write else None
    counts = collections.Counter()

    def emit(record: dict) -> None:
        counts[record["kind"]] += 1
        if sink:
            sink.write(json.dumps(record, separators=(",", ":")) + "\n")

    emit({
        "kind": "session",
        "evidence_schema": EVIDENCE_SCHEMA, "evidence_version": EVIDENCE_VERSION,
        "stem": session.stem.name,
        "capture_schema_version": schema.get("version", 2),
        "evidence_profile": schema.get("profile", "standard" if schema else None),
        "park": header.get("park"), "is_night": header.get("is_night"),
        "game_id": header.get("game_id"), "source_id": header.get("source_id"),
        "competition_type": header.get("competition_type"),
        "calibration_excluded": header.get("calibration_excluded", False),
        "clock": header.get("clock"),
        "session_metadata": metadata,
        "session_metadata_sha256": (schema.get("session_metadata") or {}).get("sha256"),
        "executable_identity": header.get("executable_identity"),
        "controller_sides_at_start": header.get("controller_sides_at_start"),
        "capture_complete": header.get("capture_complete"),
        "availability": availability(session, ports, fields),
        "ports_recorded": sorted(ports),
    })

    # Running state.
    previous_state = None
    previous_ports = {}
    previous_meter = {}
    previous_timer = None
    previous_elapsed = None
    previous_replay = None
    replay_start = None
    side_key = None
    pa_key = None
    pitch_high = 0
    swing_prev = bunt_prev = 0
    history = collections.deque(maxlen=PRE_RELEASE_FRAMES + 1)
    pending_swings = []
    frames = 0
    # Independence evidence: how often each port changed while the other did not.
    changed_alone = collections.Counter()
    changed_together = 0
    held_frames = collections.Counter()
    meter_changes = collections.Counter()
    swing_port_by_half = collections.Counter()

    def ports_for_sides(state, block):
        if not fields.has("team1_player_type"):
            return None
        return evidence.side_ports_from_memory(
            fields.read(block, "team1_player_type"), fields.read(block, "team2_player_type"),
            fields.read(block, "team1_batting_or_fielding"), state.get("inning_half"))

    current_sides = None
    # The meter reading on the frame BEFORE a release. The game takes a star
    # pitch's cost ON the release frame (pitch-input audit), so the release
    # frame's own reading is already post-spend.
    previous_meter_snapshot = {}

    def stamp(seq, frame):
        return {"seq": seq, "timer": frame.timer, "elapsed_s": round(frame.elapsed, 4)}

    def context(state):
        half = state.get("inning_half")
        return {"inning": state.get("inning"), "half": half,
                "outs": state.get("outs"), "balls": state.get("balls"),
                "strikes": state.get("strikes"),
                "batting_side": {0: "away", 1: "home"}.get(half),
                "pitches_counter": state.get("pitches")}

    def port_role(port, state):
        """Which side this port drives, and whether it is batting. Memory only."""
        if not current_sides or current_sides.get("away") is None:
            return {"side": None, "role": None, "basis": (current_sides or {}).get("basis", "unobserved")}
        side = next((s for s in ("away", "home") if current_sides.get(s) == port), None)
        half = state.get("inning_half")
        batting = {0: "away", 1: "home"}.get(half)
        role = None if side is None or batting is None else ("batting" if side == batting else "fielding")
        return {"side": side, "role": role, "basis": current_sides.get("basis")}

    for seq, frame in enumerate(session.frames()):
        frames += 1
        block = frame.block
        state = session.state(frame)
        port_values = {port: reader.read(block) for port, reader in ports.items()}

        # Clock: gaps are unsampled game frames; stalls are the clock stopping.
        if previous_timer is not None:
            if frame.timer - previous_timer > 1:
                emit({"kind": "frame_gap", **stamp(seq, frame),
                      "after_timer": previous_timer,
                      "missing_frames": frame.timer - previous_timer - 1})
            elif (frame.timer - previous_timer == 1 and previous_elapsed is not None
                  and frame.elapsed - previous_elapsed > STALL_SECONDS):
                emit({"kind": "clock_stall", **stamp(seq, frame),
                      "stalled_s": round(frame.elapsed - previous_elapsed, 3)})

        # Which port drives which side, whenever that changes.
        sides = ports_for_sides(state, block)
        key = None if sides is None else (sides.get("away"), sides.get("home"))
        if sides is not None and key != side_key:
            side_key = key
            current_sides = sides
            emit({"kind": "side_ports", **stamp(seq, frame), **context(state),
                  "memory": sides,
                  "declared_vs_memory": evidence.compare_declared_sides(metadata, sides)})

        # Replay flag intervals.
        if fields.has("in_replay"):
            replay = fields.read(block, "in_replay")
            if previous_replay is not None and bool(replay) != bool(previous_replay):
                if replay:
                    replay_start = (seq, frame.timer)
                else:
                    emit({"kind": "replay_interval", **stamp(seq, frame),
                          "start_seq": replay_start[0] if replay_start else None,
                          "start_timer": replay_start[1] if replay_start else None})
                    replay_start = None
            previous_replay = replay

        # Controller evidence: edges and connection state, per port.
        changed = []
        for port, values in port_values.items():
            before = previous_ports.get(port)
            if values["hold"] & 0xFFFF:
                held_frames[port] += 1
            if before is not None:
                pressed = values["hold"] & ~before["hold"] & 0xFFFF
                released = before["hold"] & ~values["hold"] & 0xFFFF
                if pressed or released:
                    emit({"kind": "button_edge", **stamp(seq, frame), **context(state),
                          "port": port, "pressed": evidence.button_names(pressed),
                          "released": evidence.button_names(released),
                          "held_after": evidence.button_names(values["hold"] & 0xFFFF),
                          "trig_word": values["trig"] & 0xFFFF,
                          "raw_sample_button": values["raw_button"],
                          "port_role": port_role(port, state),
                          "ball_was_hit": state.get("ball_was_hit"),
                          "ball_status": state.get("ball_status"),
                          "source": "kpad_hold_word"})
                if (values["dev_type"], values["wpad_err"]) != (before["dev_type"], before["wpad_err"]):
                    emit({"kind": "controller_state", **stamp(seq, frame), "port": port,
                          "dev_type": values["dev_type"], "wpad_err": values["wpad_err"],
                          "previous": [before["dev_type"], before["wpad_err"]],
                          # -1 is WPAD_ERR_NO_CONTROLLER. Other negative
                          # values (-2 flickers during ordinary play in every
                          # scripted capture) are transient comms errors.
                          "connected": values["dev_type"] not in evidence.KPAD_DEVICE_ABSENT
                          and values["wpad_err"] != -1})
                if values["raw_acc"] != before["raw_acc"] or values["hold"] != before["hold"]:
                    changed.append(port)
        if len(changed) == 1:
            changed_alone[changed[0]] += 1
        elif len(changed) > 1:
            changed_together += 1

        # Star meters: every change, both sides, with who was batting.
        for side, _address in STAR_METERS:
            name = f"{side}_star_meter"
            if not fields.has(name):
                continue
            value = fields.read(block, name)
            before = previous_meter.get(side)
            if before is not None and value != before:
                half = state.get("inning_half")
                batting = {0: "away", 1: "home"}.get(half)
                meter_changes[side] += 1
                emit({"kind": "star_meter_change", **stamp(seq, frame), **context(state),
                      "side": side, "before": before, "after": value, "delta": value - before,
                      "side_role": None if batting is None else ("batting" if side == batting else "fielding")})
            previous_meter[side] = value

        # Swing and bunt animation onsets, with every port's motion around them.
        swing = state.get("swing_frames") or 0
        bunt = state.get("bunt_frames") or 0
        for animation, now, before in (("swing", swing, swing_prev), ("bunt", bunt, bunt_prev)):
            if now and not before:
                pending_swings.append({"kind": "swing_onset", **stamp(seq, frame),
                                       **context(state), "animation": animation,
                                       "_due": seq + SWING_WINDOW[1],
                                       "_from": seq + SWING_WINDOW[0]})
        swing_prev, bunt_prev = swing, bunt

        history.append((seq, frame.timer, state, port_values))
        for record in [r for r in pending_swings if r["_due"] <= seq]:
            pending_swings.remove(record)
            peaks = {}
            for h_seq, _t, _s, values in history:
                if h_seq < record["_from"] or h_seq > record["_due"]:
                    continue
                for port, value in values.items():
                    acc = value.get("acc_value")
                    if acc is not None:
                        peaks[port] = max(peaks.get(port, 0.0), acc)
            record.pop("_due"), record.pop("_from")
            record["acc_value_peak_by_port"] = {str(p): round(v, 4) for p, v in sorted(peaks.items())} or None
            if len(peaks) >= 2:
                top = max(peaks, key=peaks.get)
                swing_port_by_half[(record["half"], top)] += 1
            emit(record)

        # Pitch releases, counted the deriver's way, with the pre-release window.
        if previous_state is not None:
            key = (state.get("inning"), state.get("inning_half"),
                   state.get("batter_index"), state.get("batter_id"))
            if key != pa_key:
                pa_key, pitch_high = key, 0
            if (state.get("pitches") or 0) > (previous_state.get("pitches") or 0):
                replayed = (state.get("pitches") or 0) <= pitch_high
                if state.get("game_state") == PITCH_GAME_STATE and not replayed:
                    pitch_high = state.get("pitches") or 0
                    emit(pitch_window(seq, frame, state, previous_state, history,
                                      previous_meter_snapshot, ports, port_role,
                                      context))
        previous_meter_snapshot = dict(previous_meter)

        previous_state = state
        previous_ports = port_values
        previous_timer = frame.timer
        previous_elapsed = frame.elapsed

    for record in pending_swings:           # the capture ended inside a window
        record.pop("_due"), record.pop("_from")
        record["acc_value_peak_by_port"] = None
        emit(record)

    summary = {
        "kind": "summary", "frames": frames,
        "records": dict(counts),
        "ports_recorded": sorted(ports),
        "port_changed_alone_frames": {str(p): changed_alone[p] for p in sorted(ports)},
        "ports_changed_together_frames": changed_together,
        "button_held_frames": {str(p): held_frames[p] for p in sorted(ports)},
        "star_meter_change_count": {side: meter_changes[side] for side, _ in STAR_METERS
                                    if fields.has(f"{side}_star_meter")} or None,
        "swing_onset_peak_port_by_half": {f"half{h}_port{p}": n
                                          for (h, p), n in sorted(swing_port_by_half.items())},
        "frame_timing": header.get("frame_timing"),
    }
    emit(summary)
    if sink:
        sink.close()
    summary["path"] = str(out_path) if write else None
    return summary


def pitch_window(seq, frame, state, previous_state, history, meters_before,
                 ports, port_role, context) -> dict:
    """What was knowable before the ball left the hand. No outcome, by design."""
    window = [entry for entry in history if entry[0] >= seq - PRE_RELEASE_FRAMES]
    inputs = {}
    for port in ports:
        held = collections.Counter()
        presses = []
        acc_peak = None
        last = None
        for h_seq, timer, _s, values in window:
            value = values.get(port)
            if value is None:
                continue
            mask = value["hold"] & 0xFFFF
            for name in evidence.button_names(mask):
                held[name] += 1
            if last is not None:
                pressed = mask & ~last
                if pressed:
                    presses.append({"frames_before_release": frame.timer - timer,
                                    "buttons": evidence.button_names(pressed)})
            last = mask
            acc = value.get("acc_value")
            if acc is not None:
                acc_peak = acc if acc_peak is None else max(acc_peak, acc)
        inputs[str(port)] = {"held_frames": dict(held), "press_edges": presses,
                             "acc_value_peak": None if acc_peak is None else round(acc_peak, 4),
                             "role": port_role(port, previous_state)}
    return {
        "kind": "pitch_window", "seq": seq, "timer": frame.timer,
        "elapsed_s": round(frame.elapsed, 4),
        "release_timer": frame.timer,
        **context(previous_state),
        "pitch_number_in_pa": state.get("pitches"),
        "batter_id": previous_state.get("batter_id"),
        "batter_index": previous_state.get("batter_index"),
        "score": {"away": previous_state.get("away_score"),
                  "home": previous_state.get("home_score")},
        "star_meters_before_release": ({side: meters_before.get(side) for side, _ in STAR_METERS}
                                       if meters_before else None),
        "window_frames": PRE_RELEASE_FRAMES,
        "window_frames_available": len(window),
        "inputs_by_port": inputs or None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stem")
    parser.add_argument("--summary-only", action="store_true",
                        help="print the summary without writing the .evidence.jsonl")
    args = parser.parse_args()
    summary = extract(args.stem, write=not args.summary_only)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
