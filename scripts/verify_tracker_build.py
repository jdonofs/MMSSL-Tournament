"""Verify a built tracker exe embeds exactly the current patch source.

A rebuild that silently produced nothing new is indistinguishable from a real
one by eye, and testing against a stale executable burns whole debugging
sessions chasing behaviour in code that was never running (this happened from
v14 through v19, which were byte-identical). Comparing file size or MD5 against
the previous build only answers "did anything change", not "is this what the
source says now" -- a rebuild after an unrelated edit still differs. So compare
the code objects actually embedded in the executable against the ones
compile_replacements() produces right now:

    python scripts/verify_tracker_build.py path/to/tracker.exe

Exits non-zero, naming each function, when the executable is not built from the
current source. Run this with Python 3.13, the bytecode version the tracker
uses.
"""
from __future__ import annotations

import marshal
import struct
import sys
import zlib
from pathlib import Path
from types import CodeType

sys.path.insert(0, str(Path(__file__).resolve().parent))

from patch_tracker_advanced_stats import compile_replacements  # noqa: E402
from patch_tracker_lineup_feed import (  # noqa: E402
    COOKIE_FORMAT,
    COOKIE_LENGTH,
    COOKIE_MAGIC,
    TARGET_ENTRY,
    parse_toc,
)


def embedded_functions(path: Path) -> dict[str, CodeType]:
    exe = path.read_bytes()
    off = exe.rfind(COOKIE_MAGIC)
    _, alen, toc_off, toc_len, _, _ = struct.unpack(COOKIE_FORMAT, exe[off : off + COOKIE_LENGTH])
    start = off + COOKIE_LENGTH - alen
    entries = parse_toc(exe[start + toc_off : start + toc_off + toc_len])
    entry = next(e for e in entries if e.name == TARGET_ENTRY)
    payload = exe[start + entry.offset : start + entry.offset + entry.data_length]
    raw = zlib.decompress(payload) if entry.compression_flag else payload
    code = marshal.loads(raw)

    found: dict[str, CodeType] = {}

    def walk(item: CodeType) -> None:
        for const in item.co_consts:
            if isinstance(const, CodeType):
                found.setdefault(const.co_name, const)
                walk(const)

    walk(code)
    return found


def signature(code: CodeType) -> tuple:
    """Structural identity of a code object, recursing into nested code."""
    return (
        code.co_name,
        code.co_code,
        code.co_names,
        code.co_varnames,
        tuple(
            signature(c) if isinstance(c, CodeType) else repr(c)
            for c in code.co_consts
        ),
    )


def main() -> int:
    exe = Path(sys.argv[1])
    expected = compile_replacements()
    embedded = embedded_functions(exe)
    ok = True
    for name, want in expected.items():
        have = embedded.get(name)
        if have is None:
            print(f"MISSING  {name}")
            ok = False
        elif signature(have) != signature(want):
            print(f"STALE    {name}  (exe does not match current source)")
            ok = False
        else:
            print(f"CURRENT  {name}")
    print("\nRESULT:", "exe matches current source" if ok else "exe is NOT built from current source")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
