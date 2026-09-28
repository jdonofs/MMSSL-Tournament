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
import replay_player_tracking as replay_session
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


def verify_flat_ball_address(failures: list) -> None:
    """The fixed ball address must agree with the pointer-resolved feed.

    WHY THIS CHECK EXISTS RATHER THAN A SWITCH. The live feed reads the ball
    through BALL_POINTER_SLOT plus a coordinate offset chosen per stadium load,
    and when that offset goes stale it does not error -- it writes zeroes, for a
    whole session, silently. io.BALL_POSITION_FLAT needs no offset and no
    pointer, so it can retire that whole failure mode, but it may only do so
    once it has been shown to agree at every park rather than at the one it was
    found on.

    It does: over 4.17M frames across 66 sessions and 10 parks it matches the
    pointer feed with z negated on 99.991% of frames, never matches without the
    negation, and fails to match on 0.009%. This walks a couple of sessions so
    that a regression in either feed is caught here instead of in a game.
    """
    data = SCRIPTS.parent / "data" / "player_tracking"
    stems = ["mario_stadium-20260826T171346Z", "daisy_cruiser-20260826T185635Z"]
    agree = disagree = 0
    for stem in stems:
        if not (data / f"{stem}.bin").exists():
            continue
        session = io.Session(data / stem)
        base = session.state_base
        flat_at = io.BALL_POSITION_FLAT - base
        for index, frame in enumerate(session.frames()):
            if index >= 4000:
                break
            raw = struct.unpack(
                ">fff", frame.block[flat_at:flat_at + 12])
            pointer = frame.ball
            if not any(abs(v) > 1e-6 for v in pointer):
                continue
            if (abs(raw[0] - pointer[0]) < 0.01
                    and abs(raw[1] - pointer[1]) < 0.01
                    and abs(raw[2] + pointer[2]) < 0.01):
                agree += 1
            else:
                disagree += 1
    total = agree + disagree
    if not total:
        print(f"  --  {'flat ball address':<34} no sessions on disk")
        return
    rate = agree / total
    if rate < 0.99:
        failures.append(
            f"the fixed ball address 0x{io.BALL_POSITION_FLAT:08X} agreed with "
            f"the pointer-resolved feed on only {rate:.3%} of {total} frames")
    else:
        print(f"  OK  {'flat ball address vs pointer feed':<34} "
              f"{rate:.3%} of {total} frames, z negated")


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

    THE REGION ORDER IS PART OF THE FORMAT. Every region is found by counting
    past the ones before it, so appending one moves nothing and inserting one
    moves everything after it. This check caught exactly that when the Freezie
    region was added, and it is why the offsets here are computed rather than
    written down.
    """
    import tempfile
    import zlib
    # Via the reader's own helper, not arithmetic that assumes the barrel's
    # region is the last one. It was, until Peach's Freezies were appended after
    # it, and the hardcoded version then wrote the barrel into the wrong region
    # and reported 40 parked barrels out of 40.
    barrel_offset = io.capture_offset(
        collector.BARREL_POSITION, collector.STATE_BASE, collector.STATE_SIZE,
        collector.EXTRA_REGIONS)
    train_offset = io.capture_offset(
        collector.YOSHI_TRAIN_POSITION, collector.STATE_BASE, collector.STATE_SIZE,
        collector.EXTRA_REGIONS)
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
            "yoshi_train_position": collector.YOSHI_TRAIN_POSITION,
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
                train_position = (-40.0 + i, 0.0, -90.0)
                block[train_offset:train_offset + 12] = struct.pack(
                    ">fff", *train_position)
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
            train = builder.build(frame.timer, frame.ball, frame.block).get("train")
            if barrel is None:
                failures.append("capture round trip: no barrel in the snapshot")
                return
            expected_train = (-40.0 + (frame.timer - 1000), 0.0, -90.0)
            if train is None or tuple(train.get("pos") or ()) != expected_train:
                failures.append(
                    f"capture round trip: train position {train} != {expected_train}")
                return
            live, parked = (live + 1, parked) if barrel["live"] else (live, parked + 1)
        if (parked, live) != (10, 30):
            failures.append(
                f"capture round trip: expected 10 parked / 30 live, got {parked}/{live}")
        else:
            print(f"  OK  {'capture format round trip':<34} "
                  f"{collector.CAPTURE_SIZE} B/frame, barrel + train readable")


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

    ...AND "ONLY WARIO" WAS THE SAME MISTAKE ONE STEP LATER. Wario was simply
    the only captain batting in the session the rule was written against. Every
    captain's star swing floors fielders -- Jason names Birdo, DK and Bowser Jr.
    among them -- and on 2026-09-22 Luigi's swing floored Kritter at second in
    game 2947, which the Wario rule read as an unexplained onset at a park that
    cannot produce one.

    So the control is the claim underneath both versions, over every Mario
    Stadium session on disk: at the one park with no gimmicks at all, every
    onset falls inside a plate appearance whose BATTER IS THE CAPTAIN THE GAME'S
    OWN FLAG NAMES. That is stronger than either predecessor -- it ties the raw
    byte to the derived attribution rather than to a cast list -- and it says
    the flag is not noise, because a noise onset lands between plays or under a
    batter who never swung.
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
    fired = charged_to_captain = plays_seen = sessions_seen = 0
    stray = []
    captains = set()
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
        windows = [(play["contact_timer"], play.get("dead_ball_timer"), play.get("batter"), play)
                   for play in plays if play.get("contact_timer") is not None]
        for who, timers in control.items():
            for timer in timers:
                fired += 1
                window = next((w for w in windows
                               if w[1] is not None and w[0] <= timer <= w[1]), None)
                batter = window[2] if window else None
                # The derived record for THIS onset -- same fielder, same frame
                # -- and the captain its star-swing flag names. An onset the
                # derivation left unnamed is a stray too: the park has nothing
                # else that floors a fielder, so a nameless one is a cause
                # nobody has found yet.
                record = next((entry for entry in (window[3].get("knockdowns") or [])
                               if entry.get("by") == who and entry.get("frame") == timer),
                              None) if window else None
                captain = record.get("star_swing_captain") if record else None
                if captain is not None and batter == captain:
                    charged_to_captain += 1
                    captains.add(captain)
                else:
                    stray.append((stem, timer, batter, captain))
    if not sessions_seen:
        return
    if not fired:
        failures.append(
            "knockdown control: no Mario Stadium session on disk fires the flag at all, "
            "so the control proves nothing -- it needs a session with a captain star swing")
    elif stray:
        detail = ", ".join(
            f"{stem}@{timer} (batter {who or 'between plays'}, flag names {captain or 'nobody'})"
            for stem, timer, who, captain in stray[:4])
        failures.append(
            f"knockdown flag fired {len(stray)} times at Mario Stadium where the batter is "
            f"not the captain the flag names, and the park has no gimmicks: {detail}")
    else:
        print(f"  OK  {'knockdown control: batter is captain':<34} "
              f"{charged_to_captain}/{fired} onsets, {len(captains)} captains "
              f"({', '.join(sorted(captains))}), {plays_seen} plays")

    # AND NOW THE CAUSE IS NAMED, not merely implied by who was batting. Wario's
    # bomb is his captain star swing, and the game's own flag (0x900D954A) says
    # so on the play. A park with no gimmicks has nothing else that floors a
    # fielder, so every knockdown recorded there has to come out named
    # star_swing -- one that does not is either a missed flag or a second cause
    # nobody has found, and both are worth failing on.
    knocks = named_star = 0
    unnamed = []
    for path in sorted(data.glob("mario_stadium-*.plays.jsonl")):
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            play = json.loads(line)
            for knock in play.get("knockdowns") or []:
                knocks += 1
                if knock.get("hazard") == "star_swing":
                    named_star += 1
                else:
                    unnamed.append((path.name[: -len(".plays.jsonl")],
                                    play.get("contact_timer"), play.get("batter")))
    if unnamed:
        detail = ", ".join(f"{stem}@{timer} ({who})" for stem, timer, who in unnamed[:4])
        failures.append(
            f"{len(unnamed)} of {knocks} Mario Stadium knockdowns are not named as a "
            f"star swing, at a park with no other cause: {detail}")
    elif knocks:
        print(f"  OK  {'knockdown cause: star swing':<34} "
              f"{named_star}/{knocks} Mario Stadium knockdowns named from the flag")


def verify_arrow_redirects(failures: list) -> None:
    """Wario City arrow redirects against the operator's own annotations.

    THE GROUND TRUTH IS THE PROSE, not a threshold. An annotation whose note
    says the ball hit an arrow is a positive; a detection in a session with no
    such note anywhere near it is a false positive to be explained, not
    averaged away. Four sessions, two variants, 23 labelled events.
    """
    data = Path("data/player_tracking")
    found = missed = extra = 0
    per_session = []
    for header_path in sorted(data.glob("wario_city-*.json")):
        stem = header_path.name[: -len(".json")]
        plays_path = data / f"{stem}.plays.jsonl"
        notes_path = data / f"{stem}.annotations.jsonl"
        if not plays_path.exists() or not notes_path.exists():
            continue
        # A CONTROL SAYS THE ARROW DID NOTHING, which is the opposite of what
        # this list is for. Matching on the word "arrow" alone counted the
        # 2026-09-10 controls as redirects that went undetected and failed the
        # whole check -- a label asserting "no redirect here" was being read as
        # "a redirect here". Structured labels are honoured where they exist;
        # prose still falls back to the word, which is all the older sessions
        # have.
        labelled = []
        controls = []
        for line in notes_path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            note = json.loads(line)
            timer = note.get("play_contact_timer")
            if timer is None:
                continue
            event = note.get("stadium_event") or {}
            objective = (event.get("objective_id") or "").lower()
            if objective:
                if objective not in ("directional_arrow_redirect", "arrow_redirect"):
                    continue
                (controls if event.get("is_control") else labelled).append(timer)
            elif "arrow" in (note.get("note") or "").lower():
                labelled.append(timer)
        plays = [json.loads(line) for line in
                 plays_path.read_text(encoding="utf8").splitlines() if line.strip()]
        detected = [(play.get("contact_timer"), redirect)
                    for play in plays
                    for redirect in (play.get("arrow_redirects") or [])]
        hit = sum(1 for timer in labelled
                  if any(0 <= frame - timer <= 900 for frame, _ in
                         [(r["frame"], r) for _, r in detected]))
        # AN UNANNOTATED DETECTION IS NOT AUTOMATICALLY A FALSE POSITIVE, and
        # treating it as one was wrong: once the operator was satisfied the
        # arrows worked he stopped writing them down, and 2026-09-10 flagged one
        # of its five. What makes a detection sound is EVIDENCE, and there are
        # two independent kinds -- the operator's note, and the object itself.
        # A redirect matched to a captured arrow has had its bearing checked
        # against that arrow's own heading to within half a degree at 2-5 units,
        # which is a stronger statement than a human remembering to type.
        #
        # So a detection has to carry one or the other. One carrying NEITHER is
        # the real failure, and this still catches it.
        unexplained = [r for _, r in detected
                       if not any(0 <= r["frame"] - timer <= 900 for timer in labelled)
                       and not r.get("arrow")]
        corroborated = sum(1 for _, r in detected
                           if r.get("arrow")
                           and not any(0 <= r["frame"] - timer <= 900 for timer in labelled))
        # And a control has to hold: a labelled "the arrow did not fire here"
        # play with a detected redirect on it means one of the two is wrong.
        # ON THAT PLAY, not within 900 frames of it. The loose window is there
        # because an operator annotates a redirect some seconds after seeing it;
        # a control carries the play's own contact timer, and 900 frames is 15
        # seconds, which reaches into the NEXT plate appearance -- it flagged
        # contact 64978 against a redirect belonging to the play after it.
        for timer in controls:
            if any(contact == timer for contact, _ in detected):
                failures.append(
                    f"{stem}: contact {timer} is labelled as an arrow CONTROL "
                    "but a redirect was detected on that play")
        found += hit
        missed += len(labelled) - hit
        extra += len(unexplained)
        per_session.append(f"{stem[11:19]} {hit}/{len(labelled)}"
                           + (f"+{corroborated}obj" if corroborated else ""))
        for redirect in unexplained:
            failures.append(
                f"{stem}: arrow redirect detected at frame {redirect['frame']} "
                "with neither an operator annotation nor a matching arrow object")
    if not per_session:
        print(f"  OK  {'arrow redirects':<34} no derived Wario City sessions")
        return
    # 22 of 23. The 23rd is 20260902 PA55, whose own note says a buddy attack
    # took the ball before it got away: zero frames of outgoing travel, so
    # there is no outgoing direction to measure. See ARROW_HOLD_FRAMES.
    if missed > 1:
        failures.append(
            f"{missed} annotated Wario City arrow redirects were not detected "
            f"(expected at most 1, the zero-travel one) -- {' '.join(per_session)}")
    elif extra:
        failures.append(f"{extra} arrow redirects with no evidence of any kind")
    else:
        print(f"  OK  {'arrow redirects vs annotations':<34} "
              f"{found}/{found + missed} labelled, 0 unexplained  "
              + " ".join(per_session))


def verify_arrow_night_multiplier(failures: list) -> None:
    """The night arrow is exactly 2.25x the day one, and both are measured."""
    day = derive.arrow_imposed_step_units(False)
    night = derive.arrow_imposed_step_units(True)
    if abs(night / day - 2.25) > 1e-9:
        failures.append(f"night/day imposed step is {night / day}, expected 2.25")
        return
    data = Path("data/player_tracking")
    seen = {"day": [], "night": []}
    for header_path in sorted(data.glob("wario_city-*.json")):
        stem = header_path.name[: -len(".json")]
        plays_path = data / f"{stem}.plays.jsonl"
        if not plays_path.exists():
            continue
        header = json.loads(header_path.read_text())
        variant = "night" if header.get("is_night") else "day"
        for line in plays_path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            for redirect in (json.loads(line).get("arrow_redirects") or []):
                seen[variant].append(redirect["imposed_step_units"])
    for variant, target in (("day", day), ("night", night)):
        for value in seen[variant]:
            if abs(value - target) > derive.ARROW_STEP_TOLERANCE_UNITS:
                failures.append(
                    f"a {variant} redirect imposed {value} u/frame, "
                    f"outside {target} +- {derive.ARROW_STEP_TOLERANCE_UNITS}")
                return
    if not seen["day"] or not seen["night"]:
        print(f"  OK  {'arrow night multiplier':<34} "
              f"2.25x (only one variant derived)")
        return
    print(f"  OK  {'arrow night multiplier':<34} "
          f"2.25x exactly; {len(seen['day'])} day + {len(seen['night'])} night "
          f"redirects all on their variant's constant")


def verify_arrow_park_gate(failures: list) -> None:
    """No other park produces a redirect, whatever its ball does."""
    data = Path("data/player_tracking")
    strays = []
    checked = 0
    for plays_path in sorted(data.glob("*.plays.jsonl")):
        if plays_path.name.startswith("wario_city-"):
            continue
        checked += 1
        for line in plays_path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            play = json.loads(line)
            if play.get("arrow_redirects"):
                strays.append(f"{plays_path.name} contact {play.get('contact_timer')}")
    if strays:
        failures.append("arrow redirects reported outside Wario City: "
                        + ", ".join(strays[:5]))
    else:
        print(f"  OK  {'arrow gate: Wario City only':<34} "
              f"0 redirects across {checked} other sessions")


def verify_manhole_attribution(failures: list) -> None:
    """Every Wario City knockdown is on a manhole; no other park names one.

    THE CONTROL IS THE POINT. A fielder standing on a manhole is not knocked
    down -- the operator's account is that it only erupts on some plays -- so
    this measures whether the FLOORED ones are on a manhole, never whether being
    near one predicts anything.
    """
    data = Path("data/player_tracking")
    wario_total = wario_named = 0
    distances = []
    unnamed_distances = []
    star_named = 0
    strays = []
    for plays_path in sorted(data.glob("*.plays.jsonl")):
        wario = plays_path.name.startswith("wario_city-")
        for line in plays_path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            for knock in (json.loads(line).get("knockdowns") or []):
                named = knock.get("hazard") == "manhole_water"
                if wario:
                    wario_total += 1
                    wario_named += named
                    if named:
                        distances.append(knock["manhole_distance_units"])
                    elif knock.get("hazard") == "star_swing":
                        # Named by its own evidence -- the captain star-swing
                        # flag -- so how far it sat from a manhole says nothing
                        # about the manhole radius.
                        star_named += 1
                    elif knock.get("manhole_distance_units") is not None:
                        unnamed_distances.append(knock["manhole_distance_units"])
                elif named:
                    strays.append(plays_path.name)
    if strays:
        failures.append("manhole named outside Wario City: "
                        + ", ".join(sorted(set(strays))[:4]))
        return
    if not wario_total:
        print(f"  OK  {'manhole attribution':<34} no derived Wario City sessions")
        return
    # NOT EVERY WARIO CITY KNOCKDOWN IS A MANHOLE, and asserting so was wrong.
    # The 2026-09-10 game floored three fielders with the ball 3.4-3.9u UP and
    # never touched -- all three on Luigi plate appearances, while 29 closer
    # passes by other batters floored nobody. They sit 29-35u from any manhole.
    #
    # So the claim this check can actually make is about the GAP: a knockdown
    # the radius declined must be nowhere near a manhole. One landing just
    # outside the radius would mean the radius is wrong, and that is the thing
    # worth failing on -- not the existence of a second cause.
    margin = 2 * derive.MANHOLE_KNOCKDOWN_RADIUS_UNITS
    borderline = [d for d in unnamed_distances if d <= margin]
    if borderline:
        failures.append(
            f"{len(borderline)} Wario City knockdown(s) went unattributed while sitting "
            f"within {margin:.0f}u of a manhole ({min(borderline):.2f}u closest) -- "
            "the attribution radius may be wrong")
        return
    print(f"  OK  {'manhole attribution':<34} {wario_named}/{wario_total} Wario "
          f"knockdowns on a manhole ({min(distances):.2f}-{max(distances):.2f}u), "
          f"0 named elsewhere"
          + (f"; {star_named} captain star swing" if star_named else "")
          + (f"; {len(unnamed_distances)} unnamed at {min(unnamed_distances):.0f}-"
             f"{max(unnamed_distances):.0f}u" if unnamed_distances else ""))


def verify_yoshi_pipes(failures: list) -> None:
    """Yoshi Park's reviewed pipe transits and stuns, with nothing elsewhere.

    The transits are the operator's own, 08-31T03 PA1 ("the pirhanna plant in the
    pipe ate the ball and brought it to a new pipe") and PA28. The stuns are the
    09-11 left fielder's dive and Petey Piranha walking into the right-centre
    pipe with the ball. The 09-11T19 transit was not annotated, but the operator
    reviewed that test and confirmed unannotated train/pipe detections were real.
    """
    data = Path("data/player_tracking")
    expected_transits = {
        ("yoshi_park-20260831T031212Z", 1652): ("right_centre", "left_centre"),
        ("yoshi_park-20260831T031212Z", 28773): ("right_field_line", "third_base_foul"),
        ("yoshi_park-20260911T193733Z", 120753): ("right_centre", "first_base_foul"),
        # Day pipe: held beside the LF-line pipe, carried in a perfectly
        # straight 43-frame run, then emitted beside the RF-line pipe.
        ("yoshi_park-20260911T203017Z", 25233): ("left_field_line", "right_field_line"),
        # The confirmed night capture: the plant carried the ball from right
        # centre and spat it beside third, flooring the waiting third baseman.
        ("yoshi_park-20260912T143842Z", 23645): ("right_centre", "third_base_foul"),
    }
    expected_stuns = {
        ("yoshi_park-20260911T164801Z", 64054): ("LF", "left_field_line", True),
        ("yoshi_park-20260831T134815Z", 2385): ("RF", "right_centre", False),
        # Both carry the same 1.5s impact-stun flag at a surveyed pipe: King
        # Boo ran into right-centre, then later dove into the RF-line pipe.
        ("yoshi_park-20260911T203017Z", 51857): ("RF", "right_centre", False),
        ("yoshi_park-20260911T203017Z", 70095): ("RF", "right_field_line", True),
    }
    transits, stuns, strays = {}, {}, []
    for plays_path in sorted(data.glob("*.plays.jsonl")):
        stem = plays_path.name[: -len(".plays.jsonl")]
        for line in plays_path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            play = json.loads(line)
            for transit in play.get("pipe_transits") or []:
                transits[(stem, play["contact_timer"])] = (
                    transit["entry_pipe"], transit["exit_pipe"])
            for stun in play.get("pipe_stuns") or []:
                stuns[(stem, stun["frame"])] = (stun["by"], stun["pipe"], stun["dive"])
            if not stem.startswith("yoshi_park-") and (
                    play.get("pipe_transits") or play.get("pipe_stuns")):
                strays.append(stem)
    if strays:
        failures.append("pipe event outside Yoshi Park: " + ", ".join(sorted(set(strays))[:4]))
        return
    derived = {path.name[: -len(".plays.jsonl")] for path in data.glob("yoshi_park-*.plays.jsonl")}
    for label, expected, found in (("transit", expected_transits, transits),
                                   ("stun", expected_stuns, stuns)):
        wanted = {key: value for key, value in expected.items() if key[0] in derived}
        if found != wanted:
            missing = {k: v for k, v in wanted.items() if found.get(k) != v}
            extra = {k: v for k, v in found.items() if wanted.get(k) != v}
            failures.append(f"pipe {label}s: missing {missing}, unexpected {extra}")
            return
    print(f"  OK  {'yoshi pipes':<34} {len(transits)} transit(s), {len(stuns)} pipe "
          f"stun(s) across {len(derived)} derived Yoshi Park session(s), 0 elsewhere")


def verify_yoshi_piranha_knockdowns(failures: list) -> None:
    """All three reviewed plant hits are named, with every other play a control."""
    expected = {
        ("yoshi_park-20260831T031212Z", 1834): ("RF", "eat", "right_centre"),
        ("yoshi_park-20260831T031212Z", 1974): ("LF", "spit", "left_centre"),
        ("yoshi_park-20260912T143842Z", 23967): ("3B", "spit", "third_base_foul"),
    }
    found, strays = {}, []
    for stem, plays in _plays_by_stem().items():
        for play in plays:
            for knock in play.get("knockdowns") or []:
                if knock.get("hazard") != "piranha_plant":
                    continue
                if not stem.startswith("yoshi_park-"):
                    strays.append((stem, knock.get("frame")))
                found[(stem, knock["frame"])] = (
                    knock["by"], knock.get("piranha_phase"), knock.get("pipe"))
    if strays:
        failures.append(f"Piranha Plant knockdown outside Yoshi Park: {strays[:4]}")
        return
    derived = set(_plays_by_stem("yoshi_park-"))
    wanted = {key: value for key, value in expected.items() if key[0] in derived}
    if found != wanted:
        missing = {key: value for key, value in wanted.items() if found.get(key) != value}
        extra = {key: value for key, value in found.items() if wanted.get(key) != value}
        failures.append(f"Piranha Plant knockdowns: missing {missing}, unexpected {extra}")
        return
    distances = [
        knock["ball_distance_units"]
        for plays in _plays_by_stem("yoshi_park-").values()
        for play in plays for knock in play.get("knockdowns") or []
        if knock.get("hazard") == "piranha_plant"
    ]
    print(f"  OK  {'yoshi Piranha knockdowns':<34} {len(found)}/{len(wanted)} reviewed hits "
          f"at {min(distances):.2f}-{max(distances):.2f}u from the held ball, 0 extras")


def _plays_by_stem(prefix: str = "") -> dict:
    data = Path("data/player_tracking")
    out = {}
    for plays_path in sorted(data.glob(f"{prefix}*.plays.jsonl")):
        out[plays_path.name[: -len(".plays.jsonl")]] = [
            json.loads(line) for line in plays_path.read_text(encoding="utf8").splitlines()
            if line.strip()]
    return out


def verify_throw_aim(failures: list) -> None:
    """An inaccurate throw lands away from the game's own aim point.

    The five annotated bad-chemistry throws must all be off target. The control
    is Wario to King K. Rool (bowser_jr_playroom 08-28 contact 332152): K. Rool
    was 2.2u off home, so `receiver_pulled_off_base` fires, but the ball landed
    0.06u from where it was aimed -- he was not on the plate, the throw was fine.
    """
    annotated = {
        ("yoshi_park-20260911T164801Z", 19244, 1), ("yoshi_park-20260830T235406Z", 31720, 2),
        ("yoshi_park-20260831T140742Z", 43701, 2), ("bowser_jr_playroom-20260828T155225Z", 239226, 1),
        ("bowser_castle-20260828T182145Z", 57618, 2),
    }
    control = ("bowser_jr_playroom-20260828T155225Z", 332152, 2)
    throws, total = {}, 0
    for stem, plays in _plays_by_stem().items():
        for play in plays:
            for throw in play.get("throws") or []:
                if "off_target" not in throw:
                    continue
                throws[(stem, play["contact_timer"], throw["sequence"])] = throw
                total += bool(throw["off_target"])
    judged = [key for key in annotated if key in throws]
    if not judged:
        print(f"  OK  {'throw aim point':<34} no session derived with aim points yet")
        return
    missed = [key for key in judged if not throws[key]["off_target"]]
    if missed:
        failures.append(f"annotated inaccurate throws not off target: {missed}")
        return
    if control in throws and throws[control]["off_target"]:
        failures.append("Wario -> King K. Rool called off target; it landed on its aim point")
        return
    print(f"  OK  {'throw aim point':<34} {len(judged)}/{len(judged)} annotated throws off target, "
          f"control on target; {total} off target in {len(throws)} throws")


def verify_yoshi_train(failures: list) -> None:
    """Every annotated train hit is named; nothing else and nowhere else is.

    Ten knockdowns in yoshi_park-20260911T164801Z were annotated as the train.
    The night game's two Piranha Plant hits (08-31T03 frames 1834 and 1974) sit
    20-28u inside the fence and must stay unnamed by this rule.
    """
    labelled = {("yoshi_park-20260911T164801Z", frame) for frame in
                (38797, 54112, 54192, 67840, 70628, 74862, 74942, 80275, 80355, 94058)}
    piranha = {("yoshi_park-20260831T031212Z", 1834), ("yoshi_park-20260831T031212Z", 1974)}
    named, strays = set(), []
    for stem, plays in _plays_by_stem().items():
        for play in plays:
            for knock in play.get("knockdowns") or []:
                if knock.get("hazard") != "train":
                    continue
                if not stem.startswith("yoshi_park-"):
                    strays.append(stem)
                named.add((stem, knock["frame"]))
    if strays:
        failures.append("train named outside Yoshi Park: " + ", ".join(sorted(set(strays))[:4]))
        return
    derived = set(_plays_by_stem("yoshi_park-"))
    missing = {key for key in labelled if key[0] in derived} - named
    if missing:
        failures.append(f"annotated train knockdowns not named: {sorted(missing)}")
        return
    if named & piranha:
        failures.append(f"Piranha Plant knockdowns named as the train: {sorted(named & piranha)}")
        return
    print(f"  OK  {'yoshi train':<34} {len(labelled)}/{len(labelled)} annotated hits named, "
          f"{len(named)} train knockdowns in all, 0 elsewhere, piranha hits untouched")


def verify_yoshi_train_ball_hits(failures: list) -> None:
    """The reviewed collisions remain distinct from wall, catch and dead-ball motion."""
    # THE FRAME IS THE LAST ONE ON THE INCOMING PATH -- the frame whose position
    # the record carries. f74886 reads (-23.014, 1.209, -91.130), byte-identical
    # to PA77's recorded `at`, and the step INTO f74887 is the changed one (jolt
    # 0.128 against 0.0001 on every neighbouring frame). This expectation said
    # 74887 while pairing it with 74886's coordinates, and it only ever matched
    # because the loose-ball gate was discarding the true candidate: a ball
    # knocked out of a glove files no throw, so nothing marked it loose until a
    # knockdown of the holder counted as a release (2026-09-11). Naming 74887
    # also mixed pre- and post-impact frames into the incoming speed, ~3.8 u/s
    # against the measured 1.275.
    expected = {
        ("yoshi_park-20260911T164801Z", 74573, 74886),
        ("yoshi_park-20260911T193733Z", 148599, 148773),
    }
    derived_stems = set(_plays_by_stem("yoshi_park-"))
    found, outside = set(), []
    for stem, plays in _plays_by_stem().items():
        for play in plays:
            for hit in play.get("train_ball_hits") or []:
                if not stem.startswith("yoshi_park-"):
                    outside.append((stem, hit.get("frame")))
                found.add((stem, play.get("contact_timer"), hit.get("frame")))
                inside = hit.get("fence_inside_units")
                height = hit.get("height_units")
                if inside is None or inside < derive.TRAIN_BALL_MIN_INSIDE_UNITS:
                    failures.append(f"{stem}: train-ball hit is on/past the wall: {hit}")
                    return
                if height is None or height > derive.TRAIN_BALL_MAX_HEIGHT_UNITS:
                    failures.append(f"{stem}: train-ball hit is above the train: {hit}")
                    return
    if outside:
        failures.append(f"train-ball hit reported outside Yoshi Park: {outside[:4]}")
        return
    available_expected = {entry for entry in expected if entry[0] in derived_stems}
    missing = available_expected - found
    if missing:
        failures.append(f"reviewed train-ball hits not detected: {sorted(missing)}")
        return
    false_controls = {
        # Train crossed a ball that Tiny Kong had already secured; it did not
        # move the ball. The dead-ball transition used to look like a reversal.
        ("yoshi_park-20260911T203017Z", 28389, 28859),
        # The left-field wall/foul pole, which protrudes inside the surveyed
        # fence line, turned this ball without the train touching it.
        ("yoshi_park-20260911T203017Z", 87032, 87185),
    }
    false_found = false_controls & found
    if false_found:
        failures.append(f"train-ball false controls detected: {sorted(false_found)}")
        return

    labelled = _plays_by_stem("yoshi_park-20260911T164801Z").get(
        "yoshi_park-20260911T164801Z", [])
    pa77 = next((play for play in labelled if play.get("contact_timer") == 74573), None)
    loose = next((throw for throw in (pa77 or {}).get("throws", [])
                  if throw.get("release_frame") == 74862), None)
    if (loose is None or loose.get("is_throw") is not False
            or loose.get("event_type") != "knocked_loose"
            or loose.get("knocked_loose_by") != "train"):
        failures.append(f"PA77 train knock-loose still classified as a throw: {loose}")
        return
    print(f"  OK  {'yoshi train hits ball':<34} {len(available_expected)}/{len(available_expected)} "
          f"reviewed impacts; PA77 knock-loose is not a throw")


def verify_bowser_castle_fires(failures: list) -> None:
    """The centre-field statue's fire and the falling lava, told apart by position.

    Both write +0x23E and both run 89-91 frames, so duration cannot separate
    them: the statue had to be surveyed. Six burns land within 0.60u of a flat
    front at z=-88.3 spanning x -10..10, 11u in front of the centre-field fence,
    and every other burn is 19.28u or further from it. Jason labelled one of
    each live on 2026-09-05 -- "the fire of the bowser statue in cf" and "the
    falling lava".
    """
    labelled = {
        ("bowser_castle-20260905T005948Z", 62354): "statue_fire",
        ("bowser_castle-20260905T005948Z", 77527): "falling_lava",
    }
    # `burned` is not cleared when the sides change. This run began with three
    # outs already recorded and stayed up through the intermission, by which
    # point the slot held the other team's player (character 42 -> 56 at
    # f44501). It must be dropped and say why, not called lava.
    latched = ("bowser_castle-20260826T153516Z", 44418)
    named, discarded, strays = {}, {}, []
    for stem, plays in _plays_by_stem().items():
        for play in plays:
            for fire in play.get("fire_hazards") or []:
                key = (stem, fire.get("frame"))
                if not stem.startswith("bowser_castle-"):
                    strays.append(stem)
                if fire.get("hazard"):
                    named[key] = fire["hazard"]
                else:
                    discarded[key] = fire.get("discarded")
    if strays:
        failures.append("fire hazards named outside Bowser Castle: "
                        + ", ".join(sorted(set(strays))[:4]))
        return
    derived = set(_plays_by_stem("bowser_castle-"))
    for key, hazard in labelled.items():
        if key[0] not in derived:
            continue
        if named.get(key) != hazard:
            failures.append(
                f"annotated {hazard} at {key} came back {named.get(key)!r} "
                "(regenerate the Bowser Castle plays files if this is a stale archive)")
            return
    if latched[0] in derived:
        if named.get(latched) is not None:
            failures.append(f"the latched burn at {latched} was named {named[latched]!r}")
            return
        if discarded.get(latched) != "flag_outlived_the_side_change":
            failures.append(f"the latched burn at {latched} was not recorded as "
                            f"discarded: {discarded.get(latched)!r}")
            return
    statue = sum(1 for hazard in named.values() if hazard == "statue_fire")
    lava = sum(1 for hazard in named.values() if hazard == "falling_lava")
    print(f"  OK  {'bowser castle fires':<34} {statue} statue / {lava} lava, "
          f"both labelled cases named, latched burn dropped")


def verify_bob_omb_bombs(failures: list) -> None:
    """King Bob-omb's bomb, named from the knockdown flag's own phases.

    Value 1 for exactly 40 frames and then value 2 -- the shape at all three
    labelled bombs. The controls are the Bowser Castle onsets that never reach
    value 2 (single runs of 34-127 frames, which no annotation covers and which
    floor fielders who are not in the play), and Donkey Kong's star swing, whose
    shape matches the bomb's exactly but whose cause the star-swing flag already
    named.
    """
    labelled = {("bowser_castle-20260905T005948Z", frame)
                for frame in (33839, 36879, 68063)}
    single_phase = {("bowser_castle-20260826T153516Z", 5270),
                    ("bowser_castle-20260826T153516Z", 56266),
                    ("bowser_castle-20260905T005948Z", 58775),
                    ("bowser_castle-20260905T005948Z", 61851)}
    star_swing = ("bowser_castle-20260826T153516Z", 53460)
    named, hazards, strays = set(), {}, []
    for stem, plays in _plays_by_stem().items():
        for play in plays:
            for knock in play.get("knockdowns") or []:
                key = (stem, knock.get("frame"))
                hazards[key] = knock.get("hazard")
                if knock.get("hazard") != "bob_omb_bomb":
                    continue
                named.add(key)
                if not stem.startswith("bowser_castle-"):
                    strays.append(stem)
    if strays:
        failures.append("Bob-omb bombs named outside Bowser Castle: "
                        + ", ".join(sorted(set(strays))[:4]))
        return
    derived = set(_plays_by_stem("bowser_castle-"))
    missing = {key for key in labelled if key[0] in derived} - named
    if missing:
        failures.append(
            f"annotated Bob-omb bombs not named: {sorted(missing)} "
            "(regenerate the Bowser Castle plays files if this is a stale archive)")
        return
    swept = {key for key in single_phase if key[0] in derived} & named
    if swept:
        failures.append(f"single-phase knockdowns swept in as bombs: {sorted(swept)}")
        return
    if star_swing[0] in derived and hazards.get(star_swing) != "star_swing":
        failures.append(f"Donkey Kong's star swing at {star_swing} came back "
                        f"{hazards.get(star_swing)!r}, not star_swing")
        return
    print(f"  OK  {'bob-omb bombs':<34} {len(named)} named, "
          f"{len({k for k in single_phase if k[0] in derived})} single-phase left unnamed, "
          "star swing untouched")


def verify_birdo_egg_reach(failures: list) -> None:
    """Birdo's egg flies ahead of the ball; her 6.48u knockdown is hers."""
    plays = _plays_by_stem("yoshi_park-20260911T164801Z").get("yoshi_park-20260911T164801Z")
    if not plays:
        print(f"  OK  {'birdo egg reach':<34} session not derived")
        return
    knock = next((k for play in plays for k in play.get("knockdowns") or []
                  if k.get("frame") == 45123), None)
    if not knock or knock.get("hazard") != "star_swing" or knock.get("star_swing_captain") != "Birdo":
        failures.append(f"Birdo's egg knockdown at frame 45123 not named: {knock}")
        return
    print(f"  OK  {'birdo egg reach':<34} frame 45123 named Birdo at "
          f"{knock.get('star_swing_ball_units')}u from the ball")


def verify_manhole_ball_strike(failures: list) -> None:
    """The ball bouncing off an erupting manhole, above the ground.

    One measured example: 2026-09-10 PA36, which the operator annotated as "the
    ball hit the explodnng manhole, which is why it went out of the park for a
    ground rule double". n=1, so this pins the example rather than a rate.
    """
    data = Path("data/player_tracking")
    strikes = []
    for plays_path in sorted(data.glob("*.plays.jsonl")):
        for line in plays_path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            play = json.loads(line)
            for strike in (play.get("manhole_ball_strikes") or []):
                strikes.append((plays_path.name, play.get("landing"), strike))
    outside = [name for name, _, _ in strikes if not name.startswith("wario_city-")]
    if outside:
        failures.append("manhole ball strike reported outside Wario City: "
                        + ", ".join(sorted(set(outside))[:4]))
        return
    if not strikes:
        print(f"  OK  {'manhole ball strike':<34} none derived")
        return
    for name, landing, strike in strikes:
        if strike["height_units"] < derive.MANHOLE_BALL_STRIKE_MIN_HEIGHT_UNITS:
            failures.append(f"{name}: manhole ball strike at "
                            f"{strike['height_units']}u is not above the ground")
            return
        if strike["turn_degrees"] > derive.MANHOLE_BALL_STRIKE_MAX_TURN_DEGREES:
            failures.append(f"{name}: manhole ball strike turned "
                            f"{strike['turn_degrees']} degrees -- that is a redirect, "
                            "not a bounce off a flat surface")
            return
    # The one that matters: a strike explains a play with no measured landing.
    unlanded = [s for _, landing, s in strikes if landing is None]
    print(f"  OK  {'manhole ball strike':<34} {len(strikes)} strike(s), "
          f"{len(unlanded)} on a play with no ground landing "
          f"(height {strikes[0][2]['height_units']}u, "
          f"turn {strikes[0][2]['turn_degrees']}deg)")


def verify_daisy_tables(failures: list) -> None:
    """Pin Daisy's table detectors to labelled contacts, breaks, and controls."""
    data = Path("data/player_tracking")
    expected_contacts = {
        "daisy_cruiser-20260904T202047Z": {18237, 41236, 70634},
        "daisy_cruiser-20260911T125243Z": {13008, 21159},
    }
    known_stuns = {
        ("daisy_cruiser-20260904T202047Z", 64285): ("SS", "Red Kritter"),
        ("daisy_cruiser-20260904T202047Z", 80222): ("CF", "Yoshi"),
    }
    break_stem = "daisy_cruiser-20260911T132750Z"
    known_breaks = {
        17888: ("fielder_buddy_attack", "Blue Yoshi"),
        45403: ("fielder_buddy_attack", "Blue Yoshi"),
        57318: ("fielder_buddy_attack", "Green Dry Bones"),
        85381: ("thrown_ball", "Luigi"),
        87762: ("thrown_ball", "Blue Shy Guy"),
        89024: ("thrown_ball", "Blue Shy Guy"),
        92025: ("fielder_buddy_attack", "Luigi"),
    }
    # Bowser's fire breath, not the ball: 15.7u away, no attack or throw near it
    # (Jason, PA 55).
    fire_stem, fire_timer = "daisy_cruiser-20260911T152720Z", 58236
    plays_by_stem = {}
    for stem in sorted(set(expected_contacts) | {key[0] for key in known_stuns}
                       | {break_stem, fire_stem}):
        path = data / f"{stem}.plays.jsonl"
        if not path.exists():
            failures.append(f"missing Daisy table fixture {path}")
            continue
        plays_by_stem[stem] = {
            play.get("contact_timer"): play
            for play in (json.loads(line) for line in path.read_text(
                encoding="utf8").splitlines() if line.strip())
        }

    labelled_found = 0
    for stem, timers in expected_contacts.items():
        for timer in timers:
            contacts = plays_by_stem.get(stem, {}).get(timer, {}).get(
                "table_ball_contacts") or []
            if not contacts:
                failures.append(f"{stem}: labelled table contact {timer} was not detected")
            else:
                labelled_found += 1

    near_miss = plays_by_stem.get("daisy_cruiser-20260911T125243Z", {}).get(33669)
    if near_miss is None:
        failures.append("Daisy table near-miss control 33669 is missing")
    elif near_miss.get("table_ball_contacts"):
        failures.append("Daisy table near-miss control 33669 was called a contact")

    stun_found = 0
    for (stem, timer), expected in known_stuns.items():
        stuns = plays_by_stem.get(stem, {}).get(timer, {}).get("table_stuns") or []
        if not any((stun.get("by"), stun.get("character")) == expected for stun in stuns):
            failures.append(f"{stem}: table stun {timer} did not name {expected}")
        else:
            stun_found += 1

    paint = plays_by_stem.get("daisy_cruiser-20260904T202047Z", {}).get(75650, {})
    if not paint.get("impact_stuns"):
        failures.append("Daisy Bowser Jr paint control 75650 lost the generic impact stun")
    if paint.get("table_stuns"):
        failures.append("Daisy Bowser Jr paint control 75650 was attributed to a table")

    break_found = 0
    for timer, (cause_type, character) in known_breaks.items():
        events = plays_by_stem.get(break_stem, {}).get(timer, {}).get("table_breaks") or []
        if not any(event.get("cause", {}).get("type") == cause_type
                   and event.get("cause", {}).get("character") == character
                   for event in events):
            failures.append(
                f"{break_stem}: table break {timer} did not name {cause_type} by {character}")
        else:
            break_found += 1
    fire = plays_by_stem.get(fire_stem, {}).get(fire_timer, {}).get("table_breaks") or []
    if any(event.get("cause", {}).get("type") == "star_swing"
           and event.get("cause", {}).get("captain") == "Bowser" for event in fire):
        break_found += 1
    else:
        failures.append(f"{fire_stem}: table break {fire_timer} did not name Bowser's star swing")

    destroyed_before_contact = plays_by_stem.get(break_stem, {}).get(57318, {})
    if destroyed_before_contact.get("table_ball_contacts"):
        failures.append(
            f"{break_stem}: 57318 called a batted-ball table contact after the table broke")

    outside = []
    unreviewed = 0
    for path in sorted(data.glob("*.plays.jsonl")):
        is_daisy = path.name.startswith("daisy_cruiser-")
        stem = path.name[: -len(".plays.jsonl")]
        labelled = expected_contacts.get(stem, set())
        for line in path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            play = json.loads(line)
            if not is_daisy and (play.get("table_ball_contacts") or play.get("table_stuns")
                                 or play.get("table_breaks")):
                outside.append(f"{path.name}@{play.get('contact_timer')}")
            if (is_daisy and play.get("table_ball_contacts")
                    and play.get("contact_timer") not in labelled):
                unreviewed += len(play["table_ball_contacts"])
    if outside:
        failures.append("table events reported outside Daisy Cruiser: "
                        + ", ".join(outside[:5]))
    elif (labelled_found == 5 and stun_found == 2 and break_found == 8
          and near_miss is not None):
        print(f"  OK  {'Daisy table interactions':<34} 5/5 ball contacts, "
              f"2/2 player stuns, 8/8 table breaks, near-miss + paint controls clean; "
              f"{unreviewed} unreviewed candidate(s)")


def verify_star_swing_effects(failures: list) -> None:
    """Star swings that disable without flooring, against Jason's labels.

    Each effect writes a fielder byte something else also writes -- the paint
    and a Daisy table share +0x243, the heart and DK Jungle's flower gas share
    +0x242 -- so the controls matter as much as the labels: a Yoshi egg must not
    raise the fire byte, and no effect may be named on another captain's swing.
    """
    data = Path("data/player_tracking")
    labelled = {
        # PA 48, 49, 64 and 67 of the 09-11 game.
        ("daisy_cruiser-20260911T132750Z", 49458): {("CF", "Blue Shy Guy", "paint"),
                                                    ("RF", "Green Dry Bones", "paint")},
        ("daisy_cruiser-20260911T132750Z", 52895): {("2B", "Magikoopa", "heart")},
        ("daisy_cruiser-20260911T132750Z", 70193): {("2B", "Kritter", "fire_breath")},
        ("daisy_cruiser-20260911T132750Z", 73965): {("CF", "Blue Shy Guy", "fireball")},
        # 09-04, annotated as stuns before these bytes were told apart.
        ("daisy_cruiser-20260904T202047Z", 75650): {("CF", "Yoshi", "paint"),
                                                    ("RF", "Bowser", "paint")},
        ("daisy_cruiser-20260904T202047Z", 90050): {("SS", "Red Kritter", "fire_breath")},
    }
    egg_stem, egg_timers = "daisy_cruiser-20260904T202047Z", {8313, 23336, 61681}
    problems = []
    found = named = 0
    for path in sorted(data.glob("*.plays.jsonl")):
        stem = path.name[: -len(".plays.jsonl")]
        for line in path.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            play = json.loads(line)
            timer = play.get("contact_timer")
            effects = play.get("star_swing_effects") or []
            expected = labelled.get((stem, timer))
            if expected is not None:
                missing = expected - {(e.get("by"), e.get("character"), e.get("effect"))
                                      for e in effects}
                if missing:
                    problems.append(f"{stem}@{timer}: star-swing effect not named: "
                                    + ", ".join(map(str, sorted(missing))))
                else:
                    found += 1
            if stem == egg_stem and timer in egg_timers and any(
                    fielder.get("burned_at_s")
                    for fielder in (play.get("fielders") or {}).values()):
                problems.append(f"{stem}@{timer}: a Yoshi egg raised the fire byte")
            value = (play.get("star_swing") or {}).get("value")
            flag = derive.STAR_SWING_EFFECTS.get(value, (None,))[0]
            for effect in effects:
                named += 1
                if effect.get("flag") != flag:
                    problems.append(f"{stem}@{timer}: {effect.get('effect')} named on "
                                    f"star swing {value}")
            if ({(s.get("by"), s.get("frame")) for s in play.get("table_stuns") or []}
                    & {(e.get("by"), e.get("frame")) for e in effects}):
                problems.append(f"{stem}@{timer}: a star-swing effect was also a table stun")
    if not problems and found != len(labelled):
        problems.append(f"only {found}/{len(labelled)} labelled star-swing plays were found")
    failures.extend(problems)
    if not problems:
        print(f"  OK  {'star-swing effects':<34} {found}/{len(labelled)} labelled plays, "
              f"{named} named archive-wide, each on its own captain's byte; "
              "Yoshi egg controls clean")


def verify_slap_charge_swings(failures: list) -> None:
    """Slap versus charge against the game the operator scripted for it.

    `mario_stadium-20260923T012536Z` was played slap in every top half and
    charge in every bottom half. That script makes swing mode, half-inning and
    batting remote co-vary perfectly -- 484 bytes of the state block "separate"
    the two groups -- so the labels alone cannot say a byte follows the gesture.
    The one pitch that can is the accidental charge the operator annotated in a
    slap half-inning: a byte that tracks the gesture flags it while every other
    swing in that half, by the same remote, reads slap.

    The second half of this is the staleness controls, and they are the reason
    the charge is read as a RISE rather than as a level. Neither field can be
    read as a level: abandoning a charge drops the frame counter to 0 and leaves
    the meter at its last value, and making contact resets the meter and leaves
    the counter frozen. Gating on a non-zero meter called 95% of the swings in
    three real games a charge, pitches nobody charged included.
    """
    stem = "mario_stadium-20260923T012536Z"
    path = Path("data/player_tracking") / f"{stem}.pitches.jsonl"
    if not path.exists():
        failures.append(f"{stem}.pitches.jsonl is missing; the slap/charge labels "
                        "have no capture to check against")
        return
    pitches = [json.loads(line) for line in
               path.read_text(encoding="utf8").splitlines() if line.strip()]
    if pitches and "swing_charge_frames" not in pitches[0]:
        failures.append(f"{stem}.pitches.jsonl predates the charge fields; "
                        f"re-derive it with scripts/derive_player_metrics.py")
        return

    # The operator's script, and the single pitch they annotated as off-script.
    exception = (3, 0, "Donkey Kong", 1)
    problems = []
    counts = {"slap": 0, "charge": 0}
    for pitch in pitches:
        if pitch.get("offer") != "swing":
            # A pitch nobody offered at has no swing mode, and must not acquire
            # one from a charge that was held through it and abandoned.
            if pitch.get("swing_mode") != "none" or pitch.get("swing_charge_frames") is not None:
                problems.append(f"{stem}: a taken pitch was given swing mode "
                                f"{pitch.get('swing_mode')!r} and "
                                f"{pitch.get('swing_charge_frames')!r} charge frames")
            continue
        key = (pitch.get("inning"), pitch.get("inning_half"),
               pitch.get("batter"), pitch.get("pitch_in_pa"))
        expected = "charge" if key == exception or pitch.get("inning_half") == 1 else "slap"
        actual = pitch.get("swing_mode")
        if actual != expected:
            problems.append(f"{stem} inn{key[0]} "
                            f"{'top' if key[1] == 0 else 'bot'} {key[2]} pitch {key[3]}: "
                            f"scripted {expected}, derived {actual}")
            continue
        counts[expected] += 1
        frames = pitch.get("swing_charge_frames")
        if expected == "charge" and not (isinstance(frames, int) and frames > 0):
            problems.append(f"{stem}: a charge was derived with {frames!r} charge frames")
        if expected == "slap" and frames != 0:
            problems.append(f"{stem}: a slap was derived with {frames!r} charge frames")
        if expected == "slap" and pitch.get("swing_charge_release_timing_frames") is not None:
            problems.append(f"{stem}: a slap was given a charge release time")
        if expected == "charge" and pitch.get("swing_charge_release_timing_frames") != 1:
            problems.append(
                f"{stem}: charge release should be one frame before swing onset, got "
                f"{pitch.get('swing_charge_release_timing_frames')!r}"
            )
    if counts["slap"] != 13 or counts["charge"] != 26:
        problems.append(f"{stem}: expected the scripted 13 slaps and 26 charges, "
                        f"derived {counts['slap']} and {counts['charge']}")

    # THE STALENESS CONTROLS, driven straight through the latch. Both patterns
    # are taken from real captures: the abandoned charge is how a take ends in
    # bowser_castle-20260919T003634Z, and the frozen counter is what a contact
    # leaves behind in the scripted game.
    def latch(frames_by_frame):
        deriver = derive.PitchDeriver()
        for index, value in enumerate(frames_by_frame):
            deriver._track_charge({"timer": index}, {"swing_charge_frames": value})
        return deriver._take_charge()

    abandoned = latch([0, 1, 2, 3, 4, 5, 0, 0, 0, 0])
    if abandoned != (0, None):
        problems.append("an abandoned charge (counter back to 0, meter left high) "
                        f"was still credited: {abandoned}")
    frozen = latch([10, 20, 30, 30, 30, 30])
    if frozen[0] != 30:
        problems.append(f"a charge held to the pitch was not credited: {frozen}")
    spent = derive.PitchDeriver()
    for index, value in enumerate([0, 5, 10, 15]):
        spent._track_charge({"timer": index}, {"swing_charge_frames": value})
    spent._take_charge()
    for index, value in enumerate([15, 15, 15]):
        spent._track_charge({"timer": 100 + index}, {"swing_charge_frames": value})
    leaked = spent._take_charge()
    if leaked != (0, None):
        problems.append("a charge frozen on contact leaked into the next pitch: "
                        f"{leaked}")
    absent = latch([None, None, None])
    if absent != (0, None):
        problems.append(f"a capture with no charge field produced a charge: {absent}")

    failures.extend(problems)
    if not problems:
        print(f"  OK  {'slap versus charge':<34} "
              f"{counts['slap']}/13 scripted slaps, {counts['charge']}/26 charges, "
              "the annotated off-script charge among them; abandoned, frozen and "
              "absent charges all credited to nobody")


def verify_star_meter_spend(failures: list) -> None:
    """The team star meters, and what a pitch spent off them.

    THE DEDUCTION LANDS ON THE RELEASE FRAME. mario_stadium-20260925T165659Z is
    the first capture with the meters in it, and it settled where a star pitch
    is charged: on the very frame the pitch counter rises, which is also the
    frame the pitch's `before` snapshot is taken. Differencing `before` against
    the resolution therefore read two post-deduction values and called all nine
    of that session's annotated star pitches 0 spent. The spend is now summed
    from frame-to-frame drops starting one frame BEFORE the release.

    The half-inning decides which side is batting, and the fielding side's spend
    is a STAR PITCH. The absent case matters as much as the spend: every session
    recorded before 2026-09-25 must read None, because 0 would claim the meter
    was full and untouched.
    """
    problems = []
    # (label, frames, expected running drop)
    drop_cases = [
        ("a 50-unit star pitch charged on the release frame",
         [{"away_star_meter": 250, "home_star_meter": 250},
          {"away_star_meter": 250, "home_star_meter": 200},
          {"away_star_meter": 250, "home_star_meter": 200}],
         {"away": 0, "home": 50}),
        ("an award landing mid-pitch does not cancel the spend",
         [{"away_star_meter": 100, "home_star_meter": 100},
          {"away_star_meter": 100, "home_star_meter": 50},
          {"away_star_meter": 100, "home_star_meter": 90}],
         {"away": 0, "home": 50}),
        ("a meter that only rises spends nothing",
         [{"away_star_meter": 10, "home_star_meter": 10},
          {"away_star_meter": 31, "home_star_meter": 10}],
         {"away": 0, "home": 0}),
        ("a capture with no meters accumulates nothing at all",
         [{}, {}], {}),
    ]
    for label, frames, expected in drop_cases:
        running: dict = {}
        for was, now in zip(frames, frames[1:]):
            derive._star_meter_drop(was, now, running)
        if running != expected:
            problems.append(
                f"star meter drop, {label}: expected {expected}, got {running}")

    cases = [
        ("away batting spends a captain's 100",
         0, {"away": 100, "home": 0},
         {"batting_star_meter_spent": 100, "fielding_star_meter_spent": 0}),
        ("home batting, away pitcher spends 50 -- a star pitch",
         1, {"away": 50, "home": 0},
         {"batting_star_meter_spent": 0, "fielding_star_meter_spent": 50}),
        ("a capture with no meters spends nothing and says so",
         0, {},
         {"batting_star_meter_spent": None, "fielding_star_meter_spent": None}),
        ("an unknown half cannot name a batting side",
         None, {"away": 50, "home": 0},
         {"batting_star_meter_spent": None, "fielding_star_meter_spent": None}),
    ]
    for label, half, drops, expected in cases:
        got = derive._star_meter_spend(half, drops)
        if got != expected:
            problems.append(f"star meter, {label}: expected {expected}, got {got}")

    # The retroactive half of the same change, against real sessions: score must
    # be readable from captures recorded years of commits before it was named,
    # and the meters must not be.
    checked = 0
    for stem in ("daisy_cruiser-20260831T212804Z", "peach_ice_garden-20260826T201820Z"):
        path = Path("data/player_tracking") / f"{stem}.json"
        if not path.exists():
            continue
        session = io.Session(path.with_suffix(""))
        last = None
        for frame in session.frames():
            last = frame
        state = session.state(last)
        checked += 1
        for name in ("away_score", "home_score", "away_hits", "home_hits"):
            if state.get(name) is None:
                problems.append(f"{stem}: {name} should be retroactive, read None")
        for name in ("away_star_meter", "home_star_meter"):
            if name in state:
                problems.append(
                    f"{stem}: {name} was read from a capture that never recorded "
                    f"it -- the bounds check let a neighbouring byte through")
        if state.get("away_score", 0) + state.get("home_score", 0) <= 0:
            problems.append(f"{stem}: both scores read 0 at the final frame")

    failures.extend(problems)
    if not problems:
        print(f"  OK  {'team star meter spend':<34} "
              f"{len(drop_cases)}+{len(cases)} cases including the release-frame "
              f"star-pitch deduction, a mid-pitch award and absent meters; score "
              f"retroactive on {checked} archived session(s), meters correctly "
              "absent")


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


def verify_freezie_locator(failures: list) -> None:
    """The startup scan finds the array by structure, not its old address."""
    region_start = 0x91800000
    array_offset = 0x740
    block = bytearray(0x1200)
    xs = (11.0, -29.0, 26.0, -44.0, -9.0)
    zs = (-50.0, -50.0, -75.0, -75.0, -95.0)
    matrix = (1.0, 0.0, 0.0, 0.0,
              0.0, 1.0, 0.0, 0.0,
              0.0, 0.0, 1.0, 0.0)
    for slot, (x, z) in enumerate(zip(xs, zs)):
        values = list(matrix)
        values[3], values[7], values[11] = x, 0.0, z
        start = array_offset + slot * collector.FREEZIE_STRIDE
        for copy in (collector.FREEZIE_TRANSFORM,
                     collector.FREEZIE_TRANSFORM_COPY):
            struct.pack_into(">12f", block, start + copy, *values)

    expected = region_start + array_offset
    got = collector.find_freezie_array_candidates(bytes(block), region_start)
    if got != [expected]:
        failures.append(
            f"Freezie locator: expected [0x{expected:08X}], got "
            f"{[f'0x{x:08X}' for x in got]}")
        return

    # An identity-transform array with the wrong rigid gap is ordinary scene
    # data, not a second Freezie allocation.
    struct.pack_into(">f", block,
                     array_offset + collector.FREEZIE_STRIDE + 0x0C, 27.0)
    got = collector.find_freezie_array_candidates(bytes(block), region_start)
    if got:
        failures.append(
            f"Freezie locator accepted a wrong x-gap: {[f'0x{x:08X}' for x in got]}")
    elif not failures:
        print(f"  OK  {'Freezie runtime locator':<34} moved address + false control")


def verify_barrel_locator(failures: list) -> None:
    """The barrel is found by its cannon sentinel, and a near miss is not it.

    This is the control the barrel never had. The address found live in 2026-09
    is dead in both captures that record it -- the allocation moves between
    matches exactly as Peach's Freezies do -- so the collector now locates it by
    the one thing that identifies it: a parked barrel sits on one of two cannon
    positions, which is three exact floats in a row.
    """
    region_start = 0x92000000
    block = bytearray(0x400)
    # The authoritative slot and the mirror that holds the same position, at the
    # 0xE0 gap the original allocation showed.
    for offset in (0x40, 0x40 + 0xE0):
        struct.pack_into(">fff", block, offset, *collector.BARREL_CANNONS[0])
    # A barrel that is ROLLING is not at a sentinel and must not be found by
    # this search; it is found by reading the slot the sentinel identified.
    struct.pack_into(">fff", block, 0x200, -30.0, 1.8, -70.0)
    # ...and a near miss on one axis is not a cannon. Half a unit out is far
    # beyond the exact write the game makes.
    struct.pack_into(">fff", block, 0x280, -39.5, 4.0, -93.5)

    found = collector.find_barrel_candidates(bytes(block), region_start)
    addresses = [candidate["address"] for candidate in found]
    if addresses != [region_start + 0x40, region_start + 0x40 + 0xE0]:
        failures.append(
            "barrel locator: expected the sentinel slot and its mirror, got "
            + str([f"0x{value:08X}" for value in addresses]))
        return
    if any(candidate["cannon"] != "left" for candidate in found):
        failures.append("barrel locator named the wrong cannon")
        return

    # An empty region is the honest answer, not a guess at the old address.
    if collector.find_barrel_candidates(bytes(bytearray(0x400)), region_start):
        failures.append("barrel locator found a sentinel in a block of zeros")
        return
    print(f"  OK  {'barrel located by cannon sentinel':<34} "
          f"slot + mirror, rolling barrel and near miss both rejected")


def verify_freezie_lanes(failures: list) -> None:
    """Every measured freeze happened where a Freezie actually is.

    This is the control for the object located at FREEZIE_ARRAY, and it is worth
    more than the search that found it. Watched live, the five slots patrol three
    fixed depths and slide back and forth along them. If they are the Freezies,
    then a fielder can only be frozen ON one of those depths -- and the freeze
    flag was measured independently, months before the object was found.

    75 onsets across four annotated sessions, three clean bands, nothing in
    between. A future capture where the array has moved fails here rather than
    silently reporting Freezies in the wrong place.
    """
    depths = collector.FREEZIE_LANE_DEPTHS
    tags = ["20260902T151327Z", "20260904T152214Z",
            "20260907T234715Z", "20260909T142827Z"]
    onsets = []
    for tag in tags:
        stem = Path("data/player_tracking") / f"peach_ice_garden-{tag}"
        if not stem.with_suffix(".bin").exists():
            print(f"  --  {'freeze lands on a Freezie lane':<34} {tag} not on disk")
            return
        session = io.Session(stem)
        offset = session.fields["frozen_flag"]
        up = {f["name"]: False for f in session.fielders}
        for frame in session.frames():
            for fielder in session.fielders:
                start = fielder["address"] - session.state_base
                value = bool(frame.block[start + offset])
                if value and not up[fielder["name"]]:
                    _, _, z = struct.unpack(">fff", frame.block[start + 4:start + 16])
                    # position_a is raw; Peach's fit is sign_z = -1, and the
                    # Freezie matrix is already on that side. See FREEZIE_ARRAY.
                    onsets.append(-z)
                up[fielder["name"]] = value
    off_lane = [z for z in onsets if min(abs(z - d) for d in depths) >= 6.0]
    if off_lane:
        failures.append(
            f"{len(off_lane)} of {len(onsets)} freezes happened off every Freezie "
            f"lane {depths}: {[round(z, 1) for z in off_lane[:5]]}")
    elif not failures:
        print(f"  OK  {'freeze lands on a Freezie lane':<34} "
              f"{len(onsets)}/{len(onsets)} within 6u of {depths}")


def verify_freezie_breaks(failures: list) -> None:
    """Object disappearance, cause, controls, and a frozen-fielder rebound."""
    stems = {
        "first": Path("data/player_tracking/peach_ice_garden-20260909T184001Z"),
        "latest": Path("data/player_tracking/peach_ice_garden-20260909T192448Z"),
        "newest": Path("data/player_tracking/peach_ice_garden-20260909T195355Z"),
    }
    if any(not stem.with_suffix(".bin").exists() for stem in stems.values()):
        print(f"  --  {'Freezie breaks vs annotations':<34} session not on disk")
        return
    plays = {}
    for label, stem in stems.items():
        session = io.Session(stem)
        if session.header.get("freezie_count") != 5:
            failures.append(
                f"{label} Freezie capture has {session.header.get('freezie_count')} "
                "objects, expected 5")
            return
        plays[label] = {
            play["contact_timer"]: play
            for play in replay_session.replay(stem)["plays"]
        }

    expected = {
        ("first", 20840): (20926, "fielder_buddy_attack"),
        ("first", 31209): (31359, "fielder_buddy_attack"),
        ("first", 34051): (34204, "batted_ball"),
        ("first", 53731): (53835, "batted_ball"),
        ("first", 55511): (55812, "thrown_ball"),
        ("latest", 79780): (79983, "thrown_ball"),
        ("latest", 84739): (84886, "batted_ball"),
        ("latest", 85666): (85777, "fielder_buddy_attack"),
        ("newest", 93431): (93642, "thrown_ball"),
        ("newest", 101714): (102337, "thrown_ball"),
        ("newest", 104913): (105057, "fielder_buddy_attack"),
    }
    for (label, contact), (frame, cause) in expected.items():
        got = plays[label].get(contact, {}).get("freezie_breaks") or []
        if len(got) != 1 or got[0]["frame"] != frame:
            failures.append(
                f"Freezie break at {label} contact {contact}: expected frame "
                f"{frame}, got {got}")
        elif got[0].get("cause", {}).get("type") != cause:
            failures.append(
                f"Freezie break at {label} contact {contact}: expected cause "
                f"{cause}, got {got[0].get('cause')}")
    for contact in (23285, 29716, 39649):
        got = plays["first"].get(contact, {}).get("freezie_breaks") or []
        if got:
            failures.append(
                f"Freezie near-miss control at contact {contact} reported breaks: {got}")

    intact_play = plays["newest"].get(97893, {})
    intact_breaks = intact_play.get("freezie_breaks") or []
    intact_rebounds = intact_play.get("freezie_ball_rebounds") or []
    if intact_breaks:
        failures.append(
            f"non-breaking Freezie rebound at contact 97893 reported a break: "
            f"{intact_breaks}")
    if not any(event["frame"] == 98153
               and event["slot"] == 4
               and event["outcome"] == "remained_active"
               and event["phase"] == "batted_ball"
               for event in intact_rebounds):
        failures.append(
            "intact Freezie rebound at contact 97893/frame 98153 was not "
            f"retained: {intact_rebounds}")

    close_then_throw = plays["newest"].get(93431, {})
    if close_then_throw.get("freezie_ball_rebounds"):
        failures.append(
            "near-miss batted ball at contact 93431 was incorrectly reported "
            f"as contact: {close_then_throw['freezie_ball_rebounds']}")

    rebound = (plays["latest"].get(82123, {})
               .get("frozen_fielder_ball_contacts") or [])
    if not any(event["frame"] == 82838
               and event["character"] == "Blue Kritter"
               and event["outcome"] == "rebound"
               and event.get("source_thrower_character") == "Baby Luigi"
               for event in rebound):
        failures.append(
            "frozen Blue Kritter rebound at contact 82123/frame 82838 was not "
            f"attributed to Baby Luigi's throw: {rebound}")
    if not failures:
        print(f"  OK  {'Freezie breaks vs annotations':<34} "
              "11 breaks with causes, 0/4 controls, both rebound types")


def verify_buddy_attack(failures: list) -> None:
    """Buddy-attack animation and hit confirmation against operator labels.

    Five Peach Ice Garden sessions carry eleven confirmed buddy attacks. All
    eleven must name the right attacker and set the +0x267 hit bit.
    The newest session also carries the missing negative control: Pink Yoshi
    buddy-attacked without connecting, so +0x265 must report the attack while
    +0x267 stays false.

    These older captures did not include the Freezie objects, so none may set
    `clears_freezie` from the attack latch alone.
    """
    labelled = {
        "peach_ice_garden-20260902T151327Z": {
            8648: "Boomerang Bro.", 10323: "Koopa Troopa", 23042: "Blue Shy Guy"},
        "peach_ice_garden-20260904T152214Z": {
            11640: "Green Toad", 41509: "Red Kritter", 64314: "Green Toad"},
        "peach_ice_garden-20260907T234715Z": {
            8695: "Pink Yoshi", 32277: "Pink Yoshi", 72611: "Baby Luigi"},
        "peach_ice_garden-20260909T142827Z": {4707: "Dry Bones"},
        "peach_ice_garden-20260909T155408Z": {2113: "Dark Bones"},
    }
    found = 0
    for name, want in labelled.items():
        stem = Path("data/player_tracking") / name
        if not stem.with_suffix(".bin").exists():
            print(f"  --  {'buddy attack vs annotations':<34} {name} not on disk")
            return
        plays = replay_session.replay(stem)["plays"]
        attacks = {play["contact_timer"]: play.get("buddy_attacks") or []
                   for play in plays}
        for contact, character in want.items():
            got = attacks.get(contact) or []
            if not got:
                failures.append(
                    f"buddy attack missed the annotated swing at {name} "
                    f"contact {contact} ({character})")
                continue
            if not any(a["character"] == character for a in got):
                failures.append(
                    f"buddy attack at {name} contact {contact} names "
                    f"{[a['character'] for a in got]}, operator said {character}")
                continue
            if not all(a.get("hit") for a in got):
                failures.append(
                    f"buddy attack at {name} contact {contact} did not set its "
                    f"successful-contact latch")
                continue
            if any(a["clears_freezie"] for a in got):
                failures.append(
                    f"buddy attack at {name} contact {contact} was incorrectly "
                    f"marked as breaking a Freezie")
                continue
            found += 1
    negative_stem = Path(
        "data/player_tracking/peach_ice_garden-20260909T155408Z")
    if negative_stem.with_suffix(".bin").exists():
        negative_plays = replay_session.replay(negative_stem)["plays"]
        missed = next((play.get("buddy_attacks") or [] for play in negative_plays
                       if play["contact_timer"] == 4852), [])
        if len(missed) != 1 or missed[0]["character"] != "Pink Yoshi":
            failures.append(
                "missed buddy attack at peach_ice_garden-20260909T155408Z "
                f"contact 4852 was not attributed to Pink Yoshi: {missed}")
        elif missed[0].get("hit") or missed[0]["clears_freezie"]:
            failures.append(
                "Pink Yoshi's missed buddy attack at contact 4852 was marked "
                f"as a Freezie break: {missed[0]}")
    if not failures:
        print(f"  OK  {'buddy attack vs annotations':<34} "
              f"{found}/11 contacts plus 1 confirmed miss; no latch-only breaks")


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


def verify_dk_night_hazards(failures: list) -> None:
    """Lock the night flower byte, statue POW value, and false Buddy control."""
    stem = Path("data/player_tracking/dk_jungle-20260912T150755Z")
    if not stem.with_suffix(".bin").exists():
        print(f"  --  {'DK night hazards':<34} session not on disk")
        return
    before = len(failures)
    plays = replay_session.replay(stem)["plays"]
    by_contact = {play["contact_timer"]: play for play in plays}

    flower_expected = {8950: "LF", 55573: "LF", 69773: "CF", 74823: "LF"}
    all_flowers = [
        (play["contact_timer"], spray)
        for play in plays for spray in play.get("flower_sprays", [])
    ]
    if len(all_flowers) != len(flower_expected):
        failures.append(
            f"DK night flower count changed: {len(all_flowers)}, expected 4")
    for contact, position in flower_expected.items():
        sprays = by_contact.get(contact, {}).get("flower_sprays", [])
        if (len(sprays) != 1 or sprays[0].get("by") != position
                or sprays[0].get("source_byte") != "+0x2CA"):
            failures.append(
                f"DK night flower at {contact} was {sprays}, expected {position} +0x2CA")
    if by_contact.get(7330, {}).get("flower_sprays"):
        failures.append("DK night annotated flower near miss at 7330 became a hit")

    pow_expected = {76817: "CF", 81230: "CF", 89729: "CF"}
    all_pow = [
        (play["contact_timer"], stun)
        for play in plays for stun in play.get("dk_pow_stuns", [])
    ]
    if len(all_pow) != len(pow_expected):
        failures.append(f"DK night POW count changed: {len(all_pow)}, expected 3")
    for contact, position in pow_expected.items():
        stuns = by_contact.get(contact, {}).get("dk_pow_stuns", [])
        if (len(stuns) != 1 or stuns[0].get("by") != position
                or stuns[0].get("flag_value") != 1
                or stuns[0].get("frames") != 91):
            failures.append(
                f"DK night POW at {contact} was {stuns}, expected {position}, value 1 x91")
    for contact in (40442, 58079, 68391):
        if by_contact.get(contact, {}).get("dk_pow_stuns"):
            failures.append(f"DK night no-hit POW activation at {contact} named a victim")

    false_buddy = [throw for throw in by_contact.get(32061, {}).get("throws", [])
                   if throw.get("buddy_throw")]
    if false_buddy:
        failures.append(
            f"DK close-play freeze at 32061 was called a Buddy Throw: {false_buddy}")
    if len(failures) == before:
        print(f"  OK  {'DK night hazards':<34} "
              "4 flowers, 3 POW stuns, near-miss/no-hit controls clean")
        print(f"  OK  {'close play is not Buddy Throw':<34} explicit scalar absent")


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

    # A SLOT THAT HOLDS A CONSTANT IS NOT A BARREL. This is the state the real
    # address is actually in: dk_jungle-20260904T161731Z holds
    # (0.2523, -0.1100, 0.0) for 137 consecutive frames -- finite, in range,
    # non-zero and away from both cannon sentinels, so every guard that existed
    # called it a live barrel parked 0.28u from home plate. It emitted nothing
    # only because those frames fell outside every play window, which is luck
    # rather than a guard. A real barrel crosses the outfield at 19-25 u/s.
    stuck = [frame(i / 60, 200 + i, (0.2523, -0.1100, 0.0), True, None,
                   (0.0, 0.0, 70.0), (30.0, 0.0, 60.0)) for i in range(137)]
    if derive.detect_barrel_events(stuck, 0.0, 99.0, park="dk_jungle"):
        failures.append("a barrel slot stuck on one constant produced a barrel event")
    else:
        print(f"  OK  {'stuck barrel slot rejected':<34} "
              f"137 frames of one constant, 0 events")

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
    verify_arrow_redirects(failures)
    verify_arrow_night_multiplier(failures)
    verify_arrow_park_gate(failures)
    verify_manhole_attribution(failures)
    verify_manhole_ball_strike(failures)
    verify_yoshi_pipes(failures)
    verify_yoshi_piranha_knockdowns(failures)
    verify_yoshi_train(failures)
    verify_yoshi_train_ball_hits(failures)
    verify_bowser_castle_fires(failures)
    verify_bob_omb_bombs(failures)
    verify_birdo_egg_reach(failures)
    verify_throw_aim(failures)
    verify_daisy_tables(failures)
    verify_star_swing_effects(failures)
    verify_flower_gas(failures)
    verify_dk_night_hazards(failures)
    verify_freezie_locator(failures)
    verify_barrel_locator(failures)
    verify_freezie_lanes(failures)
    verify_freezie_breaks(failures)
    verify_buddy_attack(failures)
    verify_knockdown_flag(failures)
    verify_slap_charge_swings(failures)
    verify_star_meter_spend(failures)
    verify_close_play_flag(failures)
    verify_flat_ball_address(failures)
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
