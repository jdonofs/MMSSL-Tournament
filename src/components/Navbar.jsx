import { useEffect, useRef, useState } from 'react'
import useRealtimeEnabled from '../hooks/useRealtimeEnabled'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, BookOpenText, GanttChartSquare, House, LogIn, LogOut, ScrollText, Settings, Trophy, Users2 } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useConfirmLeave } from '../context/UnsavedChangesContext'
import { useSeason } from '../context/SeasonContext'
import { useTournament } from '../context/TournamentContext'
import { getModeStorageValue, setModeStorageValue } from '../utils/season'
import { buildPlayerTeamIdentity, buildSeasonTeamIdentity } from '../utils/teamIdentity'
import PlayerTag from './PlayerTag'

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

// Maps a path in one mode to the equivalent section's path in the other mode, so switching
// modes from e.g. the Stats page lands on Stats rather than resetting to the home page.
const tournamentToSeasonPath = {
  '/': '/season',
  '/bracket': '/season/bracket',
  '/draft': '/season/draft',
  '/roster': '/season/roster',
  '/betting': '/season/bets',
  '/stats': '/season/stats',
}

const seasonToTournamentPath = {
  '/season': '/',
  '/season/schedule': '/',
  '/season/bracket': '/bracket',
  '/season/draft': '/draft',
  '/season/roster': '/roster',
  '/season/bets': '/betting',
  '/season/stats': '/stats',
}

function resolveModeSwitchPath(pathname, nextMode) {
  const map = nextMode === 'season' ? tournamentToSeasonPath : seasonToTournamentPath
  const currentModeItems = nextMode === 'season' ? tournamentNavItems : seasonNavItems
  const matchedItem = currentModeItems.find((item) => isExactNavMatch(pathname, item.to))
  const currentPath = matchedItem ? matchedItem.to : pathname
  return map[currentPath] || (nextMode === 'season' ? '/season' : '/')
}

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
  const realtimeEnabled = useRealtimeEnabled()
  const { player, logout } = useAuth()
  const confirmLeave = useConfirmLeave()
  const { currentSeason, allSeasons, viewedSeason, setViewedSeason, seasonTeams } = useSeason()
  const { allTournaments, viewedTournament, setViewedTournament } = useTournament()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mode, setMode] = useState(() => getModeStorageValue())
  const [pendingTradeCount, setPendingTradeCount] = useState(0)
  const [playersById, setPlayersById] = useState({})
  const lastPendingTradesLoadRef = useRef({ key: '', time: 0 })

  const activeTournaments = allTournaments.filter(t => !t.archived)
  const archivedTournaments = allTournaments.filter(t => t.archived)
  const isCommissioner = player?.is_commissioner === true
  const baseNavItems = mode === 'season' ? seasonNavItems : tournamentNavItems
  const navItems = isCommissioner ? [...baseNavItems, adminNavItem] : baseNavItems
  const navClusters = groupByCluster(baseNavItems)
  const activeSeasonRecord = viewedSeason || currentSeason
  const tournamentLabel = mode === 'season'
    ? (viewedSeason ? viewedSeason.name : currentSeason?.name || 'No Season')
    : (viewedTournament ? `Tournament ${viewedTournament.tournament_number}` : 'No Tournament')
  const championRecord = mode === 'season' ? activeSeasonRecord : viewedTournament
  const isChampionshipDecided = mode === 'season'
    ? championRecord?.status === 'completed'
    : championRecord?.status === 'complete'
  const championPlayerId = isChampionshipDecided ? championRecord?.champion_player_id : null
  const championPlayer = championPlayerId ? playersById[championPlayerId] : null
  const championSeasonTeam = mode === 'season' && championPlayerId
    ? seasonTeams.find((team) => String(team.player_id) === String(championPlayerId))
    : null
  const championIdentity = championPlayer
    ? (mode === 'season'
      ? (championSeasonTeam ? buildSeasonTeamIdentity(championSeasonTeam) : null)
      : buildPlayerTeamIdentity(championPlayer))
    : null

  useEffect(() => {
    let active = true
    supabase
      .from('players')
      .select('id, name, color, team_name, team_mascot, team_abbreviation, team_primary_color, team_secondary_color, team_logo_url')
      .then(({ data }) => {
        if (active) setPlayersById(Object.fromEntries((data || []).map((p) => [p.id, p])))
      })
    return () => { active = false }
  }, [])

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
    // Skipped entirely on pages that don't need live updates (see useRealtimeEnabled) — this
    // effect both fetches on mount and opens a realtime channel below, and an open realtime
    // WebSocket connection disqualifies a page from the browser's back/forward cache.
    if (!realtimeEnabled) {
      setPendingTradeCount(0)
      return undefined
    }

    let active = true

    async function loadPendingTrades() {
      if (mode !== 'season' || !currentSeason?.id || !player?.id) {
        if (active) setPendingTradeCount(0)
        return
      }
      // mode/currentSeason?.id/player?.id can each settle in separate render passes on a fresh
      // page load, re-running this effect more than once with the exact same, fully-resolved
      // dependencies — collapse those into one fetch. Realtime-triggered calls (seconds/minutes
      // later, well past this window) are unaffected and always run.
      const key = `${currentSeason.id}:${player.id}`
      const now = Date.now()
      if (lastPendingTradesLoadRef.current.key === key && now - lastPendingTradesLoadRef.current.time < 1000) return
      lastPendingTradesLoadRef.current = { key, time: now }
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
        setPendingTradeCount(modernCount)
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trade_proposals', filter: `season_id=eq.${currentSeason.id}` }, loadPendingTrades)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trade_proposal_teams', filter: `season_id=eq.${currentSeason.id}` }, loadPendingTrades)
      .subscribe()

    return () => {
      active = false
      window.removeEventListener('season-trades-updated', loadPendingTrades)
      supabase.removeChannel(channel)
    }
  }, [realtimeEnabled, mode, currentSeason?.id, player?.id])

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
    if (nextMode === mode) return
    setMode(nextMode)
    setModeStorageValue(nextMode)
    navigate(resolveModeSwitchPath(location.pathname, nextMode))
  }

  const handleLogout = async () => {
    const proceed = await confirmLeave()
    if (!proceed) return
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
        <div className="mobile-topbar-right">
          {championPlayer ? (
            <span className="champion-badge champion-badge-mobile" title={`${championIdentity?.teamName || championPlayer.name} — Champion`}>
              <Trophy size={12} className="champion-badge-icon" />
              <PlayerTag
                player={championPlayer}
                identitiesByPlayerId={championIdentity ? { [championPlayer.id]: championIdentity } : {}}
                height={18}
                showLogo={Boolean(championIdentity?.teamLogoUrl || championIdentity?.teamLogoKey)}
                showPlaceholder={false}
              />
            </span>
          ) : null}
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

          {championPlayer ? (
            <span className="champion-badge champion-badge-centered" title={`${championIdentity?.teamName || championPlayer.name} — Champion`}>
              <Trophy size={14} className="champion-badge-icon" />
              <PlayerTag
                player={championPlayer}
                identitiesByPlayerId={championIdentity ? { [championPlayer.id]: championIdentity } : {}}
                height={22}
                showLogo={Boolean(championIdentity?.teamLogoUrl || championIdentity?.teamLogoKey)}
                showPlaceholder={false}
              />
            </span>
          ) : null}

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
