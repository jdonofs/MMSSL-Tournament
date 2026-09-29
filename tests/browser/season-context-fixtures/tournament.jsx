import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { TournamentProvider, useTournament } from '../../../src/context/TournamentContext.jsx'

function Probe() {
  const context = useTournament()
  useEffect(() => {
    window.__TOURNAMENT__ = {
      selected: context.selectedTournamentId,
      loading: context.loading,
      error: context.error,
      available: context.available,
      tournaments: context.allTournaments.map((row) => row.id),
    }
    window.__TOURNAMENT_ACTIONS__ = {
      select: (id) => context.setSelectedTournamentId(id),
      refresh: (id) => context.refreshTournaments(id).catch(() => {}),
    }
  })
  return null
}

createRoot(document.getElementById('root')).render(<TournamentProvider><Probe /></TournamentProvider>)
