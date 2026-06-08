import { getPlayerSkillProfile } from './teamIdentity'
import { buildAppliedStadiumModel } from './stadiumOdds'

const MIN_PROBABILITY = 0.07
const MAX_PROBABILITY = 0.97
const MAX_UNDERDOG_ODDS = 900
const MAX_FAVORITE_ODDS = -900

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
  const baseline = liveState.inning >= 6 ? 1.5 : liveState.inning >= 4 ? 2.5 : 3.5
  const alreadySeen = Number(entry.paSoFar ?? 0)
  return clamp(baseline - alreadySeen * 0.65, 1, 5)
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
  return `${row.bet_type}::${row.target_entity || 'game'}::${row.line ?? 'nil'}`
}

export function mergeOddsWithExistingRows(rows = [], existingRows = []) {
  const existingByKey = Object.fromEntries(existingRows.map((entry) => [buildOddsRowKey(entry), entry]))
  return rows.map((row) => {
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
  const historyReliability = clamp(Number(headToHead.gamesPlayed || 0) / 8, 0, 1)
  const skillWeight = Math.max(0.35, 0.65 - historyReliability * 0.25)
  const historyWeight = 0.2 + historyReliability * 0.35
  const charWeight = Math.max(0.15, 1 - skillWeight - historyWeight)

  const char = logistic(charEdge * (1.8 + charWeight))
  const historical = logistic(historicalEdge * (1.4 + historyWeight))
  const skill = logistic(normalizedSkillDiff * (1.35 + skillWeight * 0.6))
  const live = logistic((liveState.scoreDiff * 0.32) + ((liveState.inning - 1) * 0.08))

  return {
    char,
    historical,
    live,
    skill,
    weights: {
      char: charWeight,
      historical: historyWeight,
      skill: skillWeight,
      live: liveState.inning > 1 || liveState.scoreDiff !== 0 ? 0.1 : 0,
    },
  }
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
  const blendedTotal = historySample < 5
    ? estimatedTotal
    : (historicalWeight * Number(historicalTotals.average || 0)) + (charWeight * estimatedTotal) + skillAdjustment
  const adjustedTotal = Math.max(0.5, blendedTotal * scoringFactor)
  const totalScale = adjustedTotal / Math.max(0.5, estimatedTotal)

  let projectedHomeRuns = baseHomeRuns * totalScale
  let projectedAwayRuns = baseAwayRuns * totalScale

  const historyReliability = clamp(Number(headToHead.gamesPlayed || 0) / 8, 0, 1)
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
  const completedInnings = clamp(inning - 1, 0, 9)

  if (currentTotalRuns > 0 || inning > 1) {
    const remainingFactor = clamp((9 - completedInnings) / 9, 0, 1)
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

  return {
    char: clamp(logistic(charEdge * 1.4), MIN_PROBABILITY, MAX_PROBABILITY),
    historical: clamp(logistic(historicalEdge * 1.6), MIN_PROBABILITY, MAX_PROBABILITY),
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
  const historyReliability = clamp(Math.max(historical.plateAppearances, historical.gamesPlayed) / 24, 0, 1)
  const historyWeight = clamp(0.18 + historyReliability * 0.37, 0.18, 0.55)
  const skillWeight = Math.max(0.22, 0.4 - historyReliability * 0.18)
  const charWeight = Math.max(0.18, 1 - historyWeight - skillWeight)
  const liveWeight = liveState.inning > 1 || Number(entry.paSoFar || 0) > 0 ? 0.12 : 0.05

  const hrPerPA = clamp(
    (character.bat * 0.036 * charWeight) +
      (historical.hrRate * 1.08 * historyWeight) +
      (hitterSkill * 0.068 * skillWeight) -
      ((pitcher.pitch * pitcherSkill) * 0.014),
    0.012,
    0.32,
  )
  const hitPerPA = clamp(
    (character.bat * 0.19 * charWeight) +
      (character.speed * 0.06 * charWeight) +
      (historical.hitRate * 0.82 * historyWeight) +
      (hitterSkill * 0.16 * skillWeight) -
      ((pitcher.pitch * pitcherSkill) * 0.05),
    0.08,
    0.78,
  )
  const liveSkillPressure = Math.max(0, liveState.inning - 1) * 0.015
  const kPerInning = clamp(
    (pitcher.pitch * 0.52 * charWeight) +
      (historical.strikeoutsPerInning * 0.55 * historyWeight) +
      (pitcherSkill * 0.38 * skillWeight) -
      (character.bat * hitterSkill * 0.16),
    0.2,
    2.4,
  )
  const projectedInningsRemaining = clamp(3.5 - Math.max(0, liveState.inning - 1) * 0.45, 1, 4.5)

  return {
    hr: {
      char: clamp(1 - Math.pow(1 - clamp((character.bat * 0.036) + (hitterSkill * 0.03), 0.015, 0.24), expectedPAs), MIN_PROBABILITY, MAX_PROBABILITY),
      historical: clamp(1 - Math.pow(1 - clamp(historical.hrRate * (1 + hitterSkill * 0.35), 0.015, 0.28), expectedPAs), MIN_PROBABILITY, MAX_PROBABILITY),
      live: clamp(1 - Math.pow(1 - hrPerPA, Math.max(expectedPAs - (entry.paSoFar || 0), 1)) + liveWeight * 0.04, MIN_PROBABILITY, MAX_PROBABILITY),
    },
    hit: {
      char: clamp(1 - Math.pow(1 - clamp((character.bat * 0.17) + (character.speed * 0.04) + (hitterSkill * 0.09), 0.1, 0.58), expectedPAs), MIN_PROBABILITY, MAX_PROBABILITY),
      historical: clamp(1 - Math.pow(1 - clamp(historical.hitRate * (0.95 + hitterSkill * 0.25), 0.1, 0.68), expectedPAs), MIN_PROBABILITY, MAX_PROBABILITY),
      live: clamp(1 - Math.pow(1 - hitPerPA, Math.max(expectedPAs - (entry.paSoFar || 0), 1)) + liveWeight * 0.03, MIN_PROBABILITY, MAX_PROBABILITY),
    },
    strikeouts: {
      line: roundToHalf(clamp((historical.strikeoutsPerGame * historyWeight) + (kPerInning * projectedInningsRemaining) + liveSkillPressure, 0.5, 8.5)),
      char: clamp(logistic((character.pitch + hitterSkill - character.bat) * 0.8), MIN_PROBABILITY, MAX_PROBABILITY),
      historical: clamp(logistic((historical.strikeoutsPerInning * 1.35) - 0.6), MIN_PROBABILITY, MAX_PROBABILITY),
      live: clamp(logistic((kPerInning - 0.9) + liveSkillPressure), MIN_PROBABILITY, MAX_PROBABILITY),
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

// Standard sportsbook vig: each side priced ~2.3% above fair value → ~4.6% total overround
const STANDARD_JUICE = 0.023

export function americanOddsFromProbability(probability, juice = STANDARD_JUICE) {
  const fairProbability = clamp(Number(probability || 0) + Number(juice || 0), MIN_PROBABILITY, MAX_PROBABILITY)
  let odds

  if (fairProbability >= 0.5) {
    odds = Math.round(-((fairProbability / (1 - fairProbability)) * 100))
  } else {
    odds = Math.round(((1 - fairProbability) / fairProbability) * 100)
  }

  return clamp(odds, MAX_FAVORITE_ODDS, MAX_UNDERDOG_ODDS)
}

export function calculatePayout(wagerSips, americanOdds) {
  const stake = Number(wagerSips || 0)
  const odds = Number(americanOdds || 0)
  if (!stake || !odds) return 0

  const raw = odds > 0 ? (odds / 100) * stake : (100 / Math.abs(odds)) * stake
  return Math.round(raw * 10) / 10
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

  rows.push({
    game_id: game.id,
    bet_type: 'moneyline',
    target_entity: null,
    line: null,
    odds_home: americanOddsFromProbability(moneylineProbability),
    odds_away: americanOddsFromProbability(1 - moneylineProbability),
    predicted_probability: Number(moneylineProbability.toFixed(4)),
    is_locked: false,
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
  const fairSpread = projectedMargin + ((coverTilt * marginStdDev) / 3)
  const defaultSpread = roundToNearestHook(fairSpread, 0.5)
  const baseCoverProb = probabilityFromProjectionGap(
    projectedMargin - defaultSpread,
    marginStdDev,
    coverTilt,
  )
  const favCoverProb = applyVarianceToProbability(
    baseCoverProb,
    stadiumModifiers.varianceMultiplier,
  )
  const dogCoverProb = clamp(1 - favCoverProb, MIN_PROBABILITY, MAX_PROBABILITY)

  rows.push({
    game_id: game.id,
    bet_type: 'run_line',
    target_entity: null,
    line: defaultSpread,
    odds_home: homeIsFav ? americanOddsFromProbability(favCoverProb) : americanOddsFromProbability(dogCoverProb),
    odds_away: homeIsFav ? americanOddsFromProbability(dogCoverProb) : americanOddsFromProbability(favCoverProb),
    predicted_probability: Number((homeIsFav ? favCoverProb : dogCoverProb).toFixed(4)),
    is_locked: false,
    updated_at: new Date().toISOString(),
  })

  const totalRunSources = scoreProjection
  const totalLine = roundToHook(totalRunSources.line, 0.5)
  const totalStdDev = Math.max(1, Number(totalRunSources.historicalTotals?.stdDev || 2.5))
  const overProbability = applyVarianceToProbability(
    probabilityFromProjectionGap(totalRunSources.line - totalLine, totalStdDev),
    stadiumModifiers.varianceMultiplier,
  )

  rows.push({
    game_id: game.id,
    bet_type: 'over_under',
    target_entity: null,
    line: totalLine,
    odds_over: americanOddsFromProbability(overProbability),
    odds_under: americanOddsFromProbability(1 - overProbability),
    predicted_probability: Number(overProbability.toFixed(4)),
    is_locked: false,
    updated_at: new Date().toISOString(),
  })

  const firstInningProbability = applyVarianceToProbability(
    blendSources(
      buildFirstInningSources(homeRoster, awayRoster, homeHistorical, awayHistorical, liveState),
      normalizedWeights,
    ),
    stadiumModifiers.varianceMultiplier,
  )

  rows.push({
    game_id: game.id,
    bet_type: 'first_inning_run',
    target_entity: null,
    line: 0.5,
    odds_yes: americanOddsFromProbability(firstInningProbability),
    odds_no: americanOddsFromProbability(1 - firstInningProbability),
    predicted_probability: Number(firstInningProbability.toFixed(4)),
    is_locked: false,
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
    const hrProbability = applyVarianceToProbability(
      clamp(blendSources(sources.hr, normalizedWeights) * stadiumHrBoost, MIN_PROBABILITY, MAX_PROBABILITY),
      stadiumModifiers.varianceMultiplier,
    )
    const hitProbability = applyVarianceToProbability(
      clamp(blendSources(sources.hit, normalizedWeights) * stadiumHitBoost, MIN_PROBABILITY, MAX_PROBABILITY),
      stadiumModifiers.varianceMultiplier,
    )

    rows.push({
      game_id: game.id,
      bet_type: 'hr_prop',
      target_entity: label,
      line: 0.5,
      odds_yes: americanOddsFromProbability(hrProbability),
      odds_no: americanOddsFromProbability(1 - hrProbability),
      predicted_probability: Number(hrProbability.toFixed(4)),
      is_locked: false,
      updated_at: new Date().toISOString(),
    })

    rows.push({
      game_id: game.id,
      bet_type: 'hit_prop',
      target_entity: label,
      line: 0.5,
      odds_yes: americanOddsFromProbability(hitProbability),
      odds_no: americanOddsFromProbability(1 - hitProbability),
      predicted_probability: Number(hitProbability.toFixed(4)),
      is_locked: false,
      updated_at: new Date().toISOString(),
    })
  })

  awayRoster.forEach((entry) => {
    const label = getEntityLabel(entry)
    const sources = buildPlayerPropSources(entry, playerHistorical[label] || playerHistorical[entry.id] || {}, homePitcher, liveState)
    const hrProbability = applyVarianceToProbability(
      clamp(blendSources(sources.hr, normalizedWeights) * stadiumHrBoost, MIN_PROBABILITY, MAX_PROBABILITY),
      stadiumModifiers.varianceMultiplier,
    )
    const hitProbability = applyVarianceToProbability(
      clamp(blendSources(sources.hit, normalizedWeights) * stadiumHitBoost, MIN_PROBABILITY, MAX_PROBABILITY),
      stadiumModifiers.varianceMultiplier,
    )

    rows.push({
      game_id: game.id,
      bet_type: 'hr_prop',
      target_entity: label,
      line: 0.5,
      odds_yes: americanOddsFromProbability(hrProbability),
      odds_no: americanOddsFromProbability(1 - hrProbability),
      predicted_probability: Number(hrProbability.toFixed(4)),
      is_locked: false,
      updated_at: new Date().toISOString(),
    })

    rows.push({
      game_id: game.id,
      bet_type: 'hit_prop',
      target_entity: label,
      line: 0.5,
      odds_yes: americanOddsFromProbability(hitProbability),
      odds_no: americanOddsFromProbability(1 - hitProbability),
      predicted_probability: Number(hitProbability.toFixed(4)),
      is_locked: false,
      updated_at: new Date().toISOString(),
    })
  })

  ;[homePitcher, awayPitcher].filter(Boolean).forEach((entry) => {
    const label = getEntityLabel(entry)
    const sources = buildPlayerPropSources(entry, playerHistorical[label] || playerHistorical[entry.id] || {}, entry, liveState)
    const strikeoutProbability = applyVarianceToProbability(
      blendSources(sources.strikeouts, normalizedWeights),
      stadiumModifiers.varianceMultiplier,
    )

    rows.push({
      game_id: game.id,
      bet_type: 'k_prop',
      target_entity: label,
      line: sources.strikeouts.line,
      odds_over: americanOddsFromProbability(strikeoutProbability),
      odds_under: americanOddsFromProbability(1 - strikeoutProbability),
      predicted_probability: Number(strikeoutProbability.toFixed(4)),
      is_locked: false,
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

  currentOdds.forEach((row) => {
    let nextRow = null

    if (row.bet_type === 'moneyline' && runsScored > 0) {
      const shift = Number(gameState.runsThisHalf || 0) >= 3 ? 0.12 : 0.03
      const currentProbability = Number(row.predicted_probability || 0.5)
      const signedShift = battingSide === 'home' ? shift : -shift
      const nextProbability = clamp(currentProbability + signedShift, MIN_PROBABILITY, MAX_PROBABILITY)
      nextRow = {
        ...row,
        odds_home: americanOddsFromProbability(nextProbability),
        odds_away: americanOddsFromProbability(1 - nextProbability),
        predicted_probability: Number(nextProbability.toFixed(4)),
        updated_at: new Date().toISOString(),
      }
    }

    if (row.bet_type === 'first_inning_run' && Number(pa.pa_number || gameState.paCount || 0) >= 1) {
      nextRow = { ...row, is_locked: true, updated_at: new Date().toISOString() }
    }

    if ((row.bet_type === 'hr_prop' || row.bet_type === 'hit_prop') && row.target_entity && gameState.lockedEntities?.includes(row.target_entity)) {
      nextRow = { ...row, is_locked: true, updated_at: new Date().toISOString() }
    }

    if (nextRow && JSON.stringify(nextRow) !== JSON.stringify(row)) {
      changedRows.push(nextRow)
    }
  })

  if (gameState.pitcherSwap && gameState.generationContext) {
    const regenerated = generateGameOdds(
      gameState.generationContext.game,
      gameState.generationContext.homeRoster,
      gameState.generationContext.awayRoster,
      gameState.generationContext.homeHistorical,
      gameState.generationContext.awayHistorical,
      gameState.generationContext.playerProps,
      gameState.generationContext.weights,
    )

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
