import { estimateTrackerWallDistance, projectTrackerFieldSpot } from './tracker_field_projection.mjs'

export const TRACKER_BATTED_BALL_MARKER = '[TRACKER_BATTED_BALL_PROVISIONAL]'
export const TRACKER_FIELDED_BALL_MARKER = '[TRACKER_BALL_FIELDED_PROVISIONAL]'

const TRACKER_BATTED_BALL_ENDPOINTS = new Set(['landing', 'catch', 'foul'])
const TRACKER_BATTED_BALL_SIDES = new Set(['third_base', 'center', 'first_base'])

function finiteTrackerNumber(value) {
  if (value == null || value === '' || value === 'none') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function trackerInteger(value) {
  const number = finiteTrackerNumber(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

// The experimental tracker emits one pipe-delimited record per contact. Keep
// parsing isolated here so malformed or partial diagnostic output can never be
// mistaken for data that is safe to write to a plate appearance.
export function parseTrackerBattedBallMessage(message) {
  const normalized = String(message || '').trim()
  const prefix = `${TRACKER_BATTED_BALL_MARKER} `
  if (!normalized.startsWith(prefix)) return null

  const fields = {}
  for (const part of normalized.slice(prefix.length).split('|')) {
    const separator = part.indexOf('=')
    if (separator <= 0) return null
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (!key || Object.hasOwn(fields, key)) return null
    fields[key] = value
  }

  const contactSeq = trackerInteger(fields.contact_seq)
  const endpoint = fields.endpoint
  const endpointSeq = trackerInteger(fields.endpoint_seq)
  const exitVelocityMph = finiteTrackerNumber(fields.exit_speed_mph)
  const launchAngleDeg = finiteTrackerNumber(fields.launch_degrees)
  const sprayAngleDeg = finiteTrackerNumber(fields.spray_degrees)
  const x = finiteTrackerNumber(fields.x)
  const y = finiteTrackerNumber(fields.y)
  const z = finiteTrackerNumber(fields.z)
  const distanceFeet = finiteTrackerNumber(fields.distance_feet)
  const flightUpdates = trackerInteger(fields.flight_updates)
  const emittedHangTimeSec = finiteTrackerNumber(fields.hang_time_seconds)
  const sampledUpdatesSec = finiteTrackerNumber(fields.sampled_updates_seconds)
  const wallTimeSec = finiteTrackerNumber(fields.wall_time_seconds)
  // v10 emitted update-count time as hang_time_seconds and the continuous
  // clock separately as wall_time_seconds. Current records use the continuous
  // value as hang time and name update-count time explicitly. Accept both so
  // saved v10 logs remain replayable without writing the truncated value.
  const hangTimeSec = wallTimeSec ?? emittedHangTimeSec
  const diagnosticSampledUpdatesSec = sampledUpdatesSec
    ?? (wallTimeSec != null ? emittedHangTimeSec : null)
  const isFoul = endpoint === 'foul'
  const hasFlightTiming = ['flight_updates', 'sampled_updates_seconds', 'hang_time_seconds', 'wall_time_seconds']
    .some((key) => Object.hasOwn(fields, key))

  if (
    contactSeq == null
    || !fields.batter
    || !fields.pitcher
    || exitVelocityMph == null
    || launchAngleDeg == null
    || sprayAngleDeg == null
    || !TRACKER_BATTED_BALL_SIDES.has(fields.side)
    || !TRACKER_BATTED_BALL_ENDPOINTS.has(endpoint)
    || !fields.endpoint_status
  ) return null

  // Fair/caught contacts must have a complete endpoint. Fouls deliberately
  // use `none` for endpoint coordinates and distance because they do not
  // become the batted-ball location stored on the completed PA.
  if (isFoul) {
    if (
      endpointSeq != null || x != null || y != null || z != null || distanceFeet != null
      || flightUpdates != null || hangTimeSec != null || diagnosticSampledUpdatesSec != null || wallTimeSec != null
    ) return null
  } else if (endpointSeq == null || x == null || y == null || z == null || distanceFeet == null) {
    return null
  } else if (
    hasFlightTiming
    && (flightUpdates == null || hangTimeSec == null || diagnosticSampledUpdatesSec == null)
  ) {
    return null
  }

  return {
    contactSeq,
    batterName: fields.batter,
    pitcherName: fields.pitcher,
    exitVelocityMph,
    launchAngleDeg,
    sprayAngleDeg,
    spraySide: fields.side,
    endpoint,
    endpointStatus: fields.endpoint_status,
    endpointSeq,
    x,
    y,
    z,
    distanceFeet,
    flightUpdates,
    hangTimeSec,
    sampledUpdatesSec: diagnosticSampledUpdatesSec,
    wallTimeSec,
  }
}

export function parseTrackerFieldedBallMessage(message) {
  const normalized = String(message || '').trim()
  const prefix = `${TRACKER_FIELDED_BALL_MARKER} `
  if (!normalized.startsWith(prefix)) return null

  const fields = {}
  for (const part of normalized.slice(prefix.length).split('|')) {
    const separator = part.indexOf('=')
    if (separator <= 0) return null
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (!key || Object.hasOwn(fields, key)) return null
    fields[key] = value
  }

  const record = {
    contactSeq: trackerInteger(fields.contact_seq),
    batterName: fields.batter,
    pitcherName: fields.pitcher,
    fieldedSeq: trackerInteger(fields.fielded_seq),
    timeNs: trackerInteger(fields.time_ns),
    x: finiteTrackerNumber(fields.x),
    y: finiteTrackerNumber(fields.y),
    z: finiteTrackerNumber(fields.z),
    distanceFeet: finiteTrackerNumber(fields.distance_feet),
    sprayAngleDeg: finiteTrackerNumber(fields.spray_degrees),
    fieldingTimeSec: finiteTrackerNumber(fields.fielding_time_seconds),
    source: fields.source,
  }
  if (
    record.contactSeq == null
    || !record.batterName
    || !record.pitcherName
    || record.fieldedSeq == null
    || record.timeNs == null
    || record.x == null
    || record.y == null
    || record.z == null
    || record.distanceFeet == null
    || record.sprayAngleDeg == null
    || record.fieldingTimeSec == null
    || !record.source
  ) return null
  return record
}

export function trackerBattedBallMatchesMatchup(record, { batterName, pitcherName } = {}) {
  if (!record) return false
  const normalizeName = (value) => String(value || '').trim().toLocaleLowerCase()
  return normalizeName(record.batterName) === normalizeName(batterName)
    && normalizeName(record.pitcherName) === normalizeName(pitcherName)
}

export function applyTrackerBattedBallToBuffer(buffer, record) {
  if (!buffer || !trackerBattedBallMatchesMatchup(record, buffer)) return false
  if (record.endpoint !== 'foul') {
    buffer.advancedBattedBall = record
    buffer.battedBallTrajectory = trackerBattedBallTrajectory(record)
  }
  return true
}

// The editor stores G/L/F, while the tracker gives us the physical launch
// angle and whether the first endpoint was a catch or a landing. These are
// the conventional batted-ball boundaries used throughout baseball data:
// ground ball below 10 degrees, line drive from 10 through 24.9, and fly ball
// at 25+. A ball caught before touching down is necessarily airborne, so a
// sub-25-degree catch is a liner instead of being mislabeled a grounder.
export function trackerBattedBallTrajectory(record) {
  const angle = Number(record?.launchAngleDeg)
  if (!Number.isFinite(angle) || record?.endpoint === 'foul') return null
  if (record?.endpoint === 'catch') return angle < 25 ? 'L' : 'F'
  if (angle < 10) return 'G'
  if (angle < 25) return 'L'
  return 'F'
}

export function trackerCaughtBallResult(record) {
  if (record?.endpoint !== 'catch') return 'FO'
  return trackerBattedBallTrajectory(record) === 'L' ? 'LO' : 'FO'
}

export function applyTrackerFieldedBallToBuffer(buffer, record) {
  if (!buffer || !trackerBattedBallMatchesMatchup(record, buffer)) return false
  buffer.advancedFielding = record
  return true
}

// The site already stores these four measurements directly on each PA. A
// foul is still useful diagnostic data, but it must not populate or overwrite
// the eventual fair/caught contact for that plate appearance.
export function trackerBattedBallPaFields(record, { stadiumKey = null } = {}) {
  if (!record || (record.endpoint !== 'landing' && record.endpoint !== 'catch')) return {}
  const fields = {
    exit_velocity_mph: record.exitVelocityMph,
    launch_angle_deg: record.launchAngleDeg,
    hit_distance_ft: record.distanceFeet,
    hit_angle_deg: record.sprayAngleDeg,
  }
  if (record.hangTimeSec != null) fields.hang_time_sec = record.hangTimeSec
  if (stadiumKey) {
    fields.hit_stadium_key = stadiumKey
    const spot = projectTrackerFieldSpot(record.distanceFeet, record.sprayAngleDeg, stadiumKey)
    if (spot) {
      fields.hit_x = spot.x
      fields.hit_y = spot.y
      if (record.endpoint === 'catch') {
        fields.fielded_x = spot.x
        fields.fielded_y = spot.y
      }
    }
  }
  return fields
}

const TRACKER_ROBBED_HR_WALL_MARGIN_FT = 15

// A confirmed Buddy Jump is the tracker's explicit wall-catch signal. Pair it
// with the editor's existing 15-foot fence-margin rule; ordinary catches near
// the warning track remain unmarked instead of being guessed as robberies.
export function isTrackerRobbedHomeRun({ record, isBuddyJump, stadiumKey } = {}) {
  if (!isBuddyJump || record?.endpoint !== 'catch' || !stadiumKey) return false
  const wallDistance = estimateTrackerWallDistance(record.sprayAngleDeg, stadiumKey)
  return wallDistance != null
    && Number(record.distanceFeet) >= wallDistance - TRACKER_ROBBED_HR_WALL_MARGIN_FT
}

export function trackerFieldedBallPaFields(record, { stadiumKey = null } = {}) {
  if (!record || !stadiumKey) return {}
  const spot = projectTrackerFieldSpot(record.distanceFeet, record.sprayAngleDeg, stadiumKey)
  return spot ? { fielded_x: spot.x, fielded_y: spot.y } : {}
}

export function parseTrackerPutoutMessage(message) {
  const match = String(message || '').match(/^(.+?)\s+put\s+(.+?)\s+out!$/i)
  if (!match) return null

  return {
    fielderName: match[1].trim(),
    runnerName: match[2].trim(),
  }
}

export function isTrackerMissingPlayerName(name) {
  return /^No Player$/i.test(String(name || '').trim())
}

export function shouldCreditTrackerPutout({ runnerName, batterName, result }) {
  if (runnerName === batterName) return true
  return result === 'FO' && isTrackerMissingPlayerName(runnerName)
}

// A putout can retire a baserunner while the batter still records a hit. Keep
// every distinct tracker putout instead of only retaining batter outs so the
// PA can carry the real outs_on_play and the named fielder still gets credit.
export function captureTrackerPutout(buffer, message) {
  const putout = typeof message === 'string' ? parseTrackerPutoutMessage(message) : message
  if (!buffer || !putout) return null

  const key = `${putout.fielderName}\u0000${putout.runnerName}`.toLowerCase()
  if (!Array.isArray(buffer.observedPutouts)) buffer.observedPutouts = []
  if (!buffer.observedPutouts.some((entry) => entry.key === key)) {
    buffer.observedPutouts.push({ ...putout, key })
  }
  buffer.putoutFielderName = putout.fielderName
  return putout
}

export function trackerOutsOnPlay(buffer, resultBasedOuts = 0) {
  return Math.max(Number(resultBasedOuts || 0), buffer?.observedPutouts?.length || 0)
}

export function isTrackerReplayMessage(message) {
  return /^(?:Stat tracking paused for replay\.|Replay ended\. Resuming stat tracking\.)$/i
    .test(String(message || '').trim())
}

export function parseTrackerInningStateMessage(message) {
  const normalized = String(message || '').trim()
  let match
  if ((match = normalized.match(/^Next:\s*(Top|Bottom) of inning (\d+)$/i))) {
    return {
      type: 'next_half',
      inning: Number(match[2]),
      isTop: /^Top$/i.test(match[1]),
      outs: 0,
    }
  }
  if ((match = normalized.match(/^(\d+)\s+outs?$/i))) {
    return { type: 'outs', outs: Number(match[1]) }
  }
  if (/^Changing sides!$/i.test(normalized)) {
    return { type: 'side_change', outs: 0 }
  }
  return null
}

export function applyTrackerInningStateMessage(state, message) {
  const parsed = parseTrackerInningStateMessage(message)
  if (!state || !parsed) return null
  if (parsed.inning != null) state.inning = parsed.inning
  if (parsed.isTop != null) state.isTop = parsed.isTop
  state.outs = parsed.outs
  state.inningStateSource = 'tracker'
  return parsed
}

// PA replay is a useful startup fallback, but it cannot be authoritative once
// the tracker has explicitly reported the half inning and outs. In particular,
// an unclassified baserunner out can leave PA totals one out short and would
// otherwise regress a correct "Top 2 / 0 outs" feed to "Bottom 1 / 2 outs".
export function applyPaDerivedTrackerInningState(state, totalOuts, {
  hasExplicitTrackerState = false,
} = {}) {
  if (!state || hasExplicitTrackerState) return { applied: false, halfChanged: false }

  const safeOuts = Math.max(0, Number(totalOuts || 0))
  const halfInning = Math.floor(safeOuts / 3)
  const priorHalfInning = ((Math.max(1, Number(state.inning || 1)) - 1) * 2) + (state.isTop === false ? 1 : 0)
  state.outs = safeOuts % 3
  state.inning = Math.floor(halfInning / 2) + 1
  state.isTop = halfInning % 2 === 0
  state.inningStateSource = 'plate_appearances'
  return { applied: true, halfChanged: halfInning !== priorHalfInning }
}

export function parseTrackerStarPitchMessage(message) {
  const match = String(message || '').match(/^(.+?)\s+used a star pitch!$/i)
  return match ? match[1].trim() : null
}

// The announcement arrives before the result/count lines for that pitch.
// Keep it pending until pushPitch consumes it so intervening messages such as
// "Strike 2." or "Game paused..." cannot detach the star flag from the pitch.
export function markPendingTrackerStarPitch(buffer, message) {
  if (!buffer) return false
  const pitcherName = parseTrackerStarPitchMessage(message)
  if (!pitcherName || pitcherName !== buffer.pitcherName) return false
  buffer.pendingStarPitch = true
  return true
}

export function consumeTrackerPitch(buffer, pitch) {
  const taggedPitch = { ...pitch, isStarPitch: Boolean(buffer?.pendingStarPitch) }
  if (buffer) buffer.pendingStarPitch = false
  return taggedPitch
}

export function trackerPitchStatFields(pitch) {
  return {
    is_star_pitch: Boolean(pitch?.isStarPitch),
    result: pitch?.type,
    count_balls_before: pitch?.before?.balls,
    count_strikes_before: pitch?.before?.strikes,
    count_balls_after: pitch?.after?.balls,
    count_strikes_after: pitch?.after?.strikes,
    pitch_type: pitch?.pitchType || null,
  }
}

export function numberTrackerPitches(pitches = [], lastGamePitchNumber = 0) {
  let next = Number(lastGamePitchNumber || 0)
  return pitches.map((pitch, index) => ({
    ...pitch,
    pitch_number_pa: index + 1,
    pitch_number_game: ++next,
  }))
}

function trackerRunnerKey(runner) {
  return runner?.characterId == null || runner?.playerId == null
    ? null
    : `${runner.characterId}:${runner.playerId}`
}

// The next matchup's authoritative base snapshot is the cleanest description
// of where every survivor from the prior play actually ended up. Combine it
// with explicit run and putout messages to resolve every prior runner without
// applying default one-base/two-base advancement guesses.
export function buildExactTrackerRunnerAssignments({
  runnersBefore = {},
  batter = null,
  nextRunners = {},
  scoringRunnerKeys = new Set(),
  outRunnerKeys = new Set(),
  batterOut = false,
} = {}) {
  const nextBaseByKey = new Map()
  for (const base of ['first', 'second', 'third']) {
    const key = trackerRunnerKey(nextRunners[base])
    if (key) nextBaseByKey.set(key, base)
  }
  const entries = [
    { id: 'batter', runner: batter, origin: 'plate', isBatter: true },
    ...['first', 'second', 'third'].map((base) => ({
      id: base, runner: runnersBefore[base], origin: base, isBatter: false,
    })),
  ].filter((entry) => trackerRunnerKey(entry.runner))

  const assignments = []
  for (const entry of entries) {
    const key = trackerRunnerKey(entry.runner)
    let destination = nextBaseByKey.get(key) || null
    if (!destination && scoringRunnerKeys.has(key)) destination = 'home'
    if (!destination && outRunnerKeys.has(key)) destination = 'out'
    if (!destination && entry.isBatter && batterOut) destination = 'out'
    if (!destination) return null
    assignments.push({ ...entry, destination })
  }
  return assignments
}

export function trackerStarPitchPaFlags(pitches = [], outsOnPlay = 0) {
  const decisivePitch = pitches[pitches.length - 1]
  const starPitchUsed = Boolean(decisivePitch?.isStarPitch)
  return {
    starPitchUsed,
    starPitchSuccessful: starPitchUsed && Number(outsOnPlay) > 0,
  }
}

// A sacrifice fly is scored automatically by rule, not by scorer judgment: any
// caught fly ball that lets a runner other than the batter score is a sac fly,
// full stop — no "was it intentional" call involved (that's what separates it
// from a sacrifice bunt, which the tracker's log gives no way to detect at
// all, since it never distinguishes a bunt from any other batted ball).
// Requiring fewer than 2 outs before the play guards against crediting a run
// that couldn't actually have scored: a fly out that is itself the third out
// of the inning never allows a run to cross the plate under the rules, so if
// the tracker's replay ever attached a run to that play it would be a replay
// error, not a real sac fly, and this must not paper over it.
export function shouldReclassifyTrackerFlyOutAsSacFly({ result, outsBeforePa, scoredNonBatterRunner }) {
  return result === 'FO' && Boolean(scoredNonBatterRunner) && Number(outsBeforePa || 0) < 2
}

// The tracker reports a bobble as a fielding event, not an official scoring
// decision. Only turn it into an error when the batter actually reaches on the
// batted ball. If another fielder recovers the bobble and completes the out,
// the play remains an out and no error is charged.
const TRACKER_BATTED_BALL_SAFE_RESULTS = new Set(['1B', '2B', '3B', 'ROE', 'FC'])

export function shouldChargeTrackerBobbleError({ bobbleFielderName, result }) {
  return Boolean(String(bobbleFielderName || '').trim()) && TRACKER_BATTED_BALL_SAFE_RESULTS.has(result)
}

export function parseTrackerHitByPitchMessage(message) {
  const match = String(message || '').match(/^(.+?)\s+was hit by a pitch!$/i)
  return match ? match[1].trim() : null
}

// At PA finalization, a named non-batter putout plus fair contact and no hit
// or batter-out result is positive evidence of a fielder's choice. A later
// single/double/etc. announcement always wins because this helper is only
// consulted after every line for the PA has already been consumed.
export function shouldClassifyTrackerFielderChoice(buffer) {
  if (!buffer || buffer.result || !buffer.contactRecorded) return false
  return Boolean(buffer.observedPutouts?.some((putout) => (
    !isTrackerMissingPlayerName(putout.runnerName)
    && putout.runnerName !== buffer.batterName
  )))
}
