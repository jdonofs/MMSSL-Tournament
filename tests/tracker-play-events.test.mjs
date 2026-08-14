import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyTrackerBattedBallToBuffer,
  applyTrackerFieldedBallToBuffer,
  buildExactTrackerRunnerAssignments,
  isTrackerBuntedBall,
  isTrackerRobbedHomeRun,
  numberTrackerPitches,
  parseTrackerBattedBallMessage,
  parseTrackerFieldedBallMessage,
  parseTrackerHitByPitchMessage,
  shouldChargeTrackerBobbleError,
  shouldClassifyTrackerFielderChoice,
  shouldClassifyTrackerSacrificeBunt,
  shouldCreditTrackerPutout,
  shouldReclassifyTrackerFlyOutAsSacFly,
  trackerBattedBallMatchesMatchup,
  trackerBattedBallPaFields,
  trackerBattedBallPlotGeometry,
  trackerBattedBallTrajectory,
  trackerCaughtBallResult,
  trackerFieldedBallPaFields,
} from '../scripts/tracker_play_events.mjs'
import { projectTrackerBattedBallDistanceFeet } from '../scripts/tracker_field_projection.mjs'

const bowserLandingRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=41|batter=Bowser|pitcher=Mario|exit_speed_mph=85.0|launch_degrees=35.2|spray_degrees=12.0|side=first_base|endpoint=landing|endpoint_status=fair|endpoint_seq=306|x=29.0159225|y=0.264784217|z=-71.6531067|distance_feet=229.2'
const bowserTimedLandingRecord = `${bowserLandingRecord}|flight_updates=265|hang_time_seconds=4.421|wall_time_seconds=4.820`
const bowserCurrentTimedLandingRecord = `${bowserLandingRecord}|flight_updates=265|sampled_updates_seconds=4.421|hang_time_seconds=4.820`
const kingKRoolLandingRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=4760|batter=King K. Rool|pitcher=Green Paratroopa|exit_speed_mph=97.6|launch_degrees=-0.8|spray_degrees=-14.6|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=4786|x=-5.77596045|y=0.2675789|z=-22.8378239|distance_feet=67.8'
const luigiCatchRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=2371|batter=Luigi|pitcher=Green Paratroopa|exit_speed_mph=92.2|launch_degrees=47.0|spray_degrees=16.5|side=first_base|endpoint=catch|endpoint_status=caught|endpoint_seq=2778|x=32.7537613|y=0|z=-90.8825378|distance_feet=287.0'
const wigglerFoulRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=1198|batter=Wiggler|pitcher=Green Paratroopa|exit_speed_mph=94.6|launch_degrees=35.7|spray_degrees=35.1|side=first_base|endpoint=foul|endpoint_status=foul|endpoint_seq=none|x=none|y=none|z=none|distance_feet=none'
const bowserJrDeepHrUnresolvedRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=903|batter=Bowser Jr.|pitcher=Wario|exit_speed_mph=110.0|launch_degrees=30.0|spray_degrees=8.0|side=first_base|endpoint=unresolved|endpoint_status=next_pitch_counter|endpoint_seq=none|x=none|y=none|z=none|distance_feet=none|flight_updates=none|sampled_updates_seconds=none|hang_time_seconds=none'
const redYoshiFieldedRecord = '[TRACKER_BALL_FIELDED_PROVISIONAL] contact_seq=228|batter=Red Yoshi|pitcher=Mario|fielded_seq=279|time_ns=21364236395200|x=12.732379|y=0.251562238|z=-27.107254|distance_feet=87.0|spray_degrees=25.3|fielding_time_seconds=1.253|source=this_pitch.fair_or_foul+latest_physical_sample'

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
    exit_velocity_mph: 85,
    // The ball's own coordinates, stored as measured — every position
    // downstream is derived from these rather than from the launch angle.
    hit_world_x: 29.0159225,
    hit_world_z: -71.6531067,
    hit_world_y: 0.264784217,
    launch_angle_deg: 35.2,
    // Derived from the coordinates at the measured scale, not the 229.2 the
    // executable emitted using whatever scale it was built with.
    hit_distance_ft: 257.1,
    hit_angle_deg: 12,
  })
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
    exit_velocity_mph: 85,
    hit_world_x: 29.0159225,
    hit_world_z: -71.6531067,
    hit_world_y: 0.264784217,
    launch_angle_deg: 35.2,
    hit_distance_ft: 257.1,
    hit_angle_deg: 12,
    hang_time_sec: 4.82,
    hit_stadium_key: 'mario_stadium',
    // Plotted from the tracked landing coordinates, not the 12 degree launch
    // direction, which sat this marker ~40 feet away.
    hit_x: 72,
    hit_y: 39.3,
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
    exit_velocity_mph: 92.2,
    hit_world_x: 32.7537613,
    hit_world_z: -90.8825378,
    hit_world_y: 0,
    launch_angle_deg: 47,
    hit_distance_ft: 321.8,
    hit_angle_deg: 16.5,
  })
  assert.deepEqual(trackerBattedBallPaFields(record, { stadiumKey: 'mario_stadium' }), {
    exit_velocity_mph: 92.2,
    hit_world_x: 32.7537613,
    hit_world_z: -90.8825378,
    hit_world_y: 0,
    launch_angle_deg: 47,
    hit_distance_ft: 321.8,
    hit_angle_deg: 16.5,
    hit_stadium_key: 'mario_stadium',
    hit_x: 74.8,
    hit_y: 24.8,
    fielded_x: 74.8,
    fielded_y: 24.8,
  })
})

test('a deep home run that never resolves a landing gets a physics-projected distance instead of staying empty', () => {
  const record = parseTrackerBattedBallMessage(bowserJrDeepHrUnresolvedRecord)
  assert.equal(record.endpoint, 'unresolved')
  assert.equal(record.distanceFeet, null)
  assert.equal(record.hangTimeSec, null)

  const projected = projectTrackerBattedBallDistanceFeet(110.0, 30.0)
  assert.ok(projected.distanceFeet > 0)

  assert.deepEqual(trackerBattedBallPaFields(record), {
    exit_velocity_mph: 110,
    // A ball that outran tracking still gets a position: its LAUNCH direction
    // at the projected distance. The tracker's own extrapolated coordinates are
    // deliberately not used for direction — extending the final tangent in a
    // straight line over-rotates a curving ball by 8-20 degrees down the lines,
    // against about 1 degree of real curve measured on balls that resolved.
    hit_world_x: 15.658086505049164,
    hit_world_z: -112.60380439989936,
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
    trackerBattedBallPaFields({ ...record, endpoint: 'landing', distanceFeet: 300 }).hit_distance_ft,
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

  // The real extrapolated distance/hang time win over the cruder JS-side
  // launch-only fallback projection.
  assert.deepEqual(trackerBattedBallPaFields(record), {
    exit_velocity_mph: 98.4,
    // This build did not state its feet-per-unit and sent no coordinates, so
    // 322.4 is a number in unknown units. Rather than guess a scale, the
    // position falls back to the calibrated distance fit, which is in our own
    // feet by construction. Better than guessing a scale for a number whose
    // units nobody can name.
    hit_world_x: -36.57267464234702,
    hit_world_z: -85.47922816338806,
    launch_angle_deg: 38.9,
    hit_distance_ft: 309.5,
    hit_angle_deg: -23.3,
    hang_time_sec: 5.667,
  })
})

test('measured launch angle classifies landed grounders, liners, and flies', () => {
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: -0.9 }), 'G')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 18 }), 'L')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 35 }), 'F')
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
})

test('a low airborne catch becomes a lineout while a high catch remains a flyout', () => {
  assert.equal(trackerCaughtBallResult({ endpoint: 'catch', launchAngleDeg: 8 }), 'LO')
  assert.equal(trackerCaughtBallResult({ endpoint: 'catch', launchAngleDeg: 47 }), 'FO')
})

test('only a confirmed near-wall Buddy Jump is marked as a robbed home run', () => {
  const record = parseTrackerBattedBallMessage(luigiCatchRecord)
  assert.equal(isTrackerRobbedHomeRun({ record, isBuddyJump: true, stadiumKey: 'mario_stadium' }), true)
  assert.equal(isTrackerRobbedHomeRun({ record, isBuddyJump: false, stadiumKey: 'mario_stadium' }), false)
  assert.equal(isTrackerRobbedHomeRun({
    record: { ...record, distanceFeet: 200 }, isBuddyJump: true, stadiumKey: 'mario_stadium',
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
    fielded_x: 59.7,
    fielded_y: 73,
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

test('a home run that bounces off a fielder is not automatically scored as an error', () => {
  assert.equal(shouldChargeTrackerBobbleError({
    bobbleFielderName: 'Mario', result: 'HR',
  }), false)
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
  assert.equal(fields.hit_distance_ft, 257.1)
  assert.equal(fields.hit_x, 72)
})

test('an extrapolated home run plots from its projected coordinates when the tracker reports them', () => {
  const withCoordinates = `${bowserJrDeepHrUnresolvedRecord.replace('|distance_feet=none', '|distance_feet=322.4')}|projected_x=-31.4|projected_z=-101.2`
  const geometry = trackerBattedBallPlotGeometry(parseTrackerBattedBallMessage(withCoordinates))
  assert.equal(geometry.source, 'projected_coordinates')
  assert.ok(Math.abs(geometry.angleDeg - -17.318) < 0.05)
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
