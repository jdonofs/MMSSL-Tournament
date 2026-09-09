"""Export fixed-window, pre-outcome ball-flight features for catch calibration.

Only the first 12 captured frames beginning at contact are used. The fitted
trajectory is therefore identical in information timing for catches and misses:
actual catch/landing frames, final fielder positions, possession, and outcomes
are never read while constructing a feature row.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from player_tracking_io import Session, dumps_play


SCHEMA_VERSION = "sluggers-catch-preoutcome-flight-v1"
WINDOW_FRAMES = 12
FPS = 59.94
MAX_PROJECTED_SECONDS = 10.0


def _solve(matrix, vector):
    """Small Gaussian eliminator used for deterministic least squares."""
    size = len(vector)
    augmented = [list(map(float, matrix[row])) + [float(vector[row])]
                 for row in range(size)]
    for column in range(size):
        pivot = max(range(column, size),
                    key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            return None
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        scale = augmented[column][column]
        augmented[column] = [value / scale for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [left - factor * right for left, right in
                              zip(augmented[row], augmented[column])]
    return [augmented[row][-1] for row in range(size)]


def _linear_fit(times, values):
    n = len(times)
    sx = sum(times)
    sxx = sum(value * value for value in times)
    sy = sum(values)
    sxy = sum(x * y for x, y in zip(times, values))
    solved = _solve([[n, sx], [sx, sxx]], [sy, sxy])
    return None if solved is None else (solved[0], solved[1])


def _quadratic_fit(times, values):
    n = len(times)
    sums = [sum(value ** power for value in times) for power in range(5)]
    rhs = [sum((x ** power) * y for x, y in zip(times, values))
           for power in range(3)]
    # c + b*t + a*t^2
    solved = _solve([
        [n, sums[1], sums[2]],
        [sums[1], sums[2], sums[3]],
        [sums[2], sums[3], sums[4]],
    ], rhs)
    return None if solved is None else (solved[0], solved[1], solved[2])


def _landing_time(coefficients, last_time):
    if coefficients is None:
        return None
    c, b, a = coefficients
    if a >= -1e-6:
        return None
    discriminant = b * b - 4 * a * c
    if discriminant < 0:
        return None
    roots = [(-b + sign * math.sqrt(discriminant)) / (2 * a)
             for sign in (1, -1)]
    candidates = [value for value in roots
                  if value > last_time and value <= MAX_PROJECTED_SECONDS]
    return min(candidates) if candidates else None


def project(samples):
    if len(samples) != WINDOW_FRAMES:
        return None, "incomplete_fixed_window"
    first_timer = samples[0][0]
    if any(samples[index][0] != first_timer + index
           for index in range(len(samples))):
        return None, "nonconsecutive_fixed_window"
    positions = [sample[1] for sample in samples]
    if any(not all(math.isfinite(value) for value in position)
           for position in positions):
        return None, "nonfinite_ball_position"
    times = [(timer - first_timer) / FPS for timer, _ in samples]
    fit_x = _linear_fit(times, [position[0] for position in positions])
    fit_z = _linear_fit(times, [position[2] for position in positions])
    fit_y = _quadratic_fit(times, [position[1] for position in positions])
    landing_seconds = _landing_time(fit_y, times[-1])
    if fit_x is None or fit_z is None or landing_seconds is None:
        return None, "trajectory_projection_failed"
    endpoint_x = fit_x[0] + fit_x[1] * landing_seconds
    endpoint_z = fit_z[0] + fit_z[1] * landing_seconds
    if not all(math.isfinite(value) for value in
               (endpoint_x, endpoint_z, landing_seconds)):
        return None, "nonfinite_projection"
    return {
        "projected_endpoint_x_units": round(endpoint_x, 6),
        "projected_endpoint_z_units": round(endpoint_z, 6),
        "projected_landing_seconds": round(landing_seconds, 6),
        "initial_horizontal_speed_ups": round(math.hypot(fit_x[1], fit_z[1]), 6),
        "initial_vertical_speed_ups": round(fit_y[1], 6),
        "vertical_acceleration_ups2": round(2 * fit_y[2], 6),
    }, None


def read_contacts(stem):
    path = stem.with_suffix(".plays.jsonl")
    contacts = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        play = json.loads(line)
        timer = play.get("contact_timer")
        if isinstance(timer, (int, float)) and math.isfinite(timer):
            contacts[int(timer)] = play
    return contacts


def export_session(stem):
    contacts = read_contacts(stem)
    wanted = set(contacts)
    windows = {timer: [] for timer in wanted}
    active = {}
    session = Session(stem)
    for frame in session.frames():
        timer = int(frame.timer)
        if timer in wanted:
            active[timer] = windows[timer]
        finished = []
        for contact_timer, samples in active.items():
            offset = timer - contact_timer
            if 0 <= offset < WINDOW_FRAMES:
                samples.append((timer, tuple(float(value) for value in frame.ball)))
            if offset >= WINDOW_FRAMES - 1:
                finished.append(contact_timer)
        for contact_timer in finished:
            active.pop(contact_timer, None)

    rows = []
    for contact_timer in sorted(contacts):
        features, reason = project(windows[contact_timer])
        sample_fingerprint = hashlib.sha256(json.dumps(
            windows[contact_timer], separators=(",", ":")
        ).encode()).hexdigest()
        rows.append({
            "schema_version": SCHEMA_VERSION,
            "session": stem.name,
            "contact_timer": contact_timer,
            "window_frames": WINDOW_FRAMES,
            "information_boundary": "contact through contact+11 frames only",
            "valid": features is not None,
            "reason": reason,
            "features": features,
            "sample_fingerprint_sha256": sample_fingerprint,
        })
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", default="data/player_tracking")
    parser.add_argument("--sessions", nargs="*")
    parser.add_argument("--out", default="data/calibration/catch-probability-preoutcome-features-v1.jsonl")
    args = parser.parse_args()
    archive = Path(args.archive)
    if args.sessions:
        stems = [archive / value for value in args.sessions]
    else:
        stems = sorted(path.with_suffix("") for path in archive.glob("*.plays.jsonl"))
    # with_suffix removes only .jsonl; normalize the remaining .plays suffix.
    stems = [Path(str(stem).removesuffix(".plays")) for stem in stems]
    rows = []
    for stem in stems:
        if not stem.with_suffix(".bin").exists():
            continue
        print(f"[catch-features] {stem.name}", flush=True)
        rows.extend(export_session(stem))
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(dumps_play(row) + "\n" for row in rows), encoding="utf-8")
    print(f"[catch-features] wrote {len(rows)} rows to {output}")


if __name__ == "__main__":
    main()
