// Player prop distributions, built as
//
//     final count = results already recorded + results still to come
//
// and never as a rate re-derived from scratch. "Still to come" is the number of
// opportunities the batter actually has left, which comes out of the same
// half-inning chain the game markets use: how many more plate appearances the
// team gets, and where this batter sits in the order relative to the next
// hitter up.
//
// Two coherence properties hold by construction rather than by coincidence:
//
//   * Home runs are a subset of hits. A home run is modelled as a share of the
//     batter's hits, so P(HR >= k) <= P(hits >= k) at every k.
//   * Raising an over line can never raise its win probability, because every
//     line is read from the same count distribution.

const RESIDUAL_EPSILON = 1e-12

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

/**
 * How many more plate appearances one batter gets.
 *
 * `slotsUntilNextTurn` is 0 for the batter at the plate (or on deck to lead off
 * the side's next half inning), 1 for the next hitter, and so on. With a lineup
 * of `lineupSize`, a batter who is `j` turns away gets an n-th further plate
 * appearance exactly when the team takes at least `j + 1 + (n - 1) * lineupSize`
 * more turns at bat.
 */
export function batterPlateAppearanceDistribution({
  teamPlateAppearanceDistribution,
  slotsUntilNextTurn = 0,
  lineupSize = 9,
  maxPlateAppearances = 12,
}) {
  const teamDist = teamPlateAppearanceDistribution || new Float64Array(1)
  const size = Math.max(1, Math.trunc(lineupSize))
  const offset = Math.max(0, Math.trunc(slotsUntilNextTurn))
  const cap = Math.max(0, Math.trunc(maxPlateAppearances))

  // P(batter gets at least n) = P(team gets at least offset + 1 + (n-1)*size)
  const atLeast = new Float64Array(cap + 2)
  atLeast[0] = 1
  for (let n = 1; n <= cap + 1; n += 1) {
    const needed = offset + 1 + ((n - 1) * size)
    let tail = 0
    for (let k = needed; k < teamDist.length; k += 1) tail += teamDist[k]
    atLeast[n] = Math.min(atLeast[n - 1], tail)
  }

  const exact = new Float64Array(cap + 1)
  for (let n = 0; n <= cap; n += 1) {
    exact[n] = Math.max(0, atLeast[n] - atLeast[n + 1])
  }
  // Anything beyond the cap is folded into the last bucket so the mass is never
  // silently discarded.
  let mass = 0
  for (let n = 0; n <= cap; n += 1) mass += exact[n]
  const residual = Math.max(0, 1 - mass)
  exact[cap] += residual
  return { distribution: exact, truncatedMass: residual }
}

// Binomial(n, p) probability mass, computed with a stable recurrence.
function binomialPmf(n, p) {
  const out = new Float64Array(n + 1)
  if (n < 0) return out
  const q = 1 - p
  if (p <= 0) { out[0] = 1; return out }
  if (p >= 1) { out[n] = 1; return out }
  let value = Math.pow(q, n)
  out[0] = value
  for (let k = 1; k <= n; k += 1) {
    value = value * ((n - k + 1) / k) * (p / q)
    out[k] = value
  }
  return out
}

/**
 * The distribution of a batter's or pitcher's FINAL count for the game:
 * `recorded` plus a Binomial draw over however many opportunities are left.
 */
export function buildCountDistribution({
  recorded = 0,
  opportunityDistribution,
  perOpportunityRate,
  maxCount = 20,
}) {
  const already = Math.max(0, Math.trunc(Number(recorded || 0)))
  const rate = clamp(Number(perOpportunityRate || 0), 0, 1)
  const cap = Math.max(already, Math.trunc(maxCount))
  const distribution = new Float64Array(cap + 1)
  const opportunities = opportunityDistribution || new Float64Array(1)

  let truncated = 0
  for (let n = 0; n < opportunities.length; n += 1) {
    const weight = opportunities[n]
    if (weight <= RESIDUAL_EPSILON) continue
    const pmf = binomialPmf(n, rate)
    for (let k = 0; k < pmf.length; k += 1) {
      const value = pmf[k]
      if (value <= RESIDUAL_EPSILON) continue
      const total = already + k
      if (total > cap) { truncated += weight * value; distribution[cap] += weight * value }
      else distribution[total] += weight * value
    }
  }

  return { distribution, recorded: already, truncatedMass: truncated, maxCount: cap }
}

/**
 * P(count > line), P(count == line), P(count < line) for a count distribution.
 *
 * `determined` says the market has no uncertainty left: the recorded count is
 * already past the line, or there are no opportunities remaining. A determined
 * market must be CLOSED, not quoted — returning an exact 0 or 1 here is what
 * lets the pricing layer make that decision instead of clipping a near-certainty
 * into a bettable price.
 */
export function countLineProbabilities(countDistribution, line, { remainingOpportunityMass = null } = {}) {
  const numeric = Number(line)
  const { distribution, recorded } = countDistribution
  let over = 0
  let push = 0
  let under = 0
  for (let k = 0; k < distribution.length; k += 1) {
    const mass = distribution[k]
    if (mass <= 0) continue
    if (k > numeric) over += mass
    else if (k === numeric) push += mass
    else under += mass
  }

  const alreadyOver = recorded > numeric
  const noOpportunitiesLeft = remainingOpportunityMass != null && remainingOpportunityMass <= 1e-9
  return {
    over,
    push,
    under,
    determined: alreadyOver || noOpportunitiesLeft,
    determinedOutcome: alreadyOver ? 'over' : (noOpportunitiesLeft ? (recorded > numeric ? 'over' : recorded === numeric ? 'push' : 'under') : null),
  }
}

// The board's default hook for a count market: the X.5 line whose over
// probability sits closest to even money, never below the count already
// recorded (a line the batter has already cleared is a settled market, not a
// price).
export function pickBalancedCountLine(countDistribution, { minLine = 0.5, maxLine = 12.5 } = {}) {
  const recorded = countDistribution.recorded || 0
  const floorLine = Math.max(minLine, recorded + 0.5)
  let best = null
  for (let line = floorLine; line <= maxLine + 1e-9; line += 1) {
    const { over } = countLineProbabilities(countDistribution, line)
    const distance = Math.abs(over - 0.5)
    if (!best || distance < best.distance - 1e-9) best = { line, over, distance }
  }
  return best ? best.line : floorLine
}

/**
 * Where each batter stands in the order.
 *
 * The order is read from the plate appearances this game has already recorded,
 * which is the only directly observed batting order available here; the roster's
 * own order is the fallback before the first pitch. `slotsUntilNextTurn` counts
 * from whoever bats next for that side.
 */
export function buildBattingOrder({ roster = [], gamePAs = [], playerId = null }) {
  const teamPAs = (gamePAs || [])
    .filter((pa) => playerId == null || String(pa.player_id) === String(playerId))
    .slice()
    .sort((a, b) => {
      const byNumber = Number(a.pa_number || 0) - Number(b.pa_number || 0)
      if (byNumber !== 0) return byNumber
      return String(a.created_at || '').localeCompare(String(b.created_at || ''))
    })

  const observed = []
  const seen = new Set()
  teamPAs.forEach((pa) => {
    const key = String(pa.character_id)
    if (seen.has(key)) return
    seen.add(key)
    observed.push(key)
  })

  const rosterKeys = (roster || []).map((entry) => String(entry.id))
  const order = observed.length ? observed.slice() : rosterKeys.slice()
  rosterKeys.forEach((key) => {
    if (!order.includes(key)) order.push(key)
  })

  const lineupSize = Math.max(1, order.length)
  // Whoever bats next is the character after the last recorded plate appearance.
  const lastKey = teamPAs.length ? String(teamPAs[teamPAs.length - 1].character_id) : null
  const lastIndex = lastKey == null ? -1 : order.indexOf(lastKey)
  const nextIndex = lastIndex < 0 ? 0 : (lastIndex + 1) % lineupSize

  const slots = {}
  order.forEach((key, index) => {
    slots[key] = ((index - nextIndex) + lineupSize) % lineupSize
  })

  return {
    order,
    lineupSize,
    slotsUntilNextTurn: slots,
    source: observed.length ? 'observed-plate-appearances' : 'roster-order',
    observedPlateAppearances: teamPAs.length,
  }
}
