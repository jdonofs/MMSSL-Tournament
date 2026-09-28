export function embeddedTrackerSnapshotError(snapshot, { gameId, gameStatus } = {}) {
  if (gameId != null && snapshot?.game?.game_id != null
    && String(snapshot.game.game_id) !== String(gameId)) {
    return `The local tracker is recording game #${snapshot.game.game_id}, not this game.`
  }
  if (['pending', 'scheduled'].includes(gameStatus)
    && Number(snapshot?.at_bat_count ?? snapshot?.at_bats?.length ?? 0) > 0) {
    return 'The previous tracker session is still visible locally. Waiting for a new game session.'
  }
  return null
}
