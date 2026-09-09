import { rosterCharacterName } from './tracker_character_ids.mjs'
import { estimateTrackerWallDistance, projectTrackerBattedBallDistanceFeet, projectTrackerFieldSpot } from './tracker_field_projection.mjs'
import {
  BALL_RADIUS_UNITS,
  FRAME_MAX_SEC,
  FRAME_MIN_SEC,
  projectLandingFromSamples,
} from './ball_flight_model.mjs'
import {
  FEET_PER_UNIT,
  HOME_PLATE,
  clampToFairTerritory,
  fenceDistanceFeet,
  hasImageCalibration,
  polarToWorld,
  standsHeightUnits,
  worldLandingToImagePercentAtHeight,
  worldToImagePercentAtHeight,
  worldToPolar,
} from '../src/utils/parkGeometry.js'

// What a unit was worth inside the tracker before 2026-08-14, when the
// executable used a locked 3.0 feet per unit. Later builds are self-describing:
// the short-lived regulation-base build reports 3.3532, and meter-native builds
// report 3.2808. Every stated source scale is converted to the canonical
// 1 metre/unit value imported above.
//
// A BATTED-BALL record with no feet_per_unit predates the change: the field was
// added to that record by the same commit that moved the constant, so absence
// means 3.0 rather than "unknown". (Older logs do carry feet_per_unit=3 on other
// markers, which is how the old scale was confirmed.)
export const TRACKER_LEGACY_FEET_PER_UNIT = 3.0

// The executable prints the scale with 4 decimals, so a current record reads
// 3.2808 against our 3.280839895. Anything inside this tolerance is the same
// scale rounded; both historical scales are much further away.
const FEET_PER_UNIT_MATCH_TOLERANCE = 1e-3

/**
 * Exit velocity on the canonical metre scale, whatever build produced it.
 *
 * The executable computes this as
 *   mph = units_per_frame * FEET_PER_UNIT * 59.94 / 1.4666667
 * so the number carries whichever scale that build was compiled with, exactly
 * like distance_feet does. Rebuilding the tracker once picked up a 3.0 ->
 * 3.3532 change and moved every reported velocity overnight even though the
 * ball's raw coordinate speed was unchanged. The generic conversion here also
 * handles those intermediate 3.3532 records when replaying their logs.
 *
 * Normalising here means a stored stat means the same thing regardless of which
 * executable recorded it, and keeps old saved logs replayable after the live
 * bridge moves to the metre-native build.
 */
export function normalizeTrackerExitVelocity(mph, recordFeetPerUnit) {
  // Not Number(mph): Number(null) and Number('') are both 0, which would turn a
  // missing exit velocity into a recorded 0 mph.
  if (mph == null || mph === '') return null
  const value = Number(mph)
  if (!Number.isFinite(value)) return null
  const source = Number.isFinite(recordFeetPerUnit) && recordFeetPerUnit > 0
    ? recordFeetPerUnit
    : TRACKER_LEGACY_FEET_PER_UNIT
  // Already on our scale: return it untouched rather than multiplying by a
  // number that rounds to 1, so re-ingesting a current log is exactly inert.
  if (Math.abs(source - FEET_PER_UNIT) < FEET_PER_UNIT_MATCH_TOLERANCE) return value
  return value * (FEET_PER_UNIT / source)
}

/** A tracker-emitted distance converted from its stated build scale to ours. */
export function normalizeTrackerDistanceFeet(feet, recordFeetPerUnit) {
  if (feet == null || feet === '') return null
  const value = Number(feet)
  if (!Number.isFinite(value)) return null
  const source = Number.isFinite(recordFeetPerUnit) && recordFeetPerUnit > 0
    ? recordFeetPerUnit
    : TRACKER_LEGACY_FEET_PER_UNIT
  if (Math.abs(source - FEET_PER_UNIT) < FEET_PER_UNIT_MATCH_TOLERANCE) return value
  return value * (FEET_PER_UNIT / source)
}

// Which `distance_source` values name a MEASUREMENT rather than an estimate.
// Exported so the preview's `is_projected` flag and the validation check that
// polices it read the same list: when they were written out separately, a home
// run whose carry was projected past the wall it struck ended up flagged as
// measured, and the contradiction surfaced as a validation error on six of one
// game's home runs rather than as the labelling bug it was.
export const TRACKER_MEASURED_DISTANCE_SOURCES = Object.freeze(
  new Set(['tracked_endpoint', 'tracked_collision']),
)

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

const ORDINARY_PITCH_TYPES = new Set(['fastball', 'curveball', 'changeup', 'knuckleball'])
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
// A knuckleball is a curve in both directions: a flight whose lateral
// curvature keeps one sign stays entirely on one side of its own chord, so
// clearing the curve bar to BOTH sides means the break reversed mid-flight.
// Mostly a slow-pitcher thing: replaying bowser_castle-20260904T011909Z gives
// four of 167, three of them Toadsworth's and Goomba's at 13-17 mph, against
// 163 under 0.09 on the smaller lobe. Sessions recorded before the collector
// reported the two extremes carry neither field, and those pitches classify
// exactly as they did before.
const KNUCKLE_TWO_SIDED_THRESHOLD_UNITS = 0.15
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
  const toRight = Number(telemetry.horizontalChordDeviationMaxUnits)
  const toLeft = Number(telemetry.horizontalChordDeviationMinUnits)
  if (
    Number.isFinite(toRight) && Number.isFinite(toLeft)
    && toRight >= KNUCKLE_TWO_SIDED_THRESHOLD_UNITS
    && -toLeft >= KNUCKLE_TWO_SIDED_THRESHOLD_UNITS
  ) return 'knuckleball'
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
    horizontalChordDeviationMaxUnits: finiteTrackerNumber(fields.horizontal_chord_deviation_max_units),
    horizontalChordDeviationMinUnits: finiteTrackerNumber(fields.horizontal_chord_deviation_min_units),
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

// One 60Hz ball position. The exe emits these continuously, tens of thousands
// per game, and until now nothing in the live path read them -- the whole flight
// of every batted ball was being thrown away, and the landing of a ball that
// outran tracking was estimated from launch conditions instead.
export const TRACKER_BALL_SAMPLE_MARKER = '[TRACKER_BALL_SAMPLE]'

export function parseTrackerBallSampleMessage(message) {
  const normalized = String(message || '').trim()
  const prefix = `${TRACKER_BALL_SAMPLE_MARKER} `
  if (!normalized.startsWith(prefix)) return null
  const fields = {}
  for (const part of normalized.slice(prefix.length).split('|')) {
    const separator = part.indexOf('=')
    if (separator <= 0) return null
    const key = part.slice(0, separator).trim()
    // First value wins, matching the batted-ball parser: a duplicate key means
    // two records have been run together and neither can be trusted.
    if (!Object.hasOwn(fields, key)) fields[key] = part.slice(separator + 1).trim()
  }
  const seq = trackerInteger(fields.seq)
  const timeNs = finiteTrackerNumber(fields.time_ns)
  const x = finiteTrackerNumber(fields.x)
  const y = finiteTrackerNumber(fields.y)
  const z = finiteTrackerNumber(fields.z)
  if (seq == null || timeNs == null || x == null || y == null || z == null) return null
  return { seq, timeNs, x, y, z, phase: fields.phase || null }
}

// Samples kept per flight. A generous ceiling on a real batted ball at 60Hz
// (about 12 seconds) and small enough that the buffer cannot grow without
// bound across a long game -- ~34,000 samples arrive per game, and the bridge
// only ever needs the flight in progress.
export const TRACKER_MAX_FLIGHT_SAMPLES = 750

/**
 * A rolling window of the most recent ball samples.
 *
 * Deliberately dumb: it keeps a trailing window rather than trying to decide
 * where a flight begins, because `seq` is what identifies a flight and that
 * only arrives later, on the contact record. `since(seq)` then slices out the
 * flight once the record names its bounds.
 *
 * `seq` restarts at 1 on every tracker session, so a decrease means a restart
 * and the buffer must drop what it has. Carrying samples across that boundary
 * is how one game's contact ends up holding another's trajectory.
 */
export class TrackerBallSampleBuffer {
  constructor(limit = TRACKER_MAX_FLIGHT_SAMPLES) {
    this.limit = limit
    this.samples = []
  }

  push(sample) {
    if (!sample) return false
    const previous = this.samples[this.samples.length - 1]
    if (previous && sample.seq < previous.seq) this.samples = []
    // Duplicate seq: phase=raw and phase=post_contact report the same frame.
    else if (previous && sample.seq === previous.seq) return false
    this.samples.push(sample)
    if (this.samples.length > this.limit) {
      this.samples.splice(0, this.samples.length - this.limit)
    }
    return true
  }

  /** Samples from `seq` onward, up to and including `throughSeq` when given. */
  since(seq, throughSeq = null) {
    if (!Number.isFinite(seq)) return []
    return this.samples.filter((s) => s.seq >= seq
      && (throughSeq == null || s.seq <= throughSeq))
  }

  clear() {
    this.samples = []
  }
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

  // A projected point is one coordinate pair. Accepting half of it would mix
  // one tracker coordinate with a fallback model on the other axis and create
  // a plausible-looking location no source ever reported.
  if ((projectedX == null) !== (projectedZ == null)) return null

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

// --- the measured pitch stream ----------------------------------------------
//
// The tracker log reports a pitch it did not see the batter offer at as
// `strike_unknown`, because from the outside a swing that misses and a pitch
// taken for a strike are the same event: the ball reaches the catcher and the
// count goes up. The 60 Hz capture watches the batter's own swing animation
// counters and can tell them apart, and emits one record per pitch saying so.
//
// These join the two. The measured stream is the count of record -- it is read
// from the game's own per-plate-appearance pitch counter -- so a pitch it has
// and the log does not is a pitch the log missed, and saying so is the point.

/** How the batter offered, in the vocabulary the pitch rows already use. */
export const MEASURED_OFFERS = Object.freeze(['swing', 'bunt', 'take'])

const LOGGED_CONTACT_RESULTS = new Set(['in_play', 'foul'])

/**
 * Attach measured offers to one plate appearance's pitches.
 *
 * WHY THIS IS NOT A POSITIONAL JOIN. The tracker log does not list a plate
 * appearance's pitches in the order they were thrown: the ball in play is
 * pushed when contact is announced, which can be before the fouls that
 * preceded it have been counted, so a three-pitch at-bat that went foul, foul,
 * bunt is logged as bunt, foul, foul. Pairing by position would then hand the
 * bunt's offer to the first foul. Nor is the count enough on its own -- a foul
 * with two strikes leaves it unchanged, so several pitches share one count.
 *
 * What both feeds assert independently and agree on is whether the bat touched
 * the ball, so pairing is done inside those two groups. Within the group the
 * capture's order is the real one; the log's ball in play is by definition the
 * contact that ended the plate appearance, which is the last one the capture
 * measured, and its fouls are everything before that in the order they happened.
 *
 * Returns { pitches, unmatched, matched }. `pitches` are new objects in the
 * order they were given, so pitch numbering downstream is untouched, and
 * `unmatched` are measured pitches the log has no record of at all -- which is
 * the missing-pitch report, and the only thing that should be read as one.
 */
export function applyMeasuredPitchOffers(pitches = [], measured = [], {
  resultKey = 'result',
} = {}) {
  const logged = pitches || []
  const contacts = (measured || []).filter((record) => record.contact)
  const others = (measured || []).filter((record) => !record.contact)
  const pairing = new Map()

  const loggedContacts = logged.filter((pitch) => LOGGED_CONTACT_RESULTS.has(pitch[resultKey]))
  const inPlay = loggedContacts.find((pitch) => pitch[resultKey] === 'in_play')
  const remainingContacts = [...contacts]
  if (inPlay && remainingContacts.length) {
    pairing.set(inPlay, remainingContacts.pop())
  }
  for (const pitch of loggedContacts) {
    if (pitch === inPlay || !remainingContacts.length) continue
    pairing.set(pitch, remainingContacts.shift())
  }
  const remainingOthers = [...others]
  for (const pitch of logged) {
    if (LOGGED_CONTACT_RESULTS.has(pitch[resultKey]) || !remainingOthers.length) continue
    pairing.set(pitch, remainingOthers.shift())
  }

  let matched = 0
  const out = logged.map((pitch) => {
    const record = pairing.get(pitch)
    if (!record) return { ...pitch, offer: null, offer_source: null }
    matched += 1
    const result = pitch[resultKey]
    // Only the outcome the log could not resolve is rewritten. A ball, a foul
    // and a ball in play are all things it observed directly, and the measured
    // offer is added alongside them rather than over them.
    const resolved = result === 'strike_unknown'
      ? (record.offer === 'take' ? 'looking' : 'swinging_miss')
      : result
    return {
      ...pitch,
      [resultKey]: resolved,
      offer: record.offer ?? null,
      offer_source: 'player_tracking_pitch.swing_frames',
      swing_frames: record.swing_frames ?? null,
      bunt_frames: record.bunt_frames ?? null,
      // The frame the swing started, which is what a joined play carries under
      // the same name. Present only on a pitch that was hit.
      swing_timer: record.swing_timer ?? null,
    }
  })
  const paired = new Set(pairing.values())
  return { pitches: out, unmatched: (measured || []).filter((r) => !paired.has(r)), matched }
}

export function measuredPitchMatchesPa(record, { inning, isTop, batterName } = {}) {
  if (!record) return false
  const normalize = (value) => String(rosterCharacterName(value) ?? '')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
  if (Number(record.inning) !== Number(inning)) return false
  if ((Number(record.inning_half) === 0) !== Boolean(isTop)) return false
  return normalize(record.batter) === normalize(batterName)
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

/**
 * The RBI a plate appearance is actually credited with.
 *
 * THE GAME IS NOT THE OFFICIAL SCORER. Mario Super Sluggers announces an RBI
 * off its own accounting and the tracker reads that line straight out of the
 * log, but OBR 9.04(a)(1) credits a run batted in only for a run that scores
 * "unaided by an error" on a play the batter began with a safe hit, a
 * sacrifice, an infield out or a fielder's choice. A batter who reached BECAUSE
 * of an error began no such play. 9.04(b) removes the credit on a double or
 * triple play the same way.
 *
 * The bridge has scored it this way since it started writing plate appearances;
 * the preview console did not, and announced "1 run scored on the play, with 1
 * RBI credited to Baby Mario" on a two-out ground ball to second that Daisy
 * booted, with the run coming home from SECOND. One rule, one place, so the
 * console and the database cannot disagree about it again.
 *
 * NOT IMPLEMENTED, and deliberately: 9.04(a)(3) restores the RBI when, before
 * two are out, an error is made on a play a runner from THIRD would ordinarily
 * have scored on. Both scorers have always been silent on it and no archived
 * plate appearance has hit the case yet.
 */
export function normalizeRbiForPaResult(result, rbi = 0, isError = false) {
  if (isError || result === 'ROE' || result === 'DP' || result === 'TP' || result === 'FC') return 0
  return Number(rbi || 0)
}

// A SACRIFICE FLY ALWAYS CARRIES ITS RBI. The game does not announce one: Daisy
// Cruiser 2026-09-04 printed 28 RBI across 30 runs, and the two it left out are
// exactly the two sacrifice flies. So the log's own count is short by one on
// every sac fly, and reading it straight credits the sacrifice while dropping
// the run it bought.
//
// Under OBR 9.04(a)(2) a run scoring on a sacrifice fly is an RBI; the double
// play exception in 9.04(b) cannot reach here, because the tracker's own
// "Double play!" line sets the result to DP while the log is being parsed and
// shouldReclassifyTrackerFlyOutAsSacFly only ever fires on FO or LO.
//
// Take the larger of the two rather than overwriting: if a build ever does
// announce the RBI, the announcement wins and this changes nothing.
export function trackerRbiForPaResult({ result, rbi = 0, scoredNonBatterRunners = 0 } = {}) {
  const announced = Number(rbi || 0)
  if (result !== 'SF') return announced
  return Math.max(announced, Number(scoredNonBatterRunners || 0))
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

/**
 * Whether the batter bunted, preferring the measurement over the proxy.
 *
 * `isTrackerBuntedBall` reads the exit velocity, which is a consequence of a
 * bunt and not the bunt itself: it cannot separate a bunt from a swing that was
 * simply mishit, and it says nothing at all about a bunt that went foul, where
 * there is no measurement to read. The 60 Hz capture records which of the
 * batter's two offer animations actually ran (`contact_type`), which is the
 * thing itself. Where a joined play has it, it decides; the exit velocity stays
 * as the answer for at-bats no play joined.
 */
export function trackerContactWasBunt(record, play = null) {
  const measured = play?.contact_type
  if (measured === 'bunt') return true
  if (measured === 'swing') return false
  return isTrackerBuntedBall(record)
}

// The editor stores G/L/F/B, while the tracker gives us the physical launch
// angle and whether the first endpoint was a catch or a landing. In this game's
// measured flight model the meaningful ground/air break is 6 degrees: contact
// from 6 through 10 degrees stays airborne for roughly two seconds and carries
// into the outfield, unlike the MLB-derived 10-degree boundary we used before.
// Line drives therefore run from 6 through 24.9 degrees and flies start at 25.
// A ball caught before touching down is necessarily airborne, so a sub-25-degree
// catch is a liner instead of being mislabeled a grounder.
// A bunt is its own trajectory in the editor and outranks the angle buckets:
// a bunt rolling along the ground is recorded as a bunt, not a ground ball.
//
// The angle alone is not enough at the bottom of the scale. It is measured over
// the two frames after contact, and this game's balls curve upward after that:
// a 92 mph Mario fire swing measured at 2.9 degrees rose to a 14.5-foot apex
// and came down 200 feet away, having touched nothing, and was recorded as a
// ground ball. So a ball's own flight overrules the launch angle when the two
// disagree about whether it was ever airborne. Across every session log in this
// repo an unambiguous grounder -- launch below zero, n=305 -- is on the ground
// within 1.02 seconds, while the contact the 6-degree rule already calls a line
// drive (6 to 10 degrees, n=161) stays up for 1.5 seconds or more. The gap
// between those two populations is where this boundary sits; it moves 19 of 440
// shallow landings, each of which carried 140 to 291 measured feet before its
// first bounce.
export const TRACKER_GROUNDER_MAX_HANG_TIME_SEC = 1.5

export function trackerBattedBallTrajectory(record) {
  const angle = Number(record?.launchAngleDeg)
  if (!Number.isFinite(angle) || record?.endpoint === 'foul') return null
  if (isTrackerBuntedBall(record)) return 'B'
  if (record?.endpoint === 'catch') return angle < 25 ? 'L' : 'F'
  if (angle < 6) {
    const hangTime = Number(record?.hangTimeSec)
    return Number.isFinite(hangTime) && hangTime >= TRACKER_GROUNDER_MAX_HANG_TIME_SEC ? 'L' : 'G'
  }
  if (angle < 25) return 'L'
  return 'F'
}

// Scoring rule 9.08(a): a sacrifice bunt is scored when, before two are out,
// the batter ADVANCES ONE OR MORE RUNNERS with a bunt and is put out at first.
// The batter's out is what the 'GO' result already represents (a bunt that
// retires a RUNNER instead is scored a fielder's choice by
// shouldClassifyTrackerFielderChoice, and a bunt the batter beats out stays a
// hit), so the remaining conditions are the runner, the out count, and the
// advance.
//
// THE ADVANCE IS THE HALF THIS USED TO ASSUME. A bunt is an attempt at a
// sacrifice; the sacrifice is only credited if it worked. Green Noki's
// 2026-09-04 bunt at DK Jungle was fielded by the pitcher and thrown to first
// with runners frozen on second and third -- an unsuccessful sacrifice, which
// the rules score as an ordinary 1-3 ground out, and which the console called a
// sacrifice hit and so credited a plate appearance that does not count as an
// at-bat.
//
// `runnerAdvanced` is three-valued on purpose. Only a measured "nobody moved"
// downgrades the bunt: null means no 60 Hz play joined this at-bat and nothing
// can answer the question, and a log-only session must keep scoring bunts the
// way it always did rather than silently reclassifying every one of them.
export function shouldClassifyTrackerSacrificeBunt({
  isBunt, result, outsBeforePa, hasRunnerOn, runnerAdvanced = null,
} = {}) {
  if (!isBunt || !hasRunnerOn || result !== 'GO') return false
  if (runnerAdvanced === false) return false
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
// materially different distances from the same batted ball.
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
// the two feeds materially different. And it does not measure from the world origin,
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

/**
 * Where the ball's own flight says it came down, or null.
 *
 * Reads `record.trajectory` — the 60Hz samples for this contact, attached by
 * whoever had them (the live bridge, or a log replay). A record without them
 * simply gets nothing here and the caller falls back exactly as before, so this
 * is inert on any path that has not been plumbed.
 *
 * Used for a contact with no tracked endpoint, and for one whose "endpoint" is
 * really mid-flight (see trackerEndpointIsMidFlight). A model must never
 * overrule a measurement -- but an airborne, still-outbound endpoint is not a
 * measurement of where the ball came down.
 */
export function trackerTrajectoryLanding(record) {
  if (!record) return null
  if ((record.x != null || record.z != null) && !trackerEndpointIsMidFlight(record)) return null
  if (!Array.isArray(record.trajectory) || !record.trajectory.length) return null
  // Once the ball reverses at a solid object, fitting one free-flight arc
  // through both sides of the impact invents a landing behind that object.
  // The observed contact is the endpoint instead.
  if (trackerTrajectoryCollision(record)) return null
  const landing = projectLandingFromSamples(record.trajectory)
  if (!landing) return null
  return plotFromGameCoordinates(landing.x, landing.z)
}

// A free batted ball can curve sideways, but with the game's measured linear
// drag it cannot abruptly reverse its radial travel away from home plate. For
// an unresolved record, that reversal is therefore direct evidence that the
// ball struck a wall (or another solid object) before tracking was interrupted.
// Require a meaningful one-frame reversal followed by sustained retreat so a
// noisy local maximum cannot be promoted to a collision.
const TRAJECTORY_COLLISION_MIN_RADIUS_UNITS = 60
const TRAJECTORY_COLLISION_MIN_RADIAL_STEP_UNITS = 0.03
const TRAJECTORY_COLLISION_MIN_RETREAT_UNITS = 0.5
const TRAJECTORY_COLLISION_MIN_FOLLOWING_FRAMES = 4
const TRAJECTORY_COLLISION_LOOKAHEAD_FRAMES = 12

function trackerSampleRadius(sample) {
  if (sample?.x == null || sample?.z == null) return null
  const x = Number(sample?.x)
  const z = Number(sample?.z)
  return Number.isFinite(x) && Number.isFinite(z)
    ? Math.hypot(x - HOME_PLATE.x, z - HOME_PLATE.z)
    : null
}

function trackerSamplesAreContiguous(before, after) {
  const beforeNs = Number(before?.timeNs)
  const afterNs = Number(after?.timeNs)
  if (!Number.isFinite(beforeNs) || !Number.isFinite(afterNs)) return false
  const dt = (afterNs - beforeNs) / 1e9
  return dt >= FRAME_MIN_SEC && dt <= FRAME_MAX_SEC
}

// A one-frame velocity break far too large to be gravity. Shared by both
// detectors so "what contact looks like" has one definition.
//
// Free flight changes velocity by about 0.16u/s per frame, so the thresholds
// below sit ~60x above the smooth case and still far under Petey Piranha's
// measured 17.07u/s against Bowser Castle's rear wall.
function trackerVelocityBreakAt(samples, index) {
  const previous = samples[index - 1]
  const current = samples[index]
  const next = samples[index + 1]
  if (
    trackerSampleIsZeroSentinel(current)
    || trackerSampleIsZeroSentinel(next)
    || !trackerSamplesAreContiguous(previous, current)
    || !trackerSamplesAreContiguous(current, next)
  ) return false
  const radius = trackerSampleRadius(current)
  if (radius == null || radius < TRAJECTORY_COLLISION_MIN_RADIUS_UNITS) return false

  const beforeDt = (Number(current.timeNs) - Number(previous.timeNs)) / 1e9
  const afterDt = (Number(next.timeNs) - Number(current.timeNs)) / 1e9
  const before = [
    (Number(current.x) - Number(previous.x)) / beforeDt,
    (Number(current.y) - Number(previous.y)) / beforeDt,
    (Number(current.z) - Number(previous.z)) / beforeDt,
  ]
  const after = [
    (Number(next.x) - Number(current.x)) / afterDt,
    (Number(next.y) - Number(current.y)) / afterDt,
    (Number(next.z) - Number(current.z)) / afterDt,
  ]
  if (![...before, ...after].every(Number.isFinite)) return false
  const beforeSpeed = Math.hypot(...before)
  const change = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])
  return beforeSpeed >= IMPACT_MIN_PRE_SPEED_UNITS_PER_SEC
    && change >= FIRST_IMPACT_MIN_VELOCITY_CHANGE_UNITS_PER_SEC
    && change / beforeSpeed >= IMPACT_MIN_RELATIVE_VELOCITY_CHANGE
}

/** Return the measured sample where an unresolved trajectory hit an object. */
export function trackerTrajectoryCollision(record) {
  if (!record || record.endpoint !== 'unresolved') return null
  if (record.x != null || record.z != null) return null
  const samples = record.trajectory
  if (!Array.isArray(samples) || samples.length < 4) return null

  for (let i = 1; i < samples.length - 1; i += 1) {
    const previous = samples[i - 1]
    const current = samples[i]
    const next = samples[i + 1]
    if (
      !trackerSamplesAreContiguous(previous, current)
      || !trackerSamplesAreContiguous(current, next)
    ) continue

    const previousRadius = trackerSampleRadius(previous)
    const currentRadius = trackerSampleRadius(current)
    const nextRadius = trackerSampleRadius(next)
    if (
      previousRadius == null || currentRadius == null || nextRadius == null
      || currentRadius < TRAJECTORY_COLLISION_MIN_RADIUS_UNITS
      || currentRadius - previousRadius < TRAJECTORY_COLLISION_MIN_RADIAL_STEP_UNITS
      || currentRadius - nextRadius < TRAJECTORY_COLLISION_MIN_RADIAL_STEP_UNITS
    ) continue

    let minimumFollowingRadius = nextRadius
    let followingFrames = 1
    const through = Math.min(samples.length - 1, i + TRAJECTORY_COLLISION_LOOKAHEAD_FRAMES)
    for (let j = i + 2; j <= through; j += 1) {
      if (!trackerSamplesAreContiguous(samples[j - 1], samples[j])) break
      const radius = trackerSampleRadius(samples[j])
      if (radius == null) break
      followingFrames += 1
      minimumFollowingRadius = Math.min(minimumFollowingRadius, radius)
    }
    if (
      followingFrames >= TRAJECTORY_COLLISION_MIN_FOLLOWING_FRAMES
      && currentRadius - minimumFollowingRadius >= TRAJECTORY_COLLISION_MIN_RETREAT_UNITS
    ) {
      return current
    }
  }

  // The retreat test above only sees contact that sends the ball back toward
  // home for four or more frames. Plenty of real contact does neither: a ball
  // that smacks a wall high and drops straight down keeps its radius, a ball
  // that stops dead has no retreat at all, and when tracking ends within a
  // frame or two of the hit there are no following frames to measure. All of
  // those registered as nothing, so the flight was then projected onward as if
  // it had flown free -- which is how a ball that visibly hit something ends up
  // plotted somewhere it never reached.
  //
  // So fall back to the velocity break, with the same guard the landing
  // detector uses: a break the ball flies onward past is not contact. Between
  // them, "the ball's speed changed far more than gravity can explain, and it
  // never got further out than that" is contact however it ended.
  for (let i = 1; i < samples.length - 1; i += 1) {
    if (!trackerVelocityBreakAt(samples, i)) continue
    const radius = trackerSampleRadius(samples[i])
    if (trackerFlightContinuesBeyond(samples, i, radius, Number(record.endpointSeq))) continue
    return samples[i]
  }
  return null
}

// A ball at rest sits one radius up (0.25). This is far above that on purpose:
// it is not trying to catch a ball mid-bounce, only one that is unambiguously
// still in the air.
const MID_FLIGHT_HEIGHT_UNITS = 1.0
// How many frames at the end to test for outward travel.
const OUTBOUND_TAIL_FRAMES = 5
// Tracker positions are effectively noiseless at a stationary surface. A rise
// this large on the first frame after a descending endpoint is a rebound, not
// coordinate jitter.
const IMPACT_REBOUND_MIN_RISE_UNITS = 0.05
// A wall can absorb almost all of a ball's speed without producing a visible
// upward rebound. Natural gravity changes velocity by only ~0.16u/s per frame;
// these deliberately conservative thresholds still sit far below Petey
// Piranha's measured 17.07u/s change against Bowser Castle's rear wall.
const IMPACT_MIN_PRE_SPEED_UNITS_PER_SEC = 2
const IMPACT_MIN_VELOCITY_CHANGE_UNITS_PER_SEC = 5
const IMPACT_MIN_RELATIVE_VELOCITY_CHANGE = 0.5

function trackerSampleIsZeroSentinel(sample) {
  return Number(sample?.x) === 0 && Number(sample?.y) === 0 && Number(sample?.z) === 0
}

// A fair-fielded endpoint is where the fielder eventually secured the ball,
// not necessarily where the batted ball first came down. Playroom makes that
// distinction especially visible: a ball can strike a Thwomp, rebound toward
// the infield, and be scored in play. The spray chart belongs at the Thwomp;
// the later fielded_* columns still belong at the pickup.
//
// Gravity changes velocity by only about 0.16u/s per frame. Requiring a large
// one-frame break outside the infield therefore admits real ground/object
// impacts while ignoring the smooth free-flight samples. It deliberately does
// not infer a scoring result -- fair_fielded remains authoritative even when
// the impact point is visually beyond part of the outfield wall.
const FIRST_IMPACT_MIN_VELOCITY_CHANGE_UNITS_PER_SEC = 10

/** Return the first measured impact before the endpoint recorded later. */
export function trackerTrajectoryFirstImpact(record) {
  if (
    !record
    || record.endpoint !== 'landing'
  ) return null
  const samples = record.trajectory
  if (!Array.isArray(samples) || samples.length < 3) return null

  const endpointSeq = Number(record.endpointSeq)
  for (let i = 1; i < samples.length - 1; i += 1) {
    const current = samples[i]
    if (Number.isFinite(endpointSeq) && Number(current?.seq) >= endpointSeq) continue
    const currentRadius = trackerSampleRadius(current)
    if (currentRadius == null) continue
    if (
      trackerVelocityBreakAt(samples, i)
      // ...and the flight has to actually END somewhere around here. A velocity
      // break alone is not contact: one noisy frame in clean air clears every
      // threshold in trackerVelocityBreakAt, and the ball is then plotted at a
      // point it flew straight through. Dark Bones' PA 38 was placed at 274 ft -- INSIDE a
      // fence whose shortest point is 284.5 ft -- on a ball that carried out of
      // the park for a home run. Whatever happened in that frame, the ball
      // demonstrably did not stop there.
      //
      // A real strike ends the outward travel: the ball rebounds, drops, or
      // stops. So a candidate the flight later travels well BEYOND is not where
      // the ball ended, and must not become its plotted position. This asks
      // only what the samples already show and predicts nothing.
      && !trackerFlightContinuesBeyond(samples, i, currentRadius, endpointSeq)
    ) return current
  }
  return null
}

// Slack before "the ball went further" counts, so sample noise around a genuine
// stop cannot reopen a settled impact.
const IMPACT_OUTWARD_TOLERANCE_UNITS = 1.5

/** Does the flight after `index` reach meaningfully further out than `radius`? */
function trackerFlightContinuesBeyond(samples, index, radius, endpointSeq) {
  for (let i = index + 1; i < samples.length; i += 1) {
    const sample = samples[i]
    if (trackerSampleIsZeroSentinel(sample)) continue
    if (Number.isFinite(endpointSeq) && Number(sample?.seq) > endpointSeq) break
    const later = trackerSampleRadius(sample)
    if (later != null && later > radius + IMPACT_OUTWARD_TOLERANCE_UNITS) return true
  }
  return false
}

/** Does an elevated endpoint have a measured post-impact velocity break? */
export function trackerEndpointHasObservedImpact(record) {
  if (!record || record.endpoint !== 'landing' || Number(record.y) <= MID_FLIGHT_HEIGHT_UNITS) {
    return false
  }
  const samples = record.trajectory
  const endpointSeq = Number(record.endpointSeq)
  if (!Array.isArray(samples) || !Number.isFinite(endpointSeq)) return false
  const endpointIndex = samples.findIndex((sample) => Number(sample.seq) === endpointSeq)
  if (endpointIndex < 1 || endpointIndex + 1 >= samples.length) return false

  const previous = samples[endpointIndex - 1]
  const endpoint = samples[endpointIndex]
  const post = samples[endpointIndex + 1]
  // The tracker writes an exact 0,0,0 when the game clears its ball pointer.
  // That is loss of tracking, not a physical rebound toward home plate.
  if (trackerSampleIsZeroSentinel(post)) return false

  const endpointY = Number(endpoint.y)
  const postY = Number(post.y)
  if (
    Number.isFinite(endpointY)
    && Number.isFinite(postY)
    && postY - endpointY >= IMPACT_REBOUND_MIN_RISE_UNITS
  ) return true

  if (
    !trackerSamplesAreContiguous(previous, endpoint)
    || !trackerSamplesAreContiguous(endpoint, post)
  ) return false
  const beforeDt = (Number(endpoint.timeNs) - Number(previous.timeNs)) / 1e9
  const afterDt = (Number(post.timeNs) - Number(endpoint.timeNs)) / 1e9
  const beforeVelocity = [
    (Number(endpoint.x) - Number(previous.x)) / beforeDt,
    (Number(endpoint.y) - Number(previous.y)) / beforeDt,
    (Number(endpoint.z) - Number(previous.z)) / beforeDt,
  ]
  const afterVelocity = [
    (Number(post.x) - Number(endpoint.x)) / afterDt,
    (Number(post.y) - Number(endpoint.y)) / afterDt,
    (Number(post.z) - Number(endpoint.z)) / afterDt,
  ]
  if (![...beforeVelocity, ...afterVelocity].every(Number.isFinite)) return false
  const beforeSpeed = Math.hypot(...beforeVelocity)
  const velocityChange = Math.hypot(
    afterVelocity[0] - beforeVelocity[0],
    afterVelocity[1] - beforeVelocity[1],
    afterVelocity[2] - beforeVelocity[2],
  )
  return beforeSpeed >= IMPACT_MIN_PRE_SPEED_UNITS_PER_SEC
    && velocityChange >= IMPACT_MIN_VELOCITY_CHANGE_UNITS_PER_SEC
    && velocityChange / beforeSpeed >= IMPACT_MIN_RELATIVE_VELOCITY_CHANGE
}

/**
 * Project where an elevated, measured impact would have reached ground.
 *
 * The impact remains the authoritative PLOT position: it says which wall or
 * structure the ball physically struck. It is not, however, a completed carry
 * distance. Bowser Castle makes the distinction unusually large -- a ball can
 * hit the rear wall roughly 70 feet beyond the front wall while still 80+ feet
 * in the air. Calling the horizontal radius of that wall face the home-run
 * distance mixes an obstruction distance with ordinary ground landings.
 *
 * Fit only the free-flight samples through the impact. Post-impact samples are
 * a bounce and would corrupt the ballistic projection. A projection that does
 * not extend beyond the obstruction is rejected rather than replacing a real
 * measurement with a model that has no remaining carry to estimate.
 */
export function trackerProjectedCarryFromObservedImpact(record) {
  if (!record || !Array.isArray(record.trajectory)) return null
  const collision = trackerTrajectoryFirstImpact(record)
    ?? trackerTrajectoryCollision(record)
  const endpointImpact = trackerEndpointHasObservedImpact(record)
  if (!collision && !endpointImpact) return null

  const impact = collision ?? record
  const impactY = Number(impact.y)
  const impactSeq = Number(collision?.seq ?? record.endpointSeq)
  if (!(impactY > BALL_RADIUS_UNITS) || !Number.isFinite(impactSeq)) return null

  const freeFlight = record.trajectory.filter((sample) => Number(sample?.seq) <= impactSeq)
  const landing = projectLandingFromSamples(freeFlight)
  if (!landing) return null

  const impactRadius = trackerSampleRadius(impact)
  const landingRadius = trackerSampleRadius(landing)
  if (
    impactRadius == null || landingRadius == null
    || landingRadius <= impactRadius + BALL_RADIUS_UNITS
  ) return null

  return {
    ...landing,
    distanceFeet: landingRadius * FEET_PER_UNIT,
    impactDistanceFeet: impactRadius * FEET_PER_UNIT,
    impactHeightFeet: impactY * FEET_PER_UNIT,
  }
}

// Whether a landing needs a display-only push past an occluding wall on park
// artwork. This is a property of the measured endpoint, not of the eventual
// scoring result: changing a PA to HR must never move an already-plotted dot.
//
// A measured impact stays exactly where it happened. Two independently marked
// Playroom Thwomp contacts landed at the same 6.06u height as its rear deck, so
// height alone cannot distinguish those overlapping structures. The old deck
// exception pushed them 5-8 image percent too far outward. Only a point with no
// observed impact (a true ground landing or flight estimate) may use the broad
// wall-visibility clearance.
/**
 * Is the endpoint the game's dead-ball coordinate reset rather than a place?
 *
 * The game blanks the ball coordinate to the origin on the frame the play goes
 * dead, and on some parks that reset lands on the SAME update the caught state
 * arrives. The executable then records (0, 0, 0) as where the ball was caught:
 * 11 of the 107 contacts in the 2026-08-31 Daisy Cruiser session, every one of
 * them an outfield catch of 209-286 measured feet, reported at 2.5-3.5 feet and
 * drawn on top of home plate. Exactly (0, 0, 0) is that sentinel and nothing
 * else -- a batted ball is never measured at the origin at zero height.
 *
 * v28 of the executable steps back to the last update that still held a real
 * coordinate. This keeps every log recorded before it from plotting a catch at
 * home plate, by handing the position back to the 60 Hz capture, which measured
 * the same catch independently and was never affected.
 */
export function trackerEndpointIsCoordinateReset(record) {
  if (!record) return false
  if (record.endpoint !== 'catch' && record.endpoint !== 'landing') return false
  if (record.x == null || record.y == null || record.z == null) return false
  return Number(record.x) === 0 && Number(record.y) === 0 && Number(record.z) === 0
}

function trackerObservedPlayLanding(record, play) {
  // The executable can lose the ball at a park object and stamp the contact as
  // unresolved even though the independent 60 Hz play already measured where
  // the flight ended. That measurement outranks every extrapolation attached to
  // the unresolved record. It also outranks a coordinate the dead-ball reset
  // destroyed, which is not an extrapolation but is not a position either.
  const reset = trackerEndpointIsCoordinateReset(record)
  if (record?.endpoint !== 'unresolved' && !reset) return null
  // A caught ball never lands, so its endpoint in the capture is the first
  // touch -- the same event the executable was recording when the reset
  // overwrote it. A landing endpoint keeps reading the capture's landing; the
  // spot a grounder was fielded is not where it came down.
  const observed = record.endpoint === 'catch' ? play?.first_touch : play?.landing
  const at = observed?.at
  if (!Array.isArray(at) || at.length < 3) return null
  const [x, y, z] = at.map(Number)
  if (![x, y, z].every(Number.isFinite)) return null
  const measuredTime = Number(observed?.t)
  return {
    x, y, z,
    hangTimeSec: Number.isFinite(measuredTime) && measuredTime >= 0 ? measuredTime : null,
  }
}

export function trackerBattedBallShouldRevealOccludedLanding(
  record, stadiumKey = null, play = null,
) {
  if (!record || record.endpoint === 'catch') return false
  if (trackerObservedPlayLanding(record, play) != null) return false
  // This is the exact surface/object contact, not a hidden continuation behind
  // the wall. In particular, do not push a Thwomp hit into home-run territory.
  if (trackerTrajectoryFirstImpact(record) != null) return false
  if (trackerTrajectoryCollision(record) != null) return false
  return !trackerEndpointHasObservedImpact(record)
}

/**
 * Is the tracker's "endpoint" actually a point mid-flight?
 *
 * The executable labels an endpoint `landing` whenever the ball stops being
 * tracked in fair territory, and that label is wrong roughly half the time --
 * 65 of 139 across the logs in this repo ended with the ball 0.3 to 12 units in
 * the AIR (see scripts/ball_trajectories.mjs, which exists because of it). A
 * ball that leaves the park is the common case: tracking simply gives up while
 * it is still flying, and the last frame gets stamped `landing`.
 *
 * Taken at face value that frame understates carry and, on the artwork, plots a
 * home run short of the wall it just cleared. The Peach Ice Garden ball that
 * turned this up was stamped as landing 388.2 ft out at 15.8 ft of altitude,
 * still moving outward and still descending; integrating its own flight puts it
 * down at 395.3 ft, 10.6 ft the other side of the fence.
 *
 * Two conditions, and BOTH are required. Airborne alone is not enough, because
 * a ball that struck a wall is also airborne -- and for that one the tracked
 * point IS the answer. A face strike reverses its outward travel. A top strike
 * can keep moving outward, though, so attachTrackerTrajectory retains the first
 * post-endpoint frame as well: an observed upward rebound proves physical
 * contact even when horizontal motion continues. No park geometry is involved,
 * so this works in an uncalibrated stadium and on walls with raised pillars.
 */
export function trackerEndpointIsMidFlight(record) {
  if (!record) return false
  // A catch is a real event at a real place; so is a foul. Only the "it landed"
  // claim is in doubt here.
  if (record.endpoint !== 'landing') return false
  const height = Number(record.y)
  if (!Number.isFinite(height) || height <= MID_FLIGHT_HEIGHT_UNITS) return false
  const samples = record.trajectory
  if (!Array.isArray(samples)) return false
  if (trackerEndpointHasObservedImpact(record)) return false
  if (samples.length < OUTBOUND_TAIL_FRAMES + 1) return false
  const endpointSeq = Number(record.endpointSeq)
  const endpointIndex = Number.isFinite(endpointSeq)
    ? samples.findIndex((sample) => Number(sample.seq) === endpointSeq)
    : -1
  // attachTrackerTrajectory intentionally retains one post-endpoint frame for
  // impact detection. Exclude it from the outbound test: a 0,0,0 pointer-clear
  // sentinel must not turn an otherwise outbound flight into a fake landing.
  const throughEndpoint = endpointIndex >= 0 ? samples.slice(0, endpointIndex + 1) : samples
  const tail = throughEndpoint.slice(-OUTBOUND_TAIL_FRAMES)
  if (tail.length < OUTBOUND_TAIL_FRAMES) return false
  const radius = (s) => Math.hypot(
    Number(s.x) - HOME_PLATE.x,
    Number(s.z) - HOME_PLATE.z,
  )
  const first = radius(tail[0])
  const last = radius(tail[tail.length - 1])
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false
  return last > first
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
  const firstImpact = trackerTrajectoryFirstImpact(record)
  const firstImpactGeometry = firstImpact
    && plotFromGameCoordinates(firstImpact.x, firstImpact.z)
  if (firstImpactGeometry) {
    return { ...firstImpactGeometry, source: 'trajectory_collision' }
  }
  // ...unless those coordinates are a point mid-flight rather than a landing,
  // in which case the flight below is the better answer and the check inside
  // trackerTrajectoryLanding lets it through.
  const measured = trackerEndpointIsMidFlight(record) || trackerEndpointIsCoordinateReset(record)
    ? null
    : plotFromGameCoordinates(record.x, record.z)
  if (measured) {
    return {
      ...measured,
      source: trackerEndpointHasObservedImpact(record)
        ? 'trajectory_collision'
        : 'endpoint_coordinates',
    }
  }
  const collision = trackerTrajectoryCollision(record)
  const collisionGeometry = collision && plotFromGameCoordinates(collision.x, collision.z)
  if (collisionGeometry) return { ...collisionGeometry, source: 'trajectory_collision' }
  // A ball that outran tracking still has most of a flight recorded, and
  // integrating that flight beats every alternative below by a factor of two or
  // more -- 11.8 ft median error against the polynomial's 22.3 ft, measured on
  // landed fly balls whose tails were hidden from the model
  // (scripts/backtest_hr_projection.mjs). Preferred over the exe's own
  // extrapolation because that extrapolation extends the last tracked frame in a
  // STRAIGHT LINE, ignoring both gravity and drag, and has never been checkable
  // against anything.
  const flown = trackerTrajectoryLanding(record)
  if (flown) return { ...flown, source: 'trajectory_projection' }
  const projected = plotFromGameCoordinates(record.projectedX, record.projectedZ)
  if (projected) return { ...projected, source: 'projected_coordinates' }

  // fallbackDistanceFeet is the caller's already-corrected distance and stays
  // usable; the record's own distance_feet was computed from the reset itself.
  const distanceValue = fallbackDistanceFeet
    ?? (trackerEndpointIsCoordinateReset(record)
      ? null
      : normalizeTrackerDistanceFeet(record.distanceFeet, record.recordFeetPerUnit))
  if (distanceValue == null || record.sprayAngleDeg == null) return null
  const distanceFeet = Number(distanceValue)
  const angleDeg = Number(record.sprayAngleDeg)
  if (!Number.isFinite(distanceFeet) || !Number.isFinite(angleDeg)) return null
  return { distanceFeet, angleDeg, source: 'launch_spray_angle' }
}

function roundTrackerImageCoordinate(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

// A raw world coordinate can go straight through the measured park homography;
// sending it back through the old three-point distance/angle approximation
// discarded the precision the tracker had just measured. Unmeasured parks keep
// the shared wall-reference fallback.
function projectTrackerWorldSpot({
  x, y = null, z, estimated = false, revealOccludedLanding = false,
}, stadiumKey) {
  if (!hasImageCalibration(stadiumKey)) return null
  const raw = estimated ? clampToFairTerritory(x, z) : { x: Number(x), z: Number(z) }
  if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.z)) return null
  const polar = worldToPolar(raw.x, raw.z)
  if (!polar) return null
  const measuredHeight = y != null && Number.isFinite(Number(y)) ? Number(y) : null
  const height = measuredHeight
    ?? (estimated ? standsHeightUnits(stadiumKey, polar.angleDeg, polar.distanceUnits) : null)
    ?? 0
  const spot = revealOccludedLanding
    ? worldLandingToImagePercentAtHeight(stadiumKey, raw.x, raw.z, height)
    : worldToImagePercentAtHeight(stadiumKey, raw.x, raw.z, height)
  if (!spot) return null
  return {
    x: roundTrackerImageCoordinate(spot.x),
    y: roundTrackerImageCoordinate(spot.y),
  }
}

/** Attach the samples needed to project an unresolved or airborne endpoint. */
export function attachTrackerTrajectory(record, sampleBuffer) {
  if (!record || record.contactSeq == null || !sampleBuffer) return record
  const needsProjection = record.endpoint === 'unresolved'
    || (record.endpoint === 'landing' && Number(record.y) > MID_FLIGHT_HEIGHT_UNITS)
    || (record.endpoint === 'landing' && record.endpointStatus === 'fair_fielded')
  if (!needsProjection) return record
  // The landing detector emits its record after observing a reversal, so one
  // post-endpoint frame is already in the live buffer. Keep it for an elevated
  // endpoint: a top-of-wall rebound can continue outward and otherwise looks
  // exactly like tracking stopped in mid-flight. Unresolved flights remain
  // unbounded, and ordinary ground landings still attach nothing.
  const throughSeq = record.endpoint === 'landing' && Number.isFinite(record.endpointSeq)
    ? record.endpointSeq + 1
    : (record.endpointSeq ?? null)
  const trajectory = sampleBuffer.since(record.contactSeq, throughSeq)
  return trajectory.length ? { ...record, trajectory } : record
}

export function trackerBattedBallPaFields(record, {
  stadiumKey = null,
  projectCarryAtImpact = false,
  play = null,
} = {}) {
  if (!record || (record.endpoint !== 'landing' && record.endpoint !== 'catch' && record.endpoint !== 'unresolved')) return {}
  const normalizedExitVelocity = normalizeTrackerExitVelocity(
    record.exitVelocityMph, record.recordFeetPerUnit,
  )
  const projected = record.endpoint === 'unresolved'
    ? projectTrackerBattedBallDistanceFeet(normalizedExitVelocity, record.launchAngleDeg)
    : null
  // The ball's own coordinates, kept as measured. Every position downstream can
  // be derived from these exactly against the measured park geometry, whereas
  // hit_x/hit_y below are percentages on a stadium screenshot and hit_angle_deg
  // is the launch direction rather than where the ball came down. A contact
  // whose endpoint never resolved still has the tracker's extrapolated landing
  // point, which is a real estimate of where it would have come down.
  // For a ball that outran tracking, position comes from the tracker's own
  // extrapolated COORDINATES — direction as well as distance.
  //
  // This used to take the direction from the LAUNCH spray angle instead, on the
  // grounds that extending the last tracked frame's velocity in a straight line
  // keeps turning a curving ball outward, and that the extrapolation therefore
  // rotated 8-20 degrees too far. That claim is not checkable against anything:
  // the exe emits projected_x/z only when tracking STALLS, which is exactly
  // when x/z is 'none', so no record has ever carried both a tracked endpoint
  // and an extrapolated one. There is no ball on which the extrapolation's
  // angle error is observable, here or in any log in this repo.
  //
  // The launch angle's error IS observable, on the balls that did resolve, and
  // it runs one way: the ball drifts OUTWARD, away from centre, and further the
  // deeper it goes. On the five deepest resolved balls (300-352 ft) the landing
  // angle beat the launch angle by +5.6, +3.6, +3.0, +2.6 and -1.5 degrees. So
  // launch direction is biased inward on precisely the balls that outrun
  // tracking, and can only ever draw a deep one short of the line. It did: a
  // 350 ft Donkey Kong home run into the right-field corner, launched at 30
  // degrees and extrapolated to 41.2, landed on the chart 68 ft toward centre,
  // on the bleacher stairs.
  //
  // Preferring the extrapolation barely moves the balls that already looked
  // right — the other two unresolved home runs that session shift 0.9 and 3.5
  // degrees — and it puts that one where it actually came down. The
  // over-rotation the old rule guarded against belongs to clampToFairTerritory
  // at draw time, which holds an estimate inside the foul lines without pulling
  // every deep ball toward centre.
  //
  // It also makes this agree with trackerBattedBallPlotGeometry below, which
  // has always preferred the projected coordinates for hit_x/hit_y: the same
  // ball was being placed at two different angles depending on which columns
  // were read.
  //
  // Read the distance off the extrapolated COORDINATES, never off the
  // tracker's distance_feet. Coordinates are raw units and carry no scale with
  // them; distance_feet was already converted inside the executable using
  // whatever feet-per-unit that build was compiled with. Treating one as the
  // other shortened a 342 ft home run to 306 and drew it inside the park.
  // The dead-ball reset is not a coordinate, so nothing below may read it as
  // one: (0, 0, 0) has to behave exactly like the absent coordinate it is, or
  // every fallback here is skipped in favour of home plate -- including the
  // distance_feet the executable computed from that same reset, which is what
  // put an outfield catch 2.6 feet from the plate.
  const resetEndpoint = trackerEndpointIsCoordinateReset(record)
  const projectedRadiusUnits = (record.projectedX != null && record.projectedZ != null)
    // Best: raw coordinates, no scale attached.
    ? Math.hypot(record.projectedX - HOME_PLATE.x, record.projectedZ - HOME_PLATE.z)
    // Next: the tracker's own extrapolated distance, but ONLY when the record
    // states the scale it was converted with. A build that does not say cannot
    // be second-guessed.
    : (record.distanceFeet != null && record.recordFeetPerUnit && !resetEndpoint
      ? record.distanceFeet / record.recordFeetPerUnit
      // Last: the calibrated fit, which is already in our own feet.
      : (projected?.distanceFeet != null ? projected.distanceFeet / FEET_PER_UNIT : null))
  // Only reached when the exe sent no extrapolated coordinates: with no
  // measured direction of any kind left, the launch angle is all there is, and
  // it is paired with whichever radius above was available.
  const estimatedPosition = (record.x == null || resetEndpoint) && record.projectedX == null
    && record.sprayAngleDeg != null && projectedRadiusUnits != null
    ? polarToWorld(record.sprayAngleDeg, projectedRadiusUnits)
    : null
  // The ball's own integrated flight, when its samples were attached. Ranked
  // above the exe's straight-line extrapolation for the reason recorded on
  // trackerBattedBallPlotGeometry, and kept in the SAME order here so the stored
  // world coordinates, the distance and the plotted marker all describe one
  // position. They disagreed once before, when hit_x/hit_y preferred the
  // projected coordinates and hit_world_* did not.
  // Also used when the tracked endpoint is airborne and still outbound, which
  // is not a landing however it was labelled -- see trackerEndpointIsMidFlight.
  const midFlightEndpoint = trackerEndpointIsMidFlight(record)
  const collisionPosition = trackerTrajectoryFirstImpact(record)
    ?? trackerTrajectoryCollision(record)
  const observedPlayLanding = trackerObservedPlayLanding(record, play)
  const flownPosition = collisionPosition == null && observedPlayLanding == null
    && (record.x == null || midFlightEndpoint || resetEndpoint)
    && Array.isArray(record.trajectory)
    ? projectLandingFromSamples(record.trajectory)
    : null
  // A measured collision or joined-play landing leads. flownPosition is only
  // non-null when neither exists and the tracked coordinates are absent or are
  // not a landing, so a model can never overrule a measurement.
  const worldX = collisionPosition?.x
    ?? observedPlayLanding?.x
    ?? flownPosition?.x ?? (resetEndpoint ? null : record.x)
    ?? record.projectedX ?? estimatedPosition?.x ?? null
  const worldZ = collisionPosition?.z
    ?? observedPlayLanding?.z
    ?? flownPosition?.z ?? (resetEndpoint ? null : record.z)
    ?? record.projectedZ ?? estimatedPosition?.z ?? null
  // A tracked coordinate is where the ball WAS. A projected one is where the
  // tracker reckons it would have come down after tracking stopped, which is
  // an estimate and must not be presented as a measurement — it is unbounded
  // by the foul lines, so a deep ball down the line can be projected into
  // foul ground despite being a home run.
  // An integrated flight is an estimate too, however good, so it flags the same
  // way. Anything other than a tracked coordinate must be marked, or a model's
  // output gets read downstream as a measurement.
  const positionEstimated = collisionPosition == null && observedPlayLanding == null && (
    flownPosition != null
    || ((record.x == null || resetEndpoint) && record.projectedX != null)
    || estimatedPosition != null
  )
  // Height matters for placement: both of the first two home runs measured
  // here ended well above the ground (30.6 ft into the stands, 15.6 ft off the
  // top of the wall), and a marker drawn at the ground point beneath an
  // elevated ball reads short in a perspective view. An extrapolated landing
  // has no tracked height -- it was projected to ground level by definition.
  // A projected landing is at ground level by definition, so it carries no
  // height -- which is also why replacing a mid-flight endpoint with one fixes
  // the drawing in a park with no PARK_IMAGE_VERTICAL fitted: there is no
  // elevation left to get wrong.
  const worldY = collisionPosition?.y
    ?? observedPlayLanding?.y
    ?? ((record.x != null && !midFlightEndpoint && !resetEndpoint) ? record.y : null)
  // Keep the dot at the measured obstruction, but for a confirmed home run use
  // the unobstructed carry as its distance. Ordinary wall balls and catches keep
  // their measured impact distance; the caller knows the scoring result and
  // opts in only for HR/IPHR.
  const projectedImpactCarry = projectCarryAtImpact
    ? trackerProjectedCarryFromObservedImpact(record)
    : null
  const fields = {
    exit_velocity_mph: normalizedExitVelocity,
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
      projectedImpactCarry?.distanceFeet
      ?? (worldX != null && worldZ != null
        ? trackerDistanceFeetFromCoordinates(worldX, worldZ)
        : null)
        ?? (resetEndpoint
          ? null
          : normalizeTrackerDistanceFeet(record.distanceFeet, record.recordFeetPerUnit))
        ?? projected?.distanceFeet ?? null,
    ),
    hit_angle_deg: record.sprayAngleDeg,
  }
  if (observedPlayLanding?.hangTimeSec != null) fields.hang_time_sec = observedPlayLanding.hangTimeSec
  else if (record.hangTimeSec != null) fields.hang_time_sec = record.hangTimeSec
  else if (projected?.hangTimeSec != null) fields.hang_time_sec = projected.hangTimeSec
  if (stadiumKey) {
    fields.hit_stadium_key = stadiumKey
    const geometry = trackerBattedBallPlotGeometry(record, fields.hit_distance_ft)
    const spot = (worldX != null && worldZ != null
      ? projectTrackerWorldSpot({
        x: worldX,
        y: worldY,
        z: worldZ,
        estimated: positionEstimated,
        // A catch is shown where the glove actually was, including one at the
        // wall. Landings and unresolved flights may finish behind the wall and
        // need the park's display-only occlusion clearance.
        revealOccludedLanding: trackerBattedBallShouldRevealOccludedLanding(record, stadiumKey, play),
      }, stadiumKey)
      : null)
      ?? (geometry && projectTrackerFieldSpot(geometry.distanceFeet, geometry.angleDeg, stadiumKey))
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
export function isTrackerRobbedHomeRun({ record, isBuddyJump, stadiumKey } = {}) {
  if (!isBuddyJump || record?.endpoint !== 'catch' || !stadiumKey) return false
  const geometry = trackerBattedBallPlotGeometry(record)
  if (!geometry) return false
  // Landing/catch direction, not launch spray: a curving ball can move ten
  // degrees before the glove, enough to select a meaningfully different wall.
  const wallDistance = fenceDistanceFeet(stadiumKey, geometry.angleDeg)
    ?? estimateTrackerWallDistance(geometry.angleDeg, stadiumKey)
  const hitDistance = geometry.distanceFeet
  return wallDistance != null
    && Number(hitDistance) >= wallDistance - TRACKER_ROBBED_HR_WALL_MARGIN_FT
}

export function trackerFieldedBallPaFields(record, { stadiumKey = null } = {}) {
  if (!record || !stadiumKey) return {}
  const geometry = trackerBattedBallPlotGeometry(record)
  const spot = (trackerEndpointIsCoordinateReset(record)
    ? null
    : projectTrackerWorldSpot({ x: record.x, y: record.y, z: record.z }, stadiumKey))
    ?? (geometry && projectTrackerFieldSpot(geometry.distanceFeet, geometry.angleDeg, stadiumKey))
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

export function parseTrackerStarSwingMessage(message) {
  const match = String(message || '').match(/^(.+?)\s+used a star swing!$/i)
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

// Most star-swing announcements precede the pitch result, but strike-three
// announcements can arrive immediately after the strikeout line. Attribute
// both orderings to the actual pitch instead of treating every later contact
// in the plate appearance as star-powered.
export function markTrackerStarSwing(buffer, message) {
  if (!buffer) return false
  const batterName = parseTrackerStarSwingMessage(message)
  if (!batterName || batterName !== buffer.batterName) return false
  buffer.starHitUsed = true

  if (buffer.result === 'K') {
    const lastPitch = buffer.pitches?.at(-1)
    if (lastPitch) {
      if (Object.hasOwn(lastPitch, 'is_star_swing')) lastPitch.is_star_swing = true
      else lastPitch.isStarSwing = true
      return true
    }
  }

  buffer.pendingStarSwing = true
  return true
}

export function consumeTrackerPitch(buffer, pitch) {
  const taggedPitch = {
    ...pitch,
    isStarPitch: Boolean(buffer?.pendingStarPitch || pitch?.isStarPitch),
    isStarSwing: Boolean(buffer?.pendingStarSwing || pitch?.isStarSwing),
  }
  if (buffer) {
    buffer.pendingStarPitch = false
    buffer.pendingStarSwing = false
  }
  return taggedPitch
}

export function trackerPitchStatFields(pitch) {
  const telemetry = pitch?.pitchTelemetry || pitch?.pitch_telemetry || null
  const fields = {
    is_star_pitch: Boolean(pitch?.isStarPitch),
    is_star_swing: Boolean(pitch?.isStarSwing ?? pitch?.is_star_swing),
    result: pitch?.type,
    count_balls_before: pitch?.before?.balls,
    count_strikes_before: pitch?.before?.strikes,
    count_balls_after: pitch?.after?.balls,
    count_strikes_after: pitch?.after?.strikes,
    pitch_type: pitch?.pitchType || null,
  }

  const hasPitchTelemetry = Boolean(telemetry) || pitch?.pitch_speed_mph != null
  if (!hasPitchTelemetry) return fields

  return {
    ...fields,
    pitch_speed_mph: finiteTrackerNumber(telemetry?.speedMph ?? pitch?.pitch_speed_mph),
    pitch_elapsed_seconds: finiteTrackerNumber(telemetry?.elapsedSeconds),
    pitch_path_distance_ft: finiteTrackerNumber(telemetry?.pathDistanceFeet),
    pitch_direct_distance_units: finiteTrackerNumber(telemetry?.directDistanceUnits),
    pitch_horizontal_delta_units: finiteTrackerNumber(telemetry?.horizontalDeltaUnits),
    pitch_vertical_delta_units: finiteTrackerNumber(telemetry?.verticalDeltaUnits),
    pitch_forward_delta_units: finiteTrackerNumber(telemetry?.forwardDeltaUnits),
    pitch_horizontal_range_units: finiteTrackerNumber(telemetry?.horizontalRangeUnits),
    pitch_vertical_range_units: finiteTrackerNumber(telemetry?.verticalRangeUnits),
    pitch_horizontal_chord_deviation_units: finiteTrackerNumber(telemetry?.horizontalChordDeviationUnits),
    pitch_vertical_chord_deviation_units: finiteTrackerNumber(telemetry?.verticalChordDeviationUnits),
    pitch_tracking_sample_count: finiteTrackerNumber(telemetry?.sampleCount),
    pitch_tracking_start_seq: finiteTrackerNumber(telemetry?.startSeq),
    pitch_tracking_end_seq: finiteTrackerNumber(telemetry?.endSeq),
    pitch_tracking_status: telemetry?.status || null,
    pitch_tracking_terminal: telemetry?.terminal || null,
    pitch_tracking_classifier: telemetry?.classifier || null,
    pitch_tracking_classifier_status: telemetry?.classifierStatus || null,
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

export function copyTrackerRunnerState(runners = {}) {
  return {
    first: runners.first || null,
    second: runners.second || null,
    third: runners.third || null,
  }
}

// The tracker does not publish a complete base snapshot with every matchup.
// It only emits the occupied bases whose runner changed. Apply one of those
// delta records without leaving the same runner behind on their old base.
export function applyTrackerRunnerDelta(runners = {}, { base, runner } = {}) {
  const next = copyTrackerRunnerState(runners)
  const key = trackerRunnerKey(runner)
  if (!['first', 'second', 'third'].includes(base) || !key) return next

  for (const candidate of ['first', 'second', 'third']) {
    if (trackerRunnerKey(next[candidate]) === key) next[candidate] = null
  }
  next[base] = runner
  return next
}

// Run and putout messages are the delta feed's only indication that a runner
// disappeared entirely rather than moving to another base.
export function removeTrackerRunner(runners = {}, runner) {
  const next = copyTrackerRunnerState(runners)
  const key = trackerRunnerKey(runner)
  if (!key) return next
  for (const base of ['first', 'second', 'third']) {
    if (trackerRunnerKey(next[base]) === key) next[base] = null
  }
  return next
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
//
// A CAUGHT LINE DRIVE IS ONE TOO. OBR 9.08(d) says "fly ball or line drive",
// and this used to gate on 'FO' alone -- but a caught ball is turned into 'LO'
// by launch angle one step earlier, so every sac fly hit under 25 degrees was
// unreachable by this rule. Daisy Cruiser 2026-09-04 had two of them, both
// Blue Pianta, both scored as plain lineouts, and the game's own log announced
// "recorded a sacrifice fly!" on both while the console called them outs. That
// is two phantom at-bats and two lost sacrifices in one game.
const TRACKER_SAC_FLY_ELIGIBLE_RESULTS = new Set(['FO', 'LO'])

export function shouldReclassifyTrackerFlyOutAsSacFly({
  result, outsBeforePa, scoredNonBatterRunner, isBunt = false,
}) {
  if (isBunt) return false
  return TRACKER_SAC_FLY_ELIGIBLE_RESULTS.has(result)
    && Boolean(scoredNonBatterRunner) && Number(outsBeforePa || 0) < 2
}

// The tracker reports a bobble as a fielding event, not an official scoring
// decision. Only turn it into an error when the batter actually reaches on the
// batted ball. If another fielder recovers the bobble and completes the out,
// the play remains an out and no error is charged.
//
// IPHR IS IN THE SET because it is the batter reaching and then continuing. It
// was missing, and the gap is not academic: Baby Daisy's 2026-09-04 Daisy
// Cruiser ball was a 96 ft GROUND BALL that Wiggler (2B) reached standing up,
// 0.59 units away, and did not hold -- an ordinary-effort boot by every test
// this file applies -- and she circled the bases on it. The console called it
// an inside-the-park home run with no error, because the result was not in
// this list and the question was never asked. The vetoes below are what stop
// this from downgrading a real one: a deep ball nobody could have handled
// leaves no confirmed ordinary contact to charge.
const TRACKER_BATTED_BALL_SAFE_RESULTS = new Set(['1B', '2B', '3B', 'IPHR', 'ROE', 'FC'])

// The hits a charged bobble turns into a reached-on-error. Every safe result
// that is a HIT is here -- the batter did not earn the base, so it is not one.
// 'ROE' and 'FC' are already what they should be and are deliberately absent.
export const TRACKER_ERROR_DOWNGRADED_RESULTS = Object.freeze(['1B', '2B', '3B', 'IPHR'])

const TRACKER_OUTFIELD_POSITIONS = new Set(['LF', 'CF', 'RF'])

// WHY A CHARGED ERROR DOES NOT ALWAYS TAKE THE HIT AWAY.
//
// The downgrade above assumes the error is WHY the batter is standing on a
// base. That is the usual case and it stays the default. It was not this one:
//
//   Mario Stadium PA 43. King Boo's line drive reached the ground UNTOUCHED
//   67 units out; Wario (CF) booted it 1.7 s later, 91 units out; King Boo
//   took second. The game's own log scored it "a star double", "2 RBI" and
//   "Green Noki has allowed 3 hits". The console charged E8 -- correct, the
//   boot is an error -- and then erased the double, so the batter lost a hit
//   and two RBI for a misplay that happened after he was already past first.
//
// Two measured facts have to hold together, and neither is enough alone:
//
//   THE BALL REACHED THE GROUND UNTOUCHED. `ball_landed_before_contact` means
//     no catch was ever available, so the batter was never going to be retired
//     in the air. A dropped fly is the opposite case and still downgrades.
//
//   THE BOOT WAS AN OUTFIELDER'S. No throw from the outfield retires a batter
//     at first base, so a ball already on the grass out there was a base hit
//     before anyone touched it.
//
// THE SECOND CONDITION IS NOT DECORATION, and "the batter took extra bases"
// cannot replace it. Baby Daisy's Daisy Cruiser ball -- the one the IPHR entry
// above exists for -- also reached the ground untouched and she circled the
// bases on it, but it was a 96 ft GROUND BALL that 2B booted 34 units from
// home. She went round BECAUSE of the error. Across the archive the two groups
// do not even touch: infield boots on landed balls sit between 24.6 and 43.1
// units from home, outfield boots between 60.7 and 113.6.
//
// The error is still charged either way. It is charged for what it actually
// cost -- the extra bases -- rather than for the batter reaching at all.
export function trackerBootLeftTheHitStanding(event) {
  if (!event) return false
  return event.ball_landed_before_contact === true
    && TRACKER_OUTFIELD_POSITIONS.has(String(event.by || ''))
}

export function trackerErrorKeptTheHit({ bobbleFielderName, play = null } = {}) {
  const name = String(bobbleFielderName || '').trim()
  if (!name || !play) return null
  const events = (play.fielding_events || []).filter((event) => event.character === name)
  // The same "first involvement" the veto above judges: a later clean pickup
  // by the same fielder is the recovery, not the misplay.
  const attempts = events.filter((event) => event.event_type !== 'possession' || !event.secured)
  const first = (attempts.length ? attempts : events)[0]
  if (!trackerBootLeftTheHitStanding(first)) return null
  return {
    position: first.by,
    detail: 'the ball reached the ground untouched before an outfielder booted it, '
      + 'so the batter had his base before the misplay happened',
    event: first,
  }
}

/**
 * Whether a charged bobble should turn this hit into a reached-on-error.
 *
 * Shared so the bridge and the preview cannot drift: they scored the same
 * at-bat two different ways once already, and a scoring rule that lives in two
 * copies is a scoring rule that eventually disagrees with itself.
 */
export function shouldDowngradeTrackerHitToRoe({ result, bobbleFielderName, play = null } = {}) {
  if (!TRACKER_ERROR_DOWNGRADED_RESULTS.includes(result)) return false
  return !trackerErrorKeptTheHit({ bobbleFielderName, play })
}

// WHY A BOBBLE IS NOT ENOUGH ON ITS OWN.
//
// The tracker .exe announces "X bobbled the ball!" from the game's fielding
// action byte, which fires for several mechanics that share one animation. An
// error under the rules needs more than that: it needs a ball the fielder
// could have handled with ORDINARY EFFORT and did not. The 60 Hz capture is
// the only thing that can tell those apart, and in one nine-inning game it
// vetoed seven of eleven charged errors -- every one of which the operator had
// already flagged by hand.
//
// The three vetoes, each a rule rather than a heuristic:
//
//   A STAR BALL (codes 4, 5)  Yoshi's captain star swing turns the ball into
//     an egg, and Mario's turns it into a fireball. Either way the first
//     contact is a forced misplay: the fielder has no play to make, the
//     mechanic makes the miss, and charging it charges a fielder for the
//     BATTER's ability.
//
//   NO CONTACT AT ALL         `ball_contact: 'missed'` means the capture
//     watched the fielder reach for the ball and never touch it. You cannot
//     boot a ball you never had, and a ball that beats a fielder outright is a
//     hit.
//
//   A DIVE OR A LEAP          Official scoring charges an error only on
//     ordinary effort. A dive or a leap is extraordinary effort by definition,
//     so a ball missed while diving for it is a hit, not an error -- which is
//     exactly how the same play is scored in the real game.
//
// Everything else -- a fielder who reached the ball standing up and did not
// hold it -- still gets the error it always did.
//
// THE ORDER MATTERS, and it is not arbitrary. Each reason is a sentence the
// console prints, so the one it picks has to be true alongside the rest of the
// narrative. When the capture measured no contact, "the ball was reached on a
// dive" is not merely a weaker reason, it CONTRADICTS the attempt sentence two
// lines above it -- which is exactly what a dive that never touched the ball
// produced. So no-contact is checked before extraordinary effort.
const BOBBLE_VETO_REASONS = Object.freeze({
  star_ball: "the batter's star ball forced the first contact, so there was no ordinary play to make",
  egg: 'a Yoshi Egg forced the first contact, so there was no ordinary play to make',
  no_contact: 'the capture recorded no contact with the ball at all',
  out_of_reach: 'the ball never came within reach of the fielder',
  not_on_the_play: 'the capture has the named fielder doing nothing on this play, '
    + 'while a different fielder made confirmed contact with the ball',
  extraordinary: 'the ball was reached on a dive or a leap, which is not ordinary effort',
})

/**
 * Why the 60 Hz capture says this bobble is not an error, or null if it is.
 *
 * `play` is the joined player-tracking play. With no play there is no evidence
 * either way and the tracker's own call stands -- absence of the capture must
 * never invent an exoneration.
 */
export function trackerBobbleErrorVeto({ bobbleFielderName, play } = {}) {
  const name = String(bobbleFielderName || '').trim()
  if (!name || !play) return null
  const events = (play.fielding_events || []).filter((event) => event.character === name)
  if (!events.length) {
    // NOT ON THE PLAY AT ALL. A fielder with no event is normally the capture
    // having nothing to say, and silence must not exonerate -- so this needs
    // POSITIVE evidence, not an empty list. It is the pair of conditions that
    // supplies it: the capture watched the whole play, saw this fielder make
    // no attempt and no approach, and saw a DIFFERENT fielder actually touch
    // the ball. That is not "we did not see him boot it", it is "we saw who
    // handled the ball and it was somebody else".
    //
    // Peach Ice Garden PA 38 is the case: the .exe announced a Koopa Troopa
    // bobble on a line drive down the LEFT-field line, overriding its own
    // "recorded a double" and charging E9 to the right fielder, while the
    // capture has Red Noki (LF) taking possession under a possession lock and
    // Koopa Troopa in no event and no approach window.
    const attempted = (play.catch_approaches || []).some(
      (approach) => approach.character === name)
    const handledByAnother = (play.fielding_events || []).some(
      (event) => event.character !== name && event.ball_contact === 'confirmed')
    if (!attempted && handledByAnother) {
      return {
        reason: 'not_on_the_play',
        detail: BOBBLE_VETO_REASONS.not_on_the_play,
        event: null,
      }
    }
    return null
  }

  // The fielder's own first involvement is the one the bobble describes; a
  // later clean pickup by the same fielder is the recovery, not the misplay.
  const attempts = events.filter((event) => event.event_type !== 'possession' || !event.secured)
  const first = (attempts.length ? attempts : events)[0]

  if (first.mechanic === 'egg') return { reason: 'egg', detail: BOBBLE_VETO_REASONS.egg, event: first }
  if (first.mechanic === 'star_ball') {
    return { reason: 'star_ball', detail: BOBBLE_VETO_REASONS.star_ball, event: first }
  }
  if (first.within_reach === false) {
    const reach = Number(first.closest_reach_units)
    return {
      reason: 'out_of_reach',
      detail: BOBBLE_VETO_REASONS.out_of_reach
        + (Number.isFinite(reach) ? ` — its closest approach was ${reach.toFixed(1)} units` : ''),
      event: first,
    }
  }
  // The attempt is what is judged, not the whole play: a fielder who is beaten
  // by the ball and then chases it down still made no play on it when it
  // mattered, and recovering it afterwards is not contact with the chance he
  // missed. Only an explicit 'missed' exonerates -- 'unknown' is the capture
  // saying it could not tell, which is not evidence of innocence.
  if (first.ball_contact === 'missed') {
    const reach = Number(first.closest_reach_units)
    return {
      reason: 'no_contact',
      detail: BOBBLE_VETO_REASONS.no_contact
        + (Number.isFinite(reach) ? ` — its closest approach was ${reach.toFixed(1)} units` : ''),
      event: first,
    }
  }
  if (first.dive === true || first.leap === true) {
    return { reason: 'extraordinary', detail: BOBBLE_VETO_REASONS.extraordinary, event: first }
  }
  return null
}

export function shouldChargeTrackerBobbleError({ bobbleFielderName, result, play = null }) {
  if (!String(bobbleFielderName || '').trim()) return false
  if (!TRACKER_BATTED_BALL_SAFE_RESULTS.has(result)) return false
  return !trackerBobbleErrorVeto({ bobbleFielderName, play })
}

/**
 * The measured throwing error on this play, or null.
 *
 * A different charge from the bobble above, and from a different source: the
 * tracker log never announces this one. The capture measures that an
 * inaccurate throw pulled the receiver off the base while a runner was still
 * arriving and no out followed -- a wild throw that permitted an advance,
 * which is an error under OBR 9.12(a)(1), charged to the thrower.
 *
 * WHY IT IS SAFE TO CHARGE AUTOMATICALLY. The pattern is deliberately narrow.
 * Across the eleven archived sessions (926 plays) it fires twice, and the
 * derivation already reclassifies one of those as a runner knocking the ball
 * loose (`event_type: 'loose_ball_recovery'`, which sets `is_throw: false` and
 * so never reaches the candidate flag). Not one throw that recorded an out has
 * ever had its receiver pulled off the base.
 *
 * It is charged for the RUNNER it let advance, never for the batter reaching,
 * so unlike a bobble it does not turn a hit into a reached-on-error.
 */
export function trackerPlayThrowingError(play) {
  const throwRecord = (play?.throws || []).find((entry) => entry?.throwing_error_candidate === true)
  if (!throwRecord) return null
  return {
    character: throwRecord.thrower_character || null,
    position: throwRecord.thrower_position || null,
    sequence: throwRecord.sequence ?? null,
    targetBase: throwRecord.target_base ?? null,
    receiverDistanceFromTargetUnits: throwRecord.receiver_distance_from_target_units ?? null,
    runnerAtArrival: throwRecord.runner_at_arrival ?? null,
  }
}

/**
 * The fielding position this character occupied ON THIS PLAY.
 *
 * The session's alignment is the lineup as announced, and it goes stale the
 * moment a pitching change swaps two players' positions -- the game moves the
 * outgoing pitcher into the field and the alignment keeps them at P. Charging
 * an error off that alignment put an E1 on a second baseman. The 60 Hz capture
 * reads each fielder's slot from memory on the play itself, so it is the only
 * source that cannot be stale.
 */
export function trackerPlayFieldingPosition(play, characterName) {
  const name = String(characterName || '').trim()
  if (!name || !play?.fielders) return null
  for (const [position, fielder] of Object.entries(play.fielders)) {
    if (fielder?.character === name) return position
  }
  return null
}

// The stock log credits only conventional assists. The 60 Hz play sees the
// actual sequence, including an outfielder redirect and a failed-but-effective
// deflection before a relay. Build the scoring chain through the throw that
// records the final out, while excluding incidental touches that did not alter
// the play.
export function trackerPlayOutChainPositions(play) {
  const throws = (play?.throws || []).filter((entry) => entry?.is_throw !== false)
  let finalOutThrowIndex = -1
  throws.forEach((entry, index) => {
    if (Number(entry?.outs_recorded || 0) > 0) finalOutThrowIndex = index
  })
  // A buddy-toss receiver can step on first before making another throw. The
  // force out belongs to the handoff itself, so no throw carries outs_recorded;
  // the batter's zero bases plus a secured buddy receive at 1B is the direct
  // evidence that distinguishes it from an otherwise identical safe handoff.
  const buddyForceOut = finalOutThrowIndex < 0
    && play?.runners?.BAT?.bases_ran != null
    && Number(play.runners.BAT.bases_ran) === 0
    ? (play?.fielding_events || []).find((entry) => (
      entry?.ball_contact === 'confirmed'
      && entry?.secured
      && entry?.mechanic === 'buddy_receive'
      && entry?.by === '1B'
    ))
    : null
  if (finalOutThrowIndex < 0 && !buddyForceOut) return []

  const scoringThrows = finalOutThrowIndex >= 0
    ? throws.slice(0, finalOutThrowIndex + 1)
    : []
  const cutoffFrame = Number(
    finalOutThrowIndex >= 0 ? scoringThrows.at(-1)?.arrival_frame : buddyForceOut?.frame,
  )
  // Only a repeat of the position already on the end of a chain is dropped --
  // a fielder possessing and then throwing is one link, not two. A position
  // that comes back around later is a real second touch and scores as one:
  // 3-6-3 on a double play, 1-2-3 on a rundown.
  const appended = (chain, position) => {
    const normalized = String(position || '').trim()
    if (normalized && chain.at(-1) !== normalized) chain.push(normalized)
    return chain
  }

  // The throws already carry the whole custody sequence in order, each one's
  // receiver being the next one's thrower, so they are the spine of the chain.
  const throwChain = []
  for (const entry of scoringThrows) {
    appended(throwChain, entry?.thrower_position)
    appended(throwChain, entry?.receiver_position)
  }

  // Touches are prepended for the fielders the throws do not already name --
  // a deflection off someone who never threw, or the fielder who started a
  // buddy sequence. A fielder the spine already has is not repeated here; the
  // spine is where their place in the order is known.
  const positions = []
  for (const event of play?.fielding_events || []) {
    if (event?.ball_contact !== 'confirmed') continue
    if (Number.isFinite(cutoffFrame) && Number(event?.frame) > cutoffFrame) continue
    const effectiveDeflection = !event?.secured
      && Math.abs(Number(event?.trajectory_turn_degrees || 0)) >= 10
    if (!event?.secured && !effectiveDeflection) continue
    if (throwChain.includes(String(event?.by || '').trim())) continue
    appended(positions, event?.by)
  }
  for (const position of throwChain) appended(positions, position)
  return positions
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
