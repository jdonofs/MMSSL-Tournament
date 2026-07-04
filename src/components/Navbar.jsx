import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, BookOpenText, GanttChartSquare, House, LogIn, LogOut, ScrollText, Settings, Trophy, Users2 } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useTournament } from '../context/TournamentContext'
import { getModeStorageValue, setModeStorageValue } from '../utils/season'

// `cluster` groups related pills with a divider between groups.
const tournamentNavItems = [
  { to: '/', label: 'Home', icon: House, cluster: 'overview' },
  { to: '/bracket', label: 'Bracket', icon: GanttChartSquare, cluster: 'overview' },
  { to: '/draft', label: 'Draft', icon: ScrollText, cluster: 'team' },
  { to: '/roster', label: 'Roster', icon: Users2, cluster: 'team' },
  { to: '/betting', label: 'Betting', icon: Trophy, cluster: 'team' },
  { to: '/stats', label: 'Stats', icon: BarChart3, cluster: 'stats' },
]

const seasonNavItems = [
  { to: '/season', label: 'Standings', icon: House, cluster: 'league' },
  { to: '/season/schedule', label: 'Schedule', icon: BookOpenText, cluster: 'league' },
  { to: '/season/bracket', label: 'Bracket', icon: GanttChartSquare, cluster: 'league' },
  { to: '/season/draft', label: 'Draft', icon: ScrollText, cluster: 'team' },
  { to: '/season/roster', label: 'Roster', icon: Users2, cluster: 'team' },
  { to: '/season/bets', label: 'Bets', icon: Trophy, cluster: 'team' },
  { to: '/season/stats', label: 'Stats', icon: BarChart3, cluster: 'stats' },
]

const adminNavItem = { to: '/admin', label: 'Admin', icon: Settings }

function groupByCluster(items) {
  const groups = []
  items.forEach((item) => {
    const previous = groups[groups.length - 1]
    if (previous && previous.cluster === item.cluster) {
      previous.items.push(item)
      return
    }
    groups.push({ cluster: item.cluster, items: [item] })
  })
  return groups
}

function isExactNavMatch(pathname, target) {
  if (target === '/' || target === '/season') {
    return pathname === target
  }
  return pathname === target || pathname.startsWith(`${target}/`)
}

export default function Navbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { player, logout } = useAuth()
  const { currentSeason, allSeasons, viewedSeason, setViewedSeason } = useSeason()
  const { allTournaments, viewedTournament, setViewedTournament } = useTournament()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mode, setMode] = useState(() => getModeStorageValue())
  const [pendingTradeCount, setPendingTradeCount] = useState(0)

  const activeTournaments = allTournaments.filter(t => !t.archived)
  const archivedTournaments = allTournaments.filter(t => t.archived)
  const isCommissioner = player?.is_commissioner === true
  const baseNavItems = mode === 'season' ? seasonNavItems : tournamentNavItems
  const navItems = isCommissioner ? [...baseNavItems, adminNavItem] : baseNavItems
  const navClusters = groupByCluster(baseNavItems)
  const tournamentLabel = mode === 'season'
    ? (viewedSeason ? viewedSeason.name : currentSeason?.name || 'No Season')
    : (viewedTournament ? `Tournament ${viewedTournament.tournament_number}` : 'No Tournament')

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

  useEffect(() => {
    let active = true

    async function loadPendingTrades() {
      if (mode !== 'season' || !currentSeason?.id || !player?.id) {
        if (active) setPendingTradeCount(0)
        return
      }
      const { data: myTeam } = await supabase
        .from('season_teams')
        .select('id')
        .eq('season_id', currentSeason.id)
        .eq('player_id', player.id)
        .maybeSingle()
      if (!active || !myTeam?.id) {
        if (active) setPendingTradeCount(0)
        return
      }
      const { data } = await supabase
        .from('season_trades')
        .select('id')
        .eq('season_id', currentSeason.id)
        .eq('receiving_team_id', myTeam.id)
        .eq('status', 'pending')
      const legacyCount = (data || []).length

      const { data: pendingDecisionRows } = await supabase
        .from('season_trade_proposal_teams')
        .select('proposal_id')
        .eq('season_id', currentSeason.id)
        .eq('team_id', myTeam.id)
        .eq('decision_status', 'pending')

      const pendingProposalIds = [...new Set((pendingDecisionRows || []).map((entry) => entry.proposal_id).filter(Boolean))]
      let modernCount = 0
      if (pendingProposalIds.length) {
        const { data: pendingProposals } = await supabase
          .from('season_trade_proposals')
          .select('id')
          .eq('season_id', currentSeason.id)
          .eq('status', 'pending')
          .in('id', pendingProposalIds)
        modernCount = (pendingProposals || []).length
      }

      if (active) {
        setPendingTradeCount(legacyCount + modernCount)
      }
    }

    loadPendingTrades()
    window.addEventListener('season-trades-updated', loadPendingTrades)

    if (mode !== 'season' || !currentSeason?.id || !player?.id) {
      return () => {
        active = false
        window.removeEventListener('season-trades-updated', loadPendingTrades)
      }
    }

    const channel = supabase
      .channel(`nav-season-trades-${currentSeason.id}-${player.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_teams', filter: `season_id=eq.${currentSeason.id}` }, loadPendingTrades)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trades', filter: `season_id=eq.${currentSeason.id}` }, loadPendingTrades)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trade_proposals', filter: `season_id=eq.${currentSeason.id}` }, loadPendingTrades)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trade_proposal_teams', filter: `season_id=eq.${currentSeason.id}` }, loadPendingTrades)
      .subscribe()

    return () => {
      active = false
      window.removeEventListener('season-trades-updated', loadPendingTrades)
      supabase.removeChannel(channel)
    }
  }, [mode, currentSeason?.id, player?.id])

  const handleTournamentChange = (e) => {
    const id = e.target.value
    const tournament = allTournaments.find(x => String(x.id) === id)
    if (tournament) setViewedTournament(tournament)
  }

  const handleSeasonChange = (e) => {
    const id = e.target.value
    const season = allSeasons.find((entry) => String(entry.id) === id)
    if (season) setViewedSeason(season)
  }

  const handleModeChange = (nextMode) => {
    setMode(nextMode)
    setModeStorageValue(nextMode)
    if (nextMode === 'season') {
      navigate('/season')
      return
    }
    navigate('/')
  }

  const handleLogout = async () => {
    setMobileMenuOpen(false)
    try {
      await logout()
    } catch {}
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
        {player ? (
          <NavLink to="/team" className="player-pill mobile-player-pill" style={{ borderColor: player.color, textDecoration: 'none' }}>
            <span className="player-dot" style={{ backgroundColor: player.color }} />
            <span>{player.name}</span>
          </NavLink>
        ) : (
          <NavLink to="/login" className="player-pill mobile-player-pill" style={{ textDecoration: 'none' }}>
            <LogIn size={14} />
            <span>Login</span>
          </NavLink>
        )}
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
          {player ? (
            <NavLink to="/team" onClick={() => setMobileMenuOpen(false)} className="player-pill mobile-drawer-player" style={{ borderColor: player.color, textDecoration: 'none' }}>
              <span className="player-dot" style={{ backgroundColor: player.color }} />
              <span>{player.name}</span>
            </NavLink>
          ) : null}
        </div>

        {allTournaments.length || allSeasons.length ? (
          <div className="mobile-drawer-tournament">
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={`tab-button ${mode === 'tournament' ? 'tab-button-active' : ''}`} onClick={() => handleModeChange('tournament')} type="button">Tournament</button>
                <button className={`tab-button ${mode === 'season' ? 'tab-button-active' : ''}`} onClick={() => handleModeChange('season')} type="button">Season</button>
              </div>
              {mode === 'season' ? (
                <select
                  className="nav-select mobile-nav-select"
                  onChange={handleSeasonChange}
                  value={viewedSeason ? String(viewedSeason.id) : ''}
                >
                  {allSeasons.map((season) => (
                    <option key={season.id} value={season.id}>{season.name}</option>
                  ))}
                </select>
              ) : (
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
              )}
            </div>
          </div>
        ) : null}

        <nav className="mobile-drawer-links">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/' || to === '/season'}
              onClick={() => setMobileMenuOpen(false)}
              className={() => `mobile-drawer-link ${isExactNavMatch(location.pathname, to) ? 'mobile-drawer-link-active' : ''}`}
            >
              <Icon size={18} />
              <span>{label}</span>
              {to === '/season/roster' && pendingTradeCount > 0 ? <span className="status-pill availability-open">{pendingTradeCount}</span> : null}
            </NavLink>
          ))}
        </nav>

        {player ? (
          <div className="mobile-drawer-footer">
            <button className="mobile-drawer-logout" onClick={handleLogout} type="button">
              <LogOut size={18} />
              <span>Logout</span>
            </button>
          </div>
        ) : null}
      </aside>

      <header className="top-nav">
        <div className="nav-row-top">
          <div className="brand-compact">
            <img src="/MSL.png" alt="MSL Sluggers" className="brand-mark" />
            <div className="brand-text">
              <span className="brand-kicker">Sluggers</span>
              <strong>{mode === 'season' ? 'Season Mode' : 'Tournament Tracker'}</strong>
            </div>
          </div>

          <div className="nav-row-top-right">
            {allTournaments.length || allSeasons.length ? (
              <div className="nav-context-group">
                <div className="nav-mode-toggle">
                  <button className={`nav-mode-btn ${mode === 'tournament' ? 'nav-mode-btn-active' : ''}`} onClick={() => handleModeChange('tournament')} type="button">Tournament</button>
                  <button className={`nav-mode-btn ${mode === 'season' ? 'nav-mode-btn-active' : ''}`} onClick={() => handleModeChange('season')} type="button">Season</button>
                </div>
                {mode === 'season' ? (
                  <select className="nav-season-select" onChange={handleSeasonChange} value={viewedSeason ? String(viewedSeason.id) : ''}>
                    {allSeasons.map((season) => (
                      <option key={season.id} value={season.id}>{season.name}</option>
                    ))}
                  </select>
                ) : (
                  <select
                    className="nav-season-select"
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
                )}
              </div>
            ) : null}

            {player ? (
              <>
                <NavLink to="/team" className="nav-player-pill" style={{ borderColor: player.color, textDecoration: 'none' }}>
                  <span className="player-dot" style={{ backgroundColor: player.color }} />
                  <span>{player.name}</span>
                </NavLink>
                <button className="nav-logout-button" onClick={handleLogout} type="button">
                  <LogOut size={14} />
                  <span>Logout</span>
                </button>
              </>
            ) : (
              <NavLink to="/login" className="nav-logout-button" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                <LogIn size={14} />
                <span>Login</span>
              </NavLink>
            )}
          </div>
        </div>

        <div className="nav-row-main">
          <nav className="nav-links">
            {navClusters.map((group, groupIndex) => (
              <div className={`nav-cluster ${groupIndex > 0 ? 'nav-cluster-divided' : ''}`} key={group.cluster}>
                {group.items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === '/' || to === '/season'}
                    className={() => `nav-link ${isExactNavMatch(location.pathname, to) ? 'nav-link-active' : ''}`}
                  >
                    <Icon size={16} />
                    <span>{label}</span>
                    {to === '/season/roster' && pendingTradeCount > 0 ? <span className="status-pill availability-open">{pendingTradeCount}</span> : null}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="nav-row-main-right">
            {isCommissioner ? (
              <NavLink
                to="/admin"
                className={() => `nav-admin-button ${isExactNavMatch(location.pathname, '/admin') ? 'nav-admin-button-active' : ''}`}
                aria-label="Admin"
                title="Admin"
              >
                <Settings size={16} />
              </NavLink>
            ) : null}
          </div>
        </div>
      </header>

    </>
  )
}
