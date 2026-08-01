const SEASON_GAME_ID_PREFIX = 'season-'

export function normalizeSeasonGameId(gameId) {
  if (gameId == null) return gameId
  const value = String(gameId)
  return value.startsWith(SEASON_GAME_ID_PREFIX) ? value : `${SEASON_GAME_ID_PREFIX}${value}`
}

export function normalizeSeasonRowGameId(row) {
  if (!row || row.game_id == null) return row
  return { ...row, game_id: normalizeSeasonGameId(row.game_id) }
}

export function normalizeSeasonRowsByGameId(rows = []) {
  return rows.map((row) => normalizeSeasonRowGameId(row))
}

export function normalizeSeasonScheduleRows(schedule = []) {
  return schedule.map((game) => (
    game?.id == null
      ? game
      : { ...game, id: normalizeSeasonGameId(game.id), source_game_id: game.id }
  ))
}
