import { useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import Scorebook from '../pages/Scorebook'
import TournamentGameSessionProvider from './TournamentGameSessionProvider'
import SeasonGameSessionProvider from './SeasonGameSessionProvider'
import { resolveScorebookSource } from '../utils/scorebookRouting'

export default function ScorebookRoute() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const sourceType = useMemo(
    () => resolveScorebookSource({ pathname: location.pathname, searchParams }),
    [location.pathname, searchParams],
  )

  if (sourceType === 'season') {
    return (
      <SeasonGameSessionProvider>
        <Scorebook />
      </SeasonGameSessionProvider>
    )
  }

  return (
    <TournamentGameSessionProvider>
      <Scorebook />
    </TournamentGameSessionProvider>
  )
}
