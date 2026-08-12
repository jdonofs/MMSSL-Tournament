import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyTrackerBattedBallToBuffer,
  applyTrackerFieldedBallToBuffer,
  buildExactTrackerRunnerAssignments,
  isTrackerRobbedHomeRun,
  numberTrackerPitches,
  parseTrackerBattedBallMessage,
  parseTrackerFieldedBallMessage,
  parseTrackerHitByPitchMessage,
  shouldChargeTrackerBobbleError,
  shouldClassifyTrackerFielderChoice,
  shouldCreditTrackerPutout,
  shouldReclassifyTrackerFlyOutAsSacFly,
  trackerBattedBallMatchesMatchup,
  trackerBattedBallPaFields,
  trackerBattedBallTrajectory,
  trackerCaughtBallResult,
  trackerFieldedBallPaFields,
} from '../scripts/tracker_play_events.mjs'

const bowserLandingRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=41|batter=Bowser|pitcher=Mario|exit_speed_mph=85.0|launch_degrees=35.2|spray_degrees=12.0|side=first_base|endpoint=landing|endpoint_status=fair|endpoint_seq=306|x=29.0159225|y=0.264784217|z=-71.6531067|distance_feet=229.2'
const bowserTimedLandingRecord = `${bowserLandingRecord}|flight_updates=265|hang_time_seconds=4.421|wall_time_seconds=4.820`
const bowserCurrentTimedLandingRecord = `${bowserLandingRecord}|flight_updates=265|sampled_updates_seconds=4.421|hang_time_seconds=4.820`
const kingKRoolLandingRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=4760|batter=King K. Rool|pitcher=Green Paratroopa|exit_speed_mph=97.6|launch_degrees=-0.8|spray_degrees=-14.6|side=third_base|endpoint=landing|endpoint_status=fair|endpoint_seq=4786|x=-5.77596045|y=0.2675789|z=-22.8378239|distance_feet=67.8'
const luigiCatchRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=2371|batter=Luigi|pitcher=Green Paratroopa|exit_speed_mph=92.2|launch_degrees=47.0|spray_degrees=16.5|side=first_base|endpoint=catch|endpoint_status=caught|endpoint_seq=2778|x=32.7537613|y=0|z=-90.8825378|distance_feet=287.0'
const wigglerFoulRecord = '[TRACKER_BATTED_BALL_PROVISIONAL] contact_seq=1198|batter=Wiggler|pitcher=Green Paratroopa|exit_speed_mph=94.6|launch_degrees=35.7|spray_degrees=35.1|side=first_base|endpoint=foul|endpoint_status=foul|endpoint_seq=none|x=none|y=none|z=none|distance_feet=none'
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
    distanceFeet: 229.2,
    flightUpdates: null,
    hangTimeSec: null,
    sampledUpdatesSec: null,
    wallTimeSec: null,
  })
  assert.deepEqual(trackerBattedBallPaFields(record), {
    exit_velocity_mph: 85,
    launch_angle_deg: 35.2,
    hit_distance_ft: 229.2,
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
    launch_angle_deg: 35.2,
    hit_distance_ft: 229.2,
    hit_angle_deg: 12,
    hang_time_sec: 4.82,
    hit_stadium_key: 'mario_stadium',
    hit_x: 60.7,
    hit_y: 42.5,
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
    launch_angle_deg: 47,
    hit_distance_ft: 287,
    hit_angle_deg: 16.5,
  })
  assert.deepEqual(trackerBattedBallPaFields(record, { stadiumKey: 'mario_stadium' }), {
    exit_velocity_mph: 92.2,
    launch_angle_deg: 47,
    hit_distance_ft: 287,
    hit_angle_deg: 16.5,
    hit_stadium_key: 'mario_stadium',
    hit_x: 68.3,
    hit_y: 31,
    fielded_x: 68.3,
    fielded_y: 31,
  })
})

test('measured launch angle classifies landed grounders, liners, and flies', () => {
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: -0.9 }), 'G')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 18 }), 'L')
  assert.equal(trackerBattedBallTrajectory({ endpoint: 'landing', launchAngleDeg: 35 }), 'F')
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
    fielded_x: 58.4,
    fielded_y: 75.2,
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
