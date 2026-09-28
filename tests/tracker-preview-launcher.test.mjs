// The preview launcher's port handshake. It refuses to attach to an existing
// service, and the interesting cases are the occupants that do not answer
// like one.

import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import {
  assertCollectorPythonReady,
  assertApiPortIsFree,
  backendEnvironment,
  collectorPythonEnvironment,
  probePort,
  readArgs,
} from '../scripts/tracker_preview.mjs'
import {
  assertEvidenceProfileReady,
  collectorEvidenceArgs,
} from '../scripts/tracker_collector_feed.mjs'

function listen(server, t) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)))
      resolve(server.address().port)
    })
  })
}

test('the gimmick-test launcher flag is consumed and marks the capture excluded', () => {
  const options = readArgs(['--calibration-excluded', '--tracker-flag'])
  assert.equal(options.calibrationExcluded, true)
  assert.deepEqual(options.backendArgs, ['--tracker-flag'])
  assert.equal(backendEnvironment(options, {}).TRACKER_CALIBRATION_EXCLUDED, '1')
  // No reason given, so the collector keeps its own default rather than being
  // handed an empty sentence.
  assert.equal(
    backendEnvironment(options, {}).TRACKER_CALIBRATION_EXCLUDED_REASON, undefined,
  )
})

// The collector's default reason names stadium research, and it was written
// onto mario_stadium-20260923T012536Z -- a scripted slap/charge game that was
// excluded for a different reason entirely. An operator who says why gets that
// on the capture instead.
test('a stated exclusion reason excludes on its own and reaches the collector', () => {
  const options = readArgs(['--calibration-excluded-reason', 'scripted swing modes'])
  assert.equal(options.calibrationExcluded, true)
  assert.equal(options.calibrationExcludedReason, 'scripted swing modes')
  assert.deepEqual(options.backendArgs, [])
  const environment = backendEnvironment(options, {})
  assert.equal(environment.TRACKER_CALIBRATION_EXCLUDED, '1')
  assert.equal(environment.TRACKER_CALIBRATION_EXCLUDED_REASON, 'scripted swing modes')

  // An empty reason is not a reason. It still excludes -- the operator asked
  // for that -- and leaves the collector's default in place.
  const blank = readArgs(['--calibration-excluded-reason', '   '])
  assert.equal(blank.calibrationExcluded, true)
  assert.equal(blank.calibrationExcludedReason, null)
  assert.equal(
    backendEnvironment(blank, {}).TRACKER_CALIBRATION_EXCLUDED_REASON, undefined,
  )
})

test('preview uses the collector Python configured for the bridge without loading its secrets', () => {
  const environment = collectorPythonEnvironment({}, {
    configPath: 'fixture.env',
    readFile: () => [
      'TRACKER_BRIDGE_PASSWORD=must-not-leak',
      'TRACKER_PLAYER_PYTHON=C:\\Python With Numpy\\python.exe',
    ].join('\n'),
  })
  assert.equal(environment.TRACKER_PLAYER_PYTHON, 'C:\\Python With Numpy\\python.exe')
  assert.equal(environment.TRACKER_BRIDGE_PASSWORD, undefined)
})

test('a missing collector dependency stops preview before the tracker can launch', () => {
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    return {
      status: 1,
      stderr: "ModuleNotFoundError: No module named 'numpy'",
    }
  }
  assert.throws(
    () => assertCollectorPythonReady(
      { replay: null }, { TRACKER_PLAYER_PYTHON: 'fixture-python' }, run,
    ),
    /stopped before launching the tracker/,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'fixture-python')
  assert.deepEqual(calls[0].args,
    ['-c', 'import numpy, dolphin_memory_engine, collect_player_tracking'])
  assert.equal(calls[0].options.cwd, path.resolve('scripts'))
})

test('archive replay does not require live collector dependencies', () => {
  let called = false
  assert.equal(assertCollectorPythonReady(
    { replay: 'capture' }, {}, () => { called = true },
  ), null)
  assert.equal(called, false)
})

test('a free port is free', async () => {
  // Port 1 on loopback is not listening; connect refuses immediately.
  assert.equal(await probePort(1, { timeoutMs: 300 }), false)
  await assertApiPortIsFree(1)
})

test('a port serving the preview API is named along with what it is', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ mode: 'local_preview', writes_enabled: false }))
  })
  const port = await listen(server, t)
  await assert.rejects(
    assertApiPortIsFree(port),
    (error) => /already serving local_preview/.test(error.message)
      && new RegExp(`port ${port}`).test(error.message),
  )
})

test('a bridge holding the port is called out as writing to Supabase', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ mode: 'live_bridge', writes_enabled: true }))
  })
  const port = await listen(server, t)
  await assert.rejects(assertApiPortIsFree(port), /writes to Supabase/)
})

test('a port held by something that is not an HTTP server is still refused', async (t) => {
  // The case that used to pass as "free": nothing answers the /state request,
  // the error is swallowed, and the backend then fails to bind with a message
  // that names neither the port nor the reason.
  const server = net.createServer((socket) => { socket.resume() })
  const port = await listen(server, t)
  assert.equal(await probePort(port), true)
  await assert.rejects(
    assertApiPortIsFree(port),
    (error) => /does not answer the tracker API/.test(error.message)
      && /--api-port/.test(error.message),
  )
})

test('a port held by an HTTP server that never answers is refused, not waited on', async (t) => {
  const server = http.createServer(() => { /* deliberately no response */ })
  const port = await listen(server, t)
  const started = Date.now()
  await assert.rejects(assertApiPortIsFree(port), /already serving/)
  assert.ok(Date.now() - started < 5000, 'the refusal must not wait out a hung server')
})

// THE COMPREHENSIVE EVIDENCE PROFILE is refused before any game starts when
// nobody has said who held which remote. The collector would refuse it too, but
// only once a match was live -- after the one-shot session had begun.
test('the standard profile needs no session metadata and runs no check', () => {
  let called = false
  assert.equal(assertEvidenceProfileReady({}, () => { called = true }), null)
  assert.equal(called, false)
})

test('the comprehensive profile without metadata stops before launch', () => {
  assert.throws(
    () => assertEvidenceProfileReady({ TRACKER_EVIDENCE_PROFILE: 'comprehensive' }, () => {
      throw new Error('the validator must not run without a file')
    }),
    /TRACKER_SESSION_METADATA/,
  )
})

test('an unknown profile name is refused rather than treated as standard', () => {
  assert.throws(() => assertEvidenceProfileReady({ TRACKER_EVIDENCE_PROFILE: 'everything' }),
    /standard or comprehensive/)
})

test('invalid metadata stops before launch with the validator reason', () => {
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args })
    return { status: 2, stderr: "ports['1'].remote_label is still the example placeholder" }
  }
  assert.throws(() => assertEvidenceProfileReady({
    TRACKER_EVIDENCE_PROFILE: 'comprehensive',
    TRACKER_SESSION_METADATA: 'meta.json',
    TRACKER_PLAYER_PYTHON: 'fixture-python',
  }, run), /example placeholder/)
  assert.equal(calls[0].command, 'fixture-python')
  assert.deepEqual(calls[0].args, [
    path.resolve('scripts/capture_evidence_schema.py'), '--validate-metadata', path.resolve('meta.json'),
  ])
})

test('valid metadata is summarised and handed to the collector as arguments', () => {
  const environment = {
    TRACKER_EVIDENCE_PROFILE: 'comprehensive', TRACKER_SESSION_METADATA: 'meta.json',
  }
  const summary = assertEvidenceProfileReady(environment, () => ({
    status: 0, stdout: JSON.stringify({ valid: true, ports: { 1: { player: 'Jason' } } }),
  }))
  assert.equal(summary.ports[1].player, 'Jason')
  assert.deepEqual(collectorEvidenceArgs(environment), [
    '--evidence-profile', 'comprehensive', '--session-metadata', path.resolve('meta.json'),
  ])
  assert.deepEqual(collectorEvidenceArgs({}), [])
})

test('real validator: the shipped example is refused as a placeholder', () => {
  assert.throws(() => assertEvidenceProfileReady({
    ...process.env,
    TRACKER_EVIDENCE_PROFILE: 'comprehensive',
    TRACKER_SESSION_METADATA: 'data/calibration/evidence-session-metadata.example.json',
  }), /placeholder/)
})

