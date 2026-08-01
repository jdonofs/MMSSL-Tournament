// Statcast-style expected stats (xBA/xSLG/xwOBA): the likelihood/value a batted
// ball "should" have produced based on comparable contact quality, independent
// of what actually happened to it (a squared-up line drive right at a fielder
// reads as a poorly-performing out but a well-earned xBA).
//
// MLB derives this from millions of historical batted balls binned by exit
// velocity/launch angle. We don't have that population, so instead this builds
// the same kind of lookup from this league's own batted-ball history: for a
// given (EV, LA), it takes a similarity-weighted average of the ACTUAL outcomes
// of every other recorded batted ball in the league, weighted by how close
// their EV/LA are to the one being estimated (a Gaussian kernel, not a fixed
// grid, since our sample sizes are far too small for MLB-style discrete bins).
import { hitResults, isOfficialAtBat } from './statsCalculator'

const EV_BANDWIDTH_MPH = 6
const LA_BANDWIDTH_DEG = 8
const WOBA_WEIGHTS = { '1B': 0.89, '2B': 1.27, '3B': 1.62, HR: 2.10, IPHR: 2.10 }
const TOTAL_BASES = { '1B': 1, '2B': 2, '3B': 3, HR: 4, IPHR: 4 }

function battedBallOutcome(pa) {
  const result = pa.result
  return {
    isHit: hitResults.has(result) ? 1 : 0,
    totalBases: TOTAL_BASES[result] || 0,
    wobaValue: WOBA_WEIGHTS[result] || 0,
  }
}

function withEvLa(pas = []) {
  return pas.filter((pa) => (
    pa && !pa.star_hit_used && pa.exit_velocity_mph != null && pa.launch_angle_deg != null &&
    Number.isFinite(Number(pa.exit_velocity_mph)) && Number.isFinite(Number(pa.launch_angle_deg))
  ))
}

// Builds a reusable model from the league's full batted-ball history. Pass the
// same model into summarizeExpectedBatting for every player/character to avoid
// rebuilding the (potentially large) league sample per row.
export function buildExpectedOutcomeModel(leagueBattedBalls = []) {
  const pool = withEvLa(leagueBattedBalls).map((pa) => ({
    ev: Number(pa.exit_velocity_mph),
    la: Number(pa.launch_angle_deg),
    outcome: battedBallOutcome(pa),
  }))

  function estimate(ev, la) {
    if (pool.length === 0) return null
    let weightSum = 0
    let hitSum = 0
    let basesSum = 0
    let wobaSum = 0
    for (const point of pool) {
      const dEv = (ev - point.ev) / EV_BANDWIDTH_MPH
      const dLa = (la - point.la) / LA_BANDWIDTH_DEG
      const weight = Math.exp(-0.5 * (dEv * dEv + dLa * dLa))
      if (weight < 1e-6) continue
      weightSum += weight
      hitSum += weight * point.outcome.isHit
      basesSum += weight * point.outcome.totalBases
      wobaSum += weight * point.outcome.wobaValue
    }
    if (weightSum === 0) return null
    return {
      xHitProb: hitSum / weightSum,
      xTotalBases: basesSum / weightSum,
      xWobaValue: wobaSum / weightSum,
    }
  }

  return { estimate, sampleSize: pool.length }
}

// Blends expected-value estimates for batted balls with actual outcomes for
// everything else (walks, HBP, strikeouts, sac flies) using the same formula
// shapes as summarizeAdvancedBatting, so xBA/xSLG/xwOBA sit on the same scale
// as the real AVG/SLG/wOBA they're meant to be compared against.
export function summarizeExpectedBatting(rawPlateAppearances = [], model) {
  if (!model || model.sampleSize === 0) {
    return { sampleSize: 0, xBA: null, xSLG: null, xwOBA: null, xwobaDiff: null }
  }

  const plateAppearances = rawPlateAppearances

  const abs = plateAppearances.filter((pa) => isOfficialAtBat(pa)).length
  const walks = plateAppearances.filter((pa) => pa.result === 'BB').length
  const hbp = plateAppearances.filter((pa) => pa.result === 'HBP').length
  const sfs = plateAppearances.filter((pa) => pa.result === 'SF').length
  const wobaDenom = abs + walks + sfs + hbp

  let xHitTotal = 0
  let xBasesTotal = 0
  let xWobaTotal = (0.69 * walks) + (0.72 * hbp)
  let evaluatedBattedBalls = 0

  plateAppearances.forEach((pa) => {
    if (!isOfficialAtBat(pa)) return
    if (pa.result === 'K') return // automatic out, no batted-ball estimate applies

    // Star hits force their outcome (guaranteed contact/error) independent of
    // how well the ball was actually struck, so their EV/LA says nothing about
    // contact quality — skip the model estimate and count them by actual result,
    // same as AVG does, so they stay in both stats' denominators.
    const hasEvLa = !pa.star_hit_used && pa.exit_velocity_mph != null && pa.launch_angle_deg != null &&
      Number.isFinite(Number(pa.exit_velocity_mph)) && Number.isFinite(Number(pa.launch_angle_deg))

    if (hasEvLa) {
      const est = model.estimate(Number(pa.exit_velocity_mph), Number(pa.launch_angle_deg))
      if (est) {
        xHitTotal += est.xHitProb
        xBasesTotal += est.xTotalBases
        xWobaTotal += est.xWobaValue
        evaluatedBattedBalls += 1
        return
      }
    }

    // No usable EV/LA (legacy row, star hit, or a walk/HBP/SF already excluded above) —
    // fall back to the actual result so it isn't silently dropped from the total.
    const isHit = hitResults.has(pa.result) ? 1 : 0
    xHitTotal += isHit
    xBasesTotal += TOTAL_BASES[pa.result] || 0
    xWobaTotal += WOBA_WEIGHTS[pa.result] || 0
  })

  const xBA = abs ? xHitTotal / abs : null
  const xSLG = abs ? xBasesTotal / abs : null
  const xwOBA = wobaDenom ? xWobaTotal / wobaDenom : null

  return {
    sampleSize: evaluatedBattedBalls,
    xBA: xBA != null ? Math.round(xBA * 1000) / 1000 : null,
    xSLG: xSLG != null ? Math.round(xSLG * 1000) / 1000 : null,
    xwOBA: xwOBA != null ? Math.round(xwOBA * 1000) / 1000 : null,
  }
}
