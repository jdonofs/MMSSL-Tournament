"""Prove the tracking pipeline computes what it claims, without a controller.

A recording session costs a person playing real innings, so the worst possible
time to discover that route efficiency is inverted or that reaction time is
measured from the pitch instead of from contact is after the session. This
builds a synthetic session whose every number is known in advance, runs the real
calibration and the real metrics over it, and checks what comes back.

    python scripts/verify_player_metrics.py

The synthetic frames are written in the collector's exact on-disk format -- same
XOR delta, same zlib stream, same header -- so this exercises the reader too,
not just the arithmetic. The decoys matter as much as the signal: the fake actor
structs also carry a pinned "assigned spot" field, a teleporting field, and an
out-of-range field, because those are the three things the calibration has to
reject in a real struct and a test without them would pass on a coin flip.
"""
from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

import collect_player_tracking as collector
import player_tracking_io as io
import derive_player_metrics as derive
from derive_player_metrics import (
    FAIR_CAUGHT_FLAG,
    FIELDING_ACTION_FORCED,
    FIELDING_ACTION_YOSHI_EGG,
    detect_deflections,
    detect_fielding_action_events,
    detect_forced_misplays,
    final_bases_ran,
    is_complete_third_out_catch,
    remove_replay_duplicates,
)

SCRIPTS = Path(__file__).resolve().parent
FPS = 60.0

# Ground truth. Every assertion at the bottom traces back to one of these.
CONTACT_FRAME = 120
FIRST_TOUCH_FRAME = CONTACT_FRAME + 240      # 4.0 s of hang time
THROW_RELEASE_FRAME = FIRST_TOUCH_FRAME + 30
THROW_ARRIVAL_FRAME = FIRST_TOUCH_FRAME + 90
# The relay is then thrown on to first as a BUDDY THROW: two chemistry-linked
# fielders combining, which the game plays as a cutscene with every actor frozen
# and the ball hanging unheld in mid-air. It launches far harder than an arm can
# throw, and the partner who releases it never appears in the position data.
BUDDY_RELEASE_FRAME = THROW_ARRIVAL_FRAME + 30
BUDDY_FREEZE_FRAMES = 60
BUDDY_LAUNCH_FRAME = BUDDY_RELEASE_FRAME + BUDDY_FREEZE_FRAMES
BUDDY_ARRIVAL_FRAME = BUDDY_LAUNCH_FRAME + 30
BUDDY_BOUNCE_POINT = (-13.0, 1.9, 34.0)
PLAY_END_FRAME = BUDDY_ARRIVAL_FRAME + 40
CF_REACTION_S = 0.5
CF_SPEED_UPS = 7.0
BATTER_SPEED_UPS = 8.0
LF_SPEED_UPS = 6.0
# The batter reaches first while the ball is still live, and the game then
# recycles the offense actors during the dead-ball tail of the play window,
# reverting the count to zero. Reading the last frame of the play loses it.
BATTER_REACHED_FRAME = FIRST_TOUCH_FRAME
BATTER_BASES_RAN = 1

# `ball_was_hit` stays set through the dead-ball aftermath in the real game, so
# the fixture holds it for this long after the ball goes dead. The derivation
# has to find the end of the play from `game_state`, not from that flag.
DEAD_BALL_FRAMES = 20
LIVE_END_FRAME = PLAY_END_FRAME - DEAD_BALL_FRAMES
# How long the ball spends directly above the catch point before it is caught.
DESCENT_FRAMES = 30
# The catch is made off the ground, at the wall. A fielder's own tracked height
# stays 0 through it -- that is what the real game does -- so anything that
# compares the ball's height against the fielder's rejects the catch entirely
# and only picks it up once they land.
CATCH_HEIGHT = 9.0
CATCH_HOLD_FRAMES = 20
# +0x2B2 is an enum, not a boolean. Put a confirmed boot (2) and then a Buddy
# handoff/dash (7) on the same fielder while the ball is horizontally within
# reach. The derivation must retain both as different events; the old
# `if fielding_action` implementation called both deflections.
MISPLAY_START_FRAME = FIRST_TOUCH_FRAME - 24
MISPLAY_END_FRAME = FIRST_TOUCH_FRAME - 13
HANDOFF_START_FRAME = FIRST_TOUCH_FRAME - 12
HANDOFF_END_FRAME = FIRST_TOUCH_FRAME - 1
REPLAY_START_FRAME = PLAY_END_FRAME + 20
REPLAY_END_FRAME = PLAY_END_FRAME + 50
LIVE_GAME_STATE = 2
# 3 is the game's "fair, and caught in the air" call -- see classify_batted_ball
# in derive_player_metrics.py, where every value was measured.
FAIR_CAUGHT = 3

# Where the actors start, in the ACTOR frame (+Z toward centre field), matching
# what a real Wario Stadium session reads at a pitch reset.
START = {
    "P": (0.0, 0.0, 18.6), "C": (0.0, 0.0, -3.8), "1B": (18.5, 0.0, 22.0),
    "2B": (11.0, 0.0, 36.0), "3B": (-18.5, 0.0, 22.0), "SS": (-11.0, 0.0, 36.0),
    "LF": (-34.0, 0.0, 60.0), "CF": (0.0, 0.0, 76.0), "RF": (34.0, 0.0, 60.0),
}
BAGS = {"R1": (19.5, 0.0, 19.4), "R2": (0.0, 0.0, 38.3), "R3": (-18.3, 0.0, 19.65)}
BATTER_START = (-2.3, 0.0, 0.42)
CHARACTERS = {"P": 9, "C": 52, "1B": 23, "2B": 17, "3B": 10, "SS": 19,
              "LF": 54, "CF": 37, "RF": 38}
INDICES = {"P": 3, "C": 8, "1B": 4, "2B": 2, "3B": 5, "SS": 0,
           "LF": 7, "CF": 6, "RF": 1}

# The ball is caught here, in the actor frame. CF runs to it in a straight line;
# LF sets off toward a decoy point first, so its route efficiency is knowably
# below one.
CATCH_POINT = (12.0, 0.0, 88.0)
LF_DETOUR = (-46.0, 0.0, 64.0)


def lerp(a, b, u):
    return tuple(p + (q - p) * u for p, q in zip(a, b))


def travel(start, target, speed, seconds):
    """Position after moving toward `target` at `speed` for `seconds`."""
    total = math.dist(start, target)
    if total == 0:
        return start
    covered = min(speed * seconds, total)
    return lerp(start, target, covered / total)


def motion_frame(frame):
    """The frame number with frozen cutscene time removed.

    Every actor holds still through a Buddy Throw, so their own clocks stop with
    it. Positions are laid down against this rather than against the raw frame
    counter, which is what makes the freeze detectable at all.
    """
    if frame < BUDDY_RELEASE_FRAME:
        return frame
    if frame < BUDDY_LAUNCH_FRAME:
        return BUDDY_RELEASE_FRAME
    return frame - BUDDY_FREEZE_FRAMES


def motion_time(frame):
    return (motion_frame(frame) - CONTACT_FRAME) / FPS


def cf_position(t):
    if t <= CF_REACTION_S:
        return START["CF"]
    return travel(START["CF"], CATCH_POINT, CF_SPEED_UPS, t - CF_REACTION_S)


def lf_position(t):
    """Out to a decoy, then back toward the catch point: a bad route."""
    if t <= 0.4:
        return START["LF"]
    leg = math.dist(START["LF"], LF_DETOUR) / LF_SPEED_UPS
    if t - 0.4 <= leg:
        return travel(START["LF"], LF_DETOUR, LF_SPEED_UPS, t - 0.4)
    return travel(LF_DETOUR, CATCH_POINT, LF_SPEED_UPS, t - 0.4 - leg)


def batter_position(t):
    return travel(BATTER_START, BAGS["R1"], BATTER_SPEED_UPS, t)


def write_actor(block, base, address, position, index, character, *, frame):
    """Lay a fake actor struct into the state block, decoys and all."""
    off = address - base

    def put(rel, values):
        block[off + rel : off + rel + 4 * len(values)] = struct.pack(
            ">" + "f" * len(values), *values)

    struct.pack_into(">I", block, off, collector.FIELDER_VTABLE)
    # +0x04 is a PINNED assigned spot: it never moves, so a calibration that
    # simply takes the first plausible triple would pick it and find no motion.
    put(0x04, START.get("CF") if index is None else (0.0, 0.0, 0.0))
    put(0x10, (1.0, 1.0, 1.0))
    # +0x38 is the live position: the one that should win.
    put(0x38, position)
    # +0x50 TELEPORTS every frame -- a destination field, which is exactly the
    # shape of thing a continuity test exists to throw out.
    put(0x50, (40.0 * ((frame % 3) - 1), 0.0, 40.0 * ((frame % 5) - 2)))
    # +0x60 is out of any sane park bound.
    put(0x60, (1e6, -900.0, 5e5))
    block[off + 0x29] = index & 0xFF if index is not None else 0xFF
    block[off + 0x2B] = character


def build_session(directory: Path) -> Path:
    base = collector.STATE_BASE
    size = collector.STATE_SIZE
    stem = directory / "synthetic-20260101T000000Z"

    fielders = [{"name": n, "address": collector.OFFENSE_BASE and a, "stride":
                 collector.FIELDER_STRIDE}
                for n, a in zip(collector.POSITION_NAMES,
                                [0x900D9B1C + collector.FIELDER_STRIDE * i
                                 for i in range(9)])]
    offense = [{"name": n,
                "address": collector.OFFENSE_BASE + collector.OFFENSE_STRIDE * i,
                "stride": collector.OFFENSE_STRIDE}
               for i, n in enumerate(collector.OFFENSE_NAMES)]

    header = {
        "format": collector.FRAME_MAGIC.decode(),
        "park": "synthetic",
        "note": "generated by verify_player_metrics.py",
        "recorded_utc": "20260101T000000Z",
        "state_base": base,
        "state_size": size,
        "game_timer_address": collector.GAME_TIMER,
        "ball_offset": 0x558,
        "actor_fields": collector.ACTOR_FIELDS,
        "state_fields": [[n, a, f] for n, a, f in collector.STATE_FIELDS],
        "actors": {"fielders": fielders, "offense": offense},
        "stadium_byte": 2,
    }
    stem.with_suffix(".json").write_text(json.dumps(header, indent=2))

    compressor = zlib.compressobj(6)
    previous = bytes(size)
    with stem.with_suffix(".bin").open("wb") as sink:
        sink.write(collector.FRAME_MAGIC)
        for frame in range(REPLAY_END_FRAME + 30):
            t = motion_time(frame)
            block = bytearray(size)

            for actor in fielders:
                name = actor["name"]
                if frame < CONTACT_FRAME:
                    position = START[name]
                elif name == "CF":
                    position = cf_position(t)
                elif name == "LF":
                    position = lf_position(t)
                else:
                    position = START[name]
                write_actor(block, base, actor["address"], position,
                            INDICES[name], CHARACTERS[name], frame=frame)
                if name == "CF":
                    action = 0
                    if MISPLAY_START_FRAME <= frame <= MISPLAY_END_FRAME:
                        action = 2
                    elif HANDOFF_START_FRAME <= frame <= HANDOFF_END_FRAME:
                        action = 7
                    block[actor["address"] - base
                          + collector.ACTOR_FIELDS["bobble_flag"]] = action

            for actor in offense:
                name = actor["name"]
                if name == "BAT":
                    position = BATTER_START if frame < CONTACT_FRAME else batter_position(t)
                    index, character = 1, 56
                else:
                    position, index, character = BAGS[name], None, 40
                write_actor(block, base, actor["address"], position,
                            index, character, frame=frame)
                struct.pack_into(">I", block,
                                 actor["address"] - base, collector.OFFENSE_VTABLE)
                bases = (BATTER_BASES_RAN
                         if name == "BAT"
                         and BATTER_REACHED_FRAME <= frame < LIVE_END_FRAME
                         else 0)
                block[actor["address"] - base
                      + collector.ACTOR_FIELDS["bases_ran"]] = bases

            # The real game raises `ball_was_hit` a second time after the ball
            # is dead, to replay a home run or change innings, with the ball
            # wherever it came to rest. That looked like a second batted ball
            # and duplicated one play in four. Here the replay window is real,
            # so "exactly one play" below is a check rather than a formality.
            replay = REPLAY_START_FRAME <= frame < REPLAY_END_FRAME
            hit = 1 if (CONTACT_FRAME <= frame < PLAY_END_FRAME or replay) else 0
            if FIRST_TOUCH_FRAME <= frame < THROW_RELEASE_FRAME:
                holder = INDICES["CF"]
            elif THROW_ARRIVAL_FRAME <= frame < BUDDY_RELEASE_FRAME:
                holder = INDICES["SS"]
            elif frame >= BUDDY_ARRIVAL_FRAME:
                holder = INDICES["1B"]
            else:
                holder = -1
            # `game_state` is the live-ball flag the derivation windows every
            # play by, and fair/foul plus the home-run flag are the labels it
            # reads inside that window. The real game clears all three on the
            # frame the play closes, so they are written live-only here too --
            # a fixture that leaves them set past the play would not exercise
            # the boundary the derivation actually depends on.
            live = CONTACT_FRAME <= frame < LIVE_END_FRAME
            scalars = {
                0x900D5D97: 3, 0x900D5E25: 0, 0x900D5AA9: 1, 0x900D5AA8: 2,
                0x900D5AA7: 1, 0x900D6A94: hit, 0x900D66C9: holder & 0xFF,
                0x900D69EF: 56, 0x900DB5F9: 1,
                0x900D5C28: LIVE_GAME_STATE if live else 1,
                0x900D953C: 0,
            }
            # The caught-in-the-air call lands ON the catch, not at contact.
            # Traced in the real game, `fair_or_foul` reads 0 for the whole
            # flight and flips to 3 on the exact frame the ball is taken. It is
            # one of the two things that confirm possession, so setting it early
            # here would hand the derivation the answer before the catch and
            # hide the descent it is meant to see through.
            called_caught = live and frame >= FIRST_TOUCH_FRAME
            struct.pack_into(">h", block, 0x900D9516 - base,
                             FAIR_CAUGHT if called_caught else 0)
            # The three scalars that name a fielder by its index in the actor
            # table. They idle at -1 in the real game, and writing that here
            # matters: a zeroed region would name the pitcher on every frame.
            actor_order = list(collector.POSITION_NAMES)
            in_fielding_contact = (
                MISPLAY_START_FRAME <= frame <= MISPLAY_END_FRAME
                or HANDOFF_START_FRAME <= frame <= HANDOFF_END_FRAME)
            contact_actor = (actor_order.index("CF")
                             if in_fielding_contact else -1)
            struct.pack_into(">h", block, 0x900D9522 - base, contact_actor)
            struct.pack_into(">h", block, 0x900D9524 - base, contact_actor)
            if THROW_RELEASE_FRAME <= frame < THROW_ARRIVAL_FRAME:
                aimed_at = actor_order.index("SS")
            elif BUDDY_RELEASE_FRAME <= frame < BUDDY_ARRIVAL_FRAME:
                aimed_at = actor_order.index("1B")
            else:
                aimed_at = -1
            in_buddy = BUDDY_RELEASE_FRAME <= frame < BUDDY_ARRIVAL_FRAME
            struct.pack_into(">h", block, 0x900D951A - base, aimed_at)
            struct.pack_into(">h", block, 0x900D66D0 - base,
                             actor_order.index("SS") if in_buddy else -1)
            struct.pack_into(">h", block, 0x900D66CE - base,
                             actor_order.index("CF") if in_buddy else -1)
            for address, value in scalars.items():
                block[address - base] = value & 0xFF

            # The ball, in the BALL frame: z negated against the actor frame.
            # The calibration has to discover that rather than be told.
            if frame < FIRST_TOUCH_FRAME:
                # The ball arrives OVER the catch point before it arrives in the
                # glove: the last DESCENT_FRAMES are a vertical drop onto a
                # fielder already standing there. Its x and z match CF's exactly
                # for all of them while nobody is holding it, which is the shape
                # of a fly ball passing over an outfielder's head -- on the real
                # session that read as possession and turned three home runs
                # into catches.
                travel_frames = FIRST_TOUCH_FRAME - CONTACT_FRAME - DESCENT_FRAMES
                u = max(0.0, min(1.0, (frame - CONTACT_FRAME) / travel_frames))
                point = lerp((0.0, 1.0, 0.0), CATCH_POINT, u)
                apex = 1.0 + 18.0 * math.sin(0.8 * math.pi * u)
                drop = max(0.0, (frame - CONTACT_FRAME - travel_frames) / DESCENT_FRAMES)
                ball = (point[0], apex * (1.0 - drop) + CATCH_HEIGHT * drop, -point[2])
            elif frame < THROW_RELEASE_FRAME:
                point = cf_position(t)
                held_high = frame < FIRST_TOUCH_FRAME + CATCH_HOLD_FRAMES
                ball = (point[0], CATCH_HEIGHT if held_high else 1.2, -point[2])
            elif frame < THROW_ARRIVAL_FRAME:
                u = (frame - THROW_RELEASE_FRAME) / (THROW_ARRIVAL_FRAME - THROW_RELEASE_FRAME)
                point = lerp(CATCH_POINT, START["SS"], u)
                ball = (point[0], 1.2, -point[2])
            elif frame < BUDDY_RELEASE_FRAME:
                point = START["SS"]
                ball = (point[0], 1.2, -point[2])
            elif frame < BUDDY_LAUNCH_FRAME:
                # Bounced clear of the fielder and hanging there, unheld, for the
                # length of the cutscene.
                ball = (BUDDY_BOUNCE_POINT[0], BUDDY_BOUNCE_POINT[1],
                        -BUDDY_BOUNCE_POINT[2])
            elif frame < BUDDY_ARRIVAL_FRAME:
                u = (frame - BUDDY_LAUNCH_FRAME) / (BUDDY_ARRIVAL_FRAME - BUDDY_LAUNCH_FRAME)
                point = lerp(BUDDY_BOUNCE_POINT, START["1B"], u)
                ball = (point[0], 1.2, -point[2])
            else:
                point = START["1B"]
                ball = (point[0], 1.2, -point[2])

            delta = bytes(a ^ b for a, b in zip(block, previous))
            previous = bytes(block)
            record = (struct.pack(">IdI", frame + 1000, frame / FPS, 0x8131E064)
                      + struct.pack(">fff", *ball)
                      + struct.pack(">9I", *(a["address"] for a in fielders))
                      + delta)
            sink.write(compressor.compress(struct.pack(">I", len(record)) + record))
        sink.write(compressor.flush())
    return stem


def run(script: str, *args) -> str:
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / script), *args],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"{script} failed:\n{result.stdout}\n{result.stderr}")
    return result.stdout


def close(actual, expected, tolerance, label, failures):
    if actual is None:
        failures.append(f"{label}: got nothing, expected {expected}")
        return
    if abs(actual - expected) > tolerance:
        failures.append(f"{label}: got {actual:.4f}, expected {expected:.4f} "
                        f"+/- {tolerance}")
    else:
        print(f"  OK  {label:<34} {actual:8.4f}  (expected {expected:.4f})")


def verify_real_archive(failures: list) -> None:
    """Pin the labelled real-session contact classifications and play counts."""
    data = SCRIPTS.parent / "data" / "player_tracking"
    expected = {
        "wario_stadium-20260826T005958Z": 57,
        "bowser_castle-20260826T153516Z": 101,
        "mario_stadium-20260826T171346Z": 83,
        "daisy_cruiser-20260826T185635Z": 93,
        "peach_ice_garden-20260826T201820Z": 111,
    }
    sessions = {}
    contact_unknowns = []
    dive_resolved = []
    buddy_lead_ins = []
    for stem, count in expected.items():
        path = data / f"{stem}.plays.jsonl"
        if not path.exists():
            failures.append(f"real-session assertion file is missing: {path}")
            continue
        real_plays = [json.loads(line) for line in path.read_text().splitlines()]
        sessions[stem] = real_plays
        if len(real_plays) != count:
            failures.append(f"{stem} retained {len(real_plays)} plays, expected {count}")
        if any(play.get("truncated") or play.get("batted_ball_class") == "unknown"
               for play in real_plays):
            failures.append(f"{stem} retained an unknown or truncated play")
        for play in real_plays:
            for event in play.get("fielding_events", []):
                required = {"fielding_attempt", "ball_contact", "secured",
                            "mechanic", "official_error"}
                if not required <= event.keys():
                    failures.append(f"{stem} fielding event lacks fact fields: {event}")
                if event.get("official_error") is not None:
                    failures.append(f"{stem} inferred an official error from contact")
                if (event.get("event_type") == "fielding_action"
                        and event.get("ball_contact") == "unknown"):
                    contact_unknowns.append(event)
                if (event.get("contact_source")
                        == "dive_action_without_contact_actor"):
                    dive_resolved.append(event)
                if event.get("action_lead_in_frame") is not None:
                    buddy_lead_ins.append(event)
            if any(event.get("action_code") not in (2, 3)
                   for event in play.get("deflections", [])):
                failures.append(f"{stem} put a non-ordinary action in deflections")
            # Yoshi's egg (5) and Mario's fireball (4). Both are the BATTER's
            # star ball forcing a contact the fielder cannot hold, and nothing
            # else belongs in here.
            if any(event.get("action_code") not in FIELDING_ACTION_FORCED
                   for event in play.get("forced_misplays", [])):
                failures.append(f"{stem} mixed an ordinary action into forced contacts")
            if any(event.get("action_code") != 7
                   for event in play.get("buddy_handoffs", [])):
                failures.append(f"{stem} mixed a non-Buddy action into handoffs")
    if len(sessions) == len(expected):
        print(f"  OK  {'real-session play counts':<34} 57/101/83/93/111")
        print(f"  OK  {'real sessions fully classified':<34} no unknown/truncated")
        # THREE AMBIGUOUS ACTION-2 CONTACTS, AND THE ARCHIVE STILL HOLDS THREE.
        # One stays `unknown` -- Waluigi's 121-frame window at Mario Stadium,
        # which nothing that follows explains. The second is Waluigi's
        # ninth-inning dive at Bowser Castle, which the dive rule in
        # derive_player_metrics.py resolves to a miss: a dive that reached
        # within 6 units and made no contact is a miss, not an ambiguity. The
        # third is Toadsworth's, and it was never a contact at all -- it is the
        # single frame of misplay animation that opens a Buddy toss, folded
        # into the handoff it belongs to. Pinning the SUM rather than only the
        # unknowns keeps this check as strong as it was: a contact that quietly
        # stopped being seen at all would still fail it.
        if (len(contact_unknowns) != 1
                or any(event.get("action_code") != 2 for event in contact_unknowns)):
            failures.append("archive contact quarantine changed: expected one "
                            f"action-2 unknown, got {contact_unknowns}")
        elif len(dive_resolved) != 1:
            failures.append("the dive that resolves the second ambiguous contact is "
                            f"no longer resolved that way, got {dive_resolved}")
        elif len(buddy_lead_ins) != 1:
            failures.append("the Buddy-toss lead-in that resolves the third "
                            f"ambiguous contact is no longer folded in, got "
                            f"{buddy_lead_ins}")
        else:
            print(f"  OK  {'ambiguous contacts quarantined':<34} "
                  "1 action-2 unknown + 1 dive-resolved + 1 buddy lead-in")
            print(f"  OK  {'official errors remain separate':<34} all null")

        # The approach classification, pinned on the whole archive. The two
        # invariants are the reason a dive can be claimed at all: the airborne
        # flag accompanies EVERY leap and NO dive, so it was never the dive
        # signal, and 0x2AC is.
        approaches = [window for plays in sessions.values() for play in plays
                      for window in play.get("catch_approaches", [])]
        dives = [window for window in approaches if window["dive"]]
        leaps = [window for window in approaches if window["leap"]]
        if any(window["airborne_frames"] == 0 for window in leaps):
            failures.append("a leap was recorded with no airborne frame")
        if any(window["airborne_frames"] for window in dives):
            failures.append("a dive was recorded with an airborne frame, which "
                            "would mean 0x22E and 0x2AC disagree")
        if len(dives) != 89 or len(leaps) != 23:
            failures.append(f"archive approach counts changed: {len(dives)} "
                            f"dives, {len(leaps)} leaps, expected 89 and 23")
        elif not failures:
            print(f"  OK  {'dives separated from leaps':<34} 89 dives, 23 leaps")
            print(f"  OK  {'airborne flag is a leap, not a dive':<34} 23/23 and 0/89")
            # Most dives never reach the ball, so they raise no fielding event
            # and were invisible before the approach window was recorded.
            reached = sum(1 for plays in sessions.values() for play in plays
                          for event in play.get("fielding_events", [])
                          if event.get("dive"))
            print(f"  OK  {'dives that never touched the ball':<34} "
                  f"{len(dives) - reached}/{len(dives)}")

    peach = sessions.get("peach_ice_garden-20260826T201820Z", [])
    by_contact = {play["contact_timer"]: play for play in peach}
    for timer in (40241, 142324):
        play = by_contact.get(timer)
        if not play or not any(event.get("by") == "2B"
                               and event.get("ball_contact") == "confirmed"
                               for event in play.get("deflections", [])):
            failures.append(f"Ice Garden {timer} long dive was not confirmed")
    miss_play = by_contact.get(160922)
    miss_events = (miss_play.get("fielding_events", []) if miss_play else [])
    if (not any(event.get("by") == "3B"
                and event.get("ball_contact") == "missed"
                for event in miss_events)
            or any(event.get("by") == "3B"
                   for event in (miss_play or {}).get("deflections", []))):
        failures.append("Ice Garden 160922 unrelated action was not a clean miss")
    buddy_throws = [throw for play in peach for throw in play.get("throws", [])
                    if throw.get("buddy_throw")]
    handoffs = [event for play in peach for event in play.get("buddy_handoffs", [])]
    # Counted by code rather than by length: the same list now also carries
    # Mario's fireball, so a total would move the moment the session is
    # re-derived and would be asserting the code's shape rather than the game's.
    eggs = [event for play in peach for event in play.get("forced_misplays", [])
            if event.get("action_code") == FIELDING_ACTION_YOSHI_EGG]
    if len(buddy_throws) != 5 or len(handoffs) != 7:
        failures.append(f"Ice Garden Buddy counts changed: "
                        f"{len(handoffs)} handoffs, {len(buddy_throws)} throws")
    if len(eggs) != 4:
        failures.append(f"Ice Garden egg-contact count changed: {len(eggs)}")
    if len([event for play in peach for event in play.get("deflections", [])]) != 14:
        failures.append("Ice Garden actor-confirmed boot count changed from 14")
    if peach and not failures:
        print(f"  OK  {'long dives confirmed outside radius':<34} 2/2")
        print(f"  OK  {'unrelated action excluded':<34} frame 160922")
        print(f"  OK  {'Buddy/egg mechanisms isolated':<34} 7/5 and 4")


def verify_capture_round_trip(failures: list) -> None:
    """Write a frame the way the collector does and read it back.

    The barrel added a second captured region and changed the size of every
    frame, and the synthetic session elsewhere in this file still writes the old
    single-region shape -- so nothing was actually exercising the new format. A
    bug in it does not fail loudly; it costs a whole recorded game.
    """
    import tempfile
    import zlib
    barrel_offset = collector.CAPTURE_SIZE - 0x200 + (
        collector.BARREL_POSITION - 0x92AF5400)
    with tempfile.TemporaryDirectory() as tmp:
        stem = Path(tmp) / "dk_jungle-ROUNDTRIP"
        actors = {
            "fielders": [
                {"name": n, "address": collector.STATE_BASE + 0x5000 + i * collector.FIELDER_STRIDE,
                 "stride": collector.FIELDER_STRIDE}
                for i, n in enumerate(collector.POSITION_NAMES)],
            "offense": [
                {"name": n, "address": collector.STATE_BASE + 0x6000 + i * 468, "stride": 468}
                for i, n in enumerate(["BAT", "R1", "R2", "R3"])],
        }
        stem.with_suffix(".json").write_text(json.dumps({
            "format": collector.FRAME_MAGIC.decode(), "park": "dk_jungle",
            "recorded_utc": "ROUNDTRIP", "ball_offset": 0x720,
            "state_base": collector.STATE_BASE, "state_size": collector.STATE_SIZE,
            "extra_regions": [[n, b, sz] for n, b, sz in collector.EXTRA_REGIONS],
            "capture_size": collector.CAPTURE_SIZE,
            "barrel_position": collector.BARREL_POSITION,
            "barrel_cannons": [list(c) for c in collector.BARREL_CANNONS],
            "actor_fields": collector.ACTOR_FIELDS,
            "state_fields": [[n, a, f] for n, a, f in collector.STATE_FIELDS],
            "actors": actors,
        }))
        compressor = zlib.compressobj()
        previous = bytes(collector.CAPTURE_SIZE)
        with stem.with_suffix(".bin").open("wb") as sink:
            sink.write(collector.FRAME_MAGIC)
            for i in range(40):
                block = bytearray(collector.CAPTURE_SIZE)
                position = (collector.BARREL_CANNONS[0] if i < 10
                            else (-30.0 + i * 1.5, 1.8, -70.0))
                block[barrel_offset:barrel_offset + 12] = struct.pack(">fff", *position)
                delta = bytes(a ^ b for a, b in zip(block, previous))
                previous = bytes(block)
                record = (struct.pack(">IdI", 1000 + i, i / 60, 0x8000)
                          + struct.pack(">fff", 0.0, 1.0, -18.6)
                          + struct.pack(">9I", *([0] * 9)) + delta)
                sink.write(compressor.compress(struct.pack(">I", len(record)) + record))
            sink.write(compressor.flush())

        session = io.Session(stem)
        builder = io.session_snapshot_builder(session, position_offset=4)
        live = parked = 0
        for frame in session.frames():
            if len(frame.block) != collector.CAPTURE_SIZE:
                failures.append(
                    f"capture round trip: frame is {len(frame.block)} bytes, "
                    f"expected {collector.CAPTURE_SIZE}")
                return
            barrel = builder.build(frame.timer, frame.ball, frame.block).get("barrel")
            if barrel is None:
                failures.append("capture round trip: no barrel in the snapshot")
                return
            live, parked = (live + 1, parked) if barrel["live"] else (live, parked + 1)
        if (parked, live) != (10, 30):
            failures.append(
                f"capture round trip: expected 10 parked / 30 live, got {parked}/{live}")
        else:
            print(f"  OK  {'capture format round trip':<34} "
                  f"{collector.CAPTURE_SIZE} B/frame, barrel readable")


def verify_knockdown_flag(failures: list) -> None:
    """The knockdown flag against annotations, with a no-gimmick control.

    Two claims, both from sessions already on disk. At Wario City the flag has
    three onsets in a whole game and all three fall inside the two windows the
    operator annotated as manhole knockdowns -- two of them together, which is
    what they meant by "it did it twice to koopa troopa".

    THE CONTROL USED TO BE "MARIO STADIUM NEVER FIRES IT", AND THAT WAS WRONG.
    It was pinned to one 33-play session that happened to contain no Wario at
    all, so it was measuring a Wario-free game rather than a gimmick-free park.
    On 2026-09-04 the same park fired it twice, and the operator had annotated
    both while they happened: "it was the wario phony swing bomb that stunned
    waluigi" and "dixie gets stunnned by the phony swing bomb". The flag is not
    only a park hazard -- Wario's Phony Swing plants a bomb in the ball, and it
    floors whoever fields it.

    So the control is now the sharper claim, over every Mario Stadium session on
    disk rather than one: at the one park with no gimmicks at all, the flag
    fires ONLY inside a Wario plate appearance. That still says the flag is not
    noise -- it fires for a named cause and for nothing else in hundreds of
    plays -- and unlike the old version it cannot pass by accident.
    """
    def onsets(name, offset=0x23F):
        stem = Path("data/player_tracking") / name
        if not stem.with_suffix(".bin").exists():
            return None
        session = io.Session(stem)
        starts = {f["name"]: f["address"] - session.state_base
                  for f in session.fielders}
        out = {n: [] for n in starts}
        up = {n: False for n in starts}
        for frame in session.frames():
            for who, start in starts.items():
                now = bool(frame.block[start + offset])
                if now and not up[who]:
                    out[who].append(frame.timer)
                up[who] = now
        return out

    wario = onsets("wario_city-20260902T135123Z")
    if wario is None:
        print(f"  --  {'knockdown flag vs annotations':<34} session not on disk")
        return
    total = sum(len(v) for v in wario.values())
    # PA8 and PA81, both right field, both annotated as manhole hits.
    inside = [t for t in wario["RF"] if 6552 <= t <= 6552 + 700 or 78781 <= t <= 78781 + 700]
    if len(inside) < 3:
        failures.append(
            f"knockdown flag: expected 3 onsets in the annotated manhole windows, "
            f"got {len(inside)}")
    elif total != len(inside):
        failures.append(
            f"knockdown flag fired {total - len(inside)} times outside the two "
            f"annotated manhole windows at Wario City")
    else:
        print(f"  OK  {'knockdown vs manhole annotations':<34} "
              f"{len(inside)}/{total} onsets inside both windows")

    data = Path("data/player_tracking")
    fired = charged_to_wario = plays_seen = sessions_seen = 0
    stray = []
    for path in sorted(data.glob("mario_stadium-*.plays.jsonl")):
        stem = path.name[: -len(".plays.jsonl")]
        control = onsets(stem)
        if control is None:
            continue
        sessions_seen += 1
        plays = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        plays_seen += len(plays)
        # The plate appearance an onset falls in. `dead_ball_timer` closes the
        # play, so a flag raised between plays belongs to neither and shows up
        # as a stray, which is what a noise flag would look like.
        windows = [(play["contact_timer"], play.get("dead_ball_timer"), play.get("batter"))
                   for play in plays if play.get("contact_timer") is not None]
        for timers in control.values():
            for timer in timers:
                fired += 1
                batter = next((who for start, end, who in windows
                               if end is not None and start <= timer <= end), None)
                if batter == "Wario":
                    charged_to_wario += 1
                else:
                    stray.append((stem, timer, batter))
    if not sessions_seen:
        return
    if not fired:
        failures.append(
            "knockdown control: no Mario Stadium session on disk fires the flag at "
            "all, so the control proves nothing -- it needs a session with Wario in it")
    elif stray:
        detail = ", ".join(f"{stem}@{timer} ({who or 'between plays'})"
                           for stem, timer, who in stray[:4])
        failures.append(
            f"knockdown flag fired {len(stray)} times at Mario Stadium outside a Wario "
            f"plate appearance, and the park has no gimmicks: {detail}")
    else:
        print(f"  OK  {'knockdown control: Wario bomb only':<34} "
              f"{charged_to_wario}/{fired} onsets in Wario PAs, {plays_seen} plays")


def verify_close_play_flag(failures: list) -> None:
    """The close-play flag against an annotation written before it was found.

    `yoshi_park-20260830T235406Z` was captured and annotated by hand a week
    before +0x246 was located -- "it was a close play sequence... bowser jr
    bowled over the 3b to knock it out of their hands" -- so the label cannot
    have been fitted to it. The flag has to fire exactly once in the session, on
    the THIRD BASEMAN, inside that plate appearance, and carry value 2, which is
    the runner winning.

    The control is the other half and matters more: Mario Stadium has no close
    play in any annotation, and the flag has to be silent there for the whole
    session. A byte that fires on ordinary fielding would pass the first test
    and fail this one.
    """
    def onsets(name, offset=0x246):
        stem = Path("data/player_tracking") / name
        if not stem.with_suffix(".bin").exists():
            return None
        session = io.Session(stem)
        starts = {f["name"]: f["address"] - session.state_base
                  for f in session.fielders}
        out = []
        up = {n: 0 for n in starts}
        for frame in session.frames():
            for who, start in starts.items():
                now = frame.block[start + offset]
                if now and not up[who]:
                    out.append((frame.timer, who, now))
                up[who] = now
        return out

    labelled = onsets("yoshi_park-20260830T235406Z")
    if labelled is None:
        print(f"  --  {'close play vs annotation':<34} session not on disk")
        return
    # PA37, contact 40387, annotated as a close play at third.
    inside = [row for row in labelled if 40387 <= row[0] <= 40387 + 900]
    if len(labelled) != 1 or len(inside) != 1:
        failures.append(
            f"close-play flag: expected exactly 1 onset inside the annotated "
            f"window, got {len(inside)} inside and {len(labelled)} in the session")
    elif inside[0][1] != "3B":
        failures.append(
            f"close-play flag fired on {inside[0][1]}, but the operator wrote "
            f"that the third baseman was bowled over")
    elif inside[0][2] != 2:
        failures.append(
            f"close-play flag carried value {inside[0][2]} on a play the runner "
            f"won; 2 is the runner knocking the ball loose")
    else:
        print(f"  OK  {'close play vs annotation':<34} "
              f"1/1 at 3B, value 2 (runner won)")

    control = onsets("mario_stadium-20260904T000419Z")
    if control is None:
        return
    if control:
        detail = ", ".join(f"{who}@{timer}" for timer, who, _ in control[:4])
        failures.append(
            f"close-play control: the flag fired {len(control)} times at Mario "
            f"Stadium, where no close play is annotated: {detail}")
    else:
        print(f"  OK  {'close play control: silent':<34} "
              f"0 onsets, no annotated close play")


def verify_flower_gas(failures: list) -> None:
    """The flower flag against annotations written before it was found.

    This is the strongest test in this file, because none of it is synthetic:
    `dk_jungle-20260902T171957Z` was captured and annotated by hand a day before
    +0x242 was located, so the labels cannot have been fitted to it. The flag has
    to fire at all four flower sprays the operator wrote down, at neither barrel
    hit, and on two fielders at once for the play they described that way.
    """
    stem = Path("data/player_tracking/dk_jungle-20260902T171957Z")
    if not stem.with_suffix(".bin").exists():
        print(f"  --  {'flower gas vs annotations':<34} session not on disk")
        return
    session = io.Session(stem)
    offsets = {f["name"]: f["address"] - session.state_base
               + session.fields["flower_gas_flag"] for f in session.fielders}
    up = {name: False for name in offsets}
    onsets = {name: [] for name in offsets}
    for frame in session.frames():
        for name, offset in offsets.items():
            value = bool(frame.block[offset])
            if value and not up[name]:
                onsets[name].append(frame.timer)
            up[name] = value

    # frame, fielder, and whether the operator called it a flower
    labelled = [(5406, "CF", True), (10904, "CF", True), (22861, "CF", True),
                (68122, "RF", True), (37591, "CF", False), (42863, "CF", False)]
    for frame, who, is_flower in labelled:
        fired = [t for t in onsets[who] if frame <= t <= frame + 700]
        if is_flower and not fired:
            failures.append(
                f"flower flag missed the annotated spray at frame {frame} ({who})")
        elif not is_flower and fired:
            failures.append(
                f"flower flag fired at the annotated BARREL at frame {frame} ({who})")
    # The operator wrote that two fielders were sprayed on this play.
    both = [n for n, times in onsets.items()
            if any(10904 <= t <= 10904 + 700 for t in times)]
    if len(both) < 2:
        failures.append(
            f"the two-fielder spray at frame 10904 fired on {both}, expected two")
    if not failures:
        print(f"  OK  {'flower gas vs annotations':<34} "
              f"4/4 sprays, 0/2 barrels, 2 at once")


def verify_barrel_events(failures: list) -> None:
    """DK Jungle's barrel: one run, the right cannon, the right victim.

    Synthetic frames rather than a recorded session, because the barrel was
    located after the last capture and nothing on disk contains one. The point
    is the classification logic, which is what would silently rot: a barrel that
    crosses the outfield and passes through the centre fielder must produce one
    event, from the cannon it was sitting in, hitting CF and not RF.
    """
    def frame(t, timer, barrel, live, cannon, cf, rf):
        return {
            "t": t, "timer": timer,
            "barrel": {"pos": barrel, "raw": barrel, "live": live, "cannon": cannon},
            "actors": {"CF": {"kind": "fielder", "pos": cf},
                       "RF": {"kind": "fielder", "pos": rf}},
        }

    frames = []
    for i in range(3):
        frames.append(frame(i / 60, 100 + i, (-39.0, 4.0, 93.5), False, "left",
                            (0.0, 0.0, 70.0), (30.0, 0.0, 60.0)))
    for i in range(20):
        frames.append(frame((3 + i) / 60, 103 + i, (-30.0 + i * 1.6, 1.8, 70.0),
                            True, None, (0.0, 0.0, 70.0), (30.0, 0.0, 60.0)))
    # ...and the fielder is moved after closest approach, which is the
    # independent corroboration that the contact was real.
    for i in range(20, 30):
        frames.append(frame((3 + i) / 60, 103 + i, (-30.0 + i * 1.6, 1.8, 70.0),
                            True, None, (0.0, 0.0, 70.0 + (i - 20) * 0.4),
                            (30.0, 0.0, 60.0)))

    events = derive.detect_barrel_events(frames, 0.0, 99.0, park="dk_jungle")
    if len(events) != 1:
        failures.append(f"expected one barrel run, got {len(events)}")
        return
    event = events[0]
    if event["hit_fielders"] != ["CF"]:
        failures.append(f"barrel should have hit CF alone, got {event['hit_fielders']}")
    elif event["from_cannon"] != "left":
        failures.append(f"barrel should be from the left cannon, got {event['from_cannon']}")
    else:
        cf = next(a for a in event["approaches"] if a["by"] == "CF")
        if cf["fielder_moved_units_after"] <= 0:
            failures.append("a hit fielder should be measured moving afterwards")
        else:
            print(f"  OK  {'barrel hit isolated to one fielder':<34} "
                  f"CF at {cf['closest_units']}u, moved "
                  f"{cf['fielder_moved_units_after']}u")

    # A park with no barrel, and every session recorded before the barrel
    # regions existed, must produce nothing rather than a guess. Still asked
    # AS DK Jungle, so this tests the absence of barrel data and not the park
    # gate below -- otherwise the gate would answer both and neither would be
    # checked.
    bare = [{"t": i / 60, "timer": i,
             "actors": {"CF": {"kind": "fielder", "pos": (0.0, 0.0, 70.0)}}}
            for i in range(10)]
    if derive.detect_barrel_events(bare, 0.0, 99.0, park="dk_jungle"):
        failures.append("a session with no barrel captured produced barrel events")
    else:
        print(f"  OK  {'no barrel captured, no events':<34} pre-barrel sessions")

    # THE PARK GATE. The capture reads the barrel slot at every park, and in a
    # park without cannons that slot holds whatever that park put there -- never
    # a cannon sentinel, so "away from both sentinels" is true on every frame.
    # mario_stadium-20260904T000419Z reported a barrel parked 0.6 units from the
    # catcher on all 92 plays because nothing checked the park. The same frames
    # that make one event at DK Jungle must make none anywhere else.
    for park in (None, "mario_stadium", "wario_city"):
        if derive.detect_barrel_events(frames, 0.0, 99.0, park=park):
            failures.append(f"barrel events produced for park={park!r}")
            break
    else:
        print(f"  OK  {'barrel gated to DK Jungle':<34} "
              f"same frames, 0 events elsewhere")

    # The knockdown flag outranks the provisional radius WHENEVER IT WAS
    # CAPTURED. `knockdowns={}` means captured and did not fire, which is a
    # measurement saying no; it used to be falsy and fall through to the radius,
    # which is how 58 phantom hits were charged off a distance nobody measured.
    quiet = derive.detect_barrel_events(frames, 0.0, 99.0, knockdowns={},
                                        park="dk_jungle")
    if not quiet:
        failures.append("the barrel run vanished when the knockdown flag was captured")
    elif quiet[0]["hit_fielders"]:
        failures.append("a barrel hit was charged with the knockdown flag silent: "
                        f"{quiet[0]['hit_fielders']}")
    elif quiet[0]["approaches"][0]["hit_source"] != "knockdown_flag":
        failures.append("the captured knockdown flag did not become the hit source")
    else:
        print(f"  OK  {'knockdown flag outranks the radius':<34} "
              f"captured-and-silent charges no hit")


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        stem = build_session(Path(tmp))
        print(f"synthetic session at {stem.name}\n")

        print(run("calibrate_player_tracking.py", str(stem)))
        calibration = json.loads(Path(str(stem) + ".calibration.json").read_text())
        print(run("derive_player_metrics.py", str(stem)))
        plays = [json.loads(line) for line in
                 Path(str(stem) + ".plays.jsonl").read_text().splitlines()]

    failures = []
    print("checks")

    expected_stadiums = {
        0: "mario_stadium", 1: "bowser_castle", 2: "wario_city",
        3: "yoshi_park", 4: "peach_ice_garden", 5: "dk_jungle",
        6: "luigis_mansion", 7: "daisy_cruiser",
        8: "bowser_jr_playroom",
    }
    if collector.STADIUM_BYTE_TO_PARK != expected_stadiums:
        failures.append(
            f"stadium-byte map is {collector.STADIUM_BYTE_TO_PARK}, "
            f"expected game menu order {expected_stadiums}")
    else:
        print(f"  OK  {'automatic stadium detection':<34} all 9 parks")

    if calibration["position_offset"] != 0x38:
        failures.append(
            f"calibration picked +0x{calibration['position_offset']:03X}, "
            "expected +0x038 (the only field that both moves and stays continuous)")
    else:
        print(f"  OK  {'live position offset':<34}   +0x038")

    frame_fit = calibration["ball_frame"]
    if frame_fit.get("sign_z") != -1.0 or frame_fit.get("swap_xz"):
        failures.append(f"ball-frame fit came back {frame_fit}, expected z negated")
    else:
        print(f"  OK  {'ball frame z sign':<34}        -1")
    # The calibration now selects on how many frames an actor stood exactly on
    # the ball, rather than on a residual. CF carries it for the last 120 frames
    # of the synthetic play, so a correct run has to find roughly that many.
    locks = frame_fit.get("lock_frames", 0)
    if locks < 100:
        failures.append(f"ball-lock count was {locks}, expected ~120 "
                        "(CF holds the ball for the last 2 seconds)")
    else:
        print(f"  OK  {'ball-lock frames':<34} {locks:8d}  (expected ~120)")

    if len(plays) != 1:
        failures.append(f"expected exactly 1 play, got {len(plays)}")
    else:
        play = plays[0]
        cf = play["fielders"]["CF"]
        lf = play["fielders"]["LF"]
        close(cf.get("reaction_s"), CF_REACTION_S, 0.03, "CF reaction", failures)
        close(cf.get("sprint_speed_ups"), CF_SPEED_UPS, 0.15, "CF sprint speed", failures)
        close(cf.get("route_efficiency"), 1.0, 0.02, "CF route efficiency", failures)
        close(cf.get("path_units"),
              math.dist(START["CF"][::2], CATCH_POINT[::2]), 0.4,
              "CF distance covered", failures)
        if not cf.get("fielded"):
            failures.append("CF should be marked as the fielder who took possession")
        else:
            print(f"  OK  {'CF credited with the putout':<34}")

        # LF never reaches the catch point -- the ball goes dead while it is
        # still on the second leg -- so the expectation is built from where LF
        # actually got to, not from where it was heading. It stops at the LIVE
        # boundary, which is 20 frames before `ball_was_hit` drops.
        end_t = motion_time(LIVE_END_FRAME - 1)
        lf_end = lf_position(end_t)
        leg_one = math.dist(START["LF"][::2], LF_DETOUR[::2])
        expected_lf = (math.dist(START["LF"][::2], lf_end[::2])
                       / (leg_one + math.dist(LF_DETOUR[::2], lf_end[::2])))
        close(lf.get("route_efficiency"), expected_lf, 0.03,
              "LF route efficiency", failures)

        # The live boundary itself. Everything else on this play is windowed by
        # it, so an error here is an error in all of them: measured against the
        # real game it once ranged from 0.48s to 11.21s on a 3-to-10s play.
        # Wall-clock, not the motion clock: the ball is live through the frozen
        # cutscene even though nobody moves during it.
        close(play.get("live_s"), (LIVE_END_FRAME - 1 - CONTACT_FRAME) / FPS,
              0.05, "live play length", failures)
        if play.get("batted_ball_class") != "fair_caught":
            failures.append(
                "batted ball class: got "
                f"{play.get('batted_ball_class')!r}, expected 'fair_caught'")
        else:
            print(f"  OK  {'batted ball class':<34} fair_caught")

        close(play.get("home_to_first_s"),
              math.dist(BATTER_START[::2], BAGS["R1"][::2]) / BATTER_SPEED_UPS,
              0.03, "home to first", failures)
        close(play["first_touch"]["t"] if play.get("first_touch") else None,
              (FIRST_TOUCH_FRAME - CONTACT_FRAME) / FPS, 0.05,
              "hang time to first touch", failures)
        close(play["first_touch"].get("ball_height_units") if play.get("first_touch") else None,
              CATCH_HEIGHT, 0.2, "catch height", failures)
        # The ball was caught, so it never reached the ground and the
        # opportunity is measured to the glove. A landing here would mean the
        # detector fired on the descent and every catch-probability feature
        # would be measured to the wrong point.
        if play.get("landing") is not None:
            failures.append(f"a caught ball reported a landing at "
                            f"{play['landing']['t']}s")
        elif not play.get("caught_in_flight"):
            failures.append("a caught ball was not marked caught in flight")
        else:
            print(f"  OK  {'caught in flight, never landed':<34}")
        close(play.get("hang_time_s"), (FIRST_TOUCH_FRAME - CONTACT_FRAME) / FPS,
              0.05, "hang time", failures)
        cf_opportunity = play["fielders"]["CF"]
        close(cf_opportunity.get("distance_to_landing_units"),
              math.dist(START["CF"][::2], CATCH_POINT[::2]), 0.2,
              "CF distance to the ball", failures)
        deflections = play.get("deflections", [])
        handoffs = play.get("buddy_handoffs", [])
        if len(deflections) != 1 or deflections[0].get("action_code") != 2:
            failures.append("fielding action 2 was not the one confirmed "
                            f"deflection: {deflections}")
        else:
            print(f"  OK  {'misplay enum separated':<34} action 2")
        if len(handoffs) != 1 or handoffs[0].get("action_code") != 7:
            failures.append("fielding action 7 was not retained as a separate "
                            f"Buddy handoff: {handoffs}")
        else:
            print(f"  OK  {'Buddy handoff not a boot':<34} action 7")
        if play.get("after_deflection"):
            failures.append("a fielder recovering their own boot was called a "
                            "rebound catch by someone else")
        close(play["runners"]["BAT"].get("sprint_speed_ups"), BATTER_SPEED_UPS,
              0.15, "batter sprint speed", failures)
        reached = play["runners"]["BAT"].get("bases_ran")
        if reached != BATTER_BASES_RAN:
            failures.append(f"batter bases_ran read {reached}, expected "
                            f"{BATTER_BASES_RAN} -- the count was sampled after "
                            "the offense actors were recycled")
        else:
            print(f"  OK  {'bases_ran read before recycle':<34} "
                  f"{BATTER_BASES_RAN} base")

        detected_throws = play.get("throws", [])
        if len(detected_throws) != 2:
            failures.append("expected a CF-to-SS throw and an SS-to-1B Buddy "
                            f"Throw, got {len(detected_throws)}")
        else:
            throw, buddy = detected_throws
            if throw.get("thrower_position") != "CF" or throw.get("receiver_position") != "SS":
                failures.append(f"throw endpoints were {throw.get('thrower_position')} -> "
                                f"{throw.get('receiver_position')}, expected CF -> SS")
            else:
                print(f"  OK  {'thrower and receiver':<34}      CF -> SS")
            expected_mps = math.dist(CATCH_POINT, START["SS"])
            close(throw.get("peak_speed_mps"), expected_mps, 0.5,
                  "throw velocity", failures)
            if throw.get("buddy_throw"):
                failures.append("the CF-to-SS throw was called a Buddy Throw")
            if throw.get("intended_target_position") != "SS":
                failures.append("the CF-to-SS throw was aimed at "
                                f"{throw.get('intended_target_position')!r}, expected 'SS'")
            else:
                print(f"  OK  {'throw aimed at':<34}          SS")

            # The Buddy Throw. Its velocity has to be measured from the LAUNCH,
            # not from the release a second earlier -- reading it from the whole
            # release-to-arrival span would report a third of the real speed --
            # and it has to be marked, because it is not one fielder's arm.
            if not buddy.get("buddy_throw"):
                failures.append("the SS-to-1B throw was not recognised as a "
                                "Buddy Throw, so its speed would count as an arm")
            else:
                print(f"  OK  {'Buddy Throw recognised':<34}      SS -> 1B")
            close(buddy.get("buddy_freeze_s"), BUDDY_FREEZE_FRAMES / FPS, 0.05,
                  "Buddy Throw freeze", failures)
            named = (buddy.get("buddy_thrower_position"),
                     buddy.get("buddy_partner_position"),
                     buddy.get("intended_target_position"))
            if named != ("SS", "CF", "1B"):
                failures.append("the Buddy Throw scalars resolved to "
                                f"{named}, expected ('SS', 'CF', '1B')")
            else:
                print(f"  OK  {'Buddy Throw scalars':<34} SS + CF -> 1B")
            buddy_frames = BUDDY_ARRIVAL_FRAME - BUDDY_LAUNCH_FRAME
            close(buddy.get("peak_speed_mps"),
                  math.dist(BUDDY_BOUNCE_POINT, START["1B"]) / (buddy_frames / FPS),
                  1.0, "Buddy Throw velocity", failures)

        idle = [n for n, f in play["fielders"].items()
                if n not in ("CF", "LF") and f["path_units"] > 0.5]
        if idle:
            failures.append(f"fielders that never moved reported motion: {idle}")
        else:
            print(f"  OK  {'stationary fielders read as still':<34}")

    # Daisy Cruiser proved that a normal failure has two animation codes and
    # Yoshi's egg uses a third, forced-failure code. Pin those semantics without
    # making the already dense end-to-end fixture manufacture three batted
    # balls.
    action_frames = []
    for index in range(36):
        action = 3 if 8 <= index <= 12 else 5 if 20 <= index <= 24 else 0
        action_frames.append({
            "t": index / FPS,
            "timer": index,
            "ball": (0.02 * index, 1.0, 0.0),
            "state": {
                "contact_fielder": 0 if action else -1,
                "last_contact_fielder": 0 if action else -1,
            },
            "actors": {"2B": {
                # The tracked centre is five units from the ball: outside the
                # old radius, but the game's contact actor names this fielder.
                "kind": "fielder", "pos": (0.02 * index + 5.0, 0.0, 0.0),
                "character": 2,
                "fielding_action": action,
                "airborne": 1 if index == 10 else 0,
                "contact_counter": index - 7 if 8 <= index <= 12 else 0,
            }, "3B": {
                # Same action-3 attempt, 5u from the ball, with no contact-actor
                # transition. This is the Ice Garden Shy Guy control.
                "kind": "fielder", "pos": (0.02 * index - 4.4, 0.0, 0.0),
                "character": 16,
                "fielding_action": 3 if 8 <= index <= 12 else 0,
                "airborne": 1 if index == 10 else 0,
                "contact_counter": 0,
            }},
        })
    code_three = detect_deflections(action_frames, 0.0, 1.0, None)
    code_five = detect_forced_misplays(action_frames, 0.0, 1.0, None)
    if len(code_three) != 1 or code_three[0].get("action_code") != 3:
        failures.append(f"fielding action 3 was not retained as an ordinary "
                        f"misplay: {code_three}")
    else:
        print(f"  OK  {'second misplay enum retained':<34} action 3")
    if len(code_five) != 1 or code_five[0].get("action_code") != 5:
        failures.append(f"fielding action 5 was not separated as Yoshi egg: "
                        f"{code_five}")
    else:
        print(f"  OK  {'Yoshi egg separated':<34} action 5")
    attempt_events = detect_fielding_action_events(
        action_frames, 0.0, 1.0, None, 3)
    contact = next((event for event in attempt_events if event["by"] == "2B"), None)
    miss = next((event for event in attempt_events if event["by"] == "3B"), None)
    if (not contact or contact.get("ball_contact") != "confirmed"
            or contact.get("distance_units", 0) <= 3.0):
        failures.append(f"contact actor did not confirm the action-3 contact: {contact}")
    else:
        print(f"  OK  {'contact actor confirms boot':<34} action 3")
    if (not miss or miss.get("ball_contact") != "missed"
            or any(event.get("by") == "3B" for event in code_three)):
        failures.append(f"distant action-3 attempt was not preserved as a miss: {miss}")
    else:
        print(f"  OK  {'unrelated action preserved as miss':<34} action 3")

    # A real signature is 2.5s sampled four times a second, so these fixtures
    # are the same shape. The cut replay is the Ice Garden ninth-inning case:
    # identical for five samples, then the game ends the replay early and parks
    # the ball at its reset position for the rest of the window.
    flight = ((0.0, 1.0, -1.0), (2.0, 4.0, -8.0), (4.0, 6.0, -16.0),
              (6.0, 7.0, -24.0), (8.0, 7.0, -32.0), (10.0, 6.0, -40.0),
              (12.0, 4.0, -48.0))
    parked = (0.0, 0.0, -18.6)
    cut_flight = flight[:5] + (parked, parked)
    other_flight = flight[:3] + ((9.0, 2.0, -30.0), (14.0, 1.0, -38.0),
                                 (19.0, 0.5, -46.0), (23.0, 0.0, -53.0))
    replay_base = {
        "inning": 3, "inning_half": 0, "outs": 1, "balls": 0,
        "strikes": 0, "batter_id": 3, "batter_index": 4,
        "batted_ball_class": "fair_in_play", "contact_timer": 1000,
        "swing_timer": 998, "pitch_release_timer": 947, "live_s": 4.0,
        "contact_at": [-0.764, 1.177, -1.341],
        "landing": {"t": 0.4004, "at": [-2.729, 0.291, -15.357]},
        "_trajectory_signature": flight,
    }
    replay_copy = dict(replay_base, contact_timer=1500)
    cut_replay = dict(replay_base, contact_timer=1600,
                      batted_ball_class="unknown",
                      _trajectory_signature=cut_flight)
    # Wario City's ninth-inning close-play replay stopped the live phase after
    # 0.734s: only three quarter-second samples agree before the ball resets.
    # Exact contact/landing geometry and pitch/swing leads identify that short
    # copy without weakening the ordinary five-sample threshold.
    short_replay = dict(replay_base, contact_timer=1650, swing_timer=1648,
                        pitch_release_timer=1597, live_s=0.7341,
                        _trajectory_signature=flight[:3] + (parked, parked))
    # Same batter and count, but the ball goes somewhere else after three
    # samples. Three-quarters of a second of agreement is not a replay.
    near_miss = dict(replay_base, contact_timer=1700,
                     _trajectory_signature=other_flight)
    unique = dict(replay_base, batter_index=5, contact_timer=1750)
    # Identical trajectory, but far enough past the original that the plate
    # appearance genuinely came around again.
    late = dict(replay_base, contact_timer=1000 + round(FPS * 20) + 1)
    deduped, removed = remove_replay_duplicates(
        [replay_base, replay_copy, cut_replay, short_replay, near_miss, unique, late], FPS)
    survivors = [play.get("contact_timer") for play in deduped]
    if removed != 3 or survivors != [1000, 1700, 1750, 2201]:
        failures.append(f"replay suppression removed {removed} and kept "
                        f"{survivors}, expected 3 and [1000, 1700, 1750, 2201]")
    else:
        print(f"  OK  {'ordinary replay suppression':<34} 2 copies")
        print(f"  OK  {'subsecond replay suppression':<34} 3 samples + landmarks")
        print(f"  OK  {'divergent ball kept':<34} 3 samples")
        print(f"  OK  {'replay window respected':<34} 20.0 s")

    complete_final_catch = {
        "situation": {"outs": 2},
        "live_flags": [(FAIR_CAUGHT_FLAG, 0)],
    }
    incomplete_catch = {
        "situation": {"outs": 1},
        "live_flags": [(FAIR_CAUGHT_FLAG, 0)],
    }
    if (not is_complete_third_out_catch(complete_final_catch)
            or is_complete_third_out_catch(incomplete_catch)):
        failures.append("terminal third-out catch recognition failed")
    else:
        print(f"  OK  {'terminal third-out catch':<34}")

    home_run_frames = [{
        "actors": {"BAT": {"index": 0, "bases_ran": 1}},
    }]
    if final_bases_ran(home_run_frames, "BAT") != 1:
        failures.append("ordinary bases_ran measurement was not preserved")
    elif final_bases_ran(
            home_run_frames, "BAT", over_fence_home_run=True) != 4:
        failures.append("over-the-fence home run did not advance the runner home")
    else:
        print(f"  OK  {'home-run advancement override':<34} home")

    verify_capture_round_trip(failures)
    verify_barrel_events(failures)
    verify_flower_gas(failures)
    verify_knockdown_flag(failures)
    verify_close_play_flag(failures)
    verify_real_archive(failures)

    if failures:
        print("\nFAILED")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
