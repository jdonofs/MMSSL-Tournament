import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import BettingTab from '../../../src/components/BettingTab.jsx'
import '../../../src/styles/global.css'

const mode = new URLSearchParams(window.location.search).get('mode') || 'tournament'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* The receipt links to game/character/team routes, so the fixture needs a
        router context. Navigation itself is not exercised here. */}
    <BrowserRouter>
      <BettingTab mode={mode === 'season' ? 'season' : undefined} />
    </BrowserRouter>
  </StrictMode>,
)

window.__BETTING_MOUNTED__ = true
