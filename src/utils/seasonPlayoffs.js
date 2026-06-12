import { reopenGameBets } from './betResolution'
import {
  getDoubleElimTemplate,
  getSingleElimTemplate,
  normalizeStage,
} from './bracketTemplates'

const SEASON_BET_RESOLUTION_CONFIG = {
  betsTable: 'season_bets',
  gameOddsTable: 'season_game_odds',
  enableCalibrationLogging: false,
  enableWeightAdjustment: false,
  ledgerTable: 'season_betting_ledger',
  wagerField: 'wager_dollars',
  payoutField: 'potential_payout_dollars',
  ledgerChangeField: 'dollars_change',
  sourceIdField: 'season_id',
}

function parseSeedRef(ref = '') {
  const match = String(ref).match(/^Seed(\d+)$/)
  return match ? Number(match[1]) : null
}

function normalizePlayoffFormat(value = '') {
  return value === 'single' ? 'single_elimination' : (value || 'double_elimination')
}

function findStageGame(games = [], stage = '') {
  return games.find((game) => normalizeStage(game.stage) === stage)
}

function getPlayoffTemplate(teamCount, playoffFormat) {
  if (normalizePlayoffFormat(playoffFormat) === 'single_elimination') {
    return getSingleElimTemplate(teamCount)
  }
  return getDoubleElimTemplate(teamCount) || []
}

function buildStageOrderMap(teamCount, playoffFormat) {
  const template = getPlayoffTemplate(teamCount, playoffFormat)
  const order = template.map((spec) => spec.stage)
  if (normalizePlayoffFormat(playoffFormat) === 'double_elimination') {
    order.push('Championship Reset')
  }
  return new Map(order.map((stage, index) => [normalizeStage(stage), index]))
}

function getLoserTeamId(game) {
  if (!game?.winner_team_id) return null
  if (String(game.winner_team_id) === String(game.home_team_id || '')) return game.away_team_id || null
  if (String(game.winner_team_id) === String(game.away_team_id || '')) return game.home_team_id || null
  return null
}

function resolveSeasonBracketRef(ref, seeding, gamesByStage) {
  const seedNumber = parseSeedRef(ref)
  if (seedNumber) return seeding[seedNumber - 1] || null
  if (typeof ref !== 'string' || ref.length < 3) return null

  const type = ref[0]
  const stage = normalizeStage(ref.slice(2))
  const game = gamesByStage.get(stage)
  if (!game) return null
  if (type === 'W') return game.winner_team_id || null
  if (type === 'L') return getLoserTeamId(game)
  return null
}

function resolveSeasonTemplateStages(template, seeding, games) {
  const gamesByStage = new Map(games.map((game) => [normalizeStage(game.stage), game]))
  return template.map((spec) => ({
    stage: spec.stage,
    homeTeamId: resolveSeasonBracketRef(spec.teamARef, seeding, gamesByStage),
    awayTeamId: resolveSeasonBracketRef(spec.teamBRef, seeding, gamesByStage),
  }))
}

function mergeGames(games = [], changedGames = []) {
  const byId = new Map(games.map((game) => [game.id, game]))
  changedGames.forEach((game) => {
    byId.set(game.id, game)
  })
  return Array.from(byId.values())
}

function homeTeamChanged(game, nextHomeTeamId) {
  return String(game.home_team_id || '') !== String(nextHomeTeamId || '')
}

function buildSeasonGamePatch(game, nextHomeTeamId, nextAwayTeamId, resetGame) {
  const patch = {
    home_team_id: nextHomeTeamId || null,
    away_team_id: nextAwayTeamId || null,
    stadium_picker_team_id: nextHomeTeamId || null,
  }

  if (homeTeamChanged(game, nextHomeTeamId) || !nextHomeTeamId) {
    patch.stadium = null
    patch.is_night = false
  }

  if (resetGame) {
    patch.status = 'scheduled'
    patch.winner_team_id = null
    patch.away_score = 0
    patch.home_score = 0
    patch.live_state = null
    patch.final_inning = null
    patch.is_extra_innings = false
  }

  return patch
}

async function clearSeasonGameArtifacts(supabase, gameId, seasonId) {
  await reopenGameBets(gameId, {
    ...SEASON_BET_RESOLUTION_CONFIG,
    sourceIdValue: seasonId,
  })

  const results = await Promise.all([
    supabase.from('season_lineups').delete().eq('game_id', gameId),
    supabase.from('season_plate_appearances').delete().eq('game_id', gameId),
    supabase.from('season_pitching_stints').delete().eq('game_id', gameId),
    supabase.from('season_pitches').delete().eq('game_id', gameId),
    supabase.from('season_game_fielders').delete().eq('game_id', gameId),
    supabase.from('season_runs_scored').delete().eq('game_id', gameId),
    supabase.from('season_inning_scores').delete().eq('game_id', gameId),
    supabase.from('season_game_odds').delete().eq('game_id', gameId),
    supabase.from('season_game_settlements').delete().eq('game_id', gameId),
    supabase.from('season_stadium_game_log').delete().eq('game_id', gameId),
  ])

  const failed = results.find((result) => result.error)
  if (failed?.error) throw failed.error
}

async function insertSeasonPlayoffGame(supabase, season, roundNumber, stage, homeTeamId, awayTeamId) {
  const { data, error } = await supabase
    .from('season_schedule')
    .insert({
      season_id: season.id,
      round_number: roundNumber,
      stage,
      home_team_id: homeTeamId || null,
      away_team_id: awayTeamId || null,
      stadium_picker_team_id: homeTeamId || null,
      stadium: null,
      is_night: false,
      status: 'scheduled',
      away_score: 0,
      home_score: 0,
      winner_team_id: null,
      innings: season.innings,
      mercy_rule: season.mercy_rule === true,
      mercy_rule_differential: season.mercy_rule_differential,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

async function updateSeasonPlayoffGame(supabase, game, nextHomeTeamId, nextAwayTeamId, resetGame = false) {
  const patch = buildSeasonGamePatch(game, nextHomeTeamId, nextAwayTeamId, resetGame)
  const { data, error } = await supabase
    .from('season_schedule')
    .update(patch)
    .eq('id', game.id)
    .select()
    .single()

  if (error) throw error
  return data
}

async function syncSeasonPlayoffTemplate({
  supabase,
  season,
  standings,
  schedule,
  createMissing = false,
} = {}) {
  const seeding = (standings || []).map((entry) => entry.id)
  const template = getPlayoffTemplate(seeding.length, season?.playoff_format)
  if (!season?.id || !template.length) return []

  const regularSeasonMaxRound = Math.max(
    0,
    ...(schedule || [])
      .filter((game) => !game.stage)
      .map((game) => Number(game.round_number || 0)),
  )
  const changedGames = []
  const workingGames = (schedule || []).filter((game) => Boolean(game.stage))

  for (let index = 0; index < template.length; index += 1) {
    const spec = resolveSeasonTemplateStages(template, seeding, workingGames)[index]
    const existing = findStageGame(workingGames, spec.stage)

    if (!existing) {
      if (!createMissing) continue
      const created = await insertSeasonPlayoffGame(
        supabase,
        season,
        regularSeasonMaxRound + index + 1,
        spec.stage,
        spec.homeTeamId,
        spec.awayTeamId,
      )
      workingGames.push(created)
      changedGames.push(created)
      continue
    }

    const nextHomeTeamId = spec.homeTeamId || null
    const nextAwayTeamId = spec.awayTeamId || null
    const participantsMatch =
      String(existing.home_team_id || '') === String(nextHomeTeamId || '')
      && String(existing.away_team_id || '') === String(nextAwayTeamId || '')
    const needsReset = !participantsMatch && existing.status !== 'scheduled'
    const stadiumPickerChanged = String(existing.stadium_picker_team_id || '') !== String(nextHomeTeamId || '')

    if (!needsReset && participantsMatch && !stadiumPickerChanged) {
      continue
    }

    const updated = await updateSeasonPlayoffGame(
      supabase,
      existing,
      nextHomeTeamId,
      nextAwayTeamId,
      needsReset,
    )

    if (needsReset) {
      await clearSeasonGameArtifacts(supabase, existing.id, season.id)
    }

    const workingIndex = workingGames.findIndex((game) => game.id === existing.id)
    if (workingIndex >= 0) workingGames[workingIndex] = updated
    changedGames.push(updated)
  }

  return changedGames
}

async function syncSeasonChampionshipResetState({
  supabase,
  season,
  standings,
  schedule,
} = {}) {
  const seeding = (standings || []).map((entry) => entry.id)
  const stageOrderMap = buildStageOrderMap(seeding.length, season?.playoff_format)
  const orderedGames = sortSeasonPlayoffGames(
    (schedule || []).filter((game) => Boolean(game.stage)),
    season?.playoff_format,
    seeding.length,
  )
  const winnersFinal = findStageGame(orderedGames, 'Winners Final')
  const championship = findStageGame(orderedGames, 'Championship')
  const resetGame = findStageGame(orderedGames, 'Championship Reset')

  const shouldEnableReset =
    winnersFinal?.winner_team_id
    && championship?.winner_team_id
    && String(championship.winner_team_id) !== String(winnersFinal.winner_team_id)

  if (!shouldEnableReset) {
    if (
      resetGame
      && resetGame.status === 'scheduled'
      && (resetGame.home_team_id || resetGame.away_team_id || resetGame.stadium_picker_team_id)
    ) {
      const cleared = await updateSeasonPlayoffGame(supabase, resetGame, null, null)
      return [cleared]
    }
    return []
  }

  if (resetGame) {
    const participantsMatch =
      String(resetGame.home_team_id || '') === String(championship.home_team_id || '')
      && String(resetGame.away_team_id || '') === String(championship.away_team_id || '')
    if (participantsMatch) return []

    const needsReset = resetGame.status !== 'scheduled'
    const updated = await updateSeasonPlayoffGame(
      supabase,
      resetGame,
      championship.home_team_id,
      championship.away_team_id,
      needsReset,
    )

    if (needsReset) {
      await clearSeasonGameArtifacts(supabase, resetGame.id, season.id)
    }

    return [updated]
  }

  const nextRoundNumber = Math.max(
    0,
    ...(schedule || []).map((game) => Number(game.round_number || 0)),
    stageOrderMap.size,
  ) + 1
  const created = await insertSeasonPlayoffGame(
    supabase,
    season,
    nextRoundNumber,
    'Championship Reset',
    championship.home_team_id,
    championship.away_team_id,
  )
  return [created]
}

function getSeasonChampionTeamId(season, standings, schedule) {
  const seeding = (standings || []).map((entry) => entry.id)
  const orderedGames = sortSeasonPlayoffGames(
    (schedule || []).filter((game) => Boolean(game.stage)),
    season?.playoff_format,
    seeding.length,
  )

  if (normalizePlayoffFormat(season?.playoff_format) === 'single_elimination') {
    const template = getPlayoffTemplate(seeding.length, season?.playoff_format)
    const finalStage = template[template.length - 1]?.stage || null
    const finalGame = finalStage ? findStageGame(orderedGames, finalStage) : null
    return finalGame?.status === 'completed' ? finalGame.winner_team_id || null : null
  }

  const winnersFinal = findStageGame(orderedGames, 'Winners Final')
  const championship = findStageGame(orderedGames, 'Championship')
  const resetGame = findStageGame(orderedGames, 'Championship Reset')

  if (resetGame?.status === 'completed' && resetGame.winner_team_id) {
    return resetGame.winner_team_id
  }

  if (
    winnersFinal?.winner_team_id
    && championship?.status === 'completed'
    && championship.winner_team_id
    && String(championship.winner_team_id) === String(winnersFinal.winner_team_id)
  ) {
    return championship.winner_team_id
  }

  return null
}

export function sortSeasonPlayoffGames(games = [], playoffFormat = 'double_elimination', teamCount = 0) {
  const orderMap = buildStageOrderMap(teamCount, playoffFormat)
  return [...games].sort((a, b) => {
    const aOrder = orderMap.has(normalizeStage(a.stage)) ? orderMap.get(normalizeStage(a.stage)) : Number.MAX_SAFE_INTEGER
    const bOrder = orderMap.has(normalizeStage(b.stage)) ? orderMap.get(normalizeStage(b.stage)) : Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    return Number(a.id || 0) - Number(b.id || 0)
  })
}

export async function seedSeasonPlayoffs({
  supabase,
  season,
  standings,
  schedule,
} = {}) {
  if (!season?.id) return []
  return syncSeasonPlayoffTemplate({
    supabase,
    season,
    standings,
    schedule,
    createMissing: true,
  })
}

export async function advanceSeasonPlayoffs({
  supabase,
  season,
  standings,
  schedule,
  seasonTeams,
} = {}) {
  if (!season?.id) return []

  const syncedGames = await syncSeasonPlayoffTemplate({
    supabase,
    season,
    standings,
    schedule,
    createMissing: true,
  })
  const resetGames = await syncSeasonChampionshipResetState({
    supabase,
    season,
    standings,
    schedule: mergeGames(schedule, syncedGames),
  })
  const mergedSchedule = mergeGames(schedule, [...syncedGames, ...resetGames])
  const championTeamId = getSeasonChampionTeamId(season, standings, mergedSchedule)
  const teamById = Object.fromEntries((seasonTeams || []).map((team) => [String(team.id), team]))

  await supabase
    .from('seasons')
    .update({
      champion_player_id: championTeamId ? teamById[String(championTeamId)]?.player_id || null : null,
      status: championTeamId ? 'completed' : 'playoffs',
    })
    .eq('id', season.id)

  return [...syncedGames, ...resetGames]
}

export async function reopenSeasonPlayoffs({
  supabase,
  season,
  standings,
  schedule,
  seasonTeams,
} = {}) {
  if (!season?.id) return []

  const syncedGames = await syncSeasonPlayoffTemplate({
    supabase,
    season,
    standings,
    schedule,
    createMissing: true,
  })
  const resetGames = await syncSeasonChampionshipResetState({
    supabase,
    season,
    standings,
    schedule: mergeGames(schedule, syncedGames),
  })
  const mergedSchedule = mergeGames(schedule, [...syncedGames, ...resetGames])
  const championTeamId = getSeasonChampionTeamId(season, standings, mergedSchedule)
  const teamById = Object.fromEntries((seasonTeams || []).map((team) => [String(team.id), team]))
  const allRegularSeasonComplete = mergedSchedule
    .filter((game) => !game.stage)
    .every((game) => game.status === 'completed')

  await supabase
    .from('seasons')
    .update({
      champion_player_id: championTeamId ? teamById[String(championTeamId)]?.player_id || null : null,
      status: championTeamId ? 'completed' : (allRegularSeasonComplete ? 'playoffs' : 'active'),
    })
    .eq('id', season.id)

  return [...syncedGames, ...resetGames]
}
