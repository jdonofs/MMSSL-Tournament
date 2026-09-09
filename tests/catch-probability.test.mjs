import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ARTIFACT_SCHEMA_VERSION,
  OPPORTUNITY_DEFINITION_VERSION,
  PRE_OUTCOME_FEATURES,
  aggregateOpportunityOaa,
  buildGroupedSplit,
  buildOpportunity,
  fitEmpiricalBaseline,
  fitRegularizedLogistic,
  loadFrozenCatchModel,
  opportunityOaa,
  predictRows,
  scoreCatchProbability,
  validateArtifact,
} from '../scripts/catch_probability_model.mjs'

const session = (stem = 'mario_stadium-a') => ({
  stem,
  park: 'mario_stadium',
  join_status: 'validated_all_joined',
  related_capture_group: stem,
  quarantined: false,
  malformed: false,
})

const flight = (x = 5, z = -72, seconds = 2.5) => ({
  valid: true,
  information_boundary: 'contact through contact+11 frames only',
  features: {
    projected_endpoint_x_units: x,
    projected_endpoint_z_units: z,
    projected_landing_seconds: seconds,
  },
})

function caughtPlay(overrides = {}) {
  return {
    contact_timer: 100,
    inning: 1,
    inning_half: 0,
    batted_ball_class: 'fair_caught',
    caught_in_flight: true,
    primary_fielder: 'CF',
    primary_fielder_reason: 'catch',
    first_touch: { by: 'CF', at: [5, 0, -70], ball_height_units: 0 },
    hang_time_s: 2.2,
    fielding_events: [],
    catch_approaches: [{ by: 'CF', catch_type: 1, approach: 'ordinary' }],
    fielders: {
      CF: {
        character_id: 7,
        character: 'Mario',
        pitch_release_start: [0, 0, -76],
        assist_frames: 0,
        assist_units: 0,
      },
    },
    ...overrides,
  }
}

function failedPlay(overrides = {}) {
  return caughtPlay({
    contact_timer: 101,
    batted_ball_class: 'fair_in_play',
    caught_in_flight: false,
    primary_fielder_reason: 'fielded',
    landing: { frame: 220, at: [12, 0, -68] },
    first_touch: { by: 'CF', at: [13, 0, -67], ball_height_units: 0 },
    hang_time_s: 2,
    ...overrides,
  })
}

test('opportunity construction accepts only defensible joined outfield catches and failures', () => {
  const caught = buildOpportunity(caughtPlay(), session(), null, flight())
  const failed = buildOpportunity(failedPlay(), session(), null, flight())
  assert.equal(caught.eligible, true)
  assert.equal(caught.actual_catch, 1)
  assert.equal(failed.eligible, true)
  assert.equal(failed.actual_catch, 0)

  const grounder = buildOpportunity(failedPlay({ hang_time_s: 0.5 }), session(), null, flight())
  const infielder = buildOpportunity(caughtPlay({ primary_fielder: 'SS', first_touch: { by: 'SS', at: [1, 0, -35] } }), session(), null, flight())
  assert.equal(grounder.eligible, false)
  assert.ok(grounder.exclusion_reasons.includes('not_defensible_airborne_label'))
  assert.equal(infielder.eligible, false)
  assert.ok(infielder.exclusion_reasons.includes('not_primary_outfielder'))
})

test('model features are invariant to post-outcome catch/landing and route fields', () => {
  const first = buildOpportunity(caughtPlay(), session(), null, flight(8, -75, 3))
  const changedOutcomeGeometry = buildOpportunity(caughtPlay({
    first_touch: { by: 'CF', at: [-30, 22, -95], ball_height_units: 22 },
    hang_time_s: 7,
    fielders: { CF: { ...caughtPlay().fielders.CF, end: [-30, 0, -95], path_units: 99 } },
  }), session(), null, flight(8, -75, 3))
  assert.deepEqual(first.features, changedOutcomeGeometry.features)
  assert.deepEqual(first.leakage_audit.model_features, PRE_OUTCOME_FEATURES)
  assert.ok(first.leakage_audit.diagnostic_only_post_outcome_fields.includes('resolution_seconds'))
})

test('annotations, unjoined sessions, special mechanics, walls, and missing projections are rejected', () => {
  const annotated = buildOpportunity(caughtPlay(), session(), { categories: ['wrong_result'] }, flight())
  const unjoined = buildOpportunity(caughtPlay(), { ...session(), join_status: 'not_validated' }, null, flight())
  const special = buildOpportunity(caughtPlay({ buddy_handoffs: [{ by: 'CF' }] }), session(), null, flight())
  const wall = buildOpportunity(caughtPlay({ first_touch: { by: 'CF', at: [5, 0, -70], ball_height_units: 5 } }), session(), null, flight())
  const missing = buildOpportunity(caughtPlay(), session(), null, null)
  for (const row of [annotated, unjoined, special, wall, missing]) assert.equal(row.eligible, false)
  assert.ok(annotated.exclusion_reasons.includes('operator_annotation'))
  assert.ok(unjoined.exclusion_reasons.includes('session_not_join_validated'))
  assert.ok(special.exclusion_reasons.includes('special_or_redirected_mechanic'))
  assert.ok(wall.exclusion_reasons.includes('wall_play'))
  assert.ok(missing.exclusion_reasons.includes('missing_preoutcome_flight_projection'))
})

function trainingRow(index, actualCatch, stem = `session-${index % 6}`) {
  const row = buildOpportunity(
    actualCatch ? caughtPlay({ contact_timer: 1000 + index }) : failedPlay({ contact_timer: 1000 + index }),
    session(stem), null,
    flight(actualCatch ? 2 + index % 3 : 25 + index % 3, -72, actualCatch ? 3 : 1.8),
  )
  row.related_capture_group = stem
  return row
}

test('grouped partitions are deterministic and never split a capture session', () => {
  const rows = Array.from({ length: 60 }, (_, index) => trainingRow(index, index % 3 !== 0))
  const first = buildGroupedSplit(rows, 'fixed-seed')
  const second = buildGroupedSplit([...rows].reverse(), 'fixed-seed')
  assert.deepEqual(first.by_session, second.by_session)
  assert.deepEqual(first.partitions, second.partitions)
  for (const [sessionName, partition] of Object.entries(first.by_session)) {
    assert.ok(first.rows[partition].every((row) => row.session !== sessionName || first.by_session[row.session] === partition))
  }
  const sets = Object.values(first.partitions).map((value) => new Set(value.sessions))
  assert.equal([...sets[0]].some((value) => sets[1].has(value) || sets[2].has(value)), false)
})

test('empirical and regularized models emit bounded deterministic probabilities', () => {
  const rows = Array.from({ length: 80 }, (_, index) => trainingRow(index, index % 4 !== 0))
  for (const model of [fitEmpiricalBaseline(rows), fitRegularizedLogistic(rows, { iterations: 500 })]) {
    const first = predictRows(rows, model).map((row) => row.predicted_probability)
    const second = predictRows(rows, model).map((row) => row.predicted_probability)
    assert.deepEqual(first, second)
    assert.ok(first.every((value) => value > 0 && value < 1))
  }
})

test('artifact schema and activation status are enforced by loader and scorer', () => {
  const rows = Array.from({ length: 40 }, (_, index) => trainingRow(index, index % 3 !== 0))
  const active = { ...fitEmpiricalBaseline(rows), status: 'active' }
  assert.equal(validateArtifact(active).ok, true)
  const scored = scoreCatchProbability({
    park: 'mario_stadium', position: 'CF', start_x_units: 0, start_z_units: -76,
    projected_endpoint_x_units: 5, projected_endpoint_z_units: -72, projected_landing_seconds: 2.5,
  }, active)
  assert.ok(scored.probability > 0 && scored.probability < 1)
  assert.equal(scoreCatchProbability({ park: 'mario_stadium', position: 'CF' }, active).reason, 'missing_pitch_release_start')

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sluggers-catch-'))
  const file = path.join(directory, 'artifact.json')
  fs.writeFileSync(file, JSON.stringify(active))
  assert.equal(loadFrozenCatchModel(file).artifact.model_type, 'empirical_binned')
  fs.writeFileSync(file, JSON.stringify({ ...active, status: 'rejected' }))
  assert.equal(loadFrozenCatchModel(file).reason, 'artifact_not_active')
  assert.equal(validateArtifact({ ...active, artifact_schema_version: 'future' }).errors[0], 'unsupported_artifact_schema')
  assert.equal(active.artifact_schema_version, ARTIFACT_SCHEMA_VERSION)
  assert.equal(active.opportunity_definition_version, OPPORTUNITY_DEFINITION_VERSION)
})

test('OAA signs are actual minus expected and cannot double-count legacy range value', () => {
  assert.equal(opportunityOaa(true, 0.2).oaa, 0.8)
  assert.equal(opportunityOaa(false, 0.8).oaa, -0.8)
  assert.equal(opportunityOaa(null, 0.5).oaa, null)
  assert.deepEqual(aggregateOpportunityOaa([
    { outs_above_average: 0.4 }, { outs_above_average: -0.1 },
  ]), { oaa: 0.30000000000000004, reason: null })
  assert.equal(aggregateOpportunityOaa([
    { outs_above_average: 0.4, legacy_range_runs: 0.2 },
  ]).reason, 'legacy_range_and_oaa_double_count')
})
