// The preview launcher's port handshake. It refuses to attach to an existing
// service, and the interesting cases are the occupants that do not answer
// like one.

import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import test from 'node:test'

import { assertApiPortIsFree, probePort } from '../scripts/tracker_preview.mjs'

function listen(server, t) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)))
      resolve(server.address().port)
    })
  })
}

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
