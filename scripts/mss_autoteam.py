"""Apply a Sluggers-site lineup to Mario Super Sluggers' team-select menus.

This is MSS-AutoTeam's Formationizer with its two outside dependencies removed.

The keyboard layer is gone, replaced by scripts/mss_input.py -- see that file
for why. In short: main.py's press_a() worked because Dolphin's Wii Remote 1
was an *emulated* controller bound to k/l/a/d/w/s/e/q. With real remotes on all
four ports there is no mapping layer to press keys into, and MSS's exhibition
mode only listens to player 1, so the input has to be written into the game's
own state instead.

The Gecko code hook is gone too, and that one is a design choice rather than a
constraint. main.py places characters with generate_whodeyy_code(), which
assembles a Gecko code at runtime and branches game code into it. Two things
make that unattractive here:

  * It writes its generated code to 0x800021F0 and branches there. That
    address is not spare memory -- it is inside Dolphin's Gecko codehandler,
    which occupies 0x80001800-0x80002337 -- so the trick works by using the
    codehandler as a code cave and overwriting whatever it lands on. Fine in
    isolation, hostile to anything else using that region.
  * Patching code from dolphin-memory-engine does not work at all. DME writes
    bypass Dolphin's memory API and never invalidate the JIT block cache, so a
    branch written this way sits in RAM, reads back correctly, and is never
    executed.

main.py already contains the alternative: formation_code_rev() does the same
job with plain data writes through a pointer, needing no code patch. It is
unused and unverified upstream, and it turns out not to work: the address it
reads its pointer from, 0x806D121E, is not a pointer at all but a stretch of
0x01 filler in static data. It reads 0x01010101 on every screen, so the
validation below refused it every time, which is exactly what --stage
formation did.

The two block pointers it should have used are +0xC0 and +0xC4 on an object
the draft screen allocates; the derivation is in the comment above
OBJECT_AWAY_POINTER. That object is a virtual method's `this` and is reached
through a vtable, so there is no static address to read it from and it is
found by signature instead -- see find_formation_object(). The upshot is that
apply_formation() identifies the blocks by their contents before writing, and
--stage find-formation shows that search without writing anything.

Before running anything
-----------------------

Dolphin needs four Gecko codes enabled. Three are upstream's prerequisite,
documented only in main.py's GUI panel:

    040802b4 60000000
    040802b8 60000000
    0406aed8 48000b80

These are NOT the runtime code this file drops. The first two NOP a pair of
instructions at 0x800802B4/B8, which is what stops the game overwriting a
roster written from outside. The third is now understood rather than assumed:
it branches over eight `stb r6, N(r3)` instructions at 0x8006AEDC that blank
the fielding position of slots 1..8, so it is what keeps the positions written
here from being wiped. All three are still required. The fourth code is
mss_input.py's suppression pair; see SUPPRESS_FLAG there.

Where to start
--------------

--stage all and --stage nav begin at the MAIN MENU with the cursor already
hovering "Exhibition Mode". The navigation string opens with an A press, so it
acts on whatever is highlighted, and every move after it is relative with
nothing to read back -- starting one entry off desynchronises the entire run.

--stage finalize, --stage formation and --stage find-formation instead expect
a screen to be open already, reached however you like, because they only read
and write data. Which screen is not a matter of taste: the blocks the
formation stages write into belong to Select::COrderSelectTask, the BATTING
ORDER screen that follows the draft. Run them anywhere earlier and the search
correctly finds nothing, because the task owning the blocks does not exist
yet.

Getting there needs both players, since MSS's captain screen waits for P2 to
press A and join before anything downstream happens. P2's cursor path is not
worked out yet, which is what --p2-join is for -- it sends an instruction
string on the P2 port so a candidate sequence can be tried without editing
this file.

Usage:

    node scripts/export_mss_lineup.mjs --out lineup.json
    python scripts/mss_autoteam.py --lineup lineup.json --dry-run
    python scripts/mss_autoteam.py --lineup lineup.json

    python scripts/mss_autoteam.py --from-site            # exports, then applies
    python scripts/mss_autoteam.py --lineup lineup.json --stage find-formation
    python scripts/mss_autoteam.py --lineup lineup.json --stage formation

That second line is the whole run, and it no longer needs a --nav-preset:
brisk is the default now, having taken a game from the main menu to the first
pitch often enough to stop being the experiment. --nav-preset safe is the
slower path it was derived from, one flag away if a run ever desynchronises.

Most of the time, though, nothing here is what you run. scripts/mss_autogame.mjs
wraps it: pick a game from the site's schedule and it exports that game's
lineup, calls this file, waits for the first pitch, and starts the stat
tracker on the other side of it.

    node scripts/mss_autogame.mjs

The handoff itself is --wait-for-live, which blocks until the ball is sitting
at a pitch reset and then prints MSS_AUTOTEAM_MATCH_LIVE confirmed -- see
wait_for_match_live() for why that particular signal and not a timer, and why
a run that times out still hands off, as MSS_AUTOTEAM_MATCH_LIVE unconfirmed.

Working out P2's sequence, one press at a time, is mss_input.py's job:

    python scripts/mss_input.py --port 2 --press a --suppress
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mss_input import (  # noqa: E402
    CHORDS,
    FlagSuppress,
    INSTRUCTIONS,
    TARGET_STORES,
    WAITS,
    WiimoteInput,
    hook,
    parse_script,
)
from probe_ball_memory import (  # noqa: E402
    BALL_POINTER_SLOT,
    resolve_offset,
)

# main.py drove the menus with 50ms down plus 50ms up, i.e. one press every
# 100ms, and its navigation strings were tuned at that cadence. This file kept
# the 100ms but spends it differently: the hold is one clean frame at 17ms and
# the rest sits in the gap.
#
# The HOLD is not the part being tuned and should not be. One frame is what the
# game samples; shortening it is what would risk a press being missed outright.
# What moves is the dead time after the button is released, and a press costs
# MENU_HOLD_MS + MENU_GAP_MS end to end.
#
# This is the only knob that reaches the Mii grid's in-between presses. They
# emit no wait token at all, so they are made of this number and nothing else
# -- see MII_MOVE_WAIT. It is also the only knob here that is GLOBAL: every
# press in the run pays it, including the ones guarding a screen change, and
# the clearance a press gets before the next one is
#
#     MENU_HOLD_MS + MENU_GAP_MS + (the wait token after it, if any)
#
# Which is why the gap cannot be read as a Mii-grid setting. Walking it down:
#
#     100ms   press 117ms   verified end to end, repeatedly. main.py's cadence,
#                            and where this sits. Walking down from it and back
#                            up again is the whole of what is known below.
#      75ms   press  92ms   tried, not kept.
#      50ms   press  67ms   did not survive a run.
#
# So the walk down found nothing to take. That is a result rather than a dead
# end: it says the per-press cadence was already at its floor at 100ms, and
# that the time this file used to spend was in the WAIT TOKENS, not in the
# presses. Those are gone -- a Mii pick is 3.57s against the 9.67s it started
# at, all of it taken from waits and none from the gap. Reverting this constant
# does not give any of that back, and there is no reason to walk it down again
# without changing something else first.
#
# The suspect when one of these fails is NOT the Mii grid, or not only it. The
# captains-to-draft transition is the one wait in this file walked down to its
# floor by hand -- 3.3s landed the first draft press early, 3.5s cleared it --
# so its margin is under 200ms, and the gap is subtracted straight from it:
# 3.617s of clearance at a 100ms gap, 3.567s at 50ms, 3.592s at 75ms. Only the
# first of those was ever verified.
#
# If it is ever worth trying again, do the transition first and the gap second.
# Give that one wait its margin back with --nav-preset quick, THEN drop the
# gap; that separates the two failures, which currently confound each other and
# look nothing alike. A draft press landing early re-rolls a team; a swallowed
# press in the Mii grid puts a stranger on the field. --gap-ms overrides this
# number for one run, so neither needs editing to test.
MENU_HOLD_MS = 17.0
MENU_GAP_MS = 100.0
WAIT_SECONDS = 0.5
# Between one confirm screen and the next. Nothing reports that the next
# screen has arrived, so this is a guess with margin rather than a measurement.
START_SCREEN_GAP = 2.0

# Main menu to the batting order screen, in the two-port script syntax: "N:"
# selects a port and sticks, "w" waits, "n" is the ready chord.
#
# What makes this shorter than it could be is that almost nothing here has to
# be selected CORRECTLY. The stadium byte and the captain bytes both override
# after the fact -- proven by picking DK Jungle with the wrong captains and
# landing in Peach Ice Garden as Mario Fireballs vs Wario Muscles -- and the
# draft is thrown away wholesale, since every roster slot gets overwritten.
# So each screen only has to be *cleared*, not navigated. That removes every
# cursor move except the ones that are structural, and cursor moves are the
# part of a blind sequence that goes wrong.
NAV_SAFE = " ".join([
    # "W" marks a screen change, "w" a beat on one screen -- see WAITS.
    # Main menu: the cursor already sits on Exhibition.
    "1:a", "W",
    # Stadium select, P1 only. A zooms into the highlighted stadium and brings
    # up its Enter panel; A again enters. The cursor starts on Mario Stadium
    # and it is taken as-is. Entering loads the stadium, which is the longest
    # pause on the path.
    # "E" is the same 2.5s as "W" but named apart, because this transition is
    # slower than the two before it: at 0.7s the captain screen was not ready
    # and P2's join press landed early. The presets shorten it less than the
    # others rather than treating all transitions as interchangeable.
    "1:a", "W", "1:a", "E",
    # Captain select. P2 joins first: A opens "Pick a team to join", A again
    # takes the highlighted team. Then each player takes whatever captain is
    # under their cursor. Selecting both moves straight to the draft -- there
    # is no confirm step to clear, so the transition follows immediately.
    # Only the last press here changes screen. P2's first two -- opening "Pick
    # a team to join" and taking the team -- are panels on the SAME screen, so
    # they were being given a full screen-change wait for nothing. That was
    # 5 of the 10.5 seconds this segment used to spend.
    # "D" is the captains-to-draft change, the slowest on the path and the only
    # one that has ever desynchronised a run -- so it gets its own tier rather
    # than being a doubled "W" that every transform has to special-case.
    "2:a", "w", "2:a", "w", "1:a", "w", "2:a", "D",
    # Draft. Each player's cursor starts on their own Random button, so one A
    # each fills both teams. Then to Next: the column is
    #
    #     P1 Random / Next / Mii / P2 Random
    #
    # so P1 goes down one and P2 up two -- it is not symmetric.
    #
    # That column is not static, and the difference matters to anything that
    # counts presses through it. NEXT ONLY BECOMES PRESSABLE ONCE BOTH TEAMS
    # ARE FULL, so before the Random presses the column is really
    #
    #     P1 Random / Mii / P2 Random
    #
    # and P1 reaches Mii with ONE down, not two. Everything below runs after
    # Random, so it sees the four-entry column and the counts here are right;
    # a Mii has to be taken BEFORE Random (Random fills only empty slots), so
    # that path sees the three-entry one. P2 is unaffected either way -- Next
    # sits above Mii, so P2's Mii is one up from Random whatever is showing.
    #
    # An earlier version anchored every move against the top of the column
    # instead of counting from the start position. That was solving the wrong
    # problem. The counting version is correct; it only ever failed when the
    # waits were cut to 0.6, which let presses land mid-animation. Robustness
    # bought with twenty extra presses is not robustness, it is noise -- and it
    # visibly re-rolled the teams several times getting there.
    "1:a", "w", "2:a", "w", "w",
    "1:d", "w", "2:uu", "w",
    # No wait after the last press. What follows is apply_formation(), whose
    # scan already retries until the blocks appear -- so waiting here would be
    # paying twice for the same transition, once blind and once measured.
    "1:a", "w", "2:a",
])

# The reference path, at the waits it was first verified with end to end.
# Every faster preset is derived from this one rather than written out, so the
# PATH can never drift between them -- only the wait lengths do. It is no
# longer the default; see NAV_SCRIPT below. It stays the thing to fall back to,
# one flag away, when a faster preset misbehaves. Do not tune it in place:
# add a preset.


def _faster(script):
    """The same path with transitions taken optimistically.

    Derived from NAV_SAFE rather than written out, so the two can never drift
    into being different *paths* -- the only thing that varies is how long each
    screen change is given. A doubled transition collapses to one, since the
    doubling was margin rather than a second thing being waited on.
    """
    return " ".join({"W": "s", "E": "s", "D": "s"}.get(token, token)
                    for token in script.split())


NAV_FAST = _faster(NAV_SAFE)


def _quicker(script):
    """Shorten the transitions that have never failed; leave the one that has.

    A doubled "W W" marks the captains-to-draft change, the only transition
    that has ever desynchronised a run -- it is doubled precisely because of
    that. _faster() collapses it along with everything else, which is why fast
    breaks there. This keeps it and shortens the rest, which is where the time
    actually is anyway.
    """
    return " ".join({"W": "s", "E": "s"}.get(token, token)
                    for token in script.split())


NAV_QUICK = _quicker(NAV_SAFE)


def _brisk(script):
    """quick, with the screen changes and in-screen beats both tightened.

    Two observations from watching real runs drove this. The three presses from
    the main menu into captain select were the most obviously padded -- those
    transitions are short. And the draft screen's cursor moves were sitting on
    half-second gaps when a menu only needs a couple of frames to register one;
    each press already carries its own 100ms gap on top.

    The doubled captains-to-draft transition is left alone, as in _quicker. It
    is the only one that has ever desynchronised a run.
    """
    # "E" gets 1.2s where the plain transitions get 0.7s, and "D" comes down
    # from 5.0s to 3.5s, found by walking down: 2.5, 3.0, 3.1, 3.2 and 3.3 all
    # landed the first draft press slightly early. 3.5 is the first value that
    # clears it, so it sits near this transition's floor rather than above it. This transition really is slower
    # than the rest of the path, and 3.1 is close to its floor -- which is
    # worth knowing, because a value sitting right on the threshold has no
    # margin for a slow frame. Raise it first if a run ever desynchronises
    # here.
    return " ".join({"W": "t", "E": "s", "D": "T", "w": "."}.get(token, token)
                    for token in script.split())


NAV_BRISK = _brisk(NAV_SAFE)

# The default, as of the run that took a full game from the main menu to the
# first pitch with nothing typed in between:
#
#     python scripts/mss_autoteam.py --lineup lineup.json --stage all
#
# brisk earned that by repetition, not by being the fastest thing that once
# worked -- every wait it shortens is one that has never swallowed a press,
# and the one that has (captains to draft) it leaves alone. safe is still the
# reference it is derived from and is what --nav-preset safe restores, so the
# escape hatch costs one flag.
NAV_SCRIPT = NAV_BRISK


# Game-state addresses, all from main.py's finalize() and formation_code_rev().
STADIUM_BYTE = 0x811F769D
DAY_NIGHT_BYTES = (0x811F769E, 0x811F769F)
CAPTAIN_AWAY_BYTE = 0x811F76AC
CAPTAIN_HOME_BYTE = 0x811F76AD
RULES_BASE = 0x80794328  # innings, stars, items, mercy -- one byte each

# Two of the four transitions do not have to be timed at all, because the game
# announces them. It writes the committed stadium to STADIUM_BYTE when the
# stadium screen is accepted, and a captain byte when each captain is taken --
# both watched live earlier. So the run can poison those bytes with a value the
# game will overwrite, fire the press, and continue the moment the write lands.
#
# That is strictly better than any measurement. A measured constant is only
# right on the machine and build it was measured on; waiting for the write is
# right everywhere, and it reports what the delay actually was, so the numbers
# come out of ordinary runs for free.
#
# The poison values are valid indices (stadiums are 0..8, captains 0..11), so
# nothing reads an out-of-range value if the game touches them first. And a
# sync that times out simply proceeds, having waited SYNC_TIMEOUT -- so the
# worst case is the blind behaviour it replaces, never worse.
SYNC_TIMEOUT = 6.0
SYNC_POISON = {STADIUM_BYTE: 8, CAPTAIN_AWAY_BYTE: 11, CAPTAIN_HOME_BYTE: 11}
SYNC_TOKENS = {
    "S": ("stadium accepted", (STADIUM_BYTE,)),
    "C": ("captains taken", (CAPTAIN_AWAY_BYTE, CAPTAIN_HOME_BYTE)),
}


def _synced(script):
    """NAV_SAFE with a check that the two announced presses actually landed.

    The sync goes BEFORE the transition wait, not instead of it. This was
    built the other way round first, and the distinction is the whole point:
    the byte is written when the press is ACCEPTED, not when the next screen
    has ARRIVED. The game commits the stadium the instant Enter is taken and
    then plays a transition, so the sync returned in milliseconds, P2's join
    presses fired into a screen that did not exist yet, and P2 never joined --
    leaving P1 to pick both captains.

    So this buys no time. What it buys is a swallowed press being reported at
    the moment it happens, instead of surfacing as inexplicable behaviour two
    screens later, which is how every desync so far has presented.
    """
    tokens = script.split()
    out = []
    presses = 0
    for token in tokens:
        is_press = token not in WAITS
        if is_press:
            presses += 1
        out.append(token)
        # 3rd press is the stadium Enter; 7th is P2 taking its captain.
        marker = {3: "S", 7: "C"}.get(presses)
        if marker and is_press:
            out.append(marker)
    return " ".join(out)


NAV_SYNC = _synced(NAV_SAFE)

NAV_PRESETS = {"safe": NAV_SAFE, "quick": NAV_QUICK, "brisk": NAV_BRISK,
               "fast": NAV_FAST, "sync": NAV_SYNC}

# Upstream's formation_code_rev() read what it called a pointer from
# 0x806D121E and wrote both team blocks through it. That address holds no
# pointer. It sits inside a run of 0x01 filler in static data and reads
# 0x01010101 whatever screen is up, so --stage formation could only ever
# refuse -- which is exactly what it did. The "P2 has not joined, so the struct
# does not exist yet" theory was a red herring; the constant was simply wrong,
# and upstream's own note that this path was unverified was the tell.
#
# The real source came out of the Gecko prerequisite. Its third line,
# 0406aed8 48000b80, branches from 0x8006AED8 to 0x8006BA58 -- which is that
# function's own epilogue, `lmw`/`mtlr`/`blr`. It does not skip a detail; it
# turns the entire roster-initialisation routine into a no-op, 2944 bytes of
# it. That is what stops the game overwriting a roster written from outside,
# and it is why all three prerequisite lines are still required here even
# though nothing else about upstream's Gecko approach survives.
#
# What the routine would have done confirms the block layout twice over. Just
# past the branch sit eight stores with r6 = -1:
#
#     stb r6, 0x1C(r3)
#     stb r6, 0x2C(r3)
#     ...                   ; stride 0x10
#     stb r6, 0x8C(r3)
#
# -- blanking a byte at +0x0C of successive 0x10-byte slots, which is exactly
# the stride and offset upstream wrote through. Further on, at 0x8006BA4C, a
# loop steps `addi r30, r30, 16` and stops at `cmpwi r26, 9`: nine slots of
# sixteen bytes. And 0x8006AF00 reads the slot with `lha r0, 0(r7)`, so the
# character id is a halfword at +0x00 and the byte upstream wrote at +0x01 is
# its low half -- which means the byte at +0x00 is always zero, a cheap and
# surprisingly effective test for whether a candidate is a block at all.
#
# Note what this does NOT establish: slot 0 is not the captain. The captain
# bats wherever the lineup puts them -- in the TEST-season game the away
# captain is third -- so the search below cannot key on slot 0, and instead
# asks only that each captain appears somewhere in their own block.
#
# The three call sites of the enclosing function set r3 up like this:
#
#     lwz  r4, -2816(r13)   ; r13 = 0x807961C0, so r4 = *0x807956C0 = 0x811F7698
#     lwz  r3, 0xC0(r30)    ; away block
#     lbz  r4, 0x14(r4)     ; 0x811F76AC -- CAPTAIN_AWAY_BYTE
#     bl   0x8006AEA4
#     ...
#     lwz  r3, 0xC4(r30)    ; home block
#     lbz  r4, 0x15(r4)     ; 0x811F76AD -- CAPTAIN_HOME_BYTE
#
# The captain bytes settle which block is which beyond argument: finalize()
# already writes those two addresses as the away/home pair. So there are two
# independent block pointers hanging off one object, at +0xC0 and +0xC4, and
# the "away = home - 0x90" adjacency upstream assumed is incidental rather
# than structural. Both are read separately here.
OBJECT_AWAY_POINTER = 0xC0
OBJECT_HOME_POINTER = 0xC4
TEAM_BLOCK_STRIDE = 0x10
TEAM_BLOCK_SLOTS = 9
TEAM_BLOCK_BYTES = TEAM_BLOCK_SLOTS * TEAM_BLOCK_STRIDE
CHARACTER_OFFSET = 0x01
POSITION_OFFSET = 0x0C

# MSS stores a captain as an index into this list, and the exporter's
# captainSlot is that same index -- see resolveCaptainSlot() in
# export_mss_lineup.mjs. It is needed here to turn the slot back into a
# character index, because the character index is what slot 0 of a block holds
# and is what makes the search below self-verifying rather than merely
# plausible.
CAPTAIN_CHAR_INDEXES = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 17, 19]

# r30 above is a virtual method's `this`: the function is reached through a
# vtable rather than called directly, so there is no static address holding it
# and no amount of reading the disassembly will produce one. The object is
# found by signature instead. Scanning is a fair trade -- it costs a few
# seconds once per run, needs no further Gecko code, and unlike a hardcoded
# address it cannot quietly go stale.
#
# Which object it is, though, the game will tell you. It keeps task names in
# plain ASCII beside their function pointers, and the entry holding
# 0x80080010 -- the function whose r30 carries these blocks -- sits at
# 0x8063C210, immediately before the string at 0x8063C218:
#
#     Select::COrderSelectTask
#
# Its neighbours in that table are Order_local::CS2d_DajunShubiBg (dajun
# shubi, "batting order / fielding"), CS2d_FukidasiStatusGauge and the rest of
# that screen's widgets. So these blocks belong to the BATTING ORDER screen --
# not to captain select, and not to the draft. That is where these stages have
# to run, and it is the most useful single fact here: a formation write
# attempted any earlier finds nothing, because the task that owns the blocks
# has not been created yet.
#
# It also puts P2 in perspective. P2 does have to join at the captain screen
# and draft a side, since none of the later screens exist otherwise -- but
# that is a prerequisite for reaching the order screen, not the thing the
# formation write is itself waiting on.
ORDER_SELECT_TASK_NAME = 0x8063C218  # "Select::COrderSelectTask"
SCAN_CHUNK = 0x40000
# Both block pointers come off one object, so the blocks are allocated close
# together. This bounds the search without hardcoding the 0x90 spacing
# upstream relied on.
MAX_BLOCK_SPACING = 0x1000

# Characters at or above this index are Miis, which cannot be placed by writing
# the struct -- they have to be picked out of the Mii menu by hand.
#
# That was inherited from main.py as an assertion for a long time. It is now
# tested, and it is true in the most emphatic way available: writing a Mii's
# index (77 + the Mii's offset) into a slot's character byte on the batting
# order screen HANGS THE GAME. The byte took, read back correctly, and the
# emulated machine then stopped executing entirely -- no memory movement
# anywhere in MEM1 or MEM2, not recoverable by restoring the original value,
# and needing an emulation reset.
#
# The mechanism is visible in the block itself. A slot is sixteen bytes, and
# for an ordinary character only two of them are used -- the id at +0x00 and
# the fielding position at +0x0C -- with +0x04 and +0x08 both zero. A Mii's
# slot is the only kind that fills those two words in, with pointers to the
# Mii data the roster screen loaded:
#
#     slot 0  char   0  +04=0x00000000  +08=0x00000000   <- Mario
#     slot 1  char  78  +04=0x8120CF78  +08=0x812131C8   <- a Mii
#     slot 2  char  14  +04=0x00000000  +08=0x00000000   <- Boo
#
# So writing a Mii index into a slot whose pointers are still zero leaves the
# game holding a Mii with no Mii behind it, and it dereferences null on the
# spot. That is the hang, exactly.
#
# Note what this means for the id: 78 does NOT identify which Mii. The
# identity is in the pointers, and the number is only the slot's way of
# saying 'this one is a Mii'. Reading a block back cannot tell you WHICH Mii
# is in it, and no arithmetic on 78 will produce a menu position.
#
# So the Mii menu path below is not an alternative to writing the struct. It
# is the only way, and select_miis() has to run before a Mii index can appear
# in a block at all.
FIRST_MII_INDEX = 77
# main.py guards its struct writes with `< 71`, excluding the six "Unused"
# entries as well as Miis. Kept as-is: those slots are not real characters.
LAST_WRITABLE_CHAR_INDEX = 70

# -- taking a Mii out of the draft screen's grid ----------------------------
# Walked by hand, one press at a time, against a real console. Upstream's
# pick_miis() guessed at this menu and got four things wrong; what follows is
# what the menu actually does, and each line here was watched landing.
#
# The grid is five columns by two rows, ten to a page, with a page arrow
# sitting either side of it as an ORDINARY GRID CELL -- you walk onto the
# arrow, you do not press a shoulder button. Four behaviours matter and none
# of them are guessable:
#
#   * Opening the grid does NOT move the cursor into it. The cursor stays on
#     the button (which relabels itself "Char." while Miis are showing), so
#     the first move afterwards is one `left` onto the page arrow.
#   * On any page but the last, `left` from the arrow enters the grid on the
#     TOP ROW. That much was watched. WHICH COLUMN it lands in was not -- the
#     rightmost is assumed below because that is the cell the arrow abuts.
#     The only Mii in this league sits on the LAST page, so that branch has
#     never run; check it against the screen before trusting it.
#   * On the LAST page there is no right arrow, so after the final page turn
#     the cursor is nowhere -- it is genuinely not drawn. Any direction press
#     wakes it at the grid's TOP LEFT, wherever it came from. Upstream's
#     left/left/left/up special case was groping at this without knowing it.
#   * A takes the Mii; B backs out to the button. B ANIMATES, and a press sent
#     50ms after it is swallowed -- which is how the count silently shifts by
#     one. Every press that makes the screen DO something gets a real wait;
#     see the wait tiers below for which ones those are.
#
# One more, which does not bite here but will: a Mii that has been taken is
# REMOVED from the grid, so a team taking two Miis must have the second one's
# offset recalculated after the first pick. Only one Mii exists in this league,
# so that is left unimplemented rather than written blind.
MII_PAGE_COLUMNS = 5
MII_PER_PAGE = 10

# How long each press in a pick is given, by what the press actually does.
# This started out as two lengths -- 0.5s for a cursor move, 1.2s for anything
# else -- which is the shape you get from being careful before you know which
# presses are the dangerous ones. It came down in two steps, each one run
# against the console before the next was taken, and it has ended up as two
# tiers: the two ends, and everything between them.
#
#   * Opening the grid and backing out of it are the two ends, and they keep
#     the full 1.2s. The grid has to appear before the first move into it means
#     anything, and B animates on the way out (see above), so a press sent into
#     either is swallowed. These two are what make cutting the rest safe: the
#     fast stretch is bounded on both sides by a press that is not cut.
#   * Everything strictly between them emits no wait token at all.
#
# No wait token is not no wait, and this is the part worth knowing before
# tuning any of it further: a press is not an instant. It is a 17ms hold
# followed by MENU_GAP_MS, and that dwell is imposed on every press whether a
# wait token follows it or not. So the whole middle of a pick is made of
# MENU_GAP_MS and nothing else -- one press every MENU_HOLD_MS + MENU_GAP_MS,
# with no per-press wait left to remove. These three names are the tiers;
# MENU_GAP_MS is the floor under all of them and the only number that still
# moves them, which is also why it is not safe to read it as a grid setting --
# see the walk-down log up there.
#
# The floor was taken in two goes rather than one because the middle is not all
# the same press. The cursor steps went first -- the grid does not move under
# them, so there is no animation to land in -- and a full run confirmed it.
# The two that DO make the screen move went second: turning a page slides the
# grid, and A pulls the Mii out of it. They sat at 0.2s for that run and came
# down to the floor after it.
#
# The three names below are all "" and stay separate anyway, because they are
# the three different things that could need raising, and the order to raise
# them in is not the order they are listed:
#
#   * MII_TAKE_WAIT first. It is the only in-between wait whose job is to
#     protect a press that is NOT in-between: it is what stands between A
#     taking the Mii and B backing out, and B is the press this menu punishes
#     you for losing. Every other floored wait risks a cursor step; this one
#     risks the exit.
#   * MII_PAGE_WAIT second -- a page slide is the largest animation left in the
#     fast stretch. "." is 0.2s, "t" is 0.7s.
#   * MII_MOVE_WAIT last. It has the most presses behind it and the least
#     happening under each one.
#
# The failure mode is why any of this is worth writing down: a swallowed move
# inside the grid does not fail, it takes the WRONG Mii, and nothing downstream
# can tell -- a block read back says "a Mii", never which one (see
# FIRST_MII_INDEX). So the symptom is a stranger on the field, and the fix is
# one of the three constants below, not --wait-scale: that stretches whatever
# waits are left, but it cannot stretch a wait that is not emitted. Being
# outside its reach is the one thing the floor costs. Below MENU_GAP_MS there
# is nothing left in this file to tune at all: the only part of a press still
# unspent is the 17ms hold, which is one frame, which is what the game samples.
#
# An empty string means no wait token is emitted at all -- the pad's own gap is
# the whole of it.
MII_OPEN_WAIT = "s"    # 1.2s -- the grid has to be drawn before we move in it
MII_MOVE_WAIT = ""     # floor, = MENU_GAP_MS -- a cursor step on a settled grid
MII_PAGE_WAIT = ""     # floor, = MENU_GAP_MS -- the page slides under it
MII_TAKE_WAIT = ""     # floor, = MENU_GAP_MS -- A pulls the Mii out of the grid
MII_EXIT_WAIT = "s"    # 1.2s -- B animates, and eats whatever follows it

# The captain is placed in batting slot 0 automatically, so the first pick a
# player makes by hand lands in slot 1 -- which is where a Mii ends up, since
# it must be taken before Random fills everything else.
MII_LANDING_SLOT = 1

# From the Next button -- where both cursors sit when the batting order screen
# comes up -- onto the leftmost batter of your own lineup. Walked by hand.
# The lineup is a horizontal row of nine, P1's above Next and P2's below it,
# which is why these are not mirror images of each other.
#
# Up and down move between the batting order and the FIELDING POSITIONS on
# this screen, so these routes cross a row where A means something entirely
# different -- it swaps a position rather than a batter. That is what makes a
# swallowed press here expensive rather than merely wrong: lose one of the
# `u`s and every move after it happens on the fielding row. Once the entry
# route has landed, the drag itself only ever presses left/right, so it stays
# on the batting order row by construction.
MII_ORDER_ENTRY = {1: ["l", "l", "l", "u", "u"],
                   2: ["l", "d", "d", "r"]}
# And back again, from the leftmost batter to Next: each route reversed and
# each press inverted. Walking back matters because the ready chord that
# follows is sent from wherever the cursor was left, and leaving it parked in
# the middle of a lineup is how a stray press ends up reordering one.
MII_ORDER_EXIT = {port: [{"l": "r", "r": "l", "u": "d", "d": "u"}[token]
                         for token in reversed(route)]
                  for port, route in MII_ORDER_ENTRY.items()}

# The batting order screen allocates its team blocks as the task is created,
# which is BEFORE it will accept input -- so finding the blocks proves the
# screen exists, not that it is listening. The gap between those two is what
# ate the entire entry route: all three of P1's `l` presses vanished, the
# cursor never left Next's column, and the lift and drop both landed three
# slots right of where they were aimed. Hence a settle on top of the scan.
#
# "on top of the scan" is the part that makes this cheaper than it looks. This
# is not the whole pause on arriving at the screen and never was: the wait the
# blocks are found by is formation_blocks()'s own retry loop, which returns the
# moment they exist and is doing real work while it does. A sweep costs about a
# second, so by the time it hands back, most of a second has usually already
# passed since the blocks appeared. This settle is only the remainder --
# allocated to listening -- which is why it went from "W" (2.5s) to "s" (1.2s)
# rather than being tuned as if it were the whole gap. Effective clearance is
# still roughly two seconds; what was removed was the second copy of the scan.
#
# It is also, unlike anything in the Mii grid, a wait with a CHECKER behind it.
# verify_mii_slots() runs immediately after the drag and reads back where the
# Mii actually landed, so cutting this too far fails loudly and writes nothing
# -- it does not put a stranger on the field. That asymmetry is the whole
# reason this one can be trimmed on reasoning while MII_TAKE_WAIT cannot.
MII_DRAG_SETTLE = "s"


def _press(port, button, wait):
    """One press plus its wait, or just the press when the wait is the floor."""
    return [f"{port}:{button}"] + ([wait] if wait else [])


def mii_pick_script(port, offset, total_miis):
    """Script tokens that take the Mii at menu `offset` on `port`.

    `offset` is a position in MSS's own Mii menu, which is not the order the
    console's Mii database is in -- see mss_mii_map.json and the exporter.
    """
    last_page = max(0, (total_miis - 1) // MII_PER_PAGE)
    page, within = divmod(offset, MII_PER_PAGE)
    row, column = divmod(within, MII_PAGE_COLUMNS)
    if page > last_page:
        raise SystemExit(
            f"Mii offset {offset} is past the end of a {total_miis}-Mii menu. "
            "Check --total-miis and the menuOffset in scripts/mss_mii_map.json."
        )

    # Reaching the button: Next sits between P1's Random and the Mii button but
    # is GREYED until both teams are full, and a Mii has to be taken before
    # Random fills them -- so P1 is one down, not the two it would be later.
    # P2's Random is below the Mii button, so P2 is always one up.
    # Onto the Mii button. Still the draft screen, which has been settled since
    # before this script was spliced in, so this is an ordinary cursor step.
    steps = _press(port, "d" if port == 1 else "u", MII_MOVE_WAIT)
    steps += _press(port, "a", MII_OPEN_WAIT)   # open the grid; cursor stays on the button
    steps += _press(port, "l", MII_MOVE_WAIT)   # onto the page arrow
    for _ in range(page):
        steps += _press(port, "a", MII_PAGE_WAIT)

    if page == last_page:
        # The cursor is not drawn here. This press only wakes it, at top left.
        steps += _press(port, "l", MII_MOVE_WAIT)
        steps += _press(port, "r", MII_MOVE_WAIT) * column
    else:
        # Enters the top row at the rightmost column, so count leftwards.
        steps += _press(port, "l", MII_MOVE_WAIT)
        steps += _press(port, "l", MII_MOVE_WAIT) * (MII_PAGE_COLUMNS - 1 - column)
    steps += _press(port, "d", MII_MOVE_WAIT) * row

    steps += _press(port, "a", MII_TAKE_WAIT)   # take it
    steps += _press(port, "b", MII_EXIT_WAIT)   # back out -- this animates
    # Onto Random, back on the draft screen: a cursor step again, and the press
    # it protects is the nav tail's own A on Random.
    steps += _press(port, "u" if port == 1 else "d", MII_MOVE_WAIT)
    return steps


def split_nav(script):
    """(main menu -> draft screen, draft screen -> batting order).

    The Mii picks go between the two, because Random fills only the EMPTY
    slots -- take the Mii first and Random works around it, take it second and
    there is no room left.
    """
    tokens = script.split()
    transitions = [i for i, token in enumerate(tokens) if token in ("D", "T")]
    if not transitions:
        raise SystemExit(
            "This navigation script has no captains-to-draft transition ('D' or "
            "'T'), so there is no point in it to insert a Mii pick. Miis need "
            "the stock script, or a custom one that keeps that marker."
        )
    stop = max(transitions)
    return " ".join(tokens[:stop + 1]), " ".join(tokens[stop + 1:])

# Valid write targets, used to reject a garbage formation pointer before it is
# followed. MEM1 is the 24MB main RAM; MEM2 is the Wii's extra 64MB.
MEM_RANGES = ((0x80000000, 0x817FFFFF), (0x90000000, 0x93FFFFFF))

# The sweep looks at every 4-byte-aligned word in ~90MB of RAM, which is 22
# million of them -- far too many to touch one at a time from Python. Doing
# exactly that took eleven seconds, slow enough to be abandoned mid-run rather
# than waited out, which makes it useless as the "am I on the right screen
# yet?" check the navigation work needs.
#
# The trick is that the first test is only ever "does this word's top byte
# look like a pointer". Those top bytes are buf[0::4], a slice the interpreter
# builds at C speed; translate() turns them into 1s and 0s at C speed; and
# find(b'\x01\x01') then locates adjacent pointer pairs at C speed too.
# Python only ever sees the handful of offsets that survive. Same answers,
# roughly a hundred times less work.
_POINTER_HIGH_BYTES = {byte for low, high in MEM_RANGES
                       for byte in range((low >> 24), (high >> 24) + 1)}
_HIGH_BYTE_TABLE = bytes(1 if value in _POINTER_HIGH_BYTES else 0
                         for value in range(256))
# Chunks overlap by two words so a pair straddling a boundary is not missed.
SCAN_OVERLAP = 8


def pointer_pair_offsets(buf):
    """Byte offsets in `buf` where this word and the next both look like pointers."""
    flags = buf[0::4].translate(_HIGH_BYTE_TABLE)
    offsets = []
    start = 0
    while True:
        index = flags.find(b"\x01\x01", start)
        if index < 0:
            return offsets
        offsets.append(index * 4)
        start = index + 1



def in_game_memory(address):
    return any(low <= address <= high for low, high in MEM_RANGES)


# Everything finalize() writes, in the order the menus ask for it. Watching
# these while you drive the menus by hand is the cheapest possible check that
# an address is the live one: if the byte does not move when the on-screen
# selection moves, writing it was never going to do anything, and no amount of
# work further down the chain would have revealed that.
def finalize_fields(formation):
    stadium, day_night = formation.stadium
    away_captain, home_captain = formation.away_captain, formation.home_captain
    innings, stars, items, mercy = formation.rules
    fields = [("stadium", STADIUM_BYTE, stadium)]
    for index, address in enumerate(DAY_NIGHT_BYTES):
        fields.append((f"day/night {index}", address, day_night))
    fields.append(("captain away", CAPTAIN_AWAY_BYTE, away_captain))
    fields.append(("captain home", CAPTAIN_HOME_BYTE, home_captain))
    for offset, (name, value) in enumerate(
            (("innings", innings), ("stars", stars),
             ("items", items), ("mercy", mercy))):
        fields.append((name, RULES_BASE + offset, value))
    return fields


def watch_finalize(dme, formation, seconds, interval=0.05):
    """Print each of finalize()'s bytes whenever one changes.

    Read-only. The point is to confirm, before writing anything, that these
    addresses are the ones the menus actually read -- drive the stadium and
    captain selections by hand and watch the bytes follow.
    """
    fields = finalize_fields(formation)
    width = max(len(name) for name, _, _ in fields)
    print(f"Watching {len(fields)} bytes for {seconds:.0f}s. Nothing is written.")
    print("Change the stadium and the captains in-game and watch these follow.\n")
    print("  " + "  ".join(f"{name:>{width}}" for name, _, _ in fields))
    print("  " + "  ".join(f"{'want ' + str(want):>{width}}"
                           for _, _, want in fields))
    print("  " + "  ".join("-" * width for _ in fields))

    previous = None
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            current = [dme.read_bytes(address, 1)[0] for _, address, _ in fields]
            if current != previous:
                cells = []
                for value, (_, _, want) in zip(current, fields):
                    cells.append(f"{value:>{width - 1}}{'*' if value == want else ' '}")
                print("  " + "  ".join(cells))
                previous = current
            time.sleep(interval)
    except KeyboardInterrupt:
        print("  (stopped early)")
    print("\n* marks a byte already holding the value this lineup wants.")
    print("A byte that never moves while the menu selection does is the wrong "
          "address, and finalize() writing it would be a silent no-op.")


# A character id is a halfword, and MSS has 71 real characters plus Miis, so
# anything above this is filler rather than a roster entry.
MAX_CHARACTER_INDEX = 0x7F


# -- handing off to the stat tracker ----------------------------------------
# The last thing this file does is confirm two screens; the first thing the
# tracker does is read the live game out of memory. Between them sits the
# stadium load and the intro, and neither end can see the other, so something
# has to say when the match is actually up.
#
# Wall-clock is the wrong answer. The gap depends on the stadium, the host and
# whatever Dolphin is doing, and being wrong in the fast direction is the
# expensive one: a tracker that starts before the game exists reads menu
# leftovers, calibrates its ball feed against a stale fallback offset, and
# then logs an entire game of all-zero coordinates without erroring once.
#
# So the signal is the same one the tracker itself calibrates on. Between
# pitches the ball rests on the mound at a byte-exact Z, and probe_ball_memory
# already knows how to find that signature inside the ball object (its
# resolve_offset(), which is a transcription of what the patched tracker does).
# When the signature is there, three things are true at once and only one poll
# was needed to learn them: a match is loaded, it has reached its first pitch
# reset, and the tracker launched now will calibrate off a real reset instead
# of the fallback. That last one is the whole reason to wait for THIS rather
# than for any cheaper "is a game running" flag.
MATCH_LIVE_MARKER = "MSS_AUTOTEAM_MATCH_LIVE"
MATCH_LIVE_TIMEOUT = 180.0
MATCH_LIVE_INTERVAL = 0.25

# HOLDING THE OPENING PLAY.
#
# The pitch reset that MATCH_LIVE_MARKER announces is the last moment before
# the first pitch, and until now announcing it was all that happened: the bridge
# then started the collector, waited for it, and started the tracker .exe, with
# a live game running underneath the whole sequence. Nothing held gameplay,
# because nothing that could hold gameplay was involved -- the bridge owns
# neither the emulator nor the controller ports.
#
# This process owns both. `+` opens MSS's own pause menu, which stops play at
# the reset; the readers come up; `+` closes it again. Two presses, a bounded
# wait between them, and the timeout resumes regardless -- a hold that could
# strand a paused game would be worse than the delay it prevents.
#
# WHAT THIS IS NOT. It is not a lock. A player can close the pause menu
# themselves, and nothing here would know. It is the difference between a
# capture that reliably starts before the first pitch and one that races it.
GAMEPLAY_HELD_MARKER = "MSS_AUTOTEAM_GAMEPLAY_HELD"
GAMEPLAY_RESUMED_MARKER = "MSS_AUTOTEAM_GAMEPLAY_RESUMED"
GAMEPLAY_HOLD_TIMEOUT = 45.0
GAMEPLAY_HOLD_INTERVAL = 0.25


def read_readers_handshake(ready_path):
    """The bridge's handshake, or None while there is not a complete one yet.

    THE FILE EXISTING IS NOT THE ANSWER. It used to be: this waited for the
    path and resumed, and the bridge wrote it unconditionally right after
    spawning the tracker .exe -- so an executable that failed to start with
    ENOENT still released a live match that nothing was scoring. The bridge now
    states what came up in `status`, and this reads it.

    Returns None for a file that is absent or not yet parseable (a reader that
    caught a half-written one), which keeps the hold waiting rather than
    resuming on a fragment.
    """
    try:
        payload = json.loads(Path(ready_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    # An older bridge wrote no `status` at all; its file meant "both readers
    # up" in its own terms, and reading it as a failure would hold every game
    # launched against one. Absent is the old promise, not a new denial.
    payload.setdefault("status", "ready")
    return payload


def hold_opening_play(dme, driver, ready_path, timeout=GAMEPLAY_HOLD_TIMEOUT,
                      interval=GAMEPLAY_HOLD_INTERVAL, now=time.perf_counter,
                      sleep=time.sleep):
    """Pause at the pitch reset until the readers report in, then resume.

    Returns the reason play resumed:

      "readers_ready"  the bridge says the scoring reader is attached
      "readers_failed" the bridge says it is NOT running -- nothing will score
                       this game, and waiting longer cannot change that
      "timeout"        no handshake inside the hold
      "not_held"       the pause could not be pressed at all

    Every ending prints GAMEPLAY_RESUMED_MARKER, because a launcher reading
    this feed has to be able to tell "held for 3.1s" from "never held" -- and
    the second of those is the state the whole change exists to remove, so it
    must not look like the first. `readers_failed` is separate for the same
    reason: it resumes as fast as `readers_ready` does and means the opposite.

    Never raises. The game is live by this point; an exception here would
    strand a paused match over a diagnostic.
    """
    started = now()
    ready = Path(ready_path) if ready_path else None
    if ready is None:
        print(f"{GAMEPLAY_RESUMED_MARKER} not_held 0.0", flush=True)
        return "not_held"
    try:
        with FlagSuppress(dme, store=TARGET_STORES["held"]):
            driver.press_plus()
    except Exception as error:                          # noqa: BLE001
        print(f"  could not hold gameplay ({error!r}); the readers are starting "
              "against a live game.")
        print(f"{GAMEPLAY_RESUMED_MARKER} not_held 0.0", flush=True)
        return "not_held"
    print(f"  held at the pitch reset; waiting up to {timeout:.0f}s for the "
          f"scoring reader and the 60 Hz collector ({ready})")
    print(f"{GAMEPLAY_HELD_MARKER} paused", flush=True)

    reason = "timeout"
    handshake = None
    while now() - started < timeout:
        handshake = read_readers_handshake(ready)
        if handshake is not None:
            # 'ready' and 'unconfirmed' both mean the tracker is running; the
            # second is one that has not yet said it attached, and the bridge
            # has already stopped waiting for it, so there is nothing left for
            # this hold to wait for either.
            reason = ("readers_ready"
                      if handshake.get("status") in ("ready", "unconfirmed")
                      else "readers_failed")
            break
        sleep(interval)

    waited = now() - started
    try:
        with FlagSuppress(dme, store=TARGET_STORES["held"]):
            driver.press_plus()
    except Exception as error:                          # noqa: BLE001
        print(f"  WARNING: could not resume gameplay ({error!r}). Press + on "
              "the controller to close the pause menu.")
    if reason == "readers_ready":
        if (handshake or {}).get("status") == "unconfirmed":
            print(f"  the scoring reader is running but has not confirmed it "
                  f"attached ({(handshake or {}).get('scoringReason')}) after "
                  f"{waited:.1f}s -- resuming; the opening play may not be scored.")
        else:
            print(f"  both readers up after {waited:.1f}s -- resuming.")
    elif reason == "readers_failed":
        print(f"  ERROR: the scoring reader did NOT start after {waited:.1f}s "
              f"({(handshake or {}).get('scoringReason')}). NOTHING WILL SCORE "
              "THIS GAME. Resuming anyway -- a paused match is not a recovery.")
    else:
        print(f"  WARNING: no readers handshake after {waited:.0f}s. Resuming "
              "anyway rather than leaving the match paused; the opening play "
              "may not be captured.")
    print(f"{GAMEPLAY_RESUMED_MARKER} {reason} {waited:.1f}", flush=True)
    return reason


def ball_state(dme):
    """(ball object pointer, coordinate offset) if the game is at a pitch reset.

    The offset is None for every not-yet case without distinguishing them,
    because nothing here would do anything different: a null pointer (no ball
    object), a pointer into a stadium still loading, and a ball mid-flight all
    mean the same thing to a caller that is waiting. The pointer comes back
    regardless, because a caller telling one match from the next needs to see
    it move even while the offset says nothing.
    """
    try:
        pointer = int.from_bytes(dme.read_bytes(BALL_POINTER_SLOT, 4), "big")
    except RuntimeError:
        return None, None
    if not in_game_memory(pointer):
        return pointer, None
    try:
        return pointer, resolve_offset(dme, pointer)
    except RuntimeError:
        return pointer, None


def wait_for_match_live(dme, timeout=MATCH_LIVE_TIMEOUT, require_new=True,
                        interval=MATCH_LIVE_INTERVAL, hold_driver=None,
                        hold_ready_path=None,
                        hold_timeout=GAMEPLAY_HOLD_TIMEOUT):
    """Block until the match is up and at a pitch reset. Returns True if it is.

    Prints MATCH_LIVE_MARKER either way, which is what scripts/mss_autogame.mjs
    watches for -- a token rather than prose, so the handoff does not break the
    next time this wording is improved.

    The token carries a status word, and the two are not the same claim.
    `confirmed` means a pitch reset was actually seen. `unconfirmed` means the
    wait ran out and the handoff happened anyway, which is the right call --
    see the timeout note below -- but is not evidence the match is up. This
    used to print one identical line for both, so the launcher announced "match
    is live" for a run in which nothing of the sort had been established.

    `require_new` is what makes this safe to call from a full run, and it
    exists because the obvious version is wrong in the most ordinary case
    there is: playing a second game. Coming back to the main menu does not
    clear the ball object, so the signature from the LAST game's final pitch
    is still sitting in memory when the next run starts -- and a naive poll
    matches it instantly, releases the tracker while the menus are still
    being driven, and produces exactly the menu-initialised tracker the wait
    was added to prevent. It fails silently, and only on the second game of a
    session, which is the worst shape a bug can have.

    So a match only counts as new once something has changed since the wait
    began: either the signature went away and came back (the stadium load
    tearing the old object down), or the ball pointer itself moved (the new
    object landing somewhere else). Either is proof; neither alone is
    guaranteed to happen, which is why both are watched.

    A timeout is reported and then returns False rather than raising. By this
    point the teams are placed and both players have confirmed, so the game is
    on its way regardless; refusing to hand off would strand a run that has
    already done everything it was asked to.
    """
    print(f"  waiting for the first pitch (up to {timeout:.0f}s)...")
    started = time.perf_counter()
    deadline = started + timeout
    first_pointer, first_offset = ball_state(dme)
    stale = require_new and first_offset is not None
    if stale:
        print("  (a ball is already at a pitch reset -- that is the previous"
              " game's, so waiting for this one to replace it)")
    seen_absent = False
    while time.perf_counter() < deadline:
        pointer, offset = ball_state(dme)
        if offset is None:
            seen_absent = True
        elif not stale or seen_absent or pointer != first_pointer:
            elapsed = time.perf_counter() - started
            print(f"  match live after {elapsed:.1f}s "
                  f"(ball at 0x{pointer:08X}, coordinates at +0x{offset:03X})")
            # The marker first, then the hold: the marker is what releases the
            # bridge to start the readers, and holding before anything had been
            # asked to start would be holding for nothing.
            print(f"{MATCH_LIVE_MARKER} confirmed", flush=True)
            if hold_driver is not None and hold_ready_path:
                hold_opening_play(dme, hold_driver, hold_ready_path,
                                  timeout=hold_timeout)
            return True
        time.sleep(interval)

    if stale and not seen_absent:
        print(f"  WARNING: {timeout:.0f}s on, the ball object has not moved"
              " and has stayed at a pitch reset."
              "\n  That is indistinguishable from the previous game's"
              " leftovers, so this cannot say whether the new match is up.")
    else:
        print(f"  WARNING: no pitch reset within {timeout:.0f}s. The game may"
              " still be loading, or it never started.")
    print("  Handing off anyway -- a tracker started now recalibrates on the"
          " first reset it sees.")
    print(f"{MATCH_LIVE_MARKER} unconfirmed", flush=True)
    # Deliberately no hold. Nothing here established that a match is up, so
    # there is no pitch reset to hold at and a + press would land on whatever
    # screen is actually showing.
    if hold_driver is not None and hold_ready_path:
        print(f"{GAMEPLAY_RESUMED_MARKER} not_held 0.0", flush=True)
    return False


# Why a candidate was thrown out, cheapest test first. Reporting these counts
# is the difference between "the screen is not up" and "one of these tests is
# wrong", which otherwise look identical from outside -- both just print
# nothing found. That ambiguity already cost a round of testing once, when
# 0x806D121E's refusal was read as a missing draft screen rather than a bad
# constant.
REJECT_HIGH_BYTE = "slot +0x00 high byte non-zero"
REJECT_CHAR_RANGE = "character id out of range"
REJECT_CHAR_DUPES = "duplicate character ids"
REJECT_POSITIONS = "positions neither a permutation of 0..8 nor all 0xFF"
REJECT_ORDER = [REJECT_HIGH_BYTE, REJECT_CHAR_RANGE,
                REJECT_CHAR_DUPES, REJECT_POSITIONS]


def block_shape(dme, base, strict=True, stats=None):
    """Read one candidate block and say whether it is shaped like a team.

    Returns (characters, positions) or None. Tests, cheapest first:

      * the byte at each slot's +0x00 is zero, because the character id is a
        halfword and no id needs the high byte;
      * every character id is in range;
      * the nine ids are distinct, since a team cannot field the same
        character twice;
      * the nine position bytes are either a permutation of 0..8, which is
        what a set lineup looks like, or all 0xFF, which is what a block the
        game has cleared looks like.

    The last two only hold once a team is fully drafted, and the whole point
    of writing the block is to fill one in, so `strict=False` drops them. What
    replaces them as a filter is the captain test in find_formation_object():
    a half-drafted block still has its captain in it.
    """
    if not (in_game_memory(base) and in_game_memory(base + TEAM_BLOCK_BYTES - 1)):
        return None
    try:
        raw = dme.read_bytes(base, TEAM_BLOCK_BYTES)
    except RuntimeError:
        return None

    def reject(reason):
        if stats is not None:
            stats[reason] = stats.get(reason, 0) + 1
        return None

    if any(raw[i * TEAM_BLOCK_STRIDE] != 0 for i in range(TEAM_BLOCK_SLOTS)):
        return reject(REJECT_HIGH_BYTE)
    characters = [raw[i * TEAM_BLOCK_STRIDE + CHARACTER_OFFSET]
                  for i in range(TEAM_BLOCK_SLOTS)]
    if any(c > MAX_CHARACTER_INDEX for c in characters):
        return reject(REJECT_CHAR_RANGE)
    positions = [raw[i * TEAM_BLOCK_STRIDE + POSITION_OFFSET]
                 for i in range(TEAM_BLOCK_SLOTS)]
    if strict:
        if len(set(characters)) != TEAM_BLOCK_SLOTS:
            return reject(REJECT_CHAR_DUPES)
        if (sorted(positions) != list(range(TEAM_BLOCK_SLOTS))
                and not all(p == 0xFF for p in positions)):
            return reject(REJECT_POSITIONS)
    return characters, positions


def read_blocks(dme, obj, strict=True):
    """The two block bases hanging off `obj`, or None if it is not the object."""
    if not in_game_memory(obj):
        return None
    try:
        away = int.from_bytes(dme.read_bytes(obj + OBJECT_AWAY_POINTER, 4), "big")
        home = int.from_bytes(dme.read_bytes(obj + OBJECT_HOME_POINTER, 4), "big")
    except RuntimeError:
        return None
    if (block_shape(dme, away, strict) is None
            or block_shape(dme, home, strict) is None):
        return None
    return away, home


class Candidate:
    """One object that might be the one, and how well it fits."""

    def __init__(self, obj, away, home, away_shape, home_shape, has_captains):
        self.obj = obj
        self.away = away
        self.home = home
        self.away_shape = away_shape
        self.home_shape = home_shape
        self.has_captains = has_captains

    def describe(self):
        mark = "  <-- both captains present" if self.has_captains else ""
        return (f"  object 0x{self.obj:08X}  away 0x{self.away:08X}  "
                f"home 0x{self.home:08X}{mark}\n"
                f"    away chars {self.away_shape[0]}\n"
                f"    away pos   {self.away_shape[1]}\n"
                f"    home chars {self.home_shape[0]}\n"
                f"    home pos   {self.home_shape[1]}")


class Search:
    """The result of one sweep, including what it threw away and why."""

    def __init__(self, candidates, found, stats, spacing, strict):
        self.candidates = candidates
        self.found = found
        self.stats = stats
        self.spacing = spacing
        self.strict = strict

    def report(self):
        mode = "strict" if self.strict else "loose"
        lines = [f"{self.candidates} adjacent pointer pair(s) within "
                 f"0x{self.spacing:X} of each other, {mode} shape tests:"]
        for reason in REJECT_ORDER:
            count = self.stats.get(reason, 0)
            if count:
                lines.append(f"  {count:>8} rejected: {reason}")
        lines.append(f"  {len(self.found):>8} survived")
        return "\n".join(lines)


def find_formation_object(dme, away_captain, home_captain, strict=True,
                          spacing=None):
    """Find objects whose +0xC0/+0xC4 look like this game's two team blocks.

    Two passes. The first sweeps memory for any pair of adjacent words that
    could be the two pointers, which is cheap because it never leaves a buffer
    already read. The second checks each survivor's blocks, which costs two
    more reads apiece and so is worth doing only on what gets that far.

    The captains rank rather than filter. Each captain is certainly somewhere
    in their own block -- a captain plays -- but which batting slot is the
    site's business, not the game's, and at the moment this runs the in-game
    draft may not agree with the site yet. So a candidate carrying both
    captains is preferred, and one that does not is still reported rather than
    silently dropped.
    """
    spacing = MAX_BLOCK_SPACING if spacing is None else spacing
    candidates = []
    for low, high in MEM_RANGES:
        address = low
        end = high + 1
        while address < end:
            size = min(SCAN_CHUNK, end - address)
            try:
                buf = dme.read_bytes(address, size)
            except RuntimeError:
                address += size - SCAN_OVERLAP
                continue
            for offset in pointer_pair_offsets(buf):
                if offset + 8 > size:
                    continue
                away = int.from_bytes(buf[offset:offset + 4], "big")
                if not in_game_memory(away):
                    continue
                home = int.from_bytes(buf[offset + 4:offset + 8], "big")
                if not in_game_memory(home):
                    continue
                # Which of the two sits lower in the heap is an allocator
                # detail, so the distance is taken unsigned. Requiring them to
                # differ at all is what keeps the many pointer-pair-shaped
                # runs of identical words out.
                if not 0 < abs(home - away) <= spacing:
                    continue
                candidates.append((address + offset - OBJECT_AWAY_POINTER,
                                   away, home))
            if size <= SCAN_OVERLAP:
                break
            address += size - SCAN_OVERLAP

    stats = {}
    found = []
    # Overlapping chunks can surface the same pair twice; block_shape() costs
    # two reads, so it is worth not paying them again.
    for obj, away, home in dict.fromkeys(candidates):
        away_shape = block_shape(dme, away, strict, stats)
        if away_shape is None:
            continue
        home_shape = block_shape(dme, home, strict, stats)
        if home_shape is None:
            continue
        has_captains = (away_captain in away_shape[0]
                        and home_captain in home_shape[0])
        found.append(Candidate(obj, away, home, away_shape, home_shape,
                               has_captains))
    found.sort(key=lambda c: not c.has_captains)
    return Search(len(set(candidates)), found, stats, spacing, strict)


class MenuDriver:
    """main.py's eight press_* methods, over memory instead of the keyboard.

    The names are kept exactly as upstream had them so that the navigation code
    below is a straight transcription. That code is a long series of relative
    cursor moves with no feedback of any kind -- there is nothing to read back
    that says where the cursor ended up -- so the safest port is the one that
    changes the fewest characters.
    """

    def __init__(self, pad):
        self.pad = pad

    def press_a(self):
        self.pad.press("a")

    def press_b(self):
        self.pad.press("b")

    def press_left(self):
        self.pad.press("left")

    def press_right(self):
        self.pad.press("right")

    def press_up(self):
        self.pad.press("up")

    def press_down(self):
        self.pad.press("down")

    def press_plus(self):
        self.pad.press("plus")

    def start_game(self):
        """Minus+A, one player's "I am ready" on a confirm screen.

        main.py held Minus down across a full press and release of A rather
        than tapping both together, and holding() reproduces that shape -- see
        its docstring for why the two are not obviously equivalent.

        This is one PLAYER confirming, not the game starting. Upstream treated
        the two as the same thing because it drove a one-player exhibition
        against the CPU -- main.py's startGame() is this chord on player 1 and
        nothing else. With two human ports that only presses P1's Next, which
        is exactly as far as it got. See Formation.start_game() for the rest.
        """
        with self.pad.holding("minus"):
            self.press_a()

    def execute(self, instructions):
        """Replay one of main.py's navigation strings unchanged."""
        for token in instructions:
            if token == "w":
                time.sleep(WAIT_SECONDS)
            elif token == "u":
                self.press_up()
            elif token == "d":
                self.press_down()
            elif token == "l":
                self.press_left()
            elif token == "r":
                self.press_right()
            elif token == "a":
                self.press_a()
            elif token == "b":
                self.press_b()
            else:
                raise ValueError(f"Unknown instruction {token!r} in {instructions!r}")
        time.sleep(MENU_GAP_MS / 1000.0)


class Formation:
    """One game's worth of setup: two teams, a stadium, and four rules.

    `away` and `home` are nine rows of [charIndex, battingSlot, fieldingSlot],
    ordered by batting slot. `stadium` is [stadiumIndex, dayNight] and `rules`
    is [innings, stars, items, mercy], matching the layout main.py wrote.
    """

    def __init__(self, dme, driver, away, home, stadium, rules,
                 away_captain, home_captain, total_miis=0, driver2=None,
                 start_screens=2, nav_script=None, formation_timeout=15.0,
                 wait_scale=1.0):
        self.dme = dme
        self.driver = driver
        # The P2 remote. None means "not wired up for this run", which is the
        # honest default until P2's cursor path through the captain screen has
        # actually been walked.
        self.driver2 = driver2
        self.away = away
        self.home = home
        self.stadium = stadium
        self.rules = rules
        self.away_captain = away_captain
        self.home_captain = home_captain
        self.total_miis = total_miis
        self.start_screens = start_screens
        self.nav_script = nav_script or NAV_SCRIPT
        self.formation_timeout = formation_timeout
        # Stretches every wait in the nav script at once. The failure this
        # guards against is a press arriving mid-animation: it is swallowed,
        # and everything after it acts on the wrong screen, so the symptom
        # shows up somewhere other than the segment that was actually short.
        self.wait_scale = wait_scale

    # -- data writes --------------------------------------------------------

    def finalize(self):
        """Stadium, time of day, captains and rules -- all plain data writes.

        Called twice by automate(), before and after the lineup work, because
        walking the menus overwrites some of it as the cursor passes through.
        """
        self.dme.write_byte(STADIUM_BYTE, self.stadium[0])
        for address in DAY_NIGHT_BYTES:
            self.dme.write_byte(address, self.stadium[1])
        self.dme.write_byte(CAPTAIN_AWAY_BYTE, self.away_captain)
        self.dme.write_byte(CAPTAIN_HOME_BYTE, self.home_captain)
        for offset, value in enumerate(self.rules):
            self.dme.write_byte(RULES_BASE + offset, value)

    def captain_chars(self):
        """The two captains as character indexes rather than list positions."""
        try:
            return (CAPTAIN_CHAR_INDEXES[self.away_captain],
                    CAPTAIN_CHAR_INDEXES[self.home_captain])
        except IndexError:
            raise SystemExit(
                f"Captain slots {self.away_captain}/{self.home_captain} are out "
                f"of range for MSS's {len(CAPTAIN_CHAR_INDEXES)} captains. The "
                "exporter stores a position in CAPTAIN_CHAR_INDEXES, not a "
                "character index."
            )

    def formation_blocks(self, object_address=None):
        """Locate the away and home team blocks.

        Returns (object, away_base, home_base). Writing eighteen bytes through
        a wrong pointer would corrupt whatever lives there and surface minutes
        later as unrelated misbehaviour, so nothing is written until the blocks
        have been identified by their own contents rather than by an address
        that merely looks plausible.
        """
        away_captain, home_captain = self.captain_chars()
        if object_address is not None:
            blocks = read_blocks(self.dme, object_address)
            if blocks is None:
                raise SystemExit(
                    f"0x{object_address:08X} does not carry two block pointers "
                    f"at +0x{OBJECT_AWAY_POINTER:02X}/"
                    f"+0x{OBJECT_HOME_POINTER:02X}."
                )
            return (object_address,) + blocks

        # Retry rather than fail. In a full run the scan fires seconds after
        # the navigation ends, and the batting order screen allocates its
        # blocks as it comes up -- so the first sweep can legitimately land
        # before they exist. A sweep costs about a second, which is cheap
        # enough to simply repeat until the screen has caught up.
        deadline = time.perf_counter() + self.formation_timeout
        attempt = 0
        while True:
            attempt += 1
            search = find_formation_object(self.dme, away_captain, home_captain)
            if search.found or time.perf_counter() >= deadline:
                break
            if attempt == 1:
                print(f"  waiting for the batting order screen "
                      f"(up to {self.formation_timeout:.0f}s)...")
            time.sleep(0.5)
        # A block only passes the strict tests once it is fully drafted, so a
        # strict miss is not the end of the search -- it is the expected
        # outcome partway through a draft. The loose sweep drops the two tests
        # that assume a finished team.
        if not search.found:
            loose = find_formation_object(self.dme, away_captain, home_captain,
                                          strict=False)
            if [c for c in loose.found if c.has_captains]:
                print("  (strict shape tests found nothing; "
                      "matched on the loose sweep)")
                search = loose
        found = search.found

        # One candidate is the answer, captains or not. Requiring the captains
        # to match before writing had this backwards: the in-game selection is
        # *deliberately* not what the site says -- picking wrong captains and
        # letting Random fill both teams is the intended workflow, since every
        # slot gets overwritten anyway. The captains are a tiebreaker for the
        # ambiguous case, never a precondition.
        if len(found) == 1:
            c = found[0]
            if not c.has_captains:
                print(f"  (captains in memory are not the site's yet -- "
                      f"writing anyway, only one candidate exists)")
            return c.obj, c.away, c.home

        best = [c for c in found if c.has_captains]
        if len(best) == 1:
            c = best[0]
            return c.obj, c.away, c.home
        if not found:
            raise SystemExit(
                "Could not find the team blocks in memory. Nothing was "
                "written.\n\n"
                f"The search wanted one object holding pointers at "
                f"+0x{OBJECT_AWAY_POINTER:02X} and +0x{OBJECT_HOME_POINTER:02X} "
                f"to two {TEAM_BLOCK_SLOTS}-slot blocks, and found no pair "
                "anywhere in memory that is even shaped like one.\n\n"
                "The blocks belong to Select::COrderSelectTask -- the BATTING "
                "ORDER screen -- so this reads as: that screen is not up. It is "
                "the screen after the draft, the one listing nine batters with "
                "their fielding positions. Captain select and the draft itself "
                "are both too early, however far P2 has got.\n\n"
                + search.report()
            )
        listing = "\n".join(c.describe() for c in found[:10])
        if not best:
            raise SystemExit(
                f"Found {len(found)} block-shaped candidates and none carries "
                f"both captains (away char {away_captain}, home char "
                f"{home_captain}), so there is nothing to tell them apart. "
                "Nothing was written.\n\n"
                f"{listing}\n\n"
                "Pass --formation-object 0x... to write into a specific one."
            )
        raise SystemExit(
            f"{len(best)} candidates carry both captains, so which one is the "
            "live formation is ambiguous. Nothing was written.\n\n"
            f"{listing}\n\n"
            "Pass --formation-object 0x... to pick one."
        )

    def apply_formation(self, object_address=None, blocks=None):
        """Place both teams by writing the struct, no Gecko code involved.

        This is main.py's formation_code_rev() with its pointer corrected and
        the two blocks read separately. Miis are skipped here and picked out of
        the Mii menu during the draft instead, because a Mii is not addressable
        as a character index -- see FIRST_MII_INDEX.

        `blocks` hands in bases that have already been located, skipping both
        the scan and the shape check. automate() uses it because it found them
        before the Mii drag and has read them since, and re-validating is not
        merely wasteful -- it is WRONG once the drag has run. block_shape()'s
        strict test wants the nine fielding positions to be all 0xFF or a full
        permutation of 0..8, which holds on a freshly arrived screen and stops
        holding the moment a swap makes the game assign positions to the slots
        it touched. That leaves a partial set, which is neither, so a perfectly
        good object gets refused after the one step that proves it is live.
        """
        if blocks is not None:
            away_base, home_base = blocks
            obj = object_address
        else:
            obj, away_base, home_base = self.formation_blocks(object_address)
        where = f"object 0x{obj:08X}  " if obj is not None else ""
        print(f"  formation {where}"
              f"away 0x{away_base:08X}  home 0x{home_base:08X}")
        for base, team in ((away_base, self.away), (home_base, self.home)):
            for char_index, batting_slot, fielding_slot in team:
                slot = base + (batting_slot * TEAM_BLOCK_STRIDE)
                if char_index <= LAST_WRITABLE_CHAR_INDEX:
                    self.dme.write_byte(slot + CHARACTER_OFFSET, char_index)
                self.dme.write_byte(slot + POSITION_OFFSET, fielding_slot)

    # -- menu navigation ----------------------------------------------------

    def miis_in(self, team):
        """Mii entries as [miiOffset, battingSlot], in the order main.py wants."""
        return [[char_index - FIRST_MII_INDEX, batting_slot]
                for char_index, batting_slot, _ in team if char_index >= FIRST_MII_INDEX]

    def select_miis(self):
        """main.py's sel_code_rev(): pick each team's Miis out of the Mii menu."""
        self.pick_miis(self.miis_in(self.away), 0)
        self.pick_miis(self.miis_in(self.home), 1)

    def pick_miis(self, entries, side):
        """main.py's handleMiis(), transcribed.

        The Mii menu is ten per page in two rows of five, and the last page is
        anchored differently from the others -- upstream's comment says the
        special left/left/left/up move must only fire when the target really is
        on the overall last page, which is why total_miis has to be known.
        """
        if entries and not self.total_miis:
            raise SystemExit(
                "This lineup contains a Mii, so the number of Miis on the "
                "console is needed to navigate the Mii menu (the last page is "
                "anchored differently from the others). Pass --total-miis N."
            )

        last_page = (self.total_miis - 1) // 10 if self.total_miis else 0

        for mii_offset, _ in entries:
            self.driver.execute("awllllll")
            remaining = mii_offset
            target_page = mii_offset // 10
            turns = 0
            while remaining >= 10:
                remaining -= 10
                turns += 1
                self.driver.execute("rrrrralllll")

            if target_page == last_page and turns == target_page:
                self.driver.press_left()
                self.driver.press_left()
                self.driver.press_left()
                self.driver.press_up()

            for _ in range(remaining % 5):
                self.driver.press_right()
            if remaining >= 5:
                self.driver.press_down()

            self.driver.press_a()
            self.driver.press_b()
            time.sleep(0.5)

        self.driver.execute("uuadd" if side == 0 else "dauu")

    def order_miis(self, team):
        """main.py's lineup_code_rev(): drag each Mii to its batting slot.

        Only Miis need this. Everyone else was placed by apply_formation(),
        but a Mii arrives in selection order and has to be walked into place
        with the cursor, swapping as it goes.
        """
        entries = self.miis_in(team)
        position = 0
        index = 0
        while index < len(entries):
            target = index + 1
            position = self.move_cursor(position, target)
            self.driver.press_a()
            target = entries[index][1]
            position = self.move_cursor(position, target)
            self.driver.press_a()
            if index + 1 < target <= len(entries):
                entries[index], entries[target - 1] = entries[target - 1], entries[index]
            else:
                index += 1
        self.move_cursor(position, 8)

    def move_cursor(self, position, target):
        while position < target:
            self.driver.press_right()
            position += 1
        while position > target:
            self.driver.press_left()
            position -= 1
        return position

    def drivers(self):
        """Every port this run drives, P1 first."""
        return [d for d in (self.driver, self.driver2) if d is not None]

    def poison_sync_bytes(self):
        """Put a value in each watched byte that the game is about to replace."""
        for address, value in SYNC_POISON.items():
            self.dme.write_byte(address, value)

    def wait_for_sync(self, token):
        """Block until the game writes the watched byte(s), and say how long.

        Reports the real transition time on every run, which is the number
        that would otherwise have to be measured by hand and then trusted to
        stay true.
        """
        label, addresses = SYNC_TOKENS[token]
        started = time.perf_counter()
        deadline = started + SYNC_TIMEOUT
        while time.perf_counter() < deadline:
            if all(self.dme.read_bytes(a, 1)[0] != SYNC_POISON[a] for a in addresses):
                elapsed = time.perf_counter() - started
                print(f"      {label} after {elapsed * 1000:.0f}ms")
                return True
            time.sleep(0.002)
        print(f"      WARNING: {label} never announced itself "
              f"({SYNC_TIMEOUT:.0f}s). Falling back to a blind wait; if this "
              "run desynchronises, that is why.")
        return False

    def driver_for(self, port):
        for driver in self.drivers():
            if driver.pad.port == port:
                return driver
        raise SystemExit(
            f"The script wants port {port}, but this run drives "
            f"{', '.join(str(d.pad.port) for d in self.drivers())}. "
            "Set --port / --p2-port to match."
        )

    def run_script(self, text, step=False):
        """Replay a two-port script through this run's drivers.

        Separate from mss_input's run_script, which builds its own pads: here
        the drivers already exist and carry the run's hold/gap timing, and the
        ports are the ones --port/--p2-port chose.
        """
        steps = parse_script(text, extra=SYNC_TOKENS)
        if any(token in SYNC_TOKENS for _, token in steps):
            self.poison_sync_bytes()
        for index, (port, token) in enumerate(steps, 1):
            if step:
                try:
                    input(f"  [{index}/{len(steps)}] port {port} {token!r} -- Enter: ")
                except (EOFError, KeyboardInterrupt):
                    print("\n  (stopped)")
                    return
            if token in SYNC_TOKENS:
                self.wait_for_sync(token)
                continue
            if token in WAITS:
                time.sleep(WAITS[token] * self.wait_scale)
                continue
            driver = self.driver_for(port)
            if token in CHORDS:
                hold, tap = CHORDS[token]
                with driver.pad.holding(hold):
                    driver.pad.press(tap)
            else:
                driver.pad.press(INSTRUCTIONS[token])
            if not step:
                print(f"  [{index}/{len(steps)}] port {port}: {token}")

    def start_game(self):
        """Both players confirm, on each screen that asks them to.

        Two screens stand between the batting order and the first pitch, and
        both wait for BOTH players: the order screen itself, then the rules
        screen after it. Upstream sent one chord on one port, which clears
        neither -- it only presses P1's Next and leaves the screen sitting
        there waiting for P2.

        The gap between screens is generous because there is nothing to read
        back that says the next screen has arrived; confirming into a screen
        that has not finished animating is a press thrown away.
        """
        for screen in range(self.start_screens):
            label = "batting order" if screen == 0 else f"screen {screen + 1}"
            print(f"  confirming {label} on port(s) "
                  f"{', '.join(str(d.pad.port) for d in self.drivers())}...")
            for driver in self.drivers():
                driver.start_game()
            time.sleep(START_SCREEN_GAP)

    # -- the whole run ------------------------------------------------------

    def mii_picks(self):
        """[(port, menu offset)] for every Mii this game needs, P1 first."""
        picks = []
        for driver, team in ((self.driver, self.away), (self.driver2, self.home)):
            entries = self.miis_in(team)
            if not entries:
                continue
            if driver is None:
                raise SystemExit(
                    "This lineup has a Mii on the home side, but no P2 driver is "
                    "wired up. A Mii can only be taken with its own player's "
                    "controller."
                )
            if len(entries) > 1:
                raise SystemExit(
                    f"{len(entries)} Miis on one team. Taking a Mii REMOVES it "
                    "from the grid, so the second one's menu offset shifts and "
                    "this has never been walked through -- refusing rather than "
                    "guessing at it."
                )
            offset, batting_slot = entries[0]
            picks.append((driver.pad.port, offset, batting_slot))
        return picks

    def nav_with_miis(self):
        """The navigation script, with any Mii picks spliced into the draft."""
        picks = self.mii_picks()
        if not picks:
            return self.nav_script
        if not self.total_miis:
            raise SystemExit(
                "This lineup contains a Mii, so the number of Miis on the console "
                "is needed to navigate the menu (the last page behaves differently "
                "from the others). Pass --total-miis N."
            )
        to_draft, tail = split_nav(self.nav_script)
        steps = [to_draft]
        for port, offset, _ in picks:
            print(f"  port {port}: taking the Mii at menu offset {offset}")
            steps += mii_pick_script(port, offset, self.total_miis)
        steps.append(tail)
        return " ".join(steps)

    def mii_drag_script(self):
        """Move each Mii from where the menu put it to where it should bat.

        This is main.py's lineup_code_rev(), which is the half of upstream's
        Mii handling that makes an arbitrary batting order possible at all. A
        Mii cannot be written into the block -- see FIRST_MII_INDEX -- so it
        lands wherever the draft put it, which is slot MII_LANDING_SLOT: the
        captain takes slot 0 and the Mii is the first pick after it. Getting it
        anywhere else means moving it on screen.

        The batting order screen is a horizontal row of nine, walked with
        left/right, and A lifts a player while a second A drops them onto
        whoever is standing there -- so one lift and one drop is a swap.

        Only the Mii's own move matters. Whoever it displaces is irrelevant,
        because apply_formation() overwrites every non-Mii slot straight
        afterwards -- which is why this is one swap rather than upstream's
        sort. Its bookkeeping exists to handle several Miis displacing each
        other; mii_picks() refuses more than one per team for an unrelated
        reason (the grid reshuffles after a pick), so that case cannot arise.
        """
        steps = []
        for port, _, batting_slot in self.mii_picks():
            if batting_slot == MII_LANDING_SLOT:
                continue
            print(f"  port {port}: moving the Mii from slot "
                  f"{MII_LANDING_SLOT + 1} to slot {batting_slot + 1}")
            # Both cursors start on Next, not on a batter -- upstream's
            # `pos = 0` assumes its own single-player layout and does not
            # transfer. Getting onto your own leftmost batter is asymmetric,
            # the same way the draft column is: P1's order sits above Next and
            # P2's below it, so the two routes are different lengths and
            # neither is a mirror of the other.
            for token in MII_ORDER_ENTRY[port]:
                steps += [f"{port}:{token}", "."]
            steps += [f"{port}:r", "."] * MII_LANDING_SLOT
            steps += [f"{port}:a", "w"]
            move = "r" if batting_slot > MII_LANDING_SLOT else "l"
            steps += [f"{port}:{move}", "."] * abs(batting_slot - MII_LANDING_SLOT)
            steps += [f"{port}:a", "w"]
            # Back to the leftmost batter, then out to Next the way we came in.
            steps += [f"{port}:l", "."] * batting_slot
            for token in MII_ORDER_EXIT[port]:
                steps += [f"{port}:{token}", "."]
        return " ".join([MII_DRAG_SETTLE] + steps) if steps else ""

    def verify_mii_slots(self, away_base, home_base):
        """Check each Mii actually landed where the lineup wants it.

        The drag is the one step here with no feedback of its own, and its
        failure is silent and expensive: a swallowed press shifts the count,
        the lift and drop hit the wrong slots, and apply_formation() then
        writes a perfectly consistent-looking lineup over the wreckage. What
        you see is a random drafted character standing where the Mii should
        be, which looks like the struct write misbehaving and is not.

        So this refuses to continue rather than papering over it. Nothing has
        been written at this point -- the caller runs it before finalize().
        """
        bases = {self.driver.pad.port: ("away", away_base)}
        if self.driver2 is not None:
            bases[self.driver2.pad.port] = ("home", home_base)
        for port, _, batting_slot in self.mii_picks():
            label, base = bases[port]
            found = [slot for slot in range(TEAM_BLOCK_SLOTS)
                     if int.from_bytes(
                         self.dme.read_bytes(base + slot * TEAM_BLOCK_STRIDE, 2),
                         "big") >= FIRST_MII_INDEX]
            if found == [batting_slot]:
                print(f"  port {port}: Mii confirmed in slot {batting_slot + 1}")
                continue
            where = (f"slot {found[0] + 1}" if len(found) == 1
                     else f"slots {[s + 1 for s in found]}" if found
                     else "no slot at all")
            raise SystemExit(
                f"The {label} Mii should be batting {batting_slot + 1} but is in "
                f"{where}. The drag on the batting order screen did not land "
                "where it was aimed, and writing the teams now would bury that "
                "under a lineup that looks right. Nothing was written.\n\n"
                "A swallowed press is the usual cause -- the cursor moves "
                "between the batting order and the fielding positions with "
                "up/down, so one lost press puts every move after it on the "
                "wrong row. Re-run, and raise --wait-scale if it repeats."
            )

    def automate(self, auto_start=True):
        print("  navigating to the batting order screen...")
        self.run_script(self.nav_with_miis())

        # Find the blocks BEFORE anything else touches this screen. Two jobs:
        # it is the only reliable "the batting order screen has arrived" signal
        # this file has -- formation_blocks() retries until the blocks are
        # allocated -- and it saves apply_formation() a second scan below.
        #
        # The navigation deliberately ends without a wait, on the reasoning
        # that the scan would absorb the transition anyway. That was true when
        # the scan came next. It stopped being true when the drag did: its
        # first presses went out while the screen was still coming up, were
        # swallowed, and every count after them was off by however many got
        # eaten -- so the lift and drop hit the wrong slots and left a random
        # drafted character sitting where the Mii should be.
        obj, away_base, home_base = self.formation_blocks()

        # Before the struct write, not after. The drag reorders the block, so
        # doing it second would shuffle the lineup that had just been written
        # correctly -- and doing it first costs nothing, since apply_formation()
        # then writes every non-Mii slot over whatever the swap displaced.
        drag = self.mii_drag_script()
        if drag:
            self.run_script(drag)
            self.verify_mii_slots(away_base, home_base)

        print("  writing stadium, captains and rules...")
        self.finalize()

        print("  placing both teams...")
        self.apply_formation(object_address=obj, blocks=(away_base, home_base))

        # Miis are the one thing apply_formation() cannot place: a Mii has no
        # character index to write, so it has to be picked out of the Mii menu
        # with the cursor. Everyone else is already on the field by this point.
        #
        # This block used to run unconditionally, on the reasoning that its
        # fixed navigation was load-bearing even with the loops empty -- true
        # of upstream, where the cursor position it left behind was what the
        # next step assumed. It is not true here and is now actively harmful:
        # this run writes every slot directly and then confirms with the ready
        # chord, which does not care where the cursor is. Meanwhile the block's
        # bare press_a() calls land on the batting order screen, where A picks
        # a player up and A again drops them somewhere else -- so running it
        # with no Miis reorders the lineup we just wrote.
        # Nothing to do here any more. Miis are taken during the DRAFT, by
        # nav_with_miis() above, because that is the only screen that can take
        # one -- and because Random fills the empty slots, so the Mii has to be
        # in place before it runs.
        #
        # What used to sit here was upstream's select_miis()/order_miis() pair,
        # run against the batting order screen. It could never have worked: by
        # then character selection is over, and its bare press_a() calls land on
        # a screen where A picks a player up and drops them somewhere else, so
        # it reordered the lineup that had just been written.
        #
        # order_miis() survives below, unused, for the day a Mii has to bat
        # somewhere other than second -- see mii_picks(), which refuses that
        # case rather than misplacing anyone.
        time.sleep(0.25)
        self.finalize()
        time.sleep(0.25)

        if auto_start:
            self.start_game()


# -- payload ----------------------------------------------------------------

def team_rows(team):
    """Turn the exporter's slot objects into main.py's [char, bat, field] rows."""
    rows = []
    for slot in team["slots"]:
        rows.append([int(slot["charIndex"]), int(slot["battingSlot"]), int(slot["fieldingSlot"])])
    if len(rows) != 9:
        raise SystemExit(f"{team.get('label', 'A team')} has {len(rows)} slots, expected 9.")
    return rows


def load_payload(path=None, from_site=False):
    if from_site:
        result = subprocess.run(
            ["node", str(Path(__file__).resolve().parent / "export_mss_lineup.mjs")],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise SystemExit(f"Could not export the lineup from the site:\n{result.stderr.strip()}")
        return json.loads(result.stdout)
    if not path:
        raise SystemExit("Give --lineup <file.json> or --from-site.")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def describe(payload):
    game = payload["game"]
    innings, stars, items, mercy = payload["rules"]
    print(f"Game {game['id']} ({game['table']})  {game.get('stadium') or 'stadium unset'}"
          f"  {'night' if game.get('isNight') else 'day'}")
    print(f"Rules: {innings} innings, stars {'on' if stars else 'off'}, "
          f"items {'on' if items else 'off'}, mercy {'on' if mercy else 'off'}")
    for side in ("away", "home"):
        team = payload[side]
        print(f"\n{side.title()} -- {team.get('playerName') or team.get('playerId')}")
        for slot in team["slots"]:
            label = slot["siteName"]
            if slot.get("miiColor"):
                label = f"{slot['miiColor']} Mii"
            print(f"  {slot['battingSlot'] + 1}. {label:<22} {slot['positionId']}"
                  f"   (char {slot['charIndex']}, pos {slot['fieldingSlot']})")
    stadium_test = game.get("calibration", {}).get("stadiumTest")
    if stadium_test:
        print(f"\nStadium test card ({stadium_test.get('variant', 'unknown')}; "
              f"aim for {stadium_test.get('repeatTarget', 1)} of each):")
        for objective in stadium_test.get("objectives", []):
            print(f"  {objective['id']} [{objective.get('annotationCategory', 'missing_event')}]: "
                  f"{objective['instruction']}")
        print(f"  note format: {stadium_test.get('annotationNoteFormat', '')}")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--lineup", help="JSON from scripts/export_mss_lineup.mjs")
    parser.add_argument("--from-site", action="store_true",
                        help="run the exporter first and use its output")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the lineup and exit without touching the game")
    parser.add_argument("--stage", default="all",
                        choices=["all", "nav", "finalize", "watch", "formation",
                                 "find-formation", "miis", "start", "wait-live"],
                        help="run one part of the sequence (default: all). Use this "
                             "to test the struct writes with the menus already open. "
                             "find-formation reports what the block search sees "
                             "without writing anything.")
    parser.add_argument("--port", type=int, choices=(1, 2, 3, 4), default=1,
                        help="controller port for the P1 menu driver (default: 1)")
    parser.add_argument("--p2-port", type=int, choices=(1, 2, 3, 4), default=2,
                        help="controller port for the P2 driver (default: 2)")
    parser.add_argument("--p2-join",
                        help="instruction string to make P2 join at the captain "
                             "screen, in execute() syntax. Nothing is sent unless "
                             "this is given -- the sequence is not known yet, so "
                             "this is the flag to experiment with rather than a "
                             "default to trust.")
    parser.add_argument("--wait-scale", type=float, default=1.0,
                        help="multiply every wait in the nav script (default: 1). "
                             "Raise it if presses land mid-animation.")
    parser.add_argument("--formation-timeout", type=float, default=15.0,
                        help="how long to keep looking for the team blocks "
                             "before giving up (default: 15s). The batting "
                             "order screen allocates them as it comes up.")
    parser.add_argument("--nav-preset", choices=sorted(NAV_PRESETS), default="brisk",
                        help="navigation timing (default: brisk, the version "
                             "verified end to end). Same presses in every "
                             "preset -- only the waits differ. Fall back to "
                             "'safe' if a run desynchronises; 'fast' is "
                             "shorter still and known to break at the "
                             "captains-to-draft transition.")
    parser.add_argument("--nav",
                        help="override the main-menu-to-batting-order script, "
                             "in the two-port syntax (see NAV_SCRIPT). Use this "
                             "to test one screen at a time.")
    parser.add_argument("--step", action="store_true",
                        help="pause before each press during --stage nav")
    parser.add_argument("--start-screens", type=int, default=2,
                        help="how many confirm screens both players must clear "
                             "to start (default: 2 -- batting order, then rules)")
    parser.add_argument("--seconds", type=float, default=30.0,
                        help="how long --stage watch runs (default: 30)")
    parser.add_argument("--max-spacing", type=lambda v: int(v, 0),
                        default=MAX_BLOCK_SPACING,
                        help="how far apart the two team blocks may sit, for "
                             "--stage find-formation (default: 0x%(default)X)")
    parser.add_argument("--formation-object", type=lambda v: int(v, 0),
                        help="skip the memory scan and use this object address, "
                             "as reported by --stage find-formation")
    parser.add_argument("--no-start", action="store_true",
                        help="set everything up but do not start the game")
    parser.add_argument("--wait-for-live", type=float, nargs="?",
                        const=MATCH_LIVE_TIMEOUT, default=None,
                        metavar="SECONDS",
                        help="after starting, block until the match reaches "
                             "its first pitch reset (default "
                             f"{MATCH_LIVE_TIMEOUT:.0f}s) and print "
                             + MATCH_LIVE_MARKER + " followed by "
                             "'confirmed' or, if the wait ran out and the "
                             "handoff happened regardless, 'unconfirmed'. "
                             "That token is the handoff "
                             "scripts/mss_autogame.mjs waits on before it "
                             "launches the tracker; on its own this is just "
                             "a blocking 'is the game up yet'.")
    parser.add_argument("--hold-until", metavar="PATH", default=None,
                        help="hold gameplay at the first pitch reset -- press "
                             "+ to open MSS's own pause menu -- until this file "
                             "exists, then press + again to resume. The bridge "
                             "writes it once BOTH readers are up (the tracker "
                             ".exe and the 60 Hz collector), which is what stops "
                             "the opening play being thrown while they are still "
                             "starting. Bounded by --hold-timeout, and resumed "
                             "regardless when that runs out.")
    parser.add_argument("--hold-timeout", type=float, default=GAMEPLAY_HOLD_TIMEOUT,
                        metavar="SECONDS",
                        help="how long --hold-until waits before resuming play "
                             f"anyway (default {GAMEPLAY_HOLD_TIMEOUT:.0f})")
    parser.add_argument("--total-miis", type=int, default=int(os.environ.get("MSS_TOTAL_MIIS", 0)),
                        help="how many Miis are on the console; only needed when a "
                             "lineup contains one")
    parser.add_argument("--hold-ms", type=float, default=MENU_HOLD_MS)
    parser.add_argument("--gap-ms", type=float, default=MENU_GAP_MS)
    args = parser.parse_args()

    payload = load_payload(args.lineup, args.from_site)
    describe(payload)
    if args.dry_run:
        return 0

    dme = hook()
    pad = WiimoteInput(dme, port=args.port, field="held",
                       hold_ms=args.hold_ms, gap_ms=args.gap_ms)
    ok, message = pad.verify()
    print(message)
    if not ok:
        return 1

    # P2 is not optional on these screens. MSS's captain screen waits for the
    # second player to press A and join before the draft exists at all, and
    # everything this file writes lives in structures the draft allocates. The
    # driver is built here so the port is verified up front rather than
    # halfway through a run, but it stays silent until --p2-join says what to
    # send: guessing a cursor path and shipping it as a default is how a blind
    # relative-movement sequence ends up desynchronised with no way to tell.
    pad2 = WiimoteInput(dme, port=args.p2_port, field="held",
                        hold_ms=args.hold_ms, gap_ms=args.gap_ms)
    ok2, message2 = pad2.verify()
    print(message2)
    if not ok2:
        return 1
    formation_object = args.formation_object

    formation = Formation(
        dme=dme,
        driver=MenuDriver(pad),
        driver2=MenuDriver(pad2),
        away=team_rows(payload["away"]),
        home=team_rows(payload["home"]),
        stadium=[payload["game"]["stadiumIndex"], 1 if payload["game"].get("isNight") else 0],
        rules=payload["rules"],
        away_captain=payload["away"]["captainSlot"],
        home_captain=payload["home"]["captainSlot"],
        # The exporter counts the console's Miis while it is resolving names,
        # so --total-miis is only needed when it could not read the database.
        total_miis=args.total_miis or int(payload.get("miiCount") or 0),
        start_screens=args.start_screens,
        nav_script=args.nav or NAV_PRESETS[args.nav_preset],
        formation_timeout=args.formation_timeout,
        wait_scale=args.wait_scale,
    )

    # Everything runs inside the suppression window, because the moment the
    # game stops maintaining the input word is the only moment writing it does
    # anything. The real remotes are inert until this exits, which is also why
    # it exits on the way out of any failure.
    def stage_nav():
        formation.run_script(args.nav or NAV_PRESETS[args.nav_preset],
                             step=args.step)

    def stage_finalize():
        before = [dme.read_bytes(address, 1)[0]
                  for _, address, _ in finalize_fields(formation)]
        formation.finalize()
        time.sleep(0.1)
        after = [dme.read_bytes(address, 1)[0]
                 for _, address, _ in finalize_fields(formation)]
        print("\nWrote stadium, captains and rules:\n")
        stuck = []
        for (name, address, want), was, now in zip(finalize_fields(formation),
                                                   before, after):
            note = ""
            if now != want:
                note = "  <-- did NOT take"
                stuck.append(name)
            elif was != now:
                note = "  (changed)"
            print(f"  {name:<14} 0x{address:08X}  {was:>3} -> {now:>3}"
                  f"  want {want:>3}{note}")
        if stuck:
            # A byte that reads back wrong was overwritten by the game between
            # the write and the read, which means this screen owns it and is
            # rewriting it every frame -- the same problem the input word had,
            # and the same fix: write it while the screen that reads it is up,
            # not before.
            print(f"\n{len(stuck)} byte(s) did not stick: {', '.join(stuck)}.")
            print("The game is rewriting them, so this screen owns them. Try "
                  "again on the screen that shows the value you are setting.")
        else:
            print("\nAll bytes read back as written. Whether the MENU honours "
                  "them is the next thing to check -- look at the screen.")

    def stage_formation():
        # Locate the blocks BEFORE writing anything. finalize() used to run
        # first, so a failed lookup had already written nine bytes by the time
        # it reported "Nothing was written" -- which was simply untrue, and
        # left the stadium and captains changed after a run that looked like a
        # no-op.
        obj, _, _ = formation.formation_blocks(formation_object)
        formation.finalize()
        formation.apply_formation(object_address=obj)
        print("Wrote both teams into the formation struct.")

    def stage_find_formation():
        """Report what the scan sees without writing anything.

        This is the diagnostic to reach for when --stage formation says it
        found nothing: it prints every block-shaped pair in memory alongside
        the captains being looked for, so "the screen is not up" and "the
        captains disagree" stop looking alike.
        """
        away_captain, home_captain = formation.captain_chars()
        print(f"Looking for away captain char {away_captain}, "
              f"home captain char {home_captain}.\n")
        for strict in (True, False):
            try:
                search = find_formation_object(dme, away_captain, home_captain,
                                               strict=strict,
                                               spacing=args.max_spacing)
            except KeyboardInterrupt:
                print("\n  (stopped early -- nothing was written)")
                return
            print(search.report())
            for candidate in search.found[:10]:
                print(candidate.describe())
            matched = sum(1 for c in search.found if c.has_captains)
            print(f"  {matched} of {len(search.found)} carry both captains.\n")
            if matched:
                break

    stages = {
        "all": lambda: formation.automate(auto_start=not args.no_start),
        "nav": stage_nav,
        "finalize": stage_finalize,
        "watch": lambda: watch_finalize(dme, formation, args.seconds),
        "formation": stage_formation,
        "find-formation": stage_find_formation,
        "miis": formation.select_miis,
        "start": formation.start_game,
        # Standalone, the question is "is a match up right now", so the
        # previous-game guard is off -- there is no run in progress for a
        # leftover ball object to be mistaken for.
        "wait-live": lambda: wait_for_match_live(
            dme, args.wait_for_live or MATCH_LIVE_TIMEOUT,
            require_new=False, hold_driver=formation.driver,
            hold_ready_path=args.hold_until, hold_timeout=args.hold_timeout),
    }

    # Only the stages that press buttons need the input word suppressed, and
    # suppression makes the real remotes inert while it is on. --stage finalize
    # and --stage formation are pure data writes run while you navigate to team
    # select by hand, so taking the remotes away from you there would be a
    # surprise with no upside.
    needs_input = args.stage in ("all", "nav", "miis", "start") or bool(args.p2_join)
    with FlagSuppress(dme, store=TARGET_STORES["held"]) if needs_input else contextlib.nullcontext():
        if args.p2_join:
            print(f"  port {args.p2_port}: sending {args.p2_join!r}")
            formation.driver2.execute(args.p2_join)
        stages[args.stage]()

    # Deliberately OUTSIDE the suppression window. Waiting for the first
    # pitch means waiting through the stadium load and the intro, and
    # suppression makes the real remotes inert for as long as it is held --
    # so waiting inside it would take the controllers away from both
    # players for exactly the stretch where one of them may want to skip
    # something. Everything this run had to press has been pressed by here.
    if args.wait_for_live is not None and args.stage in ("all", "start"):
        # The hold has its own, very short, suppression window around each of
        # its two presses (see hold_opening_play). That is why this call is
        # still outside the run-long suppression: taking the controllers away
        # for the whole stadium load and intro is what the comment above is
        # about, and a hold at the pitch reset is neither of those.
        wait_for_match_live(dme, args.wait_for_live,
                            hold_driver=formation.driver,
                            hold_ready_path=args.hold_until,
                            hold_timeout=args.hold_timeout)

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
