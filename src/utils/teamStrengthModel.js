// Turns rosters, recorded history and the park into the per-plate-appearance
// outcome probabilities that `gameStateModel.js` runs forward.
//
// The split this module enforces:
//
//   LEVEL comes from data. `solveLeagueHalfInningRate` finds the runs-per-half-
//   inning that makes the game model reproduce the competition's own observed
//   average game total, so nothing about the scoring level is a guess.
//
//   SHAPE comes from data too. `buildLeagueOutcomeShape` reads the relative
//   frequency of walks, singles, doubles, triples and home runs straight out of
//   the recorded plate appearances.
//
//   DEPARTURES from the league average come from ratings, one park term, and
//   ONE human-player term. That last point is the fix for the old engine, which
//   fed the same "this side is better" evidence through a character source, a
//   historical head-to-head source, a hand-assigned skill-tier source and a
//   share-of-runs bias, then blended all four as if they were independent.
//
// What is NOT claimed here: that the human-player term is identified separately
// from roster strength. It is not — a player's recorded results are produced by
// the characters they drafted, and this archive is far too small to separate
// the two. The player term is therefore a single, hard-shrunk, capped offset
// whose prior mean is the hand-assigned tier, and it is reported in the
// diagnostics so its size is visible rather than buried in a blend.

import {
  calibrateOutcomeProbabilities,
  buildGameDistribution,
  createHalfInningCache,
  DEFAULT_ADVANCE_PARAMS,
} from './gameStateModel.js'
import { isCreditedHit } from './creditedHit.js'
import { getPlayerSkillProfile } from './teamIdentity.js'
import { DEFAULT_REGULATION_INNINGS, normalizeRegulationInnings } from './gameRules.js'

// Priors, not measurements. Each one is named, has a stated meaning, and is
// exposed through `MODEL_PRIORS` so the evaluation harness can refit or
// sensitivity-test it. None of them is described anywhere as "calibrated".
export const MODEL_PRIORS = Object.freeze({
  // Elasticity of a team's run rate to a one-standard-rating-step (5 points on
  // the 0-10 scale) edge in lineup batting / opposing pitching, in log space.
  // Prior only: this repo has no fitted rating-to-runs regression.
  battingElasticity: 0.35,
  pitchingElasticity: 0.30,
  // Elasticity of a batter's own hit rate and home-run share to their rating.
  batterHitElasticity: 0.30,
  batterPowerElasticity: 0.55,
  pitcherStrikeoutElasticity: 0.45,
  // Shrinkage strengths, in units of the exposure being measured.
  teamScoringPriorGames: 8,
  playerEffectPriorGames: 12,
  batterHitPriorPlateAppearances: 60,
  batterPowerPriorPlateAppearances: 150,
  pitcherStrikeoutPriorBattersFaced: 60,
  parkPriorGames: 6,
  // Hard cap on the single human-player log offset, both directions.
  playerEffectCap: 0.22,
  // Fallback league scoring when a competition has no completed games at all.
  fallbackRunsPerHalfInning: 1.15,
  // Fallback league outcome shape when no plate appearances are on record.
  fallbackShape: Object.freeze({ walk: 0.09, single: 0.52, double: 0.22, triple: 0.03, homeRun: 0.14 }),
  fallbackStrikeoutRatePerPlateAppearance: 0.14,
})

const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const WALK_RESULTS = new Set(['BB', 'IBB', 'HBP'])

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

// ── League level and shape, both read from recorded facts ────────────────────

export function buildLeagueOutcomeShape(completedPAs = []) {
  const counts = { walk: 0, single: 0, double: 0, triple: 0, homeRun: 0 }
  let strikeouts = 0
  let plateAppearances = 0

  ;(completedPAs || []).forEach((pa) => {
    const result = pa?.result
    if (!result) return
    plateAppearances += 1
    if (result === 'K') strikeouts += 1
    if (WALK_RESULTS.has(result)) { counts.walk += 1; return }
    if (!isCreditedHit(pa)) return
    if (result === '1B') counts.single += 1
    else if (result === '2B') counts.double += 1
    else if (result === '3B') counts.triple += 1
    else if (result === 'HR' || result === 'IPHR') counts.homeRun += 1
  })

  const observed = counts.walk + counts.single + counts.double + counts.triple + counts.homeRun
  if (plateAppearances < 40 || observed < 20) {
    return {
      shape: { ...MODEL_PRIORS.fallbackShape },
      strikeoutRate: MODEL_PRIORS.fallbackStrikeoutRatePerPlateAppearance,
      plateAppearances,
      source: 'prior',
    }
  }

  return {
    shape: {
      walk: counts.walk / observed,
      single: counts.single / observed,
      double: counts.double / observed,
      triple: counts.triple / observed,
      homeRun: counts.homeRun / observed,
    },
    strikeoutRate: strikeouts / plateAppearances,
    plateAppearances,
    source: 'observed',
  }
}

export function summarizeCompletedGameScoring(completedGames = [], regulationInnings = DEFAULT_REGULATION_INNINGS) {
  const scored = (completedGames || [])
    .filter((game) => game?.team_a_runs != null && game?.team_b_runs != null)
    .map((game) => ({
      total: safeNumber(game.team_a_runs) + safeNumber(game.team_b_runs),
      innings: normalizeRegulationInnings(
        game.final_inning ?? game.current_inning ?? game.innings ?? regulationInnings,
        normalizeRegulationInnings(regulationInnings, DEFAULT_REGULATION_INNINGS),
      ),
    }))
  if (!scored.length) return { meanTotal: null, sampleSize: 0, meanInnings: normalizeRegulationInnings(regulationInnings, DEFAULT_REGULATION_INNINGS) }
  const meanTotal = scored.reduce((sum, entry) => sum + entry.total, 0) / scored.length
  const meanInnings = scored.reduce((sum, entry) => sum + entry.innings, 0) / scored.length
  return { meanTotal, sampleSize: scored.length, meanInnings }
}

const leagueRateCache = new Map()

// Finds the per-half-inning run rate that makes the FULL game model — including
// the half the leading home team never bats and the mercy rule — produce the
// observed average game total. Solving it through the model rather than by
// dividing runs by innings is what removes the old engine's hardcoded
// BASELINE_RUNS = 4.9, which was a nine-inning number being applied to
// three-inning games and inflated every park's scoring factor by roughly 40%.
export function solveLeagueHalfInningRate({
  meanTotal,
  regulationInnings = DEFAULT_REGULATION_INNINGS,
  mercyEnabled = true,
  mercyDifferential = 10,
  shape = MODEL_PRIORS.fallbackShape,
  advanceParams = DEFAULT_ADVANCE_PARAMS,
  tolerance = 1e-4,
  maxIterations = 30,
} = {}) {
  const innings = normalizeRegulationInnings(regulationInnings, DEFAULT_REGULATION_INNINGS)
  if (meanTotal == null || !(Number(meanTotal) > 0)) {
    return { rate: MODEL_PRIORS.fallbackRunsPerHalfInning, source: 'prior', iterations: 0, achievedTotal: null }
  }
  const key = [
    Number(meanTotal).toFixed(4), innings, mercyEnabled ? 1 : 0, mercyDifferential,
    shape.walk.toFixed(5), shape.single.toFixed(5), shape.double.toFixed(5),
    shape.triple.toFixed(5), shape.homeRun.toFixed(5),
    Number(advanceParams.runnerScoresFromSecondOnSingle || 0).toFixed(4),
    Number(advanceParams.runnerScoresFromFirstOnDouble || 0).toFixed(4),
  ].join('|')
  const cached = leagueRateCache.get(key)
  if (cached) return cached

  const target = Number(meanTotal)
  const evaluate = (rate) => {
    const probs = calibrateOutcomeProbabilities({ shape, targetRunsPerHalfInning: rate, advanceParams }).probabilities
    const distribution = buildGameDistribution({
      awayOutcomeProbs: probs,
      homeOutcomeProbs: probs,
      regulationInnings: innings,
      mercyEnabled,
      mercyDifferential,
      advanceParams,
      cache: createHalfInningCache(),
    })
    let expectedTotal = 0
    for (let i = 0; i < distribution.totalDistribution.length; i += 1) {
      expectedTotal += i * distribution.totalDistribution[i]
    }
    return expectedTotal
  }

  let low = 0.05
  let high = 8
  let iterations = 0
  let rate = (low + high) / 2
  let achieved = evaluate(rate)
  while (iterations < maxIterations && high - low > tolerance) {
    if (achieved > target) high = rate
    else low = rate
    rate = (low + high) / 2
    achieved = evaluate(rate)
    iterations += 1
  }

  const result = { rate, source: 'solved', iterations, achievedTotal: achieved }
  leagueRateCache.set(key, result)
  return result
}

// ── Team-level inputs ────────────────────────────────────────────────────────

function averageRating(entries, keys, fallback = 5) {
  const values = (entries || [])
    .map((entry) => {
      for (const key of keys) {
        const value = Number(entry?.[key])
        if (Number.isFinite(value)) return value
      }
      return null
    })
    .filter((value) => value != null)
  if (!values.length) return fallback
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function summarizeLineup(roster = [], activePitcher = null) {
  const batters = (roster || []).filter(Boolean)
  return {
    battingRating: averageRating(batters, ['batting', 'bat'], 5),
    fieldingRating: averageRating(batters, ['fielding', 'field'], 5),
    // The pitcher who is actually on the mound decides how the opposing lineup
    // scores; the roster's average pitching rating does not.
    pitchingRating: activePitcher
      ? averageRating([activePitcher], ['pitching', 'pitch'], averageRating(batters, ['pitching', 'pitch'], 5))
      : averageRating(batters, ['pitching', 'pitch'], 5),
    size: batters.length,
    hasActivePitcher: Boolean(activePitcher),
  }
}

// The single human-player term. Prior mean is the hand-assigned skill tier
// (recentered so an average player contributes nothing); the evidence is the
// player's own recorded scoring relative to the league, weighted by how many
// completed games they actually have.
export function buildPlayerEffect({
  playerHistory = null,
  playerName = null,
  leagueHalfInningRate,
  priorGames = MODEL_PRIORS.playerEffectPriorGames,
  cap = MODEL_PRIORS.playerEffectCap,
} = {}) {
  const tier = getPlayerSkillProfile(playerName || playerHistory?.playerName || '')
  const tierScore = clamp(Number(tier?.skillScore ?? 0.4), 0, 1)
  // Recentred so 0.5 (an unranked player) is neutral, and scaled to at most
  // half the hard cap so the prior can never dominate the evidence.
  const priorOffset = clamp((tierScore - 0.5) * (cap / 0.5) * 0.5, -cap / 2, cap / 2)

  const games = Math.max(0, safeNumber(playerHistory?.gamesPlayed, 0))
  const halfInnings = Math.max(0, safeNumber(playerHistory?.halfInningsBatted, 0))
  const runs = Math.max(0, safeNumber(playerHistory?.runsScored, 0))
  const observedRate = halfInnings > 0 ? runs / halfInnings : null
  const weight = games > 0 ? games / (games + priorGames) : 0
  const evidenceOffset = observedRate != null && leagueHalfInningRate > 0
    ? clamp(Math.log(Math.max(observedRate, 0.01) / leagueHalfInningRate), -1, 1)
    : 0

  const offset = clamp((weight * evidenceOffset) + ((1 - weight) * priorOffset), -cap, cap)
  return {
    offset,
    priorOffset,
    evidenceOffset,
    weight,
    gamesPlayed: games,
    identified: false,
    note: 'Player effect is not identified separately from roster strength at this sample size.',
  }
}

/**
 * The per-plate-appearance outcome probabilities for both sides of one game.
 *
 * A league-average matchup at a neutral park lands exactly on the league rate,
 * so every number in `diagnostics` is a departure from that anchor and can be
 * read off individually.
 */
export function buildMatchupOutcomeModel({
  homeLineup,
  awayLineup,
  homePlayerEffect = { offset: 0 },
  awayPlayerEffect = { offset: 0 },
  leagueHalfInningRate,
  leagueShape,
  parkScoringFactor = 1,
  parkHomeRunFactor = 1,
  priors = MODEL_PRIORS,
  advanceParams = DEFAULT_ADVANCE_PARAMS,
} = {}) {
  const shape = leagueShape || MODEL_PRIORS.fallbackShape
  const scoring = clamp(safeNumber(parkScoringFactor, 1), 0.5, 2)
  const hrFactor = clamp(safeNumber(parkHomeRunFactor, 1), 0.4, 2.5)

  // Park home-run factor reshapes the mix; park scoring factor sets the level.
  // They are separate signals and are applied once each.
  const parkShape = { ...shape, homeRun: shape.homeRun * hrFactor }

  const logRate = (offenseRating, opposingPitchRating, playerOffset) => (
    Math.log(leagueHalfInningRate)
    + (priors.battingElasticity * ((offenseRating - 5) / 5))
    - (priors.pitchingElasticity * ((opposingPitchRating - 5) / 5))
    + playerOffset
    + Math.log(scoring)
  )

  const homeRate = Math.exp(logRate(homeLineup.battingRating, awayLineup.pitchingRating, safeNumber(homePlayerEffect.offset, 0)))
  const awayRate = Math.exp(logRate(awayLineup.battingRating, homeLineup.pitchingRating, safeNumber(awayPlayerEffect.offset, 0)))

  const homeCal = calibrateOutcomeProbabilities({ shape: parkShape, targetRunsPerHalfInning: homeRate, advanceParams })
  const awayCal = calibrateOutcomeProbabilities({ shape: parkShape, targetRunsPerHalfInning: awayRate, advanceParams })

  return {
    homeOutcomeProbs: homeCal.probabilities,
    awayOutcomeProbs: awayCal.probabilities,
    diagnostics: {
      leagueHalfInningRate,
      parkScoringFactor: scoring,
      parkHomeRunFactor: hrFactor,
      homeRunsPerHalfInning: homeRate,
      awayRunsPerHalfInning: awayRate,
      homeOnBaseRate: homeCal.onBaseRate,
      awayOnBaseRate: awayCal.onBaseRate,
      homeCalibrationConverged: homeCal.converged,
      awayCalibrationConverged: awayCal.converged,
      homePlayerEffect,
      awayPlayerEffect,
      shapeSource: leagueShape ? 'observed-or-supplied' : 'prior',
    },
  }
}

// ── Shrunk per-player rates for the prop markets ─────────────────────────────

export function shrinkRate({ successes, exposure, priorRate, priorExposure }) {
  const n = Math.max(0, safeNumber(exposure, 0))
  const k = Math.max(1e-9, safeNumber(priorExposure, 1))
  const s = Math.max(0, safeNumber(successes, 0))
  const prior = clamp(safeNumber(priorRate, 0), 0, 1)
  return {
    rate: (s + (k * prior)) / (n + k),
    weight: n / (n + k),
    exposure: n,
    priorRate: prior,
  }
}

/**
 * A batter's per-plate-appearance hit rate and home-run share.
 *
 * Home runs are modelled as a SHARE OF HITS, never as an independent rate. That
 * is what makes P(at least k home runs) <= P(at least k hits) true by
 * construction instead of by luck, which the old engine's two independent
 * Poisson lambdas could not guarantee.
 */
export function buildBatterRates({
  batter = {},
  history = {},
  teamOutcomeProbs,
  parkHomeRunFactor = 1,
  priors = MODEL_PRIORS,
} = {}) {
  const teamHitRate = safeNumber(teamOutcomeProbs?.single, 0)
    + safeNumber(teamOutcomeProbs?.double, 0)
    + safeNumber(teamOutcomeProbs?.triple, 0)
    + safeNumber(teamOutcomeProbs?.homeRun, 0)
  const teamHrShare = teamHitRate > 0 ? safeNumber(teamOutcomeProbs?.homeRun, 0) / teamHitRate : 0

  const rating = clamp(safeNumber(batter.batting ?? batter.bat, 5), 0, 10)
  const ratingHitPrior = clamp(teamHitRate * Math.exp(priors.batterHitElasticity * ((rating - 5) / 5)), 0.01, 0.85)
  const ratingPowerPrior = clamp(
    teamHrShare * Math.exp(priors.batterPowerElasticity * ((rating - 5) / 5)) * clamp(safeNumber(parkHomeRunFactor, 1), 0.4, 2.5),
    0.001,
    0.95,
  )

  const observedPAs = Math.max(0, safeNumber(history.plateAppearances, 0))
  const observedHits = Math.max(0, safeNumber(history.hits, 0))
  const observedHRs = Math.max(0, safeNumber(history.homeRuns, 0))

  const hit = shrinkRate({
    successes: observedHits,
    exposure: observedPAs,
    priorRate: ratingHitPrior,
    priorExposure: priors.batterHitPriorPlateAppearances,
  })
  const power = shrinkRate({
    successes: observedHRs,
    exposure: observedHits,
    priorRate: ratingPowerPrior,
    priorExposure: priors.batterPowerPriorPlateAppearances * ratingHitPrior,
  })

  const hitRate = clamp(hit.rate, 0.005, 0.9)
  const homeRunShare = clamp(power.rate, 0, 1)
  return {
    hitRate,
    homeRunShare,
    homeRunRate: hitRate * homeRunShare,
    hitEvidenceWeight: hit.weight,
    powerEvidenceWeight: power.weight,
    plateAppearances: observedPAs,
    priors: { ratingHitPrior, ratingPowerPrior },
  }
}

/**
 * A pitcher's strikeouts per BATTER FACED.
 *
 * Batters faced is the exposure a strikeout total is actually generated over.
 * The old engine used strikeouts per INNING, whose denominator (outs / 3) both
 * excludes every batter who reached base and moves with the defence behind the
 * pitcher.
 */
export function buildPitcherRates({
  pitcher = {},
  history = {},
  leagueStrikeoutRate,
  priors = MODEL_PRIORS,
} = {}) {
  const league = clamp(safeNumber(leagueStrikeoutRate, priors.fallbackStrikeoutRatePerPlateAppearance), 0.01, 0.6)
  const rating = clamp(safeNumber(pitcher.pitching ?? pitcher.pitch, 5), 0, 10)
  const ratingPrior = clamp(league * Math.exp(priors.pitcherStrikeoutElasticity * ((rating - 5) / 5)), 0.01, 0.7)

  const battersFaced = Math.max(0, safeNumber(history.battersFaced, 0))
  const strikeouts = Math.max(0, safeNumber(history.strikeouts, 0))
  const shrunk = shrinkRate({
    successes: strikeouts,
    exposure: battersFaced,
    priorRate: ratingPrior,
    priorExposure: priors.pitcherStrikeoutPriorBattersFaced,
  })

  return {
    strikeoutRate: clamp(shrunk.rate, 0.005, 0.75),
    evidenceWeight: shrunk.weight,
    battersFaced,
    priors: { ratingPrior, leagueStrikeoutRate: league },
  }
}
