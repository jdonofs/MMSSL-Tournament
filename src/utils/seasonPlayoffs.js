import { reopenGameBets } from './betResolution.js'
import { buildSeasonStandings } from './competitionStandings.js'
import {
  getDoubleElimTemplate,
  getSingleElimTemplate,
  normalizeStage,
} from './bracketTemplates.js'

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

export function normalizePlayoffFormat(value = '') {
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

function gameStatusPriority(status) {
  if (status === 'completed') return 3
  if (status === 'in_progress') return 2
  return 1
}

function compareStableGameIds(a, b) {
  const numericA = Number(a?.id)
  const numericB = Number(b?.id)
  if (Number.isFinite(numericA) && Number.isFinite(numericB)) return numericA - numericB
  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

// A stage is the stable identity of a playoff game. Older clients could race
// while creating a bracket and leave duplicate rows behind; UI consumers use
// the most-progressed row (then the lowest id) so row arrival order cannot
// change the displayed bracket or its sequential lock state.
function getCanonicalSeasonPlayoffGames(games = []) {
  const byStage = new Map()
  games.filter((game) => Boolean(game?.stage)).forEach((game) => {
    const stage = normalizeStage(game.stage)
    const current = byStage.get(stage)
    if (!current) {
      byStage.set(stage, game)
      return
    }
    const priorityDelta = gameStatusPriority(game.status) - gameStatusPriority(current.status)
    if (priorityDelta > 0 || (priorityDelta === 0 && compareStableGameIds(game, current) < 0)) {
      byStage.set(stage, game)
    }
  })
  return Array.from(byStage.values())
}

export function deriveSeasonPlayoffUiState({
  schedule = [],
  playoffFormat = 'double_elimination',
  teamCount = 0,
  seasonStatus = 'active',
} = {}) {
  const orderedGames = sortSeasonPlayoffGames(schedule, playoffFormat, teamCount)
  const visibleGames = orderedGames.filter((game) => game.home_team_id || game.away_team_id)
  const metaByGameId = {}

  orderedGames.forEach((game, index) => {
    const blockingPreviousGame = orderedGames
      .slice(0, index)
      .find((previousGame) => previousGame.status !== 'completed') || null
    const previousComplete = !blockingPreviousGame
    const missingHome = !game.home_team_id
    const missingAway = !game.away_team_id
    const seasonComplete = seasonStatus === 'completed'
    const gameComplete = game.status === 'completed'

    let lockReason = ''
    if (seasonComplete && !gameComplete) {
      lockReason = 'This season is complete.'
    } else if (!previousComplete) {
      lockReason = `Complete ${blockingPreviousGame.stage} first.`
    } else if (missingHome && missingAway) {
      lockReason = 'Waiting for both teams to be determined.'
    } else if (missingHome) {
      lockReason = 'Waiting for the home team slot to be determined.'
    } else if (missingAway) {
      lockReason = 'Waiting for the away team slot to be determined.'
    }

    const canStartGame = !seasonComplete && previousComplete && !missingHome && !missingAway
    metaByGameId[String(game.id)] = {
      canStartGame,
      canOpenGame: gameComplete || canStartGame,
      canSelectStadium: !seasonComplete && !gameComplete && Boolean(game.home_team_id),
      isVisible: Boolean(game.home_team_id || game.away_team_id),
      lockReason,
    }
  })

  return { orderedGames, visibleGames, metaByGameId }
}

export function resolveSeasonScorebookGameId({
  requestedGameId,
  schedule = [],
  playoffFormat = 'double_elimination',
  teamCount = 0,
  seasonStatus = 'active',
} = {}) {
  const requestedGame = schedule.find((game) => String(game.id) === String(requestedGameId))
  if (!requestedGame?.stage) return requestedGame ? requestedGameId : 0
  const { metaByGameId } = deriveSeasonPlayoffUiState({
    schedule,
    playoffFormat,
    teamCount,
    seasonStatus,
  })
  return metaByGameId[String(requestedGame.id)]?.canOpenGame ? requestedGameId : 0
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

function isLosersRoundStage(stage) {
  return /^Losers R\d+-/.test(normalizeStage(stage))
}

// Winners Final only needs the two Winners R2 results to resolve, but that lets
// it fill in (and be visible on the bracket) before the Losers bracket has
// caught up a round. Hold it at TBD until every other Losers-bracket round has
// been completed, so brackets fill in one round at a time.
function areLosersRoundsComplete(template, gamesByStage) {
  return template
    .filter((spec) => isLosersRoundStage(spec.stage))
    .every((spec) => Boolean(gamesByStage.get(normalizeStage(spec.stage))?.winner_team_id))
}

function resolveSeasonTemplateStages(template, seeding, games) {
  const gamesByStage = new Map(games.map((game) => [normalizeStage(game.stage), game]))
  const losersRoundsComplete = areLosersRoundsComplete(template, gamesByStage)
  return template.map((spec) => {
    const isWinnersFinal = normalizeStage(spec.stage) === 'Winners Final'
    const existing = gamesByStage.get(normalizeStage(spec.stage))
    if (isWinnersFinal && !losersRoundsComplete && existing?.status !== 'completed') {
      return { stage: spec.stage, homeTeamId: null, awayTeamId: null }
    }
    return {
      stage: spec.stage,
      homeTeamId: resolveSeasonBracketRef(spec.teamARef, seeding, gamesByStage),
      awayTeamId: resolveSeasonBracketRef(spec.teamBRef, seeding, gamesByStage),
    }
  })
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
    // season_schedule.live_state is NOT NULL — {} is the "empty" sentinel used
    // everywhere else this column is cleared for a season game (see
    // getPersistedLiveStateValue in Scorebook.jsx).
    patch.live_state = {}
    patch.final_inning = null
    patch.is_extra_innings = false
  }

  return patch
}

async function clearSeasonGameArtifacts(supabase, gameId, seasonId) {
  await reopenGameBets(gameId, {
    ...SEASON_BET_RESOLUTION_CONFIG,
    sourceIdValue: seasonId,
    supabaseClient: supabase,
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

// Reopening a regular-season game invalidates the seeding of every postseason
// game that was derived from the completed standings. Remove that downstream
// graph (including any scorebook/betting artifacts) so recompleting the regular
// season can seed a single fresh bracket from the corrected standings.
export async function clearSeasonPlayoffsAfterRegularGameReopen({
  supabase,
  season,
  schedule,
} = {}) {
  if (!season?.id) return []
  const playoffGames = (schedule || []).filter((game) => Boolean(game.stage))
  if (!playoffGames.length) return []

  for (const game of playoffGames) {
    await clearSeasonGameArtifacts(supabase, game.id, season.id)
  }

  const ids = playoffGames.map((game) => game.id)
  const { error } = await supabase
    .from('season_schedule')
    .delete()
    .in('id', ids)
  if (error) throw error
  return ids
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

async function loadSeasonSchedule(supabase, seasonId) {
  const { data, error } = await supabase
    .from('season_schedule')
    .select('*')
    .eq('season_id', seasonId)
  if (error) throw error
  return data || []
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
  // Do not trust a caller's schedule snapshot while creating stages. Completion
  // callbacks can overlap and retries commonly arrive with pre-failure state.
  const persistedSchedule = await loadSeasonSchedule(supabase, season.id)
  const workingGames = getCanonicalSeasonPlayoffGames(persistedSchedule)

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

    if (needsReset) {
      // Keep the completed row authoritative until cleanup succeeds. Cleanup
      // is idempotent, so a partial failure can be retried without exposing a
      // scheduled game whose old scorebook artifacts are still present.
      await clearSeasonGameArtifacts(supabase, existing.id, season.id)
    }

    const updated = await updateSeasonPlayoffGame(
      supabase,
      existing,
      nextHomeTeamId,
      nextAwayTeamId,
      needsReset,
    )

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
      && (resetGame.home_team_id || resetGame.away_team_id || resetGame.stadium_picker_team_id || resetGame.status !== 'scheduled')
    ) {
      // The reset game may already have been played (e.g. an earlier bracket
      // game just got reopened, un-deciding the Championship game the reset
      // depended on) — clear its result/artifacts, not just its participants,
      // so a stale winner can't keep the season "completed".
      const needsReset = resetGame.status !== 'scheduled'
      if (needsReset) {
        await clearSeasonGameArtifacts(supabase, resetGame.id, season.id)
      }
      const cleared = await updateSeasonPlayoffGame(supabase, resetGame, null, null, needsReset)
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
    if (needsReset) {
      await clearSeasonGameArtifacts(supabase, resetGame.id, season.id)
    }

    const updated = await updateSeasonPlayoffGame(
      supabase,
      resetGame,
      championship.home_team_id,
      championship.away_team_id,
      needsReset,
    )

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
  return getCanonicalSeasonPlayoffGames(games).sort((a, b) => {
    const aOrder = orderMap.has(normalizeStage(a.stage)) ? orderMap.get(normalizeStage(a.stage)) : Number.MAX_SAFE_INTEGER
    const bOrder = orderMap.has(normalizeStage(b.stage)) ? orderMap.get(normalizeStage(b.stage)) : Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    return compareStableGameIds(a, b)
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

async function loadSeasonLifecycleState(supabase, seasonId) {
  const [gamesResult, teamsResult, ledgerResult] = await Promise.all([
    supabase.from('season_schedule').select('*').eq('season_id', seasonId),
    supabase.from('season_teams').select('*').eq('season_id', seasonId),
    supabase.from('season_betting_ledger').select('*').eq('season_id', seasonId),
  ])
  const failed = [gamesResult, teamsResult, ledgerResult].find((result) => result.error)
  if (failed?.error) throw failed.error
  return {
    schedule: gamesResult.data || [],
    seasonTeams: teamsResult.data || [],
    bettingLedger: ledgerResult.data || [],
  }
}

async function persistSeasonStandings(supabase, standings = []) {
  const results = await Promise.all(standings.map((team) => (
    supabase
      .from('season_teams')
      .update({
        wins: team.wins,
        losses: team.losses,
        run_differential: team.run_differential,
        home_wins: team.home_wins,
        home_losses: team.home_losses,
        away_wins: team.away_wins,
        away_losses: team.away_losses,
      })
      .eq('id', team.id)
  )))
  const failed = results.find((result) => result.error)
  if (failed?.error) throw failed.error
}

async function claimPlayoffTransition(supabase, seasonId) {
  const { data, error } = await supabase
    .from('seasons')
    .update({ champion_player_id: null, status: 'playoffs' })
    .eq('id', seasonId)
    .eq('status', 'active')
    .select('id')
  if (error) throw error
  return Array.isArray(data) && data.length > 0
}

// Shared by the scorebook provider and the isolated lifecycle suite. The
// conditional season update is the exactly-once claim for two clients that
// finish the same last regular-season game. If seeding then fails partway, a
// later callback with the refreshed `playoffs` season repairs missing stages.
//
// `requirePersistedCompletion` is for callers that have already written the
// final row (the scorebook, the tracker bridge, completion recovery). The row
// is read rather than rewritten: its score is the authoritative one, and a
// late or repeated call must not put `completed` back on a game someone has
// since reopened. That case is refused with `code: 'game_not_complete'`.
export async function completeSeasonGameLifecycle({
  supabase,
  season,
  selectedGame,
  scores,
  requirePersistedCompletion = false,
} = {}) {
  if (!season?.id || !selectedGame?.id) return null

  if (requirePersistedCompletion) {
    const { data: persisted, error: readError } = await supabase
      .from('season_schedule')
      .select('*')
      .eq('id', selectedGame.id)
      .maybeSingle()
    if (readError) throw readError
    if (persisted?.status !== 'completed') {
      const error = new Error(`season game ${selectedGame.id} is ${persisted?.status || 'missing'}, not completed; standings were not advanced`)
      error.code = 'game_not_complete'
      throw error
    }
    selectedGame = { ...selectedGame, ...persisted }
  } else {
    const awayScore = Number(scores?.a || 0)
    const homeScore = Number(scores?.b || 0)
    const winnerTeamId = awayScore === homeScore
      ? null
      : (awayScore > homeScore ? selectedGame.away_team_id : selectedGame.home_team_id)
    const { error: completionError } = await supabase
      .from('season_schedule')
      .update({
        status: 'completed',
        winner_team_id: winnerTeamId,
        away_score: awayScore,
        home_score: homeScore,
      })
      .eq('id', selectedGame.id)
    if (completionError) throw completionError
  }

  const state = await loadSeasonLifecycleState(supabase, season.id)
  const standings = buildSeasonStandings(state.seasonTeams, state.schedule, state.bettingLedger)
  await persistSeasonStandings(supabase, standings)

  if (selectedGame.stage) {
    await advanceSeasonPlayoffs({
      supabase,
      season,
      standings,
      schedule: state.schedule,
      seasonTeams: state.seasonTeams,
    })
    return { ...state, standings }
  }

  const regularSeasonGames = state.schedule.filter((game) => !game.stage)
  const allRegularSeasonComplete = regularSeasonGames.length > 0
    && regularSeasonGames.every((game) => game.status === 'completed')
  if (!allRegularSeasonComplete) return { ...state, standings }

  const claimedTransition = await claimPlayoffTransition(supabase, season.id)
  if (claimedTransition || season.status === 'playoffs') {
    await seedSeasonPlayoffs({
      supabase,
      season: { ...season, status: 'playoffs' },
      standings,
      schedule: state.schedule,
    })
  }

  return { ...state, standings, claimedTransition }
}

export async function reopenSeasonGameLifecycle({
  supabase,
  season,
  selectedGame,
  requirePersistedReopen = false,
} = {}) {
  if (!season?.id || !selectedGame?.id) return null

  // The mirror of requirePersistedCompletion: a late reopen pass must not tear
  // down a bracket for a game that has been completed again since.
  if (requirePersistedReopen) {
    const { data: persisted, error: readError } = await supabase
      .from('season_schedule')
      .select('*')
      .eq('id', selectedGame.id)
      .maybeSingle()
    if (readError) throw readError
    if (!persisted || persisted.status === 'completed') {
      const error = new Error(`season game ${selectedGame.id} is ${persisted?.status || 'missing'}; the reopen was not applied to standings`)
      error.code = 'game_complete'
      throw error
    }
    selectedGame = { ...selectedGame, ...persisted }
  }

  const state = await loadSeasonLifecycleState(supabase, season.id)
  const standings = buildSeasonStandings(state.seasonTeams, state.schedule, state.bettingLedger)
  await persistSeasonStandings(supabase, standings)

  if (selectedGame.stage) {
    await reopenSeasonPlayoffs({
      supabase,
      season,
      standings,
      schedule: state.schedule,
      seasonTeams: state.seasonTeams,
    })
    return { ...state, standings }
  }

  const hasPlayoffGames = state.schedule.some((game) => Boolean(game.stage))
  if (hasPlayoffGames) {
    await clearSeasonPlayoffsAfterRegularGameReopen({
      supabase,
      season,
      schedule: state.schedule,
    })
  }

  const regularSeasonGames = state.schedule.filter((game) => !game.stage)
  const allRegularSeasonComplete = regularSeasonGames.length > 0
    && regularSeasonGames.every((game) => game.status === 'completed')
  const { error } = await supabase
    .from('seasons')
    .update({
      champion_player_id: null,
      status: allRegularSeasonComplete ? 'playoffs' : 'active',
    })
    .eq('id', season.id)
  if (error) throw error

  return { ...state, standings }
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
  const scheduleAfterSync = await loadSeasonSchedule(supabase, season.id)
  const resetGames = await syncSeasonChampionshipResetState({
    supabase,
    season,
    standings,
    schedule: scheduleAfterSync,
  })
  const scheduleAfterReset = resetGames.length
    ? await loadSeasonSchedule(supabase, season.id)
    : scheduleAfterSync
  const championTeamId = getSeasonChampionTeamId(season, standings, scheduleAfterReset)
  const teamById = Object.fromEntries((seasonTeams || []).map((team) => [String(team.id), team]))

  const { error } = await supabase
    .from('seasons')
    .update({
      champion_player_id: championTeamId ? teamById[String(championTeamId)]?.player_id || null : null,
      status: championTeamId ? 'completed' : 'playoffs',
    })
    .eq('id', season.id)
  if (error) throw error

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
  const scheduleAfterSync = await loadSeasonSchedule(supabase, season.id)
  const resetGames = await syncSeasonChampionshipResetState({
    supabase,
    season,
    standings,
    schedule: scheduleAfterSync,
  })
  const scheduleAfterReset = resetGames.length
    ? await loadSeasonSchedule(supabase, season.id)
    : scheduleAfterSync
  const championTeamId = getSeasonChampionTeamId(season, standings, scheduleAfterReset)
  const teamById = Object.fromEntries((seasonTeams || []).map((team) => [String(team.id), team]))
  const regularSeasonGames = scheduleAfterReset.filter((game) => !game.stage)
  const allRegularSeasonComplete = regularSeasonGames.length > 0
    && regularSeasonGames.every((game) => game.status === 'completed')

  const { error } = await supabase
    .from('seasons')
    .update({
      champion_player_id: championTeamId ? teamById[String(championTeamId)]?.player_id || null : null,
      status: championTeamId ? 'completed' : (allRegularSeasonComplete ? 'playoffs' : 'active'),
    })
    .eq('id', season.id)
  if (error) throw error

  return [...syncedGames, ...resetGames]
}
