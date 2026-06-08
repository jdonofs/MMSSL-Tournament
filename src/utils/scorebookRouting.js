export const TOURNAMENT_SCOREBOOK_PATH = '/scorebook'
export const SEASON_SCOREBOOK_PATH = '/season/scorebook'

export function buildScorebookPath({ gameId, source = 'tournament' } = {}) {
  const pathname = source === 'season' ? SEASON_SCOREBOOK_PATH : TOURNAMENT_SCOREBOOK_PATH

  if (gameId == null || gameId === '') {
    return pathname
  }

  const params = new URLSearchParams({ game: String(gameId) })
  return `${pathname}?${params.toString()}`
}

export function resolveScorebookSource({ pathname = '', searchParams } = {}) {
  if (pathname.startsWith(SEASON_SCOREBOOK_PATH)) {
    return 'season'
  }

  const sourceParam = typeof searchParams?.get === 'function' ? searchParams.get('source') : null
  return sourceParam === 'season' ? 'season' : 'tournament'
}
