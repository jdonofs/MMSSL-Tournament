import { parseFielderChainFromNotation, parseErrorPositionsFromNotation } from './notation'
import { getHandedness } from './characterHandedness'
import { getPlayerSkillProfile } from './teamIdentity'
import { deriveTrackedHitFields } from './hitFieldDerivation'
import { computeDifficultySignal } from './fieldingRange'
import { isCreditedHit, isCreditedHitType, isCreditedHomeRun } from './creditedHit'

export { isCreditedHit } from './creditedHit'

export const hitResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const plateAppearanceResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'BB', 'HBP', 'K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE'])
const outResults = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])
export const battedBallResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE'])
const swingPitchResults = new Set(['swinging_miss', 'foul', 'in_play'])

export function isOfficialAtBat(pa = {}) {
  if (typeof pa.is_official_ab === 'boolean') return pa.is_official_ab
  return !['BB', 'HBP', 'SF', 'SH'].includes(pa.result)
}

function getHalfFromPa(pa = {}) {
  return pa.half || pa.pa_half || 'top'
}

export function outsFromInningsPitched(inningsPitched = 0) {
  const innings = Number(inningsPitched || 0)
  const whole = Math.trunc(innings)
  const fraction = Number((innings - whole).toFixed(3))

  if (Math.abs(fraction - 0.1) < 0.001) return whole * 3 + 1
  if (Math.abs(fraction - 0.2) < 0.001) return whole * 3 + 2

  const legacyOuts = Math.round(fraction * 3)
  return whole * 3 + legacyOuts
}

export function inningsPitchedFromOuts(outs = 0) {
  const safeOuts = Math.max(0, Number(outs || 0))
  const wholeInnings = Math.floor(safeOuts / 3)
  const remainingOuts = safeOuts % 3
  return Number(`${wholeInnings}.${remainingOuts}`)
}

export function inningsAsDecimal(inningsPitched = 0) {
  return outsFromInningsPitched(inningsPitched) / 3
}

function sumPitchingOuts(stints = []) {
  return stints.reduce((total, stint) => total + outsFromInningsPitched(stint.innings_pitched), 0)
}

function buildPitchingTeamGameKey(stint = {}) {
  return `${String(stint.game_id ?? '')}:${String(stint.player_id ?? '')}`
}

function buildPitchingPitcherGameKey(stint = {}) {
  return `${buildPitchingTeamGameKey(stint)}:${String(stint.character_id ?? '')}`
}

function derivePitchingGameAwards(stints = [], allGameStints = [], aggregation = 'pitcher') {
  const contextStints = Array.isArray(allGameStints) && allGameStints.length ? allGameStints : stints
  const stintsByTeamGame = contextStints.reduce((acc, stint) => {
    const key = buildPitchingTeamGameKey(stint)
    if (!acc[key]) acc[key] = []
    acc[key].push(stint)
    return acc
  }, {})

  let completeGames = 0
  let shutouts = 0

  if (aggregation === 'team') {
    const entityTeamGames = stints.reduce((acc, stint) => {
      const key = buildPitchingTeamGameKey(stint)
      if (!acc[key]) acc[key] = []
      acc[key].push(stint)
      return acc
    }, {})

    Object.values(entityTeamGames).forEach((teamGameStints) => {
      const contextTeamGameStints = stintsByTeamGame[buildPitchingTeamGameKey(teamGameStints[0])] || teamGameStints
      const teamOuts = sumPitchingOuts(contextTeamGameStints)
      if (!teamOuts) return

      const outsByPitcher = contextTeamGameStints.reduce((acc, stint) => {
        const key = buildPitchingPitcherGameKey(stint)
        acc[key] = (acc[key] || 0) + outsFromInningsPitched(stint.innings_pitched)
        return acc
      }, {})

      const hasCompleteGame = Object.values(outsByPitcher).some((outs) => outs > 0 && outs === teamOuts)
      if (!hasCompleteGame) return

      completeGames += 1
      if (contextTeamGameStints.reduce((total, stint) => total + Number(stint.runs_allowed || 0), 0) === 0) {
        shutouts += 1
      }
    })

    return { completeGames, shutouts }
  }

  const entityPitcherGames = stints.reduce((acc, stint) => {
    const key = buildPitchingPitcherGameKey(stint)
    if (!acc[key]) acc[key] = []
    acc[key].push(stint)
    return acc
  }, {})

  Object.values(entityPitcherGames).forEach((pitcherGameStints) => {
    const contextTeamGameStints = stintsByTeamGame[buildPitchingTeamGameKey(pitcherGameStints[0])] || pitcherGameStints
    const pitcherOuts = sumPitchingOuts(pitcherGameStints)
    const teamOuts = sumPitchingOuts(contextTeamGameStints)
    if (!pitcherOuts || pitcherOuts !== teamOuts) return

    completeGames += 1
    if (contextTeamGameStints.reduce((total, stint) => total + Number(stint.runs_allowed || 0), 0) === 0) {
      shutouts += 1
    }
  })

  return { completeGames, shutouts }
}

export function normalizeRbiForPaResult(result, rbi = 0, isError = false) {
  if (isError || result === 'ROE' || result === 'DP' || result === 'TP' || result === 'FC') return 0
  return Number(rbi || 0)
}

export function getCreditedRbiForPa(pa = {}) {
  return normalizeRbiForPaResult(pa.result, pa.rbi, pa.is_error)
}

export function hasRispOpportunity(pa = {}) {
  return pa.runner_on_second_before === true || pa.runner_on_third_before === true
}

// Scopes a full runs_scored/season_runs_scored set down to the rows relevant to a single
// character's (or player's) batting line: scored by that character/player, in one of the
// games represented by the given plateAppearances (so a caller that already filtered `pas`
// to one season/tournament/window doesn't pull in runs from unrelated games).
export function filterRunEventsForCharacter(runEvents = [], characterId, plateAppearances = []) {
  if (characterId == null) return []
  const gameIds = new Set(plateAppearances.map((pa) => String(pa.game_id)))
  return runEvents.filter((run) => (
    String(run.scoring_character_id) === String(characterId) && gameIds.has(String(run.game_id))
  ))
}

export function filterRunEventsForPlayer(runEvents = [], playerId, plateAppearances = []) {
  if (playerId == null) return []
  const gameIds = new Set(plateAppearances.map((pa) => String(pa.game_id)))
  return runEvents.filter((run) => (
    String(run.scoring_player_id) === String(playerId) && gameIds.has(String(run.game_id))
  ))
}

// runEvents: rows from runs_scored/season_runs_scored already filtered to whichever
// player/character this batting line is for. A run only shows up in pa.run_scored when
// the batter scored on their own PA (e.g. a HR) — a runner who reached base earlier and
// scored on a later teammate's play is recorded only in runs_scored, never on their own
// PA row. runEvents is the authoritative source for any game that has rows in it; pa.run_scored
// is kept only as a fallback for games recorded before runs_scored existed.
export function summarizeBatting(plateAppearances = [], runEvents = []) {
  const atBats = plateAppearances.filter((pa) => isOfficialAtBat(pa)).length
  const hits = plateAppearances.filter(isCreditedHit).length
  const walks = plateAppearances.filter((pa) => pa.result === 'BB').length
  const hbp = plateAppearances.filter((pa) => pa.result === 'HBP').length
  const singles = plateAppearances.filter((pa) => isCreditedHitType(pa, '1B')).length
  const doubles = plateAppearances.filter((pa) => isCreditedHitType(pa, '2B')).length
  const triples = plateAppearances.filter((pa) => isCreditedHitType(pa, '3B')).length
  const homeRuns = plateAppearances.filter(isCreditedHomeRun).length
  const totalBases = plateAppearances.reduce((total, pa) => {
    if (!isCreditedHit(pa)) return total
    if (pa.result === '1B') return total + 1
    if (pa.result === '2B') return total + 2
    if (pa.result === '3B') return total + 3
    if (pa.result === 'HR' || pa.result === 'IPHR') return total + 4
    return total
  }, 0)
  const sacrificeFlies = plateAppearances.filter((pa) => pa.result === 'SF').length
  const sacrificeHits = plateAppearances.filter((pa) => pa.result === 'SH').length
  const outs = plateAppearances.filter((pa) => outResults.has(pa.result)).length
  const hitByPitch = hbp
  const rispPas = plateAppearances.filter((pa) => hasRispOpportunity(pa))
  const rispAtBats = rispPas.filter((pa) => isOfficialAtBat(pa)).length
  const rispHits = rispPas.filter(isCreditedHit).length

  const gameIdsWithRunTracking = new Set(runEvents.map((run) => String(run.game_id)))
  const legacyRuns = plateAppearances.filter(
    (pa) => pa.run_scored && !gameIdsWithRunTracking.has(String(pa.game_id)),
  ).length

  return {
    games: new Set(plateAppearances.map((pa) => pa.game_id)).size,
    plateAppearances: plateAppearances.length,
    atBats,
    hits,
    singles,
    doubles,
    triples,
    runs: runEvents.length + legacyRuns,
    rbi: plateAppearances.reduce((total, pa) => total + getCreditedRbiForPa(pa), 0),
    homeRuns,
    strikeouts: plateAppearances.filter((pa) => pa.result === 'K').length,
    walks,
    hbp: hitByPitch,
    sacrificeFlies,
    sacrificeHits,
    totalBases,
    outs,
    avg: atBats ? hits / atBats : 0,
    obp: atBats + walks + hbp + sacrificeFlies ? (hits + walks + hbp) / (atBats + walks + hbp + sacrificeFlies) : 0,
    slg: atBats ? totalBases / atBats : 0,
    rispPlateAppearances: rispPas.length,
    rispAtBats,
    rispHits,
    rispAvg: rispAtBats ? rispHits / rispAtBats : null,
    ops: 0
  }
}

export function summarizePitching(stints = [], options = {}) {
  const { aggregation = 'flags', allGameStints = stints } = options
  const totalOuts = stints.reduce((total, stint) => total + outsFromInningsPitched(stint.innings_pitched), 0)
  const innings = inningsPitchedFromOuts(totalOuts)
  const inningsDecimal = totalOuts / 3
  const earnedRuns = stints.reduce((total, stint) => total + (stint.earned_runs || 0), 0)
  const runsAllowed = stints.reduce((total, stint) => total + (stint.runs_allowed || 0), 0)
  const hitsAllowed = stints.reduce((total, stint) => total + (stint.hits_allowed || 0), 0)
  const walks = stints.reduce((total, stint) => total + (stint.walks || 0), 0)
  const strikeouts = stints.reduce((total, stint) => total + (stint.strikeouts || 0), 0)
  const homeRunsAllowed = stints.reduce((total, stint) => total + (stint.hr_allowed || 0), 0)
  const derivedAwards = aggregation === 'flags'
    ? null
    : derivePitchingGameAwards(stints, allGameStints, aggregation)

  return {
    games: new Set(stints.map((stint) => stint.game_id)).size,
    innings,
    wins: stints.filter((stint) => stint.win).length,
    losses: stints.filter((stint) => stint.loss).length,
    saves: stints.filter((stint) => stint.save).length,
    shutouts: derivedAwards?.shutouts ?? stints.filter((stint) => stint.shutout).length,
    completeGames: derivedAwards?.completeGames ?? stints.filter((stint) => stint.complete_game).length,
    strikeouts,
    hitsAllowed,
    runsAllowed,
    earnedRuns,
    walks,
    homeRunsAllowed,
    era: inningsDecimal ? (earnedRuns * 3) / inningsDecimal : 0,
    whip: inningsDecimal ? (hitsAllowed + walks) / inningsDecimal : 0,
    kPer3: inningsDecimal ? (strikeouts * 3) / inningsDecimal : 0,
    hrPer3: inningsDecimal ? (homeRunsAllowed * 3) / inningsDecimal : 0
  }
}

export function hasPitchingStatLine(pitching = {}) {
  return [
    pitching.innings,
    pitching.wins,
    pitching.losses,
    pitching.saves,
    pitching.shutouts,
    pitching.completeGames,
    pitching.strikeouts,
    pitching.hitsAllowed,
    pitching.runsAllowed,
    pitching.earnedRuns,
    pitching.walks,
    pitching.homeRunsAllowed,
  ].some((value) => Number(value || 0) > 0)
}

export function summarizeBattedBallProfile(plateAppearances = []) {
  const battedBalls = plateAppearances.filter((pa) => battedBallResults.has(pa.result) && pa.trajectory)
  const total = battedBalls.length || 0
  const count = (trajectory) => battedBalls.filter((pa) => pa.trajectory === trajectory).length
  return {
    total,
    lineDrives: count('L'),
    groundBalls: count('G'),
    flyBalls: count('F'),
    bloops: count('B'),
    ldRate: total ? count('L') / total : 0,
    gbRate: total ? count('G') / total : 0,
    fbRate: total ? count('F') / total : 0,
    bloopRate: total ? count('B') / total : 0,
  }
}

function normalizeBatterHandedness(handedness) {
  return handedness === 'L' ? 'L' : 'R'
}

function resolveBatterHandedness(pa = {}) {
  if (pa.batterHandedness === 'L' || pa.batterHandedness === 'R') return pa.batterHandedness
  if (pa.bats === 'L' || pa.bats === 'R') return pa.bats
  if (pa.character_name) return normalizeBatterHandedness(getHandedness(pa.character_name).bats)
  return 'R'
}

function directionForFieldPosition(position, batterHandedness = 'R') {
  if (position == null) return null
  const handedness = normalizeBatterHandedness(batterHandedness)
  if (['5', '6', '7'].includes(String(position))) return handedness === 'L' ? 'Oppo' : 'Pull'
  if (['1', '2', '8'].includes(String(position))) return 'Center'
  if (['3', '4', '9'].includes(String(position))) return handedness === 'L' ? 'Pull' : 'Oppo'
  return null
}

function directionForSprayAngle(angleDeg, batterHandedness = 'R') {
  const angle = Number(angleDeg)
  if (!Number.isFinite(angle)) return null
  const handedness = normalizeBatterHandedness(batterHandedness)
  if (angle <= -15) return handedness === 'L' ? 'Oppo' : 'Pull'
  if (angle >= 15) return handedness === 'L' ? 'Pull' : 'Oppo'
  return 'Center'
}

function resolveBattedBallDirection(pa = {}) {
  const batterHandedness = resolveBatterHandedness(pa)
  const fromLocation = directionForFieldPosition(pa.hit_location ?? pa.error_position, batterHandedness)
  if (fromLocation) return fromLocation
  const fromAngle = directionForSprayAngle(pa.hit_angle_deg, batterHandedness)
  if (fromAngle) return fromAngle
  if (pa.direction === 'Pull' || pa.direction === 'Center' || pa.direction === 'Oppo') return pa.direction
  return null
}

export function summarizeSprayProfile(plateAppearances = []) {
  const battedBalls = plateAppearances.filter((pa) => battedBallResults.has(pa.result))
  const total = battedBalls.length || 0
  let pull = 0
  let center = 0
  let oppo = 0
  let sprayAngleSum = 0
  let sprayAngleCount = 0

  // hit_angle_deg is signed relative to straightaway CF (0deg): negative is the
  // left-field side, positive is the right-field side. Pull/Oppo flips by batter
  // handedness, but the raw average angle stays field-relative.
  battedBalls.forEach((pa) => {
    const direction = resolveBattedBallDirection(pa)
    if (direction === 'Pull') pull += 1
    else if (direction === 'Center') center += 1
    else if (direction === 'Oppo') oppo += 1

    const angle = Number(pa.hit_angle_deg)
    if (pa.hit_angle_deg != null && Number.isFinite(angle)) {
      sprayAngleSum += angle
      sprayAngleCount += 1
    }
  })

  const avgSprayAngle = sprayAngleCount
    ? Math.round((sprayAngleSum / sprayAngleCount) * 10) / 10
    : null
  return {
    total,
    pull,
    center,
    oppo,
    pullRate: total ? pull / total : 0,
    centerRate: total ? center / total : 0,
    oppoRate: total ? oppo / total : 0,
    avgSprayAngle,
  }
}

// Same Pull/Center/Oppo buckets as summarizeSprayProfile, but reporting exit velocity and
// slugging-on-contact within each direction instead of counts — e.g. "pull-side slugging" (a
// player's damage specifically on balls pulled vs. hit the other way), which spray direction and
// exit velocity have always both been captured for, just never cross-tabulated.
export function summarizeSprayContactProfile(plateAppearances = []) {
  const battedBalls = plateAppearances.filter((pa) => battedBallResults.has(pa.result))
  const byDirection = { Pull: [], Center: [], Oppo: [] }
  battedBalls.forEach((pa) => {
    const direction = resolveBattedBallDirection(pa)
    if (direction && byDirection[direction]) byDirection[direction].push(pa)
  })
  const build = (pas) => {
    const singles = pas.filter((pa) => isCreditedHitType(pa, '1B')).length
    const doubles = pas.filter((pa) => isCreditedHitType(pa, '2B')).length
    const triples = pas.filter((pa) => isCreditedHitType(pa, '3B')).length
    const hrs = pas.filter(isCreditedHomeRun).length
    const tb = singles + (doubles * 2) + (triples * 3) + (hrs * 4)
    return {
      sampleSize: pas.length,
      avgExitVelocity: averageOf(pas, 'exit_velocity_mph'),
      maxExitVelocity: maxOf(pas, 'exit_velocity_mph'),
      slgOnContact: pas.length ? +(tb / pas.length).toFixed(3) : null,
    }
  }
  return { pull: build(byDirection.Pull), center: build(byDirection.Center), oppo: build(byDirection.Oppo) }
}

// BABIP/wOBA/slugging broken out by batted-ball trajectory (GB/FB/LD/bloop) — same trajectory
// buckets as summarizeBattedBallProfile, but reporting outcome quality within each type instead of
// just its share of contact (e.g. "does this batter's BABIP hold up on fly balls specifically").
// wobaOnContact uses the same linear weights as summarizeAdvancedBatting's wOBA, but over
// batted-ball attempts of one trajectory only (no BB/HBP denominator terms — those aren't
// trajectory-tagged), so it isn't on the same 100%-park-adjusted scale as real wOBA; it's a
// same-units comparison across trajectory buckets, not against the league wOBA constant.
export function summarizeBattedBallTypeProfile(plateAppearances = []) {
  const byTrajectory = (traj) => plateAppearances.filter((pa) => battedBallResults.has(pa.result) && pa.trajectory === traj)
  const build = (pas) => {
    const total = pas.length
    const hits = pas.filter(isCreditedHit).length
    const singles = pas.filter((pa) => isCreditedHitType(pa, '1B')).length
    const doubles = pas.filter((pa) => isCreditedHitType(pa, '2B')).length
    const triples = pas.filter((pa) => isCreditedHitType(pa, '3B')).length
    const hrs = pas.filter(isCreditedHomeRun).length
    const tb = singles + (doubles * 2) + (triples * 3) + (hrs * 4)
    const babipDenom = total - hrs
    const wobaNumerator = (0.89 * singles) + (1.27 * doubles) + (1.62 * triples) + (2.10 * hrs)
    return {
      sampleSize: total,
      hits,
      babip: babipDenom > 0 ? +((hits - hrs) / babipDenom).toFixed(3) : null,
      slgOnContact: total ? +(tb / total).toFixed(3) : null,
      wobaOnContact: total ? +(wobaNumerator / total).toFixed(3) : null,
      avgExitVelocity: averageOf(pas, 'exit_velocity_mph'),
    }
  }
  return {
    groundBall: build(byTrajectory('G')),
    lineDrive: build(byTrajectory('L')),
    flyBall: build(byTrajectory('F')),
    bloop: build(byTrajectory('B')),
  }
}

// `row[key] == null` (not put in play, so no exit velo/launch angle/distance recorded) must be
// dropped BEFORE the Number() coercion — Number(null) is 0, a finite number, so a null field was
// silently being counted as a real 0-value data point and dragging every average down.
function averageOf(rows, key) {
  const vals = rows.filter((row) => row[key] != null).map((row) => Number(row[key])).filter((v) => Number.isFinite(v))
  return vals.length ? Math.round((vals.reduce((sum, v) => sum + v, 0) / vals.length) * 10) / 10 : null
}

function maxOf(rows, key) {
  const vals = rows.filter((row) => row[key] != null).map((row) => Number(row[key])).filter((v) => Number.isFinite(v))
  return vals.length ? Math.round(Math.max(...vals) * 10) / 10 : null
}

function summarizeRatio(numerator = 0, denominator = 0) {
  return Number(numerator || 0) / Math.max(1, Number(denominator || 0))
}

function roundMetric(value, digits = 2) {
  if (value == null) return null
  if (!Number.isFinite(value)) return value
  return +value.toFixed(digits)
}

export function summarizeStarHits(plateAppearances = []) {
  const used = plateAppearances.filter((pa) => pa.star_hit_used)
  // star_hit_connected is tracked as its own flag (set true by Scorebook's pitch-by-pitch FOUL/
  // IN-PLAY handlers), which historically could go unset on rows saved through other paths (e.g.
  // outcome-button shortcuts) — leaving "0% contact, nonzero success" rows where a hit was logged
  // without contact ever being marked. A batted-ball result is proof of contact on its own, so
  // treat it as connected even if the flag itself is missing/stale.
  const connected = used.filter((pa) => pa.star_hit_connected || battedBallResults.has(pa.result))
  const successful = used.filter(isCreditedHit)
  // Uses the PA's own credited RBI rather than the separate star_hit_rbi column — a data-entry
  // bug in Scorebook's runner-resolution flow (hits needing base assignment, e.g. singles/doubles)
  // leaves star_hit_rbi at 0 even when the play drove in a run, while the PA's real `rbi` field is
  // correct. Since `used` is already filtered to star_hit_used PAs, any RBI credited on one of them
  // happened during that star hit by definition.
  const totalRbi = used.reduce((sum, pa) => sum + getCreditedRbiForPa(pa), 0)
  // K and BB/HBP are broken out from the generic 'Out' bucket so the table doesn't hide that a
  // star hit attempt ended in a strikeout or a walk rather than a fielded out — they used to all
  // get lumped into 'Out' (and a walk isn't even an out), which hid part of the picture.
  const resultBreakdown = ['1B', '2B', '3B', 'HR', 'K', 'BB', 'Out', 'Error'].reduce((acc, result) => {
    acc[result] = used.filter((pa) => {
      const derivedResult = pa.star_hit_result || (
        pa.is_error ? 'Error'
          : isCreditedHit(pa) ? pa.result
            : pa.result === 'K' ? 'K'
              : (pa.result === 'BB' || pa.result === 'HBP') ? 'BB'
                : 'Out'
      )
      const normalizedResult = derivedResult === 'IPHR' ? 'HR' : derivedResult
      return normalizedResult === result
    }).length
    return acc
  }, {})
  const slashLine = summarizeBatting(used)
  slashLine.ops = slashLine.obp + slashLine.slg
  return {
    used: used.length,
    connected: connected.length,
    successful: successful.length,
    totalRbi,
    contactRate: used.length ? connected.length / used.length : 0,
    successRate: used.length ? successful.length / used.length : 0,
    avgRbiPerUse: used.length ? totalRbi / used.length : 0,
    resultBreakdown,
    slashLine,
    avgExitVelo: averageOf(used, 'exit_velocity_mph'),
    maxExitVelo: maxOf(used, 'exit_velocity_mph'),
    avgLaunchAngle: averageOf(used, 'launch_angle_deg'),
    avgDistance: averageOf(used, 'hit_distance_ft'),
    maxDistance: maxOf(used, 'hit_distance_ft'),
  }
}

export function summarizePlateDiscipline(plateAppearances = [], pitches = []) {
  const paIds = new Set(plateAppearances.map((pa) => String(pa.id)))
  const relevantPitches = pitches.filter((pitch) => paIds.has(String(pitch.pa_id)))
  const totalPitches = relevantPitches.length
  const swings = relevantPitches.filter((pitch) => swingPitchResults.has(pitch.result)).length
  const swingingMisses = relevantPitches.filter((pitch) => pitch.result === 'swinging_miss').length
  const fouls = relevantPitches.filter((pitch) => pitch.result === 'foul').length
  const ks = plateAppearances.filter((pa) => pa.result === 'K')
  const ksSwinging = ks.filter((pa) => pa.strikeout_type === 'KS').length
  const ksLooking = ks.filter((pa) => pa.strikeout_type === 'KL').length
  return {
    totalPitches,
    pitchesPerPa: plateAppearances.length ? totalPitches / plateAppearances.length : 0,
    whiffRate: swings ? swingingMisses / swings : 0,
    foulRate: totalPitches ? fouls / totalPitches : 0,
    ksRate: ks.length ? ksSwinging / ks.length : 0,
    klRate: ks.length ? ksLooking / ks.length : 0,
    bbRate: plateAppearances.length ? plateAppearances.filter((pa) => pa.result === 'BB').length / plateAppearances.length : 0,
    kRate: plateAppearances.length ? ks.length / plateAppearances.length : 0,
  }
}

export function summarizeStarPitching(plateAppearances = [], pitches = []) {
  const starPitches = pitches.filter((pitch) => pitch.is_star_pitch)
  const starPitchPas = plateAppearances.filter((pa) => pa.star_pitch_used)
  const outsOnStarPitch = starPitchPas.filter((pa) => pa.star_pitch_successful).length
  const hitsAllowedOnStarPitch = starPitchPas.filter(isCreditedHit).length
  // The star pitch itself is one pitch inside a PA that may run several more pitches before it
  // ends — resultBreakdown/oppSlashLine below describe how the whole PA ended, not what the star
  // pitch immediately did when it wasn't put in play. These cover that: of every star pitch thrown,
  // how many were called balls vs. strikes (looking/swinging/foul) on that pitch specifically.
  const pitchBalls = starPitches.filter((pitch) => pitch.result === 'ball').length
  const pitchStrikes = starPitches.filter((pitch) => ['looking', 'swinging_miss', 'strike_unknown', 'foul'].includes(pitch.result)).length
  const usageByCount = starPitches.reduce((acc, pitch) => {
    const key = `${pitch.count_balls_before ?? 0}-${pitch.count_strikes_before ?? 0}`
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  const resultBreakdown = ['1B', '2B', '3B', 'HR', 'K', 'BB', 'Out'].reduce((acc, result) => {
    acc[result] = starPitchPas.filter((pa) => {
      if (result === 'HR') return isCreditedHomeRun(pa)
      if (result === 'Out') return outResults.has(pa.result) && pa.result !== 'K'
      return pa.result === result
    }).length
    return acc
  }, {})
  const oppSlashLine = summarizeBatting(starPitchPas)
  oppSlashLine.ops = oppSlashLine.obp + oppSlashLine.slg
  return {
    used: starPitches.length,
    paUsed: starPitchPas.length,
    pitchBalls,
    pitchStrikes,
    outsOnStarPitch,
    hitsAllowedOnStarPitch,
    successRate: starPitchPas.length ? outsOnStarPitch / starPitchPas.length : 0,
    usageByCount,
    resultBreakdown,
    oppSlashLine,
    avgExitVeloAllowed: averageOf(starPitchPas, 'exit_velocity_mph'),
    avgLaunchAngleAllowed: averageOf(starPitchPas, 'launch_angle_deg'),
    avgDistanceAllowed: averageOf(starPitchPas, 'hit_distance_ft'),
  }
}

export function summarizePitchMix(plateAppearances = [], pitches = []) {
  const total = pitches.length
  const strikes = pitches.filter((pitch) => ['swinging_miss', 'looking', 'strike_unknown', 'foul', 'in_play'].includes(pitch.result)).length
  const firstPitchStrikes = plateAppearances.length
    ? pitches.filter((pitch) => pitch.count_balls_before === 0 && pitch.count_strikes_before === 0 && pitch.result !== 'ball' && pitch.result !== 'hbp').length / plateAppearances.length
    : 0
  return {
    totalPitches: total,
    strikeRate: total ? strikes / total : 0,
    swingingMissRate: total ? pitches.filter((pitch) => pitch.result === 'swinging_miss').length / total : 0,
    calledStrikeRate: total ? pitches.filter((pitch) => pitch.result === 'looking').length / total : 0,
    foulRate: total ? pitches.filter((pitch) => pitch.result === 'foul').length / total : 0,
    ballRate: total ? pitches.filter((pitch) => pitch.result === 'ball').length / total : 0,
    firstPitchStrikeRate: firstPitchStrikes,
    pitchesPerInning: 0,
    pitchesPerBatter: plateAppearances.length ? total / plateAppearances.length : 0,
  }
}

export function summarizeFielding({ plateAppearances = [], gameFielders = [], players = [] } = {}) {
  const playerNameById = Object.fromEntries(players.map((player) => [String(player.id), player.name]))
  const errors = plateAppearances.filter((pa) => pa.is_error && pa.error_position)
  const findFielderForPa = (pa) => gameFielders.find((fielder) => (
    String(fielder.game_id) === String(pa.game_id) &&
    Number(fielder.position) === Number(pa.hit_location || pa.error_position) &&
    Number(fielder.inning_from || 1) <= Number(pa.inning || 1) &&
    (fielder.inning_to == null || Number(fielder.inning_to) >= Number(pa.inning || 1)) &&
    String(fielder.team_id) === String(pa.defensive_team_id)
  ))

  const chances = plateAppearances
    .filter((pa) => pa.hit_location)
    .map((pa) => ({ pa, fielder: findFielderForPa(pa) }))
    .filter((entry) => entry.fielder)

  const errorsByCharacter = errors.reduce((acc, pa) => {
    acc[pa.error_character] = (acc[pa.error_character] || 0) + 1
    return acc
  }, {})

  const errorsByPlayer = errors.reduce((acc, pa) => {
    const name = pa.error_player || playerNameById[String(pa.defensive_team_id)] || 'Unknown'
    acc[name] = (acc[name] || 0) + 1
    return acc
  }, {})

  const errorRateByPosition = chances.reduce((acc, { pa, fielder }) => {
    const key = `${fielder.character}:${fielder.position}`
    if (!acc[key]) acc[key] = { character: fielder.character, position: fielder.position, chances: 0, errors: 0, rate: 0 }
    acc[key].chances += 1
    if (pa.is_error && String(pa.error_character) === String(fielder.character)) acc[key].errors += 1
    acc[key].rate = acc[key].chances ? acc[key].errors / acc[key].chances : 0
    return acc
  }, {})

  const errorTypeBreakdown = errors.reduce((acc, pa) => {
    const key = pa.trajectory || 'Unknown'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})

  return {
    errors,
    errorsByCharacter,
    errorsByPlayer,
    errorRateByPosition: Object.values(errorRateByPosition),
    errorTypeBreakdown,
  }
}

export function groupBy(items, key) {
  return items.reduce((accumulator, item) => {
    const groupKey = item[key]
    accumulator[groupKey] = accumulator[groupKey] || []
    accumulator[groupKey].push(item)
    return accumulator
  }, {})
}

export function buildStandings(games = [], players = []) {
  const standings = players.reduce((accumulator, player) => {
    accumulator[player.id] = {
      playerId: player.id,
      name: player.name,
      wins: 0,
      losses: 0,
      runsFor: 0,
      runsAgainst: 0,
      runDiff: 0,
      winPct: 0
    }
    return accumulator
  }, {})

  games
    .filter((game) => game.status === 'complete')
    .forEach((game) => {
      const teamA = standings[game.team_a_player_id]
      const teamB = standings[game.team_b_player_id]
      if (!teamA || !teamB) return

      teamA.runsFor += game.team_a_runs || 0
      teamA.runsAgainst += game.team_b_runs || 0
      teamB.runsFor += game.team_b_runs || 0
      teamB.runsAgainst += game.team_a_runs || 0

      if (game.winner_player_id === game.team_a_player_id) {
        teamA.wins += 1
        teamB.losses += 1
      } else if (game.winner_player_id === game.team_b_player_id) {
        teamB.wins += 1
        teamA.losses += 1
      }
    })

  return Object.values(standings)
    .map((row) => ({
      ...row,
      runDiff: row.runsFor - row.runsAgainst,
      winPct: row.wins + row.losses ? row.wins / (row.wins + row.losses) : 0
    }))
    .sort((a, b) => b.wins - a.wins || b.runDiff - a.runDiff)
}

export function buildCharacterHistory(plateAppearances = [], pitchingStints = [], runEvents = [], options = {}) {
  const { allGameStints = pitchingStints } = options
  const paByCharacter = groupBy(plateAppearances, 'character_id')
  const pitchingByCharacter = groupBy(pitchingStints, 'character_id')

  const ids = new Set([...Object.keys(paByCharacter), ...Object.keys(pitchingByCharacter)])
  const summary = {}

  ids.forEach((id) => {
    const pas = paByCharacter[id] || []
    const batting = summarizeBatting(pas, filterRunEventsForCharacter(runEvents, id, pas))
    batting.ops = batting.obp + batting.slg
    const pitching = summarizePitching(pitchingByCharacter[id] || [], {
      aggregation: 'pitcher',
      allGameStints,
    })
    summary[id] = {
      batting,
      pitching
    }
  })

  return summary
}

// Per-tournament character history. Returns:
// { [characterId]: [{ tournamentId, tournamentNumber, pa, avg, ops, hr, rbi, perfScore }] }
// perfScore = min(ops * 5, 10), only included if pa >= MIN_PA
export const MIN_PA_THRESHOLD = 5

export function buildCharacterTournamentHistory(plateAppearances = [], games = [], tournaments = []) {
  const gameById = Object.fromEntries(games.map(g => [g.id, g]))
  const tByid = Object.fromEntries(tournaments.map(t => [t.id, t]))

  // Group PAs by characterId -> tournamentId
  const byCharTournament = {}
  for (const pa of plateAppearances) {
    const game = gameById[pa.game_id]
    if (!game) continue
    const tid = game.tournament_id
    if (!byCharTournament[pa.character_id]) byCharTournament[pa.character_id] = {}
    if (!byCharTournament[pa.character_id][tid]) byCharTournament[pa.character_id][tid] = []
    byCharTournament[pa.character_id][tid].push(pa)
  }

  const result = {}
  for (const [charId, byT] of Object.entries(byCharTournament)) {
    result[charId] = Object.entries(byT)
      .map(([tid, pas]) => {
        const b = summarizeBatting(pas)
        b.ops = b.obp + b.slg
        const t = tByid[tid]
        return {
          tournamentId: tid,
          tournamentNumber: t?.tournament_number ?? '?',
          pa: pas.length,
          avg: b.avg,
          ops: b.ops,
          hr: b.homeRuns,
          rbi: b.rbi,
          perfScore: pas.length >= MIN_PA_THRESHOLD ? Math.min(b.ops * 5, 10) : null,
          rawPas: pas,
        }
      })
      .sort((a, b) => (a.tournamentNumber > b.tournamentNumber ? 1 : -1))
  }
  return result
}

// Per-game character history, unified across tournaments and seasons. Returns:
// { [characterId]: [{ gameId, eventKey, eventId, eventType, eventNumber, eventSortKey,
//                      playerId, pa, avg, ops, hr, rbi, perfScore, gameDelta, rawPas }] }
// perfScore is derived from a wRC+-style, league-relative metric (see wobaForPas/perfScoreFromIndexPlus
// below), only included if pa >= MIN_PA_PER_GAME.
// gameDelta = perfScore - (the same player's OTHER characters' combined perfScore-equivalent
// in that same event), so a game is judged relative to how the owning player was doing with
// the rest of their roster at the time, not in isolation. Falls back to a neutral 0 delta when
// the player has no other qualifying characters in that event.
export const MIN_PA_PER_GAME = 3

// A single extreme game (a perfect outing vs. a teammate's disastrous one) can otherwise produce
// a 10+ point gap that alone saturates the history blend's final ±2 clamp, drowning out every
// other game in the sample. Clamping each game's delta at the source keeps one outlier game from
// single-handedly maxing out the OVR swing.
const GAME_DELTA_CLAMP = 3
function clampGameDelta(value) {
  return Math.max(-GAME_DELTA_CLAMP, Math.min(GAME_DELTA_CLAMP, value))
}

// wOBA for a single game's worth of PAs, using the same linear weights as computeLeagueConstants/
// summarizeAdvancedBatting so the per-game perf score and the season/career advanced stats agree.
function wobaForPas(pas = []) {
  const abs = pas.filter((pa) => isOfficialAtBat(pa)).length
  const singles = pas.filter((pa) => isCreditedHitType(pa, '1B')).length
  const doubles = pas.filter((pa) => isCreditedHitType(pa, '2B')).length
  const triples = pas.filter((pa) => isCreditedHitType(pa, '3B')).length
  const hrs = pas.filter(isCreditedHomeRun).length
  const walks = pas.filter((pa) => pa.result === 'BB').length
  const hbp = pas.filter((pa) => pa.result === 'HBP').length
  const sfs = pas.filter((pa) => pa.result === 'SF').length
  const denom = abs + walks + sfs + hbp
  if (!denom) return 0
  return ((0.69 * walks) + (0.72 * hbp) + (0.89 * singles) + (1.27 * doubles) + (1.62 * triples) + (2.10 * hrs)) / denom
}

// Rescales a league-relative "-plus"/"-minus" index (100 = league average) onto the 0-10 perf
// scale buildHistoryAdjustment expects, so its confidence-weighting/clamping machinery keeps
// working unchanged regardless of which advanced metric feeds it. `invert: true` is for metrics
// where LOWER is better (e.g. FIP-), so a below-average index still maps to an above-5 perf score.
function perfScoreFromIndexPlus(indexPlus, { invert = false } = {}) {
  const signed = invert ? (200 - indexPlus) : indexPlus
  return Math.max(0, Math.min(10, signed / 20))
}

function buildGameMetaById(games = [], eventLookupById = {}, eventType, eventIdKey, eventNumberOf, sortKeyOf) {
  const metaById = {}
  for (const game of games) {
    const eventId = game[eventIdKey]
    const event = eventLookupById[eventId]
    metaById[game.id] = {
      eventId,
      eventType,
      eventKey: `${eventType}:${eventId}`,
      eventNumber: eventNumberOf(event, eventId),
      eventSortKey: sortKeyOf(event, game),
    }
  }
  return metaById
}

// season_plate_appearances rows already carry season_id directly, so season game metadata
// can be derived straight from the PA rows without a season_schedule join.
function buildSeasonGameMetaFromPAs(seasonPlateAppearances = [], seasonById = {}) {
  const metaById = {}
  for (const pa of seasonPlateAppearances) {
    if (metaById[pa.game_id]) continue
    const season = seasonById[pa.season_id]
    metaById[pa.game_id] = {
      eventId: pa.season_id,
      eventType: 'season',
      eventKey: `season:${pa.season_id}`,
      eventNumber: abbreviateSeasonName(season?.name) ?? pa.season_id,
      eventSortKey: new Date(season?.created_at || 0).getTime(),
    }
  }
  return metaById
}

function buildPlayerEventPAs(plateAppearances = [], gameMetaById = {}) {
  const map = {}
  for (const pa of plateAppearances) {
    const meta = gameMetaById[pa.game_id]
    if (!meta) continue
    const key = `${meta.eventKey}:${pa.player_id}`
    if (!map[key]) map[key] = []
    map[key].push(pa)
  }
  return map
}

function buildPerGameEntries(plateAppearances = [], gameMetaById = {}, playerEventPAs = {}, leagueConstants = {}) {
  const lgwOBA = leagueConstants.lgwOBA || computeLeagueConstants(plateAppearances).lgwOBA
  const perfScoreForPas = (pas) => perfScoreFromIndexPlus((wobaForPas(pas) / lgwOBA) * 100)

  const byCharGame = {}
  for (const pa of plateAppearances) {
    const meta = gameMetaById[pa.game_id]
    if (!meta) continue
    if (!byCharGame[pa.character_id]) byCharGame[pa.character_id] = {}
    if (!byCharGame[pa.character_id][pa.game_id]) byCharGame[pa.character_id][pa.game_id] = []
    byCharGame[pa.character_id][pa.game_id].push(pa)
  }

  const result = {}
  for (const [charId, byGame] of Object.entries(byCharGame)) {
    result[charId] = Object.entries(byGame).map(([gameId, pas]) => {
      const meta = gameMetaById[gameId] || gameMetaById[pas[0].game_id]
      const b = summarizeBatting(pas)
      b.ops = b.obp + b.slg
      const perfScore = pas.length >= MIN_PA_PER_GAME ? perfScoreForPas(pas) : null
      const playerId = pas[0].player_id ?? null

      let gameDelta = null
      if (perfScore !== null) {
        const eventPlayerPas = playerEventPAs[`${meta.eventKey}:${playerId}`] || []
        const otherCharPas = eventPlayerPas.filter((pa) => String(pa.character_id) !== String(charId))
        if (otherCharPas.length > 0) {
          const baselinePerf = perfScoreForPas(otherCharPas)
          gameDelta = clampGameDelta(perfScore - baselinePerf)
        } else {
          gameDelta = 0
        }
      }

      return {
        gameId,
        eventId: meta.eventId,
        eventType: meta.eventType,
        eventKey: meta.eventKey,
        eventNumber: meta.eventNumber,
        eventSortKey: meta.eventSortKey,
        playerId,
        pa: pas.length,
        avg: b.avg,
        ops: b.ops,
        hr: b.homeRuns,
        rbi: b.rbi,
        perfScore,
        gameDelta,
        rawPas: pas,
      }
    })
  }
  return result
}

// leagueConstants (from computeLeagueConstants) is optional — when omitted, it's derived from
// the PAs passed in here so every caller keeps working, but callers that already pool the full
// PA dataset elsewhere should pass it in explicitly to avoid recomputing it per character.
export function buildCharacterGameHistory(
  plateAppearances = [],
  games = [],
  tournaments = [],
  seasonPlateAppearances = [],
  seasons = [],
  leagueConstants = null,
) {
  const resolvedLeagueConstants = leagueConstants || computeLeagueConstants([...plateAppearances, ...seasonPlateAppearances])

  const tournamentById = Object.fromEntries(tournaments.map((t) => [t.id, t]))
  const seasonById = Object.fromEntries(seasons.map((s) => [s.id, s]))

  const tournamentGameMetaById = buildGameMetaById(
    games, tournamentById, 'tournament', 'tournament_id',
    (tournament, id) => tournament?.tournament_number ?? id,
    (tournament) => tournament?.tournament_number ?? 0,
  )
  const seasonGameMetaById = buildSeasonGameMetaFromPAs(seasonPlateAppearances, seasonById)

  const tournamentPlayerEventPAs = buildPlayerEventPAs(plateAppearances, tournamentGameMetaById)
  const seasonPlayerEventPAs = buildPlayerEventPAs(seasonPlateAppearances, seasonGameMetaById)

  const tournamentEntries = buildPerGameEntries(plateAppearances, tournamentGameMetaById, tournamentPlayerEventPAs, resolvedLeagueConstants)
  const seasonEntries = buildPerGameEntries(seasonPlateAppearances, seasonGameMetaById, seasonPlayerEventPAs, resolvedLeagueConstants)

  const charIds = new Set([...Object.keys(tournamentEntries), ...Object.keys(seasonEntries)])
  const result = {}
  charIds.forEach((charId) => {
    result[charId] = [...(tournamentEntries[charId] || []), ...(seasonEntries[charId] || [])]
      .sort((a, b) => (a.eventSortKey - b.eventSortKey) || (a.eventType > b.eventType ? 1 : -1))
  })
  return result
}

// Rolls per-game history entries back up into one row per event (tournament or season),
// for display purposes. The OVR formula consumes the per-game entries directly; this is for
// UI tables/dropdowns that want a readable one-row-per-event summary instead of dozens of rows.
export function aggregateGameHistoryByEvent(entries = []) {
  const groups = {}
  entries.forEach((entry) => {
    if (!groups[entry.eventKey]) groups[entry.eventKey] = []
    groups[entry.eventKey].push(entry)
  })

  return Object.values(groups)
    .map((group) => {
      const first = group[0]
      const allPas = group.flatMap((g) => g.rawPas || [])
      const b = summarizeBatting(allPas)
      b.ops = b.obp + b.slg
      const totalPA = group.reduce((sum, g) => sum + (g.pa || 0), 0)
      const deltaEntries = group.filter((g) => Number.isFinite(g.gameDelta))
      const deltaPA = deltaEntries.reduce((sum, g) => sum + (g.pa || 0), 0)
      const avgDelta = deltaPA > 0
        ? deltaEntries.reduce((sum, g) => sum + g.gameDelta * g.pa, 0) / deltaPA
        : null

      return {
        eventKey: first.eventKey,
        eventId: first.eventId,
        eventType: first.eventType,
        eventNumber: first.eventNumber,
        eventSortKey: first.eventSortKey,
        // sortGroup/sortValue/rawPas mirror the shape CharacterDetailModal's source dropdown
        // already expects (tournaments before seasons, then chronological within each).
        sortGroup: first.eventType === 'tournament' ? 0 : 1,
        sortValue: first.eventSortKey,
        games: group.length,
        pa: totalPA,
        avg: b.avg,
        ops: b.ops,
        hr: b.homeRuns,
        rbi: b.rbi,
        avgDelta,
        rawPas: allPas,
      }
    })
    .sort((a, b) => (a.eventSortKey - b.eventSortKey) || (a.eventType > b.eventType ? 1 : -1))
}

// Per-game pitching history, mirroring buildCharacterGameHistory's batting approach but sourced
// from pitching_stints/season_pitching_stints. pitchPerfScore is derived from a FIP--style,
// league-relative metric (see fipForStints/perfScoreFromIndexPlus). gameDelta is judged the same
// player-relative way: this character's pitchPerfScore vs the same player's OTHER pitchers in
// that event, so a rough outing counts less if the player's whole staff struggled that event.
// Raised from 1 inning (3 outs) to 2 innings: FIP's 13x HR multiplier makes a single home run in
// a 1-inning sample swing wildly, which is far noisier than ERA was at the same sample size.
export const MIN_OUTS_PER_GAME = 6

// FIP for a single game's worth of stints, using the same formula/constant as computeLeagueConstants/
// summarizeAdvancedPitching so per-game perf scores agree with the season/career advanced stats.
function fipForStints(stints = [], FIP_constant = 3.2) {
  const outs = stints.reduce((sum, stint) => sum + outsFromInningsPitched(stint.innings_pitched), 0)
  const ip = outs / 3
  if (!ip) return null
  const bb = stints.reduce((sum, stint) => sum + (stint.walks || 0), 0)
  const k = stints.reduce((sum, stint) => sum + (stint.strikeouts || 0), 0)
  const hr = stints.reduce((sum, stint) => sum + (stint.hr_allowed || 0), 0)
  return (((13 * hr) + (3 * bb) - (2 * k)) / ip) + FIP_constant
}

function buildPlayerEventStints(stints = [], gameMetaById = {}) {
  const map = {}
  for (const stint of stints) {
    const meta = gameMetaById[stint.game_id]
    if (!meta) continue
    const key = `${meta.eventKey}:${stint.player_id}`
    if (!map[key]) map[key] = []
    map[key].push(stint)
  }
  return map
}

function buildPerGamePitchingEntries(stints = [], gameMetaById = {}, playerEventStints = {}, leagueConstants = {}, playerNameById = {}) {
  const lgFIP = leagueConstants.lgFIP || computeLeagueConstants([], stints).lgFIP
  const FIP_constant = leagueConstants.FIP_constant ?? computeLeagueConstants([], stints).FIP_constant
  const pitchPerfScoreForStints = (gameStints) => {
    const fip = fipForStints(gameStints, FIP_constant)
    return fip === null ? null : perfScoreFromIndexPlus((fip / lgFIP) * 100, { invert: true })
  }

  const byCharGame = {}
  const byCharEvent = {}
  for (const stint of stints) {
    const meta = gameMetaById[stint.game_id]
    if (!meta) continue
    if (!byCharGame[stint.character_id]) byCharGame[stint.character_id] = {}
    if (!byCharGame[stint.character_id][stint.game_id]) byCharGame[stint.character_id][stint.game_id] = []
    byCharGame[stint.character_id][stint.game_id].push(stint)
    if (!byCharEvent[stint.character_id]) byCharEvent[stint.character_id] = {}
    if (!byCharEvent[stint.character_id][meta.eventKey]) byCharEvent[stint.character_id][meta.eventKey] = []
    byCharEvent[stint.character_id][meta.eventKey].push(stint)
  }

  const byCharEventSummary = {}
  for (const [charId, byEvent] of Object.entries(byCharEvent)) {
    byCharEventSummary[charId] = {}
    for (const [eventKey, eventStints] of Object.entries(byEvent)) {
      const meta = gameMetaById[eventStints[0]?.game_id]
      const outs = eventStints.reduce((sum, stint) => sum + outsFromInningsPitched(stint.innings_pitched), 0)
      const qualifies = outs >= MIN_OUTS_PER_GAME
      const pitchPerfScore = qualifies ? pitchPerfScoreForStints(eventStints) : null
      const playerId = eventStints[0]?.player_id ?? null

      let baselinePerf = null
      let gameDelta = null
      if (pitchPerfScore !== null && meta) {
        const eventPlayerStints = playerEventStints[`${meta.eventKey}:${playerId}`] || []
        const otherCharStints = eventPlayerStints.filter((stint) => String(stint.character_id) !== String(charId))
        if (otherCharStints.length > 0) {
          baselinePerf = pitchPerfScoreForStints(otherCharStints)
          gameDelta = baselinePerf === null ? 0 : clampGameDelta(pitchPerfScore - baselinePerf)
        } else {
          gameDelta = 0
        }
      }

      byCharEventSummary[charId][eventKey] = {
        eventOuts: outs,
        eventPitchPerfScore: pitchPerfScore,
        eventBaselinePerf: baselinePerf,
        eventGameDelta: gameDelta,
      }
    }
  }

  const result = {}
  for (const [charId, byGame] of Object.entries(byCharGame)) {
    result[charId] = Object.entries(byGame).map(([gameId, gameStints]) => {
      const meta = gameMetaById[gameId] || gameMetaById[gameStints[0].game_id]
      const eventSummary = byCharEventSummary[charId]?.[meta?.eventKey] || {}
      const p = summarizePitching(gameStints)
      const outs = gameStints.reduce((sum, stint) => sum + outsFromInningsPitched(stint.innings_pitched), 0)
      const qualifies = outs >= MIN_OUTS_PER_GAME
      const pitchPerfScore = qualifies ? pitchPerfScoreForStints(gameStints) : null
      const playerId = gameStints[0].player_id ?? null
      const playerSkillScore = getPlayerSkillProfile(playerNameById[playerId]).skillScore

      let gameDelta = null
      if (pitchPerfScore !== null) {
        const eventPlayerStints = playerEventStints[`${meta.eventKey}:${playerId}`] || []
        const otherCharStints = eventPlayerStints.filter((stint) => String(stint.character_id) !== String(charId))
        if (otherCharStints.length > 0) {
          const baselinePerf = pitchPerfScoreForStints(otherCharStints)
          gameDelta = baselinePerf === null ? 0 : clampGameDelta(pitchPerfScore - baselinePerf)
        } else {
          gameDelta = 0
        }
      }

      return {
        gameId,
        eventId: meta.eventId,
        eventType: meta.eventType,
        eventKey: meta.eventKey,
        eventNumber: meta.eventNumber,
        eventSortKey: meta.eventSortKey,
        playerId,
        playerSkillScore,
        outs,
        innings: p.innings,
        era: p.era,
        whip: p.whip,
        pitchPerfScore,
        gameDelta,
        ...eventSummary,
        rawStints: gameStints,
      }
    })
  }
  return result
}

// leagueConstants is optional — see buildCharacterGameHistory's comment for the same pattern.
export function buildCharacterPitchingGameHistory(
  pitchingStints = [],
  games = [],
  tournaments = [],
  seasonPitchingStints = [],
  seasons = [],
  leagueConstants = null,
  playerNameById = {},
) {
  const resolvedLeagueConstants = leagueConstants || computeLeagueConstants([], [...pitchingStints, ...seasonPitchingStints])

  const tournamentById = Object.fromEntries(tournaments.map((t) => [t.id, t]))
  const seasonById = Object.fromEntries(seasons.map((s) => [s.id, s]))

  const tournamentGameMetaById = buildGameMetaById(
    games, tournamentById, 'tournament', 'tournament_id',
    (tournament, id) => tournament?.tournament_number ?? id,
    (tournament) => tournament?.tournament_number ?? 0,
  )
  const seasonGameMetaById = buildSeasonGameMetaFromPAs(seasonPitchingStints, seasonById)

  const tournamentPlayerEventStints = buildPlayerEventStints(pitchingStints, tournamentGameMetaById)
  const seasonPlayerEventStints = buildPlayerEventStints(seasonPitchingStints, seasonGameMetaById)

  const tournamentEntries = buildPerGamePitchingEntries(pitchingStints, tournamentGameMetaById, tournamentPlayerEventStints, resolvedLeagueConstants, playerNameById)
  const seasonEntries = buildPerGamePitchingEntries(seasonPitchingStints, seasonGameMetaById, seasonPlayerEventStints, resolvedLeagueConstants, playerNameById)

  const charIds = new Set([...Object.keys(tournamentEntries), ...Object.keys(seasonEntries)])
  const result = {}
  charIds.forEach((charId) => {
    result[charId] = [...(tournamentEntries[charId] || []), ...(seasonEntries[charId] || [])]
      .sort((a, b) => (a.eventSortKey - b.eventSortKey) || (a.eventType > b.eventType ? 1 : -1))
  })
  return result
}

// Per-game fielding history. Chances are matched the same way summarizeFielding does (position +
// inning + defensive team), so a chance only resolves when defensive_team_id was actually
// recorded for that play. Older imports/backfills — especially Tournament 1 rows created before
// tournament scorebook saves stamped team ids — may still be missing that context. Games that
// can't be matched to a fielder simply contribute no chances rather than guessing.
// fieldPerfScore is derived from "Fielding%+" — fielding percentage relative to the league-average
// fielding percentage (100 = average), the best available league-relative metric given the data:
// only error/no-error per attempted chance is tracked today, with no putout/assist/range data to
// support a true defensive-range metric. gameDelta is the same player-relative comparison as
// batting/pitching, against the player's OTHER fielders in that event.
export const MIN_FIELDING_CHANCES_PER_GAME = 2

// League-average fielding percentage across every tracked chance, computed dynamically the same
// way computeLeagueConstants derives lgwOBA/lgFIP — no hardcoded constant.
export function computeFieldingLeagueConstants(allChances = []) {
  const realChances = allChances.filter((c) => !c.isBuddyJump)
  if (!realChances.length) return { lgFieldPct: 1 }
  const errors = realChances.filter((c) => c.isError).length
  return { lgFieldPct: 1 - (errors / realChances.length) }
}

function matchFielderForPa(pa, gameFieldersByGameId, position) {
  const candidates = gameFieldersByGameId[pa.game_id]
  if (!candidates) return null
  const resolvedPosition = Number(position ?? (pa.hit_location || pa.error_position))
  if (!Number.isFinite(resolvedPosition)) return null
  return candidates.find((fielder) => (
    Number(fielder.position) === resolvedPosition &&
    Number(fielder.inning_from || 1) <= Number(pa.inning || 1) &&
    (fielder.inning_to == null || Number(fielder.inning_to) >= Number(pa.inning || 1)) &&
    String(fielder.team_id) === String(pa.defensive_team_id)
  )) || null
}

// resolveTeamPlayerId maps a fielder's team_id to the owning player_id. For tournament games
// team_id IS the player_id already (players are teams); for season games team_id is a
// season_teams.id and needs the season_teams.player_id lookup passed in by the caller.
//
// Putout/assist: the fielder chain (e.g. "G6-4-3" or "G6-4-E4") is recovered from the saved
// notation string via parseFielderChainFromNotation — the LAST position in the chain gets the
// putout, every earlier position gets an assist (this is the same convention already used live
// during scorebook entry, see Scorebook.jsx's putoutPosition/touchedBases derivation). Older rows
// without notation fall back to the single hit_location/error_position chance.
//
// Pure "reached on error" plays with no outs recorded should not manufacture a putout/assist just
// because a fielder chain was saved — the batter reached safely, so only the chance/error itself
// should count. If the scorer explicitly recorded outs_on_play on the same error play, keep using
// the chain for PO/A as the best available approximation.
export function buildFieldingChances(plateAppearances = [], gameFielders = [], charactersByName = {}, resolveTeamPlayerId = (teamId) => teamId) {
  const gameFieldersByGameId = groupBy(gameFielders, 'game_id')
  const chances = []
  for (const pa of plateAppearances) {
    const notation = pa.is_error ? (pa.error_notation || pa.hit_notation) : pa.hit_notation
    const chain = parseFielderChainFromNotation(notation)
    const fallbackPosition = pa.hit_location ?? pa.error_position
    const outsOnPlay = calculateOutsForPa(pa.result, pa.outs_on_play)
    const creditOutsOnPlay = !pa.is_error || outsOnPlay > 0
    // Every fielder actually charged with an error on this play — parsed from
    // the notation's "-E<n>" segments, which a play can carry more than one
    // of (e.g. "6-4-E6-E4" when both the shortstop and second baseman booted
    // a relay). Older rows saved before multi-error support only ever wrote a
    // single "-E<n>" segment, which this still picks up fine; rows with no
    // notation at all fall back to the single error_position column.
    const notationErrorPositions = parseErrorPositionsFromNotation(notation)
    const errorPositions = notationErrorPositions.length
      ? notationErrorPositions
      : (pa.is_error && pa.error_position != null ? [String(pa.error_position)] : [])
    // Keep the hit_location/error_position fallback only for plays that actually recorded
    // an out (older GO/FO/etc rows without notation) or an error. A clean no-out hit with
    // only hit_location set is just where the ball landed, not a fielder chance/putout.
    const positions = chain.length
      ? chain
      : pa.result === 'K'
        ? [2]
        : ((pa.is_error || outsOnPlay > 0) && fallbackPosition != null ? [fallbackPosition] : [])

    positions.forEach((position, index) => {
      const fielder = matchFielderForPa(pa, gameFieldersByGameId, position)
      if (!fielder) return
      const character = charactersByName[fielder.character]
      if (!character) return
      chances.push({
        gameId: pa.game_id,
        characterId: character.id,
        playerId: resolveTeamPlayerId(fielder.team_id),
        position: Number(fielder.position ?? position),
        isError: Boolean(pa.is_error) && errorPositions.includes(String(position)),
        isPutout: creditOutsOnPlay && index === positions.length - 1,
        isAssist: creditOutsOnPlay && index !== positions.length - 1,
        isBuddyJump: false,
        // A nice/diving play only ever applies to the first fielder to touch
        // the ball on the play (see Scorebook's NICE PLAY toggle).
        isNicePlay: Boolean(pa.is_nice_play) && index === 0,
        starHitUsed: Boolean(pa.star_hit_used),
        // Range Runs (see fieldingRange.js) only makes sense for the fielder
        // who actually ranged to the batted ball — later fielders in the
        // chain are just receiving a throw, not covering ground for the hit.
        difficulty: index === 0
          ? computeDifficultySignal(fielder.position ?? position, pa.hit_stadium_key, {
            hitDistanceFt: pa.hit_distance_ft,
            hitAngleDeg: pa.hit_angle_deg,
            fieldedX: pa.fielded_x,
            fieldedY: pa.fielded_y,
            hangTimeSec: pa.hang_time_sec,
            fieldedTimeSec: pa.fielded_video_sec != null && pa.contact_video_sec != null
              ? pa.fielded_video_sec - pa.contact_video_sec
              : null,
          })
          : null,
      })
    })

    // Buddy Jump credit comes straight off its own columns rather than the parsed notation
    // chain (mirrors Stats.jsx's league-wide fielding aggregation) — tracked as a standalone
    // count per fielder, not mixed into TC/PO/A/E so it doesn't skew fielding percentage.
    if (pa.is_buddy_jump) {
      const buddyPositions = [pa.buddy_jump_assist_position, pa.buddy_jump_putout_position]
        .filter((position) => position != null && position !== '')
      buddyPositions.forEach((position) => {
        const fielder = matchFielderForPa(pa, gameFieldersByGameId, position)
        if (!fielder) return
        const character = charactersByName[fielder.character]
        if (!character) return
        chances.push({
          gameId: pa.game_id,
          characterId: character.id,
          playerId: resolveTeamPlayerId(fielder.team_id),
          position: Number(fielder.position ?? position),
          isError: false,
          isPutout: false,
          isAssist: false,
          isBuddyJump: true,
          starHitUsed: Boolean(pa.star_hit_used),
        })
      })
    }
  }
  return chances
}

function buildPlayerEventChances(chances = [], gameMetaById = {}) {
  const map = {}
  for (const chance of chances) {
    const meta = gameMetaById[chance.gameId]
    if (!meta) continue
    const key = `${meta.eventKey}:${chance.playerId}`
    if (!map[key]) map[key] = []
    map[key].push(chance)
  }
  return map
}

function buildPerGameFieldingEntries(chances = [], gameMetaById = {}, playerEventChances = {}, fieldingLeagueConstants = {}) {
  const lgFieldPct = fieldingLeagueConstants.lgFieldPct || computeFieldingLeagueConstants(chances).lgFieldPct
  const fieldPerfScoreForChances = (gameChances) => {
    const realChances = gameChances.filter((c) => !c.isBuddyJump)
    if (!realChances.length) return null
    const errors = realChances.filter((c) => c.isError).length
    const fieldPctPlus = ((1 - (errors / realChances.length)) / lgFieldPct) * 100
    return perfScoreFromIndexPlus(fieldPctPlus)
  }

  const byCharGame = {}
  for (const chance of chances) {
    const meta = gameMetaById[chance.gameId]
    if (!meta) continue
    if (!byCharGame[chance.characterId]) byCharGame[chance.characterId] = {}
    if (!byCharGame[chance.characterId][chance.gameId]) byCharGame[chance.characterId][chance.gameId] = []
    byCharGame[chance.characterId][chance.gameId].push(chance)
  }

  const result = {}
  for (const [charId, byGame] of Object.entries(byCharGame)) {
    result[charId] = Object.entries(byGame).map(([gameId, gameChances]) => {
      const meta = gameMetaById[gameId] || gameMetaById[gameChances[0].gameId]
      const realGameChances = gameChances.filter((c) => !c.isBuddyJump)
      const fieldPerfScore = realGameChances.length >= MIN_FIELDING_CHANCES_PER_GAME ? fieldPerfScoreForChances(gameChances) : null
      const playerId = gameChances[0].playerId ?? null

      let gameDelta = null
      if (fieldPerfScore !== null) {
        const eventPlayerChances = playerEventChances[`${meta.eventKey}:${playerId}`] || []
        const otherCharChances = eventPlayerChances.filter((chance) => String(chance.characterId) !== String(charId))
        if (otherCharChances.length > 0) {
          const baselinePerf = fieldPerfScoreForChances(otherCharChances)
          gameDelta = baselinePerf === null ? 0 : clampGameDelta(fieldPerfScore - baselinePerf)
        } else {
          gameDelta = 0
        }
      }

      return {
        gameId,
        eventId: meta.eventId,
        eventType: meta.eventType,
        eventKey: meta.eventKey,
        eventNumber: meta.eventNumber,
        eventSortKey: meta.eventSortKey,
        playerId,
        chances: realGameChances.length,
        errors: realGameChances.filter((c) => c.isError).length,
        putouts: realGameChances.filter((c) => c.isPutout).length,
        assists: realGameChances.filter((c) => c.isAssist).length,
        buddyJumps: gameChances.filter((c) => c.isBuddyJump).length,
        nicePlays: realGameChances.filter((c) => c.isNicePlay).length,
        fieldPerfScore,
        gameDelta,
      }
    })
  }
  return result
}

// fieldingLeagueConstants is optional — see buildCharacterGameHistory's comment for the same pattern.
export function buildCharacterFieldingGameHistory(
  plateAppearances = [],
  gameFielders = [],
  games = [],
  tournaments = [],
  seasonPlateAppearances = [],
  seasonGameFielders = [],
  seasons = [],
  charactersByName = {},
  seasonTeamPlayerById = {},
  fieldingLeagueConstants = null,
) {
  const tournamentById = Object.fromEntries(tournaments.map((t) => [t.id, t]))
  const seasonById = Object.fromEntries(seasons.map((s) => [s.id, s]))

  const tournamentGameMetaById = buildGameMetaById(
    games, tournamentById, 'tournament', 'tournament_id',
    (tournament, id) => tournament?.tournament_number ?? id,
    (tournament) => tournament?.tournament_number ?? 0,
  )
  const seasonGameMetaById = buildSeasonGameMetaFromPAs(seasonPlateAppearances, seasonById)

  const tournamentChances = buildFieldingChances(plateAppearances, gameFielders, charactersByName)
  const seasonChances = buildFieldingChances(
    seasonPlateAppearances, seasonGameFielders, charactersByName,
    (teamId) => seasonTeamPlayerById[teamId] ?? teamId,
  )

  const resolvedFieldingLeagueConstants = fieldingLeagueConstants || computeFieldingLeagueConstants([...tournamentChances, ...seasonChances])

  const tournamentPlayerEventChances = buildPlayerEventChances(tournamentChances, tournamentGameMetaById)
  const seasonPlayerEventChances = buildPlayerEventChances(seasonChances, seasonGameMetaById)

  const tournamentEntries = buildPerGameFieldingEntries(tournamentChances, tournamentGameMetaById, tournamentPlayerEventChances, resolvedFieldingLeagueConstants)
  const seasonEntries = buildPerGameFieldingEntries(seasonChances, seasonGameMetaById, seasonPlayerEventChances, resolvedFieldingLeagueConstants)

  const charIds = new Set([...Object.keys(tournamentEntries), ...Object.keys(seasonEntries)])
  const result = {}
  charIds.forEach((charId) => {
    result[charId] = [...(tournamentEntries[charId] || []), ...(seasonEntries[charId] || [])]
      .sort((a, b) => (a.eventSortKey - b.eventSortKey) || (a.eventType > b.eventType ? 1 : -1))
  })
  return result
}

// Rolls per-game pitching history (buildCharacterPitchingGameHistory's output) back up into one
// row per event, mirroring aggregateGameHistoryByEvent's batting contract — used where a full
// per-season pitching line is needed for every character at once (e.g. league-wide awards),
// rather than the single-character tournament/season grouping useCharacterProfileData's
// buildPitchingHistory does for the profile page's own Stats section.
export function aggregatePitchingHistoryByEvent(entries = []) {
  const groups = {}
  entries.forEach((entry) => {
    if (!groups[entry.eventKey]) groups[entry.eventKey] = []
    groups[entry.eventKey].push(entry)
  })

  return Object.values(groups)
    .map((group) => {
      const first = group[0]
      const allStints = group.flatMap((g) => g.rawStints || [])
      const p = summarizePitching(allStints)
      return {
        eventKey: first.eventKey,
        eventId: first.eventId,
        eventType: first.eventType,
        eventNumber: first.eventNumber,
        eventSortKey: first.eventSortKey,
        sortGroup: first.eventType === 'tournament' ? 0 : 1,
        sortValue: first.eventSortKey,
        games: group.length,
        ...p,
        rawStints: allStints,
      }
    })
    .sort((a, b) => (a.eventSortKey - b.eventSortKey) || (a.eventType > b.eventType ? 1 : -1))
}

// Rolls per-game fielding history back up into one row per event (tournament or season),
// mirroring aggregateGameHistoryByEvent's grouping/sort contract for batting so CharacterPage
// can treat batting/pitching/fielding history uniformly in a year-by-year table.
export function aggregateFieldingHistoryByEvent(entries = []) {
  const groups = {}
  entries.forEach((entry) => {
    if (!groups[entry.eventKey]) groups[entry.eventKey] = []
    groups[entry.eventKey].push(entry)
  })

  return Object.values(groups)
    .map((group) => {
      const first = group[0]
      const chances = group.reduce((sum, g) => sum + (g.chances || 0), 0)
      const putouts = group.reduce((sum, g) => sum + (g.putouts || 0), 0)
      const assists = group.reduce((sum, g) => sum + (g.assists || 0), 0)
      const errors = group.reduce((sum, g) => sum + (g.errors || 0), 0)
      const buddyJumps = group.reduce((sum, g) => sum + (g.buddyJumps || 0), 0)
      const nicePlays = group.reduce((sum, g) => sum + (g.nicePlays || 0), 0)
      return {
        eventKey: first.eventKey,
        eventId: first.eventId,
        eventType: first.eventType,
        eventNumber: first.eventNumber,
        eventSortKey: first.eventSortKey,
        sortGroup: first.eventType === 'tournament' ? 0 : 1,
        sortValue: first.eventSortKey,
        games: group.length,
        chances,
        putouts,
        assists,
        errors,
        buddyJumps,
        nicePlays,
        fieldingPct: chances ? (chances - errors) / chances : null,
      }
    })
    .sort((a, b) => (a.eventSortKey - b.eventSortKey) || (a.eventType > b.eventType ? 1 : -1))
}

// Builds a gameId -> event metadata lookup (eventKey/eventType/eventId/eventNumber/eventSortKey)
// across both tournament and season games, keyed by String(game_id) so it can be joined against
// fielding chances/game-fielder rows regardless of which side's numeric id type they carry.
export function buildFieldingGameEventMeta(games = [], tournaments = [], seasonPlateAppearances = [], seasons = []) {
  const tournamentById = Object.fromEntries(tournaments.map((t) => [t.id, t]))
  const seasonById = Object.fromEntries(seasons.map((s) => [s.id, s]))
  const tournamentGameMetaById = buildGameMetaById(
    games, tournamentById, 'tournament', 'tournament_id',
    (tournament, id) => tournament?.tournament_number ?? id,
    (tournament) => tournament?.tournament_number ?? 0,
  )
  const seasonGameMetaById = buildSeasonGameMetaFromPAs(seasonPlateAppearances, seasonById)
  const combined = {}
  Object.entries(tournamentGameMetaById).forEach(([gameId, meta]) => { combined[String(gameId)] = meta })
  Object.entries(seasonGameMetaById).forEach(([gameId, meta]) => { combined[String(gameId)] = meta })
  return combined
}

// Groups one character's fielding chances (buildFieldingChances output, filtered to a single
// character) and their raw game-fielder rows (the source of truth for G/GS, since a start with
// zero balls hit their way wouldn't appear in `chances`) into one row per season/tournament +
// position — mirrors summarizeFieldingByPosition's per-position shape but broken out year-by-year,
// Baseball-Reference style. `starHitOnly: true` scopes to chances the opposing batter used Star
// Hit on and skips G/GS (matches summarizeStarHitFieldingByPosition's narrower shape) — pass an
// empty gameFielderRows array alongside it.
export function aggregateFieldingHistoryByEventAndPosition(chances = [], gameFielderRows = [], gameEventMetaById = {}, { starHitOnly = false } = {}) {
  const scopedChances = starHitOnly ? chances.filter((c) => c.starHitUsed) : chances
  const rows = new Map()

  const ensureRow = (meta, position) => {
    const rowKey = `${meta.eventKey}::${position}`
    if (!rows.has(rowKey)) {
      rows.set(rowKey, {
        eventKey: meta.eventKey, eventId: meta.eventId, eventType: meta.eventType,
        eventNumber: meta.eventNumber, eventSortKey: meta.eventSortKey,
        sortGroup: meta.eventType === 'tournament' ? 0 : 1, sortValue: meta.eventSortKey,
        position, games: new Set(), gamesStarted: new Set(),
        chances: 0, putouts: 0, assists: 0, errors: 0, buddyJumps: 0, nicePlays: 0,
      })
    }
    return rows.get(rowKey)
  }

  if (!starHitOnly) {
    gameFielderRows.forEach((row) => {
      const meta = gameEventMetaById[String(row.game_id)]
      if (!meta) return
      const position = POSITION_LABELS[Number(row.position)] || String(row.position ?? '?')
      const r = ensureRow(meta, position)
      r.games.add(String(row.game_id))
      if (Number(row.inning_from || 1) === 1) r.gamesStarted.add(String(row.game_id))
    })
  }

  scopedChances.forEach((chance) => {
    const meta = gameEventMetaById[String(chance.gameId)]
    if (!meta) return
    const position = POSITION_LABELS[Number(chance.position)] || String(chance.position ?? '?')
    const r = ensureRow(meta, position)
    if (chance.isBuddyJump) { r.buddyJumps += 1; return }
    r.chances += 1
    if (chance.isPutout) r.putouts += 1
    if (chance.isAssist) r.assists += 1
    if (chance.isError) r.errors += 1
    if (chance.isNicePlay) r.nicePlays += 1
  })

  return [...rows.values()]
    .map((r) => ({
      ...r,
      games: r.games.size,
      gamesStarted: r.gamesStarted.size,
      fieldingPct: r.chances ? (r.chances - r.errors) / r.chances : null,
    }))
    .sort((a, b) => (a.eventSortKey - b.eventSortKey) || (a.eventType > b.eventType ? 1 : -1) || (b.chances - a.chances))
}

// Returns the percentile (0-100) of `value` within `allValues` — "% of the field at or below
// this value." Pass `invert: true` for stats where lower is better (ERA, whiff%, K%) so the
// returned percentile still reads as "better than X% of the league" either way. Generalizes the
// one-off sorted/findIndex ranking pattern already used for stadium park-factor rankings.
export function percentileOfValue(value, allValues = [], { invert = false } = {}) {
  const clean = allValues.filter((v) => Number.isFinite(v))
  if (!Number.isFinite(value) || clean.length < 2) return null
  const sorted = [...clean].sort((a, b) => a - b)
  const countBelowOrEqual = sorted.filter((v) => v <= value).length
  const rawPct = (countBelowOrEqual / sorted.length) * 100
  return Math.round(invert ? 100 - rawPct : rawPct)
}

// Convenience wrapper: builds { [characterId]: { value, percentile } } for one metric across a
// whole roster in one pass.
export function buildPercentileLookup(valuesByCharacterId = {}, { invert = false } = {}) {
  const allValues = Object.values(valuesByCharacterId)
  const result = {}
  for (const [charId, value] of Object.entries(valuesByCharacterId)) {
    result[charId] = { value, percentile: percentileOfValue(value, allValues, { invert }) }
  }
  return result
}

// Computes rank + "led league"/top-N flags for one stat across all characters within a single
// event (tournament or season), given rows of { characterId, value, ... }. qualifier(row) lets
// callers gate rate stats (AVG/ERA) behind a minimum PA/IP threshold before ranking.
export function rankStatWithinEvent(rows = [], { higherIsBetter = true, qualifier = () => true, topN = 3 } = {}) {
  const qualifying = rows.filter(qualifier).filter((r) => Number.isFinite(r.value))
  const sorted = [...qualifying].sort((a, b) => (higherIsBetter ? b.value - a.value : a.value - b.value))
  return sorted.map((row, index) => ({
    ...row,
    rank: index + 1,
    led: index === 0,
    topN: index < topN,
  }))
}

export function buildHeadToHead(games = [], playerOneId, playerTwoId) {
  const matchupGames = games.filter(
    (game) =>
      [game.team_a_player_id, game.team_b_player_id].includes(playerOneId) &&
      [game.team_a_player_id, game.team_b_player_id].includes(playerTwoId) &&
      game.status === 'complete'
  )

  const summary = {
    games: matchupGames.length,
    playerOneWins: 0,
    playerTwoWins: 0,
    playerOneRuns: 0,
    playerTwoRuns: 0
  }

  matchupGames.forEach((game) => {
    const playerOneIsTeamA = game.team_a_player_id === playerOneId
    summary.playerOneRuns += playerOneIsTeamA ? game.team_a_runs : game.team_b_runs
    summary.playerTwoRuns += playerOneIsTeamA ? game.team_b_runs : game.team_a_runs

    if (game.winner_player_id === playerOneId) summary.playerOneWins += 1
    if (game.winner_player_id === playerTwoId) summary.playerTwoWins += 1
  })

  return summary
}

// `outsOnPlay`, when present, is the actual recorded out count for the play
// (see outs_on_play migration) — it overrides the result-based guess below,
// which can't see an out that happened to a runner other than the batter
// (e.g. a 1B where a preceding runner is thrown out stretching for an extra
// base: the batter's own result is a hit, but a real out still occurred).
export function calculateOutsForPa(result, outsOnPlay = null) {
  if (outsOnPlay != null) return Number(outsOnPlay)
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1  // lead runner is out; batter reaches safely
  if (outResults.has(result)) return 1
  return 0
}

// League constants for 3-inning / 9-out games.
export function computeLeagueConstants(allPAs = [], allStints = []) {
  const totalPA = allPAs.length || 1
  const hits = allPAs.filter(isCreditedHit).length
  const singles = allPAs.filter((pa) => isCreditedHitType(pa, '1B')).length
  const doubles = allPAs.filter((pa) => isCreditedHitType(pa, '2B')).length
  const triples = allPAs.filter((pa) => isCreditedHitType(pa, '3B')).length
  const hrs = allPAs.filter(isCreditedHomeRun).length
  const walks = allPAs.filter((pa) => pa.result === 'BB').length
  const hbp = allPAs.filter((pa) => pa.result === 'HBP').length
  const sfs = allPAs.filter((pa) => pa.result === 'SF').length
  const abs = allPAs.filter((pa) => isOfficialAtBat(pa)).length || 1
  const tb = singles + doubles * 2 + triples * 3 + hrs * 4

  const lgAVG = hits / abs
  const lgOBP = (hits + walks + hbp) / (abs + walks + hbp + sfs)
  const lgSLG = tb / abs
  const lgwOBA = ((0.69 * walks) + (0.72 * hbp) + (0.89 * singles) + (1.27 * doubles) + (1.62 * triples) + (2.10 * hrs)) /
    (abs + walks + sfs + hbp) || 0.320

  const totalOuts = allStints.reduce((sum, stint) => sum + outsFromInningsPitched(stint.innings_pitched), 0)
  const totalIP = totalOuts / 3 || 1
  const lgER = allStints.reduce((sum, stint) => sum + (stint.earned_runs || 0), 0)
  const lgHR = allStints.reduce((sum, stint) => sum + (stint.hr_allowed || 0), 0)
  const lgBB = allStints.reduce((sum, stint) => sum + (stint.walks || 0), 0)
  const lgHBP = allPAs.filter((entry) => entry.result === 'HBP').length
  const lgK = allStints.reduce((sum, stint) => sum + (stint.strikeouts || 0), 0)
  const lgERA = (lgER * 3) / totalIP
  const lgFIPraw = ((13 * lgHR) + (3 * (lgBB + lgHBP)) - (2 * lgK)) / totalIP
  const FIP_constant = lgERA - lgFIPraw
  const lgFIP = lgFIPraw + FIP_constant

  return { totalPA, lgAVG, lgOBP, lgSLG, lgwOBA, lgERA, lgFIP, FIP_constant }
}

export function summarizeAdvancedBatting(plateAppearances = [], leagueConstants = {}) {
  const { lgOBP = 0.320, lgSLG = 0.450, lgwOBA = 0.320 } = leagueConstants

  const pa = plateAppearances.length || 1
  const abs = plateAppearances.filter((entry) => isOfficialAtBat(entry)).length || 1
  const hits = plateAppearances.filter(isCreditedHit).length
  const singles = plateAppearances.filter((entry) => isCreditedHitType(entry, '1B')).length
  const doubles = plateAppearances.filter((entry) => isCreditedHitType(entry, '2B')).length
  const triples = plateAppearances.filter((entry) => isCreditedHitType(entry, '3B')).length
  const hrs = plateAppearances.filter(isCreditedHomeRun).length
  const walks = plateAppearances.filter((entry) => entry.result === 'BB').length
  const hbp = plateAppearances.filter((entry) => entry.result === 'HBP').length
  const sfs = plateAppearances.filter((entry) => entry.result === 'SF').length
  const ks = plateAppearances.filter((entry) => entry.result === 'K').length
  const tb = singles + doubles * 2 + triples * 3 + hrs * 4
  const xbh = doubles + triples + hrs
  const outs = plateAppearances.filter((entry) => outResults.has(entry.result)).length || 1

  const avg = hits / abs
  const obp = (hits + walks + hbp) / (abs + walks + hbp + sfs) || 0
  const slg = tb / abs || 0
  const babip = (abs - ks - hrs + sfs) > 0
    ? (hits - hrs) / (abs - ks - hrs + sfs)
    : null
  const iso = slg - avg
  const woba = ((0.69 * walks) + (0.72 * hbp) + (0.89 * singles) + (1.27 * doubles) + (1.62 * triples) + (2.10 * hrs)) /
    (abs + walks + sfs + hbp) || 0
  const wrcPlus = lgwOBA > 0 ? Math.round((woba / lgwOBA) * 100) : 100
  const opsPlus = (lgOBP > 0 && lgSLG > 0)
    ? Math.round((((obp / lgOBP) + (slg / lgSLG)) - 1) * 100)
    : 100
  const kPct = ks / pa
  const bbPct = walks / pa
  const bbkRatio = summarizeRatio(walks, ks)
  const xbhPct = xbh / abs
  const hrPerPa = hrs / pa
  const rc = (abs + walks) > 0 ? ((hits + walks) * tb) / (abs + walks) : 0
  const rc3 = outs > 0 ? (rc / outs) * 9 : 0

  return {
    babip: babip != null ? +babip.toFixed(3) : null,
    iso: +iso.toFixed(3),
    woba: +woba.toFixed(3),
    wrcPlus,
    opsPlus,
    kPct: +kPct.toFixed(3),
    bbPct: +bbPct.toFixed(3),
    bbkRatio: roundMetric(bbkRatio, 2),
    xbhPct: +xbhPct.toFixed(3),
    hrPerPa: +hrPerPa.toFixed(3),
    xbh,
    rc: +rc.toFixed(2),
    rc3: +rc3.toFixed(2),
  }
}

export function summarizeAdvancedPitching(stints = [], leagueConstants = {}, options = {}) {
  const { lgERA = 0, lgFIP = 0, FIP_constant = 3.2 } = leagueConstants
  const { plateAppearances = [] } = options

  const totalOuts = stints.reduce((sum, stint) => sum + outsFromInningsPitched(stint.innings_pitched), 0)
  const ip = totalOuts / 3 || 1
  const er = stints.reduce((sum, stint) => sum + (stint.earned_runs || 0), 0)
  const h = stints.reduce((sum, stint) => sum + (stint.hits_allowed || 0), 0)
  const bb = stints.reduce((sum, stint) => sum + (stint.walks || 0), 0)
  const k = stints.reduce((sum, stint) => sum + (stint.strikeouts || 0), 0)
  const hr = stints.reduce((sum, stint) => sum + (stint.hr_allowed || 0), 0)
  const hasPaData = Array.isArray(plateAppearances) && plateAppearances.length > 0
  const paHits = hasPaData ? plateAppearances.filter(isCreditedHit).length : h
  const paWalks = hasPaData ? plateAppearances.filter((pa) => pa.result === 'BB').length : bb
  const paStrikeouts = hasPaData ? plateAppearances.filter((pa) => pa.result === 'K').length : k
  const paHomeRuns = hasPaData ? plateAppearances.filter(isCreditedHomeRun).length : hr
  const hbpAllowed = hasPaData ? plateAppearances.filter((pa) => pa.result === 'HBP').length : 0
  const battersFaced = hasPaData ? plateAppearances.length : Math.max(1, totalOuts + h + bb + hbpAllowed)
  const atBatsAgainst = hasPaData ? plateAppearances.filter((pa) => isOfficialAtBat(pa)).length : h + totalOuts
  const sacrificeFliesAllowed = hasPaData ? plateAppearances.filter((pa) => pa.result === 'SF').length : 0

  const era3 = (er * 3) / ip
  const fip = (((13 * hr) + (3 * (bb + hbpAllowed)) - (2 * k)) / ip) + FIP_constant
  const whip = (h + bb) / ip
  const k3 = (k * 3) / ip
  const bb3 = (bb * 3) / ip
  const hr3 = (hr * 3) / ip
  const h3 = (h * 3) / ip
  const kPct = battersFaced > 0 ? paStrikeouts / battersFaced : 0
  const bbPct = battersFaced > 0 ? paWalks / battersFaced : 0
  const kBB = summarizeRatio(paStrikeouts, paWalks)
  const eraMinus = lgERA > 0 ? Math.round((era3 / lgERA) * 100) : 100
  const fipMinus = lgFIP > 0 ? Math.round((fip / lgFIP) * 100) : 100
  const babipAllowedDenominator = hasPaData
    ? (atBatsAgainst - paStrikeouts - paHomeRuns + sacrificeFliesAllowed)
    : Math.max(0, (totalOuts - k) + (h - hr))
  const babipAllowed = babipAllowedDenominator > 0
    ? (paHits - paHomeRuns) / babipAllowedDenominator
    : null

  return {
    fip: +fip.toFixed(2),
    era3: +era3.toFixed(2),
    whip: +whip.toFixed(2),
    k3: +k3.toFixed(2),
    bb3: +bb3.toFixed(2),
    hr3: +hr3.toFixed(2),
    h3: +h3.toFixed(2),
    kPct: +kPct.toFixed(3),
    bbPct: +bbPct.toFixed(3),
    kBB: roundMetric(kBB, 2),
    eraMinus,
    fipMinus,
    babipAllowed: roundMetric(babipAllowed, 3),
  }
}

export function summarizeHitLocations(plateAppearances = []) {
  const bip = plateAppearances.filter((pa) => battedBallResults.has(pa.result) && pa.hit_location)
  const total = bip.length
  const positions = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  const counts = Object.fromEntries(positions.map((pos) => [pos, bip.filter((pa) => Number(pa.hit_location) === pos).length]))
  const rates = Object.fromEntries(positions.map((pos) => [pos, total ? counts[pos] / total : 0]))
  return { total, counts, rates }
}

export function calculateParkFactors(stadiumPas = [], allPas = [], stadiumRunEvents = null, allRunEvents = null) {
  const stadiumGames = new Set(stadiumPas.map((pa) => pa.game_id)).size || 1
  const allGames = new Set(allPas.map((pa) => pa.game_id)).size || 1

  const factor = (stadiumCount, allCount) => {
    const stadiumRate = stadiumCount / stadiumGames
    const allRate = allCount / allGames
    return allRate > 0 ? stadiumRate / allRate : 1
  }

  const countResult = (pas, result) => pas.filter((pa) => pa.result === result).length
  const countHitResult = (pas, result) => pas.filter((pa) => isCreditedHitType(pa, result)).length
  const countHr = (pas) => pas.filter(isCreditedHomeRun).length

  // Real runs are tracked via run-event rows (runs_scored/season_runs_scored), not
  // pa.run_scored — that flag only reflects the batter's own PA and misses runs scored by
  // baserunners advanced on other batters' plays. Fall back to the PA flag only when no
  // run-event data was supplied (e.g. a caller that hasn't been updated yet).
  const runCount = stadiumRunEvents != null && allRunEvents != null
    ? [stadiumRunEvents.length, allRunEvents.length]
    : [stadiumPas.filter((pa) => pa.run_scored).length, allPas.filter((pa) => pa.run_scored).length]

  return {
    hr: factor(countHr(stadiumPas), countHr(allPas)),
    r: factor(runCount[0], runCount[1]),
    h: factor(
      stadiumPas.filter(isCreditedHit).length,
      allPas.filter(isCreditedHit).length,
    ),
    single: factor(countHitResult(stadiumPas, '1B'), countHitResult(allPas, '1B')),
    double: factor(countHitResult(stadiumPas, '2B'), countHitResult(allPas, '2B')),
    triple: factor(countHitResult(stadiumPas, '3B'), countHitResult(allPas, '3B')),
    walk: factor(countResult(stadiumPas, 'BB'), countResult(allPas, 'BB')),
    strikeout: factor(countResult(stadiumPas, 'K'), countResult(allPas, 'K')),
    hbp: factor(countResult(stadiumPas, 'HBP'), countResult(allPas, 'HBP')),
    sacFly: factor(countResult(stadiumPas, 'SF'), countResult(allPas, 'SF')),
    sacHit: factor(countResult(stadiumPas, 'SH'), countResult(allPas, 'SH')),
    error: factor(
      stadiumPas.filter((pa) => pa.is_error).length,
      allPas.filter((pa) => pa.is_error).length,
    ),
    doublePlay: factor(countResult(stadiumPas, 'DP'), countResult(allPas, 'DP')),
    reachedOnError: factor(countResult(stadiumPas, 'ROE'), countResult(allPas, 'ROE')),
  }
}

export function buildCharacterIntrinsics(char = {}) {
  const slapContact = Number(char.slap_contact || 60)
  const chargeContact = Number(char.charge_contact || 40)
  const slapPower = Number(char.slap_power || 30)
  const chargePower = Number(char.charge_power || 50)
  const fastball = Number(char.fastball_speed || 130)
  const curveball = Number(char.curveball_speed || 110)
  const curve = Number(char.curve || 40)
  const stamina = Number(char.stamina || 60)
  const starBoost = Number(char.star_boost_pct || 50)

  const powerScore = Math.round((chargePower * 0.65) + (slapPower * 0.35))
  const contactScore = Math.round((chargeContact * 0.55) + (slapContact * 0.45))
  const velocityIndex = Math.round((fastball * 0.65) + (curveball * 0.35))
  const breakIndex = Math.round(curve)
  const capPower = Math.round(chargePower * (chargeContact / 100))
  const starCeiling = Math.round(chargePower * (1 + (starBoost / 100)))
  const staminaGrade = stamina >= 80 ? 'A' : stamina >= 60 ? 'B' : stamina >= 40 ? 'C' : stamina >= 20 ? 'D' : 'F'

  return {
    powerScore,
    contactScore,
    velocityIndex,
    breakIndex,
    capPower,
    starCeiling,
    stamina,
    staminaGrade,
    starBoostPct: starBoost,
    hittingTrajectory: char.hitting_trajectory || 'Medium',
    characterClass: char.character_class || 'Balanced',
    isCaptain: Boolean(char.is_captain),
  }
}

// ─── Value Batting (simplified WAR) ───────────────────────────────────────────
// A from-scratch, in-house approximation of Baseball-Reference's Rbat/Rbaser/Rfield/Rpos/
// RAA/WAA/RAR/WAR — this game has no precedent for park-adjusted linear weights or a
// replacement-level baseline calibrated over decades of MLB history, so these constants are
// reasonable stand-ins tuned to this game's much smaller-sample, higher-scoring 3-inning format,
// not a literal port of MLB's methodology.
const WOBA_SCALE = 1.15
const POSITION_ADJUSTMENTS_PER_100_PA = { 1: 3, 2: 8, 3: -8, 4: 2, 5: 1, 6: 4, 7: -5, 8: 0, 9: -5 }
const REPLACEMENT_RUNS_PER_PA = 0.06
const RUNS_PER_WIN = 6

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

// Shortens a season's stored name for compact display, matching the "MST N" tournament
// abbreviation convention — e.g. "MSL Season 1" -> "MSL 1". Names that don't contain "Season"
// pass through unchanged.
export function abbreviateSeasonName(name) {
  if (!name) return name
  return String(name).replace(/\bSeason\s+/i, '')
}

// chances/errors: this character's aggregated fielding chances/errors in the same scope as
// plateAppearances (e.g. from fieldingHistory/allTimeFielding, already aggregated elsewhere).
// position: numeric position code (1-9, matching POSITION_LABELS) the runs-above-average
// positional adjustment should be applied for — omit to skip Rpos (e.g. pitchers batting).
// rangeRuns: this character's summarizeFieldingRange() total (fieldingRange.js), already in the
// same "runs" unit as everything else here — pass it whenever it's available (it qualifies, i.e.
// enough rangeable chances were recorded) to use it as Rfield instead of the cruder error-rate-only
// formula below, which has no concept of how hard a chance was to reach in the first place. Omit
// (or pass null) to fall back to the error-rate formula, e.g. for scopes too small for Range Runs
// to qualify.
export function summarizeValueBatting(plateAppearances = [], leagueConstants = {}, { chances = 0, errors = 0, position = null, rangeRuns = null } = {}) {
  const { lgwOBA = 0.320, lgFieldPct = 0.95 } = leagueConstants
  const pa = plateAppearances.length
  const { woba } = summarizeAdvancedBatting(plateAppearances, leagueConstants)

  const rbat = pa > 0 ? ((woba - lgwOBA) / WOBA_SCALE) * pa : 0
  const rbaser = 0 // no stolen-base/caught-stealing event data exists to derive this from

  const fieldPct = chances > 0 ? (chances - errors) / chances : lgFieldPct
  const rfield = rangeRuns != null ? rangeRuns : (chances > 0 ? (fieldPct - lgFieldPct) * chances * 3 : 0)

  const rpos = (position != null && POSITION_ADJUSTMENTS_PER_100_PA[position] != null)
    ? (POSITION_ADJUSTMENTS_PER_100_PA[position] * (pa / 100))
    : 0

  const raa = rbat + rbaser + rfield + rpos
  const rar = raa + (REPLACEMENT_RUNS_PER_PA * pa)
  const war = rar / RUNS_PER_WIN
  const waa = raa / RUNS_PER_WIN

  return { rbat: round2(rbat), rbaser: round2(rbaser), rfield: round2(rfield), rpos: round2(rpos), raa: round2(raa), waa: round2(waa), rar: round2(rar), war: round2(war) }
}

// ─── Splits (home/away, regular season vs postseason, vs L/R) ───────────────────────────────
// Tags each PA with isHome/isPostseason from the same game/season_schedule metadata already
// used for franchise history + game logs (useTeamProfileData). Tournament games have no explicit
// home_team_id column, so team_a_player_id is treated as the home team by convention (matches
// how Scorebook already treats team A as batting second/home).
// Lighter-weight variant for pitching_stints/season_pitching_stints (no defensive_team_id to
// derive home/away from), used only to split a Postseason Pitching table off the regular one.
// Tournaments are single-elimination brackets end-to-end (every game carries a bracket-round
// `stage` label), so there's no "regular season vs playoffs" distinction within one — only a
// season's own playoff games count as postseason.
export function tagStintsWithPostseason(tournamentStints = [], seasonStints = [], { seasonScheduleByGameId = {} } = {}) {
  const tagTournament = (stint) => ({ ...stint, isPostseason: false })
  const tagSeason = (stint) => ({ ...stint, isPostseason: Boolean(seasonScheduleByGameId[stint.game_id]?.stage) })
  return [...tournamentStints.map(tagTournament), ...seasonStints.map(tagSeason)]
}

// See tagStintsWithPostseason: tournament games are never counted as "postseason" — only a
// season's own playoff games are.
export function tagPasWithGameContext(tournamentPas = [], seasonPas = [], { gamesById = {}, seasonScheduleByGameId = {} } = {}) {
  const tagTournamentPa = (pa) => {
    const game = gamesById[pa.game_id]
    if (!game) return { ...pa, isHome: null, isPostseason: false }
    const battingTeamId = String(pa.defensive_team_id) === String(game.team_a_player_id) ? game.team_b_player_id : game.team_a_player_id
    return { ...pa, isHome: String(battingTeamId) === String(game.team_a_player_id), isPostseason: false }
  }
  const tagSeasonPa = (pa) => {
    const sched = seasonScheduleByGameId[pa.game_id]
    if (!sched) return { ...pa, isHome: null, isPostseason: false }
    const battingTeamId = String(pa.defensive_team_id) === String(sched.home_team_id) ? sched.away_team_id : sched.home_team_id
    return { ...pa, isHome: String(battingTeamId) === String(sched.home_team_id), isPostseason: Boolean(sched.stage) }
  }
  return [...tournamentPas.map(tagTournamentPa), ...seasonPas.map(tagSeasonPa)]
}

export function buildPitchParticipantIndex(pitches = []) {
  return pitches.reduce((index, pitch) => {
    if (pitch?.pa_id == null) return index
    const key = String(pitch.pa_id)
    const current = index[key] || {}
    index[key] = {
      pitcherName: pitch.pitcher_id || current.pitcherName || null,
      batterName: pitch.batter_id || current.batterName || null,
    }
    return index
  }, {})
}

function buildPitchingStintIndex(pitchingStints = []) {
  return pitchingStints.reduce((index, stint) => {
    if (stint?.game_id == null) return index
    const gameKey = String(stint.game_id)
    const playerKey = stint.player_id != null ? String(stint.player_id) : null
    const characterKey = stint.character_id != null ? String(stint.character_id) : null
    if (!index.byGameAndPlayer[gameKey]) index.byGameAndPlayer[gameKey] = {}
    if (!index.byGameAndCharacter[gameKey]) index.byGameAndCharacter[gameKey] = {}
    if (playerKey) {
      if (!index.byGameAndPlayer[gameKey][playerKey]) index.byGameAndPlayer[gameKey][playerKey] = []
      index.byGameAndPlayer[gameKey][playerKey].push(stint)
    }
    if (characterKey) {
      if (!index.byGameAndCharacter[gameKey][characterKey]) index.byGameAndCharacter[gameKey][characterKey] = []
      index.byGameAndCharacter[gameKey][characterKey].push(stint)
    }
    return index
  }, { byGameAndPlayer: {}, byGameAndCharacter: {} })
}

function pickLikelyStint(stints = [], createdAt) {
  if (!stints.length) return null
  if (stints.length === 1) return stints[0]
  if (createdAt) {
    const paTime = new Date(createdAt).getTime()
    if (Number.isFinite(paTime)) {
      const eligible = stints
        .filter((stint) => {
          const stintTime = new Date(stint.created_at).getTime()
          return Number.isFinite(stintTime) && stintTime <= paTime
        })
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      if (eligible.length) return eligible[eligible.length - 1]
    }
  }
  const uniquePitchers = [...new Set(stints.map((stint) => String(stint.character_id)).filter(Boolean))]
  if (uniquePitchers.length === 1) return stints.find((stint) => String(stint.character_id) === uniquePitchers[0]) || null
  return null
}

function resolvePitchingPlayerId(pa, seasonTeamPlayerById = {}) {
  if (pa?.pitcher_player_id != null) return pa.pitcher_player_id
  if (pa?.defensive_team_id == null) return null
  return pa.season_id != null
    ? (seasonTeamPlayerById[String(pa.defensive_team_id)] ?? null)
    : pa.defensive_team_id
}

// Older imports/backfills do not always populate `pitcher_id` / `pitcher_player_id` directly on the
// PA row, and older scorebook saves may also be missing the derived hit-tracking geometry
// (`hit_x`/`hit_y`/`hit_distance_ft`/`hit_angle_deg`) even when the scorer picked a fielder
// location. Recover what we can from the defensive team, linked pitch rows, same-game pitching
// stints, and the game's stadium so owner/team summaries, spray charts, and handedness splits
// still work for legacy data.
export function enrichPasWithPitchingContext(
  plateAppearances = [],
  {
    pitchingStints = [],
    pitches = [],
    charactersByName = {},
    seasonTeamPlayerById = {},
    stadiumKeyByGameId = {},
  } = {},
) {
  const pitchParticipantsByPaId = buildPitchParticipantIndex(pitches)
  const stintIndex = buildPitchingStintIndex(pitchingStints)

  return plateAppearances.map((pa) => {
    let pitcherPlayerId = resolvePitchingPlayerId(pa, seasonTeamPlayerById)
    let pitcherId = pa.pitcher_id ?? null

    if (pitcherId == null) {
      const pitchPitcherName = pitchParticipantsByPaId[String(pa.id)]?.pitcherName
      if (pitchPitcherName) pitcherId = charactersByName[pitchPitcherName]?.id ?? null
    }

    if (pitcherPlayerId == null && pitcherId != null) {
      const stintsForPitcher = stintIndex.byGameAndCharacter[String(pa.game_id)]?.[String(pitcherId)] || []
      const uniquePlayers = [...new Set(stintsForPitcher.map((stint) => String(stint.player_id)).filter(Boolean))]
      if (uniquePlayers.length === 1) {
        pitcherPlayerId = stintsForPitcher.find((stint) => String(stint.player_id) === uniquePlayers[0])?.player_id ?? null
      }
    }

    if (pitcherId == null && pitcherPlayerId != null) {
      const stintsForPlayer = stintIndex.byGameAndPlayer[String(pa.game_id)]?.[String(pitcherPlayerId)] || []
      pitcherId = pickLikelyStint(stintsForPlayer, pa.created_at)?.character_id ?? null
    }

    const enriched = {
      ...pa,
      pitcher_id: pa.pitcher_id ?? pitcherId,
      pitcher_player_id: pa.pitcher_player_id ?? pitcherPlayerId,
    }

    const derivedHitFields = deriveTrackedHitFields(enriched, stadiumKeyByGameId[String(pa.game_id)] || null)
    return derivedHitFields ? { ...enriched, ...derivedHitFields } : enriched
  })
}

// Tags each PA with the opposing pitcher's throwing hand (for batting splits) and/or the
// opposing batter's batting hand (for pitching splits, where `plateAppearances` is the set of
// PAs a pitcher faced). nameById maps character_id -> character name for the handedness lookup.
export function tagPasWithHandedness(plateAppearances = [], nameById = {}) {
  return plateAppearances.map((pa) => ({
    ...pa,
    pitcherHandedness: pa.pitcher_id != null ? getHandedness(nameById[pa.pitcher_id]).throws : null,
    batterHandedness: pa.character_id != null ? getHandedness(nameById[pa.character_id]).bats : null,
  }))
}

// leagueConstants is optional — when supplied, each split row also carries woba/iso/babip
// (summarizeAdvancedBatting run over that same filtered subset) alongside the plain slash line, so
// e.g. a vs-LHP/RHP or Home/Away split can show wOBA, not just AVG/OBP/SLG/OPS.
function splitRow(pas = [], leagueConstants = null) {
  const b = summarizeBatting(pas)
  b.ops = b.obp + b.slg
  if (leagueConstants) {
    const adv = summarizeAdvancedBatting(pas, leagueConstants)
    b.woba = adv.woba
    b.iso = adv.iso
    b.babip = adv.babip
  }
  return b
}

// taggedPas must already carry isHome/isPostseason (tagPasWithGameContext) and pitcherHandedness
// (tagPasWithHandedness) for the vs-LHP/RHP split to be populated. leagueConstants is optional —
// see splitRow.
export function summarizeBattingSplits(taggedPas = [], leagueConstants = null) {
  return {
    home: splitRow(taggedPas.filter((pa) => pa.isHome === true), leagueConstants),
    away: splitRow(taggedPas.filter((pa) => pa.isHome === false), leagueConstants),
    regularSeason: splitRow(taggedPas.filter((pa) => !pa.isPostseason), leagueConstants),
    postseason: splitRow(taggedPas.filter((pa) => pa.isPostseason), leagueConstants),
    risp: splitRow(taggedPas.filter((pa) => hasRispOpportunity(pa)), leagueConstants),
    vsRHP: splitRow(taggedPas.filter((pa) => pa.pitcherHandedness === 'R'), leagueConstants),
    vsLHP: splitRow(taggedPas.filter((pa) => pa.pitcherHandedness === 'L'), leagueConstants),
  }
}

// taggedPas is the set of PAs a pitcher faced (plate_appearances.pitcher_id === character.id),
// tagged the same way — the resulting rows are the opponents' batting line against this pitcher,
// same convention Baseball-Reference uses for pitching splits. leagueConstants is optional — see
// splitRow; when supplied, adds wOBA-against/ISO-against/BABIP-against to each split.
export function summarizePitchingSplits(taggedPas = [], leagueConstants = null) {
  return {
    home: splitRow(taggedPas.filter((pa) => pa.isHome === false), leagueConstants), // pitcher is home when the batter (offense) is away
    away: splitRow(taggedPas.filter((pa) => pa.isHome === true), leagueConstants),
    regularSeason: splitRow(taggedPas.filter((pa) => !pa.isPostseason), leagueConstants),
    postseason: splitRow(taggedPas.filter((pa) => pa.isPostseason), leagueConstants),
    risp: splitRow(taggedPas.filter((pa) => hasRispOpportunity(pa)), leagueConstants),
    vsRHB: splitRow(taggedPas.filter((pa) => pa.batterHandedness === 'R'), leagueConstants),
    vsLHB: splitRow(taggedPas.filter((pa) => pa.batterHandedness === 'L'), leagueConstants),
  }
}

// ─── Appearances (games by position) ──────────────────────────────────────────────────────────
export const POSITION_LABELS = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF',
}
export const POSITION_CODES = Object.fromEntries(Object.entries(POSITION_LABELS).map(([code, label]) => [label, Number(code)]))

// gameFielderRows: game_fielders/season_game_fielders rows already filtered to this character
// (matched by `character` name, the same key buildFieldingChances uses).
// gameFielderRows: game_fielders/season_game_fielders rows for this character (drives G/GS per
// position). chances: buildFieldingChances() output filtered to this character (drives
// TC/PO/A/E/FLD% per position) — merges the old separate Appearances table into Fielding so each
// position shows both how often it was played and how it was played defensively.
export function summarizeFieldingByPosition(gameFielderRows = [], chances = []) {
  const gamesByPosition = {}
  const startedByPosition = {}
  const allGames = new Set()
  gameFielderRows.forEach((row) => {
    const label = POSITION_LABELS[Number(row.position)] || String(row.position ?? '?')
    const gameId = String(row.game_id)
    allGames.add(gameId)
    if (!gamesByPosition[label]) gamesByPosition[label] = new Set()
    gamesByPosition[label].add(gameId)
    if (Number(row.inning_from || 1) === 1) {
      if (!startedByPosition[label]) startedByPosition[label] = new Set()
      startedByPosition[label].add(gameId)
    }
  })

  const chancesByPosition = {}
  chances.forEach((chance) => {
    const label = POSITION_LABELS[Number(chance.position)] || String(chance.position ?? '?')
    if (!chancesByPosition[label]) chancesByPosition[label] = { chances: 0, putouts: 0, assists: 0, errors: 0, buddyJumps: 0, nicePlays: 0 }
    if (chance.isBuddyJump) {
      chancesByPosition[label].buddyJumps += 1
      return
    }
    chancesByPosition[label].chances += 1
    if (chance.isPutout) chancesByPosition[label].putouts += 1
    if (chance.isAssist) chancesByPosition[label].assists += 1
    if (chance.isError) chancesByPosition[label].errors += 1
    if (chance.isNicePlay) chancesByPosition[label].nicePlays += 1
  })

  const allLabels = new Set([...Object.keys(gamesByPosition), ...Object.keys(chancesByPosition)])
  const positions = [...allLabels]
    .map((label) => {
      const fc = chancesByPosition[label] || { chances: 0, putouts: 0, assists: 0, errors: 0, buddyJumps: 0, nicePlays: 0 }
      return {
        position: label,
        games: gamesByPosition[label]?.size || 0,
        gamesStarted: startedByPosition[label]?.size || 0,
        chances: fc.chances,
        putouts: fc.putouts,
        assists: fc.assists,
        errors: fc.errors,
        buddyJumps: fc.buddyJumps,
        nicePlays: fc.nicePlays,
        fieldingPct: fc.chances ? (fc.chances - fc.errors) / fc.chances : null,
      }
    })
    .sort((a, b) => b.games - a.games)

  return { totalGames: allGames.size, positions }
}

// "Stars Against > Fielding": how this character fielded balls put in play specifically off an
// opposing batter's Star Hit — a subset of buildFieldingChances() output (already carries
// starHitUsed per chance) grouped by position, same shape as summarizeFieldingByPosition but
// scoped to star-hit chances only.
export function summarizeStarHitFieldingByPosition(chances = []) {
  const starHitChances = chances.filter((c) => c.starHitUsed)
  const byPosition = {}
  starHitChances.forEach((chance) => {
    const label = POSITION_LABELS[Number(chance.position)] || String(chance.position ?? '?')
    if (!byPosition[label]) byPosition[label] = { chances: 0, errors: 0 }
    byPosition[label].chances += 1
    if (chance.isError) byPosition[label].errors += 1
  })
  const positions = Object.entries(byPosition)
    .map(([position, v]) => ({ position, chances: v.chances, errors: v.errors, fieldingPct: v.chances ? (v.chances - v.errors) / v.chances : null }))
    .sort((a, b) => b.chances - a.chances)
  const totalChances = positions.reduce((sum, p) => sum + p.chances, 0)
  const totalErrors = positions.reduce((sum, p) => sum + p.errors, 0)
  return { positions, totalChances, totalErrors, fieldingPct: totalChances ? (totalChances - totalErrors) / totalChances : null }
}
