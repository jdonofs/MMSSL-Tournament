import { buildBettingEntityLabel } from './oddsEngine'
import { getPlayerSkillProfile } from './teamIdentity'
import { inningsAsDecimal } from './statsCalculator'

const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR'])

function average(values, fallback = 0) {
  if (!values.length) return fallback
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
}

function standardDeviation(values) {
  if (values.length < 2) return 0
  const mean = average(values, 0)
  const variance = values.reduce((sum, value) => sum + Math.pow(Number(value || 0) - mean, 2), 0) / values.length
  return Math.sqrt(variance)
}

function buildPlayerHistoricalSummary({
  completedGames,
  completedPAs,
  completedPitching,
  playerId,
  characterId = null,
}) {
  const relevantGames = completedGames.filter(
    (game) => game.team_a_player_id === playerId || game.team_b_player_id === playerId,
  )
  const relevantPAs = completedPAs.filter((entry) => {
    if (entry.player_id !== playerId) return false
    return characterId ? entry.character_id === characterId : true
  })
  const relevantPitching = completedPitching.filter((entry) => {
    if (entry.player_id !== playerId) return false
    return characterId ? entry.character_id === characterId : true
  })

  const totalPas = relevantPAs.length || 1
  const totalInnings = relevantPitching.reduce((sum, entry) => sum + inningsAsDecimal(entry.innings_pitched), 0)
  const strikeouts = relevantPitching.reduce((sum, entry) => sum + Number(entry.strikeouts || 0), 0)

  return {
    gamesPlayed: relevantGames.length,
    winRate: relevantGames.length ? relevantGames.filter((game) => game.winner_player_id === playerId).length / relevantGames.length : 0.5,
    avg: relevantPAs.filter((entry) => HIT_RESULTS.has(entry.result)).length / totalPas,
    hitRate: relevantPAs.filter((entry) => HIT_RESULTS.has(entry.result)).length / totalPas,
    hrRate: relevantPAs.filter((entry) => entry.result === 'HR').length / totalPas,
    kRate: relevantPAs.filter((entry) => entry.result === 'K').length / totalPas,
    strikeoutsPerInning: totalInnings > 0 ? strikeouts / totalInnings : 0,
    strikeoutsPerGame: relevantPitching.length ? strikeouts / relevantPitching.length : 0,
    plateAppearances: relevantPAs.length,
  }
}

function buildHeadToHeadSummary(homePlayerId, awayPlayerId, completedGames = []) {
  const matchups = completedGames.filter((game) => {
    const ids = [game.team_a_player_id, game.team_b_player_id]
    return ids.includes(homePlayerId) && ids.includes(awayPlayerId)
  })
  if (!matchups.length) {
    return { homeWinRate: 0.5, awayWinRate: 0.5, gamesPlayed: 0 }
  }

  const homeWins = matchups.filter((game) => game.winner_player_id === homePlayerId).length
  return {
    homeWinRate: homeWins / matchups.length,
    awayWinRate: 1 - homeWins / matchups.length,
    gamesPlayed: matchups.length,
  }
}

export function buildOddsGenerationContext({
  game,
  draftPicks,
  charactersById,
  gamePAs = [],
  gamePitching = [],
  allGames = [],
  allPAs = [],
  allPitching = [],
  stadiumsById = {},
  stadiumGameLog = [],
  playersById = {},
  currentInning = null,
  scores = null,
}) {
  if (!game) return null

  const completedGames = allGames.filter((entry) => entry.status === 'complete' && entry.id !== game.id)
  const completedGameIds = new Set(completedGames.map((entry) => entry.id))
  const completedPAs = allPAs.filter((entry) => completedGameIds.has(entry.game_id))
  const completedPitching = allPitching.filter((entry) => completedGameIds.has(entry.game_id))
  const gamePicks = draftPicks.filter((entry) => entry.tournament_id === game.tournament_id)
  const completedTotals = completedGames.map((entry) => Number(entry.team_a_runs || 0) + Number(entry.team_b_runs || 0))
  const historicalTotals = {
    sampleSize: completedTotals.length,
    average: average(completedTotals, 0),
    stdDev: standardDeviation(completedTotals),
  }

  const margins = completedGames
    .filter((g) => g.team_a_runs != null && g.team_b_runs != null)
    .map((g) => Math.abs(Number(g.team_a_runs || 0) - Number(g.team_b_runs || 0)))
  const runLineData = {
    margins,
    historicalAvgMargin: margins.length ? margins.reduce((s, v) => s + v, 0) / margins.length : 3.5,
    oneRunGameRate: margins.length ? margins.filter((m) => m === 1).length / margins.length : 0.28,
  }

  const latestPitcherFor = (playerId) =>
    [...gamePitching]
      .filter((entry) => entry.player_id === playerId)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0]?.character_id

  const toRoster = (playerId, currentPitcherId) =>
    gamePicks
      .filter((entry) => entry.player_id === playerId && entry.character_id)
      .map((entry) => {
        const character = charactersById[entry.character_id]
        const player = playersById[playerId]
        if (!character) return null
        return {
          ...character,
          id: entry.character_id,
          playerId,
          playerName: player?.name,
          skillProfile: getPlayerSkillProfile(player),
          entityLabel: buildBettingEntityLabel(character, player),
          paSoFar: gamePAs.filter((pa) => pa.player_id === playerId && pa.character_id === entry.character_id).length,
          isPitcher: currentPitcherId === entry.character_id,
          isActivePitcher: currentPitcherId === entry.character_id,
        }
      })
      .filter(Boolean)

  const awayPitcherId = latestPitcherFor(game.team_a_player_id)
  const homePitcherId = latestPitcherFor(game.team_b_player_id)
  const awayRoster = toRoster(game.team_a_player_id, awayPitcherId)
  const homeRoster = toRoster(game.team_b_player_id, homePitcherId)
  const homePlayer = playersById[game.team_b_player_id]
  const awayPlayer = playersById[game.team_a_player_id]
  const liveInning = Number(currentInning ?? Math.max(...gamePAs.map((entry) => Number(entry.inning || 1)), 1))
  const scoreA = Number(scores?.a ?? game.team_a_runs ?? 0)
  const scoreB = Number(scores?.b ?? game.team_b_runs ?? 0)
  const stadium = stadiumsById[game.stadium_id] || null
  const isNight = Boolean(game.is_night)
  const scopedStadiumLog = stadiumGameLog.filter((entry) =>
    String(entry.stadium_id) === String(game.stadium_id) &&
    Boolean(entry.is_night) === isNight &&
    String(entry.game_id) !== String(game.id),
  )

  const playerProps = {
    historicalByEntity: {},
    gameState: {
      inning: liveInning,
      paCount: gamePAs.length,
      scoreDiff: scoreB - scoreA,
      homePitcherId,
      awayPitcherId,
    },
    historicalTotals,
    headToHead: buildHeadToHeadSummary(game.team_b_player_id, game.team_a_player_id, completedGames),
    runLineData,
    stadium,
    isNight,
    stadiumGameLog: scopedStadiumLog,
  }

  ;[...homeRoster, ...awayRoster].forEach((entry) => {
    playerProps.historicalByEntity[entry.entityLabel] = buildPlayerHistoricalSummary({
      completedGames,
      completedPAs,
      completedPitching,
      playerId: entry.playerId,
      characterId: entry.id,
    })
  })

  return {
    game: {
      ...game,
      team_a_runs: scoreA,
      team_b_runs: scoreB,
      current_inning: liveInning,
    },
    stadium,
    stadiumGameLog: scopedStadiumLog,
    isNight,
    homeRoster,
    awayRoster,
    homeHistorical: {
      ...buildPlayerHistoricalSummary({
        completedGames,
        completedPAs,
        completedPitching,
        playerId: game.team_b_player_id,
      }),
      skillProfile: getPlayerSkillProfile(homePlayer),
    },
    awayHistorical: {
      ...buildPlayerHistoricalSummary({
        completedGames,
        completedPAs,
        completedPitching,
        playerId: game.team_a_player_id,
      }),
      skillProfile: getPlayerSkillProfile(awayPlayer),
    },
    playerProps,
  }
}
