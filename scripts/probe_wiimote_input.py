"""Locate MSS's Wii Remote button state in memory, then try driving it.

Background: MSS-AutoTeam navigates the exhibition menus with global keyboard
presses, which only reach the game because Dolphin's Wii Remote 1 is an
*emulated* controller bound to a keyboard. With a **real** Wii Remote on port 1
there is no input-mapping layer at all -- Dolphin hands the game the remote's
decoded reports directly -- so nothing bound outside the game can reach it, and
exhibition mode only accepts player 1. Keyboard, vgamepad, and DSU are all dead
ends by construction.

What is left is to stop feeding input *into* Dolphin and instead write the
button state the game reads. That needs an address, and this probe finds it.

Two-stage ladder, cheapest first:

    python scripts/probe_wiimote_input.py find
        Guided differential scan. You hold one button at a time; it keeps only
        the halfwords that are zero at rest and become exactly one valid WPAD
        bit while held. Four or five rounds usually leaves a handful.

    python scripts/probe_wiimote_input.py watch --address 0x8XXXXXXX
        Live-print one candidate so you can confirm by eye that it tracks the
        remote, and read off the bit for every button in a few seconds.

    python scripts/probe_wiimote_input.py poke --address 0x8XXXXXXX --mask 0x0800
        Write the bit back and see whether the menu cursor moves.

That last step is the whole question. The real remote's decode overwrites the
buffer every frame, so poking is a race -- we write in a tight loop for the
hold duration and hope the game's read lands on one of our writes. If the
cursor moves, the eight press_* methods in main.py become pokes and no PPC
assembly is needed. If it is too flaky, we escalate to hooking the read site
the way generate_whodeyy_code() already hooks 0x8006AED4.

The bit layout is NOT assumed. Whether the game reads raw WPAD or a KPAD status
(which rotates the D-pad for a sideways remote) changes which bit means "up",
and guessing wrong here is the kind of silent failure that costs a day.

NOTE on why `find` probes the D-pad and not A/B: the button word is written
every frame by the input decode whether or not the menu reacts, so the scan
never needs a visible response. What it cannot tolerate is the screen changing
between the held and released snapshots -- a scene transition reallocates
memory and quietly filters out the true candidate, which shows up as a round
collapsing to zero. The D-pad moves a cursor at worst and never leaves the
screen; A and B enter and back out of menus. Four directions is enough to
narrow the field, and `watch` reads off A/B safely afterwards.
"""
from __future__ import annotations

import argparse
import sys
import time

import numpy as np

# Wii physical memory as Dolphin exposes it. MEM1 holds the game's own BSS and
# is where the input buffers almost always live; MEM2 is scanned only on
# request because it triples the pass time for a low-probability payoff.
MEM1 = (0x80000000, 0x01800000)
MEM2 = (0x90000000, 0x04000000)
CHUNK = 0x100000

# The 11 bits WPAD actually defines. The five gaps (0x0020/0x0040/0x0080/
# 0x2000/0x4000) are reserved and never set, so requiring a press to land on a
# defined bit throws out a large amount of ordinary counter noise without
# assuming which button owns which bit.
VALID_BITS = [0x0001, 0x0002, 0x0004, 0x0008, 0x0010,
              0x0100, 0x0200, 0x0400, 0x0800, 0x1000, 0x8000]
VALID_MASK = 0
for _bit in VALID_BITS:
    VALID_MASK |= _bit

# Buttons the automation needs. main.py drives menus with exactly these.
PROBE_BUTTONS = ["A", "B", "UP", "DOWN", "LEFT", "RIGHT", "PLUS", "MINUS"]


def parse_address(token):
    """Accept 0x-prefixed hex, and recover PowerShell-mangled addresses.

    PowerShell evaluates a bare `0xA,0xB` token as an array of Int32s and
    passes it on as decimal, so 0x80784CDA arrives as -2139599654. Separating
    addresses with spaces rather than commas avoids the whole problem, but a
    stray negative is worth decoding rather than rejecting.
    """
    token = token.strip()
    try:
        if token.startswith(("0x", "0X")):
            return int(token, 16)
        value = int(token, 10)
    except ValueError:
        raise SystemExit(
            f"Cannot read {token!r} as an address. Use 0x-prefixed hex, "
            "separated by SPACES (PowerShell mangles comma-separated hex)."
        )
    if value < 0:
        return value & 0xFFFFFFFF
    return value


def hook():
    import dolphin_memory_engine as dme

    dme.hook()
    if not dme.is_hooked():
        raise SystemExit(
            "Could not hook Dolphin. Start Dolphin, load MSS, then re-run."
        )
    return dme


def read_region(dme, base, size):
    """Read one region as big-endian uint16s, chunked to keep reads sane."""
    out = bytearray()
    for offset in range(0, size, CHUNK):
        out += dme.read_bytes(base + offset, min(CHUNK, size - offset))
    return np.frombuffer(bytes(out), dtype=">u2")


def snapshot(dme, regions):
    return {base: read_region(dme, base, size) for base, size in regions}


def prompt(message):
    try:
        input(message)
    except (EOFError, KeyboardInterrupt):
        raise SystemExit("\nAborted.")


def find(dme, regions, buttons):
    print("Point the remote at the screen and leave every button alone.")
    prompt("  Press Enter to take the resting snapshot... ")
    idle = snapshot(dme, regions)

    # Candidates are carried as index arrays per region. Start from "zero at
    # rest", which every real held-button word satisfies.
    candidates = {base: np.flatnonzero(words == 0) for base, words in idle.items()}
    total = sum(len(v) for v in candidates.values())
    print(f"  {total:,} halfwords are zero at rest.\n")

    discovered = {}

    for button in buttons:
        prompt(f"Hold {button} down -- keep holding -- then press Enter... ")
        held = snapshot(dme, regions)

        surviving = {}
        for base, idx in candidates.items():
            if len(idx) == 0:
                continue
            values = held[base][idx]
            # Exactly one bit set, and a bit WPAD actually defines.
            single = (values != 0) & ((values & (values - 1)) == 0)
            keep = idx[single & ((values & VALID_MASK) != 0)]
            if len(keep):
                surviving[base] = keep
        candidates = surviving

        prompt(f"  Release {button} and press Enter... ")
        rest = snapshot(dme, regions)

        # A real held-state word must fall back to zero on release. Anything
        # that latches is a counter or an edge-triggered flag, not the state
        # the menu code reads each frame.
        surviving = {}
        for base, idx in candidates.items():
            keep = idx[rest[base][idx] == 0]
            if len(keep):
                surviving[base] = keep
        candidates = surviving

        # Record which bit this button set, per surviving address.
        for base, idx in candidates.items():
            for i in idx:
                discovered.setdefault((base, int(i)), {})[button] = int(held[base][i])

        total = sum(len(v) for v in candidates.values())
        print(f"  {button}: {total:,} candidates remain.\n")
        if total == 0:
            print("Nothing survived. The game may buffer input somewhere this")
            print("scan does not cover -- try again with --include-mem2.")
            return 1

    print("=" * 62)
    print("Surviving addresses and the bit each button set:\n")
    shown = 0
    for base, idx in candidates.items():
        for i in idx:
            address = base + int(i) * 2
            bits = discovered.get((base, int(i)), {})
            # A genuine button word gives every button a DIFFERENT bit.
            distinct = len(set(bits.values())) == len(bits)
            flag = "" if distinct else "   <- reuses a bit, probably not it"
            mapping = "  ".join(f"{b}=0x{v:04X}" for b, v in bits.items())
            print(f"  0x{address:08X}  {mapping}{flag}")
            shown += 1
            if shown >= 40:
                print("  ... (truncated)")
                break
        if shown >= 40:
            break

    print("\nNext: confirm one by eye, then try to drive it.")
    print("  python scripts/probe_wiimote_input.py watch --address 0x........")
    print("  python scripts/probe_wiimote_input.py poke  --address 0x........ --mask 0x....")
    return 0


def watch(dme, addresses, seconds):
    """Track several candidates at once and print a row whenever any changes.

    Watching one address at a time cannot tell a live word from a stale mirror,
    because both look identical in isolation. Side by side the difference is
    obvious: candidates that move together are copies of one source, and any
    that lag or stay flat are downstream buffers we must not write to.
    """
    print(f"Watching {len(addresses)} addresses for {seconds:.0f}s.")
    print("Press A, then B, then Plus, then Minus -- pausing between each.\n")
    print("  " + "  ".join(f"0x{a:08X}" for a in addresses))
    print("  " + "  ".join("-" * 10 for _ in addresses))

    seen = {a: set() for a in addresses}
    last = None
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            values = [int.from_bytes(dme.read_bytes(a, 2), "big") for a in addresses]
            if values != last:
                last = values
                for address, value in zip(addresses, values):
                    if value:
                        seen[address].add(value)
                if any(values):
                    print("  " + "  ".join(f"    0x{v:04X}" for v in values))
            time.sleep(0.002)
    except KeyboardInterrupt:
        # Stopping early is the normal way to end a watch once you have seen
        # enough, so summarise what was collected rather than dumping a trace.
        print("\n  (stopped early)")

    print("\n" + "=" * 62)
    print("Distinct non-zero values per address:\n")
    for address in addresses:
        values = sorted(seen[address])
        rendered = " ".join(f"0x{v:04X}" for v in values) if values else "(never changed)"
        print(f"  0x{address:08X}  {rendered}")

    live = [a for a in addresses if seen[a]]
    if not live:
        print("\nNone of these moved. Wrong group, or the game re-buffers input.")
        return 1
    best = max(live, key=lambda a: len(seen[a]))
    print(f"\nMost responsive: 0x{best:08X} ({len(seen[best])} distinct values).")
    print("Poke the one that saw every button you pressed:")
    print(f"  python scripts/probe_wiimote_input.py poke --address 0x{best:08X} --mask 0x0800")
    return 0


def relay(dme, write_address, read_address, mask, hold_ms):
    """Write one address, watch another, and report how stably it follows.

    Poking the word the game reads is a race: the remote's decode rewrites it
    every frame, so the value flickers to zero a few times per hold and each
    recovery is another rising edge. That is what makes a single press land as
    one move, two, or none.

    Writing further upstream should remove the race entirely -- if the game's
    own per-frame copy propagates our value downstream, the word it reads is
    written by the game itself and never flickers. This measures whether that
    propagation actually happens, without needing anyone to count cursor moves.

    Use a mask no menu reacts to (0x0100, the Two button) so this stays a pure
    memory measurement and does not move anything on screen.
    """
    print(f"Writing 0x{mask:04X} to 0x{write_address:08X} for {hold_ms:.0f}ms,")
    print(f"sampling 0x{read_address:08X}.\n")

    payload = mask.to_bytes(2, "big")
    observed = {}
    deadline = time.perf_counter() + hold_ms / 1000.0
    while time.perf_counter() < deadline:
        dme.write_bytes(write_address, payload)
        value = int.from_bytes(dme.read_bytes(read_address, 2), "big")
        observed[value] = observed.get(value, 0) + 1
    dme.write_bytes(write_address, b"\x00\x00")

    total = sum(observed.values())
    for value, count in sorted(observed.items(), key=lambda kv: -kv[1]):
        share = 100.0 * count / total
        note = "  <- our value" if value == mask else ""
        print(f"  0x{value:04X}  {share:5.1f}%  ({count}){note}")

    followed = 100.0 * observed.get(mask, 0) / total
    print(f"\n0x{read_address:08X} held our value {followed:.1f}% of {total} samples.")
    if followed >= 99.5:
        print("Rock solid -- writing here is flicker-free, so presses should be")
        print("exactly one edge each. Point mss_input.py at this write address.")
    elif followed >= 50.0:
        print("Follows, but still flickering. Better than racing the read site")
        print("directly, though not clean enough to trust for long sequences.")
    elif followed > 0.0:
        print("Barely propagates. This is not the source the copy comes from.")
    else:
        print("No propagation at all -- these two are written independently,")
        print("so upstream writes cannot help and we hook the read site.")
    return 0


def press_once(dme, addresses, mask, hold_ms):
    """Hold `mask` across `addresses` for hold_ms, then release to zero.

    Returns (write cycles, percentage of read-backs that still held the mask).
    """
    zero = b"\x00\x00"
    payload = mask.to_bytes(2, "big")
    deadline = time.perf_counter() + hold_ms / 1000.0
    cycles = 0
    survived = 0
    while time.perf_counter() < deadline:
        for address in addresses:
            dme.write_bytes(address, payload)
        if int.from_bytes(dme.read_bytes(addresses[0], 2), "big") == mask:
            survived += 1
        cycles += 1
    for address in addresses:
        dme.write_bytes(address, zero)
    return cycles, (100.0 * survived / cycles) if cycles else 0.0


def sweep(dme, addresses, mask, hold_ms, repeats):
    """Poke each candidate alone, so a reaction attributes to one address.

    Writing every candidate at once can silently cancel the press. Menus act on
    a button-down edge -- `current & ~previous` -- and some of these addresses
    are previous-frame copies of the others. Setting both sides of that
    subtraction to the same value in the same instant means no edge, so the
    press disappears no matter how well we hold the buffer.
    """
    print(f"Poking {len(addresses)} candidates one at a time with 0x{mask:04X}.")
    print("Watch the screen after each. Between steps you can back out of")
    print("anything a press opened -- attribution is what matters here.\n")
    for address in addresses:
        prompt(f"  Enter to poke 0x{address:08X} alone... ")
        for _ in range(repeats):
            cycles, held = press_once(dme, [address], mask, hold_ms)
            time.sleep(0.12)
        print(f"    done -- {cycles} cycles, held {held:.0f}%\n")
    print("Whichever one moved something is the word the game reads.")
    print("If none did, the read site is upstream of every candidate and we")
    print("hook it instead -- see the escalation note in the module docstring.")
    return 0


def poke(dme, addresses, mask, hold_ms, repeats, gap_ms):
    """Fight the remote's per-frame decode by writing in a tight loop.

    No sleep inside the hold window on purpose: the decode overwrites these
    buffers constantly, so the only way the game's read lands on our value is
    to keep restoring it. If this proves too unreliable in the menus, that is
    the signal to hook the read site instead of racing it.

    Writing every candidate at once answers "is poking viable at all" in one
    run; narrowing to the single address that matters is a later, easier
    question. The read-back percentage separates the two ways this can fail:
    a low number means the decode is winning and we never had the buffer, a
    high number with no cursor movement means we held it and the game simply
    reads its input somewhere else.
    """
    for n in range(repeats):
        cycles, held = press_once(dme, addresses, mask, hold_ms)
        print(f"  press {n + 1}/{repeats}: 0x{mask:04X} into {len(addresses)} "
              f"address(es) for {hold_ms:.0f}ms -- {cycles} cycles, "
              f"value survived {held:.0f}% of read-backs")
        time.sleep(gap_ms / 1000.0)

    print("\nDid the cursor move?")
    print("  yes            -> poking works; the press_* methods become pokes")
    print("  only sometimes -> raise --hold-ms")
    print("  no, but survived% was high -> we hold the buffer and the game")
    print("                    reads elsewhere; try another candidate")
    print("  no, and survived% was low  -> the decode outruns us; hook the")
    print("                    read site instead of racing it")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p_find = sub.add_parser("find", help="guided differential scan")
    p_find.add_argument("--include-mem2", action="store_true",
                        help="also scan MEM2 (3x slower)")
    p_find.add_argument("--buttons", default="UP,DOWN,LEFT,RIGHT",
                        help="comma-separated probe order "
                             "(default: UP,DOWN,LEFT,RIGHT -- see NOTE in module docstring)")

    p_watch = sub.add_parser("watch", help="live-print candidates side by side")
    # nargs="+" as well as comma-splitting because PowerShell turns a bare
    # comma-separated token into an array and passes the elements as separate
    # arguments, which argparse then rejects for a single-value flag.
    p_watch.add_argument("--address", required=True, nargs="+",
                         help="one or more addresses, space- or comma-separated")
    p_watch.add_argument("--seconds", type=float, default=25.0)

    p_relay = sub.add_parser("relay", help="write one address, sample another")
    p_relay.add_argument("--write", required=True, help="upstream address to write")
    p_relay.add_argument("--read", required=True, help="downstream address to sample")
    p_relay.add_argument("--mask", default="0x0100",
                         help="default 0x0100 (Two) -- inert in menus")
    p_relay.add_argument("--hold-ms", type=float, default=300.0)

    p_sweep = sub.add_parser("sweep", help="poke each candidate alone, in turn")
    p_sweep.add_argument("--address", required=True, nargs="+",
                         help="candidates to test individually, space-separated")
    p_sweep.add_argument("--mask", required=True, help="the bit, e.g. 0x0800")
    p_sweep.add_argument("--hold-ms", type=float, default=50.0)
    p_sweep.add_argument("--repeats", type=int, default=2)

    p_poke = sub.add_parser("poke", help="write a button and see if it registers")
    p_poke.add_argument("--address", required=True, nargs="+",
                        help="one or more addresses, space-separated")
    p_poke.add_argument("--mask", required=True, help="the bit, e.g. 0x0800")
    p_poke.add_argument("--hold-ms", type=float, default=50.0)
    p_poke.add_argument("--repeats", type=int, default=3)
    p_poke.add_argument("--gap-ms", type=float, default=120.0)

    args = parser.parse_args()
    dme = hook()

    if args.command == "find":
        regions = [MEM1] + ([MEM2] if args.include_mem2 else [])
        buttons = [b.strip().upper() for b in args.buttons.split(",") if b.strip()]
        unknown = [b for b in buttons if b not in PROBE_BUTTONS]
        if unknown:
            raise SystemExit(f"Unknown button(s): {', '.join(unknown)}")
        return find(dme, regions, buttons)

    if args.command == "relay":
        return relay(dme, parse_address(args.write), parse_address(args.read),
                     int(args.mask, 16), args.hold_ms)

    addresses = [parse_address(token)
                 for chunk in args.address
                 for token in chunk.split(",") if token.strip()]

    if args.command == "watch":
        return watch(dme, addresses, args.seconds)

    if args.command == "sweep":
        return sweep(dme, addresses, int(args.mask, 16),
                     args.hold_ms, args.repeats)

    return poke(dme, addresses, int(args.mask, 16),
                args.hold_ms, args.repeats, args.gap_ms)


if __name__ == "__main__":
    sys.exit(main())
