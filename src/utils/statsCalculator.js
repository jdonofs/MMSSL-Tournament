import { parseFielderChainFromNotation } from './notation'

export const hitResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const plateAppearanceResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'BB', 'HBP', 'K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE'])
const outResults = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])
const battedBallResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE'])
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

export function normalizeRbiForPaResult(result, rbi = 0, isError = false) {
  if (isError || result === 'ROE' || result === 'DP' || result === 'TP') return 0
  return Number(rbi || 0)
}

export function getCreditedRbiForPa(pa = {}) {
  return normalizeRbiForPaResult(pa.result, pa.rbi, pa.is_error)
}

export function summarizeBatting(plateAppearances = []) {
  const atBats = plateAppearances.filter((pa) => isOfficialAtBat(pa)).length
  const hits = plateAppearances.filter((pa) => hitResults.has(pa.result)).length
  const walks = plateAppearances.filter((pa) => pa.result === 'BB').length
  const hbp = plateAppearances.filter((pa) => pa.result === 'HBP').length
  const singles = plateAppearances.filter((pa) => pa.result === '1B').length
  const doubles = plateAppearances.filter((pa) => pa.result === '2B').length
  const triples = plateAppearances.filter((pa) => pa.result === '3B').length
  const homeRuns = plateAppearances.filter((pa) => pa.result === 'HR' || pa.result === 'IPHR').length
  const totalBases = plateAppearances.reduce((total, pa) => {
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

  return {
    games: new Set(plateAppearances.map((pa) => pa.game_id)).size,
    plateAppearances: plateAppearances.length,
    atBats,
    hits,
    singles,
    doubles,
    triples,
    runs: plateAppearances.filter((pa) => pa.run_scored).length,
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
    ops: 0
  }
}

export function summarizePitching(stints = []) {
  const totalOuts = stints.reduce((total, stint) => total + outsFromInningsPitched(stint.innings_pitched), 0)
  const innings = inningsPitchedFromOuts(totalOuts)
  const inningsDecimal = totalOuts / 3
  const earnedRuns = stints.reduce((total, stint) => total + (stint.earned_runs || 0), 0)
  const runsAllowed = stints.reduce((total, stint) => total + (stint.runs_allowed || 0), 0)
  const hitsAllowed = stints.reduce((total, stint) => total + (stint.hits_allowed || 0), 0)
  const walks = stints.reduce((total, stint) => total + (stint.walks || 0), 0)
  const strikeouts = stints.reduce((total, stint) => total + (stint.strikeouts || 0), 0)
  const homeRunsAllowed = stints.reduce((total, stint) => total + (stint.hr_allowed || 0), 0)

  return {
    games: new Set(stints.map((stint) => stint.game_id)).size,
    innings,
    wins: stints.filter((stint) => stint.win).length,
    losses: stints.filter((stint) => stint.loss).length,
    saves: stints.filter((stint) => stint.save).length,
    shutouts: stints.filter((stint) => stint.shutout).length,
    completeGames: stints.filter((stint) => stint.complete_game).length,
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

export function summarizeSprayProfile(plateAppearances = []) {
  const hits = plateAppearances.filter((pa) => hitResults.has(pa.result))
  const total = hits.length || 0
  const count = (direction) => hits.filter((pa) => pa.direction === direction).length
  // hit_angle_deg is signed relative to straightaway CF (0deg): negative is the
  // pull side, positive is the oppo side, per the same convention Scorebook's
  // directionForFielderPosition() uses to bucket fielder positions into Pull/
  // Center/Oppo. This continuous version supplements those 3 coarse buckets.
  const withAngle = hits.filter((pa) => pa.hit_angle_deg != null && Number.isFinite(Number(pa.hit_angle_deg)))
  const avgSprayAngle = withAngle.length
    ? Math.round((withAngle.reduce((sum, pa) => sum + Number(pa.hit_angle_deg), 0) / withAngle.length) * 10) / 10
    : null
  return {
    total,
    pull: count('Pull'),
    center: count('Center'),
    oppo: count('Oppo'),
    pullRate: total ? count('Pull') / total : 0,
    centerRate: total ? count('Center') / total : 0,
    oppoRate: total ? count('Oppo') / total : 0,
    avgSprayAngle,
  }
}

export function summarizeStarHits(plateAppearances = []) {
  const used = plateAppearances.filter((pa) => pa.star_hit_used)
  const connected = used.filter((pa) => pa.star_hit_connected)
  const successful = used.filter((pa) => hitResults.has(pa.result))
  const totalRbi = used.reduce((sum, pa) => sum + Number(pa.star_hit_rbi || 0), 0)
  const resultBreakdown = ['1B', '2B', '3B', 'HR', 'Out', 'Error'].reduce((acc, result) => {
    acc[result] = used.filter((pa) => {
      const derivedResult = pa.star_hit_result || (hitResults.has(pa.result) ? pa.result : pa.is_error ? 'Error' : 'Out')
      const normalizedResult = derivedResult === 'IPHR' ? 'HR' : derivedResult
      return normalizedResult === result
    }).length
    return acc
  }, {})
  return {
    used: used.length,
    connected: connected.length,
    successful: successful.length,
    totalRbi,
    contactRate: used.length ? connected.length / used.length : 0,
    successRate: used.length ? successful.length / used.length : 0,
    avgRbiPerUse: used.length ? totalRbi / used.length : 0,
    resultBreakdown,
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
  const hitsAllowedOnStarPitch = starPitchPas.filter((pa) => hitResults.has(pa.result)).length
  const usageByCount = starPitches.reduce((acc, pitch) => {
    const key = `${pitch.count_balls_before ?? 0}-${pitch.count_strikes_before ?? 0}`
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  return {
    used: starPitches.length,
    paUsed: starPitchPas.length,
    outsOnStarPitch,
    hitsAllowedOnStarPitch,
    successRate: starPitchPas.length ? outsOnStarPitch / starPitchPas.length : 0,
    usageByCount,
  }
}

export function summarizePitchMix(plateAppearances = [], pitches = []) {
  const total = pitches.length
  const strikes = pitches.filter((pitch) => ['swinging_miss', 'looking', 'foul', 'in_play', 'hbp'].includes(pitch.result)).length
  const firstPitchStrikes = plateAppearances.length
    ? pitches.filter((pitch) => pitch.count_balls_before === 0 && pitch.count_strikes_before === 0 && pitch.result !== 'ball').length / plateAppearances.length
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

export function buildCharacterHistory(plateAppearances = [], pitchingStints = []) {
  const paByCharacter = groupBy(plateAppearances, 'character_id')
  const pitchingByCharacter = groupBy(pitchingStints, 'character_id')

  const ids = new Set([...Object.keys(paByCharacter), ...Object.keys(pitchingByCharacter)])
  const summary = {}

  ids.forEach((id) => {
    const batting = summarizeBatting(paByCharacter[id] || [])
    batting.ops = batting.obp + batting.slg
    const pitching = summarizePitching(pitchingByCharacter[id] || [])
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
  const singles = pas.filter((pa) => pa.result === '1B').length
  const doubles = pas.filter((pa) => pa.result === '2B').length
  const triples = pas.filter((pa) => pa.result === '3B').length
  const hrs = pas.filter((pa) => pa.result === 'HR' || pa.result === 'IPHR').length
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
      eventNumber: season?.name ?? pa.season_id,
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
        const otherCharPas = eventPlayerPas.filter((pa) => pa.character_id !== charId)
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

function buildPerGamePitchingEntries(stints = [], gameMetaById = {}, playerEventStints = {}, leagueConstants = {}) {
  const lgFIP = leagueConstants.lgFIP || computeLeagueConstants([], stints).lgFIP
  const FIP_constant = leagueConstants.FIP_constant ?? computeLeagueConstants([], stints).FIP_constant
  const pitchPerfScoreForStints = (gameStints) => {
    const fip = fipForStints(gameStints, FIP_constant)
    return fip === null ? null : perfScoreFromIndexPlus((fip / lgFIP) * 100, { invert: true })
  }

  const byCharGame = {}
  for (const stint of stints) {
    const meta = gameMetaById[stint.game_id]
    if (!meta) continue
    if (!byCharGame[stint.character_id]) byCharGame[stint.character_id] = {}
    if (!byCharGame[stint.character_id][stint.game_id]) byCharGame[stint.character_id][stint.game_id] = []
    byCharGame[stint.character_id][stint.game_id].push(stint)
  }

  const result = {}
  for (const [charId, byGame] of Object.entries(byCharGame)) {
    result[charId] = Object.entries(byGame).map(([gameId, gameStints]) => {
      const meta = gameMetaById[gameId] || gameMetaById[gameStints[0].game_id]
      const p = summarizePitching(gameStints)
      const outs = gameStints.reduce((sum, stint) => sum + outsFromInningsPitched(stint.innings_pitched), 0)
      const qualifies = outs >= MIN_OUTS_PER_GAME
      const pitchPerfScore = qualifies ? pitchPerfScoreForStints(gameStints) : null
      const playerId = gameStints[0].player_id ?? null

      let gameDelta = null
      if (pitchPerfScore !== null) {
        const eventPlayerStints = playerEventStints[`${meta.eventKey}:${playerId}`] || []
        const otherCharStints = eventPlayerStints.filter((stint) => stint.character_id !== charId)
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
        outs,
        innings: p.innings,
        era: p.era,
        whip: p.whip,
        pitchPerfScore,
        gameDelta,
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

  const tournamentEntries = buildPerGamePitchingEntries(pitchingStints, tournamentGameMetaById, tournamentPlayerEventStints, resolvedLeagueConstants)
  const seasonEntries = buildPerGamePitchingEntries(seasonPitchingStints, seasonGameMetaById, seasonPlayerEventStints, resolvedLeagueConstants)

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
// recorded for that play — currently only true for season games (tournament plate_appearances
// don't get a defensive_team_id stamped today, see TournamentGameSessionProvider). Games that
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
  if (!allChances.length) return { lgFieldPct: 1 }
  const errors = allChances.filter((c) => c.isError).length
  return { lgFieldPct: 1 - (errors / allChances.length) }
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
// Putout/assist: the fielder chain (e.g. "G6-4-3") is recovered from pa.hit_notation via
// parseFielderChainFromNotation — the LAST position in the chain gets the putout, every
// earlier position gets an assist (this is the same convention already used live during
// scorebook entry, see Scorebook.jsx's putoutPosition/touchedBases derivation). Older rows
// without hit_notation fall back to the single hit_location/error_position chance as a putout,
// same as the pre-existing behavior.
function buildFieldingChances(plateAppearances = [], gameFielders = [], charactersByName = {}, resolveTeamPlayerId = (teamId) => teamId) {
  const gameFieldersByGameId = groupBy(gameFielders, 'game_id')
  const chances = []
  for (const pa of plateAppearances) {
    const chain = parseFielderChainFromNotation(pa.hit_notation)
    const positions = chain.length ? chain : (pa.hit_location ? [pa.hit_location] : [])
    if (!positions.length) continue

    positions.forEach((position, index) => {
      const fielder = matchFielderForPa(pa, gameFieldersByGameId, position)
      if (!fielder) return
      const character = charactersByName[fielder.character]
      if (!character) return
      chances.push({
        gameId: pa.game_id,
        characterId: character.id,
        playerId: resolveTeamPlayerId(fielder.team_id),
        isError: Boolean(pa.is_error) && String(pa.error_character) === String(fielder.character),
        isPutout: index === positions.length - 1,
        isAssist: index !== positions.length - 1,
      })
    })
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
    if (!gameChances.length) return null
    const errors = gameChances.filter((c) => c.isError).length
    const fieldPctPlus = ((1 - (errors / gameChances.length)) / lgFieldPct) * 100
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
      const fieldPerfScore = gameChances.length >= MIN_FIELDING_CHANCES_PER_GAME ? fieldPerfScoreForChances(gameChances) : null
      const playerId = gameChances[0].playerId ?? null

      let gameDelta = null
      if (fieldPerfScore !== null) {
        const eventPlayerChances = playerEventChances[`${meta.eventKey}:${playerId}`] || []
        const otherCharChances = eventPlayerChances.filter((chance) => chance.characterId !== charId)
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
        chances: gameChances.length,
        errors: gameChances.filter((c) => c.isError).length,
        putouts: gameChances.filter((c) => c.isPutout).length,
        assists: gameChances.filter((c) => c.isAssist).length,
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
        fieldingPct: chances ? (chances - errors) / chances : null,
      }
    })
    .sort((a, b) => (a.eventSortKey - b.eventSortKey) || (a.eventType > b.eventType ? 1 : -1))
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

export function calculateOutsForPa(result) {
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1  // lead runner is out; batter reaches safely
  if (outResults.has(result)) return 1
  return 0
}

// League constants for 3-inning / 9-out games.
export function computeLeagueConstants(allPAs = [], allStints = []) {
  const totalPA = allPAs.length || 1
  const hits = allPAs.filter((pa) => hitResults.has(pa.result)).length
  const singles = allPAs.filter((pa) => pa.result === '1B').length
  const doubles = allPAs.filter((pa) => pa.result === '2B').length
  const triples = allPAs.filter((pa) => pa.result === '3B').length
  const hrs = allPAs.filter((pa) => pa.result === 'HR' || pa.result === 'IPHR').length
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
  const lgHBP = 0
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
  const hits = plateAppearances.filter((entry) => hitResults.has(entry.result)).length
  const singles = plateAppearances.filter((entry) => entry.result === '1B').length
  const doubles = plateAppearances.filter((entry) => entry.result === '2B').length
  const triples = plateAppearances.filter((entry) => entry.result === '3B').length
  const hrs = plateAppearances.filter((entry) => entry.result === 'HR' || entry.result === 'IPHR').length
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
    : 0
  const iso = slg - avg
  const woba = ((0.69 * walks) + (0.72 * hbp) + (0.89 * singles) + (1.27 * doubles) + (1.62 * triples) + (2.10 * hrs)) /
    (abs + walks + sfs + hbp) || 0
  const wrcPlus = lgwOBA > 0 ? Math.round((woba / lgwOBA) * 100) : 100
  const opsPlus = (lgOBP > 0 && lgSLG > 0)
    ? Math.round((((obp / lgOBP) + (slg / lgSLG)) - 1) * 100)
    : 100
  const kPct = ks / pa
  const bbPct = walks / pa
  const bbkRatio = ks > 0 ? walks / ks : walks > 0 ? 999 : 0
  const xbhPct = xbh / abs
  const hrPerPa = hrs / pa
  const rc = (abs + walks) > 0 ? ((hits + walks) * tb) / (abs + walks) : 0
  const rc3 = outs > 0 ? (rc / outs) * 9 : 0

  return {
    babip: +babip.toFixed(3),
    iso: +iso.toFixed(3),
    woba: +woba.toFixed(3),
    wrcPlus,
    opsPlus,
    kPct: +kPct.toFixed(3),
    bbPct: +bbPct.toFixed(3),
    bbkRatio: +bbkRatio.toFixed(2),
    xbhPct: +xbhPct.toFixed(3),
    hrPerPa: +hrPerPa.toFixed(3),
    xbh,
    rc: +rc.toFixed(2),
    rc3: +rc3.toFixed(2),
  }
}

export function summarizeAdvancedPitching(stints = [], leagueConstants = {}) {
  const { lgERA = 0, lgFIP = 0, FIP_constant = 3.2 } = leagueConstants

  const totalOuts = stints.reduce((sum, stint) => sum + outsFromInningsPitched(stint.innings_pitched), 0)
  const ip = totalOuts / 3 || 1
  const er = stints.reduce((sum, stint) => sum + (stint.earned_runs || 0), 0)
  const h = stints.reduce((sum, stint) => sum + (stint.hits_allowed || 0), 0)
  const bb = stints.reduce((sum, stint) => sum + (stint.walks || 0), 0)
  const k = stints.reduce((sum, stint) => sum + (stint.strikeouts || 0), 0)
  const hr = stints.reduce((sum, stint) => sum + (stint.hr_allowed || 0), 0)
  const hbpAllowed = 0

  const paEst = h + bb + k + hr || 1
  const era3 = (er * 3) / ip
  const fip = (((13 * hr) + (3 * (bb + hbpAllowed)) - (2 * k)) / ip) + FIP_constant
  const whip = (h + bb) / ip
  const k3 = (k * 3) / ip
  const bb3 = (bb * 3) / ip
  const hr3 = (hr * 3) / ip
  const h3 = (h * 3) / ip
  const kPct = paEst > 0 ? k / paEst : 0
  const bbPct = paEst > 0 ? bb / paEst : 0
  const kBB = bb > 0 ? k / bb : k > 0 ? 999 : 0
  const eraMinus = lgERA > 0 ? Math.round((era3 / lgERA) * 100) : 100
  const fipMinus = lgFIP > 0 ? Math.round((fip / lgFIP) * 100) : 100
  const babipAllowed = (paEst - k - hr) > 0 ? (h - hr) / (paEst - k - hr) : 0

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
    kBB: +kBB.toFixed(2),
    eraMinus,
    fipMinus,
    babipAllowed: +babipAllowed.toFixed(3),
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

export function calculateParkFactors(stadiumPas = [], allPas = []) {
  const stadiumGames = new Set(stadiumPas.map((pa) => pa.game_id)).size || 1
  const allGames = new Set(allPas.map((pa) => pa.game_id)).size || 1

  const factor = (stadiumCount, allCount) => {
    const stadiumRate = stadiumCount / stadiumGames
    const allRate = allCount / allGames
    return allRate > 0 ? stadiumRate / allRate : 1
  }

  const countResult = (pas, result) => pas.filter((pa) => pa.result === result).length
  const countHr = (pas) => pas.filter((pa) => pa.result === 'HR' || pa.result === 'IPHR').length

  return {
    hr: factor(countHr(stadiumPas), countHr(allPas)),
    r: factor(
      stadiumPas.filter((pa) => pa.run_scored).length,
      allPas.filter((pa) => pa.run_scored).length,
    ),
    h: factor(
      stadiumPas.filter((pa) => hitResults.has(pa.result)).length,
      allPas.filter((pa) => hitResults.has(pa.result)).length,
    ),
    single: factor(countResult(stadiumPas, '1B'), countResult(allPas, '1B')),
    double: factor(countResult(stadiumPas, '2B'), countResult(allPas, '2B')),
    triple: factor(countResult(stadiumPas, '3B'), countResult(allPas, '3B')),
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
