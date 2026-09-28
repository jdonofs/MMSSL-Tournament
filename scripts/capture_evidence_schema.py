"""The comprehensive evidence capture: what is recorded, and who was playing.

CAPTURE SCHEMA VERSIONS. The frame record never changed shape after MSSTRK02,
so every version below reads through player_tracking_io.Session unchanged. What
changed is what the header declares:

    1   MSSTRK01. The state block only. No longer written.
    2   MSSTRK02. State block, nine fielder pointers per frame, and optional
        extra regions appended to every frame in header order. No schema block;
        every session recorded before 2026-09-28 is version 2.
    3   MSSTRK02 plus a `capture_schema` header block naming the evidence
        profile, the region catalogue, the named evidence fields, the session
        metadata (who held which remote), timing statistics and executable
        identity. `standard` captures are v3 with no extra regions beyond v2;
        `comprehensive` captures append the regions in COMPREHENSIVE_REGIONS.

RAW FIRST. Nothing in this module classifies anything. It says which bytes are
recorded, what the public SDK or the vendored tracker calls them, and how sure
anyone is of that name. Interpretation happens offline, against independent
annotations, in scripts that read these captures back.

WHO WAS PLAYING IS NEVER INFERRED. A controller port is not a person, a side is
not a person, and a character is not a person. The game can say which PORT
controls which team (player_type at 0x811F76B0/B1), and that is recorded; which
HUMAN held that port, and which physical remote it was, comes only from the
session metadata file validated below. `python scripts/evidence_preflight.py
map-remotes` writes the remote-to-port half of it from live button presses.

    python scripts/capture_evidence_schema.py --validate-metadata <file.json>
    python scripts/capture_evidence_schema.py --describe
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

CAPTURE_SCHEMA_NAME = "sluggers-player-capture"
CAPTURE_SCHEMA_VERSION = 3
EVIDENCE_PROFILES = ("standard", "comprehensive")

SESSION_METADATA_SCHEMA = "sluggers-evidence-session-metadata"
SESSION_METADATA_VERSION = 1
CAPTURE_SIDES = ("away", "home")
PORTS = ("1", "2", "3", "4")

# The game's controller-port structs: see mss_input.PORT_STRUCTS. Duplicated as
# numbers rather than imported so this module stays importable without the
# collector's dependencies.
INPUT_STRUCT = 0x80784CD8
PORT_STRIDE = 0x538
PORT_BASES = {port: INPUT_STRUCT + (port - 1) * PORT_STRIDE for port in (1, 2, 3, 4)}
SAMPLE_ARRAY_OFFSET = 0x110
SAMPLE_STRIDE = 0x38
SAMPLE_COUNT = 16

# The in_replay byte the vendored tracker reads through a pointer. Resolved once
# at capture start; the pointer slot itself is inside `game_globals`, so a
# pointer that moved mid-session is visible in the capture and the resolved
# region can be distrusted from that frame on.
REPLAY_POINTER_SLOT = 0x80794C5C
REPLAY_POINTER_OFFSET = 0x0013561B
REPLAY_REGION_SIZE = 0x20

# Appended AFTER every region the standard profile records, so the capture
# offset of every older region is identical in both profiles. Contiguous where
# it matters and never overlapping an existing region: an address is recorded
# once, so no field can silently read a second copy of itself.
#
# Sizes were chosen so that the whole appended set costs well under a
# millisecond to read (measured: 128 KB = 0.6 ms on this machine) and almost
# nothing to store when the bytes do not change.
COMPREHENSIVE_REGIONS = (
    {
        "name": "input_globals_pre",
        "base": 0x80784000,
        "size": INPUT_STRUCT - 0x80784000,
        "purpose": "Input-manager globals immediately below port 1: candidate "
                   "shake/cooldown/debounce state and KPAD library globals.",
        "status": "discovery",
    },
    {
        "name": "wiimote_3_input",
        "base": PORT_BASES[3],
        "size": PORT_STRIDE,
        "purpose": "Port 3 KPAD struct. Expected idle; recording it proves no "
                   "third controller acted.",
        "status": "named_layout",
    },
    {
        "name": "wiimote_4_input",
        "base": PORT_BASES[4],
        "size": PORT_STRIDE,
        "purpose": "Port 4 KPAD struct. Expected idle.",
        "status": "named_layout",
    },
    {
        "name": "input_globals_post",
        "base": PORT_BASES[4] + PORT_STRIDE,
        "size": 0x80787800 - (PORT_BASES[4] + PORT_STRIDE),
        "purpose": "Game-side processed input copies (0x807872A0/300/360 carry "
                   "the button bits in a second layout) and their neighbours.",
        "status": "discovery",
    },
    {
        "name": "game_globals",
        "base": 0x80794000,
        "size": 0x1400,
        "purpose": "Match rules (0x80794328..2B), the replay pointer slot "
                   "(0x80794C5C) and the ball pointer slot (0x80795310).",
        "status": "partly_named",
    },
    {
        "name": "match_setup",
        "base": 0x811F7600,
        "size": 0x200,
        "purpose": "Stadium, day/night, team branding and PLAYER TYPE per team "
                   "(which controller port drives it).",
        "status": "partly_named",
    },
    {
        "name": "team_globals",
        "base": 0x81317800,
        "size": 0x4800,
        "purpose": "Both rosters (0x8131B4B9 / 0x8131B9B7, 9 x 0x8E) and the "
                   "input copy at 0x81317BB0.",
        "status": "partly_named",
    },
    {
        "name": "state_extension_low",
        "base": 0x900D0000,
        "size": 0x900D4E00 - 0x900D0000,
        "purpose": "Below the state block. Pitch charge, aim and shake were not "
                   "found inside it; this is the nearest unrecorded memory.",
        "status": "discovery",
    },
    {
        "name": "state_extension_high",
        "base": 0x900DBD40,
        "size": 0x900E0000 - 0x900DBD40,
        "purpose": "Above the state block, through the game timer at "
                   "0x900DFCFC.",
        "status": "discovery",
    },
)

# Named reads for the extractor. Each one says where its name came from, so a
# field copied from the public SDK layout is never mistaken for a field that was
# validated against this game's behaviour.
#   source "public_tracker"  read by the vendored community stat tracker
#   source "kpad_sdk"        public RVL KPADStatus layout; offsets 0x00-0x58
#                            reproduced by the swing-gesture audit, dev/err
#                            bytes checked against four scripted captures
#   source "collector"       identified in this repository (see the collector)
EVIDENCE_FIELDS = (
    ("game_timer_mirror", 0x900DFCFC, ">I", "collector"),
    ("team1_player_type", 0x811F76B0, "B", "public_tracker"),
    ("team2_player_type", 0x811F76B1, "B", "public_tracker"),
    ("team1_branding", 0x811F76AC, "B", "public_tracker"),
    ("team2_branding", 0x811F76AD, "B", "public_tracker"),
    ("team1_batting_or_fielding", 0x900D5C22, "B", "public_tracker"),
    ("team2_batting_or_fielding", 0x900D5C23, "B", "public_tracker"),
    ("team1_pitching_index", 0x900D5CED, "B", "public_tracker"),
    ("team2_pitching_index", 0x900D5CC5, "B", "public_tracker"),
    ("rules_innings", 0x80794328, "B", "public_tracker"),
    ("rules_byte_1", 0x80794329, "B", "public_tracker"),
    ("rules_byte_2", 0x8079432A, "B", "public_tracker"),
    ("rules_byte_3", 0x8079432B, "B", "public_tracker"),
    ("replay_pointer", REPLAY_POINTER_SLOT, ">I", "public_tracker"),
    ("star_cutin_counter", 0x900D4F24, ">H", "collector"),
)
ROSTER_BASES = {"team1": 0x8131B4B9, "team2": 0x8131B9B7}
ROSTER_STRIDE = 0x8E
STAMINA_BASES = {"team1": 0x900D61A0, "team2": 0x900D62C0}
STAMINA_STRIDE = 0x20

# PlayerType in the vendored tracker: 0..3 are human ports 1..4, 0xFF is CPU.
PLAYER_TYPE_CPU = 0xFF

# KPADStatus at the head of each port struct. Offsets 0x00-0x58 are exactly the
# ones the swing-gesture audit decoded; 0x5C-0x5F were checked on 2026-09-28
# against mario_stadium-20260925T165659Z (dev_type 0 = core remote, wpad_err 0,
# data_format 2 on every sampled frame of both ports).
KPAD_FIELDS = (
    ("hold", 0x00, ">I"), ("trig", 0x04, ">I"), ("release", 0x08, ">I"),
    ("acc_x", 0x0C, ">f"), ("acc_y", 0x10, ">f"), ("acc_z", 0x14, ">f"),
    ("acc_value", 0x18, ">f"), ("acc_speed", 0x1C, ">f"),
    ("pos_x", 0x20, ">f"), ("pos_y", 0x24, ">f"),
    ("dev_type", 0x5C, "B"), ("wpad_err", 0x5D, "b"),
    ("dpd_valid", 0x5E, "b"), ("data_format", 0x5F, "B"),
)
# First WPAD sample in the 16-entry ring: button word then raw accelerometer.
RAW_SAMPLE_FIELDS = (
    ("button", 0x00, ">H"), ("acc_x", 0x02, ">h"), ("acc_y", 0x04, ">h"),
    ("acc_z", 0x06, ">h"),
)
# KPAD dev_type values that mean "no usable controller in this port".
KPAD_DEVICE_ABSENT = {0xFD, 0xFE, 0xFF}

WPAD_BUTTONS = {
    "left": 0x0001, "right": 0x0002, "down": 0x0004, "up": 0x0008,
    "plus": 0x0010, "two": 0x0100, "one": 0x0200, "b": 0x0400, "a": 0x0800,
    "minus": 0x1000, "home": 0x8000,
}


def button_names(mask: int) -> list[str]:
    return [name for name, bit in WPAD_BUTTONS.items() if mask & bit]


def comprehensive_regions() -> list[tuple[str, int, int]]:
    return [(r["name"], r["base"], r["size"]) for r in COMPREHENSIVE_REGIONS]


def replay_region(pointer: int) -> tuple[str, int, int] | None:
    """The in_replay region for a pointer value, or None if it is not memory."""
    target = pointer + REPLAY_POINTER_OFFSET
    in_mem1 = 0x80000000 <= target < 0x81800000
    in_mem2 = 0x90000000 <= target < 0x94000000
    if not pointer or not (in_mem1 or in_mem2):
        return None
    base = target & ~0xF
    return ("replay_state", base, REPLAY_REGION_SIZE)


def region_overlaps(regions) -> list[tuple[str, str]]:
    """Every pair of regions that share an address. Must be empty."""
    spans = sorted((base, base + size, name) for name, base, size in regions)
    clashes = []
    for index, (start, end, name) in enumerate(spans):
        for other_start, other_end, other in spans[index + 1:]:
            if other_start >= end:
                break
            clashes.append((name, other))
    return clashes


def capture_layout(state_base: int, state_size: int, extra_regions) -> list[dict]:
    """Where each region lands inside one reconstructed frame block."""
    layout = [{"name": "state_block", "base": state_base, "size": state_size,
               "frame_offset": 0}]
    cursor = state_size
    for name, base, size in extra_regions:
        layout.append({"name": name, "base": base, "size": size,
                       "frame_offset": cursor})
        cursor += size
    return layout


def field_offset(address: int, size: int, state_base: int, state_size: int,
                 extra_regions) -> int | None:
    """Frame offset of a field that lies wholly inside ONE recorded region.

    A field straddling a region edge returns None rather than reading into the
    next region's bytes -- that would be exactly the silent alias this schema
    exists to rule out.
    """
    if state_base <= address and address + size <= state_base + state_size:
        return address - state_base
    cursor = state_size
    for _, base, region_size in extra_regions:
        if base <= address and address + size <= base + region_size:
            return cursor + (address - base)
        cursor += region_size
    return None


def bytes_per_frame(state_size: int, extra_regions) -> int:
    return state_size + sum(size for _, _, size in extra_regions)


# ---------------------------------------------------------------------------
# Session metadata: the explicit statement of who held which remote.


class MetadataError(ValueError):
    pass


def validate_session_metadata(payload) -> list[str]:
    """Every reason this metadata cannot be recorded against a capture.

    Empty means valid. Nothing here fills a gap: a missing player is an error,
    not a default, because the whole point of the file is that the mapping is
    stated rather than guessed.
    """
    errors = []
    if not isinstance(payload, dict):
        return ["metadata must be a JSON object"]
    if payload.get("schema") != SESSION_METADATA_SCHEMA:
        errors.append(f"schema must be {SESSION_METADATA_SCHEMA!r}")
    if payload.get("version") != SESSION_METADATA_VERSION:
        errors.append(f"version must be {SESSION_METADATA_VERSION}")
    if not str(payload.get("session_label") or "").strip():
        errors.append("session_label is required")
    ports = payload.get("ports")
    if not isinstance(ports, dict) or not ports:
        errors.append("ports must name at least one controller port")
        return errors
    labels = {}
    sides = {}
    for port, entry in ports.items():
        where = f"ports[{port!r}]"
        if port not in PORTS:
            errors.append(f"{where}: port must be one of {', '.join(PORTS)}")
            continue
        if not isinstance(entry, dict):
            errors.append(f"{where} must be an object")
            continue
        for key in ("player", "remote_label"):
            if not str(entry.get(key) or "").strip():
                errors.append(f"{where}.{key} is required")
        label = str(entry.get("remote_label") or "").strip()
        if label.upper().startswith("REPLACE"):
            errors.append(f"{where}.remote_label is still the example placeholder; "
                          "run evidence_preflight.py map-remotes")
        elif label:
            if label in labels:
                errors.append(f"{where}.remote_label {label!r} is also port "
                              f"{labels[label]}'s; physical remotes must be distinct")
            labels[label] = port
        side = entry.get("expected_capture_side")
        if side is not None:
            if side not in CAPTURE_SIDES:
                errors.append(f"{where}.expected_capture_side must be away, home or null")
            elif side in sides:
                errors.append(f"{where}.expected_capture_side {side!r} is also "
                              f"port {sides[side]}'s")
            else:
                sides[side] = port
        if "nunchuk" in entry and not isinstance(entry["nunchuk"], bool):
            errors.append(f"{where}.nunchuk must be true or false")
    changes = payload.get("control_changes", [])
    if not isinstance(changes, list):
        errors.append("control_changes must be a list")
    else:
        for index, change in enumerate(changes):
            where = f"control_changes[{index}]"
            if not isinstance(change, dict):
                errors.append(f"{where} must be an object")
                continue
            at = change.get("at") or {}
            if not isinstance(at.get("inning"), int) or at.get("half") not in ("top", "bottom"):
                errors.append(f"{where}.at needs an integer inning and half top|bottom")
            if not isinstance(change.get("ports"), dict) or not change["ports"]:
                errors.append(f"{where}.ports must restate who holds each changed port")
    return errors


def load_session_metadata(path) -> dict:
    """Read, validate and fingerprint a metadata file, or raise MetadataError."""
    path = Path(path)
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise MetadataError(f"cannot read session metadata {path}: {error}") from None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MetadataError(f"session metadata {path} is not JSON: {error}") from None
    errors = validate_session_metadata(payload)
    if errors:
        raise MetadataError(f"session metadata {path} is invalid:\n  - "
                            + "\n  - ".join(errors))
    return {"path": str(path.resolve()), "sha256": hashlib.sha256(raw).hexdigest(),
            "content": payload}


def port_for_player_type(value: int | None) -> int | None:
    """0..3 -> port 1..4; CPU or unknown -> None. Never guesses a port."""
    if value is None or value == PLAYER_TYPE_CPU or not 0 <= value <= 3:
        return None
    return value + 1


def side_ports_from_memory(team1_player_type, team2_player_type,
                           team1_batting_or_fielding, inning_half) -> dict:
    """Which port drives the capture's away and home sides, from memory only.

    `away` in a capture is the side batting in half 0. team1 is batting when its
    byte reads 0. Any unreadable input leaves the answer null.
    """
    if None in (team1_player_type, team2_player_type,
                team1_batting_or_fielding, inning_half):
        return {"away": None, "home": None, "basis": "unobserved"}
    if team1_batting_or_fielding not in (0, 1) or inning_half not in (0, 1):
        return {"away": None, "home": None, "basis": "unrecognised_bytes"}
    team1_batting = team1_batting_or_fielding == 0
    team1_is_away = team1_batting == (inning_half == 0)
    team1_port = port_for_player_type(team1_player_type)
    team2_port = port_for_player_type(team2_player_type)
    return {
        "away": team1_port if team1_is_away else team2_port,
        "home": team2_port if team1_is_away else team1_port,
        "basis": "player_type_and_batting_byte",
    }


def compare_declared_sides(metadata_content: dict | None, observed: dict) -> dict:
    """Declared expected_capture_side per port against the memory reading."""
    if not metadata_content:
        return {"status": "no_metadata", "mismatches": []}
    declared = {entry.get("expected_capture_side"): int(port)
                for port, entry in (metadata_content.get("ports") or {}).items()
                if entry.get("expected_capture_side") in CAPTURE_SIDES}
    if observed.get("away") is None and observed.get("home") is None:
        return {"status": "unobserved", "mismatches": []}
    if not declared:
        return {"status": "not_declared", "mismatches": []}
    mismatches = [{"side": side, "declared_port": port, "memory_port": observed.get(side)}
                  for side, port in declared.items() if observed.get(side) != port]
    return {"status": "mismatch" if mismatches else "agrees", "mismatches": mismatches}


def schema_block(*, profile: str, state_base: int, state_size: int, extra_regions,
                 metadata: dict | None, replay: dict | None) -> dict:
    """The header block that makes a capture self-describing at version 3."""
    catalogue = {r["name"]: r for r in COMPREHENSIVE_REGIONS}
    return {
        "name": CAPTURE_SCHEMA_NAME,
        "version": CAPTURE_SCHEMA_VERSION,
        "profile": profile,
        "frame_record": "MSSTRK02: >I timer, >d elapsed_s, >I ball_pointer, "
                        "3x>f ball, 9x>I fielder pointers, XOR delta of the frame block",
        "bytes_per_frame": bytes_per_frame(state_size, extra_regions),
        "layout": [
            dict(entry, purpose=catalogue.get(entry["name"], {}).get("purpose"),
                 status=catalogue.get(entry["name"], {}).get("status"))
            for entry in capture_layout(state_base, state_size, extra_regions)
        ],
        "region_overlaps": [list(pair) for pair in region_overlaps(
            [("state_block", state_base, state_size), *extra_regions])],
        "evidence_fields": [[name, address, fmt, source]
                            for name, address, fmt, source in EVIDENCE_FIELDS],
        "roster_bases": ROSTER_BASES, "roster_stride": ROSTER_STRIDE,
        "stamina_bases": STAMINA_BASES, "stamina_stride": STAMINA_STRIDE,
        "kpad_fields": [list(field) for field in KPAD_FIELDS],
        "kpad_raw_sample": {"offset": SAMPLE_ARRAY_OFFSET, "stride": SAMPLE_STRIDE,
                            "count": SAMPLE_COUNT,
                            "fields": [list(field) for field in RAW_SAMPLE_FIELDS]},
        "port_bases": {str(port): base for port, base in PORT_BASES.items()},
        "replay": replay,
        "session_metadata": metadata,
        "raw_first": "No field in this capture is a derived label. Missing "
                     "evidence is absent, never zero.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--validate-metadata", metavar="FILE")
    parser.add_argument("--describe", action="store_true",
                        help="print the comprehensive region catalogue and its size")
    args = parser.parse_args()
    if args.validate_metadata:
        try:
            loaded = load_session_metadata(args.validate_metadata)
        except MetadataError as error:
            print(str(error), file=sys.stderr)
            return 2
        ports = loaded["content"]["ports"]
        print(json.dumps({"valid": True, "sha256": loaded["sha256"],
                          "ports": {port: {k: entry.get(k) for k in
                                           ("player", "remote_label", "expected_capture_side")}
                                    for port, entry in sorted(ports.items())}}))
        return 0
    if args.describe:
        regions = comprehensive_regions()
        for name, base, size in regions:
            print(f"{name:22s} 0x{base:08X}..0x{base + size:08X}  {size:6d} B")
        print(f"appended per frame: {sum(size for _, _, size in regions)} B "
              f"(+{REPLAY_REGION_SIZE} B replay region when its pointer resolves)")
        clashes = region_overlaps(regions)
        print("overlaps:", clashes or "none")
        return 1 if clashes else 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
