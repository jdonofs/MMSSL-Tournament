"""Turn a recorded tracking session into per-play fielding and baserunning metrics.

    python scripts/calibrate_player_tracking.py data/player_tracking/<session>
    python scripts/derive_player_metrics.py     data/player_tracking/<session>

Writes <session>.plays.jsonl -- one JSON object per batted ball -- and prints a
summary. Calibration must run first; this script refuses to guess which bytes
are the live position, because guessing wrong here produces plausible-looking
numbers rather than an error.

WHAT IS MEASURED, AND WHAT EACH ONE NEEDS TO BE HONEST

  reaction        Seconds from contact until a fielder's speed first clears a
                  threshold. Measured against the CONTACT frame, not the pitch,
                  because the fielder cannot react to a ball that has not been
                  hit.
  route efficiency  Straight-line distance from where a fielder started to
                  where they ended, over the distance they actually covered.
                  Only meaningful for the fielder who went after the ball, so
                  it is emitted only for fielders who moved more than a step.
  sprint speed    The fastest one-second window, which is the same definition
                  Statcast uses and is far more stable than an instantaneous
                  frame-to-frame maximum -- at 60 Hz a single-frame difference
                  is mostly quantisation noise.
  opportunity     Hang time available before the ball's first touch, paired
                  with the distance the fielder had to cover. Those two are the
                  inputs a catch-probability model is fitted on; this script
                  records the pair rather than asserting a probability.
  home to first   Contact until the batter-runner reaches the first-base bag.
  lead            Distance off the bag at the moment of contact.

COORDINATE FRAME. Everything is emitted in the BALL's frame -- the one
parkGeometry.js documents, with -Z toward centre field and +X toward first base
-- so fielder positions, runner paths, and batted-ball spray all overlay without
a second conversion. The actor structs use a different sign convention; the
calibration step measures it rather than assuming it.

BASE COORDINATES ARE MEASURED, NOT ASSUMED. An unoccupied runner slot parks
exactly on its bag, so the session itself says where first, second and third are
in this park. That beats deriving them from a nominal base path, and it means a
park with an unusual infield is handled without a special case.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from collections import Counter, deque
from pathlib import Path

from player_tracking_io import Session, dumps_play, session_snapshot_builder
from export_catch_preoutcome_features import WINDOW_FRAMES as PREOUTCOME_WINDOW_FRAMES
from export_catch_preoutcome_features import project as project_preoutcome_flight

# Character ids are the game's own, extracted from the tracker's CHAR_ID_TO_NAME
# and cross-checked against mss_autoteam.py's captain list and its
# LAST_WRITABLE_CHAR_INDEX. Names make every output line readable; an id does
# not.
CHARACTER_NAMES = json.loads(
    (Path(__file__).resolve().parent / "mss_character_ids.json").read_text())


# charList holds 77 named characters at indexes 0..76 and every id from 77 up is
# a Mii, chosen from the Wii's own Mii list rather than the character select.
# The tracker's id table stops at 70, so a Mii used to come out as "char 78" --
# a name no other table in the repo has ever heard of, which is how one DK
# Jungle session recorded 52 plays for a player nothing could resolve. The site
# keys the whole family under "Mii"; scripts/mss_mii_map.json is what says WHICH
# Mii a given player means, and that is a roster question, not a capture one.
FIRST_MII_CHARACTER_ID = 77


def character_name(character_id: int) -> str:
    """The game's name for a character id.

    An EMPTY runner slot keeps whatever id last occupied it, so a name here is
    only meaningful when the slot's batting index is non-negative. Callers gate
    on the index, not on this.
    """
    named = CHARACTER_NAMES.get(str(character_id))
    if named:
        return named
    if character_id is not None and character_id >= FIRST_MII_CHARACTER_ID:
        return "Mii"
    return f"char {character_id}"

# A fielder is "reacting" once they exceed this, held for three frames so a
# single noisy sample cannot trip it.
REACTION_SPEED_UPS = 1.2
REACTION_HOLD_FRAMES = 3

# Below this a body counts as stationary, for deciding a play is over.
STILL_SPEED_UPS = 0.4

# Above this a fielder is not running, they are being MOVED. The game has two
# distinct modes and they do not overlap much: characters run at a fixed
# per-character speed -- the whole batting order measured between 8.2 and 10.3
# u/s, and no runner in the first real session ever exceeded 10.2 -- while
# fielders converging on a ball are glided toward it at whatever speed the game
# needs, up to 29 u/s. Both are perfectly straight-line, constant-velocity
# motion frame to frame, so smoothness cannot tell them apart; only magnitude
# can. In the fielder step histogram the running peak dies out by 0.15 u/frame,
# there is a trough at 0.16-0.17, and the assist population starts at 0.18.
#
# Sprint Speed measured through the glide is measuring the game's fielding
# assist rather than the character, which is how one 8.4 u/s outfielder came out
# at 20.7. The glide is kept and reported -- it is a real thing that happens on
# the play, and a range model needs to know it happened -- but it is not speed.
#
# RUNNERS AND FIELDERS DO NOT SHARE A CEILING, and one threshold for both let
# the whole fielder glide population through. 11.0 was measured on runners and
# is right for them. Fielders run slower: across the sixteen archived sessions
# the fastest unassisted fielder run belongs to Yoshi at 8.45 u/s, and the value
# is very nearly a per-attribute constant -- Toadette, Baby Luigi, Baby Mario,
# Red Yoshi and Blue Yoshi all carry run_speed 80 and all five read exactly
# 8.15. Everything from 9 to 11 u/s on a fielder is glide, and the game glides
# the SLOW characters hardest to get them to the ball, so the contamination is
# not noise: 17.7% of a slow character's "own running" distance was above the
# fielder ceiling against 1.4% of a fast one's.
#
# Measured against the game's own run_speed attribute, that inverted the metric
# -- per-character fielder sprint speed correlated at -0.66, King K. Rool
# (run_speed 10) reading 10.20 u/s while Yoshi (90) read 8.45.
#
# THE FIELDER CEILING IS NOW A FALLBACK. The game stores each character's own
# top speed at +0x0F0, so Track.assists uses that character's figure and only
# falls back to this one where the field is missing. The runner ceiling still
# applies to every runner: the offense actor class does not carry the field.
ASSIST_SPEED_UPS_RUNNER = 11.0
ASSIST_SPEED_UPS_FIELDER = 8.7

# Slack above a character's own top speed before a step counts as a glide. One
# sample is one frame of game clock, so a step can straddle the frame a glide
# begins on and read slightly high without being assisted.
GLIDE_TOLERANCE_UPS = 0.5

# How far past contact to look for the game's own landing prediction. It is
# written on the contact frame itself in most plays but can lag it by a frame or
# two, and the window has to stay short: the slot is cleared between balls, so a
# long search would find the NEXT play's prediction rather than this one's.
PROJECTED_LANDING_SEARCH_FRAMES = 8

# A play is abandoned if it runs longer than this; something has gone wrong with
# the state flags and a 90-second "play" would poison every aggregate.
MAX_PLAY_SECONDS = 30.0

# A single-frame move larger than this is the between-play RESET, not a body.
# See Track.path_length -- these are real and expected, not corruption.
#
# Measured on the first real session, once plays are windowed by the game's own
# live-ball state: across 57 batted balls, every single-frame jump of 2u or more
# happened AFTER the ball was dead (547 of them), and every jump inside the live
# window was between 0.6u and 1.1u (70 of them, almost all pitcher follow-through
# and outfield dives). So 2u separates the reset from real play with a clear gap
# on both sides, and it is the reset this threshold exists to remove.
#
# The earlier value of 0.6 predates the live-ball window. It was doing two jobs
# at once -- excluding the reset AND ending the play -- and to end the play early
# enough it had to be tight enough to also throw away every dive. The window does
# the second job properly now, so this only has to do the first.
TELEPORT_UNITS = 2.0

# The game's own `game_state` while a batted ball is live. It leaves this value
# two frames before the ball snaps back to the mound, which makes it the exact
# dead-ball frame rather than an inference from how bodies moved.
LIVE_BALL_GAME_STATE = 2

# How near the plate the ball has to be when the swing flag rises for this to be
# a real batted ball. `ball_was_hit` also re-raises during the dead-ball
# aftermath -- a home-run trot, an inning change -- with the ball wherever it
# came to rest, and those replays were being recorded as extra batted balls with
# a bogus contact point. On the first real session the split is total: all 57
# genuine contacts had the ball within 0.9u of the origin, and all 17 replays had
# it between 45u and 109u away.
CONTACT_BALL_RADIUS_UNITS = 6.0

# How far the ball must move from where it sat during the swing animation to
# count as having been launched. Small, because it only has to beat float noise
# on a stationary ball.
LAUNCH_MOVE_UNITS = 0.05

# If the ball has not moved this long after a swing, there was no batted ball.
MAX_LAUNCH_DELAY_SECONDS = 6.0

# What the game's own two batted-ball flags mean, read off the first real
# session by cross-checking every value against the ball's measured trajectory.
#
#   fair_or_foul   -1  foul. Every one of the nine was outside the foul lines
#                       (|spray| 50.0 to 70.6 degrees) and none recorded an out.
#                    1  fair, still in flight.
#                    2  fair, and it has touched the ground.
#                    3  fair, and it was caught in the air. All 21 recorded
#                       exactly one out, and all sat inside the lines.
#   home_run_flag   1  home run. All 11 carried 96u to 109u and scored.
#                   2  would have been a home run, but it went foul. All four
#                      peaked above 31u of height outside the lines.
#
# Both are cleared on the frame the play window closes, so they can only be read
# from inside the live window.
FOUL_FLAG = -1
FAIR_CAUGHT_FLAG = 3
HOME_RUN_FLAG_FAIR = 1

# How close the ball has to be to a fielder's own coordinate to count as being
# in their hands. The match is exact when it happens, so this is loose by orders
# of magnitude and still unambiguous. Kept in step with the calibration.
LOCK_UNITS = 0.05

# The game's own frame counter ticks once per rendered frame at the Wii's NTSC
# rate, and all in-game motion is per-frame, so this converts ticks to
# GAME seconds. Override with --frame-rate if a session proves otherwise.
GAME_FRAME_RATE = 59.94

# How close a runner's closest approach must be for them to count as having
# reached the bag at all. This gates whether a split is reported; it does not
# set the time, so it can stay generous without biasing anything.
BAG_RADIUS_UNITS = 1.5

# Throw segmentation is deliberately conservative. The ball can teleport when
# game state resets, and a single bad memory sample must never become a 400 mph
# throw. Real throws must contain several plausible in-flight samples and end
# in a different fielder's possession.
MIN_THROW_SAMPLES = 3
MIN_THROW_SPEED_MPS = 2.0

# A Buddy Throw is two chemistry-linked fielders combining: the first dashes and
# bounces the ball to the second, who fires it in. The game plays it as a
# cutscene, and the capture shows exactly that -- every one of the nine fielder
# actors holds identical coordinates for a full second while the ball hangs
# unheld in mid-air, then launches far harder than any ordinary throw. Both in
# the first real session flew at 182 and 208 mph against a normal spread of 79
# to 123.
#
# The frozen world is supporting timing evidence, not identity. A DK Jungle
# close-play contest also stopped all nine actors and produced a 2.79 s gap,
# which proved a freeze-only detector can invent chemistry. The game's
# buddy_thrower scalar is the identity signal; every MSSTRK02 capture carries
# it and every labelled Buddy Throw sets it.
#
# The partner cannot be found in the position data -- everything is frozen -- but
# the game names it in a scalar. Across eight Buddy Throws in two parks it was
# never the fielder holding the ball, never the receiver, took four different
# values, and every pairing it produced has positive chemistry in the league's
# own table. See buddy_partner in collect_player_tracking.py.
#
# The velocity belongs to the fielder who HAD the ball, not to the partner:
# grouped by that fielder it is a constant to within 0.03 mph across different
# receivers and distances (Donkey Kong 152.1 twice, Goomba 129.4 twice), and
# grouped by partner it is not. It is still a pair's output rather than an arm,
# so it stays out of Arm Strength.
BUDDY_THROW_MIN_FREEZE_FRAMES = 10

# What a throw is rejected on is SMOOTHNESS, not a speed ceiling. Traced frame
# by frame, an ordinary throw has three parts: the ball snaps out of the
# thrower's hand to the release point, flies -- decelerating smoothly under drag,
# roughly half a percent per frame -- and snaps into the receiver's glove. A
# Buddy Throw adds a fourth: a second of frozen cutscene between release and
# launch. See BUDDY_THROW_MIN_FREEZE_FRAMES.
#
# The two snaps are the artefacts. On one measured LF->3B throw they read 238.5
# and 168.2 m/s against a real flight of 81.8 m/s decaying to 71.8. A speed cap
# removed them, but at 80 m/s it also clipped the flight itself -- that throw
# came out pinned to the cap, and its true launch speed was above it. Requiring
# each in-flight sample to be within a quarter of the one before it rejects both
# snaps by the property they actually violate, and leaves the flight intact.
FLIGHT_SPEED_RATIO = 0.25

# An absolute corruption guard, not a physical limit: the fastest flight sample
# measured in a real session is 81.8 m/s, so nothing real is anywhere near this.
MAX_THROW_SPEED_MPS = 150.0
METRES_PER_SECOND_TO_MPH = 2.2369362921
TARGET_BASE_RADIUS_UNITS = 5.0
# Every routine base-targeted throw in the labelled Playroom game reached its
# receiver within 1.6 units of the bag. Across 361 targeted throws the 97.5th
# percentile is 2.01 units; confirmed bad throws run 2.99 and 4.47-4.58.
#
# 2.0 RATHER THAN 2.5, because this distance is very nearly a CONSTANT per
# (thrower, receiver, base) pair, not a noisy measurement -- Red Pianta threw to
# Blooper at first three times at 1.209 units each. So a pair that sits high
# sits high every time, and the gap between routine and off-target is far
# narrower than a pooled percentile suggests. In the 2026-08-31 Yoshi Park game
# Red Pianta reached second four times at 1.362-1.392 and reached Petey Piranha
# at home twice at 2.007 and 2.041; the operator identified that pairing as
# negative chemistry and the missing "off the bag" line as the bug. Same
# thrower, same session, same arm: only the receiver changed. Birdo->Waluigi
# (2.103, 2.112) is the same repeated-pair signature.
#
# This flags 15 of 361 archived throws instead of 7, and charges NO new errors:
# every one of the eight it adds fails the runner-gap and closing tests below,
# which is the distinction the operator drew -- the throw was off the bag, and
# nobody advanced on it.
RECEIVER_PULLED_OFF_BASE_UNITS = 2.0
# AN INACCURATE THROW, from the game's own numbers rather than from where the
# receiver ended up. THROW_AIM_ADDRESS (player_tracking_io.py) is where the game
# aimed the throw and THROW_DESTINATION_ADDRESS is where it actually sent it, so
# the gap between them is the error the game gave the throw -- known on the
# release frame, before the ball lands. Across all 2,383 archived throws
# (2026-09-11) the ball landed a median 0.20u from the destination. Of the 1,816
# aimed at a receiver already standing on the aim point, the 18 off target have
# a 2.22-7.66u gap and the other 1,798 never more than 0.94u; all 18 are between
# characters with bad chemistry, including all five the operator annotated. Bad
# chemistry is a chance, not a rule: 121 bad-chemistry throws have no gap at all.
#
# It separates what `receiver_pulled_off_base` cannot: Wario to King K. Rool at
# home caught him 2.2u off the plate and landed 0.06u from its aim point -- K. Rool
# was not on the plate, and the throw was fine.
#
# A throw to a receiver still moving is not judged: aim point and destination
# part there between neutral pairs too (218 of the 258 gaps over 3u), so the gap
# is not an error. A capture without a destination falls back to the landing.
THROW_AIM_STANDING_UNITS = 0.5
THROW_OFF_TARGET_UNITS = 1.5
THROWING_ERROR_RUNNER_DISTANCE_UNITS = 3.0
THROWING_ERROR_RUNNER_CLOSING_UNITS = 2.0
# A glove knock-out can briefly look like a very slow throw: possession changes
# from the base fielder to a nearby backup even though no target was selected.
# The labelled Yoshi Park example began 0.03 s after the contested arrival and
# moved at 10.6 mph; real missing-target relays in the archive are much faster.
LOOSE_BALL_MAX_SPEED_MPH = 20.0
LOOSE_BALL_MAX_TRANSITION_SECONDS = 0.15
PITCH_MOVE_UNITS_PER_FRAME = 0.02
PITCH_LOOKBACK_SECONDS = 3.0


def emulator_speed(session: Session) -> float:
    """How fast the emulator ran, as a fraction of full speed.

    Not used to convert anything -- it is a health check. The game advances its
    physics once per frame, so a game-second is GAME_FRAME_RATE ticks no matter
    how fast Dolphin was replaying them, and converting with a wall-clock rate
    would make every duration in a slow session read long. Measuring the first
    couple of thousand frames and calling the result "the frame rate" was
    exactly that mistake: it returned 53.19 Hz on a session whose whole-session
    wall rate was 58.61, and inflated every time by 13%.
    """
    header = session.header
    if not header.get("duration_seconds") or not header.get("frames"):
        return 1.0
    return (header["frames"] / header["duration_seconds"]) / GAME_FRAME_RATE


class Track:
    """One actor's positions through a single play, in the ball's frame."""

    def __init__(self, name: str, character: int, index: int,
                 kind: str = "fielder"):
        self.name = name
        self.character = character
        self.index = index
        # "fielder" or "offense", straight off the actor. It selects the glide
        # threshold, which is not the same for the two -- see ASSIST_SPEED_UPS_*.
        self.kind = kind
        self.times = []
        self.points = []
        # The game's own speed for this actor, per sample, in u/s -- None on an
        # offense actor, whose class does not carry the field. See
        # ACTOR_FIELDS["speed"] in collect_player_tracking.py.
        self.game_speeds = []
        # The character's top speed from +0x0F0, as the LOWEST value seen
        # across the play.
        #
        # It is a per-character constant almost everywhere -- 89 of 92 distinct
        # values across the whole archive -- but three characters (Boomerang
        # Bro., Baby Peach, Baby Daisy) also show a value at exactly 1.8x their
        # base, and what raises it is not yet known. Until it is, the ceiling
        # takes the base: a raised ceiling silently reclassifies glide as
        # running, which is the exact error this field was brought in to fix,
        # whereas a base ceiling at worst calls a genuine boost a glide and says
        # so in `assist_units`.
        self.max_speed = None

    @property
    def assist_speed_ups(self) -> float:
        return (ASSIST_SPEED_UPS_RUNNER if self.kind == "offense"
                else ASSIST_SPEED_UPS_FIELDER)

    @property
    def has_game_speed(self) -> bool:
        """Whether the game told us this actor's speed on every sample."""
        return bool(self.game_speeds) and all(
            speed is not None for speed in self.game_speeds)

    def add(self, t: float, point: tuple, game_speed: float | None = None,
            max_speed: float | None = None, character: int | None = None):
        self.times.append(t)
        self.points.append(point)
        self.game_speeds.append(game_speed)
        # ONLY FROM FRAMES THIS CHARACTER IS ACTUALLY IN. A play window can span
        # a change of sides, and the nine fielder objects are rewritten with the
        # other team when it does -- so a later frame at this slot can be a
        # different character entirely, carrying their top speed. The track's
        # own character is fixed at its first frame, so taking the value from
        # every frame silently mixed the two.
        #
        # It cost 6.93% of fielder rows a wrong ceiling and inverted the metric:
        # Toadette (run_speed 80) came out at the slowest value in the cast.
        # Within one character the field never moves -- 0 changes in 360,009
        # samples -- so matching on it is exact rather than a tolerance.
        if character is not None and character != self.character:
            return
        if max_speed and (self.max_speed is None or max_speed < self.max_speed):
            self.max_speed = max_speed

    def path_length(self) -> float:
        """Ground distance covered, excluding teleports.

        The live position field genuinely jumps -- on a change of sides the nine
        fielder objects are rewritten with the other team, and players are reset
        between plays. A single such jump is tens of units, which would swamp a
        real route and drive route efficiency toward zero, so steps that are not
        physically possible for a body are dropped rather than summed.

        A glide toward the ball IS covered ground and stays in here. It is
        excluded from speed, not from distance -- see run_path_length.
        """
        return sum(step for step in self.steps() if step <= TELEPORT_UNITS)

    def run_path_length(self) -> float:
        """Ground covered under the character's own running speed."""
        return sum(step for step, assisted in zip(self.steps(), self.assists())
                   if step <= TELEPORT_UNITS and not assisted)

    def assist_units(self) -> float:
        return sum(step for step, assisted in zip(self.steps(), self.assists())
                   if step <= TELEPORT_UNITS and assisted)

    def assists(self) -> list:
        """Per step, whether the game moved this actor faster than it can run.

        THE CEILING IS PER CHARACTER, because the game stores each character's
        top speed and there is no reason to keep guessing one number for all of
        them. ASSIST_SPEED_UPS_FIELDER had to sit above the fastest character's
        run and below the slowest character's glide at the same time, and those
        two windows overlap: the game glides the SLOW characters hardest to get
        them to the ball, so a single ceiling let King K. Rool's glide through
        as running while clipping Yoshi's real sprint.

        +0x0F0 closes that. Yoshi's ceiling is 8.46 u/s and King K. Rool's is
        7.26, each the game's own figure for that character.

        NOTE THAT +0x0E4 IS NOT USABLE HERE and the first version of this tried
        to. It is the actor's true velocity whatever is causing it -- it tracks
        a glide just as faithfully as a run, which is why it reproduces the
        finite-difference speed to a median 0.0003 u/s -- so it cannot tell the
        two apart. It reads 0.0 only for the instantaneous position rewrites,
        which TELEPORT_UNITS already handles.

        Runners keep the flat threshold: the offense actor class does not carry
        either field. See ACTOR_FIELDS in collect_player_tracking.py.
        """
        ceiling = self.assist_speed_ups
        if self.kind != "offense" and self.max_speed:
            ceiling = self.max_speed + GLIDE_TOLERANCE_UPS
        out = []
        for step, t0, t1 in zip(self.steps(), self.times, self.times[1:]):
            dt = t1 - t0
            out.append(dt > 0 and step / dt > ceiling)
        return out

    def steps(self) -> list:
        return [math.dist(a[::2], b[::2])
                for a, b in zip(self.points, self.points[1:])]

    def teleports(self) -> int:
        return sum(1 for step in self.steps() if step > TELEPORT_UNITS)

    def first_teleport_time(self):
        """The last honest instant before this actor is yanked somewhere.

        Deliberately the time of the sample BEFORE the jump, not after it. A
        window that ends at the post-jump sample still contains the jump: path
        length skips the impossible step but straight-line displacement does
        not, so route efficiency comes out above 1.0 -- which is arithmetically
        impossible and was the tell that this boundary was off by one frame.
        """
        for step, t in zip(self.steps(), self.times[:-1]):
            if step > TELEPORT_UNITS:
                return t
        return None

    def window(self, end_t: float) -> "Track":
        """A copy covering only up to `end_t`."""
        clipped = Track(self.name, self.character, self.index, self.kind)
        for t, point, speed in zip(self.times, self.points, self.game_speeds):
            if t > end_t:
                break
            # The clip carries this track's own character, so the max speed it
            # already resolved is kept rather than re-filtered against nothing.
            clipped.add(t, point, speed, self.max_speed, self.character)
        return clipped

    def displacement(self) -> float:
        if len(self.points) < 2:
            return 0.0
        return math.dist(self.points[0][::2], self.points[-1][::2])

    def speeds(self) -> list:
        """Ground speed per frame pair, in units per second."""
        out = []
        for (t0, p0), (t1, p1) in zip(zip(self.times, self.points),
                                      zip(self.times[1:], self.points[1:])):
            dt = t1 - t0
            step = math.dist(p0[::2], p1[::2])
            if dt > 0 and step <= TELEPORT_UNITS:
                out.append((t1, step / dt))
        return out

    def sprint_speed(self, window: float = 1.0) -> float:
        """Fastest average speed over any `window` seconds of the play."""
        if len(self.points) < 2:
            return 0.0
        best = 0.0
        start = 0
        cumulative = [0.0]
        for step, assisted in zip(self.steps(), self.assists()):
            counted = step <= TELEPORT_UNITS and not assisted
            cumulative.append(cumulative[-1] + (step if counted else 0.0))
        for end in range(len(self.times)):
            while self.times[end] - self.times[start] > window:
                start += 1
            span = self.times[end] - self.times[start]
            if span >= window * 0.75 and span > 0:
                best = max(best, (cumulative[end] - cumulative[start]) / span)
        return best

    def reaction(self) -> float | None:
        """Seconds from the start of the track until sustained movement.

        The hold requirement exists so one noisy frame cannot trip the
        threshold, but the answer is when the body STARTED moving, not when it
        had been moving for three frames. Returning the end of the run would
        add a flat REACTION_HOLD_FRAMES/fps to every reaction in the dataset --
        a bias of the same size as the differences between characters, which is
        the whole thing this metric is for.
        """
        run = 0
        run_started = None
        for t, speed in self.speeds():
            if speed >= REACTION_SPEED_UPS:
                if run == 0:
                    run_started = t
                run += 1
                if run >= REACTION_HOLD_FRAMES:
                    return round(run_started - self.times[0], 4)
            else:
                run = 0
        return None


# Route efficiency on someone who took two steps is dominated by idle jitter and
# is trivially 1.0. Measured on the first real session, a 1u threshold made 247
# of 467 routes exactly 1.000; requiring a real route is what makes the number
# mean anything.
ROUTE_MIN_PATH_UNITS = 5.0


# WHY A FREEZE WITHHOLDS RATHER THAN ADJUSTS. A glide can be subtracted: the
# game moved the body, the frames it moved it are identifiable, and the speed
# over the remaining frames is still the character's own. A freeze cannot. It
# does not add path length, so route efficiency is not inflated arithmetically
# -- it changes what the fielder was doing. He is held for two seconds, the
# ball goes somewhere else, and the route he then runs is a route to a
# different problem. Measured over peach_ice_garden-20260902T151327Z the 18
# frozen fielder-plays have a median route efficiency of 0.684 against 0.971
# for the other 552, and PA 72's 0.2552 is not Toadsworth taking a bad line, it
# is Toadsworth standing still.
#
# Reaction is worse: a fielder frozen at contact cannot react at all, so the
# number measures the freeze.
#
# Neither is recoverable from the capture, so neither is emitted, and
# `frozen_frames` says why. The same rule as the moved_threshold below: a
# number that would not be honest is not published.
def summarise_track(track: Track, moved_threshold: float = ROUTE_MIN_PATH_UNITS,
                    frozen_frames: int = 0) -> dict:
    path = track.path_length()
    sprint_mps = track.sprint_speed()
    out = {
        "name": track.name,
        "character_id": track.character,
        "character": character_name(track.character),
        "batting_index": track.index,
        "start": [round(v, 3) for v in track.points[0]] if track.points else None,
        "end": [round(v, 3) for v in track.points[-1]] if track.points else None,
        "path_units": round(path, 3),
        "run_path_units": round(track.run_path_length(), 3),
        "assist_units": round(track.assist_units(), 3),
        "assist_frames": sum(1 for assisted in track.assists() if assisted),
        "displacement_units": round(track.displacement(), 3),
        "sprint_speed_ups": round(sprint_mps, 3),
        "sprint_speed_fps": round(sprint_mps * 3.280839895, 3),
        "bolt": sprint_mps * 3.280839895 >= 30.0,
        "teleports": track.teleports(),
    }
    # The character's top speed as the game itself stores it, not as measured
    # off this play. A fielder who never had to run flat out still has one, so
    # this is the attribute and `sprint_speed_ups` is the performance -- the two
    # answer different questions and the pipeline had only ever had the second.
    if track.max_speed:
        out["max_speed_ups"] = round(track.max_speed, 3)
        out["max_speed_fps"] = round(track.max_speed * 3.280839895, 3)
    if path >= moved_threshold and not frozen_frames:
        out["reaction_s"] = track.reaction()
        # Route efficiency is only defined for someone who actually went
        # somewhere. On a fielder who shuffled two steps the ratio is dominated
        # by idle jitter and reads like a terrible route.
        out["route_efficiency"] = round(track.displacement() / path, 4)
    return out


def locked_fielder(snapshot: dict) -> str | None:
    """Return the defensive position whose actor is carrying the ball.

    Coordinates say WHO. The game has to say that anyone is holding it at all,
    because a fly ball passing directly over an outfielder's head matches their
    x and z exactly -- on three home runs in the first real session that was
    recorded as the fielder taking possession of a ball that had already left
    the park.

    It says so two ways, and both are needed. `ball_holder` names a carrier, and
    `fair_or_foul` reaching its caught-in-the-air value is the game declaring the
    catch. A robbery at the wall sets the second and not the first: on a
    first-inning catch at Bowser Castle the ball sat exactly on the centre
    fielder at 4.33u for ninety frames with the call already made, and
    `ball_holder` stayed at -1 throughout. Requiring the byte alone threw that
    catch away entirely.

    Neither admits the fly-over: those balls are still in flight, so the call is
    "fair, in the air" rather than "caught", and nobody is carrying them.
    """
    bx, by, bz = snapshot["ball"]
    if bx == 0.0 and by == 0.0 and bz == 0.0:
        return None
    held = int(snapshot["state"].get("ball_holder", -1)) >= 0
    called_caught = int(snapshot["state"].get("fair_or_foul", 0)) == FAIR_CAUGHT_FLAG
    if not held and not called_caught:
        return None
    # Horizontal only. A fielder's tracked height is pinned to 0.00 in every
    # frame of the first real session -- 19,326 live frames, including the 2,180
    # where the game's own airborne flag was set -- so the actor position field
    # simply does not carry height, and comparing the ball's height against it
    # was comparing it against a constant.
    #
    # That rejected every catch made off the ground. Three catch cutscenes in
    # that session hold the ball at 18u to 24u while the fielder reads 0, and
    # the touch was only recorded once they landed: 4.52s became 6.91s, 5.69s
    # became 8.17s, 4.44s became 6.86s. A robbed home run is the hardest
    # opportunity there is, and it was being recorded as a seven-second can of
    # corn. `ball_holder` is what confirms possession here, and it is exact.
    matches = []
    for name, actor in snapshot["actors"].items():
        if actor["kind"] != "fielder":
            continue
        px, _, pz = actor["pos"]
        horizontal = math.dist((px, pz), (bx, bz))
        if horizontal <= LOCK_UNITS:
            matches.append((horizontal, name))
    return min(matches)[1] if matches else None


# A fielder who holds the ball and MOVES is not necessarily carrying it. A ball
# hit hard enough drives the fielder who caught it backwards, and that is an
# impulse rather than a run: it is fastest on the very first frame, it only ever
# slows down, and it travels in a dead-straight line because nothing is steering
# it. A run has to accelerate from a standstill, and it curves.
#
# Measured over dk_jungle-20260902T171957Z: of the 30 ball-holding moves that
# clear the one-unit narrative floor, 14 have this shape and every one of them
# reads displacement/path = 1.000, against 0.28-0.99 for the other 16. The two
# the operator flagged -- "did not use ball dash to run, they got pushed back by
# the power of the hit" -- are both in the 14. Calling those a carry credited
# Ball Dash to a fielder who was standing still being shoved.
KNOCKBACK_STRAIGHTNESS = 0.97
KNOCKBACK_SPEED_TOLERANCE_UPS = 0.05


def classify_carry_motion(track: "Track") -> str:
    """'knockback' for a decaying impulse, 'carry' for self-directed movement.

    Deliberately biased toward 'carry': every test below has to pass before a
    move is called a knockback, so a fielder who is shoved and then runs comes
    out a carry. Under-calling this costs a sentence; over-calling it would
    delete a real Ball Dash observation.
    """
    speeds = [speed for _, speed in track.speeds()]
    moving = [speed for speed in speeds if speed > KNOCKBACK_SPEED_TOLERANCE_UPS]
    if len(moving) < 3:
        return "carry"
    # Sped up at any point -- only a body under its own power does that.
    if any(later > earlier + KNOCKBACK_SPEED_TOLERANCE_UPS
           for earlier, later in zip(moving, moving[1:])):
        return "carry"
    path = track.path_length()
    if path <= 0 or track.displacement() / path < KNOCKBACK_STRAIGHTNESS:
        return "carry"
    return "knockback"


def detect_possession_carries(frames: list, contact_t: float,
                              live_end: float) -> list:
    """Measure each contiguous interval in which a fielder carries the ball.

    This is the activation evidence for Ball Dash. The ability is passive, so
    the meaningful event is not a separate action byte: it is a mapped Ball
    Dash character actually moving while the game's possession state and the
    ball-to-actor coordinate lock both agree they hold the ball.
    """
    live = [snapshot for snapshot in frames
            if snapshot["t"] - contact_t <= live_end + 1e-9]
    by_timer = {snapshot["timer"]: snapshot for snapshot in live}

    def ball_speed_before(timer: int):
        """The loose ball's horizontal speed on its way into a possession frame.

        None when the two frames before possession are not both a free ball --
        a relay taken straight out of another glove has no approach to measure.
        """
        before, earlier = by_timer.get(timer - 1), by_timer.get(timer - 2)
        if before is None or earlier is None:
            return None
        if any(int(snapshot["state"].get("ball_holder", -1)) >= 0
               for snapshot in (before, earlier)):
            return None
        elapsed = before["t"] - earlier["t"]
        if elapsed <= 0:
            return None
        return round(math.dist(before["ball"][::2], earlier["ball"][::2]) / elapsed, 3)

    carries = []
    track = None
    start_frame = None
    end_frame = None
    airborne_start = False

    def finish():
        nonlocal track, start_frame, end_frame, airborne_start
        if track is not None and len(track.points) >= 2:
            distance = track.path_length()
            if distance >= 0.1:
                speeds = [speed for _, speed in track.speeds()]
                carries.append({
                    "by": track.name,
                    "character_id": track.character,
                    "character": character_name(track.character),
                    "start_frame": start_frame,
                    "end_frame": end_frame,
                    "start_t": round(track.times[0], 4),
                    "end_t": round(track.times[-1], 4),
                    "distance_units": round(distance, 3),
                    "displacement_units": round(track.displacement(), 3),
                    "peak_speed_ups": round(max(speeds), 3) if speeds else 0.0,
                    # Whether the fielder moved the ball or the ball moved the
                    # fielder. Ball Dash may only be read off a "carry".
                    "motion": classify_carry_motion(track),
                    # Still in the air on the frame they took the ball, which
                    # is what separates a leaping catch's follow-through from
                    # an impulse delivered to a fielder on their feet.
                    "airborne_at_start": airborne_start,
                    # How fast the ball was travelling when they took it. A
                    # ball can only shove a fielder if it arrives with
                    # something behind it; see KNOCKBACK_BALL_SPEED_UPS.
                    "ball_speed_at_start_ups": ball_speed_before(start_frame),
                })
        track = None
        start_frame = None
        end_frame = None
        airborne_start = False

    for snapshot in live:
        owner = locked_fielder(snapshot)
        if owner is None:
            finish()
            continue
        actor = snapshot["actors"][owner]
        if track is None or track.name != owner:
            finish()
            track = Track(owner, actor["character"], actor["index"],
                          actor.get("kind", "fielder"))
            start_frame = snapshot["timer"]
            airborne_start = bool(actor.get("airborne"))
        track.add(snapshot["t"] - contact_t, actor["pos"],
                  actor.get("speed"), actor.get("max_speed"),
                  actor.get("character"))
        end_frame = snapshot["timer"]
    finish()
    return carries


# A barrel is a body about a unit across and so is a fielder, so contact is
# somewhere near two units. This threshold is PROVISIONAL: it was chosen from
# the geometry, not measured, because the barrel was located after the last
# capture and no session on disk contains one. `closest_units` and
# `closest_frame` are recorded on every barrel run whether or not the flag
# trips, so the first session that records a barrel alongside an operator's
# annotation calibrates this properly and nothing has to be re-captured.
BARREL_HIT_UNITS = 2.5

# How long after closest approach to measure the fielder's motion. A barrel hit
# knocks a player down, so displacement here is independent corroboration that
# something happened -- the distance says they were in the same place, this says
# one of them was moved.
BARREL_KNOCKBACK_FRAMES = 30

# HOW FAR A LIVE BARREL HAS TO TRAVEL before the interval is believed.
#
# THE SLOT IS NOT THE BARREL ANY MORE. 0x92AF5490 was identified live on
# 2026-09-03 and captured from the next session on, and in both DK Jungle
# captures that record it the address is dead: dk_jungle-20260912T150755Z reads
# all-zero on 108,535 of 110,962 frames and garbage (-8.9e33) on the rest, with
# no cannon sentinel ever present, and dk_jungle-20260904T161731Z reads all-zero
# on 77,371 of 77,581 with one 137-frame run of a CONSTANT (0.2523, -0.1100,
# 0.0). That constant clears every existing guard -- finite, in range, non-zero,
# away from both sentinels -- so it reads as a live barrel parked 0.28u from
# home plate, which is precisely the Mario Stadium failure the park gate was
# added for, arriving instead through the one park the gate lets through.
#
# A measured barrel is fired from a cannon and crosses the outfield at 19-25
# u/s, covering tens of units. One that never moved a unit is not a barrel, and
# this is the cheapest test that separates the two without inventing a radius.
BARREL_MIN_TRAVEL_UNITS = 1.0


# WHAT DROVE THE FIELDER BACK. `classify_carry_motion` was built out of the
# operator's own reading of two DK Jungle plays -- "they got pushed back by the
# power of the hit" -- and then the sentence refused to say so, on the grounds
# that a barrel looks the same and the capture holds no field separating them.
# It holds three.
#
# A knockback is an impulse delivered to a fielder who is HOLDING THE BALL, and
# possession begins on an exact frame. Across mario_stadium-20260904T000419Z's
# 17 knockbacks, 16 begin on the frame that fielder first touched the batted
# ball and the 17th begins on the frame a throw arrived in their glove --
# frame-exact, not close. A hazard is under no such obligation: it reaches a
# fielder whenever it gets there, and it sets `knockdown_flag`, which fired zero
# times all game.
#
# So the ball is named when it demonstrably arrived at that instant, the
# knockdown flag outranks it when it fired, and anything else stays unnamed --
# which is the honest answer for the case this was written to protect.
#
# A LEAP OUTRANKS THE BALL. A fielder who catches in mid-air keeps travelling
# after the catch, and that drift passes every knockback test: fastest on the
# first frame, never speeding up, dead straight. It is their own jump. The
# operator flagged one at Peach Ice Garden -- "think it was his momentum of
# running and jumping to the ball" -- and the airborne flag agrees frame-exact:
# of the 25 knockbacks in peach_ice_garden-20260907T234715Z, 3 were airborne on
# the possession frame and 22 were not, and those 3 are the three smallest
# displacements in the set (1.4, 1.7, 1.9 units against a spread that runs to
# 26.8). The jump began before the ball arrived, so where both are true the
# capture cannot separate them and the leap is the one that was already
# happening.
# AND THE GAME MOVES FIELDERS BY ITSELF, which looks exactly like a knockback.
# On 09-11 PA50 Bowser caught a liner, the train floored him two frames later,
# the ball rolled out of his glove and sat there, and 104 frames later he took
# possession of it again from 4.18u away: the ball snapped into his glove and
# the game slid him 1.65u onto its spot, 5.39 u/s on the frame before and 16.98
# u/s on the frame after. That passes every knockback test -- fastest first,
# only slowing, dead straight -- with nothing to deliver it, because the ball it
# names was crawling at 0.93 u/s. PA23's train-struck ball arrived at 13.0 u/s
# and drove Toadsworth back 4.6u, which is the real thing.
#
# This bound sits between the two measured cases and is PROVISIONAL: the ball
# speed is a new field, so the archive has not been re-derived with it yet.
KNOCKBACK_BALL_SPEED_UPS = 4.0


def name_carry_impulses(carries: list, first_touch: dict | None, throws: list,
                        knocked_frames: dict) -> None:
    """Record what delivered each knockback, in place."""
    for carry in carries:
        start = carry["start_frame"]
        speed_in = carry.get("ball_speed_at_start_ups")
        arrived_fast = None if speed_in is None else speed_in >= KNOCKBACK_BALL_SPEED_UPS
        on_first_touch = bool(first_touch and first_touch.get("by") == carry["by"]
                              and first_touch.get("frame") == start)
        # A SHOVE THE GAME CUT SHORT. The track ends when the ball leaves the
        # glove, so a fielder floored just after the catch keeps only the first
        # frames of the shove the ball gave him -- too few for
        # classify_carry_motion, which needs three moving frames, and far under
        # the narrative's one-unit floor. 09-11 PA50: Bowser went from a
        # standstill to 12.8 u/s on the frame he caught a ball arriving at 19.7
        # u/s, moving in the ball's own direction of travel, and the train
        # floored him two frames later. Jason watched it -- "it was the hit that
        # drove him back", "yes it was at the moment of the catch" -- and the
        # derivation had thrown it away and described a glide 1.8 s later.
        #
        # ONE play in the whole archive meets this, so it is deliberately
        # narrow and PROVISIONAL at n=1: the catch frame, a ball measured
        # arriving fast, and a knockdown of that same fielder within two frames
        # of the track's end. The other 17 carries a knockdown ends run 17
        # frames or longer and classify on their own shape; the slow ones
        # (0.5-2.9 u/s) fail the ball-speed test.
        cut_short = [frame for frame in knocked_frames.get(carry["by"] + "@frame", [])
                     if carry["end_frame"] < frame <= carry["end_frame"] + 2]
        interrupted = bool(carry.get("motion") != "knockback" and cut_short
                           and on_first_touch and arrived_fast)
        if carry.get("motion") != "knockback" and not interrupted:
            continue
        if interrupted:
            # The distance is an artefact of the interruption; the speed is the
            # measurement, so the sentence leads with it.
            carry["truncated_by_knockdown"] = True
            carry["impulse"] = "batted_ball"
            carry["impulse_frame"] = start
            continue
        floored = [frame for frame in knocked_frames.get(carry["by"] + "@frame", [])
                   if carry["start_frame"] <= frame <= carry["end_frame"]]
        arrivals = [throw for throw in throws
                    if throw.get("receiver_position") == carry["by"]
                    and throw.get("arrival_frame") == start]
        touched = bool(first_touch and first_touch.get("by") == carry["by"]
                       and first_touch.get("frame") == start)
        speed = carry.get("ball_speed_at_start_ups")
        crawling = None if speed is None else speed < KNOCKBACK_BALL_SPEED_UPS
        if floored:
            carry["impulse"] = "knockdown"
        elif carry.get("airborne_at_start"):
            carry["impulse"] = "leap"
        elif arrivals:
            carry["impulse"] = "thrown_ball"
        # An unmeasurable approach keeps the old answer; only a ball MEASURED
        # to be crawling loses the right to be called the thing that shoved them.
        elif touched and crawling is not True:
            carry["impulse"] = "batted_ball"
        elif crawling:
            carry["impulse"] = "possession_glide"
        else:
            carry["impulse"] = None
        carry["impulse_frame"] = start


def detect_barrel_events(frames: list, contact_t: float, live_end: float,
                         knockdowns: dict | None = None,
                         park: str | None = None) -> list:
    """Every interval a DK Jungle barrel was in play, and who it reached.

    A barrel is live exactly when its slot is away from both cannon sentinels,
    which is a state the game writes rather than anything inferred here. For
    each live interval this measures the barrel's path and its closest approach
    to every fielder.

    GATED ON THE PARK, because nothing else gates it. The capture reads the
    barrel regions at every park on purpose -- a uniform record is worth the 896
    bytes -- and the collector's own comment says the INTERPRETATION is gated
    here. It was not. The slot only holds a cannon sentinel in the park that has
    cannons, so at the other eight "away from both sentinels" is true on every
    frame of every play, and mario_stadium-20260904T000419Z came back with a
    barrel permanently parked 0.6 units from the catcher on all 92 plays: 51
    sentences reporting a hazard that park does not have, and a garbage float
    (-8.9e33) that summed to NaN and made the whole plays file unreadable to
    every consumer on the JavaScript side.
    """
    if park != "dk_jungle":
        return []
    live = [snapshot for snapshot in frames
            if snapshot["t"] - contact_t <= live_end + 1e-9
            and snapshot.get("barrel")]
    events, current = [], None

    def finish():
        nonlocal current
        if current is not None and len(current["path"]) >= 2:
            points = current["path"]
            distance = sum(math.dist(a[::2], b[::2])
                           for a, b in zip(points, points[1:]))
            # A BARREL MOVES. The zero guard above rejects an all-zero slot and
            # the range guard rejects garbage, but neither rejects a small
            # CONSTANT -- and that is what the slot actually holds now.
            # dk_jungle-20260904T161731Z reads (0.2523, -0.1100, 0.0) for 137
            # consecutive frames: finite, in range, non-zero, away from both
            # cannon sentinels, and therefore "a live barrel" by every test
            # there was. It produced no event only because those frames fell
            # outside every play window, which is luck rather than a guard.
            # Measured barrels cross the outfield at 19-25 u/s and travel tens
            # of units; one that never moved a single unit is not a barrel.
            if distance < BARREL_MIN_TRAVEL_UNITS:
                current = None
                return
            approaches = []
            # `None` means the session predates the knockdown flag and has
            # nothing better; an EMPTY dict means the flag was captured and did
            # not fire, which is a measurement saying no. Testing `knockdowns or
            # {}` conflated the two and sent every ordinary play down the
            # provisional-radius path.
            floored = knockdowns
            for name, (units, frame, index) in current["closest"].items():
                after = current["fielders"].get(name, [])
                moved = 0.0
                if index is not None and index < len(after) - 1:
                    tail = after[index : index + BARREL_KNOCKBACK_FRAMES]
                    if len(tail) >= 2:
                        moved = math.dist(tail[0][::2], tail[-1][::2])
                # THE GAME SAYS WHETHER THEY WERE HIT. `knockdown_flag` fires
                # on a floored fielder, so a barrel hit is read off the flag
                # rather than off a radius somebody chose. BARREL_HIT_UNITS
                # survives only as a fallback for a session recorded before the
                # flag was named, and `closest_units` is still reported either
                # way -- it is what makes a disagreement between the two
                # visible instead of silent.
                knocked_at = [f for f in (floored or {}).get(name + "@frame", [])
                              if current["start_frame"] <= f
                              <= current["end_frame"] + BARREL_KNOCKBACK_FRAMES]
                confirmed = bool(knocked_at)
                approaches.append({
                    "by": name,
                    "closest_units": round(units, 3),
                    "closest_frame": frame,
                    "fielder_moved_units_after": round(moved, 3),
                    "knocked_down": confirmed,
                    "knocked_down_frame": knocked_at[0] if knocked_at else None,
                    "hit": confirmed if floored is not None else units <= BARREL_HIT_UNITS,
                    "hit_source": ("knockdown_flag" if floored is not None
                                   else "distance_fallback"),
                })
            approaches.sort(key=lambda entry: entry["closest_units"])
            events.append({
                "sequence": len(events) + 1,
                "start_frame": current["start_frame"],
                "end_frame": current["end_frame"],
                "start_t": round(current["start_t"] - contact_t, 4),
                "end_t": round(current["end_t"] - contact_t, 4),
                "from_cannon": current["from_cannon"],
                "distance_units": round(distance, 3),
                "start": [round(v, 4) for v in points[0]],
                "end": [round(v, 4) for v in points[-1]],
                "peak_height_units": round(max(p[1] for p in points), 3),
                "approaches": approaches,
                "hit_fielders": [a["by"] for a in approaches if a["hit"]],
            })
        current = None

    previous_cannon = None
    for snapshot in live:
        barrel = snapshot["barrel"]
        if not barrel["live"]:
            finish()
            previous_cannon = barrel["cannon"] or previous_cannon
            continue
        if current is None:
            current = {
                "start_frame": snapshot["timer"], "end_frame": snapshot["timer"],
                "start_t": snapshot["t"], "end_t": snapshot["t"],
                # Which cannon it was sitting in immediately before it fired.
                "from_cannon": previous_cannon,
                "path": [], "closest": {}, "fielders": {},
            }
        current["end_frame"] = snapshot["timer"]
        current["end_t"] = snapshot["t"]
        current["path"].append(barrel["pos"])
        for name, actor in snapshot["actors"].items():
            if actor["kind"] != "fielder":
                continue
            track = current["fielders"].setdefault(name, [])
            track.append(actor["pos"])
            gap = math.dist(barrel["pos"][::2], actor["pos"][::2])
            best = current["closest"].get(name)
            if best is None or gap < best[0]:
                current["closest"][name] = (gap, snapshot["timer"], len(track) - 1)
    finish()
    return events


def closest_target_base(point: tuple, bags: dict, home: tuple | None = None) -> str | None:
    candidates = {
        "first": bags.get("R1"), "second": bags.get("R2"),
        "third": bags.get("R3"), "home": home,
    }
    distances = []
    for name, bag in candidates.items():
        if bag is None:
            continue
        distances.append((math.dist(point[::2], bag[::2]), name))
    if not distances:
        return None
    distance, name = min(distances)
    return name if distance <= TARGET_BASE_RADIUS_UNITS else None


def frozen_fielder_frames(samples: list) -> int:
    """How many consecutive opening frames hold every fielder perfectly still.

    A cutscene freezes all nine actors at once. Real play never does: even a
    fielder standing his ground drifts by fractions of a unit frame to frame.
    """
    frozen = 0
    for before, after in zip(samples, samples[1:]):
        still = all(
            actor["pos"] == after["actors"][name]["pos"]
            for name, actor in before["actors"].items()
            if actor["kind"] == "fielder"
        )
        if not still:
            break
        frozen += 1
    return frozen


# How long the play window is held open past the game's own dead-ball call.
# Every detector windows at `live_end`, so these frames feed exactly one thing:
# `final_bases_ran`, which has to see a runner's count settle through the actor
# teardown. Measured against the full archive -- 445 plays across five parks --
# as the smallest tail that leaves every derived field unchanged, with the
# widest real advance-after-dead-ball at 62 frames.
DEAD_BALL_TAIL_FRAMES = 90

# The ball rests at y=0 but bounces off the ground to a minimum near 0.5, so the
# landing is the first low turning point rather than a zero crossing. 1.5u sits
# above every measured bounce minimum and below the flight it came out of.
LANDING_HEIGHT_UNITS = 1.5


# +0x2B2 was originally named `bobble_flag`, but three real sessions show that
# it is an action enum, not a boolean. Treating every non-zero value as a boot
# produced 27 "deflections" in one game, including every Buddy Throw and every
# clean pickup. The values observed against video and the game's other state:
#
#   1  secure pickup/catch animation
#   2  boot/misplay (ball reached, not secured)
#   3  a second boot/misplay animation. Daisy Cruiser supplied three video-
#      labelled examples: a routine grounder through Blue Kritter, Green Noki
#      failing to secure a star swing before RF caught it, and Diddy Kong
#      booting a ball that had already bounced.
#   5  Yoshi egg contact. All four occurrences in the Daisy Cruiser session
#      were Yoshi's captain star swing reaching a fielder; the forced first
#      bobble is the mechanic, not an ordinary fielding failure.
#   7  intentional diving toss/redirection to a nearby teammate. A chemistry
#      Buddy Throw can accompany it, but chemistry is not required.
#
# Values 2 and 3 are ordinary failed contacts. Value 5 is retained separately
# so it cannot become an error or teach the ordinary OAA model. Value 7 is a
# secure, intentional toss rather than a failure.
FIELDING_ACTION_SECURE = 1
FIELDING_ACTION_MISPLAYS = (2, 3)
# 4 = A STAR-SWING BALL FORCING THE FIRST CONTACT. Every action-4 window ever
# recorded -- two in this session on Blue Yoshi, one at Peach Ice Garden on
# Bowser Jr. -- was hit by MARIO, and by nobody else across five sessions of
# plays. The operator names the mechanic directly: Mario's Fire Swing turns the
# ball into a fireball the first fielder to reach it cannot hold. That is the
# same shape as Yoshi's egg, which the game gives its own code (5), and it is
# handled the same way: the fielder has no play to make, so the misplay is
# forced and no error may be charged for it.
FIELDING_ACTION_STAR_BALL = 4
FIELDING_ACTION_YOSHI_EGG = 5
FIELDING_ACTION_BUDDY_HANDOFF = 7

# Both codes are a batter's star ball forcing a contact the fielder cannot
# hold. They stay separate codes because they are separate mechanics with
# separate names; they are grouped wherever the question is "did the fielder
# have a play to make".
FIELDING_ACTION_FORCED = (FIELDING_ACTION_STAR_BALL, FIELDING_ACTION_YOSHI_EGG)

# HOW FAR A FIELDER CAN POSSIBLY REACH, in units, measured in three dimensions
# from the tracked body centre to the ball.
#
# The action byte is an animation state, not a claim about the ball: it fires
# for one frame as a fly ball sails overhead, and the tracker .exe turns that
# single frame into "X bobbled the ball!". Two such windows exist in the
# archive -- Donkey Kong with the ball 34.9u above him at DK Jungle, Baby DK
# with it 26.0u above him at Bowser Castle -- and in both the ball was a home
# run that no one came near.
#
# The bound is measured, not assumed: across 233 contacts the game's own
# `last_contact_fielder` confirms, the largest separation at the moment of
# contact is 6.29u, and the largest at a MISS the capture recorded is 8.71u.
# Twelve units is comfortably outside everything a fielder has ever actually
# touched and far inside the two overhead balls, so a window beyond it is an
# animation that coincided with a ball, not a play on one.
FIELDING_REACH_LIMIT_UNITS = 12.0

# Freezie disappearance supplies the event; proximity supplies its cause. The
# labelled breaks split cleanly: a ball that breaks one is at most 6.2u from
# its centre, while the new buddy-attack control has the ball 43.9u away and
# the attacking fielder 2.5u away. These generous limits sit outside those
# observations without turning a merely nearby actor into the cause.
FREEZIE_BALL_CONTACT_LIMIT_UNITS = 7.0
FREEZIE_BUDDY_CONTACT_LIMIT_UNITS = 6.0

# A ball rebounding from a frozen fielder has its own unmistakable physical
# trace. The labelled Blue Kritter example reverses 136 degrees at 3.1u. The
# detector retains room for the actor/ball body radii while requiring a large
# direction change, so an ordinary pass by a frozen actor is not an event.
FROZEN_FIELDER_BALL_CONTACT_UNITS = 4.0
FROZEN_FIELDER_REBOUND_TURN_DEGREES = 60.0
FREEZIE_BALL_REBOUND_CONTACT_UNITS = 4.0
FREEZIE_BALL_REBOUND_TURN_DEGREES = 60.0

# DAISY CRUISER'S DAY TABLES. Five operator-labelled ball/table contacts across
# two independent sessions split into two physical signatures:
#
#   * the ball reverses vertically 1.90-2.13u above the field when it lands on
#     a tabletop;
#   * it turns 52-132 degrees 1.44-2.28u up when it strikes a table edge.
#
# Ordinary turf contacts sit at 0.25-0.40u. The one labelled near-miss has
# three such ground bounces and no candidate above 1u. The back wall in the
# same labelled play turns the ball at radius 101u, beyond this table zone.
# These are consequence-side measurements: the impact coordinate is a place a
# table was OBSERVED, not a claim that every table's object is captured.
TABLE_MIN_CONTACT_HEIGHT_UNITS = 1.0
TABLE_MAX_CONTACT_HEIGHT_UNITS = 3.0
TABLE_MIN_VERTICAL_SPEED_UPS = 1.0
TABLE_MIN_SIDE_TURN_DEGREES = 45.0
TABLE_MIN_RADIUS_UNITS = 45.0
TABLE_MAX_RADIUS_UNITS = 90.0
TABLE_FIELDER_EXCLUSION_FRAMES = 12
TABLE_CONTACT_GROUP_FRAMES = 12
TABLE_OBJECT_MATCH_UNITS = 12.0
TABLE_TRANSFORM_COPY_OFFSET = 0x30
TABLE_ACTIVE_VALUE = 1
TABLE_BREAK_CONTACT_UNITS = 12.0
TABLE_THROW_PATH_UNITS = 8.0

# The value `buddy_jump_flag` takes while the game runs a Buddy Jump. See
# detect_buddy_jumps for why the other observed value is not one.
BUDDY_JUMP_FLAG_ACTIVE = 2

# How far back to look when asking whether a runner standing at a base ARRIVED
# there with the throw. Half a second: long enough that a runner at a measured
# 9 u/s has covered about 4.5 units, short enough that it stays inside the play.
CLOSE_PLAY_LOOKBACK_FRAMES = 30

# A CLOSE PLAY IS A DIFFERENCE IN TIME, NOT IN DISTANCE, and reading it off the
# gap in units was wrong in both directions.
#
# A runner is at the bag when they are inside this radius -- every runner
# standing on a measured bag in the archive sits 0.78-0.82 units from its
# centre. The frame they first get inside it and the frame the ball arrives are
# both measured, and `margin_s` is the difference: negative when the runner beat
# the throw, positive when the throw beat the runner.
#
# WHY THE OLD READING FAILED. Distance-at-arrival conflates the margin with the
# runner's speed. A runner at 12 u/s is four units from first a third of a
# second before reaching it, so every close play at first -- which is always
# taken at full speed -- failed a three-unit gate; and a runner who beat the
# throw two seconds ago is 0.8 units from the bag standing still, so the
# closing-speed test that was there to exclude them excluded every runner who
# WON a close play as well. In peach_ice_garden-20260907T234715Z the two gates
# selected disjoint sets: five throws inside three units, six with a runner
# still closing, no overlap, and the game narrated zero close plays. Measured in
# time the same session has five, at +0.18, +0.33, +0.37, +0.42 and -0.47 s.
RUNNER_AT_BASE_UNITS = 1.5

# How far past the ball's arrival to keep looking for the runner reaching the
# bag. A runner beaten by the throw still finishes the stride, and that finish
# is what makes the margin measurable on a play the runner LOST -- four of the
# five above are outs by under half a second.
CLOSE_PLAY_REACH_SEARCH_FRAMES = 120


# HOW THE APPROACH TO THE BALL IS CLASSIFIED (`catch_type`, actor +0x2AC).
#
# The fielding AI picks its approach before the ball arrives, writes the choice
# to this byte, and clears it on the frame the glove closes. The values were
# read off three archived sessions (wario_stadium, mario_stadium,
# peach_ice_garden -- 433 windows) and one live one:
#
#   1  ordinary catch. The fielder is standing still for the whole window.
#   2  catching a THROW. The countdown at +0x2A5 equals the frames of throw
#      flight still to come, and every window ends on a receiver's catch.
#   3  DIVE. In all 55 of them the fielder is still running at full step at the
#      moment of the catch and keeps sliding for several frames afterwards,
#      which no type-1 window ever does. Those that end in possession take the
#      ball at a height of ~0; those that do not are the balls that carry
#      through to the outfielder behind.
#   5  CLAMBER. The fielder climbs the wall; this is not a dive.
#   6  LEAP. This is the only value the airborne flag at +0x22E accompanies
#      (30/30), and it is what the 18u-24u catches at the wall are.
#   7  a dash with real displacement (~2.1u) that is not yet resolved to a
#      named mechanic, so it is reported with its raw code and nothing else.
#
# THE AIRBORNE FLAG IS NOT A DIVE DETECTOR and never was: it fires for 6 and
# never for 3. That is why every dive in the archive read as an ordinary play.
#
# 0x2B3 and 0x2B4 both read 2 for exactly the type-3 windows and 0 or 1 for
# every other type across all four sessions, so they remain a free cross-check
# if this classification is ever doubted.
#
# Type 3 says a fielder used the single dive/special-action input. The character
# mapping distinguishes an ordinary dive from Super Dive, Tongue Catch,
# Suction Catch, Magical Catch, Piranha Catch, Keeper Catch, and the three Bro
# throws. The derivation keeps the raw approach and tracker_abilities.mjs names
# the character-specific animation.
CATCH_TYPE_ORDINARY = 1
CATCH_TYPE_THROW = 2
CATCH_TYPE_DIVE = 3
CATCH_TYPE_CLAMBER = 5
CATCH_TYPE_LEAP = 6
CATCH_TYPE_NAMES = {
    CATCH_TYPE_ORDINARY: "ordinary",
    CATCH_TYPE_THROW: "throw",
    CATCH_TYPE_DIVE: "dive",
    CATCH_TYPE_CLAMBER: "clamber",
    CATCH_TYPE_LEAP: "leap",
}

# How many frames after a window closes an event may still be attributed to it.
# The byte clears on the same frame the catch registers, so the run ends one
# frame BEFORE its own possession event; two frames of slack covers that
# without reaching the next window.
CATCH_TYPE_ATTRIBUTION_FRAMES = 2


# WHAT A REACH MEASUREMENT NEEDS, beyond which approach the fielder chose.
#
# The workbook publishes a catch RADIUS per character per approach -- how far
# from the body the glove reaches on an ordinary catch, on a dive, on a leap.
# A radius is only comparable against a measured SEPARATION: how far the ball
# actually was from the fielder when the attempt resolved. Nothing here
# recorded that, so the approach windows could say Tiny Kong dove and could not
# say whether the dive was a stretch or a formality.
#
# The separation is taken at the closest point of the window rather than at its
# end, because a missed dive keeps travelling after the ball is past and its
# last frame is not where the attempt was decided. Height is reported relative
# to the fielder's own feet, not as an absolute ball y, so that a wall catch on
# the Daisy Cruiser deck and one at ground level are the same number.
#
# ONE OBSERVED CATCH IS A LOWER BOUND ON THE RADIUS AND NEVER THE RADIUS.
# The fielder is not obliged to catch at full stretch, so the largest
# separation seen is only the largest that has happened -- the true reach is at
# least that and unknown above it. Failures are what bound it from the other
# side, which is why a window that never secures the ball is kept and marked
# rather than dropped.
def _horizontal(a, b) -> float | None:
    if not a or not b:
        return None
    return math.dist((a[0], a[2]), (b[0], b[2]))


def detect_catch_approaches(frames: list, contact_t: float) -> list:
    """One record per contiguous non-zero `catch_type` window per fielder.

    Each window carries the geometry the reach comparison needs: the closest
    the ball came to the fielder while the approach was live, the ball's height
    above that fielder's feet at that moment, and the assistance flags that
    disqualify the window from being read as ordinary mechanics.
    """
    approaches = []
    active = {}

    def finish(name, last):
        window = active.pop(name, None)
        if window is None:
            return
        window["end_frame"] = last["timer"]
        window["end_t"] = round(last["t"] - contact_t, 4)
        closest = window.pop("_closest", None)
        window["separation_units"] = (
            round(closest["separation"], 3) if closest else None)
        window["separation_3d_units"] = (
            round(closest["separation_3d"], 3) if closest else None)
        window["relative_height_units"] = (
            round(closest["relative_height"], 3) if closest else None)
        window["ball_height_units"] = (
            round(closest["ball_height"], 3) if closest else None)
        window["closest_frame"] = closest["frame"] if closest else None
        window["closest_t"] = (
            round(closest["t"] - contact_t, 4) if closest else None)
        # The glide is how the fielder GOT there; what disqualifies a reach
        # measurement is the game still moving the body on the frame the
        # attempt resolved.
        window["assisted_at_closest"] = bool(closest and closest["glided"])
        window["assisted"] = bool(
            window["assist_frames"] or window["buddy_jump_frames"])
        approaches.append(window)

    previous = None
    for snapshot in frames:
        for name, actor in snapshot["actors"].items():
            if actor.get("kind") != "fielder":
                continue
            code = actor.get("catch_type") or 0
            window = active.get(name)
            if window is not None and window["catch_type"] != code:
                finish(name, previous or snapshot)
                window = None
            if code and window is None:
                active[name] = {
                    "by": name,
                    "character_id": actor["character"],
                    "character": character_name(actor["character"]),
                    "catch_type": code,
                    "approach": CATCH_TYPE_NAMES.get(code, "unresolved"),
                    "dive": code == CATCH_TYPE_DIVE,
                    "leap": code == CATCH_TYPE_LEAP,
                    "start_frame": snapshot["timer"],
                    "start_t": round(snapshot["t"] - contact_t, 4),
                    "airborne_frames": 0,
                    "buddy_jump_frames": 0,
                    "assist_frames": 0,
                    "max_speed_ups": None,
                }
                window = active[name]
            if window is not None:
                window["frames"] = window.get("frames", 0) + 1
                if actor.get("airborne"):
                    window["airborne_frames"] += 1
                if actor.get("buddy_jump"):
                    window["buddy_jump_frames"] += 1
                # The game reports 0.0 ground speed for exactly the frames it
                # is GLIDING the body to the ball (see ACTOR_FIELDS in the
                # collector). A window with glided frames is the game closing
                # the gap, not the character's reach.
                glided = False
                if actor.get("speed") == 0 and previous is not None:
                    before = previous["actors"].get(name)
                    if before and before.get("pos") and actor.get("pos"):
                        if math.dist(before["pos"], actor["pos"]) > 1e-4:
                            window["assist_frames"] += 1
                            glided = True
                # Already u/s out of player_tracking_io; do not scale again.
                if actor.get("max_speed") and window["max_speed_ups"] is None:
                    window["max_speed_ups"] = round(actor["max_speed"], 3)
                separation = _horizontal(snapshot.get("ball"), actor.get("pos"))
                if separation is not None:
                    ball = snapshot["ball"]
                    # THE CLOSEST POINT IS CHOSEN IN 3D, not on the ground
                    # plane. A catch radius bounds a reach, and a ball passing
                    # directly overhead is at its smallest HORIZONTAL
                    # separation exactly when it is furthest out of reach --
                    # picking that frame would report a dive under a ball four
                    # units up as a 0.7-unit attempt.
                    separation_3d = math.dist(ball, actor["pos"])
                    closest = window.get("_closest")
                    if closest is None or separation_3d < closest["separation_3d"]:
                        window["_closest"] = {
                            "separation": separation,
                            "separation_3d": separation_3d,
                            "relative_height": ball[1] - actor["pos"][1],
                            "ball_height": ball[1],
                            "frame": snapshot["timer"],
                            "t": snapshot["t"],
                            "glided": glided,
                        }
        previous = snapshot
    for name in list(active):
        finish(name, previous)
    approaches.sort(key=lambda window: (window["start_frame"], window["by"]))
    return approaches


def approach_at(approaches: list, name: str, frame: int) -> dict | None:
    """The approach window this fielder was in on (or just before) `frame`."""
    best = None
    for window in approaches:
        if window["by"] != name:
            continue
        if not (window["start_frame"] <= frame
                <= window["end_frame"] + CATCH_TYPE_ATTRIBUTION_FRAMES):
            continue
        if best is None or window["start_frame"] > best["start_frame"]:
            best = window
    return best


def approach_fields(window: dict | None) -> dict:
    """The approach keys carried on a fielding event."""
    if window is None:
        return {
            "catch_type": None,
            "approach": None,
            "dive": False,
            "leap": False,
        }
    return {
        "catch_type": window["catch_type"],
        "approach": window["approach"],
        "dive": window["dive"],
        "leap": window["leap"],
        "approach_frames": window.get("frames", 0),
        "approach_start_frame": window["start_frame"],
    }

def _ball_motion_change(frames: list, index: int) -> dict:
    """Horizontal turn and speed around a fielding contact.

    The action enum is authoritative; this physics is retained as an audit
    trail. A boot can deaden a ball without turning it, so turn angle must not
    be used as the classifier.
    """
    if index < 8 or index + 8 >= len(frames):
        return {}
    before_a, before_b = frames[index - 8], frames[index - 4]
    after_a, after_b = frames[index + 4], frames[index + 8]

    def velocity(first, second):
        dt = second["t"] - first["t"]
        if dt <= 0:
            return None
        return ((second["ball"][0] - first["ball"][0]) / dt,
                (second["ball"][2] - first["ball"][2]) / dt)

    incoming = velocity(before_a, before_b)
    outgoing = velocity(after_a, after_b)
    if incoming is None or outgoing is None:
        return {}
    speed_in = math.hypot(*incoming)
    speed_out = math.hypot(*outgoing)
    if speed_in <= 1e-9 or speed_out <= 1e-9:
        turn = None
    else:
        cosine = max(-1.0, min(1.0,
            (incoming[0] * outgoing[0] + incoming[1] * outgoing[1])
            / (speed_in * speed_out)))
        turn = math.degrees(math.acos(cosine))
    return {
        "incoming_speed_ups": round(speed_in, 3),
        "outgoing_speed_ups": round(speed_out, 3),
        "trajectory_turn_degrees": round(turn, 3) if turn is not None else None,
    }


def detect_frozen_fielder_ball_contacts(frames: list, contact_t: float,
                                        live_end: float, order: list) -> list:
    """Ball releases/rebounds at a fielder while their freeze flag is active."""
    candidates = []
    for index in range(8, len(frames) - 8):
        snapshot = frames[index]
        if snapshot["t"] - contact_t > live_end:
            break
        if snapshot["state"].get("ball_holder") != -1:
            continue
        for name, actor in snapshot["actors"].items():
            if actor.get("kind") != "fielder" or not actor.get("frozen"):
                continue
            distance = math.dist(snapshot["ball"], actor["pos"])
            if distance > FROZEN_FIELDER_BALL_CONTACT_UNITS:
                continue
            motion = _ball_motion_change(frames, index)
            turn = motion.get("trajectory_turn_degrees")
            if turn is None or turn < FROZEN_FIELDER_REBOUND_TURN_DEGREES:
                continue
            candidates.append((index, name, distance, motion))

    # The turn is visible across several neighbouring samples. Collapse that
    # run to the closest approach, but keep later separated rebounds.
    groups = []
    for candidate in candidates:
        index, name, _, _ = candidate
        if (groups and name == groups[-1][-1][1]
                and frames[index]["timer"] <= frames[groups[-1][-1][0]]["timer"] + 1):
            groups[-1].append(candidate)
        else:
            groups.append([candidate])

    events = []
    for group in groups:
        index, name, distance, motion = min(group, key=lambda item: item[2])
        snapshot = frames[index]
        actor = snapshot["actors"][name]
        previous_holder = frames[index - 1]["state"].get("ball_holder")
        actor_index = order.index(name) if name in order else None
        outcome = ("knocked_loose" if previous_holder == actor_index
                   else "rebound")
        # Use possession witnessed earlier on THIS play, not last_ball_holder:
        # that scalar can still name someone from the previous play before a
        # newly batted ball has ever entered a glove.
        prior_holder = next((earlier["state"].get("ball_holder")
                             for earlier in reversed(frames[:index])
                             if isinstance(earlier["state"].get("ball_holder"), int)
                             and earlier["state"].get("ball_holder") >= 0), None)
        source_name = (order[prior_holder]
                       if prior_holder is not None
                       and prior_holder < len(order) else None)
        source = (snapshot["actors"].get(source_name)
                  if source_name is not None else None)
        event = {
            "by": name,
            "character_id": actor["character"],
            "character": character_name(actor["character"]),
            "t": round(snapshot["t"] - contact_t, 4),
            "frame": snapshot["timer"],
            "outcome": outcome,
            "at": [round(value, 3) for value in actor["pos"]],
            "ball_at": [round(value, 3) for value in snapshot["ball"]],
            "distance_units": round(distance, 3),
            **motion,
        }
        if source_name is not None and source_name != name and source is not None:
            event.update({
                "source_thrower_position": source_name,
                "source_thrower_character_id": source["character"],
                "source_thrower_character": character_name(source["character"]),
            })
        events.append(event)
    return events


def attribute_freezie_breaks(freezie_breaks: list, frames: list,
                              buddy_attacks: list, throws: list) -> None:
    """Attach the measured cause of each Freezie disappearance in place."""
    snapshots = {snapshot["timer"]: snapshot for snapshot in frames}
    frame_indices = {snapshot["timer"]: index
                     for index, snapshot in enumerate(frames)}
    order = [name for name, actor in frames[0]["actors"].items()
             if actor.get("kind") == "fielder"] if frames else []
    for broken in freezie_breaks:
        frame = broken["frame"]
        snapshot = snapshots.get(frame)
        at = tuple(broken["at"])
        if snapshot is None:
            broken["cause"] = {"type": "unknown"}
            continue

        attack_candidates = []
        for attack in buddy_attacks:
            if not attack.get("hit"):
                continue
            if not (attack["timer"] <= frame
                    < attack["timer"] + attack["frames"]):
                continue
            actor = snapshot["actors"].get(attack["by"])
            if actor is None:
                continue
            distance = math.dist(actor["pos"], at)
            if distance <= FREEZIE_BUDDY_CONTACT_LIMIT_UNITS:
                attack_candidates.append((distance, attack))

        # When both are nearby, the exact successful buddy-attack window plus
        # the closer body is stronger causal evidence than ball proximity.
        if attack_candidates:
            distance, attack = min(attack_candidates, key=lambda item: item[0])
            ball_distance = broken.get("distance_units")
            if ball_distance is None or distance < ball_distance:
                broken["cause"] = {
                    "type": "fielder_buddy_attack",
                    "by": attack["by"],
                    "character_id": attack["character_id"],
                    "character": attack["character"],
                    "attack_timer": attack["timer"],
                    "distance_units": round(distance, 3),
                }
                attack["clears_freezie"] = True
                continue

        active_throw = next((throw for throw in throws
                             if throw["launch_frame"] <= frame
                             <= throw["arrival_frame"]), None)
        ball_near = (broken.get("distance_units") is not None
                     and broken["distance_units"]
                     <= FREEZIE_BALL_CONTACT_LIMIT_UNITS)
        if active_throw is not None and ball_near:
            broken["cause"] = {
                "type": "thrown_ball",
                "by": active_throw["thrower_position"],
                "character_id": active_throw["thrower_character_id"],
                "character": active_throw["thrower_character"],
                "throw_sequence": active_throw["sequence"],
            }
        elif ball_near and snapshot["state"].get("ball_status") == 2:
            # A Freezie can interrupt a throw before anybody receives it, so
            # detect_throws has no possession pair to publish. The transition
            # into ball_status 2 plus possession witnessed earlier on this play
            # still establishes the throw and its source.
            index = frame_indices[frame]
            prior_holder = next((earlier["state"].get("ball_holder")
                                 for earlier in reversed(frames[:index])
                                 if isinstance(
                                     earlier["state"].get("ball_holder"), int)
                                 and earlier["state"].get("ball_holder") >= 0),
                                None)
            if prior_holder is not None and prior_holder < len(order):
                name = order[prior_holder]
                actor = snapshot["actors"][name]
                broken["cause"] = {
                    "type": "thrown_ball",
                    "by": name,
                    "character_id": actor["character"],
                    "character": character_name(actor["character"]),
                    "throw_sequence": None,
                    "source": "live_throw_state_after_witnessed_possession",
                }
            else:
                broken["cause"] = {"type": "unknown"}
        elif ball_near:
            broken["cause"] = {"type": "batted_ball"}
        else:
            broken["cause"] = {"type": "unknown"}


def detect_freezie_ball_rebounds(frames: list, contact_t: float,
                                  live_end: float,
                                  freezie_breaks: list) -> list:
    """Physical ball contacts where the Freezie remains intact."""
    candidates = []
    for index in range(8, len(frames) - 8):
        snapshot = frames[index]
        if snapshot["t"] - contact_t > live_end:
            break
        if snapshot["state"].get("ball_holder") != -1:
            continue
        motion = _ball_motion_change(frames, index)
        turn = motion.get("trajectory_turn_degrees")
        if turn is None or turn < FREEZIE_BALL_REBOUND_TURN_DEGREES:
            continue
        for freezie in snapshot.get("freezies", []):
            if not freezie.get("active") or freezie.get("pos") is None:
                continue
            distance = math.dist(snapshot["ball"], freezie["pos"])
            if distance <= FREEZIE_BALL_REBOUND_CONTACT_UNITS:
                candidates.append((index, freezie["slot"], distance, motion))

    groups = []
    for candidate in candidates:
        index, slot, _, _ = candidate
        if (groups and slot == groups[-1][-1][1]
                and frames[index]["timer"]
                <= frames[groups[-1][-1][0]]["timer"] + 1):
            groups[-1].append(candidate)
        else:
            groups.append([candidate])

    break_frames = {(broken["slot"], broken["frame"])
                    for broken in freezie_breaks}
    order = [name for name, actor in frames[0]["actors"].items()
             if actor.get("kind") == "fielder"] if frames else []
    events = []
    for group in groups:
        index, slot, distance, motion = min(group, key=lambda item: item[2])
        snapshot = frames[index]
        if any(broken_slot == slot and abs(broken_frame - snapshot["timer"]) <= 8
               for broken_slot, broken_frame in break_frames):
            continue
        freezie = next(item for item in snapshot["freezies"]
                       if item["slot"] == slot)
        prior_holder = next((earlier["state"].get("ball_holder")
                             for earlier in reversed(frames[:index])
                             if isinstance(earlier["state"].get("ball_holder"), int)
                             and earlier["state"].get("ball_holder") >= 0), None)
        phase = "batted_ball"
        event = {
            "slot": slot,
            "t": round(snapshot["t"] - contact_t, 4),
            "frame": snapshot["timer"],
            "outcome": "remained_active",
            "phase": phase,
            "at": [round(value, 3) for value in freezie["pos"]],
            "ball_at": [round(value, 3) for value in snapshot["ball"]],
            "distance_units": round(distance, 3),
            **motion,
        }
        if prior_holder is not None and prior_holder < len(order):
            name = order[prior_holder]
            actor = snapshot["actors"][name]
            event.update({
                "phase": "thrown_ball",
                "source_thrower_position": name,
                "source_thrower_character_id": actor["character"],
                "source_thrower_character": character_name(actor["character"]),
            })
        events.append(event)
    return events


def daisy_table_objects(props: list | None) -> list:
    """The ten paired 3x4 table transforms in a Daisy Cruiser snapshot.

    Each table owns a transform and an identical copy exactly 0x30 bytes
    later. The active byte is at +0x8A from the first transform. Requiring the
    pair, scale, heading and field location keeps unrelated stadium matrices
    out without hard-coding this match's half-inning-dependent coordinates.
    """
    usable = [prop for prop in props or () if prop.get("pos") is not None]
    by_address = {prop.get("address"): prop for prop in usable}
    tables = []
    for prop in usable:
        address = prop.get("address")
        copy = by_address.get(address + TABLE_TRANSFORM_COPY_OFFSET) \
            if isinstance(address, int) else None
        if copy is None:
            continue
        x, y, z = prop["pos"]
        radius = math.hypot(x, z)
        same_transform = (
            math.dist(prop["pos"], copy["pos"]) <= 1e-4
            and abs((prop.get("scale") or 0) - 1.0) <= 1e-4
            and abs((copy.get("scale") or 0) - 1.0) <= 1e-4
            and abs(prop.get("heading_degrees") or 0) <= 1e-3
            and abs(copy.get("heading_degrees") or 0) <= 1e-3
        )
        if not same_transform or abs(y) > 0.01 or not 45 <= radius <= 95:
            continue
        tables.append({
            **prop,
            "active_raw": prop.get("active_raw"),
            "active": prop.get("active_raw") == TABLE_ACTIVE_VALUE,
        })
    return tables


def _horizontal_segment_distance(point: tuple, start: tuple, end: tuple) -> float:
    px, pz = point[0], point[2]
    ax, az = start[0], start[2]
    bx, bz = end[0], end[2]
    dx, dz = bx - ax, bz - az
    length_sq = dx * dx + dz * dz
    if length_sq <= 1e-9:
        return math.hypot(px - ax, pz - az)
    amount = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / length_sq))
    return math.hypot(px - (ax + amount * dx), pz - (az + amount * dz))


def detect_table_breaks(frames: list, contact_t: float, park: str | None,
                        is_night: bool | None, buddy_attacks: list,
                        throws: list) -> list:
    """Table-object +0x8A transitions, attributed to a measured contact."""
    if park != "daisy_cruiser" or is_night is not False:
        return []
    previous = {}
    breaks = []
    for snapshot in frames:
        tables = daisy_table_objects(snapshot.get("props"))
        for table in tables:
            address = table["address"]
            active = table.get("active")
            was_active = previous.get(address)
            previous[address] = active
            if was_active is not True or active is not False:
                continue
            frame = snapshot["timer"]
            at = tuple(table["pos"])
            cause = {"type": "unknown"}

            for attack in buddy_attacks:
                start = attack.get("timer")
                end = start + attack.get("frames", 0) if isinstance(start, int) else None
                actor = snapshot["actors"].get(attack.get("by"))
                distance = (math.dist(tuple(actor["pos"])[::2], at[::2])
                            if actor and actor.get("pos") else math.inf)
                if (attack.get("hit") and start is not None and end is not None
                        and start - 2 <= frame <= end + 3
                        and distance <= TABLE_BREAK_CONTACT_UNITS):
                    cause = {
                        "type": "fielder_buddy_attack",
                        "by": attack.get("by"),
                        "character_id": attack.get("character_id"),
                        "character": attack.get("character"),
                        "distance_units": round(distance, 3),
                    }
                    break

            if cause["type"] == "unknown":
                for throw in throws:
                    release = throw.get("release_frame")
                    arrival = throw.get("arrival_frame")
                    start, end = throw.get("start"), throw.get("end")
                    if (not isinstance(release, int) or not isinstance(arrival, int)
                            or not start or not end or not release - 2 <= frame <= arrival + 2):
                        continue
                    distance = _horizontal_segment_distance(at, tuple(start), tuple(end))
                    if distance <= TABLE_THROW_PATH_UNITS:
                        cause = {
                            "type": "thrown_ball",
                            "by": throw.get("thrower_position"),
                            "character_id": throw.get("thrower_character_id"),
                            "character": throw.get("thrower_character"),
                            "throw_sequence": throw.get("sequence"),
                            "distance_units": round(distance, 3),
                        }
                        break

            ball = tuple(snapshot["ball"])
            ball_distance = math.dist(ball, at)
            if (cause["type"] == "unknown" and ball_distance <= TABLE_BREAK_CONTACT_UNITS \
                    and snapshot["state"].get("ball_holder") == -1):
                cause = {"type": "batted_ball", "distance_units": round(ball_distance, 3)}

            breaks.append({
                "t": round(snapshot["t"] - contact_t, 4),
                "frame": frame,
                "table": {
                    "address": address,
                    "at": [round(value, 3) for value in at],
                    "scale": table.get("scale"),
                    "heading_degrees": table.get("heading_degrees"),
                },
                "ball_at": [round(value, 3) for value in ball],
                "ball_distance_units": round(ball_distance, 3),
                "active_before": True,
                "active_after": False,
                "cause": cause,
            })
    return breaks


def detect_table_ball_contacts(frames: list, contact_t: float, live_end: float,
                               park: str | None, is_night: bool | None,
                               fielding_events: list,
                               first_touch: dict | None = None) -> list:
    """Measured ball rebounds from Daisy Cruiser's daytime tables.

    The old captures do not contain the table object allocation, so this uses
    the collision itself to record an observed table location. A future
    capture may also carry structurally shortlisted props; when one is close
    to the impact it is attached as the table centre and object address.
    """
    if park != "daisy_cruiser" or is_night is not False:
        return []

    fielder_frames = [event.get("frame") for event in fielding_events
                      if isinstance(event.get("frame"), int)]
    candidates = []
    for index in range(8, len(frames) - 8):
        snapshot = frames[index]
        if snapshot["t"] - contact_t > live_end:
            break
        # This detector describes the BATTED BALL'S meeting with a table. Once
        # a glove has secured it, releases and throw arrivals generate large
        # turns of their own. Table breaks on a later throw need the table's
        # disappearance flag, which older captures do not contain and which is
        # deliberately not guessed from those possession transitions.
        if (first_touch and isinstance(first_touch.get("frame"), int)
                and snapshot["timer"] >= first_touch["frame"]):
            break
        if snapshot["state"].get("ball_holder") != -1:
            continue
        x, y, z = snapshot["ball"]
        radius = math.hypot(x, z)
        if (y < TABLE_MIN_CONTACT_HEIGHT_UNITS
                or y > TABLE_MAX_CONTACT_HEIGHT_UNITS
                or radius < TABLE_MIN_RADIUS_UNITS
                or radius > TABLE_MAX_RADIUS_UNITS):
            continue
        if any(abs(snapshot["timer"] - frame)
               <= TABLE_FIELDER_EXCLUSION_FRAMES
               for frame in fielder_frames):
            continue

        before = frames[index - 4]
        after = frames[index + 4]
        before_dt = snapshot["t"] - before["t"]
        after_dt = after["t"] - snapshot["t"]
        if before_dt <= 0 or after_dt <= 0:
            continue
        incoming_vertical = (y - before["ball"][1]) / before_dt
        outgoing_vertical = (after["ball"][1] - y) / after_dt
        top_bounce = (incoming_vertical <= -TABLE_MIN_VERTICAL_SPEED_UPS
                      and outgoing_vertical >= TABLE_MIN_VERTICAL_SPEED_UPS)
        motion = _ball_motion_change(frames, index)
        turn = motion.get("trajectory_turn_degrees")
        speed_in = motion.get("incoming_speed_ups")
        speed_out = motion.get("outgoing_speed_ups")
        side_rebound = (
            turn is not None and turn >= TABLE_MIN_SIDE_TURN_DEGREES
            and speed_in is not None and speed_out is not None
            and speed_in >= 5.0 and speed_out >= 1.0
            # Every labelled edge impact loses most of its speed. Requiring
            # that loss rejects star-ball curves, Buddy launches and receiver
            # acquisitions, all of which turn while gaining speed.
            and speed_out <= speed_in * 0.8
        )
        if not top_bounce and not side_rebound:
            continue
        candidates.append({
            "index": index,
            "top_bounce": top_bounce,
            "side_rebound": side_rebound,
            "incoming_vertical_ups": incoming_vertical,
            "outgoing_vertical_ups": outgoing_vertical,
            "motion": motion,
        })

    # A reversal spans several centred velocity windows. Collapse the run to
    # the lowest point for a top bounce, or the sharpest turn for an edge hit.
    groups = []
    for candidate in candidates:
        frame = frames[candidate["index"]]["timer"]
        if (groups and frame - frames[groups[-1][-1]["index"]]["timer"]
                <= TABLE_CONTACT_GROUP_FRAMES):
            groups[-1].append(candidate)
        else:
            groups.append([candidate])

    events = []
    for group in groups:
        top = [candidate for candidate in group if candidate["top_bounce"]]
        if top:
            chosen = min(top, key=lambda candidate:
                         frames[candidate["index"]]["ball"][1])
            kind = "tabletop_bounce"
        else:
            chosen = max(group, key=lambda candidate:
                         candidate["motion"].get("trajectory_turn_degrees") or 0)
            kind = "table_edge_rebound"
        index = chosen["index"]
        snapshot = frames[index]
        at = tuple(snapshot["ball"])

        # A nearby structurally captured prop is identified BY the independent
        # collision, never by its transform shape alone. Until such a capture
        # exists, table remains null and `at` is still the observed location.
        table = None
        # Captured TABLES, not captured props: season game 2767 recorded the
        # wrong prop cluster, and treating that as "no table here" vetoed every
        # table hit in the game.
        captured_tables = daisy_table_objects(snapshot.get("props"))
        props_captured = bool(captured_tables)
        props = [prop for prop in captured_tables if prop.get("active")]
        if props:
            closest = min(props, key=lambda prop: math.dist(at, prop["pos"]))
            distance = math.dist(at, closest["pos"])
            if distance <= TABLE_OBJECT_MATCH_UNITS:
                table = {
                    "address": closest.get("address"),
                    "at": [round(value, 3) for value in closest["pos"]],
                    "distance_units": round(distance, 3),
                    "scale": closest.get("scale"),
                    "heading_degrees": closest.get("heading_degrees"),
                }
        # Once the capture contains the actual table objects, the physics
        # signature is only a candidate until it lands on an ACTIVE table.
        # This rejects PA50 in the 2026-09-11 game: the table was broken by a
        # buddy attack first and the ball turned 19u away afterward.
        if props_captured and table is None:
            continue

        events.append({
            "t": round(snapshot["t"] - contact_t, 4),
            "frame": snapshot["timer"],
            "at": [round(value, 3) for value in at],
            "impact_kind": kind,
            "height_units": round(at[1], 3),
            "radius_units": round(math.hypot(at[0], at[2]), 3),
            "incoming_vertical_ups": round(
                chosen["incoming_vertical_ups"], 3),
            "outgoing_vertical_ups": round(
                chosen["outgoing_vertical_ups"], 3),
            **chosen["motion"],
            "table": table,
            "location_source": ("captured_table_transform_at_ball_contact"
                                if table else "measured_ball_contact"),
        })
    return events


# WARIO CITY'S DIRECTIONAL ARROWS. The arrow does not deflect the ball; it
# REWRITES its horizontal velocity. On one frame the horizontal speed is SET to
# a fixed value and the heading SNAPS to the arrow's own axis, which the ball
# then holds to +-0.002 degrees for as long as it keeps rolling while the speed
# decays normally. Nothing else in this archive does that: a bounce, a boot, a
# fielder deflection and a wall all change speed AND direction together, and by
# amounts that vary with what hit what.
#
# MEASURE THE SPEED AS PER-FRAME DISPLACEMENT, NEVER AS A WALL-CLOCK DERIVATIVE.
# `t` is the game's own 60 Hz counter here, so consecutive frames are exact; a
# derivative taken against elapsed wall time jitters the same six events over
# 11.4-12.1 u/s and no tolerance tight enough to mean anything survives it.
#
# THE IMPOSED SPEED IS A CONSTANT, AND AT NIGHT IT IS EXACTLY 2.25x THE DAY ONE.
# Measured over four sessions and 23 operator-annotated redirects:
#
#     day     0.199085 units/frame   (11.945 u/s at 60 Hz)
#     night   0.447941 units/frame   (26.877 u/s at 60 Hz)
#
# 0.447941 / 0.199085 = 2.250000. So this is ONE constant and ONE multiplier,
# and the operator's "the arrows are stronger at night" is 2.25x, exactly.
#
# THE CONSTANT IS UNITS PER FRAME AND MUST NOT BE STORED AS UNITS PER SECOND.
# The game writes a displacement, and the deriver's own frame rate is 59.94 --
# so a constant expressed in u/s is 0.1% wrong the moment anything converts it,
# which is five times this tolerance. Written as u/s it read 26.8496 against a
# 26.8774 target and the night session's six redirects came back as zero. The
# displacement is the invariant; the frame rate is not in the measurement at
# all, and appears below only to report a speed a human can read.
ARROW_IMPOSED_STEP_UNITS = 0.199085
ARROW_NIGHT_MULTIPLIER = 2.25
# Wide enough for the 32-bit rounding that splits the same magnitude into
# different heading components (the two arrow families differ by 1 part in
# 13,000) and far inside the gap to anything else: the nearest non-arrow match
# in the archive is a ball decaying THROUGH this value with no turn at all,
# which the turn gate below removes regardless.
ARROW_STEP_TOLERANCE_UNITS = 0.0004
# The heading has to actually turn. A rolling ball passes through the imposed
# speed constantly on its way down, and 32 of the 39 speed matches in
# wario_city-20260905T191040Z are exactly that -- turn under one degree. The
# smallest turn at a labelled arrow across four sessions is 62.8 degrees.
ARROW_MIN_TURN_DEGREES = 45.0
# ...and then HOLD it. This is what separates an arrow from the pitch-to-bat
# transition, which also matches the displacement for one frame while the ball
# crosses the plate: the four such matches in wario_city-20260904T144308Z all
# sat within 3 units of home plate and left at 17-680 u/s, because the bat had
# just hit the ball. An arrow's heading is still the same number eight frames
# later.
#
# EIGHT, MEASURED. Swept against the 23 operator-annotated redirects in the four
# Wario City sessions, counting a detection outside every annotated PA window as
# a false positive:
#
#     hold  4   22/23 annotated   0 unannotated
#     hold  6   22/23             0
#     hold  8   22/23             0
#     hold 10   21/23             0
#     hold 12   21/23             0
#
# Nothing is bought above 8 and one real event is lost: 20260902 PA7 holds the
# imposed heading for exactly 8 frames before a fielder reaches the ball. The
# 23rd is 20260902 PA55, which holds it for ZERO -- and the operator's note on
# that play says why: "ball hit arrow, but dark bones buddy attacked before ball
# could get away". A redirect with no frames of outgoing travel has no outgoing
# direction to measure, so that one is honestly missing rather than wrongly
# gated.
ARROW_HOLD_FRAMES = 8
ARROW_HOLD_TOLERANCE_DEGREES = 1.0
# How close the ball has to pass to an arrow for that arrow to be named as the
# one it hit. The six night redirects sit 2.5-4.7 units from the object whose
# heading matches, and the next-nearest arrow sharing that axis is 20 units away
# in every case. This is not a proximity argument on its own: the heading has to
# match to within half a degree as well.
ARROW_MATCH_RADIUS_UNITS = 9.0
# An arrow imposes an AXIS, and the ball keeps the sign it arrived with, so the
# measured bearing is the object's heading or that heading turned 180 degrees.
ARROW_AXIS_TOLERANCE_DEGREES = 0.5


def arrow_imposed_step_units(is_night: bool | None) -> float:
    """The per-frame displacement a Wario City arrow writes, by variant."""
    return ARROW_IMPOSED_STEP_UNITS * (ARROW_NIGHT_MULTIPLIER if is_night else 1.0)


def _ball_frame_step(frames: list, index: int):
    """Horizontal displacement over one GAME frame, or None across a gap."""
    if index <= 0:
        return None
    if frames[index]["timer"] != frames[index - 1]["timer"] + 1:
        return None
    now, before = frames[index]["ball"], frames[index - 1]["ball"]
    return (now[0] - before[0], now[2] - before[2])


def _match_arrow(snapshot: dict, heading: float):
    """The captured arrow whose axis AND position fit this redirect, or None."""
    candidates = []
    for prop in snapshot.get("props") or []:
        position = prop.get("pos")
        object_heading = prop.get("heading_degrees")
        if position is None or object_heading is None:
            continue
        # The axis, not the direction: the ball keeps the sign it arrived with.
        axis = abs(((object_heading - heading + 90) % 180) - 90)
        if axis > ARROW_AXIS_TOLERANCE_DEGREES:
            continue
        distance = math.dist(snapshot["ball"][::2], position[::2])
        if distance <= ARROW_MATCH_RADIUS_UNITS:
            candidates.append((distance, prop, object_heading))
    if not candidates:
        return None
    distance, prop, object_heading = min(candidates, key=lambda item: item[0])
    return {
        "address": prop.get("address"),
        "heading_degrees": object_heading,
        "at": [round(value, 3) for value in prop["pos"]],
        "distance_units": round(distance, 3),
    }


def detect_arrow_redirects(frames: list, contact_t: float, live_end: float,
                           fps: float, park: str | None,
                           is_night: bool | None) -> list:
    """Frames where a directional arrow rewrote the ball's horizontal velocity.

    Park-gated for the reason every hazard here is: the signature is a speed and
    a turn, and the speed alone also matches a fielder deflection at Mario
    Stadium. Returns [] everywhere but Wario City.
    """
    if park != "wario_city":
        return []
    target = arrow_imposed_step_units(is_night)
    events = []
    for index in range(2, len(frames) - ARROW_HOLD_FRAMES - 1):
        snapshot = frames[index]
        if snapshot["t"] - contact_t > live_end:
            break
        # An arrow only ever acts on a ball nobody is holding, and all 23
        # labelled redirects agree. Cheap, and it removes the possession
        # artefacts that match the speed while a fielder carries the ball.
        if snapshot["state"].get("ball_holder") != -1:
            continue
        step = _ball_frame_step(frames, index)
        previous = _ball_frame_step(frames, index - 1)
        if step is None or previous is None:
            continue
        displacement = math.hypot(*step)
        if abs(displacement - target) > ARROW_STEP_TOLERANCE_UNITS:
            continue
        if math.hypot(*previous) < 1e-9:
            continue
        heading = math.degrees(math.atan2(step[0], step[1]))
        before = math.degrees(math.atan2(previous[0], previous[1]))
        turn = abs(((heading - before + 180) % 360) - 180)
        if turn < ARROW_MIN_TURN_DEGREES:
            continue
        held = 0
        for ahead in range(1, ARROW_HOLD_FRAMES + 1):
            later = _ball_frame_step(frames, index + ahead)
            if later is None or math.hypot(*later) < 1e-9:
                break
            drift = abs(((math.degrees(math.atan2(later[0], later[1])) - heading
                          + 180) % 360) - 180)
            if drift > ARROW_HOLD_TOLERANCE_DEGREES:
                break
            held += 1
        if held < ARROW_HOLD_FRAMES:
            continue
        if events and snapshot["timer"] - events[-1]["frame"] <= 30:
            continue
        events.append({
            "t": round(snapshot["t"] - contact_t, 4),
            "frame": snapshot["timer"],
            "at": [round(value, 3) for value in snapshot["ball"]],
            "incoming_speed_ups": round(math.hypot(*previous) * fps, 3),
            "outgoing_speed_ups": round(displacement * fps, 3),
            # The measurement itself, in the units the game writes it in.
            "imposed_step_units": round(displacement, 6),
            "heading_degrees": round(heading, 4),
            "incoming_heading_degrees": round(before, 4),
            "turn_degrees": round(turn, 3),
            "held_frames": held,
            # Named only when this session actually captured the objects. A
            # session recorded before the props were located says null rather
            # than guessing which arrow it was.
            "arrow": _match_arrow(snapshot, heading),
        })
    return events


# WARIO CITY'S MANHOLES. Five of them, and unlike the arrows their positions do
# NOT change between matches -- measured identical in the 2026-09-09 and
# 2026-09-10 captures, and identical between the start and end memory dumps of
# each. The operator says the same: "the manholes are always there and in the
# same spot". So these are park constants, while the ALLOCATION that holds them
# still moves and is still located structurally at capture time.
#
#     ( 50, -0.4, -40)  right foul territory
#     ( 30, -0.4, -75)  right-centre
#     (  0, -0.4, +11)  behind home plate -- the operator counted four and this
#                       is the fifth; nothing is hit there and the camera does
#                       not look at it
#     (-30, -0.4, -75)  left-centre
#     (-50, -0.4, -40)  left foul territory
#
# y = -0.4 is recessed below the field. They are the same object class as the
# arrows -- 0xAC stride, translation at +0x0C/+0x1C/+0x2C -- drawn at uniform
# scale 0.7 with heading 0.
WARIO_MANHOLES = (
    (50.0, -0.4, -40.0), (30.0, -0.4, -75.0), (0.0, -0.4, 11.0),
    (-30.0, -0.4, -75.0), (-50.0, -0.4, -40.0),
)

# How close the floored fielder has to be for a manhole to be NAMED as what
# floored him. Every one of the nine knockdown onsets in the two annotated night
# sessions sits between 3.08 and 3.82 units from a manhole -- a band that tight
# over nine events is the eruption's own knockback distance, not a coincidence
# of whatever happened to be nearest.
#
# THE CONTROL IS WHAT MAKES THIS AN ATTRIBUTION AND NOT A PROXIMITY ARGUMENT.
# Fielders stand ON these manholes routinely and are not knocked down: the
# closest an UPRIGHT fielder came is 0.04 units in one session and 0.92 in the
# other, and 620 fielder-frames were spent inside four units of a manhole
# mid-cycle with nobody floored. Distance alone therefore predicts nothing --
# which is exactly the operator's account, that a manhole only stuns "if water
# spouts out from it, which only happens on certain plays". The knockdown FLAG
# is what says somebody went down; this only says which manhole was under them.
MANHOLE_KNOCKDOWN_RADIUS_UNITS = 5.0

# A BALL CAN LAND ON AN ERUPTING MANHOLE. Operator, 2026-09-10 PA36: "the ball
# hit the explodnng manhole, which is why it went out of the park for a ground
# rule double, not a hommerun... the ball is not shown landing, but it did land,
# just on the raised manhole."
#
# Measured on that play: at frame 32219->32220 the ball's VERTICAL velocity
# reverses, -0.152 to +0.118 units/frame, at y = 3.02 and 2.4 units from the
# (30, -75) manhole -- while the horizontal step carries on decaying smoothly,
# 0.4402 to 0.4383, with no change of heading at all. That is a bounce off a
# raised surface about 2.7 units up, and it is the opposite signature to an
# arrow, which rewrites the horizontal and leaves the vertical alone.
#
# It also explains a null `landing`: the landing detector waits for the ball to
# reach the ground, and this ball never did -- it bounced off the manhole and
# left the park. Reporting the strike is what turns "no landing" from a missing
# measurement into a described one.
MANHOLE_BALL_STRIKE_RADIUS_UNITS = 5.0
# Ground contact in this park sits at y = 0.25-0.6. Three units up is not the
# ground by any reading, and the one measured strike is at 3.02.
MANHOLE_BALL_STRIKE_MIN_HEIGHT_UNITS = 1.5
# A bounce reverses the vertical and keeps the horizontal. Past this the ball
# was turned as well, which is an arrow or an actor and not a flat surface.
MANHOLE_BALL_STRIKE_MAX_TURN_DEGREES = 20.0


def wario_manhole_spots(props: list | None) -> list:
    """The manholes to measure against: the captured ones, else the constants.

    A session that located them carries the real allocation, which is the
    stronger evidence and also the check -- if a capture ever disagrees with the
    constants above, that is worth knowing rather than papering over. A session
    recorded before they were located (2026-09-09 found the arrows and missed
    the manholes by 6.7 KB) still resolves, because their positions are fixed.
    """
    found = []
    for prop in props or ():
        position = prop.get("pos")
        scale = prop.get("scale")
        if position is None or scale is None:
            continue
        if abs(scale - 0.7) < 1e-6 and abs(position[1] + 0.4) < 1e-3:
            spot = (round(position[0], 3), round(position[1], 3), round(position[2], 3))
            if spot not in found:
                found.append(spot)
    return found or list(WARIO_MANHOLES)


def _nearest_manhole(point, spots):
    """(distance, spot) for the closest manhole to an (x, y, z) point."""
    if not spots:
        return None, None
    distance, spot = min(
        (math.dist((point[0], point[2]), (item[0], item[2])), item) for item in spots)
    return distance, spot


def name_manhole_knockdowns(knockdowns: list, frames: list, park: str | None,
                            spots: list) -> None:
    """Attach the manhole that floored each fielder, in place.

    `knockdown_flag` is park-neutral and says only that something hit somebody.
    At Wario City the something is a manhole, and this says which. Everywhere
    else it is left unnamed, exactly as before.
    """
    if park != "wario_city":
        return
    snapshots = {snapshot["timer"]: snapshot for snapshot in frames}
    for knock in knockdowns:
        snapshot = snapshots.get(knock.get("frame"))
        actor = (snapshot or {}).get("actors", {}).get(knock.get("by"))
        if actor is None:
            continue
        distance, spot = _nearest_manhole(actor["pos"], spots)
        if distance is None:
            continue
        # RECORDED EVEN WHEN IT DECLINES. A knockdown this leaves unnamed is not
        # a measurement that failed, it is a measurement that came out far --
        # and the difference matters, because Wario City has a cause that is
        # not the stadium at all (see the Luigi plays in the 2026-09-10 game:
        # floored with no ball contact, 24-29u from any manhole). Without the
        # distance on the record there is no way to tell that apart from a
        # manhole the radius just missed.
        knock["manhole_distance_units"] = round(distance, 3)
        if distance > MANHOLE_KNOCKDOWN_RADIUS_UNITS:
            continue
        knock["hazard"] = "manhole_water"
        knock["manhole_at"] = [round(value, 3) for value in spot]


# BOWSER CASTLE. Jason, 2026-09-05, five annotations: King Bob-omb throws bombs
# that floor fielders, a Bowser statue in centre field breathes fire, and lava
# falls. None of it was ever named -- the park reported no stadium events at all
# while 33 hazard onsets sat measured in the capture and were discarded, because
# the burned byte is only read out when a captain's star swing claims it.
#
# TWO BYTES CARRY THE WHOLE PARK. The bomb sets knocked_down (+0x23F); both
# fires set burned (+0x23E). Measured across all four captures:
#
#   THE BOMB's flag holds value 1 for exactly 40 frames and then value 2. 15
#     onsets, and all three of Jason's labelled bombs are this shape (f33839,
#     f36879, f68063). The tail varies from 26 to 73 frames; phase one never
#     does. Birdo's star swing is 1x39 -> 2x40, a frame short of it, and is
#     named from the star-swing flag before this runs.
#   FIVE ONSETS NEVER REACH VALUE 2 -- single runs of 34, 59, 91, 112 and 127
#     frames. They floor fielders who are not in the play, at scattered
#     mid-outfield spots, and one fires between plays entirely. No annotation
#     covers any of them, so they stay UNNAMED with their shape recorded. The
#     next labelled Bowser Castle game is what resolves them.
#
#   THE STATUE stands 11u in front of the centre-field fence. Six burns land on
#     a flat front at z = -88.3 +- 0.6 spanning x -10 to +10, across four
#     sessions, day and night, six different characters -- a fixed object's
#     footprint, placed from what it does exactly as the pipes were. The other
#     seven burns are scattered through left and right field. That is a gap
#     rather than a threshold: statue-side max 0.60u, lava-side min 19.28u.
BOWSER_CASTLE_STATUE_FRONT_Z = -88.3
BOWSER_CASTLE_STATUE_FRONT_X = (-10.5, 10.5)
# Five times the furthest measured statue burn, and still six times under the
# nearest lava burn.
BOWSER_CASTLE_STATUE_RADIUS_UNITS = 3.0
BOMB_KNOCKDOWN_PHASE_ONE_FRAMES = 40


def statue_front_distance(point) -> float:
    """Ground distance from a point to the centre-field statue's measured front."""
    low, high = BOWSER_CASTLE_STATUE_FRONT_X
    return math.dist((point[0], point[2]),
                     (min(max(point[0], low), high), BOWSER_CASTLE_STATUE_FRONT_Z))


def name_bowser_castle_burns(burns: list, frames: list, park: str | None,
                             claimed: set) -> list:
    """Bowser Castle's two fire hazards, told apart by where the fielder stood.

    A captain's fire star swing writes the same byte and is already claimed by
    name_star_swing_effects, which keeps it. Every other park's burns are
    star-claimed too -- all 19 of them in the archive -- so this names the only
    unclaimed set there is.
    """
    if park != "bowser_castle":
        return []
    snapshots = {snapshot["timer"]: snapshot for snapshot in frames}
    named = []
    for burn in burns:
        if (burn["by"], burn["frame"]) in claimed:
            continue
        snapshot = snapshots.get(burn["frame"])
        actor = ((snapshot or {}).get("actors") or {}).get(burn["by"])
        if actor is None:
            continue
        # A FLAG THAT OUTLIVED ITS OWNER IS NOT AN EVENT. The burned byte is not
        # cleared when the sides change: one run began with three outs already
        # recorded and stayed up for 468 frames through the intermission, by
        # which point the slot held the other team's player (character 42 -> 56
        # at f44501) at frozen coordinates. Its duration describes two different
        # people, so it is dropped and says why.
        last = snapshots.get(burn["frame"] + burn["frames"] - 1)
        last_actor = ((last or {}).get("actors") or {}).get(burn["by"])
        if last_actor is not None and last_actor["character"] != actor["character"]:
            # KEPT IN THE RECORD, unnamed, saying why. A measurement that came
            # out unusable is not the same as one that never happened, and
            # without the reason on the record a 468-frame burn simply vanishes.
            burn["discarded"] = "flag_outlived_the_side_change"
            burn["hazard"] = None
            named.append(burn)
            continue
        distance = statue_front_distance(actor["pos"])
        # Recorded even where it declines to name, exactly as the manhole does:
        # a burn this puts on the lava is a measurement that came out far, and
        # without the distance there is no telling that from one the radius
        # just missed.
        burn["statue_front_distance_units"] = round(distance, 3)
        burn["at"] = [round(value, 3) for value in actor["pos"]]
        burn["hazard"] = ("statue_fire"
                          if distance <= BOWSER_CASTLE_STATUE_RADIUS_UNITS
                          else "falling_lava")
        named.append(burn)
    return named


def name_bomb_knockdowns(knockdowns: list, park: str | None) -> None:
    """King Bob-omb's bombs, named from the knockdown flag's own phases, in place.

    Runs after the star swing, and never overrides a named hazard.
    """
    if park != "bowser_castle":
        return
    for knock in knockdowns:
        phases = knock.get("phases")
        if not phases:
            continue
        knock["phase_shape"] = "->".join(f"{value}x{count}" for value, count in phases)
        if knock.get("hazard"):
            continue
        value, held = phases[0]
        if (value == 1 and held == BOMB_KNOCKDOWN_PHASE_ONE_FRAMES
                and len(phases) > 1):
            knock["hazard"] = "bob_omb_bomb"
            knock["hazard_source"] = "knockdown_flag_phases"


# YOSHI PARK'S SIX PIPES. Jason, 2026-09-11: one each in left- and right-centre,
# one down each foul line, and one out of play beside first and beside third; a
# ball can go into one and come out of another, and a fielder who dives into one
# is stunned. No pipe object is inside any captured region, so these are park
# constants, placed from what the pipes DO in the five Yoshi Park captures:
#
#     (-21.9, -70.0)  left_centre        ( 21.9, -70.0)  right_centre
#     (-38.1, -48.6)  left_field_line    ( 38.1, -48.6)  right_field_line
#     (-29.9, -16.0)  third_base_foul    ( 29.9, -16.0)  first_base_foul
#
#   CENTRE PIPES. The only round hole in five games of fielder occupancy, ~2u in
#   radius; the left and right holes are mirror images to 0.1u.
#   LINE PIPES. Three free balls rebounding off a vertical surface -- 09-11 frame
#   64092 on the left, 08-31T03 27482 and 08-31T14 57732 on the right -- each
#   traced 2u back along its normal, agreeing to ~0.5u once mirrored. The 09-11
#   left fielder's dive into it began 2.1u from that centre.
#   FOUL PIPES. The night Piranha Plant holds the ball exactly 4.93u out from its
#   pipe along the line it then spits it (left-centre: 0.8 degrees from the
#   occupancy hole), and the third-base spit in 08-31T03 PA28 puts that pipe at
#   (-29.9, -16.0). The first-base pipe is that point mirrored; nothing has
#   measured it on its own yet.
#
# Every pipe is more than 26u from its nearest neighbour, far outside any radius
# below.
YOSHI_PIPES = (
    ("left_centre", (-21.9, 0.0, -70.0)),
    ("right_centre", (21.9, 0.0, -70.0)),
    ("left_field_line", (-38.1, 0.0, -48.6)),
    ("right_field_line", (38.1, 0.0, -48.6)),
    ("third_base_foul", (-29.9, 0.0, -16.0)),
    ("first_base_foul", (29.9, 0.0, -16.0)),
)

# A BALL THROUGH A PIPE. Both transits on disk are night ones (08-31T03 PA1 and
# PA28, annotated "the piranha plant in the pipe ate the ball and brought it to a
# new pipe"), and both run the same three phases:
#
#   held     the ball stops dead 2.0-4.1u from the entry pipe
#   carried  a straight line to the exit pipe in exactly 45 frames, at constant
#            velocity in all three axes -- no gravity and no drag
#   held     117 frames 4.93u from the exit pipe, then spat out at 0.199 u/f
#
# No daytime transit has been captured, so nothing here depends on that exact
# shape. A transit is any unbroken run of frames a free ball cannot produce on
# its own -- stopped dead, moving at constant velocity, or jumping more than
# PIPE_JUMP_UNITS in one frame -- that STARTS beside one pipe and ENDS beside a
# different one. The different pipe is what keeps a dive catch out: the game
# also freezes a free ball in mid-air while a fielder dives at it (09-11 frames
# 40128 and 73378, one of them 5.6u from a pipe), and that ball goes nowhere.
PIPE_TRANSIT_RADIUS_UNITS = 6.0
# Faster than a 95 mph batted ball moves in a frame (0.71u), and slower than both
# measured snaps into a carry (2.03u and 2.91u).
PIPE_JUMP_UNITS = 2.0
# The two carries covered 0.93 and 1.48 u/f. A roll decelerates and a flight
# falls, so neither holds its velocity to a thousandth of a unit two frames running.
PIPE_CARRY_MIN_STEP_UNITS = 0.25
PIPE_CARRY_TOLERANCE_UNITS = 1e-3
PIPE_STOPPED_UNITS = 1e-4
# The snap from a hold into a carry breaks the constant-velocity test for one
# frame, so a run survives that many ordinary frames before it ends.
PIPE_RUN_GAP_FRAMES = 3

# A PIRANHA PLANT HITTING A FIELDER WHILE IT HAS THE BALL. Three reviewed
# onsets now make the signature exact rather than anecdotal:
#
#   08-31T03 f1834  RF, 25 frames after the plant takes the ball, 1.81u away
#   08-31T03 f1974  LF, 21 frames before the plant spits it, 1.12u away
#   09-12T14 f23967 3B, 21 frames before the plant spits it, 0.85u away
#
# All three raise the game's knockdown flag while the free ball is in the
# already-detected Piranha transport, beside the affected fielder. No other
# archived play has a knockdown during any pipe transit. The endpoint window
# prevents an unrelated hit during the cross-field carry from being attributed
# to the plant, and horizontal distance is used because the held ball is 4u
# above the fielder's ground position.
PIRANHA_TRANSIT_MIN_HELD_FRAMES = 100
PIRANHA_HIT_ENDPOINT_WINDOW_FRAMES = 30
PIRANHA_HIT_BALL_RADIUS_UNITS = 2.5

# A FIELDER WHO RUNS INTO A PIPE IS STUNNED, on the shared hazard-stun byte
# (+0x243) -- the same run a Daisy Cruiser table and a Luigi's Mansion grave
# produce. The three onsets at Yoshi Park in five games:
#
#   09-11 frame 64054     LF Baby Mario dives (catch_type 3) 2.1u from the
#                         left-field-line pipe and is thrown back to 3.2u
#   08-31T13 frame 2385   RF Petey Piranha, walking with the ball, is pushed
#                         straight out from the right-centre pipe to 4.1u. No
#                         dive: running into one does it too
#   08-30 frame 40639     Bowser Jr.'s paint, 14.8u from the nearest pipe;
#                         star_swing_effects claims it before this runs
PIPE_STUN_RADIUS_UNITS = 5.0


def _nearest_pipe(point):
    """(distance, name, spot) for the Yoshi Park pipe closest to an (x, y, z) point."""
    return min((math.hypot(point[0] - spot[0], point[2] - spot[2]), name, spot)
               for name, spot in YOSHI_PIPES)


def _free_ball_step(frames: list, index: int):
    """The ball's 3D displacement into `index`, or None unless it was free on both frames."""
    if index <= 0:
        return None
    now, before = frames[index], frames[index - 1]
    if now["timer"] != before["timer"] + 1:
        return None
    if (now["state"].get("ball_holder") != -1
            or before["state"].get("ball_holder") != -1):
        return None
    step = tuple(a - b for a, b in zip(now["ball"], before["ball"]))
    return step if all(math.isfinite(value) for value in step) else None


def detect_pipe_transits(frames: list, contact_t: float, live_end: float,
                         park: str | None, is_night: bool | None,
                         buddy_handoffs: list | None = None) -> list:
    """Balls that went into one Yoshi Park pipe and came out of another."""
    if park != "yoshi_park":
        return []
    unnatural = []
    for index in range(1, len(frames)):
        if frames[index]["t"] - contact_t > live_end:
            break
        step = _free_ball_step(frames, index)
        if step is None:
            continue
        horizontal = math.hypot(step[0], step[2])
        if horizontal < PIPE_STOPPED_UNITS:
            unnatural.append((index, "held"))
            continue
        if math.hypot(*step) > PIPE_JUMP_UNITS:
            unnatural.append((index, "jump"))
            continue
        previous = _free_ball_step(frames, index - 1)
        if (previous is not None and horizontal >= PIPE_CARRY_MIN_STEP_UNITS
                and all(abs(a - b) <= PIPE_CARRY_TOLERANCE_UNITS
                        for a, b in zip(step, previous))):
            unnatural.append((index, "carried"))

    runs = []
    for index, kind in unnatural:
        if runs and index - runs[-1][-1][0] <= PIPE_RUN_GAP_FRAMES + 1:
            runs[-1].append((index, kind))
        else:
            runs.append([(index, kind)])

    transits = []
    for run in runs:
        first, last = run[0][0], run[-1][0]
        # The last ordinary frame before the run is where the ball met the pipe;
        # the last frame of the run is where it was released.
        entry_at, exit_at = frames[first - 1]["ball"], frames[last]["ball"]
        entry_distance, entry_pipe, entry_spot = _nearest_pipe(entry_at)
        exit_distance, exit_pipe, exit_spot = _nearest_pipe(exit_at)
        if (entry_distance > PIPE_TRANSIT_RADIUS_UNITS
                or exit_distance > PIPE_TRANSIT_RADIUS_UNITS
                or entry_pipe == exit_pipe):
            continue
        # A BUDDY HANDOFF HOLDS THE BALL TOO. The handoff is played as a
        # cutscene -- the ball hangs unheld at a constant height while the
        # animation runs -- which is the same "held then carried" signature a
        # pipe leaves, and the endpoints can fall near two different pipes by
        # coincidence. yoshi_park-20260911T220152Z play 94 is one: a run from
        # frame 72046 to 72116 read as left_centre -> left_field_line, with the
        # ball pinned at y=3.0 at both ends and the exit landing exactly on the
        # handoff's own action_end_frame (71998-72116). A ball inside a pipe is
        # not simultaneously inside a fielder's handoff animation, so a run that
        # sits wholly within one belongs to the handoff.
        entry_frame, exit_frame = frames[first]["timer"], frames[last]["timer"]
        if any(start is not None and end is not None
               and start <= entry_frame and exit_frame <= end
               for start, end in ((handoff.get("action_start_frame"),
                                   handoff.get("action_end_frame"))
                                  for handoff in buddy_handoffs or ())):
            continue
        kinds = [kind for _, kind in run]
        held_frames = kinds.count("held")
        # Captures before 2026-09-02 did not record the day/night bytes. Their
        # two operator-labelled Piranha transports are still distinguishable:
        # the plant holds the ball for 141-166 frames, versus 26 in both known
        # daytime pipe transits. This also lets those earlier positives remain
        # part of the detector's regression set.
        legacy_piranha = (is_night is None
                           and held_frames >= PIRANHA_TRANSIT_MIN_HELD_FRAMES)
        transits.append({
            "t": round(frames[first]["t"] - contact_t, 4),
            "frame": frames[first]["timer"],
            "exit_t": round(frames[last]["t"] - contact_t, 4),
            "exit_frame": frames[last]["timer"],
            "transit_s": round(frames[last]["t"] - frames[first - 1]["t"], 4),
            "entry_pipe": entry_pipe,
            "entry_pipe_at": list(entry_spot),
            "entry_at": [round(value, 3) for value in entry_at],
            "entry_distance_units": round(entry_distance, 3),
            "exit_pipe": exit_pipe,
            "exit_pipe_at": list(exit_spot),
            "exit_at": [round(value, 3) for value in exit_at],
            "exit_distance_units": round(exit_distance, 3),
            "held_frames": held_frames,
            "carried_frames": kinds.count("carried"),
            "jump_frames": kinds.count("jump"),
            # A Piranha Plant does the carrying at night and the pipe does it by
            # day. Legacy captures use the independently reviewed long-hold
            # signature above instead of pretending their missing byte was day.
            "mechanism": ("piranha_plant" if is_night is True or legacy_piranha
                          else "pipe" if is_night is False else None),
        })
    return transits


def name_piranha_knockdowns(knockdowns: list, frames: list,
                            pipe_transits: list, park: str | None) -> None:
    """Name a fielder floored by the plant taking or spitting the live ball."""
    if park != "yoshi_park":
        return
    by_timer = {snapshot["timer"]: snapshot for snapshot in frames}
    for knock in knockdowns:
        if knock.get("hazard"):
            continue
        frame = knock.get("frame")
        snapshot = by_timer.get(frame)
        actor = ((snapshot or {}).get("actors") or {}).get(knock.get("by"))
        if actor is None:
            continue
        for transit in pipe_transits:
            if transit.get("mechanism") != "piranha_plant":
                continue
            entry_delta = frame - transit["frame"]
            exit_delta = transit["exit_frame"] - frame
            if entry_delta < 0 or exit_delta < 0:
                continue
            endpoint_delta = min(entry_delta, exit_delta)
            if endpoint_delta > PIRANHA_HIT_ENDPOINT_WINDOW_FRAMES:
                continue
            distance = math.dist(actor["pos"][::2], snapshot["ball"][::2])
            if distance > PIRANHA_HIT_BALL_RADIUS_UNITS:
                continue
            phase = "eat" if entry_delta <= exit_delta else "spit"
            pipe_key = "entry_pipe" if phase == "eat" else "exit_pipe"
            pipe_at_key = "entry_pipe_at" if phase == "eat" else "exit_pipe_at"
            knock.update({
                "hazard": "piranha_plant",
                "hazard_source": "knockdown_during_piranha_transport",
                "piranha_phase": phase,
                "pipe": transit.get(pipe_key),
                "pipe_at": transit.get(pipe_at_key),
                "ball_at": [round(value, 3) for value in snapshot["ball"]],
                "ball_distance_units": round(distance, 3),
                "endpoint_delta_frames": endpoint_delta,
            })
            break


def name_pipe_stuns(impact_stuns: list, claimed: set, approaches: list,
                    park: str | None) -> list:
    """The impact stuns at Yoshi Park that a pipe caused, with the pipe named."""
    if park != "yoshi_park":
        return []
    named = []
    for stun in impact_stuns:
        if stun.get("at") is None or (stun["by"], stun["frame"]) in claimed:
            continue
        distance, pipe, spot = _nearest_pipe(stun["at"])
        if distance > PIPE_STUN_RADIUS_UNITS:
            continue
        window = approach_at(approaches, stun["by"], stun["frame"])
        named.append({
            **stun,
            "pipe": pipe,
            "pipe_at": list(spot),
            "pipe_distance_units": round(distance, 3),
            "dive": bool(window and window.get("dive")),
        })
    return named


# YOSHI PARK'S TRAIN. Jason, 2026-09-11, seven annotations: "the train drives
# around the outfield in a constant same path like a normal train does... it
# starts in the lf wall, drives into the rf wall, then comes back out in the lf
# wall." It floors fielders on the knockdown flag (+0x23F), and at night the
# Wiggler does the same thing along the same wall.
#
# THE TRAIN'S DIRECT POSITION IS CAPTURED IN NEW SESSIONS. The full-memory
# probes from two day games found a stable copy at 0x811F84DC: it followed the
# outfield loop and was within 12u of the floored fielder at all 26 sampled
# train knockdowns. Older captures do not contain that address, so their honest
# fallback remains the measured fence band: all annotated hits were 1.6-7.9u
# inside the fence, while non-train causes were 13u or more inside.
TRAIN_FENCE_BAND_UNITS = 9.0
TRAIN_CONTACT_RADIUS_UNITS = 12.0

_FENCES = {}


def park_fence(park: str) -> list:
    """(angle_degrees, radius) samples of a park's measured fence, origin-relative.

    Read from src/utils/parkGeometry.js, the copy the preview already draws with,
    so the deriver cannot disagree with it about where the wall is.
    """
    if park not in _FENCES:
        import re
        from pathlib import Path
        source = (Path(__file__).resolve().parent.parent / "src" / "utils"
                  / "parkGeometry.js").read_text(encoding="utf-8")
        match = re.search(rf"\b{park}: \[\s*((?:\[-?[\d.]+, -?[\d.]+\],?\s*)+)\]", source)
        _FENCES[park] = ([(float(angle), float(radius)) for angle, radius
                          in re.findall(r"\[(-?[\d.]+), (-?[\d.]+)\]", match.group(1))]
                         if match else [])
    return _FENCES[park]


def inside_fence_units(park: str, point) -> float | None:
    """How far inside the fence a ground point stands, along the ray from the origin."""
    x, z = point[0], point[2]
    angle = math.degrees(math.atan2(x, -z))
    fence = park_fence(park)
    for (a0, r0), (a1, r1) in zip(fence, fence[1:]):
        if not a0 <= angle <= a1:
            continue
        p0 = (r0 * math.sin(math.radians(a0)), -r0 * math.cos(math.radians(a0)))
        p1 = (r1 * math.sin(math.radians(a1)), -r1 * math.cos(math.radians(a1)))
        ray = (math.sin(math.radians(angle)), -math.cos(math.radians(angle)))
        edge = (p1[0] - p0[0], p1[1] - p0[1])
        denominator = ray[0] * edge[1] - ray[1] * edge[0]
        if abs(denominator) < 1e-9:
            return None
        wall = (p0[0] * edge[1] - p0[1] * edge[0]) / denominator
        return wall - math.hypot(x, z)
    return None


def name_train_knockdowns(knockdowns: list, frames: list, park: str | None,
                          is_night: bool | None = None) -> None:
    """Name the knockdowns Yoshi Park's train caused, in place.

    Runs after the star swing, and never overrides a named hazard.
    """
    if park != "yoshi_park":
        return
    by_timer = {snapshot["timer"]: snapshot for snapshot in frames}
    for knock in knockdowns:
        if knock.get("hazard"):
            continue
        snapshot = by_timer.get(knock.get("frame"))
        actor = ((snapshot or {}).get("actors") or {}).get(knock.get("by"))
        if actor is None:
            continue
        # 0x811F84DC is confirmed for the day train. Night replaces it with
        # the Wiggler, whose separate object address still has to be located.
        train = (snapshot or {}).get("train") if is_night is False else None
        train_at = (train or {}).get("pos")
        if train_at is not None:
            distance = math.dist(actor["pos"][::2], train_at[::2])
            knock["train_at"] = [round(value, 3) for value in train_at]
            knock["train_distance_units"] = round(distance, 3)
            knock["hazard_source"] = "train_position"
            # Direct evidence gets a veto as well as a positive case. If the
            # train was elsewhere, proximity to the wall cannot overrule it.
            if distance <= TRAIN_CONTACT_RADIUS_UNITS:
                knock["hazard"] = "train"
            continue
        inside = inside_fence_units(park, actor["pos"])
        if inside is None:
            continue
        knock["fence_inside_units"] = round(inside, 3)
        if inside <= TRAIN_FENCE_BAND_UNITS:
            knock["hazard"] = "train"
            knock["hazard_source"] = "fence_band"


def name_knocked_loose_throws(throws: list, knockdowns: list) -> None:
    """A "throw" released on the frame its own thrower was floored, renamed in place.

    The game drops the ball out of the glove on the frame the knockdown flag
    rises, and a floored fielder throws nothing: 09-11 PA77's "Baby Mario threw
    to Diddy Kong at 20 mph" was the train flooring Baby Mario (frame 74862, the
    ball placed at y=0.500 beside him) and then hitting the loose ball. Across
    2408 archived throws the release lands exactly on the thrower's knockdown
    four times -- that train once, a captain's star swing three times. One
    launched three frames BEFORE its thrower went down is a real throw and keeps
    its name.
    """
    for throw in throws:
        knock = next((entry for entry in knockdowns
                      if entry.get("by") == throw["thrower_position"]
                      and entry.get("frame") == throw["release_frame"]), None)
        if knock is None:
            continue
        throw["is_throw"] = False
        throw["event_type"] = "knocked_loose"
        throw["is_relay"] = False
        throw["knocked_loose_by"] = knock.get("hazard")
        throw["knocked_loose_captain"] = knock.get("star_swing_captain")
    # A throw that follows nothing but a ball knocked loose was not relayed.
    for index, throw in enumerate(throws):
        if throw.get("is_relay") and throw.get("is_throw") is not False:
            throw["is_relay"] = any(earlier.get("is_throw") is not False
                                    for earlier in throws[:index])


# HOW CLOSE THE OTHER SIDE OF A CLOSE PLAY HAS TO BE. A close play is a contest
# between two characters, but the flag is written on the FIELDER alone, so the
# record named one of them and left the runner anonymous.
#
# The runner is measured rather than read off the scoring. Across all 16 close
# plays in the archive exactly one occupied runner comes within 2.53 units of
# the contesting fielder while the flag is up, and the next nearest offense
# actor is never closer than 23.7. Nothing lands in between, so the rule is the
# nearest occupied runner and the gate sits in the empty band.
#
# NOT THE THROW MARGIN. RUNNER_AT_BASE_UNITS above times a throw against a
# runner and says nothing about this button-mash contest; the two are separate
# measurements of separate mechanics and neither one implies the other.
CLOSE_PLAY_CONTEST_UNITS = 6.0


def name_close_play_runners(close_plays: list, frames: list) -> None:
    """Name the runner contesting each close play, in place.

    An EMPTY runner slot sits parked on its bag, which at third is a unit and a
    half from the fielder taking the throw -- nearer than the runner actually
    sliding in. Only occupied slots (`index >= 0`) are candidates, which is the
    same test every other offense measurement here applies.

    The separation is carried with the name: it is the evidence, and a record
    that cannot say how close the two were cannot be checked later.
    """
    if not close_plays:
        return
    by_frame = {snapshot["timer"]: snapshot for snapshot in frames}
    for event in close_plays:
        start = event.get("frame")
        length = event.get("frames") or 0
        if start is None:
            continue
        nearest = {}
        for timer in range(start, start + length + 1):
            snapshot = by_frame.get(timer)
            if snapshot is None:
                continue
            fielder = snapshot["actors"].get(event["by"])
            if fielder is None:
                continue
            for name, actor in snapshot["actors"].items():
                if actor["kind"] != "offense" or actor["index"] < 0:
                    continue
                gap = math.dist(fielder["pos"][::2], actor["pos"][::2])
                if name not in nearest or gap < nearest[name][0]:
                    nearest[name] = (gap, actor["character"])
        if not nearest:
            continue
        name, (gap, character) = min(nearest.items(), key=lambda row: row[1][0])
        if gap > CLOSE_PLAY_CONTEST_UNITS:
            continue
        event["runner"] = name
        event["runner_character_id"] = character
        event["runner_character"] = character_name(character)
        event["runner_separation_units"] = round(gap, 3)


# ...AND IT HITS THE BALL. Jason, 09-11 PA77: "the train hit baby mario twice
# and the ball once". What it does to a loose ball, measured: a shove sideways
# in a single frame that leaves the fall alone. The last incoming frame is
# 74886, where the ball sits 1.2u up and 2.6u inside the wall crawling at 1.275
# u/s; the step INTO 74887 carries it away at 8.9 u/s inward while its height
# keeps to the same gravity curve. The record names 74886 -- the frame whose
# position it carries -- and reports that frame's own incoming speed rather than
# an average straddling the impact. The 09-11T19 test game holds the other: a ball
# in the air 6.4u inside the wall sent straight back at the speed it arrived
# with (frame 148773), nobody within 3.6u and no glove for another 200 frames.
#
# The train is still not in memory, so this is named by ruling out everything
# else that turns a ball there:
#   THE WALL. A ball that reaches it ends 0.28u past the fence line and pops up
#     a quarter unit -- 14 times in four games, train or no train, and PA77's own
#     wall bounce 66 frames before the hit is one of them. So the band starts
#     half a unit inside the line.
#   THE GROUND. A bounce turns a fall into a rise. Neither hit did.
#   A GLOVE. Every fielder touch is a fielding event or a throw launch.
#   A DEAD BALL. A home-run replay holds the ball perfectly still 25-40u up.
#     The ceiling below is a guess at the train's height, not a measurement:
#     both hits were under 1.3u.
# The left-field foul pole protrudes into the playable field. PA 106 of the
# 2026-09-11 day game hit that wall 0.956u inside the surveyed fence and was
# previously called a train collision. Both reviewed train-ball hits were at
# least 2.61u inside, so 1.5u preserves them and excludes the pole/wall skin.
TRAIN_BALL_MIN_INSIDE_UNITS = 1.5
TRAIN_BALL_MAX_HEIGHT_UNITS = 3.0
# PA77's shove was 7.6 u/s; a loose ball this far inside the wall does not
# change horizontal speed by half that on its own.
TRAIN_BALL_MIN_CHANGE_UPS = 4.0
TRAIN_BALL_BOUNCE_UPS = 0.6
TRAIN_BALL_MIN_SPEED_GAIN_UPS = 4.0
TRAIN_BALL_MIN_TURN_DEGREES = 10.0
TRAIN_BALL_MAX_SPEED_UPS = 100.0
TRAIN_BALL_WINDOW_FRAMES = 3
TRAIN_BALL_EXCLUSION_FRAMES = 6
# HOW FAR THE BALL HAS TO GO before a glove takes it. A ball that was in a
# glove on the next frame having moved a hundredth of a unit was not knocked
# anywhere: that is the possession snap. Measured over the regenerated Yoshi
# archive, the gap is enormous -- the 203017Z control took 1 frame and 0.012u,
# while the nearest real hit took 24 frames and 6.53u and the two reviewed ones
# 82 and 202 frames (10.2u and 23.2u). So this is a gap, not a tuned threshold.
TRAIN_BALL_PICKUP_MIN_UNITS = 1.0
TRAIN_BALL_GROUP_FRAMES = 10


def detect_train_ball_hits(frames: list, contact_t: float, live_end: float,
                           fps: float, park: str | None, is_night: bool | None,
                           fielding_events: list, throws: list,
                           knockdowns: list | None = None) -> list:
    """Loose balls Yoshi Park's train knocked away inside the outfield wall.

    Run after name_knocked_loose_throws: a knocked-loose "throw" is not a glove,
    and its launch is often the train's own hit.
    """
    if park != "yoshi_park":
        return []
    touched = [event["frame"] for event in fielding_events
               if isinstance(event.get("frame"), int)]
    touched += [throw["launch_frame"] for throw in throws
                if throw.get("is_throw") is not False]
    secured = sorted((event["frame"], event.get("by")) for event in fielding_events
                     if event.get("secured") and isinstance(event.get("frame"), int))
    released = sorted(throw["launch_frame"] for throw in throws
                      if isinstance(throw.get("launch_frame"), int))
    # A FLOORED FIELDER DROPS THE BALL, and that is a release. The gate below
    # exists so the dead-ball transition's holder clear cannot turn a caught
    # ball into a loose one, and its own comment allows "a measured knockdown
    # after possession" -- which was never implemented, because a dropped ball
    # only appears in `throws` when the derivation happened to build a throw
    # record for it. 09-11 PA33 is what that costs: the train floored Yellow
    # Pianta twice, the ball rolled out of his glove with no throw to rename,
    # and the hit that sent it back toward the infield 107 frames later was
    # discarded as "not loose". Jason saw it from the couch -- "it had mostly
    # stopped, then suddenly started speeding up back towards the infield, with
    # nobody touching it" -- and the frames agree: 0.90 u/s to 8.95 u/s in one
    # frame at f34316, the fielder flat on the ground 3.1u away.
    dropped = sorted((knock["frame"], knock.get("by")) for knock in knockdowns or ()
                     if isinstance(knock.get("frame"), int))
    def next_possession(index: int):
        """Who picked the ball up after the train hit it, and where.

        MEASURED, not reconstructed from the event lists. A second pickup by the
        fielder who already had the ball leaves no new fielding event -- 09-11
        PA33 holds one possession record for two pickups -- so an answer built
        from `fielding_events` reports "no fielder reached it" for a ball that
        was fetched 159 frames later. The next frame the ball is in a glove is
        the thing that actually ends the chase the shove created.
        """
        for later in frames[index + 1:]:
            if later["t"] - contact_t > live_end:
                break
            owner = locked_fielder(later)
            if owner is None:
                continue
            return {
                "pickup_frame": later["timer"],
                "pickup_t": round(later["t"] - contact_t, 4),
                "pickup_by": owner,
                "pickup_character": character_name(
                    later["actors"][owner]["character"]),
                "pickup_at": [round(value, 3) for value in later["ball"]],
            }
        return None

    span = TRAIN_BALL_WINDOW_FRAMES
    candidates = []
    for index in range(span, len(frames) - span - 1):
        snapshot = frames[index]
        if snapshot["t"] - contact_t > live_end:
            break
        # The steps into the three frames before, the one that changed, and the
        # three after -- all of a free ball, none of it dead still.
        steps = [_free_ball_step(frames, k)
                 for k in range(index - span + 1, index + span + 2)]
        if any(step is None or not any(step) for step in steps):
            continue
        if snapshot["ball"][1] > TRAIN_BALL_MAX_HEIGHT_UNITS:
            continue
        inside = inside_fence_units(park, snapshot["ball"])
        if (inside is None
                or not TRAIN_BALL_MIN_INSIDE_UNITS <= inside <= TRAIN_FENCE_BAND_UNITS):
            continue
        if any(abs(snapshot["timer"] - frame) <= TRAIN_BALL_EXCLUSION_FRAMES
               for frame in touched):
            continue
        # A caught/secured ball is not loose merely because the game's holder
        # byte later clears during the dead-ball transition. It must have been
        # released by a real throw or by a measured knockdown after possession.
        prior_secured = next(((frame, by) for frame, by in reversed(secured)
                              if frame < snapshot["timer"]), None)
        prior_release = next((frame for frame in reversed(released)
                              if frame < snapshot["timer"]), None)
        if prior_secured is not None:
            held_since, holder = prior_secured
            floored = next((frame for frame, by in reversed(dropped)
                            if held_since <= frame < snapshot["timer"]
                            and (by is None or by == holder)), None)
            if ((prior_release is None or prior_release < held_since)
                    and floored is None):
                continue
        incoming = [sum(step[axis] for step in steps[:span]) / span for axis in range(3)]
        outgoing = [sum(step[axis] for step in steps[span + 1:]) / span for axis in range(3)]
        change = math.hypot(outgoing[0] - incoming[0], outgoing[2] - incoming[2]) * fps
        if change < TRAIN_BALL_MIN_CHANGE_UPS:
            continue
        if (incoming[1] * fps <= -TRAIN_BALL_BOUNCE_UPS
                and outgoing[1] * fps >= TRAIN_BALL_BOUNCE_UPS):
            continue
        jolt = math.hypot(steps[span][0] - steps[span - 1][0],
                          steps[span][2] - steps[span - 1][2])
        candidates.append((index, jolt, inside, incoming, outgoing, change))

    groups = []
    for candidate in candidates:
        if (groups and frames[candidate[0]]["timer"]
                - frames[groups[-1][-1][0]]["timer"] <= TRAIN_BALL_GROUP_FRAMES):
            groups[-1].append(candidate)
        else:
            groups.append([candidate])

    hits = []
    for group in groups:
        index, _, inside, incoming, outgoing, change = max(group, key=lambda entry: entry[1])
        snapshot = frames[index]
        speed_in = math.hypot(incoming[0], incoming[2])
        speed_out = math.hypot(outgoing[0], outgoing[2])
        turn = None
        if speed_in > 1e-9 and speed_out > 1e-9:
            cosine = max(-1.0, min(1.0, (incoming[0] * outgoing[0] + incoming[2] * outgoing[2])
                                   / (speed_in * speed_out)))
            turn = math.degrees(math.acos(cosine))
        speed_in_ups = speed_in * fps
        speed_out_ups = speed_out * fps
        if max(speed_in_ups, speed_out_ups) > TRAIN_BALL_MAX_SPEED_UPS:
            continue
        if ((turn is None or turn < TRAIN_BALL_MIN_TURN_DEGREES)
                and speed_out_ups - speed_in_ups < TRAIN_BALL_MIN_SPEED_GAIN_UPS):
            continue
        pickup = next_possession(index)
        # A BALL THAT WENT STRAIGHT INTO A GLOVE WAS NOT KNOCKED ANYWHERE.
        # yoshi_park-20260911T203017Z contact 28389 is the reviewed control:
        # 43.7 u/s in, 1.05 u/s out, a 179.6-degree turn at ground height -- and
        # possession on the very next frame with the ball 0.012u away. Tiny Kong
        # had secured that ball 285 frames earlier and the train merely crossed
        # it; what reverses here is the possession snap. The `prior_secured` gate
        # used to hide this, and once a knockdown of the holder counted as a
        # release (which 09-11 PA33 needs) it came back, so the exclusion has to
        # be stated on its own terms.
        if pickup is not None:
            travelled = math.dist(snapshot["ball"][::2], pickup["pickup_at"][::2])
            if (pickup["pickup_frame"] - snapshot["timer"] <= TRAIN_BALL_EXCLUSION_FRAMES
                    and travelled < TRAIN_BALL_PICKUP_MIN_UNITS):
                continue
        train = snapshot.get("train") if is_night is False else None
        train_at = (train or {}).get("pos")
        train_distance = None
        cause_source = "kinematic_exclusion"
        if train_at is not None:
            train_distance = math.dist(snapshot["ball"][::2], train_at[::2])
            if train_distance > TRAIN_CONTACT_RADIUS_UNITS:
                continue
            cause_source = "train_position"
        hits.append({
            "t": round(snapshot["t"] - contact_t, 4),
            # The last frame on the incoming path; the next is already moving
            # the new way.
            "frame": snapshot["timer"],
            "at": [round(value, 3) for value in snapshot["ball"]],
            "height_units": round(snapshot["ball"][1], 3),
            "fence_inside_units": round(inside, 3),
            "incoming_speed_ups": round(speed_in_ups, 3),
            "outgoing_speed_ups": round(speed_out_ups, 3),
            "velocity_change_ups": round(change, 3),
            "turn_degrees": round(turn, 3) if turn is not None else None,
            "train_at": ([round(value, 3) for value in train_at]
                         if train_at is not None else None),
            "train_distance_units": (round(train_distance, 3)
                                     if train_distance is not None else None),
            # WHAT THE SHOVE COST: how far the ball went from the hit to the
            # glove that ended up with it, and how long that took. Jason asked
            # for exactly this instead of the distance to the wall -- "so we
            # know the true impact of it hitting the train".
            **(pickup or {}),
            "carried_to_pickup_units": (
                round(math.dist(snapshot["ball"][::2], pickup["pickup_at"][::2]), 3)
                if pickup is not None else None),
            "pickup_delay_s": (
                round(pickup["pickup_t"] - (snapshot["t"] - contact_t), 4)
                if pickup is not None else None),
            "cause_source": cause_source,
            # The Wiggler runs the same wall at night. A session that never
            # recorded the day/night bytes says null.
            "mechanism": {False: "train", True: "wiggler"}.get(is_night),
        })
    return hits


# ...AND IT SWALLOWS THE BALL, WHICH IS A HOME RUN. Jason, 09-11 PA83: "the
# ball landed inside of the train, which when that happens on yoshi park, its a
# homerun. hopefully this will help us detect this event". It does better than
# help: the capture states it on three independent bytes and infers nothing.
#
# At frame 77983 the ball stopped being a ball and BECAME the train. Its x and z
# went equal to the train's own captured position -- 0.000 apart, not close --
# and stayed equal for 119 frames while it rode from centre out toward right
# field at the train's own 10.3-10.8 u/s with its height pinned to 0. The
# game's `home_run_flag` rose 0 -> 1 on that exact frame, and the ride ended
# when the play went dead (game_state 2 -> 20) and the ball froze at the last
# spot the train left it while the train carried on.
#
# The descent into it is an ordinary flight: 21 u/s down a clean arc, closing
# to 1.08u from the train at f77980, no glove within reach. So the plain
# train-ball hit the detector above records one frame earlier is this same
# event seen from outside, and the call site drops it in favour of this.
#
# Two frames of exact agreement is the test, not one: a ball passing over the
# train's origin in flight could match for a single frame, and requiring the
# ball to be at rest height as well leaves it nothing to match on.
TRAIN_BALL_CAPTURE_UNITS = 0.05
TRAIN_BALL_CAPTURE_HEIGHT_UNITS = 0.25
TRAIN_BALL_CAPTURE_MIN_FRAMES = 2


def detect_train_ball_captures(frames: list, contact_t: float, live_end: float,
                               fps: float, park: str | None,
                               is_night: bool | None) -> list:
    """Balls Yoshi Park's train swallowed: the ball's position IS the train's.

    Day only. 0x811F84DC is the day train; at night the Wiggler runs the same
    wall and its object has not been located, so there is nothing to compare
    the ball against and this says nothing rather than guessing.
    """
    if park != "yoshi_park" or is_night is not False:
        return []

    def riding(snapshot) -> bool:
        train_at = (snapshot.get("train") or {}).get("pos")
        if train_at is None:
            return False
        if int((snapshot.get("state") or {}).get("ball_holder", -1)) >= 0:
            return False
        if snapshot["ball"][1] > TRAIN_BALL_CAPTURE_HEIGHT_UNITS:
            return False
        return math.dist(snapshot["ball"][::2],
                         train_at[::2]) <= TRAIN_BALL_CAPTURE_UNITS

    groups = []
    for index, snapshot in enumerate(frames):
        if snapshot["t"] - contact_t > live_end:
            break
        if not riding(snapshot):
            continue
        if groups and index - groups[-1][-1] == 1:
            groups[-1].append(index)
        else:
            groups.append([index])

    rides = []
    for group in groups:
        if len(group) < TRAIN_BALL_CAPTURE_MIN_FRAMES:
            continue
        first, last = frames[group[0]], frames[group[-1]]
        before = frames[group[0] - 1] if group[0] > 0 else None
        flag = int((first.get("state") or {}).get("home_run_flag", 0) or 0)
        flag_before = int((before.get("state") or {}).get("home_run_flag", 0) or 0
                          ) if before is not None else None
        rides.append({
            "t": round(first["t"] - contact_t, 4),
            "frame": first["timer"],
            "at": [round(value, 3) for value in first["ball"]],
            "frames": len(group),
            "seconds": round(len(group) / fps, 4),
            "exit_frame": last["timer"],
            "exit_at": [round(value, 3) for value in last["ball"]],
            "carried_units": round(math.dist(first["ball"][::2],
                                             last["ball"][::2]), 3),
            "arrival_speed_ups": (
                round(math.dist(before["ball"][::2], frames[group[0] - 2]["ball"][::2])
                      * fps, 3) if before is not None and group[0] > 1 else None),
            # The game's own verdict, on the frame of the swallow. This is what
            # makes the sentence a statement rather than a park anecdote.
            "home_run_flag": flag,
            "home_run_flag_rose": (None if flag_before is None
                                   else bool(flag and not flag_before)),
            "cause_source": "train_position",
            "mechanism": {False: "train", True: "wiggler"}.get(is_night),
        })
    return rides


# A CAPTAIN'S STAR SWING FLOORS FIELDERS with no ball contact at all -- Luigi's
# tornado, Wario's bomb, DK's barrel. The knockdown flag cannot tell that from a
# park hazard, and neither can its length: Wario City's manhole knockdowns run
# the same 79-80 frames. The game's own flag can; see "star_swing" in
# STATE_FIELDS.
#
# The flag's VALUE is which captain swung. Measured over eight sessions and 70
# pulses, and no value ever appeared on two different batters. 11 is Bowser:
# all five 11 pulses in the archive (Daisy Cruiser x3, Wario City x2) are his
# plate appearances. An unseen value is recorded raw with no name rather than
# guessed.
STAR_SWING_CAPTAINS = {
    1: "Mario", 2: "Luigi", 3: "Donkey Kong", 4: "Diddy Kong", 5: "Peach",
    6: "Daisy", 7: "Wario", 8: "Waluigi", 9: "Yoshi", 10: "Birdo",
    11: "Bowser", 12: "Bowser Jr.",
}
# Matched per PLAY, not per frame, and how long after the flag drops the fielder
# goes down is a property of the CAPTAIN. Across 27 knockdowns at 10 parks:
# Luigi's land inside the pulse, Birdo's inside it or up to 36 frames after,
# Wario's 5-19 frames after, and Donkey Kong's exactly 22 frames after in all 8
# cases -- 21 frames after the fielder takes possession. None lands on the
# fielder's own touch (0 of 27 within 5 frames), so "the ball does it on
# contact" is not the mechanism.
#
# This bound is the slowest measured captain with room, and it deliberately
# leaves 8 knockdowns unnamed that fall 75-310 frames after a star swing. All 8
# are at Bowser Castle, Bowser Jr. Playroom or Yoshi Park, which floor 44
# fielders on plays with NO star swing; 5 belong to Mario, Yoshi and Diddy Kong,
# who have no in-bound knockdown anywhere to fit a lag to, and the other 3 are
# well past Wario's and Birdo's own measured lags.
STAR_SWING_KNOCKDOWN_AFTER_FRAMES = 60
# THE SWING'S EFFECT IS AT THE BALL; A PARK OBJECT'S IS NOT. 26 of 27 knockdowns
# the per-play window named had the floored fielder within 5.63u of the ball
# inside 30 frames either side -- Donkey Kong's barrel at 0.00u in all 8 -- and
# the 27th was 31.3u away with the ball in the first baseman's glove: a Yoshi
# Park night-game knockdown the window had handed to Birdo. Nothing sits between
# 5.63 and 31.3.
#
# A VETO, NOT A PROOF. 20 of the 56 knockdowns on plays with no star swing at all
# were also that close to the ball, because fielders converge on it. Being near
# the ball cannot say a star swing did it; being 31u from it says one did not.
STAR_SWING_BALL_WINDOW_FRAMES = 30
STAR_SWING_BALL_UNITS = 6.0
# BIRDO'S EGG FLIES AHEAD OF THE BALL, so her knockdowns sit further from it than
# anyone's. Her eleven in the archive: pitchers at 0.6-2.6u, shortstops at
# 4.4-6.5u -- and the 6.48u one, yoshi_park-20260911T164801Z frame 45123, is the
# only knockdown the 6.0 bound ever refused on a real star swing. Jason annotated
# it: "funky kong was hit by birdos cannon swing star swing. she sends an egg out
# in front of the balls path". The nearest knockdown in a Birdo window that is
# NOT hers is still the 31.3u night one above.
STAR_SWING_BALL_UNITS_BY_CAPTAIN = {10: 10.0}


def _closest_to_ball(motion_frames: list, name: str, frame: int, window: int):
    """Closest the named fielder came to the ball within `window` frames of `frame`."""
    best = None
    for snapshot in motion_frames:
        if abs(snapshot["timer"] - frame) > window:
            continue
        actor = (snapshot.get("actors") or {}).get(name)
        ball = snapshot.get("ball")
        if actor is None or ball is None:
            continue
        here, there = actor["pos"][::2], ball[::2]
        if not all(math.isfinite(value) for value in (*here, *there)):
            continue
        units = math.dist(here, there)
        best = units if best is None else min(best, units)
    return best


def detect_star_swing(motion_frames: list, contact_timer: int) -> dict | None:
    """The captain star swing on this play, from the game's own flag, or None."""
    run = []
    for snapshot in motion_frames:
        value = int(snapshot["state"].get("star_swing", 0) or 0)
        if value:
            run.append((snapshot["timer"], value))
        elif run:
            break
    # The swing raises it. A run that starts after the ball has already left the
    # plate is not this play's swing -- and a held star swing keeps the ball at
    # the plate ~91 frames, which is why this compares against contact rather
    # than a few frames around it.
    if not run or run[0][0] > contact_timer:
        return None
    return {
        "value": run[0][1],
        "captain": STAR_SWING_CAPTAINS.get(run[0][1]),
        "start_frame": run[0][0],
        "end_frame": run[-1][0],
        "frames": run[-1][0] - run[0][0] + 1,
    }


def name_star_swing_knockdowns(knockdowns: list, star_swing: dict | None,
                               barrel_events: list, motion_frames: list) -> None:
    """Name the knockdowns a captain's star swing caused, in place.

    Runs AFTER the park hazards, and never overrides one. A manhole has its own
    object evidence and a DK Jungle barrel has its own trajectory; either keeps
    its knockdown. What is left on a star-swing play, inside the measured lag, is
    the swing's.
    """
    if not star_swing:
        return
    # THE HITS LIVE ONE LEVEL DOWN. A barrel event is an INTERVAL and carries
    # `approaches[]`; `by` and `hit` are fields of an approach, not of the
    # interval, so reading them here collected a set of Nones and the exclusion
    # never fired. Latent rather than harmless: the archive holds no barrel
    # events at all (see docs/final-stat-expansion-backend-handoff.md), so the
    # first capture that records one would have handed a confirmed barrel hit to
    # the star swing as well, charging one knockdown to two causes.
    barrel_hits = {
        approach.get("by")
        for event in barrel_events or ()
        for approach in (event.get("approaches") or ())
        if approach.get("hit")
    }
    for knock in knockdowns:
        if knock.get("hazard") or knock.get("by") in barrel_hits:
            continue
        frame = knock.get("frame")
        if frame is None or frame < star_swing["start_frame"]:
            continue
        if frame > star_swing["end_frame"] + STAR_SWING_KNOCKDOWN_AFTER_FRAMES:
            continue
        # Recorded whether or not it vetoes, so a declined knockdown carries the
        # measurement that declined it rather than a silent null.
        units = _closest_to_ball(motion_frames, knock.get("by"), frame,
                                 STAR_SWING_BALL_WINDOW_FRAMES)
        if units is not None:
            knock["star_swing_ball_units"] = round(units, 3)
        limit = STAR_SWING_BALL_UNITS_BY_CAPTAIN.get(
            star_swing["value"], STAR_SWING_BALL_UNITS)
        if units is None or units > limit:
            continue
        knock["hazard"] = "star_swing"
        knock["star_swing_captain"] = star_swing["captain"]
        knock["star_swing_value"] = star_swing["value"]


# A CAPTAIN'S STAR SWING THAT DISABLES WITHOUT FLOORING. Each effect writes a
# fielder byte that something else also writes -- the paint shares +0x243 with a
# Daisy Cruiser table, the heart shares +0x242 with DK Jungle's flower gas -- so
# the byte alone never names the cause. The captain the star-swing flag names
# has to be the one whose effect writes that byte.
#
# Every onset in the three annotated Daisy Cruiser games (08-31, 09-04, 09-11):
#   Bowser Jr. paint    +0x243   90f   6 of 6 on his swings
#   Peach heart         +0x242  120f   5 of 5 on hers (Jason: male fielders only)
#   Mario fireball      +0x23E   89f   4 of 4, each on the star_ball misplay frame
#   Bowser fire breath  +0x23E   89f   4 of 4, 2-7.5u from the ball
# None of the three Yoshi-egg forced misplays in the 09-04 game raised +0x23E.
# Bowser Castle raises +0x23E 13 times over three sessions on plays with no
# fire swing -- the park's own fire -- so a Mario or Bowser swing there can
# still coincide with one.
# A flower-gas onset on some other captain's swing at DK Jungle (the 08-28 game
# has one on Mario's and one on Wario's) is not claimed, because the byte does
# not match the captain.
STAR_SWING_EFFECTS = {
    1: ("burned", "fireball"),
    5: ("sprayed", "heart"),
    11: ("burned", "fire_breath"),
    12: ("impact_stun", "paint"),
}


def name_star_swing_effects(star_swing: dict | None, stuns_by_flag: dict) -> list:
    """The fielders a captain's star swing disabled, from the byte its effect writes."""
    if not star_swing:
        return []
    flag, effect = STAR_SWING_EFFECTS.get(star_swing["value"], (None, None))
    return [
        {**stun, "flag": flag, "effect": effect,
         "star_swing_captain": star_swing["captain"],
         "star_swing_value": star_swing["value"]}
        for stun in stuns_by_flag.get(flag, ())
        if stun.get("frame") is not None and stun["frame"] >= star_swing["start_frame"]
        # +0x243 value 1 is DK's statue POW; Bowser Jr. paint uses value 2.
        # A coincident captain swing must not claim the park's separate stun.
        and (effect != "paint" or stun.get("flag_value") == 2)
    ]


def name_star_swing_breaks(breaks: list, star_swing: dict | None) -> None:
    """Hand a break no measured contact explains to the play's star swing, in place.

    Bowser's fire breath broke a Daisy Cruiser table 15.7u from the ball with no
    buddy attack or throw near it (Jason, daisy_cruiser-20260911T152720Z PA 55):
    the fire is not the ball, so the contact geometry cannot see it. Only an
    `unknown` cause is claimed, from the swing's first frame to the same lag the
    knockdowns allow; a buddy attack, a throw or the batted ball keeps its break.
    """
    if not star_swing:
        return
    for broken in breaks:
        frame = broken.get("frame")
        if frame is None or (broken.get("cause") or {}).get("type") != "unknown":
            continue
        if not (star_swing["start_frame"] <= frame
                <= star_swing["end_frame"] + STAR_SWING_KNOCKDOWN_AFTER_FRAMES):
            continue
        broken["cause"] = {
            "type": "star_swing",
            "captain": star_swing["captain"],
            "value": star_swing["value"],
        }


def detect_manhole_ball_strikes(frames: list, contact_t: float, live_end: float,
                                 fps: float, park: str | None,
                                 spots: list) -> list:
    """Frames where the ball bounced off an erupting manhole, above the ground."""
    if park != "wario_city" or not spots:
        return []
    events = []
    for index in range(2, len(frames) - 2):
        snapshot = frames[index]
        if snapshot["t"] - contact_t > live_end:
            break
        if snapshot["state"].get("ball_holder") != -1:
            continue
        step = _ball_frame_step(frames, index)
        previous = _ball_frame_step(frames, index - 1)
        if step is None or previous is None:
            continue
        rise = snapshot["ball"][1] - frames[index - 1]["ball"][1]
        fall = frames[index - 1]["ball"][1] - frames[index - 2]["ball"][1]
        # Descending, then rising: a bounce and not a launch or an apex.
        if not (fall < -0.02 and rise > 0.02):
            continue
        if snapshot["ball"][1] < MANHOLE_BALL_STRIKE_MIN_HEIGHT_UNITS:
            continue
        distance, spot = _nearest_manhole(snapshot["ball"], spots)
        if distance is None or distance > MANHOLE_BALL_STRIKE_RADIUS_UNITS:
            continue
        speed_in, speed_out = math.hypot(*previous), math.hypot(*step)
        if speed_in < 1e-9 or speed_out < 1e-9:
            continue
        cosine = max(-1.0, min(1.0, (previous[0] * step[0] + previous[1] * step[1])
                               / (speed_in * speed_out)))
        turn = math.degrees(math.acos(cosine))
        if turn > MANHOLE_BALL_STRIKE_MAX_TURN_DEGREES:
            continue
        if events and snapshot["timer"] - events[-1]["frame"] <= 30:
            continue
        events.append({
            "t": round(snapshot["t"] - contact_t, 4),
            "frame": snapshot["timer"],
            "at": [round(value, 3) for value in snapshot["ball"]],
            "height_units": round(snapshot["ball"][1], 3),
            "manhole_at": [round(value, 3) for value in spot],
            "distance_units": round(distance, 3),
            "descent_ups": round(fall * fps, 3),
            "rebound_ups": round(rise * fps, 3),
            "horizontal_speed_ups": round(speed_out * fps, 3),
            "turn_degrees": round(turn, 3),
        })
    return events


def detect_fielding_action_events(frames: list, contact_t: float,
                                   live_end: float,
                                   first_touch: dict | None,
                                   action_code: int) -> list:
    """Classify one event per contiguous action window.

    `last_contact_fielder` at 0x900D9524 is the authority for physical contact:
    it idles at -1 and names a fielder by pointer-table order. Across the full
    labelled archive it names 16/16 ordinary boots (including the two 4.6u/5.1u
    Brown Kritter dives), 8/8 egg contacts, 50/50 intentional teammate tosses,
    and 286/286 clean possessions, while never naming Shy Guy's unrelated
    action-3 attempt.

    Action 3 without that actor transition is therefore a confirmed miss.
    Action 2 has no general labelled miss and does not consistently set the
    scalar, so absence remains explicit `unknown` here. After the independent
    approach byte is attached below, an action-2 DIVE with no contact actor can
    be resolved as a miss: the operator-confirmed DK example establishes that
    exact combination. Centre-to-ball distance remains audit context only.
    """
    cutoff = first_touch["t"] if first_touch else live_end
    active = {}
    events = []

    first_snapshot = frames[0] if frames else {"actors": {}}
    order = [name for name, actor in first_snapshot["actors"].items()
             if actor["kind"] == "fielder"]
    actor_indices = {name: index for index, name in enumerate(order)}
    mechanic = {
        2: "ordinary", 3: "ordinary", 4: "star_ball",
        5: "egg", 7: "buddy",
    }.get(action_code, "unknown")

    def finish(name):
        window = active.pop(name, None)
        if window is None:
            return
        contact = window["contact"]
        closest = window["closest"]
        if closest is None:
            return
        distance, t, index, snapshot, actor = contact or closest
        reach = window["closest_reach"]
        if contact is not None:
            ball_contact = "confirmed"
            confidence = "high"
            source = "last_contact_fielder"
        elif reach > FIELDING_REACH_LIMIT_UNITS:
            # The ball was never close enough for contact to be physically
            # possible, so this window is an animation that happened while a
            # ball was in the air somewhere else.
            ball_contact = "missed"
            confidence = "high"
            source = "ball_never_within_reach"
        elif action_code == 3:
            ball_contact = "missed"
            confidence = "high"
            source = "action_without_contact_actor"
        else:
            ball_contact = "unknown"
            confidence = "low"
            source = "no_contact_actor"
        events.append({
            "event_type": "fielding_action",
            "fielding_attempt": True,
            "ball_contact": ball_contact,
            # Code 7 deliberately takes control of the ball long enough to
            # redirect it at a teammate. It is a quick secure-and-pass even
            # when no chemistry Buddy Throw state is present.
            "secured": action_code == FIELDING_ACTION_BUDDY_HANDOFF
                       and ball_contact == "confirmed",
            "mechanic": mechanic,
            # A physical boot is not automatically an official scoring error.
            "official_error": None,
            "confidence": confidence,
            "contact_source": source,
            "t": round(t, 4),
            "frame": snapshot["timer"],
            "action_start_frame": window["start_frame"],
            "action_end_frame": window["end_frame"],
            "by": name,
            "character_id": actor["character"],
            "character": character_name(actor["character"]),
            "at": [round(value, 3) for value in actor["pos"]],
            "ball_at": [round(value, 3) for value in snapshot["ball"]],
            "distance_units": round(distance, 3),
            "closest_distance_units": round(closest[0], 3),
            # The horizontal distances above ignore the ball's height, which is
            # the only axis that separates a dive off the turf from a home run
            # sailing 35 units overhead. This one does not.
            "closest_reach_units": round(reach, 3),
            "within_reach": reach <= FIELDING_REACH_LIMIT_UNITS,
            "action_code": action_code,
            "contact_fielder": snapshot["state"].get("contact_fielder", -1),
            "last_contact_fielder": snapshot["state"].get(
                "last_contact_fielder", -1),
            "fielding_contact_counter": actor.get("contact_counter", 0),
            # The fielder position has no usable height, but this actor flag is
            # still useful attempt context. It is deliberately not called an
            # error decision: a hard play can be missed without being an error.
            "airborne_near_contact": any(
                nearby["actors"].get(name, {}).get("airborne")
                for nearby in frames
                if abs(nearby["t"] - snapshot["t"]) <= 1.0
            ),
            **_ball_motion_change(frames, index),
        })

    for index, snapshot in enumerate(frames):
        t = snapshot["t"] - contact_t
        inside_window = 0 < t <= min(cutoff, live_end)
        bx, by, bz = snapshot["ball"]
        has_ball = not (bx == 0.0 and by == 0.0 and bz == 0.0)
        for name, actor in snapshot["actors"].items():
            if actor["kind"] != "fielder":
                continue
            matches = (inside_window and has_ball
                       and actor["fielding_action"] == action_code)
            if not matches:
                finish(name)
                continue
            px, _, pz = actor["pos"]
            distance = math.dist((px, pz), (bx, bz))
            # The fielder's own height reads 0 in every frame ever captured,
            # so this is the ball's distance from a point on the ground under
            # the fielder. That is the right comparison for "could this have
            # been touched at all": the error it can make is to call a ball
            # closer than it was, never further.
            reach = math.dist((px, 0.0, pz), (bx, by, bz))
            candidate = (distance, t, index, snapshot, actor)
            window = active.get(name)
            if window is None:
                window = active[name] = {
                    "start_frame": snapshot["timer"],
                    "end_frame": snapshot["timer"],
                    "closest": candidate,
                    "closest_reach": reach,
                    "contact": None,
                }
            else:
                window["end_frame"] = snapshot["timer"]
                if distance < window["closest"][0]:
                    window["closest"] = candidate
                window["closest_reach"] = min(window["closest_reach"], reach)
            actor_index = actor_indices.get(name, -1)
            contact_named = (
                int(snapshot["state"].get("last_contact_fielder", -1)) == actor_index
                or int(snapshot["state"].get("contact_fielder", -1)) == actor_index
            )
            if contact_named and window["contact"] is None:
                window["contact"] = candidate
    for name in list(active):
        finish(name)
    return sorted(events, key=lambda event: event["t"])


def detect_deflections(frames: list, contact_t: float, live_end: float,
                       first_touch: dict | None) -> list:
    """Confirmed boots: the fielder reached the ball but did not secure it."""
    events = []
    for action_code in FIELDING_ACTION_MISPLAYS:
        events.extend(event for event in detect_fielding_action_events(
            frames, contact_t, live_end, first_touch, action_code)
            if event["ball_contact"] == "confirmed")
    return sorted(events, key=lambda event: event["t"])


def detect_forced_misplays(frames: list, contact_t: float, live_end: float,
                           first_touch: dict | None) -> list:
    """First contacts a batter's star ball forces the fielder to lose.

    Yoshi's egg (5) and Mario's fireball (4). Both are the batter's ability
    acting on the fielder, so neither is an ordinary chance and neither may be
    charged as an error or counted as a fielding failure.
    """
    events = []
    for action_code in FIELDING_ACTION_FORCED:
        events.extend(event for event in detect_fielding_action_events(
            frames, contact_t, live_end, first_touch, action_code)
            if event["ball_contact"] == "confirmed")
    return sorted(events, key=lambda event: event["t"])


def detect_buddy_handoffs(frames: list, contact_t: float, live_end: float,
                          first_touch: dict | None) -> list:
    """Intentional teammate tosses, explicitly not fielding errors."""
    return [event for event in detect_fielding_action_events(
        frames, contact_t, live_end, first_touch,
        FIELDING_ACTION_BUDDY_HANDOFF)
        if event["ball_contact"] == "confirmed"]


def detect_buddy_jumps(frames: list, contact_t: float, live_end: float) -> list:
    """Fielders the game put into a Buddy Jump, one record per attempt.

    THE ONE FIELDING ATTEMPT THE CAPTURE USED TO MISS ENTIRELY. A Buddy Jump is
    two outfielders boosting one of them over the wall, and it happens on
    exactly the balls where knowing whether anybody had a play matters most:
    home runs. It leaves no action-byte window and no possession, so a play
    with a Buddy Jump and nothing else came out of the derivation with zero
    fielding events, and the console said "no fielding attempt and no landing
    for this ball" about a ball two fielders had just gone up for.

    `buddy_jump_flag` (+0x223, fielder class) is what the game sets while it
    happens, and the VALUE MATTERS. Across the DK Jungle session the byte opens
    eight windows, four reading 2 and four reading 1, and the tracker log
    announces exactly four buddy jumps -- Peach once and Mario three times. The
    four flag-2 windows are those four plays, fielder for fielder; none of the
    flag-1 windows is announced at all, and one of them belongs to a shortstop,
    who cannot be boosted over an outfield wall. So 2 is the Buddy Jump and 1
    is some other state of the same byte, left unnamed rather than guessed at.
    The value is carried on the record so the next session can widen this if a
    flag-1 window ever turns out to be one.
    """
    jumps = []
    active = {}

    def finish(name, last):
        window = active.pop(name, None)
        if window is None or last is None:
            return
        window["end_frame"] = last["timer"]
        window["end_t"] = round(last["t"] - contact_t, 4)
        window["frames"] = window["end_frame"] - window["start_frame"] + 1
        jumps.append(window)

    previous = None
    for snapshot in frames:
        if snapshot["t"] - contact_t > live_end + 1e-9:
            break
        for name, actor in snapshot["actors"].items():
            if actor.get("kind") != "fielder":
                continue
            flag = actor.get("buddy_jump") or 0
            if flag != BUDDY_JUMP_FLAG_ACTIVE:
                flag = 0
            window = active.get(name)
            if window is not None and window["flag"] != flag:
                finish(name, previous or snapshot)
                window = None
            if flag and window is None:
                active[name] = {
                    "by": name,
                    "character_id": actor["character"],
                    "character": character_name(actor["character"]),
                    "flag": flag,
                    "start_frame": snapshot["timer"],
                    "start_t": round(snapshot["t"] - contact_t, 4),
                    "end_frame": snapshot["timer"],
                    "end_t": round(snapshot["t"] - contact_t, 4),
                    "frames": 1,
                }
        previous = snapshot
    for name in list(active):
        finish(name, previous)
    jumps.sort(key=lambda window: (window["start_frame"], window["by"]))
    return jumps


# THE BALL'S OWN PATH, as measured, for anything that has to DRAW the play.
#
# The field view used to be given three points -- contact, landing, first touch
# -- and drew straight lines between them. That is the truth only when nothing
# happened in between, and at Wario City something usually did. Worse, the two
# cases where the ball is most interesting have none of those points: a home run
# and a ball that leaves play have no landing and no first touch at all, so the
# diagram drew nothing and said "no measured endpoint" about a ball whose whole
# flight is sitting in these frames. The operator, 2026-09-10 PA93: "we should
# be tracking the full path of the ball, regardless of what happened. this also
# includes homeruns as those are not being tracked either."
#
# WHERE IT STOPS. A ball in a glove is not a ball in flight -- its coordinates
# become the glove's, and past the play they become the dead-ball reset, which
# is how eleven Daisy Cruiser catches once came to sit three feet from home
# plate. So the path ends at the FIRST possession, or at the end of the live
# window, whichever comes first, and never runs past either.
#
# Sampled rather than dumped: at 60 Hz a seven-second flight is 420 points and
# nothing drawn at screen scale can tell them from 70. The endpoint is always
# kept exactly, whatever the stride does.
BALL_PATH_STRIDE_FRAMES = 6
BALL_PATH_MAX_POINTS = 120


def measure_ball_path(frames: list, contact_t: float, live_end: float,
                      first_touch: dict | None, possession_carries: list) -> list:
    """Every measured ball position from contact to the first glove, sampled."""
    stop_timer = None
    for carry in possession_carries or ():
        timer = carry.get("start_frame")
        if timer is not None:
            stop_timer = timer if stop_timer is None else min(stop_timer, timer)
    if first_touch is not None and first_touch.get("frame") is not None:
        stop_timer = (first_touch["frame"] if stop_timer is None
                      else min(stop_timer, first_touch["frame"]))

    live = []
    for snapshot in frames:
        t = snapshot["t"] - contact_t
        if t < 0 or t > live_end:
            continue
        if stop_timer is not None and snapshot["timer"] > stop_timer:
            break
        ball = snapshot.get("ball")
        if ball is None or not all(math.isfinite(value) for value in ball):
            continue
        live.append((snapshot["timer"], round(t, 4), ball))
    if not live:
        return []

    stride = max(BALL_PATH_STRIDE_FRAMES,
                 math.ceil(len(live) / BALL_PATH_MAX_POINTS))
    kept = live[::stride]
    if kept[-1][0] != live[-1][0]:
        kept.append(live[-1])
    return [{"frame": timer, "t": t, "at": [round(value, 3) for value in ball]}
            for timer, t, ball in kept]


def measure_preoutcome_flight(frames: list, contact_timer) -> dict:
    """The catch model's flight projection, from the first 12 frames only.

    Recorded on every play so the catch probability of a ball the stadium
    redirected can be scored at ingest: the window ends long before any table,
    arrow or pipe, so the projection describes the ball the park never touched.
    The fit itself is export_catch_preoutcome_features.project, shared so the
    feature a live play is scored on is the one the model was fitted on.
    """
    if contact_timer is None:
        return {"valid": False, "reason": "missing_contact_timer", "features": None}
    samples = []
    for snapshot in frames:
        offset = snapshot["timer"] - contact_timer
        if 0 <= offset < PREOUTCOME_WINDOW_FRAMES:
            ball = snapshot.get("ball")
            if ball is not None:
                samples.append((snapshot["timer"],
                                tuple(float(value) for value in ball)))
        if offset >= PREOUTCOME_WINDOW_FRAMES - 1:
            break
    features, reason = project_preoutcome_flight(samples)
    return {"valid": features is not None, "reason": reason, "features": features}


def detect_landing(frames: list, contact_t: float, live_end: float,
                   first_touch: dict | None):
    """When and where the ball first reached the ground.

    This is the measurement Catch Probability is built on, and it is NOT first
    touch. On a ball that falls in, first touch is where a fielder picked it up
    after it bounced, which is a different place at a later time than where it
    landed -- so using first touch as the target compares a fly ball's catch
    point against a base hit's pickup point and calls them the same feature.

    The search stops at first touch, because a ball in a glove is not landing --
    it is being carried, and a fielder who lowers it is not a bounce.

    Returns None for a ball that never came down inside the live window, which
    is exactly the set that was caught on the fly or left the park.
    """
    for previous, before, after in zip(frames, frames[1:], frames[2:]):
        t = before["t"] - contact_t
        # EXCLUSIVE at first touch, because the possession frame passes the
        # descent test below on its own: the ball reads y=0 in the glove with
        # the last free-flight frame above it. Including it turned a ball taken
        # off the wall 2.8 units up into a landing at the fielder's feet, and
        # its hang time into time-to-pickup -- 6.96 s on one Mario Stadium ball
        # whose real flight ended when it struck the wall. 19 plays across the
        # archive, all of them fair balls, 18 with the landing point byte-equal
        # to first touch.
        # Compared on the FRAME, not on the seconds: first_touch["t"] is stored
        # rounded to four decimals and can land just above the raw t of the very
        # frame it names, which let the possession frame back into the scan.
        if t > live_end or (first_touch is not None
                            and before["timer"] >= first_touch["frame"]):
            break
        y = before["ball"][1]
        if t <= 0 or y > LANDING_HEIGHT_UNITS:
            continue
        # A turning point the ball DESCENDED into. The descent is what makes it
        # a landing: the ball leaves the bat below this height and climbing, and
        # without that check every batted ball "lands" on the frame after
        # contact.
        if previous["ball"][1] > y and after["ball"][1] >= y:
            return {
                "t": round(t, 4),
                "frame": before["timer"],
                "at": [round(value, 3) for value in before["ball"]],
                "distance_units": round(
                    math.hypot(before["ball"][0], before["ball"][2]), 3),
            }
    return None


def flight_window(samples: list):
    """The longest run of consecutive frames the ball was actually in flight.

    Returns (index of the launch sample, the smoothed speeds over that run), or
    None if nothing in the window looks like a flight. "Consecutive" is the
    point: the release snap is a single fast sample separated from the flight by
    the whole wind-up hold, so it can never join the run however fast it is, and
    the arrival snap is rejected by its own step change rather than by a cap.
    """
    speeds = []
    for index, (before, after) in enumerate(zip(samples, samples[1:])):
        dt = after["t"] - before["t"]
        if dt <= 0:
            continue
        speed = math.dist(before["ball"], after["ball"]) / dt
        if MIN_THROW_SPEED_MPS <= speed <= MAX_THROW_SPEED_MPS:
            speeds.append((index, speed))

    best = current = []
    for entry in speeds:
        if current:
            last_index, last_speed = current[-1]
            adjacent = entry[0] == last_index + 1
            smooth = abs(entry[1] - last_speed) <= FLIGHT_SPEED_RATIO * last_speed
            if not (adjacent and smooth):
                current = []
        current = current + [entry]
        if len(current) > len(best):
            best = current
    if len(best) < MIN_THROW_SAMPLES:
        return None

    values = [speed for _, speed in best]
    stable = [statistics.median(values[max(0, i - 1):min(len(values), i + 2)])
              for i in range(len(values))]
    return best[0][0], stable


def named_fielder(snapshots: list, field: str, order: list) -> str | None:
    """The fielder a state scalar names, over the opening frames of a throw.

    All three of these scalars idle at -1 and are set on the release frame, but
    a frame of slack costs nothing and covers a scalar that lands one tick late.
    """
    for snapshot in snapshots[:8]:
        index = int(snapshot["state"].get(field, -1))
        if 0 <= index < len(order):
            return order[index]
    return None


def detect_throws(frames: list, contact_t: float, live_end: float,
                  bags: dict, order: list, home: tuple | None = None) -> list:
    """Segment fielder possession -> flight -> receiver possession."""
    live = [snapshot for snapshot in frames
            if snapshot["t"] - contact_t <= live_end + 1e-9]
    by_timer = {snapshot["timer"]: snapshot for snapshot in live}
    throws = []
    held_by = None
    held_since = None
    held_since_t = None
    flight = None

    def finish(receiver_name: str, arrival_snapshot: dict) -> None:
        nonlocal flight
        if not flight or receiver_name == flight["thrower"]:
            flight = None
            return
        samples = flight["samples"] + [arrival_snapshot]
        window = flight_window(samples)
        if window is None:
            flight = None
            return
        first_index, stable = window
        launch = samples[first_index]
        release = flight["release"]
        frozen = frozen_fielder_frames(samples[:first_index + 1])
        # The game names a Buddy Throw explicitly. A frozen cutscene remains a
        # useful duration measurement, but cannot classify it: close-play
        # contests freeze the world too.
        buddy_named = named_fielder(samples, "buddy_thrower", order)
        buddy_throw = buddy_named is not None
        # The game's own flag for a Laser Beam, up for exactly this throw's
        # flight. Read over the whole flight rather than at one frame, because
        # the release frame the segmentation picks and the frame the game raises
        # the flag on need not be the same one. See STATE_FIELDS in
        # collect_player_tracking.py for how it was identified.
        laser_throw = any(
            int(snapshot["state"].get("laser_throw_flag", 0) or 0) != 0
            for snapshot in samples)
        thrower = release["actors"][flight["thrower"]]
        receiver = arrival_snapshot["actors"][receiver_name]
        start_ball = launch["ball"]
        end_ball = arrival_snapshot["ball"]
        outs_recorded = max(
            0, int(arrival_snapshot["state"].get("outs", 0))
            - int(release["state"].get("outs", 0)))
        target_base = closest_target_base(receiver["pos"], bags, home)
        target_positions = {
            "first": bags.get("R1"), "second": bags.get("R2"),
            "third": bags.get("R3"), "home": home,
        }
        target_position = target_positions.get(target_base)
        receiver_distance_from_target = (
            math.dist(receiver["pos"][::2], target_position[::2])
            if target_position is not None else None)
        receiver_pulled_off_base = (
            receiver_distance_from_target is not None
            and receiver_distance_from_target > RECEIVER_PULLED_OFF_BASE_UNITS)
        # WHERE THE GAME AIMED IT AND WHERE IT SENT IT, one frame after
        # release. See THROW_OFF_TARGET_UNITS for why only a throw aimed at a
        # standing receiver is judged.
        aimed = by_timer.get(release["timer"] + 1)
        aim_at = aimed.get("throw_aim") if aimed else None
        destination_at = aimed.get("throw_destination") if aimed else None
        aim_miss = aim_to_receiver = destination_error = None
        if aim_at is not None and receiver_name in aimed["actors"]:
            aim_miss = math.dist(aim_at[::2], end_ball[::2])
            aim_to_receiver = math.dist(aim_at[::2], aimed["actors"][receiver_name]["pos"][::2])
            if destination_at is not None:
                destination_error = math.dist(aim_at[::2], destination_at[::2])
        off_target = (aim_miss is not None
                      and aim_to_receiver <= THROW_AIM_STANDING_UNITS
                      and (destination_error if destination_error is not None
                           else aim_miss) > THROW_OFF_TARGET_UNITS)

        # HOW CLOSE THE PLAY WAS. The ball's arrival is measured and so is where
        # every runner is standing on that frame, and the gap between them is
        # what an operator means by "a close play at the plate". Who WON it is
        # not inferred from this -- that is the game's call and it is already in
        # `outs_recorded`; this is the margin, which nothing else records.
        #
        # An empty base slot keeps whatever runner last occupied it, so the
        # batting index gates this rather than the coordinates: a stale Luigi
        # parked on first would otherwise be the closest runner to every base.
        runner_at_arrival = None
        if target_position is not None:
            candidates = [
                (math.dist(actor["pos"][::2], target_position[::2]), name, actor)
                for name, actor in arrival_snapshot["actors"].items()
                if actor["kind"] == "offense" and actor["index"] >= 0
            ]
            if candidates:
                distance, name, actor = min(candidates, key=lambda entry: entry[0])
                # STANDING ON THE BASE LOOKS EXACTLY LIKE ARRIVING AT IT, in a
                # single frame: a batter who reached first two seconds ago is
                # 0.8 units from the bag, and so is one sliding in ahead of the
                # throw. Half a second of history separates them -- the runner
                # who is already there has not moved, and one arriving at a
                # measured 9 u/s has covered about 4.5 units.
                earlier = by_timer.get(
                    arrival_snapshot["timer"] - CLOSE_PLAY_LOOKBACK_FRAMES)
                before = earlier["actors"].get(name) if earlier else None
                distance_before = (
                    math.dist(before["pos"][::2], target_position[::2])
                    if before is not None else None)
                # WHEN THE RUNNER GOT THERE. Matched on the batting index
                # rather than the base slot, because a runner advancing moves
                # between slots and the slot would follow whoever is standing in
                # it. Searched from the start of the play so a runner who was
                # already on the bag reads as the long negative margin they are.
                reach_frame = None
                reach_t = None
                for snapshot in frames:
                    if (snapshot["timer"]
                            > arrival_snapshot["timer"] + CLOSE_PLAY_REACH_SEARCH_FRAMES):
                        break
                    running = next(
                        (candidate for candidate in snapshot["actors"].values()
                         if candidate["kind"] == "offense"
                         and candidate["index"] == actor["index"]),
                        None)
                    if running is None:
                        continue
                    if (math.dist(running["pos"][::2], target_position[::2])
                            <= RUNNER_AT_BASE_UNITS):
                        reach_frame = snapshot["timer"]
                        reach_t = snapshot["t"]
                        break
                runner_at_arrival = {
                    "runner": name,
                    "character_id": actor["character"],
                    "character": character_name(actor["character"]),
                    "distance_from_target_units": round(distance, 3),
                    "distance_before_units": (round(distance_before, 3)
                                              if distance_before is not None else None),
                    "closing_units": (round(distance_before - distance, 3)
                                      if distance_before is not None else None),
                    # The margin itself. `reach_frame` is None when the runner
                    # never reached that base at all, which is most throws --
                    # the nearest runner to second on a routine grounder to
                    # first is twenty units away and was never in the play.
                    "reach_frame": reach_frame,
                    "margin_s": (round(reach_t - arrival_snapshot["t"], 4)
                                 if reach_t is not None else None),
                }
        throws.append({
            "sequence": len(throws) + 1,
            "thrower_position": flight["thrower"],
            "thrower_character_id": thrower["character"],
            "thrower_character": character_name(thrower["character"]),
            "receiver_position": receiver_name,
            "receiver_character_id": receiver["character"],
            "receiver_character": character_name(receiver["character"]),
            "possession_frame": flight["possession_timer"],
            "release_frame": release["timer"],
            # Separation and launch are up to a second apart, because the ball
            # leaves the hand at the start of the wind-up and does not move
            # until the end of it. Arm Strength is a property of the flight, so
            # it is measured from the launch; the separation frame is kept
            # because possession-to-arrival is what an arm-value model needs.
            "launch_frame": launch["timer"],
            "arrival_frame": arrival_snapshot["timer"],
            "release_t": round(release["t"] - contact_t, 4),
            # How long the ball sat in the glove. Ordinary throws release
            # inside a second -- across 558 measured throws the median is 0.70s
            # and the 95th percentile is 1.43s -- so a long hold is a real
            # event, whatever caused it. DK Jungle's flower sprays a fielder and
            # leaves them dazed and unable to throw, and the longest hold in
            # that session (2.94s, four times the median) is exactly the play
            # the operator flagged for it. The measurement is reported; the
            # cause is not guessed at.
            "hold_s": (round(release["t"] - flight["possession_t"], 4)
                       if flight.get("possession_t") is not None else None),
            "launch_t": round(launch["t"] - contact_t, 4),
            "arrival_t": round(arrival_snapshot["t"] - contact_t, 4),
            "flight_frames": len(stable),
            "start": [round(value, 4) for value in start_ball],
            "end": [round(value, 4) for value in end_ball],
            "target_base": target_base,
            "receiver_distance_from_target_units": (
                round(receiver_distance_from_target, 3)
                if receiver_distance_from_target is not None else None),
            # The nearest real runner to the base this throw went to, on the
            # frame the ball got there.
            "runner_at_arrival": runner_at_arrival,
            "receiver_pulled_off_base": receiver_pulled_off_base,
            # The game's aim point one frame after release, how far the ball
            # landed from it, and whether that makes this an inaccurate throw.
            # See THROW_OFF_TARGET_UNITS.
            "aim_at": [round(value, 3) for value in aim_at] if aim_at is not None else None,
            "aim_miss_units": round(aim_miss, 3) if aim_miss is not None else None,
            "aim_to_receiver_units": (round(aim_to_receiver, 3)
                                      if aim_to_receiver is not None else None),
            # Where the game actually sent the ball, and how far that is from
            # the aim point: the error the throw was given, which off_target
            # keys on. See THROW_OFF_TARGET_UNITS.
            "destination_at": ([round(value, 3) for value in destination_at]
                               if destination_at is not None else None),
            "destination_error_units": (round(destination_error, 3)
                                        if destination_error is not None else None),
            "off_target": off_target,
            "peak_speed_mps": round(max(stable), 4),
            "peak_speed_mph": round(max(stable) * METRES_PER_SECOND_TO_MPH, 3),
            "median_speed_mps": round(statistics.median(stable), 4),
            "sample_count": len(stable),
            # A Buddy Throw, and the frozen cutscene that identifies one. The
            # thrower recorded above is the fielder who STARTED it; the
            # chemistry partner who actually threw the ball cannot be recovered
            # from the capture, so this velocity is not an arm measurement.
            "buddy_throw": buddy_throw,
            # Measured, not inferred from speed. False on a session recorded
            # before the flag was named only if that session predates the state
            # block -- every MSSTRK02 capture already holds the byte.
            "laser_throw": laser_throw,
            "buddy_freeze_s": round(launch["t"] - release["t"], 4) if buddy_throw else 0.0,
            "buddy_thrower_position": buddy_named,
            # The chemistry partner who made the throw possible.
            "buddy_partner_position": (
                named_fielder(samples, "buddy_partner", order)
                if buddy_throw else None),
            # Who the throw was AIMED at, from the game rather than from who
            # caught it. On a throw to second base these differ whenever the
            # other middle infielder covers, and the intent is the useful half.
            "intended_target_position": named_fielder(samples, "throw_target", order),
            "outs_recorded": outs_recorded,
            "is_relay": len(throws) > 0,
            "quality": {
                "raw_speed_samples": len(stable),
                "discarded_speed_samples": max(0, len(samples) - 1 - len(stable)),
            },
        })
        flight = None

    for snapshot in live:
        owner = locked_fielder(snapshot)
        if owner is not None:
            if flight is not None:
                finish(owner, snapshot)
            if owner != held_by:
                held_by = owner
                held_since = snapshot["timer"]
                held_since_t = snapshot["t"]
            continue

        if held_by is not None and flight is None:
            flight = {
                "thrower": held_by,
                "possession_timer": held_since,
                "possession_t": held_since_t,
                "release": snapshot,
                "samples": [snapshot],
            }
            held_by = None
            held_since = None
            held_since_t = None
        elif flight is not None:
            flight["samples"].append(snapshot)

    # An out at a base is often posted after the receiver gets the ball (the
    # runner still has to be tagged), so release-to-arrival alone reports zero
    # for successful throws. Attribute every out posted between this arrival
    # and the next throw's release to this throw. A fly-out already exists in
    # the release snapshot and therefore is not borrowed by a later throw.
    by_timer = {snapshot["timer"]: snapshot for snapshot in live}
    for index, throw in enumerate(throws):
        release = by_timer.get(throw["release_frame"])
        end_timer = (throws[index + 1]["release_frame"] - 1
                     if index + 1 < len(throws)
                     else live[-1]["timer"] if live else throw["arrival_frame"])
        after_arrival = [
            snapshot for snapshot in live
            if throw["arrival_frame"] <= snapshot["timer"] <= end_timer
        ]
        if release is not None and after_arrival:
            release_outs = int(release["state"].get("outs", 0))
            final_outs = max(int(snapshot["state"].get("outs", 0))
                             for snapshot in after_arrival)
            throw["outs_recorded"] = max(0, final_outs - release_outs)

    # A runner collision immediately after a close arrival can pop the ball out
    # of the receiver's glove. Possession-to-possession segmentation sees the
    # loose ball reach a backup and would otherwise call it a relay throw. The
    # combination below is intentionally strict: no selected target, very low
    # speed, an immediate transition, and a runner measurably arriving on the
    # preceding throw.
    for index in range(1, len(throws)):
        previous = throws[index - 1]
        current = throws[index]
        contested = previous.get("runner_at_arrival")
        runner_gap = (float(contested.get("distance_from_target_units"))
                      if contested and contested.get("distance_from_target_units") is not None
                      else None)
        closing = (float(contested.get("closing_units"))
                   if contested and contested.get("closing_units") is not None
                   else None)
        transition = float(current["release_t"]) - float(previous["arrival_t"])
        if (current.get("intended_target_position") is None
                and float(current.get("peak_speed_mph") or 0) <= LOOSE_BALL_MAX_SPEED_MPH
                and 0 <= transition <= LOOSE_BALL_MAX_TRANSITION_SECONDS
                and runner_gap is not None
                and runner_gap <= THROWING_ERROR_RUNNER_DISTANCE_UNITS
                and closing is not None
                and closing >= THROWING_ERROR_RUNNER_CLOSING_UNITS):
            current["is_throw"] = False
            current["event_type"] = "loose_ball_recovery"
            current["caused_by_runner_contact"] = True
            current["runner_contact"] = contested
            current["is_relay"] = False
            previous["receiver_knocked_loose"] = True

    # This is a review flag, not an automatic official error. It identifies the
    # narrow factual pattern the scorer needs: an inaccurate throw pulled the
    # receiver off a base while a runner was still arriving, and no out followed.
    for throw in throws:
        contested = throw.get("runner_at_arrival")
        runner_gap = (float(contested.get("distance_from_target_units"))
                      if contested and contested.get("distance_from_target_units") is not None
                      else None)
        closing = (float(contested.get("closing_units"))
                   if contested and contested.get("closing_units") is not None
                   else None)
        throwing_error_candidate = bool(
            throw.get("is_throw") is not False
            and throw.get("intended_target_position") is not None
            and throw.get("receiver_pulled_off_base") is True
            and int(throw.get("outs_recorded") or 0) == 0
            and runner_gap is not None
            and runner_gap <= THROWING_ERROR_RUNNER_DISTANCE_UNITS
            and closing is not None
            and closing >= THROWING_ERROR_RUNNER_CLOSING_UNITS)
        if throwing_error_candidate:
            throw["throwing_error_candidate"] = True

    return throws


def detect_pitch_release_window(recent: list, fps: float) -> list:
    """Return the latest sustained pre-swing ball-flight window."""
    if len(recent) < 4:
        return []
    cutoff = recent[-1]["t"] - PITCH_LOOKBACK_SECONDS
    window = [snapshot for snapshot in recent if snapshot["t"] >= cutoff]
    moving = []
    for before, after in zip(window, window[1:]):
        delta = math.dist(before["ball"], after["ball"])
        moving.append(delta >= PITCH_MOVE_UNITS_PER_FRAME)
    moving_indices = [index for index, value in enumerate(moving) if value]
    if not moving_indices:
        return []
    end = moving_indices[-1]
    # A valid pitch must still have been moving close to the swing; otherwise
    # the latest motion was a reset or the previous play.
    if window[-1]["t"] - window[end + 1]["t"] > 0.5:
        return []
    start = end
    gaps = 0
    while start > 0:
        if moving[start - 1]:
            gaps = 0
            start -= 1
            continue
        gaps += 1
        if gaps > 2:
            break
        start -= 1
    return window[start:end + 2]


def cumulative_distance_splits(track: Track, step_feet: int = 5,
                               max_feet: int = 90) -> dict:
    """Interpolate elapsed time at each five-foot path-distance crossing."""
    if len(track.points) < 2:
        return {}
    thresholds = [(feet, feet / 3.280839895)
                  for feet in range(step_feet, max_feet + step_feet, step_feet)]
    output = {}
    cumulative = 0.0
    target_index = 0
    for index, (before, after) in enumerate(zip(track.points, track.points[1:])):
        step = math.dist(before[::2], after[::2])
        if step > TELEPORT_UNITS or step <= 0:
            continue
        previous = cumulative
        cumulative += step
        while target_index < len(thresholds) and cumulative >= thresholds[target_index][1]:
            feet, distance = thresholds[target_index]
            fraction = (distance - previous) / step
            t = track.times[index] + fraction * (track.times[index + 1] - track.times[index])
            output[str(feet)] = round(t, 4)
            target_index += 1
        if target_index >= len(thresholds):
            break
    return output


def jump_measurement(frames: list, position: str, first_touch: dict,
                     release_timer: int, fps: float) -> dict | None:
    if not frames or not first_touch or release_timer is None:
        return None
    relevant = [snapshot for snapshot in frames if snapshot["timer"] >= release_timer]
    if not relevant or position not in relevant[0]["actors"]:
        return None
    start = relevant[0]["actors"][position]["pos"]
    target = tuple(first_touch["at"])
    vx, vz = target[0] - start[0], target[2] - start[2]
    length = math.hypot(vx, vz)
    if length <= 1e-9:
        return None
    ux, uz = vx / length, vz / length

    def sample_at(seconds):
        target_frame = release_timer + seconds * fps
        return min(relevant, key=lambda snapshot: abs(snapshot["timer"] - target_frame))

    at_15 = sample_at(1.5)["actors"][position]["pos"]
    at_30 = sample_at(3.0)["actors"][position]["pos"]
    reaction = max(0.0, (at_15[0] - start[0]) * ux + (at_15[2] - start[2]) * uz)
    jump = max(0.0, (at_30[0] - start[0]) * ux + (at_30[2] - start[2]) * uz)
    burst = max(0.0, jump - reaction)
    three_second_frames = [snapshot for snapshot in relevant
                           if snapshot["timer"] <= release_timer + 3.0 * fps]
    points = [snapshot["actors"][position]["pos"] for snapshot in three_second_frames]
    path = sum(math.dist(before[::2], after[::2])
               for before, after in zip(points, points[1:])
               if math.dist(before[::2], after[::2]) <= TELEPORT_UNITS)
    return {
        "pitch_release_start": [round(value, 3) for value in start],
        "jump_distance_units": round(jump, 4),
        "jump_distance_feet": round(jump * 3.280839895, 3),
        "reaction_distance_units": round(reaction, 4),
        "reaction_distance_feet": round(reaction * 3.280839895, 3),
        "burst_distance_units": round(burst, 4),
        "burst_distance_feet": round(burst * 3.280839895, 3),
        "jump_route_efficiency": round(jump / path, 4) if path > 0 else None,
    }


# --- the incremental state machine ------------------------------------------
#
# WHY THIS IS A CLASS. The derivation was always an incremental forward state
# machine -- it opens a play when the ball leaves the plate and closes one at
# the dead ball, and nothing in it ever looks back past the play it is in. It
# just happened to be spelled as a loop inside main(), which meant the only
# thing that could run it was a finished recording.
#
# The live collector needs the same answers during the game, and the one thing
# that must not happen is a second implementation: two derivations that agree
# on most plays and quietly disagree on the interesting ones would be worse
# than having no live numbers at all, because the live page would look right.
# So the loop moved here, and both callers feed it the same snapshots built by
# the same SnapshotBuilder.
#
# The postgame pass over the raw .bin remains authoritative. Live output is the
# same code reaching the same conclusion earlier, and it is labelled as live.


class PlayDeriver:
    """Frames in, completed plays out.

    Feed every frame in order with `feed(snapshot)`. It returns the plays that
    finished on that frame -- normally an empty list, and exactly one on the
    frame the ball goes dead. Call `flush()` at the end of a stream to close a
    play that was still open.

    Replay suppression is incremental and equivalent to the batch pass it
    replaces: the batch version only ever compared a play against previously
    KEPT plays inside a 20-second window, which is already a streaming rule.
    """

    def __init__(self, fps: float = GAME_FRAME_RATE, suppress_replays: bool = True,
                 build_executor=None, park: str | None = None,
                 is_night: bool | None = None):
        self.fps = fps
        # Only used to decide what a measured flag may be CALLED. Nothing is
        # measured differently because of it.
        self.park = park
        # THE VARIANT IS NOT COSMETIC HERE, unlike `park` above. Wario City's
        # arrows impose 11.9455 u/s by day and exactly 2.25x that at night, so a
        # deriver that does not know which one it is watching measures neither.
        # See ARROW_IMPOSED_SPEED_UPS.
        self.is_night = is_night
        self.suppress_replays = suppress_replays
        # WHERE build_play RUNS. Closing a play costs 42-87 ms on the archived
        # sessions -- route summaries, throw segmentation and split
        # interpolation over up to 1,800 frames -- and a 60 Hz capture has a
        # 16.7 ms frame budget of which the recording itself already uses 1.8.
        # Doing that work inline would drop about five frames at every dead
        # ball, which is exactly the kind of quiet damage live derivation is
        # not allowed to do to the recording.
        #
        # So a live caller passes a SINGLE-WORKER executor. The build moves off
        # the capture loop, the GIL hands it out in millisecond slices while
        # the loop keeps reading frames, and one worker preserves the order
        # plays closed in. The postgame pass passes nothing and runs inline,
        # which is why both produce byte-identical output: same function, same
        # arguments, same sequence -- only the thread differs.
        self.build_executor = build_executor
        self._pending = deque()
        # Measured bag coordinates, ball frame. An unoccupied runner slot parks
        # exactly on its bag, so the session itself says where the bases are.
        self.bags = {}
        self.recent = deque(maxlen=int(fps * 12))
        self.active = None
        self.pending = None
        self.previous_state = None
        self.pointer_tables = set()
        self.frames_seen = 0
        self.plays_emitted = 0
        self.replay_duplicates = 0
        # Per-play wall cost, so a live caller can prove the derivation is not
        # what is eating its frame budget.
        self.last_build_seconds = None
        self.max_build_seconds = 0.0
        self._seen = {}

    # -- replay suppression, incrementally ---------------------------------

    _FAIR_CLASSES = frozenset(
        {"fair_in_play", "fair_caught", "home_run", "home_run_robbed"})
    _COMPARABLE_CLASSES = _FAIR_CLASSES | {"unknown"}

    def _accept(self, play: dict):
        """Keep this play, or drop it as an immediate replay copy."""
        trajectory = tuple(tuple(point)
                           for point in play.pop("_trajectory_signature", ()))
        if not self.suppress_replays:
            return play
        play_class = play.get("batted_ball_class")
        if play_class not in self._COMPARABLE_CLASSES or not trajectory:
            return play
        key = (
            play.get("inning"), play.get("inning_half"), play.get("outs"),
            play.get("balls"), play.get("strikes"), play.get("batter_id"),
            play.get("batter_index"),
        )
        timer = play.get("contact_timer")
        window = round(self.fps * REPLAY_WINDOW_SECONDS)
        if timer is not None:
            fingerprint = replay_fingerprint(play)
            for (previous_timer, previous_class, previous_trajectory,
                 previous_fingerprint) in self._seen.get(key, ()):
                # An unknown record is useful evidence when it stands alone, but
                # it is not strong enough to suppress a later called fair ball.
                if previous_class not in self._FAIR_CLASSES:
                    continue
                if not 0 <= timer - previous_timer <= window:
                    continue
                if replay_trajectories_match(
                        previous_trajectory, trajectory,
                        previous_fingerprint, fingerprint, play.get("live_s")):
                    self.replay_duplicates += 1
                    return None
            if play_class in self._FAIR_CLASSES:
                self._seen.setdefault(key, []).append(
                    (timer, play_class, trajectory, fingerprint))
        return play

    def _finish(self, play: dict) -> list:
        kept = self._accept(play)
        if kept is None:
            return []
        self.plays_emitted += 1
        return [kept]

    def _timed_build(self, active, bags, truncated: bool) -> dict:
        started = time.perf_counter()
        play = build_play(active, bags, self.fps, truncated=truncated,
                          park=self.park, is_night=self.is_night)
        self.last_build_seconds = time.perf_counter() - started
        self.max_build_seconds = max(self.max_build_seconds,
                                     self.last_build_seconds)
        return play

    def _close(self, truncated: bool) -> list:
        active = self.active
        self.active = None
        # `bags` keeps being measured by later frames, so the build gets the
        # snapshot that was true when this play ended rather than a dict that
        # mutates underneath it.
        bags = dict(self.bags)
        if self.build_executor is None:
            return self._finish(self._timed_build(active, bags, truncated))
        self._pending.append(
            self.build_executor.submit(self._timed_build, active, bags, truncated))
        return self._drain()

    def _drain(self, block: bool = False) -> list:
        """Release the builds that have finished, oldest first.

        Order is preserved by refusing to skip an unfinished build: a play that
        closed earlier is always emitted earlier, which is what lets the
        replay-suppression window and the postgame comparison stay valid.
        """
        released = []
        while self._pending:
            future = self._pending[0]
            if not block and not future.done():
                break
            self._pending.popleft()
            released.extend(self._finish(future.result()))
        return released

    # -- the frame loop ----------------------------------------------------

    def note_pointers(self, pointers) -> None:
        """Whether the nine fielder objects are ever reallocated.

        The fixed capture region rests on this one assumption, and the failure
        if it breaks is silent: half a session of stale bytes that still look
        like coordinates.
        """
        self.pointer_tables.add(tuple(pointers))

    def feed(self, snapshot: dict) -> list:
        """One frame. Returns the plays released by it."""
        self.frames_seen += 1
        released = self._drain() if self._pending else []
        if released:
            return released + self._feed(snapshot)
        return self._feed(snapshot)

    def _feed(self, snapshot: dict) -> list:
        state = snapshot["state"]
        t = snapshot["t"]
        ball = snapshot["ball"]

        for name, actor in snapshot["actors"].items():
            # An empty runner slot sits on its bag, so it measures the bag.
            if (actor["kind"] == "offense" and name != "BAT"
                    and actor["index"] < 0):
                self.bags[name] = actor["pos"]
        self.recent.append(snapshot)

        hit = state["ball_was_hit"]
        was_hit = self.previous_state["ball_was_hit"] if self.previous_state else 0
        self.previous_state = state

        if self.active is None and self.pending is None and was_hit == 0 and hit == 1:
            # `ball_was_hit` rises at the SWING, not at the launch. The ball
            # then sits frozen at the plate for the duration of the contact
            # animation -- measured at 1.6 s on a star swing -- before it moves
            # at all. Starting the clock here would fold that animation into
            # every reaction time, and because the freeze is longer for star
            # swings than for ordinary ones it would do so unevenly. So mark it
            # pending and wait for the ball to actually leave.
            #
            # It also rises again AFTER the ball is dead, while the game replays
            # a home run or changes innings. Those raises are not swings: the
            # ball is out where it came to rest rather than on the plate, and
            # `game_state` has already left its live-ball value.
            if (math.hypot(ball[0], ball[2]) > CONTACT_BALL_RADIUS_UNITS
                    or state["game_state"] != LIVE_BALL_GAME_STATE):
                return []
            pitch_window = detect_pitch_release_window(list(self.recent), self.fps)
            self.pending = {
                "t": t, "timer": snapshot["timer"], "ball": ball,
                "situation": dict(state),
                "pitch_frames": pitch_window,
                "pitch_release_timer": pitch_window[0]["timer"] if pitch_window else None,
            }
            return []

        if self.pending is not None:
            pending = self.pending
            if not pending["pitch_frames"] or pending["pitch_frames"][-1]["timer"] != snapshot["timer"]:
                pending["pitch_frames"].append(snapshot)
            moved = math.dist(ball, pending["ball"])
            expired = t - pending["t"] > MAX_LAUNCH_DELAY_SECONDS
            if moved > LAUNCH_MOVE_UNITS:
                self.active = {
                    "contact_t": t,
                    "contact_timer": snapshot["timer"],
                    # The frame the swing itself started, which is not the frame
                    # the ball left: the contact animation holds the ball at the
                    # plate for 2 frames on an ordinary swing and about 91 on a
                    # star swing. PitchDeriver closes a pitch at the swing, so
                    # this is the frame the two streams join on -- carrying it
                    # means the join is an equality rather than a tolerance.
                    "swing_timer": pending["timer"],
                    "swing_to_launch_s": round(t - pending["t"], 4),
                    "frames": [snapshot],
                    "pre_contact_frames": pending["pitch_frames"],
                    "pitch_release_timer": pending.get("pitch_release_timer"),
                    "situation": pending["situation"],
                    "live_timer": snapshot["timer"],
                    "live_flags": [],
                }
                self.pending = None
                return []
            if expired or hit == 0:
                # The ball never left: a foul tip taken by the catcher, or a
                # flag that flickered. Nothing to measure.
                self.pending = None
            return []

        if self.active is not None:
            active = self.active
            active["frames"].append(snapshot)
            if state["game_state"] == LIVE_BALL_GAME_STATE:
                # The live window, and the fair/foul and home-run calls made
                # inside it. Both flags are cleared on the same frame the play
                # window closes, so the last frame of the window always reads 0
                # for both.
                active["live_timer"] = snapshot["timer"]
                active["live_flags"].append(
                    (state["fair_or_foul"], state["home_run_flag"]))
            over = (hit == 0 and was_hit == 1)
            too_long = t - active["contact_t"] > MAX_PLAY_SECONDS
            # `ball_was_hit` is not a reliable end-of-play signal on its own: it
            # stays latched through inning changes and between-play animation,
            # for up to 9.8s past the dead ball in the archived sessions. That
            # is dead time for the derivation -- every detector is already
            # windowed at `live_end` -- but it is not dead time for an operator
            # waiting to see what the tracker made of the play. So the window
            # also closes a fixed tail past the game's own dead-ball transition.
            #
            # The tail is not arbitrary. The one measurement that legitimately
            # reads PAST the dead ball is `final_bases_ran`, which follows a
            # runner's count through the actor teardown, and the widest gap in
            # the whole archive between the dead ball and a runner's last
            # advance is inside this window. Verified by re-deriving all five
            # sessions: identical output on every field of every play.
            if state["game_state"] == LIVE_BALL_GAME_STATE:
                active["dead_since"] = None
            elif active.get("dead_since") is None:
                active["dead_since"] = snapshot["timer"]
            settled = (active.get("dead_since") is not None
                       and snapshot["timer"] - active["dead_since"]
                       >= DEAD_BALL_TAIL_FRAMES)
            if over or too_long or settled:
                # After the final out of a game, `ball_was_hit` can stay set
                # forever while the caught ball remains locked in the glove. A
                # caught third out is terminal on its own; there can be no
                # subsequent runner/throw outcome the latched state is hiding.
                return self._close(
                    truncated=too_long and not is_complete_third_out_catch(active))
        return []

    def flush(self) -> list:
        """Close a play still open at the end of the stream, and wait for the
        deferred builds so nothing is lost when the capture stops."""
        released = []
        if self.active is not None:
            released.extend(self._close(
                truncated=not is_complete_third_out_catch(self.active)))
        released.extend(self._drain(block=True))
        return released


# The game's own `game_state` while a pitch is being delivered. Every one of the
# 154 genuine pitches in bowser_castle-20260828T182145Z incremented the pitch
# counter at this value, with the ball 15.8u to 17.7u from the plate -- in the
# pitcher's hand. The two increments that were NOT at this value were both
# inside a home-run replay, with the ball 47u and 89u away, and are the same
# replay that re-raises `ball_was_hit`. Gating on it is what makes the memory
# pitch count trustworthy enough to reconcile the tracker log against.
PITCH_GAME_STATE = 1

# A pitch nothing ever resolved is reported as unresolved rather than dropped.
# Real ones settle in about a second; this only has to be longer than an
# animation, and it exists so a missed transition costs one labelled record
# instead of silently swallowing every pitch after it.
MAX_PITCH_RESOLUTION_SECONDS = 20.0

# THE HORIZONTAL STRIKE-ZONE CORE AND OUTER EDGE, measured from 141 taken
# pitches across ten sessions.  Called strikes reached |x|=0.6344; called balls
# began at |x|=0.6250, so the exact edge is character/height sensitive and must
# not be represented as a single magic line.  Pitches inside 0.60 are safely in,
# pitches outside 0.70 are safely out, and the overlapping edge remains
# `shadow`.  A taken call is stronger evidence and overrides the geometry.
PITCH_ZONE_IN_MAX_ABS_X = 0.60
PITCH_ZONE_OUT_MIN_ABS_X = 0.70


def classify_pitch_zone(offer: str, outcome: str,
                        plate_x_units: float | None) -> tuple[str, bool | None, str]:
    """Return (zone, is_chase, source) without guessing at the plate edge."""
    if offer == "take" and outcome == "ball":
        return "out", False, "taken_ball"
    if offer == "take" and outcome == "strike":
        return "in", False, "taken_strike"
    if plate_x_units is None or not math.isfinite(plate_x_units):
        return "unknown", None, "plate_location_missing"
    distance = abs(plate_x_units)
    if distance <= PITCH_ZONE_IN_MAX_ABS_X:
        zone = "in"
    elif distance >= PITCH_ZONE_OUT_MIN_ABS_X:
        zone = "out"
    else:
        return "shadow", None, "horizontal_shadow_band_v1"
    return zone, bool(offer == "swing" and zone == "out"), "horizontal_zone_v1"


def _star_meter_drop(previous: dict, state: dict, running: dict) -> None:
    """Add one frame's meter drops to a pitch's running total.

    THE DEDUCTION DOES NOT LAND INSIDE THE PITCH. A star pitch is paid for on
    the very frame the game's pitch counter rises -- the same frame the pitch's
    `before` snapshot is taken -- so differencing that snapshot against the
    pitch's resolution compared two post-deduction readings and reported 0. In
    mario_stadium-20260925T165659Z the fielding meter walks 250 -> 200 -> 183
    -> 133 -> 94 -> 55 -> 5 across nine annotated star pitches and the old
    arithmetic called every one of them 0 spent. The drop is therefore measured
    from the frame BEFORE the release onwards; see _begin.

    Summing FRAME-TO-FRAME drops rather than differencing the two ends also
    stops an award landing mid-pitch from cancelling a real spend. The meter is
    not a continuous recharge: it is awarded in discrete jumps.
    """
    for side in ("away", "home"):
        was = previous.get(f"{side}_star_meter")
        now = state.get(f"{side}_star_meter")
        if was is None or now is None:
            continue
        running[side] = (running.get(side) or 0) + max(0, was - now)


def _star_meter_spend(half, drops: dict) -> dict:
    """What each side spent off its star meter across one pitch.

    The batting side spending is a star swing. The FIELDING side spending is a
    star pitch, which no metric in this project has measured before -- the
    existing `star_swing` flag is a captain-swing byte and is silent on pitching
    and on ordinary characters.

    Absent meters give None, never 0: a session recorded before 2026-09-25 has
    no meter bytes at all, and "no evidence" must not read as "spent nothing".
    """
    batting, fielding = (("away", "home") if half == 0 else
                         ("home", "away") if half == 1 else (None, None))
    out = {"batting_star_meter_spent": None, "fielding_star_meter_spent": None}
    if batting is None:
        return out
    for role, side in (("batting", batting), ("fielding", fielding)):
        out[f"{role}_star_meter_spent"] = drops.get(side)
    return out


class PitchDeriver:
    """Frames in, one record per pitch out.

    WHY THIS IS SEPARATE FROM PlayDeriver. A play is a batted ball, and most
    pitches are not one: the tracker's own log has no way to tell a swinging
    strike from a called strike, so it reports both as `strike_unknown`, and a
    pitch the log misses entirely leaves no trace at all. Both facts are in the
    state block on every frame -- the pitch counter, and the two swing animation
    counters that say how the batter offered -- and neither of them needs a
    position offset, so this runs and is trustworthy even in a session whose
    calibration never confirms.

    What it deliberately does NOT do is restate the batted ball. A pitch that
    made contact says so and names the frame, and the play record joined to
    that frame owns fair/foul, the landing and everything downstream.
    """

    def __init__(self, fps: float = GAME_FRAME_RATE):
        self.fps = fps
        self.previous_state = None
        self.open = None
        self.pitches_emitted = 0
        # Increments rejected as a replay of a pitch already counted. Reported
        # rather than hidden: if this ever climbs into the same order as the
        # pitch count, the rule is wrong and the count cannot be trusted.
        self.replay_increments = 0
        # THE REPLAY RE-RUNS THE PITCH COUNTER. When the game replays a home run
        # or a nice play it does not merely re-raise `ball_was_hit` -- it reloads
        # the state from before the pitch and runs the whole thing again, pitch
        # counter included, with the ball back in the pitcher's hand. So a
        # replayed pitch is at PITCH_GAME_STATE with the ball exactly where a
        # real one starts, and neither position nor game state can separate them.
        #
        # What separates them is that a replay covers ground already covered.
        # Within one plate appearance the counter only ever goes up, so a pitch
        # is real only when it takes the counter to a value this plate
        # appearance has not already reached. On
        # bowser_castle-20260828T182145Z that rejects 11 phantoms -- one per home
        # run, one per replayed nice play -- and keeps 145, which is exactly the
        # number of pitches in the tracker's own log for the same game.
        self._pa_key = None
        self._pitch_high = 0
        # THE CHARGE LATCH. Neither charge field can be read as a level, because
        # each one goes stale in a different way: when a charge is abandoned the
        # frame counter drops to 0 and THE METER KEEPS its last value, and when a
        # swing makes contact the meter resets to 0.0 and THE COUNTER FREEZES
        # where it was until the next plate appearance. Reading either as "is a
        # charge up right now" therefore carries the previous pitch's answer
        # forward: gating on a non-zero meter called 95% of the swings in three
        # real games a charge, including pitches nobody charged.
        #
        # A RISE is the one reading that cannot be stale. The counter only ever
        # increases while the charge is actually being held, so a rise during a
        # pitch is a live charge and its value at the last rise is the size of
        # it. The latch is set by a rise, cleared when the counter drops, and
        # cleared again as each pitch resolves, because a pitch consumes the
        # charge that was up for it. It is updated every frame rather than only
        # while a pitch is open, since a batter starts charging before the pitch
        # is released.
        self._charge_previous = None
        self._charge_live = False
        self._charge_frames = 0
        self._charge_release_timer = None
        # A batter can begin the swing a few frames before the game increments
        # its pitch counter. Track onset globally so the new pitch does not see
        # an already-running animation with no start time.
        self._swing_previous = None
        self._swing_onset_timer = None

    # -- the frame loop ----------------------------------------------------

    def feed(self, snapshot: dict) -> list:
        """One frame. Returns the pitches that resolved on it."""
        state = snapshot["state"]
        previous, self.previous_state = self.previous_state, state
        if previous is None:
            return []

        self._track_swing_onset(snapshot, state)
        self._track_charge(snapshot, state)

        released = []
        if self.open is not None:
            self._track(snapshot, previous, state)
            resolved = self._resolution(snapshot, previous, state)
            if resolved:
                released.append(self._close(snapshot, *resolved))

        # `pitches` is the game's own per-plate-appearance pitch counter, and it
        # resets between plate appearances, so a rise in it is a pitch -- unless
        # the rise is a replay re-running one already counted. See _replay_high.
        # Which plate appearance this is. The lineup INDEX alone is not enough:
        # the two teams number their slots the same way, so a half-inning that
        # ends on slot 8 and the next one that opens on slot 8 look like one
        # continuing plate appearance, and the leadoff pitch of the new half
        # gets thrown away as a replay of the last one of the old.
        pa_key = (state.get("inning"), state.get("inning_half"),
                  state.get("batter_index"), state.get("batter_id"))
        if pa_key != self._pa_key:
            self._pa_key = pa_key
            self._pitch_high = 0

        if state.get("pitches", 0) > previous.get("pitches", 0):
            replayed = state.get("pitches", 0) <= self._pitch_high
            if state.get("game_state") != PITCH_GAME_STATE or replayed:
                self.replay_increments += 1
            else:
                self._pitch_high = state.get("pitches", 0)
                # A pitch still open when the next one is thrown never had its
                # outcome observed. It is emitted saying exactly that.
                if self.open is not None:
                    released.append(self._close(snapshot, "unknown", "superseded"))
                self._begin(snapshot, previous, state)
        return released

    def flush(self) -> list:
        """Close a pitch still open at the end of the stream."""
        if self.open is None:
            return []
        snapshot = {"timer": self.open["last_timer"], "t": self.open["last_t"],
                    "state": self.previous_state or {}}
        return [self._close(snapshot, "unknown", "capture_ended")]

    # -- one pitch ---------------------------------------------------------

    def _begin(self, snapshot: dict, previous: dict, state: dict) -> None:
        pitcher = snapshot["actors"].get("P") or {}
        # The star-meter deduction for a star pitch lands on THIS frame, so
        # the running total has to start one frame earlier. See
        # _star_meter_drop.
        meter_drop: dict = {}
        _star_meter_drop(previous, state, meter_drop)
        self.open = {
            "meter_drop": meter_drop,
            "pitch_timer": snapshot["timer"],
            "t": snapshot["t"],
            "last_timer": snapshot["timer"],
            "last_t": snapshot["t"],
            "situation": dict(state),
            "pitcher_id": pitcher.get("character"),
            # Both counters can still be running down from the PREVIOUS pitch
            # when this one is thrown -- a swing's follow-through outlasts the
            # next release by dozens of frames -- so a value on its own says
            # nothing. What is recorded is whether each one ROSE while this
            # pitch was in the air, and separately what both read at the moment
            # the ball arrived. See _offer for why the second is the answer.
            "swing_shown": False,
            "bunt_shown": False,
            "star_swing_shown": False,
            "swing_frames": 0,
            "bunt_frames": 0,
            "closest_units": None,
            # The sample nearest the front/back plane of home plate.  Keep the
            # coordinates, not just the old radial distance: chase decisions
            # require knowing where the pitch crossed the plate.  This is raw
            # evidence; zone classification happens separately so a later
            # calibration can improve without changing what was measured.
            "plate_distance_units": None,
            "plate_location": None,
            "plate_timer": None,
            "swing_at_plate": 0,
            "bunt_at_plate": 0,
            # First frame on which the ordinary swing animation counter rises.
            # This is the release target for a held charge.  Keep it separate
            # from `swing_timer`, which is the contact frame used to join the
            # pitch to its batted-ball play.
            "swing_start_timer": (
                self._swing_onset_timer
                if (state.get("swing_frames") or 0) > 0 else None
            ),
            "swing_timer": None,
        }

    def _track_charge(self, snapshot: dict, state: dict) -> None:
        """Follow the batter's charge across frames. See the latch in __init__."""
        counter = state.get("swing_charge_frames")
        if counter is None:
            return
        previous, self._charge_previous = self._charge_previous, counter
        if previous is None:
            return
        if counter > previous:
            self._charge_live = True
            self._charge_frames = counter
            self._charge_release_timer = snapshot["timer"]
        elif counter < previous:
            # The charge was abandoned, or the game cleared it between batters.
            self._charge_live = False
            self._charge_frames = 0
            self._charge_release_timer = None

    def _track_swing_onset(self, snapshot: dict, state: dict) -> None:
        """Latch swing onset even when it precedes the pitch-counter rise."""
        counter = state.get("swing_frames")
        if counter is None:
            return
        previous, self._swing_previous = self._swing_previous, counter
        if previous is not None and previous == 0 and counter > 0:
            self._swing_onset_timer = snapshot["timer"]

    def _take_charge(self) -> tuple:
        """The charge this pitch was swung with, consuming it."""
        held = ((self._charge_frames, self._charge_release_timer)
                if self._charge_live else (0, None))
        self._charge_live = False
        self._charge_frames = 0
        self._charge_release_timer = None
        return held

    def _track(self, snapshot: dict, previous: dict, state: dict) -> None:
        pitch = self.open
        pitch["last_timer"] = snapshot["timer"]
        pitch["last_t"] = snapshot["t"]
        _star_meter_drop(previous, state, pitch["meter_drop"])
        for counter, shown in (("swing_frames", "swing_shown"),
                               ("bunt_frames", "bunt_shown")):
            was = previous.get(counter) or 0
            now = state.get(counter) or 0
            if was == 0 and now > 0:
                pitch[shown] = True
                if counter == "swing_frames" and pitch["swing_start_timer"] is None:
                    pitch["swing_start_timer"] = snapshot["timer"]
            if pitch[shown]:
                pitch[counter] = max(pitch[counter], now)
        if state.get("star_swing"):
            pitch["star_swing_shown"] = True
        # WHERE THE BALL GOT CLOSEST TO THE PLATE, and what the bat was doing
        # there. A pitch resolves after the ball has gone by -- the count does
        # not change until it reaches the catcher -- so the resolving frame is
        # too late to read, and "the counter rose at some point" is too early.
        radius = math.hypot(snapshot["ball"][0], snapshot["ball"][2])
        if pitch["closest_units"] is None or radius < pitch["closest_units"]:
            pitch["closest_units"] = radius
            pitch["swing_at_plate"] = state.get("swing_frames") or 0
            pitch["bunt_at_plate"] = state.get("bunt_frames") or 0
        plate_distance = abs(snapshot["ball"][2])
        if (pitch["plate_distance_units"] is None
                or plate_distance < pitch["plate_distance_units"]):
            pitch["plate_distance_units"] = plate_distance
            pitch["plate_location"] = tuple(snapshot["ball"])
            pitch["plate_timer"] = snapshot["timer"]

    @staticmethod
    def _offer(pitch: dict) -> str:
        """How the batter offered: what the bat was doing when the ball arrived.

        NOT merely whether a counter rose. A batter can square to bunt and pull
        the bat back, and that is a taken pitch, not a bunt: the one in
        bowser_castle-20260828T182145Z held the stance for 4 frames and was out
        of it with the ball still 11 units away, then took the pitch for a
        strike. Read as a rise it was indistinguishable from the bunt Baby DK
        actually laid down, which held for 26 frames and was still running when
        the bat met the ball.

        The square that was abandoned is kept as `bunt_shown` rather than thrown
        away -- it is a real decision by the hitter, it is just not a bunt.
        """
        if pitch["bunt_at_plate"]:
            return "bunt"
        if pitch["swing_at_plate"]:
            return "swing"
        return "take"

    def _resolution(self, snapshot: dict, previous: dict, state: dict):
        """(outcome, how) once this pitch's outcome is observable, else None."""
        pitch = self.open
        # Contact is the same event PlayDeriver starts a play on, gated the same
        # way, so the two cannot disagree about whether a pitch was hit.
        if (previous.get("ball_was_hit") == 0 and state.get("ball_was_hit") == 1
                and state.get("game_state") == LIVE_BALL_GAME_STATE
                and math.hypot(snapshot["ball"][0], snapshot["ball"][2])
                <= CONTACT_BALL_RADIUS_UNITS):
            pitch["swing_timer"] = snapshot["timer"]
            return ("contact", "ball_was_hit")
        if state.get("balls", 0) > previous.get("balls", 0):
            return ("ball", "balls")
        if state.get("strikes", 0) > previous.get("strikes", 0):
            return ("strike", "strikes")
        # Strike three does not increment the count -- it resets it and retires
        # the batter -- so the end of the plate appearance is the only signal a
        # third strike leaves.
        ended = (state.get("outs", 0) > previous.get("outs", 0)
                 or state.get("batter_index") != previous.get("batter_index")
                 or state.get("inning") != previous.get("inning")
                 or state.get("inning_half") != previous.get("inning_half"))
        if ended:
            struck_out = (previous.get("strikes", 0) >= 2
                          and state.get("outs", 0) > previous.get("outs", 0))
            return ("strike" if struck_out else "unknown", "plate_appearance_ended")
        if snapshot["t"] - pitch["t"] > MAX_PITCH_RESOLUTION_SECONDS:
            return ("unknown", "timed_out")
        return None

    def _close(self, snapshot: dict, outcome: str, how: str) -> dict:
        pitch, self.open = self.open, None
        self.pitches_emitted += 1
        before = pitch["situation"]
        after = snapshot.get("state") or {}
        offer = self._offer(pitch)
        plate_x = (None if pitch["plate_location"] is None
                   else pitch["plate_location"][0])
        pitch_zone, is_chase, zone_source = classify_pitch_zone(
            offer, outcome, plate_x)
        star_swing = bool(pitch["star_swing_shown"]
                          or (before.get("star_swing") or 0)
                          or (after.get("star_swing") or 0))
        # Every pitch consumes the charge latch, whether or not it was swung at,
        # so an abandoned charge can never be credited to a later pitch.
        charge_frames, charge_release_timer = self._take_charge()
        swing_start_timer = (pitch["swing_start_timer"]
                             if offer == "swing" else None)
        # Every resolved pitch consumes any onset latch. A late swing on a take
        # must not become the next pitch's swing.
        self._swing_onset_timer = None
        # Whether this capture carries the charge fields at all. A session
        # recorded before they were named reads back with the key absent, and
        # that has to stay `ordinary_unknown` -- no evidence is not a slap.
        charge_readable = "swing_charge_frames" in before
        swing_mode = ("bunt" if offer == "bunt" else
                      "star" if offer == "swing" and star_swing else
                      ("charge" if charge_frames > 0 else "slap")
                      if offer == "swing" and charge_readable else
                      "ordinary_unknown" if offer == "swing" else "none")
        return {
            "pitch_timer": pitch["pitch_timer"],
            "resolved_timer": snapshot["timer"],
            "inning": before.get("inning"),
            "inning_half": before.get("inning_half"),
            "outs": before.get("outs"),
            "batter_id": before.get("batter_id"),
            "batter": character_name(before.get("batter_id")),
            "batter_index": before.get("batter_index"),
            "pitcher_id": pitch["pitcher_id"],
            "pitcher": character_name(pitch["pitcher_id"]),
            "pitch_in_pa": before.get("pitches"),
            "balls_before": before.get("balls"),
            "strikes_before": before.get("strikes"),
            "balls_after": after.get("balls"),
            "strikes_after": after.get("strikes"),
            # THE FACT THIS EXISTS FOR. The tracker log cannot see it, and it is
            # what separates a swinging strike from a called one.
            "offer": offer,
            # Slap versus charge, off the charge counter in the same struct as
            # the animation counters -- NOT off swing_frames, which is the same
            # animation either way and which contact freezes, so hard contact
            # looks like a short swing. The counter is read as a rise rather
            # than a level; see the latch in __init__ for why a level is a lie.
            "swing_mode": swing_mode,
            "swing_mode_source": ("bunt_frames" if swing_mode == "bunt" else
                                  "star_swing" if swing_mode == "star" else
                                  "swing_charge_frames_rise"
                                  if swing_mode in ("charge", "slap") else
                                  "swing_charge_state_absent" if offer == "swing" else
                                  "no_offer"),
            # How long the charge was held. NULL, never 0, when the capture
            # cannot say: a measured slap is 0 frames of charge, and "not
            # charged" and "no evidence either way" must stay separable.
            "swing_charge_frames": (charge_frames if charge_readable
                                    and offer == "swing" else None),
            # How far before the swing animation began the charge counter last
            # rose.  The counter freezes when the batter releases the charge;
            # measuring to pitch resolution instead made a whiff look dozens
            # of frames later than a contact swing. Null when there was no
            # charge to release or no observed swing onset.
            "swing_charge_release_timing_frames": (
                None if (charge_release_timer is None or offer != "swing"
                         or swing_start_timer is None)
                else swing_start_timer - charge_release_timer),
            "swing_start_timer": swing_start_timer,
            "swing_frames": pitch["swing_frames"],
            "bunt_frames": pitch["bunt_frames"],
            # A stance the batter got into and came out of before the ball
            # arrived. `bunt_shown` without `offer == "bunt"` is a square that
            # was pulled back.
            "swing_shown": pitch["swing_shown"],
            "bunt_shown": pitch["bunt_shown"],
            "closest_units": (None if pitch["closest_units"] is None
                              else round(pitch["closest_units"], 3)),
            "plate_x_units": (None if pitch["plate_location"] is None
                              else round(pitch["plate_location"][0], 4)),
            "plate_y_units": (None if pitch["plate_location"] is None
                              else round(pitch["plate_location"][1], 4)),
            "plate_z_units": (None if pitch["plate_location"] is None
                              else round(pitch["plate_location"][2], 4)),
            "plate_timer": pitch["plate_timer"],
            "pitch_zone": pitch_zone,
            "pitch_zone_source": zone_source,
            "is_chase": is_chase,
            "outcome": outcome,
            "outcome_source": how,
            # The batted ball, if there was one. The play joined on this frame
            # owns everything about it -- fair or foul, the landing, the
            # fielding. `swing_timer` is the frame the swing started, which is
            # what the play carries under the same name; joining on the frame
            # the ball LEFT would need a tolerance, because the contact
            # animation holds it at the plate for 2 frames on an ordinary swing
            # and about 91 on a star swing.
            "contact": pitch["swing_timer"] is not None,
            "swing_timer": pitch["swing_timer"],
            # THE SCORE THIS PITCH WAS THROWN AT. Retroactive: these bytes were
            # always inside the captured block and merely had no name until
            # 2026-09-25. Every downstream value model needs the game state a
            # decision was made in, and stars in particular are handed out by a
            # comeback rule that favours the trailing team -- so a star decision
            # read without the score re-measures the deficit.
            "away_score": before.get("away_score"),
            "home_score": before.get("home_score"),
            # THE TEAM STAR METERS, at this pitch's release frame and at its
            # resolution. NOT retroactive: they sit below where this project
            # captured until 2026-09-25, so every earlier session reads None
            # rather than zero. None and 0 are different answers -- 0 is an
            # empty meter.
            #
            # `away_star_meter`/`home_star_meter` are read at the release frame,
            # which is AFTER a star pitch has been charged for. They are the raw
            # readings and are left alone; the spend below is what says a star
            # was paid for.
            "away_star_meter": before.get("away_star_meter"),
            "home_star_meter": before.get("home_star_meter"),
            "away_star_meter_after": after.get("away_star_meter"),
            "home_star_meter_after": after.get("home_star_meter"),
            # What each side spent on this pitch. The batting side spending is a
            # star swing; the FIELDING side spending is a star pitch, which
            # nothing in this project has ever measured. The meter is a bar, not
            # a count: the amount is one of the three costs in the capture
            # header, and which one names the spender (captain, own captain,
            # ordinary) -- except that regular and own-captain are both 50, so
            # only the 100 of a borrowed captain is distinguishable. Summed from
            # frame-to-frame falls starting one frame before the release, so an
            # award landing mid-pitch cannot cancel a spend; see
            # _star_meter_drop.
            **_star_meter_spend(before.get("inning_half"),
                                pitch["meter_drop"]),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session")
    parser.add_argument("--out", default=None, help="override the .plays.jsonl path")
    parser.add_argument("--pitches-out", default=None,
                        help="override the .pitches.jsonl path")
    parser.add_argument("--frame-rate", type=float, default=GAME_FRAME_RATE,
                        help="game frames per second (default: Wii NTSC)")
    args = parser.parse_args()

    session = Session(args.session)
    calibration_path = Path(str(session.stem) + ".calibration.json")
    if not calibration_path.exists():
        raise SystemExit(
            f"No calibration for this session.\n"
            f"  python scripts/calibrate_player_tracking.py {args.session}\n"
            "Without it there is no way to know which bytes are the live "
            "position, and a wrong guess yields numbers rather than an error."
        )
    calibration = json.loads(calibration_path.read_text())
    offset = calibration["position_offset"]
    ball_frame = calibration.get("ball_frame", {})
    sign_x = ball_frame.get("sign_x", 1.0)
    sign_z = ball_frame.get("sign_z", -1.0)
    swap = ball_frame.get("swap_xz", False)

    fps = args.frame_rate
    speed = emulator_speed(session)

    out_path = Path(args.out) if args.out else Path(str(session.stem) + ".plays.jsonl")
    pitch_path = (Path(args.pitches_out) if args.pitches_out
                  else Path(str(session.stem) + ".pitches.jsonl"))
    plays = []
    pitches = []
    # The same snapshot builder and the same state machine the live collector
    # runs. Nothing about this pass is postgame-specific except where the
    # frames come from, which is the whole point: a live play and its postgame
    # restatement cannot disagree because one of them took a different path.
    builder = session_snapshot_builder(session, offset, ball_frame, fps)
    deriver = PlayDeriver(fps=fps, park=session.header.get("park"),
                          is_night=session.header.get("is_night"))
    pitcher = PitchDeriver(fps=fps)

    print(f"session {session.stem.name}  park={session.header['park']}")
    print(f"position offset +0x{offset:03X}  game clock {fps:.2f} Hz  "
          f"(emulator ran at {speed:.1%} of full speed)")
    print(f"ball frame: x{'<-z' if swap else '<-x'} * {sign_x:+.0f}, "
          f"z{'<-x' if swap else '<-z'} * {sign_z:+.0f}")

    for frame in session.frames():
        deriver.note_pointers(frame.fielder_pointers)
        snapshot = builder.build(frame.timer, frame.ball, frame.block)
        pitches.extend(pitcher.feed(snapshot))
        plays.extend(deriver.feed(snapshot))
    plays.extend(deriver.flush())
    pitches.extend(pitcher.flush())

    replay_duplicates = deriver.replay_duplicates
    pointer_tables = deriver.pointer_tables
    bags = deriver.bags
    with out_path.open("w") as sink:
        for play in plays:
            sink.write(dumps_play(play) + "\n")

    with pitch_path.open("w") as sink:
        for pitch in pitches:
            sink.write(dumps_play(pitch) + "\n")

    report(plays, bags, out_path, replay_duplicates)
    report_pitches(pitches, pitch_path, pitcher.replay_increments)
    if len(pointer_tables) == 1:
        print()
        print("  fielder object pointers never moved across the session")
    else:
        print()
        print(f"  WARNING: the fielder pointer table took "
              f"{len(pointer_tables)} distinct values during this session, so "
              "the objects ARE reallocated.")
        print("  Any frame whose pointers fall outside the captured region "
              "holds stale coordinates.")
        for table in sorted(pointer_tables):
            print("    " + " ".join(f"0x{value:08X}" for value in table))
    return 0


def classify_batted_ball(live_flags: list) -> tuple:
    """The fair/foul call, the home-run call, and a single readable class."""
    fair_values = [fair for fair, _ in live_flags if fair]
    home_values = [home for _, home in live_flags if home]
    fair_or_foul = fair_values[-1] if fair_values else None
    home_run = HOME_RUN_FLAG_FAIR in home_values
    if FOUL_FLAG in fair_values:
        label = "foul_home_run" if home_values else "foul"
    elif home_run and FAIR_CAUGHT_FLAG in fair_values:
        # The game called it a home run AND called it caught in the air. That
        # contradiction is the event: a ball robbed at the wall. It is named
        # rather than resolved, because picking one of the two flags silently
        # would either credit the batter with a home run he did not get or hide
        # the hardest catch in the game inside the ordinary fly-out bucket.
        #
        # UNCONFIRMED that the game raises the home-run flag on a rob at all --
        # the three off-the-ground catches in the first session never did. If it
        # does not, this class simply never fires and nothing is mislabelled.
        label = "home_run_robbed"
    elif home_run:
        label = "home_run"
    elif FAIR_CAUGHT_FLAG in fair_values:
        label = "fair_caught"
    elif fair_values:
        label = "fair_in_play"
    else:
        # No call was ever made inside the live window. Nothing downstream
        # should treat this as a fair ball just because it is not marked foul.
        label = "unknown"
    return fair_or_foul, home_run, label


def is_complete_third_out_catch(active: dict) -> bool:
    """Whether a stuck/end-of-capture play already recorded its final out."""
    situation = active.get("situation", {})
    live_flags = active.get("live_flags", [])
    return (
        int(situation.get("outs", -1)) == 2
        and any(fair == FAIR_CAUGHT_FLAG for fair, _ in live_flags)
    )


def final_bases_ran(frames: list, name: str,
                    over_fence_home_run: bool = False) -> int:
    """How far this slot got before the game recycled it.

    The offense actors are reused for the next batter, and the count is torn
    down a few frames either side of the dead ball -- so the last frame of the
    play is the wrong place to read it. Ice Garden play 20 has R3 reach 4 on
    frame 32035 and drop back to 3 on 32155, two frames past the dead ball and
    still inside the play window; the batter on the same session's inside-the-
    park homer climbs 0..4 and is then zeroed. Reading the last frame threw both
    away, and every other advance in the archive with them.

    Scoring on an over-the-fence homer clears the slot outright rather than
    counting it to 4 -- and does so BEFORE the ball goes dead. For that one
    outcome the game's HR call is stronger than the recycled actor byte: every
    occupied runner scored, so return home explicitly. Otherwise take the last
    value before the first teardown drop, ignoring frames where the slot holds
    no runner.
    """
    if over_fence_home_run:
        return 4
    best = 0
    previous = None
    for snapshot in frames:
        actor = snapshot["actors"][name]
        if actor["index"] < 0:
            continue
        value = actor["bases_ran"]
        if previous is not None and value < previous:
            break
        best = previous = value
    return best


def build_play(active: dict, bags: dict, fps: float, truncated: bool,
               park: str | None = None, is_night: bool | None = None) -> dict:
    frames = active["frames"]
    motion_frames = []
    seen_timers = set()
    for snapshot in active.get("pre_contact_frames", []) + frames:
        if snapshot["timer"] in seen_timers:
            continue
        seen_timers.add(snapshot["timer"])
        motion_frames.append(snapshot)
    contact_t = active["contact_t"]
    tracks = {}
    airborne = {}
    bobbles = {}
    forced_misplay_frames = {}
    buddy_handoff_frames = {}
    contact_counter_frames = {}
    fielding_action_frames = {}
    frozen_frames = {}
    frozen_onsets = {}
    freezing = set()
    sprayed_frames = {}
    sprayed_onsets = {}
    spraying = set()
    sprayed_night_frames = {}
    sprayed_night_onsets = {}
    spraying_night = set()
    impact_stun_frames = {}
    impact_stun_onsets = {}
    impact_stunning = set()
    burned_frames = {}
    burned_onsets = {}
    burning = set()
    knocked_frames = {}
    knocked_onsets = {}
    knocking = set()
    close_play_frames = {}
    close_play_onsets = {}
    contesting = set()
    attack_frames = {}
    attack_onsets = {}
    attacking = set()
    for snapshot in frames:
        for name, actor in snapshot["actors"].items():
            track = tracks.get(name)
            if track is None:
                track = tracks[name] = Track(
                    name, actor["character"], actor["index"],
                    actor.get("kind", "fielder"))
            track.add(snapshot["t"] - contact_t, actor["pos"],
                      actor.get("speed"), actor.get("max_speed"),
                      actor.get("character"))
            if actor["airborne"]:
                airborne[name] = airborne.get(name, 0) + 1
            # A freeze is one contiguous 120-frame run, but a fielder can be
            # caught twice in a play, so the onsets are a list rather than a
            # first-seen time. An onset is the transition into the flag, not
            # every frame it is up.
            #
            # EACH ONSET CARRIES ITS OWN LENGTH. It used to carry only its time,
            # and the record built below then gave every onset the fielder's
            # TOTAL frozen frames for the play, so a fielder caught twice was
            # published as two freezes of the summed duration. The operator read
            # a 4.0 s freeze at Peach Ice Garden and said it looked like two 2 s
            # freezes; it was, and 0x240 is up for exactly 120 frames, so a
            # single freeze cannot be 4 s in the first place.
            if actor.get("frozen"):
                if name not in freezing:
                    freezing.add(name)
                    # THE ABSOLUTE FRAME, beside the relative time. A freeze
                    # carried only `t` -- seconds since contact -- so nothing
                    # downstream could give it a stable identity the way every
                    # other effect has one, and a re-ingest had to reconstruct
                    # the frame by multiplying back through the frame rate. The
                    # timer is right here; recording it costs nothing.
                    frozen_onsets.setdefault(name, []).append(
                        [round(snapshot["t"] - contact_t, 4), 0, snapshot["timer"]])
                frozen_onsets[name][-1][1] += 1
                frozen_frames[name] = frozen_frames.get(name, 0) + 1
            else:
                freezing.discard(name)
            # DK Jungle's flower gas, counted exactly like a freeze: onsets
            # rather than every frame, because a fielder can be sprayed twice in
            # a play and the second one is a separate event.
            if actor.get("sprayed"):
                if name not in spraying:
                    spraying.add(name)
                    sprayed_onsets.setdefault(name, []).append(
                        [round(snapshot["t"] - contact_t, 4), 0, snapshot["timer"]])
                sprayed_onsets[name][-1][1] += 1
                sprayed_frames[name] = sprayed_frames.get(name, 0) + 1
            else:
                spraying.discard(name)
            # DK Jungle's flowers change effect bytes with the day/night park
            # variant. Keep this stream separate from +0x242: that byte still
            # identifies Peach's heart swing at night, while +0x2CA has four
            # night-DK onsets matching four labelled flower hits exactly.
            if actor.get("sprayed_night"):
                if name not in spraying_night:
                    spraying_night.add(name)
                    sprayed_night_onsets.setdefault(name, []).append(
                        [round(snapshot["t"] - contact_t, 4), 0, snapshot["timer"]])
                sprayed_night_onsets[name][-1][1] += 1
                sprayed_night_frames[name] = sprayed_night_frames.get(name, 0) + 1
            else:
                spraying_night.discard(name)
            # Burned by a fire star swing (+0x23E): Mario's fireball or Bowser's
            # breath. Recorded at every park; name_star_swing_effects says whose.
            if actor.get("burned"):
                if name not in burning:
                    burning.add(name)
                    burned_onsets.setdefault(name, []).append(
                        [round(snapshot["t"] - contact_t, 4), 0, snapshot["timer"]])
                burned_onsets[name][-1][1] += 1
                burned_frames[name] = burned_frames.get(name, 0) + 1
            else:
                burning.discard(name)
            # Generic impact stun. +0x243 is shared by a Daisy Cruiser table
            # collision and Bowser Jr.'s paint, so this loop records only the
            # measured state. Causal table attribution happens after the
            # captain-star flag for this play has been resolved.
            if actor.get("impact_stun"):
                if name not in impact_stunning:
                    impact_stunning.add(name)
                    impact_stun_onsets.setdefault(name, []).append(
                        [round(snapshot["t"] - contact_t, 4), 0,
                         snapshot["timer"], int(actor["impact_stun"])])
                impact_stun_onsets[name][-1][1] += 1
                impact_stun_frames[name] = impact_stun_frames.get(name, 0) + 1
            else:
                impact_stunning.discard(name)
            # Knocked down by a stadium hazard. Park-neutral on purpose: the
            # flag says a fielder was floored and never says by what, which is
            # the barrel here, the manhole at Wario City and a Chain Chomp at
            # Bowser Jr. Naming the cause is the caller's job when it can.
            if actor.get("knocked_down"):
                value = int(actor["knocked_down"])
                if name not in knocking:
                    knocking.add(name)
                    knocked_onsets.setdefault(name, []).append(
                        [round(snapshot["t"] - contact_t, 4), 0])
                    knocked_onsets.setdefault(name + "@frame", []).append(
                        snapshot["timer"])
                    # THE FLAG'S PHASES, carried in a parallel list so the two
                    # existing readers keep their two-element unpacking. The
                    # VALUE is what separates Bowser Castle's causes: a bomb
                    # runs 1 for exactly 40 frames and then 2, while five
                    # onsets there never reach 2 at all. See
                    # name_bomb_knockdowns.
                    knocked_onsets.setdefault(name + "@phases", []).append(
                        [[value, 0]])
                phases = knocked_onsets[name + "@phases"][-1]
                if phases[-1][0] == value:
                    phases[-1][1] += 1
                else:
                    phases.append([value, 1])
                knocked_onsets[name][-1][1] += 1
                knocked_frames[name] = knocked_frames.get(name, 0) + 1
            else:
                knocking.discard(name)
            # THE CLOSE PLAY, MSS's A/B contest at a base. Counted like the
            # states above -- onsets, not every frame -- but the VALUE is
            # carried too, because the value is the outcome: 1 is the fielder
            # holding on, 2 is the runner knocking the ball loose. See
            # close_play_flag in collect_player_tracking.py for the evidence.
            if actor.get("close_play"):
                if name not in contesting:
                    contesting.add(name)
                    close_play_onsets.setdefault(name, []).append(
                        [round(snapshot["t"] - contact_t, 4), 0,
                         int(actor["close_play"]), snapshot["timer"]])
                close_play_onsets[name][-1][1] += 1
                close_play_frames[name] = close_play_frames.get(name, 0) + 1
            else:
                contesting.discard(name)
            # THE BUDDY ATTACK, counted like the states above. Onsets rather
            # than frames, because a fielder can swing twice on one play and the
            # second swing is a separate event. Park-neutral: the flag says a
            # fielder swiped at something and never says at what, so naming the
            # Freezie is the caller's job -- see buddy_attack_flag in
            # collect_player_tracking.py.
            if actor.get("buddy_attack"):
                if name not in attacking:
                    attacking.add(name)
                    attack_onsets.setdefault(name, []).append(
                        [round(snapshot["t"] - contact_t, 4), 0,
                         snapshot["timer"], False])
                attack_onsets[name][-1][1] += 1
                # +0x267 is the successful-contact latch. Only sample it while
                # this attack is active: it remains up afterward, and must not
                # make a later missed swing inherit the earlier hit.
                if actor.get("buddy_attack_hit"):
                    attack_onsets[name][-1][3] = True
                attack_frames[name] = attack_frames.get(name, 0) + 1
            else:
                attacking.discard(name)
            action = actor["fielding_action"]
            if actor.get("contact_counter"):
                contact_counter_frames[name] = (
                    contact_counter_frames.get(name, 0) + 1)
            if action:
                counts = fielding_action_frames.setdefault(name, {})
                counts[action] = counts.get(action, 0) + 1
            if action in FIELDING_ACTION_MISPLAYS:
                bobbles[name] = bobbles.get(name, 0) + 1
            elif action == FIELDING_ACTION_YOSHI_EGG:
                forced_misplay_frames[name] = (
                    forced_misplay_frames.get(name, 0) + 1)
            elif action == FIELDING_ACTION_BUDDY_HANDOFF:
                buddy_handoff_frames[name] = buddy_handoff_frames.get(name, 0) + 1

    # A FREEZIE BREAK is the object's own active byte dropping 1 -> 0. The Peach
    # captures supply the missing control: every annotated break has this
    # transition, while the annotated near misses do not. Cause is attributed
    # later from the ball/throw/attack geometry; the disappearance itself must
    # be recorded before deciding what broke it.
    freezie_breaks = []
    previous_freezies = {}
    for snapshot in frames:
        for freezie in snapshot.get("freezies", []):
            slot = freezie["slot"]
            was_active = previous_freezies.get(slot)
            is_active = freezie["active"]
            if was_active is True and not is_active and freezie.get("pos"):
                at = tuple(freezie["pos"])
                ball = tuple(snapshot["ball"])
                freezie_breaks.append({
                    "slot": slot,
                    "t": round(snapshot["t"] - contact_t, 4),
                    "frame": snapshot["timer"],
                    "at": [round(value, 3) for value in at],
                    "ball_at": [round(value, 3) for value in ball],
                    "horizontal_distance_units": round(
                        math.dist(ball[::2], at[::2]), 3),
                    "distance_units": round(math.dist(ball, at), 3),
                    "active_before": True,
                    "active_after": False,
                })
            previous_freezies[slot] = is_active

    # First touch: the earliest frame in which the ball's own coordinates sit on
    # top of a fielder's. That coincidence is exact to the float when someone is
    # holding it, which makes it a far better signal than the game's
    # `ball_holder` byte -- that byte goes stale between plays and will name a
    # fielder while the ball is sitting on the mound.
    first_touch = None
    for snapshot in frames:
        name = locked_fielder(snapshot)
        if name is None:
            continue
        actor = snapshot["actors"][name]
        first_touch = {
            "t": round(snapshot["t"] - contact_t, 4),
            "frame": snapshot["timer"],
            "by": name,
            "character_id": actor["character"],
            "character": character_name(actor["character"]),
            "at": [round(v, 3) for v in actor["pos"]],
            # The BALL's height at the catch, which is the only height in the
            # capture that is real. The fielder's own reads 0 even mid-air, so
            # a wall climb or a leaping rob is visible here and nowhere else.
            "ball_height_units": round(snapshot["ball"][1], 3),
        }
        break

    # WHERE THE PLAY ACTUALLY ENDS. `ball_was_hit` stays set through the dead
    # ball, and the game then SNAPS every fielder back to their alignment spot.
    # Measuring through that reset is what made route efficiency read 0.000 --
    # start and end are literally the same coordinate, so displacement is zero
    # however far the fielder ran in between -- and let the reset glide count as
    # a 19.8 u/s sprint.
    #
    # The boundary is the game's own `game_state`, which leaves its live-ball
    # value two frames before the ball is teleported back to the mound. The
    # earlier version inferred it instead, from the first physically impossible
    # jump by any fielder, and that inference was wrong on 36 of 57 plays in the
    # first real session -- it ranged from 0.48s to 11.21s against a true live
    # window of 3.0s to 10.7s, because a pitcher's follow-through and an
    # outfielder's dive both snap far enough in one frame to look like a reset.
    # Cutting the play at 0.48s is what discarded most of the session's first
    # touches, and with them the throws and catch opportunities behind them.
    end_of_play = frames[-1]["t"] - contact_t
    live_end = (active["live_timer"] - active["contact_timer"]) / fps
    # Each actor is still windowed at ITS OWN reset if one somehow lands inside
    # the live window, so a single corrupt actor cannot contaminate its own
    # route without ending everyone else's play.
    tracks = {
        name: track.window(min(
            live_end,
            track.first_teleport_time()
            if track.first_teleport_time() is not None else end_of_play))
        for name, track in tracks.items()
    }
    # A fielder may be handed the ball by the game after the play is already
    # dead. That was the source of the real-session false touches found during
    # the audit. Possession later than the first defensive reset is not a
    # fielding event and cannot seed catch probability or a throw chain.
    if first_touch and first_touch["t"] > live_end + (1.0 / fps):
        first_touch = None

    fair_or_foul, home_run, batted_ball_class = classify_batted_ball(
        active["live_flags"])

    # Whether the ball was caught on the fly is the GAME's call, not an
    # inference from the height trace. On a low line drive the ball descends
    # below the landing threshold and stops there because it is in a glove, and
    # the detector cannot tell that from a short hop -- it read 22 of the
    # session's caught balls as having landed first. `fair_or_foul` reaching its
    # caught value says so directly, on the exact frame of the catch.
    caught_in_flight = batted_ball_class == "fair_caught"
    landing = (None if caught_in_flight
               else detect_landing(frames, contact_t, live_end, first_touch))
    # WHERE THE BALL WOULD HAVE FIRST TOUCHED DOWN, as the game itself worked it
    # out on the contact frame. See BALL_LANDING_PREDICTION in
    # player_tracking_io.py.
    #
    # This is not a second opinion on `landing`; across 61 batted balls the two
    # agree to a median 0.14u. It is the answer in the cases where `landing` is
    # not available or is short BY CONSTRUCTION -- a ball caught in flight never
    # lands, and a ball that clears the fence or strikes a wall stops where it
    # was interrupted rather than where it was going. Those are exactly the
    # plays carry has always been wrong on.
    projected_landing = None
    for snapshot in frames[:PROJECTED_LANDING_SEARCH_FRAMES]:
        point = snapshot.get("landing_prediction")
        if point is not None:
            projected_landing = {
                "at": [round(point[0], 3), round(point[2], 3)],
                "frame": snapshot["timer"],
                "distance_units": round(
                    math.dist((point[0], point[2]),
                              (frames[0]["ball"][0], frames[0]["ball"][2])), 3),
            }
            break
    # How each fielder went to the ball. This is a separate signal from the
    # action enum above: the enum says what happened to the ball once it was
    # reached, `catch_type` says whether the fielder had to dive or leap to
    # reach it, and a dive that never touches the ball sets only the latter.
    catch_approaches = detect_catch_approaches(frames, contact_t)
    buddy_jumps = detect_buddy_jumps(frames, contact_t, live_end)
    fielding_action_events = []
    for action_code in (*FIELDING_ACTION_MISPLAYS, FIELDING_ACTION_STAR_BALL,
                        FIELDING_ACTION_YOSHI_EGG,
                        FIELDING_ACTION_BUDDY_HANDOFF):
        fielding_action_events.extend(detect_fielding_action_events(
            frames, contact_t, live_end, first_touch, action_code))
    fielding_action_events.sort(key=lambda event: event["t"])
    for event in fielding_action_events:
        approach = approach_at(catch_approaches, event["by"], event["frame"])
        if approach is None:
            approach = approach_at(
                catch_approaches, event["by"], event["action_start_frame"])
        event.update(approach_fields(approach))
        if (event["action_code"] == 2
                and event["ball_contact"] == "unknown"
                and event["dive"]):
            event["ball_contact"] = "missed"
            event["confidence"] = "high"
            event["contact_source"] = "dive_action_without_contact_actor"

    # A BUDDY TOSS OPENS WITH THE MISPLAY ANIMATION. The enum sits at 2 while
    # the fielder reaches and flips to 7 on the frame he takes control of the
    # ball, and the contact actor is not written until that second frame -- so
    # the reach surfaced as its own attempt whose contact "could not be
    # determined", one frame before the toss confirmed it. It is ONE touch
    # described twice: all seven in the archive report the same trajectory turn
    # to three decimals as the handoff that follows, and in every one the two
    # animation windows are exactly contiguous. That is the guard -- same
    # fielder, action 2 ending on the frame a confirmed action 7 begins -- and
    # it leaves the eighth action-2 unknown, a 121-frame window with no toss
    # after it, quarantined where it belongs.
    #
    # None of the seven dove, so the dive rule above cannot reach them.
    lead_ins = set()
    for handoff in fielding_action_events:
        if (handoff["action_code"] != FIELDING_ACTION_BUDDY_HANDOFF
                or handoff["ball_contact"] != "confirmed"):
            continue
        for event in fielding_action_events:
            if (event["action_code"] in FIELDING_ACTION_MISPLAYS
                    and event["ball_contact"] == "unknown"
                    and event["by"] == handoff["by"]
                    and event["action_end_frame"] + 1
                        == handoff["action_start_frame"]):
                # Kept so the frame the fielder began reaching is not lost with
                # the phantom event; the toss's own window stays as measured.
                handoff["action_lead_in_frame"] = event["action_start_frame"]
                lead_ins.add(id(event))
    if lead_ins:
        fielding_action_events = [event for event in fielding_action_events
                                  if id(event) not in lead_ins]

    deflections = [event for event in fielding_action_events
                   if event["action_code"] in FIELDING_ACTION_MISPLAYS
                   and event["ball_contact"] == "confirmed"]
    forced_misplays = [event for event in fielding_action_events
                       if event["action_code"] in FIELDING_ACTION_FORCED
                       and event["ball_contact"] == "confirmed"]
    buddy_handoffs = [event for event in fielding_action_events
                      if event["action_code"] == FIELDING_ACTION_BUDDY_HANDOFF
                      and event["ball_contact"] == "confirmed"]

    # A BUDDY TOSS IS A SECURE AND A PASS. Action 7 takes control of the ball
    # and sends it to a teammate at a fixed speed on a new heading, so the
    # fielder who tossed it is the one who fielded the batted ball, and the
    # teammate who ends up holding it caught a toss. The possession lock only
    # sees the second half of that, which is why the console reported two
    # fielders "securing the ball after it landed" on every buddy toss and then
    # charged the ball to the wrong one.
    buddy_handoff_before_touch = next(
        (event for event in buddy_handoffs
         if first_touch is None or event["t"] < first_touch["t"]), None)
    if (buddy_handoff_before_touch and first_touch
            and buddy_handoff_before_touch["by"] == first_touch["by"]):
        buddy_handoff_before_touch = None

    # Possession is independently authoritative: the ball is both declared held
    # by the game and coordinate-locked to this actor. Add it as a secured event
    # even after an earlier boot, egg contact, or handoff so contact and outcome
    # remain separate facts rather than one overloaded label.
    fielding_events = list(fielding_action_events)
    if first_touch:
        touch_snapshot = next(
            (snapshot for snapshot in frames
             if snapshot["timer"] == first_touch["frame"]), None)
        touch_actor = (touch_snapshot["actors"].get(first_touch["by"])
                       if touch_snapshot else None)
        fielding_events.append({
            "event_type": "possession",
            "fielding_attempt": True,
            "ball_contact": "confirmed",
            "secured": True,
            "mechanic": ("buddy_receive" if buddy_handoff_before_touch
                         else "ordinary"),
            "received_from": (buddy_handoff_before_touch["by"]
                              if buddy_handoff_before_touch else None),
            "official_error": None,
            "confidence": "high",
            "contact_source": "possession_lock",
            **first_touch,
            "action_code": (touch_actor.get("fielding_action", 0)
                            if touch_actor else 0),
            # The byte clears on the frame the glove closes, so the window that
            # produced this catch is the one that ended just before it.
            **approach_fields(approach_at(
                catch_approaches, first_touch["by"], first_touch["frame"])),
        })
    fielding_events.sort(key=lambda event: event["t"])
    failed_contacts = sorted(
        [*deflections, *forced_misplays], key=lambda event: event["t"])
    for event in failed_contacts:
        # A low-ball turning point and a glove deflection can be stamped on the
        # same 60 Hz frame. That frame is the contact, not proof the ball had
        # already landed: Bowser Castle PA 12 (2026-09-05) was an airborne RF
        # boot whose apparent landing and confirmed contact were both frame
        # 12567. Calling equality "before" preserved a double that the fielder
        # never allowed to land instead of scoring the error.
        event["ball_landed_before_contact"] = bool(
            landing and landing["frame"] < event["frame"])
    deflected_by = {entry["by"] for entry in failed_contacts}
    forced_misplay_by = {entry["by"] for entry in forced_misplays}

    # Charge the original batted-ball opportunity to the fielder who actually
    # had to make it. First touch is only correct on a clean catch: after a boot
    # it names the eventual pickup (or the teammate who saved the error), which
    # gives the miss to the wrong player and can turn a baserunner out into a
    # successful catch. That case is already gone by the time we get here --
    # `failed_contacts` takes it -- so anyone left holding the first touch got
    # to the ball cleanly and is the fielder who made the play.
    #
    # WHERE A GROUND BALL LANDS IS NOT WHERE IT WAS FIELDED. A grounder touches
    # down a few units off the plate and then rolls out through the infield, so
    # "the fielder closest when it came down" names whoever happened to be
    # standing near the bounce -- the pitcher on a ball hit past him, the
    # catcher on a chopper or a bunt -- while the ball is already going by them.
    # On bowser_castle-20260828T182145Z this rule was used on 31 plays and
    # disagreed with the fielder who actually picked the ball up on 22 of them,
    # including the bunt Baby DK laid down: charged to the catcher, fielded by
    # the pitcher four units later. The tracker's own scoring notation for those
    # plays (G5-3 on the ball this charged to the pitcher) agrees with the touch,
    # not with the landing.
    #
    # So the landing only decides it when nobody ever touched the ball, which is
    # the case that rule was written for: a ball that falls in untouched, where
    # the fielder who had the chance is the one who was closest to where it came
    # down.
    primary_fielder = None
    primary_reason = None
    if failed_contacts:
        primary_fielder = failed_contacts[0]["by"]
        primary_reason = ("forced_misplay" if failed_contacts[0] in forced_misplays
                          else "failed_contact")
    elif buddy_handoff_before_touch:
        primary_fielder = buddy_handoff_before_touch["by"]
        primary_reason = "buddy_handoff"
    elif caught_in_flight and first_touch:
        primary_fielder = first_touch["by"]
        primary_reason = "catch"
    elif first_touch:
        primary_fielder = first_touch["by"]
        primary_reason = "fielded"
    elif landing and batted_ball_class == "fair_in_play":
        landing_snapshot = next(
            (snapshot for snapshot in frames
             if snapshot["timer"] == landing["frame"]), None)
        if landing_snapshot:
            bx, _, bz = landing_snapshot["ball"]
            candidates = []
            for name, actor in landing_snapshot["actors"].items():
                if actor["kind"] != "fielder":
                    continue
                px, _, pz = actor["pos"]
                candidates.append((math.dist((px, pz), (bx, bz)), name))
            if candidates:
                primary_fielder = min(candidates)[1]
                primary_reason = "closest_at_landing"
    # Hang time is time to the ball's own first contact with anything: the glove
    # if it was caught, the ground if it was not. A fielder who was never going
    # to reach it still had exactly this long to try.
    hang_time = first_touch["t"] if caught_in_flight and first_touch else (
        landing["t"] if landing else None)

    # Where the ball had to be reached: the glove if it was caught on the fly,
    # otherwise the spot it came down on.
    opportunity_target = None
    if caught_in_flight and first_touch:
        opportunity_target = tuple(first_touch["at"])
    elif landing:
        opportunity_target = tuple(landing["at"])

    home = tuple(frames[0]["ball"]) if frames else None
    # The state scalars name fielders by their index in the capture's actor
    # table, which is the order they were added to each snapshot.
    order = [name for name, actor in frames[0]["actors"].items()
             if actor["kind"] == "fielder"]
    throws = detect_throws(frames, contact_t, live_end, bags, order, home)
    possession_carries = detect_possession_carries(frames, contact_t, live_end)
    name_carry_impulses(possession_carries, first_touch, throws, knocked_onsets)
    barrel_events = detect_barrel_events(frames, contact_t, live_end,
                                        knockdowns=knocked_onsets, park=park)
    frozen_fielder_ball_contacts = detect_frozen_fielder_ball_contacts(
        frames, contact_t, live_end, order)

    freezes = []
    gas_stuns = []
    gas_stuns_night = []
    knockdowns = []
    impact_stuns = []
    burns = []
    close_plays = []
    buddy_attacks = []
    fielders = {}
    for name, track in tracks.items():
        if frames[0]["actors"][name]["kind"] != "fielder":
            continue
        entry = summarise_track(track, frozen_frames=frozen_frames.get(name, 0))
        entry["airborne_frames"] = airborne.get(name, 0)
        entry["frozen_frames"] = frozen_frames.get(name, 0)
        entry["frozen_seconds"] = round(frozen_frames.get(name, 0) / fps, 4)
        entry["frozen_at_s"] = [t for t, _, _ in frozen_onsets.get(name, [])] or None
        for onset, run_frames, at_frame in frozen_onsets.get(name, []):
            freezes.append({
                "by": name,
                "character_id": track.character,
                "character": character_name(track.character),
                "t": onset,
                "frame": at_frame,
                "frames": run_frames,
                "seconds": round(run_frames / fps, 4),
            })
        entry["buddy_attack_frames"] = attack_frames.get(name, 0)
        entry["buddy_attack_at_s"] = [t for t, _, _, _ in attack_onsets.get(name, [])] or None
        for onset, run_frames, timer, hit in attack_onsets.get(name, []):
            buddy_attacks.append({
                "by": name,
                "character_id": track.character,
                "character": character_name(track.character),
                "t": onset,
                "frames": run_frames,
                "seconds": round(run_frames / fps, 4),
                "timer": timer,
                "hit": hit,
                # Filled from an object disappearance below. The attack latch
                # alone says contact, not what it contacted.
                "clears_freezie": False,
            })
        entry["sprayed_frames"] = sprayed_frames.get(name, 0)
        entry["sprayed_seconds"] = round(sprayed_frames.get(name, 0) / fps, 4)
        entry["sprayed_at_s"] = [t for t, _, _ in sprayed_onsets.get(name, [])] or None
        # THE MEASUREMENT IS ALWAYS KEPT -- sprayed_frames/seconds/at_s above are
        # written for every park. Only the NAME is gated, once the star swing is
        # known: +0x242 is DK Jungle's flower gas and also Peach's heart swing
        # at any park, so calling Daisy's runs "flower gas" would invent a
        # hazard that park does not have.
        for onset, run_frames, at_frame in sprayed_onsets.get(name, []):
            gas_stuns.append({
                "by": name,
                "character_id": track.character,
                "character": character_name(track.character),
                "t": onset,
                "frame": at_frame,
                "frames": run_frames,
                "seconds": round(run_frames / fps, 4),
            })
        entry["sprayed_night_frames"] = sprayed_night_frames.get(name, 0)
        entry["sprayed_night_seconds"] = round(
            sprayed_night_frames.get(name, 0) / fps, 4)
        entry["sprayed_night_at_s"] = [
            t for t, _, _ in sprayed_night_onsets.get(name, [])] or None
        for onset, run_frames, at_frame in sprayed_night_onsets.get(name, []):
            gas_stuns_night.append({
                "by": name,
                "character_id": track.character,
                "character": character_name(track.character),
                "t": onset,
                "frame": at_frame,
                "frames": run_frames,
                "seconds": round(run_frames / fps, 4),
                "source_byte": "+0x2CA",
            })
        entry["burned_frames"] = burned_frames.get(name, 0)
        entry["burned_seconds"] = round(burned_frames.get(name, 0) / fps, 4)
        entry["burned_at_s"] = [t for t, _, _ in burned_onsets.get(name, [])] or None
        for onset, run_frames, at_frame in burned_onsets.get(name, []):
            burns.append({
                "by": name,
                "character_id": track.character,
                "character": character_name(track.character),
                "t": onset,
                "frame": at_frame,
                "frames": run_frames,
                "seconds": round(run_frames / fps, 4),
            })
        entry["impact_stun_frames"] = impact_stun_frames.get(name, 0)
        entry["impact_stun_seconds"] = round(
            impact_stun_frames.get(name, 0) / fps, 4)
        entry["impact_stun_at_s"] = [
            t for t, _, _, _ in impact_stun_onsets.get(name, [])] or None
        for onset, run_frames, at_frame, flag_value in impact_stun_onsets.get(name, []):
            onset_snapshot = next(
                (snapshot for snapshot in frames
                 if snapshot["timer"] == at_frame), None)
            actor_at = (onset_snapshot["actors"].get(name)
                        if onset_snapshot else None)
            impact_stuns.append({
                "by": name,
                "character_id": track.character,
                "character": character_name(track.character),
                "t": onset,
                "frame": at_frame,
                "frames": run_frames,
                "seconds": round(run_frames / fps, 4),
                "flag_value": flag_value,
                "at": ([round(value, 3) for value in actor_at["pos"]]
                       if actor_at else None),
            })
        entry["knocked_down_frames"] = knocked_frames.get(name, 0)
        entry["knocked_down_seconds"] = round(knocked_frames.get(name, 0) / fps, 4)
        entry["knocked_down_at_s"] = [t for t, _ in knocked_onsets.get(name, [])] or None
        phase_runs = knocked_onsets.get(name + "@phases", [])
        for index, ((onset, run_frames), at_frame) in enumerate(zip(
                knocked_onsets.get(name, []),
                knocked_onsets.get(name + "@frame", []))):
            phases = phase_runs[index] if index < len(phase_runs) else None
            knockdowns.append({
                "by": name,
                "character_id": track.character,
                "character": character_name(track.character),
                "t": onset,
                "frame": at_frame,
                "frames": run_frames,
                "seconds": round(run_frames / fps, 4),
                # How long the flag held each value, in order. Kept for every
                # park: the shape is what names a Bowser Castle bomb, and it is
                # the only thing that separates the five onsets there that no
                # annotation covers.
                "phases": ([[value, count] for value, count in phases]
                           if phases else None),
            })
        entry["close_play_frames"] = close_play_frames.get(name, 0)
        entry["close_play_at_s"] = [
            t for t, _, _, _ in close_play_onsets.get(name, [])] or None
        for onset, run_frames, value, at_frame in close_play_onsets.get(name, []):
            close_plays.append({
                "by": name,
                "character_id": track.character,
                "character": character_name(track.character),
                "t": onset,
                "frame": at_frame,
                "frames": run_frames,
                "seconds": round(run_frames / fps, 4),
                "flag_value": value,
                # The two values seen, four onsets each, separated by the
                # game's own outs counter rather than by anything inferred
                # here. A third value has never been observed and would stay
                # unnamed rather than be guessed at.
                "won_by": {1: "fielder", 2: "runner"}.get(value),
            })
        approaches = [w for w in catch_approaches if w["by"] == name]
        entry["dove"] = any(w["dive"] for w in approaches)
        entry["leaped"] = any(w["leap"] for w in approaches)
        entry["dive_frames"] = sum(w.get("frames", 0)
                                   for w in approaches if w["dive"])
        entry["catch_type_frames"] = {
            str(code): sum(w.get("frames", 0) for w in approaches
                           if w["catch_type"] == code)
            for code in sorted({w["catch_type"] for w in approaches})
        }
        entry["bobble_frames"] = bobbles.get(name, 0)
        entry["forced_misplay_frames"] = forced_misplay_frames.get(name, 0)
        entry["buddy_handoff_frames"] = buddy_handoff_frames.get(name, 0)
        entry["fielding_contact_counter_frames"] = contact_counter_frames.get(name, 0)
        entry["fielding_action_frames"] = {
            str(code): count
            for code, count in sorted(fielding_action_frames.get(name, {}).items())
        }
        release_timer = active.get("pitch_release_timer")
        release_snapshot = next(
            (snapshot for snapshot in motion_frames
             if release_timer is not None
             and snapshot["timer"] >= release_timer
             and name in snapshot["actors"]),
            None,
        )
        if release_snapshot:
            entry["pitch_release_start"] = [
                round(value, 3)
                for value in release_snapshot["actors"][name]["pos"]
            ]
        if first_touch and track.points:
            entry["distance_to_touch_units"] = round(
                math.dist(track.points[0][::2], tuple(first_touch["at"])[::2]), 3)
            entry["opportunity_s"] = first_touch["t"]
            entry["fielded"] = name == first_touch["by"]
        if track.points and opportunity_target:
            # The catch-probability pair, and the reason it is measured against
            # the landing point rather than against first touch: on a ball that
            # falls in, first touch is where somebody picked it up after the
            # bounce. Scoring a fly ball's catch point against a base hit's
            # pickup point makes the two look like the same chance, which is
            # exactly what the first session's numbers did -- the required
            # closing speed came out at 4.41 u/s for balls caught and 4.37 for
            # balls that dropped, and every difficulty band converted at 52%.
            entry["distance_to_landing_units"] = round(
                math.dist(track.points[0][::2], opportunity_target[::2]), 3)
            entry["hang_time_s"] = hang_time
            # Reached the ball and did not hold it. Distinct from never having
            # got there, which is what an unqualified miss looks like.
            entry["deflected"] = name in deflected_by
            entry["forced_misplay"] = name in forced_misplay_by
            jump = jump_measurement(
                motion_frames, name, first_touch,
                release_timer, fps)
            if jump:
                entry.update(jump)
        fielders[name] = entry

    attribute_freezie_breaks(freezie_breaks, frames, buddy_attacks, throws)
    freezie_ball_rebounds = detect_freezie_ball_rebounds(
        frames, contact_t, live_end, freezie_breaks)
    arrow_redirects = detect_arrow_redirects(
        frames, contact_t, live_end, fps, park, is_night)
    table_ball_contacts = detect_table_ball_contacts(
        frames, contact_t, live_end, park, is_night, fielding_events,
        first_touch)
    table_breaks = detect_table_breaks(
        frames, contact_t, park, is_night, buddy_attacks, throws)
    manhole_spots = (wario_manhole_spots(frames[0].get("props") if frames else None)
                     if park == "wario_city" else [])
    manhole_ball_strikes = detect_manhole_ball_strikes(
        frames, contact_t, live_end, fps, park, manhole_spots)

    name_manhole_knockdowns(
        knockdowns, frames, park,
        wario_manhole_spots(frames[0].get("props") if frames else None)
        if park == "wario_city" else [])

    star_swing = detect_star_swing(motion_frames, active["contact_timer"])
    name_star_swing_knockdowns(knockdowns, star_swing, barrel_events, motion_frames)
    # The transit supplies the Piranha's measured ball path. Attribute its
    # synchronized knockdown before the wall-band train fallback gets a chance
    # to claim the same generic flag.
    pipe_transits = detect_pipe_transits(frames, contact_t, live_end, park, is_night,
                                         buddy_handoffs)
    name_piranha_knockdowns(knockdowns, frames, pipe_transits, park)
    name_train_knockdowns(knockdowns, frames, park, is_night)
    name_close_play_runners(close_plays, frames)
    name_star_swing_breaks(table_breaks, star_swing)
    name_star_swing_breaks(freezie_breaks, star_swing)
    star_swing_effects = name_star_swing_effects(star_swing, {
        "impact_stun": impact_stuns, "sprayed": gas_stuns, "burned": burns})
    # A Peach heart at DK Jungle writes the flower-gas byte; it is hers, not
    # the flower's.
    claimed = {(effect["by"], effect["frame"]) for effect in star_swing_effects}
    # Bowser Castle's statue fire and falling lava, both on the burned byte, and
    # King Bob-omb's bombs, named from the knockdown flag's phases.
    fire_hazards = name_bowser_castle_burns(burns, frames, park, claimed)
    name_bomb_knockdowns(knockdowns, park)
    flower_candidates = gas_stuns_night if is_night is True else gas_stuns
    flower_sprays = [
        {**{key: value for key, value in stun.items() if key != "frame"},
         "source_byte": stun.get("source_byte", "+0x242")}
        for stun in flower_candidates
        if park == "dk_jungle" and (stun["by"], stun["frame"]) not in claimed
    ]
    # DK Jungle night statue POW. The value-1 effect has exactly three onsets
    # in the labelled game, all 91 frames long and all matching the three
    # operator-confirmed POW stuns. The three visible no-hit activations remain
    # absent because no fielder effect byte rises for them.
    dk_pow_stuns = [
        {**stun, "hazard": "dk_pow"}
        for stun in impact_stuns
        if park == "dk_jungle" and is_night is True
        and stun.get("flag_value") == 1
        and (stun["by"], stun["frame"]) not in claimed
    ]
    # Daytime Daisy Cruiser has one stadium object class: tables. The raw stun
    # flag is also raised by Bowser Jr.'s paint, and the star-swing flag names
    # that competing cause. A non-star onset at this park is therefore a table
    # collision; its actor position is the observed table location until a
    # captured transform supplies the centre.
    table_stuns = [
        {**stun, "location_source": "stunned_fielder_at_contact"}
        for stun in impact_stuns
        if park == "daisy_cruiser" and is_night is False and star_swing is None
    ]
    # Yoshi Park: a ball through a pipe, and a fielder stunned by running into one.
    pipe_stuns = name_pipe_stuns(impact_stuns, claimed, catch_approaches, park)
    # A floored fielder's dropped ball is not a throw -- and at Yoshi Park the
    # train that floored them can hit it next.
    name_knocked_loose_throws(throws, knockdowns)
    train_ball_hits = detect_train_ball_hits(
        frames, contact_t, live_end, fps, park, is_night, fielding_events, throws,
        knockdowns)
    train_ball_captures = detect_train_ball_captures(
        frames, contact_t, live_end, fps, park, is_night)
    # The one-frame jolt on the way into the train is the swallow seen from
    # outside. Reporting both says the train hit the ball and then, separately,
    # took it.
    train_ball_hits = [
        hit for hit in train_ball_hits
        if not any(0 <= ride["frame"] - hit["frame"] <= 2
                   for ride in train_ball_captures)]

    ball_path = measure_ball_path(frames, contact_t, live_end, first_touch,
                                  possession_carries)
    preoutcome_flight = measure_preoutcome_flight(frames, active["contact_timer"])

    rebound_catch = None
    if (caught_in_flight and failed_contacts and first_touch
            and first_touch["by"] not in deflected_by):
        deflection = failed_contacts[0]
        deflection_snapshot = next(
            (snapshot for snapshot in frames
             if snapshot["timer"] == deflection["frame"]), None)
        saver = first_touch["by"]
        if deflection_snapshot and saver in deflection_snapshot["actors"]:
            start = deflection_snapshot["actors"][saver]["pos"]
            end = tuple(first_touch["at"])
            rebound_catch = {
                "deflected_by": deflection["by"],
                "saved_by": saver,
                "start_frame": deflection["frame"],
                "catch_frame": first_touch["frame"],
                "opportunity_s": round(first_touch["t"] - deflection["t"], 4),
                "distance_needed_units": round(
                    math.dist(start[::2], end[::2]), 3),
                "start_at": [round(value, 3) for value in start],
                "catch_at": list(first_touch["at"]),
            }

    runners = {}
    for name, track in tracks.items():
        if frames[0]["actors"][name]["kind"] != "offense":
            continue
        occupied = [s["actors"][name]["index"] >= 0 for s in frames]
        if not any(occupied):
            continue
        entry = summarise_track(track)
        entry["bases_ran"] = final_bases_ran(
            frames, name,
            over_fence_home_run=batted_ball_class == "home_run")
        entry["stealing"] = max(s["actors"][name]["stealing"] for s in frames)
        # Lead off the bag at contact, measured against the bag this slot owns.
        bag = bags.get(name)
        if bag and track.points:
            entry["lead_at_contact_units"] = round(
                math.dist(track.points[0][::2], bag[::2]), 3)
        entry["five_foot_splits_s"] = cumulative_distance_splits(track)
        runners[name] = entry

    # WHERE EVERY RUNNER WAS WHEN THE BALL WAS FIRST SECURED. The CPU decides
    # every send and hold, and this is the moment it has to decide against: how
    # far the runner still has to go when a fielder has the ball. Matched on the
    # batting index rather than the slot, because an advancing runner can move
    # between slots mid-play.
    touch_snapshot = (
        next((s for s in frames if s["timer"] == first_touch["frame"]), None)
        if first_touch is not None else None)
    if touch_snapshot is not None:
        for name, entry in runners.items():
            index = frames[0]["actors"][name]["index"]
            if index < 0:
                continue
            actor = next(
                (candidate for candidate in touch_snapshot["actors"].values()
                 if candidate["kind"] == "offense" and candidate["index"] == index),
                None)
            if actor is not None:
                entry["at_first_possession"] = [round(value, 3) for value in actor["pos"]]

    # Home to first, for the batter-runner. The first-base bag is whatever the
    # empty R1 slot measured, so this is right in any park.
    home_to_first = None
    ninety_foot_split = None
    bag = bags.get("R1")
    if bag and "BAT" in tracks:
        track = tracks["BAT"]
        # Time of CLOSEST APPROACH, not of first entering a radius around the
        # bag. A fixed radius is a fixed head start: at 8 u/s a 1.5u trigger
        # reports every runner 0.19s faster than they were, and the whole range
        # between the fastest and slowest character is smaller than that.
        best = None
        for t, point in zip(track.times, track.points):
            distance = math.dist(point[::2], bag[::2])
            if best is None or distance < best[0]:
                best = (distance, t)
        # If the closest approach is the LAST sample, the runner was still
        # closing when the window ended and the "time to first" is really the
        # time the recording stopped watching. Three plays reported an
        # identical 5.639s that way.
        still_running = bool(track.times) and best is not None and             best[1] >= track.times[-1] - 1e-9
        if best and best[0] <= BAG_RADIUS_UNITS and not still_running:
            home_to_first = round(best[1], 4)
            actual_distance_feet = (math.dist(track.points[0][::2], bag[::2]) * 3.280839895
                                    if track.points else None)
            if actual_distance_feet and actual_distance_feet > 0:
                ninety_foot_split = round(home_to_first * 90.0 / actual_distance_feet, 4)

    situation = active["situation"]
    # HOW THE BATTER OFFERED AT IT, measured rather than inferred from how hard
    # the ball left. `situation` is the state at the frame the swing flag rose,
    # and the game freezes the swing animation on contact, so the counter that
    # is running there is the animation that produced this batted ball. Exactly
    # one of the two was non-zero at all 96 contacts of the session this was
    # read from. A bunt therefore no longer has to be guessed from exit
    # velocity, which cannot tell a bunt from a swing that was simply mishit.
    swing_frames = situation.get("swing_frames")
    bunt_frames = situation.get("bunt_frames")
    contact_type = None
    if bunt_frames:
        contact_type = "bunt"
    elif swing_frames:
        contact_type = "swing"

    # The game can replay the entire batted-ball sequence from home plate while
    # keeping `game_state == live` and raising `ball_was_hit` again. That defeats
    # both launch gates. The replay is byte-for-byte deterministic in the ball
    # trace for as long as it runs -- it may be cut early, after which the ball
    # parks at its reset position -- so retain a short internal signature for the
    # post-pass below, which compares only the leading samples. It is removed
    # before JSON is written.
    signature_step = max(1, round(fps * REPLAY_SIGNATURE_STEP_SECONDS))
    signature_limit = min(len(frames),
                          round(fps * REPLAY_SIGNATURE_SECONDS) + 1)
    trajectory_signature = tuple(
        tuple(round(value, 3) for value in frames[index]["ball"])
        for index in range(0, signature_limit, signature_step)
    )

    # HOW EACH APPROACH ENDED. The fielding events already carry the approach
    # they belong to; this is the same join read the other way, so that a dive
    # can be counted as an attempt whether or not it produced an event. An
    # approach with no event at all did not touch the ball -- that is the miss,
    # and it is the half of the sample that bounds the reach from above.
    for window in catch_approaches:
        matched = [
            event for event in fielding_events
            if event.get("by") == window["by"]
            and event.get("approach_start_frame") == window["start_frame"]
        ]
        secured = any(event.get("secured") for event in matched)
        touched = any(event.get("ball_contact") == "confirmed"
                      for event in matched)
        source = "fielding_event"
        if window["catch_type"] == CATCH_TYPE_THROW and not matched:
            # `fielding_events` covers the batted ball only, so a receiver's
            # catch is not one. The throw record is where that lives, and the
            # arrival frame is what identifies it.
            arrived = [
                throw for throw in throws
                if throw.get("receiver_position") == window["by"]
                and throw.get("arrival_frame") is not None
                and window["start_frame"] <= throw["arrival_frame"]
                <= window["end_frame"] + CATCH_TYPE_ATTRIBUTION_FRAMES
            ]
            if arrived:
                secured = touched = True
            source = "throw"
        window["secured"] = secured
        window["touched"] = touched
        window["outcome"] = ("secured" if secured
                             else "touched" if touched
                             else "missed" if matched else "no_contact")
        window["outcome_source"] = source
        window["mechanics"] = sorted({
            event.get("mechanic") for event in matched if event.get("mechanic")
        }) or None

    return {
        "contact_timer": active["contact_timer"],
        "swing_timer": active.get("swing_timer"),
        "pitch_release_timer": active.get("pitch_release_timer"),
        "inning": situation["inning"],
        "inning_half": situation["inning_half"],
        "outs": situation["outs"],
        "balls": situation["balls"],
        "strikes": situation["strikes"],
        "batter_id": situation["batter_id"],
        "batter": character_name(situation["batter_id"]),
        "batter_index": situation["batter_index"],
        "duration_s": round(frames[-1]["t"] - contact_t, 4),
        "live_s": round(live_end, 4),
        "dead_ball_timer": round(active["contact_timer"] + live_end * fps),
        "swing_to_launch_s": active.get("swing_to_launch_s"),
        "contact_type": contact_type,
        "bunt": contact_type == "bunt" if contact_type else None,
        "swing_frames": swing_frames,
        "bunt_frames": bunt_frames,
        "truncated": truncated,
        "fair_or_foul": fair_or_foul,
        "home_run": home_run,
        "batted_ball_class": batted_ball_class,
        "contact_at": [round(v, 3) for v in frames[0]["ball"]],
        "landing": landing,
        "projected_landing": projected_landing,
        "deflections": deflections,
        "forced_misplays": forced_misplays,
        "buddy_handoffs": buddy_handoffs,
        # Two fielders boosting one over the wall. This leaves no action window
        # and no possession, so without it a ball they went up for reads as a
        # ball nobody played.
        "buddy_jumps": buddy_jumps,
        # Every fielder the game froze during this play, in the order they
        # were caught. A freeze is measured, not inferred: see `frozen_flag` in
        # collect_player_tracking.py. What froze them is NOT recorded, because
        # the object that did it is not in the captured region -- this says a
        # fielder was held, not what held him.
        "freezes": freezes,
        # Every buddy attack a fielder made on this play. The animation and
        # successful-contact latch stay separate; `clears_freezie` requires the
        # Freezie's own disappearance on that attack, not the latch alone.
        "buddy_attacks": buddy_attacks,
        # Object-confirmed disappearances with their separately measured cause:
        # batted ball, thrown ball, buddy attack, or unknown.
        "freezie_breaks": freezie_breaks,
        # Close ball contact plus a large trajectory turn, with the object's
        # active byte proving that it survived the collision.
        "freezie_ball_rebounds": freezie_ball_rebounds,
        # A large measured trajectory turn at close range while the fielder's
        # independently discovered freeze flag is active.
        "frozen_fielder_ball_contacts": frozen_fielder_ball_contacts,
        # WARIO CITY ONLY. Frames where an arrow rewrote the ball's horizontal
        # velocity: the imposed speed, the bearing it snapped to, the bearing it
        # arrived on, and -- when this session captured the objects -- which
        # arrow it was. Empty at every other park by construction.
        "arrow_redirects": arrow_redirects,
        # DAISY CRUISER DAY ONLY. The collision supplies an observed table
        # location even in older captures that did not include the object
        # allocation. A future prop-enabled capture may also name its transform.
        "table_ball_contacts": table_ball_contacts,
        "table_breaks": table_breaks,
        "impact_stuns": impact_stuns,
        "table_stuns": table_stuns,
        # YOSHI PARK ONLY. A ball that went into one pipe and came out of
        # another, with both pipes named; and a fielder stunned by running or
        # diving into one. See YOSHI_PIPES.
        "pipe_transits": pipe_transits,
        "pipe_stuns": pipe_stuns,
        # DK JUNGLE NIGHT ONLY. A fielder hit by the centre-field statue POW.
        "dk_pow_stuns": dk_pow_stuns,
        # BOWSER CASTLE ONLY. The centre-field statue's fire and the falling
        # lava, separated by the fielder's measured distance to the statue's
        # surveyed front. Empty at every other park, where every burn in the
        # archive belongs to a captain's star swing.
        "fire_hazards": fire_hazards,
        # YOSHI PARK ONLY. A sharp horizontal turn of a loose ball inside the
        # outfield wall, away from the ground, wall and every measured glove.
        "train_ball_hits": train_ball_hits,
        # YOSHI PARK ONLY. The ball went INTO the train: its position became the
        # train's own and the game's home-run flag rose on that frame. See
        # detect_train_ball_captures.
        "train_ball_captures": train_ball_captures,
        # THE CONSEQUENCE, stated where a consumer will trip over it. A redirect
        # means the ball's resting place is NOT on the path it was hit along, so
        # anything that draws a line from the landing to where the ball was
        # fielded is drawing a journey that did not happen, and any route charged
        # against the resting place overstates the chase. See
        # `distance_to_landing_units` and the field view.
        "path_redirected_by_stadium": bool(arrow_redirects or table_ball_contacts
                                           or pipe_transits or train_ball_hits
                                           or train_ball_captures),
        # THE MEASURED PATH, for anything that draws the play. Sampled ball
        # positions from contact to the first glove -- see measure_ball_path.
        # This is the only field that describes a home run's flight or a ball
        # that left play: both have a null `landing` and a null `first_touch`.
        "ball_path": ball_path,
        # Contact through contact+11 frames, fitted exactly as the catch model's
        # features were. Scores the no-gimmick catch chance of a redirected ball.
        "preoutcome_flight": preoutcome_flight,
        "flower_sprays": flower_sprays,
        # `hazard` names what floored them only where something MEASURED says so:
        # a Wario City manhole (name_manhole_knockdowns) or a captain's star
        # swing at any park (name_star_swing_knockdowns). Anything else stays
        # unnamed -- the flag says somebody went down, not why.
        "knockdowns": knockdowns,
        # The captain star swing on this play from the game's own flag: which
        # captain, and the frames it was up. Null on an ordinary swing.
        "star_swing": star_swing,
        # Fielders that swing disabled without flooring: Bowser Jr.'s paint,
        # Peach's heart, Mario's fireball, Bowser's fire breath. Named only when
        # the byte that fired is the one this captain's effect writes.
        "star_swing_effects": star_swing_effects,
        # The ball bouncing off an erupting manhole, above the ground. This is
        # also why `landing` can be null on such a play: the ball never reached
        # the ground to land on.
        "manhole_ball_strikes": manhole_ball_strikes,
        "manholes_surveyed": [list(spot) for spot in manhole_spots] or None,
        "close_plays": close_plays,
        # Every dive and leap on the play, including the ones that never
        # reached the ball -- those produce no fielding event at all, and they
        # are exactly the range plays worth seeing.
        "catch_approaches": catch_approaches,
        "dives": [w for w in catch_approaches if w["dive"]],
        "fielding_events": fielding_events,
        "primary_fielder": primary_fielder,
        "primary_fielder_reason": primary_reason,
        # The catch that follows a deflection is a rebound, and the chance it
        # represents was created by the boot rather than by the batted ball.
        "after_deflection": rebound_catch is not None,
        "rebound_catch": rebound_catch,
        "hang_time_s": hang_time,
        "caught_in_flight": caught_in_flight,
        "first_touch": first_touch,
        "throws": throws,
        "possession_carries": possession_carries,
        "barrel_events": barrel_events,
        "home_to_first_s": home_to_first,
        "ninety_foot_split_s": ninety_foot_split,
        "fielders": fielders,
        "runners": runners,
        # The bags this capture measured (empty runner slots sit on them) and
        # home as the contact point, in world x/z -- what a runner's or a
        # fielder's distance to a base is measured against.
        "bases": {
            base: [round(bag[0], 3), round(bag[2], 3)]
            for base, bag in (("first", bags.get("R1")), ("second", bags.get("R2")),
                              ("third", bags.get("R3")), ("home", home))
            if bag is not None
        },
        "_trajectory_signature": trajectory_signature,
    }


# How much of a replay has to agree with the original before it is treated as a
# copy. The game does not always run a replay to completion: the Ice Garden
# ninth-inning copy was identical for 1.42s and was then cut, parking the ball
# at its reset position. Comparing the whole signature window therefore misses
# short replays, so only the leading samples are required to agree. Five
# samples is 1.0s of flight matching to the millimetre, which no two distinct
# batted balls in any captured session have ever done. A Wario City close-play
# replay ended its live phase at 0.734s, however, leaving only three comparable
# samples before the ball reset. That shorter form is accepted only when the
# contact, landing, swing lead and pitch lead also repeat exactly.
REPLAY_SIGNATURE_SECONDS = 2.5
REPLAY_SIGNATURE_STEP_SECONDS = 0.25
REPLAY_MIN_MATCHING_SAMPLES = 5
REPLAY_SHORT_MIN_MATCHING_SAMPLES = 3
REPLAY_SHORT_LIVE_SECONDS = 1.0
REPLAY_WINDOW_SECONDS = 20.0


def matching_prefix(left: tuple, right: tuple) -> int:
    """How many leading trajectory samples two plays agree on exactly."""
    count = 0
    for a, b in zip(left, right):
        if a != b:
            break
        count += 1
    return count


def replay_fingerprint(play: dict):
    """Exact event landmarks that distinguish a cut-short replay from a hit."""
    contact = play.get("contact_at")
    timer = play.get("contact_timer")
    swing = play.get("swing_timer")
    pitch = play.get("pitch_release_timer")
    if (not isinstance(contact, (list, tuple))
            or timer is None or swing is None or pitch is None):
        return None
    # NO LANDING IN HERE. It used to be, and that made the fingerprint None for
    # exactly the records this branch exists to catch: a copy cut off before the
    # ball comes down never has one, so the short branch could never fire.
    #
    # AND THE LEADS ARE MEASURED SWING-TO-PITCH, NOT FROM CONTACT. Contact-
    # relative leads agree on 19 of the archive's 22 original/copy pairs and
    # disagree on all three whose original is a HOME RUN: the home-run replay
    # re-raises the hit flag exactly 90 frames off its own swing, so the copy
    # reads a 1-frame swing lead where the original read 91. The interval
    # BETWEEN the swing and the pitch is untouched by that shift and matches on
    # all 22, as does the contact point to the millimetre. Two real swings share
    # neither.
    return (tuple(contact), swing - pitch)


def replay_trajectories_match(previous_trajectory: tuple, trajectory: tuple,
                              previous_fingerprint, fingerprint,
                              live_seconds) -> bool:
    """Whether this is a full replay trace or an exactly identified short one."""
    prefix = matching_prefix(previous_trajectory, trajectory)
    if prefix >= REPLAY_MIN_MATCHING_SAMPLES:
        return True
    try:
        live = float(live_seconds)
    except (TypeError, ValueError):
        return False
    if not 0 <= live < REPLAY_SHORT_LIVE_SECONDS:
        return False
    # ASK THE COPY FOR WHAT IT COULD HAVE, NOT FOR THREE. The signature samples
    # every 0.25 s, so a replay the game cut off after five frames -- a third of
    # one interval -- can only ever supply the contact sample; everything after
    # it is the ball parked at its reset position, which agrees with nothing.
    # Demanding three samples of that record demands evidence that cannot exist,
    # and one such copy reached the Mario Stadium feed as a 112th play. A copy
    # long enough for three still has to produce three.
    available = 1 + int(live / REPLAY_SIGNATURE_STEP_SECONDS)
    return (
        prefix >= min(REPLAY_SHORT_MIN_MATCHING_SAMPLES, available)
        and fingerprint is not None
        and fingerprint == previous_fingerprint
    )


def remove_replay_duplicates(plays: list, fps: float) -> tuple[list, int]:
    """Remove immediate copies of fair balls replayed by the game.

    A real fair ball ends the plate appearance, so the same lineup slot cannot
    produce a second fair ball with the same count and trajectory seconds later.
    Daisy Cruiser contained seven such copies; Bowser Castle contained one.
    Foul balls are intentionally not deduplicated because the same batter can
    legitimately hit several with an unchanged two-strike count.
    """
    kept = []
    seen = {}
    removed = 0
    fair_classes = {"fair_in_play", "fair_caught", "home_run",
                    "home_run_robbed"}
    comparable_classes = fair_classes | {"unknown"}
    window = round(fps * REPLAY_WINDOW_SECONDS)
    for play in plays:
        trajectory = tuple(tuple(point)
                           for point in play.pop("_trajectory_signature", ()))
        play_class = play.get("batted_ball_class")
        if play_class not in comparable_classes or not trajectory:
            kept.append(play)
            continue
        # The situation is the cheap half of the key; the trajectory is compared
        # separately because a replay only has to agree on its opening, not for
        # the whole signature window. See matching_prefix below.
        key = (
            play.get("inning"), play.get("inning_half"), play.get("outs"),
            play.get("balls"), play.get("strikes"), play.get("batter_id"),
            play.get("batter_index"),
        )
        timer = play.get("contact_timer")
        duplicate = False
        if timer is not None:
            fingerprint = replay_fingerprint(play)
            for (previous_timer, previous_class, previous_trajectory,
                 previous_fingerprint) in seen.get(key, ()):
                # An unknown record is useful evidence when it stands alone, but
                # it is not strong enough to suppress a later called fair ball.
                # The observed replay failure is the opposite order: a fully
                # labelled real play, followed seconds later by the same opening
                # trajectory with no live call.
                if previous_class not in fair_classes:
                    continue
                if not 0 <= timer - previous_timer <= window:
                    continue
                if replay_trajectories_match(
                        previous_trajectory, trajectory,
                        previous_fingerprint, fingerprint, play.get("live_s")):
                    duplicate = True
                    break
        if duplicate:
            removed += 1
            continue
        if timer is not None and play_class in fair_classes:
            seen.setdefault(key, []).append(
                (timer, play_class, trajectory, replay_fingerprint(play)))
        kept.append(play)
    return kept, removed


def report_pitches(pitches: list, out_path: Path, replay_increments: int) -> None:
    """What the pitch stream saw, in the terms it is meant to be checked in."""
    print()
    print(f"wrote {len(pitches)} pitches to {out_path}")
    if not pitches:
        return
    offers = Counter(pitch["offer"] for pitch in pitches)
    outcomes = Counter(pitch["outcome"] for pitch in pitches)
    print("  offer:   " + "  ".join(f"{name} {count}"
                                    for name, count in offers.most_common()))
    print("  outcome: " + "  ".join(f"{name} {count}"
                                    for name, count in outcomes.most_common()))
    takes = [pitch for pitch in pitches if pitch["offer"] == "take"]
    balls = [pitch for pitch in takes if pitch["outcome"] == "ball"]
    squared = [pitch for pitch in pitches
               if pitch["bunt_shown"] and pitch["offer"] != "bunt"]
    # THE CHECK THAT MATTERS. A ball cannot be thrown on a swing, so every
    # pitch the game called a ball has to come back as a take. If this line
    # ever reads less than all of them, the swing counters are being misread.
    called_balls = [pitch for pitch in pitches if pitch["outcome"] == "ball"]
    print(f"  {len(balls)}/{len(called_balls)} called balls were taken"
          + ("" if len(balls) == len(called_balls)
             else "   <-- a ball cannot be thrown on a swing; this must be all of them"))
    if squared:
        print(f"  {len(squared)} squared to bunt and pulled the bat back before "
              "the ball arrived; those are takes, not bunts")
    unresolved = [pitch for pitch in pitches if pitch["outcome"] == "unknown"]
    if unresolved:
        print(f"  {len(unresolved)} pitches never resolved and are labelled unknown")
    if replay_increments:
        print(f"  {replay_increments} pitch-counter increments were rejected as "
              "home-run replays")


def report(plays: list, bags: dict, out_path: Path,
           replay_duplicates: int = 0) -> None:
    print(f"\n{len(plays)} plays -> {out_path}")
    if replay_duplicates:
        print(f"  discarded {replay_duplicates} immediate replay copies")
    if not plays:
        print("\nNo batted balls in this session. `ball_was_hit` never went 0->1,\n"
              "so either nothing was put in play or the session is all dead time.")
        return
    if bags:
        print("\nmeasured bag coordinates (ball frame)")
        for name in ("R1", "R2", "R3"):
            if name in bags:
                x, y, z = bags[name]
                print(f"  {name}  ({x:7.2f}, {y:5.2f}, {z:7.2f})")

    reactions, routes, sprints, home_to_first_times, arm_speeds = [], [], [], [], []
    for play in plays:
        for entry in play["fielders"].values():
            if entry.get("reaction_s") is not None:
                reactions.append(entry["reaction_s"])
            if entry.get("route_efficiency") is not None:
                routes.append(entry["route_efficiency"])
            if entry["sprint_speed_ups"] > 1.0:
                sprints.append(entry["sprint_speed_ups"])
        if play["home_to_first_s"]:
            home_to_first_times.append(play["home_to_first_s"])
        arm_speeds.extend(
            throw["peak_speed_mph"] for throw in play.get("throws", [])
            if throw.get("is_throw") is not False
            and throw.get("peak_speed_mph") is not None)

    def line(label, values, unit, lower_is_better=False):
        if not values:
            print(f"  {label:<22} no samples")
            return
        best = min(values) if lower_is_better else max(values)
        print(f"  {label:<22} n={len(values):<4} "
              f"median {statistics.median(values):6.3f} {unit:<5} "
              f"best {best:6.3f}")

    print("\nacross the session")
    line("fielder reaction", reactions, "s", lower_is_better=True)
    line("route efficiency", routes, "")
    line("fielder sprint speed", sprints, "u/s")
    line("home to first time", home_to_first_times, "s", lower_is_better=True)
    line("throw velocity", arm_speeds, "mph")

    classes = Counter(play["batted_ball_class"] for play in plays)
    print()
    print("batted balls by the game's own fair/foul and home-run calls")
    for label in ("fair_in_play", "fair_caught", "home_run", "home_run_robbed",
                  "foul", "foul_home_run", "unknown"):
        if classes.get(label):
            print(f"  {label:<16} {classes[label]:>3}")

    freezes = [freeze for play in plays for freeze in play.get("freezes", [])]
    if freezes:
        held = sum(freeze["seconds"] for freeze in freezes)
        print()
        print(f"  {len(freezes)} fielders were frozen and could not move, "
              f"{held:.1f}s in total. A freeze is not a slow route or a slow")
        print("  reaction, so neither number is published for those "
              "fielder-plays.")

    contests = [event for play in plays
                for event in play.get("close_plays", [])]
    if contests:
        won = sum(1 for event in contests if event["won_by"] == "runner")
        print()
        print(f"  {len(contests)} close plays, {won} won by the runner. A close "
              "play the runner wins knocks the ball")
        print("  out of the fielder's hands, which is the contest and not a "
              "fielding mistake.")

    glides = [entry["assist_units"]
              for play in plays for entry in play["fielders"].values()
              if entry.get("assist_units")]
    if glides:
        print()
        print(f"  {len(glides)} fielder-plays were glided toward the ball by "
              f"the game, {sum(glides):.0f}u in total. That is covered ground,")
        print("  but it is not the character running, so it is excluded from "
              "speed.")

    buddies = [throw for play in plays for throw in play.get("throws", [])
               if throw.get("is_throw") is not False and throw.get("buddy_throw")]
    if buddies:
        held = statistics.median(throw["buddy_freeze_s"] for throw in buddies)
        print()
        print(f"  {len(buddies)} throws were Buddy Throws, {held:.2f}s of frozen "
              "cutscene before launch.")
        partners = Counter(f"{throw['thrower_position']}+{throw['buddy_partner_position']}"
                           for throw in buddies)
        print("  pairs: "
              + ", ".join(f"{pair} x{n}" for pair, n in partners.most_common()))

    aimed = [throw for play in plays for throw in play.get("throws", [])
             if throw.get("is_throw") is not False
             and throw.get("intended_target_position")
             and throw["intended_target_position"] != throw["receiver_position"]]
    if aimed:
        print()
        print(f"  {len(aimed)} throws were caught by someone other than the "
              "fielder they were aimed at, which is the")
        print("  covering middle infielder rather than an error. Both are kept.")

    robbed = [play for play in plays
              if play["first_touch"]
              and play["first_touch"]["ball_height_units"] > 2.5]
    if robbed:
        print()
        print(f"  {len(robbed)} catches were made off the ground, the ball "
              f"{min(p['first_touch']['ball_height_units'] for p in robbed):.0f}u to "
              f"{max(p['first_touch']['ball_height_units'] for p in robbed):.0f}u up.")
        print("  A fielder's own height always reads 0, so this is the only "
              "signal that a catch left the ground.")

    handoffs = [play for play in plays if play["buddy_handoffs"]]
    if handoffs:
        print()
        print(f"  {len(handoffs)} plays used an intentional buddy toss. The "
              "secure-and-pass is tracked separately and is not a fielding error.")

    deflected = [play for play in plays if play["deflections"]]
    if deflected:
        rebounds = sum(1 for play in deflected if play["after_deflection"])
        print()
        print(f"  {len(deflected)} plays had a fielder get a hand to the ball "
              f"without holding it; {rebounds} were then caught by someone else.")
        print("  Those are reached-and-dropped, not out of range, and the "
              "rebound catch was created by the boot.")

    forced = [play for play in plays if play["forced_misplays"]]
    if forced:
        eggs = sum(1 for play in forced for event in play["forced_misplays"]
                   if event["action_code"] == FIELDING_ACTION_YOSHI_EGG)
        fireballs = sum(1 for play in forced for event in play["forced_misplays"]
                        if event["action_code"] == FIELDING_ACTION_STAR_BALL)
        print()
        print(f"  {len(forced)} plays had a batter's star ball force the first "
              f"contact to be bobbled ({eggs} Yoshi egg, "
              f"{fireballs} fireball).")
        print("  They are retained as star-swing events and excluded from "
              "ordinary error/OAA training.")

    jumps = [play for play in plays if play["buddy_jumps"]]
    if jumps:
        print()
        print(f"  {len(jumps)} plays had a fielder go up for a Buddy Jump.")
        print("  It leaves no action window and no possession, so without this "
              "the ball reads as one nobody played.")

    resolved = sum(1 for p in plays if p["first_touch"])
    print(f"\n  {resolved}/{len(plays)} plays had a fielder take possession")
    truncated = sum(1 for p in plays if p["truncated"])
    if truncated:
        print(f"  {truncated} plays hit the {MAX_PLAY_SECONDS:.0f}s cap and are "
              "marked truncated")


if __name__ == "__main__":
    sys.exit(main())
