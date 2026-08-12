// Local, read-only one-at-bat preview. This process never creates a Supabase
// client and never writes a game row; it only launches the patched tracker,
// parses stdout in memory, and exposes the latest snapshot on localhost.
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { applyTrackerPreviewMessage, createTrackerPreviewState, trackerPreviewSnapshot } from './tracker_preview_state.mjs'

const env = { ...process.env }
const DEFAULT_EXE = path.resolve('sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v12.exe')
const EXE_PATH = path.resolve(env.TRACKER_EXE_PATH || DEFAULT_EXE)
const PORT = Number(env.TRACKER_PREVIEW_PORT || 4317)
const state = createTrackerPreviewState()

if (!fs.existsSync(EXE_PATH)) throw new Error(`Tracker executable not found at ${EXE_PATH}`)

const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Cache-Control', 'no-store')
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS' })
    response.end()
    return
  }
  if (request.url !== '/state') {
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'Use GET /state' }))
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(trackerPreviewSnapshot(state)))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tracker-preview] local read-only feed: http://127.0.0.1:${PORT}/state`)
  console.log('[tracker-preview] database writes: DISABLED')
  console.log(`[tracker-preview] launching tracker: ${EXE_PATH}`)
})

const child = spawn(EXE_PATH, [], { cwd: path.dirname(EXE_PATH) })
state.trackerPid = child.pid || null
state.trackerStatus = 'tracker launched; waiting for Dolphin'

const LOG_LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.*)$/
function handleLine(line) {
  const clean = String(line || '').trim()
  if (!clean) return
  console.log(clean)
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
  console.log(`[tracker-preview] ${state.trackerStatus}`)
})

function shutdown() {
  try { child.kill() } catch { /* already stopped */ }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
