"""The collector's recording evidence, tested without an emulator.

The whole point of the line this builds is that it is *evidence*: a pid exists
before python has imported anything and "[live-status] recording" is printed
before the capture loop reads a frame. Only a frame count off a running game
clock plus a byte count off the finished file says a capture exists, so both
halves are required and the failing half has to be named.
"""
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from collect_player_tracking import (  # noqa: E402
    CAPTURE_READY_MARKER,
    capture_ready_payload,
)


class _Live:
    calibration_status = "confirmed"


class CaptureReadyPayloadTests(unittest.TestCase):
    def payload(self, **overrides):
        base = dict(
            frames=30, missed_frames=0, bytes_on_disk=8412, elapsed_s=0.5231,
            stem="data/player_tracking/wario_stadium-20260908T000000Z",
            park="wario_stadium", timer=91234, live=_Live(),
        )
        base.update(overrides)
        return capture_ready_payload(**base)

    def test_frames_and_bytes_together_are_readiness(self):
        payload = self.payload()
        self.assertTrue(payload["ready"])
        self.assertNotIn("reason", payload)
        self.assertEqual(payload["frames"], 30)
        self.assertEqual(payload["bytes_on_disk"], 8412)
        self.assertEqual(payload["elapsed_s"], 0.523)
        self.assertEqual(payload["calibration_status"], "confirmed")
        self.assertEqual(payload["game_timer"], 91234)

    def test_frames_with_nothing_on_disk_is_not_readiness(self):
        payload = self.payload(bytes_on_disk=0)
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["reason"], "no bytes written to the capture file")

    def test_no_frames_is_not_readiness(self):
        payload = self.payload(frames=0)
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["reason"], "no frames sampled")

    def test_a_capture_with_no_live_derivation_still_reports(self):
        payload = self.payload(live=None)
        self.assertTrue(payload["ready"])
        self.assertEqual(payload["calibration_status"], "disabled")

    def test_the_marker_is_the_contract_with_the_javascript_reader(self):
        # tracker_collector_feed.mjs slices exactly this prefix off.
        self.assertEqual(CAPTURE_READY_MARKER, "[capture-ready] ")


if __name__ == "__main__":
    unittest.main()
