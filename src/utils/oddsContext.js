import { buildBettingEntityLabel } from './oddsEngine.js'
import { getPlayerSkillProfile } from './teamIdentity.js'
import { DEFAULT_REGULATION_INNINGS, DEFAULT_MERCY_RULE_DIFFERENTIAL, normalizeRegulationInnings, normalizeMercyRuleDifferential } from './gameRules.js'
import { isCreditedHit } from './creditedHit.js'
import { buildLeagueOutcomeShape, summarizeCompletedGameScoring } from './teamStrengthModel.js'
import { buildAppliedStadiumModel } from './stadiumOdds.js'
import { buildBattingOrder } from './propModel.js'

// Kept local so this shared odds-context builder remains Node-compatible for
// the tracker bridge. Importing the UI-oriented stats/hit-distance modules
// pulls JSX-only field-visualization dependencies into the bridge process.
function inningsAsDecimal(inningsPitched = 0) {
  const innings = Number(inningsPitched || 0)
  const whole = Math.trunc(innings)
  const fraction = Number((innings - whole).toFixed(3))
  const extraOuts = Math.abs(fraction - 0.1) < 0.001 ? 1 : Math.abs(fraction - 0.2) < 0.001 ? 2 : Math.round(fraction * 3)
  return ((whole * 3) + extraOuts) / 3
}

function summarizeHitDistance(plateAppearances = []) {
  const distances = (plateAppearances || [])
    .map((pa) => Number(pa?.hit_distance_ft))
    .filter((distance) => Number.isFinite(distance) && distance > 0)
  if (!distances.length) return { sampleSize: 0, avgDistance: null, maxDistance: null, hardHitCount: null, hardHitRate: null }
  const hardHitCount = distances.filter((distance) => distance >= 275).length
  return {
    sampleSize: distances.length,
    avgDistance: Math.round((distances.reduce((sum, distance) => sum + distance, 0) / distances.length) * 10) / 10,
    maxDistance: Math.round(Math.max(...distances)),
    hardHitCount,
    hardHitRate: Math.round((hardHitCount / distances.length) * 1000) / 1000,
  }
}

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

const isHomeRunPA = (entry) => isCreditedHit(entry) && (entry.result === 'HR' || entry.result === 'IPHR')

/**
 * Counts, not rates.
 *
 * The pricing model shrinks a rate toward a prior, and to do that honestly it
 * needs the numerator and the denominator, not a ratio whose sample size has
 * already been thrown away. Rates are still reported for consumers that expect
 * the old shape.
 */
function buildPlayerHistoricalSummary({
  completedGames,
  completedPAs,
  completedPitching,
  playerId = null,
  characterId = null,
}) {
  const relevantGames = completedGames.filter((game) => {
    if (!playerId) return true
    return game.team_a_player_id === playerId || game.team_b_player_id === playerId
  })
  const relevantPAs = completedPAs.filter((entry) => {
    if (playerId && entry.player_id !== playerId) return false
    return characterId ? entry.character_id === characterId : true
  })
  const relevantPitching = completedPitching.filter((entry) => {
    if (playerId && entry.player_id !== playerId) return false
    return characterId ? entry.character_id === characterId : true
  })

  const plateAppearances = relevantPAs.length
  const denominator = plateAppearances || 1
  const hits = relevantPAs.filter(isCreditedHit).length
  const homeRuns = relevantPAs.filter(isHomeRunPA).length
  const strikeoutsAtBat = relevantPAs.filter((entry) => entry.result === 'K').length

  const innings = relevantPitching.reduce((sum, entry) => sum + inningsAsDecimal(entry.innings_pitched), 0)
  const strikeouts = relevantPitching.reduce((sum, entry) => sum + Number(entry.strikeouts || 0), 0)
  const hitsAllowed = relevantPitching.reduce((sum, entry) => sum + Number(entry.hits_allowed || 0), 0)
  const walksAllowed = relevantPitching.reduce((sum, entry) => sum + Number(entry.walks || 0), 0)
  // Batters faced is not stored. Outs recorded plus the runners a pitcher put on
  // is the closest thing the schema supports, and it is the right denominator
  // for a strikeout rate; an inning is not an exposure. It omits reached-on-
  // error and hit-by-pitch, which the pitching stint does not record.
  const battersFaced = (innings * 3) + hitsAllowed + walksAllowed

  // Half innings batted: each completed game contributes the innings that were
  // actually played for this side. Used only for the single player-level run
  // offset, which is capped and hard-shrunk.
  const halfInningsBatted = relevantGames.reduce((sum, game) => sum + normalizeRegulationInnings(
    game.final_inning ?? game.current_inning ?? game.innings,
    DEFAULT_REGULATION_INNINGS,
  ), 0)
  const runsScored = relevantGames.reduce((sum, game) => {
    if (game.team_a_player_id === playerId) return sum + Number(game.team_a_runs || 0)
    if (game.team_b_player_id === playerId) return sum + Number(game.team_b_runs || 0)
    return sum
  }, 0)

  const distanceProfile = summarizeHitDistance(relevantPAs)

  return {
    gamesPlayed: relevantGames.length,
    winRate: relevantGames.length ? relevantGames.filter((game) => game.winner_player_id === playerId).length / relevantGames.length : 0.5,
    plateAppearances,
    hits,
    homeRuns,
    strikeoutsAtBat,
    strikeouts,
    battersFaced,
    inningsPitched: innings,
    halfInningsBatted,
    runsScored,
    // Rates retained for consumers that read the old shape.
    avg: hits / denominator,
    hitRate: hits / denominator,
    hrRate: homeRuns / denominator,
    kRate: strikeoutsAtBat / denominator,
    strikeoutsPerInning: innings > 0 ? strikeouts / innings : 0,
    strikeoutsPerGame: relevantPitching.length ? strikeouts / relevantPitching.length : 0,
    avgDistance: distanceProfile.avgDistance,
    hardHitRate: distanceProfile.hardHitRate,
    hitDistanceSample: distanceProfile.sampleSize,
  }
}

/**
 * One entity's history, as two properly nested samples.
 *
 * The old builder averaged six overlapping summaries — player+character,
 * character, player, and all three again scoped to the stadium — with weights
 * that summed above one, so a single plate appearance could be counted up to six
 * times. Here the (player, character) pair is the specific sample and the
 * character-across-all-players sample is the group it is shrunk toward; the
 * pricing model does that shrinkage. Stadium-scoped copies are gone: the park is
 * already applied once, as a park factor.
 */
function buildEntityHistoricalProfile({ completedGames, completedPAs, completedPitching, playerId, characterId }) {
  const pair = buildPlayerHistoricalSummary({ completedGames, completedPAs, completedPitching, playerId, characterId })
  const character = buildPlayerHistoricalSummary({ completedGames, completedPAs, completedPitching, characterId })
  return {
    ...pair,
    character: {
      plateAppearances: character.plateAppearances,
      hits: character.hits,
      homeRuns: character.homeRuns,
      strikeouts: character.strikeouts,
      battersFaced: character.battersFaced,
      gamesPlayed: character.gamesPlayed,
    },
  }
}

// PART C/E — sums wagered money and potential payout liability per market/side
// from currently-open bets on this game, keyed the same way as buildOddsRowKey
// (`${bet_type}::${target_entity || 'game'}`), so the pricing layer can balance
// the book. This is EXPOSURE, never evidence about the game.
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

// The runs already recorded in inning 1, and whether that window has closed.
// A first-inning market whose answer is on the record must be closed rather than
// priced, and the model can only know that if the context carries it.
function summarizeFirstInning(gamePAs = [], currentInning = 1) {
  const inningOnePAs = gamePAs.filter((pa) => Number(pa.inning || 0) === 1)
  const runs = inningOnePAs.reduce((sum, pa) => {
    const isHomer = pa.result === 'HR' || pa.result === 'IPHR'
    return sum + Number(pa.rbi || 0) + (pa.run_scored && !isHomer ? 1 : 0)
  }, 0)
  return {
    firstInningRunsRecorded: runs,
    firstInningComplete: Number(currentInning || 1) > 1,
    firstInningPlateAppearances: inningOnePAs.length,
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
  mercyRule = null,
  mercyRuleDifferential = null,
  bets = [],
  liabilityCap = null,
  expectedPitcherByPlayer = {},
  oddsWeights = null,
  liveState = null,
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

  const regulationInnings = normalizeRegulationInnings(totalInnings, DEFAULT_REGULATION_INNINGS)

  const margins = completedGames
    .filter((g) => g.team_a_runs != null && g.team_b_runs != null)
    .map((g) => Math.abs(Number(g.team_a_runs || 0) - Number(g.team_b_runs || 0)))
  const runLineData = {
    margins,
    historicalAvgMargin: margins.length ? margins.reduce((s, v) => s + v, 0) / margins.length : 3.5,
    oneRunGameRate: margins.length ? margins.filter((m) => m === 1).length / margins.length : 0.28,
    stdDev: standardDeviation(margins),
  }

  // The team's lineup-designated pitcher is authoritative for who the
  // k_prop market should target — it reflects mid-half-inning swaps
  // immediately, whereas pitching_stints only gets a row once that team
  // actually takes the mound (and a team that hasn't pitched yet has no
  // stints at all, which previously fell back to roster[0]).
  const latestPitcherFor = (playerId) => {
    const expected = expectedPitcherByPlayer[playerId]
    if (expected != null) return Number(expected)
    return [...gamePitching]
      .filter((entry) => entry.player_id === playerId)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0]?.character_id
  }

  // Live prop placement needs the player's CURRENT in-game progress toward the
  // prop line, so odds at placement reflect "how much more do they need" rather
  // than re-deriving from scratch.
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
          hitsSoFar: ownPAs.filter(isCreditedHit).length,
          hrSoFar: ownPAs.filter(isHomeRunPA).length,
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
  const liveInning = Number(currentInning ?? liveState?.currentInning ?? game.current_inning ?? Math.max(...gamePAs.map((entry) => Number(entry.inning || 1)), 1))
  const scoreA = Number(scores?.a ?? game.team_a_runs ?? 0)
  const scoreB = Number(scores?.b ?? game.team_b_runs ?? 0)
  const stadium = stadiumsById[game.stadium_id] || null
  const isNight = Boolean(game.is_night)
  const scopedStadiumLog = stadiumGameLog.filter((entry) =>
    String(entry.stadium_id) === String(game.stadium_id) &&
    Boolean(entry.is_night) === isNight &&
    String(entry.game_id) !== String(game.id),
  )

  // League level and shape, read from the competition's own completed games and
  // recorded plate appearances rather than from a hardcoded baseline.
  const leagueShape = buildLeagueOutcomeShape(completedPAs)
  const leagueScoring = summarizeCompletedGameScoring(completedGames, regulationInnings)
  const leagueModel = {
    shape: leagueShape.shape,
    shapeSource: leagueShape.source,
    strikeoutRate: leagueShape.strikeoutRate,
    plateAppearances: leagueShape.plateAppearances,
    meanTotal: leagueScoring.meanTotal,
    sampleSize: leagueScoring.sampleSize,
  }

  const stadiumModel = buildAppliedStadiumModel(stadium, isNight, scopedStadiumLog, {
    leagueMeanRuns: leagueScoring.meanTotal,
  })

  const firstInning = summarizeFirstInning(gamePAs, liveInning)

  const playerProps = {
    historicalByEntity: {},
    gameState: {
      inning: liveInning,
      paCount: gamePAs.length,
      scoreDiff: scoreB - scoreA,
      homePitcherId,
      awayPitcherId,
      ...firstInning,
    },
    liveState: liveState || null,
    historicalTotals,
    leagueModel,
    stadiumModel,
    headToHead: buildHeadToHeadSummary(game.team_b_player_id, game.team_a_player_id, completedGames),
    runLineData,
    stadium,
    isNight,
    stadiumGameLog: scopedStadiumLog,
    totalInnings: regulationInnings,
    mercyRule: mercyRule == null ? (game.mercy_rule !== false) : Boolean(mercyRule),
    mercyRuleDifferential: normalizeMercyRuleDifferential(
      mercyRuleDifferential ?? game.mercy_rule_differential,
      DEFAULT_MERCY_RULE_DIFFERENTIAL,
    ),
    battingOrder: {
      home: buildBattingOrder({ roster: homeRoster, gamePAs, playerId: game.team_b_player_id }),
      away: buildBattingOrder({ roster: awayRoster, gamePAs, playerId: game.team_a_player_id }),
    },
    marketVolume: buildMarketVolume(bets.filter((bet) => String(bet.game_id) === String(game.id))),
    ...(liabilityCap != null ? { liabilityCap } : {}),
    // Retained for the legacy model, which reads calibrated source weights from
    // `odds_engine_weights`. The game model does not use them: those weights are
    // fitted from a Brier score computed over placed tickets only, scored
    // against side A's probability whichever side the ticket took.
    ...(oddsWeights ? { weights: oddsWeights } : {}),
  }

  ;[...homeRoster, ...awayRoster].forEach((entry) => {
    playerProps.historicalByEntity[entry.entityLabel] = buildEntityHistoricalProfile({
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
    stadiumModel,
    stadiumGameLog: scopedStadiumLog,
    isNight,
    leagueModel,
    homeRoster,
    awayRoster,
    homeHistorical: {
      ...buildPlayerHistoricalSummary({
        completedGames,
        completedPAs,
        completedPitching,
        playerId: game.team_b_player_id,
      }),
      playerName: homePlayer?.name || null,
      skillProfile: getPlayerSkillProfile(homePlayer),
    },
    awayHistorical: {
      ...buildPlayerHistoricalSummary({
        completedGames,
        completedPAs,
        completedPitching,
        playerId: game.team_a_player_id,
      }),
      playerName: awayPlayer?.name || null,
      skillProfile: getPlayerSkillProfile(awayPlayer),
    },
    playerProps,
  }
}
