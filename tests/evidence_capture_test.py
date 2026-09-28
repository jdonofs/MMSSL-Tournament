"""The comprehensive evidence capture, tested before the one game it is for.

    python -m unittest tests/evidence_capture_test.py

The end-to-end cases run the real collector against tests/helpers/fake_dme --
a scripted match with no emulator -- so the header, frame loop, crash path,
reader and extractor are exercised exactly as they will run for real.
"""
import json
import os
import random
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
FAKE_DME = ROOT / "tests" / "helpers" / "fake_dme"
sys.path.insert(0, str(SCRIPTS))

import capture_evidence_schema as evidence  # noqa: E402
import collect_player_tracking as collector  # noqa: E402
from evidence_preflight import detect_port  # noqa: E402
from extract_input_evidence import extract  # noqa: E402
from player_tracking_io import FRAME_MAGIC, Session, SnapshotBuilder  # noqa: E402

# Keys that would carry an outcome into pre-release evidence.
OUTCOME_KEYS = {"result", "outcome", "hit", "out", "outs_on_play", "rbi", "runs",
                "run_scored", "contact", "contact_result", "exit_velocity",
                "launch_angle", "is_star_pitch", "star_pitch", "swing_mode",
                "detected_swing_mode", "fielded", "error"}


def valid_metadata(**changes):
    payload = {
        "schema": evidence.SESSION_METADATA_SCHEMA,
        "version": evidence.SESSION_METADATA_VERSION,
        "session_label": "test",
        "ports": {
            "1": {"player": "A", "remote_label": "WHITE", "nunchuk": False,
                  "expected_capture_side": "home"},
            "2": {"player": "B", "remote_label": "BLACK", "nunchuk": False,
                  "expected_capture_side": "away"},
        },
        "control_changes": [],
    }
    payload.update(changes)
    return payload


def keys_anywhere(value):
    if isinstance(value, dict):
        for key, inner in value.items():
            yield key
            yield from keys_anywhere(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from keys_anywhere(inner)


class SchemaTests(unittest.TestCase):
    def test_version_and_profiles(self):
        self.assertEqual(evidence.CAPTURE_SCHEMA_VERSION, 3)
        self.assertEqual(evidence.EVIDENCE_PROFILES, ("standard", "comprehensive"))

    def test_no_address_is_recorded_twice(self):
        standard = [("state_block", collector.STATE_BASE, collector.STATE_SIZE),
                    *collector.EXTRA_REGIONS]
        everything = standard + evidence.comprehensive_regions()
        self.assertEqual(evidence.region_overlaps(everything), [])

    def test_standard_regions_keep_their_frame_offsets(self):
        standard = list(collector.EXTRA_REGIONS)
        comprehensive = standard + evidence.comprehensive_regions()
        plain = evidence.capture_layout(collector.STATE_BASE, collector.STATE_SIZE, standard)
        wide = evidence.capture_layout(collector.STATE_BASE, collector.STATE_SIZE, comprehensive)
        self.assertEqual(plain, wide[:len(plain)])

    def test_every_evidence_field_lands_in_exactly_one_region(self):
        regions = list(collector.EXTRA_REGIONS) + evidence.comprehensive_regions()
        spans = [("state_block", collector.STATE_BASE, collector.STATE_SIZE), *regions]
        for name, address, fmt, _source in evidence.EVIDENCE_FIELDS:
            size = struct.calcsize(fmt)
            holders = [r for r, base, length in spans
                       if base <= address and address + size <= base + length]
            self.assertEqual(len(holders), 1, name)
            self.assertIsNotNone(evidence.field_offset(
                address, size, collector.STATE_BASE, collector.STATE_SIZE, regions), name)

    def test_a_field_straddling_two_regions_is_not_read(self):
        regions = [("a", 0x1000, 0x10), ("b", 0x1010, 0x10)]
        self.assertIsNone(evidence.field_offset(0x100E, 4, 0x0, 0x100, regions))
        self.assertEqual(evidence.field_offset(0x1010, 4, 0x0, 0x100, regions), 0x100 + 0x10)

    def test_kpad_fields_fit_the_port_struct(self):
        for _name, offset, fmt in evidence.KPAD_FIELDS:
            self.assertLessEqual(offset + struct.calcsize(fmt), evidence.PORT_STRIDE)
        ring_end = (evidence.SAMPLE_ARRAY_OFFSET
                    + evidence.SAMPLE_STRIDE * evidence.SAMPLE_COUNT)
        self.assertLessEqual(ring_end, evidence.PORT_STRIDE)

    def test_replay_region_refuses_a_pointer_that_is_not_memory(self):
        self.assertIsNone(evidence.replay_region(0))
        self.assertIsNone(evidence.replay_region(0x12345678))
        self.assertEqual(evidence.replay_region(0x91000000)[0], "replay_state")


class MetadataTests(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(evidence.validate_session_metadata(valid_metadata()), [])

    def test_player_and_remote_are_required_never_defaulted(self):
        payload = valid_metadata()
        del payload["ports"]["1"]["player"]
        payload["ports"]["2"]["remote_label"] = ""
        errors = evidence.validate_session_metadata(payload)
        self.assertTrue(any("ports['1'].player" in e for e in errors))
        self.assertTrue(any("ports['2'].remote_label" in e for e in errors))

    def test_one_remote_cannot_be_two_ports(self):
        payload = valid_metadata()
        payload["ports"]["2"]["remote_label"] = "WHITE"
        self.assertTrue(evidence.validate_session_metadata(payload))

    def test_one_side_cannot_be_two_ports(self):
        payload = valid_metadata()
        payload["ports"]["2"]["expected_capture_side"] = "home"
        self.assertTrue(evidence.validate_session_metadata(payload))

    def test_the_example_file_cannot_be_recorded_as_is(self):
        example = ROOT / "data" / "calibration" / "evidence-session-metadata.example.json"
        with self.assertRaises(evidence.MetadataError) as caught:
            evidence.load_session_metadata(example)
        self.assertIn("placeholder", str(caught.exception))

    def test_control_changes_must_restate_who_holds_the_port(self):
        payload = valid_metadata(control_changes=[{"at": {"inning": 5, "half": "top"}}])
        self.assertTrue(evidence.validate_session_metadata(payload))

    def test_load_fingerprints_the_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "m.json"
            path.write_text(json.dumps(valid_metadata()))
            loaded = evidence.load_session_metadata(path)
        self.assertEqual(len(loaded["sha256"]), 64)
        self.assertEqual(loaded["content"]["ports"]["1"]["player"], "A")


class ControllerSideTests(unittest.TestCase):
    """Port-to-side comes from game memory; person-to-port from metadata only."""

    def test_memory_mapping_follows_the_batting_byte(self):
        # team1 fielding (1) in the top half -> team1 is home.
        self.assertEqual(evidence.side_ports_from_memory(0x00, 0x01, 1, 0),
                         {"away": 2, "home": 1, "basis": "player_type_and_batting_byte"})
        # Same match, bottom half: team1 now batting (0).
        self.assertEqual(evidence.side_ports_from_memory(0x00, 0x01, 0, 1)["home"], 1)

    def test_unreadable_bytes_give_null_not_a_guess(self):
        observed = evidence.side_ports_from_memory(None, 0x01, 1, 0)
        self.assertEqual((observed["away"], observed["home"]), (None, None))
        self.assertEqual(evidence.side_ports_from_memory(0, 1, 7, 0)["basis"], "unrecognised_bytes")

    def test_cpu_is_no_port(self):
        self.assertIsNone(evidence.port_for_player_type(0xFF))
        self.assertEqual(evidence.port_for_player_type(1), 2)

    def test_declared_sides_are_compared_not_overwritten(self):
        content = valid_metadata()
        agrees = evidence.compare_declared_sides(content, {"away": 2, "home": 1})
        self.assertEqual(agrees["status"], "agrees")
        clash = evidence.compare_declared_sides(content, {"away": 1, "home": 2})
        self.assertEqual(clash["status"], "mismatch")
        self.assertEqual(content["ports"]["1"]["expected_capture_side"], "home")
        self.assertEqual(evidence.compare_declared_sides(content, {"away": None, "home": None})["status"],
                         "unobserved")

    def test_remote_mapping_needs_exactly_one_port(self):
        alone = [{1: 0, 2: 0x0800, 3: 0, 4: 0}] * 25
        self.assertEqual(detect_port(alone)["port"], 2)
        both = [{1: 0x0800, 2: 0x0800, 3: 0, 4: 0}] * 25
        self.assertIsNone(detect_port(both))
        other_busy = [{1: 0x0800, 2: 0x0001, 3: 0, 4: 0}] * 25
        self.assertIsNone(detect_port(other_busy))
        too_short = [{1: 0x0800, 2: 0, 3: 0, 4: 0}] * 5
        self.assertIsNone(detect_port(too_short))


class FrameEncodingTests(unittest.TestCase):
    def test_numpy_xor_is_byte_identical_to_the_old_expression(self):
        rng = random.Random(3)
        for size in (1, 17, 40252, 113068):
            a = bytes(rng.getrandbits(8) for _ in range(size))
            b = bytes(rng.getrandbits(8) for _ in range(size))
            self.assertEqual(collector.xor_delta(a, b), bytes(x ^ y for x, y in zip(a, b)))

    def test_frame_timing_records_holes(self):
        timing = collector.FrameTiming()
        for timer in (10, 11, 12, 15, 16, 40, 41, 5):
            timing.note(timer)
        summary = timing.summary()
        self.assertEqual(summary["missed_frames"], 2 + 23)
        self.assertEqual(summary["longest_gap_frames"], 23)
        self.assertEqual(summary["longest_gap_after_timer"], 16)
        self.assertEqual(summary["gaps"], [[12, 2], [16, 23]])
        self.assertEqual(summary["timer_regressions"], 1)

    def test_snapshot_state_never_reads_an_extra_region_as_state(self):
        # A state field placed just past the state block would, with the old
        # len(block) bound, have read the first extra region's bytes.
        base, size = 0x1000, 0x10
        builder = SnapshotBuilder(state_base=base, actors=[], fields=collector.ACTOR_FIELDS,
                                  position_offset=4,
                                  state_fields=[["inside", base + 4, "B"],
                                                ["past_block", base + size + 2, "B"]],
                                  state_size=size)
        block = bytes(range(size)) + b"\xAA" * 8
        state = builder.state(block)
        self.assertEqual(state["inside"], 4)
        self.assertNotIn("past_block", state)


class ProbePolicyTests(unittest.TestCase):
    def block(self, pitches=1, trig=0, acc=1.0):
        regions = list(collector.EXTRA_REGIONS)
        size = evidence.bytes_per_frame(collector.STATE_SIZE, regions)
        data = bytearray(size)
        data[0x900D692C - collector.STATE_BASE] = pitches
        offset = evidence.field_offset(evidence.PORT_BASES[1], 0x20, collector.STATE_BASE,
                                       collector.STATE_SIZE, regions)
        struct.pack_into(">I", data, offset + 4, trig)
        struct.pack_into(">f", data, offset + 0x18, acc)
        return bytes(data), regions

    def test_release_always_gets_a_copy_and_presses_wait_their_turn(self):
        block, regions = self.block()
        policy = collector.EvidenceProbePolicy(regions, collector.STATE_SIZE)
        self.assertIsNone(policy.check(100, block))
        self.assertEqual(policy.check(101, self.block(trig=0x0800)[0]), "button_p1_a")
        self.assertIsNone(policy.check(150, self.block(trig=0x0400)[0]))
        self.assertEqual(policy.check(111, self.block(pitches=2)[0]), "pitch_release")
        self.assertEqual(policy.check(250, self.block(pitches=2, acc=3.0)[0]), "acc_spike_p1")

    def test_copies_are_capped(self):
        block, regions = self.block(trig=0x0800)
        policy = collector.EvidenceProbePolicy(regions, collector.STATE_SIZE)
        policy.requested = policy.MAX_COPIES
        self.assertIsNone(policy.check(10_000, block))


def run_collector(out, *extra, seconds=4, kill_after=None, env_extra=None):
    env = dict(os.environ, PYTHONPATH=os.pathsep.join([str(FAKE_DME), str(SCRIPTS)]),
               TRACKER_MEMORY_PROBE="0", **(env_extra or {}))
    command = [sys.executable, str(SCRIPTS / "collect_player_tracking.py"), "--out", str(out),
               "--max-seconds", str(seconds), *extra]
    process = subprocess.Popen(command, cwd=str(SCRIPTS), env=env, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    lines = []
    ready_at = None
    for line in process.stdout:
        lines.append(line)
        if line.startswith("[capture-ready] ") and ready_at is None:
            ready_at = time.monotonic()
        if kill_after is not None and ready_at and time.monotonic() - ready_at >= kill_after:
            process.kill()
            break
    process.wait(timeout=60)
    process.stdout.close()
    return process.returncode, "".join(lines)


class EndToEndTests(unittest.TestCase):
    """The real collector against the scripted fake match."""

    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.out = Path(cls.folder.name)
        cls.metadata = cls.out / "metadata.json"
        cls.metadata.write_text(json.dumps(valid_metadata()))
        code, cls.log = run_collector(cls.out, "--evidence-profile", "comprehensive",
                                      "--session-metadata", str(cls.metadata), seconds=12)
        assert code == 0, cls.log
        cls.stem = next(str(p.with_suffix("")) for p in cls.out.glob("mario_stadium-*.json"))
        cls.header = json.loads(Path(cls.stem + ".json").read_text())
        cls.summary = extract(cls.stem)
        cls.rows = [json.loads(line) for line in
                    Path(cls.stem + ".evidence.jsonl").read_text().splitlines()]

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def test_header_declares_schema_v3_and_the_metadata(self):
        schema = self.header["capture_schema"]
        self.assertEqual(schema["version"], 3)
        self.assertEqual(schema["profile"], "comprehensive")
        self.assertEqual(schema["session_metadata"]["content"]["ports"]["1"]["player"], "A")
        self.assertEqual(schema["region_overlaps"], [])
        self.assertTrue(self.header["capture_complete"])
        self.assertEqual(self.header["capture_size"], schema["bytes_per_frame"])
        self.assertEqual(self.header["controller_sides_at_start"]["declared_vs_memory"]["status"],
                         "agrees")
        self.assertEqual(self.header["executable_identity"]["disc_id"], "RMBE01")

    def test_every_frame_reads_back_at_full_size(self):
        session = Session(self.stem)
        count = 0
        for frame in session.frames():
            self.assertEqual(len(frame.block), self.header["capture_size"])
            count += 1
        self.assertEqual(count, self.header["frames"])

    def test_every_record_carries_the_shared_clock(self):
        for row in self.rows:
            if row["kind"] in ("session", "summary"):
                continue
            self.assertIsInstance(row["seq"], int, row)
            self.assertIsInstance(row["timer"], int, row)
            self.assertIsInstance(row["elapsed_s"], float, row)

    def test_raw_button_edges_on_both_ports_independently(self):
        edges = [row for row in self.rows if row["kind"] == "button_edge"]
        port1 = {row["timer"] for row in edges if row["port"] == 1 and "a" in row["pressed"]}
        port2 = {row["timer"] for row in edges if row["port"] == 2 and "b" in row["pressed"]}
        self.assertTrue(port1 - port2)
        self.assertTrue(port2 - port1)
        # A release is an attempt's end, recorded even with no animation behind it.
        self.assertTrue(any(row["released"] for row in edges))
        self.assertTrue(all(row["port_role"]["basis"] == "player_type_and_batting_byte"
                            for row in edges))

    def test_pitch_windows_are_pre_release_and_carry_no_outcome(self):
        windows = [row for row in self.rows if row["kind"] == "pitch_window"]
        self.assertTrue(windows)
        for row in windows:
            self.assertEqual(row["timer"], row["release_timer"])
            self.assertFalse(OUTCOME_KEYS & set(keys_anywhere(row)), row)
            for port in row["inputs_by_port"].values():
                for press in port["press_edges"]:
                    self.assertGreaterEqual(press["frames_before_release"], 0)

    def test_no_record_is_a_label_or_a_star_flag(self):
        for row in self.rows:
            self.assertFalse({"is_star_pitch", "swing_mode", "detected_swing_mode",
                              "star_pitch"} & set(keys_anywhere(row)), row["kind"])

    def test_meter_changes_keep_before_and_after(self):
        changes = [row for row in self.rows if row["kind"] == "star_meter_change"]
        self.assertTrue(changes)
        for row in changes:
            self.assertEqual(row["after"] - row["before"], row["delta"])
            self.assertIn(row["side_role"], ("batting", "fielding"))

    def test_unnamed_inputs_stay_unobserved(self):
        availability = self.rows[0]["availability"]
        self.assertEqual(availability["pitch_charge"], "unobserved")
        self.assertEqual(availability["pitch_aim_target"], "unobserved")
        self.assertEqual(availability["independent_batter_timing"], "unobserved")
        self.assertEqual(availability["physical_player_identity"], "declared_in_session_metadata")


class RefusalAndCrashTests(unittest.TestCase):
    def test_comprehensive_without_metadata_refuses_before_recording(self):
        with tempfile.TemporaryDirectory() as folder:
            code, log = run_collector(folder, "--evidence-profile", "comprehensive", seconds=2)
            self.assertNotEqual(code, 0)
            self.assertIn("session-metadata", log)
            self.assertFalse(list(Path(folder).glob("*.bin")))

    def test_invalid_metadata_refuses_before_recording(self):
        with tempfile.TemporaryDirectory() as folder:
            bad = Path(folder) / "bad.json"
            bad.write_text(json.dumps(valid_metadata(ports={"1": {"player": "A"}})))
            code, log = run_collector(folder, "--evidence-profile", "comprehensive",
                                      "--session-metadata", str(bad), seconds=2)
            self.assertNotEqual(code, 0)
            self.assertIn("remote_label", log)
            self.assertFalse(list(Path(folder).glob("*.bin")))

    def test_a_killed_collector_leaves_readable_frames(self):
        with tempfile.TemporaryDirectory() as folder:
            metadata = Path(folder) / "m.json"
            metadata.write_text(json.dumps(valid_metadata()))
            run_collector(folder, "--evidence-profile", "comprehensive",
                          "--session-metadata", str(metadata), seconds=60, kill_after=5)
            stem = next(str(p.with_suffix("")) for p in Path(folder).glob("mario_stadium-*.json"))
            header = json.loads(Path(stem + ".json").read_text())
            self.assertFalse(header["capture_complete"])
            frames = sum(1 for _ in Session(stem).frames())
            # Everything up to the last sync flush survives the kill.
            self.assertGreater(frames, int((5 - collector.SYNC_FLUSH_SECONDS) * 55))

    def test_standard_profile_is_unchanged_without_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            code, log = run_collector(folder, seconds=2)
            self.assertEqual(code, 0, log)
            stem = next(str(p.with_suffix("")) for p in Path(folder).glob("mario_stadium-*.json"))
            header = json.loads(Path(stem + ".json").read_text())
        self.assertEqual(header["capture_size"], collector.CAPTURE_SIZE)
        self.assertEqual(header["capture_schema"]["profile"], "standard")
        self.assertIsNone(header["capture_schema"]["session_metadata"])


def write_v2_capture(stem: Path, *, state_base, state_size, extra_regions, frames):
    """A capture in the pre-schema layout, written the way the collector wrote it."""
    header = {
        "format": "MSSTRK02", "park": "mario_stadium", "state_base": state_base,
        "state_size": state_size, "extra_regions": [list(r) for r in extra_regions],
        "capture_size": state_size + sum(size for _, _, size in extra_regions),
        "actor_fields": {}, "frames": len(frames),
        "state_fields": [[n, a, f] for n, a, f in collector.STATE_FIELDS
                         if state_base <= a < state_base + state_size],
        "actors": {"fielders": [], "offense": []},
    }
    stem.with_suffix(".json").write_text(json.dumps(header))
    compressor = zlib.compressobj(6)
    previous = bytes(header["capture_size"])
    with stem.with_suffix(".bin").open("wb") as sink:
        sink.write(FRAME_MAGIC)
        for index, block in enumerate(frames):
            delta = bytes(a ^ b for a, b in zip(block, previous))
            previous = block
            record = (struct.pack(">IdI", 5000 + index, index / 60, 0)
                      + struct.pack(">fff", 0, 0, 0) + bytes(36) + delta)
            sink.write(compressor.compress(struct.pack(">I", len(record)) + record))
        sink.write(compressor.flush())


class OldSessionTests(unittest.TestCase):
    def test_pre_remote_capture_reports_unobserved_not_zero(self):
        base, size = 0x900D5000, 0x900DBD40 - 0x900D5000
        frames = []
        for index in range(40):
            block = bytearray(size)
            block[0x900D692C - base] = 1 + index // 20        # one pitch release
            block[0x900D5C28 - base] = 1
            frames.append(bytes(block))
        with tempfile.TemporaryDirectory() as folder:
            stem = Path(folder) / "mario_stadium-20260901T000000Z"
            write_v2_capture(stem, state_base=base, state_size=size, extra_regions=[],
                             frames=frames)
            summary = extract(stem)
            rows = [json.loads(line) for line in stem.with_suffix(".evidence.jsonl").read_text().splitlines()]
        self.assertEqual(summary["frames"], 40)
        self.assertEqual(summary["ports_recorded"], [])
        self.assertIsNone(summary["star_meter_change_count"])
        session = rows[0]
        self.assertEqual(session["capture_schema_version"], 2)
        self.assertEqual(session["availability"]["star_meters"], "unobserved")
        self.assertEqual(session["availability"]["controller_input"], {})
        window = next(row for row in rows if row["kind"] == "pitch_window")
        self.assertIsNone(window["star_meters_before_release"])
        self.assertIsNone(window["inputs_by_port"])

    def test_remote_capture_without_meters_keeps_meters_null(self):
        base, size = 0x900D5000, 0x900DBD40 - 0x900D5000
        regions = [("wiimote_1_input", evidence.PORT_BASES[1], evidence.PORT_STRIDE),
                   ("wiimote_2_input", evidence.PORT_BASES[2], evidence.PORT_STRIDE)]
        frames = []
        for index in range(30):
            block = bytearray(size + 2 * evidence.PORT_STRIDE)
            if 10 <= index < 15:
                struct.pack_into(">I", block, size, 0x0800)   # port 1 holds A
            frames.append(bytes(block))
        with tempfile.TemporaryDirectory() as folder:
            stem = Path(folder) / "mario_stadium-20260924T000000Z"
            write_v2_capture(stem, state_base=base, state_size=size, extra_regions=regions,
                             frames=frames)
            summary = extract(stem)
            rows = [json.loads(line) for line in stem.with_suffix(".evidence.jsonl").read_text().splitlines()]
        self.assertEqual(summary["ports_recorded"], [1, 2])
        self.assertIsNone(summary["star_meter_change_count"])
        edges = [row for row in rows if row["kind"] == "button_edge"]
        self.assertEqual([(row["port"], row["pressed"], row["released"]) for row in edges],
                         [(1, ["a"], []), (1, [], ["a"])])
        # No memory mapping in a v2 capture: the role is unknown, not guessed.
        self.assertEqual(edges[0]["port_role"]["side"], None)


class NoDatabaseTests(unittest.TestCase):
    CAPTURE_PATH = ("collect_player_tracking.py", "capture_evidence_schema.py",
                    "extract_input_evidence.py", "evidence_preflight.py",
                    "memory_probe.py", "player_tracking_io.py")

    def test_capture_path_imports_no_database_or_network_client(self):
        forbidden = ("supabase", "requests", "urllib", "http", "socket", "psycopg")
        for name in self.CAPTURE_PATH:
            for line in (SCRIPTS / name).read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped.startswith(("import ", "from ")):
                    module = stripped.split()[1].split(".")[0].lower()
                    self.assertNotIn(module, forbidden, f"{name}: {stripped}")


if __name__ == "__main__":
    unittest.main()
