"""Add structured batting-order and defensive-alignment records to the tracker.

The community tracker is distributed as a Python 3.13 PyInstaller executable.
Its team objects contain both batting orders as soon as a game is initialized,
while ``__set_starting_lineup`` later receives the authoritative defensive map.
The stock build exposes neither in machine-readable output. This utility
replaces the two relevant embedded functions and rebuilds the PyInstaller
CArchive while leaving every other bundled entry byte-for-byte unchanged.

Run this script with Python 3.13 (the bytecode version used by the tracker):

    python scripts/patch_tracker_lineup_feed.py INPUT.exe OUTPUT.exe
"""

from __future__ import annotations

import argparse
import marshal
import os
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from types import CodeType


COOKIE_MAGIC = b"MEI\014\013\012\013\016"
COOKIE_FORMAT = "!8sIIII64s"
COOKIE_LENGTH = struct.calcsize(COOKIE_FORMAT)
TOC_ENTRY_FORMAT = "!IIIIBc"
TOC_ENTRY_LENGTH = struct.calcsize(TOC_ENTRY_FORMAT)
TARGET_ENTRY = "stat_tracker"
TARGET_FUNCTIONS = {"_refresh_game_values", "__set_starting_lineup"}
BATTING_MARKER = "[TRACKER_BATTING]"
LINEUP_MARKER = "[TRACKER_LINEUP]"


@dataclass(frozen=True)
class TocEntry:
    name: str
    offset: int
    data_length: int
    uncompressed_length: int
    compression_flag: int
    typecode: bytes
    entry_length: int


def parse_toc(data: bytes) -> list[TocEntry]:
    entries: list[TocEntry] = []
    cursor = 0
    while cursor < len(data):
        header = data[cursor : cursor + TOC_ENTRY_LENGTH]
        if len(header) != TOC_ENTRY_LENGTH:
            raise ValueError("Truncated PyInstaller TOC entry")
        entry_length, offset, data_length, raw_length, compressed, typecode = struct.unpack(
            TOC_ENTRY_FORMAT, header
        )
        name_length = entry_length - TOC_ENTRY_LENGTH
        name_bytes = data[cursor + TOC_ENTRY_LENGTH : cursor + entry_length]
        name = name_bytes.rstrip(b"\0").decode("utf-8")
        entries.append(
            TocEntry(
                name=name,
                offset=offset,
                data_length=data_length,
                uncompressed_length=raw_length,
                compression_flag=compressed,
                typecode=typecode,
                entry_length=entry_length,
            )
        )
        cursor += entry_length
    return entries


def compile_replacements() -> dict[str, CodeType]:
    source = r'''
def _refresh_game_values(game, team1, team2):
    game.current_batter.index.refresh()
    game.current_batter.refresh_all()
    game.current_pitcher.refresh_all()
    team1.pitching_index.refresh()
    team2.pitching_index.refresh()
    team1.meter.refresh()
    team2.meter.refresh()
    game.outs.refresh()
    game.balls.refresh()
    game.strikes.refresh()
    game.current_inning.refresh()
    game.pitches.refresh()
    team1.score.refresh()
    team2.score.refresh()
    game.ball_was_hit.refresh()
    game.batters_this_inning.refresh()
    game.ball_possession.refresh_all()
    game.this_pitch.refresh_all()
    game.star_costs.refresh_all()
    game.left_field_buddy_jump_flag.refresh()
    game.center_field_buddy_jump_flag.refresh()
    game.right_field_buddy_jump_flag.refresh()
    game.left_field_airborne_flag.refresh()
    game.center_field_airborne_flag.refresh()
    game.right_field_airborne_flag.refresh()
    game.baserunners.refresh_all()
    game.home_run_flag.refresh()

    emitted = globals().setdefault("_tracker_batting_emitted_team_ids", set())
    for team in (team1, team2):
        team_key = id(team)
        if team_key not in emitted:
            batting = ",".join(player.name for player in team.players)
            if len(team.players) == 9:
                log.debug(
                    f"[TRACKER_BATTING] team={team.short_name}|batting={batting}"
                )
                emitted.add(team_key)

def __set_starting_lineup(game, team):
    """Capture and announce the authoritative in-memory starting alignment."""
    game.def_positions.refresh_all()
    game.set_def_positions()
    lineup = game.def_positions.get_all_players_at_positions()
    team.starting_lineup = lineup

    batting = ",".join(player.name for player in team.players)
    position_players = {position: player.name for player, position in lineup.items()}
    position_order = ("P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF")
    fielding = ",".join(
        f"{position}={position_players.get(position, '')}" for position in position_order
    )
    log.debug(
        f"[TRACKER_LINEUP] team={team.short_name}|batting={batting}|fielding={fielding}"
    )
    log.debug(f"{team.short_name} Starting Lineup Set!")
    team.starting_lineup_set = True
'''
    module = compile(source, "stat_tracker.py", "exec")
    functions = {
        item.co_name: item for item in module.co_consts if isinstance(item, CodeType)
    }
    if functions.keys() != TARGET_FUNCTIONS:
        raise RuntimeError("Could not compile both tracker-feed replacement functions")
    return functions


def replace_nested_code(
    code: CodeType, replacements_by_name: dict[str, CodeType]
) -> tuple[CodeType, dict[str, int]]:
    replacement_counts = {name: 0 for name in replacements_by_name}
    constants = []
    for item in code.co_consts:
        if isinstance(item, CodeType):
            if item.co_name in replacements_by_name:
                constants.append(replacements_by_name[item.co_name])
                replacement_counts[item.co_name] += 1
            else:
                next_item, nested_counts = replace_nested_code(item, replacements_by_name)
                constants.append(next_item)
                for name, count in nested_counts.items():
                    replacement_counts[name] += count
        else:
            constants.append(item)
    if any(replacement_counts.values()):
        code = code.replace(co_consts=tuple(constants))
    return code, replacement_counts


def patch_marshaled_module(raw_module: bytes) -> bytes:
    code = marshal.loads(raw_module)
    if not isinstance(code, CodeType):
        raise TypeError("The embedded stat_tracker entry is not a Python code object")
    constants_repr = repr(code.co_consts)
    if BATTING_MARKER in constants_repr and LINEUP_MARKER in constants_repr:
        return raw_module

    patched, counts = replace_nested_code(code, compile_replacements())
    if any(counts.get(name) != 1 for name in TARGET_FUNCTIONS):
        raise RuntimeError(
            f"Expected one of each {sorted(TARGET_FUNCTIONS)}, found {counts}; tracker build is unsupported"
        )
    return marshal.dumps(patched)


def encode_toc_entry(entry: TocEntry, offset: int, payload: bytes, raw_length: int) -> bytes:
    name = entry.name.encode("utf-8")
    minimum_length = TOC_ENTRY_LENGTH + len(name) + 1
    entry_length = (minimum_length + 15) & ~15
    padding = b"\0" * (entry_length - TOC_ENTRY_LENGTH - len(name))
    return struct.pack(
        TOC_ENTRY_FORMAT,
        entry_length,
        offset,
        len(payload),
        raw_length,
        entry.compression_flag,
        entry.typecode,
    ) + name + padding


def patch_executable(source: Path, destination: Path) -> None:
    executable = source.read_bytes()
    cookie_offset = executable.rfind(COOKIE_MAGIC)
    if cookie_offset < 0:
        raise ValueError(f"{source} does not contain a PyInstaller CArchive cookie")

    cookie_end = cookie_offset + COOKIE_LENGTH
    magic, archive_length, toc_offset, toc_length, py_version, py_lib = struct.unpack(
        COOKIE_FORMAT, executable[cookie_offset:cookie_end]
    )
    archive_start = cookie_end - archive_length
    if archive_start < 0:
        raise ValueError("Invalid PyInstaller archive length")

    toc_start = archive_start + toc_offset
    entries = parse_toc(executable[toc_start : toc_start + toc_length])
    if sum(entry.name == TARGET_ENTRY for entry in entries) != 1:
        raise RuntimeError(f"Could not uniquely locate embedded {TARGET_ENTRY!r}")

    payloads: list[tuple[TocEntry, bytes, int]] = []
    for entry in entries:
        payload = executable[
            archive_start + entry.offset : archive_start + entry.offset + entry.data_length
        ]
        raw_length = entry.uncompressed_length
        if entry.name == TARGET_ENTRY:
            raw = zlib.decompress(payload) if entry.compression_flag else payload
            patched_raw = patch_marshaled_module(raw)
            payload = zlib.compress(patched_raw, level=9) if entry.compression_flag else patched_raw
            raw_length = len(patched_raw)
        payloads.append((entry, payload, raw_length))

    data_parts: list[bytes] = []
    toc_parts: list[bytes] = []
    data_offset = 0
    for entry, payload, raw_length in payloads:
        data_parts.append(payload)
        toc_parts.append(encode_toc_entry(entry, data_offset, payload, raw_length))
        data_offset += len(payload)

    archive_data = b"".join(data_parts)
    new_toc = b"".join(toc_parts)
    new_toc_offset = len(archive_data)
    new_archive_length = len(archive_data) + len(new_toc) + COOKIE_LENGTH
    new_cookie = struct.pack(
        COOKIE_FORMAT,
        magic,
        new_archive_length,
        new_toc_offset,
        len(new_toc),
        py_version,
        py_lib,
    )

    rebuilt = (
        executable[:archive_start]
        + archive_data
        + new_toc
        + new_cookie
        + executable[cookie_end:]
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(rebuilt)

    # Re-open the rebuilt archive enough to prove its cookie/TOC and patched
    # stat_tracker payload are internally consistent before declaring success.
    verify_cookie = rebuilt.rfind(COOKIE_MAGIC)
    _, verify_length, verify_toc_offset, verify_toc_length, _, _ = struct.unpack(
        COOKIE_FORMAT, rebuilt[verify_cookie : verify_cookie + COOKIE_LENGTH]
    )
    verify_start = verify_cookie + COOKIE_LENGTH - verify_length
    verify_entries = parse_toc(
        rebuilt[
            verify_start + verify_toc_offset :
            verify_start + verify_toc_offset + verify_toc_length
        ]
    )
    target = next(entry for entry in verify_entries if entry.name == TARGET_ENTRY)
    target_payload = rebuilt[
        verify_start + target.offset : verify_start + target.offset + target.data_length
    ]
    target_raw = zlib.decompress(target_payload) if target.compression_flag else target_payload
    if BATTING_MARKER.encode() not in target_raw or LINEUP_MARKER.encode() not in target_raw:
        raise RuntimeError("Rebuilt executable did not retain both tracker-feed markers")

    try:
        source_mode = source.stat().st_mode
        os.chmod(destination, source_mode)
    except OSError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    if args.source.resolve() == args.destination.resolve():
        raise SystemExit("Refusing to overwrite the source tracker; choose a separate output path")
    patch_executable(args.source, args.destination)
    print(f"Patched tracker written to {args.destination}")


if __name__ == "__main__":
    main()
