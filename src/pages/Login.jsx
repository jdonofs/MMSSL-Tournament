import { ArrowLeft, Eye, EyeOff, LogIn } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import TeamLogo from '../components/TeamLogo'

export default function Login() {
  const navigate = useNavigate()
  const { is_logged_in, loading, signInWithPassword } = useAuth()
  const { pushToast } = useToast()
  const [players, setPlayers] = useState([])
  const [playersLoading, setPlayersLoading] = useState(true)
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const passwordSectionRef = useRef(null)

  useEffect(() => {
    if (is_logged_in) {
      navigate('/season', { replace: true })
    }
  }, [is_logged_in, navigate])

  useEffect(() => {
    if (selectedPlayer && passwordSectionRef.current) {
      passwordSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [selectedPlayer])

  useEffect(() => {
    supabase
      .from('players')
      .select('id, name, color, email, team_logo_url, team_name')
      .order('name')
      .then(({ data }) => {
        setPlayers(data || [])
        setPlayersLoading(false)
      })
  }, [])

  const handleSelectPlayer = (p) => {
    setSelectedPlayer(p)
    setPassword('')
    setShowPassword(false)
  }

  const handleSignIn = async (e) => {
    e.preventDefault()
    if (!selectedPlayer?.email || !password || signingIn) return

    setSigningIn(true)
    try {
      await signInWithPassword(selectedPlayer.email, password)
    } catch (error) {
      pushToast({
        title: 'Sign-in failed',
        message: 'Incorrect password. Try again or ask a commissioner to reset it.',
        type: 'error',
      })
      setSigningIn(false)
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <button type="button" className="ghost-button" onClick={() => navigate('/')} style={{ display: 'flex', alignItems: 'center', gap: 6, width: 'fit-content' }}>
          <ArrowLeft size={16} />
          Back
        </button>
        <div className="page-head">
          <div>
            <span className="brand-kicker">Sluggers</span>
            <h1>Tournament Tracker</h1>
          </div>
        </div>

        {loading || playersLoading ? (
          <section className="panel">
            <p className="muted" style={{ margin: 0 }}>Loading…</p>
          </section>
        ) : (
          <>
            <section className="panel">
              <div className="section-head">
                <h2>Who are you?</h2>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10, marginTop: 12 }}>
                {players.map((p) => {
                  const isSelected = selectedPlayer?.id === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handleSelectPlayer(p)}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 8,
                        padding: '14px 10px',
                        background: isSelected ? 'rgba(234,179,8,0.12)' : 'rgba(15,23,42,0.55)',
                        border: isSelected ? '2px solid #EAB308' : '2px solid #1E293B',
                        borderRadius: 12,
                        cursor: 'pointer',
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      {p.team_logo_url ? (
                        <TeamLogo logoUrl={p.team_logo_url} height={40} />
                      ) : (
                        <div style={{
                          width: 40,
                          height: 40,
                          borderRadius: '50%',
                          background: p.color || '#38BDF8',
                          flexShrink: 0,
                        }} />
                      )}
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#E2E8F0', textAlign: 'center', lineHeight: 1.2 }}>
                        {p.name}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>

            {selectedPlayer && (
              <section className="panel" style={{ marginTop: 0 }} ref={passwordSectionRef}>
                <form onSubmit={handleSignIn} style={{ display: 'grid', gap: 14 }}>
                  <div className="section-head" style={{ marginBottom: 0 }}>
                    <h2>
                      <span style={{ color: selectedPlayer.color || '#38BDF8' }}>{selectedPlayer.name}</span>
                    </h2>
                    {!selectedPlayer.email && (
                      <span className="muted" style={{ color: '#F87171', fontSize: 13 }}>
                        No login account set up yet — ask a commissioner.
                      </span>
                    )}
                  </div>

                  {selectedPlayer.email && (
                    <>
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span className="muted" style={{ fontSize: 13 }}>Password</span>
                        <div style={{ position: 'relative' }}>
                          <input
                            type={showPassword ? 'text' : 'password'}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Enter your password"
                            autoFocus
                            style={{
                              width: '100%',
                              background: '#1E293B',
                              border: '1px solid #334155',
                              borderRadius: 8,
                              padding: '10px 44px 10px 14px',
                              color: '#E2E8F0',
                              fontSize: 15,
                              boxSizing: 'border-box',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            style={{
                              position: 'absolute',
                              right: 10,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              color: '#64748B',
                              padding: 4,
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                      </label>
                      <div className="inline-actions">
                        <button
                          className="solid-button"
                          type="submit"
                          disabled={!password || signingIn}
                        >
                          <LogIn size={16} />
                          {signingIn ? 'Signing in…' : 'Sign In'}
                        </button>
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => setSelectedPlayer(null)}
                        >
                          Back
                        </button>
                      </div>
                    </>
                  )}
                </form>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
