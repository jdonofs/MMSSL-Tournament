import {
  getDoubleElimTemplate,
  normalizeStage,
  resolveTemplateStages,
} from './bracketTemplates'

function findStageGame(games, stage) {
  return games.find((game) => normalizeStage(game.stage) === stage)
}

function nextGameCode(games) {
  const highest = Math.max(...games.map((game) => Number(String(game.game_code || '').replace(/\D/g, '')) || 0), 0)
  return `G${highest + 1}`
}

async function insertGame(supabase, games, tournamentId, stage, teamA, teamB) {
  const { data, error } = await supabase
    .from('games')
    .insert({
      tournament_id: tournamentId,
      game_code: nextGameCode(games),
      stage,
      team_a_player_id: teamA || null,
      team_b_player_id: teamB || null,
      team_a_runs: 0,
      team_b_runs: 0,
      status: 'pending',
    })
    .select()
    .single()

  if (error) throw error
  return data
}

async function updateGameParticipants(supabase, game, teamA, teamB) {
  const { data, error } = await supabase
    .from('games')
    .update({
      team_a_player_id: teamA || null,
      team_b_player_id: teamB || null,
    })
    .eq('id', game.id)
    .select()
    .single()

  if (error) throw error
  return data
}

async function syncDoubleElimTemplate({ supabase, tournament, games, createMissing = false }) {
  const template = getDoubleElimTemplate((tournament.player_ids || []).length)
  if (!template) return []

  const changedGames = []
  const workingGames = [...games]

  for (const spec of resolveTemplateStages(template, tournament.seeding || [], workingGames)) {
    const existing = findStageGame(workingGames, spec.stage)
    if (!existing) {
      if (!createMissing) continue
      const created = await insertGame(supabase, workingGames, tournament.id, spec.stage, spec.teamA, spec.teamB)
      workingGames.push(created)
      changedGames.push(created)
      continue
    }

    if (existing.status !== 'pending') continue
    if (
      String(existing.team_a_player_id || '') === String(spec.teamA || '') &&
      String(existing.team_b_player_id || '') === String(spec.teamB || '')
    ) {
      continue
    }

    const updated = await updateGameParticipants(supabase, existing, spec.teamA, spec.teamB)
    const index = workingGames.findIndex((game) => game.id === existing.id)
    if (index >= 0) workingGames[index] = updated
    changedGames.push(updated)
  }

  return changedGames
}

export async function syncBracketStructure({ supabase, tournament, games }) {
  if (!tournament || tournament.bracket_format !== 'double') return []
  const syncedGames = await syncDoubleElimTemplate({ supabase, tournament, games, createMissing: false })
  const allGames = [...games]
  syncedGames.forEach((game) => {
    const index = allGames.findIndex((entry) => entry.id === game.id)
    if (index >= 0) allGames[index] = game
    else allGames.push(game)
  })
  const resetGames = await syncChampionshipResetState({ supabase, tournament, games: allGames })
  return [...syncedGames, ...resetGames]
}

async function syncChampionshipResetState({ supabase, tournament, games }) {
  const winnersFinal = findStageGame(games, 'Winners Final')
  const championship = findStageGame(games, 'Championship')
  const resetGame = findStageGame(games, 'Championship Reset')

  const shouldEnableReset =
    winnersFinal?.winner_player_id &&
    championship?.winner_player_id &&
    championship.winner_player_id !== winnersFinal.winner_player_id

  if (!shouldEnableReset) {
    if (
      resetGame &&
      resetGame.status === 'pending' &&
      (resetGame.team_a_player_id || resetGame.team_b_player_id)
    ) {
      const cleared = await updateGameParticipants(supabase, resetGame, null, null)
      return [cleared]
    }
    return []
  }

  if (resetGame) {
    if (resetGame.status !== 'pending') return []
    if (
      String(resetGame.team_a_player_id || '') === String(championship.team_a_player_id || '') &&
      String(resetGame.team_b_player_id || '') === String(championship.team_b_player_id || '')
    ) {
      return []
    }
    const updated = await updateGameParticipants(
      supabase,
      resetGame,
      championship.team_a_player_id,
      championship.team_b_player_id,
    )
    return [updated]
  }

  const created = await insertGame(
    supabase,
    games,
    tournament.id,
    'Championship Reset',
    championship.team_a_player_id,
    championship.team_b_player_id,
  )

  return [created]
}

async function advanceSingleElim({ supabase, tournament, games, completedGame }) {
  const match = normalizeStage(completedGame.stage).match(/^Round (\d+)-(\d+)$/)
  if (!match) return []

  const roundNumber = Number(match[1])
  const matchNumber = Number(match[2])
  const siblingMatchNumber = matchNumber % 2 === 0 ? matchNumber - 1 : matchNumber + 1
  const sibling = findStageGame(games, `Round ${roundNumber}-${siblingMatchNumber}`)
  if (!sibling?.winner_player_id) return []

  const nextStage = `Round ${roundNumber + 1}-${Math.ceil(matchNumber / 2)}`
  if (findStageGame(games, nextStage)) return []

  const created = await insertGame(
    supabase,
    games,
    tournament.id,
    nextStage,
    matchNumber % 2 === 0 ? sibling.winner_player_id : completedGame.winner_player_id,
    matchNumber % 2 === 0 ? completedGame.winner_player_id : sibling.winner_player_id,
  )

  return [created]
}

export async function advanceBracketOnGameComplete({ supabase, tournament, games, completedGame }) {
  if (!tournament || !completedGame?.winner_player_id) return []

  if (tournament.bracket_format === 'single') {
    return advanceSingleElim({ supabase, tournament, games, completedGame })
  }

  if (tournament.bracket_format !== 'double') return []

  const syncedGames = await syncDoubleElimTemplate({ supabase, tournament, games, createMissing: false })
  const allGames = [...games]
  syncedGames.forEach((game) => {
    const index = allGames.findIndex((entry) => entry.id === game.id)
    if (index >= 0) allGames[index] = game
    else allGames.push(game)
  })

  const resetGames = await syncChampionshipResetState({
    supabase,
    tournament,
    games: allGames,
  })

  return [...syncedGames, ...resetGames]
}
