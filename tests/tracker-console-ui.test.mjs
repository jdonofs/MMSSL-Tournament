import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'

import { createTrackerPreviewServer } from '../scripts/tracker_preview_server.mjs'
import { createTrackerPreviewProxyMiddleware } from '../scripts/tracker_preview_vite_proxy.mjs'
import { buildPreviewAdvancedMetrics } from '../scripts/tracker_preview_metrics.mjs'
import { buildTrackerAnnotation } from '../scripts/tracker_annotations.mjs'
import {
  applyTrackerPreviewMessage,
  applyTrackerPreviewPlay,
  applyTrackerPreviewPostgamePlay,
  createTrackerPreviewState,
  setTrackerPreviewGameContext,
  setTrackerPreviewCaptureHealth,
  setTrackerPreviewStadiumOverride,
  trackerPreviewSnapshot,
} from '../scripts/tracker_preview_state.mjs'
import {
  fieldingEvent,
  firstTouch,
  possessionEvent,
  throwRecord,
  trackingPlay,
} from './helpers/trackerFixtures.mjs'

// The contract between the console and the two services that feed it.
//
// The page is a polling client at 2 Hz, so the two things tested hardest here
// are what the snapshot MUST contain (or the page cannot render the
// interpretation) and what it must NOT contain (or the poll becomes the
// bottleneck). The heavy evidence has to be reachable, but only on request.

function feed(state, lines) {
  for (const line of lines) applyTrackerPreviewMessage(state, line)
}

function twoAtBatSession() {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  setTrackerPreviewCaptureHealth(state, {
    status: 'recording', collector_pid: 4242, stem: 'data/player_tracking/fixture',
    park: 'mario_stadium', frames: 12000, missed_frames: 1, frame_rate: 59.9,
    calibration_status: 'confirmed', calibration_lock_frames: 60, position_offset: 4,
    last_frame_at: new Date().toISOString(), mean_feed_ms: 0.03, max_play_build_ms: 70,
  })
  feed(state, [
    'Next: Top of inning 1',
    '[TRACKER_LINEUP] team=Away|batting=Luigi,Peach|fielding=P=Bowser,C=Toad,1B=Wario,2B=Daisy,3B=Waluigi,SS=Yoshi,LF=Mario,CF=Birdo,RF=Toadette',
    'Bowser vs. Luigi',
    '0 outs',
    'Count: 0-0',
    'Fair ball!',
    "Luigi's hit was caught!",
    'Birdo put Luigi out!',
    'Bowser vs. Peach',
    '1 outs',
    'Count: 0-0',
    'Fair ball!',
    'Peach recorded a single!',
  ])
  return state
}

const caughtPlay = trackingPlay({
  contact_timer: 10000, batter: 'Luigi', inning: 1, inning_half: 0, balls: 0, strikes: 0,
  batted_ball_class: 'fair_caught', caught_in_flight: true, hang_time_s: 3.1,
  first_touch: firstTouch({ by: 'CF', character: 'Birdo' }),
  fielding_events: [possessionEvent({ by: 'CF', character: 'Birdo' })],
  primary_fielder: 'CF', primary_fielder_reason: 'catch',
  fielders: {
    CF: { name: 'CF', character: 'Birdo', start: [0, 0, -70], end: [18, 0, -70], path_units: 19.2, displacement_units: 18.0, route_efficiency: 0.94, sprint_speed_ups: 8.1, fielded: true },
    RF: { name: 'RF', character: 'Toadette', start: [40, 0, -55], end: [40, 0, -55], path_units: 0.2, sprint_speed_ups: 0.3 },
  },
  runners: { BAT: { name: 'BAT', character: 'Luigi', start: [0, 0, 0], end: [10, 0, -10], bases_ran: 0, sprint_speed_ups: 8.4, five_foot_splits_s: { 5: 0.5, 10: 0.9 } } },
  throws: [throwRecord({ thrower_position: 'CF', thrower_character: 'Birdo' })],
})

const groundPlay = trackingPlay({
  contact_timer: 20000, batter: 'Peach', inning: 1, inning_half: 0, outs: 1, balls: 0, strikes: 0,
  batted_ball_class: 'fair_in_play',
  fielding_events: [fieldingEvent({ ball_contact: 'confirmed', by: 'SS', character: 'Yoshi', confidence: 'high', contact_source: 'last_contact_fielder' })],
  landing: { t: 1.2, frame: 20072, at: [-30, 0.4, -45] },
  primary_fielder: 'SS', primary_fielder_reason: 'failed_contact',
  home_to_first_s: 3.61, ninety_foot_split_s: 3.58,
})

test('the snapshot carries everything the console renders, for the selected at-bat', () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, caughtPlay)
  applyTrackerPreviewPlay(state, groundPlay)
  // Explicitly on the caught ball, which is the at-bat with a full 60 Hz record.
  const snapshot = trackerPreviewSnapshot(state, { selectedPaNumber: 1 })

  // 1. capture health
  assert.equal(snapshot.capture.status, 'recording')
  assert.equal(snapshot.capture.collector_pid, 4242)
  assert.equal(snapshot.capture.frames, 12000)
  assert.equal(snapshot.capture.missed_frames, 1)
  assert.equal(snapshot.capture.calibration_status, 'confirmed')
  assert.equal(snapshot.capture.play_count, 2)
  assert.ok(snapshot.capture.last_frame_age_ms >= 0)
  assert.deepEqual(snapshot.capture.join_tally, { joined: 2, pending: 0, ambiguous: 0, orphaned: 0, mismatch: 0 })

  // 2. the live game situation
  assert.equal(snapshot.situation.inning, 1)
  assert.equal(snapshot.situation.half, 'top')
  assert.equal(snapshot.situation.outs, 1)
  assert.ok(snapshot.situation.batter_name)
  assert.ok(snapshot.situation.pitcher_name)

  // 3. the interpretation
  assert.ok(snapshot.interpretation.summary)
  assert.ok(snapshot.interpretation.clauses.length >= 3)
  assert.ok(Array.isArray(snapshot.warnings))
  assert.ok(snapshot.checks)

  // 4. the four-category verdict on every at-bat, for the history strip
  assert.equal(snapshot.at_bats.length, 2)
  for (const entry of snapshot.at_bats) {
    assert.ok(entry.checks, `PA ${entry.pa_number} needs a verdict`)
    assert.equal(typeof entry.warning_count, 'number')
    assert.ok(entry.narrative_summary)
    assert.equal(entry.join_status, 'joined')
  }

  // 5. the play visualization's geometry
  assert.ok(snapshot.play_geometry)
  assert.ok(snapshot.play_geometry.fielders.length >= 2)
  assert.ok(snapshot.play_geometry.first_touch)
  assert.equal(snapshot.play_geometry.throws.length, 1)
  assert.equal(snapshot.advanced_metrics.status, 'ready')
  assert.equal(snapshot.advanced_metrics.contact_timer, 10000)
  assert.ok(snapshot.advanced_metrics.rows.some((row) => row.actor === 'Birdo (CF)'))
})

test('advanced metrics retain missing and zero measurements and use explicit speed units', () => {
  const metrics = buildPreviewAdvancedMetrics({
    join: { status: 'joined' },
    play: { ...caughtPlay,
      fielders: { CF: { character: 'Birdo', reaction_s: 0, jump_distance_feet: null } },
      runners: { BAT: { character: 'Luigi', sprint_speed_ups: 8, path_units: 20 } },
      throws: [{ peak_speed_mps: 40, buddy_throw: true }],
    },
  })
  const reaction = metrics.rows.find((row) => row.label === 'Reaction time')
  assert.equal(reaction.value, 0)
  assert.equal(reaction.status, 'derived')
  assert.equal(metrics.rows.find((row) => row.label === 'Jump distance').status, 'missing')
  const speed = metrics.rows.find((row) => row.label === 'Sprint speed')
  assert.ok(Math.abs(speed.value - 26.2467) < 0.001)
  assert.equal(speed.unit, 'ft/s')
  assert.equal(speed.status, 'derived')
  const arm = metrics.rows.find((row) => row.label === 'Peak throw speed')
  assert.ok(Math.abs(arm.value - 89.47745) < 0.001)
  assert.equal(arm.status, 'excluded')
})

test('advanced metrics do not display a knocked-loose ball as throw speed', () => {
  const metrics = buildPreviewAdvancedMetrics({
    join: { status: 'joined' },
    play: { ...caughtPlay, throws: [{ is_throw: false, peak_speed_mph: 20 }] },
  })
  assert.equal(metrics.rows.some((row) => row.label === 'Peak throw speed'), false)
})

test('unjoined plays cannot supply advanced measurements to an at-bat', () => {
  for (const status of ['pending', 'ambiguous', 'mismatch', 'orphaned']) {
    const metrics = buildPreviewAdvancedMetrics({ play: caughtPlay, join: { status } })
    assert.equal(metrics.status, 'unjoined')
    assert.deepEqual(metrics.rows, [])
  }
  assert.equal(buildPreviewAdvancedMetrics().status, 'pending')
})

test('short runs and incomplete plays expose exclusions instead of player ratings', () => {
  const metrics = buildPreviewAdvancedMetrics({ join: { status: 'joined' }, play: {
    ...caughtPlay, truncated: true, after_deflection: true,
    runners: { BAT: { sprint_speed_fps: 27, path_units: 4 } },
  } })
  assert.equal(metrics.rows.find((row) => row.label === 'Sprint speed').status, 'excluded')
  assert.equal(metrics.exclusions.length, 2)
  assert.ok(metrics.models.every((model) => model.status === 'Baseline required'))
})

test('metric annotations preserve the selected play measurements and definition version', () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, caughtPlay)
  applyTrackerPreviewPlay(state, groundPlay)
  const snapshot = trackerPreviewSnapshot(state, { selectedPaNumber: 1 })
  const { record, error } = buildTrackerAnnotation({ snapshot, categories: ['wrong_measurement'] })
  assert.equal(error, undefined)
  assert.deepEqual(record.advanced_metrics, snapshot.advanced_metrics)
  assert.equal(record.advanced_metrics.contact_timer, 10000)
  assert.equal(trackerPreviewSnapshot(state, { selectedPaNumber: 2 }).advanced_metrics.contact_timer, 20000)
})

test('a poll never carries raw frame history, however many plays there are', () => {
  const state = twoAtBatSession()
  // A play record with a big trail on it, of the kind the collector produces.
  applyTrackerPreviewPlay(state, {
    ...caughtPlay,
    runners: {
      BAT: {
        ...caughtPlay.runners.BAT,
        five_foot_splits_s: Object.fromEntries(
          Array.from({ length: 18 }, (_, index) => [(index + 1) * 5, index * 0.1]),
        ),
      },
    },
  })
  const snapshot = trackerPreviewSnapshot(state)
  const serialized = JSON.stringify(snapshot)

  // The compact play list is a summary, not a copy.
  const play = snapshot.player_tracking_plays[0]
  assert.equal(play.contact_timer, 10000)
  assert.equal(play.join_status, 'joined')
  // A clean join carries no prose; only a join that needs explaining does.
  assert.equal(play.join_reason, null)
  assert.ok(play.badges.includes('SECURED'))
  assert.equal(play.fielders, undefined, 'per-fielder tracks must not be in the poll')
  assert.equal(play.runners, undefined, 'runner splits must not be in the poll')
  assert.equal(play.fielding_events, undefined, 'raw events must not be in the poll')

  // Nothing anywhere in the snapshot carries a per-frame trail.
  assert.doesNotMatch(serialized, /five_foot_splits_s/)
  assert.ok(serialized.length < 200_000, `snapshot is ${serialized.length} bytes`)
})

test('the heavy evidence is reachable on demand, and only on demand', async () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, caughtPlay)
  applyTrackerPreviewPostgamePlay(state, { ...caughtPlay, derivation: 'postgame' })

  const server = createTrackerPreviewServer({ state, port: 0 })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const evidence = await (await fetch(`http://127.0.0.1:${port}/play?contact_timer=10000`)).json()
    assert.equal(evidence.play.contact_timer, 10000)
    assert.ok(evidence.play.fielders.CF, 'the full record has per-fielder tracks')
    assert.ok(evidence.play.runners.BAT.five_foot_splits_s, 'and runner splits')
    assert.equal(evidence.join.status, 'joined')
    assert.equal(evidence.postgame.derivation, 'postgame')
    assert.ok(evidence.geometry)

    const missing = await fetch(`http://127.0.0.1:${port}/play?contact_timer=999999`)
    assert.equal(missing.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('POST /stadium responds with state, and reports callback failures as JSON', async () => {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  let selected = null
  const server = createTrackerPreviewServer({
    state,
    port: 0,
    onStadiumChange: (stadiumKey) => { selected = stadiumKey },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/stadium`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stadium_key: 'daisy_cruiser' }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.equal(response.headers.get('x-tracker-database-writes'), 'disabled')
    assert.equal((await response.json()).stadium_key, 'daisy_cruiser')
    assert.equal(selected, 'daisy_cruiser')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const failing = createTrackerPreviewServer({
    state: createTrackerPreviewState({ mode: 'local_preview' }),
    port: 0,
    onStadiumChange: () => { throw new Error('collector launch failed') },
  })
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve))
  const failingPort = failing.address().port
  try {
    const response = await fetch(`http://127.0.0.1:${failingPort}/stadium`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stadium_key: 'mario_stadium' }),
    })
    assert.equal(response.status, 500)
    assert.match((await response.json()).error, /collector launch failed/)
  } finally {
    await new Promise((resolve) => failing.close(resolve))
  }
})

test('POST /shutdown acknowledges before asking the local session to stop', async () => {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  let resolveShutdown
  const stopped = new Promise((resolve) => { resolveShutdown = resolve })
  const server = createTrackerPreviewServer({
    state,
    port: 0,
    onShutdown: () => resolveShutdown(),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), {
      accepted: true,
      message: 'Saving and ending this tracker session',
    })
    await stopped
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('live tracker shutdown requires the selected game and an allowed site', async () => {
  const state = createTrackerPreviewState({ mode: 'live_bridge', writesEnabled: true })
  setTrackerPreviewGameContext(state, { game_id: 42, games_table: 'season_schedule' })
  let stops = 0
  const server = createTrackerPreviewServer({ state, port: 0, onShutdown: () => { stops += 1 } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/shutdown`
  const stop = (gameId, table, origin = 'https://msl-tournament.vercel.app') => fetch(url, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId, table }),
  })
  try {
    assert.equal((await stop(42, 'season_schedule', 'https://other.example')).status, 403)
    assert.equal((await stop(42, 'games')).status, 409)
    assert.equal((await stop(43, 'season_schedule')).status, 409)
    assert.equal(stops, 0)
    assert.equal((await stop(42, 'season_schedule')).status, 202)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(stops, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the browser proxy returns one useful 503 when the local API is offline', async () => {
  // Reserve a port and release it so the proxy has a deterministic refused
  // target without depending on whatever is running on the developer machine.
  const reservation = createHttpServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const offlinePort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))

  const middleware = createTrackerPreviewProxyMiddleware({ port: offlinePort })
  const proxy = createHttpServer((request, response) => {
    middleware(request, response, () => {
      response.writeHead(404).end()
    })
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = proxy.address().port
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/tracker-api/state`)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('x-tracker-database-writes'), 'disabled')
    const body = await response.json()
    assert.match(body.error, /local tracker API is offline/i)
    assert.equal(body.code, 'ECONNREFUSED')
  } finally {
    await new Promise((resolve) => proxy.close(resolve))
  }
})

test('the browser proxy forwards tracker state on the configured custom port', async () => {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  const backend = createTrackerPreviewServer({ state, port: 0 })
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const middleware = createTrackerPreviewProxyMiddleware({ port: backend.address().port })
  const proxy = createHttpServer((request, response) => middleware(request, response, () => {
    response.writeHead(404).end()
  }))
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/tracker-api/state`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).writes_enabled, false)
  } finally {
    await new Promise((resolve) => proxy.close(resolve))
    await new Promise((resolve) => backend.close(resolve))
  }
})

test('the tracker:preview entry path cannot import or launch Supabase', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.scripts['tracker:preview'], 'node scripts/tracker_preview.mjs')

  for (const relative of [
    '../scripts/tracker_preview.mjs',
    '../scripts/tracker_at_bat_preview.mjs',
    '../src/trackerPreviewMain.jsx',
  ]) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /live_tracker_bridge\.mjs|@supabase\/|supabaseClient|createClient\s*\(/)
  }
  assert.equal(createTrackerPreviewState({ mode: 'local_preview' }).writesEnabled, false)
})

test('the existing /state consumers keep working — nothing was removed', () => {
  const state = twoAtBatSession()
  const snapshot = trackerPreviewSnapshot(state)
  for (const field of [
    'mode', 'writes_enabled', 'game', 'connected', 'tracker_status', 'tracker_pid',
    'started_at', 'last_message_at', 'stadium_name', 'stadium_key',
    'stadium_detected_key', 'stadium_override_key', 'stadium_options', 'revision',
    'at_bats', 'at_bat_count', 'selected_pa_number', 'display_at_bat',
    'current_at_bat', 'last_completed_at_bat', 'session_pitch_diagnostics',
    'recent_tracker_messages',
  ]) {
    assert.ok(field in snapshot, `/state lost ${field}`)
  }
  // And each at-bat index entry keeps the fields the spray chart plots from.
  for (const entry of snapshot.at_bats) {
    for (const field of ['pa_number', 'batter_name', 'pitcher_name', 'result', 'hit_world_x', 'hit_world_y', 'hit_world_z']) {
      assert.ok(field in entry, `at-bat index lost ${field}`)
    }
  }
})

test('an ambiguous join withholds the fielding narrative and says why', () => {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  // The same batter twice in one half-inning, both at 0-0: nothing can tell the
  // two at-bats apart, so the play must not attach to either.
  feed(state, [
    'Next: Top of inning 1', 'Bowser vs. Luigi', '0 outs', 'Count: 0-0',
    'Fair ball!', 'Luigi recorded a single!',
    'Bowser vs. Luigi', '0 outs', 'Count: 0-0',
    'Fair ball!', 'Luigi recorded a single!',
  ])
  applyTrackerPreviewPlay(state, caughtPlay)
  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.capture.join_tally.ambiguous, 1)
  const sentences = snapshot.interpretation.sentences.join(' ')
  assert.doesNotMatch(sentences, /secured the ball/)
  assert.ok(snapshot.warnings.some((warning) => warning.id === 'join-ambiguous'))
})

test('an orphaned play is reported without being attached to anything', () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, trackingPlay({
    contact_timer: 55555, batter: 'Nobody At All', inning: 1, inning_half: 0,
  }))
  const snapshot = trackerPreviewSnapshot(state)
  const orphan = snapshot.player_tracking_plays.find((play) => play.contact_timer === 55555)
  assert.equal(orphan.join_status, 'orphaned')
  assert.equal(orphan.join_pa_number, null)
  assert.equal(snapshot.capture.join_tally.orphaned, 1)
})

test('a play that arrives before its at-bat becomes joined once the log catches up', () => {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  feed(state, ['Next: Top of inning 1', 'Bowser vs. Luigi', '0 outs', 'Count: 0-0'])
  // A play from an inning the log has not reached.
  applyTrackerPreviewPlay(state, trackingPlay({
    contact_timer: 77777, batter: 'Peach', inning: 3, inning_half: 1, balls: 0, strikes: 0,
  }))
  assert.equal(trackerPreviewSnapshot(state).capture.join_tally.pending, 1)

  feed(state, [
    'Next: Bottom of inning 3', 'Bowser vs. Peach', '0 outs', 'Count: 0-0',
    'Fair ball!', 'Peach recorded a single!',
  ])
  const after = trackerPreviewSnapshot(state)
  assert.equal(after.capture.join_tally.joined, 1)
  assert.equal(after.capture.join_tally.pending, 0)
})

test('the same play arriving twice replaces rather than duplicates', () => {
  const state = twoAtBatSession()
  // The state stores the object it is handed and Object.assigns the
  // replacement onto it, so this must be a copy -- passing the shared fixture
  // rewrote `caughtPlay.primary_fielder` for every test that ran afterwards.
  applyTrackerPreviewPlay(state, structuredClone(caughtPlay))
  applyTrackerPreviewPlay(state, { ...caughtPlay, primary_fielder: 'RF' })
  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.capture.play_count, 1)
  assert.equal(snapshot.player_tracking_plays[0].primary_fielder, 'RF')
})

test('paging back to an earlier at-bat brings its own interpretation and warnings', () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, caughtPlay)
  applyTrackerPreviewPlay(state, groundPlay)

  const first = trackerPreviewSnapshot(state, { selectedPaNumber: 1 })
  assert.equal(first.display_at_bat.pa_number, 1)
  assert.equal(first.display_at_bat.batter_name, 'Luigi')
  assert.match(first.interpretation.summary, /Luigi/)
  assert.equal(first.display_play.contact_timer, 10000)

  const second = trackerPreviewSnapshot(state, { selectedPaNumber: 2 })
  assert.equal(second.display_at_bat.batter_name, 'Peach')
  assert.match(second.interpretation.summary, /Peach/)
  assert.equal(second.display_play.contact_timer, 20000)
  assert.match(second.interpretation.sentences.join(' '), /Yoshi \(SS\) contacted the ball but failed to secure it/)
})

test('clearing a session drops its plays with its at-bats', async () => {
  const { clearTrackerPreviewAtBats } = await import('../scripts/tracker_preview_state.mjs')
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, caughtPlay)
  assert.equal(trackerPreviewSnapshot(state).capture.play_count, 1)
  clearTrackerPreviewAtBats(state)
  const snapshot = trackerPreviewSnapshot(state)
  assert.equal(snapshot.capture.play_count, 0)
  assert.equal(snapshot.at_bat_count, 0)
  assert.equal(snapshot.interpretation, null)
})

test('the play badges name the mechanics a diagram has to distinguish', () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, trackingPlay({
    contact_timer: 10000, batter: 'Luigi', inning: 1, inning_half: 0,
    batted_ball_class: 'fair_in_play',
    fielding_events: [
      fieldingEvent({ ball_contact: 'confirmed', action_code: 2, by: '2B' }),
      fieldingEvent({ ball_contact: 'missed', action_code: 3, by: 'SS', t: 1.4 }),
      fieldingEvent({ mechanic: 'egg', action_code: 5, ball_contact: 'confirmed', by: '1B', t: 1.6 }),
      fieldingEvent({ mechanic: 'buddy', action_code: 7, ball_contact: 'confirmed', by: 'LF', t: 1.8 }),
    ],
    deflections: [fieldingEvent({ ball_contact: 'confirmed', action_code: 2 })],
    forced_misplays: [fieldingEvent({ mechanic: 'egg', action_code: 5 })],
    buddy_handoffs: [fieldingEvent({ mechanic: 'buddy', action_code: 7 })],
    first_touch: firstTouch({ ball_height_units: 9.4 }),
    throws: [throwRecord({ buddy_throw: true, is_relay: true })],
  }))
  const badges = trackerPreviewSnapshot(state).player_tracking_plays[0].badges
  for (const expected of ['EGG', 'BUDDY HANDOFF', 'BUDDY THROW', 'RELAY', 'BOBBLE', 'CONTACT', 'MISS', 'SECURED', 'WALL']) {
    assert.ok(badges.includes(expected), `missing ${expected} in ${badges.join(',')}`)
  }
  // DIVE is never badged: no signal in the capture distinguishes one.
  assert.ok(!badges.includes('DIVE'))
})

// --- the console's own view logic -------------------------------------------
//
// Everything below is the layer between the snapshot and the pixels: the feed
// state machine, the capture-health triage, the filters, the play summary and
// the one measurement formatter. It is all pure, so it is tested here rather
// than in a browser -- and it has to be tested, because the rules it encodes
// (missing is not zero; absent-by-design is not a fault; the score is read and
// never computed) are exactly the ones a rendering change breaks silently.

import {
  AT_BAT_FILTERS,
  FEED_STALE_AFTER_MS,
  annotateAtBats,
  buildGameHeader,
  buildPlayExplanation,
  countAtBatFilters,
  describeFeedStatus,
  feedRecovered,
  filterAtBats,
  findNextMatch,
  indexPlaysByAtBat,
  presentMeasurement,
  readScore,
  stepSelection,
  summarizeCaptureHealth,
} from '../src/utils/trackerConsoleView.js'
import { describePlayGeometry, placeLabels } from '../src/utils/trackerDiagramLayout.js'
import { playGeometry } from '../scripts/tracker_preview_plays.mjs'

test('the feed reports startup, live, reconnecting, stale, offline and shutdown apart', () => {
  const now = 100_000
  assert.equal(describeFeedStatus({ snapshot: null, now }).state, 'waiting')
  assert.equal(describeFeedStatus({ snapshot: {}, now }).state, 'live')
  assert.equal(describeFeedStatus({ snapshot: null, connectionError: 'refused', now }).state, 'offline')

  // A single dropped poll is a reconnection, not a stale page.
  const reconnecting = describeFeedStatus({
    snapshot: {}, connectionError: 'timeout', lastGoodAt: now - 1500, now,
  })
  assert.equal(reconnecting.state, 'reconnecting')
  assert.equal(reconnecting.showsLastGood, true)

  // Past the threshold the page must say what it is showing.
  const stale = describeFeedStatus({
    snapshot: {}, connectionError: 'timeout', lastGoodAt: now - FEED_STALE_AFTER_MS - 1, now,
  })
  assert.equal(stale.state, 'stale')
  assert.equal(stale.showsLastGood, true)
  assert.match(stale.label, /last good snapshot/i)
  assert.match(stale.detail, /Nothing below has changed/)

  assert.equal(describeFeedStatus({ snapshot: {}, shutdownRequested: true, now }).state, 'ended')
})

test('coming back from stale or offline is an announceable event', () => {
  assert.equal(feedRecovered('stale', 'live'), true)
  assert.equal(feedRecovered('reconnecting', 'live'), true)
  assert.equal(feedRecovered('offline', 'live'), true)
  assert.equal(feedRecovered('live', 'live'), false)
  assert.equal(feedRecovered('live', 'stale'), false)
})

test('capture health separates blockers from warnings from absent-by-design', () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, caughtPlay)
  const snapshot = trackerPreviewSnapshot(state)
  const healthy = summarizeCaptureHealth(snapshot, {
    feed: describeFeedStatus({ snapshot, now: Date.now() }),
  })
  assert.equal(healthy.level, 'degraded', 'the fixture has one missed frame')
  assert.deepEqual(healthy.blockers, [])
  assert.ok(healthy.warnings.some((entry) => entry.id === 'missed-frames'))
  assert.ok(healthy.healthy.some((entry) => entry.id === 'calibration-confirmed'))
  assert.ok(healthy.healthy.some((entry) => entry.id === 'writes-disabled'))

  // A failed calibration stops everything below it and must be a blocker.
  setTrackerPreviewCaptureHealth(state, { calibration_status: 'failed', plays_withheld: 4 })
  const broken = summarizeCaptureHealth(trackerPreviewSnapshot(state), {})
  assert.equal(broken.level, 'blocked')
  assert.ok(broken.blockers.some((entry) => entry.id === 'calibration-failed'))
  assert.ok(broken.blockers.some((entry) => entry.id === 'plays-withheld'))
})

test('a replayed capture reports its absent live fields as not applicable, not as faults', () => {
  const state = createTrackerPreviewState({ mode: 'archive_replay' })
  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  setTrackerPreviewCaptureHealth(state, {
    status: 'stopped', frames: 85640, missed_frames: 0, frame_rate: 59.1,
    calibration_status: 'confirmed', position_offset: 4,
  })
  const health = summarizeCaptureHealth(trackerPreviewSnapshot(state), {})
  assert.deepEqual(health.blockers, [])
  assert.deepEqual(health.warnings, [], 'a clean archive replay raises nothing')
  assert.equal(health.level, 'healthy')
  // The two fields a replay genuinely cannot have.
  assert.ok(health.optional.some((entry) => entry.id === 'replay-no-live-frames'))
  assert.ok(health.optional.some((entry) => entry.id === 'replay-no-lock-margin'))

  const frameAge = health.metrics.find((entry) => entry.id === 'frame-age')
  assert.equal(frameAge.missing, true)
  assert.match(frameAge.detail, /Not applicable/)
  const missed = health.metrics.find((entry) => entry.id === 'missed-rate')
  assert.equal(missed.missing, false, 'zero missed frames is a measurement')
  assert.match(missed.value, /^0/)
})

test('a stalled collector is a blocker even while its status still says recording', () => {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  setTrackerPreviewCaptureHealth(state, {
    status: 'recording', frames: 1000, missed_frames: 0,
    last_frame_at: new Date(Date.now() - 60_000).toISOString(),
  })
  const health = summarizeCaptureHealth(trackerPreviewSnapshot(state), {})
  assert.ok(health.blockers.some((entry) => entry.id === 'frames-stalled'))
  assert.equal(health.metrics.find((entry) => entry.id === 'frame-age').tone, 'bad')
})

test('the missed-frame RATE is reported, not only the count', () => {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  setTrackerPreviewCaptureHealth(state, { status: 'recording', frames: 200, missed_frames: 3 })
  const bad = summarizeCaptureHealth(trackerPreviewSnapshot(state), {})
  assert.ok(bad.warnings.some((entry) => entry.id === 'missed-frames-high'), '1.5% is high')

  // The same three missed frames in a real capture are not the same thing.
  setTrackerPreviewCaptureHealth(state, { frames: 200_000, missed_frames: 3 })
  const fine = summarizeCaptureHealth(trackerPreviewSnapshot(state), {})
  assert.ok(fine.warnings.some((entry) => entry.id === 'missed-frames'))
  assert.ok(!fine.warnings.some((entry) => entry.id === 'missed-frames-high'))
})

test('a capture header with no frame total says so instead of reporting zero missed', () => {
  // Three archived sessions end without their final frames/duration/missed
  // counts. Every play in them replays and joins, so the capture is usable --
  // but "0 missed of 0 frames" would be a claim the file cannot support.
  const state = createTrackerPreviewState({ mode: 'archive_replay' })
  setTrackerPreviewStadiumOverride(state, 'bowser_castle')
  setTrackerPreviewCaptureHealth(state, {
    status: 'stopped', frames: null, missed_frames: null, duration_seconds: null,
    frame_rate: null, calibration_status: 'confirmed', position_offset: 4,
  })
  applyTrackerPreviewPlay(state, structuredClone(caughtPlay))
  const health = summarizeCaptureHealth(trackerPreviewSnapshot(state), {})
  assert.ok(health.warnings.some((entry) => entry.id === 'header-incomplete'))
  assert.equal(health.level, 'degraded')
  const missed = health.metrics.find((entry) => entry.id === 'missed-rate')
  assert.equal(missed.missing, true, 'an absent missed-frame count is not a zero')
  assert.equal(health.metrics.find((entry) => entry.id === 'frame-rate').missing, true)
  // The plays it does have are still reported.
  assert.equal(health.metrics.find((entry) => entry.id === 'plays').missing, false)
})

test('the header reads the score and never computes one', () => {
  const state = twoAtBatSession()
  const header = buildGameHeader(trackerPreviewSnapshot(state))
  assert.equal(header.score.available, false)
  assert.match(header.score.reason, /does not report a running score/)
  assert.equal(header.park.label, 'Mario Stadium')
  assert.equal(header.inning.label, 'Top 1')
  assert.equal(header.outs, 1)
  assert.equal(header.balls, 0)
  assert.equal(header.strikes, 0)
  assert.ok(header.matchup.label.includes('vs'))

  // If the feed ever grows a score, it is used verbatim.
  assert.deepEqual(
    readScore({ situation: { score: { away: 3, home: 5 } } }),
    { available: true, away: 3, home: 5, source: 'tracker feed' },
  )
  // A half-reported score is not a score.
  assert.equal(readScore({ situation: { away_score: 3 } }).available, false)
})

test('at-bats carry the four navigation facts, read off fields rather than guessed', () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, caughtPlay)
  applyTrackerPreviewPlay(state, groundPlay)
  const snapshot = trackerPreviewSnapshot(state)
  const annotated = annotateAtBats(snapshot.at_bats, snapshot.player_tracking_plays)

  assert.equal(annotated.length, 2)
  for (const entry of annotated) {
    assert.equal(entry.in_play, true, 'both at-bats have a fair batted ball')
    assert.equal(entry.complete, true)
    assert.equal(entry.uncertain, false)
    assert.equal(entry.play_count, 1)
  }
  const counts = countAtBatFilters(annotated)
  assert.equal(counts.all, 2)
  assert.equal(counts.in_play, 2)
  assert.equal(counts.complete, 2)
  assert.equal(counts.uncertain, 0)

  // Every filter id in the UI has a count.
  for (const filter of AT_BAT_FILTERS) assert.equal(typeof counts[filter.id], 'number')
})

test('a play that names an at-bat but could not join marks it ambiguous rather than clean', () => {
  const state = createTrackerPreviewState({ mode: 'local_preview' })
  setTrackerPreviewStadiumOverride(state, 'mario_stadium')
  feed(state, [
    'Next: Top of inning 1', 'Bowser vs. Luigi', '0 outs', 'Count: 0-0',
    'Fair ball!', 'Luigi recorded a single!',
    'Bowser vs. Luigi', '0 outs', 'Count: 0-0',
    'Fair ball!', 'Luigi recorded a single!',
  ])
  applyTrackerPreviewPlay(state, caughtPlay)
  const snapshot = trackerPreviewSnapshot(state)
  const annotated = annotateAtBats(snapshot.at_bats, snapshot.player_tracking_plays)
  const flagged = annotated.filter((entry) => entry.uncertain)
  assert.ok(flagged.length >= 1, 'the ambiguous play must surface on the at-bats it names')
  assert.ok(flagged[0].uncertain_reasons.some((reason) => /did not join cleanly/.test(reason)))
  assert.equal(filterAtBats(annotated, 'uncertain').length, flagged.length)
})

test('a filter selects exactly the at-bats it names', () => {
  const annotated = [
    { pa_number: 1, has_warnings: false, uncertain: false, in_play: true, complete: true },
    { pa_number: 2, has_warnings: true, uncertain: true, in_play: false, complete: false },
    { pa_number: 3, has_warnings: false, uncertain: false, in_play: true, complete: true },
  ]
  assert.deepEqual(filterAtBats(annotated, 'all').map((entry) => entry.pa_number), [1, 2, 3])
  assert.deepEqual(filterAtBats(annotated, 'warnings').map((entry) => entry.pa_number), [2])
  assert.deepEqual(filterAtBats(annotated, 'uncertain').map((entry) => entry.pa_number), [2])
  assert.deepEqual(filterAtBats(annotated, 'in_play').map((entry) => entry.pa_number), [1, 3])
  assert.deepEqual(filterAtBats(annotated, 'complete').map((entry) => entry.pa_number), [1, 3])
  assert.deepEqual(filterAtBats(annotated, 'nonsense').map((entry) => entry.pa_number), [1, 2, 3])
})

test('paging stops at the ends instead of wrapping, and warning jumps skip the clean ones', () => {
  const list = [
    { pa_number: 1, has_warnings: false },
    { pa_number: 2, has_warnings: false },
    { pa_number: 3, has_warnings: true },
    { pa_number: 4, has_warnings: false },
    { pa_number: 5, has_warnings: true },
  ]
  assert.equal(stepSelection(list, 2, 1), 3)
  assert.equal(stepSelection(list, 2, -1), 1)
  assert.equal(stepSelection(list, 1, -1), null, 'the first at-bat must not wrap to the last')
  assert.equal(stepSelection(list, 5, 1), null)
  // No selection yet: an arrow starts from the newest at-bat.
  assert.equal(stepSelection(list, null, -1), 4)

  assert.equal(findNextMatch(list, 1, (entry) => entry.has_warnings, 1), 3)
  assert.equal(findNextMatch(list, 3, (entry) => entry.has_warnings, 1), 5)
  assert.equal(findNextMatch(list, 5, (entry) => entry.has_warnings, 1), null)
  assert.equal(findNextMatch(list, 5, (entry) => entry.has_warnings, -1), 3)
})

test('plays index by the at-bat they joined to, and unjoined ones are not invented into one', () => {
  const index = indexPlaysByAtBat([
    { contact_timer: 1, join_pa_number: 7 },
    { contact_timer: 2, join_pa_number: 7 },
    { contact_timer: 3, join_pa_number: null },
  ])
  assert.equal(index.get(7).length, 2)
  assert.equal(index.size, 1)
})

test('the play summary names the fielder and sources every number it shows', () => {
  const state = twoAtBatSession()
  // A fresh copy: applyPlayerTrackingPlay stores the object it is handed and
  // Object.assigns replacements onto it, so an earlier test in this file has
  // already rewritten the shared `caughtPlay` fixture in place.
  applyTrackerPreviewPlay(state, structuredClone(caughtPlay))
  const snapshot = trackerPreviewSnapshot(state, { selectedPaNumber: 1 })
  const explanation = buildPlayExplanation({
    interpretation: snapshot.interpretation,
    play: snapshot.display_play,
    atBat: snapshot.display_at_bat,
    warnings: snapshot.warnings,
  })
  assert.equal(explanation.batter, 'Luigi')
  assert.equal(explanation.result, 'FO')
  assert.equal(explanation.resultLabel, 'flyout')
  assert.equal(explanation.primary.position, 'CF')
  assert.equal(explanation.primary.character, 'Birdo')
  assert.ok(explanation.evidence.some((item) => item.label === 'Hang time'))
  for (const item of explanation.evidence) assert.ok(item.source, `${item.label} has no source`)
})

test('an unjoined play is stated as withheld rather than summarised as nothing happening', () => {
  const explanation = buildPlayExplanation({
    interpretation: { status: 'partial', summary: 'Luigi hit a fly ball.', clauses: [] },
    play: { join_status: 'ambiguous', join_reason: 'two at-bats match', unknown_contacts: 0 },
    atBat: { batter_name: 'Luigi', result: 'FO' },
  })
  const labels = explanation.uncertainty.map((item) => item.label)
  assert.ok(labels.some((label) => /Join ambiguous/.test(label)))
  assert.match(explanation.uncertainty[0].detail, /two at-bats match/)

  // No play at all is a louder statement, not a quieter one.
  const none = buildPlayExplanation({
    interpretation: { status: 'partial', summary: 'Luigi walked.', clauses: [] },
    play: null,
    atBat: { batter_name: 'Luigi', result: 'BB' },
  })
  assert.ok(none.uncertainty.some((item) => /No 60 Hz play joined/.test(item.label)))
  assert.equal(none.primary, null)
})

test('an unknown or contradicted clause reaches the summary as uncertainty', () => {
  const explanation = buildPlayExplanation({
    interpretation: {
      status: 'complete',
      summary: 'Shy Guy hit a ground ball.',
      clauses: [
        { id: 'c1', status: 'observed', text: 'observed thing' },
        { id: 'c2', status: 'unknown', text: 'The tracker could not determine whether contact occurred.' },
        { id: 'c3', status: 'mismatch', text: 'Two sources disagree about the result.' },
      ],
    },
    play: { join_status: 'joined', unknown_contacts: 1 },
    atBat: { batter_name: 'Shy Guy', result: 'GO' },
    warnings: [{ severity: 'error', title: 'runs-disagree', detail: 'the runs do not add up' }],
  })
  const text = JSON.stringify(explanation.uncertainty)
  assert.match(text, /could not determine whether contact occurred/)
  assert.match(text, /Two sources disagree/)
  assert.match(text, /1 contact unclassified/)
  assert.match(text, /runs do not add up/)
  assert.ok(!explanation.uncertainty.some((item) => /observed thing/.test(item.detail)))
})

test('zero, missing, excluded, projected and baseline-required are five presentations', () => {
  const zero = presentMeasurement(0, { unit: 's', digits: 2 })
  assert.equal(zero.text, '0.00 s')
  assert.equal(zero.tone, 'zero')
  assert.equal(zero.missing, false)

  for (const absent of [null, undefined, '', Number.NaN]) {
    const missing = presentMeasurement(absent, { unit: 's' })
    assert.equal(missing.text, 'Not measured')
    assert.equal(missing.missing, true)
  }

  const excluded = presentMeasurement(89.4, { unit: 'mph', status: 'excluded' })
  assert.equal(excluded.text, '89.40 mph')
  assert.equal(excluded.excluded, true)
  assert.equal(excluded.missing, false, 'an excluded value is measured')

  const projected = presentMeasurement(412, { unit: 'ft', digits: 0, status: 'projected' })
  assert.equal(projected.projected, true)
  assert.equal(projected.text, '412 ft')

  const model = presentMeasurement(null, { status: 'baseline_required' })
  assert.equal(model.text, 'Baseline required')
  assert.equal(model.tone, 'model')
})

test('crowded fielders get separated labels and markers that never move', () => {
  // Four fielders standing on the same spot, which the capture does produce
  // when the game bunches an infield.
  const markers = [
    { key: 'SS', x: 500, y: 400, text: 'SS', priority: false },
    { key: '2B', x: 503, y: 402, text: '2B', priority: true },
    { key: '1B', x: 498, y: 398, text: '1B', priority: false },
    { key: 'P', x: 501, y: 401, text: 'P', priority: false },
  ]
  const placed = placeLabels(markers)
  assert.equal(placed.length, 4)
  for (const entry of placed) {
    const original = markers.find((marker) => marker.key === entry.key)
    assert.equal(entry.x, original.x, 'a marker is never moved to make room')
    assert.equal(entry.y, original.y)
  }
  // No two labels land on the same point.
  const points = placed.map((entry) => `${Math.round(entry.label.cx)},${Math.round(entry.label.cy)}`)
  assert.equal(new Set(points).size, points.length, `labels collided: ${points.join(' ')}`)
  // The fielder who made the play gets first pick of the slots.
  assert.equal(placed[0].key, '2B')
})

test('the diagram has a text alternative built from the same geometry it draws', () => {
  const state = twoAtBatSession()
  applyTrackerPreviewPlay(state, structuredClone(caughtPlay))
  const snapshot = trackerPreviewSnapshot(state, { selectedPaNumber: 1 })
  const description = describePlayGeometry(snapshot.play_geometry, 'mario_stadium')
  assert.match(description, /mario stadium/)
  assert.match(description, /first touch by Birdo/)
  assert.match(description, /before the ball landed/)
  assert.match(description, /1 throw recorded/)
  assert.equal(describePlayGeometry(null), 'No measured play geometry is attached to this at-bat.')
})

// THE THIRD REPORT of the same wrong picture. The redirect reached
// compactPlaySummary the second time, and compactPlaySummary feeds the
// stadium-artwork card -- while "Measured field view" is TrackerPlayDiagram,
// which reads playGeometry, which carried nothing about the stadium at all and
// drew contact straight to the glove.
test('the measured field view gets the points the stadium moved the ball through', () => {
  const redirected = trackingPlay({
    landing: { t: 1.84, frame: 5850, at: [-32.0, 0.27, -51.78], distance_units: 60.9 },
    first_touch: firstTouch({ frame: 5928, at: [-12.19, 0, -72.11], by: 'CF', character: 'Diddy Kong' }),
    arrow_redirects: [{
      frame: 5853, t: 1.885, at: [-32.06, 0.42, -52.62],
      heading_degrees: 135, turn_degrees: 80.97,
    }],
    path_redirected_by_stadium: true,
  })
  const geometry = playGeometry(redirected)
  assert.equal(geometry.ball_waypoints.length, 1)
  assert.equal(geometry.ball_waypoints[0].kind, 'arrow_redirect')
  // The frame is what orders the turn against the landing and the touch. The
  // arrow fires three frames AFTER the ball lands, so a diagram that drops
  // either one draws a journey the ball did not take.
  assert.equal(geometry.landing.frame, 5850)
  assert.equal(geometry.ball_waypoints[0].frame, 5853)
  assert.equal(geometry.first_touch.frame, 5928)
  assert.match(describePlayGeometry(geometry, 'wario_city'), /a directional arrow turned the ball 81 degrees mid-roll/)

  // A ball that came down on an erupting manhole never reached the ground, so
  // it has no landing and nobody touched it. Its last measured position is the
  // strike, and the diagram used to answer that with "no endpoint was measured".
  const struck = trackingPlay({
    landing: null,
    first_touch: null,
    manhole_ball_strikes: [{
      frame: 32220, t: 2.19, at: [27.92, 3.14, -74.55], height_units: 3.139,
      manhole_at: [30.0, -0.4, -75.0],
    }],
  })
  const strikeGeometry = playGeometry(struck)
  assert.equal(strikeGeometry.ball_waypoints.length, 1)
  assert.equal(strikeGeometry.ball_waypoints[0].kind, 'manhole_strike')
  assert.match(
    describePlayGeometry(strikeGeometry, 'wario_city'),
    /came down on an erupting manhole and never reached the ground/,
  )

  const tabled = trackingPlay({
    table_ball_contacts: [{
      frame: 21276, t: 1.952, at: [10.374, 1.81, -67.991],
      impact_kind: 'tabletop_bounce', height_units: 1.81,
    }],
  })
  const tableGeometry = playGeometry(tabled)
  assert.equal(tableGeometry.ball_waypoints.length, 1)
  assert.equal(tableGeometry.ball_waypoints[0].kind, 'table_contact')
  assert.equal(tableGeometry.ball_waypoints[0].contact_kind, 'tabletop_bounce')
  assert.match(describePlayGeometry(tableGeometry, 'daisy_cruiser'), /the ball bounced on a table/)

  // Yoshi Park: into one pipe, out of another. The measured path draws the
  // carry as a straight line across the outfield; the two marks say why.
  const piped = trackingPlay({
    pipe_transits: [{
      frame: 1809, exit_frame: 1995, t: 0.9543, exit_t: 5.7392,
      entry_pipe: 'right_centre', exit_pipe: 'left_centre',
      entry_at: [23.259, 1.508, -68.564], exit_at: [-18.654, 4.0, -66.284],
    }],
  })
  const pipeGeometry = playGeometry(piped)
  assert.deepEqual(pipeGeometry.ball_waypoints.map((entry) => entry.kind), ['pipe_entry', 'pipe_exit'])
  assert.match(describePlayGeometry(pipeGeometry, 'yoshi_park'),
    /the ball went into the right centre pipe and came out of the left centre pipe/)

  // Yoshi Park's train knocking a loose ball back inside the outfield wall.
  const trained = trackingPlay({
    train_ball_hits: [{
      frame: 148773, t: 3.6, at: [-27.921, 1.06, -83.845], height_units: 1.06,
      fence_inside_units: 6.44, mechanism: 'train',
    }],
  })
  const trainGeometry = playGeometry(trained)
  assert.deepEqual(trainGeometry.ball_waypoints.map((entry) => entry.kind), ['train_hit'])
  assert.match(describePlayGeometry(trainGeometry, 'yoshi_park'), /the train hit the ball/)

  // A ball the train SWALLOWED, which Yoshi Park scores as a home run. The
  // diagram is the only place a reader can see why such a path stops in the
  // outfield with no fielder near it.
  const swallowed = trackingPlay({
    train_ball_captures: [{
      frame: 77983, t: 3.1698, at: [6.969, 0, -93.531], exit_at: [26.327, 0, -87.092],
      carried_units: 20.401, seconds: 1.9686, home_run_flag_rose: true, mechanism: 'train',
    }],
  })
  const swallowGeometry = playGeometry(swallowed)
  assert.deepEqual(swallowGeometry.ball_waypoints.map((entry) => entry.kind), ['train_capture'])
  assert.match(describePlayGeometry(swallowGeometry, 'yoshi_park'),
    /the ball landed inside the train, which Yoshi Park scores as a home run/)

  // Every other park still gets exactly what it got before.
  assert.deepEqual(playGeometry(trackingPlay({})).ball_waypoints, [])
})

test('an empty session renders every derived view without throwing', () => {
  const snapshot = trackerPreviewSnapshot(createTrackerPreviewState({ mode: 'local_preview' }))
  const header = buildGameHeader(snapshot)
  assert.equal(header.matchup.label, null, 'no batter and no pitcher yet')
  // The tracker state opens on Top 1 before any game exists, so the header
  // reports that rather than inventing a blank -- but it must not claim a
  // score, a park or a matchup it has never been told.
  assert.equal(header.inning.label, 'Top 1')
  assert.equal(header.park.label, null)
  assert.equal(header.score.available, false)
  const health = summarizeCaptureHealth(snapshot, { feed: describeFeedStatus({ snapshot }) })
  assert.equal(health.level, 'waiting')
  assert.equal(health.headline, 'Waiting for the first matchup')
  assert.deepEqual(annotateAtBats(snapshot.at_bats, snapshot.player_tracking_plays), [])
  assert.equal(buildPlayExplanation({}), null)
})

test('a malformed or partial snapshot does not take the header down with it', () => {
  for (const broken of [null, undefined, {}, { situation: null, capture: null }, { capture: {} }]) {
    const header = buildGameHeader(broken)
    assert.equal(header.score.available, false)
    const health = summarizeCaptureHealth(broken, {})
    assert.ok(Array.isArray(health.blockers))
    assert.ok(health.metrics.every((entry) => 'missing' in entry))
  }
})
