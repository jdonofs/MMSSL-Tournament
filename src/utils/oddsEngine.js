// The betting board's pricing entry point.
//
// One implementation serves both writers — the tracker bridge
// (`scripts/tracker_betting_sync.mjs`) and the browser (`BettingTab`) — and
// every market on it is read out of a single game model, so equivalent markets
// cannot disagree and alternate lines cannot be non-monotonic.
//
// Layering:
//
//   gameStateModel.js     the game itself: base-out chain, half-inning DP,
//                         joint (away runs, home runs) distribution
//   teamStrengthModel.js  rosters + recorded history + park -> per-PA outcomes
//   propModel.js          remaining opportunities -> player count distributions
//   oddsPricing.js        fair -> exposure -> margin -> display -> availability
//   this file             assembles the board and diffs it against what is stored
//
// `ODDS_MODEL_VERSIONS.legacy` routes everything back to `oddsEngineLegacy.js`
// unchanged; see `oddsModelConfig.js`.

import { buildAppliedStadiumModel } from './stadiumOdds.js'
import { DEFAULT_REGULATION_INNINGS, DEFAULT_MERCY_RULE_DIFFERENTIAL, normalizeRegulationInnings, normalizeMercyRuleDifferential } from './gameRules.js'
import { ODDS_MODEL_VERSIONS, resolveOddsModelVersion, isLegacyModel } from './oddsModelConfig.js'
import {
  buildGameDistribution,
  createHalfInningCache,
  marginProbabilities,
  totalProbabilities,
  firstInningRunProbability,
  remainingPlateAppearanceDistribution,
  DEFAULT_ADVANCE_PARAMS,
} from './gameStateModel.js'
import {
  MODEL_PRIORS,
  buildLeagueOutcomeShape,
  summarizeCompletedGameScoring,
  solveLeagueHalfInningRate,
  summarizeLineup,
  buildPlayerEffect,
  buildMatchupOutcomeModel,
  buildBatterRates,
  buildPitcherRates,
} from './teamStrengthModel.js'
import {
  batterPlateAppearanceDistribution,
  buildCountDistribution,
  countLineProbabilities,
  pickBalancedCountLine,
  buildBattingOrder,
} from './propModel.js'
import {
  DEFAULT_HOUSE_POLICY,
  MARKET_AVAILABILITY,
  MARGIN_METHODS,
  TARGET_OVERROUND,
  MAX_VOLUME_SHIFT,
  MIN_MARKET_LIQUIDITY,
  DEFAULT_LIABILITY_CAP,
  MIN_PROBABILITY,
  MAX_PROBABILITY,
  applyVig,
  applyMargin,
  applyExposureAdjustment,
  normalizeTwoWayFair,
  oddsFromVigProbability,
  americanOddsFromProbability,
  quoteTwoWayMarket,
  measureMarginCurve,
  decideAvailability,
  assertNoArbitrage,
  calculatePayout,
  impliedProbabilityFromAmericanOdds,
  clampProbability,
  roundOddsMagnitude,
} from './oddsPricing.js'
import * as legacy from './oddsEngineLegacy.js'

export {
  ODDS_MODEL_VERSIONS,
  resolveOddsModelVersion,
  MODEL_PRIORS,
  MARKET_AVAILABILITY,
  MARGIN_METHODS,
  DEFAULT_HOUSE_POLICY,
  TARGET_OVERROUND,
  MAX_VOLUME_SHIFT,
  MIN_MARKET_LIQUIDITY,
  DEFAULT_LIABILITY_CAP,
  applyVig,
  applyMargin,
  applyExposureAdjustment,
  normalizeTwoWayFair,
  oddsFromVigProbability,
  americanOddsFromProbability,
  quoteTwoWayMarket,
  measureMarginCurve,
  assertNoArbitrage,
  calculatePayout,
  impliedProbabilityFromAmericanOdds,
}
export { setOddsModelVersion } from './oddsModelConfig.js'
export const computeRunLineCoverProb = legacy.computeRunLineCoverProb

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

const MAX_PROP_COUNT = 12

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
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
    // A regenerated row prices the market from scratch, so its `is_locked` only
    // ever reflects the current pricing suspension. A lock already stored on the
    // market means something else: no new tickets — the first-inning window
    // closed, the pitcher was pulled, the game finished, or the board was locked
    // by hand. Letting regeneration clear it reopened a market whose outcome was
    // already known. Locks are cleared deliberately, never as a side effect of
    // repricing.
    const merged = existing?.id != null
      ? { ...row, id: existing.id, is_locked: Boolean(row.is_locked) || Boolean(existing.is_locked) }
      : row
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

export function buildBettingEntityLabel(character, player) {
  if (!character && !player) return 'Unknown'
  if (!player?.name) return character?.name || 'Unknown'
  if (!character?.name) return player.name
  return `${character.name} (${player.name})`
}

// ── Live state resolution ────────────────────────────────────────────────────

// Runners reach this code either as a bitmask (`baseState`) or, from older
// callers, only as a count. A count is turned into the lowest-leverage mask
// consistent with it, which is stated rather than hidden: one runner is placed
// on first, two on first and second, three loads the bases.
function baseStateFromCount(count) {
  const occupied = clamp(Math.trunc(safeNumber(count, 0)), 0, 3)
  if (occupied <= 0) return 0
  if (occupied === 1) return 1
  if (occupied === 2) return 3
  return 7
}

export function resolveLiveState({ game = {}, playerProps = {}, liveState = null } = {}) {
  const explicit = liveState || playerProps.liveState || null
  const raw = game?.live_state && typeof game.live_state === 'object' ? game.live_state : {}
  const gameState = playerProps.gameState || {}
  const status = explicit?.status
    || (game?.status === 'complete' ? 'complete' : game?.status === 'pending' || game?.status === 'scheduled' ? 'pending' : game?.status ? 'active' : 'pending')

  const regulationInnings = normalizeRegulationInnings(
    explicit?.regulationInnings ?? playerProps.totalInnings ?? game?.innings,
    DEFAULT_REGULATION_INNINGS,
  )
  const awayScore = safeNumber(explicit?.awayScore ?? game?.team_a_runs ?? gameState.awayRuns, 0)
  const homeScore = safeNumber(explicit?.homeScore ?? game?.team_b_runs ?? gameState.homeRuns, 0)
  const currentInning = Math.max(1, Math.trunc(safeNumber(
    explicit?.currentInning ?? raw.inning ?? game?.current_inning ?? gameState.inning,
    1,
  )))
  const isTop = explicit?.isTop != null
    ? Boolean(explicit.isTop)
    : Boolean(raw.isTop ?? raw.is_top ?? game?.is_top_inning ?? true)
  const outs = clamp(Math.trunc(safeNumber(explicit?.outsInHalf ?? raw.outsInHalf ?? raw.outs_in_half ?? game?.outs_in_half, 0)), 0, 2)

  let baseState = explicit?.baseState
  if (baseState == null && raw.runners && typeof raw.runners === 'object') {
    baseState = (raw.runners.first ? 1 : 0) | (raw.runners.second ? 2 : 0) | (raw.runners.third ? 4 : 0)
  }
  if (baseState == null) baseState = baseStateFromCount(explicit?.runnersOccupied)

  const paCount = Math.max(0, Math.trunc(safeNumber(explicit?.paCount ?? gameState.paCount ?? playerProps.paCount, 0)))
  const gameStarted = status === 'active' || currentInning > 1 || paCount > 0 || awayScore > 0 || homeScore > 0

  return {
    status,
    gameComplete: status === 'complete',
    regulationInnings,
    mercyEnabled: playerProps.mercyRule !== false,
    mercyDifferential: normalizeMercyRuleDifferential(
      playerProps.mercyRuleDifferential ?? game?.mercy_rule_differential,
      DEFAULT_MERCY_RULE_DIFFERENTIAL,
    ),
    awayScore,
    homeScore,
    currentInning: gameStarted ? currentInning : 1,
    isTop: gameStarted ? isTop : true,
    outs: gameStarted ? outs : 0,
    baseState: gameStarted ? (baseState & 7) : 0,
    paCount,
    gameStarted,
    // Betting always grades team B as home. A game flagged `home_away_swapped`
    // has team B batting in the TOP of every inning, so the betting home side
    // does not get last licks; the model has to know that or it credits a
    // walk-off to the wrong team.
    homeBatsSecond: !game?.home_away_swapped,
    firstInningRunsRecorded: Math.max(0, safeNumber(
      explicit?.firstInningRunsRecorded ?? gameState.firstInningRunsRecorded,
      0,
    )),
    firstInningComplete: Boolean(
      explicit?.firstInningComplete
      ?? gameState.firstInningComplete
      ?? (currentInning > 1 && gameStarted),
    ),
  }
}

// ── The shared market book ───────────────────────────────────────────────────

function historicalCounts(entry = {}) {
  const plateAppearances = Math.max(0, safeNumber(entry.plateAppearances, 0))
  const hits = entry.hits != null
    ? Math.max(0, safeNumber(entry.hits, 0))
    : Math.max(0, safeNumber(entry.hitRate ?? entry.avg, 0) * plateAppearances)
  const homeRuns = entry.homeRuns != null
    ? Math.max(0, safeNumber(entry.homeRuns, 0))
    : Math.max(0, safeNumber(entry.hrRate, 0) * plateAppearances)
  return {
    plateAppearances,
    hits: Math.min(hits, plateAppearances || hits),
    homeRuns: Math.min(homeRuns, hits || homeRuns),
  }
}

function pitcherHistoricalCounts(entry = {}) {
  const strikeouts = Math.max(0, safeNumber(entry.strikeouts, NaN))
  const battersFaced = Math.max(0, safeNumber(entry.battersFaced, NaN))
  if (Number.isFinite(strikeouts) && Number.isFinite(battersFaced) && battersFaced > 0) {
    return { strikeouts, battersFaced }
  }
  // Older context shapes only carry strikeouts per inning. Convert with the
  // batters-faced-per-inning the league actually runs at rather than pretending
  // an inning is an exposure.
  const perInning = Math.max(0, safeNumber(entry.strikeoutsPerInning, 0))
  const innings = Math.max(0, safeNumber(entry.inningsPitched, 0))
  if (innings > 0) {
    const faced = innings * safeNumber(entry.battersFacedPerInning, 4.3)
    return { strikeouts: perInning * innings, battersFaced: faced }
  }
  return { strikeouts: 0, battersFaced: 0 }
}

function findActivePitcher(roster = [], pitcherId = null) {
  return roster.find((entry) => String(entry.id) === String(pitcherId))
    || roster.find((entry) => entry.isActivePitcher)
    || roster.find((entry) => entry.isPitcher)
    || null
}

function getEntityLabel(entry = {}) {
  return entry.targetEntity || entry.entityLabel || entry.label || entry.name || 'Unknown'
}

function marketVolumeFor(playerProps, betType, targetEntity, sideA, sideB) {
  const key = `${betType}::${targetEntity || 'game'}`
  const stats = playerProps?.marketVolume?.[key] || {}
  const a = stats[sideA] || {}
  const b = stats[sideB] || {}
  return {
    moneyA: a.money,
    moneyB: b.money,
    liabilityA: a.liability,
    liabilityB: b.liability,
    liabilityCap: playerProps?.liabilityCap,
  }
}

function housePolicy(playerProps = {}) {
  return {
    ...DEFAULT_HOUSE_POLICY,
    ...(playerProps.housePolicy || {}),
    ...(playerProps.liabilityCap != null ? { liabilityCap: Number(playerProps.liabilityCap) } : {}),
  }
}

/**
 * Everything the board needs for one game, from one distribution.
 *
 * The returned object is deterministic: identical inputs give identical output,
 * including the alternate-line arrays. There is no sampling anywhere in it.
 */
export function buildGameMarketBook({
  game = {},
  homeRoster = [],
  awayRoster = [],
  homeHistorical = {},
  awayHistorical = {},
  playerProps = {},
  liveState = null,
  advanceParams = DEFAULT_ADVANCE_PARAMS,
  priors = MODEL_PRIORS,
} = {}) {
  const startedAt = Date.now()
  const state = resolveLiveState({ game, playerProps, liveState })
  const cache = createHalfInningCache()

  // League level and shape, read from what the competition has actually
  // recorded rather than from a hardcoded baseline.
  const supplied = playerProps.leagueModel || {}
  const shapeSummary = supplied.shape
    ? { shape: supplied.shape, strikeoutRate: supplied.strikeoutRate ?? priors.fallbackStrikeoutRatePerPlateAppearance, plateAppearances: supplied.plateAppearances ?? 0, source: supplied.shapeSource || 'supplied' }
    : buildLeagueOutcomeShape(playerProps.completedPlateAppearances || [])
  const scoringSummary = supplied.meanTotal != null
    ? { meanTotal: supplied.meanTotal, sampleSize: supplied.sampleSize ?? 0 }
    : {
      meanTotal: safeNumber(playerProps.historicalTotals?.average, 0) > 0
        ? Number(playerProps.historicalTotals.average)
        : null,
      sampleSize: Math.max(0, safeNumber(playerProps.historicalTotals?.sampleSize, 0)),
    }

  const stadiumModel = playerProps.stadiumModel || buildAppliedStadiumModel(
    playerProps.stadium,
    playerProps.isNight,
    playerProps.stadiumGameLog || [],
    { leagueMeanRuns: scoringSummary.meanTotal, priorGames: priors.parkPriorGames },
  )
  const park = stadiumModel.finalModifiers

  const leagueRate = solveLeagueHalfInningRate({
    meanTotal: scoringSummary.meanTotal,
    regulationInnings: state.regulationInnings,
    mercyEnabled: state.mercyEnabled,
    mercyDifferential: state.mercyDifferential,
    shape: shapeSummary.shape,
    advanceParams,
  })

  const homePitcher = findActivePitcher(homeRoster, playerProps.gameState?.homePitcherId)
  const awayPitcher = findActivePitcher(awayRoster, playerProps.gameState?.awayPitcherId)
  const homeLineup = summarizeLineup(homeRoster, homePitcher)
  const awayLineup = summarizeLineup(awayRoster, awayPitcher)

  const homePlayerEffect = buildPlayerEffect({
    playerHistory: homeHistorical,
    playerName: homeHistorical.playerName || homeRoster[0]?.playerName,
    leagueHalfInningRate: leagueRate.rate,
    priorGames: priors.playerEffectPriorGames,
    cap: priors.playerEffectCap,
  })
  const awayPlayerEffect = buildPlayerEffect({
    playerHistory: awayHistorical,
    playerName: awayHistorical.playerName || awayRoster[0]?.playerName,
    leagueHalfInningRate: leagueRate.rate,
    priorGames: priors.playerEffectPriorGames,
    cap: priors.playerEffectCap,
  })

  const outcomeModel = buildMatchupOutcomeModel({
    homeLineup,
    awayLineup,
    homePlayerEffect,
    awayPlayerEffect,
    leagueHalfInningRate: leagueRate.rate,
    leagueShape: shapeSummary.shape,
    parkScoringFactor: park.scoringFactor,
    parkHomeRunFactor: park.hrFactor,
    priors,
    advanceParams,
  })

  const distribution = buildGameDistribution({
    awayOutcomeProbs: outcomeModel.awayOutcomeProbs,
    homeOutcomeProbs: outcomeModel.homeOutcomeProbs,
    regulationInnings: state.regulationInnings,
    mercyEnabled: state.mercyEnabled,
    mercyDifferential: state.mercyDifferential,
    currentInning: state.currentInning,
    isTopHalf: state.isTop,
    outs: state.outs,
    baseState: state.baseState,
    awayScore: state.awayScore,
    homeScore: state.homeScore,
    homeBatsSecond: state.homeBatsSecond,
    gameComplete: state.gameComplete,
    advanceParams,
    cache,
  })

  // Remaining plate appearances per side, from the same chain.
  const homeRemainingPAs = state.gameComplete
    ? new Float64Array(1).fill(1)
    : remainingPlateAppearanceDistribution({
      outcomeProbs: outcomeModel.homeOutcomeProbs,
      distribution,
      side: 'home',
      advanceParams,
      cache,
      baseState: state.baseState,
      outs: state.outs,
    })
  const awayRemainingPAs = state.gameComplete
    ? new Float64Array(1).fill(1)
    : remainingPlateAppearanceDistribution({
      outcomeProbs: outcomeModel.awayOutcomeProbs,
      distribution,
      side: 'away',
      advanceParams,
      cache,
      baseState: state.baseState,
      outs: state.outs,
    })

  const expectedRemaining = (dist) => {
    let mean = 0
    for (let i = 0; i < dist.length; i += 1) mean += i * dist[i]
    return mean
  }

  const moneylineFair = {
    sideA: distribution.homeWinProbability,
    sideB: distribution.awayWinProbability,
    push: distribution.tieProbability,
    unresolved: distribution.unresolvedMass,
  }

  const runLineAt = (spread) => {
    const { over, push, under } = marginProbabilities(distribution, spread)
    return { sideA: over, sideB: under, push, unresolved: distribution.unresolvedMass }
  }
  const totalAt = (line) => {
    const { over, push, under } = totalProbabilities(distribution, line)
    return { sideA: over, sideB: under, push, unresolved: distribution.unresolvedMass }
  }

  const firstInning = firstInningRunProbability(distribution, {
    recordedFirstInningRuns: state.firstInningRunsRecorded,
    inningOneComplete: state.firstInningComplete || state.currentInning > 1,
  })

  return {
    version: ODDS_MODEL_VERSIONS.gameModel,
    state,
    distribution,
    outcomeModel,
    stadiumModel,
    homeLineup,
    awayLineup,
    homePitcher,
    awayPitcher,
    league: {
      halfInningRate: leagueRate.rate,
      rateSource: leagueRate.source,
      meanTotal: scoringSummary.meanTotal,
      completedGames: scoringSummary.sampleSize,
      shape: shapeSummary.shape,
      shapeSource: shapeSummary.source,
      strikeoutRate: shapeSummary.strikeoutRate,
      shapePlateAppearances: shapeSummary.plateAppearances,
    },
    remainingPlateAppearances: {
      home: homeRemainingPAs,
      away: awayRemainingPAs,
      homeExpected: expectedRemaining(homeRemainingPAs),
      awayExpected: expectedRemaining(awayRemainingPAs),
    },
    markets: {
      moneyline: moneylineFair,
      runLineAt,
      totalAt,
      firstInning,
    },
    diagnostics: {
      ...outcomeModel.diagnostics,
      unresolvedMass: distribution.unresolvedMass,
      truncationMass: distribution.truncationMass,
      resolvedMass: distribution.resolvedMass,
      halfInningCacheSize: cache.size,
      runtimeMs: Date.now() - startedAt,
    },
  }
}

// ── Line selection ───────────────────────────────────────────────────────────

// The default hook: the half-run spread whose home-cover probability is closest
// to even money. Half-run hooks cannot push, which is why the board uses them.
export function pickRunLineSpread(book, { maxSpread = 12.5 } = {}) {
  let best = null
  for (let spread = 0.5; spread <= maxSpread; spread += 1) {
    for (const candidate of [spread, -spread]) {
      const fair = book.markets.runLineAt(candidate)
      const decisive = fair.sideA + fair.sideB
      if (decisive <= 0) continue
      const distance = Math.abs((fair.sideA / decisive) - 0.5)
      if (!best || distance < best.distance - 1e-9) best = { spread: candidate, distance }
    }
  }
  return best ? best.spread : 0.5
}

export function pickTotalLine(book, { currentTotal = 0, maxLine = 60 } = {}) {
  // A total already below the runs on the board is unofferable, not a price.
  const minimum = Math.max(0.5, Math.floor(safeNumber(currentTotal, 0)) + 0.5)
  let best = null
  for (let line = minimum; line <= maxLine; line += 1) {
    const fair = book.markets.totalAt(line)
    const decisive = fair.sideA + fair.sideB
    if (decisive <= 0) continue
    const distance = Math.abs((fair.sideA / decisive) - 0.5)
    if (!best || distance < best.distance - 1e-9) best = { line, distance }
  }
  return best ? best.line : minimum
}

// Alternate lines, all read from the same distribution, so they are monotone by
// construction. `available` is false for a line whose outcome is already
// settled by the runs on the board.
export function buildAlternateRunLines(book, { spreads = null, playerProps = {}, exposureKey = 'run_line' } = {}) {
  const policy = housePolicy(playerProps)
  const candidates = spreads || defaultSpreadLadder(book)
  return candidates.map((spread) => {
    const fair = book.markets.runLineAt(spread)
    const decisive = fair.sideA + fair.sideB
    const quote = quoteTwoWayMarket({
      fair,
      exposure: marketVolumeFor(playerProps, exposureKey, null, 'home', 'away'),
      policy,
      availability: {
        gameComplete: book.state.gameComplete,
        determined: decisive > 0 && (fair.sideA / decisive >= 1 - 1e-9 || fair.sideA / decisive <= 1e-9),
      },
      label: `run_line ${spread}`,
    })
    return { spread, fair, quote }
  })
}

export function buildAlternateTotals(book, { lines = null, playerProps = {}, currentTotal = 0 } = {}) {
  const policy = housePolicy(playerProps)
  const candidates = lines || defaultTotalLadder(book, currentTotal)
  return candidates.map((line) => {
    const fair = book.markets.totalAt(line)
    const decisive = fair.sideA + fair.sideB
    const quote = quoteTwoWayMarket({
      fair,
      exposure: marketVolumeFor(playerProps, 'over_under', null, 'over', 'under'),
      policy,
      availability: {
        gameComplete: book.state.gameComplete,
        determined: decisive > 0 && (fair.sideA / decisive >= 1 - 1e-9 || fair.sideA / decisive <= 1e-9),
      },
      label: `over_under ${line}`,
    })
    return { line, fair, quote }
  })
}

function defaultSpreadLadder(book) {
  const centre = pickRunLineSpread(book)
  const values = []
  for (let step = -5; step <= 5; step += 1) values.push(centre + step)
  return values.filter((value) => Math.abs(value % 1) === 0.5)
}

function defaultTotalLadder(book, currentTotal = 0) {
  const centre = pickTotalLine(book, { currentTotal })
  const minimum = Math.max(0.5, Math.floor(safeNumber(currentTotal, 0)) + 0.5)
  const values = []
  for (let step = -6; step <= 6; step += 1) {
    const line = centre + step
    if (line >= minimum) values.push(line)
  }
  return values
}

// ── Player props ─────────────────────────────────────────────────────────────

function buildPropDistributions(book, playerProps = {}, priors = MODEL_PRIORS) {
  const historicalByEntity = playerProps.historicalByEntity || {}
  const battingOrders = playerProps.battingOrder || {}
  const result = { batters: [], pitchers: [] }

  const forSide = (roster, side) => {
    const outcomeProbs = side === 'home' ? book.outcomeModel.homeOutcomeProbs : book.outcomeModel.awayOutcomeProbs
    const teamDist = side === 'home' ? book.remainingPlateAppearances.home : book.remainingPlateAppearances.away
    const order = battingOrders[side] || buildBattingOrder({ roster, gamePAs: [], playerId: null })

    roster.forEach((entry) => {
      const label = getEntityLabel(entry)
      const history = historicalByEntity[label] || historicalByEntity[entry.id] || {}
      const rates = buildBatterRates({
        batter: entry,
        history: historicalCounts(history),
        teamOutcomeProbs: outcomeProbs,
        parkHomeRunFactor: book.stadiumModel.finalModifiers.hrFactor,
        priors,
      })
      const slots = order.slotsUntilNextTurn?.[String(entry.id)]
      const { distribution: opportunities, truncatedMass } = batterPlateAppearanceDistribution({
        teamPlateAppearanceDistribution: teamDist,
        slotsUntilNextTurn: slots == null ? Math.max(0, order.lineupSize - 1) : slots,
        lineupSize: order.lineupSize,
      })
      const remainingMass = 1 - (opportunities[0] || 0)

      const hits = buildCountDistribution({
        recorded: Math.max(0, safeNumber(entry.hitsSoFar, 0)),
        opportunityDistribution: opportunities,
        perOpportunityRate: rates.hitRate,
        maxCount: MAX_PROP_COUNT,
      })
      const homeRuns = buildCountDistribution({
        recorded: Math.max(0, safeNumber(entry.hrSoFar, 0)),
        opportunityDistribution: opportunities,
        perOpportunityRate: rates.homeRunRate,
        maxCount: MAX_PROP_COUNT,
      })

      result.batters.push({
        side,
        entry,
        label,
        rates,
        opportunities,
        opportunityTruncatedMass: truncatedMass,
        remainingOpportunityMass: remainingMass,
        slotsUntilNextTurn: slots ?? null,
        lineupSize: order.lineupSize,
        orderSource: order.source,
        hits,
        homeRuns,
      })
    })
  }

  forSide(book.homeRoster || playerProps.homeRoster || [], 'home')
  forSide(book.awayRoster || playerProps.awayRoster || [], 'away')

  return result
}

function buildPitcherProp(book, { pitcher, side, playerProps, priors }) {
  if (!pitcher) return null
  const label = getEntityLabel(pitcher)
  const history = (playerProps.historicalByEntity || {})[label] || {}
  const rates = buildPitcherRates({
    pitcher,
    history: pitcherHistoricalCounts(history),
    leagueStrikeoutRate: book.league.strikeoutRate,
    priors,
  })
  // A pitcher's exposure is the batters the OTHER side has left, and only for
  // as long as this pitcher is the one on the mound. A pitcher who has already
  // been replaced has no remaining opportunities at all.
  const opposingDist = side === 'home' ? book.remainingPlateAppearances.away : book.remainingPlateAppearances.home
  const stillPitching = Boolean(pitcher.isActivePitcher ?? pitcher.isPitcher)
  const opportunities = stillPitching ? opposingDist : new Float64Array(1).fill(1)
  const strikeouts = buildCountDistribution({
    recorded: Math.max(0, safeNumber(pitcher.kSoFar, 0)),
    opportunityDistribution: opportunities,
    perOpportunityRate: rates.strikeoutRate,
    maxCount: MAX_PROP_COUNT * 2,
  })
  const remainingMass = 1 - (opportunities[0] || 0)
  return { side, pitcher, label, rates, opportunities, strikeouts, remainingOpportunityMass: remainingMass, stillPitching }
}

// ── Board assembly ───────────────────────────────────────────────────────────

function quoteRow(base, quote, extra = {}) {
  return {
    ...base,
    ...extra,
    predicted_probability: Number(quote.fairProbabilityA.toFixed(4)),
    is_locked: !quote.availability.open,
    updated_at: new Date().toISOString(),
  }
}

function priceBoardV4(game, homeRoster, awayRoster, homeHistorical, awayHistorical, playerProps, options = {}) {
  const book = buildGameMarketBook({
    game, homeRoster, awayRoster, homeHistorical, awayHistorical, playerProps,
    liveState: options.liveState || null,
    priors: options.priors || MODEL_PRIORS,
    advanceParams: options.advanceParams || DEFAULT_ADVANCE_PARAMS,
  })
  book.homeRoster = homeRoster
  book.awayRoster = awayRoster

  const policy = housePolicy(playerProps)
  const state = book.state
  const rows = []
  const modelVersion = ODDS_MODEL_VERSIONS.gameModel
  const gameClosed = state.gameComplete

  // Moneyline. A tie is a push under the settlement rules, so it is priced as
  // one: the two sides split the decisive mass and the tie is reported.
  const moneylineQuote = quoteTwoWayMarket({
    fair: book.markets.moneyline,
    exposure: marketVolumeFor(playerProps, 'moneyline', null, 'home', 'away'),
    policy,
    availability: {
      gameComplete: gameClosed,
      determined: isDetermined(book.markets.moneyline),
      insufficientContext: !homeRoster.length || !awayRoster.length,
    },
    label: 'moneyline',
  })
  rows.push(quoteRow({
    game_id: game.id,
    bet_type: 'moneyline',
    target_entity: null,
    line: null,
    odds_home: moneylineQuote.oddsA,
    odds_away: moneylineQuote.oddsB,
    model_version: modelVersion,
  }, moneylineQuote))

  // Run line. The spread applies to the HOME team, because that is exactly how
  // `betResolution.js` grades it: home covers when home wins by more than the
  // spread and the away side covers otherwise. Pricing the favourite's margin
  // instead — the old behaviour — made the run line disagree with the moneyline
  // about the same event whenever the away team was favoured.
  const spread = pickRunLineSpread(book)
  const runLineFair = book.markets.runLineAt(spread)
  const runLineQuote = quoteTwoWayMarket({
    fair: runLineFair,
    exposure: marketVolumeFor(playerProps, 'run_line', null, 'home', 'away'),
    policy,
    availability: { gameComplete: gameClosed, determined: isDetermined(runLineFair) },
    label: 'run_line',
  })
  rows.push(quoteRow({
    game_id: game.id,
    bet_type: 'run_line',
    target_entity: null,
    line: spread,
    odds_home: runLineQuote.oddsA,
    odds_away: runLineQuote.oddsB,
    model_version: modelVersion,
  }, runLineQuote))

  const currentTotal = state.awayScore + state.homeScore
  const totalLine = pickTotalLine(book, { currentTotal })
  const totalFair = book.markets.totalAt(totalLine)
  const totalQuote = quoteTwoWayMarket({
    fair: totalFair,
    exposure: marketVolumeFor(playerProps, 'over_under', null, 'over', 'under'),
    policy,
    availability: { gameComplete: gameClosed, determined: isDetermined(totalFair) },
    label: 'over_under',
  })
  rows.push(quoteRow({
    game_id: game.id,
    bet_type: 'over_under',
    target_entity: null,
    line: totalLine,
    odds_over: totalQuote.oddsA,
    odds_under: totalQuote.oddsB,
    model_version: modelVersion,
  }, totalQuote))

  const firstInning = book.markets.firstInning
  const firstInningProbability = firstInning.probability == null ? 0.5 : firstInning.probability
  const firstInningQuote = quoteTwoWayMarket({
    fair: { sideA: firstInningProbability, sideB: 1 - firstInningProbability },
    exposure: marketVolumeFor(playerProps, 'first_inning_run', null, 'yes', 'no'),
    policy,
    availability: {
      gameComplete: gameClosed,
      determined: firstInning.determined,
      windowClosed: state.currentInning > 1,
      insufficientContext: firstInning.probability == null,
    },
    label: 'first_inning_run',
  })
  rows.push(quoteRow({
    game_id: game.id,
    bet_type: 'first_inning_run',
    target_entity: null,
    line: 0.5,
    odds_yes: firstInningQuote.oddsA,
    odds_no: firstInningQuote.oddsB,
    model_version: modelVersion,
  }, firstInningQuote))

  // Player props.
  const props = buildPropDistributions(book, playerProps, options.priors || MODEL_PRIORS)
  props.batters.forEach((prop) => {
    ;[
      { betType: 'hr_prop', counts: prop.homeRuns, rate: prop.rates.homeRunRate },
      { betType: 'hit_prop', counts: prop.hits, rate: prop.rates.hitRate },
    ].forEach(({ betType, counts, rate }) => {
      const line = pickBalancedCountLine(counts, { maxLine: MAX_PROP_COUNT - 0.5 })
      const fair = countLineProbabilities(counts, line, { remainingOpportunityMass: prop.remainingOpportunityMass })
      const quote = quoteTwoWayMarket({
        fair: { sideA: fair.over, sideB: fair.under, push: fair.push },
        exposure: marketVolumeFor(playerProps, betType, prop.label, 'over', 'under'),
        policy,
        availability: {
          gameComplete: gameClosed,
          determined: fair.determined,
          noOpportunityRemaining: prop.remainingOpportunityMass <= 1e-9,
        },
        label: `${betType} ${prop.label}`,
      })
      rows.push(quoteRow({
        game_id: game.id,
        bet_type: betType,
        target_entity: prop.label,
        line,
        prop_current_count: counts.recorded,
        prop_lambda: Number((rate * expectedValue(prop.opportunities)).toFixed(3)),
        prop_variance_multiplier: 1,
        odds_over: quote.oddsA,
        odds_under: quote.oddsB,
        model_version: modelVersion,
      }, quote))
    })
  })

  const pitcherProps = [
    buildPitcherProp(book, { pitcher: book.homePitcher, side: 'home', playerProps, priors: options.priors || MODEL_PRIORS }),
    buildPitcherProp(book, { pitcher: book.awayPitcher, side: 'away', playerProps, priors: options.priors || MODEL_PRIORS }),
  ].filter(Boolean)

  pitcherProps.forEach((prop) => {
    const line = pickBalancedCountLine(prop.strikeouts, { maxLine: (MAX_PROP_COUNT * 2) - 0.5 })
    const fair = countLineProbabilities(prop.strikeouts, line, { remainingOpportunityMass: prop.remainingOpportunityMass })
    const quote = quoteTwoWayMarket({
      fair: { sideA: fair.over, sideB: fair.under, push: fair.push },
      exposure: marketVolumeFor(playerProps, 'k_prop', prop.label, 'over', 'under'),
      policy,
      availability: {
        gameComplete: gameClosed,
        determined: fair.determined,
        noOpportunityRemaining: !prop.stillPitching || prop.remainingOpportunityMass <= 1e-9,
      },
      label: `k_prop ${prop.label}`,
    })
    rows.push(quoteRow({
      game_id: game.id,
      bet_type: 'k_prop',
      target_entity: prop.label,
      line,
      prop_current_count: prop.strikeouts.recorded,
      prop_lambda: Number((prop.rates.strikeoutRate * expectedValue(prop.opportunities)).toFixed(3)),
      prop_variance_multiplier: 1,
      odds_over: quote.oddsA,
      odds_under: quote.oddsB,
      model_version: modelVersion,
    }, quote))
  })

  return { rows: sortRows(rows), book }
}

function expectedValue(distribution) {
  let mean = 0
  for (let i = 0; i < distribution.length; i += 1) mean += i * distribution[i]
  return mean
}

function isDetermined(fair) {
  const decisive = safeNumber(fair.sideA, 0) + safeNumber(fair.sideB, 0)
  if (decisive <= 0) return true
  const share = safeNumber(fair.sideA, 0) / decisive
  return share >= 1 - 1e-9 || share <= 1e-9
}

function sortRows(rows) {
  return rows.sort((a, b) => {
    const typeOrder = BET_TYPE_ORDER.indexOf(a.bet_type) - BET_TYPE_ORDER.indexOf(b.bet_type)
    if (typeOrder !== 0) return typeOrder
    return String(a.target_entity || '').localeCompare(String(b.target_entity || ''))
  })
}

// ── Public API ───────────────────────────────────────────────────────────────

export function generateGameOdds(
  game,
  homeRoster = [],
  awayRoster = [],
  homeHistorical = {},
  awayHistorical = {},
  playerProps = {},
  weights = {},
  options = {},
) {
  if (isLegacyModel(options.modelVersion)) {
    return legacy.generateGameOdds(game, homeRoster, awayRoster, homeHistorical, awayHistorical, playerProps, weights)
  }
  return priceBoardV4(game, homeRoster, awayRoster, homeHistorical, awayHistorical, playerProps, options).rows
}

/**
 * Live market state for the scorebook's win-probability readout and for
 * anything that needs the game distribution's summary statistics.
 *
 * `winProbability` is the fair probability that the HOME team wins, normalized
 * over decisive outcomes only. `tieProbability` and `unresolvedProbability` are
 * reported separately instead of being folded into one side.
 */
export function estimateLiveMarketState({
  game = {},
  homeRoster = [],
  awayRoster = [],
  homeHistorical = {},
  awayHistorical = {},
  playerProps = {},
  state = {},
  modelVersion = null,
} = {}) {
  if (isLegacyModel(modelVersion)) {
    return legacy.estimateLiveMarketState({ game, homeRoster, awayRoster, homeHistorical, awayHistorical, playerProps, state })
  }

  const book = buildGameMarketBook({
    game, homeRoster, awayRoster, homeHistorical, awayHistorical, playerProps, liveState: state,
  })
  const distribution = book.distribution
  const decisive = distribution.homeWinProbability + distribution.awayWinProbability

  let expectedMargin = 0
  let marginSecondMoment = 0
  for (let i = 0; i < distribution.marginDistribution.length; i += 1) {
    const mass = distribution.marginDistribution[i]
    if (mass <= 0) continue
    const margin = i - distribution.marginOffset
    expectedMargin += margin * mass
    marginSecondMoment += margin * margin * mass
  }
  let projectedTotal = 0
  let totalSecondMoment = 0
  for (let i = 0; i < distribution.totalDistribution.length; i += 1) {
    const mass = distribution.totalDistribution[i]
    if (mass <= 0) continue
    projectedTotal += i * mass
    totalSecondMoment += i * i * mass
  }
  const resolved = Math.max(distribution.resolvedMass, 1e-12)
  expectedMargin /= resolved
  projectedTotal /= resolved
  const marginStdDev = Math.sqrt(Math.max(0, (marginSecondMoment / resolved) - (expectedMargin * expectedMargin)))
  const totalStdDev = Math.sqrt(Math.max(0, (totalSecondMoment / resolved) - (projectedTotal * projectedTotal)))

  return {
    winProbability: decisive > 0 ? distribution.homeWinProbability / decisive : 0.5,
    homeWinProbability: distribution.homeWinProbability,
    awayWinProbability: distribution.awayWinProbability,
    tieProbability: distribution.tieProbability,
    unresolvedProbability: distribution.unresolvedMass,
    expectedMargin,
    // Historically named `marginVariance`/`totalVariance` but consumed as a
    // scale, so these stay standard deviations.
    marginVariance: Math.max(marginStdDev, 0.01),
    projectedTotal,
    totalVariance: Math.max(totalStdDev, 0.01),
    gameComplete: book.state.gameComplete,
    book,
  }
}

export function estimateLiveWinProbability(args) {
  return estimateLiveMarketState(args).winProbability
}

const LIVE_COMPARE_FIELDS = [
  'line', 'odds_home', 'odds_away', 'odds_over', 'odds_under', 'odds_yes', 'odds_no',
  'predicted_probability', 'prop_current_count', 'prop_lambda', 'prop_variance_multiplier',
  'is_locked', 'model_version',
]

function rowsDiffer(left = {}, right = {}) {
  return LIVE_COMPARE_FIELDS.some((field) => (left[field] ?? null) !== (right[field] ?? null))
}

/**
 * Reprices a stored board against the current game state.
 *
 * The v4 path rebuilds the WHOLE board from the same function
 * `generateGameOdds` uses, so a repricing and a regeneration cannot drift apart.
 * The one-way rules are preserved: repricing may close a market, never reopen
 * one, and a market the database has already locked stays locked.
 */
export function recalculateOdds(currentOdds = [], gameState = {}, pa = {}) {
  if (isLegacyModel(gameState.modelVersion)) {
    return legacy.recalculateOdds(currentOdds, gameState, pa)
  }

  const changedRows = []
  const context = gameState.oddsContext || gameState.generationContext || null
  const liveState = gameState.liveState || null

  let repriced = []
  if (context?.game) {
    repriced = priceBoardV4(
      context.game,
      context.homeRoster || [],
      context.awayRoster || [],
      context.homeHistorical || {},
      context.awayHistorical || {},
      context.playerProps || {},
      { liveState },
    ).rows
  }
  const repricedByKey = Object.fromEntries(repriced.map((row) => [buildOddsRowKey(row), row]))
  const currentByKey = Object.fromEntries(currentOdds.map((row) => [buildOddsRowKey(row), row]))

  currentOdds.forEach((row) => {
    const next = repricedByKey[buildOddsRowKey(row)]
    let candidate = null

    if (next) {
      candidate = {
        ...row,
        ...next,
        id: row.id,
        game_id: row.game_id ?? next.game_id,
        // Repricing may suspend a market; it may never reopen one.
        is_locked: Boolean(row.is_locked) || Boolean(next.is_locked),
      }
      // A market the board has already locked keeps the line and price it was
      // locked at — an accepted ticket's market must not keep moving after the
      // house closed it.
      if (row.is_locked) {
        candidate = { ...row, is_locked: true, model_version: next.model_version ?? row.model_version }
      }
    }

    // The first-inning window closes for NEW tickets once inning 2 has begun,
    // whether or not a full context was supplied.
    const currentInning = Number(gameState.liveState?.currentInning ?? gameState.currentInning ?? 0)
    if (row.bet_type === 'first_inning_run' && !row.is_locked && currentInning >= 2) {
      candidate = { ...(candidate || row), is_locked: true }
    }

    if (candidate) {
      const merged = { ...candidate, updated_at: new Date().toISOString() }
      if (rowsDiffer(row, merged)) changedRows.push(merged)
    }
  })

  repriced.forEach((row) => {
    if (currentByKey[buildOddsRowKey(row)]) return
    if (!currentOdds.length && !gameState.generationContext) return
    changedRows.push(row)
  })

  if (gameState.pitcherSwap) {
    // A pitcher who has been pulled cannot add more strikeouts, so their market
    // closes for new tickets. Existing tickets still settle against the final
    // total.
    const liveKTargets = new Set(repriced.filter((row) => row.bet_type === 'k_prop').map((row) => row.target_entity))
    currentOdds
      .filter((row) => row.bet_type === 'k_prop' && !row.is_locked && !liveKTargets.has(row.target_entity))
      .forEach((row) => {
        if (changedRows.some((entry) => compareRows(entry, row))) return
        changedRows.push({ ...row, is_locked: true, updated_at: new Date().toISOString() })
      })
  }

  return changedRows
}

// ── Retained helpers with corrected semantics ────────────────────────────────

/**
 * P(final count > line) for a Poisson remaining count.
 *
 * Retained for stored rows priced before the game model existed. It now returns
 * an exact 1 when the recorded count is already past the line instead of the
 * old 0.998 clip, so the caller can close a settled market rather than quote
 * the losing side of it at +43500.
 */
export function poissonOverProbability(lambda, line, settledCount = 0) {
  const safeLambda = Math.max(0, Number(lambda || 0))
  const targetTotal = Math.max(0, Math.floor(Number(line ?? 0.5)) + 1)
  const neededRemaining = targetTotal - Math.max(0, Number(settledCount || 0))
  if (neededRemaining <= 0) return 1
  if (safeLambda <= 0) return 0
  let cdf = 0
  let term = Math.exp(-safeLambda)
  for (let k = 0; k < neededRemaining; k += 1) {
    cdf += term
    term *= safeLambda / (k + 1)
  }
  return clamp(1 - cdf, 0, 1)
}

/**
 * Prices one count line from a stored Poisson rate.
 *
 * Kept for rows that carry `prop_lambda` but no live model — mainly the board's
 * alternate-line rail reading a persisted row. A line the recorded count has
 * already cleared comes back closed, with no odds, rather than priced.
 */
export function priceCountPropLine(lambda, line, options = {}) {
  const { marketVolume = {}, liabilityCap, overround = TARGET_OVERROUND, settledCount = 0, gameComplete = false } = options
  const recorded = Math.max(0, Number(settledCount || 0))
  const determined = recorded > Number(line)
  const overProbability = poissonOverProbability(lambda, line, recorded)

  const quote = quoteTwoWayMarket({
    fair: { sideA: overProbability, sideB: 1 - overProbability },
    exposure: {
      moneyA: marketVolume.over?.money,
      moneyB: marketVolume.under?.money,
      liabilityA: marketVolume.over?.liability,
      liabilityB: marketVolume.under?.liability,
      liabilityCap,
    },
    policy: { ...DEFAULT_HOUSE_POLICY, overround },
    availability: { determined, gameComplete },
    label: 'count_prop',
  })

  return {
    oddsOver: determined ? null : quote.oddsA,
    oddsUnder: determined ? null : quote.oddsB,
    probabilityOver: overProbability,
    isSuspended: quote.isSuspended,
    availability: quote.availability,
    determined,
  }
}

/**
 * Legacy-shaped two-sided pricing helper.
 *
 * Retained so existing callers and their tests keep working. New code should
 * use `quoteTwoWayMarket`, which reports the stages separately and carries push
 * mass instead of assuming a two-outcome market.
 */
export function priceMarket(fairProbabilityA, options = {}) {
  const {
    moneyA = 0, moneyB = 0, liabilityA = 0, liabilityB = 0,
    liabilityCap = DEFAULT_LIABILITY_CAP, overround = TARGET_OVERROUND, alreadySuspended = false,
  } = options
  const quote = quoteTwoWayMarket({
    fair: { sideA: clampProbability(fairProbabilityA), sideB: 1 - clampProbability(fairProbabilityA) },
    exposure: { moneyA, moneyB, liabilityA, liabilityB, liabilityCap },
    policy: { ...DEFAULT_HOUSE_POLICY, overround },
    availability: { manuallyLocked: alreadySuspended },
    label: 'priceMarket',
  })
  assertNoArbitrage(quote.margin.marginProbabilityA, quote.margin.marginProbabilityB, 'priceMarket')
  return {
    oddsA: quote.oddsA,
    oddsB: quote.oddsB,
    probabilityA: quote.quotedProbabilityA,
    isSuspended: quote.isSuspended,
    availability: quote.availability,
  }
}

/**
 * Legacy-shaped total-line search.
 *
 * When a game model book is supplied it reads the line straight off the joint
 * run distribution, including the push probability at whole-number totals.
 * Without one it falls back to the established normal-approximation search so
 * the existing callers and their expectations are unchanged.
 */
export function priceBalancedTotalLine(options = {}) {
  const { book, playerProps = {}, currentTotal = 0 } = options
  if (!book) return legacy.priceBalancedTotalLine(options)
  const line = pickTotalLine(book, { currentTotal })
  const fair = book.markets.totalAt(line)
  const quote = quoteTwoWayMarket({
    fair,
    exposure: marketVolumeFor(playerProps, 'over_under', null, 'over', 'under'),
    policy: housePolicy(playerProps),
    availability: { gameComplete: book.state.gameComplete, determined: isDetermined(fair) },
    label: 'over_under',
  })
  return {
    line,
    pricing: { oddsA: quote.oddsA, oddsB: quote.oddsB, probabilityA: quote.fairProbabilityA, isSuspended: quote.isSuspended },
    pushProbability: quote.pushProbability,
    distanceFromEven: Math.abs(quote.fairProbabilityA - 0.5),
    distanceFromProjection: 0,
  }
}

// ── Calibration ──────────────────────────────────────────────────────────────

export function computeBrierScore(predictions = []) {
  if (!predictions.length) return 0
  const total = predictions.reduce((sum, entry) => {
    const probability = Number(entry.predictedProb ?? entry.predicted_probability ?? 0)
    const outcome = Number(entry.actualOutcome ?? entry.actual_outcome ?? 0)
    return sum + Math.pow(probability - outcome, 2)
  }, 0)
  return total / predictions.length
}

export function computeLogLoss(predictions = [], epsilon = 1e-6) {
  if (!predictions.length) return 0
  const total = predictions.reduce((sum, entry) => {
    const probability = Math.min(1 - epsilon, Math.max(epsilon, Number(entry.predictedProb ?? entry.predicted_probability ?? 0.5)))
    const outcome = Number(entry.actualOutcome ?? entry.actual_outcome ?? 0)
    return sum - ((outcome * Math.log(probability)) + ((1 - outcome) * Math.log(1 - probability)))
  }, 0)
  return total / predictions.length
}

export const adjustWeights = legacy.adjustWeights

export { MIN_PROBABILITY, MAX_PROBABILITY, roundOddsMagnitude, decideAvailability }
