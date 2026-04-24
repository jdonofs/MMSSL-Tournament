function parseSeedRef(ref = '') {
  const match = String(ref).match(/^Seed(\d+)$/)
  return match ? Number(match[1]) : null
}

export function normalizeStage(stage = '') {
  if (stage.includes('CG-2')) return 'Championship Reset'
  if (stage.includes('CG-1')) return 'Championship'
  return stage
}

export function getLoserId(game) {
  if (!game?.winner_player_id) return null
  if (game.winner_player_id === game.team_a_player_id) return game.team_b_player_id
  if (game.winner_player_id === game.team_b_player_id) return game.team_a_player_id
  return null
}

export function getRoundRobinSchedule(playerIds) {
  const slots = [...playerIds]
  if (slots.length < 2) return []
  if (slots.length % 2 === 1) slots.push(null)

  const rounds = []
  const totalRounds = slots.length - 1

  for (let roundIndex = 0; roundIndex < totalRounds; roundIndex += 1) {
    const games = []
    for (let pairIndex = 0; pairIndex < slots.length / 2; pairIndex += 1) {
      const teamA = slots[pairIndex]
      const teamB = slots[slots.length - 1 - pairIndex]
      if (!teamA || !teamB) continue
      games.push({
        stage: `Round ${roundIndex + 1}-${games.length + 1}`,
        teamA,
        teamB,
      })
    }
    rounds.push(...games)

    const fixed = slots[0]
    const rotating = slots.slice(1)
    rotating.unshift(rotating.pop())
    slots.splice(0, slots.length, fixed, ...rotating)
  }

  return rounds
}

export const DOUBLE_ELIM_TEMPLATES = {
  4: [
    { stage: 'Winners R1-1', teamARef: 'Seed1', teamBRef: 'Seed4' },
    { stage: 'Winners R1-2', teamARef: 'Seed2', teamBRef: 'Seed3' },
    { stage: 'Losers R1-1', teamARef: 'L:Winners R1-1', teamBRef: 'L:Winners R1-2' },
    { stage: 'Winners Final', teamARef: 'W:Winners R1-1', teamBRef: 'W:Winners R1-2' },
    { stage: 'Losers Final', teamARef: 'L:Winners Final', teamBRef: 'W:Losers R1-1' },
    { stage: 'Championship', teamARef: 'W:Winners Final', teamBRef: 'W:Losers Final' },
  ],
  5: [
    { stage: 'Winners R1-1', teamARef: 'Seed4', teamBRef: 'Seed5' },
    { stage: 'Winners R2-1', teamARef: 'Seed2', teamBRef: 'Seed3' },
    { stage: 'Winners R2-2', teamARef: 'Seed1', teamBRef: 'W:Winners R1-1' },
    { stage: 'Losers R1-1', teamARef: 'L:Winners R2-1', teamBRef: 'L:Winners R1-1' },
    { stage: 'Winners Final', teamARef: 'W:Winners R2-2', teamBRef: 'W:Winners R2-1' },
    { stage: 'Losers R2-1', teamARef: 'L:Winners R2-2', teamBRef: 'W:Losers R1-1' },
    { stage: 'Losers Final', teamARef: 'L:Winners Final', teamBRef: 'W:Losers R2-1' },
    { stage: 'Championship', teamARef: 'W:Winners Final', teamBRef: 'W:Losers Final' },
  ],
  6: [
    { stage: 'Winners R1-1', teamARef: 'Seed4', teamBRef: 'Seed5' },
    { stage: 'Winners R1-2', teamARef: 'Seed3', teamBRef: 'Seed6' },
    { stage: 'Winners R2-1', teamARef: 'Seed1', teamBRef: 'W:Winners R1-1' },
    { stage: 'Winners R2-2', teamARef: 'Seed2', teamBRef: 'W:Winners R1-2' },
    { stage: 'Losers R1-1', teamARef: 'L:Winners R2-1', teamBRef: 'L:Winners R1-2' },
    { stage: 'Losers R1-2', teamARef: 'L:Winners R2-2', teamBRef: 'L:Winners R1-1' },
    { stage: 'Losers R2-1', teamARef: 'W:Losers R1-1', teamBRef: 'W:Losers R1-2' },
    { stage: 'Winners Final', teamARef: 'W:Winners R2-1', teamBRef: 'W:Winners R2-2' },
    { stage: 'Losers Final', teamARef: 'L:Winners Final', teamBRef: 'W:Losers R2-1' },
    { stage: 'Championship', teamARef: 'W:Winners Final', teamBRef: 'W:Losers Final' },
  ],
  7: [
    { stage: 'Winners R1-1', teamARef: 'Seed4', teamBRef: 'Seed5' },
    { stage: 'Winners R1-2', teamARef: 'Seed2', teamBRef: 'Seed7' },
    { stage: 'Winners R1-3', teamARef: 'Seed3', teamBRef: 'Seed6' },
    { stage: 'Losers R1-1', teamARef: 'L:Winners R1-2', teamBRef: 'L:Winners R1-3' },
    { stage: 'Winners R2-1', teamARef: 'Seed1', teamBRef: 'W:Winners R1-1' },
    { stage: 'Winners R2-2', teamARef: 'W:Winners R1-2', teamBRef: 'W:Winners R1-3' },
    { stage: 'Losers R2-1', teamARef: 'L:Winners R2-1', teamBRef: 'W:Losers R1-1' },
    { stage: 'Losers R2-2', teamARef: 'L:Winners R2-2', teamBRef: 'L:Winners R1-1' },
    { stage: 'Losers R3-1', teamARef: 'W:Losers R2-1', teamBRef: 'W:Losers R2-2' },
    { stage: 'Winners Final', teamARef: 'W:Winners R2-1', teamBRef: 'W:Winners R2-2' },
    { stage: 'Losers Final', teamARef: 'L:Winners Final', teamBRef: 'W:Losers R3-1' },
    { stage: 'Championship', teamARef: 'W:Winners Final', teamBRef: 'W:Losers Final' },
  ],
  8: [
    { stage: 'Winners R1-1', teamARef: 'Seed1', teamBRef: 'Seed8' },
    { stage: 'Winners R1-2', teamARef: 'Seed4', teamBRef: 'Seed5' },
    { stage: 'Winners R1-3', teamARef: 'Seed2', teamBRef: 'Seed7' },
    { stage: 'Winners R1-4', teamARef: 'Seed3', teamBRef: 'Seed6' },
    { stage: 'Losers R1-1', teamARef: 'L:Winners R1-1', teamBRef: 'L:Winners R1-2' },
    { stage: 'Losers R1-2', teamARef: 'L:Winners R1-3', teamBRef: 'L:Winners R1-4' },
    { stage: 'Winners R2-1', teamARef: 'W:Winners R1-1', teamBRef: 'W:Winners R1-2' },
    { stage: 'Winners R2-2', teamARef: 'W:Winners R1-3', teamBRef: 'W:Winners R1-4' },
    { stage: 'Losers R2-1', teamARef: 'L:Winners R2-1', teamBRef: 'W:Losers R1-2' },
    { stage: 'Losers R2-2', teamARef: 'L:Winners R2-2', teamBRef: 'W:Losers R1-1' },
    { stage: 'Losers R3-1', teamARef: 'W:Losers R2-1', teamBRef: 'W:Losers R2-2' },
    { stage: 'Winners Final', teamARef: 'W:Winners R2-1', teamBRef: 'W:Winners R2-2' },
    { stage: 'Losers Final', teamARef: 'L:Winners Final', teamBRef: 'W:Losers R3-1' },
    { stage: 'Championship', teamARef: 'W:Winners Final', teamBRef: 'W:Losers Final' },
  ],
}

export function getDoubleElimTemplate(playerCount) {
  return DOUBLE_ELIM_TEMPLATES[playerCount] || null
}

export function resolveBracketRef(ref, seeding, gamesByStage) {
  const seedNumber = parseSeedRef(ref)
  if (seedNumber) return seeding[seedNumber - 1] || null
  if (typeof ref !== 'string' || ref.length < 3) return null

  const type = ref[0]
  const stage = normalizeStage(ref.slice(2))
  const game = gamesByStage.get(stage)
  if (!game) return null
  if (type === 'W') return game.winner_player_id || null
  if (type === 'L') return getLoserId(game)
  return null
}

export function resolveTemplateStages(template, seeding, games) {
  const gamesByStage = new Map(
    games.map((game) => [normalizeStage(game.stage), game]),
  )

  return template.map((spec) => ({
    stage: spec.stage,
    teamA: resolveBracketRef(spec.teamARef, seeding, gamesByStage),
    teamB: resolveBracketRef(spec.teamBRef, seeding, gamesByStage),
  }))
}

export function buildDoubleElimBracket(seeding) {
  const template = getDoubleElimTemplate(seeding.length)
  if (!template) return []
  return resolveTemplateStages(template, seeding, [])
}

function getSeededMatchups(seeding) {
  const n = seeding.length
  let bracketSize = 1
  while (bracketSize < n) bracketSize *= 2
  const byes = bracketSize - n
  const playing = seeding.slice(byes)
  const half = playing.length / 2
  const pairs = []
  for (let i = 0; i < half; i++) {
    pairs.push({ teamA: playing[i], teamB: playing[playing.length - 1 - i] })
  }
  return pairs
}

export function generateSingleElimBracket(seeding) {
  const games = []
  const n = seeding.length
  if (n < 2) return games
  const pairs = getSeededMatchups(seeding)
  pairs.forEach((pair, i) => {
    games.push({ stage: `Round 1-${i + 1}`, teamA: pair.teamA, teamB: pair.teamB })
  })
  return games
}
