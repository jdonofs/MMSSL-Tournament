const hitResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const plateAppearanceResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'BB', 'HBP', 'K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE'])
const outResults = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])
const battedBallResults = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE'])
const swingPitchResults = new Set(['swinging_miss', 'foul', 'in_play'])

function isOfficialAtBat(pa = {}) {
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

export function getCreditedRbiForPa(pa = {}) {
  if (pa.is_error || pa.result === 'ROE') return 0
  const base = Number(pa.rbi || 0)
  // Batter always drives themselves in on a home run
  return (pa.result === 'HR' || pa.result === 'IPHR') ? base + 1 : base
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
  return {
    total,
    pull: count('Pull'),
    center: count('Center'),
    oppo: count('Oppo'),
    pullRate: total ? count('Pull') / total : 0,
    centerRate: total ? count('Center') / total : 0,
    oppoRate: total ? count('Oppo') / total : 0,
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
