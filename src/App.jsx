import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Navbar from './components/Navbar'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import Home from './pages/Home'
import Draft from './pages/Draft'
import Roster from './pages/Roster'
import Scorebook from './pages/Scorebook'
import Betting from './pages/Betting'
import Stats from './pages/Stats'
import Bracket from './pages/Bracket'
import TournamentCreate from './pages/TournamentCreate'
import { TournamentProvider } from './context/TournamentContext'

function AppLayout() {
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
      <AppRoutes />
    </TournamentProvider>
  )
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Home />} />
        <Route path="/draft" element={<Draft />} />
        <Route path="/roster" element={<Roster />} />
        <Route path="/scorebook" element={<Scorebook />} />
        <Route path="/betting" element={<Betting />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/bracket" element={<Bracket />} />
        <Route path="/tournament/create" element={<TournamentCreate />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return <AppWithProviders />
}
