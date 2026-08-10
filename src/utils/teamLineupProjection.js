export function gamePitcherKey(gameId, playerId) {
  return `${gameId}:${playerId}`
}

// Resolves the current pitcher directly from each game's open position-1
// game_fielders row. Keys include the game id so two scheduled games involving
// the same team cannot accidentally share one expected-pitcher value.
export function buildActivePitcherByGamePlayer({
  games = [],
  gameFielders = [],
  characters = [],
  seasonTeams = [],
  isSeasonMode = false,
} = {}) {
  const gamesById = Object.fromEntries(games.map((game) => [String(game.id), game]))
  const characterIdByName = Object.fromEntries(characters.map((character) => [character.name, character.id]))
  const playerIdBySeasonTeamId = Object.fromEntries(seasonTeams.map((team) => [String(team.id), team.player_id]))
  const selected = {}

  for (const row of gameFielders) {
    if (Number(row.position) !== 1 || row.inning_to != null) continue
    const game = gamesById[String(row.game_id)]
    if (!game) continue
    const playerId = isSeasonMode
      ? playerIdBySeasonTeamId[String(row.team_id)]
      : row.team_id
    if (playerId == null) continue
    if (![game.team_a_player_id, game.team_b_player_id].some((id) => String(id) === String(playerId))) continue

    const characterId = characterIdByName[row.character]
    if (characterId == null) continue
    const key = gamePitcherKey(game.id, playerId)
    const rank = [Number(row.inning_from || 1), String(row.created_at || ''), Number(row.id || 0)]
    const prior = selected[key]
    if (!prior || rank[0] > prior.rank[0]
      || (rank[0] === prior.rank[0] && rank[1] > prior.rank[1])
      || (rank[0] === prior.rank[0] && rank[1] === prior.rank[1] && rank[2] > prior.rank[2])) {
      selected[key] = { characterId, rank }
    }
  }

  return Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, value.characterId]))
}
