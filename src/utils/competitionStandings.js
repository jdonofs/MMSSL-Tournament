function compareStandings(a, b) {
  if (b.wins !== a.wins) return b.wins - a.wins
  if (b.headToHead !== a.headToHead) return b.headToHead - a.headToHead
  if (b.run_differential !== a.run_differential) return b.run_differential - a.run_differential
  return String(a.team_name || '').localeCompare(String(b.team_name || ''))
}

function buildHeadToHeadLookup(rows = [], getPair, getWinner, isComplete) {
  const lookup = {}

  rows
    .filter((row) => isComplete(row) && getWinner(row))
    .forEach((row) => {
      const pair = getPair(row)
      if (!pair) return
      const [teamA, teamB] = pair
      const pairKey = [teamA, teamB].sort((a, b) => Number(a) - Number(b)).join(':')
      const winner = getWinner(row)
      if (!lookup[pairKey]) {
        lookup[pairKey] = {}
      }
      lookup[pairKey][winner] = (lookup[pairKey][winner] || 0) + 1
    })

  return lookup
}

export function buildSeasonStandings(seasonTeams = [], schedule = []) {
  const headToHeadLookup = buildHeadToHeadLookup(
    schedule,
    (game) => [game.home_team_id, game.away_team_id],
    (game) => game.winner_team_id,
    (game) => game.status === 'completed',
  )

  const firstPass = [...seasonTeams].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins
    if (b.run_differential !== a.run_differential) return b.run_differential - a.run_differential
    return String(a.team_name || '').localeCompare(String(b.team_name || ''))
  })

  return firstPass
    .map((team) => {
      const tiedTeams = seasonTeams.filter((entry) => entry.id !== team.id && entry.wins === team.wins)
      const headToHead = tiedTeams.reduce((sum, opponent) => {
        const pairKey = [team.id, opponent.id].sort((a, b) => Number(a) - Number(b)).join(':')
        return sum + Number(headToHeadLookup[pairKey]?.[team.id] || 0)
      }, 0)
      return {
        ...team,
        headToHead,
      }
    })
    .sort(compareStandings)
    .map((team, index, rows) => ({
      ...team,
      rank: index + 1,
      gamesBack: index === 0 ? 0 : ((rows[0].wins - team.wins) + (team.losses - rows[0].losses)) / 2,
    }))
}

export function buildTournamentStandings(games = [], players = [], identitiesByPlayerId = {}) {
  const rowsByPlayerId = players.reduce((accumulator, player) => {
    const identity = identitiesByPlayerId[player.id] || {}
    accumulator[player.id] = {
      id: player.id,
      player_id: player.id,
      team_name: identity.teamName || player.name,
      team_logo_key: identity.teamLogoKey || null,
      wins: 0,
      losses: 0,
      runs_scored: 0,
      runs_allowed: 0,
      run_differential: 0,
      home_wins: 0,
      home_losses: 0,
      away_wins: 0,
      away_losses: 0,
      headToHead: 0,
    }
    return accumulator
  }, {})

  games
    .filter((game) => game.status === 'complete')
    .forEach((game) => {
      const awayTeam = rowsByPlayerId[game.team_a_player_id]
      const homeTeam = rowsByPlayerId[game.team_b_player_id]
      if (!awayTeam || !homeTeam) return

      awayTeam.runs_scored += Number(game.team_a_runs || 0)
      awayTeam.runs_allowed += Number(game.team_b_runs || 0)
      homeTeam.runs_scored += Number(game.team_b_runs || 0)
      homeTeam.runs_allowed += Number(game.team_a_runs || 0)

      if (game.winner_player_id === game.team_a_player_id) {
        awayTeam.wins += 1
        awayTeam.away_wins += 1
        homeTeam.losses += 1
        homeTeam.home_losses += 1
      } else if (game.winner_player_id === game.team_b_player_id) {
        homeTeam.wins += 1
        homeTeam.home_wins += 1
        awayTeam.losses += 1
        awayTeam.away_losses += 1
      }
    })

  const rows = Object.values(rowsByPlayerId).map((row) => ({
    ...row,
    run_differential: row.runs_scored - row.runs_allowed,
  }))

  const headToHeadLookup = buildHeadToHeadLookup(
    games,
    (game) => [game.team_a_player_id, game.team_b_player_id],
    (game) => game.winner_player_id,
    (game) => game.status === 'complete',
  )

  return rows
    .map((team) => {
      const tiedTeams = rows.filter((entry) => entry.id !== team.id && entry.wins === team.wins)
      const headToHead = tiedTeams.reduce((sum, opponent) => {
        const pairKey = [team.id, opponent.id].sort((a, b) => Number(a) - Number(b)).join(':')
        return sum + Number(headToHeadLookup[pairKey]?.[team.id] || 0)
      }, 0)
      return {
        ...team,
        headToHead,
      }
    })
    .sort(compareStandings)
    .map((team, index, sortedRows) => ({
      ...team,
      rank: index + 1,
      gamesBack: index === 0 ? 0 : ((sortedRows[0].wins - team.wins) + (team.losses - sortedRows[0].losses)) / 2,
    }))
}
