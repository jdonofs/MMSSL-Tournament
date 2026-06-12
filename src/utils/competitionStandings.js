function compareStandings(a, b) {
  if (b.wins !== a.wins) return b.wins - a.wins
  if (b.headToHead !== a.headToHead) return b.headToHead - a.headToHead
  if (b.run_differential !== a.run_differential) return b.run_differential - a.run_differential
  return String(a.team_name || '').localeCompare(String(b.team_name || ''))
}

function compareHeadToHeadRecord(a, b) {
  const aGames = Number(a?.games || 0)
  const bGames = Number(b?.games || 0)
  if (!aGames && !bGames) return 0

  const aWins = Number(a?.wins || 0)
  const bWins = Number(b?.wins || 0)
  const percentageDelta = (bWins * aGames) - (aWins * bGames)
  if (percentageDelta !== 0) return percentageDelta
  if (bWins !== aWins) return bWins - aWins
  return 0
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

function buildSeasonBettingLookup(entries = []) {
  return entries.reduce((lookup, entry) => {
    const playerId = String(entry.player_id || '')
    if (!playerId) return lookup
    lookup[playerId] = (lookup[playerId] || 0) + Number(entry.dollars_change || 0)
    return lookup
  }, {})
}

function buildSeasonRows(seasonTeams = [], regularSeasonGames = []) {
  const rowsByTeamId = seasonTeams.reduce((accumulator, team) => {
    accumulator[team.id] = {
      ...team,
      wins: 0,
      losses: 0,
      runs_scored: 0,
      runs_allowed: 0,
      run_differential: 0,
      home_wins: 0,
      home_losses: 0,
      away_wins: 0,
      away_losses: 0,
    }
    return accumulator
  }, {})

  regularSeasonGames
    .filter((game) => game.status === 'completed')
    .forEach((game) => {
      const homeTeam = rowsByTeamId[game.home_team_id]
      const awayTeam = rowsByTeamId[game.away_team_id]
      if (!homeTeam || !awayTeam) return

      homeTeam.runs_scored += Number(game.home_score || 0)
      homeTeam.runs_allowed += Number(game.away_score || 0)
      awayTeam.runs_scored += Number(game.away_score || 0)
      awayTeam.runs_allowed += Number(game.home_score || 0)

      if (String(game.winner_team_id || '') === String(homeTeam.id)) {
        homeTeam.wins += 1
        homeTeam.home_wins += 1
        awayTeam.losses += 1
        awayTeam.away_losses += 1
      } else if (String(game.winner_team_id || '') === String(awayTeam.id)) {
        awayTeam.wins += 1
        awayTeam.away_wins += 1
        homeTeam.losses += 1
        homeTeam.home_losses += 1
      }
    })

  return Object.values(rowsByTeamId).map((team) => ({
    ...team,
    run_differential: team.runs_scored - team.runs_allowed,
  }))
}

function buildTiedGroupHeadToHead(group = [], regularSeasonGames = []) {
  const tiedTeamIds = new Set(group.map((team) => String(team.id)))
  const statsByTeamId = group.reduce((lookup, team) => {
    lookup[String(team.id)] = { wins: 0, losses: 0, games: 0 }
    return lookup
  }, {})

  regularSeasonGames
    .filter((game) => (
      game.status === 'completed'
      && tiedTeamIds.has(String(game.home_team_id))
      && tiedTeamIds.has(String(game.away_team_id))
    ))
    .forEach((game) => {
      const homeKey = String(game.home_team_id)
      const awayKey = String(game.away_team_id)
      statsByTeamId[homeKey].games += 1
      statsByTeamId[awayKey].games += 1

      if (String(game.winner_team_id || '') === homeKey) {
        statsByTeamId[homeKey].wins += 1
        statsByTeamId[awayKey].losses += 1
      } else if (String(game.winner_team_id || '') === awayKey) {
        statsByTeamId[awayKey].wins += 1
        statsByTeamId[homeKey].losses += 1
      }
    })

  return statsByTeamId
}

function sortSeasonTieGroup(group = [], regularSeasonGames = [], bettingLookup = {}) {
  const headToHeadByTeamId = buildTiedGroupHeadToHead(group, regularSeasonGames)

  return [...group].sort((a, b) => {
    // Official season seeding tiebreaker order:
    // 1. Head-to-head record among the tied teams.
    // 2. Total season betting winnings from season_betting_ledger.
    // Remaining ties fall back to run differential and team name only so the UI stays deterministic.
    const headToHeadDelta = compareHeadToHeadRecord(
      headToHeadByTeamId[String(a.id)],
      headToHeadByTeamId[String(b.id)],
    )
    if (headToHeadDelta !== 0) return headToHeadDelta

    const bettingDelta =
      Number(bettingLookup[String(b.player_id)] || 0)
      - Number(bettingLookup[String(a.player_id)] || 0)
    if (bettingDelta !== 0) return bettingDelta

    if (b.run_differential !== a.run_differential) return b.run_differential - a.run_differential
    return String(a.team_name || '').localeCompare(String(b.team_name || ''))
  })
}

export function buildSeasonStandings(seasonTeams = [], schedule = [], bettingLedger = []) {
  const regularSeasonGames = schedule.filter((game) => !game.stage)
  const rows = buildSeasonRows(seasonTeams, regularSeasonGames)
  const bettingLookup = buildSeasonBettingLookup(bettingLedger)

  const sorted = []
  let index = 0
  const firstPass = [...rows].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins
    if (b.losses !== a.losses) return a.losses - b.losses
    return String(a.team_name || '').localeCompare(String(b.team_name || ''))
  })

  while (index < firstPass.length) {
    const currentWins = firstPass[index].wins
    const tiedGroup = firstPass.filter((team) => team.wins === currentWins)
    if (tiedGroup.length === 1) {
      sorted.push(tiedGroup[0])
      index += 1
      continue
    }

    sorted.push(...sortSeasonTieGroup(tiedGroup, regularSeasonGames, bettingLookup))
    index += tiedGroup.length
  }

  return sorted.map((team, rowIndex, orderedRows) => ({
    ...team,
    betting_winnings: Number(bettingLookup[String(team.player_id)] || 0),
    rank: rowIndex + 1,
    gamesBack: rowIndex === 0 ? 0 : ((orderedRows[0].wins - team.wins) + (team.losses - orderedRows[0].losses)) / 2,
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
