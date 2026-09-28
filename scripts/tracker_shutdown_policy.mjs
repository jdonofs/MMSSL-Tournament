export const INTERRUPTED_SHUTDOWN_TIMEOUT_MS = 30_000
export const POSTGAME_SHUTDOWN_TIMEOUT_MS = 10 * 60_000

const POSTGAME_REASONS = new Set(['tracker_exit', 'game_completed', 'manual_stop'])

export function trackerShutdownTimeoutMs(reason = 'signal') {
  return POSTGAME_REASONS.has(reason)
    ? POSTGAME_SHUTDOWN_TIMEOUT_MS
    : INTERRUPTED_SHUTDOWN_TIMEOUT_MS
}
