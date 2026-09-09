import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyTrackerBattedBallToBuffer,
  applyTrackerFieldedBallToBuffer,
  applyTrackerRunnerDelta,
  attachTrackerTrajectory,
  buildExactTrackerRunnerAssignments,
  copyTrackerRunnerState,
  isTrackerBuntedBall,
  isTrackerRobbedHomeRun,
  numberTrackerPitches,
  parseTrackerBattedBallMessage,
  parseTrackerFieldedBallMessage,
  parseTrackerHitByPitchMessage,
  removeTrackerRunner,
  shouldChargeTrackerBobbleError,
  shouldDowngradeTrackerHitToRoe,
  trackerBobbleErrorVeto,
  shouldClassifyTrackerFielderChoice,
  shouldClassifyTrackerSacrificeBunt,
  shouldCreditTrackerPutout,
  shouldReclassifyTrackerFlyOutAsSacFly,
  trackerBattedBallMatchesMatchup,
  trackerBattedBallPaFields,
  normalizeTrackerExitVelocity,
  trackerBattedBallPlotGeometry,
  trackerBattedBallShouldRevealOccludedLanding,
  trackerProjectedCarryFromObservedImpact,
  trackerEndpointHasObservedImpact,
  trackerEndpointIsCoordinateReset,
  trackerEndpointIsMidFlight,
  trackerTrajectoryCollision,
  trackerTrajectoryFirstImpact,
  trackerTrajectoryLanding,
  parseTrackerBallSampleMessage,
  TrackerBallSampleBuffer,
  trackerBattedBallTrajectory,
  trackerCaughtBallResult,
  trackerFieldedBallPaFields,
  applyMeasuredPitchOffers,
  measuredPitchMatchesPa,
  trackerContactWasBunt,
  trackerPitchStatFields,
  trackerPlayOutChainPositions,
} from '../scripts/tracker_play_events.mjs'
import { projectTrackerBattedBallDistanceFeet } from '../scripts/tracker_field_projection.mjs'
import { positionAt, predictFirstTouch } from '../scripts/ball_flight_model.mjs'
import { FEET_PER_UNIT, HOME_PLATE, polarToWorld, worldToPolar } from '../src/utils/parkGeometry.js'

// Exit velocity is stored on the canonical 1-metre-per-unit scale. Every
// fixture below is a pre-2026-08-14 record with no feet_per_unit field, which
// means it was produced on the old locked 3.0 scale and is converted on read --
// see normalizeTrackerExitVelocity. Written as a conversion rather than a
// literal so the factor being applied is visible in the expectation.
const onCanonicalScale = (mph) => mph * (FEET_PER_UNIT / 3)

const bowserLandingRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=41|batter=Bowser|pitcher=Mario|exit_speed_mph=85.0|launch_degrees=35.2|spray_degrees=12.0|side=first_base|endpoint=landing|endpoint_status=fair|endpoint_seq=306|x=29.0159225|y=0.264784217|z=-71.6531067|distance_feet=229.2'
const bowserTimedLandingRecord = `${bowserLandingRecord}|flight_updates=265|hang_time_seconds=4.421|wall_time_seconds=4.820`
const bowserCurrentTimedLandingRecord = `${bowserLandingRecord}|flight_updates=265|sampled_updates_seconds=4.421|hang_time_seconds=4.820`
const kingKRoolLandingRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=4760|batter=King K. Rool|pitcher=Green Paratroopa|exit_speed_mph=97.6|launch_degrees=-0.8|spray_degrees=-14.6|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=4786|x=-5.77596045|y=0.2675789|z=-22.8378239|distance_feet=67.8'
const luigiCatchRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=2371|batter=Luigi|pitcher=Green Paratroopa|exit_speed_mph=92.2|launch_degrees=47.0|spray_degrees=16.5|side=first_base|endpoint=catch|endpoint_status=caught|endpoint_seq=2778|x=32.7537613|y=0|z=-90.8825378|distance_feet=287.0'
const wigglerFoulRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=1198|batter=Wiggler|pitcher=Green Paratroopa|exit_speed_mph=94.6|launch_degrees=35.7|spray_degrees=35.1|side=first_base|endpoint=foul|endpoint_status=foul|endpoint_seq=none|x=none|y=none|z=none|distance_feet=none'
const bowserJrDeepHrUnresolvedRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=903|batter=Bowser Jr.|pitcher=Wario|exit_speed_mph=110.0|launch_degrees=30.0|spray_degrees=8.0|side=first_base|endpoint=unresolved|endpoint_status=next_pitch_counter|endpoint_seq=none|x=none|y=none|z=none|distance_feet=none|flight_updates=none|sampled_updates_seconds=none|hang_time_seconds=none'
const boomerangBroLavaHrRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=5377|batter=Boomerang Bro.|pitcher=Bowser|exit_speed_mph=108.9|launch_degrees=47.0|spray_degrees=7.1|side=first_base|endpoint=landing|endpoint_status=fair|endpoint_seq=5811|x=35.9727173|y=0.25|z=-102.855698|distance_feet=354.8|projected_x=none|projected_z=none|flight_updates=434|sampled_updates_seconds=7.241|hang_time_seconds=8.777|feet_per_unit=3.2808'
const redKritterPlayroomDeckRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=630|batter=Red Kritter|pitcher=Bowser|exit_speed_mph=107.5|launch_degrees=46.9|spray_degrees=-24.1|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=1038|x=-55.1018105|y=6.31525373|z=-76.60923|distance_feet=307.3|projected_x=none|projected_z=none|flight_updates=408|sampled_updates_seconds=6.807|hang_time_seconds=8.376|feet_per_unit=3.2808'
const redPiantaWallTopRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=8578|batter=Red Pianta|pitcher=Hammer Bro.|exit_speed_mph=106.6|launch_degrees=47.5|spray_degrees=23.2|side=first_base|endpoint=landing|endpoint_status=fair|endpoint_seq=8988|x=53.5876961|y=8.91413593|z=-79.6174774|distance_feet=312.3|projected_x=none|projected_z=none|flight_updates=410|sampled_updates_seconds=6.840|hang_time_seconds=7.275|feet_per_unit=3.2808'
const birdoPillarTopRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=11304|batter=Birdo|pitcher=Hammer Bro.|exit_speed_mph=109.5|launch_degrees=47.6|spray_degrees=-22.2|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=11705|x=-45.6168823|y=11.881341|z=-87.0496521|distance_feet=320.4|projected_x=none|projected_z=none|flight_updates=401|sampled_updates_seconds=6.690|hang_time_seconds=8.244|feet_per_unit=3.2808'
const yellowPiantaWallBounceRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=8053|batter=Yellow Pianta|pitcher=Hammer Bro.|exit_speed_mph=110.9|launch_degrees=47.6|spray_degrees=-0.2|side=center|endpoint=unresolved|endpoint_status=tracking_stalled+extrapolated_from_last_frame|endpoint_seq=none|x=none|y=none|z=none|distance_feet=302.5|projected_x=3.40243367|projected_z=-92.8973647|flight_updates=none|sampled_updates_seconds=none|hang_time_seconds=9.984|feet_per_unit=3.2808'
const peteyRearWallRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=902|batter=Petey Piranha|pitcher=Bowser|exit_speed_mph=114.9|launch_degrees=36.1|spray_degrees=27.8|side=first_base|endpoint=landing|endpoint_status=fair|endpoint_seq=1226|x=64.5700531|y=14.9523716|z=-90.7503738|distance_feet=363.1|projected_x=none|projected_z=none|flight_updates=324|sampled_updates_seconds=5.405|hang_time_seconds=6.939|feet_per_unit=3.2808'
const birdoCenterWallTopRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=9973|batter=Birdo|pitcher=Hammer Bro.|exit_speed_mph=109.5|launch_degrees=48.0|spray_degrees=-9.2|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=10386|x=-16.8234253|y=9.05059242|z=-101.906219|distance_feet=335.7|projected_x=none|projected_z=none|flight_updates=413|sampled_updates_seconds=6.890|hang_time_seconds=8.459|feet_per_unit=3.2808'
const wigglerWallTopRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=450|batter=Wiggler|pitcher=Bowser|exit_speed_mph=108.0|launch_degrees=47.6|spray_degrees=-22.2|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=861|x=-51.7471199|y=8.99770355|z=-81.3781357|distance_feet=313.7|projected_x=none|projected_z=none|flight_updates=411|sampled_updates_seconds=6.857|hang_time_seconds=7.272|feet_per_unit=3.2808'
const redYoshiFieldedRecord = '[TRACKER_BALL_FIELDED_PROVISIONAL] contact_seq=228|batter=Red Yoshi|pitcher=Mario|fielded_seq=279|time_ns=21364236395200|x=12.732379|y=0.251562238|z=-27.107254|distance_feet=87.0|spray_degrees=25.3|fielding_time_seconds=1.253|source=this_pitch.fair_or_foul+latest_physical_sample'
const tinyKongPiranhaRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=146|batter=Tiny Kong|pitcher=Baby Mario|exit_speed_mph=87.7|launch_degrees=26.5|spray_degrees=17.5|side=first_base|endpoint=unresolved|endpoint_status=tracking_stalled+extrapolated_from_last_frame|endpoint_seq=none|x=none|y=none|z=none|distance_feet=594.6|projected_x=-171.73144|projected_z=-56.9315353|flight_updates=none|sampled_updates_seconds=none|hang_time_seconds=6.595|feet_per_unit=3.2808'

test('pitch stat rows retain compact velocity and movement measurements', () => {
  const fields = trackerPitchStatFields({
    type: 'swinging_miss',
    pitchType: 'curveball',
    before: { balls: 1, strikes: 1 },
    after: { balls: 1, strikes: 2 },
    pitchTelemetry: {
      speedMph: 54.2,
      elapsedSeconds: 0.72,
      pathDistanceFeet: 55.1,
      directDistanceUnits: 16.4,
      horizontalDeltaUnits: -2.1,
      verticalDeltaUnits: -1.4,
      forwardDeltaUnits: 16.2,
      horizontalRangeUnits: 2.4,
      verticalRangeUnits: 1.8,
      horizontalChordDeviationUnits: -0.31,
      verticalChordDeviationUnits: 0.42,
      sampleCount: 44,
      startSeq: 100,
      endSeq: 143,
      status: 'measured',
      terminal: 'strike',
      classifier: 'movement_v1',
      classifierStatus: 'classified',
    },
  })

  assert.equal(fields.pitch_speed_mph, 54.2)
  assert.equal(fields.pitch_horizontal_chord_deviation_units, -0.31)
  assert.equal(fields.pitch_vertical_chord_deviation_units, 0.42)
  assert.equal(fields.pitch_tracking_sample_count, 44)
  assert.equal(fields.pitch_tracking_start_seq, 100)
  assert.equal(fields.pitch_tracking_end_seq, 143)
  assert.equal(fields.pitch_tracking_classifier, 'movement_v1')
  assert.equal(fields.pitch_type, 'curveball')
})

test('advanced landing records map directly to the existing PA stat fields', () => {
  const record = parseTrackerBattedBallMessage(bowserLandingRecord)
  assert.deepEqual(record, {
    contactSeq: 41,
    batterName: 'Bowser',
    pitcherName: 'Mario',
    exitVelocityMph: 85,
    launchAngleDeg: 35.2,
    sprayAngleDeg: 12,
    spraySide: 'first_base',
    endpoint: 'landing',
    endpointStatus: 'fair',
    endpointSeq: 306,
    x: 29.0159225,
    y: 0.264784217,
    z: -71.6531067,
    projectedX: null,
    projectedZ: null,
    distanceFeet: 229.2,
    // Absent on this build, so the scale of distanceFeet is unknowable and it
    // is never used to position anything.
    recordFeetPerUnit: null,
    flightUpdates: null,
    hangTimeSec: null,
    sampledUpdatesSec: null,
    wallTimeSec: null,
  })
  assert.deepEqual(trackerBattedBallPaFields(record), {
    exit_velocity_mph: onCanonicalScale(85),
    // The ball's own coordinates, stored as measured — every position
    // downstream is derived from these rather than from the launch angle.
    hit_world_x: 29.0159225,
    hit_world_z: -71.6531067,
    hit_world_y: 0.264784217,
    launch_angle_deg: 35.2,
    // Derived from the coordinates at the measured scale, not the 229.2 the
    // executable emitted using whatever scale it was built with.
    hit_distance_ft: 251.5,
    hit_angle_deg: 12,
  })
})

test('exit velocity is stored on one scale no matter which build recorded it', () => {
  // Historical executables used both 3.0 and 3.3532 ft/unit. Neither is the
  // current 1-metre scale, so both must be normalized on read.
  const legacy = 98.0

  const intermediate = normalizeTrackerExitVelocity(109.5, 3.3532)
  assert.ok(Math.abs(intermediate - (109.5 * FEET_PER_UNIT / 3.3532)) < 1e-9)
  assert.ok(intermediate < 109.5)
  // Current exact and four-decimal scale markers are inert.
  assert.equal(normalizeTrackerExitVelocity(109.5, FEET_PER_UNIT), 109.5)
  assert.equal(normalizeTrackerExitVelocity(109.5, 3.2808), 109.5)

  // A record stating the old scale, and one from a build too old to state any,
  // are both converted — and to the same place.
  const stated = normalizeTrackerExitVelocity(legacy, 3)
  const silent = normalizeTrackerExitVelocity(legacy, null)
  assert.equal(stated, silent)
  assert.ok(Math.abs(stated - (legacy * (FEET_PER_UNIT / 3))) < 1e-9)
  assert.ok(stated > legacy, 'the old scale understated exit velocity')

  // Number(null) and Number('') are both 0, which would record a missing exit
  // velocity as a real 0 mph.
  for (const empty of [null, undefined, '', Number.NaN]) {
    assert.equal(normalizeTrackerExitVelocity(empty, 3), null, `${String(empty)} must stay null`)
  }
})

test('legacy v10 timing uses its continuous wall clock instead of its truncated update count', () => {
  const record = parseTrackerBattedBallMessage(bowserTimedLandingRecord)
  assert.equal(record.flightUpdates, 265)
  assert.equal(record.hangTimeSec, 4.82)
  assert.equal(record.sampledUpdatesSec, 4.421)
  assert.equal(record.wallTimeSec, 4.82)
})

test('current timed records populate hang time and carry the game stadium key', () => {
  const record = parseTrackerBattedBallMessage(bowserCurrentTimedLandingRecord)
  assert.equal(record.flightUpdates, 265)
  assert.equal(record.hangTimeSec, 4.82)
  assert.equal(record.sampledUpdatesSec, 4.421)
  assert.equal(record.wallTimeSec, null)
  assert.deepEqual(trackerBattedBallPaFields(record, { stadiumKey: 'mario_stadium' }), {
    exit_velocity_mph: onCanonicalScale(85),
    hit_world_x: 29.0159225,
    hit_world_z: -71.6531067,
    hit_world_y: 0.264784217,
    launch_angle_deg: 35.2,
    hit_distance_ft: 251.5,
    hit_angle_deg: 12,
    hang_time_sec: 4.82,
    hit_stadium_key: 'mario_stadium',
    // Plotted from the tracked landing coordinates, not the 12 degree launch
    // direction, which sat this marker ~40 feet away.
    hit_x: 65.8,
    hit_y: 37.6,
  })
})

test('multiword batter and pitcher names remain intact and match the active PA', () => {
  const record = parseTrackerBattedBallMessage(kingKRoolLandingRecord)
  assert.equal(record.batterName, 'King K. Rool')
  assert.equal(record.pitcherName, 'Green Paratroopa')
  assert.equal(trackerBattedBallMatchesMatchup(record, {
    batterName: 'King K. Rool', pitcherName: 'Green Paratroopa',
  }), true)
  assert.equal(trackerBattedBallMatchesMatchup(record, {
    batterName: 'King K. Rool', pitcherName: 'Mario',
  }), false)
})

test('caught balls retain their catch distance for spray charts', () => {
  const record = parseTrackerBattedBallMessage(luigiCatchRecord)
  assert.equal(record.endpoint, 'catch')
  assert.deepEqual(trackerBattedBallPaFields(record), {
    exit_velocity_mph: onCanonicalScale(92.2),
    hit_world_x: 32.7537613,
    hit_world_z: -90.8825378,
    hit_world_y: 0,
    launch_angle_deg: 47,
    hit_distance_ft: 314.8,
    hit_angle_deg: 16.5,
  })
  assert.deepEqual(trackerBattedBallPaFields(record, { stadiumKey: 'mario_stadium' }), {
    exit_velocity_mph: onCanonicalScale(92.2),
    hit_world_x: 32.7537613,
    hit_world_z: -90.8825378,
    hit_world_y: 0,
    launch_angle_deg: 47,
    hit_distance_ft: 314.8,
    hit_angle_deg: 16.5,
    hit_stadium_key: 'mario_stadium',
    hit_x: 66.6,
    hit_y: 27.5,
    fielded_x: 66.6,
    fielded_y: 27.5,
  })
})

test('a Bowser Castle lava homer keeps its measurement while its marker clears the wall', () => {
  const record = parseTrackerBattedBallMessage(boomerangBroLavaHrRecord)
  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'bowser_castle' })

  assert.equal(fields.hit_world_x, 35.9727173)
  assert.equal(fields.hit_world_y, 0.25)
  assert.equal(fields.hit_world_z, -102.855698)
  assert.equal(fields.hit_distance_ft, 355.4)
  assert.equal(trackerBattedBallShouldRevealOccludedLanding(record), true)
  assert.equal(fields.hit_x, 68)
  assert.equal(fields.hit_y, 21.7)
})

test('a deep home run that never resolves a landing gets a physics-projected distance instead of staying empty', () => {
  const record = parseTrackerBattedBallMessage(bowserJrDeepHrUnresolvedRecord)
  assert.equal(record.endpoint, 'unresolved')
  assert.equal(record.distanceFeet, null)
  assert.equal(record.hangTimeSec, null)

  const projected = projectTrackerBattedBallDistanceFeet(onCanonicalScale(110), 30.0)
  assert.ok(projected.distanceFeet > 0)
  const projectedWorld = polarToWorld(8, projected.distanceFeet / FEET_PER_UNIT)

  assert.deepEqual(trackerBattedBallPaFields(record), {
    exit_velocity_mph: onCanonicalScale(110),
    // A ball that outran tracking still gets a position. This record carries no
    // projected_x/z, so there is no measured direction to use and the LAUNCH
    // direction at the projected distance is the only thing left. When the exe
    // does send extrapolated coordinates they win — see the Donkey Kong case
    // below for why.
    hit_world_x: projectedWorld.x,
    hit_world_z: projectedWorld.z,
    hit_position_estimated: true,
    launch_angle_deg: 30,
    // Rounded to the stored column's precision so the displayed and saved
    // values cannot disagree.
    hit_distance_ft: Math.round(projected.distanceFeet * 10) / 10,
    hit_angle_deg: 8,
    hang_time_sec: projected.hangTimeSec,
  })
  const withStadium = trackerBattedBallPaFields(record, { stadiumKey: 'mario_stadium' })
  assert.equal(withStadium.hit_stadium_key, 'mario_stadium')
  assert.ok(Number.isFinite(withStadium.hit_x))
  assert.ok(Number.isFinite(withStadium.hit_y))
  assert.equal(withStadium.fielded_x, undefined)

  // Real distance always wins over a projection when both somehow exist.
  assert.equal(
    trackerBattedBallPaFields({
      ...record, endpoint: 'landing', distanceFeet: 300, recordFeetPerUnit: FEET_PER_UNIT,
    }).hit_distance_ft,
    300,
  )

  // Trajectory still resolves from launch angle alone — no endpoint dependency.
  assert.equal(trackerBattedBallTrajectory(record), 'F')

  const buffer = { batterName: 'Bowser Jr.', pitcherName: 'Wario', advancedBattedBall: null, battedBallTrajectory: null }
  assert.equal(applyTrackerBattedBallToBuffer(buffer, record), true)
  assert.equal(buffer.advancedBattedBall, record)
  assert.equal(buffer.battedBallTrajectory, 'F')
})

test('an unresolved contact with a real trajectory-extrapolated distance is not rejected as malformed', () => {
  // Real message from a live session: the exe's own last-tracked-frame
  // extrapolation (see emit_batted_ball_diagnostic) fills in a real
  // distance_feet even though endpoint stays 'unresolved' — coordinates
  // are still 'none' since there was no real observed landing point. A
  // prior version of this parser required distance_feet to be 'none'
  // whenever endpoint was 'unresolved', which silently dropped this
  // exact class of record the moment the exe started sending it.
  const kingKRoolUnresolvedRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=4658|batter=King K. Rool|pitcher=Bowser|exit_speed_mph=98.4|launch_degrees=38.9|spray_degrees=-23.3|side=third_base|endpoint=unresolved|endpoint_status=tracking_stalled+extrapolated_from_last_frame|endpoint_seq=none|x=none|y=none|z=none|distance_feet=322.4|flight_updates=none|sampled_updates_seconds=none|hang_time_seconds=5.667'
  const record = parseTrackerBattedBallMessage(kingKRoolUnresolvedRecord)
  assert.notEqual(record, null)
  assert.equal(record.endpoint, 'unresolved')
  assert.equal(record.distanceFeet, 322.4)
  assert.equal(record.hangTimeSec, 5.667)
  assert.equal(record.x, null)

  const projected = projectTrackerBattedBallDistanceFeet(onCanonicalScale(98.4), 38.9)
  const projectedWorld = polarToWorld(-23.3, projected.distanceFeet / FEET_PER_UNIT)
  // This old build did not state the scale of its distance, so the canonical
  // launch model wins rather than treating 322.4 as comparable feet.
  assert.deepEqual(trackerBattedBallPaFields(record), {
    exit_velocity_mph: onCanonicalScale(98.4),
    // This build did not state its feet-per-unit and sent no coordinates, so
    // 322.4 is a number in unknown units. Rather than guess a scale, the
    // position falls back to the calibrated distance fit, which is in our own
    // feet by construction. Better than guessing a scale for a number whose
    // units nobody can name.
    hit_world_x: projectedWorld.x,
    hit_world_z: projectedWorld.z,
    hit_position_estimated: true,
    launch_angle_deg: 38.9,
    hit_distance_ft: Math.round(projected.distanceFeet * 10) / 10,
    hit_angle_deg: -23.3,
    hang_time_sec: 5.667,
  })
})

test('a shallow contact that stayed airborne is a liner, not a ground ball', () => {
  // Real record, 2026-08-31 Daisy Cruiser: Mario's fire swing measured 2.9
  // degrees off the bat, rose to a 14.5-foot apex and first touched the ground
  // 200 feet away, 2.52 seconds later. The launch angle reads two frames; the
  // hang time reads the whole flight.
  const flew = { endpoint: 'landing', launchAngleDeg: 2.9, exitVelocityMph: 92.2, hangTimeSec: 2.521 }
  assert.equal(trackerBattedBallTrajectory(flew), 'L')
  // A grounder off the same angle is still a grounder: it is down inside a
  // second, which is where every measured sub-zero launch in the archive is.
  assert.equal(trackerBattedBallTrajectory({ ...flew, hangTimeSec: 0.85 }), 'G')
  // No measured flight leaves the angle in charge.
  assert.equal(trackerBattedBallTrajectory({ ...flew, hangTimeSec: null }), 'G')
})

test('the game-specific 6 degree boundary separates grounders from airborne contact', () => {
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 5.9 }), 'G')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 6 }), 'L')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 9.3 }), 'L')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 24.9 }), 'L')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 35 }), 'F')
})

test('a joined measured landing outranks an unresolved park-event extrapolation', () => {
  const record = parseTrackerBattedBallMessage(tinyKongPiranhaRecord)
  assert.ok(trackerBattedBallPaFields(record).hit_distance_ft > 500)

  const play = {
    landing: { t: 3.0531, frame: 1835, at: [22.434, 1.241, -68.795] },
  }
  const fields = trackerBattedBallPaFields(record, { play })
  assert.equal(fields.hit_world_x, 22.434)
  assert.equal(fields.hit_world_y, 1.241)
  assert.equal(fields.hit_world_z, -68.795)
  assert.equal(fields.hit_distance_ft, 235.2)
  assert.equal(fields.hit_position_estimated, undefined)
  assert.equal(fields.hang_time_sec, 3.0531)
  assert.equal(trackerBattedBallShouldRevealOccludedLanding(record, null, play), false)
})

test('a catch stamped on the dead-ball coordinate reset is placed by the capture', () => {
  // Real record, 2026-08-31 Daisy Cruiser: the game blanked the ball coordinate
  // on the same update the caught state arrived, so the executable recorded a
  // 286-foot centre-field fly as caught at the origin, 2.6 feet from the plate.
  const record = parseTrackerBattedBallMessage(
    '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=12979|batter=Bowser Jr.|pitcher=Boo'
    + '|exit_speed_mph=91.1|launch_degrees=46.5|spray_degrees=-2.8|side=center|endpoint=catch'
    + '|endpoint_status=caught|endpoint_seq=13349|x=0|y=0|z=0|distance_feet=2.6'
    + '|projected_x=none|projected_z=none|flight_updates=370|sampled_updates_seconds=6.173'
    + '|hang_time_seconds=6.626|feet_per_unit=3.2808',
  )
  assert.equal(trackerEndpointIsCoordinateReset(record), true)

  const play = {
    caught_in_flight: true,
    first_touch: { t: 6.2229, frame: 33466, by: 'CF', character: 'Peach', at: [-2.16, 0, -88.376] },
    landing: null,
  }
  const fields = trackerBattedBallPaFields(record, { play })
  assert.equal(fields.hit_world_x, -2.16)
  assert.equal(fields.hit_world_z, -88.376)
  assert.equal(fields.hit_distance_ft, 287.7)
  // The capture measured this catch; nothing here is a model's output.
  assert.equal(fields.hit_position_estimated, undefined)
  assert.equal(fields.hang_time_sec, 6.2229)

  // With no joined play there is no position at all, which is the honest
  // answer. What must never happen is the ball being placed on home plate.
  const alone = trackerBattedBallPaFields(record)
  assert.equal(alone.hit_world_x, undefined)
  assert.equal(alone.hit_distance_ft, null)
  assert.equal(trackerBattedBallPlotGeometry(record), null)
})

test('a buddy receiver stepping on first preserves the 4-3 force-out chain', () => {
  const forceOut = {
    runners: { BAT: { bases_ran: 0 } },
    fielding_events: [
      { frame: 100, by: '2B', ball_contact: 'confirmed', secured: true, mechanic: 'buddy' },
      { frame: 120, by: '1B', ball_contact: 'confirmed', secured: true, mechanic: 'buddy_receive' },
    ],
    // This later throw did not make the batter out and must not enter the chain.
    throws: [
      { arrival_frame: 180, thrower_position: '1B', receiver_position: 'SS', outs_recorded: 0 },
    ],
  }
  assert.deepEqual(trackerPlayOutChainPositions(forceOut), ['2B', '1B'])
  assert.deepEqual(trackerPlayOutChainPositions({
    ...forceOut,
    runners: { BAT: { bases_ran: 1 } },
  }), [])
})

test('a fielder who takes the return throw is scored again: 3-6-3', () => {
  const aroundTheHorn = {
    fielding_events: [
      { frame: 100, by: '1B', ball_contact: 'confirmed', secured: true },
    ],
    throws: [
      { arrival_frame: 200, thrower_position: '1B', receiver_position: 'SS', outs_recorded: 1 },
      { arrival_frame: 280, thrower_position: 'SS', receiver_position: '1B', outs_recorded: 1 },
    ],
  }
  assert.deepEqual(trackerPlayOutChainPositions(aroundTheHorn), ['1B', 'SS', '1B'])
})

test('contact under 25 mph is a bunt, and a bunt outranks the angle buckets', () => {
  assert.equal(isTrackerBuntedBall({ endpoint: 'landing', exitVelocityMph: 18.4 }), true)
  assert.equal(isTrackerBuntedBall({ endpoint: 'catch', exitVelocityMph: 21 }), true)
  assert.equal(isTrackerBuntedBall({ endpoint: 'landing', exitVelocityMph: 25 }), false)
  assert.equal(isTrackerBuntedBall({ endpoint: 'landing', exitVelocityMph: 71.7 }), false)
  // A foul has no usable measurement, and an unresolved ball left tracked play
  // entirely — neither can be a bunt.
  assert.equal(isTrackerBuntedBall({ endpoint: 'foul', exitVelocityMph: 12 }), false)
  assert.equal(isTrackerBuntedBall({ endpoint: 'unresolved', exitVelocityMph: 12 }), false)
  assert.equal(isTrackerBuntedBall(null), false)

  // A bunt rolling on the ground is a bunt, not a ground ball.
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 2, exitVelocityMph: 17 }), 'B')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 2, exitVelocityMph: 61 }), 'G')
})

test('a bunt that retires the batter with a runner on and fewer than 2 outs is a sacrifice', () => {
  const sacrifice = { isBunt: true, result: 'GO', outsBeforePa: 0, hasRunnerOn: true }
  assert.equal(shouldClassifyTrackerSacrificeBunt(sacrifice), true)
  assert.equal(shouldClassifyTrackerSacrificeBunt({ ...sacrifice, outsBeforePa: 1 }), true)
  // Two outs already: nothing is being sacrificed for.
  assert.equal(shouldClassifyTrackerSacrificeBunt({ ...sacrifice, outsBeforePa: 2 }), false)
  // Nobody on base to move up.
  assert.equal(shouldClassifyTrackerSacrificeBunt({ ...sacrifice, hasRunnerOn: false }), false)
  // A bunt the batter beat out is a hit, and a swung-at grounder is not a bunt.
  assert.equal(shouldClassifyTrackerSacrificeBunt({ ...sacrifice, result: '1B' }), false)
  assert.equal(shouldClassifyTrackerSacrificeBunt({ ...sacrifice, isBunt: false }), false)
  // A bunt popped up and caught is not a sacrifice fly.
  assert.equal(shouldReclassifyTrackerFlyOutAsSacFly({
    result: 'FO', outsBeforePa: 0, scoredNonBatterRunner: true, isBunt: true,
  }), false)

  // Rule 9.08(a) wants a runner ADVANCED. Green Noki's 2026-09-04 bunt was
  // fielded by the pitcher and thrown to first with the runners frozen on
  // second and third: an attempted sacrifice that failed, scored 1-3.
  assert.equal(shouldClassifyTrackerSacrificeBunt({ ...sacrifice, runnerAdvanced: false }), false)
  assert.equal(shouldClassifyTrackerSacrificeBunt({ ...sacrifice, runnerAdvanced: true }), true)
  // Unknown is not the same as measured-and-nobody-moved: a log-only session
  // with no 60 Hz play still scores the bunt the way it always did.
  assert.equal(shouldClassifyTrackerSacrificeBunt({ ...sacrifice, runnerAdvanced: null }), true)
})

test('a low airborne catch becomes a lineout while a high catch remains a flyout', () => {
  assert.equal(trackerCaughtBallResult({ endpoint: 'catch', launchAngleDeg: 8 }), 'LO')
  assert.equal(trackerCaughtBallResult({ endpoint: 'catch', launchAngleDeg: 47 }), 'FO')
})

test('only a confirmed near-wall Buddy Jump is marked as a robbed home run', () => {
  const record = parseTrackerBattedBallMessage(luigiCatchRecord)
  assert.equal(isTrackerRobbedHomeRun({ record, isBuddyJump: true, stadiumKey: 'mario_stadium' }), true)
  assert.equal(isTrackerRobbedHomeRun({ record, isBuddyJump: false, stadiumKey: 'mario_stadium' }), false)
  const shallow = polarToWorld(20, 60)
  assert.equal(isTrackerRobbedHomeRun({
    record: { ...record, x: shallow.x, z: shallow.z },
    isBuddyJump: true,
    stadiumKey: 'mario_stadium',
  }), false)
})

test('a fair landed ball can record its later fielded position independently', () => {
  const record = parseTrackerFieldedBallMessage(redYoshiFieldedRecord)
  assert.deepEqual(record, {
    contactSeq: 228,
    batterName: 'Red Yoshi',
    pitcherName: 'Mario',
    fieldedSeq: 279,
    timeNs: 21364236395200,
    x: 12.732379,
    y: 0.251562238,
    z: -27.107254,
    distanceFeet: 87,
    sprayAngleDeg: 25.3,
    fieldingTimeSec: 1.253,
    source: 'this_pitch.fair_or_foul+latest_physical_sample',
  })
  assert.deepEqual(trackerFieldedBallPaFields(record, { stadiumKey: 'mario_stadium' }), {
    fielded_x: 58.5,
    fielded_y: 68.1,
  })

  const buffer = { batterName: 'Red Yoshi', pitcherName: 'Mario', advancedFielding: null }
  assert.equal(applyTrackerFieldedBallToBuffer(buffer, record), true)
  assert.equal(buffer.advancedFielding, record)
})

test('a fielded position never attaches to a different active matchup', () => {
  const record = parseTrackerFieldedBallMessage(redYoshiFieldedRecord)
  const buffer = { batterName: 'Red Yoshi', pitcherName: 'Luigi', advancedFielding: null }
  assert.equal(applyTrackerFieldedBallToBuffer(buffer, record), false)
  assert.equal(buffer.advancedFielding, null)
})

test('malformed or physically incomplete fielded-position records are rejected', () => {
  assert.equal(parseTrackerFieldedBallMessage('[TRACKER_BALL_FIELDED_PROVISIONAL] batter=Red Yoshi'), null)
  assert.equal(parseTrackerFieldedBallMessage(redYoshiFieldedRecord.replace('|distance_feet=87.0', '|distance_feet=none')), null)
})

test('a foul contact never overwrites the fair or caught contact on a PA', () => {
  const foul = parseTrackerBattedBallMessage(wigglerFoulRecord)
  const fair = parseTrackerBattedBallMessage(kingKRoolLandingRecord)
  const buffer = { batterName: 'Wiggler', pitcherName: 'Green Paratroopa', advancedBattedBall: null }

  assert.deepEqual(trackerBattedBallPaFields(foul), {})
  assert.equal(applyTrackerBattedBallToBuffer(buffer, foul), true)
  assert.equal(buffer.advancedBattedBall, null)

  buffer.batterName = 'King K. Rool'
  assert.equal(applyTrackerBattedBallToBuffer(buffer, fair), true)
  assert.equal(buffer.advancedBattedBall, fair)
})

test('malformed or physically incomplete advanced records are rejected', () => {
  assert.equal(parseTrackerBattedBallMessage('[TRACKER_BATTED_BALL_PROVISIONAL] batter=King K. Rool'), null)
  assert.equal(parseTrackerBattedBallMessage(kingKRoolLandingRecord.replace('|distance_feet=67.8', '|distance_feet=none')), null)
  assert.equal(parseTrackerBattedBallMessage(`${kingKRoolLandingRecord}|hang_time_seconds=0.434`), null)
  const halfProjected = bowserJrDeepHrUnresolvedRecord.replace(
    '|flight_updates=none', '|projected_x=12.3|flight_updates=none',
  )
  assert.equal(parseTrackerBattedBallMessage(halfProjected), null)
})

// The tracker prints these alongside the record lines the bridge consumes, so
// a marker that collides on a startsWith() prefix would feed a diagnostic to a
// record parser and, in production, on to Supabase.
test('the tracker health diagnostics are never mistaken for record lines', () => {
  const diagnostics = [
    '[TRACKER_BALL_FEED] status=stalled|pointer=0x8131E064|coordinate_address=0x8131E5BC|seconds_since_change=15.0|x=1.40129846e-45|y=0|z=0|note=game_is_batting_but_ball_coordinates_are_frozen',
    '[TRACKER_BALL_FEED] status=moving|pointer=0x8131E064|stalled_seconds=31.4',
    '[TRACKER_BATTED_BALL_ABANDONED] contact_seq=1|batter=Blue Pianta|pitcher=Bowser|elapsed_seconds=8.0|seconds_since_last_sample=8.0|post_samples=0|flight_samples=0|reason=no_exit_metrics_before_timeout',
    '[TRACKER_BALL_CONTACT] flag=1|status=rejected|reason=placeholder_coordinates|seq=1|time_ns=39796917367100|sample_age_seconds=2.600|x=1.40129846e-45|y=0|z=0',
  ]
  for (const line of diagnostics) {
    assert.equal(parseTrackerBattedBallMessage(line), null, line)
    assert.equal(parseTrackerFieldedBallMessage(line), null, line)
  }
})

test('a bobble that lets the batter reach safely is charged as an error', () => {
  assert.equal(shouldChargeTrackerBobbleError({
    bobbleFielderName: 'Hammer Bro.', result: '1B',
  }), true)
})

test('a bobble recovered for a completed catch is not charged as an error', () => {
  assert.equal(shouldChargeTrackerBobbleError({
    bobbleFielderName: 'Blue Pianta', result: 'FO',
  }), false)
})

test('a safe result without a bobble is not charged as an error', () => {
  assert.equal(shouldChargeTrackerBobbleError({
    bobbleFielderName: null, result: '1B',
  }), false)
})

// MARIO STADIUM PA 43. King Boo's line drive reached the ground untouched, CF
// booted it 91 units from home, and King Boo took second. The game's own log
// called it a star double with 2 RBI and counted a third hit off the pitcher;
// the console charged E8 and then erased the double. The error is right and
// stays; taking the hit away is not, because the boot happened in the outfield
// after the ball was already a base hit.
test('an outfield boot on a ball that landed untouched keeps the hit', () => {
  const play = {
    fielding_events: [{
      event_type: 'fielding_action', character: 'Wario', by: 'CF',
      mechanic: 'ordinary', action_code: 3, ball_contact: 'confirmed',
      secured: false, within_reach: true, closest_reach_units: 1.6,
      ball_landed_before_contact: true,
    }],
    runners: { BAT: { bases_ran: 2 } },
  }
  // Still an error.
  assert.equal(shouldChargeTrackerBobbleError({
    bobbleFielderName: 'Wario', result: '2B', play,
  }), true)
  // But not a reached-on-error.
  assert.equal(shouldDowngradeTrackerHitToRoe({
    result: '2B', bobbleFielderName: 'Wario', play,
  }), false)
})

// The counterexample the rule has to survive, and the reason "the batter took
// extra bases" cannot stand in for the outfield test: Baby Daisy's 96 ft ground
// ball also reached the ground untouched and she circled the bases on it, but
// 2B booted it 34 units from home. She went round BECAUSE of the error.
test('an infield boot on a ball that landed untouched still takes the hit away', () => {
  const play = {
    fielding_events: [{
      event_type: 'fielding_action', character: 'Wiggler', by: '2B',
      mechanic: 'ordinary', action_code: 3, ball_contact: 'confirmed',
      secured: false, within_reach: true, closest_reach_units: 0.6,
      ball_landed_before_contact: true,
    }],
    runners: { BAT: { bases_ran: 4 } },
  }
  assert.equal(shouldDowngradeTrackerHitToRoe({
    result: 'IPHR', bobbleFielderName: 'Wiggler', play,
  }), true)
})

// A dropped fly is the opposite case: the catch WAS available, so the batter is
// on base only because it was not made.
test('a dropped fly in the outfield still takes the hit away', () => {
  const play = {
    fielding_events: [{
      event_type: 'fielding_action', character: 'Dixie Kong', by: 'RF',
      mechanic: 'ordinary', action_code: 3, ball_contact: 'confirmed',
      secured: false, within_reach: true, closest_reach_units: 1.1,
      ball_landed_before_contact: false,
    }],
    runners: { BAT: { bases_ran: 1 } },
  }
  assert.equal(shouldDowngradeTrackerHitToRoe({
    result: '1B', bobbleFielderName: 'Dixie Kong', play,
  }), true)
})

// With no joined play there is no evidence either way, and absence of the
// capture must never invent an exoneration -- the downgrade stands.
test('no capture leaves the reached-on-error downgrade alone', () => {
  assert.equal(shouldDowngradeTrackerHitToRoe({
    result: '1B', bobbleFielderName: 'Wario', play: null,
  }), true)
  assert.equal(shouldDowngradeTrackerHitToRoe({
    result: 'FO', bobbleFielderName: 'Wario', play: null,
  }), false)
})

test('a home run that bounces off a fielder is not automatically scored as an error', () => {
  assert.equal(shouldChargeTrackerBobbleError({
    bobbleFielderName: 'Mario', result: 'HR',
  }), false)
})

// Mario's Fire Swing turns the ball into a fireball the first fielder to reach
// it cannot hold -- the same shape as Yoshi's egg, and the same consequence:
// the BATTER's ability made the misplay, so the fielder is charged with
// nothing.
test("a star ball's forced first contact is never an error", () => {
  const play = {
    fielding_events: [{
      event_type: 'fielding_action', character: 'Blue Yoshi', by: '3B',
      mechanic: 'star_ball', action_code: 4, ball_contact: 'confirmed',
      secured: false, within_reach: true, closest_reach_units: 1.2,
    }],
  }
  const veto = trackerBobbleErrorVeto({ bobbleFielderName: 'Blue Yoshi', play })
  assert.equal(veto.reason, 'star_ball')
  assert.equal(shouldChargeTrackerBobbleError({
    bobbleFielderName: 'Blue Yoshi', result: 'ROE', play,
  }), false)
})

// The veto reason is a SENTENCE the console prints next to the rest of the
// narrative, so it has to be true alongside it. "The ball was reached on a
// dive" beside "did not make contact" is a contradiction, not a weaker reason.
test('a dive that never touched the ball is vetoed for no contact, not for effort', () => {
  const play = {
    fielding_events: [{
      event_type: 'fielding_action', character: 'Dixie Kong', by: 'LF',
      mechanic: 'ordinary', action_code: 3, ball_contact: 'missed',
      dive: true, catch_type: 3, within_reach: true, closest_reach_units: 2.51,
    }],
  }
  const veto = trackerBobbleErrorVeto({ bobbleFielderName: 'Dixie Kong', play })
  assert.equal(veto.reason, 'no_contact')
  assert.match(veto.detail, /no contact with the ball at all — its closest approach was 2\.5 units/)

  // A dive that DID reach the ball is still extraordinary effort.
  const reached = {
    fielding_events: [{
      event_type: 'fielding_action', character: 'Dixie Kong', by: 'LF',
      mechanic: 'ordinary', action_code: 3, ball_contact: 'confirmed',
      dive: true, catch_type: 3, within_reach: true, closest_reach_units: 0.9,
    }],
  }
  assert.equal(
    trackerBobbleErrorVeto({ bobbleFielderName: 'Dixie Kong', play: reached }).reason,
    'extraordinary',
  )
})

// The action byte fired for one frame while the ball was 34.9 units above the
// fielder's head, and the tracker .exe announced a bobble off it.
test('a bobble announced while the ball was out of reach names the reach, not the fielder', () => {
  const play = {
    fielding_events: [{
      event_type: 'fielding_action', character: 'Donkey Kong', by: 'CF',
      mechanic: 'ordinary', action_code: 2, ball_contact: 'missed',
      contact_source: 'ball_never_within_reach',
      within_reach: false, closest_reach_units: 36.38,
    }],
  }
  const veto = trackerBobbleErrorVeto({ bobbleFielderName: 'Donkey Kong', play })
  assert.equal(veto.reason, 'out_of_reach')
  assert.match(veto.detail, /closest approach was 36\.4 units/)
})

// Peach Ice Garden PA 38: the .exe announced a Koopa Troopa bobble on a line
// drive down the LEFT-field line, overrode its own "recorded a double", and
// charged E9 to the right fielder. The capture has one confirmed touch, by the
// left fielder, and Koopa Troopa in no event and no approach window.
test('a bobble announced for a fielder who was not on the play at all is vetoed', () => {
  const play = {
    fielding_events: [{
      event_type: 'possession', character: 'Red Noki', by: 'LF',
      mechanic: 'ordinary', ball_contact: 'confirmed', secured: true,
    }],
    catch_approaches: [
      { by: 'LF', character: 'Red Noki', catch_type: 1 },
      { by: 'SS', character: 'Magikoopa', catch_type: 2 },
    ],
  }
  const veto = trackerBobbleErrorVeto({ bobbleFielderName: 'Koopa Troopa', play })
  assert.equal(veto.reason, 'not_on_the_play')
  assert.equal(shouldChargeTrackerBobbleError({
    bobbleFielderName: 'Koopa Troopa', result: '2B', play,
  }), false)
  // The fielder who actually handled it is untouched by this rule.
  assert.equal(trackerBobbleErrorVeto({ bobbleFielderName: 'Red Noki', play }), null)
})

// Silence is not an exoneration, and this is the line between the two. Without
// a confirmed touch by SOMEBODY the capture has not established who handled the
// ball, so an absent fielder proves nothing and the tracker's call stands.
test('an absent fielder is only cleared when the capture saw someone else handle the ball', () => {
  const nobodyTouchedIt = {
    fielding_events: [{
      event_type: 'fielding_action', character: 'Red Noki', by: 'LF',
      mechanic: 'ordinary', ball_contact: 'unknown', secured: false,
    }],
    catch_approaches: [{ by: 'LF', character: 'Red Noki', catch_type: 1 }],
  }
  assert.equal(
    trackerBobbleErrorVeto({ bobbleFielderName: 'Koopa Troopa', play: nobodyTouchedIt }),
    null,
  )

  // Nor is a fielder who went after the ball and produced no event "not on the
  // play" -- an approach that reached nothing is exactly the failed attempt a
  // bobble might describe.
  const heWentForIt = {
    fielding_events: [{
      event_type: 'possession', character: 'Red Noki', by: 'LF',
      mechanic: 'ordinary', ball_contact: 'confirmed', secured: true,
    }],
    catch_approaches: [{ by: 'RF', character: 'Koopa Troopa', catch_type: 7 }],
  }
  assert.equal(
    trackerBobbleErrorVeto({ bobbleFielderName: 'Koopa Troopa', play: heWentForIt }),
    null,
  )
})

test('HBP messages retain the full batter name', () => {
  assert.equal(parseTrackerHitByPitchMessage('King K. Rool was hit by a pitch!'), 'King K. Rool')
  assert.equal(parseTrackerHitByPitchMessage('Strike 2.'), null)
})

test('a fair play with a named baserunner putout and no batter result becomes a fielder choice', () => {
  assert.equal(shouldClassifyTrackerFielderChoice({
    batterName: 'Mario', result: null, contactRecorded: true,
    observedPutouts: [{ fielderName: 'Luigi', runnerName: 'Yoshi' }],
  }), true)
  assert.equal(shouldClassifyTrackerFielderChoice({
    batterName: 'Mario', result: '1B', contactRecorded: true,
    observedPutouts: [{ fielderName: 'Luigi', runnerName: 'Yoshi' }],
  }), false)
})

test('game pitch numbers continue from the latest committed pitch', () => {
  assert.deepEqual(numberTrackerPitches([{ type: 'ball' }, { type: 'foul' }], 8), [
    { type: 'ball', pitch_number_pa: 1, pitch_number_game: 9 },
    { type: 'foul', pitch_number_pa: 2, pitch_number_game: 10 },
  ])
})

test('the next base snapshot resolves non-default runner movement without guessing', () => {
  const mario = { characterId: 1, playerId: 'away' }
  const luigi = { characterId: 2, playerId: 'away' }
  const yoshi = { characterId: 3, playerId: 'away' }
  assert.deepEqual(buildExactTrackerRunnerAssignments({
    runnersBefore: { first: luigi, second: yoshi, third: null },
    batter: mario,
    nextRunners: { first: mario, second: null, third: luigi },
    scoringRunnerKeys: new Set(['3:away']),
    outRunnerKeys: new Set(),
  }), [
    { id: 'batter', runner: mario, origin: 'plate', isBatter: true, destination: 'first' },
    { id: 'first', runner: luigi, origin: 'first', isBatter: false, destination: 'third' },
    { id: 'second', runner: yoshi, origin: 'second', isBatter: false, destination: 'home' },
  ])
})

test('exact runner resolution refuses an unexplained missing runner', () => {
  assert.equal(buildExactTrackerRunnerAssignments({
    runnersBefore: { first: { characterId: 2, playerId: 'away' } },
    batter: { characterId: 1, playerId: 'away' },
    nextRunners: { first: { characterId: 1, playerId: 'away' } },
  }), null)
})

test('delta runner messages preserve unchanged runners and remove a moved runner from their old base', () => {
  const funky = { characterId: 56, playerId: 'away' }
  const yellowPianta = { characterId: 23, playerId: 'away' }

  let state = applyTrackerRunnerDelta({}, { base: 'second', runner: funky })
  const unchangedNextPa = copyTrackerRunnerState(state)
  assert.deepEqual(unchangedNextPa, { first: null, second: funky, third: null })

  state = applyTrackerRunnerDelta(state, { base: 'first', runner: yellowPianta })
  state = applyTrackerRunnerDelta(state, { base: 'third', runner: funky })
  assert.deepEqual(state, { first: yellowPianta, second: null, third: funky })
})

test('run and putout deltas remove runners that disappear from the bases', () => {
  const funky = { characterId: 56, playerId: 'away' }
  const yellowPianta = { characterId: 23, playerId: 'away' }
  const state = { first: yellowPianta, second: null, third: funky }

  assert.deepEqual(removeTrackerRunner(state, funky), {
    first: yellowPianta, second: null, third: null,
  })
  assert.deepEqual(removeTrackerRunner(state, yellowPianta), {
    first: null, second: null, third: funky,
  })
})

test('an unchanged carried runner makes the following batter-out destinations exact', () => {
  const funky = { characterId: 56, playerId: 'away' }
  const redToad = { characterId: 13, playerId: 'away' }
  assert.deepEqual(buildExactTrackerRunnerAssignments({
    runnersBefore: { first: null, second: funky, third: null },
    batter: redToad,
    nextRunners: { first: null, second: funky, third: null },
    batterOut: true,
  }), [
    { id: 'batter', runner: redToad, origin: 'plate', isBatter: true, destination: 'out' },
    { id: 'second', runner: funky, origin: 'second', isBatter: false, destination: 'second' },
  ])
})

test('a caught fly ball that scores a runner with 0 or 1 outs is a sac fly', () => {
  assert.equal(shouldReclassifyTrackerFlyOutAsSacFly({
    result: 'FO', outsBeforePa: 0, scoredNonBatterRunner: true,
  }), true)
  assert.equal(shouldReclassifyTrackerFlyOutAsSacFly({
    result: 'FO', outsBeforePa: 1, scoredNonBatterRunner: true,
  }), true)
})

test('a caught fly ball with 2 outs already never becomes a sac fly, even if a run replayed onto it', () => {
  assert.equal(shouldReclassifyTrackerFlyOutAsSacFly({
    result: 'FO', outsBeforePa: 2, scoredNonBatterRunner: true,
  }), false)
})

test('a caught fly ball that scores no one stays a plain flyout', () => {
  assert.equal(shouldReclassifyTrackerFlyOutAsSacFly({
    result: 'FO', outsBeforePa: 0, scoredNonBatterRunner: false,
  }), false)
})

test('only a caught fly ball (FO) is eligible — a ground out never becomes a sac fly', () => {
  assert.equal(shouldReclassifyTrackerFlyOutAsSacFly({
    result: 'GO', outsBeforePa: 0, scoredNonBatterRunner: true,
  }), false)
})

test('the batter cannot be their own sac-fly scorer', () => {
  // scoredNonBatterRunner is computed by the caller as
  // buf.runEvents.some((run) => run.scorerName !== buf.batterName) — a batter
  // can never score on their own caught fly ball, so this documents the
  // caller contract rather than re-deriving it here.
  assert.equal(shouldReclassifyTrackerFlyOutAsSacFly({
    result: 'FO', outsBeforePa: 0, scoredNonBatterRunner: false,
  }), false)
})

test('a putout on the batter is always credited', () => {
  assert.equal(shouldCreditTrackerPutout({ runnerName: 'Mario', batterName: 'Mario', result: null }), true)
})

test('a putout on someone else is not credited as the batter result, even on an FO with a missing name', () => {
  assert.equal(shouldCreditTrackerPutout({ runnerName: 'No Player', batterName: 'Mario', result: 'FO' }), true)
  assert.equal(shouldCreditTrackerPutout({ runnerName: 'Luigi', batterName: 'Mario', result: 'GO' }), false)
})

// Spray angle is the direction the ball LEFT the bat. Balls curve, so on a
// deep hit it is not the direction the ball ended up, and plotting from it put
// markers tens of feet from where the ball actually came down.
test('a tracked landing is plotted from its real coordinates, not its launch direction', () => {
  const record = parseTrackerBattedBallMessage(bowserLandingRecord)
  const geometry = trackerBattedBallPlotGeometry(record, 229.2)

  assert.equal(geometry.source, 'endpoint_coordinates')
  assert.equal(record.sprayAngleDeg, 12)
  // Where the ball actually landed, measured from HOME PLATE rather than the
  // world origin — the origin sits ~0.7 units in front of the plate, which is
  // worth a couple of feet and a quarter degree.
  assert.ok(Math.abs(geometry.angleDeg - 22.292) < 0.05)

  // The recorded launch-direction stat is unchanged; only the plot moves.
  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'mario_stadium' })
  assert.equal(fields.hit_angle_deg, 12)
  assert.equal(fields.hit_distance_ft, 251.5)
  assert.equal(fields.hit_x, 65.8)
})

test('an extrapolated home run plots from its projected coordinates when the tracker reports them', () => {
  const withCoordinates = `${bowserJrDeepHrUnresolvedRecord.replace('|distance_feet=none', '|distance_feet=322.4')}|projected_x=-31.4|projected_z=-101.2`
  const geometry = trackerBattedBallPlotGeometry(parseTrackerBattedBallMessage(withCoordinates))
  assert.equal(geometry.source, 'projected_coordinates')
  assert.ok(Math.abs(geometry.angleDeg - -17.318) < 0.05)
})

// The bug this pins: a Donkey Kong home run launched at 30 degrees and
// extrapolated to 41.2 was stored at 30, putting it 68 ft toward centre field —
// on the right-field bleacher stairs instead of in the corner. Launch direction
// is biased INWARD on deep balls (the five deepest resolved balls that session
// each landed further out than they left, by up to 5.6 degrees), so it is the
// wrong thing to position a ball that outran tracking.
test('an unresolved home run is positioned at its extrapolated angle, not its launch angle', () => {
  const donkeyKong = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=4932|batter=Donkey Kong|pitcher=Bowser|exit_speed_mph=97.1|launch_degrees=36|spray_degrees=30|side=first_base|endpoint=unresolved|endpoint_status=tracking_stalled+extrapolated_from_last_frame|endpoint_seq=none|x=none|y=none|z=none|distance_feet=312.7|projected_x=68.7240196|projected_z=-79.3297853|flight_updates=none|sampled_updates_seconds=none|hang_time_seconds=7.491'
  const record = parseTrackerBattedBallMessage(donkeyKong)
  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'mario_stadium' })

  // The extrapolated coordinates themselves, kept as sent.
  assert.equal(fields.hit_world_x, 68.7240196)
  assert.equal(fields.hit_world_z, -79.3297853)
  assert.equal(fields.hit_position_estimated, true)
  // No tracked endpoint means no measured height, so the chart supplies the
  // deck height rather than reading one from here.
  assert.equal(fields.hit_world_y, undefined)

  const { angleDeg, distanceUnits } = worldToPolar(fields.hit_world_x, fields.hit_world_z)
  assert.ok(Math.abs(angleDeg - 41.2) < 0.1, `angle was ${angleDeg}`)
  // Distance is unchanged by the fix — it always came off these coordinates.
  const distanceFeet = distanceUnits * FEET_PER_UNIT
  assert.ok(Math.abs(distanceFeet - 342.7) < 0.5, `distance was ${distanceFeet}`)
  assert.equal(fields.hit_distance_ft, 342.7)

  // The launch direction survives untouched as the stat it actually is.
  assert.equal(fields.hit_angle_deg, 30)

  // hit_x/hit_y already used the projected coordinates, so both paths now agree
  // on one angle for one ball.
  assert.ok(Math.abs(trackerBattedBallPlotGeometry(record).angleDeg - angleDeg) < 0.01)
})

test('plot geometry falls back to launch spray only when no coordinates exist at all', () => {
  const record = parseTrackerBattedBallMessage(bowserJrDeepHrUnresolvedRecord)
  const geometry = trackerBattedBallPlotGeometry(record, 400)
  assert.equal(geometry.source, 'launch_spray_angle')
  assert.equal(geometry.angleDeg, 8)
  assert.equal(geometry.distanceFeet, 400)
})

test('a contact with no usable distance yields no plot geometry rather than one at zero feet', () => {
  // Number(null) is 0, which is finite: an absent distance must not resolve to
  // a marker sitting on home plate.
  const foul = parseTrackerBattedBallMessage(wigglerFoulRecord)
  assert.equal(trackerBattedBallPlotGeometry(foul), null)
  assert.equal(trackerBattedBallPlotGeometry(null), null)
})

// --- 60Hz ball samples and trajectory projection --------------------------

test('a ball sample parses into a usable frame, and anything malformed is refused', () => {
  const got = parseTrackerBallSampleMessage(
    '[TRACKER_BALL_SAMPLE] phase=post_contact|seq=44|time_ns=11839488959800'
    + '|pointer=0x8131E064|x=-2.89331007|y=2.48270631|z=-3.20848131',
  )
  assert.equal(got.seq, 44)
  assert.equal(got.phase, 'post_contact')
  assert.ok(Math.abs(got.x - -2.89331007) < 1e-9)
  assert.ok(Math.abs(got.y - 2.48270631) < 1e-9)

  assert.equal(parseTrackerBallSampleMessage('[TRACKER_BALL_SAMPLE] seq=1|x=1|y=2'), null)
  assert.equal(parseTrackerBallSampleMessage('something else entirely'), null)
  assert.equal(parseTrackerBallSampleMessage(''), null)
})

test('the sample buffer drops everything when a tracker session restarts', () => {
  // `seq` restarts at 1 on a new session. Keeping the old samples is how one
  // game's contact ends up holding another game's flight — the failure that
  // fitted gravity at 67 u/s^2 when it happened in the offline tooling.
  const buffer = new TrackerBallSampleBuffer()
  for (let seq = 1; seq <= 5; seq += 1) {
    buffer.push({ seq, timeNs: seq * 16_500_000, x: 100, y: 5, z: -100 })
  }
  buffer.push({ seq: 1, timeNs: 0, x: 900, y: 5, z: -900 })
  assert.equal(buffer.samples.length, 1)
  assert.equal(buffer.samples[0].x, 900)
})

test('the sample buffer ignores the duplicate frame each phase reports', () => {
  const buffer = new TrackerBallSampleBuffer()
  assert.equal(buffer.push({ seq: 7, timeNs: 1, x: 1, y: 1, z: 1 }), true)
  assert.equal(buffer.push({ seq: 7, timeNs: 1, x: 1, y: 1, z: 1 }), false)
  assert.equal(buffer.samples.length, 1)
})

test('the sample buffer stays bounded across a whole game', () => {
  const buffer = new TrackerBallSampleBuffer(50)
  for (let seq = 1; seq <= 5000; seq += 1) {
    buffer.push({ seq, timeNs: seq * 16_500_000, x: seq, y: 5, z: -seq })
  }
  assert.equal(buffer.samples.length, 50)
  assert.equal(buffer.samples[buffer.samples.length - 1].seq, 5000)
})

test('a flight sliced out of the buffer stops at the endpoint, not the next ball', () => {
  const buffer = new TrackerBallSampleBuffer()
  for (let seq = 1; seq <= 100; seq += 1) {
    buffer.push({ seq, timeNs: seq * 16_500_000, x: seq, y: 5, z: -seq })
  }
  const flight = buffer.since(20, 30)
  assert.equal(flight.length, 11)
  assert.equal(flight[0].seq, 20)
  assert.equal(flight[flight.length - 1].seq, 30)
})

test('trajectory samples attach to unresolved, airborne, and later-fielded endpoints', () => {
  const buffer = new TrackerBallSampleBuffer()
  for (let seq = 900; seq <= 940; seq += 1) {
    buffer.push({ seq, timeNs: seq * 16_500_000, x: 1, y: 3, z: -seq / 10 })
  }
  const unresolved = parseTrackerBattedBallMessage(bowserJrDeepHrUnresolvedRecord)
  const attached = attachTrackerTrajectory(unresolved, buffer)
  assert.equal(attached.trajectory[0].seq, 903)
  assert.equal(attached.trajectory.at(-1).seq, 940)

  const measured = parseTrackerBattedBallMessage(bowserLandingRecord)
  assert.equal(attachTrackerTrajectory(measured, buffer), measured)

  const fielded = {
    ...measured,
    endpointStatus: 'fair_fielded',
    contactSeq: 910,
    endpointSeq: 930,
  }
  const fieldedAttached = attachTrackerTrajectory(fielded, buffer)
  assert.equal(fieldedAttached.trajectory[0].seq, 910)
  assert.equal(fieldedAttached.trajectory.at(-1).seq, 931)
})

/** A physically real flight, generated from the measured model. */
function syntheticFlight(state, seconds, startNs = 0) {
  const out = []
  for (let t = 0; t <= seconds; t += 1 / 60.5) {
    const p = positionAt(state, t)
    out.push({ seq: out.length + 1, timeNs: startNs + (t * 1e9), ...p })
  }
  return out
}

test('a ball that outran tracking is placed by its own flight, not by the exe guess', () => {
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const truth = predictFirstTouch(launch)
  // Hand over only the first second — the rest is what the tracker never saw.
  const trajectory = syntheticFlight(launch, 1.0)

  const record = {
    endpoint: 'unresolved',
    x: null, y: null, z: null,
    projectedX: 5, projectedZ: -20, // a deliberately poor straight-line guess
    sprayAngleDeg: -6, exitVelocityMph: 110, launchAngleDeg: 34,
    trajectory,
  }
  const geometry = trackerBattedBallPlotGeometry(record)
  assert.equal(geometry.source, 'trajectory_projection')

  const landed = trackerTrajectoryLanding(record)
  const expected = Math.hypot(truth.x - HOME_PLATE.x, truth.z - HOME_PLATE.z) * FEET_PER_UNIT
  assert.ok(
    Math.abs(landed.distanceFeet - expected) < 2,
    `projected ${landed.distanceFeet.toFixed(1)} ft against a true ${expected.toFixed(1)} ft`,
  )
})

test('an unresolved wall bounce ends at its measured collision, not a projected point beyond it', () => {
  const record = parseTrackerBattedBallMessage(yellowPiantaWallBounceRecord)
  // Yellow Pianta's centre-field Bowser Castle home run. At seq 8426 the ball
  // is still moving away from home; on the very next frame it has reversed and
  // keeps retreating. Tracking later ended during that rebound, before a ground
  // landing record could be emitted.
  record.trajectory = [
    { seq: 8423, timeNs: 7270311788800, x: 2.95188808, y: 21.9389877, z: -101.419823 },
    { seq: 8424, timeNs: 7270329092700, x: 2.96509004, y: 21.6699409, z: -101.525566 },
    { seq: 8425, timeNs: 7270346617900, x: 2.97830749, y: 21.3999672, z: -101.630829 },
    { seq: 8426, timeNs: 7270362921200, x: 2.99154043, y: 21.1290703, z: -101.735619 },
    { seq: 8427, timeNs: 7270379510500, x: 3.00254202, y: 21.0330524, z: -101.602699 },
    { seq: 8428, timeNs: 7270395733900, x: 3.00649858, y: 21.0184212, z: -101.516563 },
    { seq: 8429, timeNs: 7270412287300, x: 3.01043749, y: 21.0011177, z: -101.430817 },
    { seq: 8430, timeNs: 7270428800900, x: 3.01435852, y: 20.9811554, z: -101.345459 },
    { seq: 8431, timeNs: 7270445528600, x: 3.01826191, y: 20.9585457, z: -101.260483 },
    { seq: 8432, timeNs: 7270463694200, x: 3.02214789, y: 20.9333, z: -101.175888 },
    { seq: 8433, timeNs: 7270480023400, x: 3.02601624, y: 20.9054298, z: -101.091675 },
    { seq: 8434, timeNs: 7270496669300, x: 3.02986717, y: 20.8749466, z: -101.007843 },
    { seq: 8435, timeNs: 7270512990000, x: 3.0337007, y: 20.8418636, z: -100.924385 },
    { seq: 8436, timeNs: 7270529131200, x: 3.03751707, y: 20.8061924, z: -100.841301 },
    { seq: 8437, timeNs: 7270545770300, x: 3.04131627, y: 20.7679443, z: -100.758591 },
    { seq: 8438, timeNs: 7270562459400, x: 3.0450983, y: 20.7271309, z: -100.676254 },
  ]

  const collision = trackerTrajectoryCollision(record)
  assert.equal(collision.seq, 8426)
  assert.equal(trackerTrajectoryLanding(record), null)
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'trajectory_collision')

  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'bowser_castle' })
  assert.equal(fields.hit_position_estimated, undefined)
  assert.equal(fields.hit_world_x, 2.99154043)
  assert.equal(fields.hit_world_y, 21.1290703)
  assert.equal(fields.hit_world_z, -101.735619)
})

test('a Thwomp rebound plots its first impact while its later pickup stays fielded', () => {
  // Paragoomba's Playroom double was eventually picked up at
  // (-14.956, 3.293, -94.495), but the sharp velocity break at seq 14234 is
  // where it first struck the outfield object. The game's fair_fielded status
  // remains authoritative; selecting the impact does not promote it to a HR.
  const record = {
    endpoint: 'landing',
    endpointStatus: 'fair_fielded',
    endpointSeq: 14300,
    contactSeq: 13924,
    x: -14.9562197,
    y: 3.29293942,
    z: -94.4945755,
    trajectory: [
      { seq: 14231, timeNs: 9514735782800, x: -16.0275936, y: 13.0493574, z: -96.4628372 },
      { seq: 14232, timeNs: 9514752213500, x: -16.0535622, y: 12.8120966, z: -96.6068802 },
      { seq: 14233, timeNs: 9514768685100, x: -16.0794277, y: 12.5737658, z: -96.750267 },
      { seq: 14234, timeNs: 9514785291400, x: -16.1051903, y: 12.3343697, z: -96.8930054 },
      { seq: 14235, timeNs: 9514801956400, x: -16.0302601, y: 12.2744656, z: -96.6869812 },
      { seq: 14236, timeNs: 9514818552200, x: -16.01124, y: 12.2073488, z: -96.6481552 },
    ],
  }

  const impact = trackerTrajectoryFirstImpact(record)
  assert.equal(impact.seq, 14234)
  assert.equal(trackerBattedBallShouldRevealOccludedLanding(record, 'bowser_jr_playroom'), false)

  const hit = trackerBattedBallPaFields(record, { stadiumKey: 'bowser_jr_playroom' })
  assert.equal(hit.hit_world_x, -16.1051903)
  assert.equal(hit.hit_world_y, 12.3343697)
  assert.equal(hit.hit_world_z, -96.8930054)
  assert.equal(hit.hit_x, 41.7)
  assert.equal(hit.hit_y, 20.7)

  const fielded = trackerFieldedBallPaFields({
    x: record.x,
    y: record.y,
    z: record.z,
  }, { stadiumKey: 'bowser_jr_playroom' })
  assert.deepEqual(fielded, { fielded_x: 42.1, fielded_y: 26.7 })
})

test('a home run plots its first rear-wall impact instead of a later Thwomp-area bounce', () => {
  // Boomerang Bro.'s Playroom home run struck the blue rear wall at seq 821.
  // Tracking continued until a second downward impact at seq 895; treating
  // that later event as the landing is what drew the home run on the Thwomps.
  const record = {
    endpoint: 'landing',
    endpointStatus: 'fair',
    endpointSeq: 895,
    contactSeq: 450,
    x: -49.3774643,
    y: 6.34652424,
    z: -86.0253067,
    trajectory: [
      { seq: 819, timeNs: 13463881788500, x: -50.6853676, y: 18.6664791, z: -87.7213821 },
      { seq: 820, timeNs: 13463898352500, x: -50.7924957, y: 18.3945961, z: -87.7936478 },
      { seq: 821, timeNs: 13463914507200, x: -50.8995361, y: 18.1217976, z: -87.865448 },
      { seq: 822, timeNs: 13463930670400, x: -50.9318428, y: 18.0980892, z: -87.8452988 },
      { seq: 823, timeNs: 13463946841900, x: -50.9069099, y: 18.0136089, z: -87.8161011 },
      { seq: 893, timeNs: 13465115571500, x: -49.4135857, y: 6.80429506, z: -86.0676041 },
      { seq: 894, timeNs: 13465131938600, x: -49.3954849, y: 6.57626534, z: -86.0464096 },
      { seq: 895, timeNs: 13465148765300, x: -49.3774643, y: 6.34652424, z: -86.0253067 },
      { seq: 896, timeNs: 13465167160200, x: -49.3699913, y: 6.5050025, z: -86.0165558 },
    ],
  }

  const impact = trackerTrajectoryFirstImpact(record)
  assert.equal(impact.seq, 821)
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'trajectory_collision')
  assert.equal(trackerBattedBallShouldRevealOccludedLanding(record, 'bowser_jr_playroom'), false)

  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'bowser_jr_playroom' })
  assert.equal(fields.hit_world_x, -50.8995361)
  assert.equal(fields.hit_world_y, 18.1217976)
  assert.equal(fields.hit_world_z, -87.865448)
  assert.equal(fields.hit_x, 19.7)
  assert.equal(fields.hit_y, 21.8)
})

test('smooth fair-fielded flight is not mistaken for an impact', () => {
  const record = {
    endpoint: 'landing',
    endpointStatus: 'fair_fielded',
    endpointSeq: 4,
    trajectory: syntheticFlight({ x: 0, y: 20, z: -61, vx: 4, vy: 5, vz: -20 }, 0.2),
  }
  assert.equal(trackerTrajectoryFirstImpact(record), null)
})

test('a velocity break the ball flies straight through is not an impact', () => {
  // Dark Bones, PA 38 at Wario City: a break mid-flight put the plotted spot at
  // 274 ft -- inside a fence whose shortest point is 284.5 ft -- on a ball that
  // carried out of the park. Whatever that frame was, the ball did not stop
  // there, and the samples say so by continuing 12 units further out.
  const step = 16400000
  const sample = (seq, x, y, z) => ({ seq, timeNs: 13000000000 + (seq * step), x, y, z })
  const record = {
    endpoint: 'landing',
    endpointStatus: 'fair_hr',
    endpointSeq: 10,
    x: 0,
    y: 14,
    z: -96,
    trajectory: [
      sample(1, 0, 19.7, -79.5),
      sample(2, 0, 20.0, -80.0),
      sample(3, 0, 20.3, -80.5),
      sample(4, 0, 20.5, -81.2),   // the break
      sample(5, 0, 20.4, -82.4),
      sample(6, 0, 20.0, -84.4),
      sample(7, 0, 19.2, -87.0),
      sample(8, 0, 17.6, -90.0),
      sample(9, 0, 15.9, -93.0),
      sample(10, 0, 14.0, -96.0),
    ],
  }
  assert.equal(trackerTrajectoryFirstImpact(record), null)

  // Same break, but this time the flight stops there: that IS contact, and the
  // guard must not swallow it.
  const stopped = {
    ...record,
    endpointSeq: 7,
    trajectory: [
      sample(1, 0, 19.7, -79.5),
      sample(2, 0, 20.0, -80.0),
      sample(3, 0, 20.3, -80.5),
      sample(4, 0, 20.5, -81.2),
      sample(5, 0, 19.0, -80.9),
      sample(6, 0, 16.5, -80.4),
      sample(7, 0, 13.0, -79.9),
    ],
  }
  assert.ok(trackerTrajectoryFirstImpact(stopped))
})

test('an unresolved flight that hits something and drops is not flown onward', () => {
  // The retreat test only sees contact that sends the ball back toward home for
  // four or more frames. A ball that smacks something high and drops straight
  // down keeps its radius, so it registered as nothing and the flight was then
  // projected on as if it had flown free.
  const step = 16400000
  const sample = (seq, x, y, z) => ({ seq, timeNs: 13000000000 + (seq * step), x, y, z })
  const dropped = {
    endpoint: 'unresolved',
    trajectory: [
      sample(1, 0, 24.0, -92.0),
      sample(2, 0, 24.4, -95.0),
      sample(3, 0, 24.6, -98.0),
      sample(4, 0, 24.0, -98.2),   // radial travel has stopped by here
      sample(5, 0, 22.2, -98.3),
      sample(6, 0, 19.6, -98.3),
      sample(7, 0, 16.2, -98.4),
    ],
  }
  const hit = trackerTrajectoryCollision(dropped)
  assert.ok(hit, 'a ball that stops dead and falls is contact')
  // The contact sample is the last one still travelling at speed, not the first
  // one after the ball has stopped -- radius 98.0, which is where it struck.
  assert.equal(hit.seq, 3)

  // The same flight without the break must stay unresolved, or every smooth
  // ball that simply outran tracking would acquire a phantom collision.
  const smooth = {
    endpoint: 'unresolved',
    trajectory: syntheticFlight({ x: 0, y: 20, z: -61, vx: 4, vy: 5, vz: -20 }, 0.2),
  }
  assert.equal(trackerTrajectoryCollision(smooth), null)
})

test('a tracker reset to the zero sentinel is not mistaken for a wall rebound', () => {
  const record = parseTrackerBattedBallMessage(yellowPiantaWallBounceRecord)
  record.trajectory = [
    { seq: 6281, timeNs: 7200277281400, x: 69.6481781, y: 19.8339996, z: -68.7112808 },
    { seq: 6282, timeNs: 7200293756100, x: 69.7870407, y: 19.6014557, z: -68.7333374 },
    { seq: 6283, timeNs: 7200310280400, x: 69.9255905, y: 19.3678207, z: -68.7546692 },
    { seq: 6284, timeNs: 7200326326500, x: 0, y: 0, z: 0 },
  ]
  assert.equal(trackerTrajectoryCollision(record), null)
})

test('an elevated endpoint that abruptly loses velocity is a measured rear-wall collision', () => {
  const record = parseTrackerBattedBallMessage(peteyRearWallRecord)
  record.trajectory = [
    { seq: 1218, timeNs: 10023285423000, x: 63.5827103, y: 16.8854561, z: -90.1681671 },
    { seq: 1219, timeNs: 10023302724100, x: 63.707119, y: 16.647522, z: -90.2436218 },
    { seq: 1220, timeNs: 10023318485700, x: 63.8312416, y: 16.4085197, z: -90.318306 },
    { seq: 1221, timeNs: 10023334814100, x: 63.9550781, y: 16.1684551, z: -90.3922195 },
    { seq: 1222, timeNs: 10023353302500, x: 64.0786362, y: 15.9273338, z: -90.4653702 },
    { seq: 1223, timeNs: 10023369798700, x: 64.2019119, y: 15.6851606, z: -90.5377579 },
    { seq: 1224, timeNs: 10023386275900, x: 64.3249054, y: 15.4419394, z: -90.6093826 },
    { seq: 1225, timeNs: 10023402304900, x: 64.4476166, y: 15.1976748, z: -90.6802521 },
    { seq: 1226, timeNs: 10023418638000, x: 64.5700531, y: 14.9523716, z: -90.7503738 },
    // It barely rebounds upward, but its 17.33u/s incoming velocity collapses
    // to 1.52u/s and its Z direction reverses against the rear wall.
    { seq: 1227, timeNs: 10023435047500, x: 64.5936584, y: 14.9560347, z: -90.7430649 },
  ]

  assert.equal(trackerEndpointHasObservedImpact(record), true)
  assert.equal(trackerEndpointIsMidFlight(record), false)
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'trajectory_collision')
  assert.equal(trackerTrajectoryLanding(record), null)

  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'bowser_castle' })
  assert.equal(fields.hit_position_estimated, undefined)
  assert.equal(fields.hit_world_x, 64.5700531)
  assert.equal(fields.hit_world_y, 14.9523716)
  assert.equal(fields.hit_world_z, -90.7503738)
  assert.equal(fields.hit_x, 84.7)
  assert.equal(fields.hit_y, 24.6)
})

test('a measured front-wall top rebound is not pushed across Bowser Castle lava', () => {
  const record = parseTrackerBattedBallMessage(birdoCenterWallTopRecord)
  record.trajectory = [
    { seq: 10380, timeNs: 10400329347000, x: -16.7298298, y: 10.8695316, z: -101.397179 },
    { seq: 10381, timeNs: 10400345855200, x: -16.7455826, y: 10.5683193, z: -101.482986 },
    { seq: 10382, timeNs: 10400362098500, x: -16.7612743, y: 10.266324, z: -101.568405 },
    { seq: 10383, timeNs: 10400378400100, x: -16.7769051, y: 9.96355057, z: -101.653435 },
    { seq: 10384, timeNs: 10400394625500, x: -16.7924728, y: 9.66000175, z: -101.738083 },
    { seq: 10385, timeNs: 10400411459900, x: -16.8079796, y: 9.35568142, z: -101.822342 },
    { seq: 10386, timeNs: 10400428110100, x: -16.8234253, y: 9.05059242, z: -101.906219 },
    { seq: 10387, timeNs: 10400446618800, x: -16.8335152, y: 9.10499763, z: -101.960968 },
  ]

  assert.equal(trackerEndpointHasObservedImpact(record), true)
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'trajectory_collision')
  assert.equal(trackerBattedBallShouldRevealOccludedLanding(record), false)
  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'bowser_castle' })
  // The old generic lava-visibility push moved this to (39.6, 18.6), far past
  // the front wall. The flat ground projection (40.6, 25.9) was too short.
  // The measured 3D point belongs between them, on the thick wall's top.
  assert.equal(fields.hit_x, 40.5)
  assert.equal(fields.hit_y, 21.7)
})

test('a measured Playroom raised impact is not visibility-pushed past the Thwomps', () => {
  const record = parseTrackerBattedBallMessage(redKritterPlayroomDeckRecord)
  record.trajectory = [
    { seq: 1036, timeNs: 11054340911100, x: -54.9415703, y: 6.92397785, z: -76.5660782 },
    { seq: 1037, timeNs: 11054358000700, x: -55.0218773, y: 6.61999893, z: -76.5877304 },
    { seq: 1038, timeNs: 11054375527300, x: -55.1018105, y: 6.31525373, z: -76.60923 },
    { seq: 1039, timeNs: 11054391780300, x: -55.1188202, y: 6.50501537, z: -76.6138000 },
  ]

  assert.equal(trackerEndpointHasObservedImpact(record), true)
  assert.equal(trackerBattedBallShouldRevealOccludedLanding(record), false)
  assert.equal(
    trackerBattedBallShouldRevealOccludedLanding(record, 'bowser_jr_playroom'),
    false,
  )
  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'bowser_jr_playroom' })
  // Follow-up replay marks proved that height cannot distinguish the rear deck
  // from an overlapping Thwomp. Keep the measured 3D contact and the global
  // camera projection instead of borrowing a nearby object's local correction.
  assert.equal(fields.hit_world_x, -55.1018105)
  assert.equal(fields.hit_world_y, 6.31525373)
  assert.equal(fields.hit_world_z, -76.60923)
  assert.equal(fields.hit_x, 18.6)
  assert.equal(fields.hit_y, 33.8)
})

test('a wall-top hit keeps one height-aware point when its result later becomes HR', () => {
  const record = parseTrackerBattedBallMessage(wigglerWallTopRecord)
  record.trajectory = [
    { seq: 856, timeNs: 10675202056900, x: -51.345295, y: 10.5176916, z: -81.2647476 },
    { seq: 857, timeNs: 10675220008000, x: -51.4258766, y: 10.2152405, z: -81.2882538 },
    { seq: 858, timeNs: 10675236317900, x: -51.5063477, y: 9.9120121, z: -81.3113403 },
    { seq: 859, timeNs: 10675252639600, x: -51.5867119, y: 9.60801125, z: -81.3340149 },
    { seq: 860, timeNs: 10675268924500, x: -51.6669693, y: 9.30324078, z: -81.3562775 },
    { seq: 861, timeNs: 10675285409000, x: -51.7471199, y: 8.99770355, z: -81.3781357 },
    { seq: 862, timeNs: 10675302324400, x: -51.7857208, y: 9.10499859, z: -81.3884811 },
  ]

  assert.equal(trackerEndpointHasObservedImpact(record), true)
  assert.equal(trackerBattedBallShouldRevealOccludedLanding(record), false)
  const fields = trackerBattedBallPaFields(record, { stadiumKey: 'bowser_castle' })
  // Ground-only was (21.1, 35.9); result-driven lava clearance was
  // (17.6, 28.9). The actual y=8.998 collision projects between them.
  assert.equal(fields.hit_x, 20.3)
  assert.equal(fields.hit_y, 31.7)
})

test('a post-endpoint zero sentinel still leaves an airborne outbound endpoint projected', () => {
  const record = parseTrackerBattedBallMessage(peteyRearWallRecord)
  record.trajectory = [
    { seq: 1222, timeNs: 10023353302500, x: 64.0786362, y: 15.9273338, z: -90.4653702 },
    { seq: 1223, timeNs: 10023369798700, x: 64.2019119, y: 15.6851606, z: -90.5377579 },
    { seq: 1224, timeNs: 10023386275900, x: 64.3249054, y: 15.4419394, z: -90.6093826 },
    { seq: 1225, timeNs: 10023402304900, x: 64.4476166, y: 15.1976748, z: -90.6802521 },
    { seq: 1226, timeNs: 10023418638000, x: 64.5700531, y: 14.9523716, z: -90.7503738 },
    { seq: 1227, timeNs: 10023435047500, x: 0, y: 0, z: 0 },
  ]
  assert.equal(trackerEndpointHasObservedImpact(record), false)
  assert.equal(trackerEndpointIsMidFlight(record), true)
})

test('a measurement is never overruled by the flight model', () => {
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const record = {
    endpoint: 'landing',
    x: 12, y: 0.25, z: -95,
    trajectory: syntheticFlight(launch, 1.0),
  }
  assert.equal(trackerTrajectoryLanding(record), null)
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'endpoint_coordinates')
})

test('an airborne, still-outbound "landing" is treated as mid-flight, not a landing', () => {
  // The Peach Ice Garden case: a home run stamped `landing` while the ball was
  // 15.8 ft up, still travelling outward. Taken at face value it plots short of
  // the wall it just cleared.
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const full = syntheticFlight(launch, 4.0)
  const cut = full.filter((s) => s.y > 1.4)   // stop tracking while still high
  const last = cut[cut.length - 1]
  const record = {
    endpoint: 'landing',
    x: last.x, y: last.y, z: last.z,
    trajectory: cut,
  }
  assert.equal(trackerEndpointIsMidFlight(record), true)
  const geometry = trackerBattedBallPlotGeometry(record)
  assert.equal(geometry.source, 'trajectory_projection')
  // ...and it must land FURTHER out than the point tracking stopped at.
  const stopped = Math.hypot(last.x, last.z)
  assert.ok(
    geometry.distanceFeet / FEET_PER_UNIT > stopped,
    `projected ${geometry.distanceFeet / FEET_PER_UNIT} vs stopped ${stopped}`,
  )
})

test('an outward top-of-wall rebound remains a measured landing', () => {
  const buffer = new TrackerBallSampleBuffer()
  const samples = [
    { seq: 8983, x: 53.17593, y: 10.4373169, z: -79.5281067 },
    { seq: 8984, x: 53.2585068, y: 10.1342211, z: -79.5468063 },
    { seq: 8985, x: 53.3409729, y: 9.83035183, z: -79.5650864 },
    { seq: 8986, x: 53.4233246, y: 9.52571201, z: -79.582962 },
    { seq: 8987, x: 53.5055656, y: 9.22030544, z: -79.6004257 },
    { seq: 8988, x: 53.5876961, y: 8.91413593, z: -79.6174774 },
    // The first post-endpoint frame rises sharply while x/z continue outward:
    // contact with the horizontal wall top, not tracking loss in open air.
    { seq: 8989, x: 53.6048355, y: 9.1050024, z: -79.6209488 },
  ]
  samples.forEach((sample) => buffer.push({
    ...sample, timeNs: sample.seq * 16_500_000,
  }))

  const record = parseTrackerBattedBallMessage(redPiantaWallTopRecord)
  const withoutRebound = { ...record, trajectory: samples.slice(0, -1) }
  assert.equal(trackerEndpointIsMidFlight(withoutRebound), true)

  const attached = attachTrackerTrajectory(record, buffer)
  assert.equal(attached.trajectory.at(-1).seq, 8989)
  assert.equal(trackerEndpointIsMidFlight(attached), false)
  assert.equal(trackerBattedBallPlotGeometry(attached).source, 'trajectory_collision')

  const fields = trackerBattedBallPaFields(attached, { stadiumKey: 'bowser_castle' })
  assert.equal(fields.hit_position_estimated, undefined)
  assert.equal(fields.hit_world_x, 53.5876961)
  assert.equal(fields.hit_world_y, 8.91413593)
  assert.equal(fields.hit_world_z, -79.6174774)
})

test('Bowser Castle raised-pillar height remains separate from its wall top', () => {
  const record = parseTrackerBattedBallMessage(birdoPillarTopRecord)
  record.trajectory = [
    { seq: 11700, x: -45.3057594, y: 13.3548841, z: -86.7904282 },
    { seq: 11701, x: -45.368248, y: 13.0618057, z: -86.8431015 },
    { seq: 11702, x: -45.430603, y: 12.7679081, z: -86.8953629 },
    { seq: 11703, x: -45.4928284, y: 12.473196, z: -86.9472046 },
    { seq: 11704, x: -45.5549202, y: 12.1776724, z: -86.9986343 },
    { seq: 11705, x: -45.6168823, y: 11.881341, z: -87.0496521 },
    { seq: 11706, x: -45.6234016, y: 12.1050043, z: -87.0550003 },
  ]

  assert.equal(trackerEndpointIsMidFlight(record), false)
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'trajectory_collision')
  // Ball centre is one 0.25u radius above the surface. The pillar is almost
  // ten feet taller than Red Pianta's independently observed ordinary wall.
  const pillarSurface = record.y - 0.25
  const wallSurface = parseTrackerBattedBallMessage(redPiantaWallTopRecord).y - 0.25
  assert.ok(Math.abs(pillarSurface - 11.631341) < 1e-9)
  assert.ok((pillarSurface - wallSurface) * FEET_PER_UNIT > 9.7)
})

test('a ball that struck something plots first contact rather than its later rebound', () => {
  // Also airborne, but travelling INWARD at the end — it hit a wall and came
  // back. The first velocity break is the contact; projecting the rebound as
  // uninterrupted flight would invent carry the ball never had.
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const cut = syntheticFlight(launch, 4.0).filter((s) => s.y > 1.4)
  // Reverse the last few frames: outward, then back.
  const bounced = [...cut]
  const n = bounced.length
  for (let i = 1; i <= 4; i += 1) {
    const src = bounced[n - 1 - i]
    bounced.push({ ...src, seq: n + i, timeNs: bounced[n - 1].timeNs + (i * 16_500_000) })
  }
  const last = bounced[bounced.length - 1]
  const record = {
    endpoint: 'landing', x: last.x, y: last.y, z: last.z, trajectory: bounced,
  }
  assert.equal(trackerEndpointIsMidFlight(record), false)
  assert.ok(trackerTrajectoryFirstImpact(record))
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'trajectory_collision')
})

test('an elevated home-run impact keeps its wall dot but stores its remaining carry', () => {
  const launch = { x: 0, y: 2.5, z: -1, vx: 18, vy: 39, vz: -48 }
  const freeFlight = syntheticFlight(launch, 4.0).filter((sample) => sample.y > 8)
  const impact = freeFlight.at(-1)
  const post = {
    ...impact,
    seq: impact.seq + 1,
    timeNs: impact.timeNs + 16_500_000,
    // A clear wall rebound: inward and slightly upward.
    x: impact.x - 0.1,
    y: impact.y + 0.1,
    z: impact.z + 0.1,
  }
  const record = {
    endpoint: 'landing', endpointSeq: impact.seq,
    x: impact.x, y: impact.y, z: impact.z,
    trajectory: [...freeFlight, post],
  }

  const carry = trackerProjectedCarryFromObservedImpact(record)
  assert.ok(carry)
  assert.ok(carry.distanceFeet > carry.impactDistanceFeet + 20)

  const measured = trackerBattedBallPaFields(record)
  const homeRun = trackerBattedBallPaFields(record, { projectCarryAtImpact: true })
  assert.equal(measured.hit_distance_ft, Math.round(carry.impactDistanceFeet * 10) / 10)
  assert.equal(homeRun.hit_distance_ft, Math.round(carry.distanceFeet * 10) / 10)
  // A MEASURED landing is never moved to fit the map. The distance field may
  // report the unobstructed carry, but the ball's own coordinates -- and the
  // dot drawn from them -- stay exactly where the game put it. Drawing that
  // coordinate correctly is the job of the park's vertical, not of this file.
  assert.equal(homeRun.hit_world_x, measured.hit_world_x)
  assert.equal(homeRun.hit_world_y, measured.hit_world_y)
  assert.equal(homeRun.hit_world_z, measured.hit_world_z)
})

test('a ball resting on the ground is a landing however high the arc was', () => {
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const record = {
    endpoint: 'landing',
    x: 12, y: 0.25, z: -95,
    trajectory: syntheticFlight(launch, 4.0),
  }
  assert.equal(trackerEndpointIsMidFlight(record), false)
})

test('a catch is a real event and is never replaced by a projection', () => {
  // A caught ball is genuinely airborne and genuinely outbound, so the height
  // and direction tests alone would misfire on it.
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const cut = syntheticFlight(launch, 4.0).filter((s) => s.y > 1.4)
  const last = cut[cut.length - 1]
  const record = {
    endpoint: 'catch', x: last.x, y: last.y, z: last.z, trajectory: cut,
  }
  assert.equal(trackerEndpointIsMidFlight(record), false)
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'endpoint_coordinates')
})

test('a mid-flight endpoint is flagged as an estimate and carries no height', () => {
  // Height must be dropped: the projection is to ground level, and a leftover
  // mid-flight height would be drawn as though the ball ended up there.
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const cut = syntheticFlight(launch, 4.0).filter((s) => s.y > 1.4)
  const last = cut[cut.length - 1]
  const fields = trackerBattedBallPaFields({
    endpoint: 'landing', x: last.x, y: last.y, z: last.z,
    sprayAngleDeg: -6, exitVelocityMph: 110, launchAngleDeg: 34,
    trajectory: cut,
  })
  assert.equal(fields.hit_position_estimated, true)
  assert.equal(fields.hit_world_y, undefined)
  assert.ok(Math.hypot(fields.hit_world_x, fields.hit_world_z) > Math.hypot(last.x, last.z))
})

test('too little flight yields no projection rather than a bad one', () => {
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const record = {
    endpoint: 'unresolved',
    x: null, z: null,
    projectedX: 40, projectedZ: -90,
    trajectory: syntheticFlight(launch, 0.15),
  }
  assert.equal(trackerTrajectoryLanding(record), null)
  // and the caller falls back exactly as it did before this existed
  assert.equal(trackerBattedBallPlotGeometry(record).source, 'projected_coordinates')
})

test('a record with no samples behaves exactly as it did before trajectories existed', () => {
  const record = parseTrackerBattedBallMessage(bowserJrDeepHrUnresolvedRecord)
  assert.equal(trackerTrajectoryLanding(record), null)
  assert.equal(trackerBattedBallPlotGeometry(record, 400).source, 'launch_spray_angle')
})

test('a trajectory-derived position is flagged as an estimate, not a measurement', () => {
  const launch = { x: 0, y: 2.5, z: -1, vx: 6, vy: 46, vz: -58 }
  const fields = trackerBattedBallPaFields({
    endpoint: 'unresolved',
    x: null, y: null, z: null,
    exitVelocityMph: 110, launchAngleDeg: 34, sprayAngleDeg: -6,
    trajectory: syntheticFlight(launch, 1.0),
  })
  assert.equal(fields.hit_position_estimated, true)
  assert.ok(fields.hit_world_x != null && fields.hit_world_z != null)
})

// --- the measured pitch stream ----------------------------------------------

const measuredPitch = (overrides = {}) => ({
  pitch_timer: 1000,
  inning: 1,
  inning_half: 0,
  batter: 'Baby DK',
  offer: 'swing',
  outcome: 'strike',
  swing_frames: 12,
  bunt_frames: 0,
  contact: false,
  swing_timer: null,
  balls_before: 0,
  strikes_before: 0,
  ...overrides,
})

const loggedPitch = (result, balls, strikes) => ({
  pitch_number_pa: 0,
  result,
  count_balls_before: balls,
  count_strikes_before: strikes,
})

test('a taken strike and a swinging strike stop being the same pitch', () => {
  const logged = [loggedPitch('strike_unknown', 0, 0), loggedPitch('strike_unknown', 0, 1)]
  const measured = [
    measuredPitch({ pitch_timer: 1, offer: 'take' }),
    measuredPitch({ pitch_timer: 2, offer: 'swing', strikes_before: 1 }),
  ]
  const { pitches, unmatched } = applyMeasuredPitchOffers(logged, measured)
  assert.equal(pitches[0].result, 'looking')
  assert.equal(pitches[1].result, 'swinging_miss')
  assert.deepEqual(pitches.map((pitch) => pitch.offer), ['take', 'swing'])
  assert.equal(unmatched.length, 0)
})

test('a square that was pulled back is a take, and still says it was shown', () => {
  // The capture reports it as a take; `bunt_shown` is what preserves the fact
  // that the batter squared at all. Nothing downstream may read it as a bunt.
  const { pitches } = applyMeasuredPitchOffers(
    [loggedPitch('strike_unknown', 0, 0)],
    [measuredPitch({ offer: 'take', bunt_shown: true, bunt_frames: 4, swing_frames: 0 })],
  )
  assert.equal(pitches[0].result, 'looking')
  assert.equal(pitches[0].offer, 'take')
  assert.equal(trackerContactWasBunt({ exitVelocityMph: 20 }, { contact_type: 'swing' }), false)
})

test('a missed bunt is a swinging strike, not a called one', () => {
  const { pitches } = applyMeasuredPitchOffers(
    [loggedPitch('strike_unknown', 0, 0)],
    [measuredPitch({ offer: 'bunt', bunt_frames: 9, swing_frames: 0 })],
  )
  assert.equal(pitches[0].result, 'swinging_miss')
  assert.equal(pitches[0].offer, 'bunt')
})

test('an outcome the log observed directly is never rewritten', () => {
  const { pitches } = applyMeasuredPitchOffers(
    [loggedPitch('ball', 0, 0), loggedPitch('foul', 1, 0)],
    [
      measuredPitch({ pitch_timer: 1, offer: 'take', outcome: 'ball' }),
      measuredPitch({
        pitch_timer: 2, offer: 'swing', outcome: 'contact', contact: true, swing_timer: 55,
      }),
    ],
  )
  assert.deepEqual(pitches.map((pitch) => pitch.result), ['ball', 'foul'])
  assert.deepEqual(pitches.map((pitch) => pitch.offer), ['take', 'swing'])
})

test('the log listing the ball in play first does not misassign the offers', () => {
  // The real ordering of this plate appearance was foul, foul, bunt in play;
  // the tracker log pushes the ball in play when contact is announced, so it
  // lists it first. Pairing by position would hand the bunt to the first foul.
  const logged = [
    loggedPitch('in_play', 0, 0),
    loggedPitch('foul', 0, 0),
    loggedPitch('foul', 0, 1),
  ]
  const measured = [
    measuredPitch({ pitch_timer: 1, offer: 'swing', contact: true, swing_timer: 10 }),
    measuredPitch({
      pitch_timer: 2, offer: 'swing', contact: true, swing_timer: 20, strikes_before: 1,
    }),
    measuredPitch({
      pitch_timer: 3, offer: 'bunt', contact: true, swing_timer: 30, strikes_before: 2,
      bunt_frames: 26, swing_frames: 0,
    }),
  ]
  const { pitches, unmatched } = applyMeasuredPitchOffers(logged, measured)
  assert.equal(pitches[0].offer, 'bunt')          // the ball in play, laid down
  assert.equal(pitches[0].swing_timer, 30)
  assert.deepEqual(pitches.slice(1).map((pitch) => pitch.offer), ['swing', 'swing'])
  assert.equal(unmatched.length, 0)
})

test('a pitch the log never reported is reported as missing, not absorbed', () => {
  const { pitches, unmatched } = applyMeasuredPitchOffers(
    [loggedPitch('in_play', 0, 1)],
    [
      measuredPitch({ pitch_timer: 1, offer: 'swing', outcome: 'strike' }),
      measuredPitch({
        pitch_timer: 2, offer: 'swing', outcome: 'contact', contact: true,
        swing_timer: 40, strikes_before: 1,
      }),
    ],
  )
  assert.equal(pitches.length, 1)
  assert.equal(pitches[0].swing_timer, 40)
  assert.equal(unmatched.length, 1)
  assert.equal(unmatched[0].pitch_timer, 1)
})

test('with no capture running every pitch is left exactly as the log reported it', () => {
  const logged = [loggedPitch('strike_unknown', 0, 0), loggedPitch('ball', 0, 1)]
  const { pitches, unmatched, matched } = applyMeasuredPitchOffers(logged, [])
  assert.deepEqual(pitches.map((pitch) => pitch.result), ['strike_unknown', 'ball'])
  assert.deepEqual(pitches.map((pitch) => pitch.offer), [null, null])
  assert.equal(unmatched.length, 0)
  assert.equal(matched, 0)
})

test('the bridge keys its pitch result differently and still gets the offer', () => {
  const { pitches } = applyMeasuredPitchOffers(
    [{ type: 'strike_unknown', before: { balls: 0, strikes: 0 } }],
    [measuredPitch({ offer: 'take' })],
    { resultKey: 'type' },
  )
  assert.equal(pitches[0].type, 'looking')
})

test('a measured pitch belongs to the plate appearance whose batter it names', () => {
  const record = measuredPitch({ inning: 3, inning_half: 1, batter: 'Red Koopa Troopa' })
  // The capture spells the character the game's way and the log the roster's.
  assert.equal(measuredPitchMatchesPa(record,
    { inning: 3, isTop: false, batterName: 'Red Koopa' }), true)
  assert.equal(measuredPitchMatchesPa(record,
    { inning: 3, isTop: true, batterName: 'Red Koopa' }), false)
  assert.equal(measuredPitchMatchesPa(record,
    { inning: 4, isTop: false, batterName: 'Red Koopa' }), false)
})

test('a measured bunt outranks the exit-velocity guess in both directions', () => {
  const hardHit = { exitVelocityMph: 95, endpoint: 'landing' }
  const deadened = { exitVelocityMph: 20.9, endpoint: 'landing' }
  // The capture saw the bunt animation on a ball that left the bat hard.
  assert.equal(trackerContactWasBunt(hardHit, { contact_type: 'bunt' }), true)
  // And saw a swing on a ball that barely left it -- a mishit, not a bunt.
  assert.equal(trackerContactWasBunt(deadened, { contact_type: 'swing' }), false)
  // With no play joined, the exit velocity is still the answer.
  assert.equal(trackerContactWasBunt(deadened, null), true)
  assert.equal(trackerContactWasBunt(hardHit, null), false)
})
