import { buildRoundRobinSchedule } from '../src/utils/season.js'

function assertHomeBalance(teamIds, gamesPerMatchup) {
  const games = buildRoundRobinSchedule(teamIds, gamesPerMatchup)
  const totals = Object.fromEntries(teamIds.map((teamId) => [teamId, { total: 0, home: 0 }]))

  for (const game of games) {
    totals[game.home_team_id].total += 1
    totals[game.home_team_id].home += 1
    totals[game.away_team_id].total += 1
  }

  for (const [teamId, counts] of Object.entries(totals)) {
    const minHomes = Math.floor(counts.total / 2)
    const maxHomes = Math.ceil(counts.total / 2)
    if (counts.home < minHomes || counts.home > maxHomes) {
      throw new Error(
        `Team ${teamId} is out of balance for ${teamIds.length} teams at ${gamesPerMatchup} games per matchup: ` +
        `${counts.home} home games across ${counts.total} total games (expected ${minHomes}-${maxHomes}).`,
      )
    }
  }

  return {
    teamCount: teamIds.length,
    gamesPerMatchup,
    totalGames: games.length,
  }
}

const scenarios = []

for (const teamCount of [4, 6, 8]) {
  const teamIds = Array.from({ length: teamCount }, (_, index) => `team-${index + 1}`)
  for (const gamesPerMatchup of [1, 2, 3]) {
    scenarios.push(assertHomeBalance(teamIds, gamesPerMatchup))
  }
}

for (const scenario of scenarios) {
  console.log(
    `OK ${scenario.teamCount} teams / ${scenario.gamesPerMatchup} games per matchup -> ${scenario.totalGames} scheduled games`,
  )
}
