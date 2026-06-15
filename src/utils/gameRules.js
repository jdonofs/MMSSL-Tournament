export const DEFAULT_REGULATION_INNINGS = 3
export const DEFAULT_MERCY_RULE_DIFFERENTIAL = 10

export function normalizeRegulationInnings(value, fallback = DEFAULT_REGULATION_INNINGS) {
  const fallbackValue = Number.isFinite(Number(fallback)) && Number(fallback) >= 1
    ? Math.trunc(Number(fallback))
    : DEFAULT_REGULATION_INNINGS
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return fallbackValue
  return Math.trunc(numeric)
}

export function normalizeMercyRuleDifferential(value, fallback = DEFAULT_MERCY_RULE_DIFFERENTIAL) {
  const fallbackValue = Number.isFinite(Number(fallback)) && Number(fallback) >= 1
    ? Math.trunc(Number(fallback))
    : DEFAULT_MERCY_RULE_DIFFERENTIAL
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return fallbackValue
  return Math.trunc(numeric)
}

export function deriveOffense(game, outsRecorded) {
  const halfInning = Math.floor(outsRecorded / 3)
  const isTop = halfInning % 2 === 0
  const inning = Math.floor(halfInning / 2) + 1
  // `home_away_swapped` flips which team bats in the top vs bottom of the inning
  // (i.e. who's "away"/"home") without touching team_a/team_b assignments.
  const awayPlayerId = game.home_away_swapped ? game.team_b_player_id : game.team_a_player_id
  const homePlayerId = game.home_away_swapped ? game.team_a_player_id : game.team_b_player_id
  return {
    battingPlayerId: isTop ? awayPlayerId : homePlayerId,
    pitchingPlayerId: isTop ? homePlayerId : awayPlayerId,
    inning, isTop, halfLabel: `${isTop ? 'Top' : 'Bot'} ${inning}`,
  }
}

export function getFinalStatusLabel(game, regulationInnings = game?.innings) {
  const normalizedRegulationInnings = normalizeRegulationInnings(
    regulationInnings ?? game?.innings,
    DEFAULT_REGULATION_INNINGS,
  )
  const recordedFinalInning = Number(game?.final_inning ?? game?.current_inning ?? 0)
  const finalInning = Number.isFinite(recordedFinalInning) && recordedFinalInning >= 1
    ? Math.trunc(recordedFinalInning)
    : null

  if (finalInning && (Boolean(game?.is_extra_innings) || finalInning > normalizedRegulationInnings)) {
    return `Final/${finalInning}`
  }

  return 'Final'
}
