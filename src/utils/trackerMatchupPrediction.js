function normalizeCharacterName(value) {
  return String(value || '')
    .trim()
    .replace(/\.$/, '')
    .toLocaleLowerCase()
}

function getAlignment(alignments, playerId) {
  if (playerId == null) return {}
  return alignments?.[String(playerId)] || alignments?.[playerId] || {}
}

function getBattingOrder(alignments, playerId) {
  const batting = getAlignment(alignments, playerId)?.batting
  return Array.isArray(batting) ? batting.filter(Boolean) : []
}

function nameBelongsToPlayer(name, alignments, playerId) {
  const normalizedName = normalizeCharacterName(name)
  if (!normalizedName) return false
  const alignment = getAlignment(alignments, playerId)
  const rosterNames = [
    ...(Array.isArray(alignment?.batting) ? alignment.batting : []),
    ...Object.values(alignment?.fielding || {}),
  ]
  return rosterNames.some((candidate) => normalizeCharacterName(candidate) === normalizedName)
}

function resolvePlayersForHalf({ isTop, homeAwaySwapped, teamAPlayerId, teamBPlayerId }) {
  const topPlayerId = homeAwaySwapped ? teamBPlayerId : teamAPlayerId
  const bottomPlayerId = homeAwaySwapped ? teamAPlayerId : teamBPlayerId
  return isTop
    ? { battingPlayerId: topPlayerId, pitchingPlayerId: bottomPlayerId }
    : { battingPlayerId: bottomPlayerId, pitchingPlayerId: topPlayerId }
}

function nextBatterFromOrder({ battingOrder, battingPlayerId, plateAppearances, lastConfirmedBatterByPlayer }) {
  if (!battingOrder.length) return { batterName: null, onDeckName: null }

  const lastConfirmedName = lastConfirmedBatterByPlayer?.[String(battingPlayerId)]
    ?? lastConfirmedBatterByPlayer?.[battingPlayerId]
  const lastConfirmedIndex = battingOrder.findIndex(
    (name) => normalizeCharacterName(name) === normalizeCharacterName(lastConfirmedName),
  )
  const completedPaCount = (plateAppearances || []).filter(
    (pa) => String(pa.player_id ?? pa.playerId) === String(battingPlayerId),
  ).length
  const batterIndex = lastConfirmedIndex >= 0
    ? (lastConfirmedIndex + 1) % battingOrder.length
    : completedPaCount % battingOrder.length

  return {
    batterName: battingOrder[batterIndex] || null,
    onDeckName: battingOrder[(batterIndex + 1) % battingOrder.length] || null,
  }
}

export function predictTrackerMatchup({
  inning = 1,
  isTop = true,
  homeAwaySwapped = false,
  teamAPlayerId = null,
  teamBPlayerId = null,
  alignments = {},
  plateAppearances = [],
  lastConfirmedBatterByPlayer = {},
} = {}) {
  const { battingPlayerId, pitchingPlayerId } = resolvePlayersForHalf({
    isTop,
    homeAwaySwapped,
    teamAPlayerId,
    teamBPlayerId,
  })
  const battingOrder = getBattingOrder(alignments, battingPlayerId)
  const { batterName, onDeckName } = nextBatterFromOrder({
    battingOrder,
    battingPlayerId,
    plateAppearances,
    lastConfirmedBatterByPlayer,
  })
  const pitcherName = getAlignment(alignments, pitchingPlayerId)?.fielding?.P || null

  return {
    matchup: pitcherName || batterName
      ? {
          left: pitcherName,
          right: batterName,
          inning: Math.max(1, Number(inning || 1)),
          isTop: isTop !== false,
          predicted: true,
        }
      : null,
    onDeckName,
    battingPlayerId,
    pitchingPlayerId,
  }
}

export function resolveTrackerMatchupForHalf({ existingMatchup = null, ...options } = {}) {
  const prediction = predictTrackerMatchup(options)
  if (!existingMatchup || existingMatchup.predicted === true) return prediction

  const inning = Math.max(1, Number(options.inning || 1))
  const isTop = options.isTop !== false
  const hasExplicitHalf = existingMatchup.inning != null && existingMatchup.isTop != null
  const explicitlyCurrent = hasExplicitHalf
    && Number(existingMatchup.inning) === inning
    && Boolean(existingMatchup.isTop) === isTop
  const participantsMatchCurrentSides = nameBelongsToPlayer(
    existingMatchup.left,
    options.alignments,
    prediction.pitchingPlayerId,
  ) && nameBelongsToPlayer(
    existingMatchup.right,
    options.alignments,
    prediction.battingPlayerId,
  )

  // New bridge snapshots carry the half-inning on every authoritative
  // tracker matchup. For legacy snapshots, participant team membership lets
  // us distinguish a live matchup from the just-finished half's reversed
  // batter/pitcher without discarding good state during a bridge restart.
  if (!explicitlyCurrent && (hasExplicitHalf || !participantsMatchCurrentSides)) return prediction

  const battingOrder = getBattingOrder(options.alignments, prediction.battingPlayerId)
  const batterIndex = battingOrder.findIndex(
    (name) => normalizeCharacterName(name) === normalizeCharacterName(existingMatchup.right),
  )
  return {
    ...prediction,
    matchup: {
      ...existingMatchup,
      inning,
      isTop,
      predicted: false,
    },
    onDeckName: batterIndex >= 0
      ? battingOrder[(batterIndex + 1) % battingOrder.length] || null
      : prediction.onDeckName,
  }
}
