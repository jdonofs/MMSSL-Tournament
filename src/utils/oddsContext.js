import { buildBettingEntityLabel } from './oddsEngine'
import { getPlayerSkillProfile } from './teamIdentity'
import { inningsAsDecimal } from './statsCalculator'
import { DEFAULT_REGULATION_INNINGS, normalizeRegulationInnings } from './gameRules'

const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])

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
  playerId = null,
  characterId = null,
  stadiumId = null,
  isNight = null,
}) {
  const scopedGameIds = new Set(
    completedGames
      .filter((game) => {
        if (stadiumId != null && String(game.stadium_id) !== String(stadiumId)) return false
        if (isNight != null && Boolean(game.is_night) !== Boolean(isNight)) return false
        return true
      })
      .map((game) => game.id),
  )
  const relevantGames = completedGames.filter(
    (game) => {
      if (stadiumId != null || isNight != null) {
        if (!scopedGameIds.has(game.id)) return false
      }
      if (!playerId) return true
      return game.team_a_player_id === playerId || game.team_b_player_id === playerId
    },
  )
  const relevantPAs = completedPAs.filter((entry) => {
    if ((stadiumId != null || isNight != null) && !scopedGameIds.has(entry.game_id)) return false
    if (playerId && entry.player_id !== playerId) return false
    return characterId ? entry.character_id === characterId : true
  })
  const relevantPitching = completedPitching.filter((entry) => {
    if ((stadiumId != null || isNight != null) && !scopedGameIds.has(entry.game_id)) return false
    if (playerId && entry.player_id !== playerId) return false
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
    hrRate: relevantPAs.filter((entry) => entry.result === 'HR' || entry.result === 'IPHR').length / totalPas,
    kRate: relevantPAs.filter((entry) => entry.result === 'K').length / totalPas,
    strikeoutsPerInning: totalInnings > 0 ? strikeouts / totalInnings : 0,
    strikeoutsPerGame: relevantPitching.length ? strikeouts / relevantPitching.length : 0,
    plateAppearances: relevantPAs.length,
  }
}

function blendHistoricalSummaries(parts = []) {
  const totalWeight = parts.reduce((sum, part) => sum + Number(part.weight || 0), 0) || 1
  const blend = (key, fallback = 0) => parts.reduce((sum, part) => sum + Number(part.summary?.[key] ?? fallback) * Number(part.weight || 0), 0) / totalWeight
  const maxOf = (key) => Math.max(0, ...parts.map((part) => Number(part.summary?.[key] || 0)))
  return {
    gamesPlayed: Math.round(blend('gamesPlayed')),
    winRate: blend('winRate', 0.5),
    avg: blend('avg', 0.25),
    hitRate: blend('hitRate', 0.25),
    hrRate: blend('hrRate', 0.03),
    kRate: blend('kRate', 0.2),
    strikeoutsPerInning: blend('strikeoutsPerInning', 0),
    strikeoutsPerGame: blend('strikeoutsPerGame', 0),
    plateAppearances: Math.round(blend('plateAppearances')),
    samplePlateAppearances: maxOf('plateAppearances'),
    sampleGamesPlayed: maxOf('gamesPlayed'),
  }
}

function buildEntityHistoricalProfile({
  completedGames,
  completedPAs,
  completedPitching,
  playerId,
  characterId,
  stadiumId,
  isNight,
}) {
  const playerCharacter = buildPlayerHistoricalSummary({ completedGames, completedPAs, completedPitching, playerId, characterId })
  const playerOnly = buildPlayerHistoricalSummary({ completedGames, completedPAs, completedPitching, playerId })
  const characterOnly = buildPlayerHistoricalSummary({ completedGames, completedPAs, completedPitching, characterId })
  const stadiumPlayerCharacter = buildPlayerHistoricalSummary({ completedGames, completedPAs, completedPitching, playerId, characterId, stadiumId, isNight })
  const stadiumPlayerOnly = buildPlayerHistoricalSummary({ completedGames, completedPAs, completedPitching, playerId, stadiumId, isNight })
  const stadiumCharacterOnly = buildPlayerHistoricalSummary({ completedGames, completedPAs, completedPitching, characterId, stadiumId, isNight })

  const weights = [
    { summary: playerCharacter, weight: 0.42 + Math.min(playerCharacter.plateAppearances / 60, 0.28) },
    { summary: characterOnly, weight: 0.22 + Math.min(characterOnly.plateAppearances / 120, 0.18) },
    { summary: playerOnly, weight: 0.18 + Math.min(playerOnly.plateAppearances / 120, 0.14) },
    { summary: stadiumPlayerCharacter, weight: Math.min(stadiumPlayerCharacter.plateAppearances / 16, 0.28) },
    { summary: stadiumCharacterOnly, weight: Math.min(stadiumCharacterOnly.plateAppearances / 32, 0.18) },
    { summary: stadiumPlayerOnly, weight: Math.min(stadiumPlayerOnly.plateAppearances / 32, 0.14) },
  ].filter((part) => part.weight > 0)

  return {
    ...blendHistoricalSummaries(weights),
    playerCharacter,
    playerOnly,
    characterOnly,
    stadiumPlayerCharacter,
    stadiumPlayerOnly,
    stadiumCharacterOnly,
  }
}

// PART C/E — sums wagered money and potential payout liability per market/side
// from currently-open bets on this game, keyed the same way as buildOddsRowKey
// (`${bet_type}::${target_entity || 'game'}`), so the odds engine can apply
// volume-based line movement and liability caps.
function buildMarketVolume(gameBets = []) {
  const volume = {}
  gameBets
    .filter((bet) => bet.status === 'open' || bet.status === 'pending')
    .forEach((bet) => {
      const key = `${bet.bet_type}::${bet.target_entity || 'game'}`
      const side = bet.chosen_side
      if (!side) return
      volume[key] = volume[key] || {}
      volume[key][side] = volume[key][side] || { money: 0, liability: 0 }
      volume[key][side].money += Number(bet.wager_dollars || 0)
      volume[key][side].liability += Number(bet.potential_payout_dollars || 0)
    })
  return volume
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
  totalInnings = DEFAULT_REGULATION_INNINGS,
  bets = [],
  liabilityCap = null,
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
    stdDev: standardDeviation(margins),
  }

  const latestPitcherFor = (playerId) =>
    [...gamePitching]
      .filter((entry) => entry.player_id === playerId)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0]?.character_id

  // PART G — live prop placement needs the player's CURRENT in-game progress
  // toward the prop line (kSoFar/hitsSoFar/hrSoFar), so odds at placement
  // reflect "how much more do they need" rather than re-deriving from scratch.
  const toRoster = (playerId, currentPitcherId, opposingPlayerId) =>
    gamePicks
      .filter((entry) => entry.player_id === playerId && entry.character_id)
      .map((entry) => {
        const character = charactersById[entry.character_id]
        const player = playersById[playerId]
        if (!character) return null
        const ownPAs = gamePAs.filter((pa) => pa.player_id === playerId && pa.character_id === entry.character_id)
        return {
          ...character,
          id: entry.character_id,
          playerId,
          playerName: player?.name,
          skillProfile: getPlayerSkillProfile(player),
          entityLabel: buildBettingEntityLabel(character, player),
          paSoFar: ownPAs.length,
          hitsSoFar: ownPAs.filter((pa) => HIT_RESULTS.has(pa.result)).length,
          hrSoFar: ownPAs.filter((pa) => pa.result === 'HR' || pa.result === 'IPHR').length,
          kSoFar: currentPitcherId === entry.character_id
            ? gamePAs.filter((pa) => pa.player_id === opposingPlayerId && pa.result === 'K').length
            : 0,
          isPitcher: currentPitcherId === entry.character_id,
          isActivePitcher: currentPitcherId === entry.character_id,
        }
      })
      .filter(Boolean)

  const awayPitcherId = latestPitcherFor(game.team_a_player_id)
  const homePitcherId = latestPitcherFor(game.team_b_player_id)
  const awayRoster = toRoster(game.team_a_player_id, awayPitcherId, game.team_b_player_id)
  const homeRoster = toRoster(game.team_b_player_id, homePitcherId, game.team_a_player_id)
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
    totalInnings: normalizeRegulationInnings(totalInnings, DEFAULT_REGULATION_INNINGS),
    marketVolume: buildMarketVolume(bets.filter((bet) => String(bet.game_id) === String(game.id))),
    ...(liabilityCap != null ? { liabilityCap } : {}),
  }

  ;[...homeRoster, ...awayRoster].forEach((entry) => {
    playerProps.historicalByEntity[entry.entityLabel] = buildEntityHistoricalProfile({
      completedGames,
      completedPAs,
      completedPitching,
      playerId: entry.playerId,
      characterId: entry.id,
      stadiumId: game.stadium_id,
      isNight,
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
