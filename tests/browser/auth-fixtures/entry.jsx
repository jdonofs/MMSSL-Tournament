import { StrictMode, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider, useAuth } from '../../../src/context/AuthContext.jsx'

let contentSequence = 0

function MountedContent() {
  const id = useRef(++contentSequence)

  useEffect(() => {
    window.__AUTH_CONTENT_MOUNTS__ = (window.__AUTH_CONTENT_MOUNTS__ || 0) + 1
    return () => {
      window.__AUTH_CONTENT_UNMOUNTS__ = (window.__AUTH_CONTENT_UNMOUNTS__ || 0) + 1
    }
  }, [])

  window.__AUTH_CONTENT_ID__ = id.current
  return <div data-testid="mounted-content">mounted {id.current}</div>
}

function Probe() {
  const auth = useAuth()
  window.__AUTH_ACTIONS__ = { logout: auth.logout, refreshPlayer: auth.refreshPlayer }
  window.__AUTH_SNAPSHOT__ = {
    userId: auth.authUser?.id || null,
    token: auth.session?.access_token || null,
    playerId: auth.player?.id || null,
    playerName: auth.player?.name || null,
    isLoggedIn: auth.is_logged_in,
    isCommissioner: auth.isCommissioner,
    isScorekeeper: auth.isScorekeeper,
    loading: auth.loading,
  }
  window.__AUTH_RENDER_COUNT__ = (window.__AUTH_RENDER_COUNT__ || 0) + 1

  return auth.loading ? <div data-testid="loading">loading</div> : <MountedContent />
}

const app = (
  <AuthProvider>
    <Probe />
  </AuthProvider>
)
const root = createRoot(document.getElementById('root'))
root.render(window.__AUTH_SEED__?.strict ? <StrictMode>{app}</StrictMode> : app)
window.__AUTH_UNMOUNT__ = () => root.unmount()
