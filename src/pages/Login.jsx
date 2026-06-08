import { LogIn, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'

function getDiscordAccountLabel(user) {
  if (!user) return 'Authenticated Discord account'
  return (
    user.user_metadata?.full_name
    || user.user_metadata?.preferred_username
    || user.user_metadata?.user_name
    || user.identities?.find((identity) => identity.provider === 'discord')?.identity_data?.full_name
    || user.identities?.find((identity) => identity.provider === 'discord')?.identity_data?.name
    || 'Authenticated Discord account'
  )
}

export default function Login() {
  const navigate = useNavigate()
  const { authUser, createPlayerProfile, has_auth_session, is_logged_in, loading, logout, player, signInWithDiscord } = useAuth()
  const { pushToast } = useToast()
  const [signingIn, setSigningIn] = useState(false)
  const [creatingProfile, setCreatingProfile] = useState(false)
  const [profileForm, setProfileForm] = useState({
    name: '',
    color: '#38BDF8',
  })

  useEffect(() => {
    if (is_logged_in) {
      navigate('/', { replace: true })
    }
  }, [is_logged_in, navigate])

  const handleDiscordSignIn = async () => {
    if (signingIn) return

    setSigningIn(true)
    try {
      await signInWithDiscord()
    } catch (error) {
      pushToast({
        title: 'Unable to start Discord sign-in',
        message: error.message,
        type: 'error',
      })
      setSigningIn(false)
    }
  }

  const handleCreateProfile = async () => {
    const trimmedName = profileForm.name.trim()
    if (!trimmedName || creatingProfile) return

    setCreatingProfile(true)
    try {
      await createPlayerProfile({
        name: trimmedName,
        color: profileForm.color,
      })
      pushToast({
        title: 'Profile created',
        message: 'Your player profile is now linked to this account.',
        type: 'success',
      })
      navigate('/', { replace: true })
    } catch (error) {
      pushToast({
        title: 'Unable to create player profile',
        message: error.message,
        type: 'error',
      })
    } finally {
      setCreatingProfile(false)
    }
  }

  const renderDiscordPanel = () => (
    <section className="panel">
      <div className="section-head">
        <h2>Sign In</h2>
        <span className="muted">Use Discord for account sign-in and session recovery.</span>
      </div>
      <div className="inline-actions" style={{ marginTop: 16 }}>
        <button className="solid-button" disabled={signingIn} onClick={handleDiscordSignIn} type="button">
          <LogIn size={16} />
          {signingIn ? 'Redirecting...' : 'Continue With Discord'}
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 0, marginTop: 16 }}>
        If your Discord account is not linked to a player yet, sign in first and then create a new player profile or ask a commissioner to link your Discord user ID.
      </p>
    </section>
  )

  const renderLinkedProfilePanel = () => (
    <section className="panel">
      <div className="section-head">
        <h2>Finish Setup</h2>
        <span className="muted">{getDiscordAccountLabel(authUser)}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        This Discord account is signed in but not linked to a player yet. If you already exist in the league, ask a commissioner to link this Discord user ID to your player.
      </p>
      {authUser?.id ? (
        <div style={{ padding: 12, borderRadius: 10, border: '1px solid #334155', background: 'rgba(15,23,42,0.55)' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Discord User ID</div>
          <div style={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>{authUser.id}</div>
        </div>
      ) : null}
      <div className="form-stack">
        <label>
          <span className="muted">Player name</span>
          <input
            onChange={(event) => setProfileForm((current) => ({ ...current, name: event.target.value }))}
            placeholder="Enter your display name"
            value={profileForm.name}
          />
        </label>
        <label>
          <span className="muted">Player color</span>
          <input
            onChange={(event) => setProfileForm((current) => ({ ...current, color: event.target.value }))}
            type="color"
            value={profileForm.color}
          />
        </label>
      </div>
      <div className="inline-actions" style={{ marginTop: 16 }}>
        <button className="solid-button" disabled={!profileForm.name.trim() || creatingProfile} onClick={handleCreateProfile} type="button">
          <UserPlus size={16} />
          {creatingProfile ? 'Creating...' : 'Create Player Profile'}
        </button>
        <button
          className="ghost-button"
          onClick={async () => {
            try {
              await logout()
            } catch (error) {
              pushToast({ title: 'Unable to sign out', message: error.message, type: 'error' })
            }
          }}
          type="button"
        >
          Use Different Discord Account
        </button>
      </div>
    </section>
  )

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="page-head">
          <div>
            <span className="brand-kicker">Sluggers</span>
            <h1>Tournament Tracker</h1>
          </div>
          <p className="muted">
            Discord sign-in with linked player profiles and sitewide live data.
          </p>
        </div>

        {loading ? (
          <section className="panel">
            <p className="muted" style={{ margin: 0 }}>Checking session...</p>
          </section>
        ) : has_auth_session && !player ? (
          renderLinkedProfilePanel()
        ) : (
          renderDiscordPanel()
        )}
      </div>
    </div>
  )
}
