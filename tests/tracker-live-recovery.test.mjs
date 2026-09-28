import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLiveTrackingPersistence } from '../scripts/tracker_live_tracking_persistence.mjs'
import { createTrackerFakeSupabase } from './helpers/trackerFakeSupabase.mjs'

function tables() {
  return {
    plate_appearances: [
      {
        id: 50, game_id: 12, pa_number: 1, inning: 1, result: '1B', trajectory: 'G',
        character_id: 31, player_id: 'batter-one', defensive_team_id: 'defense',
        runner_assignments: [], tracker_contact_seq: 1,
      },
      {
        id: 51, game_id: 12, pa_number: 2, inning: 1, result: '1B', trajectory: 'G',
        character_id: 31, player_id: 'batter-two', defensive_team_id: 'defense',
        runner_assignments: [], tracker_contact_seq: 2,
      },
    ],
    game_fielders: [
      { id: 1, game_id: 12, team_id: 'defense', character: 'Donkey Kong', position: 1, inning_from: 1 },
      { id: 2, game_id: 12, team_id: 'defense', character: 'Donkey Kong', position: 2, inning_from: 1 },
    ],
    characters: [{ id: 31, name: 'Donkey Kong' }],
    season_teams: [], tracking_sessions: [], tracking_plays: [],
    fielding_opportunities: [], movement_metrics: [], tracking_throws: [],
    tracking_catch_approaches: [], runner_opportunities: [], double_play_opportunities: [],
  }
}

function play(contactFrame, overrides = {}) {
  return {
    inning: 1, inning_half: 0, batter_id: 2,
    contact_timer: contactFrame, pitch_release_timer: contactFrame - 20,
    dead_ball_timer: contactFrame + 40,
    batted_ball_class: 'fair_in_play', fair_or_foul: 'fair',
    contact_at: [0, 0, -10],
    first_touch: { by: 'P', character_id: 2, frame: contactFrame + 20, at: [0, 1, -10] },
    primary_fielder: 'P', caught_in_flight: false, hang_time_s: 1.2,
    fielders: {
      P: {
        character_id: 2, pitch_release_start: [0, 0, -1], start: [0, 0, -1],
        end: [0, 0, -9], path_units: 8, distance_to_landing_units: 8, fielded: true,
      },
      C: {
        character_id: 2, pitch_release_start: [0, 0, 1], start: [0, 0, 1],
        end: [0, 0, 1], path_units: 0, distance_to_landing_units: 10, fielded: false,
      },
    },
    runners: {
      BAT: { character_id: 2, start: [0, 0, 0], end: [10, 0, 0], path_units: 10, five_foot_splits_s: {} },
    },
    throws: [{ sequence: 1, thrower_position: 'P', thrower_character_id: 2, receiver_position: 'C', receiver_character_id: 2 }],
    catch_approaches: [{
      by: 'P', character_id: 2, approach: 'ordinary', start_frame: contactFrame + 10,
      end_frame: contactFrame + 20, outcome: 'secured', secured: true,
    }],
    ...overrides,
  }
}

function fixture(t, plays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-live-recovery-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = path.join(dir, 'capture')
  fs.writeFileSync(`${stem}.json`, JSON.stringify({
    game_id: 12, competition_type: 'tournament', source_id: 3,
    park: 'mario-stadium', format: 'MSSTRK02', recorded_utc: '20260905T120000Z',
    frames: 600, missed_frames: 0,
  }))
  fs.writeFileSync(`${stem}.plays.jsonl`, plays.map(JSON.stringify).join('\n'))
  return stem
}

function client(options = {}) {
  const value = createTrackerFakeSupabase(tables(), options)
  value.unique.tracking_plays.push(['tracking_session_id', 'pa_id'])
  value.unique.tracking_catch_approaches = [['tracking_play_id', 'position', 'start_frame']]
  return value
}

function writer(supabase) {
  return createLiveTrackingPersistence({
    supabase, competitionType: 'tournament', gameId: 12, sourceId: 3,
  })
}

function input(supabase, stem, plays, { savedPas = new Set([1, 2]) } = {}) {
  return {
    stem, capture: { frames: 600, missed_frames: 0 }, plays,
    joinFor: (row) => ({ status: 'joined', pa_number: row.paNumber ?? 1 }),
    plateAppearanceFor: (number) => savedPas.has(number)
      ? supabase.db.plate_appearances.find((row) => row.pa_number === number)
      : null,
  }
}

function identities(supabase) {
  const take = (name, key) => supabase.db[name].map((row) => [key(row), row.id]).sort()
  return {
    sessions: take('tracking_sessions', (row) => row.raw_stem),
    plays: take('tracking_plays', (row) => row.contact_frame),
    fielding: take('fielding_opportunities', (row) => `${row.tracking_play_id}:${row.position}`),
    movement: take('movement_metrics', (row) => `${row.tracking_play_id}:${row.actor_type}:${row.actor_slot}`),
    throws: take('tracking_throws', (row) => `${row.tracking_play_id}:${row.throw_sequence}`),
    approaches: take('tracking_catch_approaches', (row) => `${row.tracking_play_id}:${row.position}:${row.start_frame}`),
  }
}

test('a completed live play is an identity-stable no-op after restart', async (t) => {
  const firstPlay = play(100)
  const stem = fixture(t, [firstPlay])
  const supabase = client()
  assert.equal((await writer(supabase).sync(input(supabase, stem, [firstPlay]))).written, 1)
  const before = identities(supabase)
  const operationStart = supabase.operations.length

  assert.equal((await writer(supabase.restart()).sync(input(supabase, stem, [firstPlay]))).written, 0)
  assert.deepEqual(identities(supabase), before)
  assert.equal(supabase.operations.slice(operationStart).filter((row) => row.action === 'insert').length, 0)
})

test('a parent left before its children stays retryable in-process and after restart', async (t) => {
  const firstPlay = play(100)
  const stem = fixture(t, [firstPlay])
  const supabase = client({ failures: [
    { table: 'fielding_opportunities', action: 'insert', mode: 'before', times: 6 },
  ] })
  const live = writer(supabase)

  await assert.rejects(live.sync(input(supabase, stem, [firstPlay])))
  await assert.rejects(live.sync(input(supabase, stem, [firstPlay])))
  assert.equal(supabase.db.tracking_plays.length, 1)
  assert.equal(supabase.db.fielding_opportunities.length, 0)
  assert.equal((await live.sync(input(supabase, stem, [firstPlay]))).written, 1)
  assert.equal(supabase.db.fielding_opportunities.length, 2)
  assert.equal(supabase.db.movement_metrics.length, 3)
  assert.equal(supabase.db.tracking_throws.length, 1)
  assert.equal(supabase.db.tracking_catch_approaches.length, 1)

  const before = identities(supabase)
  await writer(supabase.restart()).sync(input(supabase, stem, [firstPlay]))
  assert.deepEqual(identities(supabase), before)
})

test('restart fills a partial child set without replacing its parent or surviving children', async (t) => {
  const firstPlay = play(100)
  const stem = fixture(t, [firstPlay])
  const supabase = client()
  await writer(supabase).sync(input(supabase, stem, [firstPlay]))
  const parentId = supabase.db.tracking_plays[0].id
  const survivingFielding = supabase.db.fielding_opportunities.find((row) => row.position === 'P')
  const survivingMovement = supabase.db.movement_metrics.find((row) => row.actor_slot === 'P')
  supabase.db.fielding_opportunities = supabase.db.fielding_opportunities.filter((row) => row.position !== 'C')
  supabase.db.movement_metrics = supabase.db.movement_metrics.filter((row) => row.actor_slot !== 'C')
  supabase.db.tracking_throws.length = 0
  supabase.db.tracking_catch_approaches.length = 0

  await writer(supabase.restart()).sync(input(supabase, stem, [firstPlay]))
  assert.equal(supabase.db.tracking_plays.length, 1)
  assert.equal(supabase.db.tracking_plays[0].id, parentId)
  assert.equal(supabase.db.fielding_opportunities.find((row) => row.position === 'P').id, survivingFielding.id)
  assert.equal(supabase.db.movement_metrics.find((row) => row.actor_slot === 'P').id, survivingMovement.id)
  assert.equal(supabase.db.fielding_opportunities.length, 2)
  assert.equal(supabase.db.movement_metrics.length, 3)
  assert.equal(supabase.db.tracking_throws.length, 1)
  assert.equal(supabase.db.tracking_catch_approaches.length, 1)
})

test('lost responses and a failed completion read converge without duplicate rows', async (t) => {
  const firstPlay = play(100)
  const stem = fixture(t, [firstPlay])
  const base = client({ failures: [
    { table: 'tracking_plays', action: 'insert', mode: 'after' },
    { table: 'movement_metrics', action: 'insert', mode: 'after' },
  ] })
  let failCompletionRead = true
  const flaky = {
    ...base,
    from(table) {
      const query = base.from(table)
      const execute = query.execute.bind(query)
      query.execute = async () => {
        if (failCompletionRead && table === 'fielding_opportunities' && query.action === 'select'
            && base.db.movement_metrics.length === 3 && base.db.tracking_throws.length === 1) {
          failCompletionRead = false
          return { data: null, error: { message: 'read failed after child commits' } }
        }
        return execute()
      }
      return query
    },
  }
  const live = writer(flaky)
  await assert.rejects(live.sync(input(base, stem, [firstPlay])),
    (error) => error?.message === 'read failed after child commits')
  assert.deepEqual({
    parents: base.db.tracking_plays.length,
    fielding: base.db.fielding_opportunities.length,
    movement: base.db.movement_metrics.length,
    throws: base.db.tracking_throws.length,
  }, { parents: 1, fielding: 2, movement: 3, throws: 1 })

  assert.equal((await live.sync(input(base, stem, [firstPlay]))).written, 1)
  assert.deepEqual({
    parents: base.db.tracking_plays.length,
    fielding: base.db.fielding_opportunities.length,
    movement: base.db.movement_metrics.length,
    throws: base.db.tracking_throws.length,
  }, { parents: 1, fielding: 2, movement: 3, throws: 1 })
})

test('recovered history preserves scoring order and new fair and foul plays avoid ordinal collisions', async (t) => {
  const first = play(100, { paNumber: 1 })
  const delayedFair = play(200, { paNumber: 2 })
  const foul = play(300, {
    paNumber: 2, batted_ball_class: 'foul', fair_or_foul: 'foul', caught_in_flight: false,
  })
  const stem = fixture(t, [first, delayedFair, foul])
  const uninterrupted = client()
  const continuousWriter = writer(uninterrupted)
  await continuousWriter.sync(input(uninterrupted, stem, [first]))
  await continuousWriter.sync(input(uninterrupted, stem, [delayedFair]))
  const continuousSecond = uninterrupted.db.fielding_opportunities
    .filter((row) => row.tracking_play_id === uninterrupted.db.tracking_plays[1].id)
    .map((row) => ({ position: row.position, probability: row.expected_out_probability, oaa: row.outs_above_average }))

  const resumed = client()
  await writer(resumed).sync(input(resumed, stem, [first]))
  const restarted = writer(resumed.restart())
  assert.equal((await restarted.sync(input(resumed, stem, [first, delayedFair, foul], {
    savedPas: new Set([1]),
  }))).written, 1, 'the foul proceeds while the fair ball waits for PA 2')
  assert.deepEqual(resumed.db.tracking_plays.map((row) => [row.contact_frame, row.play_ordinal, row.pa_id]), [
    [100, 1, 50], [300, 2, null],
  ])

  assert.equal((await restarted.sync(input(resumed, stem, [first, delayedFair, foul]))).written, 1)
  assert.deepEqual(resumed.db.tracking_plays.map((row) => [row.contact_frame, row.play_ordinal, row.pa_id]), [
    [100, 1, 50], [300, 2, null], [200, 3, 51],
  ])
  const resumedFair = resumed.db.fielding_opportunities
    .filter((row) => row.tracking_play_id === resumed.db.tracking_plays[2].id)
    .map((row) => ({ position: row.position, probability: row.expected_out_probability, oaa: row.outs_above_average }))
  assert.deepEqual(resumedFair, continuousSecond, 'resumed catch scoring sees prior completed live history exactly once')
})
