import { percentileOfValue } from './statsCalculator'

// Single source of truth for what shows up in the Savant-style percentile snapshot row.
// `family: 'talent'` metrics come from analyzeCharacterTalent (ratings-based, always available).
// `family: 'performance'` metrics come from actual league-wide plate-appearance data and may be
// null for characters with no batted-ball sample yet.
export const SNAPSHOT_METRICS = [
  { key: 'power', label: 'Power', family: 'talent', digits: 0 },
  { key: 'contact', label: 'Contact', family: 'talent', digits: 0 },
  { key: 'velocity', label: 'Velocity', family: 'talent', digits: 0 },
  { key: 'fielding', label: 'Fielding', family: 'talent', digits: 0 },
  { key: 'speed', label: 'Speed', family: 'talent', digits: 0 },
  { key: 'exitVelo', label: 'Avg Exit Velo', family: 'performance', digits: 1, suffix: ' mph' },
  { key: 'barrelRate', label: 'Barrel %', family: 'performance', digits: 1, suffix: '%' },
  { key: 'hardHitRate', label: 'Hard-Hit %', family: 'performance', digits: 1, suffix: '%' },
  { key: 'whiffRate', label: 'Whiff %', family: 'performance', digits: 1, suffix: '%', invert: true },
  { key: 'kRate', label: 'K %', family: 'performance', digits: 1, suffix: '%', invert: true },
  { key: 'bbRate', label: 'BB %', family: 'performance', digits: 1, suffix: '%' },
]

function pickPercentile(value, allValues, invert) {
  return { value, percentile: percentileOfValue(value, allValues, { invert }) }
}

// Talent-family percentiles: this character's rating-derived metrics vs every other character in
// the game. Reads each character's REAL, performance-adjusted analysis from
// `analysesByCharacterId` (built once in useCharacterExtras from real game/pitching/fielding
// history) rather than recomputing a zero-history version here — otherwise this row's numbers
// can silently disagree with the Overview bars below for what's supposed to be the same stat.
export function buildTalentPercentiles(character, analysesByCharacterId = {}) {
  const analyses = Object.values(analysesByCharacterId).filter(Boolean)
  if (analyses.length < 2) return {}

  const thisAnalysis = analysesByCharacterId[character.id]
  if (!thisAnalysis) return {}

  const valuesFor = (fn) => analyses.map(fn).filter(Number.isFinite)

  const metrics = {
    power: (a) => a?.rawMetrics?.batting?.power,
    contact: (a) => a?.rawMetrics?.batting?.contact,
    velocity: (a) => a?.rawMetrics?.pitching?.velocity,
    fielding: (a) => a?.rawMetrics?.fielding?.fielding,
    speed: (a) => a?.displayRatings?.speed,
  }

  const result = {}
  Object.entries(metrics).forEach(([key, fn]) => {
    result[key] = pickPercentile(fn(thisAnalysis), valuesFor(fn), false)
  })
  return result
}

// Performance-family percentiles: this character's actual batted-ball/plate-discipline rates vs
// every other character in the league-wide index (built once in useCharacterExtras).
export function buildPerformancePercentiles(character, leaguePerformanceByCharacterId = {}) {
  const own = leaguePerformanceByCharacterId[character.id]
  if (!own) return {}

  const invertSet = new Set(['whiffRate', 'kRate'])
  const metricKeys = ['exitVelo', 'barrelRate', 'hardHitRate', 'whiffRate', 'kRate', 'bbRate']

  const result = {}
  metricKeys.forEach((key) => {
    const allValues = Object.values(leaguePerformanceByCharacterId)
      .map((perf) => perf?.[key])
      .filter(Number.isFinite)
    result[key] = pickPercentile(own[key], allValues, invertSet.has(key))
  })
  return result
}
