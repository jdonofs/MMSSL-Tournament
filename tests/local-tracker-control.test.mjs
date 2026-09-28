import assert from 'node:assert/strict'
import test from 'node:test'
import { stopLocalTrackerForGame } from '../src/features/scorebook/services/localTrackerControl.js'

test('stopping a game waits for both the launcher and the recording bridge', async (t) => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch })
  globalThis.window = { location: { hostname: 'msl-tournament.vercel.app' } }
  const calls = []
  let launcherStopped = false
  let bridgeStopped = false
  globalThis.fetch = async (url, options = {}) => {
    const route = new URL(url).pathname
    calls.push(`${options.method || 'GET'} ${route}`)
    const reply = (value, status = 200) => new Response(JSON.stringify(value), { status })
    if (route === '/status') return reply({ service: 'sluggers-game-control',
      phase: launcherStopped ? 'stopped' : 'game_live', gameId: 42, table: 'season_schedule' })
    if (route === '/stop') { launcherStopped = true; return reply({ phase: 'stopping' }, 202) }
    if (route === '/state') {
      if (bridgeStopped) throw new TypeError('connection refused')
      return reply({ writes_enabled: true, game: { game_id: 42, games_table: 'season_schedule' } })
    }
    if (route === '/shutdown') { bridgeStopped = true; return reply({ accepted: true }, 202) }
    throw new Error(`Unexpected route ${route}`)
  }
  assert.deepEqual(await stopLocalTrackerForGame({ gameId: 42, table: 'season_schedule' }), { stopped: true })
  assert.deepEqual(calls, ['GET /status', 'POST /stop', 'GET /status',
    'GET /state', 'POST /shutdown', 'GET /state'])
})

test('a selected game cannot stop a different game’s tracker', async (t) => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch })
  globalThis.window = { location: { hostname: 'msl-tournament.vercel.app' } }
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const route = new URL(url).pathname
    calls.push(`${options.method || 'GET'} ${route}`)
    if (route === '/status') return new Response(JSON.stringify({ service: 'sluggers-game-control',
      phase: 'game_live', gameId: 99, table: 'games' }))
    if (route === '/state') return new Response(JSON.stringify({ writes_enabled: true,
      game: { game_id: 99, games_table: 'games' } }))
    throw new Error(`Unexpected route ${route}`)
  }
  assert.deepEqual(await stopLocalTrackerForGame({ gameId: 42, table: 'season_schedule' }), { stopped: false })
  assert.deepEqual(calls, ['GET /status', 'GET /state'])
})

test('an already running bridge can be stopped without the site launcher', async (t) => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch })
  globalThis.window = { location: { hostname: 'msl-tournament.vercel.app' } }
  let stopped = false
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname
    if (route === '/status') throw new TypeError('helper offline')
    if (route === '/state') {
      if (stopped) throw new TypeError('bridge offline')
      return new Response(JSON.stringify({ writes_enabled: true, tracker_pid: 1234,
        game: { game_id: 42, games_table: 'season_schedule' } }))
    }
    if (route === '/shutdown') { stopped = true; return new Response(JSON.stringify({ accepted: true }), { status: 202 }) }
    throw new Error(`Unexpected route ${route}`)
  }
  assert.deepEqual(await stopLocalTrackerForGame({ gameId: 42, table: 'season_schedule' }), { stopped: true })
})
