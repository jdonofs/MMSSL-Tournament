"""Read back what collect_player_tracking.py recorded.

The stream is XOR-delta'd against the previous frame and then zlib'd as one
continuous stream, so frames can only be read forward from the start -- there is
no seeking into the middle of a session. That is the price of the delta, and it
buys roughly two orders of magnitude on disk. Sessions are minutes long, so a
full forward pass costs a second or two.

Everything here returns plain tuples and dicts rather than numpy arrays: the
analysis that follows is mostly sequential state machines over frames, and
keeping the dependency list at "standard library plus dolphin-memory-engine"
means the analysis runs anywhere the collector does.
"""
from __future__ import annotations

import json
import math
import struct

import numpy as _np
import zlib
from dataclasses import dataclass
from pathlib import Path

FRAME_MAGIC = b"MSSTRK02"
FRAME_HEADER = ">IdI"
FRAME_HEADER_SIZE = struct.calcsize(FRAME_HEADER)


# Scalars named after some sessions were already recorded. See STATE_FIELDS in
# collect_player_tracking.py for what each one is and how it was identified;
# these addresses have to stay in step with that list.
LATE_STATE_FIELDS = [
    ("throw_target", 0x900D951A, ">h"),
    ("contact_fielder", 0x900D9522, ">h"),
    ("last_contact_fielder", 0x900D9524, ">h"),
    ("buddy_thrower", 0x900D66D0, ">h"),
    ("buddy_partner", 0x900D66CE, ">h"),
    # The batter's two swing animation counters. Both idle at 0, tick up one per
    # frame while their animation runs, and freeze on contact -- which is why a
    # contact frame reads a small number and a whiff keeps counting into the
    # follow-through. See STATE_FIELDS in collect_player_tracking.py for how
    # they were identified and what they settle.
    ("swing_frames", 0x900D6A49, "B"),
    ("bunt_frames", 0x900D6A4F, "B"),
    # The charge behind a swing, which the two counters above cannot distinguish:
    # a slap and a charge run the same swing animation. The frame counter ticks
    # up while the charge is held and freezes on release; the meter is that count
    # over 60, clamped at 1.0, and resets on contact -- so the meter is what ties
    # a charge to the pitch it was released at. Retroactive like the rest of this
    # list: the whole state block was always captured, so every session on disk
    # can be re-derived for slap versus charge without replaying a game. See
    # STATE_FIELDS in collect_player_tracking.py for how they were identified.
    ("swing_charge_frames", 0x900D6A59, "B"),
    ("swing_charge_meter", 0x900D6A3C, ">f"),
    ("laser_throw_flag", 0x900D9AF5, "B"),
    # Captain star swing; the value names the captain. See STATE_FIELDS in
    # collect_player_tracking.py.
    ("star_swing", 0x900D954A, "B"),
    # Score and hits per team. Retroactive like the rest of this list: these four
    # were always inside the captured block, they just had no name. "away" is the
    # team batting in half 0, confirmed by every counter rising only during its
    # own half-inning.
    ("away_score", 0x900D5D98, ">H"),
    ("home_score", 0x900D5DB2, ">H"),
    ("away_hits", 0x900D5DCD, "B"),
    ("home_hits", 0x900D5DE7, "B"),
    # The team star meters, which are NOT retroactive: they sit below where this
    # project started capturing until 2026-09-25. Listing them here is still
    # right -- the bounds check in Session.state and SnapshotBuilder.state drops
    # an address a session never recorded, so an old capture stays silent about
    # its meters instead of reading a neighbouring byte as one.
    ("away_star_meter", 0x900D4E24, ">H"),
    ("home_star_meter", 0x900D4E26, ">H"),
]

# Actor fields named after the existing sessions were captured. The raw fielder
# objects were always inside each frame, so old MSSTRK02 files remain complete.
LATE_ACTOR_FIELDS = {
    "fielding_contact_counter": 0x2C4,
    "catch_type": 0x2AC,
    "frozen_flag": 0x240,
    "frozen_timer": 0x20D,
    # The fielder structs were always captured whole, so naming this field makes
    # every DK Jungle session already on disk report its flower sprays -- no
    # re-capture, and the sessions an operator annotated by hand become the
    # test set for it rather than merely the evidence that found it.
    "flower_gas_flag": 0x242,
    # Night DK Jungle flowers write a separate byte. The full fielder struct
    # makes this readable retroactively in every MSSTRK02 capture.
    "flower_gas_night_flag": 0x2CA,
    # Retroactive for the same reason: every session on disk already holds the
    # fielder structs, so naming this makes six parks' knockdowns readable in
    # captures recorded weeks before it was found.
    "knockdown_flag": 0x23F,
    # The close play -- MSS's A/B button-mash contest at a base -- read off the
    # fielder in it, and retroactive for the same reason again. See
    # collect_player_tracking.py for how it was found and what the value means.
    "close_play_flag": 0x246,
    # The buddy attack, retroactive like the rest of this list: the fielder
    # structs were always captured whole, so naming it makes every session on
    # disk report its attacks -- which is what turned the operator's ten
    # annotated ones into the test set. See collect_player_tracking.py.
    "buddy_attack_flag": 0x265,
    "buddy_attack_frames": 0x20B,
    # Unlike +0x265, which says only that the animation ran, this latches on a
    # successful contact. It stays zero for an attack that swings at empty air.
    "buddy_attack_hit_flag": 0x267,
    # Generic impact-stun state. Daisy Cruiser table causation is assigned by
    # the deriver only after captain star swings have been excluded.
    "impact_stun_flag": 0x243,
    # Burned by a fire star swing -- Mario's fireball or Bowser's breath. See
    # collect_player_tracking.py; retroactive like everything above.
    "burned_flag": 0x23E,
    # THE FIELDER'S OWN SPEED, and the end of measuring it by hand. FIELDER
    # CLASS ONLY -- see collect_player_tracking.py for why the offense actors
    # cannot use these and what happens if they try.
    #
    # Both are stored per FRAME, not per second, which is the one correction to
    # the report these came from. Scaled to u/s at the point of use below so
    # nothing downstream has to remember the factor.
    "speed": 0x0E4,
    "max_speed_constant": 0x0F0,
    # The game's own ground-plane distances: to the live ball, and to where the
    # ball will first touch down.
    #
    # THESE ARE CARRIED, NOT TRUSTED, and nothing derives from them yet. They
    # are approximately the distances computed from the captured coordinates and
    # not exactly: over 4.17M frames +0x13C reproduces to 0.05u on 79% of
    # samples and +0x148 on 52%, and the residual is not explained by which
    # fielder is nearest the ball or by position. Some of it is a frame of skew
    # -- matching +0x13C against the PREVIOUS frame's fielder position scores
    # 79.2% where the current frame scores 72.5%, so the game computes it before
    # it moves the body -- but that does not account for all of it.
    #
    # Until it does, prefer the distance computed from coordinates. These are
    # here because the bytes are free and a later pass may name what they
    # actually measure.
    "ball_distance": 0x13C,
    "landing_distance": 0x148,
}

# Where the fielder is steering, as opposed to where it is. This is the field
# the header has always called `position_b`; the name here says what it does.
TARGET_POSITION_OFFSET = 0x038

# THE BALL, AT A FIXED ADDRESS. The pointer-resolved feed reads the same ball
# through BALL_POINTER_SLOT plus a per-stadium coordinate offset that has to be
# relearned at every stadium load; this address needs neither, and it is inside
# the captured state region, so every session already on disk carries it.
#
# It agrees with the pointer-resolved feed exactly, WITH Z NEGATED, which is why
# it is passed through the same ball-frame transform as everything else instead
# of being trusted raw.
BALL_POSITION_FLAT = 0x900D6B6C

# THE GAME'S OWN FIRST-BOUNCE PREDICTION, as (x, z), written on the contact
# frame and cleared to (0, 0) while no ball is in flight.
#
# Across 61 batted balls in mario_stadium-20260904T213725Z it sits a median
# 0.14u from the landing the deriver measures from the flight itself. It is NOT
# redundant with that measurement: it is where the ball WOULD first touch down,
# so it keeps its value when a fielder catches the ball, when the ball strikes a
# wall, and on a home run -- the three cases where a measured landing is short
# by construction. The disagreements are the signal.
BALL_LANDING_PREDICTION = 0x900D6AC8 + 0x418


@dataclass
class Frame:
    """One captured game frame."""

    timer: int          # the game's own 60 Hz frame counter; the real clock
    elapsed: float      # wall seconds since the session started
    ball_pointer: int
    ball: tuple         # (x, y, z) in the ball's coordinate frame
    fielder_pointers: tuple   # the nine position pointers as of this frame
    block: bytes        # the whole state region, reconstructed

    def actor(self, address: int, size: int, base: int) -> memoryview:
        return memoryview(self.block)[address - base : address - base + size]


class Session:
    """A recorded session: its JSON header plus a forward iterator of frames."""

    def __init__(self, stem: str | Path):
        stem = Path(stem)
        if stem.suffix in (".json", ".bin"):
            stem = stem.with_suffix("")
        self.stem = stem
        self.header = json.loads(stem.with_suffix(".json").read_text())
        self.state_base = self.header["state_base"]
        self.state_size = self.header["state_size"]
        # Regions captured beyond the state block, appended to each frame in
        # order. Sessions recorded before the barrel was found have none, and a
        # capture_size defaulting to state_size makes them read exactly as
        # before -- the frame loop below is shared by both.
        self.extra_regions = [tuple(r) for r in self.header.get("extra_regions", [])]
        self.capture_size = self.header.get("capture_size", self.state_size)
        self.fields = {**LATE_ACTOR_FIELDS, **self.header["actor_fields"]}
        self.fielders = self.header["actors"]["fielders"]
        self.offense = self.header["actors"]["offense"]

    def frames(self):
        """Yield every frame in order, rebuilding each from its XOR delta."""
        path = self.stem.with_suffix(".bin")
        decompressor = zlib.decompressobj()
        buffer = bytearray()
        previous = _np.zeros(self.capture_size, dtype=_np.uint8)
        with path.open("rb") as source:
            # The magic sits OUTSIDE the compressed stream, so that a truncated
            # or half-written session is still identifiable by its first bytes.
            if source.read(len(FRAME_MAGIC)) != FRAME_MAGIC:
                raise ValueError(f"{path} is not a player-tracking stream")
            while True:
                chunk = source.read(1 << 20)
                buffer += (decompressor.decompress(chunk) if chunk
                           else decompressor.flush())

                while len(buffer) >= 4:
                    (length,) = struct.unpack(">I", buffer[:4])
                    if len(buffer) < 4 + length:
                        break
                    record = bytes(buffer[4 : 4 + length])
                    del buffer[: 4 + length]
                    timer, elapsed, pointer = struct.unpack(
                        FRAME_HEADER, record[:FRAME_HEADER_SIZE]
                    )
                    cursor = FRAME_HEADER_SIZE
                    ball = struct.unpack(">fff", record[cursor : cursor + 12])
                    cursor += 12
                    pointers = struct.unpack(">9I", record[cursor : cursor + 36])
                    cursor += 36
                    delta = record[cursor:]
                    # numpy rather than a Python loop: a session is ~75,000
                    # frames of ~28 KB, so the byte-at-a-time version was two
                    # billion interpreted operations and took minutes. Same
                    # arithmetic, same output, seconds instead.
                    view = _np.frombuffer(delta, dtype=_np.uint8)
                    previous[: len(view)] ^= view
                    yield Frame(timer, elapsed, pointer, ball, pointers,
                                previous.tobytes())

                if not chunk:
                    return

    def extra_region(self, frame: Frame, name: str) -> memoryview | None:
        """The named appended region for one frame, or None for old captures.

        Controller gesture calibration uses this rather than duplicating the
        packed-buffer arithmetic.  It also makes absence explicit: sessions
        recorded before Wii Remote structs were added have no such evidence.
        """
        cursor = self.state_size
        for region_name, _, size in self.extra_regions:
            if region_name == name:
                return memoryview(frame.block)[cursor:cursor + size]
            cursor += size
        return None

    # -- accessors ---------------------------------------------------------

    def triple(self, frame: Frame, actor: dict, offset: int) -> tuple:
        start = actor["address"] - self.state_base + offset
        return struct.unpack(">fff", frame.block[start : start + 12])

    def byte(self, frame: Frame, actor: dict, offset: int) -> int:
        return frame.block[actor["address"] - self.state_base + offset]

    def state(self, frame: Frame) -> dict:
        """The scalar game situation for this frame.

        Fields the header does not list are filled in from LATE_STATE_FIELDS, so
        a scalar discovered after a session was captured is still readable from
        it. The whole state region is recorded every frame, so the bytes were
        always there -- only the name is new.
        """
        out = {}
        listed = {name for name, _, _ in self.header["state_fields"]}
        fields = list(self.header["state_fields"]) + [
            field for field in LATE_STATE_FIELDS if field[0] not in listed
        ]
        for name, address, fmt in fields:
            if not (self.state_base <= address
                    < self.state_base + self.state_size):
                continue
            off = address - self.state_base
            if fmt == "B":
                out[name] = frame.block[off]
            elif fmt == "b":
                value = frame.block[off]
                out[name] = value - 256 if value > 127 else value
            else:
                out[name] = struct.unpack(
                    fmt, frame.block[off : off + struct.calcsize(fmt)]
                )[0]
        return out


# --- shared snapshot construction -------------------------------------------
#
# The live collector and the postgame pass MUST produce identical snapshots or
# the two derivations drift, and the whole point of feeding one state machine
# from both is that they cannot. The arithmetic is the same in both cases --
# an actor field is a fixed offset into a block that starts at STATE_BASE --
# so the only thing that differs is where the block came from: a decompressed
# XOR delta on disk, or a 28 KB read out of Dolphin a moment ago.
#
# Everything below therefore takes a raw `block` rather than a Frame, and the
# recorded-session path is a thin wrapper that unpacks a Frame into one.


# How close to a cannon sentinel counts as parked. The values are written
# exactly, but comparing floats for equality to decide whether a hazard fired is
# the kind of thing that works until it does not.
BARREL_PARKED_UNITS = 0.5

# Outside this the slot is not holding a position. The field is 100-odd units
# from home to the deepest fence, so anything past a few hundred is not a place
# on it. In a park with no barrel the slot holds whatever that park put there,
# and at Mario Stadium that was -8.9e33: a value that is not a coordinate, that
# no cannon test rejects, and that summed along a path to NaN -- which Python
# then wrote into the plays file as a bare `NaN` token, unreadable by every
# JavaScript consumer downstream, the calibration planner included.
BARREL_POSITION_LIMIT_UNITS = 1000.0

# An all-zero slot is not a barrel either. Zero is the world origin, which sits
# on home plate: a barrel parked on the plate for every frame of every play is
# not a thing DK Jungle does. The 2026-09-04 DK Jungle session read exactly
# (0, 0, 0) at the barrel address for all 77,581 frames -- the object was not
# where it was found -- and because zeros are finite, in range, and away from
# both cannon sentinels, every one of that game's 101 plays came back carrying a
# live barrel sitting on the plate. The distance from an outfielder to the
# origin then became "closing to 65.1 units" in the narrative, and the barrel
# clause SUPPRESSES the honest knockdown sentence, so three fielders the
# operator watched get floored were described by a fabricated number instead.
BARREL_ZERO_EPSILON_UNITS = 1e-6

# Peach Ice Garden object layout. New captures carry these values in their own
# header; the defaults make the first dynamically located session readable
# after its header address was corrected from slot 1 to the true slot 0.
FREEZIE_COUNT = 5
FREEZIE_STRIDE = 0xAC
FREEZIE_TRANSLATION = (0x0C, 0x1C, 0x2C)
FREEZIE_ACTIVE_OFFSET = 0x8A

# Wario City placed-prop layout, matching find_arrow_transform_candidates in
# collect_player_tracking.py: a row-major 3x4 matrix whose translation is the
# last column, so the three coordinates sit 16 bytes apart exactly as the
# Freezie's do.
PROP_TRANSLATION = (0x0C, 0x1C, 0x2C)
PROP_ACTIVE_OFFSET = 0x8A
# How much of the struct past the transform to keep beside it. An arrow that
# has an active or collision byte has it somewhere here; 64 bytes is enough to
# see one change without turning every snapshot into a hex dump.
PROP_TAIL_BYTES = 64

# Kept here rather than imported from the collector so the reader does not
# depend on it -- these are properties of the GAME, and a session that recorded
# different ones carries them in its own header.
BARREL_POSITION = 0x92AF5490
BARREL_CANNONS = ((-39.0, 4.0, -93.5), (39.0, 4.0, -93.5))
YOSHI_TRAIN_POSITION = 0x811F84DC

# WHERE THE GAME AIMED A THROW, as a position in the actor frame. One frame after
# release it holds where the ball is going: across 315 throws in five games
# (2026-09-11) it sat within 0.4u of the arrival on 253, usually on the receiver's
# own feet and, for a receiver still running, on the spot they will meet it. A
# throw that lands well away from it is an inaccurate throw -- see
# THROW_OFF_TARGET_UNITS in derive_player_metrics.py. Inside the state block, so
# every capture on disk already holds it.
THROW_AIM_ADDRESS = 0x900D6E60
# WHERE THE GAME ACTUALLY SENT IT: x at +0 and z at +4, actor frame, 0x50 past
# the aim point, written on the release frame and held until arrival. The aim
# point is the receiver; this is the aim point plus whatever error the throw
# was given, which is the bad-chemistry miss itself. Across the archive all 18
# off-target throws landed 0.08-0.89u from it, against 1.97-7.69u from the aim
# point, and 577 of 604 on-target throws landed within 0.35u. Found 2026-09-11
# by searching the state block around the aim point for each landing spot.
THROW_DESTINATION_ADDRESS = 0x900D6EB0


def dumps_play(record) -> str:
    """Serialize a play or pitch as JSON that every consumer can actually read.

    Python writes a float NaN as the bare token `NaN`, which is not JSON, and
    every reader on the JavaScript side -- the live collector feed, the replay
    console, the flight archive, the calibration planner -- throws on it. The
    live feed catches that throw and DROPS THE PLAY, with the only complaint
    going to a console nobody keeps. mario_stadium-20260904T000419Z lost 22 of
    its 92 plays that way and the console reported them as 22 unresolved
    fielding at-bats and 7 unresolved running ones, which reads like a fielding
    bug and is not one.

    So a value that is not a number is written as one thing every reader
    understands: null. Losing one measurement to null beats losing the play.
    """
    def clean(value):
        if isinstance(value, float):
            return value if math.isfinite(value) else None
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [clean(item) for item in value]
        return value

    return json.dumps(clean(record), allow_nan=False, separators=(",", ":"))


def capture_offset(address: int, state_base: int, state_size: int,
                   extra_regions) -> int | None:
    """Where an absolute address lands in a captured frame buffer.

    A frame is the state block followed by each extra region in order, so an
    address inside the state block is `address - state_base` and one inside an
    extra region is offset past the end of everything before it. Returns None
    for an address that was never captured -- which is the honest answer for a
    barrel read against a session recorded before barrels were captured.
    """
    if state_base <= address < state_base + state_size:
        return address - state_base
    cursor = state_size
    for _, base, size in extra_regions:
        if base <= address < base + size:
            return cursor + (address - base)
        cursor += size
    return None


def read_state_scalar(block, state_base: int, address: int, fmt: str):
    """One scalar out of a captured state block, by absolute address."""
    off = address - state_base
    if fmt == "B":
        return block[off]
    if fmt == "b":
        value = block[off]
        return value - 256 if value > 127 else value
    return struct.unpack(fmt, block[off : off + struct.calcsize(fmt)])[0]


class SnapshotBuilder:
    """Turns one captured state block into the snapshot the deriver consumes.

    The snapshot shape is the contract between capture and derivation:

        {"t", "timer", "state": {...}, "ball": (x, y, z), "actors": {name: {...}}}

    `t` is game-clock seconds, from the game's own 60 Hz counter rather than
    from wall time, because the emulator does not run at exactly 60 Hz and
    every measurement downstream is a rate.

    Positions come back in the BALL's coordinate frame, so fielder tracks,
    runner paths and batted-ball spray overlay without a second conversion.
    The sign convention is measured by the calibration step and passed in.
    """

    def __init__(self, *, state_base: int, actors: list, fields: dict,
                 state_fields: list, position_offset: int,
                 ball_frame: dict | None = None, fps: float = 59.94,
                 state_size: int | None = None, extra_regions=(),
                 barrel_address: int | None = None, barrel_cannons=(),
                 train_address: int | None = None,
                 freezie_address: int | None = None, freezie_count: int = 0,
                 freezie_stride: int = 0, freezie_translation=(),
                 freezie_active_offset: int | None = None,
                 prop_transforms=(), prop_translation=PROP_TRANSLATION):
        self.state_size = state_size
        self.extra_regions = list(extra_regions)
        self.barrel_cannons = list(barrel_cannons)
        # Resolved once, here, rather than per frame: it is a constant for the
        # whole session and None for any session recorded before barrels were
        # captured, which is what makes the barrel block below skip cleanly.
        self.barrel_offset = (
            capture_offset(barrel_address, state_base, state_size,
                           self.extra_regions)
            if barrel_address is not None and state_size is not None else None)
        self.train_offset = (
            capture_offset(train_address, state_base, state_size,
                           self.extra_regions)
            if train_address is not None and state_size is not None else None)
        self.freezie_offset = (
            capture_offset(freezie_address, state_base, state_size,
                           self.extra_regions)
            if freezie_address is not None and state_size is not None else None)
        self.freezie_count = freezie_count
        self.freezie_stride = freezie_stride
        self.freezie_translation = tuple(freezie_translation)
        self.freezie_active_offset = freezie_active_offset
        # WARIO CITY'S PLACED PROPS. The collector shortlists them by their
        # 3x4 Y-rotation shape and records the enclosing allocation; this
        # resolves each one's address into the frame buffer once, so the live
        # path and the postgame pass read the identical bytes through the
        # identical code. A prop whose address the session did not capture --
        # a candidate outside the chosen cluster -- resolves to None and is
        # dropped, which is the honest answer rather than a zero.
        self.prop_offsets = []
        for prop in prop_transforms or ():
            offset = (capture_offset(prop["address"], state_base, state_size,
                                     self.extra_regions)
                      if state_size is not None else None)
            if offset is not None:
                self.prop_offsets.append((prop, offset))
        self.prop_translation = tuple(prop_translation)
        self.state_base = state_base
        self.fps = fps
        self.position_offset = position_offset
        self.actors = actors
        self.state_fields = list(state_fields)
        self.index_offset = fields["batting_index"]
        self.character_offset = fields["character_id"]
        self.airborne_offset = fields["airborne_flag"]
        self.buddy_jump_offset = fields["buddy_jump_flag"]
        self.catch_type_offset = fields["catch_type"]
        self.action_offset = fields["bobble_flag"]
        self.contact_counter_offset = fields["fielding_contact_counter"]
        self.frozen_offset = fields["frozen_flag"]
        self.sprayed_offset = fields.get("flower_gas_flag")
        self.sprayed_night_offset = fields.get("flower_gas_night_flag")
        self.knockdown_offset = fields.get("knockdown_flag")
        self.close_play_offset = fields.get("close_play_flag")
        self.buddy_attack_offset = fields.get("buddy_attack_flag")
        self.buddy_attack_hit_offset = fields.get("buddy_attack_hit_flag")
        self.impact_stun_offset = fields.get("impact_stun_flag")
        self.burned_offset = fields.get("burned_flag")
        self.speed_offset = fields.get("speed")
        self.max_speed_offset = fields.get("max_speed_constant")
        self.ball_distance_offset = fields.get("ball_distance")
        self.landing_distance_offset = fields.get("landing_distance")
        self.frozen_timer_offset = fields["frozen_timer"]
        self.bases_ran_offset = fields["bases_ran"]
        self.stealing_offset = fields["is_stealing"]
        frame_fit = ball_frame or {}
        self.sign_x = frame_fit.get("sign_x", 1.0)
        self.sign_z = frame_fit.get("sign_z", -1.0)
        self.swap_xz = frame_fit.get("swap_xz", False)

    def to_ball_frame(self, triple: tuple) -> tuple:
        x, y, z = triple
        px, pz = (z, x) if self.swap_xz else (x, z)
        return (self.sign_x * px, y, self.sign_z * pz)

    def state(self, block) -> dict:
        out = {}
        # Bounded by the STATE BLOCK, not by the frame: past state_size the
        # frame holds the appended extra regions, so an address above the block
        # would otherwise read some other region's bytes as itself.
        limit = self.state_size if self.state_size is not None else len(block)
        for name, address, fmt in self.state_fields:
            if not (self.state_base <= address
                    and address - self.state_base + struct.calcsize(fmt) <= limit):
                continue
            out[name] = read_state_scalar(block, self.state_base, address, fmt)
        return out

    def build(self, timer: int, ball: tuple, block) -> dict:
        base = self.state_base
        snapshot = {
            "t": timer / self.fps,
            "timer": timer,
            "state": self.state(block),
            "ball": ball,
            "actors": {},
        }
        # WHERE THE GAME AIMED THE THROW, in the actor frame like every fielder
        # position. See THROW_AIM_ADDRESS.
        aim_at = THROW_AIM_ADDRESS - base
        if self.state_size is not None and 0 <= aim_at <= self.state_size - 12:
            aim = struct.unpack(">fff", block[aim_at:aim_at + 12])
            snapshot["throw_aim"] = (self.to_ball_frame(aim)
                                     if all(math.isfinite(value) for value in aim) else None)
        # WHERE THE GAME ACTUALLY SENT IT, same frame. See
        # THROW_DESTINATION_ADDRESS: only x and z are stored, so y reads 0.
        destination_at = THROW_DESTINATION_ADDRESS - base
        if self.state_size is not None and 0 <= destination_at <= self.state_size - 8:
            x, z = struct.unpack(">ff", block[destination_at:destination_at + 8])
            snapshot["throw_destination"] = (self.to_ball_frame((x, 0.0, z))
                                             if math.isfinite(x) and math.isfinite(z) else None)
        # WHERE THE GAME EXPECTS THE BALL TO FIRST TOUCH DOWN, same (x, z)
        # shape and same frame convention as the throw destination above. See
        # BALL_LANDING_PREDICTION. (0, 0) means no ball in flight, and is
        # reported as None rather than as a point behind the plate.
        landing_at = BALL_LANDING_PREDICTION - base
        if self.state_size is not None and 0 <= landing_at <= self.state_size - 8:
            x, z = struct.unpack(">ff", block[landing_at:landing_at + 8])
            live = (math.isfinite(x) and math.isfinite(z)
                    and (abs(x) > 1e-6 or abs(z) > 1e-6))
            snapshot["landing_prediction"] = (
                self.to_ball_frame((x, 0.0, z)) if live else None)
        # THE BALL AGAIN, from the fixed address rather than through the
        # per-stadium pointer offset. Carried beside `ball` rather than
        # replacing it: the two are checked against each other by
        # verify_player_metrics.py, and a disagreement means the stadium offset
        # went stale -- which is the failure this address exists to catch.
        flat_at = BALL_POSITION_FLAT - base
        if self.state_size is not None and 0 <= flat_at <= self.state_size - 12:
            raw = struct.unpack(">fff", block[flat_at:flat_at + 12])
            # It is stored in the ACTOR frame, like the fielder coordinates and
            # the throw points above, so it goes through the same transform
            # rather than through a hand-written sign flip.
            snapshot["ball_flat"] = (
                self.to_ball_frame(raw)
                if all(math.isfinite(value) for value in raw) else None)
        # DK JUNGLE'S BARREL. Present in the snapshot at every park, because
        # the capture is uniform; whether it MEANS anything is the derivation's
        # business. `live` is not a heuristic: the slot holds one of exactly two
        # cannon sentinels when nothing is rolling, so anything else is a barrel
        # in flight or on the ground.
        if self.barrel_offset is not None:
            raw = struct.unpack(
                ">fff", block[self.barrel_offset : self.barrel_offset + 12])
            plausible = (all(math.isfinite(value)
                             and abs(value) <= BARREL_POSITION_LIMIT_UNITS
                             for value in raw)
                         and any(abs(value) > BARREL_ZERO_EPSILON_UNITS
                                 for value in raw))
            parked = None
            for index, cannon in enumerate(self.barrel_cannons):
                if plausible and math.dist(raw, cannon) <= BARREL_PARKED_UNITS:
                    parked = "left" if cannon[0] < 0 else "right"
                    break
            snapshot["barrel"] = {
                "pos": self.to_ball_frame(raw) if plausible else None,
                "raw": raw,
                # A slot that is not holding a position is not holding a barrel.
                # "away from both sentinels" was the only test, so garbage read
                # as a live barrel rather than as garbage.
                "live": plausible and parked is None,
                "cannon": parked,
            }

        # YOSHI PARK'S TRAIN. This stable MEM1 slot is already in the ball
        # coordinate frame. Keeping the raw position in the shared snapshot
        # lets live and postgame causation use the same direct object evidence.
        if self.train_offset is not None:
            raw = struct.unpack(
                ">fff", block[self.train_offset : self.train_offset + 12])
            plausible = all(math.isfinite(value) and abs(value) <= 1000.0
                            for value in raw)
            snapshot["train"] = {
                "pos": raw if plausible else None,
                "raw": raw,
            }

        # PEACH ICE GARDEN'S FIVE FREEZIES. Their transform translations are
        # already in the ball coordinate frame. +0x8A drops from 1 to 0 on the
        # frame one breaks; retaining the raw value lets derivation detect the
        # event before separately attributing it to ball, throw, or buddy attack.
        if (self.freezie_offset is not None and self.freezie_count
                and self.freezie_stride and len(self.freezie_translation) == 3
                and self.freezie_active_offset is not None):
            snapshot["freezies"] = []
            for slot in range(self.freezie_count):
                start = self.freezie_offset + slot * self.freezie_stride
                raw = tuple(struct.unpack(">f", block[
                    start + offset:start + offset + 4])[0]
                    for offset in self.freezie_translation)
                plausible = all(math.isfinite(value) and abs(value) <= 1000.0
                                for value in raw)
                active_raw = block[start + self.freezie_active_offset]
                snapshot["freezies"].append({
                    "slot": slot,
                    "pos": raw if plausible else None,
                    "active": active_raw == 1,
                    "active_raw": active_raw,
                })

        # The props, read raw. NOTHING HERE SAYS THESE ARE ARROWS: the shape
        # that found them says only "a placed object with a heading", and which
        # of them Wario City's directional arrows are is settled by matching a
        # heading against the redirects measured off the ball. The derivation
        # is what decides that; this only makes the bytes readable identically
        # from a live frame and from a recorded one.
        if self.prop_offsets:
            snapshot["props"] = []
            for prop, offset in self.prop_offsets:
                matrix = struct.unpack(">12f", block[offset:offset + 48])
                raw = tuple(matrix[item // 4] for item in self.prop_translation)
                plausible = all(math.isfinite(value) and abs(value) <= 1000.0
                                for value in raw)
                cosine, sine = matrix[0], matrix[2]
                snapshot["props"].append({
                    "address": prop["address"],
                    "pos": raw if plausible else None,
                    # The uniform scale separates the classes in one allocation:
                    # Wario City's arrows are drawn at 1.0 and its manholes at
                    # 0.7. Carried through rather than re-derived so the live and
                    # postgame passes cannot classify them differently.
                    "scale": (round(matrix[5], 5)
                              if math.isfinite(matrix[5]) else None),
                    "heading_degrees": (round(math.degrees(math.atan2(sine, cosine)), 4)
                                        if math.isfinite(sine) and math.isfinite(cosine)
                                        else None),
                    # Generic raw byte only. Daisy Cruiser's paired table
                    # transforms establish that +0x8A is their active flag;
                    # other parks and unpaired props attach no meaning to it.
                    "active_raw": (block[offset + PROP_ACTIVE_OFFSET]
                                   if offset + PROP_ACTIVE_OFFSET < len(block)
                                   else None),
                    # Everything between the end of one transform and the start
                    # of the next is where an active flag or a collision state
                    # would live. Kept as bytes so a change is visible before
                    # anybody has named the field it happened in.
                    "tail": block[offset + 48:offset + 48 + PROP_TAIL_BYTES].hex(),
                })

        for actor in self.actors:
            start = actor["address"] - base
            index = block[start + self.index_offset]
            if index > 127:
                index -= 256
            triple_at = start + self.position_offset
            entry = {
                "kind": actor["kind"],
                "index": index,
                "character": block[start + self.character_offset],
                "pos": self.to_ball_frame(
                    struct.unpack(">fff", block[triple_at : triple_at + 12])),
                "airborne": 0, "fielding_action": 0, "contact_counter": 0,
                "catch_type": 0, "buddy_jump": 0, "bases_ran": 0, "stealing": 0,
                "frozen": 0, "frozen_remaining": 0, "sprayed": 0,
                "sprayed_night": 0,
                "knocked_down": 0, "close_play": 0, "buddy_attack": 0,
                "buddy_attack_hit": 0,
                "impact_stun": 0,
                "burned": 0,
                # Fielder class only; see below. None rather than 0 so that "the
                # game did not tell us" never reads as "standing still".
                "speed": None,
                "max_speed": None,
                "ball_distance": None,
                "landing_distance": None,
            }
            # The two actor classes are different sizes and share only their
            # header fields. Reading a fielder-class flag out of a 468-byte
            # offense struct runs off the end of it and into the next actor.
            if actor["kind"] == "fielder":
                entry["airborne"] = block[start + self.airborne_offset]
                entry["catch_type"] = block[start + self.catch_type_offset]
                entry["fielding_action"] = block[start + self.action_offset]
                entry["contact_counter"] = block[start + self.contact_counter_offset]
                entry["buddy_jump"] = block[start + self.buddy_jump_offset]
                entry["frozen"] = block[start + self.frozen_offset]
                entry["frozen_remaining"] = block[start + self.frozen_timer_offset]
                if self.sprayed_offset is not None:
                    entry["sprayed"] = block[start + self.sprayed_offset]
                if self.sprayed_night_offset is not None:
                    entry["sprayed_night"] = block[start + self.sprayed_night_offset]
                if self.knockdown_offset is not None:
                    entry["knocked_down"] = block[start + self.knockdown_offset]
                if self.close_play_offset is not None:
                    entry["close_play"] = block[start + self.close_play_offset]
                if self.buddy_attack_offset is not None:
                    entry["buddy_attack"] = block[start + self.buddy_attack_offset]
                if self.buddy_attack_hit_offset is not None:
                    entry["buddy_attack_hit"] = block[
                        start + self.buddy_attack_hit_offset]
                if self.impact_stun_offset is not None:
                    entry["impact_stun"] = block[start + self.impact_stun_offset]
                if self.burned_offset is not None:
                    entry["burned"] = block[start + self.burned_offset]
                # Stored per frame; published per second, because every other
                # speed in this pipeline is u/s and a mixed unit in one dict is
                # a bug waiting to be written.
                if self.speed_offset is not None:
                    at = start + self.speed_offset
                    entry["speed"] = struct.unpack(
                        ">f", block[at : at + 4])[0] * self.fps
                if self.max_speed_offset is not None:
                    at = start + self.max_speed_offset
                    entry["max_speed"] = struct.unpack(
                        ">f", block[at : at + 4])[0] * 15 * self.fps
                if self.ball_distance_offset is not None:
                    at = start + self.ball_distance_offset
                    entry["ball_distance"] = struct.unpack(
                        ">f", block[at : at + 4])[0]
                if self.landing_distance_offset is not None:
                    at = start + self.landing_distance_offset
                    entry["landing_distance"] = struct.unpack(
                        ">f", block[at : at + 4])[0]
            else:
                entry["bases_ran"] = block[start + self.bases_ran_offset]
                entry["stealing"] = block[start + self.stealing_offset]
            snapshot["actors"][actor["name"]] = entry
        return snapshot


def session_snapshot_builder(session: "Session", position_offset: int,
                             ball_frame: dict | None = None,
                             fps: float = 59.94) -> SnapshotBuilder:
    """A builder wired to a recorded session's own header."""
    listed = {name for name, _, _ in session.header["state_fields"]}
    state_fields = list(session.header["state_fields"]) + [
        field for field in LATE_STATE_FIELDS if field[0] not in listed
    ]
    actors = ([dict(a, kind="fielder") for a in session.fielders]
              + [dict(a, kind="offense") for a in session.offense])
    return SnapshotBuilder(
        state_base=session.state_base, actors=actors, fields=session.fields,
        state_fields=state_fields, position_offset=position_offset,
        ball_frame=ball_frame, fps=fps,
        state_size=session.state_size, extra_regions=session.extra_regions,
        # A session recorded before barrels were captured resolves this to None
        # and simply has no barrel in its snapshots, which is correct: it does
        # not, and inventing one from an uncaptured address would be worse than
        # the silence.
        barrel_address=session.header.get("barrel_position", BARREL_POSITION),
        barrel_cannons=[tuple(c) for c in
                        session.header.get("barrel_cannons", BARREL_CANNONS)],
        # Absent on old captures, whose frame buffers never held this address.
        train_address=session.header.get("yoshi_train_position"),
        freezie_address=session.header.get("freezie_array"),
        freezie_count=session.header.get("freezie_count", FREEZIE_COUNT),
        freezie_stride=session.header.get("freezie_stride", FREEZIE_STRIDE),
        freezie_translation=session.header.get(
            "freezie_translation", FREEZIE_TRANSLATION),
        freezie_active_offset=session.header.get(
            "freezie_active_offset", FREEZIE_ACTIVE_OFFSET),
        # Only the cluster the session actually recorded. The wider candidate
        # list is in the header too, but its addresses were never captured, so
        # reading them back would be reading whatever else landed at that
        # offset -- see BARREL_ZERO_EPSILON_UNITS for how that goes.
        prop_transforms=(session.header.get("prop_cluster")
                         or session.header.get("arrow_cluster") or ()),
        prop_translation=tuple(session.header.get(
            "prop_translation",
            session.header.get("arrow_translation", PROP_TRANSLATION))),
    )
