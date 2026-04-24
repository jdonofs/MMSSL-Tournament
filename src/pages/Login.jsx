import { PlusCircle, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { DEFAULT_PLAYERS, seedDefaultPlayers } from '../utils/dataImport.jsx'

export default function Login() {
  const navigate = useNavigate()
  const { is_logged_in, loginAsPlayer } = useAuth()
  const { pushToast } = useToast()
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [activePlayerId, setActivePlayerId] = useState(null)
  const [showCreatePlayer, setShowCreatePlayer] = useState(false)
  const [createPlayerForm, setCreatePlayerForm] = useState({
    name: '',
    color: '#38BDF8'
  })

  const loadPlayers = async () => {
    setLoading(true)
    const { data, error: fetchError } = await supabase
      .from('players')
      .select('*')
      .order('name')

    if (fetchError) {
      pushToast({
        title: 'Unable to load players',
        message: fetchError.message,
        type: 'error'
      })
    } else {
      setPlayers(data || [])
    }

    setLoading(false)
  }

  useEffect(() => {
    if (is_logged_in) {
      navigate('/', { replace: true })
    }
  }, [is_logged_in, navigate])

  useEffect(() => {
    loadPlayers()
  }, [pushToast])

  const handlePlayerLogin = async (selectedPlayer) => {
    if (submitting) return

    setSubmitting(true)
    setActivePlayerId(selectedPlayer.id)
    try {
      await loginAsPlayer(selectedPlayer.id)
      pushToast({
        title: 'Welcome back',
        message: `${selectedPlayer.name} is signed in.`,
        type: 'success'
      })
      navigate('/', { replace: true })
    } catch (loginError) {
      pushToast({
        title: 'Unable to sign in',
        message: loginError.message,
        type: 'error'
      })
    } finally {
      setActivePlayerId(null)
      setSubmitting(false)
    }
  }

  const handleSeedDefaultPlayers = async () => {
    if (submitting) return

    setSubmitting(true)
    try {
      const seededPlayers = await seedDefaultPlayers()
      setPlayers(seededPlayers)
      pushToast({
        title: 'Players added',
        message: 'The previous tournament player list is now available on the login screen.',
        type: 'success'
      })
    } catch (seedError) {
      pushToast({
        title: 'Unable to add players',
        message: seedError.message,
        type: 'error'
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleDefaultPlayerQuickStart = async (defaultPlayer) => {
    if (submitting) return

    setSubmitting(true)
    setActivePlayerId(defaultPlayer.name)
    try {
      const seededPlayers = await seedDefaultPlayers()
      setPlayers(seededPlayers)
      const selectedPlayer = seededPlayers.find((player) => player.name === defaultPlayer.name)

      if (!selectedPlayer) {
        throw new Error(`Could not find ${defaultPlayer.name} after seeding players.`)
      }

      await loginAsPlayer(selectedPlayer.id)
      pushToast({
        title: 'Welcome back',
        message: `${selectedPlayer.name} is signed in.`,
        type: 'success'
      })
      navigate('/', { replace: true })
    } catch (quickStartError) {
      pushToast({
        title: 'Unable to sign in',
        message: quickStartError.message,
        type: 'error'
      })
    } finally {
      setActivePlayerId(null)
      setSubmitting(false)
    }
  }

  const handleCreatePlayer = async () => {
    const trimmedName = createPlayerForm.name.trim()
    if (!trimmedName || submitting) return

    setSubmitting(true)
    try {
      const { error } = await supabase.from('players').insert({
        name: trimmedName,
        color: createPlayerForm.color
      })

      if (error) {
        throw error
      }

      await loadPlayers()
      setShowCreatePlayer(false)
      setCreatePlayerForm({
        name: '',
        color: '#38BDF8'
      })
      pushToast({
        title: 'Player created',
        message: `${trimmedName} is now available to sign in.`,
        type: 'success'
      })
    } catch (createError) {
      pushToast({
        title: 'Unable to create player',
        message: createError.message,
        type: 'error'
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="page-head">
          <div>
            <span className="brand-kicker">Sluggers</span>
            <h1>Tournament Tracker</h1>
          </div>
          <p className="muted">Select your player card and jump straight back into the bracket.</p>
        </div>

        <section className="panel">
          <div className="section-head">
            <h2>Players</h2>
            <div className="inline-actions">
              <span className="muted">{loading ? 'Loading roster...' : `${players.length} available`}</span>
              <button className="ghost-button" onClick={() => setShowCreatePlayer(true)} type="button">
                <PlusCircle size={16} />
                Add Player
              </button>
            </div>
          </div>
          {players.length ? (
            <div className="player-selector-grid">
              {players.map((player) => (
                <button
                  className={`player-card ${activePlayerId === player.id ? 'player-card-loading' : ''}`}
                  key={player.id}
                  onClick={() => handlePlayerLogin(player)}
                  style={{
                    color: player.color,
                    background: `linear-gradient(180deg, ${player.color}20, rgba(15,23,42,0.5))`
                  }}
                  type="button"
                >
                  <h3>{player.name}</h3>
                  <p className="muted">
                    {activePlayerId === player.id ? 'Signing in...' : 'Tap to sign in and open the live tournament dashboard.'}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <Users size={28} />
              <h3>No players yet</h3>
              <p className="muted">
                This usually means the database is empty. You can add the six players from the previous tournament
                or create a brand new player below.
              </p>
              <div className="inline-actions">
                <button className="solid-button" disabled={loading || submitting} onClick={handleSeedDefaultPlayers} type="button">
                  Add Previous Tournament Players
                </button>
                <button className="ghost-button" onClick={() => setShowCreatePlayer(true)} type="button">
                  Create New Player
                </button>
              </div>
              <div className="player-selector-grid">
                {DEFAULT_PLAYERS.map((player) => (
                  <button
                    className={`player-card ${activePlayerId === player.name ? 'player-card-loading' : ''}`}
                    key={player.name}
                    onClick={() => handleDefaultPlayerQuickStart(player)}
                    style={{
                      color: player.color,
                      background: `linear-gradient(180deg, ${player.color}20, rgba(15,23,42,0.5))`
                    }}
                    type="button"
                  >
                    <h3>{player.name}</h3>
                    <p className="muted">
                      {activePlayerId === player.name
                        ? 'Setting up player and signing in...'
                        : 'Tap to add this player if needed and sign in immediately.'}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {showCreatePlayer ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-head">
              <h2>Create Player</h2>
              <span className="muted">Add a new person to the login roster.</span>
            </div>
            <div className="form-stack">
              <label>
                <span className="muted">Player name</span>
                <input
                  onChange={(event) => setCreatePlayerForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Enter player name"
                  value={createPlayerForm.name}
                />
              </label>
              <label>
                <span className="muted">Player color</span>
                <input
                  onChange={(event) => setCreatePlayerForm((current) => ({ ...current, color: event.target.value }))}
                  type="color"
                  value={createPlayerForm.color}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button className="ghost-button" onClick={() => setShowCreatePlayer(false)} type="button">
                Cancel
              </button>
              <button className="solid-button" disabled={!createPlayerForm.name.trim() || submitting} onClick={handleCreatePlayer} type="button">
                Create Player
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
