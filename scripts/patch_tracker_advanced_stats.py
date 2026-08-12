"""Add experimental ball-coordinate, launch-metric, and landing feeds.

This patch follows the confirmed ball pointer on every tracker update, records
only changed coordinates, and logs a short sample window around the tracker's
existing ``ball_was_hit`` transition. It also reports one explicitly provisional
exit speed, launch angle, and spray direction by discarding the
contact-to-first-batted-sample jump and averaging the next two movement
vectors. It also uses the tracker's authoritative first-fair transition to arm
a rolling three-sample downward-to-upward coordinate reversal, recording the
physical landing point while excluding caught and foul balls. It records the
authoritative catch point for caught balls, and reports horizontal
contact-to-endpoint distance using the provisional 3-feet-per-unit calibration.
Once a contact resolves, it also emits one combined batted-ball record so
downstream consumers do not need to join separate metric lines themselves.
For fair and caught contacts that record also includes provisional hang time
from the continuous monotonic clock. The changed-coordinate update count is
retained as a separate diagnostic because the game can advance the batted ball
through a contact transition without exposing every intermediate coordinate.

Run this script with Python 3.13 (the bytecode version used by the tracker):

    python scripts/patch_tracker_advanced_stats.py INPUT.exe OUTPUT.exe

The destination must not already exist. Use the lineup-feed-enabled live-v2
tracker in the development folder as the input so its existing structured
batting and lineup records are retained.
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


TARGET_FUNCTIONS = {"_refresh_game_values", "_check_if_ball_was_hit"}
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
FIELDED_BALL_MARKER = "[TRACKER_BALL_FIELDED_PROVISIONAL]"
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
    FIELDED_BALL_MARKER,
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
            "batter_name": None,
            "pitcher_name": None,
        },
    )
    coordinates = None
    pointer = None
    try:
        pointer = int.from_bytes(dme.read_bytes(0x80795310, 4), "big")
        if pointer == 0:
            raise ValueError("ball pointer is null")
        raw_coordinates = dme.read_bytes(pointer + 0x558, 12)
        coordinates = __import__("struct").unpack(">fff", raw_coordinates)
    except Exception:
        if sample_state.get("valid") is not False:
            log.debug("[TRACKER_BALL_POINTER] status=invalid")
        sample_state["valid"] = False
        sample_state["pointer"] = None
        sample_state["last_coordinates"] = None

    if coordinates is not None:
        coordinate_address = pointer + 0x558
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
                # steps between them are averaged using the provisional
                # 3 feet/unit and 59.94 updates/second calibration. Launch
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
                    mph = average_step * 3 * 59.94 / 1.4666667
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
                        "|feet_per_unit=3|updates_per_second=59.94"
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
                                distance_feet = distance_units * 3
                                log.debug(
                                    "[TRACKER_LANDING_DISTANCE_PROVISIONAL]"
                                    f" feet={distance_feet:.1f}"
                                    f"|units={distance_units:.9g}"
                                    f"|contact_seq={contact_sample[0]}"
                                    f"|landing_seq={landing_sample[0]}"
                                    "|plane=xz|feet_per_unit=3"
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
                            distance_feet = distance_units * 3
                            log.debug(
                                "[TRACKER_CATCH_DISTANCE_PROVISIONAL]"
                                f" feet={distance_feet:.1f}"
                                f"|units={distance_units:.9g}"
                                f"|contact_seq={contact_sample[0]}"
                                f"|catch_seq={catch_sample[0]}"
                                "|plane=xz|feet_per_unit=3"
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

            # Emit one atomic record only after both the launch metrics and the
            # terminal endpoint classification are known. A foul deliberately
            # has no endpoint coordinate or distance.
            metrics = sample_state.get("batted_ball_metrics")
            endpoint = sample_state.get("batted_ball_endpoint")
            contact_sample = sample_state.get("contact_sample")
            if (
                metrics is not None
                and endpoint is not None
                and contact_sample is not None
                and not sample_state.get("combined_emitted", False)
            ):
                mph, launch_degrees, spray_degrees, spray_side = metrics
                endpoint_type, endpoint_status, endpoint_sample, endpoint_distance = endpoint
                if endpoint_sample is None:
                    endpoint_seq = "none"
                    endpoint_x = "none"
                    endpoint_y = "none"
                    endpoint_z = "none"
                    flight_updates_text = "none"
                    sampled_updates_time_text = "none"
                    hang_time_text = "none"
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
                    "none"
                    if endpoint_distance is None
                    else f"{endpoint_distance:.1f}"
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
                    f"|flight_updates={flight_updates_text}"
                    f"|sampled_updates_seconds={sampled_updates_time_text}"
                    f"|hang_time_seconds={hang_time_text}"
                )
                sample_state["combined_emitted"] = True

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
                fielded_distance_feet = fielded_units * 3
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
                },
            )
            samples = list(sample_state.get("samples", []))
            contact_sample = samples[-1] if samples else None
            if contact_sample is not None:
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
            else:
                log.debug("[TRACKER_BALL_CONTACT] flag=1|sample=unavailable")
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
            sample_state["batter_name"] = mc.batter.name
            sample_state["pitcher_name"] = mc.pitcher.name
        except Exception:
            log.debug("[TRACKER_BALL_CONTACT] flag=1|sample=unavailable")
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
    if all(code_contains_marker(code, marker) for marker in PATCH_MARKERS):
        return raw_module

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
