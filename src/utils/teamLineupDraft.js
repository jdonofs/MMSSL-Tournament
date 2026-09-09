// Reconciles a saved team-level lineup with the roster that is eligible right
// now. The scorebook uses this to render a pregame lineup from data included in
// its initial load, before game-specific lineups/game_fielders rows exist.
export function isPregameGameStatus(status) {
  return ['pending', 'scheduled'].includes(String(status || '').toLowerCase())
}

export function reconcileTeamLineupDraft(saved, rosterCharacterIds = [], positionIds = []) {
  const rosterByKey = new Map()
  rosterCharacterIds.forEach((id) => {
    if (id == null) return
    const key = String(id)
    if (!rosterByKey.has(key)) rosterByKey.set(key, id)
  })

  const order = []
  const orderedKeys = new Set()
  const savedOrder = Array.isArray(saved?.lineupOrder) ? saved.lineupOrder : []
  savedOrder.forEach((id) => {
    const key = String(id)
    if (!rosterByKey.has(key) || orderedKeys.has(key)) return
    orderedKeys.add(key)
    order.push(rosterByKey.get(key))
  })
  rosterByKey.forEach((id, key) => {
    if (!orderedKeys.has(key)) order.push(id)
  })

  const allowedPositions = new Set(positionIds)
  const fielding = {}
  const fieldedKeys = new Set()
  const savedFielding = saved?.fieldingPositions && typeof saved.fieldingPositions === 'object'
    ? saved.fieldingPositions
    : {}
  Object.entries(savedFielding).forEach(([positionId, id]) => {
    const key = String(id)
    if ((allowedPositions.size && !allowedPositions.has(positionId)) || !rosterByKey.has(key) || fieldedKeys.has(key)) return
    fielding[positionId] = rosterByKey.get(key)
    fieldedKeys.add(key)
  })

  if (positionIds.length) {
    const unplaced = order.filter((id) => !fieldedKeys.has(String(id)))
    const emptyPositions = positionIds.filter((positionId) => fielding[positionId] == null)
    unplaced.forEach((id, index) => {
      if (emptyPositions[index]) fielding[emptyPositions[index]] = id
    })
  }

  return { order, fielding }
}
