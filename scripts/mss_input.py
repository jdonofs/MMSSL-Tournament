"""Drive MSS's menus by writing its input state directly.

This replaces MSS-AutoTeam's keyboard layer. That layer only worked because
Dolphin's Wii Remote 1 was an *emulated* controller bound to keys; with a real
Wii Remote there is no input-mapping layer to bind to, and exhibition mode
accepts player 1 only, so keyboard, vgamepad and DSU are all unreachable by
construction.

The game keeps player input as a three-word struct, found with a write
breakpoint on the button word and confirmed against the disassembly at
0x805FD3F0:

    lwz    r3, 0(r31)        ; previous state
    rlwinm r5, r3, 0, 16, 31 ; previous buttons
    xor    r3, r0, r5        ; what changed
    stw    r0, 0(r31)        ; +0x00 held
    and    r0, r3, r0        ; changed & current = newly pressed
    stw    r0, 4(r31)        ; +0x04 pressed   <-- what menus read
    and    r0, r3, r5        ; changed & previous = newly released
    stw    r0, 8(r31)        ; +0x08 released

with r31 = 0x80784CD8. Buttons live in the low halfword of each word and use
the standard libogc WPAD bits.

Which field to write took a while to settle, and the disassembly above is
misleading about it. The comment on +0x04 says "what menus read", because that
is what the arithmetic implies -- but measured behaviour says otherwise. These
menus read HELD (the low halfword at 0x80784CDA) and do their own edge
detection. Writing `pressed` did nothing at all; writing `held` moved the
cursor.

Writing `held` unsuppressed was still unreliable, about one press in four with
no relationship to hold time, because the game rewrites the field every frame
microseconds before reading it. Writing several mirror addresses at once was
worse than useless -- it cancelled presses outright, since setting current and
previous together makes `xor` yield no changed bits.

The working configuration is therefore:

1. Write `held` (+0x00), not `pressed`.
2. NOP the store at STORE_HELD for the duration of the run, so the game stops
   overwriting the field a few microseconds after we set it.

With that store suppressed nothing else writes the field, so a press is
deterministic: set it, leave it up for about one frame so the game samples it
exactly once, clear it. Verified live at a 17ms dwell -- "lrlr" moves the
cursor exactly four times and ends where it started.

Usage as a library:

    from mss_input import WiimoteInput, SuppressDecode
    with SuppressDecode(dme):
        pad = WiimoteInput(dme)
        pad.execute("awawaw")       # same instruction syntax as main.py
        pad.combo("minus", "a")     # the start-game chord

Usage as a check:

    python scripts/mss_input.py --verify
    python scripts/mss_input.py --sequence lrlr --suppress
    python scripts/mss_input.py --port 2 --press a --suppress
    python scripts/mss_input.py --script "1:a 2:a" --suppress --step
"""
from __future__ import annotations

import argparse
import contextlib
import sys
import time

# Verified against MSS NTSC-U (RMBE01). The struct sits in the game's static
# globals near addresses the rest of this toolchain already uses (0x80794328
# rules, 0x80795310 ball pointer). The ball-coordinate offset in this project
# has moved between builds before, so verify() checks rather than assumes.
INPUT_STRUCT = 0x80784CD8
HELD_WORD = INPUT_STRUCT + 0x00
PRESSED_WORD = INPUT_STRUCT + 0x04
RELEASED_WORD = INPUT_STRUCT + 0x08

# One struct per controller port, as an array of stride 0x538. Port 1 was
# found by differential scan and confirmed against the disassembly; port 2 was
# found the same way with only the port 2 remote in hand, and the stride
# between them predicts ports 3 and 4.
#
# The confirmation is not just "all four read zero at rest", which any stretch
# of unused memory would satisfy. Each struct carries a 16-entry sample array
# of stride 0x38 at +0x110, and that array is what a long button hold lights up
# in a scan. The port 1 scan surfaced 0x80784DE8 and the port 2 scan surfaced
# 0x80785320 -- exactly base+0x110 in both cases, independently measured. Port
# 2's array runs to 0x807856A0, which lands clear of port 3 at 0x80785748.
#
# This also corrects an earlier misreading: 0x80784DE8 was labelled a
# "previous-frame copy" of port 1's input. It is not -- it is the head of port
# 1's sample array, which is why it holds values that are not zero at rest.
#
# Suppression does not need extending per port. The store being NOPed is
# `stw r0, 0(r31)`, which takes its target in a register, so the single Gecko
# code disables the held store for every port the routine services -- which is
# also why every remote goes inert while it is on.
PORT_STRIDE = 0x538
SAMPLE_ARRAY_OFFSET = 0x110
PORT_STRUCTS = {port: INPUT_STRUCT + (port - 1) * PORT_STRIDE
                for port in (1, 2, 3, 4)}


def words_for(base):
    """The three words of one port's input struct."""
    return {"held": base + 0x00, "pressed": base + 0x04, "released": base + 0x08}


def struct_for_port(port):
    base = PORT_STRUCTS.get(port)
    if base is None:
        raise SystemExit(
            f"The input struct for port {port} is not known yet. Find it by "
            "running, with ONLY that port's remote: "
            "python scripts/probe_wiimote_input.py find --buttons A,B,UP -- "
            f"then set PORT_STRUCTS[{port}] in scripts/mss_input.py to the "
            "address whose halfword carries the button bits."
        )
    return base


# The three stores that maintain the struct, from the disassembly above.
# Only the `pressed` store needs suppressing: leaving `held` and `released`
# alone keeps the real remote's state live for anything that reads them.
STORE_HELD = 0x805FD3F0
STORE_PRESSED = 0x805FD3F8
STORE_RELEASED = 0x805FD400

TARGETS = {"pressed": PRESSED_WORD, "held": HELD_WORD, "released": RELEASED_WORD}

# Suppressing a field means NOPing the store that maintains it. Writing one
# field while suppressing another is the mistake that cost a round of testing:
# the write lands, the game overwrites it microseconds later, and nothing
# happens for reasons that look nothing like the actual cause.
TARGET_STORES = {"held": STORE_HELD, "pressed": STORE_PRESSED,
                 "released": STORE_RELEASED}

# libogc WPAD bits, confirmed one at a time against a real remote.
BUTTONS = {
    "left": 0x0001,
    "right": 0x0002,
    "down": 0x0004,
    "up": 0x0008,
    "plus": 0x0010,
    "two": 0x0100,
    "one": 0x0200,
    "b": 0x0400,
    "a": 0x0800,
    "minus": 0x1000,
    "home": 0x8000,
}

# main.py's execute() alphabet, kept identical so its navigation strings
# ("awawawwwaawwwwwwwwrrawwwwd") port over unchanged.
INSTRUCTIONS = {"u": "up", "d": "down", "l": "left", "r": "right",
                "a": "a", "b": "b"}

# Chords, as single script tokens. "n" is the ready/Next chord: one player
# saying "I am done with this screen". It is what upstream called startGame,
# but it is not the game starting -- every screen that waits on both players
# wants it from each of them.
CHORDS = {"n": ("minus", "a")}

WAIT_SECONDS = 0.5

# Wait lengths, because the things being waited on are different sizes.
# "w" is a beat between presses on one settled screen. "W" is a screen CHANGE:
# a stadium loading, a captain screen giving way to the draft. Every wait was
# "w" at first, which is why the full run desynchronised where the segment
# tests never did -- a segment starts on a screen that has already arrived, so
# it never pays a transition, and the one length that was tuned was the wrong
# one. Nothing here is time-critical, so "W" is deliberately generous, and
# "s" is the same transition taken optimistically -- see NAV_FAST.
# Note the case matters and "d" is NOT available -- it is the down press.
WAITS = {"w": WAIT_SECONDS, "W": 2.5, "E": 2.5, "D": 5.0,
         "T": 3.5, "s": 1.2, "t": 0.7, ".": 0.2}

# One video frame at 60Hz. With the store suppressed the value is genuinely
# present for the whole dwell, so a one-frame hold should be sampled exactly
# once -- long enough to be seen, short enough not to be seen twice.
DEFAULT_HOLD_MS = 17.0
DEFAULT_GAP_MS = 50.0

CALIBRATION_HOLDS = [8.0, 12.0, 17.0, 25.0, 33.0]

NOP = 0x60000000

# PowerPC store forms. Primary opcodes carry a 16-bit displacement; the indexed
# forms sit under primary 31 and are identified by their extended opcode.
STORE_PRIMARY = {0x90: "stw", 0x94: "stwu", 0x98: "stb",
                 0x9C: "stbu", 0xB0: "sth", 0xB4: "sthu"}
STORE_INDEXED = {151: "stwx", 183: "stwux", 215: "stbx",
                 247: "stbux", 407: "sthx", 439: "sthux"}


def describe_store(word):
    """Name the store form, or None if this instruction is not a store.

    NOPing a wrong address silently corrupts unrelated game code, so the
    instruction is checked before it is touched rather than after something
    starts behaving strangely.
    """
    primary = (word >> 24) & 0xFC
    if primary in STORE_PRIMARY:
        return STORE_PRIMARY[primary]
    if (word & 0xFC000000) == 0x7C000000:
        return STORE_INDEXED.get((word >> 1) & 0x3FF)
    return None


# Suppression has to be driven by a flag rather than by patching code from
# here, because DME writes bypass Dolphin's memory API and never invalidate the
# JIT block cache. A NOP written this way sits in RAM, reads back correctly,
# and has no effect whatsoever -- the JIT keeps running the block it compiled
# earlier. Verified directly: 0x805FD3F0 read 60000000 for two seconds while
# the struct it maintains carried on updating from the remote.
#
# Dolphin's Gecko handler runs as PPC code inside the game, so its writes are
# guest writes and do invalidate the cache. Hence this split: Dolphin owns the
# code patch, we own a plain data flag.
#
#   20002F00 00000001
#   045FD3F0 60000000
#   E0000000 80008000
#   20002F00 00000000
#   045FD3F0 901F0000
#   E0000000 80008000
#
# The flag address is not arbitrary, and the obvious-looking choice is wrong.
# Dolphin reserves 0x80001800-0x80003000 for Gecko support and lays it out as:
#
#   0x80001800-0x80002337  codehandler, executable PPC code
#   0x80002338             00D0C0DE 00D0C0DE, the code-list marker
#   0x80002340+            the enabled codes, ending F0000000
#   ...to 0x80002FFF       unused, zeroed at boot
#
# This flag first lived at 0x800021E0, which is inside the codehandler's own
# instruction stream -- it silently replaced a test instruction in a [test]
# [beq][mr] triple, and 0 and 1 are both illegal PPC opcodes. It appeared to
# work only because the enabled codes used types (04/20/E0) that never reach
# that path; anything that did execute it would crash somewhere unrelated.
# Verified by dumping the region live, which is the only way to see it: the
# flag reads back exactly as written either way.
#
# 0x80002F00 sits in the zeroed tail past the code list, roughly 187 code lines
# clear of it, in a region the game itself never touches.
SUPPRESS_FLAG = 0x80002F00
SUPPRESS_ON = 1
SUPPRESS_OFF = 0
# How long to wait for Dolphin's code handler to act on the flag. It runs once
# per frame, so a few frames is generous.
FLAG_TIMEOUT_S = 0.5


class FlagSuppress:
    """Ask Dolphin's Gecko code to NOP the held store, and confirm it did.

    The confirmation is the point. Without it a missing Gecko code looks
    exactly like every other failure we hit on the way here -- presses vanish,
    nothing moves, and there is no way to tell an uninstalled code from a wrong
    address or a bad dwell.
    """

    def __init__(self, dme, flag=SUPPRESS_FLAG, store=STORE_HELD):
        self.dme = dme
        self.flag = flag
        self.store = store

    def _wait_for(self, expected):
        deadline = time.perf_counter() + FLAG_TIMEOUT_S
        while time.perf_counter() < deadline:
            if int.from_bytes(self.dme.read_bytes(self.store, 4), "big") == expected:
                return True
            time.sleep(0.005)
        return False

    def __enter__(self):
        self.dme.write_word(self.flag, SUPPRESS_ON)
        if not self._wait_for(NOP):
            self.dme.write_word(self.flag, SUPPRESS_OFF)
            current = int.from_bytes(self.dme.read_bytes(self.store, 4), "big")
            raise SystemExit(
                f"Set the flag at 0x{self.flag:08X} but 0x{self.store:08X} still "
                f"reads {current:08X} instead of {NOP:08X}.\n"
                "Enable cheats in Dolphin and enable the Input Suppression "
                "code in this game's Properties > Gecko Codes, then restart "
                "the game. If the code is missing, see SUPPRESS_FLAG in "
                "this file for its six lines."
            )
        print(f"  suppression on  (0x{self.store:08X} -> NOP via Gecko)")
        return self

    def __exit__(self, *exc):
        self.dme.write_word(self.flag, SUPPRESS_OFF)
        if self._wait_for(0x901F0000):
            print(f"  suppression off (0x{self.store:08X} restored)")
        else:
            print(f"  WARNING: 0x{self.store:08X} did not return to 901F0000. "
                  "Your remote may be inert until the flag clears.")
        return False


class SuppressDecode:
    """NOP the store(s) that maintain the input struct, for one run.

    Without this the game rewrites `pressed` every frame from the real remote,
    microseconds before reading it, so injected presses land at random. With it
    the field holds whatever we put there and timing becomes ours to control.

    The real remote goes inert for the duration, which is what we want -- this
    wraps menu navigation, where human input would only interfere. Restoring
    happens in __exit__ so a crash or Ctrl-C cannot leave the remote dead,
    which would look like broken hardware and be miserable to debug.
    """

    def __init__(self, dme, instructions=(STORE_PRESSED,)):
        self.dme = dme
        self.instructions = tuple(instructions)
        self.originals = {}

    def __enter__(self):
        for address in self.instructions:
            try:
                word = int.from_bytes(self.dme.read_bytes(address, 4), "big")
            except RuntimeError:
                self.__exit__()
                raise SystemExit(
                    f"0x{address:08X} is not readable. Expected a code address "
                    "in MEM1 (0x80000000-0x817FFFFF)."
                )
            form = describe_store(word)
            if form is None:
                self.__exit__()
                raise SystemExit(
                    f"0x{address:08X} holds {word:08X}, which is not a store "
                    "instruction. If the game has been rebuilt or this is a "
                    "different region, re-run the write breakpoint on "
                    f"0x{PRESSED_WORD:08X}."
                )
            self.originals[address] = word
            self.dme.write_word(address, NOP)
            print(f"  suppressed {form} at 0x{address:08X} ({word:08X} -> NOP)")
        return self

    def __exit__(self, *exc):
        for address, word in self.originals.items():
            self.dme.write_word(address, word)
            print(f"  restored 0x{address:08X} -> {word:08X}")
        self.originals.clear()
        return False


class WiimoteInput:
    """One controller port's input word, driven by writing it.

    `port` selects which struct to write; the four bases are PORT_STRUCTS, an
    array of stride 0x538. This matters because MSS's team-select screens are
    not a player 1 affair: P2 has to press A to join, pick their side and draft
    their own roster, and none of that happens if only port 1 is ever written.

    Suppression is deliberately NOT per-port. The store being NOPed is
    `stw r0, 0(r31)`, which takes its target in a register, so one Gecko code
    covers every port the routine services -- see FlagSuppress. That is also
    why a second port costs nothing to add here: the hard part was already
    done, and only the base address changes.
    """

    def __init__(self, dme, port=1, field="held",
                 hold_ms=DEFAULT_HOLD_MS, gap_ms=DEFAULT_GAP_MS):
        self.dme = dme
        self.port = port
        self.field = field
        self.base = struct_for_port(port)
        self.words = words_for(self.base)
        if field not in self.words:
            raise ValueError(f"Unknown field {field!r}; expected one of {sorted(self.words)}")
        self.address = self.words[field]
        self.hold_ms = hold_ms
        self.gap_ms = gap_ms
        # Buttons held down across other presses -- see holding(). Every write
        # ORs this in, and every release falls back to it rather than to zero.
        self._base = 0

    def _mask_for(self, names):
        mask = 0
        for name in names:
            try:
                mask |= BUTTONS[name.lower()]
            except KeyError:
                raise ValueError(
                    f"Unknown button {name!r}. Known: {', '.join(sorted(BUTTONS))}"
                )
        return mask

    def hold(self, mask, hold_ms=None):
        """Raise `mask` for the dwell, then clear it.

        Written as a full word to match the game's own `stw`: buttons occupy
        the low halfword and the high half stays zero. Clearing afterwards is
        not tidiness -- with the store suppressed a value left up would be read
        again on every subsequent frame, repeating the press indefinitely.
        """
        duration = (self.hold_ms if hold_ms is None else hold_ms) / 1000.0
        self.dme.write_word(self.address, (mask | self._base) & 0xFFFF)
        if duration > 0:
            deadline = time.perf_counter() + duration
            while time.perf_counter() < deadline:
                pass
        self.dme.write_word(self.address, self._base & 0xFFFF)
        time.sleep(self.gap_ms / 1000.0)

    def press(self, name, hold_ms=None):
        self.hold(self._mask_for([name]), hold_ms)

    def combo(self, *names, hold_ms=None):
        """Press several buttons as one chord, e.g. Minus+A to start a game."""
        self.hold(self._mask_for(names), hold_ms)

    @contextlib.contextmanager
    def holding(self, *names):
        """Keep `names` down while the body runs.

        main.py's startGame held Minus down across a full press and release of
        A, and that shape is not the same as writing both bits for one frame:
        a menu that edge-detects A while merely sampling Minus would see the A
        edge with only half a frame of Minus context. Preserving the original
        shape costs nothing and removes the question.

        The button is released in `finally`, so an exception mid-chord cannot
        leave a bit stuck down -- which, with the store suppressed, would read
        as permanently held and jam the menu.
        """
        previous = self._base
        self._base = previous | self._mask_for(names)
        self.dme.write_word(self.address, self._base & 0xFFFF)
        try:
            yield self
        finally:
            self._base = previous
            self.dme.write_word(self.address, self._base & 0xFFFF)

    def execute(self, instructions):
        """Replay a main.py navigation string. 'w' waits, the rest are presses."""
        for token in instructions:
            if token == "w":
                time.sleep(WAIT_SECONDS)
                continue
            try:
                self.press(INSTRUCTIONS[token])
            except KeyError:
                raise ValueError(f"Unknown instruction {token!r} in {instructions!r}")

    def verify(self):
        """Check the struct looks like itself before writing into it.

        All three words must read zero with the remote untouched. A non-zero
        reading means either a button is genuinely held, or the struct has
        moved and we are about to write over something else -- which would fail
        silently and destructively, so it is worth three reads to rule out.

        Ports 3 and 4 were never confirmed by their own differential scan, only
        predicted from the stride, so a clear reading there proves less than it
        does on ports 1 and 2 -- unused memory reads zero too.
        """
        values = {name: int.from_bytes(self.dme.read_bytes(addr, 4), "big")
                  for name, addr in self.words.items()}
        rendered = "  ".join(f"{n}=0x{v:08X}" for n, v in values.items())
        if not any(values.values()):
            return True, (f"port {self.port} input struct at 0x{self.base:08X} "
                          f"clear: {rendered}")
        buttons = values["held"] & 0xFFFF
        known = [n for n, bit in BUTTONS.items() if buttons & bit]
        if known:
            return True, (f"{rendered}\n  ({'+'.join(known)} held -- "
                          "release the remote and retry)")
        return False, (f"{rendered}\n  Not a button pattern. The struct may have "
                       "moved; re-run the write breakpoint.")


def parse_script(text, extra=()):
    """Turn "1:awa 2:a w 2:rra" into [(port, token), ...].

    Whitespace-separated groups. A "N:" prefix switches to port N and stays
    there until the next prefix, so a long run on one port does not need
    repeating. The characters after it are execute()'s alphabet plus 'w'.
    """
    steps = []
    port = 1
    for group in text.split():
        if ":" in group:
            prefix, _, group = group.partition(":")
            try:
                port = int(prefix)
            except ValueError:
                raise SystemExit(f"{prefix!r} in {text!r} is not a port number.")
            if port not in PORT_STRUCTS:
                raise SystemExit(f"Port {port} is not one of {sorted(PORT_STRUCTS)}.")
        for token in group:
            if (token not in WAITS and token not in INSTRUCTIONS
                    and token not in CHORDS and token not in extra):
                raise SystemExit(
                    f"Unknown instruction {token!r} in {text!r}. Known: "
                    f"{''.join(sorted(INSTRUCTIONS))}, "
                    f"{''.join(sorted(CHORDS))} for chords, and "
                    f"{''.join(sorted(WAITS))} for waits."
                )
            steps.append((port, token))
    return steps


def run_script(dme, text, hold_ms, gap_ms, step=False):
    """Drive several ports from one sequence.

    MSS's team-select screens need two players, and alternating one-port
    commands to work out a cursor path is slow enough to lose your place. This
    keeps both remotes in one line: "1:a 2:a" is P1 then P2 pressing A.

    --step pauses before each press so a blind menu can be mapped one press at
    a time, which is the only way to build these sequences -- there is nothing
    to read back that says where a cursor ended up. Note the real remotes stay
    inert for the whole run, pauses included, because suppression is on.
    """
    steps = parse_script(text)
    pads = {}
    print(f"{len(steps)} step(s) across port(s) "
          f"{', '.join(str(p) for p in sorted({p for p, _ in steps}))}.")
    for index, (port, token) in enumerate(steps, 1):
        if step:
            try:
                input(f"  [{index}/{len(steps)}] port {port} {token!r} -- Enter to send: ")
            except (EOFError, KeyboardInterrupt):
                print("\n  (stopped)")
                return 0
        if token in WAITS:
            time.sleep(WAITS[token])
            print(f"  [{index}/{len(steps)}] wait {WAITS[token]}s")
            continue
        pad = pads.get(port)
        if pad is None:
            pad = pads[port] = WiimoteInput(dme, port=port, field="held",
                                            hold_ms=hold_ms, gap_ms=gap_ms)
        if token in CHORDS:
            hold, tap = CHORDS[token]
            with pad.holding(hold):
                pad.press(tap)
        else:
            pad.press(INSTRUCTIONS[token])
        if not step:
            print(f"  [{index}/{len(steps)}] port {port}: {token}")
    return 0


def prompt(message):
    try:
        input(message)
    except (EOFError, KeyboardInterrupt):
        raise SystemExit("\nAborted.")


def calibrate(pad, sequence="lrlr"):
    """Walk hold values around one frame so the good one can be seen.

    There is no way to read the cursor back out, so this cannot self-score --
    it sends a known number of presses at each setting and you count.
    """
    presses = sum(1 for token in sequence if token != "w")
    print(f"Sending {presses} presses ({sequence!r}) at each hold value.")
    print("A clean setting moves the cursor exactly once per press and ends")
    print("where it started.\n")
    original = pad.hold_ms
    try:
        for hold in CALIBRATION_HOLDS:
            prompt(f"  Enter to try hold={hold:.0f}ms... ")
            pad.hold_ms = hold
            pad.execute(sequence)
            print(f"    sent {presses} presses at {hold:.0f}ms\n")
    finally:
        pad.hold_ms = original
    return 0


# Every address the differential scan found carrying the button bits. They are
# not all the same struct: 0x80784CDA is the low halfword of this struct's
# `held`, while the 0x80787xxx group is 4-byte aligned and so cannot be, which
# is the first clue that more than one input layout is in play.
KNOWN_COPIES = [0x80784CDA, 0x80784DE8, 0x807872A0,
                0x80787300, 0x80787360, 0x81317BB0]


def diagnose(dme, seconds=20.0):
    """Suppress the held store, then see what the real remote can still move.

    Writing `held` unsuppressed moved the cursor about a quarter of the time.
    Suppressing the store that maintains it and writing the same value moved
    nothing at all -- which is backwards, unless NOPing that instruction also
    froze whatever the menu really reads. `stw r0, 0(r31)` takes its target in
    a register, so one NOP disables the routine for every struct it services.

    If the remote still drives the cursor here, suppression is not the problem
    and we are writing the wrong struct. If the remote goes dead too, the NOP
    is too blunt and has to be made conditional on r31.
    """
    print(f"Suppressing the held store for {seconds:.0f}s.")
    print("Use the REAL remote: press buttons AND watch whether the cursor moves.\n")
    with SuppressDecode(dme, (STORE_HELD,)):
        seen = {address: set() for address in KNOWN_COPIES}
        deadline = time.time() + seconds
        try:
            while time.time() < deadline:
                for address in KNOWN_COPIES:
                    value = int.from_bytes(dme.read_bytes(address, 2), "big")
                    if value:
                        seen[address].add(value)
                time.sleep(0.002)
        except KeyboardInterrupt:
            print("  (stopped early)")

    print("\nStill changing while suppressed:\n")
    live = []
    for address in KNOWN_COPIES:
        values = sorted(seen[address])
        if values:
            live.append(address)
            print(f"  0x{address:08X}  {' '.join(f'0x{v:04X}' for v in values)}")
        else:
            print(f"  0x{address:08X}  frozen")

    print()
    if not live:
        print("Everything froze -- the NOP disabled the routine for every struct")
        print("it services. It must be made conditional on r31 instead.")
    else:
        print("These stayed live, so the NOP is narrower than feared.")
        print("If the cursor still moved, the menu reads one of the live ones")
        print("and that is what we should be writing.")
    return 0


def hook():
    import dolphin_memory_engine as dme

    dme.hook()
    if not dme.is_hooked():
        raise SystemExit("Could not hook Dolphin. Start Dolphin, load MSS, re-run.")
    return dme


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, choices=(1, 2, 3, 4), default=1,
                        help="which controller port to write (default: 1). Port 2 "
                             "is what P2 needs to join at the captain screen.")
    parser.add_argument("--target", choices=sorted(TARGETS), default="held",
                        help="which word to write (default: held -- these menus "
                             "read it and do their own edge detection)")
    parser.add_argument("--sequence", help="instruction string, e.g. lrlr")
    parser.add_argument("--script",
                        help='multi-port sequence, e.g. "1:awa 2:a w 2:rra". '
                             'A "N:" prefix switches port and sticks until the '
                             "next one. This is the flag for working out the "
                             "two-player menus.")
    parser.add_argument("--step", action="store_true",
                        help="with --script, pause before each press so a blind "
                             "menu can be mapped one press at a time")
    parser.add_argument("--press", nargs="+",
                        help="button name(s); several are sent as one chord")
    parser.add_argument("--hold-ms", type=float, default=DEFAULT_HOLD_MS)
    parser.add_argument("--gap-ms", type=float, default=DEFAULT_GAP_MS)
    parser.add_argument("--verify", action="store_true",
                        help="sanity-check the struct and exit")
    parser.add_argument("--calibrate", action="store_true",
                        help="sweep hold values around one frame")
    parser.add_argument("--suppress", action="store_true",
                        help="NOP the store maintaining --target for the run")
    parser.add_argument("--suppress-all", action="store_true",
                        help="NOP all three stores, freezing the whole struct")
    parser.add_argument("--diagnose", action="store_true",
                        help="suppress the held store and watch every known "
                             "copy while you use the real remote")
    parser.add_argument("--seconds", type=float, default=20.0)
    args = parser.parse_args()

    dme = hook()
    pad = WiimoteInput(dme, port=args.port, field=args.target,
                       hold_ms=args.hold_ms, gap_ms=args.gap_ms)

    ok, message = pad.verify()
    print(message)
    if not ok:
        return 1
    if args.verify:
        return 0

    if args.diagnose:
        return diagnose(dme, args.seconds)

    if not (args.calibrate or args.press or args.sequence or args.script):
        parser.error("give --sequence, --script, --press, --calibrate, or --verify")

    if args.suppress_all:
        guard = SuppressDecode(dme, (STORE_HELD, STORE_PRESSED, STORE_RELEASED))
    elif args.suppress:
        guard = FlagSuppress(dme, store=TARGET_STORES[args.target])
    else:
        guard = contextlib.nullcontext()

    with guard:
        if args.script:
            return run_script(dme, args.script, args.hold_ms, args.gap_ms, args.step)
        if args.calibrate:
            return calibrate(pad, args.sequence or "lrlr")
        if args.press:
            pad.combo(*args.press)
            print(f"Sent {'+'.join(args.press)} to port {args.port} {args.target}.")
        else:
            print(f"Replaying {args.sequence!r} into port {args.port} "
                  f"{args.target} ({args.hold_ms:.0f}ms hold, "
                  f"{args.gap_ms:.0f}ms gap)...")
            pad.execute(args.sequence)
            print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
