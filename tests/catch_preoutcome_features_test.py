import math
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from export_catch_preoutcome_features import FPS, WINDOW_FRAMES, project  # noqa: E402


class CatchPreOutcomeProjectionTests(unittest.TestCase):
    def samples(self):
        rows = []
        # Exact synthetic flight: linear x/z and y = 1.5 + 8t - 5t^2.
        for frame in range(WINDOW_FRAMES):
            t = frame / FPS
            rows.append((1000 + frame, (2 + 3 * t, 1.5 + 8 * t - 5 * t * t, -4 - 10 * t)))
        return rows

    def test_fixed_window_projection_is_deterministic(self):
        first, reason = project(self.samples())
        second, second_reason = project(self.samples())
        self.assertIsNone(reason)
        self.assertIsNone(second_reason)
        self.assertEqual(first, second)
        expected_time = (8 + math.sqrt(64 + 30)) / 10
        self.assertAlmostEqual(first["projected_landing_seconds"], expected_time, places=5)
        self.assertAlmostEqual(first["projected_endpoint_x_units"], 2 + 3 * expected_time, places=5)
        self.assertAlmostEqual(first["projected_endpoint_z_units"], -4 - 10 * expected_time, places=5)

    def test_incomplete_or_nonconsecutive_window_is_rejected(self):
        self.assertEqual(project(self.samples()[:-1]), (None, "incomplete_fixed_window"))
        broken = self.samples()
        broken[5] = (broken[5][0] + 1, broken[5][1])
        self.assertEqual(project(broken), (None, "nonconsecutive_fixed_window"))


if __name__ == "__main__":
    unittest.main()
