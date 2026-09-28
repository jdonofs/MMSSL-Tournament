import test from 'node:test'
import assert from 'node:assert/strict'
import {
  USER_AGENCY,
  aggregateUserValue,
  buildUserValueStats,
  classifyFieldingAction,
  classifyPitchInput,
  classifySwingMode,
  decomposeRunValue,
  fieldingRunValue,
  scoreFieldingAction,
  scoreSprintExecution,
} from '../src/utils/userValue.js'

test('swing classification refuses to invent slap or charge from animation frames', () => {
  assert.deepEqual(classifySwingMode({ offer: 'swing', swing_frames: 28 }), {
    mode: 'ordinary_unknown', observed: false, source: 'swing_observed_charge_state_missing',
  })
  assert.equal(classifySwingMode({ swing_mode: 'charge' }).mode, 'charge')
  assert.equal(classifySwingMode({ bunt_frames: 2 }).mode, 'bunt')
  assert.equal(classifySwingMode({ star_swing: { captain: 'Mario' } }).mode, 'star')
  assert.equal(classifySwingMode({ star_swing: false, offer: 'swing' }).mode, 'ordinary_unknown')
  assert.deepEqual(classifySwingMode({ offer: 'take', swing_mode: 'none', swing_frames: 9, swing_shown: true }), {
    mode: 'none', observed: true, source: 'swing_mode',
  })
})

test('pitch input separates measured changeups while keeping charge state unknown', () => {
  assert.equal(classifyPitchInput({ pitch_type: 'changeup' }).type, 'changeup')
  assert.equal(classifyPitchInput({ is_star_pitch: true }).type, 'star')
  assert.deepEqual(classifyPitchInput({ fielding_star_meter_spent: 50 }), {
    type: 'star', observed: true, source: 'fielding_star_meter_spent',
  })
  assert.deepEqual(classifyPitchInput({ pitch_type: 'fastball' }), {
    type: 'normal_or_charged_unknown', observed: false, source: 'input_type_missing',
  })
})

test('star-meter spends identify star inputs without treating a zero meter delta as use', () => {
  assert.equal(classifySwingMode({ batting_star_meter_spent: 50 }).mode, 'star')
  assert.equal(classifySwingMode({ batting_star_meter_spent: 0 }).mode, 'none')
  assert.equal(classifyPitchInput({ fielding_star_meter_spent: 0 }).observed, false)
})

test('agency map assigns automatic runner decisions and user sprint execution', () => {
  assert.ok(USER_AGENCY.baserunning.automatic.includes('advance_or_hold'))
  assert.ok(USER_AGENCY.baserunning.userControlled.includes('shake_sprint'))
  assert.ok(USER_AGENCY.fielding.automatic.includes('fielder_selection'))
})

test('run decomposition conserves value and does not credit automatic baserunning decisions', () => {
  const row = decomposeRunValue({
    leagueExpectedRuns: 0,
    gameExpectedRuns: 0.05,
    characterExpectedRuns: 0.12,
    decisionExpectedRuns: 0.20,
    executionExpectedRuns: 0.27,
    actualRuns: 0.31,
    decisionIsUserControlled: false,
    executionIsUserControlled: true,
  })
  assert.equal(row.userDecisionRuns, 0)
  assert.ok(Math.abs(row.automaticDecisionRuns - 0.08) < 1e-12)
  assert.ok(Math.abs(row.userExecutionRuns - 0.07) < 1e-12)
  assert.ok(Math.abs(row.reconciledRuns - row.observedRunsAboveAverage) < 1e-12)
})

test('fielding uses MLB position-specific run conversion and user-action gates', () => {
  assert.equal(fieldingRunValue(2, 'CF'), 1.8)
  assert.equal(fieldingRunValue(2, 'SS'), 1.5)
  assert.deepEqual(classifyFieldingAction({ approach: 'ordinary' }), { action: 'ordinary', userControlled: false })
  assert.ok(Math.abs(scoreFieldingAction({
    position: 'RF', expectedOutProbabilityWithoutAction: 0.2, expectedOutProbabilityWithAction: 0.7, action: { leap: true },
  }).runs - 0.45) < 1e-12)
  assert.equal(scoreFieldingAction({
    position: 'SS', expectedOutProbabilityWithoutAction: 0.4, expectedOutProbabilityWithAction: 0.8, action: { approach: 'ordinary' },
  }).runs, 0)
})

test('sprint execution reports whether the input itself was observed', () => {
  assert.deepEqual(scoreSprintExecution({ expectedRunsAtObservedEffort: 0.2, expectedRunsAtNeutralEffort: 0.1 }), {
    runs: 0.1, confidence: 'inferred_from_speed', inputObserved: false,
  })
  assert.deepEqual(scoreSprintExecution({ expectedRunsAtObservedEffort: 0.1, expectedRunsAtNeutralEffort: 0.3, inputObserved: true, direction: 'defense' }), {
    runs: 0.19999999999999998, confidence: 'observed_input', inputObserved: true,
  })
})

test('user value aggregation keeps decision and execution visible', () => {
  assert.deepEqual(aggregateUserValue([
    { userDecisionRuns: 0.2, userExecutionRuns: -0.1, observedRunsAboveAverage: 0.4, residualRuns: 0.1 },
    { userDecisionRuns: -0.05, userExecutionRuns: 0.3, observedRunsAboveAverage: 0.2, residualRuns: -0.1 },
  ]), {
    version: 'sluggers-uva-v1', opportunities: 2,
    userDecisionRuns: 0.15000000000000002, userExecutionRuns: 0.19999999999999998, userRuns: 0.35,
    observedRunsAboveAverage: 0.6000000000000001, residualRuns: 0,
  })
})

test('Stats-page UVA rows expose inputs without turning missing models into zero runs', () => {
  const rows = buildUserValueStats({
    identity: 'player',
    plateAppearances: [{ id: 10, game_id: 1, player_id: 'batter', character_id: 3, pitcher_player_id: 'pitcher', pitcher_id: 4, result: 'SH', star_hit_used: true }],
    pitches: [
      { pa_id: 10, game_id: 1, result: 'in_play', is_star_swing: true, pitch_type: 'changeup', bat_user_decision_runs: 0.2 },
      { pa_id: 10, game_id: 1, result: 'ball', is_star_pitch: true, pitch_user_execution_runs: 0.1 },
    ],
    movementMetrics: [{ player_id: 'batter', actor_type: 'runner', sprint_speed_fps: 30, path_distance_m: 20 }],
    runnerOpportunities: [{ runner_player_id: 'batter', runner_run_value: 0.3 }],
    fieldingOpportunities: [{ fielder_player_id: 'pitcher', is_primary: true, position: 'CF', outs_above_average: 0.5 }],
    trackingPlays: [{ id: 8, quality: { play_mechanics: [{ id: 'attack', type: 'buddy_attack', actor: { playerId: 'pitcher' }, contact: true, cleared_object: true }] } }],
  })
  const batter = rows.find((row) => row.id === 'batter')
  const pitcher = rows.find((row) => row.id === 'pitcher')
  assert.equal(batter.batting.userRuns, 0.2)
  assert.equal(batter.batting.swingRate, 0.5)
  assert.equal(batter.batting.contactRate, 1)
  assert.equal(batter.batting.starSwings, 1)
  assert.equal(batter.batting.bunts, 1)
  assert.equal(batter.baserunning.userRuns, null)
  assert.equal(batter.baserunning.automaticRuns, 0.3)
  assert.equal(batter.baserunning.sprintSpeedFps, 30)
  assert.equal(pitcher.pitching.starPitches, 1)
  assert.equal(pitcher.pitching.changeups, 1)
  assert.equal(pitcher.pitching.userRuns, 0.1)
  assert.equal(pitcher.fielding.rangeRuns, 0.45)
  assert.equal(pitcher.fielding.userRuns, null)
  assert.equal(pitcher.fielding.buddyAttacks, 1)
  assert.equal(pitcher.fielding.buddyObjectClears, 1)
})

test('Stats-page UVA joins use game plus PA id so season and tournament ids cannot collide', () => {
  const rows = buildUserValueStats({
    plateAppearances: [
      { id: 1, game_id: 7, player_id: 'tournament', pitcher_player_id: 'p1' },
      { id: 1, game_id: 'season-7', player_id: 'season', pitcher_player_id: 'p2' },
    ],
    pitches: [
      { pa_id: 1, game_id: 7, result: 'ball' },
      { pa_id: 1, game_id: 'season-7', result: 'in_play' },
    ],
  })
  assert.equal(rows.find((row) => row.id === 'tournament').batting.takes, 1)
  assert.equal(rows.find((row) => row.id === 'season').batting.swings, 1)
})

test('Stats-page chase rate uses outside-zone opportunities and excludes shadow pitches', () => {
  const [row] = buildUserValueStats({
    plateAppearances: [{ id: 1, game_id: 8, player_id: 'batter', pitcher_player_id: 'pitcher' }],
    pitches: [
      { pa_id: 1, game_id: 8, result: 'swinging_miss', swing_offer: 'swing', pitch_zone: 'out', is_chase: true },
      { pa_id: 1, game_id: 8, result: 'ball', swing_offer: 'take', pitch_zone: 'out', is_chase: false },
      { pa_id: 1, game_id: 8, result: 'in_play', swing_offer: 'swing', pitch_zone: 'in', is_chase: false },
      { pa_id: 1, game_id: 8, result: 'foul', swing_offer: 'swing', pitch_zone: 'shadow', is_chase: null },
    ],
  })
  assert.equal(row.batting.chases, 1)
  assert.equal(row.batting.outsideZonePitches, 2)
  assert.equal(row.batting.chaseRate, 0.5)
  assert.equal(row.batting.zoneSwingRate, 1)
  assert.equal(row.batting.shadowPitches, 1)
  assert.equal(row.batting.zoneCoverage, 0.75)
})
