// One operator command for tracker testing.
//
//   npm run tracker:preview
//   npm run tracker:preview -- --replay data/player_tracking/<stem>
//
// The default starts all four pieces a test game needs: the patched tracker,
// the 60 Hz collector, the localhost JSON API, and this app at the validation
// console route. The backend remains the owner of capture shutdown so Ctrl-C
// can flush the raw recording and finish the authoritative postgame pass.

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { assertEvidenceProfileReady } from './tracker_collector_feed.mjs'

export function readArgs(argv) {
  const options = {
    apiPort: Number(process.env.TRACKER_PREVIEW_PORT || 4317),
    uiPort: Number(process.env.TRACKER_PREVIEW_UI_PORT || 5173),
    open: !['0', 'false', 'no', 'off'].includes(
      String(process.env.TRACKER_PREVIEW_OPEN ?? '').trim().toLowerCase(),
    ),
    replay: null,
    calibrationExcluded: false,
    calibrationExcludedReason: null,
    backendArgs: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--replay' || token === '--session') {
      options.replay = argv[index += 1] || null
    } else if (token === '--api-port') {
      options.apiPort = Number(argv[index += 1])
    } else if (token === '--ui-port') {
      options.uiPort = Number(argv[index += 1])
    } else if (token === '--no-open') {
      options.open = false
    } else if (token === '--calibration-excluded') {
      options.calibrationExcluded = true
    // A reason given without the flag is an operator saying why this session
    // does not count, so it excludes on its own. The alternative is a typed
    // sentence that silently does nothing and a capture that counts anyway.
    } else if (token === '--calibration-excluded-reason') {
      options.calibrationExcludedReason = String(argv[index += 1] ?? '').trim() || null
      options.calibrationExcluded = true
    } else {
      options.backendArgs.push(token)
    }
  }
  return options
}

export function backendEnvironment(options, environment = process.env) {
  return {
    ...environment,
    TRACKER_PREVIEW_PORT: String(options.apiPort),
    ...(options.calibrationExcluded ? { TRACKER_CALIBRATION_EXCLUDED: '1' } : {}),
    // Without this the collector writes its own default -- "stadium research:
    // balls deliberately not fielded so they reach the hazard" -- onto every
    // excluded capture, including the ones that were excluded for something
    // else entirely. mario_stadium-20260923T012536Z was a scripted slap/charge
    // game and its header says it was stadium research.
    ...(options.calibrationExcludedReason
      ? { TRACKER_CALIBRATION_EXCLUDED_REASON: options.calibrationExcludedReason }
      : {}),
  }
}

// The live bridge already reads this setting from .env.tracker-bridge. The
// standalone preview used to ignore that file and fall back to whichever
// `python` happened to be first in the launching shell's PATH. That can be a
// different installation from the one AutoTeam and the bridge use, so the
// tracker game would start normally while the 60 Hz collector failed every
// five seconds with a missing import. Read only this non-secret setting; a
// read-only preview must not inherit the bridge's database credentials.
export function collectorPythonEnvironment(environment = process.env, {
  configPath = path.resolve('.env.tracker-bridge'),
  readFile = (filePath) => fs.readFileSync(filePath, 'utf8'),
} = {}) {
  if (environment.TRACKER_PLAYER_PYTHON) return { ...environment }
  let configured = null
  try {
    for (const line of readFile(configPath).split(/\r?\n/)) {
      const match = line.trim().match(/^TRACKER_PLAYER_PYTHON\s*=\s*(.*)$/)
      if (!match) continue
      configured = match[1].trim().replace(/^(['"])(.*)\1$/, '$2')
      break
    }
  } catch { /* no local bridge environment; the ordinary PATH fallback remains */ }
  return configured ? { ...environment, TRACKER_PLAYER_PYTHON: configured } : { ...environment }
}

// Fail before the native tracker (and therefore before a game) can start. The
// bridge has had this guard since its AutoTeam handshake was added; preview
// needs the same guarantee because fielding/baserunning cannot be recovered
// from the tracker log after a collector import failure.
export function assertCollectorPythonReady(options, environment = process.env, run = spawnSync) {
  if (options.replay || environment.TRACKER_PLAYER_TRACKING === '0') return null
  const python = String(environment.TRACKER_PLAYER_PYTHON || 'python')
  const check = run(python,
    ['-c', 'import numpy, dolphin_memory_engine, collect_player_tracking'], {
      cwd: path.resolve('scripts'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: environment,
    })
  if (check.error || check.status !== 0) {
    const detail = check.error?.message || String(check.stderr || '').trim()
      || `exit code ${check.status}`
    throw new Error(`60 Hz collector Python is not ready (${python}): ${detail}. `
      + 'Set TRACKER_PLAYER_PYTHON to a Python with numpy and dolphin-memory-engine installed; '
      + 'the preview stopped before launching the tracker.')
  }
  return python
}

function backendCommand(options) {
  if (options.replay) {
    return {
      file: path.resolve('scripts/tracker_replay_preview.mjs'),
      args: ['--session', options.replay, '--port', String(options.apiPort), ...options.backendArgs],
      label: `archive replay: ${options.replay}`,
    }
  }
  return {
    file: path.resolve('scripts/tracker_at_bat_preview.mjs'),
    args: options.backendArgs,
    label: 'live tracker + 60 Hz capture',
  }
}

async function fetchPreviewState(port, timeoutMs = 750) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/state`, {
      cache: 'no-store', signal: controller.signal,
    })
    return { response, body: await response.json().catch(() => null) }
  } finally {
    clearTimeout(timeout)
  }
}

// Can anything be connected to on this port at all. Asked before the HTTP
// question, because the HTTP question cannot tell "nothing is listening" from
// "something is listening and did not answer in time" -- and it used to answer
// both with "the port is free". The occupant was then discovered by the
// backend failing to bind, which surfaced as "Tracker backend exited before
// startup" and named neither the port nor the reason.
export function probePort(port, { timeoutMs = 750, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (occupied) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(occupied)
    }
    socket.setTimeout(timeoutMs, () => done(true))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export async function assertApiPortIsFree(port, deps = {}) {
  const probe = deps.probePort || probePort
  const identify = deps.fetchPreviewState || fetchPreviewState
  if (!await probe(port)) return

  // Something is there. Try to say what, because "stop the other preview" and
  // "pick another port" are different instructions.
  let description = 'something that does not answer the tracker API'
  try {
    const existing = await identify(port)
    const mode = existing.body?.mode || `HTTP ${existing.response.status}`
    const writes = existing.body?.writes_enabled === true ? ' and it writes to Supabase' : ''
    description = `${mode}${writes}`
  } catch { /* occupied by something that is not this API; the port is what matters */ }
  throw new Error(
    `Tracker API port ${port} is already serving ${description}. `
    + 'Stop that process first, or pass --api-port <free port>; preview refuses to '
    + 'attach to an existing service.',
  )
}

async function waitForReadOnlyBackend(port, backendExit, expectedMode) {
  let exit = null
  backendExit.then((result) => { exit = result })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (exit) {
      throw exit.error || new Error(`Tracker backend exited before startup (code ${exit.code})`)
    }
    try {
      const { response, body } = await fetchPreviewState(port)
      if (!response.ok || !body) throw new Error(`Tracker API returned HTTP ${response.status}`)
      if (body.writes_enabled !== false) {
        throw new Error('Safety stop: this API reports database writes enabled')
      }
      if (body.mode !== expectedMode) {
        throw new Error(`Safety stop: expected ${expectedMode}, but API reports ${body.mode || 'no mode'}`)
      }
      return body
    } catch (error) {
      if (/Safety stop/.test(error.message)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Tracker backend did not become ready on port ${port}`)
}

// Ask first, then insist, then stop waiting. Throwing while the backend is
// still running left it holding the API port, so the next attempt failed for a
// reason that had nothing to do with the original one.
async function stopBackend(child, backendExit, { graceMs = 3000 } = {}) {
  if (child.connected) child.send({ type: 'tracker-preview-shutdown' })
  else { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  const timedOut = Symbol('timeout')
  const raced = await Promise.race([
    backendExit,
    new Promise((resolve) => { setTimeout(() => resolve(timedOut), graceMs).unref?.() }),
  ])
  if (raced !== timedOut) return
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  await Promise.race([
    backendExit,
    new Promise((resolve) => { setTimeout(resolve, graceMs).unref?.() }),
  ])
}

async function main() {
  const options = readArgs(process.argv.slice(2))
  if (!Number.isInteger(options.apiPort) || options.apiPort < 1
    || !Number.isInteger(options.uiPort) || options.uiPort < 1) {
    throw new Error('Preview ports must be positive integers')
  }
  if (process.argv.slice(2).some((token) => ['--replay', '--session'].includes(token))
    && !options.replay) {
    throw new Error('Use --replay <capture stem>')
  }

  await assertApiPortIsFree(options.apiPort)
  const childEnvironment = collectorPythonEnvironment(process.env)
  assertCollectorPythonReady(options, childEnvironment)
  if (!options.replay) {
    const evidence = assertEvidenceProfileReady(childEnvironment)
    if (evidence) {
      console.log('[tracker-preview] comprehensive evidence capture; ports: '
        + Object.entries(evidence.ports || {}).map(([port, entry]) =>
          `${port}=${entry.player} (${entry.remote_label})`).join(', '))
    }
  }
  // vite.config.js reads this when it installs the quiet localhost API proxy.
  // Keeping it on this process also makes custom --api-port values work.
  process.env.TRACKER_PREVIEW_PORT = String(options.apiPort)

  const backend = backendCommand(options)
  const child = spawn(process.execPath, [backend.file, ...backend.args], {
    cwd: process.cwd(),
    env: backendEnvironment(options, childEnvironment),
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  })
  const backendExit = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: 1, error }))
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }))
  })

  try {
    await waitForReadOnlyBackend(
      options.apiPort,
      backendExit,
      options.replay ? 'archive_replay' : 'local_preview',
    )
  } catch (error) {
    await stopBackend(child, backendExit)
    throw error
  }

  let vite
  try {
    vite = await createViteServer({
      configFile: path.resolve('vite.config.js'),
      server: {
        host: '127.0.0.1',
        port: options.uiPort,
        // A stale Vite instance is almost always a stale preview tab too. Do
        // not silently move to 5174 and leave two consoles polling different
        // sessions; fail with the exact occupied port instead.
        strictPort: true,
        open: options.open ? '/tracker-preview.html' : false,
      },
    })
    await vite.listen()
  } catch (error) {
    await stopBackend(child, backendExit)
    throw error
  }

  const address = vite.httpServer.address()
  const uiPort = typeof address === 'object' && address ? address.port : options.uiPort
  const pageUrl = `http://127.0.0.1:${uiPort}/tracker-preview.html`
  console.log('')
  console.log('[tracker-preview] ONE-STOP TRACKER TESTING')
  console.log(`[tracker-preview] page: ${pageUrl}`)
  console.log(`[tracker-preview] mode: ${backend.label}`)
  console.log('[tracker-preview] Supabase: HARD DISABLED (startup verified)')
  console.log('[tracker-preview] raw memory, tracker logs, joins and metric evidence are shown on this page')
  console.log('[tracker-preview] Ctrl-C stops the session and waits for the capture to flush')
  console.log('')

  let stopping = false
  const requestStop = () => {
    if (stopping) {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      return
    }
    stopping = true
    console.log('[tracker-preview] stopping; waiting for the tracker backend to finish...')
    // On Windows Ctrl-C normally reaches both processes. The IPC message is a
    // fallback for shells that deliver it only to this launcher; the backend
    // ignores the message if it is already shutting down.
    if (child.connected) child.send({ type: 'tracker-preview-shutdown' })
    else {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }
  process.on('SIGINT', requestStop)
  process.on('SIGTERM', requestStop)

  const exit = await backendExit
  await vite.close()
  if (exit.error) throw exit.error
  process.exitCode = exit.code
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((error) => {
    console.error('[tracker-preview]', error.message)
    process.exitCode = 1
  })
}
