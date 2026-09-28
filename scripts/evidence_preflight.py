"""Prove the comprehensive capture works before the one game it is for.

    python scripts/evidence_preflight.py synthetic
        The real collector, header, frame loop, crash path, reader and
        extractor, run against tests/helpers/fake_dme -- no Dolphin, no game.
    python scripts/evidence_preflight.py live [--seconds 10]
        Dolphin running, MSS at ANY menu, no match needed: every region is
        read, both remotes and both meters are sampled, the per-frame cost is
        measured on live bytes. Wave both remotes during the sample.
    python scripts/evidence_preflight.py map-remotes \\
            --assign "WHITE=Jason" --assign "BLACK=Jason" --out <metadata.json>
        Hold D-pad Up on each named remote when asked. Writes the session metadata:
        which physical remote (and player) is behind which port, with the
        button evidence that proved it.
    python scripts/evidence_preflight.py offline <stem> [<stem> ...]
        The same gates against captures already on disk (old or new).
    python scripts/evidence_preflight.py report
        Every gate, pass / fail / pending, from the saved results.

Results accumulate in data/calibration/evidence-preflight-report-v1.json. None
of this writes to Supabase or starts a game.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import capture_evidence_schema as evidence

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
FAKE_DME = ROOT / "tests" / "helpers" / "fake_dme"
REPORT = ROOT / "data" / "calibration" / "evidence-preflight-report-v1.json"
CAPTURE_DIR = ROOT / "data" / "player_tracking"

# Thresholds the capture has to meet. A frame budget is 16.7 ms; the collector
# also derives plays live, so the encode path gets well under half of it.
MAX_MISSED_FRACTION = 0.005
MAX_LONGEST_GAP_FRAMES = 30
MIN_FREE_BYTES = 20 * 1024 ** 3
FRAME_BUDGET_MS = 1000 / 59.94


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_report() -> dict:
    try:
        return json.loads(REPORT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"schema": "sluggers-evidence-preflight", "version": 1, "runs": {}}


def save_run(name: str, result: dict) -> None:
    report = load_report()
    report.setdefault("runs", {})[name] = dict(result, recorded_utc=now_utc())
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")


def python_env(fake: bool, **extra) -> dict:
    env = dict(os.environ, **extra)
    if fake:
        env["PYTHONPATH"] = os.pathsep.join([str(FAKE_DME), str(SCRIPTS),
                                             env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
    return env


# ---------------------------------------------------------------------------
# synthetic


def _synthetic_metadata(path: Path) -> Path:
    payload = {
        "schema": evidence.SESSION_METADATA_SCHEMA,
        "version": evidence.SESSION_METADATA_VERSION,
        "session_label": "synthetic-preflight",
        "purpose": "preflight against tests/helpers/fake_dme",
        "ports": {
            # The fake says team1 = port 1 and team1 fields in half 0.
            "1": {"player": "SYNTHETIC-A", "remote_label": "FAKE-1",
                  "nunchuk": False, "expected_capture_side": "home"},
            "2": {"player": "SYNTHETIC-B", "remote_label": "FAKE-2",
                  "nunchuk": False, "expected_capture_side": "away"},
        },
        "control_changes": [],
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def _run_collector(out: Path, metadata: Path, seconds: float, *, kill_after=None,
                   memory_probe="on") -> dict:
    command = [sys.executable, str(SCRIPTS / "collect_player_tracking.py"),
               "--out", str(out), "--evidence-profile", "comprehensive",
               "--session-metadata", str(metadata), "--max-seconds", str(seconds),
               "--memory-probe", memory_probe]
    process = subprocess.Popen(command, cwd=str(SCRIPTS), env=python_env(True),
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, bufsize=1)
    lines, ready, attached = [], None, None
    started = time.monotonic()
    killed = False
    while True:
        line = process.stdout.readline()
        if not line:
            break
        lines.append(line.rstrip())
        if line.startswith("[capture-ready] "):
            ready = json.loads(line[len("[capture-ready] "):])
            ready_at = time.monotonic()
        if line.startswith("[capture-attached] "):
            attached = json.loads(line[len("[capture-attached] "):])
        if (kill_after is not None and ready is not None
                and time.monotonic() - ready_at >= kill_after):
            process.kill()                      # TerminateProcess: no cleanup runs
            killed = True
            break
    process.wait(timeout=60)
    return {"returncode": process.returncode, "killed": killed, "ready": ready,
            "attached": attached, "seconds": round(time.monotonic() - started, 2),
            "tail": lines[-8:], "stem": (attached or {}).get("stem")}


def _read_capture(stem: str) -> dict:
    sys.path.insert(0, str(SCRIPTS))
    from player_tracking_io import Session
    session = Session(stem)
    frames = 0
    last_timer = None
    for frame in session.frames():
        frames += 1
        last_timer = frame.timer
    return {"frames_readable": frames, "last_timer": last_timer,
            "header_frames": session.header.get("frames"),
            "capture_complete": session.header.get("capture_complete"),
            "progress": session.header.get("progress")}


def encode_cost(stem: str | None, frames: int = 600) -> dict | None:
    """Per-frame XOR + zlib cost and size at the comprehensive frame size.

    Real archived frames supply the state block and both remotes; the appended
    regions are padded with bytes that change at the rate measured across the
    Yoshi Park full-memory copies (~1,500 of the 72,784 appended bytes differ
    between copies seconds apart) -- deliberately all of them every frame, so
    this is the pessimistic end.
    """
    if not stem:
        return None
    sys.path.insert(0, str(SCRIPTS))
    import numpy as np
    from collect_player_tracking import xor_delta
    from player_tracking_io import Session
    session = Session(stem)
    appended = sum(size for _, _, size in evidence.comprehensive_regions()) + evidence.REPLAY_REGION_SIZE
    rng = np.random.default_rng(7)
    churn_positions = rng.choice(appended, size=1500, replace=False)
    compressor = zlib.compressobj(6)
    previous = None
    sizes, costs = [], []
    for index, frame in enumerate(session.frames()):
        if index >= frames:
            break
        tail = np.zeros(appended, dtype=np.uint8)
        tail[churn_positions] = rng.integers(0, 256, size=churn_positions.size, dtype=np.uint8)
        block = frame.block + tail.tobytes()
        if previous is None:
            previous = bytes(len(block))
        started = time.perf_counter()
        delta = xor_delta(block, previous)
        out = compressor.compress(struct.pack(">I", len(delta)) + delta)
        out += compressor.flush(zlib.Z_SYNC_FLUSH) if index % 120 == 0 else b""
        costs.append((time.perf_counter() - started) * 1000)
        sizes.append(len(out))
        previous = block
    tail_bytes = compressor.flush()
    total = sum(sizes) + len(tail_bytes)
    return {"source_capture": Path(stem).name, "frames": len(costs),
            "frame_bytes": len(previous),
            "compressed_bytes_per_frame": round(total / max(1, len(costs))),
            "encode_ms_mean": round(statistics.fmean(costs), 3),
            "encode_ms_p99": round(sorted(costs)[int(0.99 * (len(costs) - 1))], 3),
            "assumption": "1,500 appended bytes change every frame (pessimistic)"}


def synthetic(args) -> int:
    scratch = Path(tempfile.mkdtemp(prefix="evidence-preflight-"))
    try:
        metadata = _synthetic_metadata(scratch / "metadata.json")
        clean = _run_collector(scratch, metadata, args.seconds)
        checks = {}
        header = json.loads(Path(clean["stem"] + ".json").read_text()) if clean["stem"] else {}
        schema = header.get("capture_schema") or {}
        timing = header.get("frame_timing") or {}
        frames = header.get("frames") or 0
        checks["collector_started"] = bool(clean["attached"]) and bool((clean["ready"] or {}).get("ready"))
        checks["capture_complete"] = header.get("capture_complete") is True
        checks["schema_v3_comprehensive"] = (schema.get("version") == 3
                                             and schema.get("profile") == "comprehensive")
        checks["no_region_overlaps"] = schema.get("region_overlaps") == []
        checks["missed_frames_within_threshold"] = (
            frames > 0 and timing.get("missed_frames", 1e9) <= MAX_MISSED_FRACTION * frames
            and timing.get("longest_gap_frames", 1e9) <= MAX_LONGEST_GAP_FRAMES)
        checks["metadata_recorded"] = bool((schema.get("session_metadata") or {}).get("sha256"))
        checks["declared_sides_agree_with_memory"] = (
            (header.get("controller_sides_at_start") or {}).get("declared_vs_memory", {}).get("status") == "agrees")
        sys.path.insert(0, str(SCRIPTS))
        from extract_input_evidence import extract
        summary = extract(clean["stem"])
        rows = [json.loads(line) for line in
                Path(clean["stem"] + ".evidence.jsonl").read_text().splitlines()]
        edges = [row for row in rows if row["kind"] == "button_edge"]
        port1 = {row["timer"] for row in edges if row["port"] == 1 and "a" in row["pressed"]}
        port2 = {row["timer"] for row in edges if row["port"] == 2 and "b" in row["pressed"]}
        checks["both_ports_raw_button_edges_with_timers"] = bool(port1) and bool(port2)
        # Independent, not exclusive: two real remotes can press on the same
        # frame. What an aliased or shared struct cannot do is move on one
        # port while the other stays still, in both directions.
        checks["ports_independent"] = bool(port1 - port2) and bool(port2 - port1)
        meters = summary.get("star_meter_change_count") or {}
        checks["both_star_meters_change_independently"] = (
            meters.get("away", 0) > 0 and meters.get("home", 0) > 0
            and bool({r["timer"] for r in rows if r["kind"] == "star_meter_change" and r["side"] == "away"}
                     ^ {r["timer"] for r in rows if r["kind"] == "star_meter_change" and r["side"] == "home"}))
        pitch_windows = [row for row in rows if row["kind"] == "pitch_window"]
        checks["pitch_windows_synchronized"] = bool(pitch_windows) and all(
            row["timer"] == row["release_timer"] and row["inputs_by_port"] for row in pitch_windows)
        session_row = rows[0]
        avail = session_row["availability"]
        checks["all_evidence_streams_observed"] = (
            all(v == "observed" for v in avail["controller_input"].values())
            and avail["star_meters"] == "observed" and avail["player_type_ports"] == "observed"
            and avail["replay_flag"] == "observed" and avail["game_timer_mirror"] == "observed")
        checks["pitch_charge_still_reported_unobserved"] = avail["pitch_charge"] == "unobserved"
        probe_dir = Path(clean["stem"] + ".probe")
        copies = [line for line in (probe_dir / "index.jsonl").read_text().splitlines()] \
            if (probe_dir / "index.jsonl").exists() else []
        checks["memory_probe_copies_taken"] = len(copies) >= 2

        crash = _run_collector(scratch, metadata, 60, kill_after=args.kill_after,
                               memory_probe="off")
        partial = _read_capture(crash["stem"]) if crash["stem"] else {}
        expected = int((args.kill_after - evidence_flush_seconds()) * 59)
        checks["crash_preserves_partial_evidence"] = (
            crash["killed"] and partial.get("capture_complete") is False
            and partial.get("frames_readable", 0) >= max(1, expected))

        cost = encode_cost(args.cost_capture)
        if cost:
            checks["encode_cost_within_budget"] = cost["encode_ms_p99"] < FRAME_BUDGET_MS / 4
        result = {
            "passed": all(checks.values()), "checks": checks,
            "capture": {"frames": frames, "duration_s": header.get("duration_seconds"),
                        "fps": round(frames / max(1e-9, header.get("duration_seconds") or 0), 2),
                        "bytes_per_frame_read": schema.get("bytes_per_frame"),
                        "bytes_on_disk_per_frame_fake": round(
                            Path(clean["stem"] + ".bin").stat().st_size / max(1, frames)),
                        "frame_timing": {k: v for k, v in timing.items() if k != "gaps"},
                        "regions": [[r["name"], hex(r["base"]), r["size"]] for r in schema.get("layout", [])],
                        "probe_copies": len(copies)},
            "evidence_summary": {k: v for k, v in summary.items() if k != "path"},
            "crash": {"killed_after_ready_s": args.kill_after, **partial},
            "encode_cost": cost,
            "note": "Fake Dolphin: timing and churn are not the real game's. "
                    "It proves the code path, not the game.",
        }
        save_run("synthetic", result)
        print(json.dumps(result, indent=2))
        return 0 if result["passed"] else 1
    finally:
        if not args.keep:
            shutil.rmtree(scratch, ignore_errors=True)
        else:
            print(f"kept {scratch}")


def evidence_flush_seconds() -> float:
    sys.path.insert(0, str(SCRIPTS))
    from collect_player_tracking import SYNC_FLUSH_SECONDS
    return SYNC_FLUSH_SECONDS


# ---------------------------------------------------------------------------
# live


def _hook():
    sys.path.insert(0, str(SCRIPTS))
    from probe_ball_memory import hook
    return hook()


def _kpad(dme, port: int) -> dict:
    raw = dme.read_bytes(evidence.PORT_BASES[port], 0x60)
    out = {}
    for name, offset, fmt in evidence.KPAD_FIELDS:
        out[name] = struct.unpack_from(fmt, raw, offset)[0]
    return out


def live(args) -> int:
    sys.path.insert(0, str(SCRIPTS))
    import collect_player_tracking as collector
    try:
        dme = _hook()
    except SystemExit as error:
        result = {"passed": False, "reason": f"Dolphin not hooked: {error}"}
        save_run("live", result)
        print(json.dumps(result, indent=2))
        return 1
    checks = {}
    identity = collector.executable_identity(dme, hash_emulator=True)
    checks["disc_is_mss_ntsc_u"] = identity.get("disc_id") == "RMBE01"
    try:
        collector.resolve_actors(dme)
        match_live = True
    except SystemExit:
        match_live = False
    pointer = struct.unpack(">I", dme.read_bytes(evidence.REPLAY_POINTER_SLOT, 4))[0]
    replay = evidence.replay_region(pointer)
    regions = ([("state_block", collector.STATE_BASE, collector.STATE_SIZE)]
               + list(collector.EXTRA_REGIONS) + evidence.comprehensive_regions()
               + ([replay] if replay else []))
    readable, read_ms = {}, {}
    for name, base, size in regions:
        started = time.perf_counter()
        try:
            data = dme.read_bytes(base, size)
            readable[name] = len(data) == size
        except Exception as error:              # noqa: BLE001 - reported
            readable[name] = f"unreadable: {error!r}"
        read_ms[name] = round((time.perf_counter() - started) * 1000, 3)
    checks["all_regions_readable"] = all(value is True for value in readable.values())

    samples = []
    compressor = zlib.compressobj(6)
    previous = None
    encode = []
    sizes = []
    deadline = time.perf_counter() + args.seconds
    print(f"sampling {args.seconds:.0f}s -- wave BOTH remotes (no buttons needed)...")
    while time.perf_counter() < deadline:
        tick = time.perf_counter()
        ports = {port: _kpad(dme, port) for port in (1, 2, 3, 4)}
        meters = struct.unpack(">HH", dme.read_bytes(0x900D4E24, 4))
        timer = struct.unpack(">I", dme.read_bytes(collector.GAME_TIMER, 4))[0]
        player_types = tuple(dme.read_bytes(0x811F76B0, 2))
        started = time.perf_counter()
        block = b"".join(dme.read_bytes(base, size) for _, base, size in regions)
        read_cost = time.perf_counter() - started
        if previous is None:
            previous = bytes(len(block))
        started = time.perf_counter()
        out = compressor.compress(collector.xor_delta(block, previous))
        encode.append((time.perf_counter() - started + read_cost) * 1000)
        sizes.append(len(out))
        previous = block
        samples.append((timer, ports, meters, player_types))
        time.sleep(max(0.0, 1 / 60 - (time.perf_counter() - tick)))
    total = sum(sizes) + len(compressor.flush())
    per_port = {}
    for port in (1, 2, 3, 4):
        values = [sample[1][port] for sample in samples]
        per_port[str(port)] = {
            "connected_fraction": round(sum(
                1 for v in values if v["dev_type"] not in evidence.KPAD_DEVICE_ABSENT
                and v["wpad_err"] != -1) / len(values), 3),
            "frames_with_button_held": sum(1 for v in values if v["hold"] & 0xFFFF),
            "buttons_seen": sorted({name for v in values for name in evidence.button_names(v["hold"] & 0xFFFF)}),
            "distinct_acc_values": len({round(v["acc_value"], 4) for v in values}),
        }
    moved = {p for p, v in per_port.items() if v["distinct_acc_values"] > 5}
    checks["ports_1_and_2_connected"] = all(per_port[p]["connected_fraction"] > 0.95 for p in ("1", "2"))
    checks["ports_1_and_2_motion_changes"] = {"1", "2"} <= moved
    checks["star_meters_readable"] = all(isinstance(sample[2][0], int) for sample in samples)
    free = shutil.disk_usage(CAPTURE_DIR).free
    checks["disk_space"] = free >= MIN_FREE_BYTES
    checks["encode_and_read_within_budget"] = (
        sorted(encode)[int(0.99 * (len(encode) - 1))] < FRAME_BUDGET_MS / 3)
    result = {
        "passed": all(checks.values()), "checks": checks, "match_live": match_live,
        "identity": identity, "regions_readable": readable, "region_read_ms": read_ms,
        "samples": len(samples),
        "game_timer_advanced": samples[-1][0] != samples[0][0],
        "ports": per_port,
        "star_meters_seen": {"away": sorted({s[2][0] for s in samples}),
                             "home": sorted({s[2][1] for s in samples})},
        "player_type_bytes": sorted({s[3] for s in samples}),
        "bytes_per_frame_read": sum(size for _, _, size in regions),
        "compressed_bytes_per_frame_live": round(total / max(1, len(samples))),
        "read_plus_encode_ms_mean": round(statistics.fmean(encode), 3),
        "read_plus_encode_ms_p99": round(sorted(encode)[int(0.99 * (len(encode) - 1))], 3),
        "disk_free_gb": round(free / 1024 ** 3, 1),
        "note": ("A menu is quieter than a match, so the live compressed size "
                 "is a floor; the first minute of the game prints the real rate."),
    }
    save_run("live", result)
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


# ---------------------------------------------------------------------------
# map-remotes


def detect_port(samples: list[dict], button: int = 0x0800, hold_frames: int = 20) -> dict | None:
    """The one port that held `button` for `hold_frames` in a row, alone.

    `samples` are {port: hold_word}. Any other port pressing anything during
    the run disqualifies it -- the whole point is that exactly one remote
    moved, so a mapping can never come from two remotes acting at once.
    """
    run_port, run = None, 0
    for index, sample in enumerate(samples):
        holding = [port for port, word in sample.items() if word & button]
        others_busy = any(word & 0xFFFF for port, word in sample.items()
                          if port not in holding)
        if len(holding) == 1 and not others_busy:
            port = holding[0]
            run = run + 1 if port == run_port else 1
            run_port = port
            if run >= hold_frames:
                return {"port": port, "end_sample": index, "run_frames": run,
                        "other_ports_idle": True}
        else:
            run_port, run = None, 0
    return None


def map_remotes(args) -> int:
    assignments = []
    for item in args.assign:
        label, _, player = item.partition("=")
        if not label.strip() or not player.strip():
            raise SystemExit(f"--assign {item!r}: use LABEL=PLAYER")
        assignments.append((label.strip(), player.strip()))
    sides = {}
    for item in args.side or []:
        label, _, side = item.partition("=")
        if side not in evidence.CAPTURE_SIDES:
            raise SystemExit(f"--side {item!r}: side must be away or home")
        sides[label.strip()] = side
    mask = evidence.WPAD_BUTTONS[args.button]
    dme = _hook()
    ports, proof = {}, []
    for label, player in assignments:
        print(f"\nHold {args.button.upper()} on the remote labelled {label!r} ({player}). Touch nothing else.")
        samples = []
        deadline = time.monotonic() + args.timeout
        found = None
        while time.monotonic() < deadline and found is None:
            samples.append({port: _kpad(dme, port)["hold"] for port in (1, 2, 3, 4)})
            found = detect_port(samples[-120:], button=mask)
            time.sleep(1 / 60)
        if found is None:
            raise SystemExit(f"No single port held {args.button} for {label!r} within {args.timeout:.0f}s. "
                             "Nothing was written.")
        port = str(found["port"])
        if port in ports:
            raise SystemExit(f"{label!r} lit port {port}, which {ports[port]['remote_label']!r} "
                             "already did. Nothing was written.")
        print(f"  {label!r} is port {port}. Release it.")
        ports[port] = {"player": player, "remote_label": label, "nunchuk": False,
                       "expected_capture_side": sides.get(label)}
        proof.append({"remote_label": label, "port": int(port),
                      "detected_utc": now_utc(), **found})
        while any(_kpad(dme, p)["hold"] & 0xFFFF for p in (1, 2, 3, 4)):
            time.sleep(0.05)
    payload = {
        "schema": evidence.SESSION_METADATA_SCHEMA,
        "version": evidence.SESSION_METADATA_VERSION,
        "session_label": args.session_label,
        "purpose": "comprehensive_evidence_expansion_calibration",
        "schedule": args.schedule,
        "operator": args.operator or assignments[0][1],
        "ports": ports,
        "control_changes": [],
        "remote_mapping_evidence": {"method": f"hold {args.button} on one named remote at a time; "
                                              "exactly one port lit, all others idle",
                                    "steps": proof},
    }
    errors = evidence.validate_session_metadata(payload)
    if errors:
        raise SystemExit("Mapping produced invalid metadata:\n  - " + "\n  - ".join(errors))
    out = Path(args.out)
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    save_run("map_remotes", {"passed": True, "metadata": str(out), "ports": ports,
                             "proof": proof})
    print(f"\nwrote {out}")
    return 0


# ---------------------------------------------------------------------------
# offline


def offline(args) -> int:
    sys.path.insert(0, str(SCRIPTS))
    from extract_input_evidence import extract
    results = {}
    for stem in args.stems:
        summary = extract(stem, write=not args.summary_only)
        header = json.loads(Path(stem).with_suffix(".json").read_text())
        schema = header.get("capture_schema") or {}
        results[Path(stem).name] = {
            "capture_schema_version": schema.get("version", 2),
            "profile": schema.get("profile"),
            "frames_read": summary["frames"],
            "header_frames": header.get("frames"),
            "all_frames_read": summary["frames"] == header.get("frames"),
            "records": summary["records"],
            "ports_recorded": summary["ports_recorded"],
            "star_meter_change_count": summary["star_meter_change_count"],
            "swing_onset_peak_port_by_half": summary["swing_onset_peak_port_by_half"],
        }
    passed = all(entry["all_frames_read"] for entry in results.values())
    save_run("offline", {"passed": passed, "captures": results})
    print(json.dumps(results, indent=2))
    return 0 if passed else 1


# ---------------------------------------------------------------------------
# report

GATES = (
    ("collector_starts", "synthetic", "collector_started"),
    ("expanded_regions_readable_live", "live", "all_regions_readable"),
    ("both_controllers_update_independently_live", "map_remotes", None),
    ("both_controllers_update_independently_synthetic", "synthetic", "ports_independent"),
    ("both_star_meters_readable_live", "live", "star_meters_readable"),
    ("both_star_meters_change_independently_synthetic", "synthetic", "both_star_meters_change_independently"),
    ("player_controller_side_mapping_configured", "map_remotes", None),
    ("raw_button_and_motion_with_frame_timestamps", "synthetic", "both_ports_raw_button_edges_with_timers"),
    ("streams_synchronized", "synthetic", "pitch_windows_synchronized"),
    ("old_capture_replay_compatible", "offline", None),
    ("disk_space", "live", "disk_space"),
    ("cadence_and_missed_frames", "synthetic", "missed_frames_within_threshold"),
    ("crash_preserves_partial_evidence", "synthetic", "crash_preserves_partial_evidence"),
    ("encode_cost_within_budget", "synthetic", "encode_cost_within_budget"),
    ("live_read_plus_encode_within_budget", "live", "encode_and_read_within_budget"),
)


def report(_args) -> int:
    runs = load_report().get("runs", {})
    rows = []
    for gate, run, check in GATES:
        entry = runs.get(run)
        if entry is None:
            status = "pending"
        elif check is None:
            status = "pass" if entry.get("passed") else "fail"
        else:
            value = (entry.get("checks") or {}).get(check)
            status = "pending" if value is None else ("pass" if value else "fail")
        rows.append((gate, status, run, (entry or {}).get("recorded_utc")))
    width = max(len(row[0]) for row in rows)
    for gate, status, run, when in rows:
        print(f"{gate:<{width}}  {status:7s}  {run}  {when or ''}")
    return 0 if all(row[1] == "pass" for row in rows) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("synthetic")
    p.add_argument("--seconds", type=float, default=17.0)
    p.add_argument("--kill-after", type=float, default=6.0,
                   help="seconds after [capture-ready] to kill the crash-test collector")
    p.add_argument("--cost-capture",
                   default=str(CAPTURE_DIR / "mario_stadium-20260925T165659Z"),
                   help="archived capture whose frames feed the encode-cost estimate")
    p.add_argument("--keep", action="store_true")
    p.set_defaults(func=synthetic)
    p = sub.add_parser("live")
    p.add_argument("--seconds", type=float, default=10.0)
    p.set_defaults(func=live)
    p = sub.add_parser("map-remotes")
    p.add_argument("--assign", action="append", required=True, metavar="LABEL=PLAYER")
    p.add_argument("--side", action="append", metavar="LABEL=away|home")
    p.add_argument("--out", required=True)
    p.add_argument("--session-label", default="evidence-expansion-v1")
    p.add_argument("--schedule", default="data/calibration/evidence-expansion-schedule-v1.json")
    p.add_argument("--operator", default=None)
    p.add_argument("--timeout", type=float, default=30.0)
    # D-pad Up only moves a menu cursor; A would select whatever it is on.
    p.add_argument("--button", default="up", choices=sorted(evidence.WPAD_BUTTONS))
    p.set_defaults(func=map_remotes)
    p = sub.add_parser("offline")
    p.add_argument("stems", nargs="+")
    p.add_argument("--summary-only", action="store_true")
    p.set_defaults(func=offline)
    p = sub.add_parser("report")
    p.set_defaults(func=report)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
