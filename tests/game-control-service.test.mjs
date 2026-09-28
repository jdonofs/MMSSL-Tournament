import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createGameControlServer } from '../scripts/game_control_service.mjs'

test('the local button starts one pinned game and reports launcher progress', async (t) => {
  const calls = []
  const child = new EventEmitter()
  child.pid = 1234
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.connected = true
  const messages = []
  child.send = (message) => messages.push(message)
  const control = createGameControlServer({
    port: 0,
    origins: ['https://sluggers.example'],
    spawnChild: (...args) => { calls.push(args); return child },
  })
  await control.listen()
  t.after(() => control.server.close())
  const base = `http://127.0.0.1:${control.server.address().port}`
  const request = (gameId, table, origin = 'https://sluggers.example') => fetch(`${base}/start`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId, table }),
  })

  assert.equal((await request(42, 'games', 'https://other.example')).status, 403)
  assert.equal((await request(0, 'games')).status, 400)
  assert.equal(calls.length, 0)

  const started = await request(42, 'season_schedule')
  assert.equal(started.status, 202)
  assert.deepEqual(calls[0][1].slice(-4), ['--game', '42', '--table', 'season_schedule'])
  assert.equal(calls[0][2].windowsHide, true)
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
  assert.equal((await request(43, 'games')).status, 409)

  child.stdout.write('Driving the menus. Start from the MAIN MENU\n')
  const status = await (await fetch(`${base}/status`, {
    headers: { Origin: 'https://sluggers.example' },
  })).json()
  assert.equal(status.phase, 'selecting_teams')
  assert.equal(status.gameId, 42)
  const stop = (gameId, table) => fetch(`${base}/stop`, {
    method: 'POST', headers: { Origin: 'https://sluggers.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId, table }),
  })
  assert.equal((await stop(43, 'season_schedule')).status, 409)
  assert.deepEqual(messages, [])
  assert.equal((await stop(42, 'season_schedule')).status, 202)
  assert.deepEqual(messages, [{ type: 'stop' }])
  assert.equal(control.state().phase, 'stopping')
  child.exitCode = 1
  child.emit('close', 1)
  assert.equal(control.state().phase, 'stopped')
})

test('the deployed Scorebook origin can read status and preflight a start', async (t) => {
  const control = createGameControlServer({ port: 0 })
  await control.listen()
  t.after(() => control.server.close())
  const base = `http://127.0.0.1:${control.server.address().port}`
  const origin = 'https://msl-tournament.vercel.app'
  const status = await fetch(`${base}/status`, { headers: { Origin: origin } })
  assert.equal(status.status, 200)
  assert.equal(status.headers.get('access-control-allow-origin'), origin)
  assert.equal((await status.json()).service, 'sluggers-game-control')
  const preflight = await fetch(`${base}/start`, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  } })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/)
})
