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
import math
import os
import struct
import subprocess
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import capture_evidence_schema as evidence
from player_live_derivation import DEFAULT_POSITION_OFFSET, LiveDerivation
from player_tracking_io import dumps_play
from mss_input import PORT_STRIDE, PORT_STRUCTS
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
#
# The base was 0x900D5000 until 2026-09-25. It moved down 512 bytes because the
# TEAM STAR METERS sit at 0x900D4E24 and 0x900D4E26 -- 476 bytes below the old
# start, and therefore absent from every session captured before that date. An
# exhaustive search of the old region for a byte that steps down at a star swing
# came back empty against a permutation control, which is exactly what it should
# do when the counter is not in the bytes being searched. The addresses are not
# a guess: they are read by the vendored public tracker
# (`public-tracker-release/stat_tracker.py`, _assign_score_and_meter_fields),
# which is the same source the rest of this range comes from.
STATE_BASE = 0x900D4E00
STATE_END = 0x900DBD40  # past the last offense actor
STATE_SIZE = STATE_END - STATE_BASE
GAME_TIMER = 0x900DFCFC  # outside the block; read separately

# What one star costs off the team meter, by who spent it. Constants in MEM1
# rather than per-frame state, so they are read once and written into the header
# instead of into every frame. Read by the vendored public tracker as s16.
#
# The three exist because the price is not flat: an ordinary character pays the
# regular cost, a captain pays the captain cost, and a captain playing for the
# team he captains pays the regular one. Reading them rather than hardcoding a
# 1/2/1 rule means a game whose values differ is still priced correctly.
STAR_COST_ADDRESSES = {
    "regular": 0x8062BD48,
    "captain": 0x8062BD4A,
    "non_main_captain": 0x8062BD42,
}

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
    # BOTH REAL WIIMOTES, INCLUDING THEIR 16-ENTRY INPUT SAMPLE ARRAYS.  The three
    # button words alone cannot separate an ordinary slap from the pull-back
    # gesture that charges a swing.  The whole 0x538-byte per-port struct is
    # therefore retained losslessly so that a labelled gesture calibration can
    # identify the charge-bearing bytes without asking players to replay games.
    # Port 1 and port 2 are adjacent but named independently in the header so
    # controller/team attribution can be audited rather than assumed.
    ("wiimote_1_input", PORT_STRUCTS[1], PORT_STRIDE),
    ("wiimote_2_input", PORT_STRUCTS[2], PORT_STRIDE),
    # YOSHI PARK'S TRAIN. The stable world-position copy found by the full-memory
    # knockdown probe on 2026-09-11. It is only twelve bytes, and recording it at
    # every park keeps the frame layout uniform; interpretation remains park-gated.
    ("yoshi_train_position", 0x811F84DC, 0x0C),
    ("barrel_components", 0x92AE57C0, 0x180),
    ("barrel_transform", 0x92AF5400, 0x200),
    ("freezie_objects", 0x92A3E000, 0x2000),
]

# PEACH ICE GARDEN'S FREEZIES, found the same way the barrel was and for the
# same reason: every search inside the state block came back empty, because the
# object is not in it. Five of them, in an array of stride 0xAC observed at
# 0x92A3E674 in the calibration match, each carrying two copies of a 3x4
# transform 0x30 apart. The allocation MOVES between matches, so that address is
# a signature seed and never the address a new Peach capture trusts.
#
# THEY ARE NOT A POSITION TRIPLE, which is why nothing found them for weeks. The
# rotation is identity and the translation is its last column, so the three
# coordinates sit 16 bytes apart:
#
#     1 0 0 tx        a triple read at tx returns (tx, 0.0, 1.0) -- row 1's
#     0 1 0 ty        leading 0 and 1, not ty and tz. Every triple scanner
#     0 0 1 tz        this repo has run was looking for three floats in a row.
#
# Found by `probe_stadium_signals.py --motion` over operator-labelled events at
# Peach, then completed by the full dynamic capture: the motion scan exposed the
# trailing four slots and the capture exposed a fifth one stride before them.
# They slide LEFT TO RIGHT AND BACK, over and over. The five slots hold x-gaps
# of exactly -40.0, +15.0, -55.0 and -20.0,
# step by identical amounts every frame, and reverse at the ends of the sweep --
# five objects moving as one rigid group, which no runner or ball does.
#
# The region is 8 KB and covers the array with room either side, because the
# whole struct is wanted rather than the one float: a Freezie BREAK has to be
# somewhere in it, and 27,968 bytes of state block already proved it is nowhere
# else. Captured at every park for the reason the barrel is -- see above.
# CONFIRMED AGAINST THE FREEZES, which is the control that makes the rest of
# this mean something. Read live, the five slots patrol three fixed depths --
# z = -50 (two), -75 (two) and -95 -- each sweeping about 20 units of x and
# reversing at the ends. Every one of the 75 measured freeze onsets in the four
# annotated Peach sessions happened within 6 units of one of those three depths,
# and the histogram is three clean bands with NOTHING between them:
#
#     z -100..-90   10 freezes      the -95 lane
#     z  -80..-70   23 freezes      the two -75 lanes
#     z  -55..-45   42 freezes      the -50 lane
#
# 63 of the 75 also fall inside the x sweep observed in a 15-second sample, and
# the 12 that do not are on the busiest depth, where two Freezies patrol.
#
# THE TRANSLATION IS ALREADY IN THE BALL FRAME. A fielder's raw position_a reads
# z = +53 where the Freezie matrix reads -50, and Peach's fit is sign_z = -1 --
# so the actor needs the conversion and the matrix does not. Verified at this
# park only; a park whose fit swaps or flips x would need checking again.
FREEZIE_ARRAY = 0x92A3E674
FREEZIE_STRIDE = 0xAC
FREEZIE_COUNT = 5
FREEZIE_REGION_LEAD = FREEZIE_ARRAY - 0x92A3E000
FREEZIE_REGION_SIZE = 0x2000
FREEZIE_SEARCH_START = 0x90000000
FREEZIE_SEARCH_END = 0x94000000
FREEZIE_SEARCH_CHUNK = 1 << 20
# Within one slot: the transform, its copy, and the translation column inside
# each. `tx` is what --motion shortlisted; ty and tz follow at 16-byte steps.
FREEZIE_TRANSFORM = 0x00
FREEZIE_TRANSFORM_COPY = 0x30
FREEZIE_TRANSLATION = (0x0C, 0x1C, 0x2C)
# 1 while present, 0 on the exact frame it breaks. Ball proximity, an active
# throw, or a buddy-attack contact determines the cause downstream. The
# transform then freezes at its last position until the game respawns or resets.
FREEZIE_ACTIVE_OFFSET = 0x8A
# The three depths the Freezies patrol, for the derivation to sanity-check
# against. Not a detector -- an object off these lanes means the array moved.
FREEZIE_LANE_DEPTHS = (-50.0, -75.0, -95.0)

# WARIO CITY'S DIRECTIONAL ARROWS. Found from the effect first, the way the
# flower was: three sessions on disk carry 17 operator-annotated redirects, and
# every one of them is the same single frame -- the ball's horizontal speed is
# SET to 0.19909 units/frame (11.945 u/s) and its heading SNAPS to a bearing it
# then holds to +-0.002 degrees while the speed decays normally. Measured across
# 2026-09-02, -04 and -05 the bearings are only ever +-45, +-78, +-102, +-135,
# and 102 = 180 - 78 and 135 = 180 - 45: an arrow imposes an AXIS and the ball
# keeps the sign it arrived with. So the object holds an orientation, and the
# orientation is a number the capture can be checked against afterwards.
#
# WHY --motion CANNOT FIND THEM. The Freezie and the barrel were both found by
# looking for something that moves. An arrow does not move: it is placed at the
# start of a match, sits there, and is in a different place next match. The
# search has to be for a STRUCTURE, not for motion.
#
# THE STRUCTURE IS A SCALED Y-ROTATION TRANSFORM. A placed prop with a heading
# is a 3x4 matrix whose rotation is a rotation about the world's vertical,
# times a uniform scale s:
#
#    sc 0 ss tx     the middle row is exactly (0, s, 0), (sc, ss) has norm s,
#     0 s  0 ty     and the object's heading is atan2(ss, sc) -- which is the
#   -ss 0 sc tz     same quantity the redirect measures off the ball.
#
# THE SCALE IS NOT COSMETIC TO THIS SEARCH. The first version of it required
# s == 1 and found the eight arrows and nothing else. Wario City's manholes are
# the same class of object in the same allocation at the same 0xAC stride -- and
# they are drawn at s = 0.7, theta = 0, so every one of them failed both the
# unit-norm test and the m[5] == 1 test. Five manholes sat 6.7 KB below the
# region the arrows caused to be captured and went unrecorded for a whole
# session. Allowing any positive uniform scale costs nothing on the shortlist
# and is the difference between finding one hazard and finding two.
#
# That is a far tighter signature than "three floats in a row": five exact
# zeros, an exact one, a mirrored pair and a unit-norm constraint. Counted
# against a live Peach Ice Garden match over the whole of MEM2, the whole of
# 0x90000000..0x94000000 holds fifty of them with a field-plausible translation,
# and they sit in two obvious arrays. Fifty candidates in 64 MB is a shortlist,
# not a search space.
#
# NOTHING HERE CLAIMS AN ARROW HAS BEEN FOUND. The scan produces candidates and
# the capture records them; whether Wario City's arrows are among them is
# settled after the session by checking a candidate's angle and translation
# against the redirects measured off the ball in the same game. Until that check
# passes, these are placed props of unknown identity, and the derivation is not
# told otherwise.
ARROW_SEARCH_START = 0x90000000
ARROW_SEARCH_END = 0x94000000
ARROW_SEARCH_CHUNK = 1 << 22
# Row-major 3x4: rotation in columns 0..2 of each row, translation in column 3.
ARROW_TRANSFORM_FLOATS = 12
ARROW_TRANSLATION = (0x0C, 0x1C, 0x2C)
# A placed prop stands somewhere a ball can reach. The park is about 120 units
# wide and 140 deep with the fence at ~98; a translation outside this is not a
# spot on the field, and the origin itself is home plate, which no prop sits on.
ARROW_MAX_X = 130.0
ARROW_MAX_Y = 60.0
ARROW_MAX_Z = 150.0
ARROW_MIN_RADIUS = 1.0
# A scale has to be a real one. Below this the matrix is degenerate and above it
# nothing in a ball park is drawn; both ends are bytes that happen to look like
# a matrix rather than an object.
ARROW_MIN_SCALE = 0.05
ARROW_MAX_SCALE = 20.0
# Candidates this far apart are not in the same array. 64 KB is generous next to
# the 0x164 stride the Peach cluster uses and still cannot swallow two unrelated
# allocations at opposite ends of MEM2.
ARROW_CLUSTER_GAP = 0x10000
# What actually gets read every frame. Padded around the cluster so the bytes
# BESIDE the transform -- an active flag, a collision state, the manhole if it
# is a neighbour -- are captured too, the way the Freezie region deliberately
# covers 8 KB around a 0x364 array. Capped because a 60 Hz read has a budget:
# measured on this machine, 1 MB a frame costs 4.9 ms of a 16.6 ms frame,
# 128 KB costs 0.6 ms and the state block itself costs 0.12 ms. The cap is the
# point past which the region stops being an object and starts being a sweep.
#
# WIDENED FROM 0x1000 ON 2026-09-10, for a reason the narrow pad demonstrated:
# the thing that ERUPTS out of a manhole is not in the manhole's own struct.
# Every byte of all five structs was scanned across a full session and only
# three vary, none of them the eruption -- fielders stand on a manhole in its
# "27" state for 620 frames across 11 visits without being touched, and the
# transform never moves. So the water column is a separate object, and 4 KB
# either side of the prop array was not enough to contain it. 32 KB either side
# costs 0.5 ms of a 16.6 ms frame, measured, against 0.35 ms for the old pad.
ARROW_REGION_PAD = 0x8000
ARROW_REGION_MAX = 0x20000

# A one-time copy of the stadium's memory, written beside the capture before
# recording starts and again when it stops. It is the fallback for point 6: if
# the structural scan turns out to have been looking for the wrong shape, the
# arrows and the manhole are still IN this file and can be searched for offline
# against the redirects the same session measured -- without playing the game
# again. Reading all of MEM2 costs 0.13 s and happens outside the frame loop.
STADIUM_DUMP_START = 0x90000000
STADIUM_DUMP_END = 0x94000000
STADIUM_DUMP_CHUNK = 1 << 22

# THE MEMORY PROBE -- scripts/memory_probe.py, a separate process that copies
# all of MEM1 and MEM2 when asked. It found Yoshi Park's stable train position
# copy at 0x811F84DC after the second day game supplied enough differently
# placed knockdowns to separate the moving train from field geometry. New
# captures record that value directly; the probe remains available for the next
# confirmation game and for finding the night Wiggler's separate object.
#
# Capped because each copy is megabytes. On for test games at Yoshi Park; a
# --game-id capture is a real league game and gets it only when asked
# (TRACKER_MEMORY_PROBE=1).
MEMORY_PROBE_PARKS = ("yoshi_park",)
MEMORY_PROBE_MAX_COPIES = 24
# Long enough to finish the copy in progress. The launchers give the whole
# collector 30 s to exit, and a probe still writing after this finishes on its own.
MEMORY_PROBE_EXIT_S = 10.0

CAPTURE_SIZE = STATE_SIZE + sum(size for _, _, size in EXTRA_REGIONS)

# The barrel position found live on 2026-09-03. Kept as the SEED and the
# fallback; see locate_barrel for why it is no longer trusted on its own.
BARREL_POSITION = 0x92AF5490
# Where the barrel sits when nothing is rolling: the two cannons, symmetric in
# x, 93.5 units out and 4 up. A barrel is LIVE exactly when the slot is away
# from both. Measured off a live trace, not guessed.
BARREL_CANNONS = ((-39.0, 4.0, -93.5), (39.0, 4.0, -93.5))

# THE BARREL ALLOCATION MOVES BETWEEN MATCHES, and the address above is dead.
#
# It was captured from the session after it was found, and in BOTH DK Jungle
# captures that record it the slot holds nothing: dk_jungle-20260912T150755Z
# reads all-zero on 108,535 of its 110,962 frames and garbage (-8.9e33) on the
# remaining 2,427, and dk_jungle-20260904T161731Z reads all-zero on 77,371 of
# 77,581 with one 137-frame run of a constant. No cannon sentinel appears in
# either recording. That is the same failure Peach's Freezie array has -- its
# comment above says the allocation moves and that a remembered address must
# never be trusted -- except the Freezie is located structurally at capture time
# and the barrel was not. So DK Jungle recorded 384 plays' worth of a dead slot,
# and the six barrel hits the operator annotated have no object behind them.
#
# THE SENTINEL IS THE SIGNATURE. A parked barrel sits on one of exactly two
# cannon positions, so three exact floats in a row identify the slot -- a
# tighter signature than the arrow's matrix shape, and one that needs no cluster
# to be convincing. The search runs once, before recording, like the other two.
BARREL_SEARCH_START = 0x90000000
BARREL_SEARCH_END = 0x94000000
BARREL_SEARCH_CHUNK = 1 << 22
# The values are written exactly; this only guards the float comparison.
BARREL_SENTINEL_TOLERANCE = 1e-3
# MORE THAN ONE CANDIDATE IS EXPECTED, so uniqueness must not be required the
# way it is for the Freezie. The authoritative slot has a mirror that holds the
# same position while a barrel is live -- 0x92AF5570, 0xE0 past 0x92AF5490 in
# the allocation this was first found in. Candidates further apart than this are
# different allocations rather than one object's several windows.
BARREL_CLUSTER_GAP = 0x10000
BARREL_REGION_PAD = 0x100
BARREL_REGION_MAX = 0x1000

# Stable across both full-memory Yoshi Park probes. At every one of 26
# train-classified knockdowns it followed the outfield loop and sat within the
# train body's measured 12u reach of the floored fielder. Unlike the allocation
# transforms also found by the probe, this MEM1 copy did not move between games.
YOSHI_TRAIN_POSITION = 0x811F84DC

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
    # Not a second candidate position: it is where the actor is STEERING, which
    # is why it differs from A on the pitcher and why it drives the turn.
    "position_b": 0x038,
    # THE FIELDER'S OWN SPEED AND ITS CEILING. FIELDER CLASS ONLY.
    #
    # +0x0E4 is ground speed and +0x0F0 is the acceleration constant, which the
    # game sets to max_speed/15 -- so the character's top speed is +0x0F0 * 15.
    # BOTH ARE PER FRAME. Multiplying by 60 puts +0x0E4 within a median
    # 0.0003 u/s of the speed derive_player_metrics.py measures by differencing
    # +0x004 over 354,000 moving frames.
    #
    # WHAT MAKES THIS WORTH HAVING IS THE DISAGREEMENTS. While the game GLIDES a
    # fielder to the ball, +0x0E4 reads exactly 0.0 while the body covers ground
    # at up to 163 u/s. The game is saying outright that it is moving the body
    # rather than the character running, which is the distinction
    # ASSIST_SPEED_UPS_FIELDER had to guess at from step magnitude alone.
    #
    # And +0x0F0 settles what the guess got wrong. Measured sprint speed
    # correlated with the characters table's own run_speed at MINUS 0.66;
    # +0x0F0 * 15 * 60 correlates at 0.9675, rank 0.9885, across 65 characters
    # and every session on disk -- 7.26 u/s for King K. Rool (run_speed 10) up
    # to 8.46 for Yoshi (90), monotone the whole way.
    #
    # THE OFFENSE CLASS DOES NOT SHARE THEM. Both offsets are inside its 0x1D4
    # bytes and both hold something else: across 40,000 frames the batter and
    # runners match on ZERO moving frames, and their +0x0F0 steps through exact
    # multiples of 10.8. Runners keep ASSIST_SPEED_UPS_RUNNER.
    "speed": 0x0E4,
    "max_speed_constant": 0x0F0,
    "angular_velocity": 0x0DC,
    # The game's own ground-plane distances, fielder class: to the live ball,
    # and to where the ball will first touch down. CARRIED BUT NOT TRUSTED --
    # they only approximately reproduce the distance computed from the captured
    # coordinates (79% and 52% of 4.17M frames to 0.05u) and what accounts for
    # the rest is not yet known. See player_tracking_io.py.
    "ball_distance": 0x13C,
    "landing_distance": 0x148,
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
    # NOT exclusive to this park, unlike 0x240. It is also PEACH'S HEART star
    # swing: every Daisy Cruiser onset in the archive (5 of 5, one annotated on
    # 2026-09-11) is on a Peach captain swing, and it fires on two Peach plate
    # appearances at Mario Stadium, which has no gimmicks. At DK Jungle it IS the
    # flower, which the annotations establish; the deriver names the flower only
    # there, and the heart only on Peach's swing.
    "flower_gas_flag": 0x242,
    # DK Jungle NIGHT uses a different byte for the same flower effect. In the
    # 2026-09-12 night capture +0x242 never rose, while +0x2CA rose exactly four
    # times: the four operator-confirmed sprays. The annotated near miss did
    # not raise it, and daytime DK plus night Yoshi controls had no onsets.
    # Keep both bytes: Peach's heart and daytime flowers still use +0x242.
    "flower_gas_night_flag": 0x2CA,
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
    # THE BUDDY ATTACK -- a fielder's swipe at whatever is in his path. It is
    # deliberately separate from Freezie breaks: character contact freezes the
    # character, while only ball contact breaks a Freezie.
    #
    # 0x265 is the phase, running 1 -> 2 -> 4 over 53-73 frames and 0 otherwise.
    # 0x20B counts those frames beside it. 0x267 is the hit confirmation: it
    # latches to 1 a few frames into an attack that actually connects and stays
    # zero for a miss. That distinction matters at Peach -- an attack animation
    # is not evidence that a Freezie was in its path.
    #
    # Found from the operator-annotated Peach Ice Garden archive: five sessions,
    # eleven confirmed attacks and one confirmed miss. 0x265 fires for all
    # twelve attacks and its run shape is never anything but {1, 2, 4}; 0x267
    # separates the eleven contacts from the miss. Thirteen more
    # unannotated plays fire it; the one opened by hand (20260907T234715Z, CF at
    # timer 15051) has the identical 52-frame signature, so those are attacks
    # the operator did not write down rather than false positives.
    #
    # It is NOT the buddy jump at 0x223, which fires on 0 of the 10, and it is
    # not park-specific: Wario City has 2 in a full game against Peach's attacks.
    # Five times the rate at the one park with something in the way is the
    # Freezies, but this byte says a fielder swung, never what he swung at.
    "buddy_attack_flag": 0x265,
    "buddy_attack_frames": 0x20B,
    "buddy_attack_hit_flag": 0x267,
    # Generic impact-stun state. Value 2 covers Daisy Cruiser table impacts and
    # Bowser Jr.'s paint. DK Jungle night uses value 1 for the statue POW: the
    # 2026-09-12 capture has exactly three 91-frame runs, matching all three
    # annotated POW knockdowns and no no-hit activations.
    "impact_stun_flag": 0x243,
    # BURNED. 1 for 89 frames. Across the three annotated Daisy Cruiser games
    # every onset is on a Mario fireball (4 of 4, each on the frame of the
    # star_ball misplay) or a Bowser fire breath (4 of 4, 2-7.5u from the ball,
    # so an area rather than a touch). None of the three Yoshi-egg forced
    # misplays in the 09-04 game raised it, so it is the fire and not "a star
    # ball". Bowser Castle raises it too -- 13 onsets over three sessions on
    # plays with no fire swing, the park's own fire -- which is why the deriver
    # names a star swing from the captain and never from this byte alone.
    # +0x201 counts the same 89 frames down beside it on most onsets but not
    # all, so this is the byte to read.
    "burned_flag": 0x23E,
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
    # SCORE AND HITS, per team, and the TEAM STAR METERS. All six are read by the
    # vendored public tracker and none of them had a name here. "away" is the
    # team batting in half 0, which is how that tracker assigns them and what the
    # captures confirm: each counter rises only during its own half-inning.
    #
    # The four score/hits fields are inside the region this project has always
    # captured, so they are retroactive -- daisy_cruiser-20260831T212804Z reads
    # back 12-10 on 20 and 19 hits without replaying anything.
    #
    # The two star meters are NOT retroactive. They live below the old capture
    # start (see STATE_BASE) and only sessions recorded after 2026-09-25 contain
    # them; older ones skip these two fields on the bounds check rather than
    # inventing a value. The meter is a fine-grained bar, not a count of stars:
    # a star swing or star pitch subtracts one of the three costs in
    # STAR_COST_ADDRESSES below.
    ("away_score", 0x900D5D98, ">H"), ("home_score", 0x900D5DB2, ">H"),
    ("away_hits", 0x900D5DCD, "B"), ("home_hits", 0x900D5DE7, "B"),
    ("away_star_meter", 0x900D4E24, ">H"), ("home_star_meter", 0x900D4E26, ">H"),
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
    # THE CHARGE, which the two counters above cannot see. A charge swing and a
    # slap swing both run the same swing animation, so swing_frames is identical
    # for the two and the derivation could only ever say "a swing happened".
    #
    # These two are the charge itself, found in the same struct as the counters
    # by sweeping the state block over the 39 swings of
    # mario_stadium-20260923T012536Z -- a game the operator scripted slap in
    # every top half and charge in every bottom half:
    #
    #   swing_charge_frames  counts up ONE PER FRAME while the charge is held,
    #                        starting before the pitch is even released, and
    #                        FREEZES on release -- the same frame swing_frames
    #                        starts, which is what makes the two readable
    #                        together as "charged for N frames, then swung".
    #                        Caps at 120. Read 0 on all 13 slaps and 29..120 on
    #                        all 26 charges.
    #   swing_charge_meter   the same quantity as the on-screen meter: the frame
    #                        count over 60, clamped at 1.0. It RESETS TO 0.0 on
    #                        contact, where the frame counter stays frozen until
    #                        the next plate appearance, so the meter -- not the
    #                        counter -- is what proves a charge belongs to THIS
    #                        pitch rather than being left over from the last one.
    #
    # WHY THE SCRIPTED GAME DOES NOT PROVE THIS BY ITSELF. Scripting the mode by
    # half-inning makes swing mode, half, and batting remote co-vary perfectly,
    # and 484 bytes of the state block "separate" the two groups that way. What
    # singles these out is the one pitch the operator annotated as an accidental
    # charge in a slap half-inning: the charge ramps on it while every other
    # swing in that same half, by the same remote, reads 0. That is within-half,
    # within-remote evidence, so it is the gesture these bytes follow and not
    # which side was batting. 21 of the 484 survive that test; of those, only
    # these read as a mechanism -- a meter that ramps, clamps, and resets on
    # contact -- rather than as a number that happens to differ.
    ("swing_charge_frames", 0x900D6A59, "B"),
    ("swing_charge_meter", 0x900D6A3C, ">f"),
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
    # CAPTAIN STAR SWING. Zero on every ordinary swing; non-zero from the swing
    # until the effect is spent, and the VALUE names the captain rather than
    # saying yes -- see STAR_SWING_CAPTAINS in derive_player_metrics.py, which
    # is the one place that map lives. Only captains
    # have one (Luigi's tornado, Mario's fireball, Birdo's egg, Bowser's fire,
    # Bowser Jr.'s paint, Wario's bomb, DK's barrel), and it is the thing that
    # floors a fielder with no ball contact at all.
    #
    # Found by difference, not by search: Wario City 2026-09-10 had three Luigi
    # plate appearances that floored somebody and six that did not, and this is
    # the only byte that rises in exactly those three -- 3 pulses in 144 plays.
    # Checked at a park with no hazards at all: Mario Stadium 2026-09-04 has 9
    # pulses, every one on a Wario or Waluigi plate appearance, none elsewhere,
    # and both of that session's knockdowns sit on Wario's.
    ("star_swing", 0x900D954A, "B"),
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

# How much a crash can cost. A sync flush every SYNC_FLUSH_SECONDS bounds the
# frames a killed collector loses to that long; the header checkpoint (frames so
# far, gaps so far) and an fsync follow every CHECKPOINT_SECONDS.
SYNC_FLUSH_SECONDS = 2.0
CHECKPOINT_SECONDS = 10.0


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


def write_json_atomic(path: Path, payload: dict) -> None:
    """Replace a JSON file whole. A crash mid-write leaves the previous copy."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2))
    temporary.replace(path)


def xor_delta(block: bytes, previous: bytes) -> bytes:
    """The frame's XOR against the one before it, byte for byte.

    numpy rather than a generator over every byte: measured, the generator
    cost 2.2 ms a frame at 40 KB and 6.1 ms at the comprehensive profile's
    113 KB -- over a third of the 16.7 ms frame budget. numpy does both in
    under 0.1 ms, with identical output (tests/evidence_capture_test.py).
    """
    return np.bitwise_xor(np.frombuffer(block, dtype=np.uint8),
                          np.frombuffer(previous, dtype=np.uint8)).tobytes()


class FrameTiming:
    """Missed frames, the longest hole, and where each hole was.

    `skips` alone said how much was lost but not whether it was one long hole
    (a stall that swallowed a play) or scattered single frames (harmless to a
    velocity). The first GAP_LIMIT holes are kept so a derivation can distrust
    exactly those spans.
    """
    GAP_LIMIT = 2000

    def __init__(self):
        self.missed = 0
        self.gap_count = 0
        self.longest_gap = 0
        self.longest_gap_after_timer = None
        self.gaps = []
        self.first_timer = None
        self.last_timer = None
        self.timer_regressions = 0

    def note(self, timer: int) -> None:
        if self.first_timer is None:
            self.first_timer = timer
        elif timer < self.last_timer:
            # The game clock went backwards: a new match, or a reset. Never a
            # gap, and never hidden either.
            self.timer_regressions += 1
        elif timer - self.last_timer > 1:
            gap = timer - self.last_timer - 1
            self.missed += gap
            self.gap_count += 1
            if gap > self.longest_gap:
                self.longest_gap = gap
                self.longest_gap_after_timer = self.last_timer
            if len(self.gaps) < self.GAP_LIMIT:
                self.gaps.append([self.last_timer, gap])
        self.last_timer = timer

    def summary(self) -> dict:
        return {"missed_frames": self.missed, "gap_count": self.gap_count,
                "longest_gap_frames": self.longest_gap,
                "longest_gap_after_timer": self.longest_gap_after_timer,
                "first_timer": self.first_timer, "last_timer": self.last_timer,
                "timer_regressions": self.timer_regressions,
                "gaps_recorded": len(self.gaps),
                "gaps_truncated": self.gap_count > len(self.gaps),
                "gaps": self.gaps}


class EvidenceProbePolicy:
    """When a comprehensive capture asks memory_probe.py for a whole-memory copy.

    Pitch charge, pitch aim and shake effort were searched for across the whole
    state block and are not in it. The copies are what lets the one scripted
    session be searched for them anywhere in MEM1/MEM2 afterwards, against its
    own labels, without playing again. Triggers are deliberately dumb -- a pitch
    release, a button press, an accelerometer spike -- because anything smarter
    would need the signal it is trying to find.
    """
    # Sized to last a whole 9-inning game: the scripted captures press a button
    # about once every 56 frames, which at a 45-frame gap and a 900 cap spent
    # every copy in the first quarter-hour. At 90 frames the ceiling is ~2,000
    # copies an hour (~0.5 s of one below-normal core each), and a pitch
    # release still always gets one.
    MIN_GAP_FRAMES = 90
    MAX_COPIES = 2000
    ACC_SPIKE = 2.5

    def __init__(self, extra_regions, state_size, pitches_address=0x900D692C,
                 ports=(1, 2)):
        self.port_offsets = {}
        for port in ports:
            offset = evidence.field_offset(evidence.PORT_BASES[port], 0x20,
                                           STATE_BASE, state_size, extra_regions)
            if offset is not None:
                self.port_offsets[port] = offset
        self.pitches_offset = pitches_address - STATE_BASE
        self.last_pitches = None
        self.last_copy_timer = None
        self.last_acc = {port: 0.0 for port in self.port_offsets}
        self.requested = 0

    def check(self, timer: int, block: bytes) -> str | None:
        if self.requested >= self.MAX_COPIES:
            return None
        label = None
        pitches = block[self.pitches_offset]
        if self.last_pitches is not None and pitches != self.last_pitches:
            label = "pitch_release"
        self.last_pitches = pitches
        for port, offset in self.port_offsets.items():
            trig = struct.unpack_from(">I", block, offset + 0x04)[0] & 0xFFFF
            acc = struct.unpack_from(">f", block, offset + 0x18)[0]
            acc = acc if math.isfinite(acc) else 0.0
            if label is None and trig:
                label = f"button_p{port}_{'+'.join(evidence.button_names(trig)) or hex(trig)}"
            if label is None and acc >= self.ACC_SPIKE > self.last_acc[port]:
                label = f"acc_spike_p{port}"
            self.last_acc[port] = acc
        if label is None:
            return None
        # A release is always worth a copy; everything else waits its turn so
        # the probe's queue cannot outrun the moment it was asked about.
        if (label != "pitch_release" and self.last_copy_timer is not None
                and timer - self.last_copy_timer < self.MIN_GAP_FRAMES):
            return None
        self.last_copy_timer = timer
        self.requested += 1
        return label


def executable_identity(dme, hash_emulator: bool = False) -> dict:
    """What produced this capture: disc, emulator build, controller sources.

    Hashing Dolphin.exe costs a tenth of a second or two before the first
    frame, so only the comprehensive profile pays for it; every capture gets
    the path and size.
    """
    identity = {"disc_id": None, "disc_revision": None, "dolphin": None,
                "wiimote_sources": None}
    try:
        raw = dme.read_bytes(0x80000000, 8)
        identity["disc_id"] = raw[:6].decode("ascii", "replace")
        identity["disc_revision"] = raw[7]
    except Exception as error:                  # noqa: BLE001 - diagnostic only
        identity["disc_id_error"] = repr(error)
    try:
        import psutil
        for process in psutil.process_iter(["name", "exe"]):
            if "dolphin" in str(process.info.get("name") or "").lower():
                exe = Path(process.info["exe"])
                identity["dolphin"] = {"exe": str(exe), "bytes": exe.stat().st_size,
                                       "sha256": (hashlib.sha256(exe.read_bytes()).hexdigest()
                                                  if hash_emulator else None)}
                break
    except Exception as error:                  # noqa: BLE001 - diagnostic only
        identity["dolphin_error"] = repr(error)
    # Source = 2 is a real Wii Remote, 1 emulated, 0 none. Which physical
    # remote paired to which port is NOT in here; the session metadata says so.
    config = Path(os.environ.get("APPDATA", "")) / "Dolphin Emulator" / "Config" / "WiimoteNew.ini"
    try:
        sources, section = {}, None
        for line in config.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1]
            elif section and line.replace(" ", "").startswith("Source="):
                sources[section] = line.split("=", 1)[1].strip()
        identity["wiimote_sources"] = {"path": str(config), "sources": sources}
    except OSError:
        pass
    identity["collector_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    return identity


def controller_sides_at_start(dme, metadata) -> dict:
    """Which port drives each capture side, read from memory at attach time."""
    try:
        team1_type, team2_type = dme.read_bytes(0x811F76B0, 2)
        team1_batting = dme.read_bytes(0x900D5C22, 1)[0]
        half = dme.read_bytes(0x900D5E25, 1)[0]
    except Exception as error:                  # noqa: BLE001 - diagnostic only
        return {"error": repr(error)}
    observed = evidence.side_ports_from_memory(team1_type, team2_type,
                                               team1_batting, half)
    return {"team1_player_type": team1_type, "team2_player_type": team2_type,
            "team1_batting_or_fielding": team1_batting, "inning_half": half,
            "memory_ports": observed,
            "declared_vs_memory": evidence.compare_declared_sides(
                (metadata or {}).get("content"), observed)}


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


def attach_to_live_game(timeout: float = 12.0):
    """Wait briefly for Dolphin's match objects after the live-game handoff.

    The handoff and the collector run in separate processes. A pitch reset can
    be observed before Dolphin exposes every fielder to a second memory reader.
    Keep the actor checks strict, but let that short startup gap close.
    """
    deadline = time.monotonic() + timeout
    last_error = None
    while True:
        try:
            dme = hook()
            return dme, resolve_actors(dme)
        except SystemExit as error:
            last_error = str(error)
            if time.monotonic() >= deadline:
                raise SystemExit(
                    f"Could not attach the 60 Hz collector after {timeout:g}s: "
                    f"{last_error}"
                ) from None
            time.sleep(0.25)


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


def find_freezie_array_candidates(block: bytes, region_start: int) -> list[int]:
    """Find Peach's five Freezie transforms in one memory block.

    A single identity transform is common. This signature is not: five slots at
    stride 0xAC, two identical 3x4 transforms per slot, rigid x gaps of
    -40/+15/-55/-20, and depths distributed across -50/-50/-75/-75/-95. Those values
    were observed independently in the motion scan and the freeze-onset control.
    """
    usable = len(block) - len(block) % 4
    values = np.frombuffer(block[:usable], dtype=">f4")
    slot_floats = FREEZIE_STRIDE // 4
    copy_floats = FREEZIE_TRANSFORM_COPY // 4
    last = (FREEZIE_COUNT - 1) * slot_floats + copy_floats + 11
    count = len(values) - last
    if count <= 0:
        return []

    keep = np.ones(count, dtype=bool)

    def column(offset):
        return values[offset:offset + count]

    def near(offset, expected, tolerance=1e-4):
        data = column(offset)
        keep[:] &= np.isfinite(data) & (np.abs(data - expected) <= tolerance)

    # Both copies of every transform have an identity rotation matrix. The
    # translation is the last column and may vary with the Freezie's sweep.
    rotation = ((0, 1.0), (1, 0.0), (2, 0.0),
                (4, 0.0), (5, 1.0), (6, 0.0),
                (8, 0.0), (9, 0.0), (10, 1.0))
    with np.errstate(invalid="ignore", over="ignore"):
        for slot in range(FREEZIE_COUNT):
            base = slot * slot_floats
            for copy in (0, copy_floats):
                for relative, expected in rotation:
                    near(base + copy + relative, expected)
            for translation in (3, 7, 11):
                first = column(base + translation)
                second = column(base + copy_floats + translation)
                keep &= (np.isfinite(first) & np.isfinite(second)
                         & (np.abs(first - second) <= 0.01))

        x = [column(slot * slot_floats + 3) for slot in range(FREEZIE_COUNT)]
        keep &= np.isfinite(x[0]) & (np.abs(x[0]) <= 80.0)
        for slot, gap in enumerate((-40.0, 15.0, -55.0, -20.0), start=1):
            keep &= np.abs((x[slot] - x[0]) - gap) <= 0.05

        z = [column(slot * slot_floats + 11) for slot in range(FREEZIE_COUNT)]
        lane_counts = []
        for depth in FREEZIE_LANE_DEPTHS:
            lane_counts.append(sum((np.abs(item - depth) <= 0.1).astype(np.uint8)
                                   for item in z))
        keep &= lane_counts[0] == 2
        keep &= lane_counts[1] == 2
        keep &= lane_counts[2] == 1

    return [region_start + int(index) * 4 for index in np.flatnonzero(keep)]


def locate_freezie_array(dme) -> int:
    """Resolve the match-local Freezie allocation before recording any frames."""
    overlap = FREEZIE_STRIDE * FREEZIE_COUNT + FREEZIE_TRANSFORM_COPY
    found = []
    address = FREEZIE_SEARCH_START
    while address < FREEZIE_SEARCH_END:
        primary = min(FREEZIE_SEARCH_CHUNK, FREEZIE_SEARCH_END - address)
        size = min(primary + overlap, FREEZIE_SEARCH_END - address)
        block = dme.read_bytes(address, size)
        found.extend(candidate for candidate in
                     find_freezie_array_candidates(block, address)
                     if candidate < address + primary)
        address += primary
    found = sorted(set(found))
    if len(found) != 1:
        detail = "none" if not found else ", ".join(f"0x{x:08X}" for x in found)
        raise SystemExit(
            "Could not uniquely locate Peach Ice Garden's Freezie array "
            f"(candidates: {detail}). No capture was started, because recording "
            "the calibration match's stale address would lose every ball break."
        )
    return found[0]


def find_barrel_candidates(block: bytes, region_start: int) -> list[dict]:
    """Slots holding a DK Jungle cannon sentinel, matched by exact value.

    A parked barrel sits on one of the two cannon positions, so this looks for
    those three floats in a row. It deliberately does NOT try to tell the
    authoritative slot from its mirror: both are the barrel, and which one to
    read is a question the recorded bytes can answer later. See locate_barrel.
    """
    usable = len(block) - len(block) % 4
    values = np.frombuffer(block[:usable], dtype=">f4")
    count = len(values) - 2
    if count <= 0:
        return []
    out = []
    with np.errstate(invalid="ignore", over="ignore"):
        x = values[0:count]
        y = values[1:count + 1]
        z = values[2:count + 2]
        finite = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
        for cannon in BARREL_CANNONS:
            keep = (finite
                    & (np.abs(x - cannon[0]) <= BARREL_SENTINEL_TOLERANCE)
                    & (np.abs(y - cannon[1]) <= BARREL_SENTINEL_TOLERANCE)
                    & (np.abs(z - cannon[2]) <= BARREL_SENTINEL_TOLERANCE))
            for index in np.flatnonzero(keep):
                out.append({
                    "address": region_start + int(index) * 4,
                    "cannon": "left" if cannon[0] < 0 else "right",
                    "at": [float(value) for value in cannon],
                })
    out.sort(key=lambda candidate: candidate["address"])
    return out


def locate_barrel(dme) -> dict | None:
    """Resolve DK Jungle's barrel allocation before recording any frames.

    FAILS SAFELY, exactly as locate_placed_props does. Finding nothing returns
    None and the capture records the fixed calibration regions as before, so a
    session is never lost to this -- it simply records what it always did.

    WHAT IS RECORDED IS THE WHOLE CLUSTER, not just the chosen slot. The pick
    below is the lowest candidate, which reproduces the one relationship the
    original trace established (the authoritative slot preceded its mirror)
    without hardcoding the gap between them. If that choice is ever wrong, the
    region still covers every candidate on every frame, so a re-derivation can
    switch offsets offline and nobody has to play the game again. That is the
    difference between a capture that can be corrected and one that cannot.
    """
    found = []
    overlap = 3 * 4
    address = BARREL_SEARCH_START
    while address < BARREL_SEARCH_END:
        primary = min(BARREL_SEARCH_CHUNK, BARREL_SEARCH_END - address)
        size = min(primary + overlap, BARREL_SEARCH_END - address)
        block = dme.read_bytes(address, size)
        found.extend(candidate for candidate
                     in find_barrel_candidates(block, address)
                     if candidate["address"] < address + primary)
        address += primary
    if not found:
        return None
    found.sort(key=lambda candidate: candidate["address"])

    clusters = [[found[0]]]
    for candidate in found[1:]:
        if candidate["address"] - clusters[-1][-1]["address"] <= BARREL_CLUSTER_GAP:
            clusters[-1].append(candidate)
        else:
            clusters.append([candidate])
    largest = max(clusters, key=len)

    low = largest[0]["address"] - BARREL_REGION_PAD
    high = largest[-1]["address"] + overlap + BARREL_REGION_PAD
    base = low & ~0x1F
    size = (high - base + 0x1F) & ~0x1F
    if size > BARREL_REGION_MAX:
        return {"candidates": found, "clusters": len(clusters), "region": None,
                "position": None, "cluster": largest,
                "reason": f"the candidate cluster spans {size} bytes, past the "
                          f"{BARREL_REGION_MAX}-byte per-frame budget"}
    return {"candidates": found, "clusters": len(clusters),
            "region": (base, size), "position": largest[0]["address"],
            "cluster": largest, "reason": None}


def find_arrow_transform_candidates(block: bytes, region_start: int) -> list[dict]:
    """Placed props with a heading: 3x4 matrices whose rotation is about y.

    Returns one entry per match with the address, the heading the matrix
    encodes, and its translation, so the header can carry the whole shortlist
    and the session can be checked against it afterwards. It does NOT decide
    which of them is an arrow -- see the note beside ARROW_SEARCH_START.
    """
    usable = len(block) - len(block) % 4
    values = np.frombuffer(block[:usable], dtype=">f4")
    count = len(values) - ARROW_TRANSFORM_FLOATS
    if count <= 0:
        return []
    column = [values[index:index + count] for index in range(ARROW_TRANSFORM_FLOATS)]
    with np.errstate(invalid="ignore", over="ignore"):
        keep = np.ones(count, dtype=bool)
        for data in column:
            keep &= np.isfinite(data)
        # The rows the vertical axis pins: (_, 0, _), (0, s, 0), (_, 0, _).
        for index in (1, 4, 6, 9):
            keep &= np.abs(column[index]) <= 1e-6
        scale = column[5]
        keep &= (scale >= ARROW_MIN_SCALE) & (scale <= ARROW_MAX_SCALE)
        # cos in both corners, +sin and -sin mirrored, and a pair whose norm is
        # the scale the middle row already stated. Three independent constraints
        # on the same three numbers, which is what makes a chance match out of
        # arbitrary bytes vanishingly unlikely.
        keep &= np.abs(column[0] - column[10]) <= 1e-5
        keep &= np.abs(column[2] + column[8]) <= 1e-5
        keep &= np.abs(np.hypot(column[0], column[2]) - scale) <= 1e-4 * np.abs(scale)
        keep &= np.abs(column[3]) <= ARROW_MAX_X
        keep &= np.abs(column[7]) <= ARROW_MAX_Y
        keep &= np.abs(column[11]) <= ARROW_MAX_Z
        keep &= np.hypot(column[3], column[11]) > ARROW_MIN_RADIUS
        found = np.flatnonzero(keep)

    out = []
    for index in found:
        index = int(index)
        cos, sin = float(column[0][index]), float(column[2][index])
        out.append({
            "address": region_start + index * 4,
            "heading_degrees": round(math.degrees(math.atan2(sin, cos)), 4),
            "scale": round(float(column[5][index]), 5),
            "translation": [round(float(column[offset][index]), 4)
                            for offset in (3, 7, 11)],
        })
    return out


# DAISY CRUISER'S TABLES ARE NOT ALWAYS THE LARGEST CLUSTER. Season game 2767
# (2026-09-18) loaded a 108-transform allocation standing 7u up that outnumbered
# the 30-transform table cluster, so the capture recorded the wrong region and
# not one table hit or break was measured. A table is a transform plus an
# identical copy 0x30 later, on the deck (y=0), 45-95u out -- the same shape
# daisy_table_objects() accepts in the derivation.
TABLE_TRANSFORM_COPY_OFFSET = 0x30


def daisy_table_count(cluster: list) -> int:
    by_address = {candidate["address"]: candidate for candidate in cluster}
    count = 0
    for candidate in cluster:
        copy = by_address.get(candidate["address"] + TABLE_TRANSFORM_COPY_OFFSET)
        x, y, z = candidate["translation"]
        if (copy is not None and copy["translation"] == candidate["translation"]
                and abs(candidate["scale"] - 1.0) <= 1e-4
                and abs(candidate["heading_degrees"]) <= 1e-3
                and abs(y) <= 0.01 and 45 <= math.hypot(x, z) <= 95):
            count += 1
    return count


def locate_placed_props(dme, rank=None) -> dict | None:
    """Shortlist a stadium's placed props and pick a region to record.

    FAILS SAFELY, which is the whole point: an empty shortlist, or one so
    scattered that no allocation can be called THE one, returns None and the
    capture runs exactly as it did before. Recording a region chosen out of
    hope would be worse than recording none, because the header would then
    claim an arrow address that nothing had established.

    `rank` scores a cluster by the park's own object shape; the highest score
    wins and size only breaks ties. Without it the largest cluster wins.
    """
    found = []
    overlap = ARROW_TRANSFORM_FLOATS * 4
    address = ARROW_SEARCH_START
    while address < ARROW_SEARCH_END:
        primary = min(ARROW_SEARCH_CHUNK, ARROW_SEARCH_END - address)
        size = min(primary + overlap, ARROW_SEARCH_END - address)
        block = dme.read_bytes(address, size)
        found.extend(candidate for candidate
                     in find_arrow_transform_candidates(block, address)
                     if candidate["address"] < address + primary)
        address += primary
    if not found:
        return None
    found.sort(key=lambda candidate: candidate["address"])

    clusters = [[found[0]]]
    for candidate in found[1:]:
        if candidate["address"] - clusters[-1][-1]["address"] <= ARROW_CLUSTER_GAP:
            clusters[-1].append(candidate)
        else:
            clusters.append([candidate])
    # The biggest cluster, and it has to be a cluster: a single stray matrix is
    # not an array of placed props and its neighbourhood is not evidence.
    largest = max(clusters, key=lambda cluster: (rank(cluster) if rank else 0,
                                                 len(cluster)))
    if len(largest) < 2:
        return {"candidates": found, "clusters": len(clusters), "region": None,
                "reason": "no candidate cluster; the largest allocation holds one transform"}

    low = largest[0]["address"] - ARROW_REGION_PAD
    high = largest[-1]["address"] + ARROW_TRANSFORM_FLOATS * 4 + ARROW_REGION_PAD
    base = low & ~0x1F
    size = (high - base + 0x1F) & ~0x1F
    if size > ARROW_REGION_MAX:
        return {"candidates": found, "clusters": len(clusters), "region": None,
                "reason": f"the candidate cluster spans {size} bytes, past the "
                          f"{ARROW_REGION_MAX}-byte per-frame budget"}
    return {"candidates": found, "clusters": len(clusters),
            "region": (base, size), "cluster": largest, "reason": None}


def read_stadium_memory(dme) -> bytes:
    """One copy of MEM2, read and nothing else. See STADIUM_DUMP_START.

    THE READ AND THE WRITE ARE SEPARATE ON PURPOSE. Reading MEM2 costs 0.13 s;
    compressing it costs 1.3 s. The start copy has to be taken while the arrows
    are the ones this match is about to be played with, and the only moment
    that is certainly true is before recording -- but the collector reaches
    that point immediately after a pitch reset, and 1.3 s of zlib there is 80
    frames of the first at-bat. So the bytes are held and written at the end.
    """
    buffer = bytearray()
    address = STADIUM_DUMP_START
    while address < STADIUM_DUMP_END:
        size = min(STADIUM_DUMP_CHUNK, STADIUM_DUMP_END - address)
        buffer += dme.read_bytes(address, size)
        address += size
    return bytes(buffer)


def write_stadium_memory(raw: bytes, path) -> dict:
    """Compress one copy beside the capture and describe it for the header."""
    compressed = zlib.compress(raw, 6)
    path.write_bytes(compressed)
    return {"path": str(path), "start": STADIUM_DUMP_START,
            "end": STADIUM_DUMP_END, "bytes": len(raw),
            "compressed_bytes": len(compressed),
            "sha256": hashlib.sha256(raw).hexdigest()}


def resolve_extra_regions(dme, park: str):
    """Replace calibration addresses with this match's live allocations.

    Stadium searches run here rather than in the frame loop, and all are
    park-gated: a signature that means something at one park is a coincidence
    at the other eight. Returns the regions to capture, Peach's Freezie array
    (None elsewhere), a placed-prop shortlist for Wario City or day Daisy
    Cruiser (None elsewhere), and DK Jungle's barrel allocation (None
    elsewhere). The prop shortlist is deliberately generic: a later ball/object
    match establishes whether an entry is an arrow or a table.
    """
    regions = list(EXTRA_REGIONS)
    if park in ("wario_city", "daisy_cruiser"):
        props = locate_placed_props(
            dme, rank=daisy_table_count if park == "daisy_cruiser" else None)
        park_prop = "arrows" if park == "wario_city" else "tables"
        if props is None:
            print("No placed-prop transform found anywhere in MEM2. Nothing "
                  f"extra is being recorded for the {park_prop}; the stadium dump "
                  "beside the capture is the only way to look again.")
            return regions, None, None, None
        if props["region"] is None:
            print(f"{len(props['candidates'])} placed-prop transform(s) in "
                  f"{props['clusters']} allocation(s), but no region was "
                  f"chosen: {props['reason']}. The shortlist is in the header.")
            return regions, None, props, None
        base, size = props["region"]
        regions = regions + [("stadium_props", base, size)]
        headings = sorted({round(c["heading_degrees"], 1) for c in props["cluster"]})
        print(f"{len(props['candidates'])} placed-prop transform(s); recording "
              f"the {len(props['cluster'])}-object cluster at "
              f"0x{base:08X}..0x{base + size:08X} ({size} bytes/frame)")
        print(f"  headings: {', '.join(f'{h:g}' for h in headings)}")
        print(f"  NOT yet established as the {park_prop} -- the check is against "
              "this session's own interactions, afterwards.")
        return regions, None, props, None
    if park == "dk_jungle":
        # THE BARREL IS LOCATED, NOT REMEMBERED. See locate_barrel: the address
        # in EXTRA_REGIONS was found live in 2026-09 and is dead in both
        # captures that recorded it, which is why DK Jungle has 384 plays of an
        # empty slot and not one barrel event.
        barrel = locate_barrel(dme)
        if barrel is None:
            print("No DK Jungle cannon sentinel found anywhere in MEM2, so the "
                  "barrel could not be located. Recording the calibration "
                  "region as before; the stadium dump beside the capture is "
                  "the only way to look again.")
            return regions, None, None, None
        if barrel["region"] is None:
            print(f"{len(barrel['candidates'])} barrel sentinel(s) in "
                  f"{barrel['clusters']} allocation(s), but no region was "
                  f"chosen: {barrel['reason']}. The shortlist is in the header.")
            return regions, None, None, barrel
        base, size = barrel["region"]
        regions = [
            (name, base, size) if name == "barrel_transform" else (name, old, old_size)
            for name, old, old_size in regions
        ]
        print(f"Barrel 0x{barrel['position']:08X} "
              f"({len(barrel['cluster'])} sentinel slot(s) in this allocation, "
              f"capture region 0x{base:08X}..0x{base + size:08X})")
        print("  the whole cluster is recorded, so the authoritative slot can be "
              "re-chosen offline if this pick is wrong.")
        return regions, None, None, barrel
    if park != "peach_ice_garden":
        return regions, None, None, None
    freezie_array = locate_freezie_array(dme)
    freezie_region = freezie_array - FREEZIE_REGION_LEAD
    regions = [
        (name, freezie_region, FREEZIE_REGION_SIZE)
        if name == "freezie_objects" else (name, base, size)
        for name, base, size in regions
    ]
    print(f"Freezie array 0x{freezie_array:08X} "
          f"(capture region 0x{freezie_region:08X}.."
          f"0x{freezie_region + FREEZIE_REGION_SIZE:08X})")
    return regions, freezie_array, None, None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--park", default="auto", choices=("auto",) + PARK_KEYS,
                        metavar="PARK",
                        help="optional park fallback (default: detect from game memory): "
                             + ", ".join(PARK_KEYS))
    parser.add_argument("--out", default="data/player_tracking",
                        help="directory for the session files")
    parser.add_argument("--note", default="", help="free text stored in the header")
    # A STADIUM-RESEARCH GAME IS NOT A SAMPLE OF NORMAL PLAY. Its balls are
    # deliberately not fielded so they reach the hazard, so its fielding
    # chances, routes and reactions come from a defence that was not trying to
    # make the play. Counting those toward calibration adds a one-directional
    # bias that is invisible afterwards, because a ball nobody chased looks
    # exactly like a ball nobody could reach. Recorded in the header so it
    # travels with the capture and survives re-derivation.
    parser.add_argument("--calibration-excluded", action="store_true",
                        default=os.environ.get("TRACKER_CALIBRATION_EXCLUDED") == "1",
                        help="mark this session as stadium research: recorded and "
                             "derived normally, but never counted toward calibration")
    parser.add_argument("--calibration-excluded-reason",
                        default=os.environ.get("TRACKER_CALIBRATION_EXCLUDED_REASON") or None,
                        help="why this session does not count toward calibration")
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
    # See MEMORY_PROBE_PARKS. auto is test games only: a capture with a
    # --game-id is a real league game and does not pay for research copies.
    parser.add_argument("--memory-probe", choices=("auto", "on", "off"),
                        default={"1": "on", "0": "off"}.get(
                            os.environ.get("TRACKER_MEMORY_PROBE", ""), "auto"),
                        help="copy all of game memory at each Yoshi Park knockdown "
                             "(scripts/memory_probe.py); auto = only without --game-id")
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
    # THE EVIDENCE PROFILE. `standard` records exactly the regions every capture
    # has recorded since 2026-09-25. `comprehensive` appends the regions in
    # capture_evidence_schema.COMPREHENSIVE_REGIONS, takes whole-memory copies
    # at input and pitch events, and REFUSES to start without a valid session
    # metadata file -- a capture meant to separate players from characters is
    # worthless if nobody wrote down who held which remote.
    parser.add_argument("--evidence-profile", choices=evidence.EVIDENCE_PROFILES,
                        default=os.environ.get("TRACKER_EVIDENCE_PROFILE") or "standard",
                        help="standard (default) or comprehensive")
    parser.add_argument("--session-metadata",
                        default=os.environ.get("TRACKER_SESSION_METADATA") or None,
                        help="who held which controller port; required by the "
                             "comprehensive profile (capture_evidence_schema.py)")
    args = parser.parse_args()

    # Checked before Dolphin is touched, so a bad file costs a message and not
    # the opening at-bats of the game it was meant to describe.
    session_metadata = None
    if args.session_metadata:
        try:
            session_metadata = evidence.load_session_metadata(args.session_metadata)
        except evidence.MetadataError as error:
            raise SystemExit(str(error)) from None
    if args.evidence_profile == "comprehensive" and session_metadata is None:
        raise SystemExit(
            "The comprehensive evidence profile needs --session-metadata (or "
            "TRACKER_SESSION_METADATA): a file stating which player held which "
            "remote in which port. It is never inferred. See "
            "data/calibration/evidence-session-metadata.example.json.")

    stop_path = Path(args.stop_file) if args.stop_file else None
    manifest_path = Path(args.manifest) if args.manifest else None

    def write_manifest(payload: dict) -> None:
        if not manifest_path:
            return
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=2))
        temporary.replace(manifest_path)

    dme, actors = attach_to_live_game()
    print("fielders  " + "  ".join(
        f"{a['name']}@0x{a['address']:08X}" for a in actors["fielders"]))
    print("offense   " + "  ".join(
        f"{a['name']}@0x{a['address']:08X}" for a in actors["offense"]))

    ball_offset = lock_ball_offset(dme, args.ball_timeout)
    print(f"ball coordinate offset 0x{ball_offset:03X}")

    # THE FALLBACK COPY. See read_stadium_memory: if the structural scan below
    # was looking for the wrong shape, Wario City's arrows/manhole or Daisy
    # Cruiser's tables are still in these bytes and can be searched for offline
    # against this session's own interactions, without playing the game again.
    #
    # TAKEN AFTER THE PITCH RESET, NOT BEFORE. The arrows are placed when the
    # match starts, and a collector launched at a menu would otherwise copy a
    # heap that does not contain them yet -- a fallback that is empty exactly
    # when it is needed. lock_ball_offset above blocks until the game has
    # actually reset a pitch, so from here the match is live. The read costs
    # 0.11 s; the 1.3 s of compression is deferred to the end of the session so
    # that no frame of the first at-bat waits on it.
    #
    # Park-gated on the game's own stadium byte -- the same one that resolves
    # args.park below -- because eight parks do not need 16 MB, and never
    # fatal: a capture that records the game is worth more than one that
    # refused to start because a diagnostic copy failed.
    stadium_dump_start_bytes = None
    dump_park = STADIUM_BYTE_TO_PARK.get(dme.read_bytes(0x811F769D, 1)[0])
    # Yoshi Park joined 2026-09-11: its six pipes were placed from what they do
    # to the ball and the fielders, and the copy is how their objects get
    # confirmed without replaying the game.
    if dump_park in ("wario_city", "daisy_cruiser", "yoshi_park"):
        try:
            stadium_dump_start_bytes = read_stadium_memory(dme)
            print(f"stadium memory copied "
                  f"({len(stadium_dump_start_bytes) / 1e6:.0f} MB, written at the end)")
        except Exception as error:              # noqa: BLE001 - diagnostic only
            print(f"  stadium memory read failed: {error!r}", flush=True)

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

    extra_regions, freezie_array, props, barrel = resolve_extra_regions(dme, args.park)
    replay = None
    if args.evidence_profile == "comprehensive":
        # Appended after every standard region, so each older region keeps the
        # frame offset it has in a standard capture.
        extra_regions = extra_regions + evidence.comprehensive_regions()
        pointer = struct.unpack(">I", dme.read_bytes(evidence.REPLAY_POINTER_SLOT, 4))[0]
        region = evidence.replay_region(pointer)
        replay = {"pointer_slot": evidence.REPLAY_POINTER_SLOT, "pointer_at_start": pointer,
                  "offset": evidence.REPLAY_POINTER_OFFSET,
                  "address": pointer + evidence.REPLAY_POINTER_OFFSET if region else None,
                  "region": list(region) if region else None,
                  "reason": None if region else "pointer did not resolve into MEM1/MEM2"}
        if region:
            extra_regions = extra_regions + [region]
        clashes = evidence.region_overlaps([("state_block", STATE_BASE, STATE_SIZE),
                                            *extra_regions])
        if clashes:
            print(f"  WARNING: capture regions overlap {clashes}; the bytes are "
                  "recorded twice and field reads take the first copy.", flush=True)
        for name, base, size in extra_regions:
            dme.read_bytes(base, size)      # unreadable memory fails here, not mid-game
        print(f"comprehensive evidence profile: "
              f"{evidence.bytes_per_frame(STATE_SIZE, extra_regions)} bytes/frame "
              f"across {len(extra_regions) + 1} regions", flush=True)
    capture_size = STATE_SIZE + sum(size for _, _, size in extra_regions)

    # Read once: these are build constants, not game state, and putting them in
    # the header means a star meter drop can be priced by whoever reads the
    # session back without needing the emulator again.
    star_costs = {
        name: struct.unpack(">h", dme.read_bytes(address, 2))[0]
        for name, address in STAR_COST_ADDRESSES.items()
    }

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
        "extra_regions": [[n, b, sz] for n, b, sz in extra_regions],
        "controller_input_capture": {
            "version": 1,
            "ports": [1, 2],
            "struct_size": PORT_STRIDE,
            "source": "mss_input.PORT_STRUCTS",
            "purpose": "slap_charge_and_shake_gesture_calibration",
        },
        "capture_size": capture_size,
        # What a star costs off the team meter, by spender. Absent from sessions
        # recorded before 2026-09-25, which also have no meter to spend.
        "star_costs": star_costs,
        "star_cost_addresses": {name: address for name, address
                                in STAR_COST_ADDRESSES.items()},
        # A heap allocation resolved for this match, not a reusable address.
        # Null outside Peach Ice Garden, where the signature does not exist.
        "freezie_array": freezie_array,
        "freezie_count": FREEZIE_COUNT,
        "freezie_stride": FREEZIE_STRIDE,
        "freezie_transform": FREEZIE_TRANSFORM,
        "freezie_transform_copy": FREEZIE_TRANSFORM_COPY,
        "freezie_translation": list(FREEZIE_TRANSLATION),
        "freezie_active_offset": FREEZIE_ACTIVE_OFFSET,
        # PLACED STADIUM PROPS -- the shortlist, not a claim. Every 3x4
        # Y-rotation transform with a field-plausible translation that was in
        # MEM2 when this match started. Populated at Wario City and Daisy
        # Cruiser; the derivation identifies a particular prop only by matching
        # it to a measured interaction. The arrow names remain as compatibility
        # aliases for existing Wario captures and analysis scripts.
        "prop_candidates": (props or {}).get("candidates"),
        "prop_cluster": (props or {}).get("cluster"),
        "prop_region": list((props or {}).get("region") or ()) or None,
        "prop_region_reason": (props or {}).get("reason"),
        "prop_transform_floats": ARROW_TRANSFORM_FLOATS,
        "prop_translation": list(ARROW_TRANSLATION),
        "arrow_candidates": (props or {}).get("candidates") if args.park == "wario_city" else None,
        "arrow_cluster": (props or {}).get("cluster") if args.park == "wario_city" else None,
        "arrow_region": (list((props or {}).get("region") or ()) or None)
                        if args.park == "wario_city" else None,
        "arrow_region_reason": (props or {}).get("reason") if args.park == "wario_city" else None,
        "arrow_transform_floats": ARROW_TRANSFORM_FLOATS,
        "arrow_translation": list(ARROW_TRANSLATION),
        # THE ADDRESS THIS MATCH ACTUALLY USED. Located by cannon sentinel at DK
        # Jungle and the fixed seed everywhere else, so a session stays readable
        # either way and an old capture reads back exactly as before.
        # player_tracking_io.session_snapshot_builder already prefers the header
        # over the constant, so nothing downstream needed changing.
        "barrel_position": (barrel or {}).get("position") or BARREL_POSITION,
        # The whole shortlist, not a claim about which slot is authoritative.
        # The capture region covers every one of them on every frame, so if the
        # chosen slot turns out to be a mirror the right one can be read back
        # offline without replaying the game.
        "barrel_candidates": (barrel or {}).get("candidates"),
        "barrel_cluster": (barrel or {}).get("cluster"),
        "barrel_region": list((barrel or {}).get("region") or ()) or None,
        "barrel_region_reason": (barrel or {}).get("reason"),
        "barrel_located": bool((barrel or {}).get("position")),
        "barrel_cannons": [list(c) for c in BARREL_CANNONS],
        "yoshi_train_position": YOSHI_TRAIN_POSITION,
        "game_timer_address": GAME_TIMER,
        "ball_offset": ball_offset,
        "actor_fields": ACTOR_FIELDS,
        "state_fields": [[n, a, f] for n, a, f in STATE_FIELDS],
        "actors": actors,
        "stadium_byte": stadium_byte,
        "day_night_bytes": day_night_bytes,
        "is_night": is_night,
        # See --calibration-excluded. Absent/false means countable, so every
        # session already on disk is unaffected.
        "calibration_excluded": bool(args.calibration_excluded),
        # NO DEFAULT REASON. This used to fall back to "stadium research: balls
        # deliberately not fielded so they reach the hazard", which is one of
        # several reasons a session is excluded and was written onto every
        # excluded capture regardless -- mario_stadium-20260923T012536Z is a
        # scripted slap/charge game filed under it. Nothing reads this field
        # programmatically, so an unstated reason is better left unstated than
        # given a plausible one.
        "calibration_excluded_reason": (
            (args.calibration_excluded_reason or "").strip() or None
            if args.calibration_excluded else None),
        # VERSION 3. See capture_evidence_schema.py. Readers that predate it
        # ignore the block; the frame record is unchanged.
        "capture_schema": evidence.schema_block(
            profile=args.evidence_profile, state_base=STATE_BASE,
            state_size=STATE_SIZE, extra_regions=extra_regions,
            metadata=session_metadata, replay=replay),
        "executable_identity": executable_identity(
            dme, hash_emulator=args.evidence_profile == "comprehensive"),
        "controller_sides_at_start": controller_sides_at_start(dme, session_metadata),
        # False until the finally block below has flushed the stream and
        # checksummed it. A header still saying false beside a .bin is a crashed
        # capture: its frames up to the last checkpoint are readable.
        "capture_complete": False,
    }
    sides = header["controller_sides_at_start"].get("declared_vs_memory") or {}
    if sides.get("status") == "mismatch":
        print("  *** WARNING: the session metadata's expected_capture_side does not "
              f"match the game's own player_type bytes: {sides['mismatches']}. "
              "Recording both; fix the metadata before the evidence is used.",
              flush=True)
    write_json_atomic(stem.with_suffix(".json"), header)
    write_manifest({
        "status": "recording",
        "stem": str(stem.resolve()),
        "header_path": str(stem.with_suffix(".json").resolve()),
        "stream_path": str(stem.with_suffix(".bin").resolve()),
        "game_id": args.game_id,
        "competition_type": args.competition_type,
        "source_id": args.source_id,
        "evidence_profile": args.evidence_profile,
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
            extra_regions=extra_regions,
            barrel_address=header["barrel_position"],
            barrel_cannons=BARREL_CANNONS,
            train_address=YOSHI_TRAIN_POSITION,
            freezie_address=freezie_array,
            freezie_count=FREEZIE_COUNT,
            freezie_stride=FREEZIE_STRIDE,
            freezie_translation=FREEZIE_TRANSLATION,
            freezie_active_offset=FREEZIE_ACTIVE_OFFSET,
            # Exactly what the header records and exactly what the postgame
            # pass will read back from it -- the same cluster, resolved through
            # the same capture_offset arithmetic.
            prop_transforms=(props or {}).get("cluster") or (),
            prop_translation=ARROW_TRANSLATION,
            park=args.park,
            is_night=is_night,
        )
        header["live_plays_path"] = str(live_path)
        header["live_pitches_path"] = str(pitches_path)
        header["live_position_offset"] = args.position_offset
        write_json_atomic(stem.with_suffix(".json"), header)
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

    # See MEMORY_PROBE_PARKS. Started before the first frame, so its first copy
    # is the match as it is about to be recorded. Never fatal: a capture without
    # the copies is the capture it always was.
    probe = None
    probe_copies = 0
    probe_down = [0] * len(actors["fielders"])
    knockdown_at = ACTOR_FIELDS["knockdown_flag"]
    # The comprehensive profile takes copies at every park, on input and pitch
    # events rather than knockdowns. TRACKER_MEMORY_PROBE=0 still turns it off.
    probe_policy = (EvidenceProbePolicy(extra_regions, STATE_SIZE)
                    if args.evidence_profile == "comprehensive"
                    and args.memory_probe != "off" else None)
    if probe_policy is not None or (args.park in MEMORY_PROBE_PARKS and (
            args.memory_probe == "on"
            or (args.memory_probe == "auto" and args.game_id is None))):
        probe_dir = stem.with_suffix(".probe").resolve()
        try:
            probe_dir.mkdir(parents=True, exist_ok=True)
            with (probe_dir / "probe.log").open("w") as probe_log:
                probe = subprocess.Popen(
                    [sys.executable, str(Path(__file__).with_name("memory_probe.py")),
                     "--out", str(probe_dir)],
                    stdin=subprocess.PIPE, stdout=probe_log, stderr=subprocess.STDOUT,
                    text=True,
                    creationflags=getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0))
            header["memory_probe"] = {
                "dir": str(probe_dir),
                "policy": "evidence" if probe_policy is not None else "knockdown",
                "max_copies": (EvidenceProbePolicy.MAX_COPIES if probe_policy is not None
                               else MEMORY_PROBE_MAX_COPIES)}
            write_json_atomic(stem.with_suffix(".json"), header)
            print(f"memory probe on: a copy of game memory at each "
                  f"{'pitch release, button press and shake spike' if probe_policy is not None else 'knockdown'}"
                  f" -> {probe_dir}", flush=True)
        except Exception as error:              # noqa: BLE001 - diagnostic only
            print(f"  memory probe did not start: {error!r}", flush=True)
            probe = None

    def ask_probe(timer: int, block: bytes, fielder: str, label: str = "knockdown") -> None:
        """Ask for a copy now, with every fielder's position on this frame."""
        nonlocal probe, probe_copies
        limit = (EvidenceProbePolicy.MAX_COPIES if probe_policy is not None
                 else MEMORY_PROBE_MAX_COPIES)
        if probe is None or probe_copies >= limit:
            return
        positions = {
            actor["name"]: [round(value, 3) for value in struct.unpack_from(
                ">fff", block, actor["address"] - STATE_BASE + args.position_offset)]
            for actor in actors["fielders"]}
        try:
            probe.stdin.write(json.dumps({"label": label, "timer": timer,
                                          "fielder": fielder, "fielders": positions}) + "\n")
            probe.stdin.flush()
            probe_copies += 1
        except (OSError, ValueError) as error:
            print(f"  memory probe stopped taking requests: {error!r}", flush=True)
            probe = None

    compressor = zlib.compressobj(6)
    frames = 0
    skips = 0
    wandered = False
    previous = bytes(capture_size)
    timing = FrameTiming()
    started = time.perf_counter()
    # Frame `elapsed` is seconds since this instant, so wall-clock time for any
    # frame is started_epoch_s + elapsed. Taken back to back with `started`.
    header["clock"] = {"started_epoch_s": time.time(),
                       "elapsed_origin": "perf_counter at started_epoch_s"}
    write_json_atomic(stem.with_suffix(".json"), header)
    last_timer = None
    last_report = started
    last_sync = started
    last_checkpoint = started

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
            timing.note(timer)

            block = dme.read_bytes(STATE_BASE, STATE_SIZE)
            # Appended to the same buffer so one XOR delta covers everything and
            # the record format stays a single block. Offsets past STATE_SIZE
            # belong to the header's extra_regions in order; `capture_offset` in
            # player_tracking_io is the only thing that needs to know that.
            for _, base, size in extra_regions:
                block += dme.read_bytes(base, size)
            pointers = dme.read_bytes(FIELDER_POINTER_TABLE, 36)
            if not wandered:
                for i in range(9):
                    target = struct.unpack(">I", pointers[i * 4 : i * 4 + 4])[0]
                    # Null is the game freeing the fielders once the match
                    # ends, not moving them: season games 2813 and 2814 were
                    # quarantined whole over P reading 0 seconds after the
                    # final out, before the bridge got round to stopping us.
                    # A slot that comes back pointing elsewhere still trips.
                    if target == 0:
                        continue
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
            delta = xor_delta(block, previous)
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

            # CRASH DURABILITY. zlib holds its output until it has a block's
            # worth, so a collector killed mid-game used to leave everything
            # after the readiness flush inside a dead process. A sync flush
            # every couple of seconds puts it in the OS instead; the reader
            # decodes a stream cut after any of them. The checkpoint also
            # fsyncs and rewrites the header with how far the capture got.
            now_sync = time.perf_counter()
            if capture_ready_announced and now_sync - last_sync >= SYNC_FLUSH_SECONDS:
                try:
                    sink.write(compressor.flush(zlib.Z_SYNC_FLUSH))
                    sink.flush()
                    if now_sync - last_checkpoint >= CHECKPOINT_SECONDS:
                        os.fsync(sink.fileno())
                        header["progress"] = {
                            "frames": frames, "last_timer": timer,
                            "bytes_on_disk": sink.tell(),
                            "elapsed_s": round(now_sync - started, 3),
                            **{k: v for k, v in timing.summary().items() if k != "gaps"}}
                        write_json_atomic(stem.with_suffix(".json"), header)
                        last_checkpoint = now_sync
                except OSError as error:      # noqa: BLE001 - never fatal
                    print(f"  checkpoint flush failed: {error!r}", flush=True)
                last_sync = now_sync

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

            # After the frame is on disk, like the live derivation: a knockdown
            # starting now is when the train is beside the fielder.
            if probe is not None:
                for index, actor in enumerate(actors["fielders"]):
                    down = block[actor["address"] - STATE_BASE + knockdown_at]
                    if down and not probe_down[index]:
                        ask_probe(timer, block, actor["name"])
                    probe_down[index] = down
                if probe_policy is not None:
                    label = probe_policy.check(timer, block)
                    if label:
                        ask_probe(timer, block, None, label)

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
        # Closing its input is the probe's stop signal. Each copy is already on
        # disk, so this only waits out the one in progress.
        if probe is not None:
            try:
                probe.stdin.close()
                probe.wait(timeout=MEMORY_PROBE_EXIT_S)
            except Exception as error:          # noqa: BLE001 - diagnostic only
                print(f"  memory probe still writing at exit: {error!r}", flush=True)
        if "memory_probe" in header:
            header["memory_probe"]["copies_requested"] = probe_copies
        if has_winmm:
            ctypes.windll.winmm.timeEndPeriod(1)

    elapsed = time.perf_counter() - started
    size = stem.with_suffix(".bin").stat().st_size
    header["frames"] = frames
    header["missed_frames"] = skips
    header["frame_timing"] = timing.summary()
    header["capture_complete"] = True
    header.pop("progress", None)
    header["fielder_pointers_left_region"] = wandered
    header["duration_seconds"] = round(elapsed, 3)
    if live is not None:
        header["live_derivation"] = live.status()
    header["checksum_sha256"] = hashlib.sha256(
        stem.with_suffix(".bin").read_bytes()).hexdigest()
    # Both copies, written now that no frame is waiting on the clock. The
    # second one's whole job is to say what CHANGED over the session: an object
    # whose bytes are identical in both did not move and holds no state a
    # game's worth of play touched, which is an answer, and one that differs is
    # where to look for the arrow's active or collision state.
    if stadium_dump_start_bytes is not None:
        try:
            header["stadium_dump_start"] = write_stadium_memory(
                stadium_dump_start_bytes, stem.with_suffix(".memdump.zlib"))
            header["stadium_dump_end"] = write_stadium_memory(
                read_stadium_memory(dme), stem.with_suffix(".memdump-end.zlib"))
            print(f"stadium memory dumps written "
                  f"({header['stadium_dump_start']['compressed_bytes'] / 1e6:.1f} MB each)")
        except Exception as error:              # noqa: BLE001 - diagnostic only
            print(f"  stadium memory dump failed: {error!r}", flush=True)
    write_json_atomic(stem.with_suffix(".json"), header)
    write_manifest({
        "status": "captured",
        "stem": str(stem.resolve()),
        "header_path": str(stem.with_suffix(".json").resolve()),
        "stream_path": str(stem.with_suffix(".bin").resolve()),
        "game_id": args.game_id,
        "competition_type": args.competition_type,
        "source_id": args.source_id,
        "evidence_profile": args.evidence_profile,
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
