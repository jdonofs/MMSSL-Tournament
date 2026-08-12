import { lazy, Suspense, useCallback, useRef } from 'react'
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom'
import Navbar from './components/Navbar'
import ProtectedRoute from './components/ProtectedRoute'
import { AuthProvider, useAuth } from './context/AuthContext'

// Lazy-loaded so each tab only downloads/parses the JS for the page it's actually
// showing, instead of every route's code being bundled into one always-loaded chunk.
const ScorebookRoute = lazy(() => import('./components/ScorebookRoute'))
const Login = lazy(() => import('./pages/Login'))
const Home = lazy(() => import('./pages/Home'))
const Draft = lazy(() => import('./pages/Draft'))
const TournamentDraftPresentation = lazy(() =>
  import('./pages/DraftPresentation').then((m) => ({ default: m.TournamentDraftPresentation })),
)
const SeasonDraftPresentation = lazy(() =>
  import('./pages/DraftPresentation').then((m) => ({ default: m.SeasonDraftPresentation })),
)
const Roster = lazy(() => import('./pages/Roster'))
const Betting = lazy(() => import('./pages/Betting'))
const Stats = lazy(() => import('./pages/Stats'))
const Bracket = lazy(() => import('./pages/Bracket'))
const TournamentCreate = lazy(() => import('./pages/TournamentCreate'))
const SeasonHome = lazy(() => import('./pages/SeasonHome'))
const SeasonCreate = lazy(() => import('./pages/SeasonCreate'))
const SeasonDraft = lazy(() => import('./pages/SeasonDraft'))
const SeasonSchedule = lazy(() => import('./pages/SeasonSchedule'))
const SeasonRoster = lazy(() => import('./pages/SeasonRoster'))
const SeasonBetting = lazy(() => import('./pages/SeasonBetting'))
const SeasonBracket = lazy(() => import('./pages/SeasonBracket'))
const SeasonStats = lazy(() => import('./pages/SeasonStats'))
const Admin = lazy(() => import('./pages/Admin'))
const TeamProfile = lazy(() => import('./pages/TeamProfile'))
const TeamPage = lazy(() => import('./pages/TeamPage'))
const CharacterPage = lazy(() => import('./pages/CharacterPage'))
const AtBatEditor = lazy(() => import('./pages/AtBatEditor'))
const VideoTimestamps = lazy(() => import('./pages/VideoTimestamps'))
const TrackerAtBatTest = lazy(() => import('./pages/TrackerAtBatTest'))
const TrackerAtBatPreview = lazy(() => import('./pages/TrackerAtBatPreview'))
import { SeasonProvider, useSeason } from './context/SeasonContext'
import { TournamentProvider, useTournament } from './context/TournamentContext'
import { UnsavedChangesProvider } from './context/UnsavedChangesContext'
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
    <UnsavedChangesProvider>
      <div className="app-shell">
        <Navbar />
        <main className="page-shell">
          <Suspense fallback={<p className="muted" style={{ margin: 0 }}>Loading…</p>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </UnsavedChangesProvider>
  )
}

function RootProviders() {
  return (
    <TournamentProvider>
      <SeasonProvider>
        <Outlet />
      </SeasonProvider>
    </TournamentProvider>
  )
}

function RootRoute() {
  return getModeStorageValue() === 'season' ? <Navigate to="/season" replace /> : <Home />
}

// A data router (rather than plain <BrowserRouter>/<Routes>) is required so
// pages can use useBlocker() to intercept in-app navigation and prompt for
// unsaved lineup/fielding changes before leaving. See useUnsavedChangesGuard.
const router = createBrowserRouter([
  {
    // AuthProvider lives here (inside the router) rather than in main.jsx so its always-on
    // realtime channel can use useLocation() to pause itself on pages that don't need live
    // updates — see useRealtimeEnabled.
    element: <AuthProvider><RootProviders /></AuthProvider>,
    children: [
      { path: '/login', element: <Suspense fallback={<AppLoadingScreen />}><Login /></Suspense> },
      { path: '/draft/presentation', element: <Suspense fallback={<AppLoadingScreen />}><TournamentDraftPresentation /></Suspense> },
      { path: '/season/draft/presentation', element: <Suspense fallback={<AppLoadingScreen />}><SeasonDraftPresentation /></Suspense> },
      {
        element: <ProtectedRoute><AppLayout /></ProtectedRoute>,
        children: [
          { path: '/', element: <RootRoute /> },
          { path: '/draft', element: <Draft /> },
          { path: '/roster', element: <Roster /> },
          { path: TOURNAMENT_SCOREBOOK_PATH, element: <ScorebookRoute /> },
          { path: '/betting', element: <Betting /> },
          { path: '/stats', element: <Stats /> },
          { path: '/bracket', element: <Bracket /> },
          { path: '/tournament/create', element: <TournamentCreate /> },
          { path: '/season', element: <SeasonHome /> },
          { path: '/season/create', element: <SeasonCreate /> },
          { path: '/season/draft', element: <SeasonDraft /> },
          { path: '/season/roster', element: <SeasonRoster /> },
          { path: '/season/schedule', element: <SeasonSchedule /> },
          { path: SEASON_SCOREBOOK_PATH, element: <ScorebookRoute /> },
          { path: '/season/trades', element: <Navigate to="/season/roster" replace /> },
          { path: '/season/bets', element: <SeasonBetting /> },
          { path: '/season/stats', element: <SeasonStats /> },
          { path: '/season/bracket', element: <SeasonBracket /> },
          { path: '/team', element: <TeamProfile /> },
          { path: '/teams/:playerId', element: <Navigate to="career" replace /> },
          { path: '/teams/:playerId/career', element: <TeamPage /> },
          { path: '/teams/:playerId/season/:seasonId', element: <TeamPage /> },
          { path: '/teams/:playerId/tournament/:tournamentId', element: <TeamPage /> },
          { path: '/character/:id', element: <Navigate to="career" replace /> },
          { path: '/character/:id/career', element: <CharacterPage /> },
          { path: '/character/:id/season/:seasonId', element: <CharacterPage /> },
          { path: '/character/:id/tournament/:tournamentId', element: <CharacterPage /> },
          { path: '/admin', element: <Admin /> },
          { path: '/admin/video-timestamps', element: <VideoTimestamps /> },
          { path: '/at-bat/:source/:id', element: <AtBatEditor /> },
          { path: '/tracker-editor/:source/:gameId', element: <AtBatEditor /> },
          { path: '/tracker-test', element: <TrackerAtBatTest /> },
          { path: '/tracker-preview', element: <TrackerAtBatPreview /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

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
      <RouterProvider router={router} />
    </div>
  )
}
