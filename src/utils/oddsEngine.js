import { getPlayerSkillProfile } from './teamIdentity'
import { buildAppliedStadiumModel } from './stadiumOdds'
import { DEFAULT_REGULATION_INNINGS, normalizeRegulationInnings } from './gameRules'

const MIN_PROBABILITY = 0.002
const MAX_PROBABILITY = 0.998
const MIN_DISPLAY_DECIMAL_ODDS = 1.01
const MAX_DISPLAY_DECIMAL_ODDS = 1000
const MAX_UNDERDOG_ODDS = Math.round((MAX_DISPLAY_DECIMAL_ODDS - 1) * 100)
const MAX_FAVORITE_ODDS = Math.round(-100 / (MIN_DISPLAY_DECIMAL_ODDS - 1))

// Sportsbooks don't display every integer once odds get steep — round to a
// coarser increment as the magnitude grows (matches real-world board behavior).
function roundOddsMagnitude(odds) {
  const abs = Math.abs(odds)
  let rounded = abs
  if (abs >= 5000) rounded = Math.round(abs / 500) * 500
  else if (abs >= 1000) rounded = Math.round(abs / 100) * 100
  else if (abs >= 200) rounded = Math.round(abs / 5) * 5
  return odds < 0 ? -rounded : rounded
}

const BET_TYPE_ORDER = [
  'moneyline',
  'run_line',
  'over_under',
  'first_inning_run',
  'hr_prop',
  'hit_prop',
  'k_prop',
  'custom',
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundToHalf(value) {
  return Math.round(value * 2) / 2
}

function roundToHook(value, min = 0.5) {
  const numeric = Number(value || 0)
  if (numeric <= min) return min
  return Math.floor(numeric) + 0.5
}

function roundToNearestHook(value, min = 0.5) {
  const numeric = Number(value || 0)
  if (numeric <= min) return min
  const lower = Math.floor(numeric) + 0.5
  const upper = Math.ceil(numeric) + 0.5
  return Math.abs(numeric - lower) <= Math.abs(upper - numeric) ? lower : upper
}

function average(values, fallback = 0) {
  if (!values.length) return fallback
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
}

function getSampleReliability({
  plateAppearances = 0,
  gamesPlayed = 0,
  paFullTrust = 60,
  gamesFullTrust = 12,
} = {}) {
  const paReliability = paFullTrust > 0 ? Number(plateAppearances || 0) / paFullTrust : 0
  const gameReliability = gamesFullTrust > 0 ? Number(gamesPlayed || 0) / gamesFullTrust : 0
  return clamp(Math.max(paReliability, gameReliability), 0, 1)
}

function shrinkHistoricalProbability(probability, reliability = 0) {
  return clamp(0.5 + ((Number(probability || 0.5) - 0.5) * clamp(reliability, 0, 1)), MIN_PROBABILITY, MAX_PROBABILITY)
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value))
}

function normalizeEdge(value, scale = 1) {
  return clamp(value / scale, -1, 1)
}

function applyVarianceToProbability(probability, varianceMultiplier = 1) {
  if (!varianceMultiplier || varianceMultiplier <= 1) return clamp(probability, MIN_PROBABILITY, MAX_PROBABILITY)
  return clamp(0.5 + ((probability - 0.5) / varianceMultiplier), MIN_PROBABILITY, MAX_PROBABILITY)
}

function probabilityFromProjectionGap(gap, stdDev = 1.5, tilt = 0) {
  const scale = Math.max(0.75, Number(stdDev || 0))
  return clamp(logistic((Number(gap || 0) / scale) * 3 + tilt), MIN_PROBABILITY, MAX_PROBABILITY)
}

function computeHomeCoverProbabilityAtSpread({
  spread,
  homeIsFav,
  favWinProb,
  projectedMargin,
  marginStdDev,
  coverTilt,
  varianceMultiplier = 1,
}) {
  const numericSpread = Number(spread || 0.5)
  const favCoverProb = numericSpread <= 0.5
    ? favWinProb
    : applyVarianceToProbability(
      probabilityFromProjectionGap(projectedMargin - numericSpread, marginStdDev, coverTilt),
      varianceMultiplier,
    )
  const dogCoverProb = clamp(1 - favCoverProb, MIN_PROBABILITY, MAX_PROBABILITY)
  return homeIsFav ? favCoverProb : dogCoverProb
}

function pickBoardRunLineSpread({
  projectedMargin,
  marginStdDev,
  homeIsFav,
  favWinProb,
  coverTilt,
  varianceMultiplier = 1,
}) {
  const maxSpread = Math.max(5.5, roundToNearestHook(projectedMargin + marginStdDev, 0.5) + 1)
  let bestSpread = 0.5
  let bestDistance = Number.POSITIVE_INFINITY

  for (let candidate = 0.5; candidate <= maxSpread; candidate += 1) {
    const homeCoverProb = computeHomeCoverProbabilityAtSpread({
      spread: candidate,
      homeIsFav,
      favWinProb,
      projectedMargin,
      marginStdDev,
      coverTilt,
      varianceMultiplier,
    })
    const distanceFromPickEm = Math.abs(homeCoverProb - 0.5)

    if (distanceFromPickEm < bestDistance - 0.0001) {
      bestSpread = candidate
      bestDistance = distanceFromPickEm
    }
  }

  return bestSpread
}

function buildWeights(weights = {}) {
  const raw = {
    char: Number(weights.char_stats_weight ?? weights.char ?? 0.333),
    historical: Number(weights.historical_weight ?? weights.historical ?? 0.333),
    live: Number(weights.live_weight ?? weights.live ?? 0.334),
  }

  const total = raw.char + raw.historical + raw.live || 1
  return {
    char: raw.char / total,
    historical: raw.historical / total,
    live: raw.live / total,
  }
}

function blendSources(sources, weights) {
  return clamp(
    sources.char * weights.char + sources.historical * weights.historical + sources.live * weights.live,
    MIN_PROBABILITY,
    MAX_PROBABILITY,
  )
}

function getCharacterRatings(entry = {}) {
  const rawBat = Number(entry.batting ?? entry.bat ?? 5)
  const rawPitch = Number(entry.pitching ?? entry.pitch ?? 5)
  const rawField = Number(entry.fielding ?? entry.field ?? 5)
  const rawSpeed = Number(entry.speed ?? 5)

  return {
    bat: clamp(rawBat / 10, 0, 1),
    pitch: clamp(rawPitch / 10, 0, 1),
    field: clamp(rawField / 10, 0, 1),
    speed: clamp(rawSpeed / 10, 0, 1),
  }
}

function getHistoricalSummary(entry = {}) {
  return {
    winRate: clamp(Number(entry.winRate ?? entry.careerWinRate ?? 0.5), 0, 1),
    avg: clamp(Number(entry.avg ?? entry.hitRate ?? 0.25), 0, 1),
    hrRate: clamp(Number(entry.hrRate ?? 0.05), 0, 1),
    hitRate: clamp(Number(entry.hitRate ?? entry.avg ?? 0.25), 0, 1),
    kRate: clamp(Number(entry.kRate ?? 0.2), 0, 1),
    strikeoutsPerInning: Math.max(0, Number(entry.strikeoutsPerInning ?? 0)),
    strikeoutsPerGame: Math.max(0, Number(entry.strikeoutsPerGame ?? 0)),
    gamesPlayed: Math.max(0, Number(entry.gamesPlayed ?? 0)),
    plateAppearances: Math.max(0, Number(entry.plateAppearances ?? 0)),
  }
}

function getLiveState(game = {}, playerProps = {}) {
  const gameState = playerProps.gameState || {}
  return {
    inning: Number(gameState.inning ?? game.current_inning ?? 1),
    totalInnings: normalizeRegulationInnings(
      gameState.totalInnings ?? playerProps.totalInnings ?? game.innings,
      DEFAULT_REGULATION_INNINGS,
    ),
    scoreDiff: Number(gameState.scoreDiff ?? (Number(game.team_b_runs || 0) - Number(game.team_a_runs || 0))),
    homeRuns: Number(gameState.homeRuns ?? game.team_b_runs ?? 0),
    awayRuns: Number(gameState.awayRuns ?? game.team_a_runs ?? 0),
    runsThisHalf: Number(gameState.runsThisHalf ?? 0),
    paCount: Number(gameState.paCount ?? playerProps.paCount ?? 0),
    homePitcherId: gameState.homePitcherId ?? playerProps.homePitcherId ?? null,
    awayPitcherId: gameState.awayPitcherId ?? playerProps.awayPitcherId ?? null,
  }
}

function getEntityLabel(entry = {}) {
  return entry.targetEntity || entry.entityLabel || entry.label || entry.name || 'Unknown'
}

function getExpectedPAs(entry = {}, liveState) {
  if (entry.expectedPAs != null) return Number(entry.expectedPAs)
  const inning = Math.max(1, Number(liveState.inning || 1))
  const totalInnings = normalizeRegulationInnings(liveState.totalInnings, DEFAULT_REGULATION_INNINGS)
  const legacyBaseline = inning >= 6 ? 1.5 : inning >= 4 ? 2.5 : 3.5
  const inningLimitedBaseline = Math.max(0.5, totalInnings - (inning - 1))
  const baseline = Math.min(legacyBaseline, inningLimitedBaseline)
  const alreadySeen = Number(entry.paSoFar ?? 0)
  return clamp(baseline - alreadySeen * 0.65, 0.5, Math.max(0.5, baseline))
}

function getSkillScore(entry = {}) {
  return clamp(
    Number(
      entry.skillProfile?.skillScore ??
        entry.skillScore ??
        getPlayerSkillProfile(entry.playerName || entry.playerId).skillScore,
    ),
    0,
    1,
  )
}

function getRosterAverages(roster = []) {
  return {
    bat: average(roster.map((entry) => Number(entry.batting ?? entry.bat ?? 5)), 5),
    pitch: average(roster.map((entry) => Number(entry.pitching ?? entry.pitch ?? 5)), 5),
    speed: average(roster.map((entry) => Number(entry.speed ?? 5)), 5),
    skill: average(roster.map((entry) => getSkillScore(entry)), 0.5),
  }
}

export function buildOddsRowKey(row = {}) {
  return `${row.bet_type}::${row.target_entity || 'game'}`
}

export function mergeOddsWithExistingRows(rows = [], existingRows = []) {
  const dedupedRows = Object.values(
    (rows || []).reduce((acc, row) => {
      acc[buildOddsRowKey(row)] = row
      return acc
    }, {}),
  )
  const existingByKey = Object.fromEntries(existingRows.map((entry) => [buildOddsRowKey(entry), entry]))
  return dedupedRows.map((row) => {
    if (row.id != null) return row
    const existing = existingByKey[buildOddsRowKey(row)]
    const merged = existing?.id != null ? { ...row, id: existing.id } : row
    if (merged.id == null) {
      const { id, ...rest } = merged
      return rest
    }
    return merged
  })
}

function compareRows(a, b) {
  return buildOddsRowKey(a) === buildOddsRowKey(b) && a.game_id === b.game_id
}

function buildMoneylineSources(homeRoster, awayRoster, homeHistorical, awayHistorical, liveState, playerProps = {}) {
  const homeProfile = getRosterAverages(homeRoster)
  const awayProfile = getRosterAverages(awayRoster)
  const charEdge = ((homeProfile.bat - awayProfile.pitch) - (awayProfile.bat - homeProfile.pitch)) / 10

  const headToHead = playerProps.headToHead || {}
  const historicalEdge = (Number(headToHead.homeWinRate ?? homeHistorical.winRate ?? 0.5) - 0.5) * 2
  const normalizedSkillDiff = homeProfile.skill - awayProfile.skill
  const headToHeadReliability = getSampleReliability({
    gamesPlayed: Number(headToHead.gamesPlayed || 0),
    gamesFullTrust: 16,
  })
  const rosterHistoryReliability = getSampleReliability({
    plateAppearances: Math.min(
      Number(homeHistorical.plateAppearances || 0),
      Number(awayHistorical.plateAppearances || 0),
    ),
    gamesPlayed: Math.min(
      Number(homeHistorical.gamesPlayed || 0),
      Number(awayHistorical.gamesPlayed || 0),
    ),
    paFullTrust: 120,
    gamesFullTrust: 20,
  })
  const historyReliability = clamp((headToHeadReliability * 0.7) + (rosterHistoryReliability * 0.3), 0, 1)
  const skillWeight = Math.max(0.42, 0.64 - historyReliability * 0.16)
  const historyWeight = 0.12 + historyReliability * 0.22
  const charWeight = Math.max(0.18, 1 - skillWeight - historyWeight)

  const char = logistic(charEdge * (1.8 + charWeight))
  const historical = shrinkHistoricalProbability(
    logistic(historicalEdge * (1.2 + historyWeight)),
    historyReliability,
  )
  const skill = logistic(normalizedSkillDiff * (1.35 + skillWeight * 0.6))

  // Live win probability: a lead matters far more with fewer innings left to play it back.
  const totalInnings = normalizeRegulationInnings(playerProps.totalInnings, DEFAULT_REGULATION_INNINGS)
  const completedInnings = clamp(liveState.inning - 1, 0, totalInnings - 1)
  const remainingInnings = Math.max(totalInnings - completedInnings, 0.5)
  const live = logistic((liveState.scoreDiff * 1.1) / Math.sqrt(remainingInnings))

  // Live weight ramps up as the game progresses, dominating by the final innings.
  const gameStarted = liveState.inning > 1 || liveState.scoreDiff !== 0 || liveState.paCount > 0
  const gameProgress = completedInnings / totalInnings
  const liveWeight = gameStarted ? clamp(0.12 + gameProgress * 0.85, 0.12, 0.92) : 0
  const remainder = 1 - liveWeight
  const pregameTotal = skillWeight + historyWeight + charWeight || 1

  return {
    char,
    historical,
    live,
    skill,
    weights: {
      char: (charWeight / pregameTotal) * remainder,
      historical: (historyWeight / pregameTotal) * remainder,
      skill: (skillWeight / pregameTotal) * remainder,
      live: liveWeight,
    },
  }
}

function buildPregameMoneylineProbability(moneylineSources = {}) {
  const pregameWeight =
    Number(moneylineSources.weights?.char || 0) +
    Number(moneylineSources.weights?.historical || 0) +
    Number(moneylineSources.weights?.skill || 0)

  if (!pregameWeight) return 0.5

  return clamp(
    (
      (Number(moneylineSources.char || 0.5) * Number(moneylineSources.weights?.char || 0)) +
      (Number(moneylineSources.historical || 0.5) * Number(moneylineSources.weights?.historical || 0)) +
      (Number(moneylineSources.skill || 0.5) * Number(moneylineSources.weights?.skill || 0))
    ) / pregameWeight,
    MIN_PROBABILITY,
    MAX_PROBABILITY,
  )
}

function getRemainingOutsBySide({
  currentInning = 1,
  isTop = true,
  outsInHalf = 0,
  totalInnings = DEFAULT_REGULATION_INNINGS,
}) {
  const inning = Math.max(1, Number(currentInning || 1))
  const outs = clamp(Number(outsInHalf || 0), 0, 2)
  const regulationInnings = normalizeRegulationInnings(totalInnings, DEFAULT_REGULATION_INNINGS)
  const inningsAfterCurrent = Math.max(regulationInnings - inning, 0)

  if (isTop) {
    return {
      away: Math.max(0, 3 - outs) + (inningsAfterCurrent * 3),
      home: inning > regulationInnings ? 0 : (Math.max(regulationInnings - inning + 1, 0) * 3),
    }
  }

  return {
    away: inningsAfterCurrent * 3,
    home: Math.max(0, 3 - outs) + (inningsAfterCurrent * 3),
  }
}

export function estimateLiveMarketState({
  game = {},
  homeRoster = [],
  awayRoster = [],
  homeHistorical = {},
  awayHistorical = {},
  playerProps = {},
  state = {},
}) {
  const status = state.status || game.status || 'active'
  const homeScore = Number(state.homeScore ?? game.team_b_runs ?? 0)
  const awayScore = Number(state.awayScore ?? game.team_a_runs ?? 0)

  if (status === 'complete') {
    const winProbability = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5
    return {
      winProbability,
      expectedMargin: homeScore - awayScore,
      marginVariance: 1,
      projectedTotal: homeScore + awayScore,
      totalVariance: 1,
    }
  }

  const totalInnings = normalizeRegulationInnings(
    state.regulationInnings ?? playerProps.totalInnings,
    DEFAULT_REGULATION_INNINGS,
  )
  const currentInning = Math.max(1, Number(state.currentInning ?? game.current_inning ?? 1))
  const isTop = Boolean(state.isTop ?? true)
  const outsInHalf = clamp(Number(state.outsInHalf ?? 0), 0, 2)
  const runnersOccupied = clamp(Number(state.runnersOccupied ?? 0), 0, 3)
  const balls = clamp(Number(state.balls ?? 0), 0, 3)
  const strikes = clamp(Number(state.strikes ?? 0), 0, 2)
  const paCount = Math.max(0, Number(state.paCount ?? playerProps.gameState?.paCount ?? 0))
  const scoreDiff = homeScore - awayScore

  const liveState = {
    inning: currentInning,
    scoreDiff,
    homeRuns: homeScore,
    awayRuns: awayScore,
    paCount,
    homePitcherId: playerProps.gameState?.homePitcherId ?? null,
    awayPitcherId: playerProps.gameState?.awayPitcherId ?? null,
  }

  const moneylineSources = buildMoneylineSources(
    homeRoster,
    awayRoster,
    homeHistorical,
    awayHistorical,
    liveState,
    { ...playerProps, totalInnings },
  )
  const pregameProbability = buildPregameMoneylineProbability(moneylineSources)

  if (status === 'pending') {
    return {
      winProbability: pregameProbability,
      expectedMargin: 0,
      marginVariance: Math.max(1.1, Number(playerProps.runLineData?.stdDev || 2.5)),
      projectedTotal: Number(playerProps.historicalTotals?.average || 0) || null,
      totalVariance: Math.max(1, Number(playerProps.historicalTotals?.stdDev || 2.5)),
    }
  }

  const projectedScore = buildProjectedScore(
    homeRoster,
    awayRoster,
    liveState,
    { ...playerProps, totalInnings },
  )
  const remainingOuts = getRemainingOutsBySide({
    currentInning,
    isTop,
    outsInHalf,
    totalInnings,
  })
  const totalOutsRemaining = remainingOuts.home + remainingOuts.away
  const totalGameOuts = totalInnings * 6
  const remainingOutFraction = clamp(totalOutsRemaining / Math.max(totalGameOuts, 1), 0, 1)
  const progress = clamp(1 - remainingOutFraction, 0, 1)
  const historicalMarginStd = Math.max(
    1.1,
    Number(playerProps.runLineData?.stdDev || 0),
    Number(playerProps.historicalTotals?.stdDev || 0) * 0.55,
  )
  const oneRunGameRate = clamp(Number(playerProps.runLineData?.oneRunGameRate || 0.28), 0.15, 0.65)
  const baseStatePressure = (runnersOccupied * 0.14) + ((balls * 0.045) - (strikes * 0.035))
  const battingStateAdjustment = (isTop ? -1 : 1) * baseStatePressure * (0.42 + progress * 0.58)
  const lastBatBonus = !isTop ? 0.08 : 0
  const expectedMargin =
    Number(projectedScore.margin || scoreDiff) +
    battingStateAdjustment +
    ((pregameProbability - 0.5) * 0.65) +
    lastBatBonus

  const variance =
    Math.max(
      0.72,
      historicalMarginStd * (0.42 + remainingOutFraction * 0.95),
    ) +
    (Math.abs(scoreDiff) <= 1 ? oneRunGameRate * (0.9 + remainingOutFraction * 0.8) : 0)

  const liveProbability = clamp(
    logistic(expectedMargin / variance),
    MIN_PROBABILITY,
    MAX_PROBABILITY,
  )
  const liveWeight = clamp(
    0.1 + (progress * 0.74),
    0.1,
    0.94,
  )

  let probability = (pregameProbability * (1 - liveWeight)) + (liveProbability * liveWeight)

  if (currentInning >= totalInnings && isTop && homeScore > awayScore) {
    const closeoutFloor = clamp(
      0.64 + ((homeScore - awayScore) * 0.08) + (outsInHalf * 0.1),
      0.64,
      0.96,
    )
    probability = Math.max(probability, closeoutFloor)
  }

  // Baserunners and a deep count both raise the chance of more runs scoring
  // this half-inning, regardless of which team is batting — push the total up.
  const totalStateAdjustment = baseStatePressure * (0.42 + progress * 0.58)
  const totalStdDev = Math.max(1, Number(playerProps.historicalTotals?.stdDev || 2.5))
  const projectedTotal = Math.max(homeScore + awayScore, Number(projectedScore.line || 0) + totalStateAdjustment)
  const totalVariance = Math.max(0.9, totalStdDev * (0.42 + remainingOutFraction * 0.95))

  return {
    winProbability: clamp(probability, MIN_PROBABILITY, MAX_PROBABILITY),
    expectedMargin,
    marginVariance: variance,
    projectedTotal,
    totalVariance,
  }
}

export function estimateLiveWinProbability(args) {
  return estimateLiveMarketState(args).winProbability
}

function buildProjectedScore(homeRoster, awayRoster, liveState, playerProps = {}) {
  const homeProfile = getRosterAverages(homeRoster)
  const awayProfile = getRosterAverages(awayRoster)
  const historicalTotals = playerProps.historicalTotals || {}
  const headToHead = playerProps.headToHead || {}
  const scoringFactor = Number(playerProps.stadiumModifiers?.scoringFactor || 1)

  const baseHomeRuns = ((homeProfile.bat / 10) * (1 - awayProfile.pitch / 20) * 9)
  const baseAwayRuns = ((awayProfile.bat / 10) * (1 - homeProfile.pitch / 20) * 9)
  const estimatedTotal =
    baseHomeRuns +
    baseAwayRuns

  const skillAdjustment = ((homeProfile.skill + awayProfile.skill) / 2) * Number(historicalTotals.stdDev || 0) * 0.3
  const historicalWeight = clamp(Number(playerProps.weights?.historical_weight ?? 0.333), 0, 1)
  const charWeight = clamp(Number(playerProps.weights?.char_stats_weight ?? 0.333), 0, 1)
  const historySample = Number(historicalTotals.sampleSize || 0)
  const historySampleReliability = getSampleReliability({
    gamesPlayed: historySample,
    gamesFullTrust: 18,
  })
  const historicalContribution = historicalWeight * historySampleReliability
  const charContribution = charWeight + (historicalWeight * (1 - historySampleReliability))
  const blendedTotal =
    (historicalContribution * Number(historicalTotals.average || 0)) +
    (charContribution * estimatedTotal) +
    skillAdjustment
  const adjustedTotal = Math.max(0.5, blendedTotal * scoringFactor)
  const totalScale = adjustedTotal / Math.max(0.5, estimatedTotal)

  let projectedHomeRuns = baseHomeRuns * totalScale
  let projectedAwayRuns = baseAwayRuns * totalScale

  const historyReliability = getSampleReliability({
    gamesPlayed: Number(headToHead.gamesPlayed || 0),
    gamesFullTrust: 16,
  })
  const homeShareBias =
    ((homeProfile.skill - awayProfile.skill) * 0.4) +
    (((Number(headToHead.homeWinRate ?? 0.5) - 0.5) * 2) * historyReliability * 0.35)
  const shareShift = clamp(homeShareBias * adjustedTotal * 0.08, -adjustedTotal * 0.18, adjustedTotal * 0.18)
  projectedHomeRuns = Math.max(0.25, projectedHomeRuns + shareShift)
  projectedAwayRuns = Math.max(0.25, projectedAwayRuns - shareShift)

  const matchupAdvantage =
    ((homeProfile.bat * homeProfile.skill) + (awayProfile.bat * awayProfile.skill)) / 2 -
    ((homeProfile.pitch * homeProfile.skill) + (awayProfile.pitch * awayProfile.skill)) / 2

  const inning = Number(liveState.inning || 1)
  const currentHomeRuns = Math.max(0, Number(liveState.homeRuns || 0))
  const currentAwayRuns = Math.max(0, Number(liveState.awayRuns || 0))
  const currentTotalRuns = currentHomeRuns + currentAwayRuns
  const totalInnings = normalizeRegulationInnings(playerProps.totalInnings, DEFAULT_REGULATION_INNINGS)
  const completedInnings = clamp(inning - 1, 0, totalInnings)

  if (currentTotalRuns > 0 || inning > 1) {
    const remainingFactor = clamp((totalInnings - completedInnings) / totalInnings, 0, 1)
    projectedHomeRuns = currentHomeRuns + Math.max(0, projectedHomeRuns * remainingFactor)
    projectedAwayRuns = currentAwayRuns + Math.max(0, projectedAwayRuns * remainingFactor)
  }

  return {
    homeRuns: projectedHomeRuns,
    awayRuns: projectedAwayRuns,
    line: Math.max(0.5, projectedHomeRuns + projectedAwayRuns),
    margin: projectedHomeRuns - projectedAwayRuns,
    estimatedTotal,
    matchupAdvantage,
    historicalTotals,
  }
}

function buildRunExpectation(homeRoster, awayRoster, liveState, playerProps = {}) {
  return buildProjectedScore(homeRoster, awayRoster, liveState, playerProps)
}

function buildFirstInningSources(homeRoster, awayRoster, homeHistorical, awayHistorical, liveState) {
  const awayTop = getRosterAverages(awayRoster)
  const homeTop = getRosterAverages(homeRoster)
  const charEdge = (((awayTop.bat * awayTop.skill) - homeTop.pitch) + ((homeTop.bat * homeTop.skill) - awayTop.pitch)) / 10
  const historicalEdge = ((homeHistorical.hitRate || 0.25) + (awayHistorical.hitRate || 0.25)) - 0.5
  const historicalReliability = getSampleReliability({
    plateAppearances: Number(homeHistorical.plateAppearances || 0) + Number(awayHistorical.plateAppearances || 0),
    gamesPlayed: Number(homeHistorical.gamesPlayed || 0) + Number(awayHistorical.gamesPlayed || 0),
    paFullTrust: 80,
    gamesFullTrust: 18,
  })

  return {
    char: clamp(logistic(charEdge * 1.4), MIN_PROBABILITY, MAX_PROBABILITY),
    historical: shrinkHistoricalProbability(
      clamp(logistic(historicalEdge * 1.35), MIN_PROBABILITY, MAX_PROBABILITY),
      historicalReliability,
    ),
    live: clamp(0.42 - Math.min(liveState.paCount, 1) * 0.32, MIN_PROBABILITY, MAX_PROBABILITY),
  }
}

function buildPlayerPropSources(entry, historicalEntry, opposingPitcher, liveState) {
  const character = getCharacterRatings(entry)
  const historical = getHistoricalSummary(historicalEntry)
  const pitcher = getCharacterRatings(opposingPitcher)
  const expectedPAs = getExpectedPAs(entry, liveState)
  const hitterSkill = getSkillScore(entry)
  const pitcherSkill = getSkillScore(opposingPitcher)
  const historyReliability = getSampleReliability({
    plateAppearances: historical.plateAppearances,
    gamesPlayed: historical.gamesPlayed,
    paFullTrust: 60,
    gamesFullTrust: 12,
  })
  const historyWeight = clamp(0.12 + historyReliability * 0.23, 0.12, 0.35)
  const skillWeight = Math.max(0.28, 0.42 - historyReliability * 0.08)
  const charWeight = Math.max(0.26, 1 - historyWeight - skillWeight)
  const liveWeight = liveState.inning > 1 || Number(entry.paSoFar || 0) > 0 ? 0.12 : 0.05

  const hrPerPA = clamp(
    (character.bat * 0.036 * charWeight) +
      (historical.hrRate * 0.78 * historyWeight) +
      (hitterSkill * 0.068 * skillWeight) -
      ((pitcher.pitch * pitcherSkill) * 0.014),
    0.012,
    0.32,
  )
  // HR rate is a rare, high-variance event — a single recent game (n=1) is nearly
  // pure noise, so shrink the historical HR rate toward the intrinsic power-stat
  // baseline based on plate-appearance sample size (full trust around 40+ PAs).
  const hrCharBaseline = clamp((character.bat * 0.036) + (hitterSkill * 0.03), 0.015, 0.24)
  const hrSampleReliability = clamp(historical.plateAppearances / 40, 0, 1)
  const hrEffectiveRate = clamp(
    (hrCharBaseline * (1 - hrSampleReliability)) +
      (clamp(historical.hrRate, 0, 0.4) * (1 + hitterSkill * 0.35)) * hrSampleReliability,
    0.012,
    0.28,
  )
  const hitPerPA = clamp(
    (character.bat * 0.19 * charWeight) +
      (character.speed * 0.06 * charWeight) +
      (historical.hitRate * 0.58 * historyWeight) +
      (hitterSkill * 0.16 * skillWeight) -
      ((pitcher.pitch * pitcherSkill) * 0.05),
    0.08,
    0.78,
  )
  const liveSkillPressure = Math.max(0, liveState.inning - 1) * 0.015
  const totalInnings = normalizeRegulationInnings(liveState.totalInnings, DEFAULT_REGULATION_INNINGS)
  const completedInnings = clamp(Number(liveState.inning || 1) - 1, 0, totalInnings)
  const kPerInning = clamp(
    (pitcher.pitch * 0.52 * charWeight) +
      (historical.strikeoutsPerInning * 0.4 * historyWeight) +
      (pitcherSkill * 0.38 * skillWeight) -
      (character.bat * hitterSkill * 0.16),
    0.85,
    2.4,
  )
  const projectedInningsRemaining = clamp(totalInnings - completedInnings, 0.5, totalInnings)

  // PART G — if a prop has effectively already resolved by the time it's
  // being priced (e.g. the player already has a hit/HR this game, or a
  // pitcher already has Ks toward a K-prop line), the probability must
  // reflect that progress rather than re-deriving it from pre-game rates.
  const hrSoFar = Number(entry.hrSoFar || 0)
  const hitsSoFar = Number(entry.hitsSoFar || 0)
  const kSoFar = Number(entry.kSoFar || 0)

  // PART G — these always price "one more" HR/hit from this point on. Once a
  // player has already recorded one (hrSoFar/hitsSoFar > 0), the prop's line
  // is bumped to the next milestone (see generateGameOdds) and this same
  // probability now represents the chance of reaching THAT milestone, rather
  // than being pinned to a near-certain sentinel value.
  const hrSources = {
    char: clamp(1 - Math.pow(1 - clamp((character.bat * 0.036) + (hitterSkill * 0.03), 0.015, 0.24), expectedPAs), MIN_PROBABILITY, MAX_PROBABILITY),
    historical: clamp(1 - Math.pow(1 - hrEffectiveRate, expectedPAs), MIN_PROBABILITY, MAX_PROBABILITY),
    live: clamp(1 - Math.pow(1 - hrPerPA, Math.max(expectedPAs, 0.5)) + liveWeight * 0.04, MIN_PROBABILITY, MAX_PROBABILITY),
  }

  const hitSources = {
    char: clamp(1 - Math.pow(1 - clamp((character.bat * 0.17) + (character.speed * 0.04) + (hitterSkill * 0.09), 0.1, 0.58), expectedPAs), MIN_PROBABILITY, MAX_PROBABILITY),
    historical: clamp(1 - Math.pow(1 - clamp(historical.hitRate * (0.95 + hitterSkill * 0.25), 0.1, 0.68), expectedPAs), MIN_PROBABILITY, MAX_PROBABILITY),
    live: clamp(1 - Math.pow(1 - hitPerPA, Math.max(expectedPAs, 0.5)) + liveWeight * 0.03, MIN_PROBABILITY, MAX_PROBABILITY),
  }

  const strikeoutLine = roundToHalf(clamp((historical.strikeoutsPerGame * historyWeight) + (kPerInning * projectedInningsRemaining) + liveSkillPressure, 0.5, 8.5))
  // PART G — the strikeout line always refers to the FULL-GAME total. Once a
  // pitcher already has Ks recorded (kSoFar > 0), price "over" based on how
  // many MORE Ks they need (remainingNeeded) vs. the expected number they'll
  // pick up in the innings left, instead of the pre-game rate-based formula.
  let strikeoutSources
  if (kSoFar > 0) {
    const expectedRemainingKs = kPerInning * projectedInningsRemaining
    const remainingNeeded = strikeoutLine - kSoFar
    const kOverProb = remainingNeeded <= 0
      ? MAX_PROBABILITY
      : clamp(logistic((expectedRemainingKs - remainingNeeded) * 1.1), MIN_PROBABILITY, MAX_PROBABILITY)
    strikeoutSources = { char: kOverProb, historical: kOverProb, live: kOverProb }
  } else {
    strikeoutSources = {
      char: clamp(logistic((character.pitch + hitterSkill - character.bat) * 0.8), MIN_PROBABILITY, MAX_PROBABILITY),
      historical: clamp(logistic((historical.strikeoutsPerInning * 1.35) - 0.6), MIN_PROBABILITY, MAX_PROBABILITY),
      live: clamp(logistic((kPerInning - 0.9) + liveSkillPressure), MIN_PROBABILITY, MAX_PROBABILITY),
    }
  }

  // Poisson rate parameters for arbitrary over/under count lines (PART I —
  // props overhaul). hr/hit lambdas project the FULL-GAME total count
  // (already-recorded + expected remaining); the k lambda is likewise a
  // full-game projection so it lines up with strikeoutLine.
  const remainingPAs = Math.max(expectedPAs, 0.5)
  const hrLambda = Math.max(0.01, hrPerPA * remainingPAs)
  const hitLambda = Math.max(0.01, hitPerPA * remainingPAs)
  const kLambda = Math.max(0.01, kPerInning * projectedInningsRemaining)

  return {
    hr: { ...hrSources, lambda: hrLambda, settledCount: hrSoFar },
    hit: { ...hitSources, lambda: hitLambda, settledCount: hitsSoFar },
    strikeouts: {
      line: strikeoutLine,
      lambda: kLambda,
      settledCount: kSoFar,
      ...strikeoutSources,
    },
  }
}

// Baseline P(winner margin > spread) with no historical data, calibrated to Mario Baseball
function runLineFallback(spread) {
  return clamp(0.62 - spread * 0.10, 0.05, 0.80)
}

export function computeRunLineCoverProb(spread, margins = []) {
  const baseline = runLineFallback(spread)
  if (!margins.length) return baseline
  const raw = margins.filter((m) => m > spread).length / margins.length
  // Regress toward baseline proportionally to sample size — full trust at 20+ games
  const confidence = clamp(margins.length / 20, 0, 1)
  return clamp(raw * confidence + baseline * (1 - confidence), MIN_PROBABILITY, MAX_PROBABILITY)
}

function logFactorial(n) {
  let sum = 0
  for (let i = 2; i <= n; i++) sum += Math.log(i)
  return sum
}

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  return Math.exp((-lambda) + (k * Math.log(lambda)) - logFactorial(k))
}

// P(currentCount + X > line) for X ~ Poisson(lambdaRemaining). Lines are
// always at the X.5 hooks (0.5, 1.5, 2.5, ...), so "over" means the FINAL
// count is at least floor(line) + 1 after adding the already-recorded count.
export function poissonOverProbability(lambda, line, settledCount = 0) {
  const safeLambda = Math.max(0.01, Number(lambda || 0))
  const targetTotal = Math.max(0, Math.floor(Number(line ?? 0.5)) + 1)
  const neededRemaining = targetTotal - Math.max(0, Number(settledCount || 0))
  if (neededRemaining <= 0) return MAX_PROBABILITY
  let cdf = 0
  for (let k = 0; k < neededRemaining; k++) cdf += poissonPmf(k, safeLambda)
  return clamp(1 - cdf, MIN_PROBABILITY, MAX_PROBABILITY)
}

// Standard sportsbook overround: both sides' implied probabilities sum to ~107%
// (target is configurable; 105-110% is the typical sportsbook range).
export const TARGET_OVERROUND = 1.07

function getOddsMultiplierFromOverround(overround = TARGET_OVERROUND) {
  const safeOverround = Math.max(1.001, Number(overround || TARGET_OVERROUND))
  // Public bookmaking references describe the simplest margin model as a
  // proportional reduction of the fair odds rather than a flat additive bump
  // to probability. Calibrate the multiplier so a 50/50 market lands on the
  // requested total overround, then apply that same reduction to any 2-way
  // market. This avoids the artificial +2600-ish cap that additive probability
  // vig creates on longshots.
  return clamp((2 / safeOverround) - 1, 0.001, 1)
}

// Step 1 of the pricing pipeline: take a "fair" probability for one side of a
// 2-outcome market and apply the house edge by proportionally shrinking the
// fair net odds. This matches the classic "reduce the odds" bookmaking model
// better than adding a flat probability surcharge.
export function applyVig(probability, overround = TARGET_OVERROUND) {
  const fairProbability = clamp(Number(probability || 0), MIN_PROBABILITY, MAX_PROBABILITY)
  const oddsMultiplier = getOddsMultiplierFromOverround(overround)
  const fairDecimalOdds = 1 / fairProbability
  const vigDecimalOdds = 1 + ((fairDecimalOdds - 1) * oddsMultiplier)
  return clamp(1 / vigDecimalOdds, MIN_PROBABILITY, MAX_PROBABILITY)
}

// Step 2 of the pricing pipeline: convert a vig-adjusted probability to American odds.
export function oddsFromVigProbability(vigProbability) {
  const probability = clamp(Number(vigProbability || 0), MIN_PROBABILITY, MAX_PROBABILITY)
  const decimalOdds = clamp(1 / probability, MIN_DISPLAY_DECIMAL_ODDS, MAX_DISPLAY_DECIMAL_ODDS)
  let odds

  if (decimalOdds >= 2) {
    odds = Math.round((decimalOdds - 1) * 100)
  } else {
    odds = Math.round(-100 / (decimalOdds - 1))
  }

  return clamp(roundOddsMagnitude(odds), MAX_FAVORITE_ODDS, MAX_UNDERDOG_ODDS)
}

// Convenience wrapper: fair probability -> apply vig -> American odds.
export function americanOddsFromProbability(probability, overround = TARGET_OVERROUND) {
  return oddsFromVigProbability(applyVig(probability, overround))
}

// ── PART C/D/E — volume-based line movement, arbitrage-proofing, liability caps ──

// Max probability-point shift the volume adjustment can apply to either side.
export const MAX_VOLUME_SHIFT = 0.12
// Below this much total wagered on a market, volume adjustments are ignored
// (avoids wild swings from a single small bet).
export const MIN_MARKET_LIQUIDITY = 20
// Max payout liability the collective bank will carry on one side of a market
// before that side is suspended for new bets.
export const DEFAULT_LIABILITY_CAP = 500

// Throws if a 2-sided market's implied probabilities don't sum to >1 (i.e. the
// market could be arbitraged by betting both sides). Intended for dev-time
// assertions / tests, not the hot path.
export function assertNoArbitrage(probabilityA, probabilityB, label = 'market') {
  const total = Number(probabilityA || 0) + Number(probabilityB || 0)
  if (total <= 1) {
    throw new Error(`Arbitrage detected in ${label}: implied probabilities sum to ${total.toFixed(4)} (must be > 1)`)
  }
  return total
}

// Prices a 2-sided market end-to-end:
//   fair probability (side A) -> volume-based line movement -> vig -> American odds
// `moneyA`/`moneyB` are total dollars wagered on each side so far (PART C).
// `liabilityA`/`liabilityB` are the house's potential payout exposure on each
// side; once either exceeds `liabilityCap` the market is marked suspended
// (PART E). The volume shift always keeps probabilityA in (0, 1), and vig is
// applied symmetrically from probabilityA/1-probabilityA, so the arbitrage
// invariant from PART D holds by construction.
export function priceMarket(fairProbabilityA, options = {}) {
  const {
    moneyA = 0,
    moneyB = 0,
    liabilityA = 0,
    liabilityB = 0,
    liabilityCap = DEFAULT_LIABILITY_CAP,
    overround = TARGET_OVERROUND,
    alreadySuspended = false,
  } = options

  const totalMoney = Number(moneyA || 0) + Number(moneyB || 0)
  const liquidity = Math.max(totalMoney, MIN_MARKET_LIQUIDITY)
  const imbalance = clamp((Number(moneyA || 0) - Number(moneyB || 0)) / liquidity, -1, 1)
  // More money on side A makes side A's odds worse (higher implied probability).
  const volumeShift = imbalance * MAX_VOLUME_SHIFT
  const adjustedProbabilityA = clamp(Number(fairProbabilityA || 0.5) + volumeShift, MIN_PROBABILITY, MAX_PROBABILITY)
  const adjustedProbabilityB = 1 - adjustedProbabilityA

  const vigA = applyVig(adjustedProbabilityA, overround)
  const vigB = applyVig(adjustedProbabilityB, overround)
  assertNoArbitrage(vigA, vigB, 'priceMarket')

  const liabilityExceeded = Number(liabilityA || 0) > liabilityCap || Number(liabilityB || 0) > liabilityCap
  const volumeMaxedOut = Math.abs(volumeShift) >= MAX_VOLUME_SHIFT && Math.abs(imbalance) >= 1
  const isSuspended = alreadySuspended || liabilityExceeded || volumeMaxedOut

  return {
    oddsA: oddsFromVigProbability(vigA),
    oddsB: oddsFromVigProbability(vigB),
    probabilityA: adjustedProbabilityA,
    isSuspended,
  }
}

export function calculatePayout(wagerSips, americanOdds) {
  const stake = Number(wagerSips || 0)
  const odds = Number(americanOdds || 0)
  if (!stake || !odds) return 0

  const raw = odds > 0 ? (odds / 100) * stake : (100 / Math.abs(odds)) * stake
  return Math.round(raw * 100) / 100
}

// Looks up tracked wager volume / liability for a 2-sided market (PART C/E),
// keyed the same way as buildOddsRowKey, then runs it through priceMarket
// (volume adjustment -> vig -> American odds, with arb-proofing built in).
function priceTwoSidedMarket(fairProbabilityA, playerProps, betType, targetEntity, sideA, sideB) {
  const key = `${betType}::${targetEntity || 'game'}`
  const stats = playerProps?.marketVolume?.[key] || {}
  const a = stats[sideA] || {}
  const b = stats[sideB] || {}
  return priceMarket(fairProbabilityA, {
    moneyA: a.money,
    moneyB: b.money,
    liabilityA: a.liability,
    liabilityB: b.liability,
    liabilityCap: playerProps?.liabilityCap,
  })
}

// Prices an arbitrary over/under line on a Poisson-distributed REMAINING count
// (HR/hit/K props) end-to-end: remaining lambda + already-banked count + line
// -> Poisson over-probability -> variance -> volume-based line movement -> vig
// -> American odds. `marketVolume` is the `{ over: { money, liability }, under:
// {...} }` slice for this exact line, if any bets have been placed on it.
export function priceCountPropLine(lambda, line, options = {}) {
  const { varianceMultiplier = 1, marketVolume = {}, liabilityCap, overround = TARGET_OVERROUND, settledCount = 0 } = options
  const rawOverProbability = poissonOverProbability(lambda, line, settledCount)
  const overProbability = applyVarianceToProbability(rawOverProbability, varianceMultiplier)
  const over = marketVolume.over || {}
  const under = marketVolume.under || {}
  const pricing = priceMarket(overProbability, {
    moneyA: over.money,
    moneyB: under.money,
    liabilityA: over.liability,
    liabilityB: under.liability,
    liabilityCap,
    overround,
  })

  return {
    oddsOver: pricing.oddsA,
    oddsUnder: pricing.oddsB,
    probabilityOver: pricing.probabilityA,
    isSuspended: pricing.isSuspended,
  }
}

export function generateGameOdds(
  game,
  homeRoster = [],
  awayRoster = [],
  homeHistorical = {},
  awayHistorical = {},
  playerProps = {},
  weights = {},
) {
  const normalizedWeights = buildWeights(weights)
  const liveState = getLiveState(game, playerProps)
  const stadiumModel = buildAppliedStadiumModel(
    playerProps.stadium,
    playerProps.isNight,
    playerProps.stadiumGameLog || [],
  )
  const stadiumModifiers = stadiumModel.finalModifiers
  const rows = []

  const moneylineSources = buildMoneylineSources(homeRoster, awayRoster, homeHistorical, awayHistorical, liveState, playerProps)
  const baseMoneylineProbability = clamp(
    (moneylineSources.char * moneylineSources.weights.char) +
      (moneylineSources.historical * moneylineSources.weights.historical) +
      (moneylineSources.skill * moneylineSources.weights.skill) +
      (moneylineSources.live * moneylineSources.weights.live),
    MIN_PROBABILITY,
    MAX_PROBABILITY,
  )
  const moneylineProbability = applyVarianceToProbability(baseMoneylineProbability, stadiumModifiers.varianceMultiplier)

  const moneylinePricing = priceTwoSidedMarket(moneylineProbability, playerProps, 'moneyline', null, 'home', 'away')

  rows.push({
    game_id: game.id,
    bet_type: 'moneyline',
    target_entity: null,
    line: null,
    odds_home: moneylinePricing.oddsA,
    odds_away: moneylinePricing.oddsB,
    predicted_probability: Number(moneylinePricing.probabilityA.toFixed(4)),
    is_locked: moneylinePricing.isSuspended,
    updated_at: new Date().toISOString(),
  })

  // ── Run line ───────────────────────────────────────────────────────────────
  const scoreProjection = buildRunExpectation(homeRoster, awayRoster, liveState, {
    ...playerProps,
    weights,
    stadiumModifiers,
  })

  const rlData = playerProps.runLineData || {}
  const histAvgMargin = Number(rlData.historicalAvgMargin ?? 3.5)
  const marginStdDev = Math.max(1, Number(rlData.stdDev || histAvgMargin || 2.5))
  const projectedMargin = Math.abs(Number(scoreProjection.margin || 0))
  const homeIsFav = moneylineProbability >= 0.5
  const favWinProb = homeIsFav ? moneylineProbability : 1 - moneylineProbability
  const coverTilt = (favWinProb - 0.5) * 0.25
  const defaultSpread = pickBoardRunLineSpread({
    projectedMargin,
    marginStdDev,
    homeIsFav,
    favWinProb,
    coverTilt,
    varianceMultiplier: stadiumModifiers.varianceMultiplier,
  })
  const homeCoverProb = computeHomeCoverProbabilityAtSpread({
    spread: defaultSpread,
    homeIsFav,
    favWinProb,
    projectedMargin,
    marginStdDev,
    coverTilt,
    varianceMultiplier: stadiumModifiers.varianceMultiplier,
  })
  const runLinePricing = priceTwoSidedMarket(homeCoverProb, playerProps, 'run_line', null, 'home', 'away')

  rows.push({
    game_id: game.id,
    bet_type: 'run_line',
    target_entity: null,
    line: defaultSpread,
    odds_home: runLinePricing.oddsA,
    odds_away: runLinePricing.oddsB,
    predicted_probability: Number(runLinePricing.probabilityA.toFixed(4)),
    is_locked: runLinePricing.isSuspended,
    updated_at: new Date().toISOString(),
  })

  const totalRunSources = scoreProjection
  const totalLine = roundToHook(totalRunSources.line, 0.5)
  const totalStdDev = Math.max(1, Number(totalRunSources.historicalTotals?.stdDev || 2.5))
  const overProbability = applyVarianceToProbability(
    probabilityFromProjectionGap(totalRunSources.line - totalLine, totalStdDev),
    stadiumModifiers.varianceMultiplier,
  )
  const totalPricing = priceTwoSidedMarket(overProbability, playerProps, 'over_under', null, 'over', 'under')

  rows.push({
    game_id: game.id,
    bet_type: 'over_under',
    target_entity: null,
    line: totalLine,
    odds_over: totalPricing.oddsA,
    odds_under: totalPricing.oddsB,
    predicted_probability: Number(totalPricing.probabilityA.toFixed(4)),
    is_locked: totalPricing.isSuspended,
    updated_at: new Date().toISOString(),
  })

  const firstInningProbability = applyVarianceToProbability(
    blendSources(
      buildFirstInningSources(homeRoster, awayRoster, homeHistorical, awayHistorical, liveState),
      normalizedWeights,
    ),
    stadiumModifiers.varianceMultiplier,
  )
  const firstInningPricing = priceTwoSidedMarket(firstInningProbability, playerProps, 'first_inning_run', null, 'yes', 'no')

  rows.push({
    game_id: game.id,
    bet_type: 'first_inning_run',
    target_entity: null,
    line: 0.5,
    odds_yes: firstInningPricing.oddsA,
    odds_no: firstInningPricing.oddsB,
    predicted_probability: Number(firstInningPricing.probabilityA.toFixed(4)),
    is_locked: firstInningPricing.isSuspended,
    updated_at: new Date().toISOString(),
  })

  const awayPitcher = awayRoster.find((entry) => entry.isPitcher || entry.isActivePitcher || entry.id === liveState.awayPitcherId) || awayRoster[0]
  const homePitcher = homeRoster.find((entry) => entry.isPitcher || entry.isActivePitcher || entry.id === liveState.homePitcherId) || homeRoster[0]
  const playerHistorical = playerProps.historicalByEntity || {}
  const stadiumHrBoost = clamp(stadiumModifiers.hrFactor, 0.82, 1.28)
  const stadiumHitBoost = clamp((stadiumModifiers.scoringFactor * 0.6) + (stadiumModifiers.hrFactor * 0.4), 0.88, 1.22)

  homeRoster.forEach((entry) => {
    const label = getEntityLabel(entry)
    const sources = buildPlayerPropSources(entry, playerHistorical[label] || playerHistorical[entry.id] || {}, awayPitcher, liveState)
    // PART I — props overhaul: hr/hit props are now Poisson-distributed
    // over/under count markets, priced from a per-player lambda (expected
    // full-game total) with stadium HR/scoring factors applied as a boost.
    const hrLambda = sources.hr.lambda * stadiumHrBoost
    const hitLambda = sources.hit.lambda * stadiumHitBoost
    const hrCurrentCount = Number(entry.hrSoFar || 0)
    const hitCurrentCount = Number(entry.hitsSoFar || 0)
    const hrLine = 0.5 + hrCurrentCount
    const hitLine = 0.5 + hitCurrentCount
    const hrPricing = priceCountPropLine(hrLambda, hrLine, {
      varianceMultiplier: stadiumModifiers.varianceMultiplier,
      marketVolume: playerProps?.marketVolume?.[`hr_prop::${label}`],
      liabilityCap: playerProps?.liabilityCap,
      settledCount: hrCurrentCount,
    })
    const hitPricing = priceCountPropLine(hitLambda, hitLine, {
      varianceMultiplier: stadiumModifiers.varianceMultiplier,
      marketVolume: playerProps?.marketVolume?.[`hit_prop::${label}`],
      liabilityCap: playerProps?.liabilityCap,
      settledCount: hitCurrentCount,
    })

    rows.push({
      game_id: game.id,
      bet_type: 'hr_prop',
      target_entity: label,
      line: hrLine,
      prop_current_count: hrCurrentCount,
      prop_lambda: Number(hrLambda.toFixed(3)),
      prop_variance_multiplier: stadiumModifiers.varianceMultiplier,
      odds_over: hrPricing.oddsOver,
      odds_under: hrPricing.oddsUnder,
      predicted_probability: Number(hrPricing.probabilityOver.toFixed(4)),
      is_locked: hrPricing.isSuspended,
      updated_at: new Date().toISOString(),
    })

    rows.push({
      game_id: game.id,
      bet_type: 'hit_prop',
      target_entity: label,
      line: hitLine,
      prop_current_count: hitCurrentCount,
      prop_lambda: Number(hitLambda.toFixed(3)),
      prop_variance_multiplier: stadiumModifiers.varianceMultiplier,
      odds_over: hitPricing.oddsOver,
      odds_under: hitPricing.oddsUnder,
      predicted_probability: Number(hitPricing.probabilityOver.toFixed(4)),
      is_locked: hitPricing.isSuspended,
      updated_at: new Date().toISOString(),
    })
  })

  awayRoster.forEach((entry) => {
    const label = getEntityLabel(entry)
    const sources = buildPlayerPropSources(entry, playerHistorical[label] || playerHistorical[entry.id] || {}, homePitcher, liveState)
    // PART I — props overhaul: hr/hit props are now Poisson-distributed
    // over/under count markets, priced from a per-player lambda (expected
    // full-game total) with stadium HR/scoring factors applied as a boost.
    const hrLambda = sources.hr.lambda * stadiumHrBoost
    const hitLambda = sources.hit.lambda * stadiumHitBoost
    const hrCurrentCount = Number(entry.hrSoFar || 0)
    const hitCurrentCount = Number(entry.hitsSoFar || 0)
    const hrLine = 0.5 + hrCurrentCount
    const hitLine = 0.5 + hitCurrentCount
    const hrPricing = priceCountPropLine(hrLambda, hrLine, {
      varianceMultiplier: stadiumModifiers.varianceMultiplier,
      marketVolume: playerProps?.marketVolume?.[`hr_prop::${label}`],
      liabilityCap: playerProps?.liabilityCap,
      settledCount: hrCurrentCount,
    })
    const hitPricing = priceCountPropLine(hitLambda, hitLine, {
      varianceMultiplier: stadiumModifiers.varianceMultiplier,
      marketVolume: playerProps?.marketVolume?.[`hit_prop::${label}`],
      liabilityCap: playerProps?.liabilityCap,
      settledCount: hitCurrentCount,
    })

    rows.push({
      game_id: game.id,
      bet_type: 'hr_prop',
      target_entity: label,
      line: hrLine,
      prop_current_count: hrCurrentCount,
      prop_lambda: Number(hrLambda.toFixed(3)),
      prop_variance_multiplier: stadiumModifiers.varianceMultiplier,
      odds_over: hrPricing.oddsOver,
      odds_under: hrPricing.oddsUnder,
      predicted_probability: Number(hrPricing.probabilityOver.toFixed(4)),
      is_locked: hrPricing.isSuspended,
      updated_at: new Date().toISOString(),
    })

    rows.push({
      game_id: game.id,
      bet_type: 'hit_prop',
      target_entity: label,
      line: hitLine,
      prop_current_count: hitCurrentCount,
      prop_lambda: Number(hitLambda.toFixed(3)),
      prop_variance_multiplier: stadiumModifiers.varianceMultiplier,
      odds_over: hitPricing.oddsOver,
      odds_under: hitPricing.oddsUnder,
      predicted_probability: Number(hitPricing.probabilityOver.toFixed(4)),
      is_locked: hitPricing.isSuspended,
      updated_at: new Date().toISOString(),
    })
  })

  ;[homePitcher, awayPitcher].filter(Boolean).forEach((entry) => {
    const label = getEntityLabel(entry)
    const sources = buildPlayerPropSources(entry, playerHistorical[label] || playerHistorical[entry.id] || {}, entry, liveState)
    const kCurrentCount = Number(sources.strikeouts.settledCount || entry.kSoFar || 0)
    const kPricing = priceCountPropLine(sources.strikeouts.lambda, sources.strikeouts.line, {
      varianceMultiplier: stadiumModifiers.varianceMultiplier,
      marketVolume: playerProps?.marketVolume?.[`k_prop::${label}`],
      liabilityCap: playerProps?.liabilityCap,
      settledCount: kCurrentCount,
    })

    rows.push({
      game_id: game.id,
      bet_type: 'k_prop',
      target_entity: label,
      line: sources.strikeouts.line,
      prop_current_count: kCurrentCount,
      prop_lambda: Number(sources.strikeouts.lambda.toFixed(3)),
      prop_variance_multiplier: stadiumModifiers.varianceMultiplier,
      odds_over: kPricing.oddsOver,
      odds_under: kPricing.oddsUnder,
      predicted_probability: Number(kPricing.probabilityOver.toFixed(4)),
      is_locked: kPricing.isSuspended,
      updated_at: new Date().toISOString(),
    })
  })

  return rows.sort((a, b) => {
    const typeOrder = BET_TYPE_ORDER.indexOf(a.bet_type) - BET_TYPE_ORDER.indexOf(b.bet_type)
    if (typeOrder !== 0) return typeOrder
    return String(a.target_entity || '').localeCompare(String(b.target_entity || ''))
  })
}

export function recalculateOdds(currentOdds = [], gameState = {}, pa = {}) {
  const changedRows = []
  const runsScored = Number(pa.rbi || 0) + (pa.run_scored ? 1 : 0)
  const battingSide = gameState.battingSide || (gameState.isTop ? 'away' : 'home')

  const liveMarketState = gameState.oddsContext && gameState.liveState
    ? estimateLiveMarketState({
      game: gameState.oddsContext.game,
      homeRoster: gameState.oddsContext.homeRoster || [],
      awayRoster: gameState.oddsContext.awayRoster || [],
      homeHistorical: gameState.oddsContext.homeHistorical || {},
      awayHistorical: gameState.oddsContext.awayHistorical || {},
      playerProps: gameState.oddsContext.playerProps || {},
      state: gameState.liveState,
    })
    : null

  currentOdds.forEach((row) => {
    let nextRow = null

    if (row.bet_type === 'moneyline') {
      let nextProbability = null

      if (liveMarketState) {
        nextProbability = liveMarketState.winProbability
      } else if (runsScored > 0) {
        const shift = Number(gameState.runsThisHalf || 0) >= 3 ? 0.12 : 0.03
        const currentProbability = Number(row.predicted_probability || 0.5)
        const signedShift = battingSide === 'home' ? shift : -shift
        nextProbability = clamp(currentProbability + signedShift, MIN_PROBABILITY, MAX_PROBABILITY)
      }

      if (nextProbability != null) {
        const pricing = priceTwoSidedMarket(nextProbability, gameState.oddsContext?.playerProps, 'moneyline', null, 'home', 'away')
        nextRow = {
          ...row,
          odds_home: pricing.oddsA,
          odds_away: pricing.oddsB,
          predicted_probability: Number(pricing.probabilityA.toFixed(4)),
          is_locked: pricing.isSuspended,
          updated_at: new Date().toISOString(),
        }
      }
    }

    if (row.bet_type === 'run_line' && liveMarketState && row.line != null && !row.is_locked) {
      const homeIsFav = liveMarketState.winProbability >= 0.5
      const favWinProb = homeIsFav ? liveMarketState.winProbability : 1 - liveMarketState.winProbability
      const coverTilt = (favWinProb - 0.5) * 0.25
      const projectedMargin = Math.abs(liveMarketState.expectedMargin)
      const favCoverProb = Number(row.line) <= 0.5
        ? favWinProb
        : clamp(
          probabilityFromProjectionGap(projectedMargin - Number(row.line), liveMarketState.marginVariance, coverTilt),
          MIN_PROBABILITY,
          MAX_PROBABILITY,
        )
      const dogCoverProb = clamp(1 - favCoverProb, MIN_PROBABILITY, MAX_PROBABILITY)
      const homeCoverProb = homeIsFav ? favCoverProb : dogCoverProb
      const pricing = priceTwoSidedMarket(homeCoverProb, gameState.oddsContext?.playerProps, 'run_line', null, 'home', 'away')

      nextRow = {
        ...row,
        odds_home: pricing.oddsA,
        odds_away: pricing.oddsB,
        predicted_probability: Number(pricing.probabilityA.toFixed(4)),
        is_locked: pricing.isSuspended,
        updated_at: new Date().toISOString(),
      }
    }

    if (row.bet_type === 'over_under' && liveMarketState && row.line != null && liveMarketState.projectedTotal != null && !row.is_locked) {
      const overProbability = clamp(
        probabilityFromProjectionGap(liveMarketState.projectedTotal - Number(row.line), liveMarketState.totalVariance),
        MIN_PROBABILITY,
        MAX_PROBABILITY,
      )
      const pricing = priceTwoSidedMarket(overProbability, gameState.oddsContext?.playerProps, 'over_under', null, 'over', 'under')

      nextRow = {
        ...row,
        odds_over: pricing.oddsA,
        odds_under: pricing.oddsB,
        predicted_probability: Number(pricing.probabilityA.toFixed(4)),
        is_locked: pricing.isSuspended,
        updated_at: new Date().toISOString(),
      }
    }

    // PART H — first-inning props lock for NEW bets once inning 1's window has
    // closed (i.e. inning 2+ has begun), not after the game's very first PA.
    if (row.bet_type === 'first_inning_run' && !row.is_locked && Number(gameState.liveState?.currentInning ?? gameState.currentInning ?? 1) >= 2) {
      nextRow = { ...row, is_locked: true, updated_at: new Date().toISOString() }
    }

    if (nextRow && JSON.stringify(nextRow) !== JSON.stringify(row)) {
      changedRows.push(nextRow)
    }
  })

  if (gameState.generationContext) {
    const regenerated = generateGameOdds(
      gameState.generationContext.game,
      gameState.generationContext.homeRoster,
      gameState.generationContext.awayRoster,
      gameState.generationContext.homeHistorical,
      gameState.generationContext.awayHistorical,
      gameState.generationContext.playerProps,
      gameState.generationContext.weights,
    )

    if (gameState.pitcherSwap) {
      // PART H — a pitcher who's been pulled can't add more strikeouts, so lock
      // their now-stale k_prop market for new bets (their existing bets still
      // settle against the final total).
      const regeneratedKPropEntities = new Set(regenerated.filter((row) => row.bet_type === 'k_prop').map((row) => row.target_entity))
      currentOdds
        .filter((row) => row.bet_type === 'k_prop' && !row.is_locked && !regeneratedKPropEntities.has(row.target_entity))
        .forEach((row) => {
          changedRows.push({ ...row, is_locked: true, updated_at: new Date().toISOString() })
        })
    }

    regenerated
      .filter((row) => row.bet_type === 'hr_prop' || row.bet_type === 'hit_prop' || row.bet_type === 'k_prop')
      .forEach((row) => {
        const existing = currentOdds.find((entry) => compareRows(entry, row))
        if (!existing) {
          changedRows.push(row)
          return
        }

        const merged = { ...existing, ...row, id: existing.id }
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          changedRows.push(merged)
        }
      })
  }

  return changedRows
}

export function computeBrierScore(predictions = []) {
  if (!predictions.length) return 0
  const total = predictions.reduce((sum, entry) => {
    const probability = Number(entry.predictedProb ?? entry.predicted_probability ?? 0)
    const outcome = Number(entry.actualOutcome ?? entry.actual_outcome ?? 0)
    return sum + Math.pow(probability - outcome, 2)
  }, 0)

  return total / predictions.length
}

export function adjustWeights(currentWeights = {}, sourceBrierScores = {}) {
  const weights = buildWeights(currentWeights)
  const sources = ['char', 'historical', 'live']
  const scores = {
    char: Number(sourceBrierScores.char ?? sourceBrierScores.char_stats ?? 0),
    historical: Number(sourceBrierScores.historical ?? 0),
    live: Number(sourceBrierScores.live ?? 0),
  }

  const ranked = [...sources].sort((a, b) => scores[a] - scores[b])
  const best = ranked[0]
  const worst = ranked[ranked.length - 1]

  if (scores[best] === scores[worst]) {
    return {
      char_stats_weight: Number(weights.char.toFixed(4)),
      historical_weight: Number(weights.historical.toFixed(4)),
      live_weight: Number(weights.live.toFixed(4)),
    }
  }

  const next = { ...weights }
  const transfer = Math.min(0.03, next[worst] - 0.15, 0.6 - next[best])
  next[worst] -= transfer
  next[best] += transfer

  sources.forEach((key) => {
    next[key] = clamp(next[key], 0.15, 0.6)
  })

  const total = next.char + next.historical + next.live
  next.char /= total
  next.historical /= total
  next.live = 1 - next.char - next.historical

  return {
    char_stats_weight: Number(next.char.toFixed(4)),
    historical_weight: Number(next.historical.toFixed(4)),
    live_weight: Number(next.live.toFixed(4)),
  }
}

export function buildBettingEntityLabel(character, player) {
  if (!character && !player) return 'Unknown'
  if (!player?.name) return character?.name || 'Unknown'
  if (!character?.name) return player.name
  return `${character.name} (${player.name})`
}
