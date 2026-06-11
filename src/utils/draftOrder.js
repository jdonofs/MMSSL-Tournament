// Snake-draft order: odd rounds go in player order, even rounds reverse.
export function snakeOrder(players, round) {
  return round % 2 === 1 ? players : [...players].reverse()
}

// Normalizes season_roster rows (which don't carry pick metadata) into the
// same shape as tournament draft_picks rows, so shared draft-order logic
// can treat both modes identically.
export function normalizeSeasonDraftPicks(rosterRows, seasonId, seasonTeams, charactersByName) {
  const teamCount = Math.max((seasonTeams || []).length, 1)
  return (rosterRows || []).map((entry, index) => ({
    ...entry,
    tournament_id: seasonId,
    pick_number: index + 1,
    round: Math.ceil((index + 1) / teamCount),
    pick_in_round: (index % teamCount) + 1,
    player_id: (seasonTeams || []).find((team) => team.id === entry.team_id)?.player_id || null,
    character_id: charactersByName[entry.character_name]?.id || null,
    mii_color: null,
    is_captain: index < (seasonTeams || []).length,
  }))
}

// Computes the current draft state (round, pick number, current drafter,
// whether the draft is complete) from the player order and existing picks.
export function getCurrentDraftState(players, draftPicks) {
  const currentPickNumber = draftPicks.length + 1
  const round = Math.ceil(currentPickNumber / Math.max(players.length, 1))
  const orderThisRound = snakeOrder(players, round)
  const pickInRound = (currentPickNumber - 1) % Math.max(players.length, 1)
  const totalPicks = players.length > 0 ? players.length * 9 : 54
  const isDraftComplete = players.length > 0 && draftPicks.length >= totalPicks
  const currentDrafter = isDraftComplete ? null : orderThisRound[pickInRound]
  return { currentPickNumber, round, pickInRound, totalPicks, isDraftComplete, currentDrafter, orderThisRound }
}
