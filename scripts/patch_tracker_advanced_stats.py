"""Add experimental ball-coordinate, pitch-flight, and contact-metric feeds.

This patch follows the confirmed ball pointer on every tracker update, records
only changed coordinates, and logs a short sample window around the tracker's
existing ``ball_was_hit`` transition. It also reports one explicitly provisional
exit speed, launch angle, and spray direction by discarding the
contact-to-first-batted-sample jump and averaging the next two movement
vectors. It also uses the tracker's authoritative first-fair transition to arm
a rolling three-sample downward-to-upward coordinate reversal, recording the
physical landing point while excluding caught and foul balls. It records the
authoritative catch point for caught balls, and reports horizontal
contact-to-endpoint distance using the locked 3-feet-per-unit convention
(see FEET_PER_UNIT in _refresh_game_values).
Once a contact resolves, it also emits one combined batted-ball record so
downstream consumers do not need to join separate metric lines themselves.
For fair and caught contacts that record also includes provisional hang time
from the continuous monotonic clock. The changed-coordinate update count is
retained as a separate diagnostic because the game can advance the batted ball
through a contact transition without exposing every intermediate coordinate.

Run this script with Python 3.13 (the bytecode version used by the tracker):

    python scripts/patch_tracker_advanced_stats.py INPUT.exe OUTPUT.exe
    python scripts/verify_tracker_build.py OUTPUT.exe

The destination must not already exist. A previously patched advanced-stat
tracker can be used as input; the rebuilt stat_tracker entry retains the
lineup, batted-ball, fielding, and diagnostic pitch feeds.

Always run the verify step before testing a new build. It compares the code
objects actually embedded in the executable against what this file compiles to
right now, which is the only check that distinguishes a real rebuild from one
that silently carried old logic forward.
"""

from __future__ import annotations

import argparse
import marshal
import os
import struct
import zlib
from pathlib import Path
from types import CodeType

from patch_tracker_lineup_feed import (
    BATTING_MARKER,
    COOKIE_FORMAT,
    COOKIE_LENGTH,
    COOKIE_MAGIC,
    LINEUP_MARKER,
    TARGET_ENTRY,
    encode_toc_entry,
    parse_toc,
    replace_nested_code,
)


TARGET_FUNCTIONS = {
    "_refresh_game_values",
    "_check_if_ball_was_hit",
    "_check_for_star_pitch_usage",
}
POINTER_MARKER = "[TRACKER_BALL_POINTER]"
SAMPLE_MARKER = "[TRACKER_BALL_SAMPLE]"
CONTACT_MARKER = "[TRACKER_BALL_CONTACT]"
WINDOW_MARKER = "[TRACKER_BALL_CONTACT_WINDOW]"
EXIT_SPEED_MARKER = "[TRACKER_EXIT_SPEED_PROVISIONAL]"
LAUNCH_ANGLE_MARKER = "[TRACKER_LAUNCH_ANGLE_PROVISIONAL]"
SPRAY_DIRECTION_MARKER = "[TRACKER_SPRAY_DIRECTION_PROVISIONAL]"
LANDING_MARKER = "[TRACKER_LANDING_PROVISIONAL]"
LANDING_DISTANCE_MARKER = "[TRACKER_LANDING_DISTANCE_PROVISIONAL]"
CATCH_MARKER = "[TRACKER_CATCH_PROVISIONAL]"
CATCH_DISTANCE_MARKER = "[TRACKER_CATCH_DISTANCE_PROVISIONAL]"
BATTED_BALL_MARKER = "[TRACKER_BATTED_BALL_PROVISIONAL]"
BATTED_BALL_ABANDONED_MARKER = "[TRACKER_BATTED_BALL_ABANDONED]"
BALL_FEED_MARKER = "[TRACKER_BALL_FEED]"
FIELDED_BALL_MARKER = "[TRACKER_BALL_FIELDED_PROVISIONAL]"
PITCH_MARKER = "[TRACKER_PITCH_PROVISIONAL]"
PITCH_CLASSIFIER_MARKER = "classifier=movement_v1"
PATCH_MARKERS = {
    BATTING_MARKER,
    LINEUP_MARKER,
    POINTER_MARKER,
    SAMPLE_MARKER,
    CONTACT_MARKER,
    WINDOW_MARKER,
    EXIT_SPEED_MARKER,
    LAUNCH_ANGLE_MARKER,
    SPRAY_DIRECTION_MARKER,
    LANDING_MARKER,
    LANDING_DISTANCE_MARKER,
    CATCH_MARKER,
    CATCH_DISTANCE_MARKER,
    BATTED_BALL_MARKER,
    BATTED_BALL_ABANDONED_MARKER,
    BALL_FEED_MARKER,
    FIELDED_BALL_MARKER,
    PITCH_MARKER,
    PITCH_CLASSIFIER_MARKER,
}


def code_contains_marker(code: CodeType, marker: str) -> bool:
    for item in code.co_consts:
        if isinstance(item, str) and marker in item:
            return True
        if isinstance(item, CodeType) and code_contains_marker(item, marker):
            return True
    return False


def compile_replacements() -> dict[str, CodeType]:
    source = r'''
def _refresh_game_values(game, team1, team2):
    # Game world units -> feet, derived rather than assumed.
    #
    # The infield was measured directly: a character carrying the ball was
    # stood on home, first, second, third and the rubber, 17-28 times each and
    # approached from varied directions so the ball's offset in their hands
    # averaged out (see scripts/fit_infield_scale.py). Fitting a regulation
    # infield to those 103 holds gives a base path of 26.840 units with an RMS
    # residual of 0.186u (0.62 ft) -- and, as a blind test, places the rubber
    # at 60.29 ft against a regulation 60.50 ft, having taken no part in the
    # fit. That 0.4% agreement establishes the infield has regulation
    # PROPORTIONS.
    #
    # It does NOT establish regulation SIZE: a 70-foot infield with the rubber
    # scaled to match would fit identically. No object in this game has a known
    # real-world size, so that ambiguity cannot be resolved from inside it. The
    # 90 feet below is therefore the one genuine assumption in the chain, kept
    # as its own named value so it stays visible and swappable rather than
    # dissolved into a magic constant. It rests on parsimony: a developer who
    # reproduces regulation proportions to 0.4% near-certainly used regulation
    # numbers.
    #
    # Rankings, park factors, spray-chart positions and every player-vs-player
    # comparison are invariant to this value; only absolute printed numbers
    # move. If a real in-game distance readout ever turns up, change
    # BASE_PATH_FEET and everything downstream follows.
    #
    # Kept as function-locals: compile_replacements() extracts only function
    # code objects by name, so module-level constants in this injected source
    # would not exist in the patched executable's namespace at runtime.
    BASE_PATH_UNITS = 26.840  # measured
    BASE_PATH_FEET = 90.0     # assumed (regulation)
    FEET_PER_UNIT = BASE_PATH_FEET / BASE_PATH_UNITS  # 3.3531

    game.current_batter.index.refresh()
    game.current_batter.refresh_all()
    game.current_pitcher.refresh_all()
    team1.pitching_index.refresh()
    team2.pitching_index.refresh()
    team1.meter.refresh()
    team2.meter.refresh()
    game.outs.refresh()
    game.balls.refresh()
    game.strikes.refresh()
    game.current_inning.refresh()
    game.pitches.refresh()
    team1.score.refresh()
    team2.score.refresh()
    game.ball_was_hit.refresh()
    game.batters_this_inning.refresh()
    game.ball_possession.refresh_all()
    game.this_pitch.refresh_all()
    game.star_costs.refresh_all()
    game.left_field_buddy_jump_flag.refresh()
    game.center_field_buddy_jump_flag.refresh()
    game.right_field_buddy_jump_flag.refresh()
    game.left_field_airborne_flag.refresh()
    game.center_field_airborne_flag.refresh()
    game.right_field_airborne_flag.refresh()
    game.baserunners.refresh_all()
    game.home_run_flag.refresh()
    game.game_state.refresh()

    # The pointer at 0x80795310 can be null before the pitch. Resolve it on
    # every update instead of using Field.from_pointer(), which resolves only
    # once during construction. Reading all three floats in one 12-byte block
    # also keeps X/Y/Z from three separate pointer resolutions.
    sample_state = globals().setdefault(
        "_tracker_ball_sample_state",
        {
            "valid": None,
            "pointer": None,
            "last_coordinates": None,
            "sequence": 0,
            "samples": [],
            "post_remaining": 0,
            "post_index": 0,
            "post_samples": [],
            "exit_speed_emitted": False,
            "landing_tracking": False,
            "landing_recent_samples": [],
            "contact_sample": None,
            "batted_ball_metrics": None,
            "batted_ball_endpoint": None,
            "combined_emitted": False,
            "fielded_emitted": False,
            "flight_samples": [],
            "feed_stalled": False,
            "feed_last_change_ns": None,
            "coordinate_offset": None,
            "uncalibrated_reported": False,
            "batter_name": None,
            "pitcher_name": None,
            "pitch_last_counter": None,
            "pitch_last_balls": None,
            "pitch_last_strikes": None,
            "pitch_armed": False,
            "pitch_active": False,
            "pitch_samples": [],
            "pitch_terminal": None,
            "pitch_counter": None,
            "pitch_balls_before": None,
            "pitch_strikes_before": None,
            "pitch_batter_name": None,
            "pitch_pitcher_name": None,
            "pitch_is_star": False,
            "pitch_start_state": None,
        },
    )

    # A pitch is armed only by the game's own per-at-bat pitch counter while
    # the game is in BATTING. The first subsequent changed coordinate moving
    # from mound toward plate (+Z in the observed coordinate system) starts
    # the measured window. This excludes post-contact play and ordinary
    # fielding throws without assigning an ordinary pitch type.
    def emit_pitch_diagnostic(terminal):
        pitch_samples = list(sample_state.get("pitch_samples", []))
        if len(pitch_samples) >= 2:
            first = pitch_samples[0]
            last = pitch_samples[-1]
            elapsed_seconds = (last[1] - first[1]) / 1000000000
            path_units = 0.0
            for before, after in zip(pitch_samples, pitch_samples[1:]):
                step_x = after[3] - before[3]
                step_y = after[4] - before[4]
                step_z = after[5] - before[5]
                path_units += (
                    step_x * step_x + step_y * step_y + step_z * step_z
                ) ** 0.5
            direct_x = last[3] - first[3]
            direct_y = last[4] - first[4]
            direct_z = last[5] - first[5]
            direct_units = (
                direct_x * direct_x + direct_y * direct_y + direct_z * direct_z
            ) ** 0.5
            speed_mph = None
            if elapsed_seconds > 0:
                speed_mph = path_units * FEET_PER_UNIT / elapsed_seconds / 1.4666667

            # Shape is reported as measured deviation from the straight chord
            # between the start and end, parameterized by forward Z progress.
            horizontal_deviation = 0.0
            vertical_deviation = 0.0
            if abs(direct_z) > 0.000001:
                for item in pitch_samples[1:-1]:
                    progress = (item[5] - first[5]) / direct_z
                    expected_x = first[3] + direct_x * progress
                    expected_y = first[4] + direct_y * progress
                    item_horizontal = item[3] - expected_x
                    item_vertical = item[4] - expected_y
                    if abs(item_horizontal) > abs(horizontal_deviation):
                        horizontal_deviation = item_horizontal
                    if abs(item_vertical) > abs(vertical_deviation):
                        vertical_deviation = item_vertical

            # Movement classifier v1 is based on two repeated, labeled Mario
            # test sequences. Ordinary fastballs were nearly straight
            # (about 0.01 horizontal / 0.03 vertical chord deviation), charged
            # and uncharged curves had at least 0.25 horizontal deviation in
            # either direction, and changeups had about 3.38 vertical
            # deviation. Stay unresolved for star pitches and abbreviated
            # flights, and keep the cutoffs well inside the observed gaps.
            # The flight-completeness gate uses direct_units (the true 3D
            # straight-line distance) rather than direct_z (forward-only),
            # because steep changeups legitimately spend much of their travel
            # on the vertical axis and would otherwise be under-measured by a
            # forward-only distance despite a full, complete flight.
            pitch_type = "unresolved"
            classifier_status = "insufficient_flight"
            if sample_state.get("pitch_is_star"):
                classifier_status = "star_pitch_excluded"
            elif len(pitch_samples) >= 20 and direct_units >= 12:
                if abs(vertical_deviation) >= 1.0:
                    pitch_type = "changeup"
                elif abs(horizontal_deviation) >= 0.15:
                    pitch_type = "curveball"
                else:
                    pitch_type = "fastball"
                classifier_status = "classified"

            horizontal_values = [item[3] for item in pitch_samples]
            vertical_values = [item[4] for item in pitch_samples]
            sample_text = ";".join(
                f"{item[0]},{item[1]},{item[3]:.9g},{item[4]:.9g},{item[5]:.9g}"
                for item in pitch_samples
            )
            speed_text = "none" if speed_mph is None else f"{speed_mph:.1f}"
            current_balls = game.balls.value
            current_strikes = game.strikes.value
            log.debug(
                "[TRACKER_PITCH_PROVISIONAL]"
                f" version=1|status=measured|pitch_type={pitch_type}"
                "|classifier=movement_v1"
                f"|classifier_status={classifier_status}"
                "|changeup_vertical_threshold_units=1"
                "|curve_horizontal_threshold_units=0.15"
                "|minimum_samples=20|minimum_direct_distance_units=12"
                f"|terminal={terminal}"
                f"|pitch_counter={sample_state.get('pitch_counter')}"
                f"|pitcher={sample_state.get('pitch_pitcher_name') or 'unknown'}"
                f"|batter={sample_state.get('pitch_batter_name') or 'unknown'}"
                f"|is_star_pitch={'true' if sample_state.get('pitch_is_star') else 'false'}"
                f"|game_state_start={sample_state.get('pitch_start_state') or 'unknown'}"
                f"|count_before={sample_state.get('pitch_balls_before')}-{sample_state.get('pitch_strikes_before')}"
                f"|count_after={current_balls}-{current_strikes}"
                "|start_reason=pitch_counter_increment+forward_z"
                f"|start_seq={first[0]}|end_seq={last[0]}"
                f"|start_time_ns={first[1]}|end_time_ns={last[1]}"
                f"|start_x={first[3]:.9g}|start_y={first[4]:.9g}|start_z={first[5]:.9g}"
                f"|end_x={last[3]:.9g}|end_y={last[4]:.9g}|end_z={last[5]:.9g}"
                f"|sample_count={len(pitch_samples)}"
                f"|elapsed_seconds={elapsed_seconds:.6f}"
                f"|path_distance_units={path_units:.9g}"
                f"|path_distance_feet={path_units * FEET_PER_UNIT:.3f}"
                f"|direct_distance_units={direct_units:.9g}"
                f"|speed_mph={speed_text}"
                f"|horizontal_delta_units={direct_x:.9g}"
                f"|vertical_delta_units={direct_y:.9g}"
                f"|forward_delta_units={direct_z:.9g}"
                f"|horizontal_range_units={max(horizontal_values) - min(horizontal_values):.9g}"
                f"|vertical_range_units={max(vertical_values) - min(vertical_values):.9g}"
                f"|horizontal_chord_deviation_units={horizontal_deviation:.9g}"
                f"|vertical_chord_deviation_units={vertical_deviation:.9g}"
                f"|feet_per_unit={FEET_PER_UNIT:.4f}|timing_source=perf_counter_ns"
                "|samples_format=seq,time_ns,x,y,z"
                f"|samples={sample_text}"
            )
        else:
            log.debug(
                "[TRACKER_PITCH_PROVISIONAL]"
                " version=1|status=insufficient_samples|pitch_type=unresolved"
                f"|terminal={terminal}"
                f"|pitch_counter={sample_state.get('pitch_counter')}"
                f"|pitcher={sample_state.get('pitch_pitcher_name') or 'unknown'}"
                f"|batter={sample_state.get('pitch_batter_name') or 'unknown'}"
                f"|is_star_pitch={'true' if sample_state.get('pitch_is_star') else 'false'}"
                f"|sample_count={len(pitch_samples)}"
            )
        sample_state["pitch_active"] = False
        sample_state["pitch_armed"] = False
        sample_state["pitch_samples"] = []
        sample_state["pitch_terminal"] = None

    # Exit speed/launch angle/spray direction are known within a few samples
    # of contact, independent of where the ball ends up. The endpoint
    # (landing/catch coordinates, distance, hang time) instead depends on the
    # game's own fair_or_foul state reaching a terminal value, which never
    # happens for a ball hit deep enough to leave tracked play (e.g. a home
    # run that transitions straight into its cutscene). Without this, that
    # contact's record would simply never be emitted, silently losing exit
    # speed/launch angle/spray direction that were already known. Emitting a
    # best-effort record with endpoint=unresolved (called once the next pitch
    # starts, so the previous contact's fate is conclusively decided either
    # way) preserves that partial signal for the bridge to work with instead.
    def emit_batted_ball_diagnostic(reason):
        metrics = sample_state.get("batted_ball_metrics")
        endpoint = sample_state.get("batted_ball_endpoint")
        contact_sample = sample_state.get("contact_sample")
        if (
            metrics is None
            or contact_sample is None
            or sample_state.get("combined_emitted", False)
        ):
            return
        if endpoint is None:
            endpoint_type, endpoint_status, endpoint_sample, endpoint_distance = (
                "unresolved", reason, None, None,
            )
        else:
            endpoint_type, endpoint_status, endpoint_sample, endpoint_distance = endpoint
        mph, launch_degrees, spray_degrees, spray_side, vy_launch_units_per_sec, launch_time_ns = metrics

        # An unresolved contact (the ball's tracked position simply stopped
        # updating — see the staleness check below) still has real, this-shot
        # trajectory data right up to the last tracked frame. Extrapolating
        # forward from THAT point using THIS shot's own observed vertical
        # deceleration is far more accurate than projecting from launch
        # conditions with an assumed real-world gravity/no-drag model: this
        # game's actual physics are unknown and clearly not real-world (a
        # same-speed/angle shot that barely clears the fence here would need
        # ~250mph under real orbital-mechanics-grade no-drag physics).
        extrapolated_hang_time_seconds = None
        extrapolated_x = None
        extrapolated_z = None
        if endpoint_type == "unresolved":
            flight_samples = sample_state.get("flight_samples") or []
            if len(flight_samples) >= 8:
                last = flight_samples[-1]
                reference = flight_samples[max(0, len(flight_samples) - 6)]
                dt_local = (last[1] - reference[1]) / 1000000000
                elapsed_launch_to_last = (last[1] - launch_time_ns) / 1000000000
                if dt_local > 0.02 and elapsed_launch_to_last > 0.3:
                    vy_last = (last[4] - reference[4]) / dt_local
                    vx_last = (last[3] - reference[3]) / dt_local
                    vz_last = (last[5] - reference[5]) / dt_local
                    g_effective = (vy_launch_units_per_sec - vy_last) / elapsed_launch_to_last
                    # A degenerate/non-physical estimate (this shot never
                    # dropped enough yet to measure its own deceleration
                    # reliably) falls back to a plain real-world-gravity
                    # guess rather than producing a nonsense distance.
                    if not (0.5 <= g_effective <= 100):
                        g_effective = 32.174 / FEET_PER_UNIT
                    discriminant = (vy_last * vy_last) + (2 * g_effective * max(0, last[4]))
                    if discriminant >= 0:
                        fall_seconds = (vy_last + discriminant ** 0.5) / g_effective
                        final_x = last[3] + (vx_last * fall_seconds)
                        final_z = last[5] + (vz_last * fall_seconds)
                        dx = final_x - contact_sample[3]
                        dz = final_z - contact_sample[5]
                        endpoint_distance = ((dx * dx) + (dz * dz)) ** 0.5 * FEET_PER_UNIT
                        endpoint_status = f"{reason}+extrapolated_from_last_frame"
                        # Report where this lands, not just how far. Spray
                        # angle describes the direction the ball LEFT the bat,
                        # which a curving ball does not keep, so a consumer
                        # placing the ball on a field from distance+spray puts
                        # it in the wrong spot. These are in the same game
                        # coordinates as a real endpoint.
                        extrapolated_x = final_x
                        extrapolated_z = final_z
                        extrapolated_hang_time_seconds = max(
                            0, (last[1] - contact_sample[1]) / 1000000000
                        ) + fall_seconds

        if endpoint_sample is None:
            endpoint_seq = "none"
            endpoint_x = "none"
            endpoint_y = "none"
            endpoint_z = "none"
            flight_updates_text = "none"
            sampled_updates_time_text = "none"
            hang_time_text = (
                "none" if extrapolated_hang_time_seconds is None
                else f"{extrapolated_hang_time_seconds:.3f}"
            )
        else:
            endpoint_seq = str(endpoint_sample[0])
            endpoint_x = f"{endpoint_sample[3]:.9g}"
            endpoint_y = f"{endpoint_sample[4]:.9g}"
            endpoint_z = f"{endpoint_sample[5]:.9g}"
            flight_updates = max(0, endpoint_sample[0] - contact_sample[0])
            sampled_updates_seconds = flight_updates / 59.94
            hang_time_seconds = max(
                0, (endpoint_sample[1] - contact_sample[1]) / 1000000000
            )
            flight_updates_text = str(flight_updates)
            sampled_updates_time_text = f"{sampled_updates_seconds:.3f}"
            hang_time_text = f"{hang_time_seconds:.3f}"
        distance_text = (
            "none" if endpoint_distance is None else f"{endpoint_distance:.1f}"
        )
        projected_x_text = (
            "none" if extrapolated_x is None else f"{extrapolated_x:.9g}"
        )
        projected_z_text = (
            "none" if extrapolated_z is None else f"{extrapolated_z:.9g}"
        )
        log.debug(
            "[TRACKER_BATTED_BALL_PROVISIONAL]"
            f" contact_seq={contact_sample[0]}"
            f"|batter={sample_state.get('batter_name') or 'unknown'}"
            f"|pitcher={sample_state.get('pitcher_name') or 'unknown'}"
            f"|exit_speed_mph={mph:.1f}"
            f"|launch_degrees={launch_degrees:.1f}"
            f"|spray_degrees={spray_degrees:.1f}|side={spray_side}"
            f"|endpoint={endpoint_type}|endpoint_status={endpoint_status}"
            f"|endpoint_seq={endpoint_seq}|x={endpoint_x}"
            f"|y={endpoint_y}|z={endpoint_z}"
            f"|distance_feet={distance_text}"
            f"|projected_x={projected_x_text}"
            f"|projected_z={projected_z_text}"
            f"|flight_updates={flight_updates_text}"
            f"|sampled_updates_seconds={sampled_updates_time_text}"
            f"|hang_time_seconds={hang_time_text}"
            # Self-describing scale. distance_feet is converted inside this
            # executable, so a consumer holding a record from an older build
            # otherwise has no way to know which feet it is in -- and guessing
            # wrong shortened a 342 ft home run to 306 and drew it inside the
            # park. Coordinates never had this problem; they are raw units.
            f"|feet_per_unit={FEET_PER_UNIT:.4f}"
        )
        sample_state["combined_emitted"] = True

    # Waiting for the next pitch counter to increment (the other flush
    # trigger, below) means the result is invisible until the user throws
    # another pitch — useless for actually watching the number appear after
    # the play. A ball the game has stopped simulating (deep enough to leave
    # tracked play) does not invalidate the memory pointer — it was checked
    # directly and never happens — it just stops producing new coordinate
    # samples, since the coordinate-changed check upstream is what drives
    # flight_samples' growth. That staleness is the real, fast "this is the
    # last frame we're going to get" signal: check it against wall-clock time
    # since the last actual sample, not since contact, so this fires within
    # ~1-2s of tracking actually stopping instead of waiting out a fixed
    # guess. A longer absolute-elapsed fallback stays as a backstop only, in
    # case staleness detection itself never fires for some reason.
    contact_sample_for_timeout = sample_state.get("contact_sample")
    if contact_sample_for_timeout is not None and not sample_state.get("combined_emitted", False):
        flight_samples_for_timeout = sample_state.get("flight_samples") or []
        now_ns = time.perf_counter_ns()
        elapsed_since_contact = (now_ns - contact_sample_for_timeout[1]) / 1000000000
        seconds_since_last_sample = (
            (now_ns - flight_samples_for_timeout[-1][1]) / 1000000000
            if flight_samples_for_timeout else elapsed_since_contact
        )
        # Cheap diagnostic trail (one line per 5s, not per tick) so a stalled
        # flush is visible directly in the log instead of just absent — did
        # this code path run at all, and if so, what did it see.
        watch_checkpoint = int(elapsed_since_contact // 5)
        if watch_checkpoint != sample_state.get("timeout_watch_checkpoint"):
            sample_state["timeout_watch_checkpoint"] = watch_checkpoint
            log.debug(
                f"[TRACKER_BATTED_BALL_TIMEOUT_WATCH] elapsed_seconds={elapsed_since_contact:.1f}"
                f"|seconds_since_last_sample={seconds_since_last_sample:.1f}"
                f"|contact_seq={contact_sample_for_timeout[0]}"
                f"|flight_samples={len(flight_samples_for_timeout)}"
                f"|post_samples={len(sample_state.get('post_samples') or [])}"
                f"|metrics_ready={sample_state.get('batted_ball_metrics') is not None}"
                f"|endpoint_ready={sample_state.get('batted_ball_endpoint') is not None}"
            )
        if sample_state.get("batted_ball_metrics") is None:
            # Every flush path below emits nothing without metrics, so a
            # contact that never produced any (the coordinate feed went quiet
            # at or before contact, so no post-contact movement ever arrived)
            # would otherwise stay latched forever: it can never be emitted,
            # and only a *new* contact clears it. That leaves this watch
            # ticking indefinitely and keeps flight_samples accumulating
            # against a contact that is never going to resolve. Real exit
            # metrics need just three post-contact samples (~0.05s), so
            # seconds without them means they are not coming; drop the contact
            # and say so rather than silently latching.
            if elapsed_since_contact >= 8:
                log.debug(
                    "[TRACKER_BATTED_BALL_ABANDONED]"
                    f" contact_seq={contact_sample_for_timeout[0]}"
                    f"|batter={sample_state.get('batter_name') or 'unknown'}"
                    f"|pitcher={sample_state.get('pitcher_name') or 'unknown'}"
                    f"|elapsed_seconds={elapsed_since_contact:.1f}"
                    f"|seconds_since_last_sample={seconds_since_last_sample:.1f}"
                    f"|post_samples={len(sample_state.get('post_samples') or [])}"
                    f"|flight_samples={len(flight_samples_for_timeout)}"
                    "|reason=no_exit_metrics_before_timeout"
                )
                sample_state["contact_sample"] = None
                sample_state["combined_emitted"] = True
                sample_state["landing_tracking"] = False
                sample_state["landing_recent_samples"] = []
                sample_state["flight_samples"] = []
                sample_state["post_remaining"] = 0
                sample_state["post_samples"] = []
                sample_state["timeout_watch_checkpoint"] = None
        elif seconds_since_last_sample >= 1.5:
            emit_batted_ball_diagnostic("tracking_stalled")
        elif elapsed_since_contact >= 20:
            emit_batted_ball_diagnostic("landing_timeout")

    if sample_state.get("pitch_terminal") and sample_state.get("pitch_active"):
        emit_pitch_diagnostic(sample_state["pitch_terminal"])

    game_state_name = str(game.game_state.display)
    current_pitch_counter = game.pitches.value
    previous_pitch_counter = sample_state.get("pitch_last_counter")
    if previous_pitch_counter is None:
        sample_state["pitch_last_counter"] = current_pitch_counter
    elif current_pitch_counter > previous_pitch_counter:
        if sample_state.get("pitch_active"):
            emit_pitch_diagnostic("next_pitch_counter")
        emit_batted_ball_diagnostic("next_pitch_counter")
        sample_state["pitch_armed"] = game_state_name == "BATTING"
        sample_state["pitch_active"] = False
        sample_state["pitch_samples"] = []
        sample_state["pitch_terminal"] = None
        sample_state["pitch_counter"] = current_pitch_counter
        sample_state["pitch_balls_before"] = game.balls.value
        sample_state["pitch_strikes_before"] = game.strikes.value
        sample_state["pitch_is_star"] = False
        sample_state["pitch_start_state"] = game_state_name
        try:
            sample_state["pitch_pitcher_name"] = game.get_current_pitcher().name
            sample_state["pitch_batter_name"] = game.get_current_batter().name
        except Exception:
            sample_state["pitch_pitcher_name"] = "unknown"
            sample_state["pitch_batter_name"] = "unknown"
        sample_state["pitch_last_counter"] = current_pitch_counter
    elif current_pitch_counter != previous_pitch_counter:
        # A new plate appearance resets this counter; it is not itself a pitch.
        sample_state["pitch_last_counter"] = current_pitch_counter

    previous_balls = sample_state.get("pitch_last_balls")
    previous_strikes = sample_state.get("pitch_last_strikes")
    count_changed = (
        previous_balls is not None
        and previous_strikes is not None
        and (
            game.balls.value != previous_balls
            or game.strikes.value != previous_strikes
        )
    )
    coordinates = None
    pointer = None
    coordinate_offset = None
    try:
        struct_module = __import__("struct")
        pointer = int.from_bytes(dme.read_bytes(0x80795310, 4), "big")
        if pointer == 0:
            raise ValueError("ball pointer is null")

        # The position field's offset inside the ball object is NOT stable
        # across sessions. It was 0x558 when this feed was first built and is
        # 0x4B4 now, with the pointer itself unchanged; 0x558 currently holds
        # an unrelated integer that never moves. A hardcoded offset therefore
        # fails silently and total: the coordinates read fine, never change,
        # and every downstream metric produces nothing with no error anywhere.
        # So ask the object where its coordinates are instead of assuming.
        # Between pitches the ball rests on the mound at a byte-exact Z, which
        # is re-established before every single pitch and is unique within the
        # object, making it an unambiguous fingerprint to search for. Only Z is
        # matched: the resting Y alternates between 0 and 1 depending on
        # whether the pitcher is holding the ball, so keying on it would miss
        # half the time. X and Y are range-checked instead, which is enough to
        # reject a stray constant that is not a position.
        coordinate_offset = sample_state.get("coordinate_offset")
        if coordinate_offset is None:
            reset_signature = struct_module.pack(">f", -18.6000004)
            window = dme.read_bytes(pointer + 0x300, 0x400)
            match_index = window.find(reset_signature)
            while match_index >= 0:
                candidate_offset = 0x300 + match_index - 8
                if match_index >= 8 and candidate_offset % 4 == 0:
                    candidate_x, candidate_y = struct_module.unpack(
                        ">ff", window[match_index - 8 : match_index]
                    )
                    if -60 < candidate_x < 60 and -5 < candidate_y < 60:
                        coordinate_offset = candidate_offset
                        sample_state["coordinate_offset"] = candidate_offset
                        log.debug(
                            "[TRACKER_BALL_FEED] status=calibrated"
                            f"|pointer=0x{pointer:08X}"
                            f"|coordinate_offset=0x{candidate_offset:03X}"
                            f"|coordinate_address=0x{pointer + candidate_offset:08X}"
                            f"|x={candidate_x:.9g}|y={candidate_y:.9g}|z=-18.6000004"
                            "|source=pitch_reset_signature"
                        )
                        break
                match_index = window.find(reset_signature, match_index + 1)
            if coordinate_offset is None:
                # The ball is not at rest yet (or this build rests it
                # somewhere else). Use the last known-good offset without
                # latching it, so calibration retries every update until the
                # next reset settles the question.
                coordinate_offset = 0x4B4
                if not sample_state.get("uncalibrated_reported"):
                    sample_state["uncalibrated_reported"] = True
                    log.debug(
                        "[TRACKER_BALL_FEED] status=uncalibrated"
                        f"|pointer=0x{pointer:08X}"
                        f"|fallback_coordinate_offset=0x{coordinate_offset:03X}"
                        "|note=waiting_for_ball_at_pitch_reset_to_calibrate"
                    )
        raw_coordinates = dme.read_bytes(pointer + coordinate_offset, 12)
        coordinates = struct_module.unpack(">fff", raw_coordinates)
    except Exception:
        if sample_state.get("valid") is not False:
            log.debug("[TRACKER_BALL_POINTER] status=invalid")
        sample_state["valid"] = False
        sample_state["pointer"] = None
        sample_state["last_coordinates"] = None

    if coordinates is not None:
        coordinate_address = pointer + coordinate_offset
        if (
            sample_state.get("valid") is not True
            or sample_state.get("pointer") != pointer
        ):
            log.debug(
                f"[TRACKER_BALL_POINTER] status=valid|pointer=0x{pointer:08X}"
                f"|coordinate_address=0x{coordinate_address:08X}"
            )
        sample_state["valid"] = True
        sample_state["pointer"] = pointer

        # A pointer that resolves is not the same as a ball feed that works.
        # When the resolved coordinates simply never change, every downstream
        # feature (pitch flight, exit speed, launch angle, landing) produces
        # nothing at all, and the log looks identical to a broken batted-ball
        # state machine: no records, no errors, no explanation. That reading
        # already cost this project a full debugging session, so say it out
        # loud instead. One line per stall episode and one on recovery keeps
        # this cheap; the ball legitimately rests between pitches, so only a
        # long freeze while the game is actually in BATTING is reported.
        feed_now_ns = time.perf_counter_ns()
        if coordinates != sample_state.get("last_coordinates"):
            if sample_state.get("feed_stalled"):
                stalled_for = (
                    feed_now_ns - (sample_state.get("feed_last_change_ns") or feed_now_ns)
                ) / 1000000000
                log.debug(
                    "[TRACKER_BALL_FEED] status=moving"
                    f"|pointer=0x{pointer:08X}"
                    f"|stalled_seconds={stalled_for:.1f}"
                )
                sample_state["feed_stalled"] = False
            sample_state["feed_last_change_ns"] = feed_now_ns
        else:
            feed_last_change_ns = sample_state.get("feed_last_change_ns")
            if feed_last_change_ns is None:
                sample_state["feed_last_change_ns"] = feed_now_ns
            elif (
                not sample_state.get("feed_stalled", False)
                and game_state_name == "BATTING"
                and (feed_now_ns - feed_last_change_ns) / 1000000000 >= 15
            ):
                sample_state["feed_stalled"] = True
                log.debug(
                    "[TRACKER_BALL_FEED] status=stalled"
                    f"|pointer=0x{pointer:08X}"
                    f"|coordinate_address=0x{coordinate_address:08X}"
                    f"|coordinate_offset=0x{coordinate_offset:03X}"
                    f"|seconds_since_change={(feed_now_ns - feed_last_change_ns) / 1000000000:.1f}"
                    f"|x={coordinates[0]:.9g}|y={coordinates[1]:.9g}|z={coordinates[2]:.9g}"
                    "|note=game_is_batting_but_ball_coordinates_are_frozen"
                )
                # A frozen feed during BATTING is the exact symptom of the
                # offset having moved, so make the stall retrigger calibration
                # rather than reporting the same frozen field forever.
                sample_state["coordinate_offset"] = None

        # The tracker loop can run multiple times during one Dolphin frame.
        # Keep only changed values so the experiment does not log duplicates.
        if coordinates != sample_state.get("last_coordinates"):
            sample_state["sequence"] += 1
            sample = (
                sample_state["sequence"],
                time.perf_counter_ns(),
                pointer,
                coordinates[0],
                coordinates[1],
                coordinates[2],
            )
            sample_state["samples"].append(sample)
            if len(sample_state["samples"]) > 12:
                del sample_state["samples"][:-12]

            # Retained for the rest of a contact's flight (not the rolling
            # 12-sample window above) so an unresolved landing can extrapolate
            # from this game's own observed trajectory instead of guessing at
            # real-world physics from launch conditions alone. ~700 samples is
            # about 11.7s at 59.94fps, comfortably past the longest hang time
            # seen on a real tracked landing so far (~9.3s).
            if (
                sample_state.get("contact_sample") is not None
                and not sample_state.get("combined_emitted", False)
            ):
                flight_samples = sample_state.setdefault("flight_samples", [])
                flight_samples.append(sample)
                if len(flight_samples) > 700:
                    del flight_samples[:-700]

            if game_state_name == "BATTING":
                if sample_state.get("pitch_active"):
                    pitch_samples = sample_state.setdefault("pitch_samples", [])
                    previous_pitch_sample = pitch_samples[-1] if pitch_samples else None
                    if (
                        previous_pitch_sample is None
                        or sample[5] > previous_pitch_sample[5]
                    ):
                        pitch_samples.append(sample)
                        if len(pitch_samples) > 120:
                            del pitch_samples[:-120]
                    else:
                        # The first loss of forward +Z motion is treated only as
                        # an arrival boundary; the reversing sample is excluded.
                        sample_state["pitch_terminal"] = "forward_z_ended"
                elif sample_state.get("pitch_armed"):
                    previous_coordinates = sample_state.get("last_coordinates")
                    if (
                        previous_coordinates is not None
                        and sample[5] > previous_coordinates[2]
                    ):
                        sample_state["pitch_active"] = True
                        sample_state["pitch_samples"] = [sample]

            phase = (
                "post_contact"
                if sample_state.get("post_remaining", 0) > 0
                else "raw"
            )
            log.debug(
                f"[TRACKER_BALL_SAMPLE] phase={phase}|seq={sample[0]}"
                f"|time_ns={sample[1]}|pointer=0x{sample[2]:08X}"
                f"|x={sample[3]:.9g}|y={sample[4]:.9g}|z={sample[5]:.9g}"
            )

            if sample_state.get("post_remaining", 0) > 0:
                sample_state["post_index"] += 1
                sample_state["post_samples"].append(sample)
                log.debug(
                    f"[TRACKER_BALL_CONTACT_WINDOW] relative=+{sample_state['post_index']}"
                    f"|seq={sample[0]}|time_ns={sample[1]}"
                    f"|x={sample[3]:.9g}|y={sample[4]:.9g}|z={sample[5]:.9g}"
                )
                sample_state["post_remaining"] -= 1

                # The contact-to-first-post-contact jump is deliberately not
                # included. Once three post-contact samples exist, the two
                # steps between them are averaged using the locked
                # FEET_PER_UNIT convention and the 59.94 updates/second
                # calibration. Launch
                # angle uses that same averaged movement vector, with positive
                # degrees meaning the ball is moving above horizontal. Spray
                # uses straightaway center (-Z) as zero, with negative angles
                # toward third base and positive angles toward first base.
                if (
                    len(sample_state["post_samples"]) == 3
                    and not sample_state.get("exit_speed_emitted", False)
                ):
                    first, second, third = sample_state["post_samples"]
                    dx1 = second[3] - first[3]
                    dy1 = second[4] - first[4]
                    dz1 = second[5] - first[5]
                    step1 = (dx1 * dx1 + dy1 * dy1 + dz1 * dz1) ** 0.5
                    dx2 = third[3] - second[3]
                    dy2 = third[4] - second[4]
                    dz2 = third[5] - second[5]
                    step2 = (dx2 * dx2 + dy2 * dy2 + dz2 * dz2) ** 0.5
                    average_step = (step1 + step2) / 2
                    mph = average_step * FEET_PER_UNIT * 59.94 / 1.4666667
                    average_dx = (dx1 + dx2) / 2
                    average_dy = (dy1 + dy2) / 2
                    average_dz = (dz1 + dz2) / 2
                    horizontal = (
                        average_dx * average_dx + average_dz * average_dz
                    ) ** 0.5
                    math_module = __import__("math")
                    launch_degrees = math_module.degrees(
                        math_module.atan2(average_dy, horizontal)
                    )
                    step1_degrees = math_module.degrees(
                        math_module.atan2(
                            dy1, (dx1 * dx1 + dz1 * dz1) ** 0.5
                        )
                    )
                    step2_degrees = math_module.degrees(
                        math_module.atan2(
                            dy2, (dx2 * dx2 + dz2 * dz2) ** 0.5
                        )
                    )
                    spray_degrees = math_module.degrees(
                        math_module.atan2(average_dx, -average_dz)
                    )
                    spray_step1_degrees = math_module.degrees(
                        math_module.atan2(dx1, -dz1)
                    )
                    spray_step2_degrees = math_module.degrees(
                        math_module.atan2(dx2, -dz2)
                    )
                    if spray_degrees < -5:
                        spray_side = "third_base"
                    elif spray_degrees > 5:
                        spray_side = "first_base"
                    else:
                        spray_side = "center"
                    log.debug(
                        f"[TRACKER_EXIT_SPEED_PROVISIONAL] mph={mph:.1f}"
                        f"|step1_units={step1:.9g}|step2_units={step2:.9g}"
                        f"|samples={first[0]},{second[0]},{third[0]}"
                        f"|feet_per_unit={FEET_PER_UNIT:.4f}|updates_per_second=59.94"
                    )
                    log.debug(
                        "[TRACKER_LAUNCH_ANGLE_PROVISIONAL]"
                        f" degrees={launch_degrees:.1f}"
                        f"|step1_degrees={step1_degrees:.1f}"
                        f"|step2_degrees={step2_degrees:.1f}"
                        f"|samples={first[0]},{second[0]},{third[0]}"
                        "|horizontal_plane=xz|vertical_axis=y"
                    )
                    log.debug(
                        "[TRACKER_SPRAY_DIRECTION_PROVISIONAL]"
                        f" degrees={spray_degrees:.1f}|side={spray_side}"
                        f"|step1_degrees={spray_step1_degrees:.1f}"
                        f"|step2_degrees={spray_step2_degrees:.1f}"
                        f"|samples={first[0]},{second[0]},{third[0]}"
                        "|zero_axis=-z|negative=third_base|positive=first_base"
                    )
                    sample_state["batted_ball_metrics"] = (
                        mph,
                        launch_degrees,
                        spray_degrees,
                        spray_side,
                        average_dy * 59.94,
                        second[1],
                    )
                    sample_state["exit_speed_emitted"] = True

            # ``fair_or_foul`` is the same authoritative tracker field that
            # produces "Fair ball!", "Fair ball fielded!", and caught-hit
            # records. A fair state arms the physical landing detector, which
            # selects a local Y minimum from the three most recent samples. The
            # rolling buffer lets it look back one update when the fair state
            # arrives just after the physical bounce. Caught and foul terminal
            # states deliberately produce no landing. A caught state instead
            # records the current catch coordinate for spray-chart placement.
            if sample_state.get("landing_tracking", False):
                recent_samples = sample_state.setdefault(
                    "landing_recent_samples", []
                )
                recent_samples.append(sample)
                if len(recent_samples) > 3:
                    del recent_samples[:-3]
                try:
                    landing_status = BallLandingStatus(
                        game.this_pitch.fair_or_foul.value
                    )
                    if landing_status in (
                        BallLandingStatus.FAIR,
                        BallLandingStatus.FAIR_FIELDED,
                    ):
                        landing_sample = None
                        landing_name = None
                        landing_source = None
                        if len(recent_samples) == 3:
                            before, candidate, after = recent_samples
                            if (
                                candidate[4] <= before[4]
                                and after[4] > candidate[4] + 0.0001
                            ):
                                landing_sample = candidate
                        if landing_sample is not None:
                            landing_name = "fair"
                            landing_source = (
                                "this_pitch.fair_or_foul+recent_y_reversal"
                            )
                        elif landing_status == BallLandingStatus.FAIR_FIELDED:
                            positive_height_samples = [
                                item for item in recent_samples if item[4] > 0.0001
                            ]
                            landing_sample = min(
                                positive_height_samples or recent_samples,
                                key=lambda item: item[4],
                            )
                            landing_name = "fair_fielded"
                            landing_source = "this_pitch.fair_or_foul"

                        if landing_sample is not None:
                            distance_feet = None
                            log.debug(
                                "[TRACKER_LANDING_PROVISIONAL]"
                                f" status={landing_name}|seq={landing_sample[0]}"
                                f"|time_ns={landing_sample[1]}"
                                f"|x={landing_sample[3]:.9g}"
                                f"|y={landing_sample[4]:.9g}"
                                f"|z={landing_sample[5]:.9g}"
                                f"|source={landing_source}"
                            )
                            contact_sample = sample_state.get("contact_sample")
                            if contact_sample is not None:
                                distance_dx = landing_sample[3] - contact_sample[3]
                                distance_dz = landing_sample[5] - contact_sample[5]
                                distance_units = (
                                    distance_dx * distance_dx
                                    + distance_dz * distance_dz
                                ) ** 0.5
                                distance_feet = distance_units * FEET_PER_UNIT
                                log.debug(
                                    "[TRACKER_LANDING_DISTANCE_PROVISIONAL]"
                                    f" feet={distance_feet:.1f}"
                                    f"|units={distance_units:.9g}"
                                    f"|contact_seq={contact_sample[0]}"
                                    f"|landing_seq={landing_sample[0]}"
                                    f"|plane=xz|feet_per_unit={FEET_PER_UNIT:.4f}"
                                )
                            sample_state["batted_ball_endpoint"] = (
                                "landing",
                                landing_name,
                                landing_sample,
                                distance_feet,
                            )
                            sample_state["landing_tracking"] = False
                            sample_state["landing_recent_samples"] = []
                    elif landing_status == BallLandingStatus.CAUGHT_OUT:
                        catch_sample = sample
                        distance_feet = None
                        log.debug(
                            "[TRACKER_CATCH_PROVISIONAL] status=caught"
                            f"|seq={catch_sample[0]}|time_ns={catch_sample[1]}"
                            f"|x={catch_sample[3]:.9g}|y={catch_sample[4]:.9g}"
                            f"|z={catch_sample[5]:.9g}"
                            "|source=this_pitch.fair_or_foul"
                        )
                        contact_sample = sample_state.get("contact_sample")
                        if contact_sample is not None:
                            distance_dx = catch_sample[3] - contact_sample[3]
                            distance_dz = catch_sample[5] - contact_sample[5]
                            distance_units = (
                                distance_dx * distance_dx
                                + distance_dz * distance_dz
                            ) ** 0.5
                            distance_feet = distance_units * FEET_PER_UNIT
                            log.debug(
                                "[TRACKER_CATCH_DISTANCE_PROVISIONAL]"
                                f" feet={distance_feet:.1f}"
                                f"|units={distance_units:.9g}"
                                f"|contact_seq={contact_sample[0]}"
                                f"|catch_seq={catch_sample[0]}"
                                f"|plane=xz|feet_per_unit={FEET_PER_UNIT:.4f}"
                            )
                        sample_state["batted_ball_endpoint"] = (
                            "catch",
                            "caught",
                            catch_sample,
                            distance_feet,
                        )
                        sample_state["landing_tracking"] = False
                        sample_state["landing_recent_samples"] = []
                    elif landing_status == BallLandingStatus.FOUL:
                        sample_state["batted_ball_endpoint"] = (
                            "foul",
                            "foul",
                            None,
                            None,
                        )
                        sample_state["landing_tracking"] = False
                        sample_state["landing_recent_samples"] = []
                except Exception:
                    pass

            # Emit as soon as both the launch metrics and the terminal endpoint
            # classification are known (the ordinary case). If the endpoint
            # never resolves (see emit_batted_ball_diagnostic above), the
            # next-pitch-counter flush below is what actually emits it.
            if sample_state.get("batted_ball_endpoint") is not None:
                emit_batted_ball_diagnostic("endpoint_resolved")

            sample_state["last_coordinates"] = coordinates

        # FAIR_FIELDED is authoritative and can change while the held ball's
        # coordinates are momentarily unchanged. Check it outside the
        # changed-coordinate block and use the latest physical sample, which
        # is the last position before possession/throwing can move the ball.
        try:
            fielding_status = BallLandingStatus(game.this_pitch.fair_or_foul.value)
            contact_sample = sample_state.get("contact_sample")
            latest_samples = sample_state.get("samples", [])
            if (
                fielding_status == BallLandingStatus.FAIR_FIELDED
                and contact_sample is not None
                and latest_samples
                and not sample_state.get("fielded_emitted", False)
            ):
                fielded_sample = latest_samples[-1]
                fielded_dx = fielded_sample[3] - contact_sample[3]
                fielded_dz = fielded_sample[5] - contact_sample[5]
                fielded_units = (
                    fielded_dx * fielded_dx + fielded_dz * fielded_dz
                ) ** 0.5
                fielded_distance_feet = fielded_units * FEET_PER_UNIT
                fielded_spray_degrees = __import__("math").degrees(
                    __import__("math").atan2(fielded_dx, -fielded_dz)
                )
                fielding_time_seconds = max(
                    0, (fielded_sample[1] - contact_sample[1]) / 1000000000
                )
                log.debug(
                    "[TRACKER_BALL_FIELDED_PROVISIONAL]"
                    f" contact_seq={contact_sample[0]}"
                    f"|batter={sample_state.get('batter_name') or 'unknown'}"
                    f"|pitcher={sample_state.get('pitcher_name') or 'unknown'}"
                    f"|fielded_seq={fielded_sample[0]}"
                    f"|time_ns={fielded_sample[1]}"
                    f"|x={fielded_sample[3]:.9g}"
                    f"|y={fielded_sample[4]:.9g}"
                    f"|z={fielded_sample[5]:.9g}"
                    f"|distance_feet={fielded_distance_feet:.1f}"
                    f"|spray_degrees={fielded_spray_degrees:.1f}"
                    f"|fielding_time_seconds={fielding_time_seconds:.3f}"
                    "|source=this_pitch.fair_or_foul+latest_physical_sample"
                )
                sample_state["fielded_emitted"] = True
        except Exception:
            pass

        if sample_state.get("pitch_active"):
            if count_changed:
                sample_state["pitch_terminal"] = "count_change"
            elif game.this_pitch.bean_ball_flag.value == 1:
                sample_state["pitch_terminal"] = "hit_by_pitch"
            elif game_state_name != "BATTING":
                sample_state["pitch_terminal"] = "left_batting_state"
            if sample_state.get("pitch_terminal"):
                emit_pitch_diagnostic(sample_state["pitch_terminal"])

    sample_state["pitch_last_balls"] = game.balls.value
    sample_state["pitch_last_strikes"] = game.strikes.value

    emitted = globals().setdefault("_tracker_batting_emitted_team_ids", set())
    for team in (team1, team2):
        team_key = id(team)
        if team_key not in emitted:
            batting = ",".join(player.name for player in team.players)
            if len(team.players) == 9:
                log.debug(
                    f"[TRACKER_BATTING] team={team.short_name}|batting={batting}"
                )
                emitted.add(team_key)

def _check_if_ball_was_hit(game, offense_meter, mc):
    game.ball_was_hit.refresh()
    if game.ball_was_hit.value == 1 and not mc.ball_hit_flag:
        mc.baserunners[0] = mc.batter
        mc.num_baserunners = sum(x is not NO_PLAYER for x in mc.baserunners)
        mc.steal_attempters = []
        mc.ball_hit_flag = True

        # Preserve the confirmed tracker contact event above, then annotate the
        # latest raw samples. Instrumentation failures must never interrupt the
        # tracker's existing stat logic.
        try:
            sample_state = globals().setdefault(
                "_tracker_ball_sample_state",
                {
                    "valid": None,
                    "pointer": None,
                    "last_coordinates": None,
                    "sequence": 0,
                    "samples": [],
                    "post_remaining": 0,
                    "post_index": 0,
                    "post_samples": [],
                    "exit_speed_emitted": False,
                    "landing_tracking": False,
                    "landing_recent_samples": [],
                    "contact_sample": None,
                    "batted_ball_metrics": None,
                    "batted_ball_endpoint": None,
                    "combined_emitted": False,
                    "fielded_emitted": False,
                    "batter_name": None,
                    "pitcher_name": None,
                    "pitch_active": False,
                    "pitch_terminal": None,
                },
            )
            samples = list(sample_state.get("samples", []))
            contact_sample = samples[-1] if samples else None

            # A real contact is anchored to the frame the ball was struck on:
            # the newest sample is milliseconds old, because a struck ball is
            # moving. Anchoring to anything else produces a contact that can
            # never resolve — no post-contact movement is coming — and feeds
            # consumers a phantom zero-distance batted ball built from a
            # position the ball was never at. That is exactly what a dead
            # coordinate feed looks like: a stale pointer, a paused emulator,
            # or the placeholder the slot holds before the game initialises
            # the ball. Reject those instead of latching them, and name the
            # reason so the log distinguishes "no contact happened" from
            # "contact happened and the ball feed was not live for it".
            contact_reject_reason = None
            if contact_sample is None:
                contact_reject_reason = "no_sample"
            else:
                contact_age_seconds = (
                    time.perf_counter_ns() - contact_sample[1]
                ) / 1000000000
                # A struck ball is sampled every frame, so one second of no
                # movement at all (~60 frames) cannot be a real contact. Kept
                # deliberately loose rather than tight: the abandon path above
                # already bounds a phantom contact's lifetime, so the cost of
                # missing one is small while the cost of rejecting a real
                # contact is a permanently lost batted ball.
                if contact_age_seconds > 1.0:
                    contact_reject_reason = "stale_sample"
                elif (
                    abs(contact_sample[3]) < 0.001
                    and abs(contact_sample[4]) < 0.001
                    and abs(contact_sample[5]) < 0.001
                ):
                    contact_reject_reason = "placeholder_coordinates"

            if contact_reject_reason is not None:
                if contact_sample is None:
                    log.debug(
                        "[TRACKER_BALL_CONTACT] flag=1|status=rejected"
                        f"|reason={contact_reject_reason}|sample=unavailable"
                    )
                else:
                    log.debug(
                        "[TRACKER_BALL_CONTACT] flag=1|status=rejected"
                        f"|reason={contact_reject_reason}"
                        f"|seq={contact_sample[0]}|time_ns={contact_sample[1]}"
                        f"|sample_age_seconds={contact_age_seconds:.3f}"
                        f"|x={contact_sample[3]:.9g}|y={contact_sample[4]:.9g}"
                        f"|z={contact_sample[5]:.9g}"
                    )
                sample_state["post_remaining"] = 0
                sample_state["post_index"] = 0
                sample_state["post_samples"] = []
                sample_state["exit_speed_emitted"] = False
                sample_state["landing_tracking"] = False
                sample_state["landing_recent_samples"] = []
                sample_state["contact_sample"] = None
                sample_state["batted_ball_metrics"] = None
                sample_state["batted_ball_endpoint"] = None
                sample_state["combined_emitted"] = True
                sample_state["fielded_emitted"] = True
                sample_state["timeout_watch_checkpoint"] = None
                sample_state["flight_samples"] = []
                if sample_state.get("pitch_active"):
                    sample_state["pitch_terminal"] = "contact"
                return

            # Reaching here means the contact passed the checks above, so the
            # sample exists and is a live one.
            log.debug(
                f"[TRACKER_BALL_CONTACT] flag=1|seq={contact_sample[0]}"
                f"|time_ns={contact_sample[1]}"
                f"|x={contact_sample[3]:.9g}|y={contact_sample[4]:.9g}"
                f"|z={contact_sample[5]:.9g}"
            )
            final_index = len(samples) - 1
            for index, sample in enumerate(samples):
                relative = index - final_index
                log.debug(
                    f"[TRACKER_BALL_CONTACT_WINDOW] relative={relative:+d}"
                    f"|seq={sample[0]}|time_ns={sample[1]}"
                    f"|x={sample[3]:.9g}|y={sample[4]:.9g}|z={sample[5]:.9g}"
                )
            sample_state["post_remaining"] = 12
            sample_state["post_index"] = 0
            sample_state["post_samples"] = []
            sample_state["exit_speed_emitted"] = False
            sample_state["landing_tracking"] = True
            sample_state["landing_recent_samples"] = []
            sample_state["contact_sample"] = contact_sample
            sample_state["batted_ball_metrics"] = None
            sample_state["batted_ball_endpoint"] = None
            sample_state["combined_emitted"] = False
            sample_state["fielded_emitted"] = False
            sample_state["timeout_watch_checkpoint"] = None
            sample_state["flight_samples"] = []
            sample_state["batter_name"] = mc.batter.name
            sample_state["pitcher_name"] = mc.pitcher.name
            if sample_state.get("pitch_active"):
                sample_state["pitch_terminal"] = "contact"
        except Exception:
            log.debug("[TRACKER_BALL_CONTACT] flag=1|sample=unavailable")

def _check_for_star_pitch_usage(game, defense_meter, mc):
    """Preserve the tracker star-pitch award and annotate pitch diagnostics."""
    sc = game.star_costs
    game.defense_team.meter.refresh()
    meter_cost = defense_meter - game.defense_team.meter.value
    if meter_cost in (
        sc.captain_star_cost.value,
        sc.non_main_captain_star_cost.value,
        sc.regular_star_cost.value,
    ):
        mc.pitcher.stats.pitching.star_pitches += 1
        mc.pitcher.stats.pitching.raw_stars_used += meter_cost
        sample_state = globals().get("_tracker_ball_sample_state")
        if sample_state is not None and (
            sample_state.get("pitch_armed")
            or sample_state.get("pitch_active")
        ):
            sample_state["pitch_is_star"] = True
        log.info(f"{mc.pitcher.name} used a star pitch!")
'''
    module = compile(source, "stat_tracker.py", "exec")
    functions = {
        item.co_name: item for item in module.co_consts if isinstance(item, CodeType)
    }
    if functions.keys() != TARGET_FUNCTIONS:
        raise RuntimeError("Could not compile both advanced-stat replacement functions")
    return functions


def patch_marshaled_module(raw_module: bytes) -> bytes:
    code = marshal.loads(raw_module)
    if not isinstance(code, CodeType):
        raise TypeError("The embedded stat_tracker entry is not a Python code object")

    if not all(
        code_contains_marker(code, marker) for marker in (BATTING_MARKER, LINEUP_MARKER)
    ):
        raise RuntimeError(
            "Input tracker is missing the live lineup-feed markers; use the "
            "development copy of sluggers-stat-tracker-live-v2.exe"
        )
    # Deliberately no "already patched, skip" short-circuit here. Every marker
    # string above stays identical across versions (they're log-line prefixes,
    # not payload); only the logic inside the replaced functions changes
    # between versions. A marker-presence check would therefore silently
    # no-op every rebuild from an already-patched input onward — which is
    # exactly what happened from v14 through v19 here — since
    # replace_nested_code swaps the target functions wholesale by name,
    # re-applying it is always safe/idempotent regardless of the input's
    # existing patch state, so there is nothing to protect against by
    # skipping.
    patched, counts = replace_nested_code(code, compile_replacements())
    if any(counts.get(name) != 1 for name in TARGET_FUNCTIONS):
        raise RuntimeError(
            f"Expected one of each {sorted(TARGET_FUNCTIONS)}, found {counts}; "
            "tracker build is unsupported"
        )
    return marshal.dumps(patched)


def patch_executable(source: Path, destination: Path) -> None:
    if source.resolve() == destination.resolve():
        raise ValueError("Refusing to overwrite the source tracker")
    if destination.exists():
        raise FileExistsError(
            f"Refusing to overwrite existing destination {destination}; choose a new path"
        )

    executable = source.read_bytes()
    cookie_offset = executable.rfind(COOKIE_MAGIC)
    if cookie_offset < 0:
        raise ValueError(f"{source} does not contain a PyInstaller CArchive cookie")

    cookie_end = cookie_offset + COOKIE_LENGTH
    magic, archive_length, toc_offset, toc_length, py_version, py_lib = struct.unpack(
        COOKIE_FORMAT, executable[cookie_offset:cookie_end]
    )
    if py_version != 313:
        raise RuntimeError(
            f"Expected Python 3.13 bytecode, but the archive reports {py_version}"
        )
    archive_start = cookie_end - archive_length
    if archive_start < 0:
        raise ValueError("Invalid PyInstaller archive length")

    toc_start = archive_start + toc_offset
    entries = parse_toc(executable[toc_start : toc_start + toc_length])
    if sum(entry.name == TARGET_ENTRY for entry in entries) != 1:
        raise RuntimeError(f"Could not uniquely locate embedded {TARGET_ENTRY!r}")

    original_payloads: list[bytes] = []
    payloads = []
    for entry in entries:
        payload = executable[
            archive_start + entry.offset : archive_start + entry.offset + entry.data_length
        ]
        original_payloads.append(payload)
        raw_length = entry.uncompressed_length
        if entry.name == TARGET_ENTRY:
            raw = zlib.decompress(payload) if entry.compression_flag else payload
            patched_raw = patch_marshaled_module(raw)
            payload = (
                zlib.compress(patched_raw, level=9)
                if entry.compression_flag
                else patched_raw
            )
            raw_length = len(patched_raw)
        payloads.append((entry, payload, raw_length))

    data_parts: list[bytes] = []
    toc_parts: list[bytes] = []
    data_offset = 0
    for entry, payload, raw_length in payloads:
        data_parts.append(payload)
        toc_parts.append(encode_toc_entry(entry, data_offset, payload, raw_length))
        data_offset += len(payload)

    archive_data = b"".join(data_parts)
    new_toc = b"".join(toc_parts)
    new_toc_offset = len(archive_data)
    new_archive_length = len(archive_data) + len(new_toc) + COOKIE_LENGTH
    new_cookie = struct.pack(
        COOKIE_FORMAT,
        magic,
        new_archive_length,
        new_toc_offset,
        len(new_toc),
        py_version,
        py_lib,
    )
    rebuilt = (
        executable[:archive_start]
        + archive_data
        + new_toc
        + new_cookie
        + executable[cookie_end:]
    )

    # Verify the complete archive in memory before writing the new executable.
    verify_cookie = rebuilt.rfind(COOKIE_MAGIC)
    _, verify_length, verify_toc_offset, verify_toc_length, verify_py, _ = struct.unpack(
        COOKIE_FORMAT, rebuilt[verify_cookie : verify_cookie + COOKIE_LENGTH]
    )
    verify_start = verify_cookie + COOKIE_LENGTH - verify_length
    verify_entries = parse_toc(
        rebuilt[
            verify_start + verify_toc_offset :
            verify_start + verify_toc_offset + verify_toc_length
        ]
    )
    if verify_py != py_version or len(verify_entries) != len(entries):
        raise RuntimeError("Rebuilt executable changed the archive version or entry count")

    for index, (original, verified) in enumerate(zip(entries, verify_entries)):
        if (
            original.name != verified.name
            or original.compression_flag != verified.compression_flag
            or original.typecode != verified.typecode
        ):
            raise RuntimeError(f"Archive entry metadata changed at index {index}")
        verified_payload = rebuilt[
            verify_start + verified.offset :
            verify_start + verified.offset + verified.data_length
        ]
        if original.name != TARGET_ENTRY and verified_payload != original_payloads[index]:
            raise RuntimeError(f"Unrelated archive entry changed: {original.name}")

    target = next(entry for entry in verify_entries if entry.name == TARGET_ENTRY)
    target_payload = rebuilt[
        verify_start + target.offset : verify_start + target.offset + target.data_length
    ]
    target_raw = (
        zlib.decompress(target_payload) if target.compression_flag else target_payload
    )
    for marker in PATCH_MARKERS:
        if marker.encode() not in target_raw:
            raise RuntimeError(f"Rebuilt executable did not retain marker {marker}")
    verified_code = marshal.loads(target_raw)
    _, counts = replace_nested_code(verified_code, compile_replacements())
    if any(counts.get(name) != 1 for name in TARGET_FUNCTIONS):
        raise RuntimeError("Rebuilt executable is missing an advanced-stat function")

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(rebuilt)
    try:
        os.chmod(destination, source.stat().st_mode)
    except OSError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    patch_executable(args.source, args.destination)
    print(f"Advanced-stat tracker written to {args.destination}")


if __name__ == "__main__":
    main()
