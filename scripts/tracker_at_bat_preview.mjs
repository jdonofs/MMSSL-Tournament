// Local, read-only one-at-bat preview. This process never creates a Supabase
// client and never writes a game row; it only launches the patched tracker,
// parses stdout in memory, and exposes the latest snapshot on localhost.
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import {
  applyTrackerPreviewMessage,
  clearTrackerPreviewAtBats,
  createTrackerPreviewState,
  setTrackerPreviewStadiumOverride,
  trackerPreviewSnapshot,
} from './tracker_preview_state.mjs'

const env = { ...process.env }
const DEFAULT_EXE = path.resolve('sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v25.exe')
const EXE_PATH = path.resolve(env.TRACKER_EXE_PATH || DEFAULT_EXE)
const PORT = Number(env.TRACKER_PREVIEW_PORT || 4317)
const state = createTrackerPreviewState()

if (!fs.existsSync(EXE_PATH)) throw new Error(`Tracker executable not found at ${EXE_PATH}`)

const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Cache-Control', 'no-store')
  const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${PORT}`)
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    response.end()
    return
  }
  // Choosing the stadium by hand is the only way to check field placement in a
  // session where the tracker never prints a "A vs. B @ Stadium" line, which is
  // most of them. Still read-only with respect to Supabase: this only changes
  // which geometry the in-memory projection uses.
  if (requestUrl.pathname === '/stadium' && request.method === 'POST') {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 4096) request.destroy()
    })
    request.on('end', () => {
      let stadiumKey = null
      try {
        ({ stadium_key: stadiumKey } = JSON.parse(body || '{}'))
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'Body must be JSON: {"stadium_key": "mario_stadium"}' }))
        return
      }
      if (!setTrackerPreviewStadiumOverride(state, stadiumKey)) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: `Unknown stadium key: ${stadiumKey}` }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(trackerPreviewSnapshot(state, {
        selectedPaNumber: requestUrl.searchParams.get('at_bat'),
      })))
    })
    return
  }
  if (requestUrl.pathname === '/pitch-diagnostics') {
    const snapshot = trackerPreviewSnapshot(state)
    const diagnostics = snapshot.session_pitch_diagnostics
    if (!diagnostics?.at_bat_count) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'No at-bat is available yet' }))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="pitch-diagnostics-session.json"',
    })
    response.end(JSON.stringify(diagnostics, null, 2))
    return
  }
  if (requestUrl.pathname !== '/state') {
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      error: 'Use GET /state (optionally ?at_bat=N), GET /pitch-diagnostics, or POST /stadium',
    }))
    return
  }
  // ?at_bat=N pages back to an earlier at-bat in this session. Only the
  // requested one is serialized, so paging through a long session costs the
  // same per poll as watching the live at-bat does.
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(trackerPreviewSnapshot(state, {
    selectedPaNumber: requestUrl.searchParams.get('at_bat'),
  })))
})

// Terminal scrollback is finite and gets lost once it fills up mid-session —
// this file is the durable record so a session can be traced after the fact
// without needing to have kept the console open. Truncated fresh each launch.
const SESSION_LOG_PATH = path.resolve('sluggers-stat-tracker-advanced-stats-dev/preview-session.log')
fs.writeFileSync(SESSION_LOG_PATH, `[tracker-preview] session started ${new Date().toISOString()} · exe=${EXE_PATH}\n`)
const sessionLogStream = fs.createWriteStream(SESSION_LOG_PATH, { flags: 'a' })

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tracker-preview] local read-only feed: http://127.0.0.1:${PORT}/state`)
  console.log('[tracker-preview] database writes: DISABLED')
  console.log(`[tracker-preview] launching tracker: ${EXE_PATH}`)
  console.log(`[tracker-preview] full session log (survives scrollback loss): ${SESSION_LOG_PATH}`)
})

const child = spawn(EXE_PATH, [], { cwd: path.dirname(EXE_PATH) })
state.trackerPid = child.pid || null
state.trackerStatus = 'tracker launched; waiting for Dolphin'

const LOG_LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.*)$/
function handleLine(line) {
  const clean = String(line || '').trim()
  if (!clean) return
  console.log(clean)
  sessionLogStream.write(`${clean}\n`)
  const match = clean.match(LOG_LINE_RE)
  applyTrackerPreviewMessage(state, match ? match[3] : clean)
}
readline.createInterface({ input: child.stdout }).on('line', handleLine)
readline.createInterface({ input: child.stderr }).on('line', handleLine)

child.on('error', (error) => {
  state.trackerStatus = `tracker launch failed: ${error.message}`
  console.error('[tracker-preview]', state.trackerStatus)
})
child.on('exit', (code) => {
  state.trackerStatus = `tracker exited with code ${code}`
  state.trackerPid = null
  // The session's at-bats are held only for as long as the tracker that
  // produced them is running. The session log on disk is the record that
  // survives; nothing here is meant to outlive the process it came from.
  clearTrackerPreviewAtBats(state)
  console.log(`[tracker-preview] ${state.trackerStatus}; cleared this session's at-bats`)
})

function shutdown() {
  try { child.kill() } catch { /* already stopped */ }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
