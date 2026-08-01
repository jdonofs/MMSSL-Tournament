import { STADIUM_CONFIGS, getFielderFieldSpot, estimateHitDistance, estimateHitAngle } from '../components/FieldPlayBuilder'

// Range Runs: how far/fast a fielder had to travel from their standard position to reach a
// batted ball, difficulty-adjusted against the league's out rate on plays of similar difficulty.
// Distinct from the error-only Fielding %+ (see buildPerGameFieldingEntries in
// statsCalculator.js), which has no concept of how hard a chance was to get to in the first
// place. Only ever applies to the first fielder to touch a batted ball (index 0 of the fielder
// chain): later fielders in a chain are just receiving a throw, not ranging for the original hit.
//
// Every character starts each play from the same generic position marker (getFielderFieldSpot) —
// there's no in-game shifting to account for, so that "standard spot" is always the right
// baseline to range from, not an approximation to apologize for.
//
// Difficulty is graded into three confidence tiers depending on what was actually recorded for
// that play, from best to weakest signal:
//   'timed'    — hang_time_sec is known, so difficulty = feet-per-second the fielder needed to
//                cover (distance / time) — the truest read on how hard a play was.
//   'measured' — fielded_x/fielded_y is known (where the ball was actually secured, which can
//                differ from where it landed — grounders that roll, relayed catches) but no hang
//                time, so difficulty = feet from the standard spot to that actual fielding point.
//   'distance' — neither of the above; falls back to feet from the standard spot to hit_x/hit_y
//                (where the ball landed/was first touched).
// Each tier is its own unit (ft/sec vs ft) and gets its own league baseline — ft and ft/sec are
// never bucketed together. hang_time_sec and fielded_x/fielded_y are sparse today (both are
// backfilled from film after the fact), so most chances land in 'distance' — but nothing here
// hardcodes that; as more games get hang time/fielded-location entered, chances shift into the
// higher-confidence tiers on their own and the league baselines (and per-player Range Runs) get
// more precise without any formula changes.

const polarCache = new Map()

// Distance (ft) + angle (deg, 0 = straightaway CF) of a position's standard field marker for a
// given stadium, from home plate — same geometry conversion used to derive hit_distance_ft/
// hit_angle_deg from a tapped spot.
function getStandardPositionPolar(position, stadiumKey) {
  const cacheKey = `${stadiumKey || 'default'}:${position}`
  if (polarCache.has(cacheKey)) return polarCache.get(cacheKey)
  const config = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
  const spot = getFielderFieldSpot(position, config)
  const result = spot && config
    ? { distanceFt: estimateHitDistance(spot, config), angleDeg: estimateHitAngle(spot, config) }
    : null
  polarCache.set(cacheKey, result)
  return result
}

// Straight-line feet between a fielder's standard spot and a point (distance/angle from home,
// same units as hit_distance_ft/hit_angle_deg), via the law of cosines on the two polar
// coordinates. Null if the standard spot can't be resolved (unknown stadium key/position).
function distanceFromStandardSpot(position, stadiumKey, pointDistanceFt, pointAngleDeg) {
  const standard = getStandardPositionPolar(position, stadiumKey)
  if (!standard || standard.distanceFt == null || standard.angleDeg == null) return null
  const d1 = standard.distanceFt
  const d2 = Number(pointDistanceFt)
  const angleDiffRad = ((Number(pointAngleDeg) - standard.angleDeg) * Math.PI) / 180
  const squared = (d1 * d1) + (d2 * d2) - (2 * d1 * d2 * Math.cos(angleDiffRad))
  return Math.sqrt(Math.max(0, squared))
}

// Scorebook.jsx falls back to a fielder's own generic field marker as the "landing spot"
// (hit_x/hit_y/hit_distance_ft/hit_angle_deg) when a play is scored without a live tap — for
// those rows the landing spot IS the standard spot by construction, so distanceFromStandardSpot
// comes out ~0. That's indistinguishable from a genuinely stand-still routine play, and roughly
// half of all location-bearing rows are this fallback (not a real tap) — so any 'distance'-tier
// result under this floor is treated as "no real location data" rather than "zero range needed."
// fielded_x/fielded_y has no such fallback (migration 065: only ever captured when a play
// genuinely diverges from the landing spot), so the 'measured' tier doesn't need this filter.
const MIN_REAL_LANDING_DISTANCE_FT = 3

// Best available difficulty signal for one first-touch fielding chance. Returns
// { tier: 'timed'|'measured'|'distance', value, distanceFt } or null if nothing usable was
// recorded for this play.
export function computeDifficultySignal(position, stadiumKey, {
  hitDistanceFt = null, hitAngleDeg = null, fieldedX = null, fieldedY = null, hangTimeSec = null, fieldedTimeSec = null,
} = {}) {
  if (position == null || !stadiumKey) return null
  const config = STADIUM_CONFIGS[stadiumKey]
  if (!config) return null

  let distanceFt = null
  let source = null
  if (fieldedX != null && fieldedY != null) {
    const spot = { x: Number(fieldedX), y: Number(fieldedY) }
    const fDist = estimateHitDistance(spot, config)
    const fAngle = estimateHitAngle(spot, config)
    if (fDist != null && fAngle != null) {
      const d = distanceFromStandardSpot(position, stadiumKey, fDist, fAngle)
      if (d != null) { distanceFt = d; source = 'measured' }
    }
  }
  if (distanceFt == null && hitDistanceFt != null && hitAngleDeg != null) {
    const d = distanceFromStandardSpot(position, stadiumKey, hitDistanceFt, hitAngleDeg)
    if (d != null && d >= MIN_REAL_LANDING_DISTANCE_FT) { distanceFt = d; source = 'distance' }
  }
  if (distanceFt == null) return null

  // fieldedTimeSec (contact -> fielded_video_sec) is the fielder's actual elapsed time to the
  // measured spot above — only meaningful paired with that same 'measured' distance, so it's
  // checked first and only trusted when that's the distance source. hangTimeSec (contact ->
  // landed_video_sec) is the general fallback: exactly right for a caught fly/liner (landed IS
  // fielded) or a grounder (its "Mark Fielded" button writes landed_video_sec directly), but for
  // a landed-and-retrieved-elsewhere play it's the wrong clock for the 'measured' distance above,
  // which is why fieldedTimeSec takes priority whenever both exist.
  if (source === 'measured') {
    const fieldedTime = fieldedTimeSec != null ? Number(fieldedTimeSec) : null
    if (fieldedTime != null && Number.isFinite(fieldedTime) && fieldedTime > 0) {
      return { tier: 'timed', value: distanceFt / fieldedTime, distanceFt }
    }
  }
  const hangTime = hangTimeSec != null ? Number(hangTimeSec) : null
  if (hangTime != null && Number.isFinite(hangTime) && hangTime > 0) {
    return { tier: 'timed', value: distanceFt / hangTime, distanceFt }
  }
  return { tier: source, value: distanceFt, distanceFt }
}

// Approximate runs value of converting one fielding chance into an out vs. not — in the same
// ballpark as sabermetric out-value estimates (~0.75-0.85 runs). Not derived from this league's
// own run environment since that would require full base/out state run expectancy, which isn't
// tracked; kept as a single documented constant instead.
export const RANGE_RUN_VALUE = 0.8

// Chances need this many rangeable (non-null difficulty signal) plays at a position before a
// Range Runs number is shown for it — matches the spirit of MIN_FIELDING_CHANCES_PER_GAME
// elsewhere: too few plays makes the tercile bucketing below meaningless noise.
export const MIN_RANGE_CHANCES = 8

// A tier/position group needs at least this many samples before it's confident enough to split
// into three difficulty terciles — below that, everything in the group shares one flat average
// conversion rate instead of three noisy ones. Purely a function of how much data has accumulated
// (no tuning knob to touch as hang_time_sec/fielded_x backfill grows the 'timed'/'measured'
// samples over time) — the split upgrades itself once there's enough to support it.
const MIN_TERCILE_SAMPLES = 15

function computeTercileCutoffs(values = []) {
  if (values.length < MIN_TERCILE_SAMPLES) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return [at(1 / 3), at(2 / 3)]
}

function tierBucket(value, cutoffs) {
  if (!cutoffs) return 0
  if (value <= cutoffs[0]) return 0
  if (value <= cutoffs[1]) return 1
  return 2
}

const DIFFICULTY_TIERS = ['timed', 'measured', 'distance']

// League-wide baseline, keyed by position then difficulty tier: the value terciles (or one flat
// bucket under MIN_TERCILE_SAMPLES) and the league's actual conversion rate (chance became a
// putout/assist for the fielder who ranged for it) within each. Computed from the FULL chances
// list (every character, every position) before any per-character filtering — same ordering as
// computeFieldingLeagueConstants.
export function computeRangeLeagueConstants(allChances = []) {
  const byPosition = {}
  const grouped = {}
  allChances.forEach((c) => {
    if (c.isBuddyJump || !c.difficulty) return
    const key = c.position
    if (!grouped[key]) grouped[key] = {}
    if (!grouped[key][c.difficulty.tier]) grouped[key][c.difficulty.tier] = []
    grouped[key][c.difficulty.tier].push(c)
  })
  Object.entries(grouped).forEach(([position, byTier]) => {
    byPosition[position] = {}
    DIFFICULTY_TIERS.forEach((tier) => {
      const chances = byTier[tier]
      if (!chances || !chances.length) return
      const cutoffs = computeTercileCutoffs(chances.map((c) => c.difficulty.value))
      const tierTotals = [0, 0, 0]
      const tierConverted = [0, 0, 0]
      chances.forEach((c) => {
        const bucket = tierBucket(c.difficulty.value, cutoffs)
        tierTotals[bucket] += 1
        if (c.isPutout || c.isAssist) tierConverted[bucket] += 1
      })
      byPosition[position][tier] = {
        cutoffs,
        bucketRates: tierTotals.map((total, i) => (total ? tierConverted[i] / total : null)),
        sampleSize: chances.length,
      }
    })
  })
  return { byPosition }
}

// Relative weight of each tier toward a player's overall Range Runs confidence score (0-100) —
// how much of their rangeable sample came from the strongest signal vs. the weakest. Purely
// descriptive (doesn't affect the runs/rate math, which already blends tiers via each chance's
// own baseline) — lets a "Confidence" figure be shown next to the number itself.
const TIER_CONFIDENCE_WEIGHT = { timed: 1, measured: 0.7, distance: 0.4 }

function confidenceForChances(chances = []) {
  if (!chances.length) return null
  const total = chances.reduce((sum, c) => sum + (TIER_CONFIDENCE_WEIGHT[c.difficulty?.tier] || 0), 0)
  return Math.round((total / chances.length) * 100)
}

// Per-character Range Runs, rolled up by position (only the first fielder in a chain carries a
// difficulty signal, so this is naturally scoped to range-relevant chances only — relay/
// assist-only touches are excluded). Each chance is judged against its own tier's baseline, so a
// position's number is a blend across however much 'timed'/'measured'/'distance' data exists —
// and automatically leans more on the stronger tiers as that data grows.
export function summarizeFieldingRange(chances = [], rangeLeagueConstants = { byPosition: {} }) {
  const grouped = {}
  chances.forEach((c) => {
    if (c.isBuddyJump || !c.difficulty) return
    if (!grouped[c.position]) grouped[c.position] = []
    grouped[c.position].push(c)
  })

  const positions = Object.entries(grouped).map(([position, posChances]) => {
    const baselineByTier = rangeLeagueConstants.byPosition?.[position] || {}
    let expectedConversions = 0
    let actualConversions = 0
    const tierCounts = { timed: 0, measured: 0, distance: 0 }
    posChances.forEach((c) => {
      const tier = c.difficulty.tier
      tierCounts[tier] = (tierCounts[tier] || 0) + 1
      const baseline = baselineByTier[tier]
      const bucket = baseline ? tierBucket(c.difficulty.value, baseline.cutoffs) : null
      const bucketRate = baseline?.bucketRates?.[bucket]
      if (bucketRate != null) expectedConversions += bucketRate
      if (c.isPutout || c.isAssist) actualConversions += 1
    })
    const chances_ = posChances.length
    const qualifies = chances_ >= MIN_RANGE_CHANCES
    const rangeRuns = qualifies ? (actualConversions - expectedConversions) * RANGE_RUN_VALUE : null
    const rangeFactorPlus = qualifies && expectedConversions > 0
      ? Math.round((actualConversions / expectedConversions) * 1000) / 10
      : null
    return {
      position,
      chances: chances_,
      actualConversions,
      expectedConversions: Math.round(expectedConversions * 100) / 100,
      rangeRuns: rangeRuns != null ? Math.round(rangeRuns * 100) / 100 : null,
      rangeFactorPlus,
      qualifies,
      tierCounts,
      confidence: confidenceForChances(posChances),
    }
  }).sort((a, b) => b.chances - a.chances)

  // Cross-position totals — for flat, single-row tables (Stats.jsx league leaderboards,
  // TeamPage's roster table) that don't break a player out by position. Actual/expected are
  // summed across EVERY position (not gated by each position's own `qualifies`), then the total
  // itself is gated by MIN_RANGE_CHANCES — a player with 4 rangeable chances at two different
  // positions still gets one blended number instead of two too-small-to-show ones.
  const allRangeableChances = Object.values(grouped).flat()
  const totalRangeable = allRangeableChances.length
  const totalActualConversions = positions.reduce((sum, p) => sum + p.actualConversions, 0)
  const totalExpectedConversions = positions.reduce((sum, p) => sum + p.expectedConversions, 0)
  const totalQualifies = totalRangeable >= MIN_RANGE_CHANCES
  const totalRangeRunsRaw = totalQualifies ? (totalActualConversions - totalExpectedConversions) * RANGE_RUN_VALUE : null
  return {
    positions,
    totalRangeable,
    totalRangeRuns: totalRangeRunsRaw != null ? Math.round(totalRangeRunsRaw * 100) / 100 : null,
    rangeFactorPlus: totalQualifies && totalExpectedConversions > 0
      ? Math.round((totalActualConversions / totalExpectedConversions) * 1000) / 10
      : null,
    confidence: confidenceForChances(allRangeableChances),
    qualifies: totalQualifies,
  }
}
