"""Audit the two 2026-09-25 slap/charge calibration preview games.

This is intentionally an offline audit.  It reads the captured frame streams,
the derived pitch/play streams, and their preview manifests; it does not alter
the tracker detector or production scoring.

Run from the repository root:

    python scripts/audit_swing_gesture_calibration.py

Outputs:
    data/calibration/swing-gesture-pitches-v1.jsonl
    data/calibration/swing-gesture-audit-v1.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import struct
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from player_tracking_io import Session


ROOT = Path(__file__).resolve().parents[1]
TRACKING = ROOT / "data" / "player_tracking"
CALIBRATION = ROOT / "data" / "calibration"

SESSIONS = [
    {
        "game": 1,
        "stem": "mario_stadium-20260925T122709Z",
        "manifest": "preview-2026-09-25T12-25-57-291Z.manifest.json",
        "tracker_log": "sluggers-stat-tracker-advanced-stats-dev/preview-sessions/preview-2026-09-25_08-25-57.log",
        # The operator's intended PA blocks.  PAs 10-12 and PA 13 are the
        # explicitly corrected deviations supplied with this audit.
        "planned_pa_blocks": [
            (1, 5, "slap"),
            (6, 9, "charge"),
            (10, 12, "slap"),
            (13, 14, "charge"),
            (15, 21, "slap"),
            (22, 26, "charge"),
        ],
    },
    {
        "game": 2,
        "stem": "mario_stadium-20260925T123759Z",
        "manifest": "preview-2026-09-25T12-37-58-847Z.manifest.json",
        "tracker_log": "sluggers-stat-tracker-advanced-stats-dev/preview-sessions/preview-2026-09-25_08-37-58.log",
        "planned_pa_blocks": [
            (1, 4, "charge"),
            (5, 10, "slap"),
            (11, 22, "charge"),
            (23, 26, "slap"),
        ],
    },
]

TEAM_BY_HALF = {0: "Flowers", 1: "Spitballs"}
SIDE_BY_HALF = {0: "top", 1: "bottom"}
PORT_BY_HALF = {0: 1, 1: 2}

# The current KPADStatus at the head of each captured 0x538-byte port struct.
# Names and offsets follow the public KPADStatus layout.  The 16-entry raw
# sample array starts at +0x110 with 0x38-byte entries; its first accelerometer
# sample is retained separately below as an explicitly raw value.
KPAD_FLOAT_FIELDS = {
    "acc_x": 0x0C,
    "acc_y": 0x10,
    "acc_z": 0x14,
    "acc_magnitude": 0x18,
    "acc_variation": 0x1C,
    "pos_x": 0x20,
    "pos_y": 0x24,
    "pos_diff_x": 0x28,
    "pos_diff_y": 0x2C,
    "pos_diff_magnitude": 0x30,
    "angle_x": 0x34,
    "angle_y": 0x38,
    "angle_diff_x": 0x3C,
    "angle_diff_y": 0x40,
    "angle_diff_magnitude": 0x44,
    "distance": 0x48,
    "distance_diff": 0x4C,
    "distance_diff_magnitude": 0x50,
    "down_x": 0x54,
    "down_y": 0x58,
}

MOTION_REPORT_FIELDS = (
    "acc_x",
    "acc_y",
    "acc_z",
    "acc_magnitude",
    "acc_variation",
    "angle_diff_y",
    "angle_diff_magnitude",
    "down_x",
    "down_y",
    "raw_sample_acc_x",
    "raw_sample_acc_y",
    "raw_sample_acc_z",
)

PREP_WINDOW = (-120, -15)
RELEASE_WINDOW = (-30, 5)
RAW_CLASSIFIER_FEATURE = "prep.angle_diff_y.path"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def round_value(value, digits=6):
    if value is None:
        return None
    return round(float(value), digits)


def planned_mode(config: dict, pa_number: int) -> str:
    for first, last, mode in config["planned_pa_blocks"]:
        if first <= pa_number <= last:
            return mode
    raise ValueError(f"no planned mode for Game {config['game']} PA {pa_number}")


def f32(data: memoryview, offset: int):
    value = struct.unpack(">f", data[offset:offset + 4])[0]
    return value if math.isfinite(value) and abs(value) < 10_000 else None


def decode_kpad(data: memoryview) -> dict:
    decoded = {name: f32(data, offset) for name, offset in KPAD_FLOAT_FIELDS.items()}
    # The first raw sample entry is enough to retain the unfiltered sensor
    # coordinates without multiplying the artifact by all 16 redundant ring
    # entries on every captured game frame.
    for axis, offset in zip("xyz", (0x112, 0x114, 0x116)):
        decoded[f"raw_sample_acc_{axis}"] = struct.unpack(">h", data[offset:offset + 2])[0]
    return decoded


def describe(values: list[float]) -> dict | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    median = (ordered[middle] if len(ordered) % 2
              else (ordered[middle - 1] + ordered[middle]) / 2)
    return {
        "n": len(values),
        "min": round_value(ordered[0]),
        "median": round_value(median),
        "mean": round_value(statistics.fmean(values)),
        "max": round_value(ordered[-1]),
    }


def summarize_motion(frames: dict, port: int, anchor: int, bounds: tuple[int, int]) -> dict:
    low, high = bounds
    samples = [
        frames[timer]["ports"][port]
        for timer in range(anchor + low, anchor + high + 1)
        if timer in frames
    ]
    result = {
        "relative_frames": [low, high],
        "sample_count": len(samples),
    }
    for field in MOTION_REPORT_FIELDS:
        values = [sample[field] for sample in samples if sample.get(field) is not None]
        if not values:
            continue
        result[field] = {
            "mean": round_value(statistics.fmean(values)),
            "min": round_value(min(values)),
            "max": round_value(max(values)),
            "range": round_value(max(values) - min(values)),
            "path": round_value(sum(abs(right - left) for left, right in zip(values, values[1:]))),
        }
    return result


def first_swing_rise(frames: dict, pitch: dict):
    start = pitch["pitch_timer"]
    end = pitch["resolved_timer"]
    previous = frames.get(start - 1, {}).get("swing_frames", 0) or 0
    for timer in range(start, end + 1):
        now = frames.get(timer, {}).get("swing_frames", 0) or 0
        if now > previous:
            return timer
        previous = now
    return None


def charge_evidence(frames: dict, pitch: dict, anchor: int) -> dict:
    start = anchor - 180
    end = anchor
    rises = []
    prior = frames.get(start - 1, {}).get("charge_frames")
    max_counter = 0
    max_meter = 0.0
    for timer in range(start, end + 1):
        sample = frames.get(timer)
        if not sample:
            continue
        counter = sample.get("charge_frames")
        meter = sample.get("charge_meter")
        if isinstance(counter, (int, float)):
            max_counter = max(max_counter, counter)
            if prior is not None and counter > prior:
                rises.append(timer)
            prior = counter
        if isinstance(meter, (int, float)) and math.isfinite(meter):
            max_meter = max(max_meter, meter)
    release_timing = pitch.get("swing_charge_release_timing_frames")
    # The production field is now measured to swing onset, not to the later
    # pitch-resolution frame (which biased misses by the catcher's delay).
    release_timer = (None if release_timing is None
                     else anchor - release_timing)
    release_to_swing = release_timing
    return {
        "detector_latched_rise": (pitch.get("detected_swing_mode_source") or pitch.get("swing_mode_source")) == "swing_charge_frames_rise" and (pitch.get("swing_charge_frames") or 0) > 0,
        "counter_rise_observed": bool(rises),
        "first_rise_timer_in_window": rises[0] if rises else None,
        "last_rise_timer_in_window": rises[-1] if rises else None,
        "max_counter_in_180_frame_window": int(max_counter),
        "max_meter_in_180_frame_window": round_value(max_meter),
        "derived_release_timer": release_timer,
        "release_to_swing_start_frames": release_to_swing,
    }


def actual_label(config: dict, pitch: dict, evidence: dict) -> tuple[str | None, str, str | None]:
    game = config["game"]
    pa = pitch["pa_number"]
    pitch_no = pitch["pitch_number"]
    offer_type = pitch["offer_type"]
    if offer_type != "ordinary_swing":
        return None, "not_applicable_nonordinary_offer", offer_type

    if game == 1 and pa in (10, 11, 12):
        established = (
            pitch.get("swing_charge_frames", 0) > 0
            and pitch.get("swing_charge_release_timing_frames") is not None
            and pitch.get("detected_swing_mode_source") == "swing_charge_frames_rise"
            and evidence["detector_latched_rise"]
        )
        if established:
            return "charge", "capture_charge_state", None
        return "unsure", "operator_unsure_capture_inconclusive", "unresolved_operator_deviation"

    if game == 1 and pa == 13:
        return "slap", "operator_correction", None
    if game == 2 and pa == 23 and pitch_no == 1:
        return "charge", "operator_correction", None
    if game == 2 and pa == 23 and pitch_no == 2:
        return "slap", "operator_correction", None
    return pitch["planned_swing_mode"], "planned_schedule_no_reported_deviation", None


def offer_type(pitch: dict) -> str:
    detected = str(pitch.get("swing_mode") or "").lower()
    if pitch.get("offer") == "take":
        return "take"
    if pitch.get("offer") == "bunt" or detected == "bunt":
        return "bunt"
    if detected == "star":
        return "star_swing"
    if pitch.get("offer") == "swing":
        return "ordinary_swing"
    return "no_swing"


def contact_result(pitch: dict, play: dict | None) -> str:
    kind = pitch["offer_type"]
    if kind == "take":
        return f"taken_{pitch.get('outcome', 'unknown')}"
    if kind == "bunt":
        return (play or {}).get("batted_ball_class") or "bunt"
    if kind in ("ordinary_swing", "star_swing") and not pitch.get("contact"):
        return "swinging_miss"
    return (play or {}).get("batted_ball_class") or pitch.get("outcome") or "unknown"


def load_session(config: dict) -> tuple[list[dict], dict]:
    stem = config["stem"]
    header_path = TRACKING / f"{stem}.json"
    binary_path = TRACKING / f"{stem}.bin"
    pitches_path = TRACKING / f"{stem}.pitches.jsonl"
    plays_path = TRACKING / f"{stem}.plays.jsonl"
    manifest_path = TRACKING / config["manifest"]
    tracker_log_path = ROOT / config["tracker_log"]
    header = read_json(header_path)
    manifest = read_json(manifest_path)
    source_pitches = read_jsonl(pitches_path)
    plays = read_jsonl(plays_path)
    plays_by_swing = {play.get("swing_timer"): play for play in plays}

    session = Session(TRACKING / stem)
    frames = {}
    for frame in session.frames():
        state = session.state(frame)
        ports = {}
        for port in (1, 2):
            region = session.extra_region(frame, f"wiimote_{port}_input")
            if region is not None:
                ports[port] = decode_kpad(region)
        frames[frame.timer] = {
            "swing_frames": state.get("swing_frames") or 0,
            "charge_frames": state.get("swing_charge_frames"),
            "charge_meter": state.get("swing_charge_meter"),
            "ports": ports,
        }

    rows = []
    pa_number = 0
    for index, source in enumerate(source_pitches):
        if index == 0 or source.get("pitch_in_pa") == 1:
            pa_number += 1
        half = source.get("inning_half")
        port = PORT_BY_HALF.get(half)
        kind = offer_type(source)
        planned = planned_mode(config, pa_number)
        pitch = {
            "schema_version": 1,
            "game": config["game"],
            "session": stem,
            "pa_number": pa_number,
            "pitch_number": source.get("pitch_in_pa"),
            "inning": source.get("inning"),
            "half": SIDE_BY_HALF.get(half, "unknown"),
            "batting_team": TEAM_BY_HALF.get(half),
            "controller_port": port,
            "controller_port_source": "calibration_lineup_top_port1_bottom_port2",
            "physical_remote_identity": None,
            "batter_id": source.get("batter_id"),
            "batter": source.get("batter"),
            "pitcher_id": source.get("pitcher_id"),
            "pitcher": source.get("pitcher"),
            "offer_type": kind,
            "planned_swing_mode": planned,
            "detected_swing_mode": source.get("swing_mode"),
            "detected_swing_mode_source": source.get("swing_mode_source"),
            "swing_charge_frames": source.get("swing_charge_frames"),
            "swing_charge_release_timing_frames": source.get("swing_charge_release_timing_frames"),
            "swing_frames": source.get("swing_frames"),
            "bunt_frames": source.get("bunt_frames"),
            "pitch_timer": source.get("pitch_timer"),
            "resolved_timer": source.get("resolved_timer"),
            "plate_timer": source.get("plate_timer"),
            "contact": bool(source.get("contact")),
            "pitch_outcome": source.get("outcome"),
        }
        swing_start = first_swing_rise(frames, source) if kind in ("ordinary_swing", "star_swing") else None
        anchor = swing_start or source.get("plate_timer") or source.get("resolved_timer")
        memory_evidence = charge_evidence(frames, source, anchor)
        actual, label_source, exclusion = actual_label(config, pitch, memory_evidence)
        play = plays_by_swing.get(source.get("swing_timer"))
        pitch.update({
            "actual_swing_mode": actual,
            "actual_swing_mode_source": label_source,
            "gold_eligible": kind == "ordinary_swing" and actual in ("slap", "charge"),
            "exclusion_reason": exclusion,
            "detector_agrees_with_actual": (
                source.get("swing_mode") == actual if actual in ("slap", "charge") else None
            ),
            "swing_start_timer": swing_start,
            "motion_anchor_timer": anchor,
            "motion_anchor_source": "swing_frames_rise" if swing_start is not None else "plate_timer",
            "charge_memory_evidence": memory_evidence,
            "raw_wiimote_motion": {
                "port": port,
                "struct_region": f"wiimote_{port}_input",
                "struct_size": header.get("controller_input_capture", {}).get("struct_size"),
                "kpad_status_offsets": {name: f"0x{offset:03x}" for name, offset in KPAD_FLOAT_FIELDS.items() if name in MOTION_REPORT_FIELDS},
                "raw_sample_array_offset": "0x110",
                "raw_sample_stride": "0x38",
                "prep": summarize_motion(frames, port, anchor, PREP_WINDOW),
                "release": summarize_motion(frames, port, anchor, RELEASE_WINDOW),
            },
            "contact_result": contact_result(pitch, play),
            "play_swing_timer": (play or {}).get("swing_timer"),
            "play_contact_timer": (play or {}).get("contact_timer"),
        })
        rows.append(pitch)

    first_pitch = source_pitches[0]
    last_pitch = source_pitches[-1]
    provenance = {
        "game": config["game"],
        "stem": stem,
        "recorded_utc": header.get("recorded_utc"),
        "header_note": header.get("note"),
        "calibration_excluded": header.get("calibration_excluded"),
        "calibration_excluded_reason": header.get("calibration_excluded_reason"),
        "controller_input_capture": header.get("controller_input_capture"),
        "header_frames": header.get("frames"),
        "duration_seconds": header.get("duration_seconds"),
        "missed_frames": header.get("missed_frames"),
        "header_checksum_sha256": header.get("checksum_sha256"),
        "verified_binary_checksum_sha256": sha256(binary_path),
        "manifest": str(manifest_path.relative_to(ROOT)).replace("\\", "/"),
        "manifest_recorded_utc": manifest.get("recorded_utc"),
        "manifest_frames": manifest.get("frames"),
        "manifest_duration_seconds": manifest.get("duration_seconds"),
        "tracker_log": str(tracker_log_path.relative_to(ROOT)).replace("\\", "/"),
        "pitch_stream": str(pitches_path.relative_to(ROOT)).replace("\\", "/"),
        "play_stream": str(plays_path.relative_to(ROOT)).replace("\\", "/"),
        "pitch_count": len(source_pitches),
        "play_count": len(plays),
        "pa_count": pa_number,
        "first_pitch": {
            "timer": first_pitch.get("pitch_timer"),
            "inning": first_pitch.get("inning"),
            "half": SIDE_BY_HALF.get(first_pitch.get("inning_half")),
            "batter": first_pitch.get("batter"),
        },
        "last_pitch": {
            "timer": last_pitch.get("pitch_timer"),
            "inning": last_pitch.get("inning"),
            "half": SIDE_BY_HALF.get(last_pitch.get("inning_half")),
            "batter": last_pitch.get("batter"),
        },
    }
    return rows, provenance


def nested_feature(row: dict, path: str):
    value = row
    for part in path.split("."):
        if part == "prep":
            value = value["raw_wiimote_motion"]["prep"]
        else:
            value = value[part]
    return value


def fit_threshold(rows: list[dict], feature: str) -> dict:
    pairs = [(nested_feature(row, feature), row["actual_swing_mode"]) for row in rows]
    values = sorted({value for value, _ in pairs})
    thresholds = [values[0] - 1e-9, values[-1] + 1e-9]
    thresholds.extend((left + right) / 2 for left, right in zip(values, values[1:]))
    best = None
    for threshold in thresholds:
        for charge_above in (False, True):
            correct = sum(
                (((value > threshold) == charge_above) == (label == "charge"))
                for value, label in pairs
            )
            candidate = (correct / len(pairs), threshold, charge_above)
            if best is None or candidate[0] > best[0]:
                best = candidate
    return {
        "training_accuracy": round_value(best[0]),
        "threshold": round_value(best[1]),
        "charge_when_above_threshold": best[2],
    }


def predict_threshold(row: dict, feature: str, model: dict) -> str:
    above = nested_feature(row, feature) > model["threshold"]
    charge = above == model["charge_when_above_threshold"]
    return "charge" if charge else "slap"


def confusion(rows: list[dict], predicted_key) -> dict:
    matrix = {
        "slap": {"slap": 0, "charge": 0},
        "charge": {"slap": 0, "charge": 0},
    }
    disagreements = []
    for row in rows:
        actual = row["actual_swing_mode"]
        predicted = predicted_key(row) if callable(predicted_key) else row[predicted_key]
        matrix[actual][predicted] += 1
        if actual != predicted:
            disagreements.append({
                "game": row["game"],
                "session": row["session"],
                "pa_number": row["pa_number"],
                "pitch_number": row["pitch_number"],
                "controller_port": row["controller_port"],
                "actual": actual,
                "predicted": predicted,
            })
    correct = matrix["slap"]["slap"] + matrix["charge"]["charge"]
    total = len(rows)
    return {
        "matrix_actual_then_predicted": matrix,
        "correct": correct,
        "total": total,
        "accuracy": round_value(correct / total if total else 0),
        "false_charge": matrix["slap"]["charge"],
        "false_slap": matrix["charge"]["slap"],
        "disagreements": disagreements,
    }


def grouped_counts(rows: list[dict], fields: tuple[str, ...]) -> list[dict]:
    buckets = defaultdict(Counter)
    for row in rows:
        key = tuple(row[field] for field in fields)
        buckets[key][row["actual_swing_mode"]] += 1
    result = []
    for key in sorted(buckets, key=lambda item: tuple(str(part) for part in item)):
        counts = buckets[key]
        item = {field: value for field, value in zip(fields, key)}
        item.update({"slap": counts["slap"], "charge": counts["charge"], "total": sum(counts.values())})
        result.append(item)
    return result


def motion_distribution(rows: list[dict], feature: str) -> dict:
    values = {
        label: [nested_feature(row, feature) for row in rows if row["actual_swing_mode"] == label]
        for label in ("slap", "charge")
    }
    combined_sd = statistics.pstdev(values["slap"] + values["charge"]) or None
    mean_difference = statistics.fmean(values["charge"]) - statistics.fmean(values["slap"])
    return {
        "slap": describe(values["slap"]),
        "charge": describe(values["charge"]),
        "charge_minus_slap_mean": round_value(mean_difference),
        "standardized_mean_difference": round_value(mean_difference / combined_sd) if combined_sd else None,
    }


def build_audit(rows: list[dict], provenance: list[dict]) -> dict:
    gold = [row for row in rows if row["gold_eligible"]]
    detector = confusion(gold, "detected_swing_mode")
    independent = [row for row in gold if row["actual_swing_mode_source"] != "capture_charge_state"]
    detector_independent = confusion(independent, "detected_swing_mode")

    cross_game = []
    raw_disagreements = []
    for train_game, test_game in ((1, 2), (2, 1)):
        train = [row for row in gold if row["game"] == train_game]
        test = [row for row in gold if row["game"] == test_game]
        model = fit_threshold(train, RAW_CLASSIFIER_FEATURE)
        result = confusion(test, lambda row: predict_threshold(row, RAW_CLASSIFIER_FEATURE, model))
        for disagreement in result["disagreements"]:
            source = next(row for row in test
                          if row["pa_number"] == disagreement["pa_number"]
                          and row["pitch_number"] == disagreement["pitch_number"])
            disagreement["feature_value"] = nested_feature(source, RAW_CLASSIFIER_FEATURE)
            disagreement["threshold"] = model["threshold"]
        raw_disagreements.extend(result["disagreements"])
        port_results = {}
        for port in (1, 2):
            subset = [row for row in test if row["controller_port"] == port]
            port_results[str(port)] = confusion(
                subset, lambda row: predict_threshold(row, RAW_CLASSIFIER_FEATURE, model)
            )
        majority = Counter(row["actual_swing_mode"] for row in test).most_common(1)[0]
        cross_game.append({
            "train_game": train_game,
            "test_game": test_game,
            "feature": RAW_CLASSIFIER_FEATURE,
            "model": model,
            "test": result,
            "test_by_controller_port": port_results,
            "majority_baseline": {
                "label": majority[0],
                "correct": majority[1],
                "total": len(test),
                "accuracy": round_value(majority[1] / len(test)),
            },
        })

    planned_disagreements = [
        {
            "game": row["game"],
            "session": row["session"],
            "pa_number": row["pa_number"],
            "pitch_number": row["pitch_number"],
            "batter": row["batter"],
            "planned": row["planned_swing_mode"],
            "actual": row["actual_swing_mode"],
            "detected": row["detected_swing_mode"],
            "label_source": row["actual_swing_mode_source"],
            "charge_frames": row["swing_charge_frames"],
            "release_timing_frames": row["swing_charge_release_timing_frames"],
        }
        for row in gold if row["planned_swing_mode"] != row["actual_swing_mode"]
    ]

    charges = [row for row in gold if row["actual_swing_mode"] == "charge"]
    charge_frames = [row["swing_charge_frames"] for row in charges]
    release_timing = [row["swing_charge_release_timing_frames"] for row in charges
                      if row["swing_charge_release_timing_frames"] is not None]
    release_to_swing = [row["charge_memory_evidence"]["release_to_swing_start_frames"] for row in charges
                        if row["charge_memory_evidence"]["release_to_swing_start_frames"] is not None]
    charge_timing_by_game = []
    for game in (1, 2):
        game_charges = [row for row in charges if row["game"] == game]
        charge_timing_by_game.append({
            "game": game,
            "charge_frames": describe([row["swing_charge_frames"] for row in game_charges]),
            "release_to_swing_start_frames": describe([
                row["swing_charge_release_timing_frames"] for row in game_charges
                if row["swing_charge_release_timing_frames"] is not None
            ]),
            "release_to_swing_start_reconstructed_frames": describe([
                row["charge_memory_evidence"]["release_to_swing_start_frames"] for row in game_charges
                if row["charge_memory_evidence"]["release_to_swing_start_frames"] is not None
            ]),
        })

    excluded = Counter(row["exclusion_reason"] or row["offer_type"] for row in rows if not row["gold_eligible"])
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "purpose": "offline slap/charge calibration audit; no production model activation",
        "sessions": provenance,
        "selection": {
            "selected_in_order": [item["stem"] for item in provenance],
            "excluded_discovery_session": "mario_stadium-20260923T012536Z",
            "reason": "the selected headers/manifests were consecutive 2026-09-25 captures and both use calibration_excluded_reason='scripted slap-charge calibration'; the 2026-09-23 lineup declares status='gesture_discovery_only'",
        },
        "label_policy": {
            "planned_swing_mode": "operator schedule; never used as a detector feature",
            "actual_swing_mode": "operator corrections override plan; Game 1 PAs 10-12 become charge only when a live charge-counter rise plus release is present",
            "detected_swing_mode": "unaltered pitch-stream output",
            "gold_filter": "ordinary swings with corrected slap/charge labels only",
            "target_leakage": {
                "swing_charge_frames": "direct in-game charge-state evidence and the same signal used by the current detector; not an independent classifier feature",
                "raw_wiimote_motion": "independent candidate input; evaluated without swing_mode or swing_charge_frames",
            },
        },
        "counts": {
            "all_pitches": len(rows),
            "gold_ordinary_swings": len(gold),
            "gold_by_game": grouped_counts(gold, ("game",)),
            "by_controller_port": grouped_counts(gold, ("controller_port",)),
            "by_game_and_controller_port": grouped_counts(gold, ("game", "controller_port")),
            "by_side": grouped_counts(gold, ("half",)),
            "by_game_and_inning": grouped_counts(gold, ("game", "inning")),
            "by_batter": grouped_counts(gold, ("game", "batter")),
            "by_batter_all_games": grouped_counts(gold, ("batter",)),
            "by_contact_result": grouped_counts(gold, ("contact_result",)),
            "excluded": dict(sorted(excluded.items())),
        },
        "current_detector": {
            "signal": "swing_charge_frames rise; charge if >0, slap if zero",
            "against_all_corrected_gold": detector,
            "against_operator_schedule_or_correction_only": detector_independent,
            "interpretation": "The all-gold matrix is partly circular because four Game 1 swings use the same direct charge-state evidence to resolve operator uncertainty. The operator-only subset is the independent check.",
        },
        "planned_vs_actual_disagreements": planned_disagreements,
        "charge_timing": {
            "slap_charge_frames": describe([
                row["swing_charge_frames"] for row in gold if row["actual_swing_mode"] == "slap"
            ]),
            "charge_frames": describe(charge_frames),
            "release_to_pitch_resolution_frames": describe(release_timing),
            "release_to_swing_start_frames": describe(release_to_swing),
            "by_game": charge_timing_by_game,
            "note": "The existing release-timing field is measured to pitch resolution. It is comparable to swing release on contact, but is inflated on a swing-and-miss because the count resolves later.",
        },
        "raw_controller_motion": {
            "candidate_feature_distributions": {
                RAW_CLASSIFIER_FEATURE: motion_distribution(gold, RAW_CLASSIFIER_FEATURE),
                "prep.acc_variation.mean": motion_distribution(gold, "prep.acc_variation.mean"),
                "prep.acc_y.path": motion_distribution(gold, "prep.acc_y.path"),
                "prep.down_x.range": motion_distribution(gold, "prep.down_x.range"),
            },
            "exploratory_classifier": {
                "type": "one-dimensional threshold",
                "feature": RAW_CLASSIFIER_FEATURE,
                "feature_selection_caveat": "chosen after exploratory inspection as the most stable same-direction raw feature; with only two games, this is not an untouched model-selection holdout",
                "split": "train one complete game, test the other, then reverse",
                "results": cross_game,
                "all_disagreements": raw_disagreements,
            },
            "conclusion": "raw controller motion overlaps heavily and does not support a reliable standalone slap/charge classifier in these two games",
        },
        "focused_pitch_evidence": {
            "game_1_pa_10_to_13": [row for row in rows if row["game"] == 1 and 10 <= row["pa_number"] <= 13],
            "game_2_pa_23": [row for row in rows if row["game"] == 2 and row["pa_number"] == 23],
        },
        "conclusion": {
            "memory_state_separable": True,
            "raw_controller_motion_separable": False,
            "sufficient_for_memory_detector": True,
            "sufficient_for_motion_only_detector": False,
            "production_change_made": False,
        },
        "remaining_confounds": [
            "Only two games and one operator are represented.",
            "Logical ports 1 and 2 are both covered, but the capture has no physical-remote serial, so the planned physical-device swap cannot be proven from the files.",
            "Character, inning, planned mode, and contact result are not fully factorial; all six home runs in the gold set are charges.",
            "Four Game 1 swings are resolved from the same charge-state signal the current detector uses, so they are excluded from the independent 55-swing detector check.",
            "The raw-motion feature was selected during exploration with only two game groups, so its cross-game result is optimistic rather than a final untouched validation.",
        ],
    }


def validate(rows: list[dict], audit: dict) -> None:
    assert [item["stem"] for item in audit["sessions"]] == [item["stem"] for item in SESSIONS]
    assert [item["recorded_utc"] for item in audit["sessions"]] == [
        "20260925T122709Z", "20260925T123759Z"
    ]
    assert all(item["calibration_excluded"] is True for item in audit["sessions"])
    assert all(item["calibration_excluded_reason"] == "scripted slap-charge calibration"
               for item in audit["sessions"])
    assert all(item["header_checksum_sha256"] == item["verified_binary_checksum_sha256"]
               for item in audit["sessions"])
    assert audit["counts"]["all_pitches"] == 62
    assert audit["counts"]["gold_ordinary_swings"] == 59, audit["counts"]
    game_counts = {item["game"]: item for item in audit["counts"]["gold_by_game"]}
    assert (game_counts[1]["slap"], game_counts[1]["charge"]) == (14, 15)
    assert (game_counts[2]["slap"], game_counts[2]["charge"]) == (11, 19)
    assert audit["counts"]["excluded"] == {"take": 3}
    detector = audit["current_detector"]["against_all_corrected_gold"]
    assert detector["accuracy"] == 1.0 and not detector["disagreements"]
    independent = audit["current_detector"]["against_operator_schedule_or_correction_only"]
    assert independent["correct"] == independent["total"] == 55
    pa10_12 = [row for row in rows if row["game"] == 1 and row["pa_number"] in (10, 11, 12)]
    assert len(pa10_12) == 4
    assert all(row["actual_swing_mode"] == "charge" for row in pa10_12)
    assert all(row["actual_swing_mode_source"] == "capture_charge_state" for row in pa10_12)
    pa13 = [row for row in rows if row["game"] == 1 and row["pa_number"] == 13]
    assert len(pa13) == 1 and pa13[0]["actual_swing_mode"] == "slap"
    pa23 = [row for row in rows if row["game"] == 2 and row["pa_number"] == 23]
    assert [(row["pitch_number"], row["actual_swing_mode"]) for row in pa23] == [(1, "charge"), (2, "slap")]
    assert all(row["gold_eligible"] == (row["offer_type"] == "ordinary_swing") for row in rows)
    cross_game = audit["raw_controller_motion"]["exploratory_classifier"]["results"]
    assert [(item["test"]["correct"], item["test"]["total"]) for item in cross_game] == [(21, 30), (22, 29)]


def write_outputs(rows: list[dict], audit: dict) -> None:
    CALIBRATION.mkdir(parents=True, exist_ok=True)
    jsonl_path = CALIBRATION / "swing-gesture-pitches-v1.jsonl"
    audit_path = CALIBRATION / "swing-gesture-audit-v1.json"
    jsonl_path.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")
    audit_path.write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="validate in memory without rewriting artifacts")
    args = parser.parse_args()
    rows = []
    provenance = []
    for config in SESSIONS:
        session_rows, session_provenance = load_session(config)
        rows.extend(session_rows)
        provenance.append(session_provenance)
    audit = build_audit(rows, provenance)
    validate(rows, audit)
    if not args.check:
        write_outputs(rows, audit)
    detector = audit["current_detector"]["against_all_corrected_gold"]
    print(f"sessions: {', '.join(item['stem'] for item in provenance)}")
    print(f"pitches: {len(rows)}; gold ordinary swings: {len([row for row in rows if row['gold_eligible']])}")
    print(f"detector: {detector['correct']}/{detector['total']} ({detector['accuracy']:.1%}) against corrected labels")
    for result in audit["raw_controller_motion"]["exploratory_classifier"]["results"]:
        test = result["test"]
        print(f"raw motion train Game {result['train_game']} -> test Game {result['test_game']}: "
              f"{test['correct']}/{test['total']} ({test['accuracy']:.1%})")


if __name__ == "__main__":
    main()
