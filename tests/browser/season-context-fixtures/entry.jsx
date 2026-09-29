import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { SeasonProvider, useSeason } from '../../../src/context/SeasonContext.jsx'

function Probe() {
  const context = useSeason()
  useEffect(() => {
    window.__SEASON__ = {
      selected: context.selectedSeasonId,
      loading: context.loading,
      error: context.error,
      available: context.available,
      seasons: context.allSeasons.map((row) => row.id),
      teams: context.seasonTeams.map((row) => row.id),
      schedule: context.schedule.map((row) => row.id),
      ledger: context.seasonBettingLedger.map((row) => row.id),
      players: context.players.map((row) => row.id),
    }
    window.__SEASON_ACTIONS__ = {
      select: (id) => context.setSelectedSeasonId(id),
      refresh: (id, options) => context.refreshSeasons(id, options).catch(() => {}),
    }
  })
  return <div data-testid="mounted-content">{context.schedule.map((game) => game.id).join(',')}</div>
}

const root = createRoot(document.getElementById('root'))
window.__UNMOUNT__ = () => root.unmount()
root.render(<SeasonProvider><Probe /></SeasonProvider>)
