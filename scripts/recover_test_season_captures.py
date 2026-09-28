"""Recover TEST games by ending their recordings before menu pointers go stale.

The untouched originals are copied to .pre-recovery.* beside each file. Without
--apply this scans and reports the first invalid fielder pointer only.
"""

import argparse
import hashlib
import json
import shutil
import struct
import zlib
from pathlib import Path


FRAME_MAGIC = b"MSSTRK02"
FRAME_HEADER = ">IdI"
FRAME_HEADER_SIZE = struct.calcsize(FRAME_HEADER)
TARGETS = {2767: 680.0, 2768: 595.0,  # seconds since collector start; final scores precede these
           # The tracker printed "Final Score:" at 00:30:55 and 00:48:23 UTC, 494.5 s and
           # 708.7 s after these collectors launched; P read 0 about 20 s and 17 s later.
           2813: 494.0, 2814: 708.0}


def recover(game_id: int, apply: bool) -> None:
    manifest_path = Path(f"data/player_tracking/season-{game_id}.manifest.json")
    manifest = json.loads(manifest_path.read_text())
    header_path = Path(manifest["header_path"])
    header = json.loads(header_path.read_text())
    stream_path = Path(manifest["stream_path"])
    if str(header.get("game_id")) != str(game_id) or str(manifest.get("game_id")) != str(game_id):
        raise ValueError(f"game {game_id}: capture identity does not match")
    if manifest["status"] not in ("recording", "captured"):
        raise ValueError(f"game {game_id}: unexpected manifest status {manifest['status']}")
    state_base = header["state_base"]
    state_end = state_base + header["state_size"]
    stride = header["actors"]["fielders"][0]["stride"]
    temp_path = stream_path.with_suffix(".recovered.tmp")
    compressor = zlib.compressobj(6) if apply else None
    frames = missed = 0
    last_timer = last_elapsed = None
    first_bad = None
    decoder = zlib.decompressobj()
    buffer = bytearray()

    with stream_path.open("rb") as source:
        if source.read(len(FRAME_MAGIC)) != FRAME_MAGIC:
            raise ValueError(f"game {game_id}: bad stream magic")
        destination = temp_path.open("wb") if apply else None
        try:
            if destination:
                destination.write(FRAME_MAGIC)
            while True:
                chunk = source.read(1 << 20)
                buffer.extend(decoder.decompress(chunk) if chunk else decoder.flush())
                while len(buffer) >= 4:
                    (length,) = struct.unpack_from(">I", buffer)
                    if length != FRAME_HEADER_SIZE + 12 + 36 + header["capture_size"]:
                        raise ValueError(f"game {game_id}: unexpected frame size {length}")
                    if len(buffer) < 4 + length:
                        break
                    record = bytes(buffer[4:4 + length])
                    del buffer[:4 + length]
                    timer, elapsed, _ = struct.unpack_from(FRAME_HEADER, record)
                    pointers = struct.unpack_from(">9I", record, FRAME_HEADER_SIZE + 12)
                    invalid = next((i for i, pointer in enumerate(pointers)
                                    if not state_base <= pointer <= state_end - stride), None)
                    if invalid is not None:
                        first_bad = (frames + 1, round(elapsed, 3), invalid, pointers[invalid])
                        break
                    if last_timer is not None and timer > last_timer + 1:
                        missed += timer - last_timer - 1
                    last_timer, last_elapsed = timer, elapsed
                    frames += 1
                    if destination:
                        destination.write(compressor.compress(struct.pack(">I", length) + record))
                if first_bad or not chunk:
                    break
            if destination:
                destination.write(compressor.flush())
        finally:
            if destination:
                destination.close()

    print(f"game {game_id}: {frames} valid frames through {last_elapsed:.2f}s; "
          f"first invalid pointer {first_bad}; source zlib EOF={decoder.eof}; missed={missed}")
    stopped_at_unclean_end = manifest["status"] == "recording" and not decoder.eof
    if not (first_bad or stopped_at_unclean_end) or last_elapsed is None or last_elapsed < TARGETS[game_id]:
        if apply:
            temp_path.unlink(missing_ok=True)
        raise ValueError(f"game {game_id}: no safe cutoff after the final score")
    if not apply:
        return

    digest = hashlib.sha256()
    with temp_path.open("rb") as recovered_stream:
        for chunk in iter(lambda: recovered_stream.read(1 << 20), b""):
            digest.update(chunk)
    checksum = digest.hexdigest()
    backup_paths = [
        (stream_path, stream_path.with_suffix(".pre-recovery.bin")),
        (header_path, header_path.with_suffix(".pre-recovery.json")),
        (manifest_path, manifest_path.with_suffix(".pre-recovery.manifest.json")),
    ]
    if any(backup.exists() for _, backup in backup_paths):
        raise ValueError(f"game {game_id}: backup already exists; refusing to overwrite")
    for original, backup in backup_paths:
        shutil.copy2(original, backup)
    header.update(frames=frames, missed_frames=missed,
                  duration_seconds=round(last_elapsed, 3), checksum_sha256=checksum,
                  fielder_pointers_left_region=False)
    header["capture_recovery"] = {
        "reason": ("trimmed at first out-of-region fielder pointer after final score"
                   if first_bad else "closed unclean zlib stream at last complete frame after final score"),
        "original_stream": str(backup_paths[0][1]),
        "first_invalid_frame": first_bad[0] if first_bad else None,
        "first_invalid_elapsed_seconds": first_bad[1] if first_bad else None,
    }
    manifest.update(status="captured", frames=frames, missed_frames=missed,
                    duration_seconds=round(last_elapsed, 3), checksum_sha256=checksum,
                    fielder_pointers_left_region=False, capture_recovery=header["capture_recovery"])
    temp_path.replace(stream_path)
    header_path.write_text(json.dumps(header, indent=2))
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"game {game_id}: recovered stream committed; originals retained beside it")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--game", type=int, action="append", choices=sorted(TARGETS))
    args = parser.parse_args()
    for target in args.game or TARGETS:
        recover(target, args.apply)
