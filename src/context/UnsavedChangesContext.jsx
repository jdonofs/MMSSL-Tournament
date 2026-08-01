import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt'

const UnsavedChangesContext = createContext(null)

// Covers "leave" actions that don't go through react-router's navigation
// pipeline, so useUnsavedChangesGuard's useBlocker can't see them — notably
// Logout, which flips auth state and lets ProtectedRoute swap out the whole
// protected route tree (unmounting the page's blocker) before any navigate()
// call fires. Pages register their current dirty/save state here; anything
// that needs to leave outside the router (Navbar's logout button) calls
// confirmLeave() first and only proceeds if it resolves true.
export function UnsavedChangesProvider({ children }) {
  const guardRef = useRef(null)
  const pendingSaveRef = useRef(null)
  const [pendingResolve, setPendingResolve] = useState(null)

  const registerGuard = useCallback((isDirty, onSave) => {
    guardRef.current = isDirty ? { onSave } : null
  }, [])

  const confirmLeave = useCallback(() => {
    if (!guardRef.current) return Promise.resolve(true)
    pendingSaveRef.current = guardRef.current.onSave
    return new Promise((resolve) => setPendingResolve(() => resolve))
  }, [])

  const blocker = pendingResolve
    ? {
      state: 'blocked',
      proceed: () => { const r = pendingResolve; setPendingResolve(null); r(true) },
      reset: () => { const r = pendingResolve; setPendingResolve(null); r(false) },
    }
    : { state: 'unblocked' }

  return (
    <UnsavedChangesContext.Provider value={{ registerGuard, confirmLeave }}>
      {children}
      <UnsavedChangesPrompt blocker={blocker} onSave={() => pendingSaveRef.current?.()} />
    </UnsavedChangesContext.Provider>
  )
}

function useUnsavedChangesContext() {
  const ctx = useContext(UnsavedChangesContext)
  if (!ctx) throw new Error('useUnsavedChangesContext must be used within UnsavedChangesProvider')
  return ctx
}

// Pages with an editable lineup/fielding form call this alongside
// useUnsavedChangesGuard so non-router "leave" actions (Logout) can also be
// guarded.
export function useRegisterUnsavedChanges(isDirty, onSave) {
  const { registerGuard } = useUnsavedChangesContext()
  useEffect(() => {
    registerGuard(isDirty, onSave)
    return () => registerGuard(false, null)
  }, [registerGuard, isDirty, onSave])
}

// Returns a function that resolves true immediately if there's nothing
// unsaved, or shows the Save & Leave / Discard & Leave / Cancel prompt and
// resolves with the user's choice (true = proceed, false = stay).
export function useConfirmLeave() {
  return useUnsavedChangesContext().confirmLeave
}
