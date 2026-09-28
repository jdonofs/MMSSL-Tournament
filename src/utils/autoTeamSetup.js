import { CHARACTER_VARIANTS, chemistryNamesMatch, getChemistry } from '../data/chemistry.js'

const LINEUP_SLOT_WEIGHTS = [1.12, 1.06, 1.0, 0.98, 0.94, 0.9, 0.86, 0.83, 0.8]
const CLEANUP_SLOT_INDEXES = new Set([2, 3])
const INFIELD_FIELD_IDS = ['catcher', 'firstBase', 'secondBase', 'thirdBase']
const FIELDING_ASSIGNMENT_ORDER = [
  'pitcher',
  'catcher',
  'firstBase',
  'secondBase',
  'thirdBase',
  'shortStop',
  'leftField',
  'centerField',
  'rightField',
]
const EPSILON = 1e-9

function toNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function getPlayerId(player) {
  return player?.id ?? null
}

function getStableKey(id) {
  return String(id ?? '')
}

function getStableRankById(players = []) {
  return Object.fromEntries(players.map((player, index) => [getStableKey(getPlayerId(player)), index]))
}

function getChemistryName(player) {
  return player?.chemistryName || player?.name || ''
}

function hasGoodChemistry(leftPlayer, rightPlayer) {
  const leftName = getChemistryName(leftPlayer)
  const rightName = getChemistryName(rightPlayer)
  if (!leftName || !rightName || leftName === rightName) return false

  const leftChem = getChemistry(leftName)
  const rightChem = getChemistry(rightName)
  return (
    leftChem.good.some((candidate) => chemistryNamesMatch(candidate, rightName))
    || rightChem.good.some((candidate) => chemistryNamesMatch(candidate, leftName))
  )
}

function isKritterVariant(player) {
  const chemistryName = getChemistryName(player)
  const baseName = CHARACTER_VARIANTS[chemistryName] || chemistryName
  return baseName === 'Kritter'
}

// Auto setup explores many arrangements of the same nine players. Pull every
// value out of the much larger analysis objects once instead of repeating the
// optional-property walk for every candidate.
function buildPlayerProfiles(players, analysisById) {
  return players.map((player, stableRank) => {
    const analysis = analysisById[getPlayerId(player)] || null
    return {
      player,
      id: getPlayerId(player),
      stableRank,
      batting: toNumber(analysis?.displayRatings?.batting),
      pitching: toNumber(analysis?.displayRatings?.pitching),
      fielding: toNumber(analysis?.displayRatings?.fielding),
      speed: toNumber(analysis?.displayRatings?.speed),
      power: toNumber(analysis?.rawMetrics?.batting?.power),
      armStrength: toNumber(analysis?.rawMetrics?.fielding?.armStrength),
      physicality: toNumber(analysis?.rawMetrics?.fielding?.physicality),
      isKritter: isKritterVariant(player),
    }
  })
}

function buildChemistryMatrix(profiles) {
  const matrix = profiles.map(() => Array(profiles.length).fill(false))
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const linked = hasGoodChemistry(profiles[leftIndex].player, profiles[rightIndex].player)
      matrix[leftIndex][rightIndex] = linked
      matrix[rightIndex][leftIndex] = linked
    }
  }
  return matrix
}

function compareLexicographicByStableOrder(candidateIds = [], bestIds = [], stableRankById = {}) {
  for (let index = 0; index < candidateIds.length; index += 1) {
    const candidateRank = toNumber(stableRankById[getStableKey(candidateIds[index])])
    const bestRank = toNumber(stableRankById[getStableKey(bestIds[index])])
    if (candidateRank !== bestRank) return candidateRank < bestRank ? 1 : -1
  }
  return 0
}

function buildFieldAssignmentIds(fieldingPositions = {}, fieldIds = FIELDING_ASSIGNMENT_ORDER) {
  return fieldIds.map((fieldId) => fieldingPositions[fieldId] ?? null)
}

function compareNumericDesc(candidateValue, bestValue) {
  if (candidateValue > bestValue + EPSILON) return 1
  if (candidateValue < bestValue - EPSILON) return -1
  return 0
}

function compareOutfieldCandidate(candidate, best, stableRankById) {
  let result = compareNumericDesc(candidate.centerLinks, best.centerLinks)
  if (result) return result

  result = compareNumericDesc(candidate.totalSpeed, best.totalSpeed)
  if (result) return result

  result = compareNumericDesc(candidate.centerSpeed, best.centerSpeed)
  if (result) return result

  result = compareNumericDesc(candidate.totalFielding, best.totalFielding)
  if (result) return result

  return compareLexicographicByStableOrder(candidate.ids, best.ids, stableRankById)
}

function compareInfieldCandidate(candidate, best, stableRankById) {
  let result = compareNumericDesc(candidate.totalScore, best.totalScore)
  if (result) return result

  result = compareNumericDesc(candidate.secondBaseSpeed, best.secondBaseSpeed)
  if (result) return result

  return compareLexicographicByStableOrder(candidate.ids, best.ids, stableRankById)
}

function pickShortstop(profiles) {
  return [...profiles].sort((left, right) => {
    const fieldingDiff = right.fielding - left.fielding
    if (fieldingDiff !== 0) return fieldingDiff

    const speedDiff = right.speed - left.speed
    if (speedDiff !== 0) return speedDiff

    const kritterDiff = Number(right.isKritter) - Number(left.isKritter)
    if (kritterDiff !== 0) return kritterDiff

    return left.stableRank - right.stableRank
  })[0] || null
}

function scoreInfieldPosition(fieldId, profile) {
  const { fielding: fieldingOvr, speed: speedOvr, armStrength, physicality } = profile

  switch (fieldId) {
    case 'secondBase':
      return (0.55 * fieldingOvr) + (0.35 * speedOvr) + (0.1 * armStrength)
    case 'thirdBase':
      return (0.45 * fieldingOvr) + (0.3 * armStrength) + (0.25 * physicality)
    case 'firstBase':
      return (0.45 * fieldingOvr) + (0.4 * physicality) + (0.15 * armStrength)
    case 'catcher':
      return (0.65 * (100 - fieldingOvr)) + (0.35 * (100 - speedOvr)) + (0.1 * physicality)
    default:
      return 0
  }
}

function forEachPermutation(items, callback, startIndex = 0) {
  if (startIndex >= items.length) {
    callback(items)
    return
  }

  for (let index = startIndex; index < items.length; index += 1) {
    ;[items[startIndex], items[index]] = [items[index], items[startIndex]]
    forEachPermutation(items, callback, startIndex + 1)
    ;[items[startIndex], items[index]] = [items[index], items[startIndex]]
  }
}

function addChemistryBonus(score, linkCount) {
  let total = score
  for (let index = 0; index < linkCount; index += 1) total += 4
  return total
}

function addLineupSlotScore(score, profile, slotIndex) {
  let total = score + (profile.batting * LINEUP_SLOT_WEIGHTS[slotIndex])
  if (CLEANUP_SLOT_INDEXES.has(slotIndex)) total += 0.12 * profile.power
  return total
}

function compareLineupPath(candidate, best, stableRankById) {
  let result = compareNumericDesc(
    addChemistryBonus(candidate.slotScore, candidate.chemistryLinks),
    addChemistryBonus(best.slotScore, best.chemistryLinks),
  )
  if (result) return result

  result = compareNumericDesc(candidate.topFourBatting, best.topFourBatting)
  if (result) return result

  result = compareNumericDesc(candidate.cleanupPower, best.cleanupPower)
  if (result) return result

  return compareLexicographicByStableOrder(candidate.ids, best.ids, stableRankById)
}

export function recommendLineup(players = [], analysisById = {}) {
  if (!Array.isArray(players) || players.length !== 9) return []

  const stableRankById = getStableRankById(players)
  const profiles = buildPlayerProfiles(players, analysisById)
  const chemistry = buildChemistryMatrix(profiles)
  const playerCount = profiles.length

  // This is a small Held-Karp dynamic program. A state keeps the best path for
  // (starting player, used players, last player), cutting the search from 9!
  // complete orders to a few thousand states while retaining the exact scoring
  // and tie-break order used by the exhaustive implementation.
  let states = new Map()
  profiles.forEach((profile, index) => {
    states.set(((index * (1 << playerCount)) + (1 << index)) * playerCount + index, {
      firstIndex: index,
      lastIndex: index,
      mask: 1 << index,
      ids: [profile.id],
      slotScore: addLineupSlotScore(0, profile, 0),
      chemistryLinks: 0,
      topFourBatting: profile.batting,
      cleanupPower: 0,
    })
  })

  for (let slotIndex = 1; slotIndex < playerCount; slotIndex += 1) {
    const nextStates = new Map()
    states.forEach((path) => {
      profiles.forEach((profile, nextIndex) => {
        const nextBit = 1 << nextIndex
        if (path.mask & nextBit) return

        const candidate = {
          firstIndex: path.firstIndex,
          lastIndex: nextIndex,
          mask: path.mask | nextBit,
          ids: [...path.ids, profile.id],
          slotScore: addLineupSlotScore(path.slotScore, profile, slotIndex),
          chemistryLinks: path.chemistryLinks + Number(chemistry[path.lastIndex][nextIndex]),
          topFourBatting: path.topFourBatting + (slotIndex < 4 ? profile.batting : 0),
          cleanupPower: path.cleanupPower + (CLEANUP_SLOT_INDEXES.has(slotIndex) ? profile.power : 0),
        }
        const key = ((candidate.firstIndex * (1 << playerCount)) + candidate.mask) * playerCount + candidate.lastIndex
        const current = nextStates.get(key)
        if (!current || compareLineupPath(candidate, current, stableRankById) > 0) nextStates.set(key, candidate)
      })
    })
    states = nextStates
  }

  let bestCandidate = null
  states.forEach((path) => {
    const candidate = {
      ...path,
      chemistryLinks: path.chemistryLinks + Number(chemistry[path.lastIndex][path.firstIndex]),
    }
    if (!bestCandidate || compareLineupPath(candidate, bestCandidate, stableRankById) > 0) bestCandidate = candidate
  })

  return bestCandidate?.ids || []
}

export function recommendFielding(players = [], analysisById = {}) {
  if (!Array.isArray(players) || players.length !== 9) return {}

  const stableRankById = getStableRankById(players)
  const profiles = buildPlayerProfiles(players, analysisById)
  const chemistry = buildChemistryMatrix(profiles)
  let bestOutfield = null

  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let centerIndex = 0; centerIndex < profiles.length; centerIndex += 1) {
      if (centerIndex === leftIndex) continue
      for (let rightIndex = 0; rightIndex < profiles.length; rightIndex += 1) {
        if (rightIndex === leftIndex || rightIndex === centerIndex) continue

        const leftField = profiles[leftIndex]
        const centerField = profiles[centerIndex]
        const rightField = profiles[rightIndex]
        const candidate = {
          ids: [leftField.id, centerField.id, rightField.id],
          centerLinks: Number(chemistry[centerIndex][leftIndex]) + Number(chemistry[centerIndex][rightIndex]),
          totalSpeed: leftField.speed + centerField.speed + rightField.speed,
          centerSpeed: centerField.speed,
          totalFielding: leftField.fielding + centerField.fielding + rightField.fielding,
          positions: {
            leftField: leftField.id,
            centerField: centerField.id,
            rightField: rightField.id,
          },
        }

        if (!bestOutfield || compareOutfieldCandidate(candidate, bestOutfield, stableRankById) > 0) {
          bestOutfield = candidate
        }
      }
    }
  }

  if (!bestOutfield) return {}

  const outfieldIds = new Set(bestOutfield.ids.map((id) => String(id)))
  const remainingPlayers = profiles.filter((profile) => !outfieldIds.has(String(profile.id)))

  const pitcher = [...remainingPlayers].sort((left, right) => {
    const pitchingDiff = right.pitching - left.pitching
    if (pitchingDiff !== 0) return pitchingDiff
    return left.stableRank - right.stableRank
  })[0] || null

  if (!pitcher) return {}

  const infieldPlayers = remainingPlayers.filter((profile) => String(profile.id) !== String(pitcher.id))

  const shortStopPlayer = pickShortstop(infieldPlayers)
  if (!shortStopPlayer) return {}

  const workingInfield = infieldPlayers.filter((profile) => String(profile.id) !== String(shortStopPlayer.id))
  let bestInfield = null

  forEachPermutation(workingInfield, (order) => {
    const positions = {
      catcher: order[0].id,
      firstBase: order[1].id,
      secondBase: order[2].id,
      thirdBase: order[3].id,
    }

    const totalScore = INFIELD_FIELD_IDS.reduce((sum, fieldId, index) => (
      sum + scoreInfieldPosition(fieldId, order[index])
    ), 0)
    const secondBasePlayer = order[2]
    const candidate = {
      ids: buildFieldAssignmentIds(positions, INFIELD_FIELD_IDS),
      totalScore,
      secondBaseSpeed: secondBasePlayer.speed,
      positions,
    }

    if (!bestInfield || compareInfieldCandidate(candidate, bestInfield, stableRankById) > 0) {
      bestInfield = candidate
    }
  })

  if (!bestInfield) return {}

  return {
    pitcher: pitcher.id,
    shortStop: shortStopPlayer.id,
    ...bestInfield.positions,
    ...bestOutfield.positions,
  }
}
