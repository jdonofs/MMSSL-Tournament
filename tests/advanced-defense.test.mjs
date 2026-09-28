import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateArmStrength,
  buildDoublePlayOpportunityFromPa,
  buildRunExpectancy,
  extraBaseContext,
  extraBaseFeatures,
  scoreExtraBaseDecision,
  buildExtraBaseOpportunitiesFromPa,
  isEligibleDoublePlayPa,
  modelDoublePlayOpportunities,
  modelFieldingOpportunities,
  modelRunnerOpportunities,
  runExpectancyValue,
  summarizeAdvancedFielding,
  summarizeAdvancedBaserunning,
  summarizeMovementMetrics,
} from '../src/utils/advancedDefense.js'
import { stadiumDecidedFielding } from '../src/utils/stadiumIncidents.js'
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
  // The batter-runner always has his own decision on a single; this is about
  // the runner who was on first.
  const lead = (rows) => rows.filter((row) => row.runner_id === 'first')
  assert.deepEqual(lead(buildExtraBaseOpportunitiesFromPa(pa)), [])
  pa.runner_assignments[1].attemptedBase = 'third'
  assert.equal(lead(buildExtraBaseOpportunitiesFromPa(pa))[0].outcome, 'advance_out')
  pa.runner_assignments[1].attemptedBase = 'second'
  assert.deepEqual(lead(buildExtraBaseOpportunitiesFromPa(pa)), [])
})

test('unmodeled baserunning counts have no invented zero run value', () => {
  const summary = summarizeAdvancedBaserunning(buildExtraBaseOpportunitiesFromPa(runningPa()))['1']
  assert.equal(summary.advances, 1)
  assert.equal(summary.modeledOpportunities, 0)
  assert.equal(summary.baserunningRunValue, null)
})

test('baserunning type splits reconcile with the same opportunity totals', () => {
  const rows = [
    { runner_character_id: 1, runner_player_id: 'owner', opportunity_type: 'first_to_third_on_single', outcome: 'hold', attempted: false },
    { runner_character_id: 1, runner_player_id: 'owner', opportunity_type: 'first_to_third_on_single', outcome: 'advance_safe', attempted: true, runner_run_value: 0.12 },
    { runner_character_id: 1, runner_player_id: 'owner', opportunity_type: 'tag_third_to_home', outcome: 'advance_out', attempted: true },
  ]
  for (const [identity, id] of [['character', '1'], ['player', 'owner']]) {
    const summary = summarizeAdvancedBaserunning(rows, identity)[id]
    assert.deepEqual(summary.byType.first_to_third_on_single, { opportunities: 2, holds: 1, attempts: 1, advances: 1, outs: 0 })
    assert.deepEqual(summary.byType.tag_third_to_home, { opportunities: 1, holds: 0, attempts: 1, advances: 0, outs: 1 })
    assert.equal(summary.attemptRate, 2 / 3)
    assert.equal(summary.successRate, 1 / 2)
    assert.equal(summary.modeledOpportunities, 1)
  }
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
  const leadRow = (rows) => rows.find((row) => row.runner_id === 'first')
  const seasonRow = { ...leadRow(buildExtraBaseOpportunitiesFromPa(runningPa(), { competitionType: 'season' })), id: 99 }
  const db = memoryOpportunityDb([seasonRow])
  const options = { pa: runningPa(), competitionType: 'tournament', outsBefore: 0 }
  await syncRunnerOpportunities(db, options)
  // The batter-runner's own stretch decision and the runner on first's, plus
  // the untouched season row.
  assert.equal(db.rows.length, 3)
  assert.deepEqual(db.rows.filter((r) => r.competition_type === 'tournament').map((r) => r.runner_id).sort(), ['batter', 'first'])
  const row = leadRow(db.rows.filter((r) => r.competition_type === 'tournament'))
  row.runner_run_value = 0.2
  row.model_version = 'fitted-test'
  const second = await syncRunnerOpportunities(db, options)
  assert.equal(second.updated, 0)
  assert.equal(row.runner_run_value, 0.2)
  await syncRunnerOpportunities(db, { ...options, pa: runningPa('second') })
  assert.equal(leadRow(db.rows.filter((r) => r.competition_type === 'tournament')).outcome, 'hold')
  assert.equal(leadRow(db.rows.filter((r) => r.competition_type === 'tournament')).runner_run_value, null)
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

// One half-inning scored the way older rows were: no outs_on_play, and the
// batter who later scored flagged run_scored on his own PA.
const legacyHalfInning = (gameId) => [
  { game_id: gameId, inning: 1, player_id: 'a', pa_number: 1, result: '1B', rbi: 0, run_scored: true },
  { game_id: gameId, inning: 1, player_id: 'a', pa_number: 2, result: 'GO', rbi: 0, runner_on_first_before: true },
  { game_id: gameId, inning: 1, player_id: 'a', pa_number: 3, result: '1B', rbi: 1, runner_on_second_before: true },
  { game_id: gameId, inning: 1, player_id: 'a', pa_number: 4, result: 'FO', rbi: 0, runner_on_first_before: true },
  { game_id: gameId, inning: 1, player_id: 'a', pa_number: 5, result: 'K', rbi: 0, runner_on_first_before: true },
]

test('run expectancy infers outs from the result and counts a run once, on the play it scored', () => {
  const pas = Array.from({ length: 60 }, (_, index) => legacyHalfInning(index)).flat()
  const expectancy = buildRunExpectancy(pas)
  // Every half-inning here scores exactly one run from the leadoff state (the
  // prior pulls it a little below); a run_scored flag on the leadoff PA would
  // have made it two.
  const leadoff = runExpectancyValue(expectancy, 0, 0)
  assert.ok(leadoff > 0.8 && leadoff < 1.2, `leadoff state ${leadoff}`)
  // The groundout is the second PA; with outs read as zero it would sit in 0:1.
  assert.ok(runExpectancyValue(expectancy, 1, 1) > runExpectancyValue(expectancy, 2, 1))
  assert.ok(runExpectancyValue(expectancy, 1, 2) > 0.9)
})

test('a sparse base/out state is shrunk toward the league-scaled prior, not read raw', () => {
  const pas = Array.from({ length: 60 }, (_, index) => legacyHalfInning(index)).flat()
  // Four corners-with-one-out samples that happened not to score.
  for (let index = 0; index < 4; index += 1) {
    pas.push(
      { game_id: 1000 + index, inning: 1, player_id: 'a', pa_number: 1, result: 'GO', rbi: 0, runner_on_first_before: true, runner_on_third_before: true },
      { game_id: 1000 + index, inning: 1, player_id: 'a', pa_number: 2, result: 'GO', rbi: 0, runner_on_first_before: true, runner_on_third_before: true, outs_on_play: 2 },
    )
  }
  const expectancy = buildRunExpectancy(pas)
  assert.ok(runExpectancyValue(expectancy, 1, 5) > runExpectancyValue(expectancy, 1, 1))
  assert.ok(runExpectancyValue(expectancy, 0, 7) > runExpectancyValue(expectancy, 0, 0))
})

// A single to left with a runner on first, as the deriver writes it.
const singlePlay = {
  bases: { first: [19.5, -19.4], second: [0, -38.3], third: [-18.3, -19.65], home: [0.8, -1.3] },
  first_touch: { by: 'LF', character: 'Funky Kong', frame: 2153, at: [-30, 0, -60] },
  runners: {
    BAT: { character: 'Daisy', at_first_possession: [15, 0, -15] },
    R1: { character: 'Tiny Kong', at_first_possession: [4, 0, -34] },
    R2: { character: 'Mario', batting_index: -1 },
  },
}

test('extra-base features measure the runner and the ball against the target base at first possession', () => {
  const context = extraBaseContext(singlePlay)
  // BAT is present so the batter-runner's own decision can be scored.
  assert.deepEqual(context.runners.map((row) => row.slot), ['BAT', 'R1'])
  assert.equal(context.touch.character, 'Funky Kong')
  const row = { origin_base: 'first', target_base: 'third', opportunity_type: 'first_to_third_on_single', outs_before: 1 }
  const features = extraBaseFeatures(row, context, { runnerSpeed: 6, fielderArm: 7 })
  assert.ok(Math.abs(features.runner_to_target_units - Math.hypot(4 + 18.3, -34 + 19.65)) < 1e-9)
  assert.ok(Math.abs(features.ball_to_target_units - Math.hypot(-30 + 18.3, -60 + 19.65)) < 1e-9)
  assert.equal(extraBaseFeatures(row, context, { runnerSpeed: null, fielderArm: 7 }), null)
  assert.equal(extraBaseFeatures({ ...row, origin_base: 'second' }, context, { runnerSpeed: 6, fielderArm: 7 }), null)
  assert.equal(extraBaseContext({ ...singlePlay, first_touch: null }), null)
})

const decisionModel = {
  model_version: 'runner-decision-test',
  status: 'active',
  standardization: Object.fromEntries(['runner_to_target_units', 'ball_to_target_units', 'runner_speed', 'fielder_arm']
    .map((name) => [name, { mean: 0, scale: 1 }])),
  opportunity_types: ['first_to_third_on_single'],
  // Closer runner, farther ball -> more sends.
  coefficients: [2, -0.2, 0.05, 0, 0, 0, 0],
}

test('the fitted decision model scores sends only while active and only for types it was fitted on', () => {
  const row = { opportunity_type: 'first_to_third_on_single', outs_before: 0 }
  const near = scoreExtraBaseDecision(decisionModel, row, { runner_to_target_units: 5, ball_to_target_units: 40, runner_speed: 6, fielder_arm: 7 })
  const far = scoreExtraBaseDecision(decisionModel, row, { runner_to_target_units: 25, ball_to_target_units: 10, runner_speed: 6, fielder_arm: 7 })
  assert.ok(near > far)
  assert.equal(scoreExtraBaseDecision({ ...decisionModel, status: 'rejected' }, row, { runner_to_target_units: 5, ball_to_target_units: 40, runner_speed: 6, fielder_arm: 7 }), null)
  assert.equal(scoreExtraBaseDecision(decisionModel, { ...row, opportunity_type: 'tag_third_to_home' }, { runner_to_target_units: 5, ball_to_target_units: 40, runner_speed: 6, fielder_arm: 7 }), null)
})

test('runner opportunities use the decision model where the capture can feed it, and WAR reuses the stored value', () => {
  const rows = [
    { id: 1, opportunity_type: 'first_to_third_on_single', outcome: 'hold', attempted: false, outs_before: 0,
      origin_base: 'first', target_base: 'third', base_state_before: 1, responsible_fielder_character_id: 5 },
    { id: 2, opportunity_type: 'first_to_third_on_single', outcome: 'advance_safe', attempted: true, safe: true, outs_before: 0,
      origin_base: 'first', target_base: 'third', base_state_before: 1, responsible_fielder_character_id: 5 },
  ]
  const features = { runner_to_target_units: 5, ball_to_target_units: 40, runner_speed: 6, fielder_arm: 7 }
  const modelled = modelRunnerOpportunities(rows, new Map(), { decisionModel, featuresFor: (row) => (row.id === 1 ? features : null) })
  assert.ok(Math.abs(modelled[0].expected_attempt_probability - scoreExtraBaseDecision(decisionModel, rows[0], features)) < 1e-12)
  assert.match(modelled[0].model_version, /\+decision:runner-decision-test$/)
  assert.doesNotMatch(modelled[1].model_version, /decision/)
  const reused = modelRunnerOpportunities(modelled, new Map(), { useStoredDecision: true })
  assert.equal(reused[0].expected_attempt_probability, modelled[0].expected_attempt_probability)
  // Without the flag a stale stored value never leaks back in.
  const refit = modelRunnerOpportunities(modelled, new Map())
  assert.notEqual(refit[0].expected_attempt_probability, modelled[0].expected_attempt_probability)
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

test('a ground ball is not a catch opportunity and leaves OAA unmodelled rather than failed', () => {
  const fly = (id, actualOut) => (
    { id, position: 'CF', is_primary: true, actual_out: actualOut, distance_needed_m: 20, opportunity_seconds: 2.1 }
  )
  const modeled = modelFieldingOpportunities([
    // Six catchable fly balls, four of them caught, so the position has a rate
    // to shrink toward.
    fly(1, true), fly(2, true), fly(3, true), fly(4, true), fly(5, false), fly(6, false),
    // Fielded off the ground and thrown out at first: an out the fielder made,
    // which `actual_out` (caught in flight) cannot express. Before the gate it
    // entered the same model as a failure and was debited for it.
    { id: 7, position: '2B', is_primary: true, actual_out: false, distance_needed_m: 18, opportunity_seconds: 0.45 },
    { id: 8, position: 'SS', is_primary: true, actual_out: false, distance_needed_m: 23, opportunity_seconds: 0.37 },
  ])
  const byId = Object.fromEntries(modeled.map((row) => [row.id, row]))
  assert.equal(byId[7].outs_above_average, undefined)
  assert.equal(byId[7].expected_out_probability, undefined)
  assert.equal(byId[8].outs_above_average, undefined)
  // The airborne chances are still modelled against each other.
  assert.ok(byId[1].outs_above_average > 0)
  assert.ok(byId[5].outs_above_average < 0)
  const scored = modeled.filter((row) => row.outs_above_average != null)
  assert.equal(scored.length, 6)
})

test('the airborne gate is a threshold on hang time, not on the outcome', () => {
  const at = (seconds, actualOut) => modelFieldingOpportunities([
    { id: 1, position: 'LF', is_primary: true, actual_out: actualOut, distance_needed_m: 12, opportunity_seconds: seconds },
  ])[0]
  assert.equal(at(0.99, false).outs_above_average, undefined)
  assert.ok(at(1.0, false).outs_above_average != null)
  // A catch is self-evidently a catch opportunity however short the flight.
  assert.ok(at(0.4, true).outs_above_average != null)
})

const singleWithRunnerOnFirst = (batterDestination, leadDestination = 'first') => ({
  id: 11, game_id: 3, result: '1B', outs_on_play: 0, runner_on_first_before: true,
  runner_assignments: [
    { id: 'batter', origin: 'plate', runner: runner(9), isBatter: true, destination: batterDestination },
    { id: 'first', origin: 'first', runner: runner(1), destination: leadDestination },
  ],
})

test('the batter-runner gets his own extra-base opportunity on a hit', () => {
  const held = buildExtraBaseOpportunitiesFromPa(singleWithRunnerOnFirst('first'))
    .find((row) => row.runner_id === 'batter')
  assert.equal(held.origin_base, 'plate')
  assert.equal(held.target_base, 'second')
  assert.equal(held.opportunity_type, 'batter_to_second_on_single')
  assert.equal(held.outcome, 'hold')
  assert.equal(held.runner_character_id, 9)
  // Stretching it is an advance; the lead runner taking second does not block
  // the batter, because he cannot end up there too.
  const stretched = buildExtraBaseOpportunitiesFromPa(singleWithRunnerOnFirst('second', 'third'))
    .find((row) => row.runner_id === 'batter')
  assert.equal(stretched.outcome, 'advance_safe')
  // A double measures the next base instead.
  const onDouble = buildExtraBaseOpportunitiesFromPa({ ...singleWithRunnerOnFirst('second', 'home'), result: '2B' })
    .find((row) => row.runner_id === 'batter')
  assert.equal(onDouble.target_base, 'third')
  assert.equal(onDouble.outcome, 'hold')
})

test('a batter thrown out stretching is a failed advance; one retired short of his hit is not', () => {
  const out = singleWithRunnerOnFirst('out')
  out.outs_on_play = 1
  const batterRow = (pa) => buildExtraBaseOpportunitiesFromPa(pa).find((row) => row.runner_id === 'batter')
  assert.equal(batterRow(out), undefined)
  out.runner_assignments[0].attemptedBase = 'second'
  assert.equal(batterRow(out).outcome, 'advance_out')
  // A base the batter never reached at all is not a stretch that failed.
  const short = singleWithRunnerOnFirst('plate')
  assert.equal(batterRow(short), undefined)
  // Nor is reaching on an error a discretionary hit.
  assert.deepEqual(buildExtraBaseOpportunitiesFromPa({ ...singleWithRunnerOnFirst('first'), result: 'ROE', is_error: true }), [])
})

test('the batter-runner is priced from the base his hit guaranteed him, not from the empty state', () => {
  const expectancy = buildRunExpectancy(Array.from({ length: 60 }, (_, index) => legacyHalfInning(index)).flat())
  const [row] = modelRunnerOpportunities(
    [{
      runner_id: 'batter', runner_character_id: 9, origin_base: 'plate', target_base: 'second',
      opportunity_type: 'batter_to_second_on_single', outcome: 'hold', is_discretionary: true,
      attempted: false, outs_before: 1, base_state_before: 0,
      responsible_fielder_character_id: 8,
    }],
    expectancy,
  )
  // Holding is worth nothing, taking second is worth the gap between a runner
  // on first and a runner on second, and being thrown out costs more than that
  // -- none of which includes the value of the hit itself.
  const first = runExpectancyValue(expectancy, 1, 1)
  const second = runExpectancyValue(expectancy, 1, 2)
  const outState = runExpectancyValue(expectancy, 2, 0)
  assert.ok(Math.abs(row.runner_run_value + row.arm_run_value) < 1e-12)
  assert.ok(second > first)
  const expectedValue = row.expected_attempt_probability
    * (row.expected_success_probability * (second - first) + (1 - row.expected_success_probability) * (outState - first))
  assert.ok(Math.abs(row.runner_run_value - (0 - expectedValue)) < 1e-9)
})

test('the stadium decides a play for every fielder when it moves the ball, for one fielder when it hits him', () => {
  const tableHit = [{ family: 'ball_interaction', type: 'table_rebound', victim: null }]
  assert.equal(stadiumDecidedFielding(tableHit, 'CF'), true)
  assert.equal(stadiumDecidedFielding(tableHit, 'LF'), true)
  const stun = [{ family: 'actor_effect', type: 'table_stun', victim: { position: 'CF' } }]
  assert.equal(stadiumDecidedFielding(stun, 'CF'), true)
  assert.equal(stadiumDecidedFielding(stun, 'LF'), false)
  const broken = [{ family: 'object_change', type: 'table_break', initiator: { position: 'SS' } }]
  assert.equal(stadiumDecidedFielding(broken, 'SS'), false)
  assert.equal(stadiumDecidedFielding(null, 'CF'), false)
})

test('a hazard that floors a fielder after he has the ball did not decide the catch', () => {
  const knockdown = [{ family: 'actor_effect', type: 'knockdown_unknown_cause', frame: 34923, victim: { position: 'CF' } }]
  assert.equal(stadiumDecidedFielding(knockdown, 'CF', { firstTouchFrame: 34922 }), false)
  const earlyKnockdown = [{ family: 'actor_effect', type: 'star_swing_knockdown', frame: 33935, victim: { position: 'LF' } }]
  assert.equal(stadiumDecidedFielding(earlyKnockdown, 'LF', { firstTouchFrame: 34108 }), true)
})

test('a stadium-affected opportunity is neither modelled nor counted in OAA', () => {
  const rows = [
    { id: 1, fielder_character_id: 5, position: 'CF', is_primary: true, actual_out: true, distance_needed_m: 20, opportunity_seconds: 2 },
    { id: 2, fielder_character_id: 5, position: 'CF', is_primary: true, actual_out: false, distance_needed_m: 20, opportunity_seconds: 2 },
    // The line drive that hit a table and fell in: not the fielder's miss.
    { id: 3, fielder_character_id: 5, position: 'CF', is_primary: true, actual_out: false, distance_needed_m: 20, opportunity_seconds: 2, quality: { stadium_affected: true } },
  ]
  const modeled = modelFieldingOpportunities(rows)
  assert.equal(modeled[2].outs_above_average, undefined)
  // A row stored with an OAA from before it was excluded still stays out.
  const summary = summarizeAdvancedFielding({
    fieldingOpportunities: [...modeled.slice(0, 2), { ...rows[2], outs_above_average: -0.9, expected_out_probability: 0.9 }],
  }, 'character')
  assert.equal(summary['5'].fieldingOpportunities, 2)
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

test('a ball knocked loose from a fielder is not an arm-strength throw', () => {
  const strength = aggregateArmStrength([
    { thrower_character_id: 7, thrower_position: 'LF', peak_speed_mph: 20, is_throw: false },
    { thrower_character_id: 7, thrower_position: 'LF', peak_speed_mph: 91, is_throw: true },
  ])
  assert.equal(strength.throws, 1)
  assert.equal(strength.hardestThrowMph, 91)
  assert.equal(strength.armStrengthMph, 91)
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

test('both double-play participants receive a DP without duplicating modeled value', () => {
  const summary = summarizeAdvancedFielding({
    doublePlayOpportunities: [{
      first_fielder_character_id: 71,
      pivot_fielder_character_id: 72,
      credit_status: 'team',
      double_play_completed: true,
      double_plays_added: 0.5,
      run_value: 0.15,
    }],
  }, 'character')
  assert.deepEqual(
    { opportunities: summary['71'].doublePlayOpportunities, doublePlays: summary['71'].doublePlays },
    { opportunities: 1, doublePlays: 1 },
  )
  assert.deepEqual(
    { opportunities: summary['72'].doublePlayOpportunities, doublePlays: summary['72'].doublePlays },
    { opportunities: 1, doublePlays: 1 },
  )
  assert.equal(summary['71'].doublePlayRuns, null)
  assert.equal(summary['72'].doublePlayRuns, null)
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
