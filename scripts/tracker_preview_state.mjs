import { TRACKER_POSITION_NUMBERS, parseTrackerLineupMessage, parseTrackerRunnerMessage } from './tracker_alignment.mjs'
import {
  applyTrackerBattedBallToBuffer,
  applyTrackerFieldedBallToBuffer,
  classifyPitchMovement,
  isTrackerBuntedBall,
  isTrackerRobbedHomeRun,
  parseTrackerBattedBallMessage,
  parseTrackerFieldedBallMessage,
  parseTrackerHitByPitchMessage,
  parseTrackerPitchProvisionalMessage,
  parseTrackerPutoutMessage,
  shouldChargeTrackerBobbleError,
  shouldClassifyTrackerFielderChoice,
  shouldClassifyTrackerSacrificeBunt,
  TRACKER_PITCH_PROVISIONAL_MARKER,
  trackerBattedBallPaFields,
  trackerBattedBallPlotGeometry,
  trackerCaughtBallResult,
  trackerFieldedBallPaFields,
} from './tracker_play_events.mjs'
import {
  projectTrackerBattedBallDistanceFeet,
  projectTrackerFieldSpot,
  TRACKER_STADIUM_FIELD_GEOMETRY,
} from './tracker_field_projection.mjs'
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
  const physics = projectTrackerBattedBallDistanceFeet(record.exitVelocityMph, record.launchAngleDeg)
  const measuredDistance = record.distanceFeet ?? null
  const isUnresolved = record.endpoint === 'unresolved'
  const usedExtrapolation = isUnresolved && measuredDistance != null

  const distanceSource = !isUnresolved && measuredDistance != null ? 'tracked_endpoint'
    : usedExtrapolation ? 'tracker_last_frame_extrapolation'
      : physics ? 'physics_from_exit_velocity' : 'none'

  const physicsSpot = physics && stadiumKey
    ? projectTrackerFieldSpot(physics.distanceFeet, record.sprayAngleDeg, stadiumKey)
    : null
  const plottedX = serialized?.hit_x ?? null
  const plottedY = serialized?.hit_y ?? null

  const geometry = trackerBattedBallPlotGeometry(record, serialized?.hit_distance_ft)

  return {
    stadium_key: stadiumKey,
    is_projected: distanceSource !== 'tracked_endpoint',
    distance_source: distanceSource,
    // Which geometry actually placed the marker. 'launch_spray_angle' is the
    // weakest of the three: it assumes the ball kept the direction it left the
    // bat on, which curving balls do not.
    plot_source: geometry?.source ?? null,
    plot_angle_deg: geometry ? Math.round(geometry.angleDeg * 10) / 10 : null,
    spray_angle_deg: record.sprayAngleDeg ?? null,
    plotted_distance_ft: serialized?.hit_distance_ft ?? null,
    plotted_x: plottedX,
    plotted_y: plottedY,
    physics_distance_ft: physics?.distanceFeet ?? null,
    physics_hang_time_sec: physics?.hangTimeSec ?? null,
    physics_x: physicsSpot?.x ?? null,
    physics_y: physicsSpot?.y ?? null,
    // Only meaningful when the plotted spot is a real observation: it is the
    // gap between what was measured and what the physics model would have
    // guessed, which is the calibration signal for the model itself.
    physics_vs_plotted_distance_ft: physics && serialized?.hit_distance_ft != null
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
    batterName,
    inning: state.inning,
    isTop: state.isTop,
    outsBeforePa: state.outs,
    countSeen: false,
    lastCount: { balls: 0, strikes: 0 },
    pendingPitchType: null,
    pendingStarPitch: false,
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
    count_balls_before: before.balls,
    count_strikes_before: before.strikes,
    count_balls_after: after.balls,
    count_strikes_after: after.strikes,
  })
  pa.pendingStarPitch = false
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
  if (pa.pendingTriplePlay) pa.result = 'TP'
  else if (pa.pendingDoublePlay) pa.result = 'DP'
}

function fieldingPosition(state, fielderName, pitcherName) {
  for (const alignment of Object.values(state.alignments)) {
    if (!alignment.batting.includes(pitcherName)) continue
    const position = Object.entries(alignment.fielding).find(([, name]) => name === fielderName)?.[0]
    if (position) return TRACKER_POSITION_NUMBERS[position] ?? null
  }
  return null
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

function normalizedResult(pa) {
  let result = pa.result
  if (!result && shouldClassifyTrackerFielderChoice(pa)) result = 'FC'
  if (result === 'FO' && pa.battedBallTrajectory === 'L') result = 'LO'
  const error = shouldChargeTrackerBobbleError({ bobbleFielderName: pa.bobbleFielderName, result })
  if (error && ['1B', '2B', '3B'].includes(result)) result = 'ROE'
  const isBunt = isTrackerBuntedBall(pa.advancedBattedBall)
  if (
    result === 'FO'
    && !isBunt
    && pa.outsBeforePa < 2
    && pa.runEvents.some((run) => run.scorerName !== pa.batterName)
  ) result = 'SF'
  if (shouldClassifyTrackerSacrificeBunt({
    isBunt,
    result,
    outsBeforePa: pa.outsBeforePa,
    hasRunnerOn: Boolean(pa.runnersBefore.first || pa.runnersBefore.second || pa.runnersBefore.third),
  })) result = 'SH'
  return result
}

function serializePa(state, pa, runnerAssignments = pa.exactRunnerAssignments || null) {
  if (!pa) return null
  const result = normalizedResult(pa)
  const isError = shouldChargeTrackerBobbleError({ bobbleFielderName: pa.bobbleFielderName, result: pa.result })
  const errorPosition = isError ? fieldingPosition(state, pa.bobbleFielderName, pa.pitcherName) : null
  const chainNames = [...pa.assistFielderNames, pa.putoutFielderName].filter(Boolean)
  const chainPositions = chainNames.map((name) => fieldingPosition(state, name, pa.pitcherName)).filter((value) => value != null)
  let hitNotation = chainPositions.length
    ? `${pa.battedBallTrajectory || (result === 'FO' ? 'F' : result === 'LO' ? 'L' : 'G')}${chainPositions.join('-')}`
    : null
  let errorNotation = null
  if (isError && errorPosition != null) {
    errorNotation = assembleErrorNotation(pa.battedBallTrajectory || 'G', [errorPosition], errorPosition)
    hitNotation = errorNotation
  }
  const outsOnPlay = resultOuts(result, pa.observedPutouts)
  const decisivePitch = pa.pitches.at(-1)
  const batterRun = pa.runEvents.find((run) => run.scorerName === pa.batterName)
  return {
    preview_only: true,
    saved_to_database: false,
    pa_number: pa.localPaNumber,
    inning: pa.inning,
    half: pa.isTop ? 'top' : 'bottom',
    batter_name: pa.batterName,
    pitcher_name: pa.pitcherName,
    result,
    outs_on_play: outsOnPlay,
    rbi: pa.rbi,
    run_scored: Boolean(batterRun) || result === 'HR' || result === 'IPHR',
    is_official_ab: result ? !['BB', 'HBP', 'SF', 'SH'].includes(result) : null,
    is_earned_run: batterRun ? batterRun.earnedRun === true : !isError,
    runner_on_first_before: Boolean(pa.runnersBefore.first),
    runner_on_second_before: Boolean(pa.runnersBefore.second),
    runner_on_third_before: Boolean(pa.runnersBefore.third),
    runners_before: { ...pa.runnersBefore },
    runner_assignments: runnerAssignments,
    trajectory: pa.battedBallTrajectory,
    // Preview-only: the production bridge records a bunt through `trajectory`
    // ('B'), the same code the At-Bat editor uses, because plate_appearances
    // has no bunt column of its own.
    is_bunt: isTrackerBuntedBall(pa.advancedBattedBall),
    hit_notation: hitNotation,
    fielder_choice_out: result === 'FC',
    is_error: isError,
    error_position: errorPosition,
    error_character: isError ? pa.bobbleFielderName : null,
    error_player: null,
    error_notation: errorNotation,
    is_nice_play: false,
    star_hit_used: Boolean(pa.starHitUsed),
    star_pitch_used: Boolean(decisivePitch?.is_star_pitch),
    star_pitch_successful: Boolean(decisivePitch?.is_star_pitch && outsOnPlay > 0),
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
    ...trackerBattedBallPaFields(pa.advancedBattedBall, { stadiumKey: state.stadiumKey }),
    ...trackerFieldedBallPaFields(pa.advancedFielding, { stadiumKey: state.stadiumKey }),
    pitches: pa.pitches.map((pitch) => ({ ...pitch })),
    runs_scored: pa.runEvents.map((run) => ({
      scoring_character_name: run.scorerName,
      charged_to_pitcher_name: run.chargedToPitcherName || pa.pitcherName,
      is_earned_run: run.earnedRun === true,
    })),
    fielding_events: {
      assists: [...pa.assistFielderNames],
      putouts: pa.observedPutouts.map(({ fielderName, runnerName }) => ({ fielderName, runnerName })),
      bobble: pa.bobbleFielderName,
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

export function createTrackerPreviewState() {
  return {
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
  }
}

// The preview is deliberately not a recording: the at-bats it holds live only
// as long as the tracker that produced them. Once that process is gone the
// session is over, so everything it accumulated goes with it.
export function clearTrackerPreviewAtBats(state) {
  state.current = null
  state.completedBuffers = []
  state.latestCompletedBuffer = null
  state.latestCompleted = null
  state.sessionAtBats = []
  state.localPaNumber = 0
  state.gamePitchNumber = 0
  state.revision += 1
  return state
}

export function applyTrackerPreviewMessage(state, message) {
  const clean = String(message || '').trim()
  if (!clean) return state
  state.connected = true
  state.trackerStatus = 'receiving tracker output'
  state.lastMessageAt = new Date().toISOString()
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
    return state
  }
  if ((match = clean.match(/^(\d+)\s+outs?$/i))) {
    state.outs = Number(match[1])
    return state
  }
  if ((match = clean.match(/^(.+?)\s+vs\.\s+(.+)$/)) && !clean.includes(' @ ')) {
    if (state.current && paHasActivity(state.current)) {
      state.latestCompletedBuffer = state.current
      state.completedBuffers.push(state.current)
      state.latestCompleted = serializePaWithProjection(state, state.current)
      retainSessionAtBat(state, state.latestCompleted)
      state.revision += 1
    }
    state.current = freshPa(state, match[1].trim(), match[2].trim())
    return state
  }

  const pa = state.current
  if (!pa) return state
  pa.messages.push(clean)

  const runner = parseTrackerRunnerMessage(clean)
  if (runner) {
    pa.runnersBefore[runner.base] = runner.characterName
    return state
  }
  if ((match = clean.match(/^Count:\s*(\d)-(\d)$/i))) {
    const next = { balls: Number(match[1]), strikes: Number(match[2]) }
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
  if (/^Foul ball!$/i.test(clean)) { pa.pendingPitchType = 'foul'; return state }
  if (/^Fair ball!$/i.test(clean)) { ensureContactPitch(state, pa); return state }

  if (clean.startsWith(PITCH_PROVISIONAL_PREFIX)) {
    applyPitchTelemetry(pa, parseTrackerPitchProvisionalMessage(clean))
    return state
  }

  const hbpBatter = parseTrackerHitByPitchMessage(clean)
  if (hbpBatter === pa.batterName) {
    pushPitch(state, pa, 'hbp')
    pa.result = 'HBP'
    return state
  }
  if (clean.startsWith('[TRACKER_BATTED_BALL_PROVISIONAL]')) {
    const record = parseTrackerBattedBallMessage(clean)
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
  if (clean.startsWith('[TRACKER_BALL_FIELDED_PROVISIONAL]')) {
    const record = parseTrackerFieldedBallMessage(clean)
    if (record) applyTrackerFieldedBallToBuffer(pa, record)
    return state
  }
  if (/^Double play!$/i.test(clean)) {
    if (['GO', 'FO', 'LO'].includes(pa.result)) pa.result = 'DP'
    else pa.pendingDoublePlay = true
    return state
  }
  if (/^Triple play!$/i.test(clean)) {
    if (['GO', 'FO', 'LO'].includes(pa.result)) pa.result = 'TP'
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
    if (!pa.observedPutouts.some((entry) => entry.fielderName === putout.fielderName && entry.runnerName === putout.runnerName)) {
      pa.observedPutouts.push(putout)
    }
    pa.putoutFielderName = putout.fielderName
    if (!pa.result && putout.runnerName === pa.batterName) {
      ensureContactPitch(state, pa)
      pa.result = 'GO'
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
  if ((match = clean.match(/^(.+?)\s+used a star swing!$/i)) && match[1].trim() === pa.batterName) {
    pa.starHitUsed = true
    return state
  }
  if (!pa.result) {
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?single!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = '1B'; return state }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?double!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = '2B'; return state }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?triple!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = '3B'; return state }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?inside the park home run!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = 'IPHR'; return state }
    if ((match = clean.match(/^(.+?)\s+hits an?\s+.*(?:homer|home run).*off of\s+.+!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = 'HR'; return state }
    if ((match = clean.match(/^.+?\s+struck out\s+(.+?)!$/i)) && match[1].trim() === pa.batterName) {
      ensureStrikeoutPitch(state, pa)
      pa.result = 'K'
      return state
    }
  }
  if ((match = clean.match(/^(.+?)\s+recorded (\d+) RBI!$/i)) && match[1].trim() === pa.batterName) {
    pa.rbi = Number(match[2])
    return state
  }
  if ((match = clean.match(/^(.+?)\s+recorded a run!$/i))) {
    pa.runEvents.push({ scorerName: match[1].trim(), chargedToPitcherName: null, earnedRun: false })
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
function atBatIndexEntry(pa, { isCurrent = false, stadiumKey = null } = {}) {
  // Enough batted-ball detail to plot the whole session on one spray chart.
  // Deliberately only the position and the few numbers a marker's tooltip
  // shows -- this list is fetched on every poll, so it stays an index rather
  // than turning into a second copy of every at-bat.
  const batted = trackerBattedBallPaFields(pa.advancedBattedBall, { stadiumKey })
  return {
    pa_number: pa.localPaNumber,
    batter_name: pa.batterName,
    pitcher_name: pa.pitcherName,
    inning: pa.inning,
    half: pa.isTop ? 'top' : 'bottom',
    result: normalizedResult(pa),
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
    hit_world_z: batted.hit_world_z ?? null,
    hit_distance_ft: batted.hit_distance_ft ?? null,
    hit_angle_deg: batted.hit_angle_deg ?? null,
    exit_velocity_mph: batted.exit_velocity_mph ?? null,
    launch_angle_deg: batted.launch_angle_deg ?? null,
  }
}

// selectedPaNumber pages back to an earlier at-bat in this session; omitting it
// keeps the default live behaviour of following whatever is happening now.
export function trackerPreviewSnapshot(state, { selectedPaNumber = null } = {}) {
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
  const atBats = [
    ...state.completedBuffers.map((buffer) => atBatIndexEntry(buffer, { stadiumKey: state.stadiumKey })),
    ...(current ? [atBatIndexEntry(state.current, { isCurrent: true, stadiumKey: state.stadiumKey })] : []),
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
  const display = selected || current || state.latestCompleted
  return {
    mode: 'local_preview',
    writes_enabled: false,
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
    at_bats: atBats,
    at_bat_count: atBats.length,
    selected_pa_number: display?.pa_number ?? null,
    display_at_bat: display,
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
