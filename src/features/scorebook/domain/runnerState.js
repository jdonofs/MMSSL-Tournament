export function getRunnerStateStorageKey(gameId, halfIdx) {
  return `scorebook-runners:${gameId}:${halfIdx}`
}

export function getRunnerHistoryStorageKey(gameId, halfIdx) {
  return `scorebook-runners-history:${gameId}:${halfIdx}`
}

export function getActivePaStorageKey(gameId) {
  return `scorebook-active-pa:${gameId}`
}

export function sanitizeRunnersForOffense(nextRunners, offense) {
  if (!offense?.battingPlayerId) return nextRunners
  const isOffensiveRunner = (runner) => (
    runner
    && String(runner.playerId) === String(offense.battingPlayerId)
  )
  return {
    first: isOffensiveRunner(nextRunners?.first) ? nextRunners.first : null,
    second: isOffensiveRunner(nextRunners?.second) ? nextRunners.second : null,
    third: isOffensiveRunner(nextRunners?.third) ? nextRunners.third : null,
  }
}
