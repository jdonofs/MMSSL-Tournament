const BASE_LF = 330
const BASE_CF = 400
const BASE_RF = 330
export const BASELINE_RUNS = 4.9

export function calcStadiumModifiers(stadium, isNight) {
  if (!stadium) return { hrFactor: 1, scoringFactor: 1, varianceMultiplier: 1 }

  const lfRatio = BASE_LF / Number(stadium.lf_distance || BASE_LF)
  const cfRatio = BASE_CF / Number(stadium.cf_distance || BASE_CF)
  const rfRatio = BASE_RF / Number(stadium.rf_distance || BASE_RF)
  const distanceHRFactor = (lfRatio * 0.35) + (cfRatio * 0.3) + (rfRatio * 0.35)

  const gimmickHRModifier = getGimmickHRModifier(stadium.name, isNight)
  const gimmickScoringModifier = getGimmickScoringModifier(stadium.name, isNight)

  return {
    hrFactor: distanceHRFactor * gimmickHRModifier,
    scoringFactor: gimmickScoringModifier,
    varianceMultiplier: 1 + (Number(stadium.chaos_level || 0) * 0.08),
  }
}

function getGimmickHRModifier(name, isNight) {
  const modifiers = {
    'Mario Stadium': { day: 1, night: 1 },
    'Peach Ice Garden': { day: 0.92, night: 0.92 },
    'DK Jungle': { day: 0.88, night: 0.88 },
    'Wario City': { day: 1.05, night: 1.05 },
    'Yoshi Park': { day: 1.08, night: 1.18 },
    'Bowser Jr. Playroom': { day: 0.72, night: 0.72 },
    'Daisy Cruiser': { day: 1.05, night: 1.12 },
    "Luigi's Mansion": { day: 1, night: 1.05 },
    'Bowser Castle': { day: 1, night: 0.88 },
  }
  const modifier = modifiers[name]
  if (!modifier) return 1
  return isNight ? modifier.night : modifier.day
}

function getGimmickScoringModifier(name, isNight) {
  const modifiers = {
    'Mario Stadium': { day: 1, night: 1 },
    'Peach Ice Garden': { day: 1.05, night: 1.12 },
    'DK Jungle': { day: 0.92, night: 0.93 },
    'Wario City': { day: 1.22, night: 1.22 },
    'Yoshi Park': { day: 1.15, night: 1.25 },
    'Bowser Jr. Playroom': { day: 0.83, night: 0.83 },
    'Daisy Cruiser': { day: 1.24, night: 1.32 },
    "Luigi's Mansion": { day: 1, night: 1.14 },
    'Bowser Castle': { day: 1, night: 1.04 },
  }
  const modifier = modifiers[name]
  if (!modifier) return 1
  return isNight ? modifier.night : modifier.day
}

export function calcConfidenceWeight(stadiumGameLog = []) {
  const gameCount = stadiumGameLog.length
  const avgConfidence = gameCount === 0
    ? 0
    : stadiumGameLog.reduce((sum, game) => sum + Number(game.confidence || 0), 0) / gameCount

  const historicalWeight =
    gameCount === 0 ? 0 :
    gameCount <= 2 ? 0.25 :
    gameCount <= 4 ? 0.5 : 0.75

  return {
    historicalWeight,
    formulaWeight: 1 - historicalWeight,
    avgConfidence,
  }
}

export function blendModifiers(formulaModifiers, historicalModifiers, weights) {
  const { historicalWeight, formulaWeight } = weights
  return {
    hrFactor: (formulaModifiers.hrFactor * formulaWeight) + (historicalModifiers.hrFactor * historicalWeight),
    scoringFactor: (formulaModifiers.scoringFactor * formulaWeight) + (historicalModifiers.scoringFactor * historicalWeight),
    varianceMultiplier: (formulaModifiers.varianceMultiplier * formulaWeight) + (historicalModifiers.varianceMultiplier * historicalWeight),
  }
}

export function buildAppliedStadiumModel(stadium, isNight, stadiumGameLog = []) {
  const formulaModifiers = calcStadiumModifiers(stadium, isNight)
  const historicalAvgRuns = stadiumGameLog.length
    ? stadiumGameLog.reduce((sum, game) => sum + Number(game.total_runs || 0), 0) / stadiumGameLog.length
    : BASELINE_RUNS

  const historicalModifiers = {
    hrFactor: formulaModifiers.hrFactor,
    scoringFactor: historicalAvgRuns / BASELINE_RUNS,
    varianceMultiplier: formulaModifiers.varianceMultiplier,
  }

  const weights = calcConfidenceWeight(stadiumGameLog)
  const finalModifiers = blendModifiers(formulaModifiers, historicalModifiers, weights)

  return {
    formulaModifiers,
    historicalModifiers,
    historicalAvgRuns,
    weights,
    finalModifiers,
  }
}
