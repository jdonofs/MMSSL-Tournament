// Which tracking facts are counted, and what happens when that cannot be known.
//
// src/utils/activeTrackingVersions.js decides which tracking plays belong to a
// version nothing on the site reads. It used to answer every failure the same
// way -- an empty exclusion set -- on the reasoning that dropping data because
// a query failed is the worse error. Two consequences were reproduced:
//
//   * A statement timeout on `tracking_sessions` excluded nothing, so a
//     superseded version and the active one were counted TOGETHER. The same
//     play entered a character's fielding line twice.
//   * PostgREST caps a response at 1000 rows without saying so, and neither
//     read was paginated. Past a thousand plays in superseded versions the
//     1001st was counted as an official fact.
//
// So the tests here are about the three answers it can now give -- known,
// legacy-schema, and UNKNOWN -- and about what each of its consumers does with
// them. The consumers are the point: a filter that reports uncertainty to
// nobody is the same defect one step further back.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchSupersededTrackingPlayIds,
  isLegacyTrackingSchema,
  onlyActiveTrackingFacts,
  supersededTrackingPlayIds,
} from '../src/utils/activeTrackingVersions.js'
import { recomputeAdvancedMetrics } from '../scripts/recompute_advanced_metrics.mjs'
import { createTrackerFakeSupabase } from './helpers/trackerFakeSupabase.mjs'

const PAGE = 1000

/**
 * A client that pages the way PostgREST does: `.range(from, to)` and never
 * more than 1000 rows, whatever was asked for.
 *
 * `failures` injects an error for a table, once or for every request, which is
 * how a statement timeout is modelled without a database that can be made slow.
 */
function pagingClient({ sessions = [], plays = [], failures = {}, onRequest = null } = {}) {
  const requests = []
  const build = (table, rows) => {
    const state = { filter: null, from: 0, to: PAGE - 1 }
    const query = {
      select() { return query },
      order() { return query },
      in(field, values) { state.filter = { field, values: values.map(String) }; return query },
      range(from, to) { state.from = from; state.to = to; return query },
      then(resolve, reject) {
        requests.push({ table, ...state })
        onRequest?.({ table, ...state })
        const failure = failures[table]
        if (failure && (failure.always || !failure.used)) {
          if (failure) failure.used = true
          return Promise.resolve({ data: null, error: failure.error }).then(resolve, reject)
        }
        const matched = state.filter
          ? rows.filter((row) => state.filter.values.includes(String(row[state.filter.field])))
          : rows
        const page = matched.slice(state.from, Math.min(state.to + 1, state.from + PAGE))
        return Promise.resolve({ data: page, error: null }).then(resolve, reject)
      },
    }
    return query
  }
  return {
    requests,
    from(table) {
      if (table === 'tracking_sessions') return build(table, sessions)
      if (table === 'tracking_plays') return build(table, plays)
      throw new Error(`unexpected table ${table}`)
    },
  }
}

test('a read that fails is reported as unknown, not as "nothing is superseded"', async () => {
  const client = pagingClient({
    sessions: [{ id: 1, is_active: true }, { id: 2, is_active: false }],
    failures: { tracking_sessions: { always: true, error: { code: '57014', message: 'canceling statement due to statement timeout' } } },
  })
  const result = await fetchSupersededTrackingPlayIds(client)
  assert.equal(result.data, null)
  assert.match(String(result.error?.message), /statement timeout/)
  assert.equal(result.legacy, null)
})

test('a timeout on the PLAYS read is unknown too, not a partial exclusion set', async () => {
  const client = pagingClient({
    sessions: [{ id: 2, is_active: false }],
    plays: [{ id: 10, tracking_session_id: 2 }],
    failures: { tracking_plays: { always: true, error: { code: '57014', message: 'statement timeout' } } },
  })
  const result = await fetchSupersededTrackingPlayIds(client)
  assert.equal(result.data, null)
  assert.ok(result.error)
})

test('a schema that cannot express versions is a real answer, not a failure', async () => {
  for (const error of [
    { code: '42703', message: 'column tracking_sessions.is_active does not exist' },
    { code: 'PGRST204', message: "Could not find the 'is_active' column" },
    { code: '42P01', message: 'relation "tracking_sessions" does not exist' },
  ]) {
    assert.equal(isLegacyTrackingSchema(error), true, error.code)
    const result = await fetchSupersededTrackingPlayIds(pagingClient({
      failures: { tracking_sessions: { always: true, error } },
    }))
    assert.equal(result.error, null)
    assert.equal(result.data.size, 0)
    assert.match(result.legacy, /version|exclude/)
  }
})

test('an operational failure is never read as a legacy schema', () => {
  for (const error of [
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: '08006', message: 'connection failure' },
    { code: 'PGRST301', message: 'JWT expired' },
    // The trap the narrow test exists for: a message that CONTAINS the legacy
    // shape but carries a code naming a different fault.
    { code: '57014', message: 'timeout while reading column is_active' },
  ]) {
    assert.equal(isLegacyTrackingSchema(error), false, error.code)
  }
})

test('every superseded play is excluded past the 1000-row cap', async () => {
  const plays = Array.from({ length: 1001 }, (_, index) => (
    { id: index + 1, tracking_session_id: 2 }))
  const client = pagingClient({
    sessions: [{ id: 1, is_active: true }, { id: 2, is_active: false }],
    plays,
  })
  const result = await fetchSupersededTrackingPlayIds(client)
  assert.equal(result.error, null)
  assert.equal(result.data.size, 1001, 'the 1001st inactive play is excluded like the rest')
  assert.ok(client.requests.filter((request) => request.table === 'tracking_plays').length >= 2,
    'which needs more than one request, because one request cannot return it')
  // And the facts hanging off them are all dropped, which is the thing the
  // exclusion set exists to do.
  const facts = plays.map((play) => ({ tracking_play_id: play.id, outs_above_average: 1 }))
  assert.equal(onlyActiveTrackingFacts(facts, result.data).length, 0)
})

test('more sessions than one filter can carry are read in batches', async () => {
  const sessions = Array.from({ length: 250 }, (_, index) => (
    { id: index + 1, is_active: index % 2 === 0 ? false : true }))
  const plays = sessions.filter((row) => row.is_active === false)
    .map((row, index) => ({ id: 5000 + index, tracking_session_id: row.id }))
  const client = pagingClient({ sessions, plays })
  const result = await fetchSupersededTrackingPlayIds(client)
  assert.equal(result.error, null)
  assert.equal(result.data.size, 125)
  const filters = client.requests.filter((request) => request.table === 'tracking_plays')
  assert.ok(filters.length >= 2, 'a 125-id filter is split rather than sent as one URL')
  assert.ok(filters.every((request) => (request.filter?.values.length ?? 0) <= 100))
})

test('the sessions read is paginated as well as the plays read', async () => {
  const sessions = Array.from({ length: 1500 }, (_, index) => (
    { id: index + 1, is_active: index !== 1400 }))
  const client = pagingClient({ sessions, plays: [{ id: 77, tracking_session_id: 1401 }] })
  const result = await fetchSupersededTrackingPlayIds(client)
  assert.equal(result.error, null)
  // The one inactive session is past the first page: an un-paginated read would
  // never have seen it, and would have reported an empty exclusion set.
  assert.deepEqual([...result.data], ['77'])
})

test('the exclusion set is a Set, and the result object is refused as one', () => {
  const rows = [{ tracking_play_id: 1 }, { tracking_play_id: 2 }]
  assert.equal(onlyActiveTrackingFacts(rows, new Set(['2'])).length, 1)
  assert.equal(onlyActiveTrackingFacts(rows, null).length, 2)
  // The mistake the type check exists for: an object is truthy, has no `.size`,
  // and would have filtered nothing while looking filtered.
  assert.throws(() => onlyActiveTrackingFacts(rows, { data: new Set(['2']), error: null }),
    /not the fetch result/)
})

test('supersededTrackingPlayIds names only the plays of an inactive version', () => {
  const excluded = supersededTrackingPlayIds(
    [{ id: 1, is_active: true }, { id: 2, is_active: false }],
    [{ id: 10, tracking_session_id: 1 }, { id: 11, tracking_session_id: 2 }],
  )
  assert.deepEqual([...excluded], ['11'])
})

// ── the consumers ─────────────────────────────────────────────────────────────
//
// recompute_advanced_metrics WRITES the models it builds. Everything else that
// reads these facts renders them. So the rule is the same for both and the
// consequence is not: one must not persist an aggregate it cannot vouch for,
// the other must not publish one.

function metricsWorld() {
  return createTrackerFakeSupabase({
    plate_appearances: [
      { id: 1, game_id: 12, inning: 1, result: '1B', outs_on_play: 0, competition_type: 'tournament' },
    ],
    season_plate_appearances: [],
    runner_opportunities: [],
    double_play_opportunities: [],
    fielding_opportunities: [
      { id: 1, tracking_play_id: 100, expected_out_probability: null, outs_above_average: null },
      { id: 2, tracking_play_id: 200, expected_out_probability: null, outs_above_average: null },
    ],
    tracking_sessions: [{ id: 1, is_active: true }, { id: 2, is_active: false }],
    tracking_plays: [
      { id: 100, tracking_session_id: 1 },
      { id: 200, tracking_session_id: 2 },
    ],
  })
}

test('recomputation refuses to persist models built from uncertain version membership', async () => {
  const client = metricsWorld()
  const before = client.db.fielding_opportunities.map((row) => ({ ...row }))
  const realFrom = client.from.bind(client)
  client.from = (table) => {
    if (table !== 'tracking_sessions') return realFrom(table)
    // A read that fails the way a busy database fails.
    return { select: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) }) }) }
  }
  // PostgREST hands back a plain `{ code, message }`, and this path rethrows it
  // as it arrived -- the same shape every other failed read in that function
  // throws. What matters here is that it stops.
  await assert.rejects(recomputeAdvancedMetrics(client),
    (error) => error?.code === '57014' && /statement timeout/.test(error.message))
  assert.deepEqual(client.db.fielding_opportunities, before,
    'the previously computed columns are left exactly as they were')
})

test('recomputation runs, and excludes the superseded version, when membership is known', async () => {
  const client = metricsWorld()
  const summary = await recomputeAdvancedMetrics(client)
  assert.ok(summary.fieldingOpportunities >= 0)
  const modeled = client.db.fielding_opportunities.find((row) => row.tracking_play_id === 100)
  const superseded = client.db.fielding_opportunities.find((row) => row.tracking_play_id === 200)
  assert.notEqual(modeled.model_version, undefined,
    'the active version is modelled')
  assert.equal(superseded.model_version ?? null, null,
    'the superseded version is not, and keeps whatever it had')
})
