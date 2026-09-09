import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import TrackerLivePreview from './components/TrackerLivePreview'
import './styles/global.css'

// Intentionally not mounted through App.jsx. The tracker validation console
// has no auth, tournament, season, realtime, or Supabase provider; its only
// data source is the local read-only API started by tracker:preview.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <div className="app-shell">
        <main className="page-shell">
          <TrackerLivePreview baseUrl="/tracker-api" />
        </main>
      </div>
    </BrowserRouter>
  </React.StrictMode>,
)
