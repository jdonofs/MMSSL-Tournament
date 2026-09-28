import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGimmickEvents,
  buildStadiumRunsInput,
  formatGimmickLuckScore,
  priceStadiumRuns,
  summarizeGimmickLuck,
} from '../src/utils/gimmickLuck.js'
import { buildStadiumIncidents } from '../src/utils/stadiumIncidents.js'
import { runExpectancyValue } from '../src/utils/advancedDefense.js'

const pa = {
  result: '1B',
  player_id: 'offense-owner',
  character_id: 10,
  pitcher_player_id: 'defense-owner',
  pitcher_id: 20,
}

function resolveFielder({ position, characterId }) {
  return { position, playerId: 'defense-owner', characterId }
}

test('a confirmed fielder-hindering gimmick favors offense even when it is not the primary fielder', () => {
  const events = buildGimmickEvents({
    primary_fielder: 'CF',
    first_touch: { by: 'CF', character_id: 30 },
    table_stuns: [{ by: 'SS', character_id: 31, frame: 123, t: 2.1 }],
  }, { plateAppearance: pa, resolveFielder })

  assert.deepEqual(events, [{
    schema_version: 1,
    type: 'table_stun',
    label: 'Table stun',
    category: 'fielder_hindered',
    beneficiary_side: 'offense',
    beneficiary_player_id: 'offense-owner',
    beneficiary_character_id: 10,
    unlucky_player_id: 'defense-owner',
    unlucky_character_id: 31,
    affected_position: 'SS',
    affected_character_id: 31,
    points: 1,
    evidence: { frame: 123, t: 2.1 },
  }])
})

test('a ball redirect credits the side that won the play', () => {
  const out = buildGimmickEvents({
    primary_fielder: 'RF',
    first_touch: { by: 'RF', character_id: 33 },
    arrow_redirects: [{ frame: 88, t: 1.5 }],
  }, { plateAppearance: { ...pa, result: 'FO' }, resolveFielder })

  assert.equal(out[0].beneficiary_side, 'defense')
  assert.equal(out[0].beneficiary_player_id, 'defense-owner')
  assert.equal(out[0].beneficiary_character_id, 33)
  assert.equal(out[0].unlucky_player_id, 'offense-owner')
  assert.equal(out[0].unlucky_character_id, 10)
})

test('generic effects and deliberate object-clearing abilities do not become gimmick luck', () => {
  const events = buildGimmickEvents({
    freezes: [{ by: '2B', character_id: 4, frame: 1 }],
    impact_stuns: [{ by: 'CF', character_id: 5, frame: 2 }],
    knockdowns: [{ by: 'LF', character_id: 6, frame: 3 }],
    freezie_breaks: [{ frame: 4, cause: { type: 'fielder_buddy_attack' } }],
    table_breaks: [
      { frame: 5, cause: { type: 'star_swing' } },
      { frame: 6, cause: { type: 'thrown_ball' } },
    ],
  }, { plateAppearance: pa, resolveFielder })

  assert.deepEqual(events, [])
})

test('named stadium knockdowns and confirmed barrel hits are normalized and deduplicated', () => {
  const events = buildGimmickEvents({
    knockdowns: [{ by: 'LF', character_id: 8, frame: 22, hazard: 'bob_omb_bomb' }],
    barrel_events: [{ approaches: [
      { by: 'CF', character_id: 9, hit: true, closest_frame: 40, hit_source: 'knockdown_flag' },
      { by: 'RF', character_id: 11, hit: false, closest_frame: 41 },
    ] }],
  }, { plateAppearance: pa, resolveFielder })

  assert.deepEqual(events.map((event) => event.type), ['bob_omb_bomb_knockdown', 'barrel_knockdown'])
  assert.deepEqual(events.map((event) => event.affected_character_id), [8, 9])
})

test('owner and character summaries are zero-sum and count distinct affected plays', () => {
  const plays = [
    { id: 1, quality: { gimmick_events: [
      { label: 'Arrow redirect', beneficiary_player_id: 'a', unlucky_player_id: 'b', beneficiary_character_id: 1, unlucky_character_id: 2, points: 1 },
      { label: 'Table stun', beneficiary_player_id: 'a', unlucky_player_id: 'b', beneficiary_character_id: 1, unlucky_character_id: 3, points: 1 },
    ] } },
    { id: 2, quality: { gimmick_events: [
      { label: 'Pipe transit', beneficiary_player_id: 'b', unlucky_player_id: 'a', beneficiary_character_id: 2, unlucky_character_id: 1, points: 1 },
    ] } },
  ]

  const owners = summarizeGimmickLuck(plays, 'player')
  assert.deepEqual(owners.a, {
    luckScore: 1, luckyEvents: 2, unluckyEvents: 1,
    totalEvents: 3, affectedPlays: 2,
    gimmickTypes: ['Arrow redirect', 'Pipe transit', 'Table stun'],
    luckRuns: 0, pricedPlays: 0,
  })
  assert.equal(owners.b.luckScore, -1)
  assert.equal(Object.values(owners).reduce((sum, row) => sum + row.luckScore, 0), 0)

  const characters = summarizeGimmickLuck(plays, 'character')
  assert.equal(characters['1'].luckScore, 1)
  assert.equal(characters['3'].unluckyEvents, 1)
  assert.equal(formatGimmickLuckScore(characters['1'].luckScore), '+1')
})

test('the deriver spelling of a manhole knockdown reaches luck', () => {
  // THE PRODUCER'S OWN SHAPE. name_manhole_knockdowns writes
  // `hazard: 'manhole_water'`; this whitelist said 'manhole', and a whitelist
  // miss returns nothing rather than an error -- so all 19 manhole knockdowns
  // in the archive were discarded between the deriver and the site.
  const events = buildGimmickEvents({
    knockdowns: [{
      by: 'RF', character_id: 42, frame: 32090, t: 1.5,
      hazard: 'manhole_water', manhole_distance_units: 3.41,
    }],
  }, { plateAppearance: pa, resolveFielder })

  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'manhole_water_knockdown')
  assert.equal(events[0].category, 'fielder_hindered')
  assert.equal(events[0].affected_position, 'RF')
})

test('a quarantined session contributes no official luck', () => {
  // Movement, arm and catch-probability summaries all reject a session the
  // ingester flagged; luck was the one that did not, so a capture already known
  // to be untrustworthy still reached the leaderboard.
  const events = [{
    label: 'Arrow redirect', beneficiary_player_id: 'a', unlucky_player_id: 'b',
    beneficiary_character_id: 1, unlucky_character_id: 2, points: 1,
  }]
  assert.deepEqual(summarizeGimmickLuck([
    { id: 1, quality: { quarantined_session: true, gimmick_events: events } },
  ], 'player'), {})
  // ...and an ordinary session still counts, so the guard is not just off.
  assert.equal(summarizeGimmickLuck([
    { id: 2, quality: { gimmick_events: events } },
  ], 'player').a.luckyEvents, 1)
})

// ── stadium runs ────────────────────────────────────────────────────────────

// Game 2767's first table ball: Mii's two-out line drive to centre, off a
// Daisy Cruiser table edge before anybody touched it, for a single.
const tablePlay = {
  outs: 2,
  caught_in_flight: false,
  home_run: false,
  primary_fielder: 'CF',
  first_touch: { by: 'CF', frame: 6363 },
  table_ball_contacts: [{ frame: 6280, t: 2.05, location_source: 'measured_ball_contact' }],
  preoutcome_flight: {
    valid: true,
    features: { projected_endpoint_x_units: -14.2, projected_endpoint_z_units: -86.2, projected_landing_seconds: 1.89 },
  },
  fielders: {
    LF: { pitch_release_start: [-34, 0, -60], character_id: 1 },
    CF: { pitch_release_start: [0, 0, -76], character_id: 2 },
    RF: { pitch_release_start: [34, 0, -60], character_id: 3 },
  },
}

const singlePa = {
  id: 5, result: '1B', outs_on_play: 0,
  player_id: 'offense-owner', character_id: 10, pitcher_player_id: 'defense-owner',
  runner_assignments: [{ id: 'batter', origin: 'plate', runner: { characterId: 10 }, isBatter: true, destination: 'first' }],
}

// A fixed table so the arithmetic below is checkable by hand.
const expectancy = new Map([['0:0', 0.9], ['1:0', 0.5], ['2:0', 0.2], ['2:1', 0.4], ['1:1', 0.7], ['3:0', 0]])
const catchChance = { LF: 0.1, CF: 0.73, RF: 0.02 }
const scoreCatch = ({ position }) => ({ probability: catchChance[position], model_version: 'test', model_status: 'rejected' })

function stadiumInput(play = tablePlay) {
  const incidents = buildStadiumIncidents(play, { resolveFielder })
  return buildStadiumRunsInput(play, { incidents, plateAppearance: singlePa, park: 'daisy_cruiser', resolveFielder })
}

test('a table that turned a likely catch into a single charges the park p x (single - catch)', () => {
  const priced = priceStadiumRuns(stadiumInput(), singlePa, expectancy, { scoreCatch })
  const single = runExpectancyValue(expectancy, 2, 1) - runExpectancyValue(expectancy, 2, 0)
  const caught = 0 - runExpectancyValue(expectancy, 2, 0)
  assert.equal(priced.price.fielder_position, 'CF')
  assert.equal(priced.price.model_status, 'rejected')
  assert.ok(Math.abs(priced.price.runs - 0.73 * (single - caught)) < 1e-9)
  assert.ok(priced.price.runs > 0)
})

test('a park that handed the defense a catch prices the lost hit as a forced single', () => {
  const play = { ...tablePlay, caught_in_flight: true }
  const outPa = { ...singlePa, result: 'LO', outs_on_play: 1,
    runner_assignments: [{ ...singlePa.runner_assignments[0], destination: 'out' }] }
  const priced = priceStadiumRuns(stadiumInput(play), outPa, expectancy, { scoreCatch })
  const caught = 0 - runExpectancyValue(expectancy, 2, 0)
  const single = runExpectancyValue(expectancy, 2, 1) - runExpectancyValue(expectancy, 2, 0)
  assert.ok(Math.abs(priced.price.runs - (1 - 0.73) * (caught - single)) < 1e-9)
  assert.ok(priced.price.runs < 0)
})

test('the park gets nothing for a play it never touched, a star swing, or a hit after the catch', () => {
  assert.equal(stadiumInput({ ...tablePlay, table_ball_contacts: [] }), null)
  assert.equal(stadiumInput({ ...tablePlay, table_ball_contacts: [{ frame: 6400 }] }), null)
  const starOnly = { ...tablePlay, table_ball_contacts: [],
    star_swing_effects: [{ by: 'CF', frame: 6200, effect: 'fire' }] }
  assert.equal(stadiumInput(starOnly), null)
})

test('balls the catch model has never seen stay unpriced with a reason', () => {
  const reason = (play) => priceStadiumRuns(stadiumInput(play), singlePa, expectancy, { scoreCatch }).price
  assert.deepEqual([reason({ ...tablePlay, home_run: true }).reason, reason({ ...tablePlay, home_run: true }).runs], ['home_run', null])
  const grounder = { ...tablePlay, preoutcome_flight: { valid: true,
    features: { projected_endpoint_x_units: 2, projected_endpoint_z_units: -20, projected_landing_seconds: 0.4 } } }
  assert.equal(reason(grounder).reason, 'outside_catch_model_range')
  assert.equal(reason({ ...tablePlay, preoutcome_flight: { valid: false } }).reason, 'no_preoutcome_flight')
  assert.equal(priceStadiumRuns(stadiumInput(), null, expectancy, { scoreCatch }).price.reason, 'no_plate_appearance')
})

test('a stun on a fielder the ball was not going to is not the park deciding the play', () => {
  const play = { ...tablePlay, table_ball_contacts: [],
    table_stuns: [{ by: 'LF', frame: 6200, character_id: 1 }] }
  assert.equal(priceStadiumRuns(stadiumInput(play), singlePa, expectancy, { scoreCatch }).price.reason, 'park_missed_the_catcher')
  const onCatcher = { ...play, table_stuns: [{ by: 'CF', frame: 6200, character_id: 2 }] }
  assert.ok(priceStadiumRuns(stadiumInput(onCatcher), singlePa, expectancy, { scoreCatch }).price.runs > 0)
})

test('stadium runs are zero-sum between the batter and the fielder the park took the ball from', () => {
  const priced = priceStadiumRuns(stadiumInput(), singlePa, expectancy, { scoreCatch })
  const summary = summarizeGimmickLuck([{ id: 1, quality: { gimmick_events: [], stadium_runs: priced } }], 'character')
  assert.ok(Math.abs(summary['10'].luckRuns - priced.price.runs) < 1e-9)
  assert.ok(Math.abs(summary['2'].luckRuns + priced.price.runs) < 1e-9)
  assert.equal(summary['2'].pricedPlays, 1)
})
