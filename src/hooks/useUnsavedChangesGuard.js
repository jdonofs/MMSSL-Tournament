import { useCallback, useEffect, useState } from 'react'
import { useBlocker } from 'react-router-dom'

// Blocks in-app navigation (Navbar links, back/forward, redirects) and warns
// on tab close/refresh while `isDirty` is true. Returns the react-router
// blocker so the caller can render a confirmation prompt (see
// UnsavedChangesPrompt) with Save / Discard / Cancel actions.
export function useUnsavedChangesGuard(isDirty) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    // Compare pathname + search (not just pathname) so switching the
    // selected game via a `?game=` query-param change (Scorebook) is
    // treated as a real navigation and gets blocked too.
    isDirty && (
      currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
    )
  ))

  useEffect(() => {
    if (!isDirty) return undefined
    const handleBeforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])

  return blocker
}

// For same-page actions that discard unsaved lineup/fielding state without a
// route change (e.g. switching the viewed team/tournament/game via a select)
// — not covered by useUnsavedChangesGuard's route blocker. Wrap the state
// change in `run`; if dirty, it's deferred behind a confirmation (rendered
// via the same UnsavedChangesPrompt, since the returned object matches the
// react-router blocker shape) instead of applying immediately.
export function useConfirmedAction(isDirty) {
  const [pendingAction, setPendingAction] = useState(null)

  const run = useCallback((action) => {
    if (isDirty) {
      setPendingAction(() => action)
    } else {
      action()
    }
  }, [isDirty])

  const blocker = pendingAction
    ? {
      state: 'blocked',
      proceed: () => {
        const action = pendingAction
        setPendingAction(null)
        action()
      },
      reset: () => setPendingAction(null),
    }
    : { state: 'unblocked' }

  return { run, blocker }
}
