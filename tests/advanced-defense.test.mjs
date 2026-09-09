import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateArmStrength,
  buildDoublePlayOpportunityFromPa,
  buildExtraBaseOpportunitiesFromPa,
  isEligibleDoublePlayPa,
  modelDoublePlayOpportunities,
  modelFieldingOpportunities,
  modelRunnerOpportunities,
  summarizeAdvancedFielding,
  summarizeAdvancedBaserunning,
  summarizeMovementMetrics,
} from '../src/utils/advancedDefense.js'
import { syncRunnerOpportunities } from '../src/utils/runnerOpportunityPersistence.js'

const runner = (characterId, playerId = `00000000-0000-0000-0000-00000000000${characterId}`) => ({ characterId, playerId })

const runningPa = (destination = 'third') => ({
  id: 7, game_id: 2, result: '1B', outs_on_play: 0, runner_on_first_before: true,
  runner_assignments: [
    { id: 'batter', origin: 'plate', runner: runner(9), isBatter: true, destination: 'first' },
    { id: 'first', origin: 'first', runner: runner(1), destination },
  ],
})

test('third-out catches and incomplete assignments do not invent baserunning opportunities', () => {
  assert.deepEqual(buildExtraBaseOpportunitiesFromPa({ ...runningPa('first'), result: 'FO', outs_on_play: 1 }, { outsBefore: 2 }), [])
  assert.deepEqual(buildExtraBaseOpportunitiesFromPa({ ...runningPa('first'), result: 'FO', outs_on_play: 2 }, { outsBefore: 0 }), [])
  assert.deepEqual(buildExtraBaseOpportunitiesFromPa({ ...runningPa(), runner_on_second_before: true }), [])
  assert.deepEqual(buildExtraBaseOpportunitiesFromPa({ ...runningPa('second'), outs_on_play: 1 }, { outsBefore: 2 }), [])
})

test('a retired runner needs an explicit extra-base target before charging a failed advance', () => {
  const pa = runningPa('out')
  pa.outs_on_play = 1
  assert.deepEqual(buildExtraBaseOpportunitiesFromPa(pa), [])
  pa.runner_assignments[1].attemptedBase = 'third'
  assert.equal(buildExtraBaseOpportunitiesFromPa(pa)[0].outcome, 'advance_out')
  pa.runner_assignments[1].attemptedBase = 'second'
  assert.deepEqual(buildExtraBaseOpportunitiesFromPa(pa), [])
})

test('unmodeled baserunning counts have no invented zero run value', () => {
  const summary = summarizeAdvancedBaserunning(buildExtraBaseOpportunitiesFromPa(runningPa()))['1']
  assert.equal(summary.advances, 1)
  assert.equal(summary.modeledOpportunities, 0)
  assert.equal(summary.baserunningRunValue, null)
})

function memoryOpportunityDb(initial = [], failUpsert = false) {
  let rows = structuredClone(initial)
  const operations = []
  return {
    operations, get rows() { return rows },
    from(table) {
      assert.equal(table, 'runner_opportunities')
      let operation = 'select', payload, filters = []
      const query = {
        select() { return query },
        eq(field, value) { filters.push((row) => row[field] === value); return query },
        in(field, values) { filters.push((row) => values.includes(row[field])); return query },
        upsert(value) { operation = 'upsert'; payload = value; return query },
        delete() { operation = 'delete'; return query },
        then(resolve, reject) {
          const run = () => {
            operations.push(operation)
            if (operation === 'upsert') {
              if (failUpsert) return { error: new Error('write failed') }
              for (const row of payload) {
                const index = rows.findIndex((old) => ['competition_type', 'game_id', 'pa_id', 'runner_id', 'target_base'].every((key) => old[key] === row[key]))
                if (index < 0) rows.push({ id: rows.length + 1, ...row })
                else rows[index] = { ...rows[index], ...row }
              }
            } else if (operation === 'delete') rows = rows.filter((row) => !filters.every((test) => test(row)))
            return { data: operation === 'select' ? rows.filter((row) => filters.every((test) => test(row))) : null, error: null }
          }
          return Promise.resolve().then(run).then(resolve, reject)
        },
      }
      return query
    },
  }
}

test('opportunity refresh is idempotent, updates advances to holds, and removes stale rows within source scope', async () => {
  const seasonRow = { ...buildExtraBaseOpportunitiesFromPa(runningPa(), { competitionType: 'season' })[0], id: 99 }
  const db = memoryOpportunityDb([seasonRow])
  const options = { pa: runningPa(), competitionType: 'tournament', outsBefore: 0 }
  await syncRunnerOpportunities(db, options)
  assert.equal(db.rows.length, 2)
  const row = db.rows.find((r) => r.competition_type === 'tournament')
  row.runner_run_value = 0.2
  row.model_version = 'fitted-test'
  const second = await syncRunnerOpportunities(db, options)
  assert.equal(second.updated, 0)
  assert.equal(row.runner_run_value, 0.2)
  await syncRunnerOpportunities(db, { ...options, pa: runningPa('second') })
  assert.equal(db.rows.find((r) => r.competition_type === 'tournament').outcome, 'hold')
  assert.equal(db.rows.find((r) => r.competition_type === 'tournament').runner_run_value, null)
  await syncRunnerOpportunities(db, { ...options, pa: { ...runningPa(), result: 'K' } })
  assert.deepEqual(db.rows, [seasonRow])
})

test('a failed opportunity write retains previously saved evidence for retry', async () => {
  const existing = { ...buildExtraBaseOpportunitiesFromPa(runningPa())[0], id: 1 }
  const db = memoryOpportunityDb([existing], true)
  await assert.rejects(syncRunnerOpportunities(db, { pa: runningPa('second'), competitionType: 'tournament', outsBefore: 0 }), /write failed/)
  assert.deepEqual(db.rows, [existing])
})

test('missing or invalid out context cannot erase saved runner opportunities', async () => {
  const existing = { ...buildExtraBaseOpportunitiesFromPa(runningPa())[0], id: 1 }
  const db = memoryOpportunityDb([existing])
  for (const outsBefore of [undefined, null, NaN, -1, 3, 0.5]) {
    await assert.rejects(syncRunnerOpportunities(db, { pa: runningPa(), competitionType: 'tournament', outsBefore }), /outs before/)
  }
  assert.deepEqual(db.rows, [existing])
  assert.deepEqual(db.operations, [])
})

test('double-play eligibility requires a force at first, fewer than two outs, and a ground ball', () => {
  const pa = { id: 7, game_id: 2, result: 'GO', trajectory: 'G', runner_on_first_before: true, outs_on_play: 1 }
  assert.equal(isEligibleDoublePlayPa(pa, 0), true)
  assert.equal(isEligibleDoublePlayPa(pa, 2), false)
  assert.equal(isEligibleDoublePlayPa({ ...pa, trajectory: 'F', result: 'FO' }, 0), false)
  assert.equal(isEligibleDoublePlayPa({ ...pa, runner_on_first_before: false }, 0), false)

  const row = buildDoublePlayOpportunityFromPa({ ...pa, result: 'DP', outs_on_play: 2 }, {
    outsBefore: 1,
    firstFielder: { characterId: 6, position: 6 },
    pivotFielder: { characterId: 4, position: 4 },
  })
  assert.equal(row.double_play_completed, true)
  assert.equal(row.first_fielder_character_id, 6)
  assert.equal(row.pivot_fielder_position, '4')
})

test('extra-base opportunities store no-throw holds as real outcomes', () => {
  const pa = {
    id: 8,
    game_id: 2,
    result: '1B',
    outs_on_play: 0,
    runner_on_first_before: true,
    runner_on_second_before: true,
    runner_assignments: [
      { id: 'batter', runner: runner(9), origin: 'plate', destination: 'first', isBatter: true },
      { id: 'first', runner: runner(1), origin: 'first', destination: 'second' },
      { id: 'second', runner: runner(2), origin: 'second', destination: 'home' },
    ],
  }
  const rows = buildExtraBaseOpportunitiesFromPa(pa, {
    responsibleFielder: { characterId: 7, position: 7 },
  })
  assert.deepEqual(rows.map((row) => [row.opportunity_type, row.outcome, row.attempted]), [
    ['first_to_third_on_single', 'hold', false],
    ['second_to_home_on_single', 'advance_safe', true],
  ])
  assert.equal(rows[0].responsible_fielder_character_id, 7)
})

test('runner and DP models emit finite, opposite runner/arm values', () => {
  const rows = [
    { id: 1, opportunity_type: 'first_to_third_on_single', origin_base: 'first', target_base: 'third', outcome: 'hold', attempted: false, safe: null, is_discretionary: true, outs_before: 0, base_state_before: 1, responsible_fielder_character_id: 7 },
    { id: 2, opportunity_type: 'first_to_third_on_single', origin_base: 'first', target_base: 'third', outcome: 'advance_safe', attempted: true, safe: true, is_discretionary: true, outs_before: 0, base_state_before: 1, responsible_fielder_character_id: 8 },
    { id: 3, opportunity_type: 'first_to_third_on_single', origin_base: 'first', target_base: 'third', outcome: 'advance_out', attempted: true, safe: false, is_discretionary: true, outs_before: 0, base_state_before: 1, responsible_fielder_character_id: 9 },
  ]
  const modeled = modelRunnerOpportunities(rows)
  modeled.forEach((row) => {
    assert.ok(Number.isFinite(row.expected_attempt_probability))
    assert.ok(Number.isFinite(row.expected_success_probability))
    assert.ok(Math.abs(row.runner_run_value + row.arm_run_value) < 1e-9)
  })

  const dp = modelDoublePlayOpportunities([
    { id: 1, trajectory: 'G', outs_before: 0, base_state_before: 1, structural_eligible: true, double_play_completed: true, context: {} },
    { id: 2, trajectory: 'G', outs_before: 0, base_state_before: 1, structural_eligible: true, double_play_completed: false, context: {} },
  ])
  assert.ok(dp[0].double_plays_added > 0)
  assert.ok(dp[1].double_plays_added < 0)
})

test('fielding opportunities produce catch probability, stars, and OAA', () => {
  const modeled = modelFieldingOpportunities([
    { id: 1, position: 'CF', is_primary: true, actual_out: true, distance_needed_m: 20, opportunity_seconds: 2 },
    { id: 2, position: 'CF', is_primary: true, actual_out: false, distance_needed_m: 20, opportunity_seconds: 2 },
  ])
  assert.ok(modeled.every((row) => row.expected_out_probability > 0 && row.expected_out_probability < 1))
  assert.ok(modeled[0].outs_above_average > 0)
  assert.ok(modeled[1].outs_above_average < 0)
  assert.ok(modeled.every((row) => row.star_difficulty >= 1 && row.star_difficulty <= 5))
})

test('fielding model excludes quarantined, incomplete, and manufactured tracking rows', () => {
  const modeled = modelFieldingOpportunities([
    { id: 1, position: 'CF', is_primary: true, actual_out: true, distance_needed_m: null, opportunity_seconds: null },
    { id: 2, position: 'CF', is_primary: true, actual_out: true, distance_needed_m: 10, opportunity_seconds: 2, quality: { quarantined_session: true } },
    // A teammate caught this only after another fielder booted it, so the
    // batted-ball geometry does not describe the catch that was made.
    { id: 3, position: 'CF', is_primary: true, actual_out: true, distance_needed_m: 6, opportunity_seconds: 4, quality: { exclude_from_oaa: true, after_deflection: true } },
  ])
  assert.equal(modeled[0].expected_out_probability, undefined)
  assert.equal(modeled[1].expected_out_probability, undefined)
  assert.equal(modeled[2].expected_out_probability, undefined)
})

test('a Buddy Throw is counted apart from Arm Strength, not as the hardest arm', () => {
  const throws = [
    { thrower_character_id: 7, thrower_position: 'LF', peak_speed_mph: 100 },
    { thrower_character_id: 7, thrower_position: 'LF', peak_speed_mph: 110 },
    { thrower_character_id: 7, thrower_position: 'LF', peak_speed_mph: 208, is_buddy_throw: true },
  ]
  const strength = aggregateArmStrength(throws)
  assert.equal(strength.throws, 3)
  assert.equal(strength.buddyThrows, 1)
  assert.equal(strength.hardestBuddyThrowMph, 208)
  // The 208 belongs to a chemistry pairing, and to a partner the capture cannot
  // even name, so it must not become this fielder's Max Throw or drag Arm
  // Strength up with it.
  assert.equal(strength.hardestThrowMph, 110)
  assert.equal(strength.armStrengthMph, 110)
})

test('a fielder seen only in a Buddy Throw has no Arm Strength rather than a borrowed one', () => {
  const strength = aggregateArmStrength([
    { thrower_character_id: 7, thrower_position: 'RF', peak_speed_mph: 182, is_buddy_throw: true },
  ])
  assert.equal(strength.throws, 1)
  assert.equal(strength.buddyThrows, 1)
  assert.equal(strength.armStrengthMph, null)
  assert.equal(strength.hardestThrowMph, null)
  assert.equal(strength.hardestBuddyThrowMph, 182)
})

test('Arm Strength uses the hardest position-aware subset and aggregates value components', () => {
  const throws = Array.from({ length: 20 }, (_, index) => ({
    thrower_character_id: 7,
    thrower_position: 'LF',
    peak_speed_mph: 60 + index,
  }))
  const strength = aggregateArmStrength(throws)
  assert.equal(strength.throws, 20)
  assert.equal(strength.hardestThrowMph, 79)
  assert.equal(strength.armStrengthMph, 78.5)

  const summary = summarizeAdvancedFielding({
    throws,
    runnerOpportunities: [{ responsible_fielder_character_id: 7, outcome: 'hold', arm_run_value: 0.2 }],
    doublePlayOpportunities: [{ first_fielder_character_id: 7, credit_status: 'player', double_play_completed: true, double_plays_added: 0.5, run_value: 0.15 }],
    fieldingOpportunities: [{ fielder_character_id: 7, is_primary: true, actual_out: true, expected_out_probability: 0.7, outs_above_average: 0.3 }],
  })
  assert.equal(summary['7'].armHolds, 1)
  assert.equal(summary['7'].doublePlays, 1)
  assert.ok(Math.abs(summary['7'].fieldingRunValue - 0.59) < 1e-9)
})

test('positioning, directional OAA, Sprint Speed, Bolts, and splits aggregate from normalized rows', () => {
  const fielding = summarizeAdvancedFielding({
    fieldingOpportunities: [
      { fielder_character_id: 7, is_primary: true, position_depth_ft: 120, position_angle_deg: -8, direction: 'back_left', outs_above_average: 0.25 },
      { fielder_character_id: 7, is_primary: false, position_depth_ft: 124, position_angle_deg: -4, direction: 'stationary' },
    ],
  })['7']
  assert.equal(fielding.positioningSamples, 2)
  assert.equal(fielding.averagePositionDepthFeet, 122)
  assert.equal(fielding.directionalOpportunities.back_left, 1)
  assert.equal(fielding.directionalOaa.back_left, 0.25)

  const movement = summarizeMovementMetrics([
    { character_id: 7, actor_type: 'batter', sprint_speed_fps: 28, is_bolt: false, home_to_first_seconds: 3.7, ninety_foot_split_seconds: 4.0 },
    { character_id: 7, actor_type: 'runner', sprint_speed_fps: 31, is_bolt: true },
    { character_id: 7, actor_type: 'runner', sprint_speed_fps: 25, is_bolt: false },
  ])['7']
  assert.equal(movement.speedSamples, 3)
  assert.equal(movement.bolts, 1)
  assert.equal(movement.sprintSpeedFps, 29.5)
  assert.equal(movement.homeToFirstSeconds, 3.7)
  assert.equal(movement.ninetyFootSplitSeconds, 4)
})

test('a run too short to reach top speed does not count toward sprint speed', () => {
  // The per-play speed of a short run is a measure of the run, not the runner:
  // a shuffle off first reads a fraction of what the same character does going
  // first to third. Raising the qualifying distance to 15 units moved this
  // estimator from 0.69 to 0.72 against the game's own run_speed attribute.
  const rows = [
    { character_id: 9, actor_type: 'runner', sprint_speed_fps: 31, path_distance_m: 24 },
    { character_id: 9, actor_type: 'runner', sprint_speed_fps: 29, path_distance_m: 18 },
    { character_id: 9, actor_type: 'runner', sprint_speed_fps: 4, path_distance_m: 2 },
  ]
  const movement = summarizeMovementMetrics(rows)['9']
  assert.equal(movement.speedSamples, 2)
  assert.equal(movement.sprintSpeedFps, 30)
  // The short shuffle is gone entirely, not merely outweighed.
  assert.equal(movement.maxSprintSpeedFps, 31)

  // A row with no measured distance at all is still admitted -- that is the
  // older capture format, and refusing it would silently empty the metric.
  const unmeasured = summarizeMovementMetrics([
    { character_id: 9, actor_type: 'runner', sprint_speed_fps: 27 },
  ])['9']
  assert.equal(unmeasured.speedSamples, 1)
})
