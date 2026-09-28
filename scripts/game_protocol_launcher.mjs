// Invoked by Windows for sluggers-game://start links on the deployed site.
// It starts the localhost helper on demand, asks it to run one pinned game,
// then exits. The helper closes after the page stops polling and the game ends.
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'game_control_service.mjs')
const BASE = 'http://127.0.0.1:4318'

export function parseGameLink(raw) {
  const link = new URL(raw)
  const gameId = Number(link.searchParams.get('game'))
  const table = link.searchParams.get('table')
  if (link.protocol !== 'sluggers-game:' || link.hostname !== 'start'
    || link.pathname !== '' || link.username || link.password || link.port
    || [...link.searchParams.keys()].sort().join(',') !== 'game,table'
    || !Number.isSafeInteger(gameId) || gameId < 1
    || !['games', 'season_schedule'].includes(table)) {
    throw new Error('Invalid Sluggers game link.')
  }
  return { gameId, table }
}

export async function launchFromLink(raw, { spawnChild = spawn, fetchApi = fetch } = {}) {
  const { gameId, table } = parseGameLink(raw)
  const online = async () => {
    try {
      const response = await fetchApi(`${BASE}/status`, { signal: AbortSignal.timeout(500) })
      return response.ok && (await response.json()).service === 'sluggers-game-control'
    } catch { return false }
  }
  if (!await online()) {
    const child = spawnChild(process.execPath, [SERVICE], {
      cwd: path.dirname(path.dirname(SERVICE)),
      detached: true, stdio: 'ignore', windowsHide: true,
      env: process.env,
    })
    child.unref?.()
    const deadline = Date.now() + 5000
    while (!await online()) {
      if (Date.now() >= deadline) throw new Error('Local game helper did not start.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const response = await fetchApi(`${BASE}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId, table }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Local game helper returned ${response.status}.`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchFromLink(process.argv[2]).catch((error) => {
    console.error(`[game-link] ${error.message}`)
    process.exitCode = 1
  })
}
