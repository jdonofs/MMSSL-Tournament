export const SLUGGERS_PLAYER_ORDER = ['Aidan', 'Donovan', 'Jason', 'Justin', 'May', 'Nick']
export const SEASON_PLAYOFF_FORMATS = ['single_elimination', 'double_elimination']

function buildPairings(teamIds = [], gamesPerMatchup = 3) {
  const matchupCount = Math.trunc(Number(gamesPerMatchup))
  if (teamIds.length < 2 || matchupCount < 1) return []

  const teams = [...teamIds]
  if (teams.length % 2 !== 0) teams.push('__bye__')

  const roundsPerCycle = teams.length - 1
  const pairings = []
  let roundNumber = 1

  for (let cycle = 0; cycle < matchupCount; cycle += 1) {
    const rotating = teams.slice(1)

    for (let roundIndex = 0; roundIndex < roundsPerCycle; roundIndex += 1) {
      const circle = [teams[0], ...rotating]

      for (let pairIndex = 0; pairIndex < circle.length / 2; pairIndex += 1) {
        const teamA = circle[pairIndex]
        const teamB = circle[circle.length - 1 - pairIndex]
        if (teamA === '__bye__' || teamB === '__bye__') continue

        pairings.push({
          round_number: roundNumber,
          cycle,
          pairIndex,
          teamA,
          teamB,
        })
      }

      roundNumber += 1
      rotating.unshift(rotating.pop())
    }
  }

  return pairings
}

function buildInitialSchedule(pairings) {
  const pairMeetings = new Map()

  return pairings.map((pairing) => {
    const pairKey = [pairing.teamA, pairing.teamB].sort().join('::')
    const meetingIndex = pairMeetings.get(pairKey) || 0
    pairMeetings.set(pairKey, meetingIndex + 1)

    const useFirstTeamAsHome = (pairing.round_number + pairing.cycle + pairing.pairIndex + meetingIndex) % 2 === 0
    const homeTeamId = useFirstTeamAsHome ? pairing.teamA : pairing.teamB
    const awayTeamId = useFirstTeamAsHome ? pairing.teamB : pairing.teamA

    return {
      round_number: pairing.round_number,
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      stadium_picker_team_id: homeTeamId,
      status: 'scheduled',
    }
  })
}

function getHomeCounts(games) {
  const counts = new Map()

  games.forEach((game) => {
    counts.set(game.home_team_id, (counts.get(game.home_team_id) || 0) + 1)
    counts.set(game.away_team_id, counts.get(game.away_team_id) || 0)
  })

  return counts
}

function getHomeTargets(games) {
  const totalGamesByTeam = new Map()
  const homeCounts = getHomeCounts(games)
  let assignedHomes = 0

  games.forEach((game) => {
    totalGamesByTeam.set(game.home_team_id, (totalGamesByTeam.get(game.home_team_id) || 0) + 1)
    totalGamesByTeam.set(game.away_team_id, (totalGamesByTeam.get(game.away_team_id) || 0) + 1)
  })

  const targets = new Map()
  totalGamesByTeam.forEach((totalGames, teamId) => {
    const minimumHomes = Math.floor(totalGames / 2)
    targets.set(teamId, minimumHomes)
    assignedHomes += minimumHomes
  })

  const remainingHomes = games.length - assignedHomes
  const oddGameTeams = [...totalGamesByTeam.entries()]
    .filter(([, totalGames]) => totalGames % 2 === 1)
    .sort((a, b) => {
      const homeDelta = (homeCounts.get(b[0]) || 0) - (homeCounts.get(a[0]) || 0)
      if (homeDelta !== 0) return homeDelta
      return String(a[0]).localeCompare(String(b[0]))
    })

  for (let index = 0; index < remainingHomes; index += 1) {
    const [teamId] = oddGameTeams[index] || []
    if (!teamId) break
    targets.set(teamId, (targets.get(teamId) || 0) + 1)
  }

  return targets
}

function findReorientationPath(games, targets) {
  const homeCounts = getHomeCounts(games)
  const surplusTeams = [...targets.entries()]
    .filter(([teamId, target]) => (homeCounts.get(teamId) || 0) > target)
    .map(([teamId]) => teamId)
  const deficitTeams = new Set(
    [...targets.entries()]
      .filter(([teamId, target]) => (homeCounts.get(teamId) || 0) < target)
      .map(([teamId]) => teamId),
  )

  if (!surplusTeams.length || !deficitTeams.size) return null

  for (const startTeamId of surplusTeams) {
    const queue = [startTeamId]
    const visited = new Set([startTeamId])
    const previous = new Map()

    while (queue.length) {
      const currentTeamId = queue.shift()
      if (currentTeamId !== startTeamId && deficitTeams.has(currentTeamId)) {
        const path = []
        let walkTeamId = currentTeamId

        while (walkTeamId !== startTeamId) {
          const step = previous.get(walkTeamId)
          if (!step) break
          path.unshift(step.gameIndex)
          walkTeamId = step.fromTeamId
        }

        if (path.length) return path
      }

      games.forEach((game, gameIndex) => {
        if (game.home_team_id !== currentTeamId) return
        const nextTeamId = game.away_team_id
        if (visited.has(nextTeamId)) return
        visited.add(nextTeamId)
        previous.set(nextTeamId, { fromTeamId: currentTeamId, gameIndex })
        queue.push(nextTeamId)
      })
    }
  }

  return null
}

function rebalanceSchedule(games) {
  const balancedGames = games.map((game) => ({ ...game }))
  const targets = getHomeTargets(balancedGames)

  for (let attempts = 0; attempts < balancedGames.length * 4; attempts += 1) {
    const path = findReorientationPath(balancedGames, targets)
    if (!path) break

    path.forEach((gameIndex) => {
      const game = balancedGames[gameIndex]
      balancedGames[gameIndex] = {
        ...game,
        home_team_id: game.away_team_id,
        away_team_id: game.home_team_id,
        stadium_picker_team_id: game.away_team_id,
      }
    })
  }

  return balancedGames
}

export function buildRoundRobinSchedule(teamIds = [], gamesPerMatchup = 3) {
  const pairings = buildPairings(teamIds, gamesPerMatchup)
  if (!pairings.length) return []
  return rebalanceSchedule(buildInitialSchedule(pairings))
}

export function formatSeasonLabel(value = '') {
  return String(value)
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function getModeStorageValue() {
  try {
    return localStorage.getItem('sluggers_mode') || 'tournament'
  } catch {
    return 'tournament'
  }
}

export function setModeStorageValue(mode) {
  try {
    localStorage.setItem('sluggers_mode', mode)
  } catch {
    // ignore storage failures
  }
}

export function normalizeSeasonName(value = '') {
  return String(value).trim().replace(/\s+/g, ' ')
}

export function validateSeasonSettings(form, existingSeasons = [], seasonIdToIgnore = null) {
  const normalizedName = normalizeSeasonName(form?.name)
  if (!normalizedName) return 'Season name is required.'

  const duplicate = existingSeasons.some((season) => (
    String(season.id) !== String(seasonIdToIgnore || '')
    && normalizeSeasonName(season.name).toLowerCase() === normalizedName.toLowerCase()
  ))
  if (duplicate) return 'A season with that name already exists.'

  const gamesPerMatchup = Math.trunc(Number(form?.games_per_matchup))
  if (!Number.isFinite(gamesPerMatchup) || gamesPerMatchup < 1) {
    return 'Games per matchup must be at least 1.'
  }

  const innings = Math.trunc(Number(form?.innings))
  if (!Number.isFinite(innings) || innings < 1) {
    return 'Regulation innings must be at least 1.'
  }

  if (form?.mercy_rule) {
    const mercyRuleDifferential = Math.trunc(Number(form?.mercy_rule_differential))
    if (!Number.isFinite(mercyRuleDifferential) || mercyRuleDifferential < 1) {
      return 'Mercy rule differential must be at least 1.'
    }
  }

  return null
}
