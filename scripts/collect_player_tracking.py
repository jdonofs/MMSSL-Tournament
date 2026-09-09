"""Record every character's world coordinates during play, frame by frame.

WHY THIS EXISTS. The tracker already follows the ball, which is enough for
batted-ball metrics but says nothing about the nine people chasing it. Fielding
range, first-step reaction, route efficiency, throw velocity, and every
baserunning split are questions about where the *players* were, and the game
holds all of that in memory the whole time. This is the collector for it.

Like collect_fence_samples.py this is a separate Dolphin reader rather than
another patch to the tracker executable: no rebuild/verify cycle, nothing that
can break the working stat feed, and it runs happily alongside the tracker.

    pip install dolphin-memory-engine
    python scripts/collect_player_tracking.py

Ctrl-C to stop. Output is a compressed frame stream plus a JSON header in
data/player_tracking/, which analyse_player_tracking.py then reads.

WHAT IT CAPTURES, AND WHY IT CAPTURES SO MUCH. Every frame it stores the whole
28 KB game-state region -- all thirteen actor structs and every scalar the
tracker knows about -- rather than a chosen handful of fields. The reason is
that a recording session costs a human sitting at a controller playing real
innings, and the fields worth extracting are not all known yet: exactly which
of the position-shaped triples in an actor struct is the live one is settled by
looking at recorded motion, not by guessing beforehand. Capturing the region
whole means a new metric costs a re-analysis instead of another session. It is
affordable because Dolphin's memory is mapped, not piped -- a 28 KB read
benchmarks at 4 microseconds -- and because almost none of those bytes change
between consecutive frames, so the XOR delta below flattens them to zeros that
compress to nearly nothing.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import struct
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

from player_live_derivation import DEFAULT_POSITION_OFFSET, LiveDerivation
from player_tracking_io import dumps_play
from probe_ball_memory import (
    BALL_POINTER_SLOT,
    FALLBACK_OFFSET,
    hook,
    plausible_position,
    resolve_offset,
)

# The in-game state block. Static in MEM2 -- the community tracker hardcodes
# addresses throughout this range and they have never moved between runs, which
# is a stronger guarantee than anything this script could re-derive.
STATE_BASE = 0x900D5000
STATE_END = 0x900DBD40  # past the last offense actor
STATE_SIZE = STATE_END - STATE_BASE
GAME_TIMER = 0x900DFCFC  # outside the block; read separately

# DK Jungle's barrel, found by `scripts/probe_stadium_signals.py --motion` and
# confirmed by an operator watching the numbers move with a rolling barrel. See
# `docs/tracker-validation-console.md`. It is the first stadium hazard object
# located in any park, and it lives 45 MB past the state block, so it needs its
# own regions -- everything else the tracker knows is inside STATE_BASE..END.
#
# Two clusters, both small. 0x92AF5490 is the authoritative position; 0x92AF5570
# mirrors it while a barrel is live and goes stale after it despawns. The
# 0x92AE57xx cluster holds correlated components at stride 0x18 and is captured
# because it is nearly free and may yet explain the object's shape.
#
# Captured at EVERY park, not just DK Jungle. The read is 896 bytes a frame
# against the state block's 27,968, the XOR delta turns a park with no barrel
# into runs of zeros, and a uniform record format is worth far more than the
# bytes. What is park-specific is the INTERPRETATION, and that is gated in the
# derivation, not here.
EXTRA_REGIONS = [
    ("barrel_components", 0x92AE57C0, 0x180),
    ("barrel_transform", 0x92AF5400, 0x200),
]
CAPTURE_SIZE = STATE_SIZE + sum(size for _, _, size in EXTRA_REGIONS)

# The authoritative barrel position, as an absolute address.
BARREL_POSITION = 0x92AF5490
# Where the barrel sits when nothing is rolling: the two cannons, symmetric in
# x, 93.5 units out and 4 up. A barrel is LIVE exactly when the slot is away
# from both. Measured off a live trace, not guessed.
BARREL_CANNONS = ((-39.0, 4.0, -93.5), (39.0, 4.0, -93.5))

# The nine fielders, found the way the game finds them: a table of nine object
# pointers, one per defensive position, in table order.
FIELDER_POINTER_TABLE = 0x80708D78
POSITION_NAMES = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]
FIELDER_STRIDE = 0x2EC
FIELDER_VTABLE = 0x806434E8

# The batter and the three runners are a DIFFERENT actor class with its own
# vtable, which is why they are absent from the pointer table above and why
# searching for more instances of the fielder class never turns them up. They
# sit in an array of four immediately after the fielders.
#
# The base address is not a guess: the community tracker reads the batter's
# batting-order index from 0x900DB5F9, and the index byte sits at +0x29 in both
# actor classes, so the struct must begin 0x29 earlier. The runner slots then
# land exactly on the tracker's own first/second/third-base addresses.
OFFENSE_BASE = 0x900DB5D0
OFFENSE_STRIDE = 0x1D4
OFFENSE_VTABLE = 0x8064A318
OFFENSE_NAMES = ["BAT", "R1", "R2", "R3"]

# Offsets within an actor struct, shared by both classes where noted. These are
# recorded in the header rather than used to trim the capture -- the whole
# struct is stored regardless -- so that analysis has a starting point without
# having to rediscover them.
ACTOR_FIELDS = {
    "vtable": 0x000,
    "position_a": 0x004,       # candidate live position (x, y, z)
    "scale": 0x010,            # (1, 1, 1) on every actor; a type fingerprint
    "position_b": 0x038,       # second candidate; differs from A on the pitcher
    "batting_index": 0x029,    # u8, 0..8; 0xFF in an empty runner slot
    "character_id": 0x02B,     # u8, indexes the tracker's CHAR_ID_TO_NAME
    "buddy_jump_flag": 0x223,  # fielder class
    "airborne_flag": 0x22E,    # fielder class; a LEAP and nothing else
    # What the fielding AI decided to do about the ball, written on the frame
    # it commits and cleared on the frame the glove closes:
    #   1 ordinary catch   2 catch a throw   3 dive   6 leap   7 unresolved dash
    # 0x22E is set for 6 and never for 3, which is why every dive in the
    # archive read as an ordinary play until this byte was named. 0x2B3 and
    # 0x2B4 both read 2 for exactly the type-3 windows and 0/1 otherwise, so
    # they are a free cross-check on the classification.
    "catch_type": 0x2AC,
    # Fielder action enum, retained under its original header key for capture
    # compatibility: 1=secure fielding, 2/3=ordinary failed contacts,
    # 5=Yoshi egg's forced first bobble, 7=Buddy handoff/dash. It is not a
    # boolean bobble flag.
    "bobble_flag": 0x2B2,
    # Action-3's internal contact/animation counter. It starts at 1 on the same
    # frame as `last_contact_fielder`, advances once per frame, and stays zero
    # for an action-3 attempt that does not touch the ball. The global actor
    # scalar below is the primary signal; this is retained as an independent
    # actor-local audit field.
    "fielding_contact_counter": 0x2C4,
    # THE CLOSE PLAY, fielder class. MSS runs an A/B button-mash contest when a
    # runner and a throw reach a base together, and this is the fielder's side
    # of it. `+0x247` rises on the same frame and is not captured separately
    # until it is known to say something `+0x246` does not.
    #
    # THE VALUE IS THE OUTCOME, and it was read off the game's own `outs`
    # counter rather than off the operator's notes:
    #
    #   1   the fielder holds on. Possession lands +24 to +40 frames later and
    #       an out is recorded on the following frame. 4/4 onsets.
    #   2   the runner wins. `ball_status` goes to 3 -- the ball loose -- at
    #       EXACTLY +6 frames, and no out is recorded. 4/4 onsets. The flag then
    #       stays up for exactly 121 frames; the value-1 cases clear sooner and
    #       variably, between 100 and 116.
    #
    # Found from seven operator-annotated close plays over six sessions, all of
    # which name a base: it fires on C or 3B and nothing else, 6 for 6, which is
    # the mechanic's own "mostly at third base and home plate" and is not
    # something the search was told to look for. Six control sessions across
    # five parks -- 540,000 frames -- produce zero onsets.
    #
    # ONE LABELLED PLAY HAS NO ONSET: Luigi's Mansion PA67, "no one presses it
    # in time, and the runner is just out at third". So this may mark a contest
    # that was actually ENGAGED rather than every close play, and a timeout may
    # resolve without one. Treat a missing flag as "no contest recorded", never
    # as "no close play happened".
    "close_play_flag": 0x246,
    # A frozen fielder, fielder class. Peach Ice Garden's Freezies immobilise
    # whoever they touch, and the game says so plainly: 0x240 is 1 for exactly
    # 120 frames (2.000 s) and 0 otherwise, 0x20D counts those frames down
    # beside it so the freeze REMAINING is readable on any frame rather than
    # only at the onset, and 0x20F counts a further 60 frames of recovery
    # animation after 0x240 clears.
    #
    # It is a Freezie and not a generic stun. Six sessions at other parks --
    # Mario Stadium, Wario City, Luigi's Mansion, DK Jungle, Bowser Jr.
    # Playroom and Daisy Cruiser, 511,473 frames carrying labelled manhole
    # knockdowns, ghost attacks, flower gas, Chain Chomp hits and table stuns
    # -- produce zero runs of it. The two Peach sessions produce 54.
    "frozen_flag": 0x240,
    "frozen_timer": 0x20D,
    # A fielder in DK Jungle's flower gas, two bytes from the Freezie flag --
    # the game keeps its "this player is disabled" states together, which is
    # also why the Freezie search kept landing near here.
    #
    # Found by `probe_stadium_signals.py --stun` on 5 labelled dazes against 94
    # undazed actor-samples: 1 for the sprayed fielder and 0 for every other,
    # with zero chance separators in 2,000 permutations (p = 0.0005). Then
    # confirmed against a session recorded a day earlier and annotated by hand:
    # it fires at all four labelled flower sprays, at NEITHER labelled barrel
    # hit, and at frame 11154 it fires on two fielders at once -- which is
    # exactly what the operator wrote for that play.
    #
    # NOT exclusive to this park, unlike 0x240. A sweep of one session per park
    # finds it at DK Jungle (7 runs) and Daisy Cruiser (4, unlabelled) and at
    # none of the other seven, so it is plausibly a shared "stunned by a stadium
    # object" state that DK's flower and Daisy's table both write. At DK Jungle
    # it IS the flower, which the annotations establish; what it means at Daisy
    # is untested, and the deriver gates on park for that reason.
    "flower_gas_flag": 0x242,
    # A fielder KNOCKED DOWN by a stadium hazard. Not park-specific and not
    # hazard-specific: this is the physical-impact half of the disabled cluster,
    # where 0x242 is the gas half, and the two are complementary at DK Jungle --
    # 0x242 fires at 4 of 4 annotated flower sprays and 0 of 2 barrel hits,
    # 0x23F at 0 of 4 and 2 of 2.
    #
    # Found from Wario City's two annotated manhole knockdowns, where it has
    # three onsets in the whole session and all three fall in the two annotated
    # windows -- two of them together, matching an operator note that the
    # manhole "did it twice to koopa troopa". Then confirmed across the archive:
    #
    #   Mario Stadium       0   the one park with no gimmicks at all
    #   Peach Ice Garden    0   Freezies FREEZE (0x240); they do not knock down
    #   Luigi's Mansion     0
    #   Wario City          3   manhole
    #   DK Jungle           7   barrel
    #   Daisy Cruiser       4   table
    #   Bowser Castle       5   podoboo / thwomp / bob-omb
    #   Yoshi Park          4   piranha / train
    #   Bowser Jr Playroom 16   chain chomp / bullet bill
    #
    # Mario Stadium reading zero is the control that makes the rest mean
    # something. What KNOCKED a fielder down is still not named by this byte --
    # only that something did.
    "knockdown_flag": 0x23F,
    "bases_ran": 0x17D,        # offense class
    "is_stealing": 0x198,      # offense class
}

# Scalars pulled out per frame so the analysis does not have to re-derive the
# game situation from the raw block. Everything here is inside STATE_BASE..END,
# so these are slices of a read that already happened, not extra reads.
STATE_FIELDS = [
    ("inning", 0x900D5D97, "B"), ("inning_half", 0x900D5E25, "B"),
    ("outs", 0x900D5AA9, "B"), ("balls", 0x900D5AA8, "B"),
    ("strikes", 0x900D5AA7, "B"), ("game_state", 0x900D5C28, "B"),
    ("last_state", 0x900D5C29, "B"), ("ball_was_hit", 0x900D6A94, "B"),
    ("ball_status", 0x900D953A, "B"), ("home_run_flag", 0x900D953C, "B"),
    ("ball_holder", 0x900D66C9, "b"), ("last_ball_holder", 0x900D5056, "B"),
    ("batter_id", 0x900D69EF, "B"), ("batter_index", 0x900DB5F9, "B"),
    ("batter_bases_ran", 0x900DB74D, "B"), ("pitches", 0x900D692C, "B"),
    ("batters_this_inning", 0x900D5E35, "B"), ("num_bases_ran", 0x900D66D2, "b"),
    ("fair_or_foul", 0x900D9516, ">h"), ("runs_this_pitch", 0x900D5E30, "B"),
    ("outs_this_pitch", 0x900D5E31, "B"),
    # Found by diffing the whole state block across the two Buddy Throws in
    # wario_stadium-20260826T005958Z. All three idle at -1 and name a fielder by
    # its index in `actors.fielders` while they are set.
    #
    #   throw_target   the fielder the throw is AIMED at, set on all 37 detected
    #                  throws in that session and agreeing with the fielder who
    #                  actually received it on 35. The two it disagreed on were
    #                  both throws to second base that named the second baseman
    #                  while the shortstop covered -- which is the extra fact,
    #                  not an error: intent is what an arm-value or double-play
    #                  model needs, and it cannot be recovered from the catch.
    #   buddy_thrower  set for exactly the two Buddy Throws and nothing else,
    #                  naming the fielder who had the ball. An independent
    #                  confirmation of the frozen-cutscene detector.
    #   buddy_partner  the chemistry partner. Across eight Buddy Throws in two
    #                  parks it took four different values, was never the
    #                  fielder holding the ball and never the receiver, and
    #                  every pairing it produced has positive chemistry in the
    #                  league's own table -- Donkey Kong with Funky Kong, Dixie
    #                  Kong with Tiny Kong, Goomba with Monty Mole.
    ("throw_target", 0x900D951A, ">h"),
    # Ball-interaction actors, discovered by sweeping the complete recorded
    # state block around labelled contacts. Both idle at -1 and use the fielder
    # pointer-table order. `last_contact_fielder` named the involved actor on
    # every labelled boot, clean possession, egg contact, and Buddy handoff;
    # `contact_fielder` is a shorter-lived companion and is kept for auditing.
    ("contact_fielder", 0x900D9522, ">h"),
    ("last_contact_fielder", 0x900D9524, ">h"),
    ("buddy_thrower", 0x900D66D0, ">h"),
    ("buddy_partner", 0x900D66CE, ">h"),
    # THE BATTER SWUNG, OR DID NOT. `ball_was_hit` cannot answer this: it rises
    # only when the bat MEETS the ball, so a whiff and a taken pitch look
    # identical through it, and the tracker log has to call both `strike_unknown`.
    #
    # These two are animation frame counters for the batter's two ways of
    # offering at a pitch. Both idle at 0 and tick up once per frame while their
    # animation plays; on contact the game freezes the animation (the same
    # freeze that holds the ball at the plate before launch), so the counter
    # stops where it was. Found by sweeping the recorded state block across the
    # 156 pitches of bowser_castle-20260828T182145Z:
    #
    #   swing_frames  ran on 129 pitches and stayed 0 on 5. All four pitches
    #                 the game called BALLS are in that 5 -- a ball cannot be
    #                 thrown on a swing, so those are the ground truth, and the
    #                 split is total. It also fires on pitches as far outside as
    #                 the ones called balls (plate x -1.5 against balls at -1.3
    #                 to -2.0), which is what rules out the obvious rival
    #                 reading that this is a strike-zone flag rather than a swing.
    #   bunt_frames   ran on the 2 pitches Baby DK squared on and nothing else.
    #
    #   contact:  0->1->2->3 and stops    whiff: 0->1->...->29 and runs on
    #
    # At the 96 measured contacts exactly one of the two is non-zero, all 96
    # times, so they also separate a bunt from a swing without going near exit
    # velocity. bowser_jr_playroom-20260828T155225Z, a different park, has the
    # same addresses live and never has both counters running at once.
    ("swing_frames", 0x900D6A49, "B"),
    ("bunt_frames", 0x900D6A4F, "B"),
    #
    # THE LASER BEAM THROW. Up (1) from the frame the ball is released to the
    # frame it arrives, and 0 the rest of the time. Zero elsewhere in the whole
    # state block: this byte does nothing on any other kind of throw.
    #
    # It replaces a speed threshold that does not work. The move was calibrated
    # off ONE labelled throw at 105.7 mph and gated at 100, and Daisy Cruiser
    # 2026-09-04 broke that from both sides in a single game: the operator
    # labelled a Blue Pianta throw home that peaked at 84.5 -- indistinguishable
    # from Mario's two ordinary throws home at 84.6 and 84.8 -- while Wiggler,
    # who has no Laser Beam, threw home at 93.2, inside the band the
    # calibration called empty. Peak speed does not separate the move.
    #
    # Found by intersecting the whole 27,968-byte state region across the two
    # labelled throws against 194 control throws in three sessions. It was the
    # only byte left. What makes it a measurement rather than a fit:
    #
    #   DK Jungle 2026-09-04     1 run in 77,581 frames, starting on the exact
    #                            release frame of the labelled throw and lasting
    #                            its exact 77-frame flight.
    #   Daisy Cruiser 2026-09-04 2 runs in 91,582. One is the labelled throw,
    #                            again release-exact and flight-length exact.
    #   Yoshi Park 2026-08-31    0 runs in 62,759 -- the session where the
    #                            operator wrote that Red Pianta's throw home was
    #                            NOT a Laser Beam.
    #   Luigi's Mansion 20260902 1 run in 85,451, on the play the operator
    #                            annotated "missing the laser throw from yellow
    #                            pianta to home plate". A third park, a third
    #                            character, and the throw detector never saw it.
    #
    # The second Daisy run is the same shape: it begins on the frame King K.
    # Rool's possession ends, and King K. Rool has Laser Beam. So the flag also
    # finds the throws the possession segmentation misses, which is exactly what
    # the operator said was wrong at Luigi's Mansion.
    ("laser_throw_flag", 0x900D9AF5, "B"),
]

# The nine park keys, kept in step with STADIUM_NAME_TO_KEY in
# src/utils/stadiums.js. A session is labelled with one of these and nothing
# else: a misspelled key is not a cosmetic problem, because the fence geometry
# is looked up by it and an unknown key silently returns no fence at all --
# which turns off wall proximity and home-run robbery detection for the whole
# session without erroring.
PARK_KEYS = (
    "mario_stadium", "luigis_mansion", "peach_ice_garden", "daisy_cruiser",
    "wario_city", "yoshi_park", "dk_jungle", "bowser_jr_playroom",
    "bowser_castle",
)

# The game's own stadium byte. This is the stadium-menu order used by the game
# and by the repository's auto-team tooling. Six values are also independently
# pinned by recorded capture headers. Reading it here means a preview test never
# has to block its 60 Hz collector on a browser dropdown.
STADIUM_BYTE_TO_PARK = {
    0: "mario_stadium",
    1: "bowser_castle",
    2: "wario_city",
    3: "yoshi_park",
    4: "peach_ice_garden",
    5: "dk_jungle",
    6: "luigis_mansion",
    7: "daisy_cruiser",
    8: "bowser_jr_playroom",
}

# The two adjacent menu bytes carry the same day/night selection. Keep both in
# the metadata so a disagreement is visible instead of silently assigning a
# variant-specific stadium event to the wrong treatment.
DAY_NIGHT_ADDRESSES = (0x811F769E, 0x811F769F)

FRAME_MAGIC = b"MSSTRK02"

# Format 01 stored only the state block. 02 adds the nine fielder pointers to
# every frame, because those pointers are the one thing in this system that is
# allowed to move and the failure if they do is silent: the capture region is
# fixed at start-up, so a fielder object reallocated somewhere else would leave
# half a session reading stale bytes that still look like coordinates. Evidence
# says they do not move -- the community tracker hardcodes 0x900DAED2 for the
# left fielder's airborne flag and that only works if the object stays put
# across a change of sides -- but "the tracker seems to work" is not the same as
# knowing, and one 36-byte read per frame settles it from the data.


# THE RECORDING HANDSHAKE. A pid is not evidence and neither is "launched":
# the collector can be up, attached and reading a paused emulator, and a
# launcher that took either for proof would release the first pitch into a
# capture that has written nothing. So readiness is stated only once frames
# this process actually sampled have been flushed to the .bin -- the frame
# counter only advances when the game clock does, so a non-zero count is
# itself proof that the emulator is running and being read.
#
# CAPTURE_READY_MARKER is a contract with scripts/tracker_collector_feed.mjs.
# Keep the two in step.
CAPTURE_READY_MARKER = "[capture-ready] "

# THE OTHER HALF OF THE HANDSHAKE, AND WHY THERE HAS TO BE ONE.
#
# The readiness above cannot be reached while the game is not running: the
# frame counter only advances when the game clock does. That is what makes it
# good evidence, and it is also what made it useless for HOLDING the opening
# play -- a launcher that pauses the game to wait for the capture waits
# forever, because pausing the game is exactly what stops the counter.
#
# So the two claims are separated. "Attached" is everything this process can
# establish with the clock stopped: dolphin-memory-engine is attached, the
# stadium byte read, the ball offset resolved, the actors located, the header
# written and the stream file open. It is what gameplay is held for, because it
# is what can be true before the first pitch. "Recording" stays exactly as it
# was and is confirmed in the first half second of live play.
CAPTURE_ATTACHED_MARKER = "[capture-attached] "


def capture_attached_payload(*, stem, park, stadium_byte, ball_offset,
                             stream_path, actors, timer):
    """Everything provable with the game clock stopped."""
    return {
        "status": "attached",
        "stem": str(stem),
        "park": park,
        "stadium_byte": stadium_byte,
        "ball_offset": ball_offset,
        "stream_path": str(stream_path),
        "fielders": len(actors.get("fielders", [])),
        "offense": len(actors.get("offense", [])),
        "game_timer": int(timer),
        # Deliberately NOT "the game is running". The clock may well be stopped
        # -- held at a pitch reset is the case this exists for -- and claiming
        # otherwise would be the same overstatement the pid was.
        "attached": True,
    }


def capture_ready_payload(*, frames, missed_frames, bytes_on_disk, elapsed_s,
                          stem, park, timer, live=None):
    """The evidence line, built where it can be tested without an emulator."""
    payload = {
        "status": "recording",
        "frames": int(frames),
        "missed_frames": int(missed_frames),
        "bytes_on_disk": int(bytes_on_disk),
        "elapsed_s": round(float(elapsed_s), 3),
        "stem": str(stem),
        "park": park,
        "game_timer": int(timer),
        "calibration_status": (live.calibration_status if live is not None
                               else "disabled"),
    }
    # Frames counted but nothing on disk is not readiness -- it is a buffered
    # writer, and saying "recording" on it would be the same overstatement the
    # pid was. Both halves are required and the caller is told which failed.
    payload["ready"] = payload["frames"] > 0 and payload["bytes_on_disk"] > 0
    if not payload["ready"]:
        payload["reason"] = ("no frames sampled" if payload["frames"] <= 0
                             else "no bytes written to the capture file")
    return payload


def read_state_field(block: bytes, address: int, fmt: str):
    """Pull one scalar out of an already-captured state block."""
    off = address - STATE_BASE
    if fmt == "B":
        return block[off]
    if fmt == "b":
        value = block[off]
        return value - 256 if value > 127 else value
    return struct.unpack(fmt, block[off : off + struct.calcsize(fmt)])[0]


def resolve_actors(dme) -> dict:
    """Locate the thirteen actor structs and prove they are what we think.

    The fielder pointers are read from the game's own table, so they are right
    by construction. The offense base is a derived constant, so it is checked
    against the class vtable before a session is allowed to start -- a wrong
    base here would record 1872 bytes of unrelated memory and the failure would
    only surface hours later during analysis, which is exactly the silent kind
    of breakage that costs a whole session.
    """
    fielders = []
    table = dme.read_bytes(FIELDER_POINTER_TABLE, 4 * 9)
    for i, name in enumerate(POSITION_NAMES):
        pointer = struct.unpack(">I", table[i * 4 : i * 4 + 4])[0]
        if pointer == 0:
            raise SystemExit(
                f"The {name} fielder pointer is null. Start a game first -- the "
                "actor objects do not exist outside of play."
            )
        vtable = struct.unpack(">I", dme.read_bytes(pointer, 4))[0]
        if vtable != FIELDER_VTABLE:
            raise SystemExit(
                f"{name} at 0x{pointer:08X} has vtable 0x{vtable:08X}, not the "
                f"fielder class 0x{FIELDER_VTABLE:08X}."
            )
        fielders.append({"name": name, "address": pointer, "stride": FIELDER_STRIDE})

    offense = []
    for i, name in enumerate(OFFENSE_NAMES):
        address = OFFENSE_BASE + OFFENSE_STRIDE * i
        vtable = struct.unpack(">I", dme.read_bytes(address, 4))[0]
        if vtable != OFFENSE_VTABLE:
            raise SystemExit(
                f"Offense slot {name} at 0x{address:08X} has vtable "
                f"0x{vtable:08X}, not 0x{OFFENSE_VTABLE:08X}. The state block "
                "has moved; re-derive OFFENSE_BASE before recording."
            )
        offense.append({"name": name, "address": address, "stride": OFFENSE_STRIDE})

    # Every actor must fall inside the region actually being captured, or the
    # frames would not contain it.
    for actor in fielders + offense:
        end = actor["address"] + actor["stride"]
        if not (STATE_BASE <= actor["address"] and end <= STATE_END):
            raise SystemExit(
                f"{actor['name']} at 0x{actor['address']:08X} lies outside the "
                f"captured region 0x{STATE_BASE:08X}..0x{STATE_END:08X}."
            )
    return {"fielders": fielders, "offense": offense}


def lock_ball_offset(dme, timeout: float) -> int:
    """Wait for a pitch reset and take the ball's coordinate offset from it.

    The offset is chosen per stadium load, so the seed in probe_ball_memory is
    wrong more often than right and a stale one reads (0, 0, 0) forever without
    erroring. Blocking here is the cheap version of that failure.
    """
    deadline = time.time() + timeout
    warned = False
    while time.time() < deadline:
        pointer = struct.unpack(">I", dme.read_bytes(BALL_POINTER_SLOT, 4))[0]
        if pointer:
            offset = resolve_offset(dme, pointer)
            if offset is not None:
                x, y, z = struct.unpack(">fff", dme.read_bytes(pointer + offset, 12))
                if plausible_position(x, y, z):
                    return offset
        if not warned:
            print("  waiting for a pitch reset to calibrate the ball offset...")
            warned = True
        time.sleep(0.05)
    print(
        f"  WARNING: no pitch reset in {timeout:.0f}s. Falling back to "
        f"0x{FALLBACK_OFFSET:03X}, which is a seed and not a last-known-good; "
        "ball coordinates in this session may be meaningless."
    )
    return FALLBACK_OFFSET


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--park", default="auto", choices=("auto",) + PARK_KEYS,
                        metavar="PARK",
                        help="optional park fallback (default: detect from game memory): "
                             + ", ".join(PARK_KEYS))
    parser.add_argument("--out", default="data/player_tracking",
                        help="directory for the session files")
    parser.add_argument("--note", default="", help="free text stored in the header")
    parser.add_argument("--ball-timeout", type=float, default=90.0,
                        help="seconds to wait for a pitch reset before giving up")
    parser.add_argument("--max-seconds", type=float, default=0.0,
                        help="stop automatically after this long (0 = until Ctrl-C)")
    parser.add_argument("--stop-file", default=None,
                        help="stop cleanly when this path appears (bridge sidecar mode)")
    parser.add_argument("--manifest", default=None,
                        help="write sidecar status/stem JSON to this fixed path")
    parser.add_argument("--game-id", default=None,
                        help="database game id recorded in the session metadata")
    parser.add_argument("--competition-type", choices=("tournament", "season"),
                        default=None, help="database game family")
    parser.add_argument("--source-id", default=None,
                        help="tournament or season id recorded in metadata")
    # Live derivation turns the frames this loop already reads into finished
    # plays at the dead ball. It is on by default because the recording is
    # unaffected either way -- the .bin is written exactly as before and the
    # postgame pass over it stays authoritative -- and off is one flag away if
    # a capture ever needs the last microsecond of its frame budget.
    parser.add_argument("--no-live-derive", action="store_true",
                        help="record only; do not derive plays during capture")
    parser.add_argument("--position-offset", type=lambda v: int(v, 0),
                        default=DEFAULT_POSITION_OFFSET,
                        help="actor live-position offset for live derivation; "
                             "it is confirmed against the session itself "
                             "before any play is released")
    parser.add_argument("--live-out", default=None,
                        help="path for live plays (default <stem>.live.jsonl)")
    # How much capture has to exist before this process will claim to be
    # recording. Half a second of frames, flushed, is enough to prove the
    # emulator is running and the writer reaches the disk, and short enough
    # that a launcher waiting on it is not the reason the first pitch is late.
    parser.add_argument("--ready-frames", type=int, default=30,
                        help="frames that must be captured and flushed before "
                             "the [capture-ready] evidence line is printed")
    args = parser.parse_args()

    stop_path = Path(args.stop_file) if args.stop_file else None
    manifest_path = Path(args.manifest) if args.manifest else None

    def write_manifest(payload: dict) -> None:
        if not manifest_path:
            return
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=2))
        temporary.replace(manifest_path)

    dme = hook()
    actors = resolve_actors(dme)
    print("fielders  " + "  ".join(
        f"{a['name']}@0x{a['address']:08X}" for a in actors["fielders"]))
    print("offense   " + "  ".join(
        f"{a['name']}@0x{a['address']:08X}" for a in actors["offense"]))

    ball_offset = lock_ball_offset(dme, args.ball_timeout)
    print(f"ball coordinate offset 0x{ball_offset:03X}")

    # The game knows which park it is in, and that value outranks a supplied
    # fallback. Resolve it before naming the capture: the old order changed the
    # JSON header but left a mismatched filename when the fallback was wrong.
    stadium_byte = dme.read_bytes(0x811F769D, 1)[0]
    day_night_bytes = [dme.read_bytes(address, 1)[0]
                       for address in DAY_NIGHT_ADDRESSES]
    is_night = bool(day_night_bytes[0]) if len(set(day_night_bytes)) == 1 else None
    if is_night is None:
        print(f"  WARNING: day/night bytes disagree: {day_night_bytes}. "
              "The capture will preserve both and leave is_night unknown.", flush=True)
    named = STADIUM_BYTE_TO_PARK.get(stadium_byte)
    if named and args.park not in ("auto", named):
        print()
        print(f"  the game says this is {named}, not {args.park}. "
              f"Recording it as {named}.", flush=True)
    if named:
        args.park = named
    elif args.park == "auto":
        raise SystemExit(
            f"Stadium byte {stadium_byte} is outside the known 0..8 menu. "
            "No capture was started because labelling it with the wrong park "
            "would corrupt field geometry."
        )

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = out_dir / f"{args.park}-{stamp}"

    header = {
        "format": FRAME_MAGIC.decode(),
        "park": args.park,
        "note": args.note,
        "recorded_utc": stamp,
        "game_id": args.game_id,
        "competition_type": args.competition_type,
        "source_id": args.source_id,
        "state_base": STATE_BASE,
        "state_size": STATE_SIZE,
        # Regions captured beyond the state block, appended to every frame in
        # this order. Absent from older sessions, which read back unchanged.
        "extra_regions": [[n, b, sz] for n, b, sz in EXTRA_REGIONS],
        "capture_size": CAPTURE_SIZE,
        # Written into the header rather than only living in code, so a session
        # stays readable if these ever move.
        "barrel_position": BARREL_POSITION,
        "barrel_cannons": [list(c) for c in BARREL_CANNONS],
        "game_timer_address": GAME_TIMER,
        "ball_offset": ball_offset,
        "actor_fields": ACTOR_FIELDS,
        "state_fields": [[n, a, f] for n, a, f in STATE_FIELDS],
        "actors": actors,
        "stadium_byte": stadium_byte,
        "day_night_bytes": day_night_bytes,
        "is_night": is_night,
    }
    stem.with_suffix(".json").write_text(json.dumps(header, indent=2))
    write_manifest({
        "status": "recording",
        "stem": str(stem.resolve()),
        "header_path": str(stem.with_suffix(".json").resolve()),
        "stream_path": str(stem.with_suffix(".bin").resolve()),
        "game_id": args.game_id,
        "competition_type": args.competition_type,
        "source_id": args.source_id,
        "recorded_utc": stamp,
        "park": args.park,
        "stadium_byte": stadium_byte,
        "day_night_bytes": day_night_bytes,
        "is_night": is_night,
    })

    # Windows' default 15.6 ms timer granularity is coarser than a 16.5 ms game
    # frame, so an unadjusted sleep would miss frames outright. One millisecond
    # is enough to poll a 60 Hz counter without spinning a core flat.
    has_winmm = hasattr(ctypes, "windll")
    if has_winmm:
        ctypes.windll.winmm.timeBeginPeriod(1)

    # The live consumer of the same frames. It owns nothing the recording
    # depends on: if it raises, the capture carries on and says so.
    live = None
    if not args.no_live_derive:
        live_path = Path(args.live_out) if args.live_out else stem.with_suffix(".live.jsonl")
        pitches_path = stem.with_suffix(".pitches.jsonl")
        live = LiveDerivation(
            state_base=STATE_BASE,
            actors=([dict(a, kind="fielder") for a in actors["fielders"]]
                    + [dict(a, kind="offense") for a in actors["offense"]]),
            fields=ACTOR_FIELDS,
            state_fields=[[n, a, f] for n, a, f in STATE_FIELDS],
            out_path=live_path,
            pitches_path=pitches_path,
            position_offset=args.position_offset,
            # The live path sees the barrel through exactly the same
            # SnapshotBuilder the postgame pass uses, which is the whole reason
            # that class exists: two derivations that disagree about whether a
            # barrel was rolling would be worse than one that cannot see it.
            state_size=STATE_SIZE,
            extra_regions=EXTRA_REGIONS,
            barrel_address=BARREL_POSITION,
            barrel_cannons=BARREL_CANNONS,
            park=args.park,
        )
        header["live_plays_path"] = str(live_path)
        header["live_pitches_path"] = str(pitches_path)
        header["live_position_offset"] = args.position_offset
        stem.with_suffix(".json").write_text(json.dumps(header, indent=2))
        print(f"live derivation on, +0x{args.position_offset:03X} pending "
              f"confirmation -> {live_path}", flush=True)
    else:
        print("live derivation disabled (--no-live-derive)", flush=True)

    initial_status = live.status() if live is not None else {
        "calibration_status": "disabled",
        "plays_emitted": 0,
        "plays_withheld": 0,
    }
    initial_status.update({
        "status": "recording",
        "park": args.park,
        "stadium_byte": stadium_byte,
        "day_night_bytes": day_night_bytes,
        "is_night": is_night,
        "stem": str(stem.resolve()),
        "live_path": str(live_path.resolve()) if live is not None else None,
    })
    print("[live-status] " + json.dumps(initial_status), flush=True)

    compressor = zlib.compressobj(6)
    frames = 0
    skips = 0
    wandered = False
    previous = bytes(CAPTURE_SIZE)
    started = time.perf_counter()
    last_timer = None
    last_report = started

    print("\nrecording -- play normally. Ctrl-C to stop.\n")
    capture_ready_announced = False
    stream_path = stem.with_suffix(".bin")
    sink = stream_path.open("wb")
    try:
        sink.write(FRAME_MAGIC)
        sink.flush()
        # Printed before the first frame is read, on purpose: this is the claim
        # a held game can wait for. Nothing here needs the clock to advance.
        try:
            attached_timer = struct.unpack(">I", dme.read_bytes(GAME_TIMER, 4))[0]
        except Exception:                                # noqa: BLE001 - diagnostic only
            attached_timer = 0
        print(CAPTURE_ATTACHED_MARKER + json.dumps(capture_attached_payload(
            stem=stem.resolve(), park=args.park, stadium_byte=stadium_byte,
            ball_offset=ball_offset, stream_path=stream_path.resolve(),
            actors=actors, timer=attached_timer)), flush=True)
        stalled_since = None
        while True:
            timer = struct.unpack(">I", dme.read_bytes(GAME_TIMER, 4))[0]
            if timer == last_timer:
                # The game clock stops dead whenever the emulator is paused, and
                # Dolphin pauses itself on losing focus. Waiting on it silently
                # is indistinguishable from a hung collector, so say what is
                # happening and keep honouring --max-seconds and Ctrl-C.
                now = time.perf_counter()
                if stalled_since is None:
                    stalled_since = now
                elif now - stalled_since >= 5.0:
                    print(f"  game clock has not advanced for "
                          f"{now - stalled_since:.0f}s -- emulator paused?",
                          flush=True)
                    stalled_since = now
                if args.max_seconds and now - started >= args.max_seconds:
                    break
                if stop_path and stop_path.exists():
                    print(f"  stop signal received ({stop_path})", flush=True)
                    break
                time.sleep(0.001)
                continue
            stalled_since = None
            # A jump of more than one means a frame went by unsampled. It is
            # recorded rather than hidden, because a velocity computed across a
            # gap is wrong and the analysis has to know where to distrust.
            if last_timer is not None and timer - last_timer > 1:
                skips += timer - last_timer - 1
            last_timer = timer

            block = dme.read_bytes(STATE_BASE, STATE_SIZE)
            # Appended to the same buffer so one XOR delta covers everything and
            # the record format stays a single block. Offsets past STATE_SIZE
            # belong to EXTRA_REGIONS in order; `capture_offset` in
            # player_tracking_io is the only thing that needs to know that.
            for _, base, size in EXTRA_REGIONS:
                block += dme.read_bytes(base, size)
            pointers = dme.read_bytes(FIELDER_POINTER_TABLE, 36)
            if not wandered:
                for i in range(9):
                    target = struct.unpack(">I", pointers[i * 4 : i * 4 + 4])[0]
                    if not (STATE_BASE <= target
                            and target + FIELDER_STRIDE <= STATE_END):
                        wandered = True
                        print(
                            f"  *** {POSITION_NAMES[i]} now points at "
                            f"0x{target:08X}, outside the captured region. "
                            "Its coordinates from here on are STALE. Stop, and "
                            "widen STATE_BASE..STATE_END to cover it.",
                            flush=True,
                        )
                        break
            ball_pointer = struct.unpack(">I", dme.read_bytes(BALL_POINTER_SLOT, 4))[0]
            if ball_pointer:
                ball = dme.read_bytes(ball_pointer + ball_offset, 12)
            else:
                ball = struct.pack(">fff", 0.0, 0.0, 0.0)

            # XOR against the previous frame: thirteen actor structs are mostly
            # constant between consecutive frames, so this turns almost all of
            # the payload into runs of zero bytes before zlib ever sees it.
            # Lossless, and it is what makes 60 Hz whole-region capture cost
            # megabytes instead of gigabytes.
            delta = bytes(a ^ b for a, b in zip(block, previous))
            previous = block

            record = (struct.pack(">IdI", timer, time.perf_counter() - started,
                                  ball_pointer) + ball + pointers + delta)
            sink.write(compressor.compress(struct.pack(">I", len(record)) + record))
            frames += 1

            # One sync flush, once, at the readiness threshold. It costs a
            # fraction of a percent of compression on one block and buys the
            # only honest answer to "are frames on disk yet": the file's own
            # size, read back from the filesystem.
            if not capture_ready_announced and frames >= max(1, args.ready_frames):
                capture_ready_announced = True
                try:
                    sink.write(compressor.flush(zlib.Z_SYNC_FLUSH))
                    sink.flush()
                    bytes_on_disk = stream_path.stat().st_size
                except OSError as error:      # noqa: BLE001 - never fatal
                    bytes_on_disk = 0
                    print(f"  could not flush the capture for the readiness "
                          f"check: {error!r}", flush=True)
                print(CAPTURE_READY_MARKER + json.dumps(capture_ready_payload(
                    frames=frames, missed_frames=skips,
                    bytes_on_disk=bytes_on_disk,
                    elapsed_s=time.perf_counter() - started,
                    stem=str(stem.resolve()), park=args.park, timer=timer,
                    live=live,
                )), flush=True)

            # The recording is already durable at this point. Anything the live
            # derivation gets wrong from here can cost a play on a page; it
            # cannot cost a frame on disk.
            if live is not None:
                try:
                    for play in live.feed(
                        timer, struct.unpack(">fff", ball), block,
                        struct.unpack(">9I", pointers),
                    ):
                        print("[live-play] " + dumps_play(play), flush=True)
                    # Pitches come off the same frame but through their own
                    # accessor, because they are not gated on the calibration.
                    for pitch in live.take_pitches():
                        print("[live-pitch] " + dumps_play(pitch), flush=True)
                except Exception as error:      # noqa: BLE001 - never fatal
                    print(f"  live derivation stopped after an error: {error!r}",
                          flush=True)
                    live = None

            now = time.perf_counter()
            if now - last_report >= 2.0:
                elapsed = now - started
                print(
                    f"  {elapsed:6.1f}s  {frames:7d} frames "
                    f"({frames / elapsed:5.1f}/s, {skips} missed)  "
                    f"{sink.tell() / 1e6:6.2f} MB  "
                    f"inning {read_state_field(block, 0x900D5D97, 'B')}"
                    f".{read_state_field(block, 0x900D5E25, 'B')} "
                    f"{read_state_field(block, 0x900D5AA9, 'B')} out  "
                    f"holder={read_state_field(block, 0x900D66C9, 'b')}"
                    + (f"  live {live.plays_emitted} plays "
                       f"({live.calibration_status}, "
                       f"{live.status()['mean_feed_ms']:.3f} ms/frame)"
                       if live is not None else ""),
                    flush=True,
                )
                if live is not None:
                    status = live.status()
                    status.update({
                        "status": "recording",
                        "park": args.park,
                        "stadium_byte": stadium_byte,
                        "day_night_bytes": day_night_bytes,
                        "is_night": is_night,
                        "stem": str(stem.resolve()),
                        "live_path": str(live_path.resolve()),
                    })
                    print("[live-status] " + json.dumps(status), flush=True)
                last_report = now
            if args.max_seconds and now - started >= args.max_seconds:
                break
            if stop_path and stop_path.exists():
                print(f"  stop signal received ({stop_path})", flush=True)
                break
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        if live is not None:
            try:
                for play in live.close():
                    print("[live-play] " + dumps_play(play), flush=True)
                for pitch in live.take_pitches():
                    print("[live-pitch] " + dumps_play(pitch), flush=True)
            except Exception as error:          # noqa: BLE001 - never fatal
                print(f"  live derivation close failed: {error!r}", flush=True)
        sink.write(compressor.flush())
        sink.close()
        if has_winmm:
            ctypes.windll.winmm.timeEndPeriod(1)

    elapsed = time.perf_counter() - started
    size = stem.with_suffix(".bin").stat().st_size
    header["frames"] = frames
    header["missed_frames"] = skips
    header["fielder_pointers_left_region"] = wandered
    header["duration_seconds"] = round(elapsed, 3)
    if live is not None:
        header["live_derivation"] = live.status()
    header["checksum_sha256"] = hashlib.sha256(
        stem.with_suffix(".bin").read_bytes()).hexdigest()
    stem.with_suffix(".json").write_text(json.dumps(header, indent=2))
    write_manifest({
        "status": "captured",
        "stem": str(stem.resolve()),
        "header_path": str(stem.with_suffix(".json").resolve()),
        "stream_path": str(stem.with_suffix(".bin").resolve()),
        "game_id": args.game_id,
        "competition_type": args.competition_type,
        "source_id": args.source_id,
        "recorded_utc": stamp,
        "park": args.park,
        "stadium_byte": stadium_byte,
        "day_night_bytes": day_night_bytes,
        "is_night": is_night,
        "frames": frames,
        "missed_frames": skips,
        "duration_seconds": round(elapsed, 3),
        "checksum_sha256": header["checksum_sha256"],
        "fielder_pointers_left_region": wandered,
        "live_derivation": live.status() if live is not None else None,
    })
    print(
        f"\n{frames} frames in {elapsed:.1f}s "
        f"({frames / max(elapsed, 1e-9):.1f}/s, {skips} missed) -> "
        f"{stem.with_suffix('.bin')} ({size / 1e6:.2f} MB, "
        f"{size / max(frames, 1):.0f} B/frame)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
