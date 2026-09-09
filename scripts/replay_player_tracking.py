"""Replay a recorded session through the LIVE derivation path and compare.

    python scripts/replay_player_tracking.py data/player_tracking/<session>
    python scripts/replay_player_tracking.py data/player_tracking/<session> \
      --postgame tmp/rederived.plays.jsonl --live-out tmp/live.plays.jsonl
    python scripts/replay_player_tracking.py --all

WHAT THIS PROVES, AND WHY IT IS NEEDED. Live derivation and the postgame pass
share a state machine, but they do not share everything: live picks its position
offset up front instead of scoring it over the whole session, reads its scalar
list from the collector's own table rather than the recorded header, and closes
each play at the dead ball instead of at the end of a file. Any of those could
make the two disagree, and the disagreement would show up as a live page that
looks fine and a postgame row that says something else.

So this feeds a recorded .bin through LiveDerivation exactly as the collector
will -- same builder inputs, same seeded offset, same emit-at-dead-ball -- and
diffs the result against the .plays.jsonl the authoritative pass produced. It
needs no emulator, no controller and no new game.

It also reports the two numbers the live path is actually at risk from: the
per-frame cost of deriving (against a 16.6 ms budget) and the worst per-play
cost at the dead ball, which bounds how long after the dead ball a play can
take to appear.

It does NOT measure emission latency in frames. Frames go by here as fast as
they decode, which is roughly nine times real speed, so a frame count from this
harness would say nothing about a real capture. benchmark_live_derivation.py
paces against a wall clock and answers that question properly.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import collect_player_tracking as collector
from derive_player_metrics import GAME_FRAME_RATE
from player_live_derivation import LiveDerivation
from player_tracking_io import Session

DATA = Path(__file__).resolve().parent.parent / "data" / "player_tracking"

# Fields the live pass adds to say what it is. They are not part of the shared
# derivation and are excluded from the comparison rather than being allowed to
# fail it.
LIVE_ONLY_KEYS = {"derivation", "position_offset"}


def replay(stem: Path, fps: float = GAME_FRAME_RATE,
           live_out: Path | None = None) -> dict:
    """Run one recorded session through the live path."""
    session = Session(stem)
    actors = ([dict(a, kind="fielder") for a in session.fielders]
              + [dict(a, kind="offense") for a in session.offense])
    live = LiveDerivation(
        state_base=session.state_base,
        actors=actors,
        fields=session.fields,
        # The collector's own table, not the recorded header's -- this is what
        # the live path will really read, so it is what gets tested.
        state_fields=[[n, a, f] for n, a, f in collector.STATE_FIELDS],
        out_path=live_out,
        position_offset=session.header.get("live_position_offset", 0x004),
        fps=fps,
        state_size=session.state_size,
        extra_regions=session.extra_regions,
        barrel_address=session.header.get(
            "barrel_position", collector.BARREL_POSITION),
        barrel_cannons=[tuple(c) for c in session.header.get(
            "barrel_cannons", collector.BARREL_CANNONS)],
        park=session.header.get("park"),
    )
    plays = []
    for frame in session.frames():
        plays.extend(live.feed(frame.timer, frame.ball, frame.block,
                               frame.fielder_pointers))
    plays.extend(live.close())
    return {"plays": plays, "status": live.status()}


def compare(live_plays: list, postgame_plays: list) -> list:
    """Every way the two derivations disagree, in plain language."""
    problems = []
    if len(live_plays) != len(postgame_plays):
        problems.append(
            f"play count: live {len(live_plays)}, postgame {len(postgame_plays)}")
    by_timer = {play["contact_timer"]: play for play in postgame_plays}
    for play in live_plays:
        timer = play["contact_timer"]
        reference = by_timer.get(timer)
        if reference is None:
            problems.append(f"live play at contact_timer {timer} has no postgame match")
            continue
        for key in sorted(set(play) | set(reference)):
            if key in LIVE_ONLY_KEYS:
                continue
            left, right = play.get(key), reference.get(key)
            if not _same(left, right):
                problems.append(
                    f"contact_timer {timer}: {key} live={_short(left)} "
                    f"postgame={_short(right)}")
    for timer in by_timer:
        if not any(play["contact_timer"] == timer for play in live_plays):
            problems.append(f"postgame play at contact_timer {timer} was never emitted live")
    return problems


def _same(left, right) -> bool:
    if isinstance(left, float) and isinstance(right, float):
        return math.isclose(left, right, rel_tol=0, abs_tol=1e-9)
    if isinstance(left, dict) and isinstance(right, dict):
        return (set(left) == set(right)
                and all(_same(left[k], right[k]) for k in left))
    if isinstance(left, list) and isinstance(right, list):
        return (len(left) == len(right)
                and all(_same(a, b) for a, b in zip(left, right)))
    return left == right


def _short(value) -> str:
    text = json.dumps(value, default=str)
    return text if len(text) <= 90 else text[:87] + "..."


def run_session(stem: Path, quiet: bool = False,
                postgame_path: Path | None = None,
                live_out: Path | None = None) -> bool:
    postgame_path = postgame_path or Path(str(stem) + ".plays.jsonl")
    if not postgame_path.exists():
        print(f"  {stem.name}: no .plays.jsonl to compare against -- run "
              f"derive_player_metrics.py first")
        return False
    postgame = [json.loads(line)
                for line in postgame_path.read_text().splitlines() if line.strip()]
    result = replay(stem, live_out=live_out)
    status = result["status"]
    problems = compare(result["plays"], postgame)

    print(f"\n{stem.name}")
    print(f"  live plays {len(result['plays']):>4}   postgame {len(postgame):>4}   "
          f"calibration {status['calibration_status']} "
          f"(+0x{status['position_offset']:03X}, {status['lock_frames']} locks)")
    print(f"  derivation cost   {status['mean_feed_ms']:.4f} ms/frame mean, "
          f"{status['max_feed_ms']:.1f} ms worst frame, "
          f"{status['max_play_build_ms']:.0f} ms worst play")
    # Emission latency is NOT measured here, deliberately. This harness feeds
    # frames as fast as it can decode them, so the number of frames that go by
    # while a play is being built has nothing to do with how many would go by at
    # 60 Hz. benchmark_live_derivation.py paces against a wall clock and is the
    # honest measurement; the worst per-play build time above bounds it.
    if problems:
        print(f"  {len(problems)} DISAGREEMENT(S) with the authoritative pass:")
        for problem in problems[:20]:
            print(f"    - {problem}")
        if len(problems) > 20:
            print(f"    ... and {len(problems) - 20} more")
        return False
    print("  live and postgame agree on every field of every play")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", nargs="?", default=None)
    parser.add_argument("--all", action="store_true",
                        help="replay every session in data/player_tracking")
    parser.add_argument("--live-out", default=None,
                        help="also write the live plays to this path")
    parser.add_argument(
        "--postgame", default=None,
        help="compare against this derived plays file instead of <session>.plays.jsonl",
    )
    args = parser.parse_args()

    if args.all:
        if args.postgame or args.live_out:
            parser.error("--postgame and --live-out require one session, not --all")
        stems = sorted({path.with_suffix("")
                        for path in DATA.glob("*.plays.jsonl")})
        stems = [Path(str(stem).removesuffix(".plays")) for stem in stems]
    elif args.session:
        stem = Path(args.session)
        if stem.suffix in (".json", ".bin"):
            stem = stem.with_suffix("")
        stems = [stem]
    else:
        parser.error("give a session stem or --all")

    if not stems:
        print("no derived sessions found in", DATA)
        return 1

    ok = True
    for stem in stems:
        ok = run_session(
            stem,
            postgame_path=Path(args.postgame) if args.postgame else None,
            live_out=Path(args.live_out) if args.live_out else None,
        ) and ok
    print()
    print("live derivation matches the authoritative pass on every session"
          if ok else "LIVE AND POSTGAME DISAGREE -- see above")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
