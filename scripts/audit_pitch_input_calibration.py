"""Audit the scripted PITCH-input calibration game of 2026-09-25.

Session: mario_stadium-20260925T165659Z, the third scripted input-calibration
preview and the first capture recorded with STATE_BASE = 0x900D4E00, so the
first one that contains the team star meters at 0x900D4E24/26.

This is an offline audit.  It reads the captured frame stream, the derived pitch
stream and the console annotations; it changes no production model and no
scoring.  Run from the repository root:

    python scripts/audit_pitch_input_calibration.py

Outputs:
    data/calibration/pitch-input-pitches-v1.jsonl
    data/calibration/pitch-input-audit-v1.json

SIDE NAMING.  `away_*` and `home_*` in a capture mean "the side batting in half
0" and "the side batting in half 1".  In this session the nine the lineup file
calls "home" bat in half 0, so the lineup file's away/home are the opposite way
round from the capture's.  Every side here is resolved from the capture.

THREE LABEL FIELDS, never merged: `planned_input_mode` is the block the pitch
falls in, `actual_input_mode` is that corrected by the operator, and
`detected_*` is whatever this audit infers.  A detector output is never written
back over a label or over raw evidence.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from player_tracking_io import Session

ROOT = Path(__file__).resolve().parents[1]
TRACKING = ROOT / "data" / "player_tracking"
CALIBRATION = ROOT / "data" / "calibration"
STEM = "mario_stadium-20260925T165659Z"

STATE_BASE = 0x900D4E00
AWAY_METER = 0x900D4E24
HOME_METER = 0x900D4E26
CUT_IN_TIMER = 0x900D4F24          # named by this audit; see the report

# The scripted plan, by (inning, inning_half).  half 0 is the top.
PLANNED_BY_BLOCK = {
    (1, 0): "pitch_normal",
    (1, 1): "pitch_charged",
    (2, 0): "pitch_changeup",
    (2, 1): "pitch_alternating_by_batter",
    (3, 0): "pitch_star",
    (3, 1): "pitch_corner",
}


def _label(mode, charge, changeup, star, aim, source):
    return {"actual_input_mode": mode, "actual_charge": charge,
            "actual_changeup": changeup, "actual_star": star,
            "actual_aim": aim, "actual_label_source": source}


# Corrected ground truth, by pitch index in .pitches.jsonl order (1-based).
#   charge/changeup: 1 yes, 0 no, None the block never specified it
#   star: from the 3T annotations, which name the plate appearances with no
#         star available; the block default is a star pitch
# The source is carried through to the artifact so a block default is never
# mistaken for something the operator said.
ACTUAL = {}
for _i in range(1, 6):
    ACTUAL[_i] = _label("pitch_normal", 0, 0, 0, None, "block_1T")
for _i in (6, 7, 8):
    # The correction covers all three pitches, not one of them: the lineup
    # file's note format is "pitch=<n if only ONE pitch of the at-bat differed,
    # else omit>" and this correction carries no pitch number.
    ACTUAL[_i] = _label("pitch_normal", 0, 0, 0, None, "operator_correction_PA6")
ACTUAL[9] = _label("pitch_charged", 1, 0, 0, None, "block_1B")
ACTUAL[10] = _label("pitch_normal", 0, 0, 0, None, "operator_correction_PA8")
for _i in (11, 12, 13):
    ACTUAL[_i] = _label("pitch_changeup", None, 1, 0, None, "block_2T")
ACTUAL[14] = _label("pitch_charged", 1, 0, 0, None, "annotation_PA12")
ACTUAL[15] = _label("pitch_normal", 0, 0, 0, None, "annotation_PA13")
for _i in (16, 17, 18):
    ACTUAL[_i] = _label("pitch_changeup_charged", 1, 1, 0, None,
                        "annotation_PA14")
STAR_3T = {19, 20, 21, 22, 23, 24, 30, 31, 38}
for _i in range(19, 39):
    _source = "block_3T" if _i <= 23 else "annotation_3T"
    if _i in STAR_3T:
        ACTUAL[_i] = _label("pitch_star", None, 0, 1, None, _source)
    else:
        ACTUAL[_i] = _label("pitch_charged", 1, 0, 0, None, _source)
for _i in (39, 40, 41):
    ACTUAL[_i] = _label("pitch_corner", None, None, 0, "left", "block_3B")

# Plate appearance of each pitch, hard-coded so the annotation join is
# checkable by eye against the pitch-in-PA counter in the derived stream.
PA_OF = {1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 6, 8: 6, 9: 7, 10: 8, 11: 9,
         12: 10, 13: 11, 14: 12, 15: 13, 16: 14, 17: 14, 18: 14, 19: 15,
         20: 16, 21: 17, 22: 17, 23: 17, 24: 18, 25: 18, 26: 18, 27: 19,
         28: 19, 29: 19, 30: 20, 31: 20, 32: 20, 33: 21, 34: 21, 35: 22,
         36: 23, 37: 24, 38: 24, 39: 25, 40: 26, 41: 27}

# Pitches whose charge state the labelling never fixed, and why.
CHARGE_EXCLUSIONS = {}
CHARGE_EXCLUSIONS.update(
    {i: "block_2T_specified_changeup_not_charge" for i in (11, 12, 13)})
CHARGE_EXCLUSIONS.update(
    {i: "block_3T_star_pitch_charge_not_specified" for i in STAR_3T})
CHARGE_EXCLUSIONS.update(
    {i: "block_3B_specified_aim_not_charge" for i in (39, 40, 41)})

PREP_FRAMES = 180          # lookback for the exhaustive byte search
PERMUTATION_TRIALS = 400
RELEASE_SPEED_FRAMES = 3   # frames of flight averaged for the release speed


# --- loading -----------------------------------------------------------------

def read_jsonl(path: Path) -> list:
    return [json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def load_capture(session: Session):
    """(state block per frame, ball xyz per frame, game timer per frame)."""
    width = session.state_size
    frames = session.header["frames"]
    block = np.zeros((frames, width), dtype=np.uint8)
    ball = np.zeros((frames, 3), dtype=np.float64)
    timer = np.zeros(frames, dtype=np.int64)
    for i, frame in enumerate(session.frames()):
        block[i] = np.frombuffer(frame.block, dtype=np.uint8, count=width)
        ball[i] = frame.ball
        timer[i] = frame.timer
    return block, ball, timer


def u16_series(block: np.ndarray, address: int) -> np.ndarray:
    off = address - STATE_BASE
    pair = block[:, off:off + 2].astype(np.int64)
    return (pair[:, 0] << 8) | pair[:, 1]


# --- star meter --------------------------------------------------------------

def meter_events(series: np.ndarray, timer: np.ndarray) -> list:
    delta = np.diff(series)
    return [{"timer": int(timer[i + 1]), "amount": int(delta[i]),
             "before": int(series[i]), "after": int(series[i + 1])}
            for i in np.nonzero(delta)[0]]


def star_spends(block, timer, pitches):
    """Each pitch's star spend, measured ACROSS the release frame.

    The deduction lands ON the frame the pitch counter rises -- which is the
    frame the derivation takes as the pitch's `before` snapshot -- so the old
    within-window arithmetic differenced two post-deduction readings and
    reported 0 for every star pitch in this session.
    """
    base = int(timer[0])
    meters = {"away": u16_series(block, AWAY_METER),
              "home": u16_series(block, HOME_METER)}
    out = []
    for pitch in pitches:
        i = pitch["pitch_timer"] - base
        half = pitch["inning_half"]
        batting, fielding = ("away", "home") if half == 0 else ("home", "away")
        row = {}
        for role, side in (("batting", batting), ("fielding", fielding)):
            series = meters[side]
            row[role + "_side"] = side
            row[role + "_meter_before_release"] = int(series[i - 1])
            row[role + "_meter_at_release"] = int(series[i])
            row[role + "_release_drop"] = int(max(0, series[i - 1] - series[i]))
        out.append(row)
    return out


# --- kinematics --------------------------------------------------------------

def kinematics(ball, timer, pitches):
    """Ball speed at release and at mid-flight, from the captured coordinates.

    Independent of every memory byte the search below looks at.
    """
    base = int(timer[0])
    step = np.linalg.norm(np.diff(ball, axis=0), axis=1)
    out = []
    for pitch in pitches:
        i = pitch["pitch_timer"] - base
        j = (pitch["plate_timer"] or pitch["pitch_timer"]) - base
        segment = step[i:j]
        # How high the ball is on the release frame.  It is quantised per
        # pitcher into a few discrete levels -- separate delivery animations --
        # and half a unit apart is far more than one frame of flight can
        # account for, so it is a release POINT and not a sampling artefact.
        height = round(float(ball[i, 1]), 4)
        if len(segment) < RELEASE_SPEED_FRAMES + 2:
            out.append({"flight_frames": int(max(1, j - i)),
                        "release_height_units": height,
                        "release_speed_units_per_frame": None,
                        "midflight_speed_units_per_frame": None,
                        "decel_ratio": None})
            continue
        mid = len(segment) // 2
        release = float(segment[:RELEASE_SPEED_FRAMES].mean())
        midflight = float(segment[max(0, mid - 1):mid + 2].mean())
        out.append({
            "flight_frames": int(j - i),
            "release_height_units": height,
            "release_speed_units_per_frame": round(release, 4),
            "midflight_speed_units_per_frame": round(midflight, 4),
            "decel_ratio": round(midflight / release, 4) if release else None,
        })
    return out



def summarise(rows, key):
    values = [r[key] for r in rows if r.get(key) is not None]
    if not values:
        return None
    values.sort()
    return {"n": len(values), "min": values[0],
            "median": values[len(values) // 2], "max": values[-1]}


def kinematic_contrasts(labelled):
    """What the ball itself says, per pitcher.

    This is the only evidence in the audit that is not a memory byte, so it is
    the only independent check on a memory-byte detector.  It is grouped BY
    PITCHER because release speed is a per-character ladder -- Daisy's plain
    pitch and Waluigi's plain pitch are not the same number -- and pooling them
    manufactures an overlap that is not there.
    """
    out = {}
    for pitcher in sorted({r["pitcher"] for r in labelled}):
        mine = [r for r in labelled if r["pitcher"] == pitcher]
        groups = {}
        for r in mine:
            key = r["actual_input_mode"]
            groups.setdefault(key, []).append(r)
        out[pitcher] = {
            "pitches": len(mine),
            "by_actual_mode": {
                mode: {
                    "pitch_indexes": [r["pitch_index"] for r in rows],
                    "release_speed": summarise(rows,
                                               "release_speed_units_per_frame"),
                    "release_height": summarise(rows, "release_height_units"),
                    "decel_ratio": summarise(rows, "decel_ratio"),
                    "flight_frames": summarise(rows, "flight_frames"),
                    "plate_x_units": summarise(rows, "plate_x_units"),
                }
                for mode, rows in sorted(groups.items())
            },
        }
    return out


# --- the cut-in timer --------------------------------------------------------

def cut_in_runs(block, timer):
    """Runs of the nonzero counter at 0x900D4F24, with their length and end."""
    series = u16_series(block, CUT_IN_TIMER)
    runs, start = [], None
    for i in range(1, len(series)):
        if series[i] and not series[i - 1]:
            start = i
        elif series[i - 1] and not series[i] and start is not None:
            runs.append({"start_timer": int(timer[start]),
                         "end_timer": int(timer[i - 1]),
                         "peak": int(series[i - 1]),
                         "frames": int(i - start)})
            start = None
    return runs


# --- the exhaustive byte search ---------------------------------------------

def search_features(block, timer, pitches, prep=PREP_FRAMES):
    """Per-pitch features over every u8 and every big-endian u16 in the block.

    A positive float's big-endian bytes order exactly the way the float does, so
    a charge meter stored as a float in 0..1 is visible to the u16 `max`
    channel.  That is why the sweep is not repeated over float reads.
    """
    base = int(timer[0])
    width = block.shape[1]
    channels = width + (width - 1)
    # `release_drop` is what makes the positive control work: the star-pitch
    # deduction is a fall across the release frame and nothing else in this set
    # can see a fall.  If the sweep stops rediscovering 0x900D4E26 with it, the
    # sweep is broken and its negatives mean nothing.
    names = ("max", "at_release", "pre_release", "release_drop", "rise")
    feats = {n: np.zeros((len(pitches), channels), dtype=np.int32)
             for n in names}
    for row, pitch in enumerate(pitches):
        i = pitch["pitch_timer"] - base
        lo = max(0, i - prep)
        window = block[lo:i + 1].astype(np.int32)
        window = np.concatenate(
            [window, (window[:, :-1] << 8) | window[:, 1:]], axis=1)
        feats["max"][row] = window.max(0)
        feats["at_release"][row] = window[-1]
        feats["pre_release"][row] = window[-2]
        feats["release_drop"][row] = window[-2] - window[-1]
        increments = np.diff(window, axis=0) == 1
        run = np.zeros(window.shape[1], np.int32)
        best = np.zeros(window.shape[1], np.int32)
        for t in range(increments.shape[0]):
            run = np.where(increments[t], run + 1, 0)
            np.maximum(best, run, out=best)
        feats["rise"][row] = best
    return feats


def perfectly_separating(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Channels whose values never overlap between the two classes."""
    pos, neg = x[y], x[~y]
    return (pos.min(0) > neg.max(0)) | (pos.max(0) < neg.min(0))


def run_search(feats, width, rows, y, trials=PERMUTATION_TRIALS, seed=20260925):
    """Perfect separators for one target, with a matched permutation control.

    The control permutes the SAME labels over the SAME pitches, which bounds how
    often a sweep of ~57,000 channels splits this many pitches perfectly by
    accident.  It does NOT excuse a channel that merely tracks the passage of
    the game: a permutation ignores pitch order, so ordering artefacts have to
    be ruled out by looking at the channel itself.
    """
    rng = np.random.default_rng(seed)
    n, positives = len(rows), int(y.sum())
    channels = int(next(iter(feats.values())).shape[1])
    result = {"n": n, "positives": positives, "channels": channels,
              "features": {}}
    for name, table in feats.items():
        x = table[rows]
        hits = np.nonzero(perfectly_separating(x, y))[0]
        null = 0
        for _ in range(trials):
            shuffled = np.zeros(n, bool)
            shuffled[rng.choice(n, positives, replace=False)] = True
            null += int(perfectly_separating(x, shuffled).any())
        result["features"][name] = {
            "perfect_separators": [channel_name(int(c), width) for c in hits],
            "permutation_trials": trials,
            "permutation_trials_with_any_separator": null,
        }
    return result


def channel_name(index: int, width: int) -> str:
    if index < width:
        return "u8 0x%08X" % (STATE_BASE + index)
    return "u16 0x%08X" % (STATE_BASE + index - width)


# --- report ------------------------------------------------------------------

def main() -> int:
    session = Session(TRACKING / STEM)
    header = session.header
    pitches = read_jsonl(TRACKING / (STEM + ".pitches.jsonl"))
    annotations = read_jsonl(TRACKING / (STEM + ".annotations.jsonl"))
    if len(pitches) != len(ACTUAL):
        raise SystemExit("expected %d pitches, found %d"
                         % (len(ACTUAL), len(pitches)))

    block, ball, timer = load_capture(session)
    width = block.shape[1]

    spends = star_spends(block, timer, pitches)
    moves = kinematics(ball, timer, pitches)
    runs = cut_in_runs(block, timer)

    # Which side is which, resolved from the capture and never from the lineup.
    side_convention = {}
    for name, half in (("away", 0), ("home", 1)):
        side_convention[name] = {
            "bats_in_half": half,
            "batters": sorted({p["batter"] for p in pitches
                               if p["inning_half"] == half}),
            "pitcher_when_fielding": sorted({p["pitcher"] for p in pitches
                                             if p["inning_half"] != half}),
        }

    labelled = []
    for index, pitch in enumerate(pitches, start=1):
        label = ACTUAL[index]
        planned = PLANNED_BY_BLOCK[(pitch["inning"], pitch["inning_half"])]
        spend, move = spends[index - 1], moves[index - 1]
        detected_star = spend["fielding_release_drop"] > 0
        row = {
            "pitch_index": index,
            "pa_number": PA_OF[index],
            "session": STEM,
            "inning": pitch["inning"],
            "inning_half": pitch["inning_half"],
            "pitch_in_pa": pitch["pitch_in_pa"],
            "pitcher": pitch["pitcher"],
            "batter": pitch["batter"],
            "pitch_timer": pitch["pitch_timer"],
            "plate_timer": pitch["plate_timer"],
            "planned_input_mode": planned,
        }
        row.update(label)
        row["charge_exclusion_reason"] = CHARGE_EXCLUSIONS.get(index)
        # measured evidence, independent of every label above
        row.update({
            "fielding_side": spend["fielding_side"],
            "fielding_meter_before_release":
                spend["fielding_meter_before_release"],
            "fielding_meter_at_release": spend["fielding_meter_at_release"],
            "fielding_star_spend_measured": spend["fielding_release_drop"],
            "batting_star_spend_measured": spend["batting_release_drop"],
            "plate_x_units": pitch["plate_x_units"],
        })
        row.update(move)
        # detector output, kept apart from every label above
        row["detected_input_mode"] = "pitch_star" if detected_star else None
        row["detected_star_source"] = ("fielding_meter_drop_across_release"
                                       if detected_star else None)
        labelled.append(row)

    # -- star pitch, against the operator's ground truth
    star_actual = np.array([r["actual_star"] == 1 for r in labelled])
    star_detected = np.array([r["fielding_star_spend_measured"] > 0
                              for r in labelled])
    star_matrix = {
        "true_positive": int((star_actual & star_detected).sum()),
        "false_positive": int((~star_actual & star_detected).sum()),
        "false_negative": int((star_actual & ~star_detected).sum()),
        "true_negative": int((~star_actual & ~star_detected).sum()),
    }
    spend_amounts = Counter(r["fielding_star_spend_measured"] for r in labelled
                            if r["fielding_star_spend_measured"] > 0)

    # The cut-in counter as a SECOND star signal: a 125-frame run ending a fixed
    # distance before a release.  It also runs 89 frames on scoring plays, so it
    # is a generic cut-in timer, not a star flag.
    star_timers = [r["pitch_timer"] for r in labelled if r["actual_star"] == 1]
    cut_in_leads = sorted({t - run["end_timer"] for run in runs
                           if run["frames"] == 125 for t in star_timers
                           if 0 < t - run["end_timer"] < 200})

    # -- the exhaustive search, with its positive control
    feats = search_features(block, timer, pitches)
    charge = np.array([r["actual_charge"] if r["actual_charge"] is not None
                       else -1 for r in labelled])
    charge_rows = np.nonzero(charge >= 0)[0]
    changeup = np.array([r["actual_changeup"]
                         if r["actual_changeup"] is not None else -1
                         for r in labelled])
    changeup_rows = np.nonzero(changeup >= 0)[0]
    searches = {
        # POSITIVE CONTROL.  The meter is known to separate star pitches, so the
        # same sweep must rediscover 0x900D4E26 or the sweep proves nothing.
        "star_positive_control": run_search(
            feats, width, np.arange(len(labelled)), star_actual),
        "charge": run_search(feats, width, charge_rows,
                             charge[charge_rows] == 1),
        "changeup": run_search(feats, width, changeup_rows,
                               changeup[changeup_rows] == 1),
    }

    # Every charge candidate the sweep returns gets the same two questions
    # asked of it, because an exhaustive sweep of 57,000 channels will hand back
    # noise that happens to split 26 pitches.  A byte that is the low mantissa
    # byte of a float is noise however clean its split looks: the float itself
    # would then separate too, and a positive float's leading u16 orders exactly
    # the way the float does.
    diagnostics = {}
    for name, result in searches.items():
        for feature, detail in result["features"].items():
            for channel in detail["perfect_separators"]:
                kind, address = channel.split()
                offset = int(address, 16) - STATE_BASE
                if channel in diagnostics:
                    continue
                aligned = offset & ~3
                series = block[:, offset].astype(np.int64)
                lead = u16_series(block, STATE_BASE + aligned)
                lead_separates = None
                if name == "charge":
                    rows_, y_ = charge_rows, charge[charge_rows] == 1
                elif name == "changeup":
                    rows_, y_ = changeup_rows, changeup[changeup_rows] == 1
                else:
                    rows_, y_ = np.arange(len(labelled)), star_actual
                lead_at = np.array([lead[p["pitch_timer"] - int(timer[0])]
                                    for p in pitches])[rows_]
                lead_separates = bool(perfectly_separating(
                    lead_at.reshape(-1, 1), y_)[0])
                diagnostics[channel] = {
                    "target": name,
                    "feature": feature,
                    "frames_changed": int((np.diff(series) != 0).sum()),
                    "byte_offset_within_aligned_word": int(offset - aligned),
                    "aligned_word_leading_u16_separates": lead_separates,
                }

    awards = {side: meter_events(u16_series(block, addr), timer)
              for side, addr in (("away", AWAY_METER), ("home", HOME_METER))}

    audit = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "session": STEM,
        "checksum_sha256": header.get("checksum_sha256"),
        "frames": header.get("frames"),
        "state_base": "0x%08X" % STATE_BASE,
        "star_costs": header.get("star_costs"),
        "side_convention": side_convention,
        "annotations": [{"pa_number": a["pa_number"], "inning": a["inning"],
                         "half": a["half"], "batter": a["batter_name"],
                         "pitcher": a["pitcher_name"], "note": a["note"]}
                        for a in annotations],
        "pitch_counts_by_block": dict(Counter(
            "%d%s" % (r["inning"], "T" if r["inning_half"] == 0 else "B")
            for r in labelled)),
        "actual_mode_counts": dict(Counter(r["actual_input_mode"]
                                           for r in labelled)),
        "star_pitch": {
            "detector": "fielding-side star meter drop across the release frame",
            "confusion": star_matrix,
            "spend_amounts": {str(k): v for k, v in spend_amounts.items()},
            "cut_in_runs": runs,
            "cut_in_lead_frames_before_star_release": cut_in_leads,
        },
        "kinematic_contrasts": kinematic_contrasts(labelled),
        "searches": searches,
        "candidate_diagnostics": diagnostics,
        "star_meter_awards": awards,
    }

    CALIBRATION.mkdir(parents=True, exist_ok=True)
    pitches_path = CALIBRATION / "pitch-input-pitches-v1.jsonl"
    pitches_path.write_text(
        "".join(json.dumps(r) + "\n" for r in labelled), encoding="utf-8")
    audit_path = CALIBRATION / "pitch-input-audit-v1.json"
    audit_path.write_text(json.dumps(audit, indent=1), encoding="utf-8")

    print("pitches       %d in %d plate appearances"
          % (len(labelled), len(set(PA_OF.values()))))
    print("star pitches  actual %d, detected %d, FP %d, FN %d"
          % (int(star_actual.sum()), int(star_detected.sum()),
             star_matrix["false_positive"], star_matrix["false_negative"]))
    print("star spends   %s (cost table %s)"
          % (dict(spend_amounts), header.get("star_costs")))
    print("cut-in lead   %s frames before release" % cut_in_leads)
    for name, result in searches.items():
        print("search %-22s n=%d pos=%d" % (name, result["n"],
                                            result["positives"]))
        for feature, detail in result["features"].items():
            print("    %-12s hits=%s null=%d/%d"
                  % (feature, detail["perfect_separators"] or "none",
                     detail["permutation_trials_with_any_separator"],
                     detail["permutation_trials"]))
    for channel, detail in diagnostics.items():
        if detail["target"] == "star_positive_control":
            continue
        print("candidate     %-22s target=%s changed on %d frames, byte %d of "
              "its aligned word, leading u16 separates: %s"
              % (channel, detail["target"], detail["frames_changed"],
                 detail["byte_offset_within_aligned_word"],
                 detail["aligned_word_leading_u16_separates"]))
    print("wrote         %s" % pitches_path)
    print("wrote         %s" % audit_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
