const hitResults = new Set(['1B', '2B', '3B', 'HR'])
const obpResults = new Set(['1B', '2B', '3B', 'HR', 'BB', 'HBP'])
const sacrificeResults = new Set(['SF', 'SH'])
const outResults = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'SF', 'SH'])

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
  const baseRbi = Number(pa.rbi || 0)
  const batterDrivenIn = Boolean(pa.run_scored) && hitResults.has(pa.result)
  return baseRbi + (batterDrivenIn ? 1 : 0)
}

export function summarizeBatting(plateAppearances = []) {
  const atBats = plateAppearances.filter((pa) => !['BB', 'HBP', 'SF', 'SH'].includes(pa.result)).length
  const hits = plateAppearances.filter((pa) => hitResults.has(pa.result)).length
  const walks = plateAppearances.filter((pa) => pa.result === 'BB').length
  const hbp = plateAppearances.filter((pa) => pa.result === 'HBP').length
  const singles = plateAppearances.filter((pa) => pa.result === '1B').length
  const doubles = plateAppearances.filter((pa) => pa.result === '2B').length
  const triples = plateAppearances.filter((pa) => pa.result === '3B').length
  const homeRuns = plateAppearances.filter((pa) => pa.result === 'HR').length
  const totalBases = plateAppearances.reduce((total, pa) => {
    if (pa.result === '1B') return total + 1
    if (pa.result === '2B') return total + 2
    if (pa.result === '3B') return total + 3
    if (pa.result === 'HR') return total + 4
    return total
  }, 0)
  const sacrificeFlies = plateAppearances.filter((pa) => pa.result === 'SF').length
  const sacrificeHits = plateAppearances.filter((pa) => pa.result === 'SH').length
  const sacrifice = sacrificeFlies + sacrificeHits
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
    obp: atBats + walks + hbp + sacrifice ? (hits + walks + hbp) / (atBats + walks + hbp + sacrifice) : 0,
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

  // Group PAs by characterId → tournamentId
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
  if (result === 'DP') return 2
  if (outResults.has(result)) return 1
  return 0
}
