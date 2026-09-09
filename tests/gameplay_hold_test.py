"""Holding the opening play, tested without an emulator.

WHAT WAS WRONG. autoteam signalled the pitch reset and the bridge then started
the collector, waited up to thirty seconds for recording evidence, and only
afterwards started the scoring executable -- with a live game running underneath
the whole sequence. The existing test proved collector-before-executable, which
is an ordering between two processes and not a claim about the GAME.

WHAT IS TESTED HERE. The one process that owns the controller ports pausing at
the reset, waiting for the readers, and resuming; and every way that can end.
The two presses are a fake driver, the clock and the sleep are injected, and
nothing here touches Dolphin -- which is exactly why
docs/tracker-real-game-validation.md keeps the real-game step for it.
"""
import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import mss_autoteam  # noqa: E402
from mss_autoteam import (  # noqa: E402
    GAMEPLAY_HELD_MARKER,
    GAMEPLAY_RESUMED_MARKER,
    hold_opening_play,
)


class FakeDriver:
    def __init__(self, fail_on=()):
        self.presses = []
        self.fail_on = set(fail_on)

    def press_plus(self):
        index = len(self.presses)
        self.presses.append("plus")
        if index in self.fail_on:
            raise RuntimeError(f"press {index} failed")


class FakeSuppress:
    """Stands in for FlagSuppress, which writes a Gecko flag through DME."""

    entered = 0

    def __init__(self, dme, store=None):
        self.dme = dme
        self.store = store

    def __enter__(self):
        FakeSuppress.entered += 1
        return self

    def __exit__(self, *exc):
        return False


class Clock:
    """A perf_counter that only moves when something waits on it."""

    def __init__(self, step=0.25):
        self.now = 0.0
        self.step = step

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class GameplayHoldTests(unittest.TestCase):
    def setUp(self):
        self._suppress = mss_autoteam.FlagSuppress
        mss_autoteam.FlagSuppress = FakeSuppress
        FakeSuppress.entered = 0
        self.addCleanup(self._restore)

    def _restore(self):
        mss_autoteam.FlagSuppress = self._suppress

    def run_hold(self, ready_path, *, timeout=45.0, driver=None, ready_after=None,
                 handshake='{"status": "ready", "collectorAttached": true}'):
        """Run one hold, optionally publishing the handshake mid-wait."""
        driver = driver or FakeDriver()
        clock = Clock()
        created = {"done": False}

        def sleep(seconds):
            clock.sleep(seconds)
            if ready_after is not None and not created["done"] and clock.now >= ready_after:
                Path(ready_path).write_text(handshake)
                created["done"] = True

        out = io.StringIO()
        with redirect_stdout(out):
            reason = hold_opening_play(object(), driver, ready_path, timeout=timeout,
                                       interval=0.25, now=clock, sleep=sleep)
        return reason, out.getvalue(), driver, clock

    def test_holds_until_the_readers_are_up_then_resumes(self):
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            reason, printed, driver, clock = self.run_hold(str(ready), ready_after=3.0)

        self.assertEqual(reason, "readers_ready")
        self.assertEqual(driver.presses, ["plus", "plus"], "pause, then resume")
        self.assertIn(f"{GAMEPLAY_HELD_MARKER} paused", printed)
        self.assertIn(f"{GAMEPLAY_RESUMED_MARKER} readers_ready", printed)
        # The hold really waited: gameplay was stopped for the whole startup,
        # which is the entire point.
        self.assertGreaterEqual(clock.now, 3.0)
        self.assertEqual(FakeSuppress.entered, 2,
                         "each press takes the input word for a moment, not the whole hold")

    def test_a_collector_that_never_starts_resumes_on_the_timeout(self):
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            reason, printed, driver, clock = self.run_hold(str(ready), timeout=5.0)

        self.assertEqual(reason, "timeout")
        self.assertEqual(driver.presses, ["plus", "plus"],
                         "a hold that could strand a paused game would be worse than the delay")
        self.assertIn(f"{GAMEPLAY_RESUMED_MARKER} timeout", printed)
        self.assertIn("may not be captured", printed)
        self.assertGreaterEqual(clock.now, 5.0)

    def test_a_delayed_collector_is_waited_for_rather_than_raced(self):
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            reason, printed, _driver, clock = self.run_hold(str(ready), timeout=30.0,
                                                            ready_after=12.0)
        self.assertEqual(reason, "readers_ready")
        self.assertGreaterEqual(clock.now, 12.0)
        self.assertIn("both readers up after", printed)

    def test_a_scoring_reader_that_did_not_start_is_not_read_as_ready(self):
        """The reproduction, in the controller's own terms.

        The bridge writes this file whatever happens, so its EXISTENCE says
        only that the bridge got as far as answering. `status` is the answer,
        and `failed` means nothing is going to score the game that is about to
        be played.
        """
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            reason, printed, driver, clock = self.run_hold(
                str(ready), ready_after=2.0,
                handshake='{"status": "failed", "trackerStarted": false, '
                          '"scoringReader": "spawn_failed", '
                          '"scoringReason": "the tracker could not be started: spawn ENOENT"}')

        self.assertEqual(reason, "readers_failed")
        self.assertEqual(driver.presses, ["plus", "plus"],
                         "resumed anyway -- a paused match is not a recovery")
        self.assertIn(f"{GAMEPLAY_RESUMED_MARKER} readers_failed", printed)
        self.assertIn("NOTHING WILL SCORE", printed)
        self.assertIn("spawn ENOENT", printed)

    def test_a_running_but_unconfirmed_reader_resumes_and_says_which_it_was(self):
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            reason, printed, _driver, _clock = self.run_hold(
                str(ready), ready_after=2.0,
                handshake='{"status": "unconfirmed", "trackerStarted": true, '
                          '"scoringReader": "timeout", '
                          '"scoringReason": "the tracker did not report attaching to Dolphin"}')

        # Running and unproven: there is nothing left for the hold to wait for,
        # because the bridge has already stopped waiting too.
        self.assertEqual(reason, "readers_ready")
        self.assertIn("has not confirmed it attached", printed)
        self.assertNotIn("both readers up after", printed)

    def test_a_half_written_handshake_is_waited_out_rather_than_believed(self):
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            reason, printed, _driver, clock = self.run_hold(
                str(ready), timeout=5.0, ready_after=1.0, handshake='{"status": "rea')

        self.assertEqual(reason, "timeout")
        self.assertIn("no readers handshake", printed)
        self.assertGreaterEqual(clock.now, 5.0)

    def test_a_handshake_from_an_older_bridge_still_means_both_readers_up(self):
        """A file with no `status` was written by a bridge that only ever wrote
        it to mean "up". Reading that as a failure would hold every game
        launched against one."""
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            reason, printed, _driver, _clock = self.run_hold(
                str(ready), ready_after=1.0,
                handshake='{"collectorAttached": true, "trackerStarted": true}')

        self.assertEqual(reason, "readers_ready")
        self.assertIn("both readers up after", printed)

    def test_a_pause_that_cannot_be_pressed_says_so_instead_of_pretending(self):
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            driver = FakeDriver(fail_on=(0,))
            reason, printed, driver, clock = self.run_hold(str(ready), driver=driver)

        self.assertEqual(reason, "not_held")
        self.assertEqual(clock.now, 0.0, "nothing is waited for when nothing was held")
        self.assertIn(f"{GAMEPLAY_RESUMED_MARKER} not_held", printed)
        self.assertIn("could not hold gameplay", printed)

    def test_a_resume_that_fails_is_shouted_about_rather_than_swallowed(self):
        with TemporaryDirectory() as directory:
            ready = Path(directory) / "run.live.readers"
            driver = FakeDriver(fail_on=(1,))
            reason, printed, _driver, _clock = self.run_hold(str(ready), ready_after=1.0)
            reason, printed, driver, _clock = self.run_hold(
                str(ready), driver=driver, ready_after=1.0)

        self.assertEqual(reason, "readers_ready")
        self.assertIn("could not resume gameplay", printed)
        self.assertIn("Press + on", printed, "a person has to be told the game is paused")

    def test_no_ready_path_is_reported_as_not_held(self):
        out = io.StringIO()
        driver = FakeDriver()
        with redirect_stdout(out):
            reason = hold_opening_play(object(), driver, None)
        self.assertEqual(reason, "not_held")
        self.assertEqual(driver.presses, [])
        self.assertIn(f"{GAMEPLAY_RESUMED_MARKER} not_held", out.getvalue())


if __name__ == "__main__":
    unittest.main()
