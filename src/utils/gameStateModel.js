// A deterministic model of one Mario Super Sluggers game.
//
// Everything the board prices about a game — moneyline, run line at any spread,
// total at any line, first-inning run, and the number of plate appearances each
// batter has left — is read out of ONE distribution built here. Two markets
// that describe the same event therefore cannot disagree, and an alternate line
// cannot be non-monotonic, because they are different reads of the same array
// rather than different formulas.
//
// Structure
//
//   1. A plate appearance produces one of six outcomes (out / walk / single /
//      double / triple / home run).
//   2. Those outcomes drive a base-out Markov chain, which gives the exact
//      distribution of runs scored in the remainder of a half inning from any
//      (bases, outs) state.
//   3. A half-inning-by-half-inning dynamic program carries the joint
//      distribution of (runs the away team still adds, runs the home team still
//      adds) forward under the game's actual ending rules.
//
// There is no simulation and no random number generator anywhere in this file:
// the same inputs always produce bit-identical outputs, which is what stops the
// board from flickering between repricings.
//
// Baserunning is deliberately parameter-free by default: a runner advances
// exactly as many bases as the hit is worth, and a walk forces only the runners
// it has to. That is a simplification, not a measurement — this repo has no
// recorded baserunning-advance rates to fit. `advanceParams` exposes the two
// places a real league would differ (a runner scoring from second on a single,
// and from first on a double) so the evaluation harness can measure how much
// the answer moves; both default to off. The overall run LEVEL is not left to
// these assumptions: `calibrateOutcomeProbabilities` solves for the on-base
// scale that reproduces an observed runs-per-half-inning target, so the shape
// comes from ratings and the level comes from data.

export const OUTCOME_KEYS = ['out', 'walk', 'single', 'double', 'triple', 'homeRun']

// Bases are a 3-bit mask: 1 = runner on first, 2 = on second, 4 = on third.
export const BASE_STATE_COUNT = 8
const MAX_OUTS = 3

export const DEFAULT_MAX_RUNS_PER_HALF = 24
export const DEFAULT_MAX_RUNS_PER_SIDE = 30
export const DEFAULT_MAX_EXTRA_INNINGS = 9
const MAX_PA_STEPS_PER_HALF = 80
const RESIDUAL_EPSILON = 1e-12

export const DEFAULT_ADVANCE_PARAMS = Object.freeze({
  // P(runner on second scores on a single) beyond the base "advance one" rule.
  runnerScoresFromSecondOnSingle: 0,
  // P(runner on first scores on a double) beyond the base "advance two" rule.
  runnerScoresFromFirstOnDouble: 0,
})

function baseBits(baseState) {
  return [baseState & 1, (baseState >> 1) & 1, (baseState >> 2) & 1]
}

function bitsToBase(first, second, third) {
  return (first ? 1 : 0) | (second ? 2 : 0) | (third ? 4 : 0)
}

// [nextBaseState, runsScored, outsAdded, weight] for every (baseState, outcome).
// Outcomes that can split into two successors (an aggressive runner) return two
// entries whose weights sum to 1.
export function buildTransitionTable(advanceParams = DEFAULT_ADVANCE_PARAMS) {
  const secondScoresOnSingle = clamp01(Number(advanceParams.runnerScoresFromSecondOnSingle ?? 0))
  const firstScoresOnDouble = clamp01(Number(advanceParams.runnerScoresFromFirstOnDouble ?? 0))
  const table = []

  for (let baseState = 0; baseState < BASE_STATE_COUNT; baseState += 1) {
    const [first, second, third] = baseBits(baseState)
    const perOutcome = {}

    perOutcome.out = [[baseState, 0, 1, 1]]

    // A walk forces only the runners it has to.
    perOutcome.walk = [[
      bitsToBase(1, second || first, third || (first && second)),
      first && second && third ? 1 : 0,
      0,
      1,
    ]]

    // Single: batter to first, everyone else up one base. Optionally the runner
    // on second scores instead of stopping at third.
    perOutcome.single = second && secondScoresOnSingle > 0
      ? [
        [bitsToBase(1, first, second), third, 0, 1 - secondScoresOnSingle],
        [bitsToBase(1, first, 0), third + 1, 0, secondScoresOnSingle],
      ]
      : [[bitsToBase(1, first, second), third, 0, 1]]

    // Double: batter to second, everyone else up two bases. Optionally the
    // runner on first scores instead of stopping at third.
    perOutcome.double = first && firstScoresOnDouble > 0
      ? [
        [bitsToBase(0, 1, first), second + third, 0, 1 - firstScoresOnDouble],
        [bitsToBase(0, 1, 0), second + third + 1, 0, firstScoresOnDouble],
      ]
      : [[bitsToBase(0, 1, first), second + third, 0, 1]]

    perOutcome.triple = [[bitsToBase(0, 0, 1), first + second + third, 0, 1]]
    perOutcome.homeRun = [[0, 1 + first + second + third, 0, 1]]

    table.push(perOutcome)
  }

  return table
}

const DEFAULT_TRANSITIONS = buildTransitionTable(DEFAULT_ADVANCE_PARAMS)

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function normalizeOutcomeProbabilities(raw = {}) {
  const values = {}
  let nonOut = 0
  OUTCOME_KEYS.forEach((key) => {
    if (key === 'out') return
    const value = Math.max(0, Number(raw[key] || 0))
    values[key] = value
    nonOut += value
  })
  const out = Math.max(0, Number(raw.out ?? (1 - nonOut)))
  const total = out + nonOut
  if (!(total > 0)) {
    return { out: 1, walk: 0, single: 0, double: 0, triple: 0, homeRun: 0 }
  }
  const normalized = { out: out / total }
  OUTCOME_KEYS.forEach((key) => {
    if (key === 'out') return
    normalized[key] = values[key] / total
  })
  return normalized
}

// Exact expected runs for the remainder of a half inning, by solving the
// base-out chain one out level at a time (8 unknowns each). Used by the
// calibration search, which needs the mean only.
export function expectedRunsFromState(outcomeProbs, transitions = DEFAULT_TRANSITIONS) {
  const probs = normalizeOutcomeProbabilities(outcomeProbs)
  // expected[outs][baseState]; three outs is worth nothing.
  const expected = [new Float64Array(BASE_STATE_COUNT), new Float64Array(BASE_STATE_COUNT), new Float64Array(BASE_STATE_COUNT), new Float64Array(BASE_STATE_COUNT)]

  for (let outs = MAX_OUTS - 1; outs >= 0; outs -= 1) {
    // Solve (I - A) x = b over the 8 base states at this out level.
    const matrix = []
    for (let b = 0; b < BASE_STATE_COUNT; b += 1) {
      const row = new Float64Array(BASE_STATE_COUNT + 1)
      row[b] += 1
      let constant = 0
      OUTCOME_KEYS.forEach((key) => {
        const p = probs[key]
        if (!(p > 0)) return
        transitions[b][key].forEach(([nextBase, runs, outsAdded, weight]) => {
          const mass = p * weight
          constant += mass * runs
          if (outsAdded > 0) {
            constant += mass * expected[outs + 1][nextBase]
          } else {
            row[nextBase] -= mass
          }
        })
      })
      row[BASE_STATE_COUNT] = constant
      matrix.push(row)
    }
    const solution = solveLinearSystem(matrix, BASE_STATE_COUNT)
    for (let b = 0; b < BASE_STATE_COUNT; b += 1) expected[outs][b] = solution[b]
  }

  return expected
}

function solveLinearSystem(matrix, size) {
  for (let col = 0; col < size; col += 1) {
    let pivot = col
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row
    }
    if (pivot !== col) {
      const swap = matrix[col]
      matrix[col] = matrix[pivot]
      matrix[pivot] = swap
    }
    const pivotValue = matrix[col][col]
    if (Math.abs(pivotValue) < 1e-15) continue
    for (let row = col + 1; row < size; row += 1) {
      const factor = matrix[row][col] / pivotValue
      if (!factor) continue
      for (let k = col; k <= size; k += 1) matrix[row][k] -= factor * matrix[col][k]
    }
  }

  const solution = new Float64Array(size)
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = matrix[row][size]
    for (let col = row + 1; col < size; col += 1) value -= matrix[row][col] * solution[col]
    const pivotValue = matrix[row][row]
    solution[row] = Math.abs(pivotValue) < 1e-15 ? 0 : value / pivotValue
  }
  return solution
}

export function expectedRunsPerHalfInning(outcomeProbs, transitions = DEFAULT_TRANSITIONS) {
  return expectedRunsFromState(outcomeProbs, transitions)[0][0]
}

// Level from data, shape from ratings.
//
// `shape` gives the RELATIVE frequency of each non-out outcome. This solves for
// the single on-base scale that makes the chain score `targetRunsPerHalfInning`
// from a clean inning, so a league that averages 2.4 runs a half inning is
// modelled at 2.4 whatever the ratings say, and the ratings decide only how
// those runs are produced and how they are split between the two teams.
export function calibrateOutcomeProbabilities({
  shape,
  targetRunsPerHalfInning,
  advanceParams = DEFAULT_ADVANCE_PARAMS,
  minOnBase = 0.02,
  maxOnBase = 0.72,
  tolerance = 1e-6,
  maxIterations = 40,
}) {
  const transitions = advanceParams === DEFAULT_ADVANCE_PARAMS
    ? DEFAULT_TRANSITIONS
    : buildTransitionTable(advanceParams)
  const shapeTotal = ['walk', 'single', 'double', 'triple', 'homeRun']
    .reduce((sum, key) => sum + Math.max(0, Number(shape[key] || 0)), 0)
  if (!(shapeTotal > 0)) {
    return { probabilities: normalizeOutcomeProbabilities({ out: 1 }), onBaseRate: 0, expectedRuns: 0, converged: true, iterations: 0 }
  }

  const atScale = (scale) => normalizeOutcomeProbabilities({
    out: 1 - scale,
    walk: (Number(shape.walk || 0) / shapeTotal) * scale,
    single: (Number(shape.single || 0) / shapeTotal) * scale,
    double: (Number(shape.double || 0) / shapeTotal) * scale,
    triple: (Number(shape.triple || 0) / shapeTotal) * scale,
    homeRun: (Number(shape.homeRun || 0) / shapeTotal) * scale,
  })

  const target = Math.max(0, Number(targetRunsPerHalfInning || 0))
  let low = minOnBase
  let high = maxOnBase
  let iterations = 0
  let probabilities = atScale((low + high) / 2)
  let expected = expectedRunsPerHalfInning(probabilities, transitions)

  if (expectedRunsPerHalfInning(atScale(high), transitions) <= target) {
    probabilities = atScale(high)
    return { probabilities, onBaseRate: high, expectedRuns: expectedRunsPerHalfInning(probabilities, transitions), converged: false, iterations: 0 }
  }
  if (expectedRunsPerHalfInning(atScale(low), transitions) >= target) {
    probabilities = atScale(low)
    return { probabilities, onBaseRate: low, expectedRuns: expectedRunsPerHalfInning(probabilities, transitions), converged: false, iterations: 0 }
  }

  while (iterations < maxIterations && high - low > tolerance) {
    const mid = (low + high) / 2
    probabilities = atScale(mid)
    expected = expectedRunsPerHalfInning(probabilities, transitions)
    if (expected > target) high = mid
    else low = mid
    iterations += 1
  }

  const scale = (low + high) / 2
  probabilities = atScale(scale)
  expected = expectedRunsPerHalfInning(probabilities, transitions)
  return { probabilities, onBaseRate: scale, expectedRuns: expected, converged: high - low <= tolerance, iterations }
}

// The distribution of runs scored in the REST of a half inning, plus everything
// needed to answer the walk-off question for any deficit without redoing the
// work.
//
//   runs[v]        P(exactly v runs, half ends on the third out)
//   batters[n]     P(exactly n more batters come to the plate)
//   crossings[a][b]  total mass of transitions that took the running total from
//                    a to b. For a walk-off threshold T, the half stops the
//                    first time the total reaches T or more, and that first
//                    crossing is exactly sum over a < T of crossings[a][b].
//   residual       mass still live after MAX_PA_STEPS_PER_HALF plate
//                  appearances, i.e. the truncation error of this half.
export function halfInningDistribution(outcomeProbs, {
  baseState = 0,
  outs = 0,
  maxRuns = DEFAULT_MAX_RUNS_PER_HALF,
  advanceParams = DEFAULT_ADVANCE_PARAMS,
} = {}) {
  const transitions = advanceParams === DEFAULT_ADVANCE_PARAMS
    ? DEFAULT_TRANSITIONS
    : buildTransitionTable(advanceParams)
  const probs = normalizeOutcomeProbabilities(outcomeProbs)
  const runCap = Math.max(1, Math.trunc(maxRuns))
  const stateCount = BASE_STATE_COUNT * MAX_OUTS * (runCap + 1)
  const index = (b, o, r) => ((r * MAX_OUTS) + o) * BASE_STATE_COUNT + b

  let live = new Float64Array(stateCount)
  live[index(baseState & 7, Math.min(outs, MAX_OUTS - 1), 0)] = 1

  const runs = new Float64Array(runCap + 1)
  const batters = new Float64Array(MAX_PA_STEPS_PER_HALF + 1)
  const crossings = []
  for (let r = 0; r <= runCap; r += 1) crossings.push(new Float64Array(runCap + 1))

  let truncatedRunMass = 0
  let step = 0
  for (; step < MAX_PA_STEPS_PER_HALF; step += 1) {
    const next = new Float64Array(stateCount)
    let liveMass = 0
    for (let r = 0; r <= runCap; r += 1) {
      for (let o = 0; o < MAX_OUTS; o += 1) {
        for (let b = 0; b < BASE_STATE_COUNT; b += 1) {
          const mass = live[index(b, o, r)]
          if (mass <= RESIDUAL_EPSILON) continue
          liveMass += mass
          for (let k = 0; k < OUTCOME_KEYS.length; k += 1) {
            const key = OUTCOME_KEYS[k]
            const p = probs[key]
            if (!(p > 0)) continue
            const branches = transitions[b][key]
            for (let t = 0; t < branches.length; t += 1) {
              const [nextBase, scored, outsAdded, weight] = branches[t]
              const flow = mass * p * weight
              if (flow <= RESIDUAL_EPSILON) continue
              let nextRuns = r + scored
              if (nextRuns > runCap) {
                truncatedRunMass += flow
                nextRuns = runCap
              }
              if (scored > 0) crossings[r][nextRuns] += flow
              const nextOuts = o + outsAdded
              if (nextOuts >= MAX_OUTS) {
                runs[nextRuns] += flow
                batters[step + 1] += flow
              } else {
                next[index(nextBase, nextOuts, nextRuns)] += flow
              }
            }
          }
        }
      }
    }
    if (liveMass <= RESIDUAL_EPSILON) break
    live = next
  }

  let residual = 0
  for (let i = 0; i < stateCount; i += 1) residual += live[i]

  return { runs, batters, crossings, residual, truncatedRunMass, maxRuns: runCap, steps: step }
}

// The stopped distribution for a walk-off threshold, read out of a single
// unstopped pass. `threshold` is the number of runs that ends the half inning
// (the home team needs deficit + 1 to go ahead); null means "play it out".
export function stoppedRunDistribution(halfDistribution, threshold = null) {
  const { runs, crossings, maxRuns } = halfDistribution
  if (threshold == null || threshold > maxRuns) return runs
  const target = Math.max(1, Math.trunc(threshold))
  const stopped = new Float64Array(maxRuns + 1)
  for (let v = 0; v < target && v <= maxRuns; v += 1) stopped[v] += runs[v]
  for (let before = 0; before < target; before += 1) {
    const row = crossings[before]
    for (let after = target; after <= maxRuns; after += 1) {
      if (row[after] > 0) stopped[after] += row[after]
    }
  }
  return stopped
}

function halfInningCacheKey(probs, baseState, outs, maxRuns, advanceParams) {
  return [
    probs.out.toFixed(7), probs.walk.toFixed(7), probs.single.toFixed(7),
    probs.double.toFixed(7), probs.triple.toFixed(7), probs.homeRun.toFixed(7),
    baseState, outs, maxRuns,
    Number(advanceParams.runnerScoresFromSecondOnSingle || 0).toFixed(4),
    Number(advanceParams.runnerScoresFromFirstOnDouble || 0).toFixed(4),
  ].join('|')
}

export function createHalfInningCache() {
  const store = new Map()
  return {
    get(outcomeProbs, options = {}) {
      const probs = normalizeOutcomeProbabilities(outcomeProbs)
      const baseState = (options.baseState || 0) & 7
      const outs = Math.min(Math.max(0, Number(options.outs || 0)), MAX_OUTS - 1)
      const maxRuns = Math.max(1, Math.trunc(options.maxRuns ?? DEFAULT_MAX_RUNS_PER_HALF))
      const advanceParams = options.advanceParams || DEFAULT_ADVANCE_PARAMS
      const key = halfInningCacheKey(probs, baseState, outs, maxRuns, advanceParams)
      const cached = store.get(key)
      if (cached) return cached
      const built = halfInningDistribution(probs, { baseState, outs, maxRuns, advanceParams })
      store.set(key, built)
      return built
    },
    get size() { return store.size },
  }
}

/**
 * The joint distribution of (runs the away team still adds, runs the home team
 * still adds), advanced half inning by half inning under the game's real ending
 * rules, and the market probabilities that fall out of it.
 *
 * `homeBatsSecond` is the betting sense of "home" — team B — which is the side
 * settlement grades as home. A game with `home_away_swapped` set has team B
 * batting in the TOP of each inning, so it does not get last licks; passing
 * `homeBatsSecond: false` models that correctly.
 */
export function buildGameDistribution({
  awayOutcomeProbs,
  homeOutcomeProbs,
  regulationInnings = 3,
  mercyEnabled = true,
  mercyDifferential = 10,
  currentInning = 1,
  isTopHalf = true,
  outs = 0,
  baseState = 0,
  awayScore = 0,
  homeScore = 0,
  homeBatsSecond = true,
  gameComplete = false,
  maxRunsPerSide = DEFAULT_MAX_RUNS_PER_SIDE,
  maxRunsPerHalf = DEFAULT_MAX_RUNS_PER_HALF,
  maxExtraInnings = DEFAULT_MAX_EXTRA_INNINGS,
  advanceParams = DEFAULT_ADVANCE_PARAMS,
  cache = null,
} = {}) {
  const halfCache = cache || createHalfInningCache()
  const stride = Math.max(1, Math.trunc(maxRunsPerSide)) + 1
  const cells = stride * stride
  const startAway = Math.max(0, Math.trunc(Number(awayScore || 0)))
  const startHome = Math.max(0, Math.trunc(Number(homeScore || 0)))
  const regulation = Math.max(1, Math.trunc(Number(regulationInnings || 1)))
  const mercyLimit = mercyEnabled ? Math.max(1, Math.trunc(Number(mercyDifferential || 10))) : Number.POSITIVE_INFINITY

  const final = new Float64Array(cells)
  let live = new Float64Array(cells)
  live[0] = 1

  const halvesPlayed = []
  let unresolved = 0
  let truncationMass = 0

  if (gameComplete) {
    final[0] = 1
    return summarizeDistribution({
      final, live: new Float64Array(cells), stride, startAway, startHome,
      unresolved: 0, truncationMass: 0, halvesPlayed, halfInningRuns: [], gameComplete: true,
    })
  }

  // Which betting side bats in each half. `bottomSide` is the side with last
  // licks and is the one the game-ending rules are written around.
  const topSide = homeBatsSecond ? 'away' : 'home'
  const bottomSide = homeBatsSecond ? 'home' : 'away'

  const scoreOf = (side, away, home) => (side === 'away' ? startAway + away : startHome + home)

  const maxInning = regulation + Math.max(0, Math.trunc(maxExtraInnings))
  let inning = Math.max(1, Math.trunc(Number(currentInning || 1)))
  let top = Boolean(isTopHalf)
  let firstHalf = true
  const halfInningRuns = []

  while (inning <= maxInning) {
    const side = top ? topSide : bottomSide
    const outcomeProbs = side === 'away' ? awayOutcomeProbs : homeOutcomeProbs
    const startBase = firstHalf ? (baseState & 7) : 0
    const startOuts = firstHalf ? Math.min(Math.max(0, Math.trunc(Number(outs || 0))), MAX_OUTS - 1) : 0
    const halfDist = halfCache.get(outcomeProbs, {
      baseState: startBase, outs: startOuts, maxRuns: maxRunsPerHalf, advanceParams,
    })
    truncationMass += halfDist.residual + halfDist.truncatedRunMass

    const walkOffPossible = !top && inning >= regulation
    // One stopped distribution per distinct walk-off threshold, not per cell:
    // the deficit repeats across the whole grid.
    const stoppedByThreshold = new Map()
    const next = new Float64Array(cells)
    let playedMass = 0

    for (let away = 0; away < stride; away += 1) {
      for (let home = 0; home < stride; home += 1) {
        const mass = live[away * stride + home]
        if (mass <= RESIDUAL_EPSILON) continue
        const bottomScore = scoreOf(bottomSide, away, home)
        const topScore = scoreOf(topSide, away, home)

        // The side with last licks does not bat an unnecessary final half.
        if (!top && inning >= regulation && bottomScore > topScore) {
          final[away * stride + home] += mass
          continue
        }

        playedMass += mass
        const threshold = walkOffPossible ? (topScore - bottomScore) + 1 : null
        let runDist = halfDist.runs
        if (threshold != null && threshold <= maxRunsPerHalf) {
          const cached = stoppedByThreshold.get(threshold)
          if (cached) {
            runDist = cached
          } else {
            runDist = stoppedRunDistribution(halfDist, threshold)
            stoppedByThreshold.set(threshold, runDist)
          }
        }

        for (let v = 0; v < runDist.length; v += 1) {
          const p = runDist[v]
          if (p <= RESIDUAL_EPSILON) continue
          const flow = mass * p
          if (side === 'away') {
            const nextAway = away + v
            if (nextAway >= stride) truncationMass += flow
            next[Math.min(stride - 1, nextAway) * stride + home] += flow
          } else {
            const nextHome = home + v
            if (nextHome >= stride) truncationMass += flow
            next[away * stride + Math.min(stride - 1, nextHome)] += flow
          }
        }
      }
    }

    halvesPlayed.push({ inning, isTop: top, side, playProbability: playedMass })
    if (inning === 1) halfInningRuns.push({ isTop: top, distribution: halfDist.runs, playProbability: playedMass, side })

    // End-of-half checks, in the same order the scorebook applies them.
    live = next
    for (let away = 0; away < stride; away += 1) {
      for (let home = 0; home < stride; home += 1) {
        const idx = away * stride + home
        const mass = live[idx]
        if (mass <= RESIDUAL_EPSILON) {
          if (mass > 0) { final[idx] += mass; live[idx] = 0 }
          continue
        }
        const bottomScore = scoreOf(bottomSide, away, home)
        const topScore = scoreOf(topSide, away, home)
        const differential = Math.abs(bottomScore - topScore)
        let over = false
        if (top) {
          // The bottom side already leads after the top of a final-or-later
          // inning: it never bats, so the game is over.
          if (inning >= regulation && bottomScore > topScore) over = true
        } else {
          if (differential >= mercyLimit) over = true
          else if (inning >= regulation && bottomScore !== topScore) over = true
        }
        if (over) {
          final[idx] += mass
          live[idx] = 0
        }
      }
    }

    firstHalf = false
    if (top) { top = false } else { top = true; inning += 1 }

    let remaining = 0
    for (let i = 0; i < cells; i += 1) remaining += live[i]
    if (remaining <= RESIDUAL_EPSILON) break
  }

  for (let i = 0; i < cells; i += 1) unresolved += live[i]

  return summarizeDistribution({
    final, live, stride, startAway, startHome, unresolved, truncationMass,
    halvesPlayed, halfInningRuns, gameComplete: false,
  })
}

function summarizeDistribution({
  final, live, stride, startAway, startHome, unresolved, truncationMass,
  halvesPlayed, halfInningRuns, gameComplete,
}) {
  const maxAdded = stride - 1
  const maxTotal = startAway + startHome + (2 * maxAdded)
  const totalDistribution = new Float64Array(maxTotal + 1)
  const marginOffset = startHome + maxAdded
  const marginDistribution = new Float64Array((2 * marginOffset) + 1)
  const awayFinalDistribution = new Float64Array(startAway + maxAdded + 1)
  const homeFinalDistribution = new Float64Array(startHome + maxAdded + 1)

  let resolvedMass = 0
  let homeWin = 0
  let awayWin = 0
  let tie = 0

  for (let away = 0; away <= maxAdded; away += 1) {
    for (let home = 0; home <= maxAdded; home += 1) {
      const mass = final[away * stride + home]
      if (mass <= 0) continue
      resolvedMass += mass
      const awayFinal = startAway + away
      const homeFinal = startHome + home
      totalDistribution[awayFinal + homeFinal] += mass
      marginDistribution[(homeFinal - awayFinal) + marginOffset] += mass
      awayFinalDistribution[awayFinal] += mass
      homeFinalDistribution[homeFinal] += mass
      if (homeFinal > awayFinal) homeWin += mass
      else if (homeFinal < awayFinal) awayWin += mass
      else tie += mass
    }
  }

  return {
    gameComplete,
    resolvedMass,
    unresolvedMass: unresolved,
    truncationMass,
    homeWinProbability: homeWin,
    awayWinProbability: awayWin,
    tieProbability: tie,
    totalDistribution,
    marginDistribution,
    marginOffset,
    awayFinalDistribution,
    homeFinalDistribution,
    startAway,
    startHome,
    halvesPlayed,
    halfInningRuns,
    liveMass: live,
    stride,
  }
}

// P(home final − away final > spread), P(= spread), P(< spread) — the exact
// three-way split the run-line settlement rule needs. `spread` is applied to
// the home team, which is how `betResolution.js` grades it: home covers when
// home WINS by more than the spread, and the away side covers otherwise.
export function marginProbabilities(distribution, spread) {
  const { marginDistribution, marginOffset } = distribution
  const numeric = Number(spread || 0)
  let over = 0
  let push = 0
  let under = 0
  for (let i = 0; i < marginDistribution.length; i += 1) {
    const mass = marginDistribution[i]
    if (mass <= 0) continue
    const margin = i - marginOffset
    if (margin > numeric) over += mass
    else if (margin === numeric) push += mass
    else under += mass
  }
  return { over, push, under }
}

export function totalProbabilities(distribution, line) {
  const { totalDistribution } = distribution
  const numeric = Number(line || 0)
  let over = 0
  let push = 0
  let under = 0
  for (let i = 0; i < totalDistribution.length; i += 1) {
    const mass = totalDistribution[i]
    if (mass <= 0) continue
    if (i > numeric) over += mass
    else if (i === numeric) push += mass
    else under += mass
  }
  return { over, push, under }
}

// P(at least one run in inning 1). `recordedFirstInningRuns` is what the game
// has already produced, and `inningOneComplete` says the window is closed — a
// determined outcome is returned as exactly 0 or 1 so the caller can close the
// market rather than quote a probability for something already known.
export function firstInningRunProbability(distribution, {
  recordedFirstInningRuns = 0,
  inningOneComplete = false,
} = {}) {
  if (Number(recordedFirstInningRuns || 0) > 0) return { probability: 1, determined: true }
  if (inningOneComplete) return { probability: 0, determined: true }

  const halves = distribution.halfInningRuns || []
  if (!halves.length) return { probability: null, determined: false }

  let noRun = 1
  halves.forEach((half) => {
    const playProbability = Math.min(1, Math.max(0, Number(half.playProbability ?? 1)))
    const scoreless = half.distribution?.[0] ?? 1
    // A half that is never played contributes no runs.
    noRun *= (playProbability * scoreless) + (1 - playProbability)
  })
  return { probability: Math.min(1, Math.max(0, 1 - noRun)), determined: false }
}

// The distribution of how many more plate appearances a side gets, built from
// the same half-inning chain. Each remaining half contributes its batter
// distribution with the probability that half is actually played.
export function remainingPlateAppearanceDistribution({
  outcomeProbs,
  distribution,
  side,
  maxPlateAppearances = 60,
  maxRunsPerHalf = DEFAULT_MAX_RUNS_PER_HALF,
  advanceParams = DEFAULT_ADVANCE_PARAMS,
  cache = null,
  baseState = 0,
  outs = 0,
}) {
  const halfCache = cache || createHalfInningCache()
  const halves = (distribution.halvesPlayed || []).filter((half) => half.side === side)
  let result = new Float64Array(maxPlateAppearances + 1)
  result[0] = 1

  halves.forEach((half, index) => {
    const playProbability = Math.min(1, Math.max(0, Number(half.playProbability ?? 0)))
    if (playProbability <= 0) return
    const halfDist = halfCache.get(outcomeProbs, {
      baseState: index === 0 ? (baseState & 7) : 0,
      outs: index === 0 ? Math.min(Math.max(0, outs), MAX_OUTS - 1) : 0,
      maxRuns: maxRunsPerHalf,
      advanceParams,
    })
    const next = new Float64Array(maxPlateAppearances + 1)
    for (let existing = 0; existing <= maxPlateAppearances; existing += 1) {
      const mass = result[existing]
      if (mass <= RESIDUAL_EPSILON) continue
      next[existing] += mass * (1 - playProbability)
      for (let batters = 0; batters < halfDist.batters.length; batters += 1) {
        const p = halfDist.batters[batters]
        if (p <= RESIDUAL_EPSILON) continue
        next[Math.min(maxPlateAppearances, existing + batters)] += mass * playProbability * p
      }
    }
    result = next
  })

  return result
}
