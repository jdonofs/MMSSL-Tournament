// The quoting pipeline, as five separate stages.
//
//   1. FAIR          probabilities from the game/prop model, including push mass
//   2. EXPOSURE      the house's book-balancing shift, from money already taken
//   3. MARGIN        the house edge
//   4. DISPLAY       American odds and their rounding
//   5. AVAILABILITY  whether the market may be quoted at all
//
// Keeping them apart is the point. Stage 1 is the only thing a calibration
// report is allowed to score, and it never sees a dollar of exposure: money on
// one side changes the PRICE, not the model's belief about who wins. The old
// engine wrote the exposure-shifted number into `predicted_probability`, which
// is the field the post-game Brier score reads, so a lopsided book looked like
// evidence that a team had got better.
//
// A note on the house margin, because the previous constant was described in a
// way the formula does not deliver: `proportional-net-odds` reduces the fair NET
// odds by a constant fraction. That produces the requested overround only on a
// coin flip. On heavier favourites the same fraction of a smaller net price is a
// much smaller edge, so the two implied probabilities sum to progressively less
// (measured: 1.070 at a 50/50, 1.045 at 80/20, 1.025 at 90/10, 1.003 at 99/1).
// That is the house's configured behaviour and is preserved; it is now named
// accurately and `measureMarginCurve` reports it rather than a comment asserting
// a constant 7%.

export const MIN_PROBABILITY = 0.002
export const MAX_PROBABILITY = 0.998
export const MIN_DISPLAY_DECIMAL_ODDS = 1.01
export const MAX_DISPLAY_DECIMAL_ODDS = 1000
export const MAX_UNDERDOG_ODDS = Math.round((MAX_DISPLAY_DECIMAL_ODDS - 1) * 100)
export const MAX_FAVORITE_ODDS = Math.round(-100 / (MIN_DISPLAY_DECIMAL_ODDS - 1))

// Retained name and value: this is what the house has been charging.
export const TARGET_OVERROUND = 1.07

export const MARGIN_METHODS = Object.freeze({
  // Reduce the fair net odds by a constant fraction. Delivers `overround` only
  // at even money; the effective margin shrinks toward zero on heavy favourites.
  proportionalNetOdds: 'proportional-net-odds',
  // Scale both fair probabilities by the same factor so they sum to `overround`
  // on every market. Available but NOT the default: switching to it would
  // change what the house takes on every non-even market.
  multiplicative: 'multiplicative',
})

export const MAX_VOLUME_SHIFT = 0.12
export const MIN_MARKET_LIQUIDITY = 20
export const DEFAULT_LIABILITY_CAP = 500

export const DEFAULT_HOUSE_POLICY = Object.freeze({
  marginMethod: MARGIN_METHODS.proportionalNetOdds,
  overround: TARGET_OVERROUND,
  maxVolumeShift: MAX_VOLUME_SHIFT,
  minMarketLiquidity: MIN_MARKET_LIQUIDITY,
  liabilityCap: DEFAULT_LIABILITY_CAP,
})

export const MARKET_AVAILABILITY = Object.freeze({
  open: 'open',
  outcomeDetermined: 'outcome-determined',
  gameComplete: 'game-complete',
  noOpportunityRemaining: 'no-opportunity-remaining',
  windowClosed: 'window-closed',
  liabilityCap: 'liability-cap',
  exposureSaturated: 'exposure-saturated',
  insufficientContext: 'insufficient-context',
  manuallyLocked: 'manually-locked',
})

export function clampProbability(value, min = MIN_PROBABILITY, max = MAX_PROBABILITY) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.min(max, Math.max(min, numeric))
}

// Sportsbooks don't display every integer once odds get steep — round to a
// coarser increment as the magnitude grows (matches real-world board behavior).
export function roundOddsMagnitude(odds) {
  const abs = Math.abs(odds)
  let rounded = abs
  if (abs >= 5000) rounded = Math.round(abs / 500) * 500
  else if (abs >= 1000) rounded = Math.round(abs / 100) * 100
  else if (abs >= 200) rounded = Math.round(abs / 5) * 5
  return odds < 0 ? -rounded : rounded
}

export function impliedProbabilityFromAmericanOdds(odds) {
  const numeric = Number(odds)
  if (!Number.isFinite(numeric) || numeric === 0) return null
  return numeric > 0 ? 100 / (numeric + 100) : Math.abs(numeric) / (Math.abs(numeric) + 100)
}

// ── Stage 1: fair probabilities, pushes kept explicit ────────────────────────

/**
 * Splits a three-way {over, push, under} outcome into the two prices a
 * stake-refunding push market actually offers.
 *
 * A push returns the stake, so the fair price of each side is its share of the
 * NON-PUSH mass. `pushProbability` and `unresolvedProbability` are carried
 * through rather than folded into a side — the old engine added the whole tie
 * mass to the home team, which quoted a refund as a win.
 */
export function normalizeTwoWayFair({ sideA = 0, push = 0, sideB = 0, unresolved = 0 } = {}) {
  const a = Math.max(0, Number(sideA) || 0)
  const b = Math.max(0, Number(sideB) || 0)
  const p = Math.max(0, Number(push) || 0)
  const u = Math.max(0, Number(unresolved) || 0)
  const decisive = a + b
  const total = decisive + p + u
  return {
    probabilityA: decisive > 0 ? a / decisive : 0.5,
    probabilityB: decisive > 0 ? b / decisive : 0.5,
    pushProbability: total > 0 ? p / total : 0,
    unresolvedProbability: total > 0 ? u / total : 0,
    decisiveMass: decisive,
    normalizationMass: total,
  }
}

// ── Stage 2: exposure ────────────────────────────────────────────────────────

/**
 * Book balancing. More money on one side makes that side's price worse.
 *
 * The result is deliberately NOT a probability estimate. It is returned in its
 * own field so the fair probability stays available for calibration.
 */
export function applyExposureAdjustment(fairProbabilityA, exposure = {}, policy = DEFAULT_HOUSE_POLICY) {
  const maxShift = Number(policy.maxVolumeShift ?? MAX_VOLUME_SHIFT)
  const minLiquidity = Number(policy.minMarketLiquidity ?? MIN_MARKET_LIQUIDITY)
  const moneyA = Math.max(0, Number(exposure.moneyA || 0))
  const moneyB = Math.max(0, Number(exposure.moneyB || 0))
  const liquidity = Math.max(moneyA + moneyB, minLiquidity)
  const imbalance = Math.min(1, Math.max(-1, (moneyA - moneyB) / liquidity))
  const shift = imbalance * maxShift
  const adjusted = clampProbability(Number(fairProbabilityA || 0.5) + shift)
  return {
    probabilityA: adjusted,
    shift,
    imbalance,
    saturated: Math.abs(imbalance) >= 1 && Math.abs(shift) >= maxShift,
    moneyA,
    moneyB,
  }
}

// ── Stage 3: margin ──────────────────────────────────────────────────────────

function proportionalNetOddsMultiplier(overround) {
  const safe = Math.max(1.001, Number(overround || TARGET_OVERROUND))
  return Math.min(1, Math.max(0.001, (2 / safe) - 1))
}

export function applyMargin(probabilityA, policy = DEFAULT_HOUSE_POLICY) {
  const method = policy.marginMethod || MARGIN_METHODS.proportionalNetOdds
  const overround = Number(policy.overround ?? TARGET_OVERROUND)
  const pA = clampProbability(probabilityA)
  const pB = clampProbability(1 - pA)

  if (method === MARGIN_METHODS.multiplicative) {
    const scale = overround / (pA + pB)
    return {
      method,
      overround,
      marginProbabilityA: clampProbability(pA * scale),
      marginProbabilityB: clampProbability(pB * scale),
    }
  }

  const multiplier = proportionalNetOddsMultiplier(overround)
  const shrink = (probability) => {
    const fairDecimal = 1 / probability
    const vigDecimal = 1 + ((fairDecimal - 1) * multiplier)
    return clampProbability(1 / vigDecimal)
  }
  return {
    method: MARGIN_METHODS.proportionalNetOdds,
    overround,
    marginProbabilityA: shrink(pA),
    marginProbabilityB: shrink(pB),
  }
}

// Retained single-side helper so existing callers keep their exact behaviour.
export function applyVig(probability, overround = TARGET_OVERROUND) {
  const fairProbability = clampProbability(probability)
  const multiplier = proportionalNetOddsMultiplier(overround)
  const fairDecimalOdds = 1 / fairProbability
  const vigDecimalOdds = 1 + ((fairDecimalOdds - 1) * multiplier)
  return clampProbability(1 / vigDecimalOdds)
}

// ── Stage 4: display ─────────────────────────────────────────────────────────

export function oddsFromVigProbability(vigProbability) {
  const probability = clampProbability(vigProbability)
  const decimalOdds = Math.min(MAX_DISPLAY_DECIMAL_ODDS, Math.max(MIN_DISPLAY_DECIMAL_ODDS, 1 / probability))
  const odds = decimalOdds >= 2
    ? Math.round((decimalOdds - 1) * 100)
    : Math.round(-100 / (decimalOdds - 1))
  return Math.min(MAX_UNDERDOG_ODDS, Math.max(MAX_FAVORITE_ODDS, roundOddsMagnitude(odds)))
}

export function americanOddsFromProbability(probability, overround = TARGET_OVERROUND) {
  return oddsFromVigProbability(applyVig(probability, overround))
}

/**
 * The house edge that actually reaches the board, measured on the DISPLAYED
 * odds after rounding rather than on the internal probabilities.
 */
export function measureMarginCurve(fairProbabilities = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99], policy = DEFAULT_HOUSE_POLICY) {
  return fairProbabilities.map((fair) => {
    const margin = applyMargin(fair, policy)
    const oddsA = oddsFromVigProbability(margin.marginProbabilityA)
    const oddsB = oddsFromVigProbability(margin.marginProbabilityB)
    const impliedA = impliedProbabilityFromAmericanOdds(oddsA)
    const impliedB = impliedProbabilityFromAmericanOdds(oddsB)
    return {
      fairProbabilityA: fair,
      oddsA,
      oddsB,
      impliedSum: impliedA + impliedB,
      internalSum: margin.marginProbabilityA + margin.marginProbabilityB,
      method: margin.method,
    }
  })
}

// ── Stage 5: availability ────────────────────────────────────────────────────

export function decideAvailability({
  determined = false,
  gameComplete = false,
  noOpportunityRemaining = false,
  windowClosed = false,
  manuallyLocked = false,
  insufficientContext = false,
  liabilityExceeded = false,
  exposureSaturated = false,
} = {}) {
  if (insufficientContext) return { open: false, reason: MARKET_AVAILABILITY.insufficientContext }
  if (gameComplete) return { open: false, reason: MARKET_AVAILABILITY.gameComplete }
  if (determined) return { open: false, reason: MARKET_AVAILABILITY.outcomeDetermined }
  if (noOpportunityRemaining) return { open: false, reason: MARKET_AVAILABILITY.noOpportunityRemaining }
  if (windowClosed) return { open: false, reason: MARKET_AVAILABILITY.windowClosed }
  if (manuallyLocked) return { open: false, reason: MARKET_AVAILABILITY.manuallyLocked }
  if (liabilityExceeded) return { open: false, reason: MARKET_AVAILABILITY.liabilityCap }
  if (exposureSaturated) return { open: false, reason: MARKET_AVAILABILITY.exposureSaturated }
  return { open: true, reason: MARKET_AVAILABILITY.open }
}

export function assertNoArbitrage(probabilityA, probabilityB, label = 'market') {
  const total = Number(probabilityA || 0) + Number(probabilityB || 0)
  if (total <= 1) {
    throw new Error(`Arbitrage detected in ${label}: implied probabilities sum to ${total.toFixed(4)} (must be > 1)`)
  }
  return total
}

/**
 * The whole pipeline for one two-sided market.
 *
 * `fair` is {sideA, sideB, push, unresolved} straight from the model.
 * Everything downstream is reported separately so a diagnostics reader can see
 * exactly which stage moved the number.
 */
export function quoteTwoWayMarket({
  fair,
  exposure = {},
  policy = DEFAULT_HOUSE_POLICY,
  availability = {},
  label = 'market',
} = {}) {
  const normalized = normalizeTwoWayFair(fair)
  const liabilityCap = Number(exposure.liabilityCap ?? policy.liabilityCap ?? DEFAULT_LIABILITY_CAP)
  const liabilityExceeded = Number(exposure.liabilityA || 0) > liabilityCap || Number(exposure.liabilityB || 0) > liabilityCap

  const adjusted = applyExposureAdjustment(normalized.probabilityA, exposure, policy)
  const margin = applyMargin(adjusted.probabilityA, policy)
  const oddsA = oddsFromVigProbability(margin.marginProbabilityA)
  const oddsB = oddsFromVigProbability(margin.marginProbabilityB)

  const decision = decideAvailability({
    ...availability,
    liabilityExceeded,
    exposureSaturated: adjusted.saturated,
  })

  const impliedA = impliedProbabilityFromAmericanOdds(oddsA)
  const impliedB = impliedProbabilityFromAmericanOdds(oddsB)

  return {
    label,
    fairProbabilityA: normalized.probabilityA,
    fairProbabilityB: normalized.probabilityB,
    pushProbability: normalized.pushProbability,
    unresolvedProbability: normalized.unresolvedProbability,
    quotedProbabilityA: adjusted.probabilityA,
    exposure: adjusted,
    margin,
    oddsA,
    oddsB,
    displayedOverround: (impliedA ?? 0) + (impliedB ?? 0),
    availability: decision,
    isSuspended: !decision.open,
  }
}

export function calculatePayout(wagerSips, americanOdds) {
  const stake = Number(wagerSips || 0)
  const odds = Number(americanOdds || 0)
  if (!stake || !odds) return 0
  const raw = odds > 0 ? (odds / 100) * stake : (100 / Math.abs(odds)) * stake
  return Math.round(raw * 100) / 100
}
