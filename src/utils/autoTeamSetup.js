import { CHARACTER_VARIANTS, chemistryNamesMatch, getChemistry } from '../data/chemistry'

const LINEUP_SLOT_WEIGHTS = [1.12, 1.06, 1.0, 0.98, 0.94, 0.9, 0.86, 0.83, 0.8]
const CLEANUP_SLOT_INDEXES = new Set([2, 3])
const OUTFIELD_FIELD_IDS = ['leftField', 'centerField', 'rightField']
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

function getAnalysis(player, analysisById = {}) {
  return analysisById[getPlayerId(player)] || null
}

function getDisplayRating(player, analysisById, key) {
  return toNumber(getAnalysis(player, analysisById)?.displayRatings?.[key])
}

function getRawMetric(player, analysisById, group, key) {
  return toNumber(getAnalysis(player, analysisById)?.rawMetrics?.[group]?.[key])
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

function compareLineupCandidate(candidate, best, stableRankById) {
  let result = compareNumericDesc(candidate.totalScore, best.totalScore)
  if (result) return result

  result = compareNumericDesc(candidate.topFourBatting, best.topFourBatting)
  if (result) return result

  result = compareNumericDesc(candidate.cleanupPower, best.cleanupPower)
  if (result) return result

  return compareLexicographicByStableOrder(candidate.ids, best.ids, stableRankById)
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

function pickShortstop(players, analysisById, stableRankById) {
  return [...players].sort((left, right) => {
    const fieldingDiff = getDisplayRating(right, analysisById, 'fielding') - getDisplayRating(left, analysisById, 'fielding')
    if (fieldingDiff !== 0) return fieldingDiff

    const speedDiff = getDisplayRating(right, analysisById, 'speed') - getDisplayRating(left, analysisById, 'speed')
    if (speedDiff !== 0) return speedDiff

    const kritterDiff = Number(isKritterVariant(right)) - Number(isKritterVariant(left))
    if (kritterDiff !== 0) return kritterDiff

    return toNumber(stableRankById[getStableKey(getPlayerId(left))]) - toNumber(stableRankById[getStableKey(getPlayerId(right))])
  })[0] || null
}

function scoreInfieldPosition(fieldId, player, analysisById) {
  const fieldingOvr = getDisplayRating(player, analysisById, 'fielding')
  const speedOvr = getDisplayRating(player, analysisById, 'speed')
  const armStrength = getRawMetric(player, analysisById, 'fielding', 'armStrength')
  const physicality = getRawMetric(player, analysisById, 'fielding', 'physicality')

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

export function recommendLineup(players = [], analysisById = {}) {
  if (!Array.isArray(players) || players.length !== 9) return []

  const stableRankById = getStableRankById(players)
  const workingPlayers = [...players]
  let bestCandidate = null

  forEachPermutation(workingPlayers, (order) => {
    let totalScore = 0
    let topFourBatting = 0
    let cleanupPower = 0

    order.forEach((player, index) => {
      const battingOvr = getDisplayRating(player, analysisById, 'batting')
      const power = getRawMetric(player, analysisById, 'batting', 'power')
      const weightedBatting = battingOvr * LINEUP_SLOT_WEIGHTS[index]
      totalScore += weightedBatting
      if (index < 4) topFourBatting += battingOvr
      if (CLEANUP_SLOT_INDEXES.has(index)) {
        totalScore += 0.12 * power
        cleanupPower += power
      }
    })

    for (let index = 0; index < order.length; index += 1) {
      const current = order[index]
      const next = order[(index + 1) % order.length]
      if (hasGoodChemistry(current, next)) totalScore += 4
    }

    const candidate = {
      ids: order.map((player) => getPlayerId(player)),
      totalScore,
      topFourBatting,
      cleanupPower,
    }

    if (!bestCandidate || compareLineupCandidate(candidate, bestCandidate, stableRankById) > 0) {
      bestCandidate = candidate
    }
  })

  return bestCandidate?.ids || []
}

export function recommendFielding(players = [], analysisById = {}) {
  if (!Array.isArray(players) || players.length !== 9) return {}

  const stableRankById = getStableRankById(players)
  let bestOutfield = null

  for (let leftIndex = 0; leftIndex < players.length; leftIndex += 1) {
    for (let centerIndex = 0; centerIndex < players.length; centerIndex += 1) {
      if (centerIndex === leftIndex) continue
      for (let rightIndex = 0; rightIndex < players.length; rightIndex += 1) {
        if (rightIndex === leftIndex || rightIndex === centerIndex) continue

        const leftField = players[leftIndex]
        const centerField = players[centerIndex]
        const rightField = players[rightIndex]
        const candidate = {
          ids: [getPlayerId(leftField), getPlayerId(centerField), getPlayerId(rightField)],
          centerLinks: Number(hasGoodChemistry(centerField, leftField)) + Number(hasGoodChemistry(centerField, rightField)),
          totalSpeed: getDisplayRating(leftField, analysisById, 'speed') + getDisplayRating(centerField, analysisById, 'speed') + getDisplayRating(rightField, analysisById, 'speed'),
          centerSpeed: getDisplayRating(centerField, analysisById, 'speed'),
          totalFielding: getDisplayRating(leftField, analysisById, 'fielding') + getDisplayRating(centerField, analysisById, 'fielding') + getDisplayRating(rightField, analysisById, 'fielding'),
          positions: {
            leftField: getPlayerId(leftField),
            centerField: getPlayerId(centerField),
            rightField: getPlayerId(rightField),
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
  const remainingPlayers = players.filter((player) => !outfieldIds.has(String(getPlayerId(player))))

  const pitcher = [...remainingPlayers].sort((left, right) => {
    const pitchingDiff = getDisplayRating(right, analysisById, 'pitching') - getDisplayRating(left, analysisById, 'pitching')
    if (pitchingDiff !== 0) return pitchingDiff
    return toNumber(stableRankById[getStableKey(getPlayerId(left))]) - toNumber(stableRankById[getStableKey(getPlayerId(right))])
  })[0] || null

  if (!pitcher) return {}

  const infieldPlayers = remainingPlayers.filter((player) => String(getPlayerId(player)) !== String(getPlayerId(pitcher)))

  const shortStopPlayer = pickShortstop(infieldPlayers, analysisById, stableRankById)
  if (!shortStopPlayer) return {}

  const workingInfield = infieldPlayers.filter((player) => String(getPlayerId(player)) !== String(getPlayerId(shortStopPlayer)))
  let bestInfield = null

  forEachPermutation(workingInfield, (order) => {
    const positions = {
      catcher: getPlayerId(order[0]),
      firstBase: getPlayerId(order[1]),
      secondBase: getPlayerId(order[2]),
      thirdBase: getPlayerId(order[3]),
    }

    const totalScore = INFIELD_FIELD_IDS.reduce((sum, fieldId, index) => (
      sum + scoreInfieldPosition(fieldId, order[index], analysisById)
    ), 0)
    const secondBasePlayer = order[2]
    const candidate = {
      ids: buildFieldAssignmentIds(positions, INFIELD_FIELD_IDS),
      totalScore,
      secondBaseSpeed: getDisplayRating(secondBasePlayer, analysisById, 'speed'),
      positions,
    }

    if (!bestInfield || compareInfieldCandidate(candidate, bestInfield, stableRankById) > 0) {
      bestInfield = candidate
    }
  })

  if (!bestInfield) return {}

  return {
    pitcher: getPlayerId(pitcher),
    shortStop: getPlayerId(shortStopPlayer),
    ...bestInfield.positions,
    ...bestOutfield.positions,
  }
}
