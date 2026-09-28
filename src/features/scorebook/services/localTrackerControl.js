const PREVIEW_URL = 'http://127.0.0.1:4317'

function gameControlUrl() {
  return ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? `${window.location.origin}/game-control`
    : 'http://127.0.0.1:4318'
}

async function readLocalJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Local tracker returned ${response.status}`)
    return response.json()
  } catch (error) {
    if (error instanceof TypeError) return null // no local process is listening
    throw error
  }
}

async function waitUntilStopped(read, isRunning, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await read()
    if (!status || !isRunning(status)) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`${label} did not finish stopping. Nothing was reset.`)
}

export async function stopLocalTrackerForGame({ gameId, table }) {
  const controlUrl = gameControlUrl()
  const sameGame = (state) => String(state?.gameId) === String(gameId) && state?.table === table
  const launcher = await readLocalJson(`${controlUrl}/status`)
  if (launcher && launcher.service !== 'sluggers-game-control') {
    throw new Error('Another service is using the game launcher port. Nothing was reset.')
  }
  let stopped = false
  if (sameGame(launcher) && ['starting', 'selecting_teams', 'game_live', 'stopping'].includes(launcher.phase)) {
    const response = await fetch(`${controlUrl}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, table }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `Could not stop launcher (${response.status})`)
    stopped = true
    // Past the handoff the launcher asks the bridge to stop and waits for it,
    // postgame derivation and ingest included; the bridge allows itself 120 s.
    await waitUntilStopped(() => readLocalJson(`${controlUrl}/status`),
      (state) => sameGame(state) && ['starting', 'selecting_teams', 'game_live', 'stopping'].includes(state.phase),
      'The game launcher', 130000)
  }

  const preview = await readLocalJson(`${PREVIEW_URL}/state`)
  // A launcher that finished stopping has outlived its bridge, so no preview
  // is the expected answer then, not an unconfirmed one.
  if (launcher?.phase === 'game_live' && !preview && !stopped) {
    throw new Error('The tracker status is unavailable, so its shutdown could not be confirmed. Nothing was reset.')
  }
  if (!preview?.writes_enabled) return { stopped }
  if (String(preview.game?.game_id) !== String(gameId) || preview.game?.games_table !== table) {
    return { stopped }
  }
  if (!stopped && !preview.tracker_pid && !/exited/i.test(preview.tracker_status || '')) {
    throw new Error('This tracker is still starting outside the site launcher. Stop its terminal before resetting the game.')
  }
  const response = await fetch(`${PREVIEW_URL}/shutdown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId, table }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Could not stop tracker (${response.status})`)
  await waitUntilStopped(() => readLocalJson(`${PREVIEW_URL}/state`),
    (state) => state.writes_enabled && String(state.game?.game_id) === String(gameId)
      && state.game?.games_table === table,
    'The tracker', 125000)
  return { stopped: true }
}
