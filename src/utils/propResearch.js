// Research context for the hit / home-run / strikeout prop markets.
//
// What this is: a factual record of what the target has actually done in this
// competition's completed games. What it is not: a probability, an edge, or an
// opinion about the price. The odds model is untouched and nothing here is used
// to price anything.
//
// Three rules it enforces:
//
//   * PARTICIPATION IS EVIDENCE, NOT AN ASSUMPTION. A completed game with no
//     recorded rows for the target is not a zero — it is a game the target is
//     not known to have played. It stays out of the denominator and is reported
//     as uncovered.
//   * SEASON AND TOURNAMENT STAY SEPARATE. The caller passes one competition's
//     games and rows; nothing here reaches across.
//   * LIVE IS NOT HISTORY. The game being bet on is excluded from every
//     average and returned on its own.

import { buildBettingEntityLabel } from './oddsEngine.js'
import { isCreditedHit } from './creditedHit.js'
import { HR_RESULTS, getTargetPlayerName, getTargetPortraitName } from './bettingMarkets.js'

export const PROP_STAT_LABELS = {
  hit_prop: { stat: 'Hits', unit: 'hits', unitSingular: 'hit', role: 'batter' },
  hr_prop: { stat: 'Home runs', unit: 'HR', unitSingular: 'HR', role: 'batter' },
  k_prop: { stat: 'Strikeouts', unit: 'K', unitSingular: 'K', role: 'pitcher' },
}

export function isResearchableProp(betType) {
  return Boolean(PROP_STAT_LABELS[betType])
}

function gameSortValue(game = {}) {
  const created = game.created_at ? new Date(game.created_at).getTime() : Number.NaN
  if (!Number.isNaN(created)) return created
  const round = Number(game.round_number || 0)
  return round * 1e6 + Number(game.id || 0)
}

// Per-game value for one entity, computed with the same credited-hit and
// strikeout rules settlement uses, so research and grading cannot disagree.
function valueForGame(betType, { pas = [], stints = [] }) {
  if (betType === 'k_prop') {
    return stints.reduce((total, stint) => total + Number(stint.strikeouts || 0), 0)
  }
  if (betType === 'hr_prop') {
    return pas.filter((pa) => isCreditedHit(pa) && HR_RESULTS.has(pa.result)).length
  }
  return pas.filter((pa) => isCreditedHit(pa)).length
}

function opponentLabelFor(game, entityPlayerId, labelForPlayer) {
  if (!game) return null
  const isAway = String(game.team_a_player_id) === String(entityPlayerId)
  const opponentId = isAway ? game.team_b_player_id : game.team_a_player_id
  const label = labelForPlayer ? labelForPlayer(opponentId) : null
  return label ? `${isAway ? '@' : 'vs'} ${label}` : null
}

// `games` must already be scoped to one competition. `currentGameId` is the
// game being bet on and is never part of the historical sample.
export function buildPropResearch({
  betType,
  targetEntity,
  games = [],
  plateAppearances = [],
  pitchingStints = [],
  charactersById = {},
  playersById = {},
  currentGameId = null,
  recentLimit = 5,
  competitionLabel = '',
  labelForPlayer = null,
  matchupNote = '',
} = {}) {
  const meta = PROP_STAT_LABELS[betType]
  if (!meta || !targetEntity) return null

  const isPitcherProp = meta.role === 'pitcher'
  const matches = (row) => buildBettingEntityLabel(charactersById[row.character_id], playersById[row.player_id]) === targetEntity

  const entityPAs = plateAppearances.filter(matches)
  const entityStints = pitchingStints.filter(matches)
  const entityPlayerId = (isPitcherProp ? entityStints[0] : entityPAs[0])?.player_id ?? null

  const pasByGame = new Map()
  entityPAs.forEach((pa) => {
    const key = String(pa.game_id)
    if (!pasByGame.has(key)) pasByGame.set(key, [])
    pasByGame.get(key).push(pa)
  })
  const stintsByGame = new Map()
  entityStints.forEach((stint) => {
    const key = String(stint.game_id)
    if (!stintsByGame.has(key)) stintsByGame.set(key, [])
    stintsByGame.get(key).push(stint)
  })

  const completedGames = games
    .filter((game) => game.status === 'complete')
    .filter((game) => currentGameId == null || String(game.id) !== String(currentGameId))
    .sort((a, b) => gameSortValue(a) - gameSortValue(b))

  const played = []
  let notRecorded = 0

  completedGames.forEach((game) => {
    const key = String(game.id)
    const pas = pasByGame.get(key) || []
    const stints = stintsByGame.get(key) || []
    const appeared = isPitcherProp ? stints.length > 0 : pas.length > 0
    if (!appeared) {
      // Either the target did not play, or this game's rows were never
      // recorded. The row set cannot tell those apart, so neither does this.
      notRecorded += 1
      return
    }
    played.push({
      gameId: game.id,
      sourceGameId: game.source_game_id ?? game.id,
      gameCode: game.game_code || `Game ${game.id}`,
      status: game.status,
      value: valueForGame(betType, { pas, stints }),
      opponent: opponentLabelFor(game, entityPlayerId ?? (isPitcherProp ? stints[0]?.player_id : pas[0]?.player_id), labelForPlayer),
      at: game.created_at || null,
    })
  })

  const total = played.reduce((sum, entry) => sum + entry.value, 0)
  const eligibleGames = played.length
  const average = eligibleGames > 0 ? total / eligibleGames : null

  // The live game, kept entirely out of the average above.
  const liveKey = currentGameId == null ? null : String(currentGameId)
  const liveValue = liveKey == null ? null : valueForGame(betType, {
    pas: pasByGame.get(liveKey) || [],
    stints: stintsByGame.get(liveKey) || [],
  })
  const liveAppeared = liveKey == null
    ? false
    : (isPitcherProp ? (stintsByGame.get(liveKey) || []).length > 0 : (pasByGame.get(liveKey) || []).length > 0)

  const recent = played.slice(-recentLimit).reverse()

  const coverage = []
  if (notRecorded > 0) {
    coverage.push(`${notRecorded} completed ${notRecorded === 1 ? 'game has' : 'games have'} no recorded ${isPitcherProp ? 'pitching appearance' : 'plate appearance'} for ${targetEntity}. Those games are left out of the average rather than counted as ${meta.unit === 'K' ? '0 K' : `0 ${meta.unit}`}.`)
  }
  if (eligibleGames === 0) {
    coverage.push(`No completed game in ${competitionLabel || 'this competition'} has a recorded ${isPitcherProp ? 'pitching appearance' : 'plate appearance'} for ${targetEntity}, so there is no historical rate to report.`)
  }

  return {
    betType,
    statLabel: meta.stat,
    unit: meta.unit,
    unitSingular: meta.unitSingular,
    role: meta.role,
    competitionLabel,
    entity: {
      label: targetEntity,
      characterName: getTargetPortraitName(targetEntity) || targetEntity,
      playerName: getTargetPlayerName(targetEntity),
      playerId: entityPlayerId,
    },
    matchupNote: matchupNote || null,
    games: played,
    recent,
    total,
    eligibleGames,
    average,
    // Spelled out so the number is never read against the wrong denominator.
    denominatorLabel: eligibleGames > 0
      ? `${meta.stat.toLowerCase()} per completed game with a recorded appearance (n = ${eligibleGames})`
      : 'no eligible completed games',
    completedGamesInCompetition: completedGames.length,
    gamesWithoutRecordedAppearance: notRecorded,
    live: liveKey == null ? null : {
      gameId: currentGameId,
      value: liveValue,
      appeared: liveAppeared,
      note: 'Current game only. Not included in the average above.',
    },
    coverage,
  }
}
