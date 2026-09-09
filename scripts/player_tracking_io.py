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
    ("laser_throw_flag", 0x900D9AF5, "B"),
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
    # Retroactive for the same reason: every session on disk already holds the
    # fielder structs, so naming this makes six parks' knockdowns readable in
    # captures recorded weeks before it was found.
    "knockdown_flag": 0x23F,
    # The close play -- MSS's A/B button-mash contest at a base -- read off the
    # fielder in it, and retroactive for the same reason again. See
    # collect_player_tracking.py for how it was found and what the value means.
    "close_play_flag": 0x246,
}


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

# Kept here rather than imported from the collector so the reader does not
# depend on it -- these are properties of the GAME, and a session that recorded
# different ones carries them in its own header.
BARREL_POSITION = 0x92AF5490
BARREL_CANNONS = ((-39.0, 4.0, -93.5), (39.0, 4.0, -93.5))


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
                 barrel_address: int | None = None, barrel_cannons=()):
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
        self.knockdown_offset = fields.get("knockdown_flag")
        self.close_play_offset = fields.get("close_play_flag")
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
        for name, address, fmt in self.state_fields:
            if not (self.state_base <= address < self.state_base + len(block)):
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
                "knocked_down": 0, "close_play": 0,
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
                if self.knockdown_offset is not None:
                    entry["knocked_down"] = block[start + self.knockdown_offset]
                if self.close_play_offset is not None:
                    entry["close_play"] = block[start + self.close_play_offset]
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
    )
