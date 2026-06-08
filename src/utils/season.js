export const SLUGGERS_PLAYER_ORDER = ['Aidan', 'Donovan', 'Jason', 'Justin', 'May', 'Nick']

export function buildRoundRobinSchedule(teamIds = [], gamesPerMatchup = 3) {
  if (teamIds.length < 2) return []

  // Circle (Berger) method: fix one team, rotate the rest each round.
  // Every team plays exactly once per round — nobody sits out more than one round.
  const teams = [...teamIds]
  const hasBye = teams.length % 2 !== 0
  if (hasBye) teams.push('__bye__') // phantom team for odd counts

  const n = teams.length
  const roundsPerCycle = n - 1

  const games = []
  let roundNumber = 1

  for (let cycle = 0; cycle < gamesPerMatchup; cycle += 1) {
    // Alternate rotation direction each cycle for home/away variety
    const rotating = cycle % 2 === 0 ? teams.slice(1) : teams.slice(1).reverse()

    for (let r = 0; r < roundsPerCycle; r += 1) {
      // Build the circle layout for this round: fixed seat 0 + current rotating order
      const circle = [teams[0], ...rotating]

      for (let i = 0; i < n / 2; i += 1) {
        const a = circle[i]
        const b = circle[n - 1 - i]
        if (a === '__bye__' || b === '__bye__') continue

        const flipHome = Math.random() > 0.5
        const homeTeamId = flipHome ? b : a
        const awayTeamId = flipHome ? a : b
        games.push({
          round_number: roundNumber,
          home_team_id: homeTeamId,
          away_team_id: awayTeamId,
          stadium_picker_team_id: homeTeamId,
          status: 'scheduled',
        })
      }

      roundNumber += 1
      // Rotate: move the last element in rotating to the front
      rotating.unshift(rotating.pop())
    }
  }

  return games
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
