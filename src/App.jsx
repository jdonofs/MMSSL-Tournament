import { useCallback, useRef } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Navbar from './components/Navbar'
import ProtectedRoute from './components/ProtectedRoute'
import ScorebookRoute from './components/ScorebookRoute'
import { useAuth } from './context/AuthContext'
import Login from './pages/Login'
import Home from './pages/Home'
import Draft from './pages/Draft'
import { SeasonDraftPresentation, TournamentDraftPresentation } from './pages/DraftPresentation'
import Roster from './pages/Roster'
import Betting from './pages/Betting'
import Stats from './pages/Stats'
import Bracket from './pages/Bracket'
import TournamentCreate from './pages/TournamentCreate'
import SeasonHome from './pages/SeasonHome'
import SeasonCreate from './pages/SeasonCreate'
import SeasonDraft from './pages/SeasonDraft'
import SeasonSchedule from './pages/SeasonSchedule'
import SeasonRoster from './pages/SeasonRoster'
import SeasonBetting from './pages/SeasonBetting'
import SeasonBracket from './pages/SeasonBracket'
import SeasonStats from './pages/SeasonStats'
import Admin from './pages/Admin'
import TeamProfile from './pages/TeamProfile'
import { SeasonProvider, useSeason } from './context/SeasonContext'
import { TournamentProvider, useTournament } from './context/TournamentContext'
import { SEASON_SCOREBOOK_PATH, TOURNAMENT_SCOREBOOK_PATH } from './utils/scorebookRouting'
import { getModeStorageValue } from './utils/season'

const INTERACTIVE_TAP_SELECTOR = 'button, a, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]'

function AppLoadingScreen() {
  return (
    <div className="app-shell">
      <main className="page-shell">
        <section className="panel">
          <p className="muted" style={{ margin: 0 }}>Loading…</p>
        </section>
      </main>
    </div>
  )
}

function AppLayout() {
  const { loading: authLoading } = useAuth()
  const { loading: seasonLoading } = useSeason()
  const { loading: tournamentLoading } = useTournament()

  if (authLoading || seasonLoading || tournamentLoading) {
    return <AppLoadingScreen />
  }

  return (
    <div className="app-shell">
      <Navbar />
      <main className="page-shell">
        <Outlet />
      </main>
    </div>
  )
}

function AppWithProviders() {
  return (
    <TournamentProvider>
      <SeasonProvider>
        <AppRoutes />
      </SeasonProvider>
    </TournamentProvider>
  )
}

function RootRoute() {
  return getModeStorageValue() === 'season' ? <Navigate to="/season" replace /> : <Home />
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/draft/presentation" element={<TournamentDraftPresentation />} />
      <Route path="/season/draft/presentation" element={<SeasonDraftPresentation />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<RootRoute />} />
        <Route path="/draft" element={<Draft />} />
        <Route path="/roster" element={<Roster />} />
        <Route path={TOURNAMENT_SCOREBOOK_PATH} element={<ScorebookRoute />} />
        <Route path="/betting" element={<Betting />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/bracket" element={<Bracket />} />
        <Route path="/tournament/create" element={<TournamentCreate />} />
        <Route path="/season" element={<SeasonHome />} />
        <Route path="/season/create" element={<SeasonCreate />} />
        <Route path="/season/draft" element={<SeasonDraft />} />
        <Route path="/season/roster" element={<SeasonRoster />} />
        <Route path="/season/schedule" element={<SeasonSchedule />} />
        <Route path={SEASON_SCOREBOOK_PATH} element={<ScorebookRoute />} />
        <Route path="/season/trades" element={<Navigate to="/season/roster" replace />} />
        <Route path="/season/bets" element={<SeasonBetting />} />
        <Route path="/season/stats" element={<SeasonStats />} />
        <Route path="/season/bracket" element={<SeasonBracket />} />
        <Route path="/team" element={<ProtectedRoute><TeamProfile /></ProtectedRoute>} />
        <Route path="/admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  const pendingTouchClicksRef = useRef(new WeakMap())
  const lastTouchClickRef = useRef(null)

  const handlePointerUpCapture = useCallback((event) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
    if (!(event.target instanceof Element)) return

    const interactiveTarget = event.target.closest(INTERACTIVE_TAP_SELECTOR)
    if (!interactiveTarget) return

    const pendingEntry = pendingTouchClicksRef.current.get(interactiveTarget)
    pendingTouchClicksRef.current.set(interactiveTarget, {
      count: (pendingEntry?.count || 0) + 1,
      timestamp: performance.now(),
    })
  }, [])

  const handleClickCapture = useCallback((event) => {
    if (!(event.target instanceof Element)) return
    if (event.detail === 0) return

    const interactiveTarget = event.target.closest(INTERACTIVE_TAP_SELECTOR)
    if (!interactiveTarget) return

    const now = performance.now()
    const pendingEntry = pendingTouchClicksRef.current.get(interactiveTarget)

    if (pendingEntry && now - pendingEntry.timestamp < 1000) {
      if (pendingEntry.count <= 1) {
        pendingTouchClicksRef.current.delete(interactiveTarget)
      } else {
        pendingTouchClicksRef.current.set(interactiveTarget, {
          ...pendingEntry,
          count: pendingEntry.count - 1,
        })
      }
      lastTouchClickRef.current = { target: interactiveTarget, timestamp: now }
      return
    }

    if (
      lastTouchClickRef.current?.target === interactiveTarget
      && now - lastTouchClickRef.current.timestamp < 350
    ) {
      event.preventDefault()
      event.stopPropagation()
      event.nativeEvent.stopImmediatePropagation?.()
    }
  }, [])

  return (
    <div onPointerUpCapture={handlePointerUpCapture} onClickCapture={handleClickCapture} style={{ minHeight: '100%' }}>
      <AppWithProviders />
    </div>
  )
}
