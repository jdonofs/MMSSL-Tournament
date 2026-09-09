export function resolveGameCompletionDetails({
  winnerId,
  finalInning,
  isExtra,
  scores,
  selectedGame,
  currentInning,
  regulationInnings,
}) {
  const resolvedWinnerId = winnerId ?? (
    scores.a === scores.b
      ? null
      : scores.a > scores.b ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
  )
  const resolvedFinalInning = Number(finalInning || currentInning)
  const resolvedIsExtra = isExtra == null
    ? resolvedFinalInning > regulationInnings
    : Boolean(isExtra)

  return { resolvedWinnerId, resolvedFinalInning, resolvedIsExtra }
}

export function buildGameCompletionPatch({
  isSeasonGame,
  winnerId,
  scores,
  finalInning,
  isExtra,
  teamIdByPlayerId = {},
  clearedLiveState,
}) {
  if (isSeasonGame) {
    return {
      status: 'completed',
      live_state: clearedLiveState,
      winner_team_id: winnerId ? teamIdByPlayerId[winnerId] || null : null,
      away_score: scores.a,
      home_score: scores.b,
      final_inning: finalInning,
      is_extra_innings: isExtra,
    }
  }

  return {
    status: 'complete',
    live_state: clearedLiveState,
    winner_player_id: winnerId,
    team_a_runs: scores.a,
    team_b_runs: scores.b,
    final_inning: finalInning,
    is_extra_innings: isExtra,
  }
}

export function buildGameReopenPatch({ isSeasonGame, scores, clearedLiveState }) {
  if (isSeasonGame) {
    return {
      status: 'in_progress',
      live_state: clearedLiveState,
      winner_team_id: null,
      away_score: scores.a,
      home_score: scores.b,
      final_inning: null,
      is_extra_innings: false,
    }
  }

  return {
    status: 'active',
    live_state: clearedLiveState,
    winner_player_id: null,
    team_a_runs: scores.a,
    team_b_runs: scores.b,
    final_inning: null,
    is_extra_innings: false,
  }
}

export function buildGameResetPatch({ isSeasonGame }) {
  const sourceFields = isSeasonGame
    ? { status: 'scheduled', home_score: null, away_score: null, winner_team_id: null }
    : { status: 'pending', team_a_runs: 0, team_b_runs: 0, winner_player_id: null }

  return {
    ...sourceFields,
    live_state: {},
    final_inning: null,
    is_extra_innings: false,
  }
}
