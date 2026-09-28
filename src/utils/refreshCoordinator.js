// Collapse bursts of invalidations without allowing a steady event stream to
// postpone a refresh forever. Requests received during a load become one
// trailing load. Hidden tabs remember that they are stale and reconcile when
// resume() is called, instead of polling while nobody can see the result.
export function createRefreshCoordinator({
  run,
  delayMs = 250,
  maxWaitMs = 1500,
  isPaused = () => false,
  onError = (error) => console.warn('[refresh] background refresh failed', error),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createRefreshCoordinator requires run')

  let disposed = false
  let inFlight = false
  let pending = false
  let firstPendingAt = 0
  let timer = null

  const clearScheduled = () => {
    if (timer != null) clearTimer(timer)
    timer = null
  }

  const execute = async () => {
    clearScheduled()
    if (disposed) return
    if (isPaused()) {
      pending = true
      return
    }
    if (inFlight) {
      pending = true
      return
    }

    pending = false
    firstPendingAt = 0
    inFlight = true
    try {
      await run()
    } catch (error) {
      if (!disposed) onError(error)
    } finally {
      inFlight = false
      if (pending && !disposed && !isPaused()) schedule()
    }
  }

  const schedule = ({ immediate = false } = {}) => {
    if (disposed) return
    pending = true
    if (isPaused()) return
    if (inFlight) return

    const currentTime = now()
    if (!firstPendingAt) firstPendingAt = currentTime
    const remaining = Math.max(0, maxWaitMs - (currentTime - firstPendingAt))
    const wait = immediate ? 0 : Math.min(delayMs, remaining)
    clearScheduled()
    timer = setTimer(execute, wait)
  }

  return {
    request: schedule,
    resume() {
      if (pending && !disposed) schedule({ immediate: true })
    },
    dispose() {
      disposed = true
      pending = false
      clearScheduled()
    },
    getState() {
      return { disposed, inFlight, pending, scheduled: timer != null }
    },
  }
}
