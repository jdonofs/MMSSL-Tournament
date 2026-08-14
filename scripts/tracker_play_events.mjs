import { estimateTrackerWallDistance, projectTrackerBattedBallDistanceFeet, projectTrackerFieldSpot } from './tracker_field_projection.mjs'
import { FEET_PER_UNIT, HOME_PLATE, polarToWorld } from '../src/utils/parkGeometry.js'

export const TRACKER_BATTED_BALL_MARKER = '[TRACKER_BATTED_BALL_PROVISIONAL]'
export const TRACKER_FIELDED_BALL_MARKER = '[TRACKER_BALL_FIELDED_PROVISIONAL]'
export const TRACKER_PITCH_PROVISIONAL_MARKER = '[TRACKER_PITCH_PROVISIONAL]'

// 'unresolved' is a contact whose exit velo/launch angle/spray were measured
// but whose landing was never seen (see emit_batted_ball_diagnostic in
// patch_tracker_advanced_stats.py) — typically a home run hit deep enough to
// leave tracked play before landing. trackerBattedBallPaFields projects a
// distance/hang-time for these from the measured launch physics instead of
// leaving the batted-ball fields empty.
const TRACKER_BATTED_BALL_ENDPOINTS = new Set(['landing', 'catch', 'foul', 'unresolved'])
const TRACKER_BATTED_BALL_SIDES = new Set(['third_base', 'center', 'first_base'])

const ORDINARY_PITCH_TYPES = new Set(['fastball', 'curveball', 'changeup'])
// Movement classifier v1 is based on repeated, labeled test sequences across
// three pitchers. Ordinary fastballs stayed under about 0.14 horizontal chord
// deviation even with natural per-character wobble; deliberate curves started
// around 0.23 and up. Changeups showed at least ~2.0 vertical chord deviation
// regardless of horizontal steering, so vertical is checked first. The
// flight-completeness gate uses the true 3D straight-line distance (not a
// forward-only component) because steep changeups legitimately spend much of
// their travel on the vertical axis and would otherwise be under-measured
// despite a full, complete flight. See tests/tracker-preview-state.test.mjs.
const CHANGEUP_VERTICAL_THRESHOLD_UNITS = 1
const CURVE_HORIZONTAL_THRESHOLD_UNITS = 0.15
const MINIMUM_CLASSIFIER_SAMPLES = 20
const MINIMUM_CLASSIFIER_DIRECT_DISTANCE_UNITS = 12

function finiteTrackerNumber(value) {
  if (value == null || value === '' || value === 'none') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseTrackerPitchCount(value) {
  const match = String(value || '').match(/^(\d+)-(\d+)$/)
  return match ? { balls: Number(match[1]), strikes: Number(match[2]) } : null
}

// Classifies a pitch's shape from its measured ball-flight telemetry. Returns
// null (unresolved) for star pitches, too-short samples, or abbreviated
// flights — callers should leave pitch_type unset in those cases rather than
// guess.
export function classifyPitchMovement(telemetry) {
  if (!telemetry || telemetry.isStarPitch) return null
  if (
    Number(telemetry.sampleCount) < MINIMUM_CLASSIFIER_SAMPLES
    || Number(telemetry.directDistanceUnits) < MINIMUM_CLASSIFIER_DIRECT_DISTANCE_UNITS
  ) return null
  const horizontal = Math.abs(Number(telemetry.horizontalChordDeviationUnits))
  const vertical = Math.abs(Number(telemetry.verticalChordDeviationUnits))
  if (!Number.isFinite(horizontal) || !Number.isFinite(vertical)) return null
  if (vertical >= CHANGEUP_VERTICAL_THRESHOLD_UNITS) return 'changeup'
  if (horizontal >= CURVE_HORIZONTAL_THRESHOLD_UNITS) return 'curveball'
  return 'fastball'
}

// The experimental tracker emits one pipe-delimited record per measured pitch
// flight (start-of-throw to plate/terminal event), including the raw XYZ
// sample trail. Movement classification (see classifyPitchMovement) fills in
// pitch_type when the tracker itself doesn't report one.
export function parseTrackerPitchProvisionalMessage(message) {
  const clean = String(message || '').trim()
  const prefix = `${TRACKER_PITCH_PROVISIONAL_MARKER} `
  if (!clean.startsWith(prefix)) return null
  const fields = {}
  for (const part of clean.slice(prefix.length).trim().split('|')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    fields[part.slice(0, separator).trim()] = part.slice(separator + 1).trim()
  }
  if (!fields.status || !fields.terminal) return null
  const samples = String(fields.samples || '').split(';').filter(Boolean).map((sample) => {
    const [seq, timeNs, x, y, z] = sample.split(',').map(Number)
    if (![seq, timeNs, x, y, z].every(Number.isFinite)) return null
    return { seq, time_ns: timeNs, x, y, z }
  }).filter(Boolean)
  const record = {
    version: finiteTrackerNumber(fields.version),
    status: fields.status,
    pitchType: ORDINARY_PITCH_TYPES.has(fields.pitch_type) ? fields.pitch_type : null,
    classifier: fields.classifier || null,
    classifierStatus: fields.classifier_status || null,
    terminal: fields.terminal,
    pitchCounter: finiteTrackerNumber(fields.pitch_counter),
    pitcherName: fields.pitcher || null,
    batterName: fields.batter || null,
    isStarPitch: fields.is_star_pitch === 'true',
    gameStateStart: fields.game_state_start || null,
    countBefore: parseTrackerPitchCount(fields.count_before),
    countAfter: parseTrackerPitchCount(fields.count_after),
    startReason: fields.start_reason || null,
    startSeq: finiteTrackerNumber(fields.start_seq),
    endSeq: finiteTrackerNumber(fields.end_seq),
    startTimeNs: finiteTrackerNumber(fields.start_time_ns),
    endTimeNs: finiteTrackerNumber(fields.end_time_ns),
    start: fields.start_x == null ? null : {
      x: finiteTrackerNumber(fields.start_x), y: finiteTrackerNumber(fields.start_y), z: finiteTrackerNumber(fields.start_z),
    },
    end: fields.end_x == null ? null : {
      x: finiteTrackerNumber(fields.end_x), y: finiteTrackerNumber(fields.end_y), z: finiteTrackerNumber(fields.end_z),
    },
    sampleCount: finiteTrackerNumber(fields.sample_count),
    elapsedSeconds: finiteTrackerNumber(fields.elapsed_seconds),
    pathDistanceUnits: finiteTrackerNumber(fields.path_distance_units),
    pathDistanceFeet: finiteTrackerNumber(fields.path_distance_feet),
    directDistanceUnits: finiteTrackerNumber(fields.direct_distance_units),
    speedMph: finiteTrackerNumber(fields.speed_mph),
    horizontalDeltaUnits: finiteTrackerNumber(fields.horizontal_delta_units),
    verticalDeltaUnits: finiteTrackerNumber(fields.vertical_delta_units),
    forwardDeltaUnits: finiteTrackerNumber(fields.forward_delta_units),
    horizontalRangeUnits: finiteTrackerNumber(fields.horizontal_range_units),
    verticalRangeUnits: finiteTrackerNumber(fields.vertical_range_units),
    horizontalChordDeviationUnits: finiteTrackerNumber(fields.horizontal_chord_deviation_units),
    verticalChordDeviationUnits: finiteTrackerNumber(fields.vertical_chord_deviation_units),
    feetPerUnit: finiteTrackerNumber(fields.feet_per_unit),
    timingSource: fields.timing_source || null,
    samplesFormat: fields.samples_format || null,
    samples,
  }
  if (record.isStarPitch) record.pitchType = null
  else record.pitchType = record.pitchType || classifyPitchMovement(record)
  if (record.pitchType && !record.classifier) record.classifier = 'movement_v1_preview'
  if (record.pitchType && !record.classifierStatus) record.classifierStatus = 'classified'
  return record
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
  // Which feet distance_feet is in. Present only on builds new enough to say
  // so; without it the value's scale is unknowable and it must not be used for
  // positioning — see trackerBattedBallPaFields.
  const recordFeetPerUnit = finiteTrackerNumber(fields.feet_per_unit)
  // Present only on an unresolved contact whose distance came from the
  // tracker's last-frame extrapolation: where that extrapolation says the ball
  // would have come down, in the same game coordinates as a real endpoint.
  const projectedX = finiteTrackerNumber(fields.projected_x)
  const projectedZ = finiteTrackerNumber(fields.projected_z)
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
  const isUnresolved = endpoint === 'unresolved'
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

  // Fair/caught contacts must have a complete endpoint. A foul deliberately
  // uses `none` for coordinates, distance, and timing alike — it has no real
  // observed landing at all. An unresolved contact also has no real
  // coordinates and no real flight_updates/sampled_updates_seconds (both
  // require a real tracked endpoint sample to compute), but MAY carry a real
  // extrapolated distance_feet and hang_time_seconds (from the tracked
  // trajectory's last frame — see emit_batted_ball_diagnostic in
  // patch_tracker_advanced_stats.py) — neither is, itself, evidence of a
  // malformed record, so both are deliberately excluded from this check for
  // the unresolved case.
  if (isFoul) {
    if (
      endpointSeq != null || x != null || y != null || z != null || distanceFeet != null
      || flightUpdates != null || hangTimeSec != null || diagnosticSampledUpdatesSec != null || wallTimeSec != null
    ) return null
  } else if (isUnresolved) {
    if (
      endpointSeq != null || x != null || y != null || z != null
      || flightUpdates != null || diagnosticSampledUpdatesSec != null || wallTimeSec != null
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
    projectedX,
    projectedZ,
    distanceFeet,
    recordFeetPerUnit,
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

// The tracker never says "bunt", but the measured launch does: a bunt is
// deadened contact that leaves the bat far slower than any swing produces.
// 25 mph is the separating line — swung-at contact, even weak mishits, clears
// it comfortably.
export const TRACKER_BUNT_MAX_EXIT_VELOCITY_MPH = 25

export function isTrackerBuntedBall(record) {
  // A foul has no measurement to judge, and an unresolved endpoint means the
  // ball left tracked play entirely, which a bunt cannot do.
  if (!record || record.endpoint !== 'landing' && record.endpoint !== 'catch') return false
  const exitVelocity = Number(record.exitVelocityMph)
  return Number.isFinite(exitVelocity) && exitVelocity < TRACKER_BUNT_MAX_EXIT_VELOCITY_MPH
}

// The editor stores G/L/F/B, while the tracker gives us the physical launch
// angle and whether the first endpoint was a catch or a landing. These are
// the conventional batted-ball boundaries used throughout baseball data:
// ground ball below 10 degrees, line drive from 10 through 24.9, and fly ball
// at 25+. A ball caught before touching down is necessarily airborne, so a
// sub-25-degree catch is a liner instead of being mislabeled a grounder.
// A bunt is its own trajectory in the editor and outranks the angle buckets:
// a bunt rolling along the ground is recorded as a bunt, not a ground ball.
export function trackerBattedBallTrajectory(record) {
  const angle = Number(record?.launchAngleDeg)
  if (!Number.isFinite(angle) || record?.endpoint === 'foul') return null
  if (isTrackerBuntedBall(record)) return 'B'
  if (record?.endpoint === 'catch') return angle < 25 ? 'L' : 'F'
  if (angle < 10) return 'G'
  if (angle < 25) return 'L'
  return 'F'
}

// Scoring rule: a bunt that retires the batter while a runner is on base, with
// fewer than two outs, is a sacrifice hit — and, like a sacrifice fly, it is a
// rule rather than a judgment call. The batter's out is what the 'GO' result
// already represents (a bunt that retires a RUNNER instead is scored a
// fielder's choice by shouldClassifyTrackerFielderChoice, and a bunt the batter
// beats out stays a hit), so the remaining conditions are the runner and the
// out count. Whether that runner then advanced is not yet known when the play
// is recorded, and a bunt laid down with the batter thrown out is how a runner
// is moved up — treating it as the sacrifice it was called for is the correct
// default rather than leaving every sacrifice bunt as an ordinary ground out.
export function shouldClassifyTrackerSacrificeBunt({
  isBunt, result, outsBeforePa, hasRunnerOn,
} = {}) {
  if (!isBunt || !hasRunnerOn || result !== 'GO') return false
  return Number(outsBeforePa || 0) < 2
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
// the eventual fair/caught contact for that plate appearance. An unresolved
// endpoint (ball left tracked play before landing, e.g. a deep home run) has
// no real distance/hang time — those get a physics-projected estimate from
// the measured exit velocity/launch angle instead of staying empty.
// One definition of the scale, shared with the app rather than copied here.
//
// This used to be a local constant kept "in step" with the tracker executable's
// own copy, which is a promise no code can keep: the exe is a separate build
// artefact, so a rebuild that lags behind a scale change leaves the two feeds
// silently in different units. That is not hypothetical -- it produced
// distances 11.8% apart from the same batted ball.
//
// The tracker's job is to report the ball's raw coordinates, which are unit
// free and always correct. Converting those to feet is this side's job, so the
// scale lives in exactly one place and a stale exe cannot disagree with it.
export const TRACKER_FEET_PER_UNIT = FEET_PER_UNIT

// Distance from HOME PLATE, in feet, straight from the ball's coordinates.
//
// Two things this deliberately does not do. It does not use the tracker's own
// emitted distance_feet, which is computed inside the executable at whatever
// scale that build was compiled with — a rebuild lagging a scale change puts
// the two feeds 11.8% apart. And it does not measure from the world origin,
// which sits about 0.7 units beyond the plate and quietly adds a couple of
// feet to everything.
// hit_distance_ft is numeric(6,1); a raw float would be stored rounded anyway,
// so round here rather than letting the displayed and stored values differ.
function roundTrackerDistance(feet) {
  return feet == null || !Number.isFinite(feet) ? feet : Math.round(feet * 10) / 10
}

export function trackerDistanceFeetFromCoordinates(x, z) {
  const gameX = Number(x)
  const gameZ = Number(z)
  if (!Number.isFinite(gameX) || !Number.isFinite(gameZ)) return null
  const dx = gameX - HOME_PLATE.x
  const dz = gameZ - HOME_PLATE.z
  return Math.sqrt((dx * dx) + (dz * dz)) * FEET_PER_UNIT
}

// Straightaway centre field is -Z, so a tracked position is already everything
// needed to place a marker. Measured from home plate rather than the world
// origin, which sits about 0.7 units in front of it.
function plotFromGameCoordinates(x, z) {
  // Number(null) is 0, which is finite, so an absent coordinate would silently
  // resolve to "home plate, straight back" instead of falling through to the
  // next-best geometry.
  if (x == null || z == null) return null
  const gameX = Number(x)
  const gameZ = Number(z)
  if (!Number.isFinite(gameX) || !Number.isFinite(gameZ)) return null
  return {
    distanceFeet: trackerDistanceFeetFromCoordinates(gameX, gameZ),
    angleDeg: (Math.atan2(gameX - HOME_PLATE.x, -(gameZ - HOME_PLATE.z)) * 180) / Math.PI,
  }
}

// Spray angle is measured from two frames immediately after contact, so it is
// the direction the ball STARTED in — not where it ended up. Balls curve, and
// on a real tracked landing the two differed by 10 degrees, which puts the
// marker 40 feet from where the ball actually came down. So plot from the
// tracked coordinates whenever they exist: they are the position itself, with
// nothing left to infer. Spray angle remains the right value for the recorded
// hit_angle_deg stat, which is genuinely about launch direction.
export function trackerBattedBallPlotGeometry(record, fallbackDistanceFeet = null) {
  if (!record) return null
  const measured = plotFromGameCoordinates(record.x, record.z)
  if (measured) return { ...measured, source: 'endpoint_coordinates' }
  const projected = plotFromGameCoordinates(record.projectedX, record.projectedZ)
  if (projected) return { ...projected, source: 'projected_coordinates' }

  const distanceValue = fallbackDistanceFeet ?? record.distanceFeet
  if (distanceValue == null || record.sprayAngleDeg == null) return null
  const distanceFeet = Number(distanceValue)
  const angleDeg = Number(record.sprayAngleDeg)
  if (!Number.isFinite(distanceFeet) || !Number.isFinite(angleDeg)) return null
  return { distanceFeet, angleDeg, source: 'launch_spray_angle' }
}

export function trackerBattedBallPaFields(record, { stadiumKey = null } = {}) {
  if (!record || (record.endpoint !== 'landing' && record.endpoint !== 'catch' && record.endpoint !== 'unresolved')) return {}
  const projected = record.endpoint === 'unresolved'
    ? projectTrackerBattedBallDistanceFeet(record.exitVelocityMph, record.launchAngleDeg)
    : null
  // The ball's own coordinates, kept as measured. Every position downstream can
  // be derived from these exactly against the measured park geometry, whereas
  // hit_x/hit_y below are percentages on a stadium screenshot and hit_angle_deg
  // is the launch direction rather than where the ball came down. A contact
  // whose endpoint never resolved still has the tracker's extrapolated landing
  // point, which is a real estimate of where it would have come down.
  // For a ball that outran tracking, direction comes from the LAUNCH spray
  // angle and distance from the calibrated fit — not from the tracker's
  // extrapolated coordinates.
  //
  // That looks backwards, since the extrapolation uses this shot's own
  // trajectory while the launch angle ignores everything after contact. But
  // the extrapolation extends the last tracked frame's velocity in a STRAIGHT
  // line, and a curving ball's final tangent already points outward, so
  // running it on keeps turning the ball further out. Measured against the 45
  // balls that did resolve, real curve is small: mean 1.1 degrees, range -12
  // to +13. The extrapolation instead rotates by 8 to 20 degrees on balls down
  // the lines, which threw two home runs into foul territory.
  //
  // So the launch angle wins on evidence: about a degree of typical error
  // against the extrapolation's twenty.
  // Only the DIRECTION changes. Distance still prefers the tracker's own
  // extrapolation, which is derived from this shot's observed deceleration
  // rather than from a population average. The evidence above is about angle;
  // there is none that the fit beats a shot-specific distance.
  //
  // Read that distance off the extrapolated COORDINATES, never off the
  // tracker's distance_feet. Coordinates are raw units and carry no scale with
  // them; distance_feet was already converted inside the executable using
  // whatever feet-per-unit that build was compiled with. Treating one as the
  // other shortened a 342 ft home run to 306 and drew it inside the park.
  const projectedRadiusUnits = (record.projectedX != null && record.projectedZ != null)
    // Best: raw coordinates, no scale attached.
    ? Math.hypot(record.projectedX - HOME_PLATE.x, record.projectedZ - HOME_PLATE.z)
    // Next: the tracker's own extrapolated distance, but ONLY when the record
    // states the scale it was converted with. A build that does not say cannot
    // be second-guessed.
    : (record.distanceFeet != null && record.recordFeetPerUnit
      ? record.distanceFeet / record.recordFeetPerUnit
      // Last: the calibrated fit, which is already in our own feet.
      : (projected?.distanceFeet != null ? projected.distanceFeet / FEET_PER_UNIT : null))
  const estimatedPosition = record.x == null && record.sprayAngleDeg != null
    && projectedRadiusUnits != null
    ? polarToWorld(record.sprayAngleDeg, projectedRadiusUnits)
    : null
  const worldX = record.x ?? estimatedPosition?.x ?? record.projectedX ?? null
  const worldZ = record.z ?? estimatedPosition?.z ?? record.projectedZ ?? null
  // A tracked coordinate is where the ball WAS. A projected one is where the
  // tracker reckons it would have come down after tracking stopped, which is
  // an estimate and must not be presented as a measurement — it is unbounded
  // by the foul lines, so a deep ball down the line can be projected into
  // foul ground despite being a home run.
  const positionEstimated = record.x == null && record.projectedX != null
  // Height matters for placement: both of the first two home runs measured
  // here ended well above the ground (30.6 ft into the stands, 15.6 ft off the
  // top of the wall), and a marker drawn at the ground point beneath an
  // elevated ball reads short in a perspective view. An extrapolated landing
  // has no tracked height -- it was projected to ground level by definition.
  const worldY = record.x != null ? record.y : null
  const fields = {
    exit_velocity_mph: record.exitVelocityMph,
    ...(worldX != null && worldZ != null ? { hit_world_x: worldX, hit_world_z: worldZ } : {}),
    ...(worldY != null ? { hit_world_y: worldY } : {}),
    ...(positionEstimated ? { hit_position_estimated: true } : {}),
    launch_angle_deg: record.launchAngleDeg,
    // Derived from the ball's coordinates whenever they exist, in preference to
    // the executable's own distance_feet. The coordinates are a raw
    // measurement; the emitted feet already had a scale applied inside a build
    // that may predate the current one. Falling back to the emitted value is
    // still right for a contact with no coordinates at all.
    hit_distance_ft: roundTrackerDistance(
      (worldX != null && worldZ != null
        ? trackerDistanceFeetFromCoordinates(worldX, worldZ)
        : null)
        ?? record.distanceFeet ?? projected?.distanceFeet ?? null,
    ),
    hit_angle_deg: record.sprayAngleDeg,
  }
  if (record.hangTimeSec != null) fields.hang_time_sec = record.hangTimeSec
  else if (projected?.hangTimeSec != null) fields.hang_time_sec = projected.hangTimeSec
  if (stadiumKey) {
    fields.hit_stadium_key = stadiumKey
    const geometry = trackerBattedBallPlotGeometry(record, fields.hit_distance_ft)
    const spot = geometry && projectTrackerFieldSpot(geometry.distanceFeet, geometry.angleDeg, stadiumKey)
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
//
// Known imprecision: distanceFeet is in TRACKER_FEET_PER_UNIT feet while
// wallDistance comes from the hand-entered wallRefs `dist` values, which are in
// feet of unknown origin. The two scales are not known to agree, and an error
// of a few percent at the fence is comparable to the 15-foot margin itself.
// The fix is to re-measure each park's fence from tracked ball coordinates so
// both sides of this comparison come from the same feed; the Buddy Jump flag
// still gates it, so a mismatch only shifts a genuine wall catch in or out of
// "robbed", it never invents one.
export function isTrackerRobbedHomeRun({ record, isBuddyJump, stadiumKey } = {}) {
  if (!isBuddyJump || record?.endpoint !== 'catch' || !stadiumKey) return false
  const wallDistance = estimateTrackerWallDistance(record.sprayAngleDeg, stadiumKey)
  return wallDistance != null
    && Number(record.distanceFeet) >= wallDistance - TRACKER_ROBBED_HR_WALL_MARGIN_FT
}

export function trackerFieldedBallPaFields(record, { stadiumKey = null } = {}) {
  if (!record || !stadiumKey) return {}
  const geometry = trackerBattedBallPlotGeometry(record)
  const spot = geometry && projectTrackerFieldSpot(geometry.distanceFeet, geometry.angleDeg, stadiumKey)
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
  const taggedPitch = { ...pitch, isStarPitch: Boolean(buffer?.pendingStarPitch || pitch?.isStarPitch) }
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
// full stop — no "was it intentional" call involved. Requiring fewer than 2
// outs before the play guards against crediting a run that couldn't actually
// have scored: a fly out that is itself the third out of the inning never
// allows a run to cross the plate under the rules, so if the tracker's replay
// ever attached a run to that play it would be a replay error, not a real sac
// fly, and this must not paper over it. A caught bunt is excluded because the
// rule covers a fly ball or line drive; a popped-up bunt is neither, and it is
// handled as a bunt by shouldClassifyTrackerSacrificeBunt instead.
export function shouldReclassifyTrackerFlyOutAsSacFly({
  result, outsBeforePa, scoredNonBatterRunner, isBunt = false,
}) {
  if (isBunt) return false
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
