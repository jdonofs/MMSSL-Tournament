// Draft value: how much a team got out of a draft pick relative to where it was
// drafted. "Actual value" is deliberately NOT analyzeCharacterTalent's trueValue —
// that rating is intentionally talent-first (real performance can only nudge it by
// up to ~18% weight, see HISTORY_WEIGHT_CAP in characterAnalysis.js), which is right
// for "how good is this character overall" but wrong for "what did this pick actually
// produce." Here it's the reverse: real stats (wRC+ for batting, FIP- for pitching)
// dominate once there's a real sample, blended against the character's zero-history
// talent score only as a small-sample shrinkage anchor — a pick with no games played
// yet (an in-progress draft, or a season/tournament that just started) reads as pure
// talent, then shifts almost entirely to real performance as PAs/innings accumulate.
// "Expected value" is the average actual value realized by every other pick made at
// that exact pick number, so a late-round steal or an early-round bust shows up as a
// surplus/deficit against what that slot has historically produced. Season and
// tournament drafts are pooled separately since a "pick #5" means a different thing
// in each format (different team counts, snake order, etc).
import { outsFromInningsPitched, summarizeAdvancedBatting, summarizeAdvancedPitching } from './statsCalculator'
import { analyzeCharacterTalent } from './characterAnalysis'

// Sample size (in PAs / outs) needed to reach full confidence in the real-performance
// signal. Matches characterAnalysis.js's HISTORY_PA_SCALE (120)/PITCHING_OUTS_SCALE (60)
// rather than stabilizing faster than that: an earlier, lower version of these constants
// let a single small, extreme-variance stretch (e.g. ~10 IP of a new player's rough
// outings, where FIP- swings wildly) hit near-full confidence and blow a pick's actual
// value down toward its performance-weight floor. Real performance should still take
// over as PAs/innings accumulate, just not on a sample this small.
const BATTING_STABILIZATION_PA = 120
const PITCHING_STABILIZATION_OUTS = 60
// Outs accumulate slower than PAs, so weight them more per unit when blending batting
// and pitching sample confidence together — mirrors the 2x ratio between the two
// STABILIZATION constants above.
const OUTS_TO_PA_WEIGHT = 2
// Even at full sample confidence, keep a talent anchor so one small-but-"stabilized"
// hot/cold stretch can't swing a pick's grade as if it were a certainty.
const MAX_PERFORMANCE_WEIGHT = 0.75
// Maps a league-relative "-plus" index (100 = average) onto a 0-100 value scale roughly
// comparable to trueValue's range (TIER_REFERENCE_MEAN ≈ 57 in characterAnalysis.js).
const PERFORMANCE_SCALE_CENTER = 55
const PERFORMANCE_SCALE_SENSITIVITY = 0.6

function indexPlusToValueScale(indexPlus) {
  return Math.max(0, Math.min(100, PERFORMANCE_SCALE_CENTER + ((indexPlus - 100) * PERFORMANCE_SCALE_SENSITIVITY)))
}

function buildGameIdsByTournament(games = []) {
  const map = new Map()
  games.forEach((game) => {
    if (game.tournament_id == null) return
    const key = String(game.tournament_id)
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(String(game.id))
  })
  return map
}

// Normalizes draft_picks (tournament) + season_roster (season, once it carries
// round/pick_number/pick_in_round — see migration 054) into one pick shape.
export function buildUnifiedDraftPicks({ draftPicks = [], seasonRoster = [], seasonTeams = [], charactersByName = {} }) {
  const seasonTeamsById = Object.fromEntries(seasonTeams.map((t) => [t.id, t]))

  const tournamentPicks = draftPicks
    .filter((p) => p.character_id != null && p.pick_number != null)
    .map((p) => ({
      source: 'tournament',
      contextId: p.tournament_id,
      ownerId: p.player_id,
      characterId: p.character_id,
      round: p.round,
      pickNumber: p.pick_number,
      pickInRound: p.pick_in_round,
    }))

  const seasonPicks = seasonRoster
    .filter((r) => r.round != null && r.pick_number != null)
    .map((r) => {
      const team = seasonTeamsById[r.team_id]
      return {
        source: 'season',
        contextId: r.season_id,
        ownerId: team?.player_id ?? null,
        characterId: charactersByName[r.character_name]?.id ?? null,
        round: r.round,
        pickNumber: r.pick_number,
        pickInRound: r.pick_in_round,
      }
    })
    .filter((p) => p.characterId != null && p.ownerId != null)

  return [...tournamentPicks, ...seasonPicks]
}

// Actual value for one pick: a sample-size-weighted blend of real performance (only the
// PAs/innings this owner logged with this character in this pick's own season/tournament)
// and the character's zero-history talent score, so a pick with little or no data yet
// still reads as a sensible baseline instead of 0/null.
function computePickActualValue(pick, characters, ctx) {
  const character = characters.find((c) => c.id === pick.characterId)
  if (!character) return { actualValue: null, talentPrior: null }

  const talentPrior = analyzeCharacterTalent(character, [], [], [])?.trueValue
  if (talentPrior == null) return { actualValue: null, talentPrior: null }

  const gameIdsForTournament = pick.source === 'tournament' ? ctx.gameIdsByTournament.get(String(pick.contextId)) : null

  const battingPas = pick.source === 'season'
    ? ctx.seasonPas.filter((pa) => pa.character_id === pick.characterId
      && String(pa.player_id) === String(pick.ownerId)
      && String(pa.season_id) === String(pick.contextId))
    : ctx.tournamentPas.filter((pa) => pa.character_id === pick.characterId
      && String(pa.player_id) === String(pick.ownerId)
      && gameIdsForTournament?.has(String(pa.game_id)))

  const pitchingStints = pick.source === 'season'
    ? ctx.seasonStints.filter((s) => s.character_id === pick.characterId
      && String(s.player_id) === String(pick.ownerId)
      && String(s.season_id) === String(pick.contextId))
    : ctx.tournamentStints.filter((s) => s.character_id === pick.characterId
      && String(s.player_id) === String(pick.ownerId)
      && gameIdsForTournament?.has(String(s.game_id)))

  const paCount = battingPas.length
  const outs = pitchingStints.reduce((sum, s) => sum + outsFromInningsPitched(s.innings_pitched), 0)
  if (paCount === 0 && outs === 0) return { actualValue: talentPrior, talentPrior }

  const battingPerf = paCount > 0 ? indexPlusToValueScale(summarizeAdvancedBatting(battingPas, ctx.leagueConstants).wrcPlus) : null
  const pitchingPerf = outs > 0 ? indexPlusToValueScale(200 - summarizeAdvancedPitching(pitchingStints, ctx.leagueConstants).fipMinus) : null

  const battingUnits = paCount
  const pitchingUnits = outs * OUTS_TO_PA_WEIGHT
  const totalUnits = battingUnits + pitchingUnits
  const performanceScore = (
    ((battingPerf ?? 0) * battingUnits) + ((pitchingPerf ?? 0) * pitchingUnits)
  ) / totalUnits

  const stabilizationUnits = (BATTING_STABILIZATION_PA + (PITCHING_STABILIZATION_OUTS * OUTS_TO_PA_WEIGHT)) / 2
  const confidence = Math.min(1, totalUnits / stabilizationUnits)
  const performanceWeight = confidence * MAX_PERFORMANCE_WEIGHT

  const actualValue = (talentPrior * (1 - performanceWeight)) + (performanceScore * performanceWeight)
  return { actualValue, talentPrior }
}

// Fraction of `values` at or below `value` — same binary-search-free approach
// characterAnalysis.js uses for its S/A/B/C/D/F pool tiers, kept local here since
// that helper isn't exported.
function percentileOf(values, value) {
  if (!values.length) return 0.5
  const below = values.filter((v) => v <= value).length
  return below / values.length
}

function gradeFromPercentile(percentile) {
  if (percentile >= 0.95) return 'S'
  if (percentile >= 0.80) return 'A'
  if (percentile >= 0.50) return 'B'
  if (percentile >= 0.20) return 'C'
  if (percentile >= 0.05) return 'D'
  return 'F'
}

// Builds actual/expected/surplus/grade for every draft pick across the league.
// Returns a Map<ownerId, PickValueRow[]> so team pages can pull just their own rows.
export function buildDraftValueReport({
  draftPicks = [], seasonRoster = [], seasonTeams = [], characters = [],
  games = [], tournaments = [], seasons = [], players = [],
  seasonPas = [], seasonStints = [], tournamentPas = [], tournamentStints = [],
  leagueConstants = {},
}) {
  const charactersByName = Object.fromEntries(characters.map((c) => [c.name, c]))
  const charactersById = Object.fromEntries(characters.map((c) => [c.id, c]))
  const gameIdsByTournament = buildGameIdsByTournament(games)

  const ctx = { seasonPas, seasonStints, tournamentPas, tournamentStints, leagueConstants, gameIdsByTournament }

  const picks = buildUnifiedDraftPicks({ draftPicks, seasonRoster, seasonTeams, charactersByName })
    .map((pick) => ({ ...pick, ...computePickActualValue(pick, characters, ctx) }))
    .filter((pick) => pick.actualValue != null)

  // Expected value per exact pick number, kept separate per draft format. With few
  // drafts logged so far, a raw per-slot (or even per-round) average is mostly noise —
  // e.g. one lucky 4th-round steal can make round 4's "expected value" beat round 1's.
  // Instead, expected value is shrunk toward a smooth monotonically-decreasing prior
  // curve (later picks always expected to be worth less than earlier ones) fit across
  // every pick in that format, then nudged toward the round-level average, then the
  // exact-pick-number average — each layer's influence growing with its own sample
  // size, so the curve "slowly takes over" as more drafts accumulate real data.
  const average = (values) => values.reduce((sum, v) => sum + v, 0) / values.length

  // Weight given to an empirical bucket average vs. its prior: n / (n + k), so a bucket
  // needs roughly k samples before it counts for half as much as the prior it's shrinking.
  const shrinkTowardPrior = (prior, values, k) => {
    if (!values.length) return prior
    const weight = values.length / (values.length + k)
    return (prior * (1 - weight)) + (average(values) * weight)
  }

  // Fits talentPrior ~ a - b*log(pickNumber + 1) by ordinary least squares, per source,
  // so the prior is a smooth decay curve driven by every pick in that format rather than
  // any single pick slot. Deliberately fit on talentPrior (the character's static,
  // performance-independent talent score) rather than actualValue: actualValue is exactly
  // what this curve is used to judge picks *against*, so fitting on it would let one
  // pick's own noisy in-season performance drag down the "expected value" baseline it's
  // then compared to (most visibly at the edges of the pick range, where a single pick
  // is a high-leverage outlier in the regression). b is clamped to >=0 so a small/skewed
  // sample can never produce a prior that expects *later* picks to be worth more than
  // earlier ones.
  const decayCurveBySource = new Map()
  const picksBySource = new Map()
  picks.forEach((pick) => {
    if (!picksBySource.has(pick.source)) picksBySource.set(pick.source, [])
    picksBySource.get(pick.source).push(pick)
  })
  picksBySource.forEach((sourcePicks, source) => {
    const xs = sourcePicks.map((p) => Math.log(p.pickNumber + 1))
    const ys = sourcePicks.map((p) => p.talentPrior)
    const xBar = average(xs)
    const yBar = average(ys)
    const denominator = xs.reduce((sum, x) => sum + ((x - xBar) ** 2), 0)
    const rawSlope = denominator > 0
      ? xs.reduce((sum, x, i) => sum + ((x - xBar) * (ys[i] - yBar)), 0) / denominator
      : 0
    const slope = Math.max(0, rawSlope)
    decayCurveBySource.set(source, { intercept: yBar - (slope * xBar), slope })
  })
  const priorFor = (pick) => {
    const curve = decayCurveBySource.get(pick.source)
    if (!curve) return average(picksBySource.get(pick.source)?.map((p) => p.talentPrior) || [0])
    return curve.intercept - (curve.slope * Math.log(pick.pickNumber + 1))
  }

  const byPickNumber = new Map()
  const byRound = new Map()
  picks.forEach((pick) => {
    const pickKey = `${pick.source}:${pick.pickNumber}`
    const roundKey = `${pick.source}:${pick.round}`
    if (!byPickNumber.has(pickKey)) byPickNumber.set(pickKey, [])
    byPickNumber.get(pickKey).push(pick.actualValue)
    if (!byRound.has(roundKey)) byRound.set(roundKey, [])
    byRound.get(roundKey).push(pick.actualValue)
  })
  // Samples needed at the round/exact-pick level to weight that bucket's own average
  // as heavily as what it's shrinking toward. Round buckets pool more picks per draft
  // (every pick in the round, across all teams) than an exact pick number does, so they
  // need more samples to earn the same trust.
  const ROUND_SHRINKAGE_K = 6
  const PICK_SHRINKAGE_K = 3
  // Excludes `pick` itself from `bucket` before averaging, so a pick is never graded
  // even partly against its own outcome — otherwise an early draft with only one pick
  // at a given slot (the common case right now) makes that pick its own sole comparison,
  // letting one bad stretch drag down the very "expected value" it's judged against.
  const otherValuesInBucket = (bucket, pick) => {
    const values = [...bucket]
    values.splice(values.indexOf(pick.actualValue), 1)
    return values
  }
  const expectedValueFor = (pick) => {
    const prior = priorFor(pick)
    const roundValues = otherValuesInBucket(byRound.get(`${pick.source}:${pick.round}`) || [], pick)
    const roundBlend = shrinkTowardPrior(prior, roundValues, ROUND_SHRINKAGE_K)
    const pickValues = otherValuesInBucket(byPickNumber.get(`${pick.source}:${pick.pickNumber}`) || [], pick)
    return shrinkTowardPrior(roundBlend, pickValues, PICK_SHRINKAGE_K)
  }

  const withSurplus = picks.map((pick) => {
    const expectedValue = expectedValueFor(pick)
    return { ...pick, expectedValue, surplus: pick.actualValue - expectedValue }
  })

  const allSurplus = withSurplus.map((pick) => pick.surplus)
  const withGrade = withSurplus.map((pick) => {
    const percentile = percentileOf(allSurplus, pick.surplus)
    return {
      ...pick,
      characterName: charactersById[pick.characterId]?.name ?? null,
      percentile,
      grade: gradeFromPercentile(percentile),
    }
  })

  const picksByOwnerId = new Map()
  withGrade.forEach((pick) => {
    const key = String(pick.ownerId)
    if (!picksByOwnerId.has(key)) picksByOwnerId.set(key, [])
    picksByOwnerId.get(key).push(pick)
  })

  return { picksByOwnerId, allPicks: withGrade }
}

// Summarizes one team's picks (already filtered to the desired scope) into a single
// "team draft grade" tile: average surplus and its own percentile/grade against every
// other team-scope's average surplus, computed from the same league-wide pick pool.
export function summarizeTeamDraftValue(teamPicks = [], allPicks = []) {
  if (!teamPicks.length) return null
  const totalSurplus = teamPicks.reduce((sum, p) => sum + p.surplus, 0)
  const averageSurplus = totalSurplus / teamPicks.length

  const ownerAverages = new Map()
  allPicks.forEach((pick) => {
    const key = String(pick.ownerId)
    const entry = ownerAverages.get(key) || { total: 0, count: 0 }
    entry.total += pick.surplus
    entry.count += 1
    ownerAverages.set(key, entry)
  })
  const allAverages = [...ownerAverages.values()].map((entry) => entry.total / entry.count)
  const percentile = percentileOf(allAverages, averageSurplus)

  return {
    pickCount: teamPicks.length,
    totalSurplus,
    averageSurplus,
    percentile,
    grade: gradeFromPercentile(percentile),
  }
}
