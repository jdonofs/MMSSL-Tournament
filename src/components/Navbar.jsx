import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, BookOpenText, GanttChartSquare, House, LogOut, Plus, ScrollText, Trash2, Trophy, Users2 } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useTournament } from '../context/TournamentContext'
import { useToast } from '../context/ToastContext'

const navItems = [
  { to: '/', label: 'Home', icon: House },
  { to: '/draft', label: 'Draft', icon: ScrollText },
  { to: '/roster', label: 'Roster', icon: Users2 },
  { to: '/scorebook', label: 'Scorebook', icon: BookOpenText },
  { to: '/betting', label: 'Betting', icon: Trophy },
  { to: '/stats', label: 'Stats', icon: BarChart3 },
  { to: '/bracket', label: 'Bracket', icon: GanttChartSquare },
]

export default function Navbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { player, logout } = useAuth()
  const { allTournaments, viewedTournament, setViewedTournament, refreshTournaments } = useTournament()
  const { pushToast } = useToast()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const activeTournaments = allTournaments.filter(t => !t.archived)
  const archivedTournaments = allTournaments.filter(t => t.archived)
  const isCommissioner = player?.is_commissioner === true
  const tournamentLabel = viewedTournament ? `Tournament ${viewedTournament.tournament_number}` : 'No Tournament'

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!mobileMenuOpen) {
      document.body.classList.remove('drawer-open')
      return undefined
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setMobileMenuOpen(false)
    }

    document.body.classList.add('drawer-open')
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.classList.remove('drawer-open')
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [mobileMenuOpen])

  const handleTournamentChange = (e) => {
    const id = e.target.value
    const tournament = allTournaments.find(x => String(x.id) === id)
    if (tournament) setViewedTournament(tournament)
  }

  const handleDeleteTournament = async () => {
    if (!viewedTournament) return
    const { error } = await supabase.from('tournaments').delete().eq('id', viewedTournament.id)
    setConfirmDelete(false)
    setMobileMenuOpen(false)
    if (error) {
      pushToast({ title: 'Error', message: error.message, type: 'error' })
      return
    }
    pushToast({
      title: 'Tournament deleted',
      message: `Tournament ${viewedTournament.tournament_number} has been deleted.`,
      type: 'success',
    })
    await refreshTournaments()
  }

  const handleLogout = () => {
    setMobileMenuOpen(false)
    logout()
    navigate('/login')
  }

  return (
    <>
      <header className="mobile-topbar">
        <button
          className={`mobile-menu-toggle ${mobileMenuOpen ? 'mobile-menu-toggle-open' : ''}`}
          onClick={() => setMobileMenuOpen(open => !open)}
          type="button"
          aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-drawer-nav"
        >
          <span />
          <span />
          <span />
        </button>
        <div className="mobile-brand">
          <span className="brand-kicker">Sluggers</span>
          <strong>{tournamentLabel}</strong>
        </div>
        <div className="player-pill mobile-player-pill" style={{ borderColor: player?.color }}>
          <span className="player-dot" style={{ backgroundColor: player?.color }} />
          <span>{player?.name}</span>
        </div>
      </header>

      <div
        className={`mobile-drawer-overlay ${mobileMenuOpen ? 'mobile-drawer-overlay-open' : ''}`}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden={!mobileMenuOpen}
      />

      <aside
        id="mobile-drawer-nav"
        className={`mobile-drawer ${mobileMenuOpen ? 'mobile-drawer-open' : ''}`}
        aria-hidden={!mobileMenuOpen}
      >
        <div className="mobile-drawer-head">
          <div className="brand-block">
            <span className="brand-kicker">Sluggers</span>
            <strong>{tournamentLabel}</strong>
          </div>
          <div className="player-pill mobile-drawer-player" style={{ borderColor: player?.color }}>
            <span className="player-dot" style={{ backgroundColor: player?.color }} />
            <span>{player?.name}</span>
          </div>
        </div>

        {allTournaments.length ? (
          <div className="mobile-drawer-tournament">
            <select
              className="nav-select mobile-nav-select"
              onChange={handleTournamentChange}
              value={viewedTournament ? String(viewedTournament.id) : ''}
            >
              {activeTournaments.map(tournament => (
                <option key={tournament.id} value={tournament.id}>
                  Tournament {tournament.tournament_number}
                </option>
              ))}
              {archivedTournaments.length > 0 && (
                <optgroup label="Archived">
                  {archivedTournaments.map(tournament => (
                    <option key={tournament.id} value={tournament.id}>
                      Tournament {tournament.tournament_number} [archived]
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {isCommissioner && (
              <div className="mobile-drawer-actions">
                <button
                  onClick={() => {
                    setMobileMenuOpen(false)
                    navigate('/tournament/create')
                  }}
                  title="New Tournament"
                  type="button"
                  className="mobile-admin-button mobile-admin-button-primary"
                >
                  <Plus size={16} />
                  <span>New Tournament</span>
                </button>
                {viewedTournament && (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    title="Delete Tournament"
                    type="button"
                    className="mobile-admin-button mobile-admin-button-danger"
                  >
                    <Trash2 size={14} />
                    <span>Delete Tournament</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : null}

        <nav className="mobile-drawer-links">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) => `mobile-drawer-link ${isActive ? 'mobile-drawer-link-active' : ''}`}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="mobile-drawer-footer">
          <button
            className="mobile-drawer-logout"
            onClick={handleLogout}
            type="button"
          >
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <header className="top-nav">
        <div className="brand-block">
          <span className="brand-kicker">Sluggers</span>
          <strong>Tournament Tracker</strong>
        </div>
        <nav className="nav-links">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}
            >
              <Icon size={16} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="nav-user">
          {allTournaments.length ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <select
                className="nav-select"
                onChange={handleTournamentChange}
                value={viewedTournament ? String(viewedTournament.id) : ''}
              >
                {activeTournaments.map(tournament => (
                  <option key={tournament.id} value={tournament.id}>
                    Tournament {tournament.tournament_number}
                  </option>
                ))}
                {archivedTournaments.length > 0 && (
                  <optgroup label="Archived">
                    {archivedTournaments.map(tournament => (
                      <option key={tournament.id} value={tournament.id}>
                        Tournament {tournament.tournament_number} [archived]
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {isCommissioner && (
                <>
                  <button
                    onClick={() => navigate('/tournament/create')}
                    title="New Tournament"
                    type="button"
                    style={{
                      background: '#EAB308',
                      border: 'none',
                      borderRadius: 6,
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    <Plus size={16} color="#000" />
                  </button>
                  {viewedTournament && (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      title="Delete Tournament"
                      type="button"
                      style={{
                        background: 'transparent',
                        border: '1px solid #ef4444',
                        borderRadius: 6,
                        width: 28,
                        height: 28,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        flexShrink: 0,
                        color: '#ef4444',
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </>
              )}
            </div>
          ) : null}

          <div className="player-pill" style={{ borderColor: player?.color }}>
            <span className="player-dot" style={{ backgroundColor: player?.color }} />
            <span>{player?.name}</span>
          </div>
          <button
            className="ghost-button"
            onClick={handleLogout}
            type="button"
          >
            <LogOut size={16} />
            <span>Logout</span>
          </button>
        </div>
      </header>

      {confirmDelete && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-head">
              <h2>Delete Tournament {viewedTournament?.tournament_number}?</h2>
              <span className="muted">This will permanently delete all games and draft picks for this tournament.</span>
            </div>
            <div className="modal-actions">
              <button className="ghost-button" onClick={() => setConfirmDelete(false)} type="button">Cancel</button>
              <button
                onClick={handleDeleteTournament}
                type="button"
                style={{
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '0.5rem 1.25rem',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
