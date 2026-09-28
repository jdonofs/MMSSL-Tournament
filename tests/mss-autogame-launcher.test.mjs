// The launcher, driven end to end against fake children and a fake database.
//
// Everything under test here is orchestration: which process starts, in what
// order, what proves it is ready, and what is left running when something
// goes wrong. None of it touches Dolphin, Supabase, lineup.json or a raw
// recording -- every file this suite writes lives in its own temp directory,
// and every child is a scripted fake.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MATCH_LIVE_MARKER, main, parseArgs, resolveById,
} from '../scripts/mss_autogame.mjs'
import { createTrackerFakeSupabase } from './helpers/trackerFakeSupabase.mjs'
import { createFakeSpawner, waitFor } from './helpers/fakeChildProcess.mjs'

const EXPORTER = 'export_mss_lineup'
const BRIDGE = 'live_tracker_bridge'
const AUTOTEAM = 'mss_autoteam'

const PINNED_PID = 4242
const PINNED_NOW = 1757000000000
const SIGNAL_NAME = `mss-autogame-${PINNED_PID}-${PINNED_NOW}.live`

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autogame-launcher-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const TOURNAMENT_GAME = {
  id: 12, tournament_id: 3, status: 'pending', stats_source: 'manual',
  team_a_player_id: 'p-away', team_b_player_id: 'p-home', stadium: null,
}
const SEASON_GAME = {
  id: 40, season_id: 71, status: 'scheduled', stats_source: 'manual',
  away_team_id: 'st-away', home_team_id: 'st-home', stadium: 'Yoshi Park',
}

function db(overrides = {}) {
  return {
    games: [{ ...TOURNAMENT_GAME }],
    season_schedule: [{ ...SEASON_GAME }],
    seasons: [{ id: 71, name: 'TEST', status: 'active' }],
    tournaments: [{ id: 3, tournament_number: 9, status: 'active', archived: false }],
    season_teams: [
      { id: 'st-away', team_name: 'Dumbos', player_id: 'p-s-away' },
      { id: 'st-home', team_name: 'Bompkins', player_id: 'p-s-home' },
    ],
    players: [{ id: 'p-away', name: 'May' }, { id: 'p-home', name: 'Aidan' }],
    ...overrides,
  }
}

// One launcher run. Everything injectable is injected; nothing here reaches
// the real filesystem outside `dir`, the real clock for the signal name, or
// the real process table except through a pid the test chose.
function harness(t, {
  tables = db(), argv = [], script = () => {}, env = {}, answers = [],
  dir = tempDir(t), bridgeReadyTimeoutMs = 400, recordingTimeoutMs = 400,
} = {}) {
  const supabase = createTrackerFakeSupabase(tables)
  supabase.auth = {
    signInWithPassword: async () => ({ data: { session: {
      user: {}, access_token: 'launcher-session-token',
    } }, error: null }),
  }
  const logs = []
  const errors = []
  const signals = new Map()
  const controls = new Set()
  const exitCodes = []
  const exitHandlers = []
  const fetches = []
  const spawn = createFakeSpawner(script)
  const asked = []
  const ask = async (question) => {
    asked.push(question)
    return answers.shift() ?? ''
  }
  ask.close = () => {}

  const deps = {
    argv,
    supabase,
    spawn,
    ask,
    env: {
      VITE_SUPABASE_URL: 'http://supabase.invalid',
      VITE_SUPABASE_ANON_KEY: 'anon',
      TRACKER_BRIDGE_EMAIL: 'bridge@example.invalid',
      TRACKER_BRIDGE_PASSWORD: 'secret',
      ...env,
    },
    childEnv: { PATH_MARKER: 'inherited' },
    execPath: path.join('C:', 'Program Files', 'nodejs', 'node.exe'),
    paths: {
      exporter: path.join('C:', 'Sluggers dir', 'scripts', 'export_mss_lineup.mjs'),
      autoteam: path.join('C:', 'Sluggers dir', 'scripts', 'mss_autoteam.py'),
      bridge: path.join('C:', 'Sluggers dir', 'scripts', 'live_tracker_bridge.mjs'),
    },
    log: (...args) => logs.push(args.join(' ')),
    logError: (...args) => errors.push(args.join(' ')),
    lockDir: dir,
    signalDir: dir,
    pid: PINNED_PID,
    now: () => PINNED_NOW,
    bridgeReadyTimeoutMs,
    recordingTimeoutMs,
    startupRecordDir: path.join(dir, 'startup-records'),
    pollMs: 5,
    onSignal: (name, handler) => {
      if (!signals.has(name)) signals.set(name, [])
      signals.get(name).push(handler)
    },
    offSignal: (name, handler) => {
      signals.set(name, (signals.get(name) || []).filter((entry) => entry !== handler))
    },
    onControl: (handler) => controls.add(handler),
    offControl: (handler) => controls.delete(handler),
    onExit: (handler) => exitHandlers.push(handler),
    exit: (code) => { exitCodes.push(code) },
    fetch: async (url, init) => {
      fetches.push({ url, init })
      return { ok: true, status: 202, json: async () => ({ accepted: true }) }
    },
  }

  return {
    dir,
    supabase,
    spawn,
    logs,
    errors,
    exitCodes,
    exitHandlers,
    fetches,
    asked,
    signalPath: path.join(dir, SIGNAL_NAME),
    readyPath: path.join(dir, `${SIGNAL_NAME}.ready`),
    recordingPath: path.join(dir, `${SIGNAL_NAME}.recording`),
    startupRecords: () => {
      const directory = path.join(dir, 'startup-records')
      if (!fs.existsSync(directory)) return []
      return fs.readdirSync(directory)
        .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
    },
    raise: (name) => (signals.get(name) || []).slice().forEach((handler) => handler()),
    control: (message) => [...controls].forEach((handler) => handler(message)),
    signalCount: (name) => (signals.get(name) || []).length,
    run: () => main(deps),
    output: () => logs.concat(errors).join('\n'),
  }
}

// The scripted child behaviours the tests compose out of.
function exporterSucceeds(call) {
  if (call.args.some((arg) => String(arg).includes(EXPORTER))) call.child.exit(0)
}
function bridgeBecomesReady(call) {
  if (call.args.some((arg) => String(arg).includes(BRIDGE))) {
    fs.writeFileSync(call.options.env.TRACKER_LAUNCH_READY, '{"pid":1}\n')
  }
}
function standardStartup(call) {
  exporterSucceeds(call)
  bridgeBecomesReady(call)
}

async function pumpUntilAutoteam(harnessed) {
  return waitFor('autoteam to be spawned', () => harnessed.spawn.forScript(AUTOTEAM)[0])
}

// ── arguments ───────────────────────────────────────────────────────────────

test('numeric options are rejected rather than silently becoming NaN', () => {
  assert.throws(() => parseArgs(['--game', 'abc']), /--game needs a positive whole number/)
  assert.throws(() => parseArgs(['--game', '0']), /--game needs a positive whole number/)
  assert.throws(() => parseArgs(['--limit', '-1']), /--limit needs a positive whole number/)
  assert.throws(() => parseArgs(['--table', 'sideways']), /--table must be one of/)
  assert.equal(parseArgs(['--game', '2706']).gameId, 2706)
})

test('everything after a bare -- reaches autoteam untouched, spaces included', () => {
  const parsed = parseArgs(['--game', '12', '--', '--nav-preset', 'safe', '--formation-object', '0x80 12'])
  assert.deepEqual(parsed.passthrough, ['--nav-preset', 'safe', '--formation-object', '0x80 12'])
  assert.equal(parsed.gameId, 12)
})

test('an id held by both tables is refused rather than resolved by search order', () => {
  const entries = [
    { id: 12, source: { gamesTable: 'games' } },
    { id: 12, source: { gamesTable: 'season_schedule' } },
  ]
  assert.throws(() => resolveById(entries, 12), /exists in both games and season_schedule/)
  assert.equal(resolveById(entries, 12, 'season_schedule').source.gamesTable, 'season_schedule')
  assert.equal(resolveById(entries, 99), null)
})

// ── selection ───────────────────────────────────────────────────────────────

test('a tournament game and a season game each resolve to their own table', async (t) => {
  for (const [gameId, table] of [[12, 'games'], [40, 'season_schedule']]) {
    const run = harness(t, {
      argv: ['--game', String(gameId), '--dry-run'],
      script: exporterSucceeds,
    })
    assert.equal(await run.run(), 0)
    const call = run.spawn.oneFor(EXPORTER)
    assert.equal(call.options.env.MSS_GAME_ID, String(gameId))
    assert.equal(call.options.env.MSS_GAME_TABLE, table)
  }
})

test('overlapping numeric ids stop the run instead of picking one', async (t) => {
  const tables = db()
  tables.season_schedule[0].id = 12 // the same number as the tournament game
  const run = harness(t, { tables, argv: ['--game', '12'], script: standardStartup })
  await assert.rejects(run.run(), /exists in both games and season_schedule/)
  assert.equal(run.spawn.calls.length, 0, 'nothing may be spawned before the game is known')
  assert.equal(run.supabase.db.games[0].stats_source, 'manual')
  assert.equal(run.supabase.db.season_schedule[0].stats_source, 'manual')
})

test('--table resolves an overlapping id and travels to both children', async (t) => {
  const tables = db()
  tables.season_schedule[0].id = 12
  const run = harness(t, {
    tables,
    argv: ['--game', '12', '--table', 'season_schedule'],
    script: standardStartup,
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  assert.equal(autoteam.args.includes('--nav-preset'), false, 'use AutoTeam’s brisk default')
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  assert.equal(await finished, 0)

  assert.equal(run.spawn.oneFor(EXPORTER).options.env.MSS_GAME_TABLE, 'season_schedule')
  assert.equal(run.spawn.oneFor(BRIDGE).options.env.TRACKER_GAME_TABLE, 'season_schedule')
  assert.equal(run.supabase.db.season_schedule[0].stats_source, 'tracker')
  assert.equal(run.supabase.db.games[0].stats_source, 'manual', 'the other table must be untouched')
})

test('an id that is not waiting to be played is refused with a way past it', async (t) => {
  const tables = db()
  tables.games[0].status = 'complete'
  const refused = harness(t, { tables, argv: ['--game', '12'], script: standardStartup })
  await assert.rejects(refused.run(), /not one of the .* games waiting to be played/)
  assert.equal(refused.spawn.calls.length, 0)

  const allowed = harness(t, {
    tables,
    argv: ['--game', '12', '--dry-run'],
    env: { MSS_ALLOW_FINISHED: '1' },
    script: exporterSucceeds,
  })
  assert.equal(await allowed.run(), 0)
  assert.equal(allowed.spawn.oneFor(EXPORTER).options.env.MSS_GAME_TABLE, 'games')
})

test('an ambiguous #id typed at the picker is refused', async (t) => {
  const tables = db()
  tables.season_schedule[0].id = 12
  const run = harness(t, { tables, answers: ['', '#12'], script: standardStartup })
  await assert.rejects(run.run(), /exists in both/)
  assert.equal(run.spawn.calls.length, 0)
})

// ── export before mutation ──────────────────────────────────────────────────

test('a failed lineup export leaves the game unclaimed and the emulator alone', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      if (call.args.some((arg) => String(arg).includes(EXPORTER))) call.child.exit(1)
      bridgeBecomesReady(call)
    },
  })
  await assert.rejects(run.run(), /The lineup export failed \(exit 1\)/)
  assert.equal(run.supabase.db.games[0].stats_source, 'manual',
    'a lineup that cannot be exported must not leave the game in Tracker mode')
  assert.equal(run.spawn.forScript(BRIDGE).length, 0)
  assert.equal(run.spawn.forScript(AUTOTEAM).length, 0)
})

test('the claim happens after a successful export and before the bridge', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  assert.equal(run.supabase.db.games[0].stats_source, 'tracker')
  const order = run.spawn.calls.map((call) => (
    call.args.some((arg) => String(arg).includes(EXPORTER)) ? 'export'
      : call.args.some((arg) => String(arg).includes(BRIDGE)) ? 'bridge' : 'autoteam'))
  assert.deepEqual(order, ['export', 'bridge', 'autoteam'])
  assert.equal(run.spawn.oneFor(EXPORTER).options.env.MSS_EXPORT_ACCESS_TOKEN,
    'launcher-session-token')
  assert.equal(run.spawn.oneFor(BRIDGE).options.env.MSS_EXPORT_ACCESS_TOKEN, undefined)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
})

test('--no-claim leaves stats_source alone', async (t) => {
  const run = harness(t, { argv: ['--game', '12', '--no-claim', '--no-tracker'], script: exporterSucceeds })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.exit(0)
  assert.equal(await finished, 0)
  assert.equal(run.supabase.db.games[0].stats_source, 'manual')
})

// ── bridge readiness ────────────────────────────────────────────────────────

test('a bridge that dies during startup stops the run before the emulator is touched', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      exporterSucceeds(call)
      if (call.args.some((arg) => String(arg).includes(BRIDGE))) call.child.exit(3)
    },
  })
  await assert.rejects(run.run(), /exited with code 3 before it finished starting up/)
  assert.equal(run.spawn.forScript(AUTOTEAM).length, 0,
    'no menu may be driven behind a dead bridge')
  assert.match(run.output(), /this game will NOT be tracked/)
  assert.equal(fs.existsSync(run.signalPath), false)
  assert.equal(fs.existsSync(run.readyPath), false)
})

test('a bridge that cannot be spawned at all is reported the same way', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      exporterSucceeds(call)
      if (call.args.some((arg) => String(arg).includes(BRIDGE))) {
        call.child.failToSpawn(new Error('ENOENT node'))
      }
    },
  })
  await assert.rejects(run.run(), /could not be started \(ENOENT node\)/)
  assert.equal(run.spawn.forScript(AUTOTEAM).length, 0)
})

test('a bridge that is merely slow is warned about, not fatal', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: exporterSucceeds, // the bridge never writes its ready file
    bridgeReadyTimeoutMs: 120,
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  assert.match(run.output(), /has not finished starting up after/)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
})

test('a ready bridge is reported as ready before the menus are driven', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  const readyIndex = run.logs.findIndex((line) => /bridge ready: signed in/.test(line))
  const drivingIndex = run.logs.findIndex((line) => /Driving the menus/.test(line))
  assert.ok(readyIndex !== -1 && readyIndex < drivingIndex)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
})

// ── the handoff ─────────────────────────────────────────────────────────────

test('a marker split across stdout chunks releases the tracker exactly once', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.sayPartial(`${MATCH_LIVE_MARKER.slice(0, 8)}`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fs.existsSync(run.signalPath), false, 'half a marker is not a marker')
  autoteam.child.sayPartial(`${MATCH_LIVE_MARKER.slice(8)} confirmed\n`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  assert.match(fs.readFileSync(run.signalPath, 'utf8'), /confirmed/)
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  assert.equal(await finished, 0)
  const releases = run.logs.filter((line) => /releasing the tracker/.test(line))
  assert.equal(releases.length, 1)
})

test('a marker printed twice releases once and says the second was ignored', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  const first = fs.readFileSync(run.signalPath, 'utf8')
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the repeat to be noticed', () => run.errors.some((line) => /repeated/.test(line)))
  assert.equal(fs.readFileSync(run.signalPath, 'utf8'), first, 'the signal must not be rewritten')
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
  assert.equal(run.logs.filter((line) => /releasing the tracker/.test(line)).length, 1)
})

test('an unconfirmed handoff is reported as unconfirmed, and a bare token counts as one', async (t) => {
  for (const line of [`${MATCH_LIVE_MARKER} unconfirmed`, MATCH_LIVE_MARKER]) {
    const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
    const finished = run.run()
    const autoteam = await pumpUntilAutoteam(run)
    autoteam.child.say(line)
    await waitFor('the handoff', () => fs.existsSync(run.signalPath))
    autoteam.child.exit(0)
    run.spawn.oneFor(BRIDGE).child.exit(0)
    await finished
    assert.match(run.output(), /could NOT confirm a pitch reset/)
    assert.doesNotMatch(run.output(), /match is live at a pitch reset/)
  }
})

test('a confirmed handoff says so and nothing weaker', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
  assert.match(run.output(), /Handed off on a confirmed pitch reset/)
  assert.doesNotMatch(run.output(), /could NOT confirm/)
})

test('a marker delivered after the exit event is still a handoff', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  // The real ordering: the process is gone before its last stdout chunk has
  // been read. Deciding the handoff on `exit` alone read this as "autoteam
  // never reported the first pitch" and killed a bridge that should have run.
  autoteam.child.exitBeforeStdoutFlush(0, [`${MATCH_LIVE_MARKER} confirmed`])
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  run.spawn.oneFor(BRIDGE).child.exit(0)
  assert.equal(await finished, 0)
  assert.match(run.output(), /Handed off on a confirmed pitch reset/)
  assert.deepEqual(run.spawn.oneFor(BRIDGE).child.killSignals, [])
})

test('autoteam exiting 0 without the marker stops the bridge instead of letting it guess', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.exit(0)
  await assert.rejects(finished, /never reported the first pitch/)
  assert.ok(run.spawn.oneFor(BRIDGE).child.killSignals.length >= 1,
    'the bridge must not be left holding a tracker it will launch on a timeout')
  assert.equal(fs.existsSync(run.signalPath), false)
  assert.equal(fs.existsSync(run.readyPath), false)
})

// ── failure and cancellation ────────────────────────────────────────────────

test('autoteam failing before the handoff stops the bridge and clears the files', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.exit(2)
  await assert.rejects(finished, /mss_autoteam\.py exited 2.*The tracker was not started/s)
  assert.ok(run.spawn.oneFor(BRIDGE).child.killSignals.length >= 1)
  assert.equal(fs.existsSync(run.signalPath), false)
})

test('a failure after the handoff leaves the signal the bridge is still reading', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(2)
  // The run waits out the bridge it launched rather than exiting under it.
  await new Promise((resolve) => setTimeout(resolve, 20))
  // The bridge polls for this file every 250ms. Deleting it inside that window
  // strands the bridge until its own five-minute timeout, after which it
  // launches the tracker anyway -- into whatever screen is up.
  assert.equal(fs.existsSync(run.signalPath), true)
  assert.deepEqual(run.spawn.oneFor(BRIDGE).child.killSignals, [])
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await assert.rejects(finished, /The match was already live/)
})

test('autoteam failing to spawn does not leak the bridge', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      standardStartup(call)
      if (call.args.some((arg) => String(arg).includes(AUTOTEAM))) {
        call.child.failToSpawn(new Error('python not found'))
      }
    },
  })
  await assert.rejects(run.run(), /python not found/)
  // The bug this pins: the reject path used to skip every cleanup, leaving a
  // bridge alive that would launch its tracker into a menu five minutes later.
  assert.ok(run.spawn.oneFor(BRIDGE).child.killSignals.length >= 1)
  assert.equal(fs.existsSync(run.signalPath), false)
  assert.equal(fs.existsSync(run.readyPath), false)
})

test('cancelling during bridge startup kills the bridge and reports a cancelled run', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: exporterSucceeds, // never becomes ready, so the run sits in the wait
    bridgeReadyTimeoutMs: 5000,
  })
  const finished = run.run()
  const bridge = await waitFor('the bridge', () => run.spawn.forScript(BRIDGE)[0])
  run.raise('SIGINT')
  assert.equal(await finished, 130)
  assert.deepEqual(run.exitCodes, [130])
  assert.ok(bridge.child.killSignals.length >= 1)
  assert.match(run.output(), /cancelled during bridge startup/)
  assert.match(run.output(), /nothing is recording this game/)
})

test('the local helper can stop menu navigation through its control channel', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  run.control({ type: 'stop' })
  assert.equal(await finished, 130)
  assert.ok(autoteam.child.killSignals.length >= 1)
  assert.ok(run.spawn.oneFor(BRIDGE).child.killSignals.length >= 1)
})

test('cancelling before the handoff kills both children', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  run.raise('SIGINT')
  assert.equal(await finished, 130)
  assert.ok(run.spawn.oneFor(BRIDGE).child.killSignals.length >= 1)
  assert.ok(autoteam.child.killSignals.length >= 1, 'the python child is ours to reap')
  assert.match(run.output(), /cancelled during menu navigation/)
  assert.equal(fs.existsSync(run.signalPath), false)
})

test('cancelling after the handoff leaves the bridge to finish its capture', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  await waitFor('the game to be under way', () => run.output().includes('Handed off on a confirmed'))

  const bridge = run.spawn.oneFor(BRIDGE).child
  run.control({ type: 'stop' })
  // On Windows kill() is a TerminateProcess, which would skip the bridge's own
  // SIGTERM handler -- the one that flushes the capture and drains the writes.
  assert.deepEqual(bridge.killSignals, [],
    'a bridge with a capture still finalizing must never be terminated from here')
  // Nor may this process exit under it: on Windows the bridge is in this
  // process's job object and dies with it. Season games 2811 and 2812 lost
  // their postgame ingest that way.
  assert.deepEqual(run.exitCodes, [])
  await waitFor('the shutdown request', () => run.fetches.length)
  assert.equal(run.fetches[0].url, 'http://127.0.0.1:4317/shutdown')
  assert.deepEqual(JSON.parse(run.fetches[0].init.body), { gameId: 12, table: 'games' })
  let settled = false
  finished.then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false, 'the run must outlive the bridge it launched')
  bridge.exit(0)
  assert.equal(await finished, 130, 'a cancelled run must not report success')
  assert.deepEqual(run.exitCodes, [])
})

test('a second stop after the handoff forces the exit', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  await waitFor('the game to be under way', () => run.output().includes('Handed off on a confirmed'))

  run.raise('SIGINT')
  run.raise('SIGINT')
  assert.deepEqual(run.exitCodes, [130])
  assert.match(run.output(), /without waiting for the bridge/)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
})

test('a bridge that dies after the handoff returns its own exit code', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  await waitFor('the game to be under way', () => run.output().includes('Handed off on a confirmed'))
  run.spawn.oneFor(BRIDGE).child.exit(7)
  assert.equal(await finished, 7)
  assert.deepEqual(run.spawn.oneFor(BRIDGE).child.killSignals, [])
})

test('a stale handoff file on this run path is cleared before the bridge starts', async (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, SIGNAL_NAME), 'left over from a crashed run\n')
  fs.writeFileSync(path.join(dir, `${SIGNAL_NAME}.ready`), 'also stale\n')
  const run = harness(t, { dir, argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  assert.match(run.output(), /clearing a stale handoff file/)
  // A stale file must not have been read as this run's handoff.
  assert.doesNotMatch(run.output(), /releasing the tracker/)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  assert.match(fs.readFileSync(run.signalPath, 'utf8'), /confirmed/)
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
})

test('every run removes its own handoff files and unhooks its signal handlers', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
  assert.equal(fs.existsSync(run.signalPath), false)
  assert.equal(fs.existsSync(run.readyPath), false)
  assert.equal(run.signalCount('SIGINT'), 0)
  assert.equal(run.signalCount('SIGTERM'), 0)
  assert.equal(run.exitHandlers.length, 1, 'a hard exit still has to clear the signal file')
})

// ── the recording handshake ─────────────────────────────────────────────────
//
// "The match is live" and "frames are being written" are different claims and
// were being made by the same sentence. These fix which one each signal is.

test('the bridge is told where to publish its recording evidence', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  const bridge = run.spawn.oneFor(BRIDGE)
  assert.equal(bridge.options.env.TRACKER_LAUNCH_RECORDING, run.recordingPath)
  assert.equal(bridge.options.env.TRACKER_LAUNCH_READY, run.readyPath)
  autoteam.child.exit(1)
  await finished.catch(() => {})
})

test('capture evidence is reported with the frames and bytes behind it', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      standardStartup(call)
      // The bridge's half of the handshake: it publishes what the collector
      // proved, not that the collector exists.
      if (call.args.some((arg) => String(arg).includes(BRIDGE))) {
        fs.writeFileSync(call.options.env.TRACKER_LAUNCH_RECORDING, JSON.stringify({
          recording: true, frames: 47, bytesOnDisk: 9134, firstFramesSeconds: 0.78,
          stem: 'data/player_tracking/wario_stadium-20260908T000000Z', collectorPid: 5150,
        }))
      }
    },
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
  assert.match(run.output(), /60 Hz capture CONFIRMED: 47 frames and 9134 bytes on disk/)
  assert.match(run.output(), /wario_stadium-20260908T000000Z/)
  assert.match(run.output(), /timings: bridge ready \d+ ms, handoff \d+ ms, capture \d+ ms/)
  assert.doesNotMatch(run.output(), /nothing has proved the 60 Hz capture/)
})

test('a collector that never records is a warning, not a stopped game', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      standardStartup(call)
      if (call.args.some((arg) => String(arg).includes(BRIDGE))) {
        fs.writeFileSync(call.options.env.TRACKER_LAUNCH_RECORDING, JSON.stringify({
          recording: false, reason: 'no capture evidence after 30s', waitedMs: 30000,
        }))
      }
    },
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  const code = await finished
  assert.equal(code, 0, 'the game is still being scored; this is not a failed run')
  assert.match(run.output(), /nothing has proved the 60 Hz capture is recording/)
  assert.match(run.output(), /no capture evidence after 30s/)
  assert.match(run.output(), /no fielding, baserunning or throw measurements/)
})

test('a capture deliberately turned off is reported plainly rather than as a fault', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      standardStartup(call)
      if (call.args.some((arg) => String(arg).includes(BRIDGE))) {
        fs.writeFileSync(call.options.env.TRACKER_LAUNCH_RECORDING, JSON.stringify({
          recording: false, disabled: true,
          reason: 'player tracking is disabled (TRACKER_PLAYER_TRACKING=0)',
        }))
      }
    },
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
  assert.match(run.output(), /60 Hz capture is off for this run/)
  assert.doesNotMatch(run.output(), /WARNING: nothing has proved/)
})

test('a bridge that dies before reporting is named instead of waited out', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'], script: standardStartup, recordingTimeoutMs: 60000,
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  // No recording file will ever be written. A 60 s deadline would be a hung
  // launcher; the bridge's exit is the answer and arrives immediately.
  run.spawn.oneFor(BRIDGE).child.exit(3)
  await finished
  assert.match(run.output(), /the bridge exited \(code 3\) before it reported a capture/)
})

test('a run gives up on capture evidence rather than waiting forever', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'], script: standardStartup, recordingTimeoutMs: 60,
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  await waitFor('the capture wait to expire', () => /no capture evidence after/.test(run.output()))
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
  assert.match(run.output(), /no capture evidence after 0s/)
})

test('a stale recording file from a previous run is cleared before the bridge starts', async (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, `${SIGNAL_NAME}.recording`), '{"recording":true}')
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup, dir })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  assert.equal(fs.existsSync(run.recordingPath), false,
    'a leftover evidence file would report a capture that does not exist')
  assert.match(run.output(), /clearing a stale handoff file/)
  autoteam.child.exit(1)
  await finished.catch(() => {})
})

test('every run removes its recording evidence file too', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      standardStartup(call)
      if (call.args.some((arg) => String(arg).includes(BRIDGE))) {
        fs.writeFileSync(call.options.env.TRACKER_LAUNCH_RECORDING, '{"recording":true,"frames":30}')
      }
    },
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished
  assert.equal(fs.existsSync(run.recordingPath), false)
})

// ── ownership ───────────────────────────────────────────────────────────────

test('a second launch against a game a live bridge owns is refused before any mutation', async (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(
    path.join(dir, 'mss-tracker-tournament-12.lock'),
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
  )
  const run = harness(t, { dir, argv: ['--game', '12'], script: standardStartup })
  await assert.rejects(run.run(), /already owns tournament game 12/)
  assert.equal(run.spawn.calls.length, 0, 'not even the export may run')
  assert.equal(run.supabase.db.games[0].stats_source, 'manual')
})

test('a lock left by a crashed bridge does not block a new launch', async (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(
    path.join(dir, 'mss-tracker-tournament-12.lock'),
    JSON.stringify({ pid: 999999998, createdAt: '2026-01-01T00:00:00Z' }),
  )
  const run = harness(t, { dir, argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  assert.equal(await finished, 0)
})

// ── modes ───────────────────────────────────────────────────────────────────

test('--dry-run exports and stops, exactly as the help text says', async (t) => {
  const run = harness(t, { argv: ['--game', '12', '--dry-run'], script: exporterSucceeds })
  assert.equal(await run.run(), 0)
  assert.equal(run.spawn.calls.length, 1)
  assert.equal(run.supabase.db.games[0].stats_source, 'manual')
  assert.equal(
    run.supabase.operations.filter((op) => op.action !== 'select').length, 0,
    'a dry run may not write to the database',
  )
  assert.match(run.output(), /No database row and no emulator was touched/)
})

test('--no-tracker starts no bridge and does not wait for a pitch it cannot use', async (t) => {
  const run = harness(t, { argv: ['--game', '12', '--no-tracker'], script: exporterSucceeds })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  assert.equal(run.spawn.forScript(BRIDGE).length, 0)
  assert.equal(autoteam.args.includes('--wait-for-live'), false)
  autoteam.child.exit(0)
  assert.equal(await finished, 0)
  assert.match(run.output(), /no first\s+pitch was waited for/)
})

// ── argument forwarding ─────────────────────────────────────────────────────

test('paths with spaces and passthrough flags arrive as single arguments', async (t) => {
  const dir = tempDir(t)
  const lineupPath = path.join(dir, 'my lineups', 'game 12.json')
  const run = harness(t, {
    dir,
    argv: ['--game', '12', '--lineup', lineupPath, '--stadium', 'Bowser Jr. Playroom',
      '--', '--nav-preset', 'safe'],
    script: standardStartup,
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)

  const exporter = run.spawn.oneFor(EXPORTER)
  assert.deepEqual(exporter.args, [
    path.join('C:', 'Sluggers dir', 'scripts', 'export_mss_lineup.mjs'),
    '--out', path.resolve(lineupPath),
  ])
  assert.equal(exporter.command, path.join('C:', 'Program Files', 'nodejs', 'node.exe'))
  assert.equal(exporter.options.env.MSS_STADIUM, 'Bowser Jr. Playroom')
  assert.equal(exporter.options.env.PATH_MARKER, 'inherited')

  // --hold-until is between --wait-for-live and the passthrough: it is the file
  // autoteam holds MSS's pause menu for, and the passthrough still has to
  // arrive last and intact.
  const bridgeSpawn = run.spawn.oneFor(BRIDGE)
  assert.deepEqual(autoteam.args, [
    '-u', path.join('C:', 'Sluggers dir', 'scripts', 'mss_autoteam.py'),
    '--lineup', path.resolve(lineupPath),
    '--stage', 'all', '--wait-for-live',
    '--hold-until', bridgeSpawn.options.env.TRACKER_LAUNCH_READERS,
    '--nav-preset', 'safe',
  ])

  const bridge = run.spawn.oneFor(BRIDGE)
  assert.equal(bridge.options.env.TRACKER_GAME_ID, '12')
  assert.equal(bridge.options.env.TRACKER_LAUNCH_SIGNAL, run.signalPath)
  assert.equal(bridge.options.env.TRACKER_LAUNCH_READY, run.readyPath)

  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  bridge.child.exit(0)
  await finished
})

test('--python chooses the interpreter and MSS_PYTHON is the fallback', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12', '--no-tracker', '--python', path.join('C:', 'py 3.10', 'python.exe')],
    env: { MSS_PYTHON: 'ignored.exe' },
    script: exporterSucceeds,
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  assert.equal(autoteam.command, path.join('C:', 'py 3.10', 'python.exe'))
  autoteam.child.exit(0)
  await finished

  const fallback = harness(t, {
    argv: ['--game', '12', '--no-tracker'],
    env: { MSS_PYTHON: path.join('C:', 'py 3.10', 'python.exe') },
    script: exporterSucceeds,
  })
  const second = fallback.run()
  const child = await pumpUntilAutoteam(fallback)
  assert.equal(child.command, path.join('C:', 'py 3.10', 'python.exe'))
  child.child.exit(0)
  await second
})

test('the bridge collector uses the same selected Python as AutoTeam', async (t) => {
  const python = path.join('C:', 'py with numpy', 'python.exe')
  const run = harness(t, {
    argv: ['--game', '12', '--python', python],
    script: standardStartup,
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  const bridge = run.spawn.oneFor(BRIDGE)
  assert.equal(autoteam.command, python)
  assert.equal(bridge.options.env.TRACKER_PLAYER_PYTHON, python)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  bridge.child.exit(0)
  await finished
})

test('a launch writes down what it actually did, and what it was recording', async (t) => {
  // Every number in here exists only while this process is alive: how long the
  // bridge took to be ready, whether autoteam confirmed a pitch reset, how long
  // after the handoff the collector had frames on disk, and which log and which
  // capture belong to this game. It is the measurement
  // docs/tracker-launcher-orchestration.md said nobody had taken.
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      standardStartup(call)
      if (call.args.some((arg) => String(arg).includes(BRIDGE))) {
        fs.writeFileSync(call.options.env.TRACKER_LAUNCH_RECORDING, JSON.stringify({
          recording: true, frames: 44, missedFrames: 0, bytesOnDisk: 7712,
          firstFramesSeconds: 0.73, collectorPid: 5150, park: 'wario_stadium',
          stem: 'data/player_tracking/wario_stadium-20260908T000000Z',
          sessionLogPath: 'sluggers-stat-tracker-advanced-stats-dev/preview-sessions/preview-x.log',
        }))
      }
    },
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished

  const records = run.startupRecords()
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.competition, 'tournament')
  assert.equal(record.game_id, 12)
  assert.equal(record.stages.match_live, 'confirmed')
  assert.equal(record.stages.capture_recording, true)
  assert.equal(record.capture.stem, 'data/player_tracking/wario_stadium-20260908T000000Z')
  assert.equal(record.capture.frames, 44)
  // The pairing recorded first-hand rather than reconstructed from timestamps.
  assert.match(record.tracker_log, /preview-x\.log$/)
  assert.ok(Number.isFinite(record.timings_ms.capture_after_handoff))
  assert.ok(Number.isFinite(record.timings_ms.handoff))
})

test('a launch that never proved a capture still records why', async (t) => {
  const run = harness(t, {
    argv: ['--game', '12'],
    script: (call) => {
      standardStartup(call)
      if (call.args.some((arg) => String(arg).includes(BRIDGE))) {
        fs.writeFileSync(call.options.env.TRACKER_LAUNCH_RECORDING, JSON.stringify({
          recording: false, reason: 'the collector exited with code 2 before it captured anything',
        }))
      }
    },
  })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(MATCH_LIVE_MARKER)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished

  const [record] = run.startupRecords()
  assert.equal(record.stages.capture_recording, false)
  assert.equal(record.stages.match_live, 'unconfirmed')
  assert.match(record.capture.reason, /exited with code 2/)
  assert.equal(record.capture.stem, null)
})

// ── the gameplay hold ────────────────────────────────────────────────────────
//
// The five readiness claims the launcher already tracked are all about
// PROCESSES. None of them says anything about the game, and the game is what
// the opening play belongs to: autoteam signals at the pitch reset, so every
// second the bridge spent starting its readers was a second of live play with
// no scoring reader attached. The hold is the sixth claim, and it is the only
// one that is about the match.

test('the bridge is told where to publish "both readers up", and autoteam is told to wait for it', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  const bridge = run.spawn.oneFor(BRIDGE)

  const readersPath = bridge.options.env.TRACKER_LAUNCH_READERS
  assert.ok(readersPath, 'the bridge has somewhere to say both readers are up')
  assert.match(readersPath, /\.readers$/)
  assert.notEqual(readersPath, bridge.options.env.TRACKER_LAUNCH_RECORDING,
    'recording evidence and readers-ready are different claims and different files')
  const holdIndex = autoteam.args.indexOf('--hold-until')
  assert.notEqual(holdIndex, -1, 'autoteam is asked to hold the game')
  assert.equal(autoteam.args[holdIndex + 1], readersPath)

  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.exit(0)
  bridge.child.exit(0)
  await finished
})

test('a held opening play is recorded as held, with how long it cost', async (t) => {
  const run = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  autoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(run.signalPath))
  autoteam.child.say('MSS_AUTOTEAM_GAMEPLAY_HELD paused')
  autoteam.child.say('MSS_AUTOTEAM_GAMEPLAY_RESUMED readers_ready 3.4')
  autoteam.child.exit(0)
  run.spawn.oneFor(BRIDGE).child.exit(0)
  await finished

  const [record] = run.startupRecords()
  assert.equal(record.stages.gameplay_hold, 'readers_ready')
  assert.equal(record.timings_ms.gameplay_held, 3400)
  assert.match(run.output(), /both readers were up 3\.4s into the hold/)
})

test('a hold that timed out, and a run with no hold at all, are both said out loud', async (t) => {
  const timedOut = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const timedOutFinished = timedOut.run()
  const timedOutAutoteam = await pumpUntilAutoteam(timedOut)
  timedOutAutoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(timedOut.signalPath))
  timedOutAutoteam.child.say('MSS_AUTOTEAM_GAMEPLAY_RESUMED timeout 45.0')
  timedOutAutoteam.child.exit(0)
  timedOut.spawn.oneFor(BRIDGE).child.exit(0)
  await timedOutFinished
  assert.equal(timedOut.startupRecords()[0].stages.gameplay_hold, 'timeout')
  assert.match(timedOut.output(), /the opening play may not\s+be captured/)

  // An older mss_autoteam.py prints neither marker. That is not "fine": it is
  // the behaviour the hold replaced, so it is recorded as null rather than
  // assumed to have held.
  const silent = harness(t, { argv: ['--game', '12'], script: standardStartup })
  const silentFinished = silent.run()
  const silentAutoteam = await pumpUntilAutoteam(silent)
  silentAutoteam.child.say(`${MATCH_LIVE_MARKER} confirmed`)
  await waitFor('the handoff', () => fs.existsSync(silent.signalPath))
  silentAutoteam.child.exit(0)
  silent.spawn.oneFor(BRIDGE).child.exit(0)
  await silentFinished
  assert.equal(silent.startupRecords()[0].stages.gameplay_hold, null)
})

test('--no-tracker asks for no hold, because nothing is coming to release it', async (t) => {
  const run = harness(t, { argv: ['--game', '12', '--no-tracker'], script: standardStartup })
  const finished = run.run()
  const autoteam = await pumpUntilAutoteam(run)
  assert.equal(autoteam.args.includes('--hold-until'), false)
  assert.equal(autoteam.args.includes('--wait-for-live'), false)
  autoteam.child.exit(0)
  await finished
})
