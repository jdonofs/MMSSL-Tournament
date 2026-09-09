import { TRACKER_POSITION_NUMBERS, parseTrackerLineupMessage, parseTrackerRunnerMessage } from './tracker_alignment.mjs'
import {
  applyTrackerBattedBallToBuffer,
  applyTrackerFieldedBallToBuffer,
  attachTrackerTrajectory,
  classifyPitchMovement,
  applyMeasuredPitchOffers,
  measuredPitchMatchesPa,
  trackerContactWasBunt,
  isTrackerRobbedHomeRun,
  normalizeTrackerExitVelocity,
  parseTrackerBattedBallMessage,
  parseTrackerFieldedBallMessage,
  parseTrackerHitByPitchMessage,
  parseTrackerPitchProvisionalMessage,
  parseTrackerPutoutMessage,
  TRACKER_MEASURED_DISTANCE_SOURCES,
  shouldChargeTrackerBobbleError,
  trackerPlayThrowingError,
  trackerBobbleErrorVeto,
  trackerPlayFieldingPosition,
  trackerPlayOutChainPositions,
  markTrackerStarSwing,
  normalizeRbiForPaResult,
  trackerRbiForPaResult,
  shouldClassifyTrackerFielderChoice,
  shouldClassifyTrackerSacrificeBunt,
  shouldReclassifyTrackerFlyOutAsSacFly,
  shouldDowngradeTrackerHitToRoe,
  TRACKER_BALL_SAMPLE_MARKER,
  TRACKER_PITCH_PROVISIONAL_MARKER,
  TrackerBallSampleBuffer,
  parseTrackerBallSampleMessage,
  trackerBattedBallPaFields,
  trackerBattedBallPlotGeometry,
  trackerBattedBallShouldRevealOccludedLanding,
  trackerProjectedCarryFromObservedImpact,
  trackerCaughtBallResult,
  trackerFieldedBallPaFields,
} from './tracker_play_events.mjs'
import {
  projectTrackerBattedBallDistanceFeet,
  projectTrackerFieldSpot,
  TRACKER_STADIUM_FIELD_GEOMETRY,
} from './tracker_field_projection.mjs'
import {
  applyPlayerTrackingPitch,
  applyPlayerTrackingPlay,
  applyPostgamePlay,
  compactPlaySummary,
  createPlayerTrackingState,
  joinTally,
  outcomePlayFor,
  playGeometry,
  playsForAtBat,
  rejoinPlays,
  setCaptureHealth,
} from './tracker_preview_plays.mjs'
import { buildTrackerNarrative } from './tracker_narrative.mjs'
import { buildPreviewAdvancedMetrics } from './tracker_preview_metrics.mjs'
import { runnerAdvancedOnPlay, runnerDestinationsFromPlay } from './tracker_runner_telemetry.mjs'
import { summarizeAtBatChecks, validateTrackerAtBat } from './tracker_validation.mjs'
import { getStadiumKeyByName, getStadiumNameByKey } from '../src/utils/stadiums.js'
import { assembleErrorNotation } from '../src/utils/notation.js'

export { classifyPitchMovement, parseTrackerPitchProvisionalMessage }

// The tracker only names a stadium when it prints a "A vs. B @ Stadium" line,
// which does not happen in every session, and without a stadium key there is
// no field geometry and therefore no field location at all. The preview lets
// one be chosen by hand so field placement can be checked deliberately rather
// than only when the tracker volunteers the name.
export const TRACKER_PREVIEW_STADIUM_OPTIONS = Object.keys(TRACKER_STADIUM_FIELD_GEOMETRY)
  .map((key) => ({ key, name: getStadiumNameByKey(key) || key }))

function resolveStadiumKey(state) {
  return state.stadiumOverrideKey ?? state.stadiumDetectedKey ?? null
}

export function setTrackerPreviewStadiumOverride(state, stadiumKey) {
  const normalized = stadiumKey ? String(stadiumKey) : null
  if (normalized && !Object.hasOwn(TRACKER_STADIUM_FIELD_GEOMETRY, normalized)) return false
  state.stadiumOverrideKey = normalized
  state.stadiumKey = resolveStadiumKey(state)
  // Retained session data was serialized under whatever stadium was active when
  // each at-bat completed, so its projected field spot was frozen then. Without
  // re-deriving every one of them the selector would appear to do nothing for
  // the at-bat actually on screen, which is the one being checked.
  for (const buffer of state.completedBuffers) {
    retainSessionAtBat(state, serializePaWithProjection(state, buffer, buffer.exactRunnerAssignments))
  }
  if (state.latestCompletedBuffer) {
    state.latestCompleted = serializePaWithProjection(
      state, state.latestCompletedBuffer, state.latestCompletedBuffer.exactRunnerAssignments,
    )
  }
  state.revision += 1
  return true
}

// The collector reads the game's stadium-menu byte directly. Feed that value
// back into the preview so geometry and capture labelling agree without asking
// the operator to unblock collection with a dropdown.
export function setTrackerPreviewDetectedStadium(state, stadiumKey) {
  const normalized = stadiumKey ? String(stadiumKey) : null
  if (normalized && !Object.hasOwn(TRACKER_STADIUM_FIELD_GEOMETRY, normalized)) return false
  state.stadiumDetectedKey = normalized
  state.stadiumKey = resolveStadiumKey(state)
  if (normalized) state.stadiumName = getStadiumNameByKey(normalized) || state.stadiumName
  state.revision += 1
  return true
}

// Where the ball's distance came from decides how much the plotted spot can be
// trusted, and the three sources are not interchangeable: a tracked landing is
// observed, the tracker's last-frame extrapolation is derived from this shot's
// own trajectory, and the exit-velocity/launch-angle physics estimate assumes
// real-world gravity this game does not necessarily use. Preview-only — these
// keys are deliberately not added to trackerBattedBallPaFields, whose output is
// spread straight into Supabase writes by the production bridge.
function buildPreviewProjection(state, record, serialized) {
  if (!record) return null
  const stadiumKey = state.stadiumKey
  const projectedImpactCarry = (serialized?.result === 'HR' || serialized?.result === 'IPHR')
    ? trackerProjectedCarryFromObservedImpact(record)
    : null
  const physics = projectTrackerBattedBallDistanceFeet(
    normalizeTrackerExitVelocity(record.exitVelocityMph, record.recordFeetPerUnit),
    record.launchAngleDeg,
  )
  const geometry = trackerBattedBallPlotGeometry(record, serialized?.hit_distance_ft)
  const distanceSource = projectedImpactCarry ? 'trajectory_projected_carry_from_collision'
    : geometry?.source === 'endpoint_coordinates' ? 'tracked_endpoint'
    : geometry?.source === 'trajectory_collision' ? 'tracked_collision'
      : geometry?.source === 'trajectory_projection' ? 'trajectory_projection'
      : geometry?.source === 'projected_coordinates' ? 'tracker_last_frame_extrapolation'
        : geometry?.source === 'launch_spray_angle'
          && (record.distanceFeet == null || record.recordFeetPerUnit == null)
          && physics ? 'physics_from_exit_velocity'
          : geometry?.source === 'launch_spray_angle' ? 'tracker_scaled_distance'
            : 'none'

  const physicsSpot = physics && stadiumKey
    ? projectTrackerFieldSpot(physics.distanceFeet, record.sprayAngleDeg, stadiumKey)
    : null
  const plottedX = serialized?.hit_x ?? null
  const plottedY = serialized?.hit_y ?? null

  return {
    stadium_key: stadiumKey,
    // Derived from `distance_source` rather than from the plot geometry, so the
    // two can never disagree. They used to: a home run whose distance is the
    // carry projected on past the wall or object it struck kept the underlying
    // geometry's `trajectory_collision` source here and was published as a
    // measurement, while `distance_source` correctly said the number was
    // projected.
    is_projected: !TRACKER_MEASURED_DISTANCE_SOURCES.has(distanceSource),
    distance_source: distanceSource,
    // Which geometry actually placed the marker. 'launch_spray_angle' is the
    // weakest of the three: it assumes the ball kept the direction it left the
    // bat on, which curving balls do not.
    plot_source: geometry?.source ?? null,
    plot_angle_deg: geometry ? Math.round(geometry.angleDeg * 10) / 10 : null,
    spray_angle_deg: record.sprayAngleDeg ?? null,
    plotted_distance_ft: serialized?.hit_distance_ft ?? null,
    impact_distance_ft: projectedImpactCarry?.impactDistanceFeet != null
      ? Math.round(projectedImpactCarry.impactDistanceFeet * 10) / 10
      : null,
    impact_height_ft: projectedImpactCarry?.impactHeightFeet != null
      ? Math.round(projectedImpactCarry.impactHeightFeet * 10) / 10
      : null,
    plotted_x: plottedX,
    plotted_y: plottedY,
    physics_distance_ft: physics?.distanceFeet ?? null,
    physics_hang_time_sec: physics?.hangTimeSec ?? null,
    physics_x: physicsSpot?.x ?? null,
    physics_y: physicsSpot?.y ?? null,
    // Only meaningful when the plotted spot is a real observation: it is the
    // gap between what was measured and what the physics model would have
    // guessed, which is the calibration signal for the model itself.
    physics_vs_plotted_distance_ft: physics
      && (geometry?.source === 'endpoint_coordinates' || geometry?.source === 'trajectory_collision')
      && serialized?.hit_distance_ft != null
      ? Math.round((physics.distanceFeet - serialized.hit_distance_ft) * 10) / 10
      : null,
  }
}

const OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])
const PITCH_PROVISIONAL_PREFIX = TRACKER_PITCH_PROVISIONAL_MARKER

function freshPa(state, pitcherName, batterName) {
  state.localPaNumber += 1
  return {
    localPaNumber: state.localPaNumber,
    pitcherName,
    // Every pitcher this plate appearance faced, in order. One name on all but
    // the plate appearances a relief pitcher entered in the middle of, and the
    // reason a pitch measured for the pitcher who was replaced is not a
    // contradiction on the at-bat that names their replacement.
    pitcherNames: [pitcherName],
    batterName,
    inning: state.inning,
    isTop: state.isTop,
    outsBeforePa: state.outs,
    countSeen: false,
    lastCount: { balls: 0, strikes: 0 },
    pendingPitchType: null,
    pendingStarPitch: false,
    pendingStarSwing: false,
    pendingPitchTelemetry: [],
    pendingDoublePlay: false,
    pendingTriplePlay: false,
    contactRecorded: false,
    pitches: [],
    result: null,
    rbi: 0,
    runEvents: [],
    runnersBefore: { first: null, second: null, third: null },
    starHitUsed: false,
    battedBallTrajectory: null,
    advancedBattedBall: null,
    advancedFielding: null,
    observedPutouts: [],
    assistFielderNames: [],
    putoutFielderName: null,
    bobbleFielderName: null,
    isBuddyJump: false,
    buddyJumpFielderName: null,
    messages: [],
  }
}

function emptyRunnerState() {
  return { first: null, second: null, third: null }
}

function sameRunnerName(left, right) {
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return Boolean(left && right && normalize(left) === normalize(right))
}

function applyRunnerStateDelta(state, { characterName, base }) {
  for (const occupiedBase of ['first', 'second', 'third']) {
    if (sameRunnerName(state.runnersInHalf[occupiedBase], characterName)) {
      state.runnersInHalf[occupiedBase] = null
    }
  }
  state.runnersInHalf[base] = characterName
}

function removeRunnerFromState(state, characterName) {
  for (const base of ['first', 'second', 'third']) {
    if (sameRunnerName(state.runnersInHalf[base], characterName)) state.runnersInHalf[base] = null
  }
}

function finalizeCurrentPa(state) {
  if (!state.current || !paHasActivity(state.current)) return
  state.latestCompletedBuffer = state.current
  state.completedBuffers.push(state.current)
  state.latestCompleted = serializePaWithProjection(state, state.current)
  retainSessionAtBat(state, state.latestCompleted)
  state.revision += 1
}

// Close the final buffer when an input stream itself ends. Ordinarily the next
// matchup closes a plate appearance, but an archive (and an interrupted live
// session) has no next line. Keeping that last PA marked current makes a replay
// look permanently in progress even though capture health already says stopped.
export function finalizeTrackerPreviewSession(state) {
  if (!state.current || !paHasActivity(state.current)) return false
  finalizeCurrentPa(state)
  state.current = null
  return true
}

function startPa(state, pitcherName, batterName) {
  finalizeCurrentPa(state)
  state.current = freshPa(state, pitcherName, batterName)
  state.current.runnersBefore = { ...state.runnersInHalf, ...Object.fromEntries(
    Object.entries(state.pendingRunners).filter(([, runner]) => runner),
  ) }
  state.pendingRunners = emptyRunnerState()
  return state.current
}

function knownDiagnosticName(value) {
  return value && value !== 'unknown' ? value : null
}

// Some game states omit the stock "pitcher vs. batter" banner entirely. The
// structured pitch/contact diagnostics still name both actors, so once the
// previous PA has a terminal result they can safely recover the missing PA.
function recoverMissingMatchup(state, record) {
  const pa = state.current
  if (!pa?.result || !record) return pa
  const pitcherName = knownDiagnosticName(record.pitcherName)
  const batterName = knownDiagnosticName(record.batterName)
  if (!pitcherName || !batterName) return pa
  if (pitcherName === pa.pitcherName && batterName === pa.batterName) return pa
  return startPa(state, pitcherName, batterName)
}

function pushPitch(state, pa, type, before = pa.lastCount, after = pa.lastCount) {
  state.gamePitchNumber += 1
  const telemetry = pa.pendingPitchTelemetry.shift() || null
  pa.pitches.push({
    pitch_number_pa: pa.pitches.length + 1,
    pitch_number_game: state.gamePitchNumber,
    result: type,
    pitch_type: telemetry?.pitchType ?? null,
    pitch_speed_mph: telemetry?.speedMph ?? null,
    pitch_telemetry: telemetry,
    is_star_pitch: Boolean(pa.pendingStarPitch || telemetry?.isStarPitch),
    is_star_swing: Boolean(pa.pendingStarSwing),
    count_balls_before: before.balls,
    count_strikes_before: before.strikes,
    count_balls_after: after.balls,
    count_strikes_after: after.strikes,
  })
  pa.pendingStarPitch = false
  pa.pendingStarSwing = false
}

function applyPitchTelemetry(pa, telemetry) {
  if (!telemetry) return false
  if (telemetry.pitcherName && telemetry.pitcherName !== 'unknown' && telemetry.pitcherName !== pa.pitcherName) return false
  if (telemetry.batterName && telemetry.batterName !== 'unknown' && telemetry.batterName !== pa.batterName) return false
  const lastPitch = pa.pitches.at(-1)
  if (
    lastPitch
    && !lastPitch.pitch_telemetry
    && telemetry.pitchCounter === lastPitch.pitch_number_pa
  ) {
    lastPitch.pitch_telemetry = telemetry
    lastPitch.pitch_speed_mph = telemetry.speedMph
    lastPitch.pitch_type = telemetry.pitchType
    lastPitch.is_star_pitch = Boolean(lastPitch.is_star_pitch || telemetry.isStarPitch)
  } else {
    pa.pendingPitchTelemetry.push(telemetry)
  }
  return true
}

function ensureContactPitch(state, pa) {
  if (pa.contactRecorded) return
  pushPitch(state, pa, 'in_play')
  pa.contactRecorded = true
}

// THE GAME CAN CALL ONE CONTACT BOTH WAYS. The tracker reads fair_or_foul the
// instant the bat meets the ball and announces "Fair ball!"; a ball struck near
// the line flips a beat later and the tracker announces "Foul ball!" for the
// SAME contact, with the landing and batted-ball records it already emitted
// still stamped fair. Everything the first call produced therefore describes a
// ball that went out of play.
//
// Leaving it behind cost Baby DK's fourth-inning strikeout on 2026-08-31 a
// phantom fourth pitch at 0-0 -> 0-0, shifted every later pitch's telemetry by
// one (two "telemetry disagrees with the count" warnings), and hung a 67-foot
// batted ball on a plate appearance scored K -- which is exactly the
// "contact recorded on a plate appearance with no ball in play" error.
//
// Only ever retracts a pitch pushed by ensureContactPitch and not yet closed
// out by a count: it carries the same count on both sides and no result has
// landed, which no real pitch record does.
function retractPrematureFairBall(state, pa) {
  if (!pa.contactRecorded || pa.result) return
  const last = pa.pitches.at(-1)
  if (!last || last.result !== 'in_play') return
  if (last.count_balls_before !== last.count_balls_after
    || last.count_strikes_before !== last.count_strikes_after) return
  pa.pitches.pop()
  state.gamePitchNumber -= 1
  // The measurement belongs to the foul this pitch actually was, so it goes
  // back in the queue for the record the count change is about to push.
  if (last.pitch_telemetry) pa.pendingPitchTelemetry.unshift(last.pitch_telemetry)
  pa.pendingStarSwing = pa.pendingStarSwing || Boolean(last.is_star_swing)
  pa.pendingStarPitch = pa.pendingStarPitch
    || Boolean(last.is_star_pitch && !last.pitch_telemetry?.isStarPitch)
  pa.contactRecorded = false
  pa.advancedBattedBall = null
  pa.battedBallTrajectory = null
}

function ensureStrikeoutPitch(state, pa) {
  if (pa.pendingPitchType !== 'strike') return
  const telemetry = pa.pendingPitchTelemetry[0] || null
  const after = telemetry?.countAfter || {
    balls: pa.lastCount.balls,
    strikes: pa.lastCount.strikes + 1,
  }
  pushPitch(state, pa, 'strike_unknown', pa.lastCount, after)
  pa.pendingPitchType = null
  pa.lastCount = after
}

function applyPendingMultiOut(pa) {
  if (!['GO', 'FO', 'LO'].includes(pa.result)) return
  if (pa.pendingTriplePlay) { pa.result = 'TP'; pa.resultInferredFromPutout = false }
  else if (pa.pendingDoublePlay) { pa.result = 'DP'; pa.resultInferredFromPutout = false }
}

// The 60 Hz play joined to this buffer, or null.
//
// Reads the joins that are already in the tracking state rather than
// recomputing them, because the at-bat list a rejoin needs is built from
// serialized at-bats -- rejoining from inside serialization would be circular.
// The snapshot rejoins before it serializes anything, so by the time a record
// reaches the console or an annotation the join is current; the earlier
// serialization at plate-appearance completion simply sees no play yet and
// leaves every play-dependent decision at what the tracker log alone said.
function outcomePlayForBuffer(state, pa) {
  const paNumber = pa?.localPaNumber
  if (paNumber == null || !state?.playerTracking?.joins?.size) return null
  const outcome = outcomePlayFor(state.playerTracking, paNumber)
  return outcome.join?.status === 'joined' ? outcome.play : null
}

/**
 * The measured pitches belonging to one plate-appearance buffer.
 *
 * The capture does not number plate appearances -- it has no idea the tracker
 * log exists -- so its pitches are grouped the only way the capture itself
 * distinguishes them: consecutive pitches sharing an inning, a half and a
 * batter are one plate appearance. The Nth such group with a given inning /
 * half / batter is the Nth buffer with the same, which is what keeps a batter
 * who comes up twice in one inning from collecting both his plate appearances'
 * pitches.
 */
function measuredPitchesForBuffer(state, pa) {
  const all = state?.playerTracking?.pitches
  if (!all?.length || !pa) return []
  const groups = []
  for (const record of all) {
    const last = groups.at(-1)
    if (last && measuredPitchMatchesPa(record, {
      inning: last[0].inning,
      isTop: Number(last[0].inning_half) === 0,
      batterName: last[0].batter,
    })) {
      last.push(record)
    } else {
      groups.push([record])
    }
  }
  const matches = groups.filter((group) => measuredPitchMatchesPa(group[0], {
    inning: pa.inning, isTop: pa.isTop, batterName: pa.batterName,
  }))
  if (!matches.length) return []
  const buffers = [...state.completedBuffers, ...(state.current ? [state.current] : [])]
    .filter((buffer) => Number(buffer.inning) === Number(pa.inning)
      && Boolean(buffer.isTop) === Boolean(pa.isTop)
      && buffer.batterName === pa.batterName)
  const ordinal = Math.max(0, buffers.indexOf(pa))
  return matches[ordinal] || []
}

// The play's own reading of where this fielder stood wins over the announced
// alignment, which a mid-game pitching change leaves stale. See
// trackerPlayFieldingPosition.
function fieldingPosition(state, fielderName, pitcherName, play = null) {
  const fromPlay = trackerPlayFieldingPosition(play, fielderName)
  if (fromPlay) return TRACKER_POSITION_NUMBERS[fromPlay] ?? null
  for (const alignment of Object.values(state.alignments)) {
    if (!alignment.batting.includes(pitcherName)) continue
    const position = Object.entries(alignment.fielding).find(([, name]) => name === fielderName)?.[0]
    if (position) return TRACKER_POSITION_NUMBERS[position] ?? null
  }
  return null
}

// Names for the fielders the 60 Hz capture could not identify.
//
// Miis are not in the game's character table, so the capture reports every one
// of them as `char 78` and the console fell back to "the first baseman" -- a
// position where every other fielder on the field gets a name. The tracker
// log's [TRACKER_LINEUP] line already names them the way the game does
// ("Orange Mii (M)"), so the name is in this at-bat already, just on the other
// feed.
//
// Only the unnamed positions are filled in, and only with a name the capture
// has not already used elsewhere on this play, so an alignment left stale by a
// mid-game position change can never rename a fielder the capture identified
// for itself.
function unnamedFielderNames(state, pa, play) {
  if (!play?.fielders) return null
  const announced = Object.values(state.alignments)
    .find((alignment) => alignment.batting.includes(pa.pitcherName))?.fielding
  if (!announced) return null
  const named = (value) => Boolean(value) && !/^char \d+$/.test(value)
  const captured = new Set(
    Object.values(play.fielders).map((fielder) => fielder?.character).filter(named),
  )
  const names = {}
  for (const [position, fielder] of Object.entries(play.fielders)) {
    if (named(fielder?.character)) continue
    const candidate = announced[position]
    if (candidate && !captured.has(candidate)) names[position] = candidate
  }
  return Object.keys(names).length ? names : null
}

function resultOuts(result, observedPutouts) {
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  const resultOut = OUT_RESULTS.has(result) || result === 'FC' ? 1 : 0
  return Math.max(resultOut, observedPutouts.length)
}

function exactRunnerAssignments(pa, nextRunners) {
  const nextBaseByName = new Map()
  for (const base of ['first', 'second', 'third']) {
    if (nextRunners[base]) nextBaseByName.set(nextRunners[base], base)
  }
  const scorers = new Set(pa.runEvents.map((run) => run.scorerName))
  const outs = new Set(pa.observedPutouts.map((putout) => putout.runnerName))
  const batterOut = ['K', 'GO', 'FO', 'LO', 'SF', 'SH'].includes(normalizedResult(pa))
  const entries = [
    { id: 'batter', runner: { characterName: pa.batterName }, origin: 'plate', isBatter: true },
    ...['first', 'second', 'third'].filter((base) => pa.runnersBefore[base]).map((base) => ({
      id: base, runner: { characterName: pa.runnersBefore[base] }, origin: base, isBatter: false,
    })),
  ]
  const assignments = []
  for (const entry of entries) {
    const name = entry.runner.characterName
    const destination = nextBaseByName.get(name)
      || (scorers.has(name) ? 'home' : null)
      || (outs.has(name) || (entry.isBatter && batterOut) ? 'out' : null)
    if (!destination) return null
    assignments.push({ ...entry, destination })
  }
  return assignments
}

function exactRunnerAssignmentsFromPlay(pa, play) {
  const entries = [
    {
      id: 'batter', origin: 'plate', isBatter: true,
      characterName: pa.batterName,
    },
    ...['first', 'second', 'third'].filter((base) => pa.runnersBefore[base]).map((base) => ({
      id: base, origin: base, isBatter: false,
      characterName: pa.runnersBefore[base],
    })),
  ]
  const destinations = runnerDestinationsFromPlay({
    entries,
    result: normalizedResult(pa, play),
    scoringRunners: pa.runEvents.map((run) => ({ characterName: run.scorerName })),
    outRunners: pa.observedPutouts.map((putout) => ({ characterName: putout.runnerName })),
    inningEndedOnThisPlay:
      pa.outsBeforePa + resultOuts(normalizedResult(pa, play), pa.observedPutouts) >= 3,
    play,
  })
  if (!destinations) return null
  return destinations.map((destination, index) => ({
    ...entries[index],
    runner: { characterName: entries[index].characterName },
    destination: destination.destination,
  }))
}

function deterministicRunnerAssignments(pa) {
  const entries = [
    { id: 'batter', runner: { characterName: pa.batterName }, origin: 'plate', isBatter: true },
    ...['first', 'second', 'third'].filter((base) => pa.runnersBefore[base]).map((base) => ({
      id: base, runner: { characterName: pa.runnersBefore[base] }, origin: base, isBatter: false,
    })),
  ]
  const result = normalizedResult(pa)
  if (result === 'HR' || result === 'IPHR') {
    return entries.map((entry) => ({ ...entry, destination: 'home' }))
  }
  if (result === 'BB' || result === 'HBP') {
    const occupied = pa.runnersBefore
    return entries.map((entry) => {
      let destination
      if (entry.isBatter) destination = 'first'
      else if (entry.origin === 'first') destination = 'second'
      else if (entry.origin === 'second') destination = occupied.first ? 'third' : 'second'
      else destination = occupied.first && occupied.second ? 'home' : 'third'
      return { ...entry, destination }
    })
  }
  const hasExistingRunners = entries.length > 1
  // A putout naming the batter is an OBSERVATION; the result letter is a
  // summary of the plate appearance. A batter credited with a single and
  // thrown out stretching for second is both at once, and where he finished is
  // the thing that was watched.
  const batterRetired = (pa.observedPutouts || []).some(
    (putout) => putout.runnerName === pa.batterName,
  )
  // A STRIKEOUT FOR THE THIRD OUT STRANDS EVERYONE. There is no ball in play,
  // so nothing joins, and the tracker stops announcing runner positions the
  // moment the inning ends -- which left the one case the rules settle outright
  // as the only unresolved at-bat of the 2026-09-04 DK Jungle game. It is the
  // same rule runnerDestinationsFromPlay already applies when an inning ends on
  // a joined play: a runner keeps his base. Runners the tracker DID announce as
  // scoring or as retired were resolved by exactRunnerAssignments before this
  // is reached, so this only ever holds a runner nothing was said about.
  if (result === 'K' && pa.outsBeforePa + 1 >= 3) {
    return entries.map((entry) => ({
      ...entry,
      destination: entry.isBatter ? 'out' : entry.origin,
    }))
  }
  if (!hasExistingRunners && ['1B', '2B', '3B', 'ROE'].includes(result)) {
    const destination = batterRetired ? 'out'
      : result === 'ROE' ? 'first' : { '1B': 'first', '2B': 'second', '3B': 'third' }[result]
    return [{ ...entries[0], destination }]
  }
  if (!hasExistingRunners && ['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'].includes(result)) {
    return [{ ...entries[0], destination: 'out' }]
  }
  if (!hasExistingRunners && result === 'FC') {
    return [{ ...entries[0], destination: batterRetired ? 'out' : 'first' }]
  }
  return null
}

function normalizedResult(pa, play = null) {
  let result = pa.result
  if (!result && shouldClassifyTrackerFielderChoice(pa)) result = 'FC'
  if (result === 'FO' && pa.battedBallTrajectory === 'L') result = 'LO'
  const error = shouldChargeTrackerBobbleError({ bobbleFielderName: pa.bobbleFielderName, result, play })
  if (error && shouldDowngradeTrackerHitToRoe({
    result, bobbleFielderName: pa.bobbleFielderName, play,
  })) result = 'ROE'
  const isBunt = trackerContactWasBunt(pa.advancedBattedBall, play)
  // The one sac-fly rule, shared with the bridge. This used to be a second
  // copy spelled out here, and the two drifted: the helper learned that a
  // caught line drive is a sacrifice fly and this copy did not.
  if (shouldReclassifyTrackerFlyOutAsSacFly({
    result,
    outsBeforePa: pa.outsBeforePa,
    scoredNonBatterRunner: pa.runEvents.some((run) => run.scorerName !== pa.batterName),
    isBunt,
  })) result = 'SF'
  if (shouldClassifyTrackerSacrificeBunt({
    isBunt,
    result,
    outsBeforePa: pa.outsBeforePa,
    hasRunnerOn: Boolean(pa.runnersBefore.first || pa.runnersBefore.second || pa.runnersBefore.third),
    // Read straight off the play's runner slots rather than off the runner
    // assignments, which are resolved from this function's own answer.
    runnerAdvanced: runnerAdvancedOnPlay({
      runnersBefore: pa.runnersBefore,
      scoringRunners: pa.runEvents.map((run) => ({ characterName: run.scorerName })),
      play,
    }),
  })) result = 'SH'
  return result
}

function serializePa(state, pa, runnerAssignments = pa.exactRunnerAssignments || null) {
  if (!pa) return null
  // The 60 Hz play is what decides whether the tracker's bobble is an error and
  // which position the fielder was actually standing in, so it is resolved
  // before anything that depends on either. It is null until the play arrives
  // and the join runs, and every one of these decisions falls back to what the
  // tracker log alone said in that case.
  const play = outcomePlayForBuffer(state, pa)
  const bunted = trackerContactWasBunt(pa.advancedBattedBall, play)
  // How the batter offered at each pitch, from the capture. This is what turns
  // the log's `strike_unknown` into a swinging or a called strike, and it is
  // also where a pitch the log never saw shows up -- as an unmatched measured
  // pitch rather than as nothing at all.
  const measured = measuredPitchesForBuffer(state, pa)
  const offers = applyMeasuredPitchOffers(pa.pitches, measured)
  const resolvedRunnerAssignments = runnerAssignments
    ?? exactRunnerAssignmentsFromPlay(pa, play)
    ?? deterministicRunnerAssignments(pa)
  const result = normalizedResult(pa, play)
  const announcedBobble = pa.bobbleFielderName
  const announcedBobbleVeto = trackerBobbleErrorVeto({
    bobbleFielderName: announcedBobble, play,
  })
  // The executable's line is sourced from a shared fielding-animation byte,
  // not from ball contact. Once the 60 Hz capture proves the named fielder
  // never touched the ball, could not reach it, or was not on the play at all
  // while someone else demonstrably handled it, the line is a false signal,
  // not a physical bobble that merely escaped an error charge. Keep it as
  // discarded audit evidence, but do not expose it as a bobble, warning, or
  // scoring narrative. Confirmed forced/extraordinary contacts remain real
  // bobbles and continue through the ordinary error-veto path.
  const discardedBobble = ['no_contact', 'out_of_reach', 'not_on_the_play']
    .includes(announcedBobbleVeto?.reason)
  const bobbleFielderName = discardedBobble ? null : announcedBobble
  const bobbleError = shouldChargeTrackerBobbleError({
    bobbleFielderName, result: pa.result, play,
  })
  const errorVeto = discardedBobble ? null : announcedBobbleVeto
  // The second error source, measured rather than announced. Consulted only
  // when the log's own bobble did not already charge one, so a single play can
  // never charge two errors for the same sequence.
  const throwingError = bobbleError ? null : trackerPlayThrowingError(play)
  const isError = bobbleError || Boolean(throwingError)
  const errorCharacter = bobbleError ? bobbleFielderName : (throwingError?.character ?? null)
  const errorPosition = bobbleError
    ? fieldingPosition(state, bobbleFielderName, pa.pitcherName, play)
    : (throwingError ? TRACKER_POSITION_NUMBERS[throwingError.position] ?? null : null)
  const capturedChain = trackerPlayOutChainPositions(play)
    .map((position) => TRACKER_POSITION_NUMBERS[position])
    .filter((value) => value != null)
  const chainNames = [...pa.assistFielderNames, pa.putoutFielderName].filter(Boolean)
  const loggedChain = chainNames
    .map((name) => fieldingPosition(state, name, pa.pitcherName, play))
    .filter((value) => value != null)
  const chainPositions = capturedChain.length ? capturedChain : loggedChain
  let hitNotation = chainPositions.length
    ? `${pa.battedBallTrajectory || (result === 'FO' ? 'F' : result === 'LO' ? 'L' : 'G')}${chainPositions.join('-')}`
    : null
  let errorNotation = null
  if (bobbleError && errorPosition != null) {
    // The batter reached because of the boot, so the error notation IS the play.
    errorNotation = assembleErrorNotation(pa.battedBallTrajectory || 'G', [errorPosition], errorPosition)
    hitNotation = errorNotation
  } else if (throwingError && errorPosition != null) {
    // A throwing error that only let a RUNNER advance leaves the batter's own
    // line alone -- his single is still a single. The charge hangs off the
    // putout chain when the play recorded one, and off the thrower alone when
    // it did not.
    errorNotation = assembleErrorNotation(
      pa.battedBallTrajectory || 'G',
      chainPositions.length ? chainPositions : [errorPosition],
      errorPosition,
    )
  }
  const outsOnPlay = resultOuts(result, pa.observedPutouts)
  const decisivePitch = offers.pitches.at(-1)
  const batterRun = pa.runEvents.find((run) => run.scorerName === pa.batterName)
  return {
    preview_only: true,
    saved_to_database: false,
    pa_number: pa.localPaNumber,
    inning: pa.inning,
    half: pa.isTop ? 'top' : 'bottom',
    outs_before_pa: pa.outsBeforePa,
    batter_name: pa.batterName,
    pitcher_name: pa.pitcherName,
    ...(pa.pitcherNames?.length > 1 ? { pitchers_faced: [...pa.pitcherNames] } : {}),
    result,
    outs_on_play: outsOnPlay,
    // The game's own RBI line, re-scored under OBR 9.04. See the rule.
    rbi: normalizeRbiForPaResult(result, trackerRbiForPaResult({
      result,
      rbi: pa.rbi,
      scoredNonBatterRunners: pa.runEvents.filter(
        (run) => run.scorerName !== pa.batterName).length,
    }), isError),
    run_scored: Boolean(batterRun) || result === 'HR' || result === 'IPHR',
    is_official_ab: result ? !['BB', 'HBP', 'SF', 'SH'].includes(result) : null,
    // Keyed on the bobble, not on `isError`: a throwing error that advanced
    // another runner says nothing about whether this batter's own run is
    // earned.
    is_earned_run: batterRun ? batterRun.earnedRun === true : !bobbleError,
    runner_on_first_before: Boolean(pa.runnersBefore.first),
    runner_on_second_before: Boolean(pa.runnersBefore.second),
    runner_on_third_before: Boolean(pa.runnersBefore.third),
    runners_before: { ...pa.runnersBefore },
    runner_assignments: resolvedRunnerAssignments,
    // A measured bunt outranks the letter the exit velocity produced: the
    // capture watched which animation the batter used, the tracker log only
    // saw how hard the ball left.
    trajectory: bunted ? 'B' : pa.battedBallTrajectory,
    // Preview-only: the production bridge records a bunt through `trajectory`
    // ('B'), the same code the At-Bat editor uses, because plate_appearances
    // has no bunt column of its own.
    is_bunt: bunted,
    hit_notation: hitNotation,
    fielder_choice_out: result === 'FC',
    is_error: isError,
    error_position: errorPosition,
    error_character: isError ? errorCharacter : null,
    error_player: null,
    error_notation: errorNotation,
    // Which of the two error sources charged it. The console says "a throwing
    // error" rather than "an error" for the measured one, because the operator
    // never saw the tracker announce anything for it.
    error_kind: isError ? (bobbleError ? 'fielding' : 'throwing') : null,
    // Present only when the tracker announced a bobble and the capture ruled it
    // out as an error, so the console can say why the play is a hit instead of
    // silently dropping a charge the operator saw the tracker make.
    error_vetoed_reason: errorVeto?.reason ?? null,
    error_vetoed_detail: errorVeto?.detail ?? null,
    is_nice_play: false,
    star_hit_used: Boolean(pa.starHitUsed),
    star_hit_connected: Boolean(
      decisivePitch?.is_star_swing && decisivePitch.result === 'in_play',
    ),
    star_pitch_used: Boolean(decisivePitch?.is_star_pitch),
    star_pitch_successful: Boolean(decisivePitch?.is_star_pitch && outsOnPlay > 0),
    // The tracker log announces the ATTEMPT ("is going up for a buddy jump!")
    // and, separately, only the ones that produced an out. A ball that clears
    // the fence gets the first line and never the second, so without this the
    // console said nobody played a home run two outfielders had gone up for.
    buddy_jump_attempt_by: pa.buddyJumpFielderName || null,
    is_buddy_jump: Boolean(pa.isBuddyJump),
    buddy_jump_assist_position: pa.isBuddyJump && pa.assistFielderNames[0]
      ? fieldingPosition(state, pa.assistFielderNames[0], pa.pitcherName) : null,
    buddy_jump_putout_position: pa.isBuddyJump
      ? fieldingPosition(state, pa.buddyJumpFielderName, pa.pitcherName) : null,
    is_robbed_hr: isTrackerRobbedHomeRun({
      record: pa.advancedBattedBall,
      isBuddyJump: pa.isBuddyJump,
      stadiumKey: state.stadiumKey,
    }),
    strikeout_type: result === 'K'
      ? (decisivePitch?.result === 'looking' ? 'KL'
        : decisivePitch?.result === 'swinging_miss' ? 'KS' : null)
      : null,
    hit_stadium_key: state.stadiumKey,
    ...trackerBattedBallPaFields(pa.advancedBattedBall, {
      stadiumKey: state.stadiumKey,
      projectCarryAtImpact: result === 'HR' || result === 'IPHR',
      play,
    }),
    ...trackerFieldedBallPaFields(pa.advancedFielding, { stadiumKey: state.stadiumKey }),
    pitches: offers.pitches.map((pitch) => ({ ...pitch })),
    // The two feeds' own counts, side by side, so a pitch only one of them saw
    // is a number on the page rather than a silent omission.
    pitches_logged: pa.pitches.length,
    pitches_measured: measured.length,
    // ONLY WHERE THERE IS A REAL LOG TO MISS THEM. An archive replay has no
    // tracker log at all -- its at-bat side is reconstructed from the plays,
    // which by construction contains a pitch only where the bat met the ball --
    // so every taken pitch in a replayed session would be reported as one the
    // tracker missed, which is a statement about the reconstruction and not
    // about the tracker.
    pitches_missing_from_log: state.mode === 'archive_replay' ? [] : offers.unmatched.map((record) => ({
      pitch_timer: record.pitch_timer,
      balls_before: record.balls_before,
      strikes_before: record.strikes_before,
      offer: record.offer,
      outcome: record.outcome,
    })),
    runs_scored: pa.runEvents.map((run) => ({
      scoring_character_name: run.scorerName,
      charged_to_pitcher_name: run.chargedToPitcherName || pa.pitcherName,
      is_earned_run: run.earnedRun === true,
    })),
    fielding_alignment: unnamedFielderNames(state, pa, play),
    fielding_events: {
      assists: [...pa.assistFielderNames],
      putouts: pa.observedPutouts.map(({ fielderName, runnerName }) => ({ fielderName, runnerName })),
      bobble: bobbleFielderName,
      bobble_signal_discarded: discardedBobble ? announcedBobble : null,
      bobble_signal_discarded_reason: discardedBobble ? announcedBobbleVeto.reason : null,
    },
    advanced_batted_ball_raw: pa.advancedBattedBall,
    advanced_fielding_raw: pa.advancedFielding,
    recent_messages: pa.messages.slice(-80),
  }
}

function serializePaWithProjection(state, pa, assignments) {
  const serialized = serializePa(state, pa, assignments)
  serialized.preview_projection = buildPreviewProjection(state, pa.advancedBattedBall, serialized)
  return serialized
}

function paHasActivity(pa) {
  return Boolean(pa && (
    pa.pitches.length || pa.result || pa.pendingPitchType || pa.pendingPitchTelemetry.length || pa.contactRecorded
    || pa.advancedBattedBall || pa.advancedFielding || pa.observedPutouts.length
  ))
}

function retainSessionAtBat(state, serializedPa) {
  const compact = compactTrackerPitchDiagnostics(serializedPa)
  if (!compact) return
  const existingIndex = state.sessionAtBats.findIndex((pa) => pa.pa_number === compact.pa_number)
  if (existingIndex >= 0) state.sessionAtBats[existingIndex] = compact
  else state.sessionAtBats.push(compact)
}

// mode/writesEnabled describe WHO is running this state machine, because the
// same parser now backs two very different processes: the standalone read-only
// preview, and the live Supabase bridge. The browser page renders identically
// for both, so the snapshot has to say which one it is talking to -- a page
// that cannot tell them apart would show "nothing is saved" over a session
// that is, in fact, writing every at-bat to the database.
export function createTrackerPreviewState({ mode = 'local_preview', writesEnabled = false } = {}) {
  return {
    mode,
    writesEnabled: Boolean(writesEnabled),
    // Set by the bridge once it has resolved which games row it is feeding, so
    // the embedded page can prove it is watching the game it is opened on.
    gameContext: null,
    // localPaNumber -> the outcome of this at-bat's database write. Only the
    // bridge fills this in; in the standalone preview it stays empty and the
    // page shows nothing, which is correct -- that process writes nothing.
    writeStatusByPaNumber: new Map(),
    connected: false,
    trackerStatus: 'waiting',
    trackerPid: null,
    startedAt: new Date().toISOString(),
    lastMessageAt: null,
    inning: 1,
    isTop: true,
    outs: 0,
    stadiumName: null,
    // stadiumKey is the effective key everything projects against; the other
    // two are the inputs it is resolved from.
    stadiumKey: null,
    stadiumDetectedKey: null,
    stadiumOverrideKey: null,
    localPaNumber: 0,
    gamePitchNumber: 0,
    alignments: {},
    // Base announcements received after a completed result describe the next
    // batter's situation. They wait here in case that batter's matchup banner
    // is one of the banners the game occasionally omits.
    pendingRunners: emptyRunnerState(),
    // The stock runner feed is delta-based: a runner who stays on the same
    // base is omitted from the next matchup. Carry the half-inning state and
    // apply only the locations the tracker actually announces.
    runnersInHalf: emptyRunnerState(),
    current: null,
    latestCompletedBuffer: null,
    latestCompleted: null,
    // Every completed at-bat's live buffer, oldest first, so any of them can be
    // re-serialized on demand (a stadium change re-projects all of them, and the
    // preview page pages back through them). Buffers rather than serialized
    // output because late-arriving records still mutate a completed at-bat.
    completedBuffers: [],
    sessionAtBats: [],
    revision: 0,
    events: [],
    ballSamples: new TrackerBallSampleBuffer(),
    // The 60 Hz half of the session: completed plays from the collector, how
    // each joined to an at-bat, and the health of the capture producing them.
    playerTracking: createPlayerTrackingState(),
  }
}

// The preview is deliberately not a recording: the at-bats it holds live only
// as long as the tracker that produced them. Once that process is gone the
// session is over, so everything it accumulated goes with it.
export function clearTrackerPreviewAtBats(state) {
  state.inning = 1
  state.isTop = true
  state.outs = 0
  state.alignments = {}
  state.current = null
  state.completedBuffers = []
  state.latestCompletedBuffer = null
  state.latestCompleted = null
  state.sessionAtBats = []
  state.localPaNumber = 0
  state.gamePitchNumber = 0
  state.pendingRunners = emptyRunnerState()
  state.runnersInHalf = emptyRunnerState()
  state.events = []
  // A manual override is an operator setting, not session data, so retain it.
  // The detected stadium and display name came from the tracker that stopped.
  state.stadiumDetectedKey = null
  state.stadiumKey = resolveStadiumKey(state)
  state.stadiumName = state.stadiumOverrideKey
    ? getStadiumNameByKey(state.stadiumOverrideKey)
    : null
  state.writeStatusByPaNumber?.clear()
  state.ballSamples?.clear()
  // The plays belong to the tracker session that produced them, exactly as the
  // at-bats do. The .bin on disk is the record that survives.
  state.playerTracking = createPlayerTrackingState()
  state.revision += 1
  return state
}

// What the bridge knows about the games row it is feeding. Kept deliberately
// small: enough for the embedded page to confirm it is pointed at the right
// game, and nothing that would go stale mid-session.
export function setTrackerPreviewGameContext(state, context) {
  state.gameContext = context ? { ...context } : null
  state.revision += 1
  return state
}

export const TRACKER_PREVIEW_WRITE_STATUSES = Object.freeze(['written', 'skipped', 'failed'])

// The whole point of running this preview against the live bridge: every
// at-bat on the page can say whether it actually reached the database, and if
// it did not, why. A skip is not an error -- the bridge deliberately refuses to
// guess an unresolved result -- but it IS the thing worth catching during a
// bug-test, and until now it existed only as a line in the bridge's console.
export function recordTrackerPreviewWrite(state, paNumber, status) {
  const key = Number(paNumber)
  if (!Number.isFinite(key) || !status) return state
  if (!TRACKER_PREVIEW_WRITE_STATUSES.includes(status.status)) return state
  state.writeStatusByPaNumber.set(key, {
    status: status.status,
    reason: status.reason ?? null,
    result: status.result ?? null,
    pa_id: status.paId ?? null,
    pa_number_db: status.paNumberDb ?? null,
    pitch_rows: status.pitchRows ?? null,
    run_rows: status.runRows ?? null,
    recorded_at: status.recordedAt || new Date().toISOString(),
  })
  state.revision += 1
  return state
}

function writeStatusFor(state, paNumber) {
  const key = Number(paNumber)
  if (!Number.isFinite(key)) return null
  return state.writeStatusByPaNumber?.get(key) || null
}

// --- the 60 Hz player-tracking feed ----------------------------------------
//
// These are the only ways a completed play, or the health of the capture
// producing them, enters a preview session. Both processes call them: the
// bridge as its collector sidecar emits plays, and the replay harness as it
// feeds an archived session back through.

/** One completed play from the collector (or a replayed archived one). */
export function applyTrackerPreviewPlay(state, play) {
  if (!applyPlayerTrackingPlay(state.playerTracking, play)) return false
  state.revision += 1
  return true
}

/** One pitch the capture measured, including how the batter offered at it. */
export function applyTrackerPreviewPitch(state, pitch) {
  if (!applyPlayerTrackingPitch(state.playerTracking, pitch)) return false
  state.revision += 1
  return true
}

/** The authoritative postgame restatement of a play, for comparison. */
export function applyTrackerPreviewPostgamePlay(state, play) {
  if (!applyPostgamePlay(state.playerTracking, play)) return false
  state.revision += 1
  return true
}

/** Collector health: frames, missed frames, calibration, pid, cost. */
export function setTrackerPreviewCaptureHealth(state, health) {
  setCaptureHealth(state.playerTracking, health || {})
  state.revision += 1
  return state.playerTracking.capture
}

// Every at-bat this session holds, in the shape the join needs. Built from the
// live buffers rather than from the compact index, because the join
// discriminates on the count and only the full serialization carries pitches.
function joinableAtBats(state) {
  // The measured stream carries the game's count before and after every pitch.
  // Add that count evidence to the join candidate only; it does not become a
  // reconstructed tracker-log pitch or invent a result. This matters in an
  // archive replay, whose rebuilt text intentionally includes contact pitches
  // only: a fair ball after an unprinted measured strike otherwise becomes a
  // false count mismatch even though the capture saw the missing count.
  const joinPitches = (buffer) => [
    ...buffer.pitches,
    ...measuredPitchesForBuffer(state, buffer).map((pitch) => ({
      count_balls_before: pitch.balls_before,
      count_strikes_before: pitch.strikes_before,
      count_balls_after: pitch.balls_after,
      count_strikes_after: pitch.strikes_after,
    })),
  ]
  const atBats = state.completedBuffers.map((buffer) => ({
    pa_number: buffer.localPaNumber,
    inning: buffer.inning,
    half: buffer.isTop ? 'top' : 'bottom',
    outs_before_pa: buffer.outsBeforePa,
    batter_name: buffer.batterName,
    result: normalizedResult(buffer),
    pitches: joinPitches(buffer),
  }))
  if (state.current && paHasActivity(state.current)) {
    atBats.push({
      pa_number: state.current.localPaNumber,
      inning: state.current.inning,
      half: state.current.isTop ? 'top' : 'bottom',
      outs_before_pa: state.current.outsBeforePa,
      batter_name: state.current.batterName,
      result: normalizedResult(state.current),
      pitches: joinPitches(state.current),
    })
  }
  return atBats
}

/**
 * The 60 Hz play this at-bat's outcome should be read from, joins re-run first.
 *
 * For callers OUTSIDE the snapshot path -- the production bridge finalizes a
 * plate appearance on its own schedule and must reach the same verdict the
 * console shows, or the database and the page disagree about whether a play
 * was an error. Returns null when no play has arrived yet, which is the same
 * "trust the tracker log alone" fallback the preview uses.
 */
export function trackerPreviewOutcomePlay(state, paNumber) {
  if (!state?.playerTracking || paNumber == null) return null
  rejoinPlays(state.playerTracking, joinableAtBats(state), {
    latestInning: state.inning,
    latestHalf: state.isTop ? 'top' : 'bottom',
  })
  if (state.latestCompletedBuffer) {
    state.latestCompleted = serializePaWithProjection(
      state, state.latestCompletedBuffer, state.latestCompletedBuffer.exactRunnerAssignments,
    )
  }
  const outcome = outcomePlayFor(state.playerTracking, paNumber)
  return outcome.join?.status === 'joined' ? outcome.play : null
}

/**
 * The pitches the capture measured for one plate appearance, by PA number.
 *
 * The bridge keeps its own plate-appearance buffers, so it cannot call the
 * buffer-keyed grouping directly; it asks by the number both sides agree on.
 * Returns an empty array when no capture is running, which is what makes the
 * offer an addition to the tracker log rather than a dependency of it.
 */
export function trackerPreviewMeasuredPitches(state, paNumber) {
  if (!state?.playerTracking?.pitches?.length || paNumber == null) return []
  const buffers = [...state.completedBuffers, ...(state.current ? [state.current] : [])]
  const buffer = buffers.find((entry) => entry.localPaNumber === paNumber)
  return buffer ? measuredPitchesForBuffer(state, buffer) : []
}

// The full record for one play, for the /play endpoint. Deliberately not in
// the snapshot: this is the heavy evidence an operator opens deliberately.
export function trackerPreviewPlayEvidence(state, contactTimer) {
  const key = Number(contactTimer)
  const play = state.playerTracking.playsByContactTimer.get(key)
  if (!play) return null
  // Joins are derived, not stored, and this endpoint can be called without a
  // snapshot having been taken first. Re-derive rather than answer with a
  // stale join or none at all.
  rejoinPlays(state.playerTracking, joinableAtBats(state), {
    latestInning: state.inning,
    latestHalf: state.isTop ? 'top' : 'bottom',
  })
  return {
    play,
    join: state.playerTracking.joins.get(key) || null,
    postgame: state.playerTracking.postgameByContactTimer.get(key) || null,
    geometry: playGeometry(play),
  }
}

// The interpretation, the warnings and the four-category verdict for one
// at-bat. One function so the history strip, the cards and the annotation
// payload can never disagree about what this at-bat's status is.
function interpretAtBat(state, serialized) {
  if (!serialized) return null
  const { play, join } = outcomePlayFor(state.playerTracking, serialized.pa_number)
  const postgamePlay = play
    ? state.playerTracking.postgameByContactTimer.get(Number(play.contact_timer)) || null
    : null
  const narrative = buildTrackerNarrative({
    atBat: serialized, play, join,
    // So the narrative can tell "the play has not arrived" apart from "no
    // collector is running and none ever will".
    captureStatus: state.playerTracking?.capture?.status ?? null,
  })
  const warnings = validateTrackerAtBat({
    atBat: serialized, play, join, narrative, postgamePlay,
  })
  return {
    narrative,
    warnings,
    checks: summarizeAtBatChecks({ atBat: serialized, play, join, warnings }),
    play,
    join,
  }
}

export function applyTrackerPreviewMessage(state, message) {
  const clean = String(message || '').trim()
  if (!clean) return state
  state.connected = true
  state.trackerStatus = 'receiving tracker output'
  state.lastMessageAt = new Date().toISOString()

  // Samples are high-volume model input, not human-readable events. Keep them
  // in the bounded flight buffer and out of recent_tracker_messages.
  if (clean.startsWith(`${TRACKER_BALL_SAMPLE_MARKER} `)) {
    state.ballSamples.push(parseTrackerBallSampleMessage(clean))
    return state
  }
  state.events.push(clean)
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300)

  let match
  const lineup = parseTrackerLineupMessage(clean)
  if (lineup) {
    state.alignments[lineup.teamName] = lineup
    return state
  }
  if ((match = clean.match(/^(.+?)\s+vs\.\s+(.+?)\s+@\s+(.+)$/))) {
    state.stadiumName = match[3].trim()
    state.stadiumDetectedKey = getStadiumKeyByName(state.stadiumName)
    // A hand-picked stadium stays in force once chosen, so a detection
    // arriving mid-session cannot silently move the field out from under the
    // location being checked.
    state.stadiumKey = resolveStadiumKey(state)
    return state
  }
  if ((match = clean.match(/^Next:\s*(Top|Bottom) of inning (\d+)$/i))) {
    state.isTop = /^Top$/i.test(match[1])
    state.inning = Number(match[2])
    state.outs = 0
    state.pendingRunners = emptyRunnerState()
    state.runnersInHalf = emptyRunnerState()
    return state
  }
  if ((match = clean.match(/^(\d+)\s+outs?$/i))) {
    state.outs = Number(match[1])
    // THE MATCHUP LINE COMES FIRST, so the plate appearance it opened captured
    // the out total from BEFORE the out that ended the previous one. Every PA
    // that followed an out was therefore stamped one out light, and the mistake
    // is invisible: nothing else in the log restates the count.
    //
    // Peach's fifth-inning lineout on 2026-08-31 is what it cost -- announced
    // at two outs, recorded as one, so the rule that voids a runner's advance
    // when the catch is the third out never fired and the console put two
    // runners on third. It also decides sacrifice flies and sacrifice bunts,
    // both of which are only sacrifices with fewer than two out.
    //
    // Adopted only while the plate appearance is still empty, which is the only
    // place this line ever appears -- between the matchup and "Count: 0-0".
    if (state.current && !paHasActivity(state.current)) state.current.outsBeforePa = state.outs
    return state
  }
  if ((match = clean.match(/^(.+?)\s+vs\.\s+(.+)$/)) && !clean.includes(' @ ')) {
    const pitcherName = match[1].trim()
    const batterName = match[2].trim()
    // A RELIEF PITCHER IS NOT A NEW PLATE APPEARANCE. The tracker reprints the
    // matchup banner when the defence changes pitchers mid-count, naming the
    // same batter again: on 2026-08-31 Boo faced Waluigi, Waluigi fouled one
    // off at 0-1, Red Toad came in, and the banner split one plate appearance
    // into two -- an unfinished 0-1 at-bat with no result at all, and a second
    // one that began on the pitch that ended it. Both then matched the same
    // 60 Hz play on inning, half and batter, so the join went ambiguous and the
    // fielding was withheld from a single that had measured fielding.
    //
    // The batter is the plate appearance; the pitcher is a field on it. The
    // new name is adopted, which is what the executable itself does -- the
    // batted-ball record for that single names Red Toad, not Boo.
    if (state.current && !state.current.result && paHasActivity(state.current)
      && sameRunnerName(state.current.batterName, batterName)) {
      state.current.pitcherName = pitcherName
      if (!state.current.pitcherNames.includes(pitcherName)) {
        state.current.pitcherNames.push(pitcherName)
      }
      return state
    }
    startPa(state, pitcherName, batterName)
    return state
  }

  let pa = state.current
  if (!pa) return state

  if (clean.startsWith(PITCH_PROVISIONAL_PREFIX)) {
    const telemetry = parseTrackerPitchProvisionalMessage(clean)
    pa = recoverMissingMatchup(state, telemetry)
    pa.messages.push(clean)
    applyPitchTelemetry(pa, telemetry)
    return state
  }

  if (clean.startsWith('[TRACKER_BATTED_BALL_PROVISIONAL]')) {
    const record = attachTrackerTrajectory(
      parseTrackerBattedBallMessage(clean), state.ballSamples,
    )
    pa = recoverMissingMatchup(state, record)
    pa.messages.push(clean)
    // A foul call already standing for this contact outranks the record's own
    // endpoint_status. The tracker stamps the landing from fair_or_foul at the
    // moment it resolves, so a ball the game reclassified a beat later arrives
    // here marked fair; `endpoint !== 'foul'` inside the apply cannot see that,
    // but a pending foul is the game's final word on the same contact.
    if (pa.pendingPitchType === 'foul') return state
    // A deep/unresolved contact's flush can lag behind the next matchup line
    // (the game announces the next batter well before our flight-timeout
    // fires), so the record for the PREVIOUS batter can arrive after `pa`
    // has already moved on. Retry against the just-completed buffer before
    // giving up, mirroring the exact-runner-assignment backfill above.
    if (record && !applyTrackerBattedBallToBuffer(pa, record) && state.latestCompletedBuffer) {
      if (applyTrackerBattedBallToBuffer(state.latestCompletedBuffer, record)) {
        state.latestCompleted = serializePaWithProjection(
          state, state.latestCompletedBuffer, state.latestCompletedBuffer.exactRunnerAssignments,
        )
        retainSessionAtBat(state, state.latestCompleted)
        state.revision += 1
      }
    }
    return state
  }

  pa.messages.push(clean)

  const runner = parseTrackerRunnerMessage(clean)
  if (runner) {
    applyRunnerStateDelta(state, runner)
    if (pa.result) state.pendingRunners[runner.base] = runner.characterName
    else pa.runnersBefore = { ...state.runnersInHalf }
    return state
  }
  if ((match = clean.match(/^Count:\s*(\d)-(\d)$/i))) {
    const next = { balls: Number(match[1]), strikes: Number(match[2]) }
    // The stock tracker can repeat 0-0 after a long pre-pitch pause, and emits
    // another 0-0 between PAs even when it omits the matchup banner. Neither is
    // a pitch. A pending foul at two strikes is intentionally NOT ignored.
    if (pa.result) return state
    if (
      pa.countSeen && !pa.pendingPitchType
      && next.balls === pa.lastCount.balls && next.strikes === pa.lastCount.strikes
    ) return state
    if (!pa.countSeen) {
      pa.countSeen = true
      pa.lastCount = next
      if (state.latestCompletedBuffer) {
        const assignments = exactRunnerAssignments(state.latestCompletedBuffer, pa.runnersBefore)
        state.latestCompletedBuffer.exactRunnerAssignments = assignments
        state.latestCompleted = serializePaWithProjection(state, state.latestCompletedBuffer, assignments)
      }
      return state
    }
    const type = pa.pendingPitchType === 'strike'
      ? 'strike_unknown' : pa.pendingPitchType === 'foul' ? 'foul' : 'ball'
    pushPitch(state, pa, type, pa.lastCount, next)
    pa.pendingPitchType = null
    pa.lastCount = next
    if (next.balls >= 4) pa.result = pa.result || 'BB'
    return state
  }
  if (/^Strike\s+\d+\.$/i.test(clean)) { pa.pendingPitchType = 'strike'; return state }
  if (/^Foul ball!$/i.test(clean)) {
    retractPrematureFairBall(state, pa)
    pa.pendingPitchType = 'foul'
    return state
  }
  if (/^Fair ball!$/i.test(clean)) { ensureContactPitch(state, pa); return state }

  const hbpBatter = parseTrackerHitByPitchMessage(clean)
  if (hbpBatter === pa.batterName) {
    pushPitch(state, pa, 'hbp')
    pa.result = 'HBP'
    return state
  }
  if (clean.startsWith('[TRACKER_BALL_FIELDED_PROVISIONAL]')) {
    const record = parseTrackerFieldedBallMessage(clean)
    if (record) applyTrackerFieldedBallToBuffer(pa, record)
    return state
  }
  if (/^Double play!$/i.test(clean)) {
    if (['GO', 'FO', 'LO'].includes(pa.result)) { pa.result = 'DP'; pa.resultInferredFromPutout = false }
    else pa.pendingDoublePlay = true
    return state
  }
  if (/^Triple play!$/i.test(clean)) {
    if (['GO', 'FO', 'LO'].includes(pa.result)) { pa.result = 'TP'; pa.resultInferredFromPutout = false }
    else pa.pendingTriplePlay = true
    return state
  }
  if ((match = clean.match(/^(.+?)'s hit was caught!$/i)) && match[1].trim() === pa.batterName) {
    ensureContactPitch(state, pa)
    pa.result = trackerCaughtBallResult(pa.advancedBattedBall)
    pa.battedBallTrajectory = pa.battedBallTrajectory || (pa.result === 'LO' ? 'L' : 'F')
    applyPendingMultiOut(pa)
    return state
  }
  const putout = parseTrackerPutoutMessage(clean)
  if (putout) {
    removeRunnerFromState(state, putout.runnerName)
    if (!pa.observedPutouts.some((entry) => entry.fielderName === putout.fielderName && entry.runnerName === putout.runnerName)) {
      pa.observedPutouts.push(putout)
    }
    pa.putoutFielderName = putout.fielderName
    if (!pa.result && putout.runnerName === pa.batterName) {
      ensureContactPitch(state, pa)
      pa.result = 'GO'
      // AN INFERENCE, NOT AN ANNOUNCEMENT. "X put the batter out" says the
      // batter was retired; it does not say WHERE. A batter who reaches first
      // and is thrown out stretching for second is credited with the hit and
      // an out on the bases, and the game announces both -- the putout first,
      // then "recorded a single!". Latching the groundout here and refusing
      // the announcement that followed turned every one of those into a
      // groundout on a fly ball the outfield had already let land.
      pa.resultInferredFromPutout = true
      pa.battedBallTrajectory = pa.battedBallTrajectory || 'G'
      applyPendingMultiOut(pa)
    }
    return state
  }
  if ((match = clean.match(/^(.+?)\s+recorded an assist!$/i))) {
    pa.assistFielderNames.push(match[1].trim())
    return state
  }
  if ((match = clean.match(/^(.+?)\s+bobbled the ball!$/i))) {
    pa.bobbleFielderName = match[1].trim()
    return state
  }
  if ((match = clean.match(/^(.+?)\s+is going up for a buddy jump!$/i))) {
    pa.buddyJumpFielderName = match[1].trim()
    return state
  }
  if ((match = clean.match(/^(.+?)\s+went high up with the buddy jump to get the out!$/i))) {
    pa.isBuddyJump = true
    pa.buddyJumpFielderName = match[1].trim()
    return state
  }
  if ((match = clean.match(/^(.+?)\s+used a star pitch!$/i)) && match[1].trim() === pa.pitcherName) {
    pa.pendingStarPitch = true
    return state
  }
  if (markTrackerStarSwing(pa, clean)) return state
  // An announced result outranks the groundout inferred from a putout above.
  if (!pa.result || pa.resultInferredFromPutout) {
    const announce = (value) => {
      ensureContactPitch(state, pa)
      pa.result = value
      pa.resultInferredFromPutout = false
      return state
    }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?single!$/i)) && match[1].trim() === pa.batterName) { return announce('1B') }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?double!$/i)) && match[1].trim() === pa.batterName) { return announce('2B') }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?triple!$/i)) && match[1].trim() === pa.batterName) { return announce('3B') }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?inside the park home run!$/i)) && match[1].trim() === pa.batterName) { return announce('IPHR') }
    if ((match = clean.match(/^(.+?)\s+hits an?\s+.*(?:homer|home run).*off of\s+.+!$/i)) && match[1].trim() === pa.batterName) { return announce('HR') }
    if ((match = clean.match(/^.+?\s+struck out\s+(.+?)!$/i)) && match[1].trim() === pa.batterName) {
      ensureStrikeoutPitch(state, pa)
      pa.result = 'K'
      pa.resultInferredFromPutout = false
      return state
    }
  }
  if ((match = clean.match(/^(.+?)\s+recorded (\d+) RBI!$/i)) && match[1].trim() === pa.batterName) {
    pa.rbi = Number(match[2])
    return state
  }
  if ((match = clean.match(/^(.+?)\s+recorded a run!$/i))) {
    pa.runEvents.push({ scorerName: match[1].trim(), chargedToPitcherName: null, earnedRun: false })
    removeRunnerFromState(state, match[1].trim())
    return state
  }
  if ((match = clean.match(/^(.+?)\s+was charged with an? earned run$/i))) {
    const run = pa.runEvents.at(-1)
    if (run) { run.chargedToPitcherName = match[1].trim(); run.earnedRun = true }
    return state
  }
  if ((match = clean.match(/^.+?\s+inherited this runner from (.+?)\.\s+(.+?)\s+will be charged any earned runs\.$/i))) {
    const run = pa.runEvents.at(-1)
    if (run && match[1].trim() === match[2].trim()) run.chargedToPitcherName = match[1].trim()
  }
  return state
}

// One line per at-bat the session is holding — enough to label the preview's
// back/forward navigation without serializing (and re-transmitting) every
// at-bat's full record, pitch-flight sample trails included, on every poll.
function atBatIndexEntry(pa, {
  isCurrent = false, stadiumKey = null, writeStatus = null,
  checks = null, warningCount = 0, errorCount = 0, joinStatus = null,
  narrativeSummary = null, play = null, result = null,
} = {}) {
  // Enough batted-ball detail to plot the whole session on one spray chart.
  // Deliberately only the position and the few numbers a marker's tooltip
  // shows -- this list is fetched on every poll, so it stays an index rather
  // than turning into a second copy of every at-bat.
  //
  // THE RESULT IS HANDED IN, not recomputed. This used to call
  // normalizedResult(pa) with no play, which is not the same question: without
  // the 60 Hz play no error veto can fire, so every announced bobble on a base
  // hit became an ROE here while the at-bat card -- which does pass the play --
  // still said single. Daisy Cruiser 2026-09-04 disagreed with itself on 12 of
  // 93 at-bats that way, and this list is what draws the session spray chart.
  const resolvedResult = result ?? normalizedResult(pa, play)
  const isHomeRun = resolvedResult === 'HR' || resolvedResult === 'IPHR'
  const projectedImpactCarry = isHomeRun
    ? trackerProjectedCarryFromObservedImpact(pa.advancedBattedBall)
    : null
  const batted = trackerBattedBallPaFields(pa.advancedBattedBall, {
    stadiumKey,
    projectCarryAtImpact: isHomeRun,
    play,
  })
  return {
    pa_number: pa.localPaNumber,
    // null in the read-only preview; the bridge fills it in as each at-bat is
    // written, skipped, or fails, so the arrow strip can flag the bad ones.
    supabase_write: writeStatus,
    // The one-line verdict the history strip renders, and the count of things
    // worth looking at. Computed here so the strip and the cards cannot
    // disagree about whether an at-bat is clean.
    checks: checks || null,
    warning_count: warningCount,
    error_count: errorCount,
    join_status: joinStatus,
    narrative_summary: narrativeSummary,
    batter_name: pa.batterName,
    pitcher_name: pa.pitcherName,
    inning: pa.inning,
    half: pa.isTop ? 'top' : 'bottom',
    result: resolvedResult,
    pitch_count: pa.pitches.length,
    is_current: isCurrent,
    hit_stadium_key: batted.hit_stadium_key ?? null,
    hit_world_x: batted.hit_world_x ?? null,
    // Height is not optional here. A home run ends well above the ground -- 30
    // ft into the stands, 15 off the top of the wall -- and without it the
    // chart draws the ground point beneath the ball, which reads short by
    // exactly that much. Omitting it does not degrade the marker, it silently
    // disables the correction entirely.
    hit_world_y: batted.hit_world_y ?? null,
    hit_position_estimated: batted.hit_position_estimated ?? false,
    // Tri-state on persisted rows, but always explicit in this live preview.
    // The spray chart must not infer this from result=HR later and move a dot
    // that was already placed from a definitive collision.
    hit_reveal_occluded_landing: trackerBattedBallShouldRevealOccludedLanding(
      pa.advancedBattedBall,
      stadiumKey,
      play,
    ),
    hit_world_z: batted.hit_world_z ?? null,
    hit_distance_ft: batted.hit_distance_ft ?? null,
    // Preview-only. Persisted rows can infer the same distinction by comparing
    // an elevated impact's stored projected carry with its measured world
    // radius, but the live chart should not have to infer anything.
    hit_distance_is_projected: projectedImpactCarry != null,
    hit_angle_deg: batted.hit_angle_deg ?? null,
    exit_velocity_mph: batted.exit_velocity_mph ?? null,
    launch_angle_deg: batted.launch_angle_deg ?? null,
  }
}

// selectedPaNumber pages back to an earlier at-bat in this session; omitting it
// keeps the default live behaviour of following whatever is happening now.
export function trackerPreviewSnapshot(state, { selectedPaNumber = null } = {}) {
  // Join before serializing: runner destinations, error vetoes, and fielder
  // positions all read the joined play. Doing this afterwards made only the
  // history rows accurate while the current at-bat still showed stale values.
  rejoinPlays(state.playerTracking, joinableAtBats(state), {
    latestInning: state.inning,
    latestHalf: state.isTop ? 'top' : 'bottom',
  })

  // A fresh matchup with nothing in it yet is still exposed as current_at_bat
  // (it proves the parser moved on to the right batter), but it is not an
  // at-bat anyone can page to or display until something actually happens in it.
  const currentSerialized = state.current ? serializePaWithProjection(state, state.current) : null
  const current = paHasActivity(state.current) ? currentSerialized : null
  const sessionAtBats = [...state.sessionAtBats]
  if (current) {
    const compactCurrent = compactTrackerPitchDiagnostics(current)
    const existingIndex = sessionAtBats.findIndex((pa) => pa.pa_number === compactCurrent.pa_number)
    if (existingIndex >= 0) sessionAtBats[existingIndex] = compactCurrent
    else sessionAtBats.push(compactCurrent)
  }

  // Interpret every at-bat once, here, so the history strip, the four cards and
  // the annotation payload all read the same verdict.
  const interpretations = new Map()
  const interpretFor = (buffer, serialized) => {
    const result = interpretAtBat(state, serialized)
    if (result) interpretations.set(serialized.pa_number, result)
    return result
  }
  const indexEntry = (buffer, isCurrent) => {
    const serialized = isCurrent
      ? currentSerialized
      : serializePaWithProjection(state, buffer, buffer.exactRunnerAssignments)
    const interpretation = interpretFor(buffer, serialized)
    const warnings = interpretation?.warnings || []
    return atBatIndexEntry(buffer, {
      isCurrent,
      stadiumKey: state.stadiumKey,
      // The value the card and the narrative already agreed on, so the strip
      // cannot reach a different one.
      result: serialized.result,
      writeStatus: writeStatusFor(state, buffer.localPaNumber),
      checks: interpretation?.checks || null,
      warningCount: warnings.length,
      errorCount: warnings.filter((warning) => warning.severity === 'error').length,
      joinStatus: interpretation?.join?.status || null,
      narrativeSummary: interpretation?.narrative?.summary || null,
      play: interpretation?.play || null,
    })
  }
  const atBats = [
    ...state.completedBuffers.map((buffer) => indexEntry(buffer, false)),
    ...(current ? [indexEntry(state.current, true)] : []),
  ]

  const requestedPaNumber = Number(selectedPaNumber)
  let selected = null
  if (Number.isFinite(requestedPaNumber)) {
    if (current?.pa_number === requestedPaNumber) selected = current
    else {
      const buffer = state.completedBuffers.find((entry) => entry.localPaNumber === requestedPaNumber)
      if (buffer) selected = serializePaWithProjection(state, buffer, buffer.exactRunnerAssignments)
    }
  }
  const refreshedLatestCompleted = state.latestCompletedBuffer
    ? serializePaWithProjection(
      state,
      state.latestCompletedBuffer,
      state.latestCompletedBuffer.exactRunnerAssignments,
    )
    : state.latestCompleted
  const display = selected || current || refreshedLatestCompleted
  const displayInterpretation = display
    ? interpretations.get(display.pa_number) || interpretAtBat(state, display)
    : null
  const displayPlays = display
    ? playsForAtBat(state.playerTracking, display.pa_number)
    : []

  return {
    mode: state.mode || 'local_preview',
    writes_enabled: Boolean(state.writesEnabled),
    game: state.gameContext || null,
    connected: state.connected,
    tracker_status: state.trackerStatus,
    tracker_pid: state.trackerPid,
    started_at: state.startedAt,
    last_message_at: state.lastMessageAt,
    stadium_name: state.stadiumName,
    stadium_key: state.stadiumKey,
    stadium_detected_key: state.stadiumDetectedKey,
    stadium_override_key: state.stadiumOverrideKey,
    stadium_options: TRACKER_PREVIEW_STADIUM_OPTIONS,
    revision: state.revision,
    // The live game situation, for the capture-health bar. The bar is the one
    // part of the page that must be right even when everything below it is
    // waiting, because it is what says whether to trust anything below it.
    situation: {
      inning: state.inning,
      half: state.isTop ? 'top' : 'bottom',
      outs: state.outs,
      batter_name: current?.batter_name ?? state.latestCompleted?.batter_name ?? null,
      pitcher_name: current?.pitcher_name ?? state.latestCompleted?.pitcher_name ?? null,
      count: current?.pitches?.length
        ? `${current.pitches.at(-1).count_balls_after}-${current.pitches.at(-1).count_strikes_after}`
        : '0-0',
    },
    // 60 Hz capture health and the compact play list. The full record for any
    // one play is fetched from /play; nothing heavy travels on a poll.
    capture: {
      ...state.playerTracking.capture,
      last_frame_age_ms: state.playerTracking.capture.last_frame_at
        ? Date.now() - Date.parse(state.playerTracking.capture.last_frame_at)
        : null,
      play_count: state.playerTracking.plays.length,
      join_tally: joinTally(state.playerTracking),
    },
    player_tracking_plays: state.playerTracking.plays.map((play) => compactPlaySummary(
      play,
      state.playerTracking.joins.get(Number(play.contact_timer)) || null,
      null,
    )),
    at_bats: atBats,
    at_bat_count: atBats.length,
    selected_pa_number: display?.pa_number ?? null,
    display_at_bat: display
      ? { ...display, supabase_write: writeStatusFor(state, display.pa_number) }
      : null,
    // "Tracker interpreted this play as:" -- the centrepiece of the page.
    interpretation: displayInterpretation?.narrative || null,
    warnings: displayInterpretation?.warnings || [],
    checks: displayInterpretation?.checks || null,
    advanced_metrics: buildPreviewAdvancedMetrics({
      play: displayInterpretation?.play,
      join: displayInterpretation?.join,
      atBat: display,
    }),
    // Geometry for the play visualization: nine fielders at pitch release, the
    // flight, the routes and the throw chain. Small enough to poll; the frame
    // trail behind it is not, and stays behind /play.
    play_geometry: playGeometry(displayInterpretation?.play || null),
    display_play: compactPlaySummary(
      displayInterpretation?.play || null,
      displayInterpretation?.join || null,
      display,
    ),
    display_play_joins: displayPlays.map(({ play, join }) => compactPlaySummary(play, join, display)),
    current_at_bat: currentSerialized,
    last_completed_at_bat: state.latestCompleted,
    session_pitch_diagnostics: compactTrackerSessionPitchDiagnostics(sessionAtBats),
    recent_tracker_messages: state.events.slice(-100),
  }
}

export function compactTrackerPitchDiagnostics(pa) {
  if (!pa) return null
  const battedBallRaw = pa.advanced_batted_ball_raw
  return {
    schema_version: 1,
    raw_xyz_samples_included: false,
    pa_number: pa.pa_number,
    batter_name: pa.batter_name,
    pitcher_name: pa.pitcher_name,
    result: pa.result,
    inning: pa.inning,
    half: pa.half,
    batted_ball: battedBallRaw ? {
      endpoint: battedBallRaw.endpoint,
      endpoint_status: battedBallRaw.endpointStatus,
      is_projected: battedBallRaw.endpoint === 'unresolved',
      exit_velocity_mph: pa.exit_velocity_mph ?? null,
      launch_angle_deg: pa.launch_angle_deg ?? null,
      spray_angle_deg: pa.hit_angle_deg ?? null,
      hit_distance_ft: pa.hit_distance_ft ?? null,
      hang_time_sec: pa.hang_time_sec ?? null,
      hit_x: pa.hit_x ?? null,
      hit_y: pa.hit_y ?? null,
    } : null,
    pitches: (pa.pitches || []).map((pitch) => {
      const telemetry = pitch.pitch_telemetry || {}
      return {
        pitch_number_pa: pitch.pitch_number_pa,
        result: pitch.result,
        pitch_type: pitch.pitch_type,
        is_star_pitch: pitch.is_star_pitch,
        count_before: `${pitch.count_balls_before}-${pitch.count_strikes_before}`,
        count_after: `${pitch.count_balls_after}-${pitch.count_strikes_after}`,
        speed_mph: pitch.pitch_speed_mph,
        elapsed_seconds: telemetry.elapsedSeconds ?? null,
        path_distance_feet: telemetry.pathDistanceFeet ?? null,
        sample_count: telemetry.sampleCount ?? null,
        horizontal_delta_units: telemetry.horizontalDeltaUnits ?? null,
        vertical_delta_units: telemetry.verticalDeltaUnits ?? null,
        forward_delta_units: telemetry.forwardDeltaUnits ?? null,
        horizontal_chord_deviation_units: telemetry.horizontalChordDeviationUnits ?? null,
        horizontal_chord_deviation_max_units: telemetry.horizontalChordDeviationMaxUnits ?? null,
        horizontal_chord_deviation_min_units: telemetry.horizontalChordDeviationMinUnits ?? null,
        vertical_chord_deviation_units: telemetry.verticalChordDeviationUnits ?? null,
        classifier: telemetry.classifier ?? null,
        classifier_status: telemetry.classifierStatus ?? null,
      }
    }),
  }
}

export function compactTrackerSessionPitchDiagnostics(atBats = []) {
  const compactAtBats = atBats.map((pa) => (
    pa?.raw_xyz_samples_included === false ? pa : compactTrackerPitchDiagnostics(pa)
  )).filter(Boolean)
  return {
    schema_version: 2,
    scope: 'preview_session',
    persists_until_preview_restart: true,
    raw_xyz_samples_included: false,
    at_bat_count: compactAtBats.length,
    pitch_count: compactAtBats.reduce((total, pa) => total + pa.pitches.length, 0),
    at_bats: compactAtBats,
  }
}
