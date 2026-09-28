// Local control surface for the Scorebook's Start Game button. This process is
// kept running on the Dolphin computer; each click starts the existing launcher
// with an explicit game id and table, so no interactive terminal picker is used.
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCHER = path.join(ROOT, 'scripts', 'mss_autogame.mjs')
const DEFAULT_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173',
  'https://msl-tournament.vercel.app']

export function createGameControlServer({
  port = Number(process.env.GAME_CONTROL_PORT || 4318),
  origins = [...DEFAULT_ORIGINS, ...(process.env.GAME_CONTROL_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)],
  spawnChild = spawn,
  now = () => new Date().toISOString(),
} = {}) {
  const allowed = new Set(origins)
  const state = { phase: 'idle', gameId: null, table: null, pid: null, startedAt: null,
    finishedAt: null, exitCode: null, lines: [] }
  let child = null
  let lastPageContact = Date.now()
  const snapshot = () => ({ service: 'sluggers-game-control', ...state, lines: state.lines.slice() })
  const addLine = (line) => {
    if (!line) return
    state.lines.push(line)
    if (state.lines.length > 80) state.lines.splice(0, state.lines.length - 80)
    if (state.phase !== 'stopping') {
      if (/Driving the menus/.test(line)) state.phase = 'selecting_teams'
      // A timed-out handoff still releases the tracker into a running match.
      if (/match is live at a pitch reset|Handed off on a confirmed pitch reset|releasing the tracker/.test(line)) state.phase = 'game_live'
    }
  }
  const respond = (response, status, data) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(data))
  }
  const server = http.createServer(async (request, response) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
      respond(response, 403, { error: 'Game control is only available on this computer.' })
      return
    }
    const origin = request.headers.origin
    if (origin && !allowed.has(origin)) {
      respond(response, 403, { error: 'This site is not allowed to control the local game launcher.' })
      return
    }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
    if (origin) lastPageContact = Date.now()
    response.setHeader('Vary', 'Origin')
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type' })
      response.end()
      return
    }
    if (request.url === '/status' && request.method === 'GET') {
      respond(response, 200, snapshot())
      return
    }
    if (request.url === '/stop' && request.method === 'POST') {
      if (!child) {
        respond(response, 200, snapshot())
        return
      }
      let body = ''
      try {
        for await (const chunk of request) {
          body += chunk
          if (body.length > 1024) throw new Error('Request is too large.')
        }
        const parsed = JSON.parse(body)
        if (String(parsed.gameId) !== String(state.gameId) || parsed.table !== state.table) {
          respond(response, 409, { error: 'The launcher is running a different game.', ...snapshot() })
          return
        }
        if (typeof child.send !== 'function' || !child.connected) {
          respond(response, 503, { error: 'The launcher cannot receive a stop request.' })
          return
        }
        child.send({ type: 'stop' })
        state.phase = 'stopping'
        respond(response, 202, snapshot())
      } catch (error) {
        respond(response, 400, { error: error.message })
      }
      return
    }
    if (request.url !== '/start' || request.method !== 'POST') {
      respond(response, 404, { error: 'Unknown game control endpoint.' })
      return
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      respond(response, 415, { error: 'Send JSON to start a game.' })
      return
    }
    let body = ''
    try {
      for await (const chunk of request) {
        body += chunk
        if (body.length > 1024) throw new Error('Request is too large.')
      }
      const parsed = JSON.parse(body)
      const gameId = Number(parsed.gameId)
      const table = parsed.table
      if (!Number.isSafeInteger(gameId) || gameId < 1
        || !['games', 'season_schedule'].includes(table)) {
        respond(response, 400, { error: 'A valid game id and table are required.' })
        return
      }
      if (child) {
        respond(response, 409, { error: `Game ${state.gameId} is already launching or running.`, ...snapshot() })
        return
      }
      state.phase = 'starting'
      state.gameId = gameId
      state.table = table
      state.pid = null
      state.startedAt = now()
      state.finishedAt = null
      state.exitCode = null
      state.lines = []
      child = spawnChild(process.execPath, [LAUNCHER, '--game', String(gameId), '--table', table], {
        cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: process.env,
      })
      state.pid = child.pid ?? null
      for (const stream of [child.stdout, child.stderr]) {
        let pending = ''
        stream?.on('data', (chunk) => {
          pending += String(chunk)
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() || ''
          lines.forEach(addLine)
        })
        stream?.on('end', () => addLine(pending))
      }
      let settled = false
      const finish = (code, error) => {
        if (settled) return
        settled = true
        if (error) addLine(error.message)
        state.exitCode = code ?? 1
        state.finishedAt = now()
        state.phase = state.phase === 'stopping' ? 'stopped'
          : state.exitCode === 0 ? 'finished' : 'failed'
        child = null
      }
      child.once('error', (error) => finish(1, error))
      child.once('close', (code) => finish(code))
      respond(response, 202, snapshot())
    } catch (error) {
      respond(response, 400, { error: error.message })
    }
  })
  return { server, state: snapshot,
    isBusy: () => Boolean(child),
    lastPageContact: () => lastPageContact,
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)) }
}

// A locally served site already has a Node process: Vite. Mount the same
// control API there, so opening the local Scorebook needs no second terminal.
export function gameControlVitePlugin() {
  return {
    name: 'sluggers-game-control',
    configureServer(vite) {
      const control = createGameControlServer({ port: 0 })
      vite.middlewares.use('/game-control', (request, response) => {
        control.server.emit('request', request, response)
      })
    },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const control = createGameControlServer()
  control.listen().then(() => {
    console.log(`[game-control] ready at http://127.0.0.1:${control.server.address().port}`)
    const idleCheck = setInterval(() => {
      if (!control.isBusy() && Date.now() - control.lastPageContact() > 30000) {
        clearInterval(idleCheck)
        control.server.close()
      }
    }, 5000)
  }).catch((error) => {
    console.error(`[game-control] ${error.message}`)
    process.exitCode = 1
  })
}
