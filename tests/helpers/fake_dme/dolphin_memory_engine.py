"""A stand-in for dolphin_memory_engine: a scripted match, no emulator.

Put this directory first on PYTHONPATH and the collector, the memory probe and
the preflight all attach to it exactly as they would to Dolphin. It exists so
the whole capture path -- attach, header, frame loop, crash, read-back,
extraction -- can be run for real before the one-shot session, without starting
a game.

The match it serves is deliberately simple and deliberately asymmetric, so that
every check has something to find and nothing can pass by accident:

  * the game timer advances with wall-clock time at 60 Hz
  * port 1 presses A for frames 30..39 of every 120; port 2 presses B for
    frames 90..99 of every 150 -- the two remotes never share a schedule
  * each port's acc_value follows its own period
  * the away meter steps +7 every 600 frames, the home meter -50 every 900
  * a pitch is released every 300 frames in game_state 1, half flipping
    every 1800 frames
  * player_type says team1 = port 1 (0x00), team2 = port 2 (0x01)

FAKE_DME_NO_CONTROLLERS=1 leaves every controller struct at rest.
"""
from __future__ import annotations

import math
import os
import struct
import time

_PAGE = 0x10000
_pages: dict[int, bytearray] = {}
_hooked = False
_t0 = None

GAME_TIMER = 0x900DFCFC
STATE_BASE = 0x900D4E00
FIELDER_POINTER_TABLE = 0x80708D78
FIELDER_VTABLE = 0x806434E8
FIELDERS = [0x900D9B1C, 0x900D9E08, 0x900DA0F4, 0x900DA3E0, 0x900DA6CC,
            0x900DA9B8, 0x900DACA4, 0x900DAF90, 0x900DB27C]
OFFENSE_BASE = 0x900DB5D0
OFFENSE_STRIDE = 0x1D4
OFFENSE_VTABLE = 0x8064A318
BALL_POINTER_SLOT = 0x80795310
BALL_OBJECT = 0x91000000
BALL_OFFSET = 0x720
PORT_BASE = 0x80784CD8
PORT_STRIDE = 0x538


def _write(address: int, data: bytes) -> None:
    for index, value in enumerate(data):
        page, offset = divmod(address + index, _PAGE)
        _pages.setdefault(page, bytearray(_PAGE))[offset] = value


def _read(address: int, size: int) -> bytes:
    out = bytearray(size)
    cursor = 0
    while cursor < size:
        page, offset = divmod(address + cursor, _PAGE)
        take = min(_PAGE - offset, size - cursor)
        stored = _pages.get(page)
        if stored is not None:
            out[cursor:cursor + take] = stored[offset:offset + take]
        cursor += take
    return bytes(out)


def _setup() -> None:
    _pages.clear()
    table = b"".join(struct.pack(">I", address) for address in FIELDERS)
    _write(FIELDER_POINTER_TABLE, table)
    for index, address in enumerate(FIELDERS):
        _write(address, struct.pack(">I", FIELDER_VTABLE))
        _write(address + 0x04, struct.pack(">fff", 5.0 * index, 0.0, 30.0 + index))
        _write(address + 0x2B, bytes([index]))
    for slot in range(4):
        address = OFFENSE_BASE + OFFENSE_STRIDE * slot
        _write(address, struct.pack(">I", OFFENSE_VTABLE))
        _write(address + 0x29, bytes([0 if slot == 0 else 0xFF]))
    _write(BALL_POINTER_SLOT, struct.pack(">I", BALL_OBJECT))
    # resolve_offset looks for the pitch-reset z of -18.6 with a plausible
    # (x, y) in front of it.
    _write(BALL_OBJECT + BALL_OFFSET, struct.pack(">fff", 0.5, 2.0, -18.6000004))
    _write(0x80000000, b"RMBE01\x00\x00")
    _write(0x811F769D, bytes([0, 0, 0]))                    # Mario Stadium, day
    _write(0x811F76AC, bytes([3, 7]))                       # branding
    _write(0x811F76B0, bytes([0x00, 0x01]))                 # team1 = P1, team2 = P2
    _write(0x8062BD42, struct.pack(">h", 100))
    _write(0x8062BD48, struct.pack(">hh", 50, 50))
    _write(0x80794328, bytes([9, 0, 0, 0]))
    _write(0x80794C5C, struct.pack(">I", 0x91000000))       # replay pointer
    _write(0x8131B4B9, bytes([5]))                          # a roster slot
    for port in (1, 2):
        base = PORT_BASE + (port - 1) * PORT_STRIDE
        _write(base + 0x5C, bytes([0, 0, 0, 2]))           # core remote, no error
    _animate(100000)


def _timer() -> int:
    return 100000 + int((time.perf_counter() - _t0) * 60)


def _animate(timer: int) -> None:
    """Advance the scripted match to `timer`."""
    _write(GAME_TIMER, struct.pack(">I", timer))
    frame = timer - 100000
    half = (frame // 1800) % 2
    _write(0x900D5D97, bytes([1 + frame // 3600]))         # inning
    _write(0x900D5E25, bytes([half]))                       # inning_half
    _write(0x900D5C22, bytes([1 - half, half]))            # team1 fields in half 0
    _write(0x900D5C28, bytes([1]))                          # game_state: pitch
    _write(0x900D692C, bytes([(frame // 300) % 4 + 1]))     # pitches in PA
    _write(0x900D69EF, bytes([10 + (frame // 1200) % 9]))   # batter_id
    _write(0x900DB5F9, bytes([(frame // 1200) % 9]))        # batter_index
    _write(0x900D4E24, struct.pack(">H", min(250, 7 * (frame // 600))))
    _write(0x900D4E26, struct.pack(">H", max(0, 250 - 50 * (frame // 900))))
    if os.environ.get("FAKE_DME_NO_CONTROLLERS") == "1":
        return
    for port, (period, low, high, bit) in {1: (120, 30, 40, 0x0800),
                                           2: (150, 90, 100, 0x0400)}.items():
        base = PORT_BASE + (port - 1) * PORT_STRIDE
        phase = frame % period
        held = bit if low <= phase < high else 0
        previous = bit if low <= (frame - 1) % period < high else 0
        _write(base, struct.pack(">III", held, held & ~previous, previous & ~held))
        acc = 1.0 + 0.8 * math.sin(frame / (7.0 + 5 * port))
        _write(base + 0x0C, struct.pack(">ffff", 0.1 * port, acc, 0.0, abs(acc)))
        _write(base + 0x110, struct.pack(">Hhhh", held, int(512 * acc), 0, 100 * port))


# --- the dolphin_memory_engine surface the repository uses -----------------

def hook():
    global _hooked, _t0
    if not _hooked:
        _setup()
        _t0 = time.perf_counter()
    _hooked = True


def un_hook():
    global _hooked
    _hooked = False


def is_hooked():
    return _hooked


def get_status():
    return "DolphinStatus.hooked" if _hooked else "DolphinStatus.notRunning"


def read_bytes(address: int, size: int) -> bytes:
    if address == GAME_TIMER:
        _animate(_timer())
    return _read(address, size)


def write_word(address: int, value: int) -> None:
    _write(address, struct.pack(">I", value & 0xFFFFFFFF))


def write_byte(address: int, value: int) -> None:
    _write(address, bytes([value & 0xFF]))
